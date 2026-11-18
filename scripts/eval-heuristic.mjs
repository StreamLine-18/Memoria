/* Evaluasi kualitas triage Tier 0 tanpa LLM.
 * Pakai: npm run build && node scripts/eval-heuristic.mjs [--verbose]
 * Metrik:
 *   active precision — dari yang diputuskan "active", berapa yang memang memori
 *   memory kept      — dari memori berlabel, berapa yang TIDAK diarsip
 *   noise removed    — dari noise berlabel, berapa yang diarsip
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { rescoreStored } = require(path.join(root, "dist/engine/extract/heuristic.js"));

export function evaluate(items) {
  const rows = items.map((it) => ({ ...it, t: rescoreStored({ kind: it.kind, content: it.content, importance: 0.5 }) }));
  const active = rows.filter((r) => r.t.decision === "active");
  const mem = rows.filter((r) => r.label === "memory");
  const noise = rows.filter((r) => r.label === "noise");
  const ratio = (a, b) => (b ? a / b : 1);
  return {
    rows,
    activePrecision: ratio(active.filter((r) => r.label === "memory").length, active.length),
    memoryKept: ratio(mem.filter((r) => r.t.decision !== "archive").length, mem.length),
    memoryActive: ratio(mem.filter((r) => r.t.decision === "active").length, mem.length),
    noiseRemoved: ratio(noise.filter((r) => r.t.decision === "archive").length, noise.length),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const items = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/heuristic-eval.json"), "utf8")).items;
  const r = evaluate(items);
  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log(`items           ${items.length}`);
  console.log(`active precision ${pct(r.activePrecision)}`);
  console.log(`memory kept      ${pct(r.memoryKept)}  (active ${pct(r.memoryActive)})`);
  console.log(`noise removed    ${pct(r.noiseRemoved)}`);
  const wrong = r.rows.filter((x) => (x.label === "noise") !== (x.t.decision === "archive"));
  if (wrong.length || process.argv.includes("--verbose")) {
    console.log("\nmisclassified:");
    for (const w of wrong) console.log(`  [${w.label} -> ${w.t.decision} ${w.t.score} ${w.t.reason}] ${w.content.slice(0, 100)}`);
  }
}
