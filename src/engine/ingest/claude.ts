import * as fs from "node:fs";
import {
  getSourceOffset,
  setSourceOffset,
  insertTranscript,
  seqAllocator,
  ensureProject,
} from "../store/db";
import { withTx } from "../store/tx";
import { walkFiles, safeJson, textFromContent, projectSlugFromCwd, readLinesIncremental, isToolResultOnly, stripInjectedTags, todosFromContent } from "./util";

export async function scanClaude(root: string, log?: (msg: string) => void): Promise<{ files: number; lines: number }> {
  // A single transcript file is accepted too (Claude Code hooks pass transcript_path).
  let isFile = false;
  try {
    isFile = fs.statSync(root).isFile();
  } catch {
    /* missing root: walkFiles returns [] */
  }
  const files = isFile ? (root.endsWith(".jsonl") ? [root] : []) : walkFiles(root, [".jsonl"]);
  let totalLines = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const mtime = fs.statSync(file).mtimeMs;
    const stored = getSourceOffset("claude", file);
    const { lines, finalOffset } = await readLinesIncremental(file, stored);
    if (!lines.length) {
      if (finalOffset > stored) setSourceOffset("claude", file, finalOffset, mtime);
      continue;
    }
    const nextSeq = seqAllocator("claude");
    withTx(() => {
      for (const line of lines) {
        const j = safeJson(line);
        if (!j) continue;
        if (j.type !== "user" && j.type !== "assistant") continue;
        const ts = Date.parse(j.timestamp || "") || 0;
        const cwd = j.cwd || j.project_path;
        const sessionId = j.sessionId || j.session_id || "n/a";
        const projectId = ensureProject(projectSlugFromCwd(cwd), cwd);
        const rawContent = j.message?.content;
        // Peran sebenarnya: tool_result yang dibungkus pesan "user" → "tool";
        // pesan meta suntikan CLI (isMeta) → "system".
        const role = isToolResultOnly(rawContent) ? "tool" : j.isMeta ? "system" : j.type;
        const content = role === "tool" ? textFromContent(rawContent) : stripInjectedTags(textFromContent(rawContent));
        if (content) {
          insertTranscript({
            tool: "claude",
            sessionId,
            projectId,
            role,
            content,
            ts: ts || Date.now(),
            seq: nextSeq(sessionId),
          });
          totalLines++;
        }
        // TodoWrite: the agent's own task list → a checklist row the heuristic
        // extractor turns into task_pending / task_done memories.
        const todos = j.type === "assistant" ? todosFromContent(rawContent) : "";
        if (todos) {
          insertTranscript({ tool: "claude", sessionId, projectId, role: "assistant", content: todos, ts: ts || Date.now(), seq: nextSeq(sessionId) });
          totalLines++;
        }
      }
    });
    setSourceOffset("claude", file, finalOffset, mtime);
    if (log && (i % 10 === 0 || i === files.length - 1)) {
      log(`claude: ${i + 1}/${files.length} file, ${totalLines} pesan`);
    }
  }
  return { files: files.length, lines: totalLines };
}
