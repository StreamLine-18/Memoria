/* ---------- First-run onboarding ----------
 * Goal: from install to "this is what Memoria remembers about your project"
 * in under two minutes, without reading docs.
 *   1. detect   — which AI tools have session data on this machine
 *   2. connect  — enable capture + register Memoria's MCP server in each
 *   3. import   — scan existing sessions, extract (Tier 0 works offline),
 *                 auto-triage, so the first view is not an approval queue
 *   4. show     — top projects with their current memories
 * The import runs in the background; the dashboard polls its status.
 * ------------------------------------------------------------------------- */
import * as fs from "node:fs";
import { getConfig } from "./config";
import { getSetting, setSetting, getBoolSetting, setBoolSetting, getDb, pendingExtractionCount, countMemories, countTranscripts } from "./store/db";
import { emitEvent } from "./events";

export interface DetectedTool {
  tool: string;
  label: string;
  /** Session data exists on this machine. */
  found: boolean;
  captureEnabled: boolean;
  /** Integration target key (MCP registration), if Memoria can register itself there. */
  integration: string | null;
  integrated: boolean;
}

export function detectTools(): DetectedTool[] {
  const { integrationStatus } = require("./integrate") as typeof import("./integrate");
  const integ = new Map(integrationStatus().map((i) => [i.key, i]));
  return getConfig().sources.map((s) => {
    const found = s.paths.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    const i = integ.get(s.tool);
    return {
      tool: s.tool,
      label: s.label,
      found,
      captureEnabled: getBoolSetting(`source:${s.tool}:enabled`, s.enabled),
      integration: i ? i.key : null,
      integrated: !!i?.configured,
    };
  });
}

export type Phase = "idle" | "connecting" | "scanning" | "extracting" | "triaging" | "done" | "error";

interface JobState {
  phase: Phase;
  startedAt: number;
  finishedAt: number;
  connected: string[];
  failed: Array<{ tool: string; message: string }>;
  transcripts: number;
  memories: number;
  pending: number;
  error: string;
}

let job: JobState = { phase: "idle", startedAt: 0, finishedAt: 0, connected: [], failed: [], transcripts: 0, memories: 0, pending: 0, error: "" };

export function onboardingStatus(): JobState & { done: boolean } {
  return { ...job, transcripts: countTranscripts(), memories: countMemories(), pending: pendingExtractionCount(), done: isOnboarded() };
}

/** Existing installs with memories count as onboarded (never nag them). */
export function isOnboarded(): boolean {
  if (getSetting("onboardingDone", "") === "1") return true;
  return countMemories() > 0;
}

export function markOnboarded(): void {
  setSetting("onboardingDone", "1");
}

/** Extraction budget for the first import: enough for a useful first view,
 * the rest continues in the background (housekeeping every 5 minutes). */
const EXTRACT_BUDGET_MS = 75_000;

export function startOnboarding(tools: string[]): JobState {
  if (["connecting", "scanning", "extracting", "triaging"].includes(job.phase)) return job;
  job = { phase: "connecting", startedAt: Date.now(), finishedAt: 0, connected: [], failed: [], transcripts: 0, memories: 0, pending: 0, error: "" };
  void (async () => {
    try {
      const { registerIntegration } = await import("./integrate");
      const detected = new Map(detectTools().map((d) => [d.tool, d]));
      for (const t of tools) {
        const d = detected.get(t);
        if (!d) continue;
        setBoolSetting(`source:${t}:enabled`, true);
        if (d.integration) {
          const r = registerIntegration(d.integration);
          if (r.ok) job.connected.push(d.label);
          else job.failed.push({ tool: d.label, message: r.message });
        }
      }
      job.phase = "scanning";
      emitEvent("onboarding", { phase: job.phase });
      const { scanAll } = await import("./ingest/manager");
      await scanAll();
      job.phase = "extracting";
      emitEvent("onboarding", { phase: job.phase });
      const { extractQueue } = await import("./extract/extractor");
      // Newest sessions first: they are what the user will resume next.
      const until = Date.now() + EXTRACT_BUDGET_MS;
      while (Date.now() < until && pendingExtractionCount() > 0) {
        const n = await extractQueue(true, { order: "desc" });
        if (!n && pendingExtractionCount() === 0) break;
        // 0 also means another extraction pass is running: wait instead of spinning.
        if (!n) await new Promise((r) => setTimeout(r, 1000));
      }
      job.phase = "triaging";
      const { runTriage } = await import("./extract/triage");
      runTriage();
      job.phase = "done";
      job.finishedAt = Date.now();
      markOnboarded();
      emitEvent("onboarding", { phase: job.phase });
      emitEvent("memory", { onboarding: true });
    } catch (err) {
      job.phase = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
    }
  })();
  return job;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  path: string | null;
  transcripts: number;
  memories: Array<{ id: number; kind: string; content: string }>;
}

/** "What Memoria remembers": the most active projects and their key memories. */
export function rememberedSummary(limit = 3): ProjectSummary[] {
  const { projectContext } = require("./retrieve/search") as typeof import("./retrieve/search");
  const rows = getDb()
    .prepare(
      `SELECT p.slug, p.name, p.path, COUNT(m.id) AS mems,
              (SELECT COUNT(*) FROM transcripts t WHERE t.project_id = p.id) AS tx
       FROM projects p JOIN memories m ON m.project_id = p.id AND m.archived = 0 AND m.status = 'active'
       WHERE p.slug != '_unknown'
       GROUP BY p.id ORDER BY MAX(m.created_at) DESC LIMIT ?`
    )
    .all(limit) as Array<{ slug: string; name: string | null; path: string | null; mems: number; tx: number }>;
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name || r.slug,
    path: r.path,
    transcripts: r.tx,
    memories: projectContext(r.slug, 6).map((h) => ({ id: h.id, kind: h.kind, content: h.content })),
  }));
}
