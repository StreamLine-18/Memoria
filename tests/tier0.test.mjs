/* Tier 0 maksimal: redaksi secret, filter noise, triage active/draft/archive,
 * corroboration lintas sesi, auto-triage backlog + undo, peran tool di ingest
 * Claude, dan dekripsi safeStorage. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-t0-"));
const dbmod = require("../dist/engine/store/db.js");
const { redactSecrets } = require("../dist/engine/privacy/redact.js");
const { noiseReason } = require("../dist/engine/extract/noise.js");
const { triageCandidate, heuristicExtract } = require("../dist/engine/extract/heuristic.js");
const { addMemoryWithDedupe } = require("../dist/engine/extract/dedupe.js");
const { runTriage, undoTriage, planTriage } = require("../dist/engine/extract/triage.js");
const { scanClaude } = require("../dist/engine/ingest/claude.js");
const secure = require("../dist/engine/store/secure.js");
const evalMod = await import("../scripts/eval-heuristic.mjs");

dbmod.initDb(process.env.MEMORIA_DATA_DIR);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");

/* ---------- redaksi ---------- */

test("redact: token provider, private key, connection string, assignment", () => {
  const input = [
    "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
    "AKIAIOSFODNN7EXAMPLE",
    "postgres://app:s3cr3tPassw0rd@db.example.com:5432/app",
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
    'const cfg = { "password": "hunter2hunter2" }',
    "<private>nomor rekening 1234567890</private>",
  ].join("\n");
  const r = redactSecrets(input);
  assert.ok(r.count >= 7, `harus menyensor >=7 secret, dapat ${r.count}`);
  for (const leak of ["sk-proj-abcdef", "ghp_abcdef", "AKIAIOSFODNN7EXAMPLE", "s3cr3tPassw0rd", "MIIEvQIBADANBg", "hunter2hunter2", "1234567890"]) {
    assert.ok(!r.text.includes(leak), `bocor: ${leak}`);
  }
  // Struktur di sekitar secret dipertahankan (konteks tetap terbaca)
  assert.ok(r.text.includes("postgres://app:[REDACTED:conn-password]@db.example.com"));
  assert.ok(r.text.includes("OPENAI_API_KEY="));
});

test("redact: tidak menyensor placeholder, nama variabel, alamat publik, atau teks biasa", () => {
  const safe = [
    "API_KEY=${OPENAI_API_KEY}",
    "token = getToken()",
    "password: string;",
    "max_tokens=4096 and tokenizer: cl100k_base",
    'paymentToken: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"',
    "commit e6feab0 fixed the build",
    "Keputusan: kita pakai JWT daripada session cookie.",
  ];
  for (const s of safe) {
    const r = redactSecrets(s);
    assert.equal(r.count, 0, `false positive pada: ${s} -> ${r.text}`);
  }
  // Idempoten
  const once = redactSecrets("SECRET_KEY=abc123def456ghi").text;
  assert.equal(redactSecrets(once).count, 0);
});

