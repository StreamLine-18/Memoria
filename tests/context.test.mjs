/* Progressive disclosure (project_context index + get_memory) dan metrik
 * pemakaian konteks lokal, diuji lewat klien MCP sungguhan (in-memory). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-ctx-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
const { createMcpServer, indexText, INDEX_SNIPPET } = require("../dist/engine/mcp/server.js");
const { usageSummary, estimateTokens } = require("../dist/engine/retrieve/usage.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-ctx-proj-"));
const pid = dbmod.ensureProject("ctx-proj", projPath);
const long = "Keputusan: kita pakai SQLite FTS5 daripada Elasticsearch karena app ini offline-first, ".repeat(4).trim();
const ids = [
  dbmod.insertMemory({ projectId: pid, kind: "decision", content: long, importance: 0.8, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude" }),
  dbmod.insertMemory({ projectId: pid, kind: "task_pending", content: "TODO: tambahkan test parser Codex", importance: 0.7, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "codex" }),
];

async function connect() {
  const server = createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("indexText: memori pendek utuh, panjang dipotong dengan petunjuk get_memory", () => {
  const out = indexText([
    { id: 1, kind: "fact", content: "short one" },
    { id: 2, kind: "decision", content: "x".repeat(300) },
    { id: 3, kind: "brief", content: "b".repeat(300) },
  ]);
  const lines = out.split("\n");
  assert.equal(lines[0], "#1 [fact] short one");
  assert.ok(lines[1].length <= INDEX_SNIPPET + 20 && lines[1].endsWith("…"));
  assert.ok(lines[2].includes("b".repeat(300)), "brief selalu utuh");
  assert.match(out, /1 entry is truncated .*get_memory/);
});

test("MCP project_context: default index lebih ringkas, get_memory memberi teks penuh, pemakaian tercatat", async () => {
  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("get_memory"));

  const idx = textOf(await client.callTool({ name: "project_context", arguments: { project: "ctx-proj" } }));
  const full = textOf(await client.callTool({ name: "project_context", arguments: { project: "ctx-proj", mode: "full" } }));
  assert.ok(idx.includes(`#${ids[0]} [decision]`));
  assert.ok(!idx.includes(long), "teks panjang tidak dikirim utuh di mode index");
  assert.ok(full.includes(long));

  const got = textOf(await client.callTool({ name: "get_memory", arguments: { ids: [ids[0], 999999] } }));
  assert.ok(got.includes(long));
  assert.ok(got.includes("#999999 not found"));

  const u = usageSummary(1);
  assert.equal(u.calls, 3);
  assert.ok(u.tokensSavedByIndex > 0, "mode index harus mencatat penghematan");
  assert.equal(u.bySource.project_context.calls, 2);
  assert.equal(u.bySource.get_memory.calls, 1);
  assert.equal(estimateTokens("abcd"), 1);
});

test("handoff: blok resume yang ditulis tercatat sebagai satu pengiriman konteks", async () => {
  const { injectHandoffAll } = require("../dist/engine/handoff.js");
  const before = usageSummary(1).resumeBlocks;
  const rs = await injectHandoffAll("ctx-proj", { slim: true });
  assert.ok(rs.some((r) => r.ok));
  assert.equal(usageSummary(1).resumeBlocks, before + 1, "satu blok per injeksi, bukan per file");
});
