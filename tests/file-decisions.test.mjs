/* file_context (memories about a file path) and superseded decisions. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-fd-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
const { fileContext } = require("../dist/engine/retrieve/filecontext.js");
const { addMemoryWithDedupe } = require("../dist/engine/extract/dedupe.js");
const { restoreDecision } = require("../dist/engine/extract/supersede.js");
const { projectContext, searchMemories } = require("../dist/engine/retrieve/search.js");
const { collectResumeData } = require("../dist/engine/handoff.js");
const { createMcpServer } = require("../dist/engine/mcp/server.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const pid = dbmod.ensureProject("fd-proj", fs.mkdtempSync(path.join(os.tmpdir(), "memoria-fd-proj-")));
const mem = (over) => ({ projectId: pid, importance: 0.6, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic", ...over });

test("file_context: matches by trailing path segments, ignores look-alikes, needs 2 segments for generic names", () => {
  const a = dbmod.insertMemory(mem({ kind: "error_fixed", content: "Fixed the 500 in src/engine/http.ts: node:sqlite rows are null-prototype objects." }));
  const b = dbmod.insertMemory(mem({ kind: "decision", content: "Keep the router in engine/http.ts as a flat if/else until the refactor." }));
  dbmod.insertMemory(mem({ kind: "fact", content: "web/myhttp.tsx renders the request inspector." }));
  const d = dbmod.insertMemory(mem({ kind: "fact", content: "apps/web/app/page.tsx is the marketing landing page." }));
  const c = dbmod.insertMemory(mem({ kind: "task_pending", content: "TODO: split src/app/page.tsx into sections." }));
  dbmod.insertMemory(mem({ kind: "fact", content: "components/page.tsx wraps every route." }));

  const hits = fileContext("/Users/dev/repo/src/engine/http.ts");
  assert.deepEqual(hits.map((h) => h.id), [a, b], "most specific match first, look-alike excluded");
  assert.equal(fileContext("http.ts").length, 2);
  // page.tsx is generic: a bare basename must not match every project's page.
  assert.equal(fileContext("page.tsx").length, 0);
  // 3 matching segments rank above 2; a single shared "page.tsx" is not enough.
  assert.deepEqual(fileContext("/repo/src/app/page.tsx").map((h) => h.id), [c, d]);
});

test("supersede: a newer decision about the same subject replaces the older one", () => {
  const t0 = Date.now() - 60_000;
  const r1 = addMemoryWithDedupe(mem({ kind: "decision", content: "Keputusan: deploy worker ke Vercel pakai cron functions.", createdAt: t0 }));
  assert.ok(r1.inserted);
  const oldId = dbmod.readMemories("WHERE project_id = ? AND content LIKE '%Vercel pakai cron%'", [pid])[0].id;
  const unrelated = addMemoryWithDedupe(mem({ kind: "decision", content: "Keputusan: pakai pnpm daripada npm untuk monorepo.", createdAt: t0 }));
  assert.ok(unrelated.inserted);

  addMemoryWithDedupe(mem({ kind: "decision", content: "Keputusan baru: worker pindah dari Vercel ke Railway karena harus jalan 24/7." }));
  const old = dbmod.memoryById(oldId);
  assert.ok(old.validTo > 0, "old decision closed");
  assert.equal(dbmod.getDb().prepare("SELECT superseded_by FROM memories WHERE id = ?").get(oldId).superseded_by > 0, true);

  const ctx = projectContext("fd-proj", 20).map((h) => h.id);
  assert.ok(!ctx.includes(oldId), "project context shows only current decisions");
  assert.ok(dbmod.readMemories("WHERE content LIKE '%pnpm daripada npm%'", [])[0].validTo === 0, "different subject untouched");

  const hit = searchMemories("vercel cron worker", { limit: 10 }).find((h) => h.id === oldId);
  assert.ok(hit && hit.superseded, "history stays searchable, flagged");

  assert.ok(restoreDecision(oldId));
  assert.equal(dbmod.memoryById(oldId).validTo, 0);
  assert.ok(projectContext("fd-proj", 20).some((h) => h.id === oldId));
});

test("supersede: resume block lists only current decisions", async () => {
  const p2 = dbmod.ensureProject("fd-proj2", fs.mkdtempSync(path.join(os.tmpdir(), "memoria-fd2-")));
  addMemoryWithDedupe(mem({ projectId: p2, kind: "decision", content: "Decided to use Postgres on Neon for the staging database.", createdAt: Date.now() - 5000 }));
  addMemoryWithDedupe(mem({ projectId: p2, kind: "decision", content: "Decided to move staging from Postgres on Neon to Supabase for auth." }));
  const data = await collectResumeData("fd-proj2");
  const decs = data.decisions.map((d) => d.content || d);
  assert.equal(decs.length, 1);
  assert.match(String(decs[0]), /Supabase/);
});

test("MCP file_context tool", async () => {
  const server = createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = await client.callTool({ name: "file_context", arguments: { path: "src/engine/http.ts" } });
  const text = r.content.map((c) => c.text).join("");
  assert.match(text, /Known about src\/engine\/http\.ts/);
  assert.match(text, /\[error_fixed\]/);
});
