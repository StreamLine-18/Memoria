/* ---------- HeuristicProvider (Tier 0 — tanpa model, tanpa network) ----------
 * Tujuan: user TANPA Ollama/API key tetap mendapatkan memori sejak menit pertama
 * dan, saat limit-hopping, tool berikutnya langsung punya konteks.
 *  - extract: deteksi berbasis aturan (kalimat + list/checkbox + pola ID/EN)
 *    memanfaatkan gaya percakapan dev/AI: keputusan, task, error-fix, preferensi,
 *    fakta ber-entitas (path/command/url/versi/teknologi).
 *  - embed: hashing TF-IDF 256 dim (FNV-1a), pure JS — cukup untuk dedupe +
 *    kemiripan/graph; upgrade ke model embedding tetap didukung (backfill).
 * Kualitas tiap memori dinilai (confidence/signal). Sinyal kuat dapat
 * diaktifkan langsung (active, origin "heuristic") agar resume/recall/link
 * lintas-AI bekerja instan; sisanya masuk draft untuk tinjau.
 * ----------------------------------------------------------------------------- */

export const HASH_MODEL = "hash-256-v1";

const HASH_DIM = 256;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const TOKEN_RE = /[\s,.;:!?"'()[\]{}<>\\/|@#$%^&*+=~`-]+/;

/** Embedding murah tanpa model: hashing trick + normalisasi L2. */
export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(HASH_DIM).fill(0);
  const tokens = text.toLowerCase().split(TOKEN_RE).filter((t) => t.length > 1);
  if (!tokens.length) return vec;
  const counts = new Map<number, number>();
  // unigram + bigram kata + trigram karakter (membantu path/identifier/typo)
  const grams: string[] = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) grams.push(tokens[i] + "_" + tokens[i + 1]);
  for (const t of tokens) {
    if (t.length >= 4) {
      for (let i = 0; i <= t.length - 3; i++) grams.push("c:" + t.slice(i, i + 3));
    }
  }
  for (const g of grams) {
    const h = fnv1a(g) % HASH_DIM;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  for (const [h, c] of counts) vec[h] = 1 + Math.log(c); // sublinear TF
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < HASH_DIM; i++) vec[i] /= norm;
  return vec;
}

/* ---------------- Ekstraksi berbasis aturan ---------------- */

export type HeuristicKind = "fact" | "decision" | "task_done" | "task_pending" | "error_fixed" | "preference" | "context";

export interface HeuristicMemory {
  kind: HeuristicKind;
  content: string;
  importance: number;
  /** 0..1 — dipakai untuk auto-activate fast-path (kontinuitas limit-hopping). */
  confidence?: number;
  signal?: string[];
}

interface Rule {
  kind: Exclude<HeuristicKind, "context">;
  re: RegExp;
  base: number;
  conf: number;
  sig: string;
}

