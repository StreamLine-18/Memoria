/* Secret storage (API keys, webhook URLs/tokens, sync group key).
 *   enc1:<base64>  Electron safeStorage (Keychain / DPAPI / kwallet)
 *   kc1:<base64>   AES-256-GCM with a master key kept in the OS keychain
 *                  (secretkey.ts) — used by the CLI / npm / headless mode,
 *                  which has no safeStorage. Readable in both contexts.
 *   anything else  legacy plaintext (upgraded by upgradePlaintextSecrets). */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { masterKey } from "./secretkey";

let electronMod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  electronMod = require("electron");
} catch {
  // outside Electron (CLI / MCP)
}

/** Tests only: inject a fake safeStorage (null = none). */
export function __setSafeStorageForTest(ss: unknown): void {
  electronMod = ss ? { safeStorage: ss } : null;
}

export function encryptionAvailable(): boolean {
  try {
    return !!electronMod?.safeStorage?.isEncryptionAvailable?.();
  } catch {
    return false;
  }
}

function kcEncrypt(plain: string): string | null {
  try {
    const { key } = masterKey();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return "kc1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  } catch {
    return null;
  }
}

function kcDecrypt(stored: string): string | null {
  try {
    const raw = Buffer.from(stored.slice(4), "base64");
    const d = createDecipheriv("aes-256-gcm", masterKey().key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Encrypt with safeStorage when available, otherwise with the OS-keychain
 * master key. Returns null only if both are unavailable. */
export function encryptSecret(plain: string): string | null {
  try {
    const ss = electronMod?.safeStorage;
    if (ss?.isEncryptionAvailable?.()) {
      return "enc1:" + Buffer.from(ss.encryptString(plain)).toString("base64");
    }
  } catch {
    // fall through to the keychain master key
  }
  return kcEncrypt(plain);
}

export function decryptSecret(stored: string): string | null {
  if (stored.startsWith("kc1:")) return kcDecrypt(stored);
  try {
    if (!stored.startsWith("enc1:")) return stored; // legacy plaintext
    const ss = electronMod?.safeStorage;
    if (ss?.isEncryptionAvailable?.()) {
      // Used to only base64-decode, returning ciphertext bytes instead of plaintext.
      return ss.decryptString(Buffer.from(stored.slice(5), "base64"));
    }
  } catch {
    // cannot decrypt in this context
  }
  return null;
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith("enc1:") || stored.startsWith("kc1:");
}

export const SECRET_SETTING_KEYS = ["openaiApiKey", "notifyDiscordUrl", "notifyTelegramToken", "notifyGenericUrl"];

/** Encrypt secrets that older versions stored in plaintext (CLI mode).
 * Returns the keys that were upgraded. */
export function upgradePlaintextSecrets(): string[] {
  const db = require("./db") as typeof import("./db");
  const done: string[] = [];
  for (const k of SECRET_SETTING_KEYS) {
    const v = db.getSetting(k, "");
    if (!v || isEncrypted(v)) continue;
    const enc = encryptSecret(v);
    if (enc && decryptSecret(enc) === v) {
      db.setSetting(k, enc);
      done.push(k);
    }
  }
  return done;
}
