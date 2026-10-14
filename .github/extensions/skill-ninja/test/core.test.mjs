import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadIndex, searchSkills, installSkill, uninstallSkill, listInstalled, isSafeName, isSafeRelPath } from "../core/core.mjs";

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
