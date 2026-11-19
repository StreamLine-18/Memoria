// Fails when a README status badge or server.json does not match package.json,
// so translated READMEs and the MCP Registry metadata never drift on release.
import fs from "node:fs";

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const badge = `status-${version.replace(/-/g, "--")}--beta`;
const problems = [];

for (const file of fs.readdirSync(".").filter((f) => /^README(\.[\w-]+)?\.md$/.test(f))) {
  const text = fs.readFileSync(file, "utf8");
  const found = text.match(/status-[\w.-]+?--beta/);
  if (found && found[0] !== badge) problems.push(`${file}: badge ${found[0]}, expected ${badge}`);
}

const server = JSON.parse(fs.readFileSync("server.json", "utf8"));
if (server.version !== version) problems.push(`server.json: version ${server.version}, expected ${version}`);
for (const p of server.packages || []) {
  if (p.version !== version) problems.push(`server.json: package ${p.identifier} ${p.version}, expected ${version}`);
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`✅ README badges and server.json match ${version}`);
