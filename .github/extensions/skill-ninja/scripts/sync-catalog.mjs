// Sync the bundled catalog with the VS Code "Agent Skills Ninja" catalog.
// Usage: node scripts/sync-catalog.mjs [--local]
//   default : pull upstream resources/skill-index.json (public repo) via `gh api`
//   --local : also merge non-user-added sources/skills from the local VS Code extension data
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vscodeIndexCandidates, EXCLUDED_SOURCES } from "../core/core.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", "skill-index.json");
const UPSTREAM = "repos/aktsmm/vscode-agent-skill-ninja/contents/resources/skill-index.json";
const PRIVATE_TYPES = new Set(["user-added"]);
// Sources intentionally dropped from the bundled catalog even if upstream still lists them.
const EXCLUDED_SOURCES = new Set(["microsoftdocs-agent-skills"]);

const readJson = async (f) => JSON.parse((await fs.readFile(f, "utf8")).replace(/^\uFEFF/, ""));
const merge = (base, extra) => {
  const sources = new Map(base.sources.map((s) => [s.id, s]));
  for (const s of extra.sources ?? []) if (!PRIVATE_TYPES.has(s.type) && !sources.has(s.id)) sources.set(s.id, s);
  const skills = new Map(base.skills.map((s) => [`${s.source}/${s.path}`, s]));
  for (const s of extra.skills ?? []) if (sources.has(s.source) && !skills.has(`${s.source}/${s.path}`)) skills.set(`${s.source}/${s.path}`, s);
  const bundles = new Map((base.bundles ?? []).map((b) => [b.id, b]));
  for (const b of extra.bundles ?? []) if (sources.has(b.source) && !bundles.has(b.id)) bundles.set(b.id, b);
  const lastUpdated = [base.lastUpdated, extra.lastUpdated].filter(Boolean).sort().pop();
  return { ...base, lastUpdated, sources: [...sources.values()], skills: [...skills.values()], bundles: [...bundles.values()], categories: base.categories ?? extra.categories ?? [] };
};

const raw = execFileSync("gh", ["api", UPSTREAM, "-H", "Accept: application/vnd.github.raw"], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
let index = JSON.parse(raw.replace(/^\uFEFF/, ""));
if (process.argv.includes("--local")) {
  for (const f of vscodeIndexCandidates()) {
    try {
      index = merge(index, await readJson(f));
      console.log("merged", f);
    } catch {
      // not present
    }
  }
}
// install_extension rejects files over 1,000,000 bytes: write compact JSON without empty fields.
index.sources = index.sources.filter((s) => !EXCLUDED_SOURCES.has(s.id));
index.skills = index.skills.filter((s) => !EXCLUDED_SOURCES.has(s.source));
index.bundles = (index.bundles ?? []).filter((b) => !EXCLUDED_SOURCES.has(b.source));
for (const s of index.skills) for (const k of Object.keys(s)) if (s[k] === "" || (Array.isArray(s[k]) && !s[k].length)) delete s[k];
const json = JSON.stringify(index);
if (Buffer.byteLength(json) > 990000) throw new Error(`catalog is ${Buffer.byteLength(json)} bytes; install_extension limits files to 1,000,000 bytes`);
await fs.writeFile(OUT, json);
console.log(`catalog: ${index.sources.length} sources, ${index.skills.length} skills, ${index.bundles.length} bundles (updated ${index.lastUpdated})`);
