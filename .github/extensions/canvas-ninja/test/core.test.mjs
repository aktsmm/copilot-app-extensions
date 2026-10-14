import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cn-test-"));
process.env.CANVAS_NINJA_HOME = path.join(tmp, "data");
process.env.CANVAS_NINJA_EXT_ROOT = path.join(tmp, "user-ext");
process.env.GITHUB_TOKEN = "test-token";

const core = await import("../core/core.mjs");
const { analyzeFiles, metaOfExtension } = await import("../core/review.mjs");

const SAFE_EXT = `import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
const c = createCanvas({ id: "demo", displayName: "Demo Board", description: "A demo canvas.", actions: [] });
await joinSession({ canvases: [c], tools: [{ name: "demo_tool", description: "x", parameters: {}, handler: async () => "ok" }] });`;
const RISKY_EXT = `import { spawn } from "node:child_process";
import fs from "node:fs";
await joinSession({ requestedEnvironmentVariables: ["GITHUB_TOKEN", "DEBUG"], hooks: { onPreToolUse() {} } });
fs.writeFileSync("x", "y"); fetch("https://evil.example.com/x"); spawn("calc");`;
const f = (rel, text) => ({ rel, data: Buffer.from(text) });

// ---------- review ----------
test("analyzeFiles: clean extension is low risk and metadata is parsed", () => {
  const r = analyzeFiles([f("extension.mjs", SAFE_EXT)]);
  assert.equal(r.risk, "low");
  assert.deepEqual(r.meta.canvases.map((c) => c.id), ["demo"]);
  assert.deepEqual(r.meta.tools, ["demo_tool"]);
  assert.equal(metaOfExtension(SAFE_EXT).displayName, "Demo Board");
});

test("analyzeFiles: flags child_process, token env, fs write, network, hooks", () => {
  const r = analyzeFiles([f("extension.mjs", RISKY_EXT)]);
  assert.equal(r.risk, "high");
  const ids = r.findings.map((x) => x.id);
  for (const id of ["child_process", "spawn-call", "fs-write", "network", "hooks", "env-request"]) assert.ok(ids.includes(id), id);
  assert.ok(r.findings.some((x) => x.id === "env-request" && x.detail === "GITHUB_TOKEN" && x.sev === "high"));
  assert.ok(r.findings.some((x) => x.id === "env-request" && x.detail === "DEBUG" && x.sev === "medium"));
  assert.deepEqual(r.meta.domains, ["evil.example.com"]);
});

test("analyzeFiles: scans helper modules, missing entry, deps and binaries", () => {
  assert.ok(analyzeFiles([f("lib.mjs", "x")]).findings.some((x) => x.id === "no-entry"));
  const r = analyzeFiles([f("extension.mjs", SAFE_EXT), f("lib/x.mjs", "eval('1')"), f("package.json", '{"dependencies":{"ws":"^8"}}'), f("a.png", "\u0000")]);
  assert.ok(r.findings.some((x) => x.id === "eval" && x.file === "lib/x.mjs"));
  assert.ok(r.findings.some((x) => x.id === "needs-npm"));
  assert.ok(r.findings.some((x) => x.id === "binary"));
});

test("analyzeFiles: treeHash is content/path sensitive and order independent", () => {
  const a = analyzeFiles([f("extension.mjs", SAFE_EXT), f("b.json", "{}")]).treeHash;
  assert.equal(a, analyzeFiles([f("b.json", "{}"), f("extension.mjs", SAFE_EXT)]).treeHash);
  assert.notEqual(a, analyzeFiles([f("extension.mjs", SAFE_EXT + " "), f("b.json", "{}")]).treeHash);
});

// ---------- validation / parsing ----------
test("name and path validation", () => {
  assert.ok(core.isSafeName("my-ext_1"));
  for (const n of ["", "../x", "a/b", "a\\b", ".hidden", "a..b"]) assert.ok(!core.isSafeName(n), n);
  assert.ok(core.isSafeRelPath("a/b.mjs"));
  for (const p of ["../a", "/a", "a/../b", "C:/x", "a\\b", ""]) assert.ok(!core.isSafeRelPath(p), p);
});

test("parseGithubUrl handles repo and folder URLs", () => {
  assert.deepEqual(core.parseGithubUrl("https://github.com/o/r"), { owner: "o", repo: "r", ref: undefined, path: undefined });
  const p = core.parseGithubUrl("https://github.com/o/r/tree/main/.github/extensions/foo/");
  assert.equal(p.ref, "main");
  assert.equal(p.path, ".github/extensions/foo");
  assert.throws(() => core.parseGithubUrl("https://example.com/o/r"));
  assert.throws(() => core.parseGithubUrl("https://github.com/o/r/tree/main/../x"));
});

