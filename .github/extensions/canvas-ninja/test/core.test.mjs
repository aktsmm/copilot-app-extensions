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
const { DICT, t, findingText } = await import("../ui/i18n.mjs");
const EXT_ROOT = process.env.CANVAS_NINJA_EXT_ROOT;
const STATE = path.join(process.env.CANVAS_NINJA_HOME, "canvas-ninja-installed.json");

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

test("analyzeFiles: catches common bypass forms", () => {
  const cases = {
    network: 'await globalThis.fetch("x")',
    "dynamic-require": 'const m = require("node:" + "child_process")',
    "dynamic-import": "await import(name)",
    eval: 'Function("return 1")()',
    obfuscation: 'eval(atob("aGk="))',
  };
  for (const [id, code] of Object.entries(cases)) assert.ok(analyzeFiles([f("extension.mjs", SAFE_EXT + "\n" + code)]).findings.some((x) => x.id === id), id);
  assert.ok(analyzeFiles([f("extension.mjs", 'import https from "node:https";')]).findings.some((x) => x.id === "network"));
});

test("analyzeFiles: scans helper modules, missing entry, deps and binaries", () => {
  assert.ok(analyzeFiles([f("lib.mjs", "x")]).findings.some((x) => x.id === "no-entry"));
  const r = analyzeFiles([f("extension.mjs", SAFE_EXT), f("lib/x.mjs", "eval('1')"), f("package.json", '{"dependencies":{"ws":"^8"}}'), f("a.png", "\u0000")]);
  assert.ok(r.findings.some((x) => x.id === "eval" && x.file === "lib/x.mjs"));
  assert.ok(r.findings.some((x) => x.id === "needs-npm"));
  assert.ok(r.findings.some((x) => x.id === "binary"));
  assert.ok(!analyzeFiles([f("extension.mjs", SAFE_EXT), f("package.json", '{"dependencies":{"@github/copilot-sdk":"^1"}}')]).findings.some((x) => x.id === "needs-npm"));
  assert.equal(analyzeFiles([f("extension.mjs", SAFE_EXT), f("a.png", "\u0000")]).risk, "low");
});

test("analyzeFiles(plugin): MCP commands and hooks are reported, nested extension.mjs counted", () => {
  const r = analyzeFiles([
    f("plugin.json", "{}"), f(".mcp.json", JSON.stringify({ mcpServers: { az: { command: "npx", args: ["-y", "@azure/mcp"] } } })),
    f("hooks/hooks.json", "{}"), f("com.github.copilot/extensions/x/extension.mjs", SAFE_EXT),
  ], { kind: "plugin" });
  assert.ok(r.findings.some((x) => x.id === "plugin-mcp" && /npx -y @azure\/mcp/.test(x.params.list)));
  assert.ok(r.findings.some((x) => x.id === "plugin-hooks"));
  assert.ok(!r.findings.some((x) => x.id === "no-entry"));
  assert.deepEqual(r.meta.canvases.map((c) => c.id), ["demo"]);
});

test("analyzeFiles: treeHash is content/path sensitive and order independent", () => {
  const a = analyzeFiles([f("extension.mjs", SAFE_EXT), f("b.json", "{}")]).treeHash;
  assert.equal(a, analyzeFiles([f("b.json", "{}"), f("extension.mjs", SAFE_EXT)]).treeHash);
  assert.notEqual(a, analyzeFiles([f("extension.mjs", SAFE_EXT + " "), f("b.json", "{}")]).treeHash);
});

