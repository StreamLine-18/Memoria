/* ---------- Pemakaian konteks (lokal, tanpa telemetry) ----------
 * Mencatat berapa banyak konteks yang dikirim Memoria ke agen (MCP + blok
 * resume) dan berapa yang dihemat oleh mode indeks (progressive disclosure).
 * Disimpan di continuity_events (retensi 90 hari, sudah di-prune harian).
 *
 * Token = perkiraan chars/4 (heuristik umum untuk teks Inggris/kode; teks
 * Indonesia cenderung sedikit lebih banyak token). Ditampilkan sebagai
 * perkiraan, bukan angka tagihan.
 * ------------------------------------------------------------------------- */
import { getDb, recordContinuity } from "../store/db";

export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

/** Catat satu pengiriman konteks. fullChars = biaya jika dikirim lengkap. */
export function recordContextServed(source: string, projectId: number | null, servedChars: number, fullChars = servedChars): void {
  try {
    recordContinuity("context_served", projectId, JSON.stringify({ s: source, c: servedChars, f: Math.max(fullChars, servedChars) }));
  } catch {
    /* metrik non-kritis */
  }
}

export interface UsageSummary {
  days: number;
  calls: number;
  tokensDelivered: number;
  tokensSavedByIndex: number;
  resumeBlocks: number;
  bySource: Record<string, { calls: number; tokens: number }>;
}

export function usageSummary(days = 7): UsageSummary {
  const since = Date.now() - days * 86400000;
  const rows = getDb()
    .prepare("SELECT detail FROM continuity_events WHERE kind = 'context_served' AND ts >= ?")
    .all(since) as Array<{ detail: string }>;
  const out: UsageSummary = { days, calls: 0, tokensDelivered: 0, tokensSavedByIndex: 0, resumeBlocks: 0, bySource: {} };
  for (const r of rows) {
    let d: { s?: string; c?: number; f?: number };
    try {
      d = JSON.parse(r.detail || "{}");
    } catch {
      continue;
    }
    const served = Math.ceil((Number(d.c) || 0) / 4);
    const full = Math.ceil((Number(d.f) || 0) / 4);
    const src = String(d.s || "other");
    out.calls++;
    out.tokensDelivered += served;
    out.tokensSavedByIndex += Math.max(0, full - served);
    if (src === "resume") out.resumeBlocks++;
    const b = (out.bySource[src] ||= { calls: 0, tokens: 0 });
    b.calls++;
    b.tokens += served;
  }
  return out;
}
