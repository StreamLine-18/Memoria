import * as os from "node:os";
import { createHash } from "node:crypto";
import { getDb, getDeviceId, getSetting, getSyncState, setSetting } from "../store/db";
import { decryptSecret, encryptSecret, encryptionAvailable } from "../store/secure";
import {
  assertSyncKey,
  decodeRecoveryCode,
  encodeRecoveryCode,
  generateGroupKey,
  groupIdFor,
  unwrapKeyWithPassphrase,
  wrapKeyWithPassphrase,
} from "./crypto";

const KEY_SETTING = "sync.groupKey";
const DEVICE_NAME_SETTING = "sync.deviceName";
const PREVIOUS_GROUPS = "sync.previousGroups";
const REVOKED_DEVICES = "sync.revokedDevices";
const unlockedCache = new Map<string, Buffer>();

export interface UnlockOptions {
  passphrase?: string;
}

export interface SetupOptions extends UnlockOptions {
  joinCode?: string;
  deviceName?: string;
  force?: boolean;
}

export interface SetupResult {
  groupId: string;
  recoveryCode: string | null;
  joined: boolean;
}

export type KeyStorage = "env" | "safeStorage" | "keychain" | "passphrase" | "none";

export function getDeviceName(): string {
  return getSetting(DEVICE_NAME_SETTING, "") || os.hostname() || "local";
}

export function setDeviceName(name: string): void {
  const clean = String(name || "").trim();
  if (!clean) return;
  setSetting(DEVICE_NAME_SETTING, clean);
  getDb()
    .prepare("UPDATE sync_devices SET name = ?, last_seen = ? WHERE device_id = ?")
    .run(clean, Date.now(), getDeviceId());
}

export function keyStorage(): KeyStorage {
  if (process.env.MEMORIA_SYNC_KEY) return "env";
  const stored = getSetting(KEY_SETTING, "");
  if (!stored) return "none";
  if (stored.startsWith("pass1:")) return "passphrase";
  if (stored.startsWith("enc1:")) return "safeStorage";
  if (stored.startsWith("kc1:")) return "keychain";
  return "none";
}

export function isSyncConfigured(): boolean {
  return keyStorage() !== "none";
}

export function loadGroupKey(opts: UnlockOptions = {}): Buffer {
  const env = process.env.MEMORIA_SYNC_KEY;
  if (env) return decodeRecoveryCode(env);

  const stored = getSetting(KEY_SETTING, "");
  if (!stored) {
    throw new Error("Sync is not configured. Run: node dist/engine/index.js sync setup");
  }
  if (stored.startsWith("pass1:")) {
    const passphrase = opts.passphrase || process.env.MEMORIA_SYNC_PASSPHRASE || "";
    if (!passphrase) {
      throw new Error("Sync key is locked; pass --passphrase or set MEMORIA_SYNC_PASSPHRASE");
    }
    // scrypt (N=32768) blocks the event loop for ~100 ms: unwrap once per
    // stored key + passphrase and keep the result in memory for this process.
    const cacheKey = createHash("sha256").update(stored).update("\0").update(passphrase).digest("hex");
    const hit = unlockedCache.get(cacheKey);
    if (hit) return Buffer.from(hit);
    const key = unwrapKeyWithPassphrase(stored, passphrase);
    unlockedCache.clear();
    unlockedCache.set(cacheKey, Buffer.from(key));
    return key;
  }
  if (stored.startsWith("kc1:")) {
    // CLI/headless: AES-GCM with the OS-keychain master key (store/secretkey.ts).
    const plain = decryptSecret(stored);
    if (!plain) throw new Error("Cannot unlock sync key from the OS keychain");
    try {
      return assertSyncKey(Buffer.from(plain, "base64"));
    } catch {
      throw new Error("Stored sync key is corrupt");
    }
  }
  if (stored.startsWith("enc1:")) {
    if (!encryptionAvailable()) {
      throw new Error(
        "Sync key is protected by the OS keychain, which is unavailable in this CLI. Unlock it from the desktop app or reconfigure with sync setup --passphrase."
      );
    }
    const plain = decryptSecret(stored);
    if (!plain) throw new Error("Cannot unlock sync key from the OS keychain");
    try {
      return assertSyncKey(Buffer.from(plain, "base64"));
    } catch {
      throw new Error("Stored sync key is corrupt");
    }
  }
  throw new Error("Stored sync key format is unsupported; run sync setup --force");
}