test("redact: diterapkan di insertTranscript & insertMemory", () => {
  const pid = dbmod.ensureProject("users-mac-redact", "/tmp/redact");
  dbmod.insertTranscript({ tool: "claude", sessionId: "r1", projectId: pid, role: "user", content: "pakai key sk-ant-abcdefghijklmnopqrstuvwxyz012345 ya", ts: Date.now(), seq: 1 });
  const row = dbmod.getDb().prepare("SELECT content FROM transcripts WHERE session_id = 'r1'").get();
  assert.ok(!row.content.includes("sk-ant-abcdef"));
  assert.ok(row.content.includes("[REDACTED:anthropic]"));
  const id = dbmod.insertMemory({ projectId: pid, kind: "fact", content: "DB_PASSWORD=Sup3rS3cret!x", importance: 0.5, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude" });
  assert.ok(!dbmod.memoryById(id).content.includes("Sup3rS3cret"));
  dbmod.updateMemory(id, { content: "now GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" });
  assert.ok(!dbmod.memoryById(id).content.includes("ghp_abcdef"));
  assert.ok(Number(dbmod.getSetting("redactedTotal", "0")) >= 3);
});

/* ---------- noise + triage ---------- */

test("noise: output tool/shell/kode lepas ditolak, kalimat nyata lolos", () => {
  const noise = {
    "The file /a/b/Cart.tsx has been updated successfully.": "tool-echo",
    "-rw-r--r--@ 1 dev staff 30761 Oct 17 23:36 /tmp/idl.json": "ls-line",
    "src/app/page.tsx:386: <div className=\"x\">": "grep-line",
    "import * as burrow from './lib/burrow.ts';": "code-line",
    "(Bash completed with no output)": "tool-marker",
    "Mau saya lanjutkan jadi file PRD.md + skema SQL?": "offer-question",
  };
  for (const [s, id] of Object.entries(noise)) assert.equal(noiseReason(s), id, s);
  for (const ok of [
    "Use pnpm instead of npm (faster installs in CI).",
    "Keputusan: kita pakai JWT daripada session cookie.",
    "TODO: tambahkan test untuk parser Codex.",
  ]) assert.equal(noiseReason(ok), null, ok);
});

test("triage: keputusan eksplisit active, noise archive, kalimat ragu draft", () => {
  assert.equal(triageCandidate({ kind: "decision", content: "Keputusan: kita pakai SQLite FTS5 daripada Elasticsearch karena offline-first.", importance: 0.6, confidence: 0.82, signal: ["decision"] }).decision, "active");
  const n = triageCandidate({ kind: "fact", content: "The file /x/y.ts has been updated successfully.", importance: 0.5, confidence: 0.65 });
  assert.equal(n.decision, "archive");
  assert.match(n.reason, /^noise:/);
  // Pertanyaan tidak pernah jadi memori aktif
  assert.notEqual(triageCandidate({ kind: "task_pending", content: "Should we also migrate the old embeddings to the new format?", importance: 0.6, confidence: 0.8, signal: ["todo"] }).decision, "active");
});

test("heuristicExtract: pesan role tool dilewati, ucapan user diberi sinyal user", () => {
  const mems = heuristicExtract([
    { role: "tool", content: "TODO: this line is inside a tool result and must be ignored" },
    { role: "user", content: "TODO: tambahkan rate limit di endpoint login" },
  ]);
  assert.ok(!mems.some((m) => m.content.includes("tool result")));
  const user = mems.find((m) => m.content.includes("rate limit"));
  assert.ok(user && user.signal.includes("user"));
});

test("eval set: precision active >= 0.9, noise terbuang >= 0.9, memori bertahan >= 0.9", () => {
  const items = JSON.parse(fs.readFileSync(new URL("./fixtures/heuristic-eval.json", import.meta.url), "utf8")).items;
  const r = evalMod.evaluate(items);
  assert.ok(r.activePrecision >= 0.9, `active precision ${r.activePrecision}`);
  assert.ok(r.noiseRemoved >= 0.9, `noise removed ${r.noiseRemoved}`);
  assert.ok(r.memoryKept >= 0.9, `memory kept ${r.memoryKept}`);
});

/* ---------- corroboration + auto-triage ---------- */

const base = (pid, over = {}) => ({ projectId: pid, kind: "fact", importance: 0.5, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "draft", origin: "heuristic", ...over });

test("corroboration: draft yang muncul lagi di sesi lain dipromosikan", () => {
  const pid = dbmod.ensureProject("users-mac-corrob", undefined);
  addMemoryWithDedupe(base(pid, { content: "Staging database lives on Neon in the ap-southeast-1 region.", sourceSession: "a" }));
  addMemoryWithDedupe(base(pid, { content: "Staging database lives on Neon in the ap-southeast-1 region.", sourceSession: "b" }));
  const rows = dbmod.readMemories("WHERE project_id = ?", [pid]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "active");
});

test("auto-triage: dry-run tidak menulis; apply mengosongkan noise/duplikat/expired; undo memulihkan", () => {
  const pid = dbmod.ensureProject("users-mac-triage", undefined);
  const old = Date.now() - 30 * 86400000;
  const ins = (content, over = {}) => dbmod.insertMemory(base(pid, { content, ...over }));
  const idNoise = ins("-rw-r--r--@ 1 dev staff 30761 Oct 17 23:36 /tmp/idl.json");
  const idStrong = ins("Keputusan: kita pakai Railway daripada Vercel karena worker harus jalan 24/7.", { kind: "decision" });
  const idDupA = ins("Preview deploys use the staging Neon branch named preview-main.", { sourceSession: "s1" });
  const idDupB = ins("Preview deploys use the staging Neon branch named preview-main.", { sourceSession: "s2", createdAt: Date.now() - 1000 });
  const idOld = ins("Dokumen status ada di docs/PROJECT_STATUS.md dan matrix integrasi.", { createdAt: old });

  const preview = runTriage({ dryRun: true, projectId: pid });
  assert.equal(preview.batch, null);
  assert.equal(dbmod.memoryById(idNoise).archived ?? 0, 0, "dry-run tidak boleh mengubah data");
  assert.equal(dbmod.countDraft() >= 5, true);

  const plan = planTriage({ projectId: pid });
  const byId = Object.fromEntries(plan.map((p) => [p.id, p]));
  assert.equal(byId[idNoise].action, "archive");
  assert.equal(byId[idStrong].action, "promote");
  assert.equal(byId[idDupB].reason, "duplicate");
  assert.equal(byId[idDupA].reason, "corroborated", "dua sesi berbeda = bukti");
  assert.equal(byId[idOld].action === "promote", false);

  const r = runTriage({ projectId: pid });
  assert.ok(r.batch);
  const status = (id) => dbmod.getDb().prepare("SELECT status, archived FROM memories WHERE id = ?").get(id);
  assert.equal(status(idNoise).archived, 1);
  assert.equal(status(idStrong).status, "active");
  assert.equal(status(idDupA).status, "active");
  assert.equal(status(idDupB).archived, 1);
  const left = dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM memories WHERE project_id = ? AND status = 'draft' AND archived = 0").get(pid).c;
  assert.equal(left, 0, "antrean draft proyek harus kosong");

  const u = undoTriage(r.batch);
  assert.equal(u.restored, r.promoted + r.archived);
  for (const id of [idNoise, idStrong, idDupA, idDupB]) {
    assert.equal(status(id).status, "draft");
    assert.equal(status(id).archived, 0);
  }
});

/* ---------- ingest Claude: peran tool & tag suntikan ---------- */

test("ingest claude: tool_result disimpan sebagai role tool, tag IDE dibuang", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-claude-"));
  const file = path.join(root, "proj", "sess.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cwd = "/tmp/claude-role-proj";
  const lines = [
    { type: "user", sessionId: "cr1", cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "<ide_opened_file>The user opened /a.ts</ide_opened_file>\nTolong tambahkan endpoint health" } },
    { type: "assistant", sessionId: "cr1", cwd, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Oke, aku tambahkan." }] } },
    { type: "user", sessionId: "cr1", cwd, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "total 8\n-rw-r--r-- 1 a b 1 Jan 1 a.ts" }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await scanClaude(root);
  const rows = dbmod.getDb().prepare("SELECT role, content FROM transcripts WHERE session_id = 'cr1' ORDER BY seq").all();
  assert.deepEqual(rows.map((r) => r.role), ["user", "assistant", "tool"]);
  assert.ok(!rows[0].content.includes("ide_opened_file"));
  assert.ok(rows[0].content.includes("endpoint health"));

  // Pemulihan m9: offset di-reset lalu file dibaca ulang → tidak boleh dobel.
  dbmod.getDb().prepare("UPDATE sources SET offset = 0 WHERE file = ?").run(file);
  await scanClaude(root);
  const again = dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM transcripts WHERE session_id = 'cr1'").get().c;
  assert.equal(again, 3, "re-scan tidak boleh menggandakan pesan");
});

test("task lifecycle: a done-word about something else does not close a task", async () => {
  const { isTaskDone } = require("../dist/engine/extract/tasklife.js");
  const t0 = 1000;
  const rows = [
    { role: "assistant", ts: t0, content: "TODO: tambahkan migrasi untuk tabel orders dan index pada created_at." },
    { role: "user", ts: t0 + 1, content: "Error ECONNREFUSED ternyata karena DATABASE_URL belum di-set, fixed dengan menambah .env.local." },
    { role: "assistant", ts: t0 + 2, content: "- [ ] Tambah rate limit di POST /api/orders\n- [x] Setup Neon branch preview-main" },
  ];
  assert.equal(isTaskDone("TODO: tambahkan migrasi untuk tabel orders dan index pada created_at.", t0, rows), false);
  assert.equal(isTaskDone("Tambah rate limit di POST /api/orders", t0 + 2, rows), false, "its own unchecked line is not evidence");
  assert.equal(isTaskDone("Setup Neon branch preview-main", t0, rows), true, "a checked checkbox for the same item closes it");
  rows.push({ role: "assistant", ts: t0 + 3, content: "Rate limit di POST /api/orders sudah selesai dan dites." });
  assert.equal(isTaskDone("Tambah rate limit di POST /api/orders", t0 + 2, rows), true);
});

test("seqAllocator: setiap pesan satu sesi mendapat seq unik (dulu semua sama → pesan hilang)", () => {
  const next = dbmod.seqAllocator("seqtest");
  const seqs = [next("s"), next("s"), next("s"), next("t"), next("s")];
  assert.deepEqual(seqs, [0, 1, 2, 0, 3]);
});

/* ---------- secure.ts ---------- */

test("secure: decryptSecret membalik encryptSecret (dulu mengembalikan ciphertext)", () => {
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ 0x5a)),
    decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ 0x5a)).toString("utf8"),
  };
  secure.__setSafeStorageForTest(fake);
  try {
    const enc = secure.encryptSecret("https://discord.com/api/webhooks/1/abc");
    assert.ok(enc && enc.startsWith("enc1:"));
    assert.equal(secure.decryptSecret(enc), "https://discord.com/api/webhooks/1/abc");
    assert.equal(secure.decryptSecret("plain-legacy"), "plain-legacy");
  } finally {
    secure.__setSafeStorageForTest(null);
  }
  assert.equal(secure.decryptSecret("enc1:AAAA"), null, "tanpa safeStorage tidak bisa dekripsi");
});
