/* ---------- Master key for secrets outside Electron ----------
 * Electron uses safeStorage ("enc1:"). The CLI / npm / headless mode has no
 * safeStorage, so secrets used to be stored in plaintext. Now they are
 * encrypted with AES-256-GCM ("kc1:") using one random master key, kept in:
 *   macOS   Keychain        (`security -i`, key written via stdin)
 *   Linux   Secret Service  (`secret-tool store`, key via stdin)
 *   Windows DPAPI           (PowerShell ProtectedData, CurrentUser, via stdin)
 *   other / unavailable     <dataDir>/secret.key, mode 0600
 * The key is never passed as a command-line argument (visible in `ps`).
 * MEMORIA_SECRET_BACKEND=file forces the file backend (tests, containers).
 * ------------------------------------------------------------------------- */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "../config";

export type SecretBackend = "keychain" | "secret-service" | "dpapi" | "file" | "env";

const SERVICE = "Memoria";
const ACCOUNT = "secret-master-key";
let cached: { dir: string; key: Buffer; backend: SecretBackend } | null = null;

function dataDir(): string {
  return process.env.MEMORIA_DATA_DIR || getConfig().dataDir;
}

function run(cmd: string, args: string[], input?: string): string | null {
  try {
    return execFileSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 8000 }).trim();
  } catch {
    return null;
  }
}

function decodeKey(s: string | null): Buffer | null {
  if (!s) return null;
  const b = Buffer.from(s.trim(), "base64");
  return b.length === 32 ? b : null;
}

/* ---- platform backends: read() returns the key or null, write() returns success ---- */

const macos = {
  read: () => decodeKey(run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])),
  write: (b64: string) =>
    // `security -i` reads commands from stdin, so the key never appears in argv.
    run("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${b64}\n`) !== null && !!macos.read(),
};

const linux = {
  read: () => decodeKey(run("secret-tool", ["lookup", "service", "memoria", "account", ACCOUNT])),
  write: (b64: string) => run("secret-tool", ["store", "--label=Memoria secrets", "service", "memoria", "account", ACCOUNT], b64) !== null && !!linux.read(),
};

const DPAPI_FILE = "secret.key.dpapi";
const PS = ["-NoProfile", "-NonInteractive", "-Command"];
const windows = {
  read: (): Buffer | null => {
    const f = path.join(dataDir(), DPAPI_FILE);
    if (!fs.existsSync(f)) return null;
    const script =
      "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
      "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
    return decodeKey(run("powershell", [...PS, script], fs.readFileSync(f, "utf8")));
  },
  write: (b64: string): boolean => {
    const script =
      "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
      "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
    const protectedB64 = run("powershell", [...PS, script], b64);
    if (!protectedB64) return false;
    fs.writeFileSync(path.join(dataDir(), DPAPI_FILE), protectedB64, { mode: 0o600 });
    return !!windows.read();
  },
};

const FILE_NAME = "secret.key";
const file = {
  read: (): Buffer | null => {
    try {
      return decodeKey(fs.readFileSync(path.join(dataDir(), FILE_NAME), "utf8"));
    } catch {
      return null;
    }
  },
  write: (b64: string): boolean => {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dataDir(), FILE_NAME), b64 + "\n", { mode: 0o600 });
    return !!file.read();
  },
};

function osBackend(): { name: SecretBackend; read: () => Buffer | null; write: (b64: string) => boolean } | null {
  if (process.env.MEMORIA_SECRET_BACKEND === "file") return null;
  // `node --test` sets NODE_TEST_CONTEXT: never touch the developer's real keychain.
  if (process.env.NODE_TEST_CONTEXT) return null;
  if (process.platform === "darwin") return { name: "keychain", ...macos };
  if (process.platform === "win32") return { name: "dpapi", ...windows };
  if (process.platform === "linux") return { name: "secret-service", ...linux };
  return null;
}

/** The master key, created on first use. */
export function masterKey(): { dir: string; key: Buffer; backend: SecretBackend } {
  const dir = dataDir();
  if (cached && cached.dir === dir) return cached;
  const env = decodeKey(process.env.MEMORIA_SECRET_KEY || null);
  if (env) {
    cached = { dir, key: env, backend: "env" };
    return cached;
  }
  const os = osBackend();
  // Existing key first (OS store, then file), so switching backends never
  // orphans secrets that were already encrypted.
  const fromOs = os?.read();
  if (os && fromOs) return (cached = { dir, key: fromOs, backend: os.name });
  const fromFile = file.read();
  if (fromFile) return (cached = { dir, key: fromFile, backend: "file" });
  const fresh = randomBytes(32);
  const b64 = fresh.toString("base64");
  if (os && os.write(b64)) return (cached = { dir, key: fresh, backend: os.name });
  if (!file.write(b64)) throw new Error("cannot store the secret master key");
  return (cached = { dir, key: fresh, backend: "file" });
}

export function secretBackend(): SecretBackend | null {
  try {
    return masterKey().backend;
  } catch {
    return null;
  }
}

/** Tests only: forget the cached key. */
export function __resetMasterKeyCache(): void {
  cached = null;
}
