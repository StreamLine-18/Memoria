/* First-run onboarding: detect tools, connect, import, triage, summary. Runs
 * against a fake HOME so nothing outside the temp folders is touched. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-onb-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-onb-"));

// One Gemini CLI session (generic jsonl) in the fake HOME.
const repo = path.join(home, "work", "billing");
fs.mkdirSync(repo, { recursive: true });
const sess = path.join(home, ".gemini", "sessions", "s.jsonl");
fs.mkdirSync(path.dirname(sess), { recursive: true });
const t = (i) => new Date(Date.now() - 60_000 + i * 1000).toISOString();
fs.writeFileSync(
  sess,
  [
    { sessionId: "b1", type: "user", cwd: repo, timestamp: t(1), content: "Keputusan: kita pakai Stripe daripada Midtrans karena butuh subscription." },
    { sessionId: "b1", role: "model", cwd: repo, timestamp: t(2), content: "TODO: tambahkan webhook handler untuk invoice.paid." },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n"
);

const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
const onb = require("../dist/engine/onboarding.js");

test("fresh install is not onboarded; detection reports which tools have data", () => {
  assert.equal(onb.isOnboarded(), false);
  const tools = onb.detectTools();
  const gemini = tools.find((x) => x.tool === "gemini");
  assert.equal(gemini.found, true);
  assert.equal(gemini.integration, "gemini");
  assert.equal(tools.find((x) => x.tool === "codex").found, false);
});

test("startOnboarding connects, imports, triages, and summarises the project", async () => {
  onb.startOnboarding(["gemini"]);
  let s;
  for (let i = 0; i < 100; i++) {
    s = onb.onboardingStatus();
    if (s.phase === "done" || s.phase === "error") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(s.phase, "done", s.error);
  assert.deepEqual(s.connected, ["Gemini CLI"]);
  assert.ok(s.transcripts >= 2);
  assert.ok(s.memories >= 1);
  assert.equal(onb.isOnboarded(), true);
  // MCP registration landed in the fake HOME only.
  assert.ok(fs.existsSync(path.join(home, ".gemini", "settings.json")));

  const summary = onb.rememberedSummary(3);
  assert.equal(summary.length, 1);
  const kinds = summary[0].memories.map((m) => m.kind);
  assert.ok(kinds.includes("decision"));
  assert.ok(kinds.includes("task_pending"), "a fresh TODO stays pending");
});

test("an existing install with memories counts as onboarded (no wizard)", () => {
  dbmod.setSetting("onboardingDone", "");
  assert.equal(onb.isOnboarded(), true);
});
