/* ---------- Obsidian / Markdown vault, two-way ----------
 * One note per active memory: `<dir>/<project>/m<id>-<slug>.md` with YAML
 * frontmatter (memoria_id = stable uid). `.memoria-sync.json` remembers what
 * was last written, so a sync can tell who changed what:
 *   note body edited in Obsidian      → memory content updated
 *   `kind:` / `importance:` edited    → memory updated
 *   note deleted in Obsidian          → memory archived (recoverable)
 *   new note without memoria_id       → new memory, id written back into it
 *   memory changed in Memoria         → note rewritten
 * When both sides changed since the last sync, the note wins (it is the
 * newer human edit) and the conflict is counted. Generated sections
 * ("## Entities", "## Related") are rewritten on every export and ignored
 * on import. Sync runs from the dashboard, `memoria obsidian sync <dir>`,
 * and every 5 minutes when Settings → Obsidian vault is set.
 * ------------------------------------------------------------------------- */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  allMemories, readMemories, projectSlugById, linksForMemory, tagsForMemory, entitiesForMemory,
  updateMemory, archiveMemory, insertMemory, ensureProject, getDb, Memory, getSetting,
} from "../store/db";

const MANIFEST = ".memoria-sync.json";
const KINDS = ["fact", "decision", "task_done", "task_pending", "error_fixed", "preference", "context"];
const GENERATED = /\n## (?:Entities|Related|Entitas|Terhubung)\n[\s\S]*$/;

interface ManifestEntry {
  file: string;
  hash: string;
  updatedAt: number;
}
type Manifest = Record<string, ManifestEntry>;

export interface SyncResult {
  ok: boolean;
  dir: string;
  notes: number;
  written: number;
  updatedFromNotes: number;
  createdFromNotes: number;
  archivedFromNotes: number;
  conflicts: number;
  error?: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "memory";
}

function hash(s: string): string {
  return createHash("sha256").update(s.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);
}

function readManifest(dir: string): Manifest {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
  } catch {
    return {};
  }
}

/** Minimal frontmatter parser: `key: value` lines and `tags:` lists. */
export function parseNote(text: string): { meta: Record<string, string | string[]>; body: string } {
  const src = text.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { meta: {}, body: src.trim() };
  const meta: Record<string, string | string[]> = {};
  let listKey = "";
  for (const line of m[1].split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (meta[listKey] as string[]).push(item[1].trim());
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === "") {
      listKey = kv[1];
      meta[listKey] = [];
    } else {
      listKey = "";
      meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  const body = m[2].replace(GENERATED, "").replace(/^\s*#\s[^\n]*\n/, "").trim();
  return { meta, body };
}

function noteText(m: Memory, used: Map<number, string>): string {
  const tags = tagsForMemory(m.id!);
  const lines = [
    "---",
    `memoria_id: ${m.uid}`,
    `kind: ${m.kind}`,
    `importance: ${Math.round(m.importance * 100)}`,
    `project: ${projectSlugById(m.projectId) || "global"}`,
    `source: ${m.sourceTool}`,
    `created: ${new Date(m.createdAt).toISOString()}`,
  ];
  if (tags.length) lines.push("tags:", ...tags.map((t) => `  - ${t}`));
  lines.push("---", "", m.content.trim());
  const entities = entitiesForMemory(m.id!);
  if (entities.length) {
    lines.push("", "## Entities");
    for (const e of entities) lines.push(`- \`${e.text}\` (${e.type})`);
  }
  const rels = linksForMemory(m.id!, 10).filter((r) => used.has(r.memoryId));
  if (rels.length) {
    lines.push("", "## Related");
    for (const r of rels) lines.push(`- [[${used.get(r.memoryId)!.replace(/\.md$/, "")}]] — ${r.kind}`);
  }
  return lines.join("\n") + "\n";
}

function walkNotes(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 3) return out;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkNotes(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".md") && e.name !== "Index.md") out.push(full);
  }
  return out;
}

function memoryByUid(uid: string): Memory | null {
  return readMemories("WHERE uid = ?", [uid])[0] || null;
}