// ---------- i18n ----------
test("i18n: ja/en have identical keys and every finding id is localized", () => {
  assert.deepEqual(Object.keys(DICT.ja).sort(), Object.keys(DICT.en).sort());
  const ids = ["no-entry", "child_process", "spawn-call", "eval", "dynamic-require", "auto-approve", "env-dump", "dynamic-import", "fs-write", "network", "send-prompt", "hooks", "obfuscation", "binary", "long-line", "env-request", "domains", "multi-file", "needs-npm", "install-script", "bad-package-json", "symlink", "partial-review", "plugin-mcp", "plugin-hooks"];
  for (const id of ids) for (const l of ["ja", "en"]) assert.ok(DICT[l][`f.${id}`], `${l} f.${id}`);
  assert.match(findingText("en", { id: "env-request", params: { v: "X" } }), /X/);
  assert.equal(t("en", "nope"), "nope");
  for (const l of ["ja", "en"]) for (const [k, v] of Object.entries(DICT[l])) assert.equal([...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(), [...DICT.en[k].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(), `${l} ${k} placeholders`);
});

// ---------- validation / parsing ----------
test("name and path validation", () => {
  assert.ok(core.isSafeName("my-ext_1"));
  for (const n of ["", "../x", "a/b", "a\\b", ".hidden", "a..b"]) assert.ok(!core.isSafeName(n), n);
  assert.ok(core.isSafeRelPath("a/b.mjs"));
  for (const p of ["../a", "/a", "a/../b", "C:/x", "a\\b", ""]) assert.ok(!core.isSafeRelPath(p), p);
});

test("parseGithubUrl handles repo and folder URLs; official org detection", () => {
  assert.deepEqual(core.parseGithubUrl("https://github.com/o/r"), { owner: "o", repo: "r", ref: undefined, path: undefined });
  const p = core.parseGithubUrl("https://github.com/o/r/tree/main/.github/extensions/foo/");
  assert.equal(p.ref, "main");
  assert.equal(p.path, ".github/extensions/foo");
  assert.throws(() => core.parseGithubUrl("https://example.com/o/r"));
  assert.throws(() => core.parseGithubUrl("https://github.com/o/r/tree/main/../x"));
  assert.ok(core.isOfficialRepo("microsoft/azure-dev-tools") && core.isOfficialRepo("Azure/Connectors") && core.isOfficialRepo("github/awesome-copilot"));
  assert.ok(!core.isOfficialRepo("microsoftfan/x"));
});

// ---------- search ----------
test("searchExtensions scores, filters, official and kind", () => {
  const mk = (name, extra = {}) => ({ key: `o/r:${name}`, name, displayName: name, description: "", repo: "o/r", source: "s", stars: 1, kind: "extension", ...extra });
  const index = { extensions: [mk("pr-review", { description: "Review pull requests" }), mk("draw", { description: "Sketch board", source: "t", official: true }), mk("kanban", { keywords: ["board"] }), mk("sk", { kind: "plugin", hasCanvas: false }), mk("cv", { kind: "plugin", hasCanvas: true })] };
  assert.equal(core.searchExtensions(index, "review").items[0].name, "pr-review");
  assert.equal(core.searchExtensions(index, "board").total, 2);
  assert.equal(core.searchExtensions(index, "board zzz").total, 0);
  assert.equal(core.searchExtensions(index, "", { source: "t" }).items[0].name, "draw");
  assert.deepEqual(core.searchExtensions(index, "", { official: true }).items.map((e) => e.name), ["draw"]);
  assert.deepEqual(core.searchExtensions(index, "", { kind: "plugin" }).items.map((e) => e.name).sort(), ["cv", "sk"]);
  assert.ok(!core.searchExtensions(index, "", { kind: "canvas" }).items.some((e) => e.name === "sk"));
});

// ---------- state ----------
test("state: parallel config mutations are serialized (no lost updates)", async () => {
  await Promise.all(Array.from({ length: 25 }, (_, i) => core.toggleListed("favorites", `k${i}`)));
  const c = await core.loadConfig();
  assert.equal(c.favorites.filter((k) => /^k\d+$/.test(k)).length, 25);
  await Promise.all([core.setTheme("ocean"), core.setLang("en"), core.toggleListed("pins", "p1")]);
  const c2 = await core.loadConfig();
  assert.equal(c2.theme, "ocean");
  assert.equal(c2.lang, "en");
  assert.ok(c2.pins.includes("p1"));
});

// ---------- sources ----------
test("sources: add / duplicate / remove / ignore", async () => {
  const id = await core.addSource({ url: "https://github.com/foo/bar/tree/dev/extensions" });
  assert.equal(id, "foo-bar");
  await assert.rejects(core.addSource({ url: "https://github.com/foo/bar/tree/dev/extensions" }), /既に/);
  await assert.rejects(core.addSource({ id: "bad id", url: "https://github.com/foo/baz" }), /ソース ID/);
  const s = (await core.loadIndex()).sources.find((x) => x.id === "foo-bar");
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
  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
  const impl = async (url, { headers }) => {
    const u = new URL(url);
    const p = u.pathname;
    if (extra.status) return json({}, extra.status);
    if (extra.ssoForToken && headers.Authorization) return json({}, 403, { "x-github-sso": "required; url=https://github.com/orgs/x/sso" });
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
        ...(extra.pkg ? [{ path: "extensions/demo/package.json", type: "blob", sha: "b5", size: 30, mode: "100644" }] : []),
      ] });
    }
    const m = /^\/repos\/o\/r\/git\/blobs\/(\w+)$/.exec(p);
    if (m) return new Response(m[1] === "b5" ? '{"dependencies":{"ws":"^8"}}' : (blobs[m[1]] ?? ""), { status: blobs[m[1]] === undefined && m[1] !== "b5" ? 404 : 200 });
    // official plugin repo + marketplace
    if (p === "/repos/o/r/contents/.github/plugin/marketplace.json") {
      return new Response(JSON.stringify({ plugins: extra.plugins ?? [
        { name: "az-canvas", description: "Azure canvas", version: "1.0.0", author: { name: "MS" }, source: { source: "github", repo: "microsoft/plug", path: "canvases/az", sha: "pinned1" } },
        { name: "community-skill", description: "just skills", source: { source: "github", repo: "someone/skills" } },
        { name: "local-one", description: "canvas thing", source: "plugins/local-one" },
      ] }));
    }
    if (p === "/repos/microsoft/plug/commits/pinned1") return new Response("pinned1");
    if (p === "/repos/microsoft/plug/git/trees/pinned1") {
      return json({ sha: "pt", truncated: false, tree: [
        { path: "canvases/az/plugin.json", type: "blob", sha: "p1", size: 2, mode: "100644" },
        { path: "canvases/az/skills/s/SKILL.md", type: "blob", sha: "p2", size: 2, mode: "100644" },
        { path: "canvases/az/com.github.copilot/extensions/az/extension.mjs", type: "blob", sha: "p3", size: ext.length, mode: "100644" },
        { path: "other/readme.md", type: "blob", sha: "p9", size: 1, mode: "100644" },
      ] });
    }
    const pb = /^\/repos\/microsoft\/plug\/git\/blobs\/(\w+)$/.exec(p);
    if (pb) return new Response({ p1: "{}", p2: "# s", p3: ext }[pb[1]] ?? "", { status: 200 });
    return json({ message: "nf" }, 404);
  };
  return { impl };
}
const entry = { key: "o/r:extensions/demo", name: "demo", repo: "o/r", path: "extensions/demo", source: "test" };

