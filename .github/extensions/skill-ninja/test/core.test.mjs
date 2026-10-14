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