// Urutan = prioritas klasifikasi (paling spesifik dulu).
const RULES: Rule[] = [
  { kind: "error_fixed", base: 0.6, conf: 0.85, sig: "error_fix", re: /\b(error|bug|gagal|failed|exception|traceback|crash|stack ?trace|panic|uncaught)\b[\s\S]{0,120}\b(fix|fixed|perbaik|solusi|ternyata|penyebab|solved|resolved|workaround|patch|handled)\b|\b(fix|fixed|perbaik|solusi|ternyata|penyebab|workaround|resolved|solved)\b[\s\S]{0,120}\b(error|bug|gagal|failed|exception|traceback|crash|panic)\b/i },
  { kind: "task_done", base: 0.5, conf: 0.8, sig: "done", re: /\b(sudah selesai|sudah dibuat|sudah diperbaiki|sudah ditambahkan|sudah diimplementasi|sudah beres|selesai dikerjakan|berhasil dibuat|done|completed|implemented|finished|shipped|merged|resolved|fixed now)\b/i },
  { kind: "task_pending", base: 0.62, conf: 0.8, sig: "todo", re: /\b(todo|to-do|next step|next steps|follow[- ]?up|remaining|still need|not yet|belum selesai|belum dibuat|akan dibuat|akan ditambahkan|tinggal|lanjut(kan)?|perlu dibuat|perlu diperbaiki|perlu ditambah|harus di|nanti|blocked|wip|in progress|plan to|need to|should)\b/i },
  { kind: "decision", base: 0.62, conf: 0.82, sig: "decision", re: /\b(keputusan|disepakati|diputuskan|kita pakai|kita pilih|kami pakai|pakai saja|memakai|menggunakan|pilih|daripada|decided|we('ll| will)? use|going with|chose|chosen|instead of|settle(d)? (on|for)|opt(ed)? for|use .+ (for|as))\b/i },
  { kind: "preference", base: 0.5, conf: 0.7, sig: "preference", re: /\b(prefer|lebih suka|jangan |usahakan |selalu |hindari |gaya kode|code style|favor|always |never |avoid |please (don't|do not))\b/i },
  { kind: "fact", base: 0.48, conf: 0.65, sig: "entity", re: /(\bv?\d+\.\d+(\.\d+)?\b)|(https?:\/\/)|([\w.@+-]+\/[\w.@+\/-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|md|json|ya?ml|toml|sql|sh|css|scss|html|vue|svelte|kt|swift|c|cpp|h|hpp))|(\b(port|endpoint|default|timeout|limit|schema|table|branch|version|versi)\b\s*[:=]?\s*\S+)/i },
];

const SENTENCE_RE = /\n{2,}|(?<=[.!?])\s+/;
const GENERIC_RE = /\b(identifika|mengidentifikasi|memahami|memperhatikan|membantu (pengguna|user)|kebutuhan (pengguna|user)|menentukan apa|langkah berikutnya adalah|melanjutkan tugas|how can i help|let me know|feel free)\b/i;
const PATH_LIKE = /(^|[\s`("'`])([A-Za-z]:\\|~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\.[A-Za-z0-9]{1,8}\b|(^|[\s`])[\w-]+\.(ts|tsx|js|jsx|py|go|rs|java|md|json|ya?ml|toml|sql|css|html)\b/;
const CMD_LIKE = /\b(npm|pnpm|yarn|bun|node|npx|git|gh|python3?|pip3?|cargo|go |make|docker|kubectl|curl|ssh|tsc|vite|next|uv)\b[^\n]{0,80}/i;
const ERR_LIKE = /\b(Error|Exception|TypeError|ReferenceError|SyntaxError|ENOENT|EACCES|ECONN|Traceback|panic|failed|Cannot |not found)\b/;

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_RE)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18 && s.length <= 320);
}

function normalizeContent(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[-*>\d.)\[\]xX ]+/, "").trim();
}

function classifySentence(sentence: string): { kind: Exclude<HeuristicKind, "context">; importance: number; confidence: number; signals: string[] } | null {
  for (const r of RULES) {
    if (r.re.test(sentence)) {
      let confidence = r.conf;
      const signals = [r.sig];
      if (PATH_LIKE.test(sentence)) { confidence += 0.05; signals.push("path"); }
      if (CMD_LIKE.test(sentence)) { confidence += 0.04; signals.push("cmd"); }
      if (ERR_LIKE.test(sentence) && r.kind === "error_fixed") { confidence += 0.04; signals.push("err"); }
      if (/\bhttps?:\/\//.test(sentence) || /\bv?\d+\.\d+/.test(sentence)) { confidence += 0.03; signals.push("ref"); }
      return { kind: r.kind, importance: Math.min(0.85, r.base), confidence: Math.min(0.98, confidence), signals };
    }
  }
  return null;
}

function extractListItems(text: string): Array<{ content: string; kind: HeuristicKind; confidence: number; signals: string[]; importance: number }> {
  const out: Array<{ content: string; kind: HeuristicKind; confidence: number; signals: string[]; importance: number }> = [];
  const lines = text.split("\n");
  for (const raw of lines) {
    const m = raw.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[( |x|X)\]\s*)?(.*)$/);
    if (!m) continue;
    const checked = m[1];
    const body = normalizeContent(m[2] || "");
    if (body.length < 12 || body.length > 280) continue;
    if (GENERIC_RE.test(body)) continue;
    if (checked === "x" || checked === "X") {
      out.push({ content: body, kind: "task_done", confidence: 0.86, signals: ["checkbox_done"], importance: 0.55 });
      continue;
    }
    if (checked === " ") {
      out.push({ content: body, kind: "task_pending", confidence: 0.86, signals: ["checkbox_todo"], importance: 0.62 });
      continue;
    }
    const cls = classifySentence(body);
    if (cls && (cls.kind === "task_pending" || cls.kind === "task_done" || cls.kind === "decision" || cls.kind === "error_fixed")) {
      out.push({ content: body, kind: cls.kind, confidence: Math.max(cls.confidence, 0.78), signals: [...cls.signals, "list"], importance: cls.importance });
    } else if (/^(todo|next|plan|fix|add|implement|update|create|remove|refactor|investigate|check|verify|test)\b/i.test(body) || /\b(tinggal|lanjut|perlu|harus|akan)\b/i.test(body)) {
      out.push({ content: body, kind: "task_pending", confidence: 0.78, signals: ["list", "imperative"], importance: 0.6 });
    }
  }
  return out;
}

function extractCodeSignals(text: string): HeuristicMemory[] {
  const out: HeuristicMemory[] = [];
  // fenced code: capture file-ish hints in info string and short error/command lines inside
  const fences = text.match(/```[\s\S]*?```/g) || [];
  for (const f of fences.slice(0, 3)) {
    const inner = f.replace(/```[^\n]*\n?|```/g, "");
    const lines = inner.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.length < 12 || line.length > 220) continue;
      if (ERR_LIKE.test(line) && /\b(fix|fixed|solved|resolved|use|set|change|add|remove)\b/i.test(inner)) {
        out.push({ kind: "error_fixed", content: line, importance: 0.6, confidence: 0.72, signal: ["code", "err"] });
      } else if (CMD_LIKE.test(line)) {
        out.push({ kind: "fact", content: `Command: ${line.slice(0, 180)}`, importance: 0.5, confidence: 0.72, signal: ["code", "cmd"] });
      }
    }
  }
  return out.slice(0, 3);
}

function dedupeKey(content: string): string {
  return content.toLowerCase().replace(/[`*_#>\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function scoreForRank(m: HeuristicMemory): number {
  return (m.confidence ?? 0.5) * 2 + m.importance + ((m.signal || []).length > 0 ? 0.1 : 0);
}

/** Klasifikasi sinyal memori heuristik (dipakai extractor/aktivasi cepat). */
export function assessHeuristicSignal(m: { kind: HeuristicKind; content: string; importance: number; confidence?: number; signal?: string[] }): { activate: boolean; confidence: number; signals: string[] } {
  const content = m.content || "";
  const signals = [...(m.signal || [])];
  let confidence = m.confidence ?? 0.5;
  if (PATH_LIKE.test(content)) { confidence += 0.06; if (!signals.includes("path")) signals.push("path"); }
  if (CMD_LIKE.test(content)) { confidence += 0.04; if (!signals.includes("cmd")) signals.push("cmd"); }
  if (ERR_LIKE.test(content)) { if (!signals.includes("err")) signals.push("err"); }
  if (/\bhttps?:\/\/|\bv?\d+\.\d+/.test(content)) { if (!signals.includes("ref")) signals.push("ref"); }
  confidence = Math.min(0.99, confidence);

  const kind = m.kind;
  const strongKind = kind === "task_pending" || kind === "decision" || kind === "error_fixed" || kind === "task_done";
  const entityBacked = signals.some((s) => ["path", "cmd", "err", "ref", "entity", "checkbox_todo", "checkbox_done", "decision", "todo", "done", "error_fix"].includes(s));
  const longEnough = content.length >= 22;
  const specific = !GENERIC_RE.test(content);
  const activate =
    specific && longEnough && (
      (strongKind && (confidence >= 0.68 || entityBacked || m.importance >= 0.55)) ||
      (kind === "preference" && confidence >= 0.74) ||
      (kind === "fact" && confidence >= 0.72 && entityBacked) ||
      (kind === "context" && confidence >= 0.8 && entityBacked)
    );
  return { activate, confidence, signals };
}

/**
 * Ekstraksi tanpa LLM: kalimat + list/todo + sinyal kode. Pesan user dibobot
 * sedikit lebih tinggi. Hasil diprioritaskan (sinyal kuat dulu) dan dibatasi
 * agar tidak membanjiri, namun cukup kaya untuk kontinuitas limit-hopping.
 */
export function heuristicExtract(conversation: Array<{ role: string; content: string }>): HeuristicMemory[] {
  const collected: HeuristicMemory[] = [];
  const seen = new Set<string>();

  const push = (m: HeuristicMemory) => {
    const content = normalizeContent(m.content || "");
    if (content.length < 15 || content.length > 360) return;
    if (GENERIC_RE.test(content)) return;
    const key = dedupeKey(content);
    if (!key || seen.has(key)) return;
    seen.add(key);
    collected.push({ ...m, content });
  };

  for (const msg of conversation) {
    const text = msg.content || "";
    if (!text.trim()) continue;
    const fromUser = msg.role === "user";
    const bias = fromUser ? 0.08 : 0;

    // 1) List/checkbox/todo terstruktur (sinyal sangat berguna untuk resume)
    for (const item of extractListItems(text)) {
      push({ kind: item.kind, content: item.content, importance: Math.min(0.85, item.importance + bias), confidence: Math.min(0.98, item.confidence + bias), signal: item.signals });
    }

    // 2) Kalimat berpola
    for (const sentence of splitSentences(text)) {
      const hit = classifySentence(sentence);
      if (!hit) continue;
      push({ kind: hit.kind, content: sentence, importance: Math.min(0.85, hit.importance + bias), confidence: Math.min(0.98, hit.confidence + bias), signal: hit.signals });
    }

    // 3) Sinyal dari blok kode (command/error/fix hint)
    for (const m of extractCodeSignals(text)) {
      push({ ...m, importance: Math.min(0.8, (m.importance || 0.5) + bias), confidence: Math.min(0.95, (m.confidence || 0.6) + bias) });
    }
  }

  // Prioritaskan sinyal kuat & relevan limit-hopping, lalu batasi.
  collected.sort((a, b) => scoreForRank(b) - scoreForRank(a));
  return collected.slice(0, 14);
}



/** Backfill: promosikan draft heuristik lama yang kini memenuhi ambang sinyal
 * kuat ke active, agar data lama ikut mendapat manfaat upgrade heuristik
 * (tanpa re-ekstrak transkrip). Idempoten & aman: hanya origin heuristic. */
export function promoteLegacyHeuristicDrafts(limit = 500): { scanned: number; promoted: number } {
  // require lazily to avoid cycle at module init
  const db = require("../store/db") as typeof import("../store/db");
  const drafts = db.listHeuristicDrafts().slice(0, limit);
  let promoted = 0;
  for (const m of drafts) {
    const sig = assessHeuristicSignal({
      kind: m.kind as any,
      content: m.content,
      importance: m.importance,
      confidence: 0.5,
      signal: [],
    });
    if (!sig.activate || m.id == null) continue;
    const importance = Math.max(
      m.importance,
      sig.signals.some((s) => ["path", "cmd", "err", "ref", "entity"].includes(s)) ? 0.58 : 0.52
    );
    const ok = db.updateMemory(m.id, { importance } as any);
    // update status directly (updateMemory doesn't take status; use SQL)
    if (ok) {
      try {
        db.getDb().prepare("UPDATE memories SET status = 'active', updated_at = ?, updated_by = ? WHERE id = ? AND origin = 'heuristic' AND status = 'draft'").run(Date.now(), db.getDeviceId(), m.id);
        promoted++;
      } catch { /* ignore */ }
    }
  }
  return { scanned: drafts.length, promoted };
}
