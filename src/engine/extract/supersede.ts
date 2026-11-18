/* ---------- Superseded decisions (zero-LLM) ----------
 * When a new active decision is stored, older active decisions in the same
 * project about the same subject are marked as superseded: their validity
 * window closes (valid_to) and superseded_by points at the new decision.
 * Nothing is deleted or archived, so recall can still answer "what did we
 * decide before?", but the resume block, project context, and build_context
 * stop presenting the old choice as current.
 *
 * Detection is deliberately conservative, because hiding a decision that is
 * still valid is worse than showing a stale one:
 *   - same project, both kind = decision, both active, the old one older
 *   - they share at least one specific subject entity (tech word, package,
 *     path, command)
 *   - token overlap is in the "same topic, different content" band: high
 *     enough to be about the same thing, below the dedupe merge level
 * ------------------------------------------------------------------------- */
import { getDb, bumpDataVersion, getDeviceId, memoryById } from "../store/db";
import { extractEntities } from "./entities";
import { textSimilarity } from "./dedupe";

const SUBJECT_TYPES = new Set(["tech", "pkg", "PATH", "command"]);
export const SUPERSEDE_MIN_SIM = 0.2;
export const SUPERSEDE_MAX_SIM = 0.85; // at or above this, dedupe merges instead

function subjects(text: string): Set<string> {
  return new Set(
    extractEntities(text)
      .filter((e) => SUBJECT_TYPES.has(e.type))
      .map((e) => e.text.toLowerCase())
  );
}

export function supersedeOlderDecisions(newId: number): number[] {
  const m = memoryById(newId);
  if (!m || m.kind !== "decision" || m.projectId == null || (m.status && m.status !== "active")) return [];
  const mine = subjects(m.content);
  if (!mine.size) return [];
  const d = getDb();
  const olds = d
    .prepare(
      `SELECT id, content FROM memories
       WHERE project_id = ? AND kind = 'decision' AND status = 'active' AND archived = 0
         AND COALESCE(superseded_by, 0) = 0 AND id != ? AND created_at <= ?
       ORDER BY created_at DESC LIMIT 200`
    )
    .all(m.projectId, newId, m.createdAt) as Array<{ id: number; content: string }>;
  const out: number[] = [];
  const now = Date.now();
  const upd = d.prepare("UPDATE memories SET superseded_by = ?, valid_to = ?, updated_at = ?, updated_by = ? WHERE id = ?");
  for (const o of olds) {
    let shared = false;
    for (const s of subjects(o.content)) if (mine.has(s)) { shared = true; break; }
    if (!shared) continue;
    const sim = textSimilarity(m.content, o.content);
    if (sim < SUPERSEDE_MIN_SIM || sim >= SUPERSEDE_MAX_SIM) continue;
    upd.run(newId, now, now, getDeviceId(), o.id);
    out.push(o.id);
  }
  if (out.length) bumpDataVersion();
  return out;
}

/** Undo: mark a superseded decision as current again. */
export function restoreDecision(id: number): boolean {
  const res = getDb()
    .prepare("UPDATE memories SET superseded_by = 0, valid_to = 0, updated_at = ?, updated_by = ? WHERE id = ? AND COALESCE(superseded_by, 0) != 0")
    .run(Date.now(), getDeviceId(), id);
  bumpDataVersion();
  return res.changes > 0;
}
