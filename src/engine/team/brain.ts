/* ---------- Project brain for teams ----------
 * `.memoria/brain.md` in a repository: the project's current decisions,
 * conventions, fixed errors and open tasks as plain Markdown, so it can be
 * reviewed in a pull request like any other file. Every teammate who runs
 * Memoria on that repo gets it as memories (origin "team"), and their agents
 * see it through project_context / recall / the resume block.
 *
 *   export  only active, current memories of the project (superseded
 *           decisions, drafts and archived memories are left out); secrets are
 *           redacted again on the way out; stable order so diffs stay small.
 *   import  each entry carries `<!-- m:<uid> -->`; re-importing updates the
 *           same memory instead of adding a copy. Entries removed from the
 *           file (e.g. in review) archive the team memory they created.
 * Exports are opt-in per project (Settings or `memoria brain export`).
 * ------------------------------------------------------------------------- */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { readMemories, projectRecord, insertMemory, updateMemory, archiveMemory, getSetting, setSetting, getDb } from "../store/db";
import { redactSecrets } from "../privacy/redact";

export const BRAIN_DIR = ".memoria";
export const BRAIN_FILE = "brain.md";

const SECTIONS: Array<{ kind: string; title: string }> = [
  { kind: "decision", title: "Decisions" },
  { kind: "preference", title: "Conventions" },
  { kind: "error_fixed", title: "Known issues and fixes" },
  { kind: "fact", title: "Facts" },
  { kind: "task_pending", title: "Open tasks" },
];
const TITLE_TO_KIND = new Map(SECTIONS.map((s) => [s.title.toLowerCase(), s.kind]));
const MAX_PER_SECTION = 60;

export function brainPath(projectPath: string): string {
  return path.join(projectPath, BRAIN_DIR, BRAIN_FILE);
}

function oneLine(s: string): string {
  return redactSecrets(s.replace(/\s+/g, " ").trim()).text;
}

export interface BrainExportResult {
  file: string;
  entries: number;
  changed: boolean;
}

/** Write `.memoria/brain.md` for a project. */
export function exportBrain(slug: string): BrainExportResult {
  const proj = projectRecord(slug);
  if (!proj || !proj.path) throw new Error(`Project "${slug}" has no folder on this machine`);
  const lines: string[] = [
    `# Project brain — ${proj.name || slug}`,
    "",
    "> Maintained by [Memoria](https://github.com/xinzzu/Memoria). Review it like code: edit or delete",
    "> lines, and teammates' Memoria picks the changes up. Keep `<!-- m:… -->` markers intact.",
    "",
  ];
  let entries = 0;
  for (const sec of SECTIONS) {
    const rows = readMemories(
      `WHERE project_id = ? AND kind = ? AND archived = 0 AND status = 'active' AND COALESCE(valid_to, 0) = 0
         AND COALESCE(resolved_at, 0) = 0 AND source_tool != 'brief'
       ORDER BY importance DESC, created_at ASC LIMIT ?`,
      [proj.id, sec.kind, MAX_PER_SECTION]
    );
    if (!rows.length) continue;
    lines.push(`## ${sec.title}`, "");
    for (const m of rows.sort((a, b) => (a.uid || "").localeCompare(b.uid || ""))) {
      if (!m.uid) continue;
      lines.push(`- ${oneLine(m.content)} <!-- m:${m.uid} -->`);
      entries++;
    }
    lines.push("");
  }
  const text = lines.join("\n").trimEnd() + "\n";
  const file = brainPath(proj.path);
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    /* first export */
  }
  const changed = current !== text;
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  }
  setSetting(`brain:${slug}:hash`, hash(text));
  return { file, entries, changed };
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export interface BrainEntry {
  kind: string;
  content: string;
  uid: string | null;
}

export function parseBrain(text: string): BrainEntry[] {
  const out: BrainEntry[] = [];
  let kind = "";
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) {
      kind = TITLE_TO_KIND.get(h[1].toLowerCase()) || "";
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (!li || !kind) continue;
    const m = /<!--\s*m:([\w-]{8,})\s*-->\s*$/.exec(li[1]);
    const content = li[1].replace(/<!--[\s\S]*?-->\s*$/, "").trim();
    if (content.length < 5) continue;
    out.push({ kind, content, uid: m ? m[1] : null });
  }
  return out;
}