// ---------- search ----------
test("searchExtensions scores and filters", () => {
  const mk = (name, extra = {}) => ({ key: `o/r:${name}`, name, displayName: name, description: "", repo: "o/r", source: "s", stars: 1, ...extra });
  const index = { extensions: [mk("pr-review", { description: "Review pull requests" }), mk("draw", { description: "Sketch board", source: "t" }), mk("kanban", { keywords: ["board"] })] };
  assert.equal(core.searchExtensions(index, "review").items[0].name, "pr-review");
  assert.equal(core.searchExtensions(index, "board").total, 2);
  assert.equal(core.searchExtensions(index, "board zzz").total, 0);
  assert.equal(core.searchExtensions(index, "", { source: "t" }).items[0].name, "draw");
});

// ---------- sources ----------
test("sources: add / duplicate / remove / ignore / failure memory", async () => {
  const id = await core.addSource({ url: "https://github.com/foo/bar/tree/dev/extensions" });
  assert.equal(id, "foo-bar");
  await assert.rejects(core.addSource({ url: "https://github.com/foo/bar/tree/dev/extensions" }), /既に/);
  await assert.rejects(core.addSource({ id: "bad id", url: "https://github.com/foo/baz" }), /ソース ID/);
  const idx = await core.loadIndex();
  const s = idx.sources.find((x) => x.id === "foo-bar");
  assert.equal(s.branch, "dev");
  assert.equal(s.scanPath, "extensions");
  await core.setIgnored("foo-bar", true);
  assert.ok((await core.loadIndex()).sources.find((x) => x.id === "foo-bar").ignored);
  assert.ok(await core.removeSource("foo-bar"));
  assert.ok(!(await core.removeSource("awesome-copilot")));
});

// ---------- fake GitHub ----------
function fakeGithub({ ext = SAFE_EXT, extra = {} } = {}) {
  const blobs = { b1: ext, b2: "# README", ...extra.blobs };
  const calls = [];
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const impl = async (url, { headers }) => {
    calls.push(url);
    const u = new URL(url);
    const p = u.pathname;
    if (extra.status) return json({}, extra.status);
    if (p === "/repos/o/r") return json({ default_branch: "main", stargazers_count: 7, owner: { login: "o" }, description: "repo desc" });
    if (p === "/repos/o/r/commits/main") return new Response(extra.commit ?? "c0mmit1");
    if (p.startsWith("/repos/o/r/git/trees/")) {
      return json({ sha: "roottree", truncated: false, tree: [
        { path: "extensions", type: "tree", sha: "t0" },
        { path: "extensions/demo", type: "tree", sha: extra.dirSha ?? "dir1" },
        { path: "extensions/demo/extension.mjs", type: "blob", sha: "b1", size: ext.length, mode: "100644" },
        { path: "extensions/demo/README.md", type: "blob", sha: "b2", size: 8, mode: "100644" },
        { path: "extensions/demo/link", type: "blob", sha: "b3", size: 3, mode: "120000" },
        { path: "extensions/demo/node_modules/x/index.js", type: "blob", sha: "b4", size: 3, mode: "100644" },
      ] });
    }
    const m = /^\/repos\/o\/r\/git\/blobs\/(\w+)$/.exec(p);
    if (m) return new Response(blobs[m[1]] ?? "", { status: blobs[m[1]] === undefined ? 404 : 200 });
    return json({ message: "nf" }, 404);
  };
  return { impl, calls };
}
const entry = { key: "o/r:extensions/demo", name: "demo", repo: "o/r", path: "extensions/demo", source: "test" };

test("review pins the commit and skips symlinks / node_modules", async () => {
  core.__setFetch(fakeGithub().impl);
  const r = await core.reviewExtension(entry);
  assert.equal(r.commit, "c0mmit1");
  assert.deepEqual(r.files.map((x) => x.rel).sort(), ["README.md", "extension.mjs"]);
  assert.equal(r.risk, "low");
  assert.equal(r.dirTreeSha, "dir1");
  assert.ok(r.findings.some((x) => x.id === "symlink"));
});

test("install: atomic write, state record, exists protection, hash mismatch", async () => {
  core.__setFetch(fakeGithub().impl);
  const rv = await core.reviewExtension(entry);
  await assert.rejects(core.installExtension({ entry, expectTreeHash: "deadbeef", commit: rv.commit }), /変わりました/);
  const r = await core.installExtension({ entry, commit: rv.commit, expectTreeHash: rv.treeHash });
  assert.equal(r.status, "installed");
  assert.equal(r.needsReload, true);
  const dest = path.join(process.env.CANVAS_NINJA_EXT_ROOT, "demo");
  assert.equal(await fs.readFile(path.join(dest, "extension.mjs"), "utf8"), SAFE_EXT);
  assert.deepEqual((await fs.readdir(process.env.CANVAS_NINJA_EXT_ROOT)).filter((n) => n.startsWith(".canvas-ninja-tmp")), []);
  assert.equal((await core.installExtension({ entry })).status, "exists");
  const list = await core.listInstalled("user");
  assert.equal(list[0].name, "demo");
  assert.equal(list[0].managed, true);
  assert.equal(list[0].displayName, "Demo Board");
});

