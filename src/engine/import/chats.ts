/* ---------- Import ChatGPT and Claude.ai data exports ----------
 * For people who think out loud in chat apps rather than coding tools
 * (writers, researchers, students). Both services email a .zip with a
 * conversations.json:
 *   ChatGPT  [{ title, create_time, mapping: { id: { message: { author: {role},
 *            content: { parts: [...] }, create_time }, parent } }, current_node }]
 *   Claude   [{ uuid, name, created_at, chat_messages: [{ sender: human|assistant,
 *            text | content: [{ type: "text", text }], created_at }] }]
 * Each conversation becomes a session (tool "chatgpt" / "claude-ai") in one
 * project per service, so Tier 0 extraction and triage run on it like on any
 * other source. Re-importing the same export adds nothing (transcript dedupe).
 * ------------------------------------------------------------------------- */
import { insertTranscript, ensureProject, seqAllocator } from "../store/db";
import { withTx } from "../store/tx";
import { readFileOrZipEntry } from "./zip";

export type ChatSource = "chatgpt" | "claude-ai";

export interface ChatImportResult {
  source: ChatSource;
  conversations: number;
  messages: number;
  skipped: number;
}

interface Msg {
  role: "user" | "assistant" | "tool";
  text: string;
  ts: number;
}

function sec(t: unknown): number {
  const n = Number(t);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const d = Date.parse(String(t || ""));
  return Number.isFinite(d) ? d : 0;
}

/** ChatGPT keeps every edit/regeneration as a tree; the visible thread is the
 * path from current_node back to the root. */
function chatgptThread(conv: any): Msg[] {
  const mapping = conv?.mapping || {};
  let node = conv?.current_node;
  const chain: any[] = [];
  const guard = new Set<string>();
  while (node && mapping[node] && !guard.has(node)) {
    guard.add(node);
    chain.push(mapping[node]);
    node = mapping[node].parent;
  }
  if (!chain.length) {
    // Exports without current_node: keep insertion order.
    chain.push(...Object.values(mapping).reverse());
  }
  const out: Msg[] = [];
  for (const n of chain.reverse()) {
    const m = n?.message;
    if (!m || m.metadata?.is_visually_hidden_from_conversation) continue;
    const role = m.author?.role;
    const parts: unknown[] = Array.isArray(m.content?.parts) ? m.content.parts : typeof m.content?.text === "string" ? [m.content.text] : [];
    const text = parts.filter((p) => typeof p === "string").join("\n").trim();
    if (!text) continue;
    const r = role === "user" ? "user" : role === "assistant" ? "assistant" : role === "tool" ? "tool" : null;
    if (!r) continue; // system prompts
    out.push({ role: r, text, ts: sec(m.create_time) || sec(conv.create_time) });
  }
  return out;
}

function claudeThread(conv: any): Msg[] {
  const out: Msg[] = [];
  for (const m of Array.isArray(conv?.chat_messages) ? conv.chat_messages : []) {
    const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    let text = typeof m.text === "string" ? m.text : "";
    if (!text && Array.isArray(m.content)) {
      text = m.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
    }
    text = text.trim();
    if (!text) continue;
    out.push({ role, text, ts: sec(m.created_at) || sec(conv.created_at) });
  }
  return out;
}

export function detectChatSource(data: unknown): ChatSource | null {
  if (!Array.isArray(data) || !data.length) return null;
  const first = data[0] as any;
  if (first && typeof first === "object" && first.mapping) return "chatgpt";
  if (first && typeof first === "object" && Array.isArray(first.chat_messages)) return "claude-ai";
  return null;
}

/** Import from a parsed conversations.json array. */
export function importChatConversations(data: unknown, source?: ChatSource): ChatImportResult {
  const src = source || detectChatSource(data);
  if (!src) throw new Error("Not a ChatGPT or Claude conversations export");
  const list = Array.isArray(data) ? data : [];
  const projectId = ensureProject(src === "chatgpt" ? "chatgpt" : "claude-ai");
  const res: ChatImportResult = { source: src, conversations: 0, messages: 0, skipped: 0 };
  const nextSeq = seqAllocator(src);
  withTx(() => {
    for (const conv of list) {
      const msgs = src === "chatgpt" ? chatgptThread(conv) : claudeThread(conv);
      if (!msgs.length) {
        res.skipped++;
        continue;
      }
      const sessionId = String((conv as any).id || (conv as any).conversation_id || (conv as any).uuid || (conv as any).title || "conversation");
      const title = String((conv as any).title || (conv as any).name || "").trim();
      let added = 0;
      if (title) {
        // The title is often the best one-line summary of the conversation.
        if (insertTranscript({ tool: src, sessionId, projectId, role: "system", content: `Conversation: ${title}`, ts: msgs[0].ts, seq: nextSeq(sessionId) })) added++;
      }
      for (const m of msgs) {
        if (insertTranscript({ tool: src, sessionId, projectId, role: m.role, content: m.text.slice(0, 20000), ts: m.ts || Date.now(), seq: nextSeq(sessionId) })) added++;
      }
      if (added) res.conversations++;
      res.messages += added;
    }
  });
  return res;
}

/** Import from a .zip export or a conversations.json file. */
export function importChatExport(file: string, source?: ChatSource): ChatImportResult {
  const raw = readFileOrZipEntry(file, "conversations.json");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("conversations.json is not valid JSON");
  }
  return importChatConversations(data, source);
}
