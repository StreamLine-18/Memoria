/* Tier 0 polish: inbox cap per project, "always archive" patterns, stale
 * tasks (archived, undo restores them as active), and the "used" boost. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-t0p-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
const triage = require("../dist/engine/extract/triage.js");
const { projectContext, touchMemories } = require("../dist/engine/retrieve/search.js");
const { extractQueue } = require("../dist/engine/extract/extractor.js");

const DAY = 86400000;
const draft = (pid, content, over = {}) =>
  dbmod.insertMemory({ projectId: pid, kind: "fact", content, importance: 0.5, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "draft", origin: "heuristic", ...over });
const state = (id) => dbmod.getDb().prepare("SELECT status, archived FROM memories WHERE id = ?").get(id);

test("inbox cap: uncertain drafts beyond the cap are archived, best scores kept", () => {
  const pid = dbmod.ensureProject("cap-proj", undefined);
  dbmod.setSetting("draftCapPerProject", "3");
  // Uncertain-but-plausible facts (sentence + entity) so they stay as drafts.
  const facts = [
    "The staging worker listens on port 8080 behind the internal load balancer.",
    "Invoices are generated nightly by a cron job running at 02:00 UTC in region one.",
    "The mobile app reads feature flags from the remote config endpoint version two.",
    "Search results are cached in Redis for fifteen minutes per tenant and locale.",
    "Uploaded avatars are resized to three widths before storage in the media bucket.",
    "Password reset links expire after thirty minutes and can be used only once.",
  ];
  for (const f of facts) draft(pid, f);
  dbmod.setSetting("draftCapPerProject", "50");
  const uncertain = triage.planTriage({ projectId: pid }).filter((p) => p.action === "keep");
  assert.ok(uncertain.length >= 2, `fixture needs uncertain drafts, got ${uncertain.length}`);
  const cap = uncertain.length - 1;
  dbmod.setSetting("draftCapPerProject", String(cap));
  const plan = triage.planTriage({ projectId: pid });
  const kept = plan.filter((p) => p.action === "keep");
  const over = plan.filter((p) => p.reason === "over-cap");
  assert.equal(kept.length, cap);
  assert.equal(over.length, 1);
  assert.ok(Math.min(...kept.map((k) => k.score)) >= over[0].score, "the lowest score goes first");
  dbmod.setSetting("draftCapPerProject", "50");
});

test("always-archive pattern: archives matching drafts now (undoable) and future candidates", async () => {
  const pid = dbmod.ensureProject("pattern-proj", "/tmp/pattern-proj");
  const a = draft(pid, "Jalankan build lagi setelah cache dibersihkan dari folder dist.");
  const b = draft(pid, "Jalankan build lagi dengan flag verbose untuk melihat log.");
  const c = draft(pid, "Konfigurasi Neon branch untuk preview environment sudah dibuat.");
  const r = triage.addUserNoisePattern("jalankan build lagi");
  assert.equal(r.archived, 2);
  assert.equal(state(a).archived, 1);
  assert.equal(state(b).archived, 1);
  assert.equal(state(c).archived, 0);
  assert.deepEqual(triage.userNoisePatterns(), ["jalankan build lagi"]);
  assert.throws(() => triage.addUserNoisePattern("ab"), /at least 3/);

  // Future extraction drops matching candidates entirely.
  dbmod.insertTranscript({ tool: "claude", sessionId: "pat1", projectId: pid, role: "user", content: "Keputusan: jalankan build lagi pakai turbo daripada npm scripts karena lebih cepat.", ts: Date.now(), seq: 0 });
  await extractQueue(true);
  assert.equal(dbmod.readMemories("WHERE project_id = ? AND content LIKE '%turbo%'", [pid]).length, 0);

  const u = triage.undoTriage(r.batch);
  assert.equal(u.restored, 2);
  assert.equal(state(a).archived, 0);
  assert.equal(state(a).status, "draft");
  triage.removeUserNoisePattern("jalankan build lagi");
  assert.deepEqual(triage.userNoisePatterns(), []);
});

test("stale tasks: unmentioned old tasks archived, mentioned ones kept, undo restores them as active", () => {
  const pid = dbmod.ensureProject("stale-proj", undefined);
  const old = Date.now() - 45 * DAY;
  const stale = dbmod.insertMemory({ projectId: pid, kind: "task_pending", content: "Migrate invoices table to partitioned storage", importance: 0.6, createdAt: old, lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic" });
  const alive = dbmod.insertMemory({ projectId: pid, kind: "task_pending", content: "Rotate webhook signing secret for payments", importance: 0.6, createdAt: old, lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic" });
  const fresh = dbmod.insertMemory({ projectId: pid, kind: "task_pending", content: "Write onboarding emails copy", importance: 0.6, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic" });
  dbmod.insertTranscript({ tool: "claude", sessionId: "st1", projectId: pid, role: "user", content: "Still working on the payments webhook signing secret rotation today.", ts: Date.now() - 2 * DAY, seq: 0 });

  const dry = triage.archiveStaleTasks({ dryRun: true });
  assert.ok(dry.ids.includes(stale));
  assert.ok(!dry.ids.includes(alive), "mentioned recently");
  assert.ok(!dry.ids.includes(fresh), "too new");
  assert.equal(state(stale).archived, 0, "dry run writes nothing");

  const r = triage.archiveStaleTasks();
  assert.equal(state(stale).archived, 1);
  triage.undoTriage(r.batch);
  assert.deepEqual({ ...state(stale) }, { status: "active", archived: 0 }, "restored as active, not draft");
});

test("used boost: memories agents fetched rank higher in project context", () => {
  const pid = dbmod.ensureProject("used-proj", undefined);
  const t = Date.now();
  const a = dbmod.insertMemory({ projectId: pid, kind: "fact", content: "Fact A about the cache layer", importance: 0.5, createdAt: t, lastAccessed: 0, accessCount: 0, sourceTool: "x", status: "active", origin: "user" });
  const b = dbmod.insertMemory({ projectId: pid, kind: "fact", content: "Fact B about the cache layer", importance: 0.5, createdAt: t, lastAccessed: 0, accessCount: 0, sourceTool: "x", status: "active", origin: "user" });
  for (let i = 0; i < 4; i++) touchMemories([b]);
  const ids = projectContext("used-proj", 5).map((h) => h.id);
  assert.ok(ids.indexOf(b) < ids.indexOf(a));
});