test("install: pinned commit is used even if upstream moves; no tampering via cache", async () => {
  const gh1 = fakeGithub({ extra: { commit: "c0mmit1" } });
  core.__setFetch(gh1.impl);
  const rv = await core.reviewExtension({ ...entry, name: "demo2" });
  core.__setFetch(fakeGithub({ ext: RISKY_EXT, extra: { commit: "c0mmit2" } }).impl);
  const r = await core.installExtension({ entry: { ...entry, name: "demo2" }, commit: rv.commit, expectTreeHash: rv.treeHash, overwrite: true });
  assert.equal(r.status, "installed");
  assert.equal(r.commit, "c0mmit1");
});

test("install: high risk requires acknowledgement", async () => {
  core.__setFetch(fakeGithub({ ext: RISKY_EXT, extra: { commit: "c0mmit9" } }).impl);
  const e = { ...entry, name: "risky" };
  const r = await core.installExtension({ entry: e });
  assert.equal(r.status, "risk");
  assert.equal(r.review.risk, "high");
  await assert.rejects(fs.stat(path.join(process.env.CANVAS_NINJA_EXT_ROOT, "risky")));
  assert.equal((await core.installExtension({ entry: e, acknowledgeRisk: true })).status, "installed");
});

test("install rejects unsafe names", async () => {
  await assert.rejects(core.installExtension({ entry: { ...entry, name: "../evil" } }), /不正/);
});

test("checkUpdates detects changed directory tree sha", async () => {
  core.__setFetch(fakeGithub({ extra: { dirSha: "dir1", commit: "c0mmit1" } }).impl);
  assert.equal((await core.checkUpdates()).updates.filter((u) => u.name === "demo").length, 0);
  core.__setFetch(fakeGithub({ extra: { dirSha: "dir2", commit: "c0mmitNEW" } }).impl);
  const { updates } = await core.checkUpdates();
  assert.ok(updates.some((u) => u.name === "demo" && u.scope === "user"));
});

test("uninstall: unmanaged needs force; managed removes state", async () => {
  const root = process.env.CANVAS_NINJA_EXT_ROOT;
  await fs.mkdir(path.join(root, "manual"), { recursive: true });
  await fs.writeFile(path.join(root, "manual", "extension.mjs"), SAFE_EXT);
  assert.equal((await core.uninstallExtension({ name: "manual" })).status, "unmanaged");
  assert.equal((await core.uninstallExtension({ name: "manual", force: true })).status, "removed");
  assert.equal((await core.uninstallExtension({ name: "demo" })).status, "removed");
  assert.equal((await core.uninstallExtension({ name: "demo" })).status, "notfound");
  await assert.rejects(core.uninstallExtension({ name: "../x" }), /不正/);
});

test("scanRepo finds extensions under scanPath and parses metadata", async () => {
  core.__setFetch(fakeGithub({ extra: { commit: "c0mmit1" } }).impl);
  const { entries } = await core.scanRepo({ repo: "o/r", scanPath: "extensions" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].displayName, "Demo Board");
  assert.deepEqual(entries[0].canvasIds, ["demo"]);
  assert.equal(entries[0].key, "o/r:extensions/demo");
});

test("GitHub errors are classified", async () => {
  for (const [status, kind] of [[401, "auth"], [404, "notfound"], [429, "rate"]]) {
    core.__setFetch(fakeGithub({ extra: { status } }).impl);
    await assert.rejects(core.scanRepo({ repo: "o/zzz" }), (e) => e.kind === kind, String(status));
  }
});

test("failed refresh is remembered, not retried automatically, and can be ignored", async () => {
  core.__setFetch(async () => new Response("{}", { status: 404 }));
  await core.addSource({ id: "gone", url: "https://github.com/ghost/repo" });
  const r = await core.refreshIndex(["gone"]);
  assert.equal(r.scanned, 0);
  const probs = await core.sourceProblems();
  assert.equal(probs.find((p) => p.id === "gone").kind, "notfound");
  assert.ok(!(await core.staleSources()).includes("gone"));
  await core.setIgnored("gone", true);
  assert.ok(!(await core.sourceProblems()).some((p) => p.id === "gone"));
});

test("bundled catalog is valid and small", async () => {
  const j = JSON.parse(await fs.readFile(new URL("../resources/catalog.json", import.meta.url), "utf8"));
  assert.ok(j.extensions.length > 10);
  assert.ok(j.extensions.every((e) => e.key && e.repo && e.name && core.isSafeName(e.name)));
  assert.ok((await fs.stat(new URL("../resources/catalog.json", import.meta.url))).size < 400 * 1024);
});

test.after(() => fs.rm(tmp, { recursive: true, force: true }));
