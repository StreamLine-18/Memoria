/* Team project brain: .memoria/brain.md shared through a repository. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

const dbmod = require("../dist/engine/store/db.js");
const brain = require("../dist/engine/team/brain.js");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-brain-repo-"));
const dirs = {};
function use(name) {
  dbmod.closeDb();
  if (!dirs[name]) dirs[name] = fs.mkdtempSync(path.join(os.tmpdir(), `memoria-brain-${name}-`));
  dbmod.initDb(dirs[name]);
  return dbmod.ensureProject("team-repo", repo);
}
const mem = (pid, kind, content, over = {}) =>
  dbmod.insertMemory({ projectId: pid, kind, content, importance: 0.6, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic", ...over });

test("export: current decisions, conventions, fixes, open tasks; no drafts, no superseded, secrets redacted", () => {
  const pid = use("alice");
  mem(pid, "decision", "Use Postgres on Neon for staging data.");
  mem(pid, "preference", "Never commit .env files; deploy secrets live in Railway.");
  mem(pid, "error_fixed", "ECONNREFUSED on start: DATABASE_URL was missing, fixed by adding .env.local.");
  mem(pid, "task_pending", "Add rate limiting to POST /api/orders.");
  mem(pid, "fact", "Draft that should stay private.", { status: "draft" });
  const old = mem(pid, "decision", "Use SQLite for staging.");
  dbmod.getDb().prepare("UPDATE memories SET valid_to = ?, superseded_by = 1 WHERE id = ?").run(Date.now(), old);
  // Inserted directly to bypass redaction, so the export redaction is what is tested.
  dbmod.getDb().prepare("UPDATE memories SET content = ? WHERE kind = 'preference'").run("Never commit .env files; token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB lives in Railway.");

  const r = brain.exportBrain("team-repo");
  assert.equal(r.entries, 4);
  const text = fs.readFileSync(path.join(repo, ".memoria", "brain.md"), "utf8");
  for (const h of ["## Decisions", "## Conventions", "## Known issues and fixes", "## Open tasks"]) assert.ok(text.includes(h), h);
  assert.ok(!text.includes("SQLite"), "superseded decision left out");
  assert.ok(!text.includes("Draft that should stay private"));
  assert.ok(!text.includes("ghp_abcdef"), "secret redacted on export");
  assert.match(text, /<!-- m:[\w-]+ -->/);
  assert.equal(brain.exportBrain("team-repo").changed, false, "stable output, no rewrite");
  const own = brain.importBrain("team-repo");
  assert.equal(own.added + own.updated + own.archived, 0, "own unchanged export is not re-imported");
});

test("a teammate imports it, review edits flow back, removed lines archive team memories only", () => {
  const pid = use("bob");
  mem(pid, "fact", "Bob's own local note about the test runner.");
  const r = brain.importBrain("team-repo");
  assert.equal(r.added, 4);
  const team = dbmod.readMemories("WHERE project_id = ? AND origin = 'team'", [pid]);
  assert.equal(team.length, 4);
  assert.ok(team.some((m) => m.kind === "error_fixed" && /DATABASE_URL/.test(m.content)));
  assert.equal(brain.importBrain("team-repo").added, 0, "re-import does not duplicate");

  // Review: edit one line, delete another.
  const file = path.join(repo, ".memoria", "brain.md");
  let text = fs.readFileSync(file, "utf8");
  text = text.replace("Use Postgres on Neon for staging data.", "Use Postgres 16 on Neon for staging data.");
  text = text.split("\n").filter((l) => !l.includes("rate limiting")).join("\n");
  fs.writeFileSync(file, text);
  const r2 = brain.importBrain("team-repo");
  assert.equal(r2.updated, 1);
  assert.equal(r2.archived, 1);
  assert.ok(dbmod.readMemories("WHERE content LIKE '%Postgres 16%'", []).length === 1);
  assert.equal(dbmod.readMemories("WHERE content LIKE '%Bob''s own local note%' AND archived = 0", []).length, 1, "local memories untouched");

  // Bob adds a line by hand.
  fs.appendFileSync(file, "\n## Conventions\n\n- Use conventional commits for every pull request.\n");
  assert.equal(brain.importBrain("team-repo").added, 1);
  // Back on Alice's side the same uids are recognised.
  use("alice");
  const r3 = brain.importBrain("team-repo");
  assert.equal(r3.added, 1, "only Bob's new line is new for Alice");
  assert.equal(r3.updated, 1, "Alice's decision updated from review");
  assert.equal(dbmod.readMemories("WHERE content LIKE 'Add rate limiting%' AND archived = 0", []).length, 1, "Alice's own task is never archived by a teammate's removal");
});

test("parseBrain ignores unknown sections and short lines", () => {
  const e = brain.parseBrain("## Random\n- not a memory line here\n## Decisions\n- ok\n- Use pnpm workspaces. <!-- m:abc12345-x -->\n");
  assert.deepEqual(e, [{ kind: "decision", content: "Use pnpm workspaces.", uid: "abc12345-x" }]);
});