test("review pins the commit, skips symlinks / node_modules and returns a reviewId", async () => {
  core.__setFetch(fakeGithub().impl);
  const r = await core.reviewExtension(entry);
  assert.ok(r.reviewId);
  assert.equal(r.commit, "c0mmit1");
  assert.deepEqual(r.files.map((x) => x.rel).sort(), ["README.md", "extension.mjs"]);
  assert.equal(r.risk, "low");
  assert.equal(r.dirTreeSha, "dir1");
  assert.ok(r.findings.some((x) => x.id === "symlink" && x.params.n === 1));
});

test("install requires a valid reviewId for the same entry", async () => {
  core.__setFetch(fakeGithub().impl);
  await assert.rejects(core.installExtension({ entry }), (e) => e.kind === "review");
  await assert.rejects(core.installExtension({ entry, reviewId: "nope" }), (e) => e.kind === "review");
  const rv = await core.reviewExtension(entry);
  await assert.rejects(core.installExtension({ entry: { ...entry, key: "o/r:other", name: "other" }, reviewId: rv.reviewId }), /一致/);
});

test("install: writes exactly the reviewed bytes (upstream changes after review do not matter)", async () => {
  core.__setFetch(fakeGithub({ extra: { commit: "c0mmit1" } }).impl);
  const e = { ...entry, name: "demo2", key: "o/r:extensions/demo2" };
  const rv = await core.reviewExtension(e);
  core.__setFetch(fakeGithub({ ext: RISKY_EXT, extra: { commit: "c0mmit2" } }).impl);
  const r = await core.installExtension({ entry: e, reviewId: rv.reviewId });
  assert.equal(r.status, "installed");
  assert.equal(r.commit, "c0mmit1");
  assert.equal(await fs.readFile(path.join(EXT_ROOT, "demo2", "extension.mjs"), "utf8"), SAFE_EXT);
  assert.deepEqual((await fs.readdir(EXT_ROOT)).filter((n) => n.startsWith(".canvas-ninja")), []);
  const list = await core.listInstalled("user");
  const d2 = list.find((x) => x.name === "demo2");
  assert.equal(d2.managed, true);
  assert.equal(d2.displayName, "Demo Board");
  assert.equal((await core.installExtension({ entry: e, reviewId: rv.reviewId })).status, "exists");
});

