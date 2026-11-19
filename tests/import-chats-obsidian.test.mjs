/* ChatGPT / Claude data exports (zip + json) and two-way Obsidian sync. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { deflateRawSync, crc32 } from "node:zlib";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-imp-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
const { importChatExport, detectChatSource } = require("../dist/engine/import/chats.js");
const { readZipEntry } = require("../dist/engine/import/zip.js");
const { syncObsidianVault, parseNote } = require("../dist/engine/export/obsidian.js");
const { extractQueue } = require("../dist/engine/extract/extractor.js");

/** Minimal zip writer (deflate) to build realistic export archives. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = deflateRawSync(data);
    const n = Buffer.from(name);
    const crc = crc32 ? crc32(data) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp);
    centrals.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const chatgpt = [
  {
    title: "Thesis outline",
    id: "cg-1",
    create_time: 1794000000,
    current_node: "c",
    mapping: {
      root: { message: null, parent: null },
      sys: { message: { author: { role: "system" }, content: { parts: ["You are ChatGPT"] }, create_time: 1794000001 }, parent: "root" },
      a: { message: { author: { role: "user" }, content: { parts: ["Keputusan: bab 2 pakai metode kualitatif daripada survei karena sampelnya kecil."] }, create_time: 1794000002 }, parent: "sys" },
      old: { message: { author: { role: "assistant" }, content: { parts: ["(regenerated, not on the visible thread)"] }, create_time: 1794000003 }, parent: "a" },
      b: { message: { author: { role: "assistant" }, content: { parts: ["Good. TODO: tulis kerangka wawancara untuk 8 responden."] }, create_time: 1794000004 }, parent: "a" },
      c: { message: { author: { role: "user" }, content: { parts: ["Jangan pakai bahasa terlalu formal di bab pendahuluan."] }, create_time: 1794000005 }, parent: "b" },
    },
  },
];
const claudeAi = [
  {
    uuid: "cl-1",
    name: "Newsletter plan",
    created_at: "2026-11-01T10:00:00Z",
    chat_messages: [
      { sender: "human", text: "We decided to send the newsletter on Tuesdays instead of Fridays.", created_at: "2026-11-01T10:00:01Z" },
      { sender: "assistant", content: [{ type: "text", text: "Noted. Next step: draft the first Tuesday issue." }], created_at: "2026-11-01T10:00:02Z" },
    ],
  },
];

test("zip reader extracts conversations.json from a deflate archive", () => {
  const zip = makeZip({ "user.json": "{}", "conversations.json": JSON.stringify(chatgpt) });
  assert.deepEqual(JSON.parse(readZipEntry(zip, "conversations.json").toString()), chatgpt);
  assert.equal(detectChatSource(chatgpt), "chatgpt");
  assert.equal(detectChatSource(claudeAi), "claude-ai");
  assert.equal(detectChatSource([{ foo: 1 }]), null);
});

test("ChatGPT export: visible thread only, system prompt skipped, re-import adds nothing", () => {
  const file = path.join(tmp("mem-cg-"), "chatgpt-export.zip");
  fs.writeFileSync(file, makeZip({ "conversations.json": JSON.stringify(chatgpt) }));
  const r = importChatExport(file);
  assert.equal(r.source, "chatgpt");
  assert.equal(r.conversations, 1);
  const rows = dbmod.getDb().prepare("SELECT role, content FROM transcripts WHERE tool = 'chatgpt' ORDER BY seq").all();
  assert.deepEqual(rows.map((x) => x.role), ["system", "user", "assistant", "user"]);
  assert.equal(rows[0].content, "Conversation: Thesis outline");
  assert.ok(!rows.some((x) => x.content.includes("regenerated")), "regenerated branch not imported");
  assert.ok(!rows.some((x) => x.content === "You are ChatGPT"));
  assert.equal(importChatExport(file).messages, 0, "re-import is a no-op");
});

test("Claude export (plain conversations.json) and memories come out of it", async () => {
  const file = path.join(tmp("mem-cl-"), "conversations.json");
  fs.writeFileSync(file, JSON.stringify(claudeAi));
  const r = importChatExport(file);
  assert.equal(r.source, "claude-ai");
  assert.equal(r.messages, 3);
  for (let i = 0; i < 5; i++) if (!(await extractQueue(true))) break;
  const mems = dbmod.readMemories("WHERE source_tool IN ('chatgpt','claude-ai') AND status = 'active'", []);
  assert.ok(mems.some((m) => m.kind === "decision" && /Tuesdays|kualitatif/.test(m.content)), "decisions from chat history become memories");
});

test("Obsidian two-way: export, edit, new note, delete, DB change", () => {
  const vault = tmp("mem-vault-");
  const pid = dbmod.ensureProject("vault-proj", undefined);
  const a = dbmod.insertMemory({ projectId: pid, kind: "decision", content: "Use Postgres for the billing service.", importance: 0.7, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active" });
  const b = dbmod.insertMemory({ projectId: pid, kind: "fact", content: "The staging URL is staging.example.com.", importance: 0.5, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active" });

  const first = syncObsidianVault(vault);
  assert.ok(first.ok, first.error);
  const noteA = path.join(vault, JSON.parse(fs.readFileSync(path.join(vault, ".memoria-sync.json"), "utf8"))[dbmod.memoryById(a).uid].file);
  const parsed = parseNote(fs.readFileSync(noteA, "utf8"));
  assert.equal(parsed.meta.memoria_id, dbmod.memoryById(a).uid);
  assert.equal(parsed.body, "Use Postgres for the billing service.");
  const again = syncObsidianVault(vault);
  assert.equal(again.written, 0, "nothing rewritten when nothing changed");
  assert.equal(again.updatedFromNotes, 0);

  // Edit in Obsidian: body + kind.
  fs.writeFileSync(noteA, fs.readFileSync(noteA, "utf8").replace("Use Postgres for the billing service.", "Use Postgres 16 on Neon for the billing service.").replace("kind: decision", "kind: preference"));
  // New note written by the user.
  fs.mkdirSync(path.join(vault, "vault-proj"), { recursive: true });
  const mine = path.join(vault, "vault-proj", "my-note.md");
  fs.writeFileSync(mine, "---\nkind: task_pending\n---\n\nRotate the Stripe webhook secret before launch.\n");
  // Delete b's note.
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, ".memoria-sync.json"), "utf8"));
  fs.unlinkSync(path.join(vault, manifest[dbmod.memoryById(b).uid].file));

  const r = syncObsidianVault(vault);
  assert.equal(r.updatedFromNotes, 1);
  assert.equal(r.createdFromNotes, 1);
  assert.equal(r.archivedFromNotes, 1);
  assert.equal(dbmod.memoryById(a).content, "Use Postgres 16 on Neon for the billing service.");
  assert.equal(dbmod.memoryById(a).kind, "preference");
  assert.equal(dbmod.getDb().prepare("SELECT archived FROM memories WHERE id = ?").get(b).archived, 1);
  const created = dbmod.readMemories("WHERE source_tool = 'obsidian'", [])[0];
  assert.equal(created.kind, "task_pending");
  assert.equal(created.projectId, pid, "folder name maps to the project");
  assert.match(fs.readFileSync(mine, "utf8"), /memoria_id: /, "id written back into the user's note");

  // Change in Memoria → note rewritten.
  dbmod.updateMemory(a, { content: "Use Postgres 16 on Neon (region ap-southeast-1) for billing." });
  syncObsidianVault(vault);
  assert.match(fs.readFileSync(noteA, "utf8"), /ap-southeast-1/);
});

test("Obsidian: notes from the old one-way export are replaced, not duplicated", () => {
  const vault = tmp("mem-vault-old-");
  fs.writeFileSync(path.join(vault, "m1-old.md"), "---\nkind: fact\njenis: Fakta\n---\n\nOld exported note.\n");
  const before = dbmod.readMemories("WHERE source_tool = 'obsidian'", []).length;
  const r = syncObsidianVault(vault);
  assert.equal(r.createdFromNotes, 0);
  assert.equal(dbmod.readMemories("WHERE source_tool = 'obsidian'", []).length, before);
  assert.equal(fs.existsSync(path.join(vault, "m1-old.md")), false);
});