/** Two-way sync between the database and a Markdown folder. */
export function syncObsidianVault(dir: string): SyncResult {
  const r: SyncResult = { ok: true, dir, notes: 0, written: 0, updatedFromNotes: 0, createdFromNotes: 0, archivedFromNotes: 0, conflicts: 0 };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const manifest = readManifest(dir);
    const seen = new Set<string>();

    // 1) Notes → database.
    for (const file of walkNotes(dir)) {
      const rel = path.relative(dir, file);
      const text = fs.readFileSync(file, "utf8");
      const { meta, body } = parseNote(text);
      const uid = typeof meta.memoria_id === "string" ? meta.memoria_id : "";
      // Notes from the old one-way export (no memoria_id, Indonesian keys,
      // m<id>- file names) are Memoria's own copies, not user notes: replace
      // them with the new layout instead of importing them as duplicates.
      if (!uid && meta.jenis !== undefined && /^m\d+-/.test(path.basename(file))) {
        fs.unlinkSync(file);
        continue;
      }
      if (!uid) {
        // A note the user wrote: becomes a memory, then gets an id.
        if (body.length < 10) continue;
        const kind = KINDS.includes(String(meta.kind)) ? String(meta.kind) : "fact";
        const projName = typeof meta.project === "string" && meta.project !== "global" ? meta.project : path.dirname(rel) !== "." ? path.dirname(rel).split(path.sep)[0] : "";
        const projectId = projName ? (getDb().prepare("SELECT id FROM projects WHERE slug = ?").get(projName) as { id: number } | undefined)?.id ?? ensureProject(projName) : null;
        const id = insertMemory({
          projectId, kind, content: body.slice(0, 4000), importance: 0.6, createdAt: Date.now(), lastAccessed: 0, accessCount: 0,
          sourceTool: "obsidian", status: "active", origin: "user",
        });
        const created = readMemories("WHERE id = ?", [id])[0];
        if (created?.uid) {
          const withId = text.startsWith("---\n") ? text.replace(/^---\n/, `---\nmemoria_id: ${created.uid}\n`) : `---\nmemoria_id: ${created.uid}\nkind: ${kind}\n---\n\n${text}`;
          fs.writeFileSync(file, withId, "utf8");
          manifest[created.uid] = { file: rel, hash: hash(body), updatedAt: Date.now() };
          seen.add(created.uid);
        }
        r.createdFromNotes++;
        continue;
      }
      seen.add(uid);
      const mem = memoryByUid(uid);
      if (!mem || mem.id == null) continue;
      const prev = manifest[uid];
      const noteChanged = !prev || prev.hash !== hash(body);
      const kind = KINDS.includes(String(meta.kind)) ? String(meta.kind) : mem.kind;
      const imp = Number(meta.importance);
      const importance = Number.isFinite(imp) ? Math.min(1, Math.max(0, imp / 100)) : mem.importance;
      const metaChanged = kind !== mem.kind || Math.abs(importance - mem.importance) > 0.005;
      if (prev && (noteChanged || metaChanged)) {
        if ((mem.updatedAt || 0) > prev.updatedAt && hash(mem.content) !== prev.hash) r.conflicts++;
        updateMemory(mem.id, { content: noteChanged && body ? body : undefined, kind, importance });
        r.updatedFromNotes++;
      }
      manifest[uid] = { file: rel, hash: hash(noteChanged && body ? body : mem.content), updatedAt: Date.now() };
    }

    // 2) Notes deleted in the vault → archive (only notes we wrote before).
    for (const [uid, entry] of Object.entries(manifest)) {
      if (seen.has(uid) || fs.existsSync(path.join(dir, entry.file))) continue;
      const mem = memoryByUid(uid);
      if (mem?.id != null) {
        archiveMemory(mem.id, true);
        r.archivedFromNotes++;
      }
      delete manifest[uid];
    }

    // 3) Database → notes.
    const mems = allMemories().filter((m) => m.uid);
    const used = new Map<number, string>();
    for (const m of mems) {
      const existing = manifest[m.uid!]?.file;
      used.set(m.id!, existing || path.join(projectSlugById(m.projectId) || "global", `m${m.id}-${slugify(m.content)}.md`));
    }
    const live = new Set<string>();
    for (const m of mems) {
      const rel = used.get(m.id!)!;
      const full = path.join(dir, rel);
      const text = noteText(m, used);
      live.add(m.uid!);
      let current = "";
      try {
        current = fs.readFileSync(full, "utf8");
      } catch {
        /* new note */
      }
      if (current !== text) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text, "utf8");
        r.written++;
      }
      manifest[m.uid!] = { file: rel, hash: hash(m.content), updatedAt: Date.now() };
      r.notes++;
    }
    // Memories archived/deleted in Memoria: remove their notes.
    for (const [uid, entry] of Object.entries(manifest)) {
      if (live.has(uid)) continue;
      try {
        fs.unlinkSync(path.join(dir, entry.file));
      } catch {
        /* already gone */
      }
      delete manifest[uid];
    }

    const index = ["# Memoria", "", "> Edit notes here; Memoria syncs changes back. Deleting a note archives the memory.", ""];
    for (const m of mems) index.push(`- [[${used.get(m.id!)!.replace(/\.md$/, "")}]] — ${m.kind} · ${projectSlugById(m.projectId) || "global"}`);
    fs.writeFileSync(path.join(dir, "Index.md"), index.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), "utf8");
    return r;
  } catch (e) {
    return { ...r, ok: false, error: String(e) };
  }
}

/** Kept for the existing API: a full export is a sync into that folder. */
export function exportObsidianVault(dir: string): { ok: boolean; dir: string; notes: number; error?: string } {
  const r = syncObsidianVault(dir);
  return { ok: r.ok, dir: r.dir, notes: r.notes, error: r.error };
}

/** Background sync when Settings → Obsidian vault is set. */
export function syncConfiguredVault(): SyncResult | null {
  const dir = getSetting("obsidianVault", "").trim();
  if (!dir) return null;
  return syncObsidianVault(dir);
}
