/* ---------- VS Code (Copilot Chat) and Cursor (Composer) sessions ----------
 * The generic vscdb scanner only looks at ItemTable keys; neither editor keeps
 * its conversations there any more.
 *
 * VS Code: workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl is an
 *   operation log (src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts):
 *     { kind: 0, v }            initial state
 *     { kind: 1, k: path, v }   set value at path
 *     { kind: 2, k: path, v, i} push v to the array at path (truncate at i)
 *     { kind: 3, k: path }      delete
 *   Older builds wrote <sessionId>.json with the plain state. The state has
 *   requests[] with message (string | { text }) and response[] parts.
 *   The project folder comes from workspaceStorage/<hash>/workspace.json.
 *
 * Cursor: globalStorage/state.vscdb, table cursorDiskKV:
 *   composerData:<id>  { conversation: [{ type: 1|2, text }] } (older), or
 *                      { fullConversationHeadersOnly: [{ bubbleId, type }] }
 *   bubbleId:<id>:<bubbleId>  { type, text }
 *   type 1 = user, 2 = assistant. The workspace of each composer is listed in
 *   workspaceStorage/<hash>/state.vscdb ItemTable "composer.composerData".
 * ------------------------------------------------------------------------- */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { insertTranscript, seqAllocator, ensureProject, getSourceOffset, setSourceOffset } from "../store/db";
import { withTx } from "../store/tx";
import { projectSlugFromCwd, stripInjectedTags } from "./util";

type Role = "user" | "assistant" | "tool";
interface Msg {
  role: Role;
  text: string;
  ts: number;
}

/** Replay a VS Code object mutation log into the final state. */
export function replayMutationLog(lines: string[]): any {
  let state: any = null;
  const walk = (k: Array<string | number>) => {
    let cur = state;
    for (let i = 0; i < k.length - 1; i++) {
      if (cur == null) return null;
      cur = cur[k[i]];
    }
    return cur;
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.kind === 0) state = e.v;
    else if (state == null) continue;
    else if ((e.kind === 1 || e.kind === 3) && Array.isArray(e.k) && e.k.length) {
      const parent = walk(e.k);
      if (parent != null) parent[e.k[e.k.length - 1]] = e.kind === 3 ? undefined : e.v;
    } else if (e.kind === 2 && Array.isArray(e.k) && e.k.length) {
      const parent = walk(e.k);
      if (parent == null) continue;
      const key = e.k[e.k.length - 1];
      const arr: unknown[] = Array.isArray(parent[key]) ? parent[key] : [];
      if (typeof e.i === "number") arr.length = e.i;
      if (Array.isArray(e.v)) arr.push(...e.v);
      parent[key] = arr;
    }
  }
  return state;
}

function partText(p: any): { role: Role; text: string } | null {
  if (!p || typeof p !== "object") return null;
  if (p.kind === "thinking" || p.kind === "progressMessage" || p.kind === "undoStop" || p.kind === "codeblockUri") return null;
  if (p.kind === "toolInvocationSerialized" || p.kind === "toolInvocation" || p.kind === "prepareToolInvocation") {
    const msg = p.pastTenseMessage?.value || p.invocationMessage?.value || p.toolId || "";
    return msg ? { role: "tool", text: String(msg) } : null;
  }
  if (typeof p.value === "string" && (p.kind === undefined || p.kind === "markdownContent" || "isTrusted" in p || "supportThemeIcons" in p)) {
    return { role: "assistant", text: p.value };
  }
  return null;
}

/** Messages from a VS Code chat session state. */
export function vscodeSessionMessages(state: any): Msg[] {
  const out: Msg[] = [];
  const base = Number(state?.creationDate) || 0;
  for (const r of Array.isArray(state?.requests) ? state.requests : []) {
    if (!r || r.isHidden || r.hiddenFromTranscript) continue;
    const ts = Number(r.timestamp) || base || 0;
    const msg = typeof r.message === "string" ? r.message : typeof r.message?.text === "string" ? r.message.text : "";
    if (msg.trim()) out.push({ role: "user", text: msg, ts });
    const assistant: string[] = [];
    const tools: string[] = [];
    for (const p of Array.isArray(r.response) ? r.response : []) {
      const t = partText(p);
      if (!t) continue;
      (t.role === "tool" ? tools : assistant).push(t.text);
    }
    if (assistant.join("").trim()) out.push({ role: "assistant", text: assistant.join(""), ts: ts + 1 });
    if (tools.length) out.push({ role: "tool", text: tools.join("\n"), ts: ts + 2 });
  }
  return out;
}

function workspaceFolder(dir: string): string | undefined {
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(dir, "workspace.json"), "utf8"));
    const uri = ws.folder || ws.workspace;
    if (typeof uri !== "string" || !uri.startsWith("file://")) return undefined;
    const p = fileURLToPath(uri);
    return p.endsWith(".code-workspace") ? path.dirname(p) : p;
  } catch {
    return undefined;
  }
}

