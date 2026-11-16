import { allMemories, updateMemory, getDb, markResolved, readMemories } from "../store/db";

const DONE_WORDS = [
  "selesai", "beres", "kelar", "done", "fixed", "berhasil", "sukses", "complete",
  "completed", "resolved", "solved", "settled", "accomplished", "finished", "tuntas",
  "sudah saya", "sudah diperbaiki", "teratasi", "implemented", "merged", "shipped",
];

const IN_PROGRESS_WORDS = ["sedang", "mulai", "akan", "progress", "in progress", "sedang proses", "lagi", "menangani", "working on", "implementing"];

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

  const textLower = rows.map((r) => r.content).join("\n").toLowerCase();
  const firstWorkIndex = rows.findIndex((r) => hasAny(r.content, IN_PROGRESS_WORDS) || r.role === "user");

  for (const mem of pending) {
    const kws = keywordsOf(mem.content);
    if (!kws.length) continue;
    const matched = kws.some((k) => textLower.includes(k));
    if (!matched) continue;
    const idx = firstWorkIndex >= 0 ? firstWorkIndex : 0;
    const after = rows.slice(idx).map((r) => r.content).join("\n");
    if (hasAny(after, DONE_WORDS)) {
      updateMemory(mem.id!, { kind: "task_done" });
      markResolved(mem.id!);
    }
  }
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