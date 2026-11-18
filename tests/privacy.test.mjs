/* Pengecualian capture: proyek yang cocok dengan setting captureExclude
 * (path prefix atau nama/slug) tidak pernah menyimpan transkrip. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-priv-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-excl-"));
const secretDir = path.join(root, "client-secret");
const nested = path.join(secretDir, "api");
const lookalike = path.join(root, "client-secret-public");
for (const d of [nested, lookalike]) fs.mkdirSync(d, { recursive: true });

const count = (pid) => dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM transcripts WHERE project_id = ?").get(pid).c;
const add = (pid, s) => dbmod.insertTranscript({ tool: "claude", sessionId: s, projectId: pid, role: "user", content: "hello " + s, ts: Date.now(), seq: 0 });

test("captureExclude: path prefix (termasuk subfolder) dan nama proyek dilewati", () => {
  const pSecret = dbmod.ensureProject("client-secret", secretDir);
  const pNested = dbmod.ensureProject("client-secret-api", nested);
  const pLook = dbmod.ensureProject("client-secret-public", lookalike);
  const pNamed = dbmod.ensureProject("banking-app", undefined);
  const pFree = dbmod.ensureProject("open-project", undefined);

  dbmod.setSetting("captureExclude", `# komentar\n${secretDir}/\nBanking-App`);
  for (const [pid, s] of [[pSecret, "a"], [pNested, "b"], [pLook, "c"], [pNamed, "d"], [pFree, "e"]]) add(pid, s);

  assert.equal(count(pSecret), 0, "folder yang dikecualikan");
  assert.equal(count(pNested), 0, "subfolder ikut dikecualikan");
  assert.equal(count(pLook), 1, "folder dengan prefix nama mirip tidak ikut");
  assert.equal(count(pNamed), 0, "nama proyek tidak peka huruf besar");
  assert.equal(count(pFree), 1);

  // Menghapus aturan berlaku langsung (cache mengikuti nilai setting).
  dbmod.setSetting("captureExclude", "");
  add(pSecret, "f");
  assert.equal(count(pSecret), 1);
});
