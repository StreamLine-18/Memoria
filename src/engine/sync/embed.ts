import { getDb, setMemoryEmbedding } from "../store/db";
import { embedManyVia, getEmbedProvider } from "../extract/provider";

/** Vektor tidak ikut disinkronkan. Memori remote yang kontennya berubah
 * dimasukkan ke antrean ini, lalu di-embed ulang dengan dialek lokal. */
export function queueEmbeddingBackfill(memoryId: number): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO sync_embed_queue (memory_id, queued_at) VALUES (?, ?)")
    .run(memoryId, Date.now());
}

export function embeddingBackfillCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM sync_embed_queue").get() as { c: number };
  return Number(row.c);
}

/** Re-embed batch memori dengan provider saat ini (upgrade offline→cloud/Lokal).
 * Dipakai untuk memigrasikan vektor lama (mis. hash-256-v1) ke dialek model. */
export async function reembedMemories(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT id, content FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`
    )
    .all(...ids) as Array<{ id: number; content: string }>;
  if (!rows.length) return 0;
  let done = 0;
  try {
    const provider = await getEmbedProvider();
    const embeddings = await embedManyVia(provider, rows.map((r) => r.content));
    for (let i = 0; i < rows.length; i++) {
      const embedding = embeddings[i];
      if (!embedding || !embedding.length) continue;
      setMemoryEmbedding(rows[i].id, embedding, provider.embedModel);
      d.prepare("DELETE FROM sync_embed_queue WHERE memory_id = ?").run(rows[i].id);
      done++;
    }
  } catch {
    /* best effort */
  }
  return done;
}

export async function processEmbeddingBackfill(limit = 50): Promise<number> {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT q.memory_id AS id, m.content
       FROM sync_embed_queue q JOIN memories m ON m.id = q.memory_id
       ORDER BY q.queued_at LIMIT ?`
    )
    .all(limit) as Array<{ id: number; content: string }>;
  if (!rows.length) return 0;

  const ids = rows.map((r) => r.id);
  // reembedMemories menghapus dari queue saat sukses; jika gagal, biarkan antre.
  const done = await reembedMemories(ids);

  // Memori yang sudah dihapus sebelum sempat di-embed tidak perlu antre.
  d.prepare("DELETE FROM sync_embed_queue WHERE memory_id NOT IN (SELECT id FROM memories)").run();
  return done;
}

/** Antre & proses re-embed untuk semua memori yang dialeknya beda dari provider
 * aktif (path upgrade offline/hash → model). */
export async function reembedAll(opts: { batch?: number; limitTotal?: number } = {}): Promise<{ queued: number; embedded: number; targetModel: string }> {
  const d = getDb();
  const provider = await getEmbedProvider();
  const target = provider.embedModel || "";
  const lim = opts.limitTotal ?? 200000;
  const rows = d
    .prepare(
      `SELECT id FROM memories
       WHERE COALESCE(embed_model,'') != ? AND COALESCE(content,'') != '' AND archived = 0
       ORDER BY id DESC LIMIT ?`
    )
    .all(target, lim) as Array<{ id: number }>;
  const ids = rows.map((r) => r.id);
  const batch = opts.batch ?? 64;
  let embedded = 0;
  for (let i = 0; i < ids.length; i += batch) {
    embedded += await reembedMemories(ids.slice(i, i + batch));
  }
  return { queued: ids.length, embedded, targetModel: target };
}