export function setupSync(opts: SetupOptions = {}): SetupResult {
  if (isSyncConfigured() && !opts.force) {
    throw new Error("Sync is already configured. Use --force to replace the group key.");
  }
  const joined = !!opts.joinCode;
  const key = opts.joinCode ? decodeRecoveryCode(opts.joinCode) : generateGroupKey();
  // Re-joining after a rotation: remember the old group so its leftover
  // bundles in the shared folder are skipped instead of reported as errors.
  if (isSyncConfigured()) {
    try {
      const oldId = groupIdFor(loadGroupKey(opts));
      if (oldId !== groupIdFor(key)) {
        setSetting(PREVIOUS_GROUPS, JSON.stringify([oldId, ...previousGroupIds().filter((g) => g !== oldId)].slice(0, 20)));
      }
    } catch {
      /* old key locked or corrupt: nothing to remember */
    }
  }
  unlockedCache.clear();
  const passphrase = opts.passphrase || process.env.MEMORIA_SYNC_PASSPHRASE || "";
  if (passphrase) {
    setSetting(KEY_SETTING, wrapKeyWithPassphrase(key, passphrase));
  } else {
    const encrypted = encryptSecret(key.toString("base64"));
    if (!encrypted) {
      throw new Error("No OS keychain is available. Re-run with --passphrase or set MEMORIA_SYNC_PASSPHRASE.");
    }
    setSetting(KEY_SETTING, encrypted);
  }
  setDeviceName(opts.deviceName || getDeviceName());
  return {
    groupId: groupIdFor(key),
    recoveryCode: joined ? null : encodeRecoveryCode(key),
    joined,
  };
}

/* ---------- M5: key rotation and device revocation ----------
 * Bundles are encrypted with the group key, so a device that has the key can
 * read everything written with it. Revoking a device = rotating the key: new
 * bundles use a new key the revoked device never sees. Bundles from the old
 * group (or from a revoked device id) are skipped before decryption. Other
 * devices keep working after they join the new group with the new code. */

