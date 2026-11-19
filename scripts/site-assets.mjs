// Copies shared brand assets into <dir>/shared/ for the landing page in site/.
// Usage: node scripts/site-assets.mjs <dir>   e.g. site, site/public, site/dist
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/site-assets.mjs <dir>");
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "logo.png",
  "banner.png",
  "docs/img/demo.gif",
  "docs/img/social-preview.png",
  "docs/img/overview.png",
  "docs/img/memori.png",
  "docs/img/graph.png",
  "docs/img/handoff.png",
  "docs/img/pengaturan.png",
];
const dest = path.resolve(out, "shared");
fs.mkdirSync(dest, { recursive: true });
let copied = 0;
for (const f of files) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) continue;
  fs.copyFileSync(src, path.join(dest, path.basename(f)));
  copied++;
}
console.log(`copied ${copied} assets to ${path.relative(process.cwd(), dest) || dest}`);
