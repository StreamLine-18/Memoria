/* ---------- Antigravity "brain" transcripts ----------
 * Antigravity (IDE, CLI, and agent) writes one JSONL log per conversation:
 *   ~/.gemini/<antigravity|antigravity-ide|antigravity-cli>/brain/<id>/
 *     .system_generated/logs/transcript_full.jsonl
 * Each line is a step: { step_index, source, type, created_at, content }.
 *   USER_INPUT (USER_EXPLICIT)  → user   (only the <USER_REQUEST> body)
 *   PLANNER_RESPONSE (MODEL)    → assistant
 *   other MODEL steps           → tool   (VIEW_FILE, RUN_COMMAND, CODE_ACTION…)
 *   SYSTEM steps                → skipped (history, checkpoints, reminders)
 * transcript.jsonl and chunks/ hold the same steps again and are ignored.
 * There is no cwd field, so the project is inferred from the first absolute
 * path the conversation mentions (walked up to the nearest repo root).
 * ------------------------------------------------------------------------- */
import * as fs from "node:fs";
import * as path from "node:path";
import { getSourceOffset, setSourceOffset, insertTranscript, seqAllocator, ensureProject, getSetting, setSetting } from "../store/db";
import { withTx } from "../store/tx";
import { safeJson, projectSlugFromCwd, readLinesIncremental, stripInjectedTags } from "./util";

const TOOL_TYPES = new Set([
  "VIEW_FILE", "RUN_COMMAND", "CODE_ACTION", "LIST_DIRECTORY", "GREP_SEARCH", "SEARCH_WEB",
  "GENERIC", "BROWSER_SUBAGENT", "READ_URL_CONTENT", "MCP_TOOL", "ASK_QUESTION", "FIND_FILE",
]);

/** Brain transcript files under a root such as ~/.gemini/antigravity. */
export function brainTranscripts(root: string): string[] {
  const brain = path.join(root, "brain");
  if (!fs.existsSync(brain)) return [];
  const out: string[] = [];
  for (const id of fs.readdirSync(brain)) {
    const f = path.join(brain, id, ".system_generated", "logs", "transcript_full.jsonl");
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

/** The user's text without the metadata blocks Antigravity wraps around it. */
export function cleanUserInput(content: string): string {
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  const body = m ? m[1] : content;
  return stripInjectedTags(body.replace(/<([A-Z_]+)>[\s\S]*?<\/\1>/g, "")).trim();
}

const PATH_RE = /@\[(\/[^\]\n]+)\]|file:\/\/(\/[^\s`'")\]]+)|(?:^|[\s`'"(])(\/(?:Users|home|workspace|workspaces|srv|opt|var\/www)\/[^\s`'")\]]+)/;

/** Nearest ancestor with .git / package.json / pyproject, else the folder. */
export function projectRootFor(p: string): string {
  let cur = decodeURIComponent(p).replace(/[.,:;]+$/, "");
  try {
    if (fs.existsSync(cur) && fs.statSync(cur).isFile()) cur = path.dirname(cur);
  } catch {
    /* keep */
  }
  if (!fs.existsSync(cur)) cur = path.dirname(cur);
  let probe = cur;
  for (let i = 0; i < 8; i++) {
    if (["/", ""].includes(probe)) break;
    if ([".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml"].some((m) => fs.existsSync(path.join(probe, m)))) return probe;
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  return cur;
}

export async function scanAntigravityBrain(root: string): Promise<{ files: number; lines: number }> {
  const files = brainTranscripts(root);
  let total = 0;
  for (const file of files) {
    const mtime = fs.statSync(file).mtimeMs;
    const stored = getSourceOffset("antigravity", file);
    const { lines, finalOffset } = await readLinesIncremental(file, stored);
    if (!lines.length) {
      if (finalOffset > stored) setSourceOffset("antigravity", file, finalOffset, mtime);
      continue;
    }
    const sessionId = path.basename(path.dirname(path.dirname(path.dirname(file))));
    const steps = lines.map((l) => safeJson(l)).filter(Boolean) as Array<Record<string, any>>;
    // Project: remembered per conversation; otherwise the first absolute path.
    const projKey = `antigravity:project:${sessionId}`;
    let projPath = getSetting(projKey, "");
    if (!projPath) {
      for (const s of steps) {
        const m = PATH_RE.exec(String(s.content || ""));
        const hit = m && (m[1] || m[2] || m[3]);
        if (hit) {
          projPath = projectRootFor(hit);
          setSetting(projKey, projPath);
          break;
        }
      }
    }
    const projectId = ensureProject(projectSlugFromCwd(projPath || undefined), projPath || undefined);
    const nextSeq = seqAllocator("antigravity");
    withTx(() => {
      for (const s of steps) {
        const type = String(s.type || "");
        const source = String(s.source || "");
        if (source === "SYSTEM") continue;
        let role: "user" | "assistant" | "tool";
        let content = String(s.content || "");
        if (type === "USER_INPUT") {
          role = "user";
          content = cleanUserInput(content);
        } else if (type === "PLANNER_RESPONSE") {
          role = "assistant";
        } else if (TOOL_TYPES.has(type) || source === "MODEL") {
          role = "tool";
          // Drop the "Created At / Completed At" header every tool step starts with.
          content = content.replace(/^(?:Created At|Completed At):[^\n]*\n/gm, "").trim();
        } else {
          continue;
        }
        if (!content.trim()) continue;
        const ts = Date.parse(String(s.created_at || "")) || Date.now();
        insertTranscript({ tool: "antigravity", sessionId, projectId, role, content: content.slice(0, 20000), ts, seq: nextSeq(sessionId) });
        total++;
      }
    });
    setSourceOffset("antigravity", file, finalOffset, mtime);
  }
  return { files: files.length, lines: total };
}