export interface BrainImportResult {
  file: string;
  added: number;
  updated: number;
  archived: number;
  unchanged: number;
}

/** Import `.memoria/brain.md` of a project as team memories. */
export function importBrain(slug: string): BrainImportResult | null {
  const proj = projectRecord(slug);
  if (!proj || !proj.path) return null;
  const file = brainPath(proj.path);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const res: BrainImportResult = { file, added: 0, updated: 0, archived: 0, unchanged: 0 };
  // Our own export, unchanged: nothing to import.
  if (getSetting(`brain:${slug}:hash`, "") === hash(text)) {
    return res;
  }
  const entries = parseBrain(text);
  const d = getDb();
  const seenTeamUids = new Set<string>();
  for (const e of entries) {
    const local = e.uid ? readMemories("WHERE uid = ?", [e.uid])[0] : undefined;
    if (local && local.id != null) {
      // Compare in exported form: a locally unredacted secret is not an edit.
      if (oneLine(local.content) !== e.content || local.kind !== e.kind) {
        updateMemory(local.id, { content: e.content, kind: e.kind });
        res.updated++;
      } else res.unchanged++;
      if (local.origin === "team") seenTeamUids.add(e.uid!);
      continue;
    }
    // Someone else's memory (or a hand-written line): stored with the same uid
    // so the next import recognises it.
    const id = insertMemory({
      uid: e.uid || undefined,
      projectId: proj.id, kind: e.kind, content: e.content, importance: 0.65, createdAt: Date.now(), lastAccessed: 0, accessCount: 0,
      sourceTool: "brain", status: "active", origin: "team",
    });
    const uid = (d.prepare("SELECT uid FROM memories WHERE id = ?").get(id) as { uid: string }).uid;
    seenTeamUids.add(uid);
    res.added++;
  }
  // Lines removed from the file (e.g. dropped in review) → archive the team
  // memories they created. Local memories are never touched by this.
  const team = d
    .prepare("SELECT id, uid FROM memories WHERE project_id = ? AND origin = 'team' AND source_tool = 'brain' AND archived = 0")
    .all(proj.id) as Array<{ id: number; uid: string }>;
  for (const t of team) {
    if (!seenTeamUids.has(t.uid)) {
      archiveMemory(t.id, true);
      res.archived++;
    }
  }
  setSetting(`brain:${slug}:importHash`, hash(text));
  return res;
}

/** Projects with brain export switched on. */
export function brainProjects(): string[] {
  const rows = getDb().prepare("SELECT key FROM settings WHERE key LIKE 'brain:%:export' AND value = '1'").all() as Array<{ key: string }>;
  return rows.map((r) => r.key.slice("brain:".length, -":export".length));
}

export function setBrainExport(slug: string, on: boolean): void {
  setSetting(`brain:${slug}:export`, on ? "1" : "0");
}

/** Background pass: import changed brain files of recent projects, then
 * re-export opted-in ones. */
export function syncBrains(): { imported: number; exported: number } {
  let imported = 0;
  let exported = 0;
  const recent = getDb()
    .prepare("SELECT slug FROM projects WHERE path IS NOT NULL AND path != '' AND last_seen >= ? ORDER BY last_seen DESC LIMIT 30")
    .all(Date.now() - 30 * 86400000) as Array<{ slug: string }>;
  for (const { slug } of recent) {
    try {
      const proj = projectRecord(slug);
      if (!proj?.path || !fs.existsSync(brainPath(proj.path))) continue;
      const text = fs.readFileSync(brainPath(proj.path), "utf8");
      if (getSetting(`brain:${slug}:importHash`, "") === hash(text)) continue;
      const r = importBrain(slug);
      if (r && (r.added || r.updated || r.archived)) imported++;
    } catch {
      /* unreadable file: next pass */
    }
  }
  for (const slug of brainProjects()) {
    try {
      if (exportBrain(slug).changed) exported++;
    } catch {
      /* project folder gone */
    }
  }
  return { imported, exported };
}
