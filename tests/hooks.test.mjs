/* Claude Code native hooks: install/remove in settings.json (other hooks
 * untouched, idempotent), SessionStart prints resume context, Stop/SessionEnd
 * import the transcript, and the real CLI behaves like Claude Code expects. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-hooks-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-hooks-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
dbmod.setSetting("autoInjectProjectFiles", "0");
const hooks = require("../dist/engine/hooks/claude.js");
const script = path.resolve("dist/engine/index.js");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-hooks-repo-"));
const settings = path.join(home, ".claude", "settings.json");

test("install keeps the user's own hooks, is idempotent, and remove only removes ours", () => {
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
  assert.ok(hooks.installClaudeHooks("node", script).ok);
  assert.ok(hooks.installClaudeHooks("node", script).ok, "second install replaces, does not duplicate");
  const cfg = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(cfg.model, "opus");
  assert.equal(cfg.hooks.Stop.length, 2, "user hook + ours");
  assert.equal(cfg.hooks.Stop[0].hooks[0].command, "say done");
  for (const ev of hooks.HOOK_EVENTS) assert.equal(cfg.hooks[ev].filter((g) => g.hooks.some((h) => h.command.includes(" hook " + ev))).length, 1, ev);
  assert.equal(cfg.hooks.SessionStart[0].hooks[0].async, undefined, "SessionStart is synchronous so its stdout becomes context");
  assert.equal(cfg.hooks.Stop[1].hooks[0].async, true);
  assert.ok(hooks.claudeHooksInstalled());

  const r = hooks.removeClaudeHooks();
  assert.equal(r.removed, 4);
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual(after.hooks, { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
  assert.equal(hooks.claudeHooksInstalled(), false);
});

test("install refuses to touch a settings file it cannot parse", () => {
  const bad = path.join(home, "bad-settings.json");
  fs.writeFileSync(bad, "{ not json");
  assert.equal(hooks.installClaudeHooks("node", script, bad).ok, false);
  assert.equal(fs.readFileSync(bad, "utf8"), "{ not json");
});

test("hook command quotes paths with spaces", () => {
  const cmd = hooks.hookCommand("node", "/Users/me/Personal Project/dist/engine/index.js", "Stop");
  if (process.platform !== "win32") assert.equal(cmd, "node '/Users/me/Personal Project/dist/engine/index.js' hook Stop");
  const el = hooks.hookCommand("/Applications/Memoria.app/Contents/MacOS/Memoria", script, "Stop");
  assert.match(el, /ELECTRON_RUN_AS_NODE=1/);
});

test("Stop imports the session transcript; transcripts outside ~/.claude/projects are ignored", async () => {
  const file = path.join(home, ".claude", "projects", "-repo", "sess-h1.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = (i) => new Date(Date.now() - 60000 + i * 1000).toISOString();
  fs.writeFileSync(file, [
    { type: "user", sessionId: "h1", cwd: repo, timestamp: t(1), message: { content: "Keputusan: kita pakai Redis daripada memcached untuk cache sesi." } },
    { type: "assistant", sessionId: "h1", cwd: repo, timestamp: t(2), message: { content: [{ type: "text", text: "TODO: tambahkan TTL 24 jam untuk key sesi." }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  await hooks.runHook("Stop", { transcript_path: file, cwd: repo });
  const n = dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM transcripts WHERE session_id = 'h1'").get().c;
  assert.equal(n, 2);
  const outside = path.join(os.tmpdir(), "evil.jsonl");
  fs.writeFileSync(outside, JSON.stringify({ type: "user", sessionId: "evil", cwd: repo, timestamp: t(3), message: { content: "x" } }) + "\n");
  await hooks.runHook("Stop", { transcript_path: outside, cwd: repo });
  assert.equal(dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM transcripts WHERE session_id = 'evil'").get().c, 0);
  await hooks.runHook("SessionEnd", { transcript_path: file, cwd: repo });
  assert.ok(dbmod.countMemories() >= 1, "SessionEnd extracts memories");
});

test("real CLI: SessionStart prints only the resume context, fast; unknown project prints nothing", () => {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script, "hook", "SessionStart"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: repo, session_id: "new" }),
    env,
    encoding: "utf8",
  });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Memoria: context from earlier sessions/);
  assert.match(r.stdout, /Redis/);
  assert.ok(!r.stdout.includes("[memoria]"), "engine logs never reach stdout");
  assert.ok(ms < 5000, `SessionStart took ${ms} ms`);

  const none = spawnSync(process.execPath, [script, "hook", "SessionStart"], { input: JSON.stringify({ cwd: "/nonexistent/xyz" }), env, encoding: "utf8" });
  assert.equal(none.status, 0);
  assert.equal(none.stdout, "");

  const garbage = spawnSync(process.execPath, [script, "hook", "Stop"], { input: "not json", env, encoding: "utf8" });
  assert.equal(garbage.status, 0, "bad input never fails Claude Code");
});

test("claudeHooks=0 turns the hooks into no-ops", async () => {
  dbmod.setSetting("claudeHooks", "0");
  assert.equal(await hooks.runHook("SessionStart", { cwd: repo }), "");
  dbmod.setSetting("claudeHooks", "1");
});