test("install: high risk requires acknowledgement; no-entry and dependency extensions are blocked", async () => {
  core.__setFetch(fakeGithub({ ext: RISKY_EXT, extra: { commit: "c0mmit9" } }).impl);
  const e = { ...entry, name: "risky", key: "o/r:extensions/risky" };
  const rv = await core.reviewExtension(e);
  assert.equal(rv.risk, "high");
  assert.equal((await core.installExtension({ entry: e, reviewId: rv.reviewId })).status, "risk");
  await assert.rejects(fs.stat(path.join(EXT_ROOT, "risky")));
  assert.equal((await core.installExtension({ entry: e, reviewId: rv.reviewId, acknowledgeRisk: true })).status, "installed");

  core.__setFetch(fakeGithub({ extra: { commit: "c0mmit8", pkg: true } }).impl);
  const dep = { ...entry, name: "withdeps", key: "o/r:extensions/withdeps" };
  const rv2 = await core.reviewExtension(dep);
  assert.ok(rv2.findings.some((x) => x.id === "needs-npm"));
  await assert.rejects(core.installExtension({ entry: dep, reviewId: rv2.reviewId, acknowledgeRisk: true }), (x) => x.kind === "blocked" && x.findingId === "needs-npm");
  await assert.rejects(fs.stat(path.join(EXT_ROOT, "withdeps")));
});

test("install: overwrite failure restores the previous extension (rollback)", async () => {
  core.__setFetch(fakeGithub({ extra: { commit: "c0mmit3" } }).impl);
  const e = { ...entry, name: "keep", key: "o/r:extensions/keep" };
  const first = await core.reviewExtension(e);
  await core.installExtension({ entry: e, reviewId: first.reviewId });
  await fs.writeFile(path.join(EXT_ROOT, "keep", "marker.txt"), "old");
  const again = await core.reviewExtension(e);
  // Make state persistence fail after the swap: a directory in place of the state file.
  const savedState = await fs.readFile(STATE, "utf8").catch(() => "{}");
  await fs.rm(STATE, { force: true });
  await fs.mkdir(STATE);
  await assert.rejects(core.installExtension({ entry: e, reviewId: again.reviewId, overwrite: true }));
  await fs.rm(STATE, { recursive: true, force: true });
  await fs.writeFile(STATE, savedState);
  assert.equal(await fs.readFile(path.join(EXT_ROOT, "keep", "marker.txt"), "utf8"), "old");
  assert.deepEqual((await fs.readdir(EXT_ROOT)).filter((n) => n.startsWith(".canvas-ninja")), []);
});

test("install rejects unsafe names", async () => {
  await assert.rejects(core.installExtension({ entry: { ...entry, name: "../evil" }, reviewId: "x" }), /不正/);
});

test("checkUpdates detects changed directory tree sha", async () => {
  core.__setFetch(fakeGithub({ extra: { dirSha: "dir1", commit: "c0mmit1" } }).impl);
  assert.equal((await core.checkUpdates()).updates.filter((u) => u.name === "demo2").length, 0);
  core.__setFetch(fakeGithub({ extra: { dirSha: "dir2", commit: "c0mmitNEW" } }).impl);
  const { updates } = await core.checkUpdates();
  assert.ok(updates.some((u) => u.name === "demo2" && u.scope === "user"));
});

