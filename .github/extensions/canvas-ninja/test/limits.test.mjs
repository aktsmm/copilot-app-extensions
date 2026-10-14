import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// install_extension rejects any single file over 1,000,000 bytes. Keep a margin.
const LIMIT = 1_000_000;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

test("every shipped file stays under the install_extension 1,000,000 byte limit", async () => {
  const over = [];
  for await (const f of walk(root)) {
    const { size } = await fs.stat(f);
    if (size >= LIMIT) over.push(`${path.relative(root, f)} (${size} bytes)`);
  }
  assert.deepEqual(over, [], `files over ${LIMIT} bytes break install_extension: ${over.join(", ")}`);
});

test("extension is self-contained: entry exists and nothing imports outside the folder", async () => {
  await fs.access(path.join(root, "extension.mjs"));
  const bad = [];
  for await (const f of walk(root)) {
    if (!f.endsWith(".mjs") || f.includes(`${path.sep}test${path.sep}`) || f.includes(`${path.sep}scripts${path.sep}`)) continue;
    const src = await fs.readFile(f, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (path.relative(root, target).startsWith("..")) bad.push(`${path.relative(root, f)} -> ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], "imports escaping the extension folder break install_extension");
});
