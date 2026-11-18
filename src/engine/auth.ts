/* ---------- Local API token ----------
 * The HTTP server only listens on 127.0.0.1, but other OS users and local
 * processes can still reach it. Every install now gets a random token:
 *   - stored in <dataDir>/api-token with mode 0600 (owner only)
 *   - accepted as header `x-memoria-token` (scripts, MCP over HTTP)
 *   - or as cookie `memoria_token` (dashboard; set by Electron, or once via
 *     http://127.0.0.1:<port>/?token=<token> which `memoria server` prints)
 * A token set manually in the `apiToken` setting (older opt-in) still wins.
 * Setting `apiTokenRequired` = "0" turns enforcement off.
 * ------------------------------------------------------------------------- */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { getConfig } from "./config";
import { getSetting } from "./store/db";

export const TOKEN_COOKIE = "memoria_token";
export const TOKEN_HEADER = "x-memoria-token";

let cached: { file: string; token: string } | null = null;

export function tokenFile(): string {
  return path.join(process.env.MEMORIA_DATA_DIR || getConfig().dataDir, "api-token");
}

/** Current API token; created on first use. */
export function getApiToken(): string {
  const manual = getSetting("apiToken", "");
  if (manual) return manual;
  const file = tokenFile();
  if (cached && cached.file === file) return cached.token;
  let token = "";
  try {
    token = fs.readFileSync(file, "utf8").trim();
  } catch {
    /* not created yet */
  }
  if (!/^[a-f0-9]{32,}$/.test(token)) {
    token = randomBytes(24).toString("hex");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: ACLs of the user profile already restrict access */
  }
  cached = { file, token };
  return token;
}

export function tokenRequired(): boolean {
  return getSetting("apiTokenRequired", "1") !== "0" || !!getSetting("apiToken", "");
}

export function safeEqual(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookieToken(req: IncomingMessage): string {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === TOKEN_COOKIE) return decodeURIComponent(v.join("="));
  }
  return "";
}

export function isAuthorized(req: IncomingMessage): boolean {
  if (!tokenRequired()) return true;
  const token = getApiToken();
  return safeEqual(req.headers[TOKEN_HEADER], token) || safeEqual(cookieToken(req), token);
}

export function tokenCookieHeader(token: string): string {
  // Path=/ covers /api and /mcp. Strict: never sent on cross-site requests.
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
}

export function dashboardLoginUrl(): string {
  return `http://127.0.0.1:${getConfig().httpPort}/?token=${getApiToken()}`;
}