test("uninstall: unmanaged needs force; managed removes state", async () => {
  await fs.mkdir(path.join(EXT_ROOT, "manual"), { recursive: true });
  await fs.writeFile(path.join(EXT_ROOT, "manual", "extension.mjs"), SAFE_EXT);
  assert.equal((await core.uninstallExtension({ name: "manual" })).status, "unmanaged");
  assert.equal((await core.uninstallExtension({ name: "manual", force: true })).status, "removed");
  assert.equal((await core.uninstallExtension({ name: "demo2" })).status, "removed");
  assert.equal((await core.uninstallExtension({ name: "demo2" })).status, "notfound");
  await assert.rejects(core.uninstallExtension({ name: "../x" }), /不正/);
});

test("scanRepo finds extensions under scanPath and parses metadata", async () => {
  core.__setFetch(fakeGithub({ extra: { commit: "c0mmit1" } }).impl);
  const { entries } = await core.scanRepo({ repo: "o/r", scanPath: "extensions" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].displayName, "Demo Board");
  assert.deepEqual(entries[0].canvasIds, ["demo"]);
});

// ---------- GitHub access ----------
test("GitHub errors are classified", async () => {
  for (const [status, kind] of [[401, "auth"], [404, "notfound"], [429, "rate"]]) {
    core.__setFetch(fakeGithub({ extra: { status } }).impl);
    await assert.rejects(core.scanRepo({ repo: "o/zzz" }), (e) => e.kind === kind, String(status));
  }
});

test("an SSO-blocked token falls back to anonymous access for public repos", async () => {
  core.__setFetch(fakeGithub({ extra: { ssoForToken: true, commit: "c0mmit1" } }).impl);
  const { entries } = await core.scanRepo({ repo: "o/r", scanPath: "extensions" });
  assert.equal(entries.length, 1);
});

test("failed refresh is remembered, not retried automatically, and can be ignored", async () => {
  core.__setFetch(async () => new Response("{}", { status: 404 }));
  await core.addSource({ id: "gone", url: "https://github.com/ghost/repo" });
  const r = await core.refreshIndex(["gone"]);
  assert.equal(r.scanned, 0);
  assert.equal((await core.sourceProblems()).find((p) => p.id === "gone").kind, "notfound");
  assert.ok(!(await core.staleSources()).includes("gone"));
  await core.setIgnored("gone", true);
  assert.ok(!(await core.sourceProblems()).some((p) => p.id === "gone"));
});

// ---------- official marketplace / plugins ----------
const mkt = { id: "mkt", url: "https://github.com/o/r", marketplaceFile: ".github/plugin/marketplace.json", marketplaceName: "awesome-copilot", type: "official" };

test("scanMarketplace keeps official/canvas plugins with pinned sha and summarizes contents", async () => {
  core.__setFetch(fakeGithub().impl);
  const { entries, errors } = await core.scanMarketplace(mkt);
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => e.name), ["az-canvas"]);
  const e = entries[0];
  assert.equal(e.kind, "plugin");
  assert.equal(e.pluginSpec, "az-canvas@awesome-copilot");
  assert.equal(e.sha, "pinned1");
  assert.equal(e.hasCanvas, true);
  assert.deepEqual(e.contents, { skills: 1, agents: 0, extensions: 1, mcp: false, hooks: false });
  assert.equal(core.searchExtensions({ extensions: [{ ...e, official: core.isOfficialRepo(e.repo) }] }, "", { official: true }).total, 1);
});