function readList(key: string): string[] {
  try {
    const v = JSON.parse(getSetting(key, "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function previousGroupIds(): string[] {
  return readList(PREVIOUS_GROUPS);
}

export function revokedDevices(): string[] {
  return readList(REVOKED_DEVICES);
}

export interface RotateResult {
  groupId: string;
  previousGroupId: string;
  recoveryCode: string;
}

/** Replace the group key with a new random key, stored the same way. */
export function rotateGroupKey(opts: UnlockOptions = {}): RotateResult {
  if (process.env.MEMORIA_SYNC_KEY) throw new Error("The group key comes from MEMORIA_SYNC_KEY; change that variable instead");
  const storage = keyStorage();
  if (storage === "none") throw new Error("Sync is not configured. Run: memoria sync setup");
  const oldKey = loadGroupKey(opts); // also proves the passphrase
  const previousGroupId = groupIdFor(oldKey);
  const key = generateGroupKey();
  if (storage === "passphrase") {
    const passphrase = opts.passphrase || process.env.MEMORIA_SYNC_PASSPHRASE || "";
    setSetting(KEY_SETTING, wrapKeyWithPassphrase(key, passphrase));
  } else {
    const encrypted = encryptSecret(key.toString("base64"));
    if (!encrypted) throw new Error("No OS keychain is available; re-run with --passphrase");
    setSetting(KEY_SETTING, encrypted);
  }
  unlockedCache.clear();
  const prev = previousGroupIds().filter((g) => g !== previousGroupId);
  setSetting(PREVIOUS_GROUPS, JSON.stringify([previousGroupId, ...prev].slice(0, 20)));
  return { groupId: groupIdFor(key), previousGroupId, recoveryCode: encodeRecoveryCode(key) };
}

/** Mark a device as revoked (by full id or unique prefix) and rotate the key. */
export function revokeDevice(idOrPrefix: string, opts: UnlockOptions = {}): RotateResult & { deviceId: string } {
  const q = String(idOrPrefix || "").trim();
  if (!q) throw new Error("Usage: sync revoke <device-id>");
  if (getDeviceId().startsWith(q)) throw new Error("That is this device; run sync rotate on another device instead");
  const matches = listDevices().filter((d) => d.deviceId.startsWith(q));
  if (matches.length > 1) throw new Error(`Device id prefix "${q}" is ambiguous`);
  const deviceId = matches[0]?.deviceId || q;
  setSetting(REVOKED_DEVICES, JSON.stringify([...new Set([...revokedDevices(), deviceId])]));
  return { ...rotateGroupKey(opts), deviceId };
}

export interface DeviceInfo {
  deviceId: string;
  name: string;
  self: boolean;
  revoked: boolean;
  lastBundleAt: number;
  bundles: number;
}

/** This device plus every device whose bundles were applied here. */
export function listDevices(): DeviceInfo[] {
  const d = getDb();
  const revoked = new Set(revokedDevices());
  const self = getDeviceId();
  const out = new Map<string, DeviceInfo>();
  out.set(self, { deviceId: self, name: getDeviceName(), self: true, revoked: false, lastBundleAt: 0, bundles: 0 });
  try {
    const rows = d
      .prepare("SELECT device_id AS id, COUNT(*) AS n, MAX(applied_at) AS last FROM sync_applied_bundle GROUP BY device_id")
      .all() as Array<{ id: string; n: number; last: number }>;
    for (const r of rows) {
      if (!r.id || r.id === self) continue;
      out.set(r.id, { deviceId: r.id, name: "", self: false, revoked: revoked.has(r.id), lastBundleAt: Number(r.last) || 0, bundles: Number(r.n) || 0 });
    }
  } catch {
    /* ledger missing on very old databases */
  }
  for (const id of revoked) if (!out.has(id)) out.set(id, { deviceId: id, name: "", self: false, revoked: true, lastBundleAt: 0, bundles: 0 });
  return [...out.values()];
}

export interface SyncStatus {
  configured: boolean;
  storage: KeyStorage;
  groupId: string | null;
  deviceId: string;
  deviceName: string;
  pendingOutbox: number;
  pendingSinceExport: number;
  tombstones: number;
  conflicts: number;
  embeddingsQueued: number;
  lastExportHlc: string;
  lastExportAt: string;
  lastImportHlc: string;
  lastImportAt: string;
  locked: boolean;
}

export function syncStatus(opts: UnlockOptions = {}): SyncStatus {
  const d = getDb();
  const count = (sql: string, ...params: string[]): number => {
    const row = d.prepare(sql).get(...params) as { c: number };
    return Number(row.c);
  };
  let groupId: string | null = null;
  let locked = false;
  try {
    groupId = groupIdFor(loadGroupKey(opts));
  } catch (err) {
    locked = isSyncConfigured() && !process.env.MEMORIA_SYNC_KEY && !String((err as Error).message).includes("not configured");
  }
  const lastExportHlc = getSyncState("last_export_hlc");
  return {
    configured: isSyncConfigured(),
    storage: keyStorage(),
    groupId,
    deviceId: getDeviceId(),
    deviceName: getDeviceName(),
    pendingOutbox: count("SELECT COUNT(*) AS c FROM sync_outbox"),
    pendingSinceExport: count("SELECT COUNT(*) AS c FROM sync_outbox WHERE hlc > ?", lastExportHlc),
    tombstones: count("SELECT COUNT(*) AS c FROM sync_tombstones"),
    conflicts: count("SELECT COUNT(*) AS c FROM sync_conflicts"),
    embeddingsQueued: count("SELECT COUNT(*) AS c FROM sync_embed_queue"),
    lastExportHlc,
    lastExportAt: getSyncState("last_export_at"),
    lastImportHlc: getSyncState("last_import_hlc"),
    lastImportAt: getSyncState("last_import_at"),
    locked,
  };
}
