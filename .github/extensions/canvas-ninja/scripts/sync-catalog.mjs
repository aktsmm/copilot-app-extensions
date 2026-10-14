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
if (r.scanned < ids.length) {
  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`errors:\n${r.errors.join("\n")}\ncatalog NOT written (${r.scanned}/${ids.length} sources scanned)`);
  process.exit(1);
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", "catalog.json");
const body = `{\n"version": 1,\n"generatedAt": ${JSON.stringify(new Date().toISOString())},\n"extensions": [\n${extensions.map((e) => JSON.stringify(e)).join(",\n")}\n]\n}\n`;
await fs.writeFile(out, body);
await fs.rm(tmp, { recursive: true, force: true });
console.log(`scanned ${r.scanned}/${ids.length} sources, ${extensions.length} extensions -> ${out}`);
if (r.errors.length) console.log(`errors:\n${r.errors.join("\n")}`);
if (r.scanned < ids.length) process.exitCode = 1;
