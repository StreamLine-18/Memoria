import { allMemories, updateMemory, getDb, markResolved, readMemories } from "../store/db";

const DONE_WORDS = [
  "selesai", "beres", "kelar", "done", "fixed", "berhasil", "sukses", "complete",
  "completed", "resolved", "solved", "settled", "accomplished", "finished", "tuntas",
  "sudah saya", "sudah diperbaiki", "teratasi", "implemented", "merged", "shipped",
];


function hasAny(text: string, words: string[]): boolean {
  const lc = text.toLowerCase();
  return words.some((w) => lc.includes(w));
}

export function runTaskLifecycle(projectId: number): void {
  const d = getDb();
  // Aktif + draft heuristik (sinyal yang belum/tidak dipromosikan tetap bisa ditutup
  // agar tidak menggantung; recall tetap hanya menampilkan aktif).
  const pending = readMemories(
    `WHERE project_id = ? AND kind = 'task_pending' AND archived = 0 AND COALESCE(resolved_at, 0) = 0
       AND (status = 'active' OR (status = 'draft' AND origin = 'heuristic'))`,
    [projectId]
  );
  if (!pending.length) return;

  const since = Math.min(...pending.map((p) => p.createdAt));
  const rows = d
    .prepare(
      `SELECT role, content, ts FROM transcripts
       WHERE project_id = ? AND ts >= ? AND role IN ('user','assistant')
       ORDER BY ts ASC LIMIT 3000`
    )
    .all(projectId, since) as Array<{ role: string; content: string; ts: number }>;
  if (!rows.length) return;

  for (const mem of pending) {
    if (isTaskDone(mem.content, mem.createdAt, rows)) {
      updateMemory(mem.id!, { kind: "task_done" });
      markResolved(mem.id!);
    }
  }
}

/** A task is done only when ONE message part both talks about this task
 * (most of its keywords) and says it is finished. Before, a done-word
 * anywhere in the session ("fixed" about another bug) closed every task
 * whose keywords appeared anywhere, so fresh TODOs showed up as Done. A
 * checked checkbox for the same item counts; the task's own line does not. */
export function isTaskDone(content: string, createdAt: number, rows: Array<{ role: string; content: string; ts: number }>): boolean {
  const kws = keywordsOf(content);
  if (!kws.length) return false;
  const need = Math.min(kws.length, Math.max(2, Math.ceil(kws.length * 0.6)));
  const own = content.replace(/^\s*(?:[-*]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?(?:todo:?\s*)?/i, "").replace(/\s+/g, " ").trim().toLowerCase();
  for (const r of rows) {
    if (r.ts < createdAt) continue;
    for (const part of r.content.split(/\n+/)) {
      const lc = part.replace(/\s+/g, " ").toLowerCase();
      if (!lc.trim()) continue;
      const checked = /^\s*(?:[-*]|\d+[.)])?\s*\[[xX]\]/.test(part);
      // The pending item itself (`- [ ] …`, `TODO: …`) is not evidence of completion.
      if (!checked && (/^\s*(?:[-*]|\d+[.)])?\s*\[ \]/.test(part) || lc.includes(own))) continue;
      const hits = kws.filter((k) => lc.includes(k)).length;
      if (hits < need) continue;
      if (checked || hasAny(lc, DONE_WORDS)) return true;
    }
  }
  return false;
}

function keywordsOf(content: string): string[] {
  const stop = new Set([
    "yang", "dan", "atau", "untuk", "dengan", "dari", "pada", "ke", "di", "ini", "itu", "agar",
    "the", "and", "for", "with", "from", "that", "this", "a", "an", "to", "of", "in", "on",
    "buat", "bikin", "membuat", "task", "tugas", "selesaikan", "perbaiki", "fix", "implement",
    "please", "need", "should", "would", "could",
  ]);
  const words = content.toLowerCase().match(/[a-z0-9_\-]{4,}/g) || [];
  const freq = new Map<string, number>();
  for (const w of words) {
    if (stop.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
}

export function countOpen(projectId?: number): number {
  const all = allMemories().filter((m) => m.kind === "task_pending");
  return projectId != null ? all.filter((m) => m.projectId === projectId).length : all.length;
}