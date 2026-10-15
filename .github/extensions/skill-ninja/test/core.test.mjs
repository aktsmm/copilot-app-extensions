import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Never touch the real shared store (%APPDATA%\agent-ninja) from tests.
process.env.SKILL_NINJA_SHARED_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "sn-shared-"));

import { loadIndex, searchSkills, getFacets, installSkill, uninstallSkill, listInstalled, isSafeName, isSafeRelPath } from "../core/core.mjs";

test("shared sources manifest: read validated, write only if exists, honors lock", async () => {
  const dir = process.env.SKILL_NINJA_SHARED_DIR;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "snh-"));
  process.env.SKILL_NINJA_HOME = home;
  const core = await import(`../core/core.mjs?shared=${Date.now()}`);
  const file = path.join(dir, "sources.json");
  try {
    await core.addSource({ id: "no-manifest", url: "https://github.com/a/b" });
    assert.equal(await fs.stat(file).then(() => true, () => false), false);
    await core.removeSource("no-manifest");

    await fs.writeFile(file, JSON.stringify({
      schemaVersion: 1, updatedBy: "other.ext", lastUpdated: "x",
      sources: [
        { id: "shared-ok", name: "Shared OK", url: "https://github.com/x/shared", type: "user-added", excludePaths: ["a/", "../bad"] },
        { id: "bad id", url: "https://github.com/x/y" },
        { id: "bad-url", url: "http://evil.example/x" },
        { id: "other-field", url: "https://github.com/x/z", extra: { keep: true } },
      ],
    }));
    const idx = await core.loadIndex();
    const s = idx.sources.find((x) => x.id === "shared-ok");
    assert.equal(s.origin, "shared");
    assert.deepEqual(s.excludePaths, ["a/"]);
    assert.ok(!idx.sources.some((x) => x.id === "bad id" || x.id === "bad-url"));

    assert.equal(await core.addSource({ id: "from-app", url: "https://github.com/me/app" }), "written");
    let raw = JSON.parse(await fs.readFile(file, "utf8"));
    assert.ok(raw.sources.some((x) => x.id === "from-app"));
    assert.ok(raw.sources.find((x) => x.id === "other-field").extra.keep, "unknown fields of other writers survive");
    assert.equal(raw.updatedBy, "aktsmm.agent-skills-ninja-copilot-app");

    await fs.writeFile(path.join(dir, "index.lock"), "{}");
    assert.equal(await core.addSource({ id: "while-locked", url: "https://github.com/me/lock" }), "locked");
    raw = JSON.parse(await fs.readFile(file, "utf8"));
    assert.ok(!raw.sources.some((x) => x.id === "while-locked"));
    await fs.rm(path.join(dir, "index.lock"));

    assert.equal(await core.removeSource("shared-ok"), true);
    raw = JSON.parse(await fs.readFile(file, "utf8"));
    assert.ok(!raw.sources.some((x) => x.id === "shared-ok"));
  } finally {
    delete process.env.SKILL_NINJA_HOME;
    await fs.rm(file, { force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("path safety", () => {
  assert.equal(isSafeName("../x"), false);
  assert.equal(isSafeName("pdf-tools"), true);
  assert.equal(isSafeRelPath("a/../b"), false);
  assert.equal(isSafeRelPath("/abs"), false);
  assert.equal(isSafeRelPath("a/b.md"), true);
});

test("search", async () => {
  const index = await loadIndex();
  assert.ok(searchSkills(index, "docx").total > 0);
});

test("source management + update detection", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "snh-"));
  process.env.SKILL_NINJA_HOME = home;
  const core = await import(`../core/core.mjs?home=${Date.now()}`);
  try {
    await core.addSource({ id: "my-src", url: "https://github.com/github/awesome-copilot" });
    assert.ok((await core.loadIndex()).sources.some((s) => s.id === "my-src"));
    await assert.rejects(core.addSource({ id: "../bad", url: "https://github.com/a/b" }));
    assert.equal(await core.removeSource("my-src"), true);

    const index = await core.loadIndex();
    const skill = index.skills.find((s) => s.source === "github-awesome-copilot");
    const source = index.sources.find((s) => s.id === skill.source);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sn-"));
    await core.installSkill({ skill, source, scope: "project", cwd });
    assert.deepEqual(await core.checkUpdates(index, cwd), []);
    const state = JSON.parse(await fs.readFile(path.join(home, "skill-ninja-installed.json"), "utf8"));
    for (const k of Object.keys(state)) state[k].sha = "0".repeat(40);
    await fs.writeFile(path.join(home, "skill-ninja-installed.json"), JSON.stringify(state));
    assert.equal((await core.checkUpdates(index, cwd)).length, 1);
    await fs.rm(cwd, { recursive: true, force: true });
  } finally {
    delete process.env.SKILL_NINJA_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("ui server rejects missing token and serves api", async () => {
  const { startUiServer } = await import("../core/ui.mjs");
  const ui = await startUiServer(() => process.cwd());
  try {
    assert.equal((await fetch(`http://127.0.0.1:${ui.port}/api/search?q=pdf`)).status, 403);
    const r = await (await fetch(`http://127.0.0.1:${ui.port}/api/search?q=pdf&t=${ui.token}`)).json();
    assert.ok(r.total > 0);
    assert.match(await (await fetch(`http://127.0.0.1:${ui.port}/?t=${ui.token}`)).text(), /Agent Skills Ninja/);
  } finally {
    ui.server.close();
  }
});

test("pagination, filters and facets", async () => {
  const index = await loadIndex();
  const p1 = searchSkills(index, "", 10);
  const p2 = searchSkills(index, "", 10, { offset: 10 });
  assert.equal(p1.items.length, 10);
  assert.notEqual(p1.items[0].name + p1.items[0].source, p2.items[0].name + p2.items[0].source);
  const f = getFacets(index);
  assert.ok(f.sources.length > 1 && f.categories.length > 0);
  const bySrc = searchSkills(index, "", 5, { source: f.sources[0].id });
  assert.ok(bySrc.items.every((s) => s.source === f.sources[0].id));
  assert.equal(bySrc.total, f.sources[0].count);
});

test("favorites, pins, frontmatter, import from VS Code data", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "snh-"));
  process.env.SKILL_NINJA_HOME = home;
  const core = await import(`../core/core.mjs?fav=${Date.now()}`);
  try {
    assert.equal(await core.toggleFavorite("a/b"), true);
    assert.deepEqual(await core.getFavorites(), ["a/b"]);
    assert.equal(await core.toggleFavorite("a/b"), false);
    assert.equal(await core.togglePin("a/b"), true);
    assert.deepEqual(await core.getPins(), ["a/b"]);
    assert.deepEqual(core.parseFrontmatter("---\nname: x\ndescription: >\n  line one\n  line two\n---\nbody"), { name: "x", description: "line one line two" });

    const fake = path.join(home, "vsc-index.json");
    await fs.writeFile(fake, JSON.stringify({
      sources: [
        { id: "my-private", url: "https://github.com/me/skills", type: "user-added" },
        { id: "../evil", url: "https://github.com/x/y" },
        { id: "bad-url", url: "https://example.com/x" },
      ],
      skills: [
        { name: "hello", source: "my-private", path: "skills/hello", description: "hi", categories: [] },
        { name: "orphan", source: "unknown", path: "skills/orphan" },
        { name: "esc", source: "my-private", path: "../x" },
      ],
    }));
    const r = await core.importFromVsCode([fake, path.join(home, "missing.json")]);
    assert.deepEqual(r.sources, ["my-private"]);
    assert.equal(r.skills, 1);
    assert.equal((await core.importFromVsCode([fake])).skills, 0);
    const idx = await core.loadIndex();
    assert.ok(idx.sources.some((s) => s.id === "my-private"));
    assert.ok(idx.skills.some((s) => s.name === "hello"));
    assert.ok((await core.projectContext(process.cwd())).length > 0);
  } finally {
    delete process.env.SKILL_NINJA_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("failing sources: classified, remembered, no nagging loop, ignore, change URL", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "snh-"));
  process.env.SKILL_NINJA_HOME = home;
  process.env.GITHUB_TOKEN = "test-token";
  const realFetch = globalThis.fetch;
  const core = await import(`../core/core.mjs?fail=${Date.now()}`);
  const res = (status, headers = {}, body = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
  try {
    await core.addSource({ id: "src-sso", url: "https://github.com/org/sso" });
    await core.addSource({ id: "src-gone", url: "https://github.com/me/gone" });
    await core.addSource({ id: "src-ok", url: "https://github.com/me/ok" });
    globalThis.fetch = async (url) => {
      if (/org\/sso/.test(url)) return res(403, { "x-github-sso": "required; url=https://github.com/orgs/org/sso?authorization_request=abc" });
      if (/me\/gone/.test(url)) return res(404);
      if (/me\/ok\/git\/trees/.test(url)) return res(200, {}, { tree: [{ type: "blob", path: "skills/new-one/SKILL.md" }] });
      if (/me\/ok$/.test(url)) return res(200, {}, { default_branch: "master" });
      return res(200, {}, { tree: [] });
    };
    const r = await core.refreshIndex(["src-sso", "src-gone", "src-ok"]);
    assert.equal(r.scanned, 1);
    assert.equal(r.added, 1);
    const kinds = Object.fromEntries(r.failed.map((f) => [f.id, f.kind]));
    assert.deepEqual(kinds, { "src-sso": "sso", "src-gone": "notfound" });
    assert.match(r.errors.join("\n"), /org\/sso/);
    assert.ok(r.failed.find((f) => f.id === "src-sso").ssoUrl.startsWith("https://github.com/"));

    const problems = await core.sourceProblems();
    assert.deepEqual(problems.map((p) => p.id).sort(), ["src-gone", "src-sso"]);
    const stale = (await core.staleSources(null, Date.parse("2031-01-01"))).map((s) => s.id);
    assert.ok(!stale.includes("src-sso") && !stale.includes("src-gone"), "failing sources must not keep reappearing as stale");

    await core.setIgnored("src-gone", true);
    assert.deepEqual((await core.sourceProblems()).map((p) => p.id), ["src-sso"]);
    const all = await core.refreshIndex();
    assert.ok(!all.failed.some((f) => ["src-gone", "src-sso"].includes(f.id)), "auto scans skip failed/ignored sources");
    await core.setIgnored("src-gone", false);

    await core.setSourceUrl("src-sso", "https://github.com/me/ok");
    assert.ok(!(await core.sourceProblems()).some((p) => p.id === "src-sso"), "changing the URL clears the failure");
    assert.equal((await core.loadIndex()).sources.find((s) => s.id === "src-sso").url, "https://github.com/me/ok");
    await assert.rejects(core.setSourceUrl("src-sso", "https://example.com/x"));

    globalThis.fetch = async () => res(429, { "x-ratelimit-remaining": "0" });
    const rl = await core.refreshIndex(["src-sso", "src-ok"]);
    assert.equal(rl.failed.length, 1, "rate limit stops the run");
    assert.ok(!(await core.sourceProblems()).some((p) => p.id === "src-ok"), "rate limit must not mark a source as broken");

    const idx = await core.loadIndex();
    assert.ok(idx.sources.every((s) => /^[A-Za-z0-9._-]+$/.test(s.id)), "sources without an id are dropped");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GITHUB_TOKEN;
    delete process.env.SKILL_NINJA_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("theme persists and is injected server-side", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "snh-"));
  const prev = process.env.SKILL_NINJA_HOME;
  process.env.SKILL_NINJA_HOME = home;
  const stamp = Date.now();
  // ui.mjs imports ./core.mjs, so load both through a fresh copy of the directory to keep one isolated instance.
  const copy = path.join(home, "core");
  await fs.cp(new URL("../core/", import.meta.url), copy, { recursive: true });
  await fs.cp(new URL("../resources/", import.meta.url), path.join(home, "resources"), { recursive: true });
  const core = await import(`${new URL(`file:///${copy.replace(/\\/g, "/")}/core.mjs`)}?t=${stamp}`);
  const { startUiServer } = await import(`${new URL(`file:///${copy.replace(/\\/g, "/")}/ui.mjs`)}?t=${stamp}`);
  const ui = await startUiServer(() => process.cwd());
  try {
    assert.equal(await core.getTheme(), "auto");
    const post = (t) => fetch(`http://127.0.0.1:${ui.port}/api/theme?t=${ui.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: t }) });
    assert.equal((await post("ninja")).status, 200);
    assert.equal((await post("evil\"><script>")).status, 500);
    assert.equal(await core.getTheme(), "ninja");
    assert.match(await (await fetch(`http://127.0.0.1:${ui.port}/?t=${ui.token}`)).text(), /data-theme="ninja"/);
    assert.ok(JSON.parse(await fs.readFile(path.join(home, "skill-ninja.json"), "utf8")).theme === "ninja");
  } finally {
    ui.server.close();
    if (prev === undefined) delete process.env.SKILL_NINJA_HOME;
    else process.env.SKILL_NINJA_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("stale sources, localize, create skill, upstream sync, web search", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "snh-"));
  process.env.SKILL_NINJA_HOME = home;
  const core = await import(`../core/core.mjs?stale=${Date.now()}`);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sn-"));
  try {
    const stale = await core.staleSources(null, Date.parse("2030-01-01"));
    assert.ok(stale.length > 0 && (stale[0].unknown || stale[0].days >= 30));
    const few = await core.refreshIndex(undefined, { limit: 2 });
    assert.equal(few.scanned + few.errors.length, 2);
    const after = await core.staleSources(null, Date.now());
    const scanned = JSON.parse(await fs.readFile(path.join(home, "skill-ninja-index-cache.json"), "utf8")).scans;
    assert.ok(Object.keys(scanned).length >= 1 || few.errors.length === 2);
    assert.ok(after.length >= 0);

    await core.setLocalized("anthropics-skills", "docx", "Word 文書の作成・編集");
    const docx = (await core.loadIndex()).skills.find((s) => s.name === "docx" && s.source === "anthropics-skills");
    assert.equal(docx.description_ja, "Word 文書の作成・編集");
    await assert.rejects(core.setLocalized("x", "../bad", "t"));

    assert.equal((await core.createSkill({ name: "my-skill", description: "does: things", scope: "project", cwd })).status, "created");
    assert.equal((await core.createSkill({ name: "my-skill", scope: "project", cwd })).status, "exists");
    const listed = await core.listInstalled("project", cwd);
    assert.equal(listed[0].description, "does: things");
    await assert.rejects(core.createSkill({ name: "../x", scope: "project", cwd }));

    const fake = async () => ({ ok: true, text: async () => JSON.stringify({
      sources: [{ id: "new-official", url: "https://github.com/a/b", type: "official" }, { id: "priv", url: "https://github.com/a/c", type: "user-added" }],
      skills: [{ name: "n1", source: "new-official", path: "skills/n1" }, { name: "n2", source: "priv", path: "skills/n2" }],
    }) });
    assert.deepEqual(await core.syncUpstream(fake), { sources: 1, skills: 1 });
    assert.deepEqual(await core.syncUpstream(fake), { sources: 0, skills: 0 });
    const idx = await core.loadIndex();
    assert.ok(idx.sources.some((s) => s.id === "new-official") && !idx.sources.some((s) => s.id === "priv"));

    const hits = await core.webSearchSkills("azure");
    assert.ok(Array.isArray(hits));
    const b = await core.installBundle({ bundleId: idx.bundles[0].id, scope: "project", cwd }).catch((e) => e);
    assert.ok(Array.isArray(b));
  } finally {
    delete process.env.SKILL_NINJA_HOME;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("install -> list -> uninstall (live GitHub)", async (t) => {
  const index = await loadIndex();
  const skill = index.skills.find((s) => s.source === "github-awesome-copilot");
  const source = index.sources.find((s) => s.id === skill.source);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sn-"));
  try {
    let first;
    try {
      first = await installSkill({ skill, source, scope: "project", cwd });
    } catch (e) {
      if (e.kind === "rate") return t.skip("GitHub API rate limit");
      throw e;
    }
    assert.equal(first.status, "installed");
    assert.equal((await installSkill({ skill, source, scope: "project", cwd })).status, "exists");
    assert.equal((await listInstalled("project", cwd)).length, 1);
    assert.equal((await uninstallSkill({ name: skill.name, scope: "project", cwd })).status, "removed");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
