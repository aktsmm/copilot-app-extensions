// Regenerates resources/catalog.json by scanning the bundled sources on GitHub.
// Usage: node scripts/sync-catalog.mjs   (uses `gh auth token` / GITHUB_TOKEN if available)
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-ninja-sync-"));
process.env.CANVAS_NINJA_HOME = tmp;
const core = await import("../core/core.mjs");

const ids = core.BUNDLED_SOURCES.map((s) => s.id);
const r = await core.refreshIndex(ids);
const cache = await core.readCache();
const extensions = ids.flatMap((id) => (cache.sources[id]?.entries ?? []).map(({ updatedAt, ...e }) => ({ ...e, source: id })));
extensions.sort((a, b) => a.key.localeCompare(b.key));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", "catalog.json");
await fs.writeFile(out, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), extensions }));
await fs.rm(tmp, { recursive: true, force: true });
console.log(`scanned ${r.scanned}/${ids.length} sources, ${extensions.length} extensions -> ${out}`);
if (r.errors.length) console.log(`errors:\n${r.errors.join("\n")}`);
if (r.scanned < ids.length) process.exitCode = 1;
