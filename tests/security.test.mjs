/* Local API token (header + cookie login), owner-only data files, OS-keychain
 * secret encryption for CLI mode, and token headers in HTTP MCP configs. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-sec-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-sec-home-"));
process.env.MEMORIA_DATA_DIR = dataDir;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.MEMORIA_HTTP_PORT = String(48500 + Math.floor(Math.random() * 400));
const PORT = Number(process.env.MEMORIA_HTTP_PORT);
const BASE = `http://127.0.0.1:${PORT}`;

// Existing Cursor config pointing at the HTTP bridge, without a token header.
fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { memoria: { url: `${BASE}/mcp` }, other: { url: "http://x" } } }));

const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(dataDir);
const auth = require("../dist/engine/auth.js");
const secure = require("../dist/engine/store/secure.js");
const { startHttpServer } = require("../dist/engine/http.js");

// Plaintext secret left by an older CLI version.
dbmod.setSetting("openaiApiKey", "sk-legacy-plaintext-key-0123456789");
await startHttpServer();
after(() => setTimeout(() => process.exit(0), 10));

const token = auth.getApiToken();

test("token file is created owner-only; data dir and db are not world-readable", { skip: process.platform === "win32" }, () => {
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(mode(auth.tokenFile()), 0o600);
  assert.equal(mode(dataDir), 0o700);
  assert.equal(mode(path.join(dataDir, "memory.db")), 0o600);
});

test("API requires the token; static files stay public", async () => {
  assert.equal((await fetch(`${BASE}/api/stats`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/stats`, { headers: { "x-memoria-token": "wrong" } })).status, 401);
  assert.equal((await fetch(`${BASE}/api/stats`, { headers: { "x-memoria-token": token } })).status, 200);
  assert.equal((await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${BASE}/`)).status, 200, "dashboard HTML loads so it can show the sign-in hint");
});

test("one-time login link sets an HttpOnly SameSite=Strict cookie that unlocks the API", async () => {
  const bad = await fetch(`${BASE}/?token=nope`, { redirect: "manual" });
  assert.equal(bad.status, 401);
  const r = await fetch(`${BASE}/?token=${token}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const cookie = r.headers.get("set-cookie") || "";
  assert.match(cookie, /memoria_token=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const jar = cookie.split(";")[0];
  assert.equal((await fetch(`${BASE}/api/stats`, { headers: { cookie: jar } })).status, 200);
});

test("foreign Origin is rejected even with a valid token", async () => {
  const r = await fetch(`${BASE}/api/stats`, { headers: { "x-memoria-token": token, origin: "https://evil.example" } });
  assert.equal(r.status, 403);
});

test("apiTokenRequired=0 turns enforcement off", async () => {
  dbmod.setSetting("apiTokenRequired", "0");
  try {
    assert.equal((await fetch(`${BASE}/api/stats`)).status, 200);
  } finally {
    dbmod.setSetting("apiTokenRequired", "1");
  }
  assert.equal((await fetch(`${BASE}/api/stats`)).status, 401);
});

test("existing HTTP MCP config gets the token header, other servers untouched", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cfg.mcpServers.memoria.headers["x-memoria-token"], token);
  assert.equal(cfg.mcpServers.other.headers, undefined);
});

test("CLI secrets: kc1 round trip, legacy plaintext upgraded on start, settings API encrypts", async () => {
  const enc = secure.encryptSecret("https://discord.com/api/webhooks/1/secret");
  assert.ok(enc.startsWith("kc1:"), "no safeStorage in CLI: falls back to the keychain master key");
  assert.equal(secure.decryptSecret(enc), "https://discord.com/api/webhooks/1/secret");
  assert.equal(secure.decryptSecret("kc1:" + Buffer.alloc(40).toString("base64")), null, "tampered ciphertext fails closed");

  const stored = dbmod.getSetting("openaiApiKey", "");
  assert.ok(stored.startsWith("kc1:"), "legacy plaintext encrypted at startup");
  assert.equal(secure.decryptSecret(stored), "sk-legacy-plaintext-key-0123456789");

  const r = await fetch(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-memoria-token": token },
    body: JSON.stringify({ key: "notifyTelegramToken", value: "12345678:AAabcdefghijklmnopqrstuvwxyz0123456789" }),
  });
  assert.deepEqual(await r.json(), { ok: true, encrypted: true });
  assert.ok(dbmod.getSetting("notifyTelegramToken", "").startsWith("kc1:"));
  // node --test never touches the real keychain: file backend, owner-only.
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dataDir, "secret.key")).mode & 0o777, 0o600);
});
