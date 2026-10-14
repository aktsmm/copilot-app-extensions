import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadIndex, searchSkills, getFacets, installSkill, uninstallSkill, listInstalled, isSafeName, isSafeRelPath } from "../core/core.mjs";

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
    assert.match(await (await fetch(`http://127.0.0.1:${ui.port}/?t=${ui.token}`)).text(), /Skill Ninja/);
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

test("install -> list -> uninstall (live GitHub)", async () => {
  const index = await loadIndex();
  const skill = index.skills.find((s) => s.source === "github-awesome-copilot");
  const source = index.sources.find((s) => s.id === skill.source);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sn-"));
  try {
    assert.equal((await installSkill({ skill, source, scope: "project", cwd })).status, "installed");
    assert.equal((await installSkill({ skill, source, scope: "project", cwd })).status, "exists");
    assert.equal((await listInstalled("project", cwd)).length, 1);
    assert.equal((await uninstallSkill({ name: skill.name, scope: "project", cwd })).status, "removed");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