function insertAll(tool: string, sessionId: string, folder: string | undefined, msgs: Msg[]): number {
  const projectId = ensureProject(projectSlugFromCwd(folder), folder);
  const nextSeq = seqAllocator(tool);
  let n = 0;
  withTx(() => {
    for (const m of msgs) {
      const text = m.role === "tool" ? m.text : stripInjectedTags(m.text);
      if (!text.trim()) continue;
      if (insertTranscript({ tool, sessionId, projectId, role: m.role, content: text.slice(0, 20000), ts: m.ts || Date.now(), seq: nextSeq(sessionId) })) n++;
    }
  });
  return n;
}

/** VS Code chat sessions under a workspaceStorage folder. */
export function scanVscodeChatSessions(workspaceStorage: string, tool = "vscode"): number {
  if (!fs.existsSync(workspaceStorage)) return 0;
  let total = 0;
  for (const hash of fs.readdirSync(workspaceStorage)) {
    const dir = path.join(workspaceStorage, hash);
    const sessDir = path.join(dir, "chatSessions");
    if (!fs.existsSync(sessDir)) continue;
    const folder = workspaceFolder(dir);
    for (const name of fs.readdirSync(sessDir)) {
      if (!name.endsWith(".jsonl") && !name.endsWith(".json")) continue;
      const file = path.join(sessDir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      // Files are rewritten/compacted in place: re-read when mtime changes
      // (insertTranscript skips messages that are already stored).
      if (getSourceOffset(tool, file) === Math.floor(st.mtimeMs)) continue;
      const raw = fs.readFileSync(file, "utf8");
      let state: any = null;
      if (name.endsWith(".jsonl")) state = replayMutationLog(raw.split("\n"));
      else {
        try {
          state = JSON.parse(raw);
        } catch {
          state = null;
        }
      }
      const msgs = state ? vscodeSessionMessages(state) : [];
      if (msgs.length) total += insertAll(tool, String(state.sessionId || name.replace(/\.jsonl?$/, "")), folder, msgs);
      setSourceOffset(tool, file, Math.floor(st.mtimeMs), st.mtimeMs);
    }
  }
  return total;
}

/** composerId → workspace folder, from each workspace's state.vscdb. */
function cursorComposerFolders(workspaceStorage: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(workspaceStorage)) return map;
  for (const hash of fs.readdirSync(workspaceStorage)) {
    const dir = path.join(workspaceStorage, hash);
    const dbFile = path.join(dir, "state.vscdb");
    const folder = workspaceFolder(dir);
    if (!folder || !fs.existsSync(dbFile)) continue;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as { value: string | Uint8Array } | undefined;
      if (!row) continue;
      const v = typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value);
      for (const c of JSON.parse(v)?.allComposers || []) if (c?.composerId) map.set(String(c.composerId), folder);
    } catch {
      /* locked or unexpected format */
    } finally {
      db?.close();
    }
  }
  return map;
}

/** Cursor composer conversations from globalStorage/state.vscdb. */
export function scanCursorComposer(globalStorage: string, workspaceStorage: string, tool = "cursor"): number {
  const file = path.join(globalStorage, "state.vscdb");
  if (!fs.existsSync(file)) return 0;
  const mtime = Math.floor(fs.statSync(file).mtimeMs);
  if (getSourceOffset(`${tool}-composer`, file) === mtime) return 0;
  let db: DatabaseSync | null = null;
  let total = 0;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const hasKv = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cursorDiskKV'").get();
    if (!hasKv) return 0;
    const folders = cursorComposerFolders(workspaceStorage);
    const decode = (v: unknown) => (typeof v === "string" ? v : v instanceof Uint8Array ? new TextDecoder().decode(v) : "");
    const bubble = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as Array<{ key: string; value: unknown }>;
    for (const r of rows) {
      let c: any;
      try {
        c = JSON.parse(decode(r.value));
      } catch {
        continue;
      }
      const id = String(c?.composerId || r.key.slice("composerData:".length));
      const base = Number(c?.createdAt) || 0;
      let items: any[] = Array.isArray(c?.conversation) ? c.conversation : [];
      if (!items.length && Array.isArray(c?.fullConversationHeadersOnly)) {
        items = c.fullConversationHeadersOnly.map((h: any) => {
          try {
            const b = bubble.get(`bubbleId:${id}:${h.bubbleId}`) as { value: unknown } | undefined;
            return b ? JSON.parse(decode(b.value)) : null;
          } catch {
            return null;
          }
        });
      }
      const msgs: Msg[] = [];
      items.forEach((b: any, i: number) => {
        if (!b || typeof b.text !== "string" || !b.text.trim()) return;
        const role: Role | null = b.type === 1 ? "user" : b.type === 2 ? "assistant" : null;
        if (!role) return;
        const ts = Number(b.timingInfo?.clientStartTime) || Number(b.createdAt) || base + i;
        msgs.push({ role, text: b.text, ts });
      });
      if (msgs.length) total += insertAll(tool, `composer:${id}`, folders.get(id), msgs);
    }
    setSourceOffset(`${tool}-composer`, file, mtime, mtime);
  } catch {
    /* database locked by Cursor: retried next scan */
  } finally {
    db?.close();
  }
  return total;
}