test("reviewPlugin + installPlugin: reviewId required, marketplace pin must still match, native installer is used", async () => {
  core.__setFetch(fakeGithub().impl);
  const { entries } = await core.scanMarketplace(mkt);
  const e = { ...entries[0], source: "awesome-copilot-plugins", marketplace: "awesome-copilot" };
  const rv = await core.reviewPlugin(e);
  assert.equal(rv.kind, "plugin");
  assert.equal(rv.commit, "pinned1");
  assert.equal(rv.contents.extensions, 1);
  assert.deepEqual(rv.meta.canvases.map((c) => c.id), ["demo"]);
  const calls = [];
  const plugins = { marketplaces: async () => [{ name: "awesome-copilot" }], install: async (s) => (calls.push(s), { postInstallMessage: "hi", skillsInstalled: 1 }) };
  await assert.rejects(core.installPlugin({ entry: e, reviewId: "bad", plugins }), (x) => x.kind === "review");
  await core.setSourceUrl("awesome-copilot-plugins", "https://github.com/o/r"); // point the bundled source at the fake marketplace
  const ok = await core.installPlugin({ entry: e, reviewId: rv.reviewId, plugins });
  assert.equal(ok.status, "installed");
  assert.deepEqual(calls, ["az-canvas@awesome-copilot"]);
  // the marketplace re-pinned the plugin after review: fail closed
  core.__setFetch(fakeGithub({ extra: { plugins: [{ name: "az-canvas", source: { source: "github", repo: "microsoft/plug", path: "canvases/az", sha: "moved2" } }] } }).impl);
  await assert.rejects(core.installPlugin({ entry: e, reviewId: rv.reviewId, plugins }), /固定コミット/);
  // unregistered marketplace
  core.__setFetch(fakeGithub().impl);
  await assert.rejects(core.installPlugin({ entry: e, reviewId: rv.reviewId, plugins: { ...plugins, marketplaces: async () => [] } }), /未登録/);
  assert.equal(calls.length, 1);
});

test("custom sets: create, add, remove item, auto-delete when empty, delete", async () => {
  const a = await core.addToBundle({ key: "github/awesome-copilot:extensions/draw", name: "My Azure" });
  assert.match(a.id, /^my-[0-9a-f]{8}$/);
  await core.addToBundle({ key: "github/awesome-copilot:extensions/draw", bundleId: a.id });
  const b2 = await core.addToBundle({ key: "github/awesome-copilot:extensions/color-orb", bundleId: a.id });
  assert.equal(b2.count, 2);
  const mine = (await core.loadBundles()).bundles.find((b) => b.id === a.id);
  assert.ok(mine.custom && mine.name.ja === "My Azure" && mine.items.length === 2);
  await assert.rejects(core.addToBundle({ key: "x" }), /name required/);
  await core.removeFromBundle({ bundleId: a.id, key: "github/awesome-copilot:extensions/draw" });
  assert.equal((await core.loadBundles()).bundles.find((b) => b.id === a.id).items.length, 1);
  await core.removeFromBundle({ bundleId: a.id, key: "github/awesome-copilot:extensions/color-orb" });
  assert.ok(!(await core.loadBundles()).bundles.some((b) => b.id === a.id));
  const c = await core.addToBundle({ key: "k", name: "tmp" });
  assert.ok(await core.deleteBundle(c.id));
  assert.ok(!(await core.deleteBundle(c.id)));
});

test("bundled catalog and bundles are valid", async () => {
  const j = JSON.parse(await fs.readFile(new URL("../resources/catalog.json", import.meta.url), "utf8"));
  assert.ok(j.extensions.length > 30);
  assert.ok(j.extensions.every((e) => e.key && e.repo && e.name));
  assert.ok(j.extensions.filter((e) => e.kind !== "plugin").every((e) => core.isSafeName(e.name)));
  assert.ok((await fs.stat(new URL("../resources/catalog.json", import.meta.url))).size < 400 * 1024);
  const keys = new Set(j.extensions.map((e) => e.key));
  const ja = JSON.parse(await fs.readFile(new URL("../resources/catalog-ja.json", import.meta.url), "utf8"));
  for (const e of j.extensions) if (e.description) assert.ok(ja[e.key], `missing ja: ${e.key}`);
  for (const k of Object.keys(ja)) assert.ok(keys.has(k), `stale ja: ${k}`);
  const idx = await core.loadIndex();
  assert.ok(idx.extensions.find((e) => e.key === "github/awesome-copilot:extensions/draw").description_ja);
  assert.ok(core.searchExtensions(idx, "draw", { ja: {} }).items[0].description_ja);
  const { bundles } = await core.loadBundles();
  assert.ok(bundles.length >= 1);
  for (const b of bundles) {
    assert.ok(b.name.ja && b.name.en && b.description.ja && b.description.en, b.id);
    for (const k of b.items) assert.ok(keys.has(k), `${b.id}: ${k}`);
  }
});

test.after(() => fs.rm(tmp, { recursive: true, force: true }));
