// Skill Ninja core: vscode-independent logic (search / index / GitHub fetch / install / scan).
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_INDEX = path.join(HERE, "..", "resources", "skill-index.json");
const DATA_DIR = process.env.SKILL_NINJA_HOME || path.join(os.homedir(), ".copilot");
export const CONFIG_PATH = path.join(DATA_DIR, "skill-ninja.json");
const STATE_PATH = path.join(DATA_DIR, "skill-ninja-installed.json");
const CACHE_PATH = path.join(DATA_DIR, "skill-ninja-index-cache.json");
const SOURCE_PRIORITY = { official: 0, "awesome-list": 1, community: 2 };
export const MAX_RESULTS = 20;

// ---------- path safety ----------
export function isSafeName(name) {
  return typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

export function isSafeRelPath(p) {
  if (typeof p !== "string" || !p || p.includes("\0") || path.isAbsolute(p)) return false;
  return !p.split(/[\\/]/).some((s) => s === ".." || s === "");
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---------- scopes ----------
export function skillsRoot(scope, cwd = process.cwd()) {
  if (scope === "project") return path.join(cwd, ".github", "skills");
  return path.join(os.homedir(), ".copilot", "skills");
}

// ---------- config ----------
export async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

export async function addSource({ id, url, branch, type = "community" }) {
  if (!isSafeName(id)) throw new Error(`Invalid source id: ${id}`);
  parseRepo(url);
  const cfg = await loadConfig();
  const sources = (cfg.sources ?? []).filter((s) => s.id !== id);
  sources.push({ id, name: id, url, type, ...(branch ? { branch } : {}), description: "" });
  await writeJson(CONFIG_PATH, { ...cfg, sources });
}

export async function removeSource(id) {
  const cfg = await loadConfig();
  const before = (cfg.sources ?? []).length;
  const sources = (cfg.sources ?? []).filter((s) => s.id !== id);
  await writeJson(CONFIG_PATH, { ...cfg, sources });
  return before !== sources.length;
}

// ---------- index ----------
export async function loadIndex() {
  const index = JSON.parse(await fs.readFile(BUNDLED_INDEX, "utf8"));
  const cfg = await loadConfig();
  const cache = await readJson(CACHE_PATH, { skills: [] });
  const extraSources = Array.isArray(cfg.sources) ? cfg.sources : [];
  const skills = [...(index.skills ?? [])];
  const seen = new Set(skills.map((s) => `${s.source}/${s.path}`));
  for (const s of cache.skills ?? []) if (!seen.has(`${s.source}/${s.path}`)) skills.push(s);
  return {
    sources: [...(index.sources ?? []), ...extraSources],
    skills,
    lastUpdated: cache.refreshedAt ?? index.lastUpdated,
  };
}

// Scan source repos for SKILL.md and cache skills missing from the bundled catalog.
export async function refreshIndex(sourceIds) {
  const index = await loadIndex();
  const known = new Set(index.skills.map((s) => `${s.source}/${s.path}`));
  const cache = await readJson(CACHE_PATH, { skills: [] });
  const added = [];
  const errors = [];
  for (const source of index.sources.filter((s) => !sourceIds?.length || sourceIds.includes(s.id))) {
    try {
      const tree = await getTree(source);
      for (const e of tree.tree ?? []) {
        if (e.type !== "blob" || !/(^|\/)SKILL\.md$/.test(e.path)) continue;
        const dir = e.path.replace(/\/?SKILL\.md$/, "");
        const name = dir.split("/").pop();
        if (!dir || !isSafeName(name) || known.has(`${source.id}/${dir}`)) continue;
        known.add(`${source.id}/${dir}`);
        added.push({ name, source: source.id, path: dir, categories: [], description: "" });
      }
    } catch (e) {
      errors.push(`${source.id}: ${e.message}`);
    }
  }
  const skills = [...(cache.skills ?? []), ...added];
  await writeJson(CACHE_PATH, { refreshedAt: new Date().toISOString().slice(0, 10), skills });
  return { added: added.length, errors };
}

// ---------- search ----------
function score(skill, keywords) {
  const name = skill.name.toLowerCase();
  const desc = `${skill.description ?? ""} ${skill.description_ja ?? ""}`.toLowerCase();
  const cats = (skill.categories ?? []).map((c) => c.toLowerCase());
  const src = skill.source.toLowerCase();
  let s = 0;
  for (const k of keywords) {
    if (name === k) s += 100;
    else if (name.startsWith(k)) s += 50;
    else if (name.includes(k)) s += 30;
    if (cats.some((c) => c.includes(k))) s += 20;
    if (desc.includes(k)) s += 10;
    if (src.includes(k)) s += 5;
  }
  return s;
}

export function searchSkills(index, query, limit = MAX_RESULTS, { source, category, offset = 0 } = {}) {
  const prio = (id) => SOURCE_PRIORITY[index.sources.find((s) => s.id === id)?.type] ?? 99;
  const keywords = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const scored = index.skills
    .filter((s) => (!source || s.source === source) && (!category || (s.categories ?? []).includes(category)))
    .map((skill) => ({ skill, score: keywords.length ? score(skill, keywords) : 1 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => prio(a.skill.source) - prio(b.skill.source) || b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return { total: scored.length, items: scored.slice(offset, offset + limit).map((x) => x.skill) };
}

export function getFacets(index) {
  const src = new Map();
  const cat = new Map();
  for (const s of index.skills) {
    src.set(s.source, (src.get(s.source) ?? 0) + 1);
    for (const c of s.categories ?? []) cat.set(c, (cat.get(c) ?? 0) + 1);
  }
  const sources = [...src].map(([id, count]) => ({ id, count, name: index.sources.find((x) => x.id === id)?.name ?? id }))
    .sort((a, b) => b.count - a.count);
  const categories = [...cat].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count).slice(0, 30);
  return { sources, categories };
}

export function findSkill(index, name, source) {
  return index.skills.filter((s) => s.name === name && (!source || s.source === source));
}

// ---------- GitHub ----------
let tokenCache;
export async function getToken() {
  if (tokenCache !== undefined) return tokenCache;
  if (process.env.GITHUB_TOKEN) return (tokenCache = process.env.GITHUB_TOKEN);
  tokenCache = await new Promise((resolve) =>
    execFile("gh", ["auth", "token"], { timeout: 10000, windowsHide: true }, (err, out) => resolve(err ? "" : out.trim())),
  );
  return tokenCache;
}

async function ghGet(url, accept = "application/vnd.github+json") {
  const headers = { Accept: accept, "User-Agent": "skill-ninja-copilot-app", "X-GitHub-Api-Version": "2022-11-28" };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? " (rate limited? set GITHUB_TOKEN or run `gh auth login`)" : "";
    throw new Error(`GitHub ${res.status} for ${url}${hint}`);
  }
  return res;
}

export function parseRepo(url) {
  const m = /github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/.exec(url ?? "");
  if (!m) throw new Error(`Unsupported source URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

const treeCache = new Map();
export async function getTree(source, fresh = false) {
  const { owner, repo } = parseRepo(source.url);
  const branch = source.branch || "main";
  const key = `${owner}/${repo}@${branch}`;
  const hit = treeCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 60000) return hit.tree;
  const tree = await (await ghGet(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)).json();
  treeCache.set(key, { at: Date.now(), tree });
  return tree;
}

export async function fetchSkillFiles(source, skill) {
  if (!isSafeRelPath(skill.path)) throw new Error(`Unsafe skill path: ${skill.path}`);
  const { owner, repo } = parseRepo(source.url);
  const tree = await getTree(source, true);
  const prefix = `${skill.path}/`;
  const blobs = (tree.tree ?? []).filter((e) => e.type === "blob" && e.path.startsWith(prefix));
  if (!blobs.some((b) => b.path === `${prefix}SKILL.md`)) throw new Error(`SKILL.md not found at ${skill.path}`);
  if (blobs.length > 200) throw new Error(`Too many files (${blobs.length}) in ${skill.path}`);
  const files = [];
  for (const b of blobs) {
    const rel = b.path.slice(prefix.length);
    if (!isSafeRelPath(rel)) continue;
    const res = await ghGet(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${b.sha}`, "application/vnd.github.raw+json");
    files.push({ rel, data: Buffer.from(await res.arrayBuffer()) });
  }
  files.treeSha = (tree.tree ?? []).find((e) => e.type === "tree" && e.path === skill.path)?.sha ?? null;
  return files;
}

// ---------- install / uninstall / scan ----------
export async function installSkill({ skill, source, scope, cwd, overwrite }) {
  if (!isSafeName(skill.name)) throw new Error(`Unsafe skill name: ${skill.name}`);
  const root = skillsRoot(scope, cwd);
  const dest = path.join(root, skill.name);
  const exists = await fs.stat(dest).then(() => true, () => false);
  if (exists && !overwrite) return { status: "exists", dest };
  const files = await fetchSkillFiles(source, skill);
  const tmp = `${dest}.tmp-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  for (const f of files) {
    const target = path.join(tmp, f.rel);
    if (!isInside(tmp, target)) throw new Error(`Path escape: ${f.rel}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.data);
  }
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.rename(tmp, dest);
  const state = await readJson(STATE_PATH, {});
  state[dest] = { name: skill.name, source: source.id, path: skill.path, sha: files.treeSha };
  await writeJson(STATE_PATH, state);
  return { status: "installed", dest, fileCount: files.length };
}

// Compare recorded tree SHAs of installed skills with the current remote state.
export async function checkUpdates(index, cwd) {
  const state = await readJson(STATE_PATH, {});
  const out = [];
  for (const scope of ["user", "project"]) {
    for (const s of await listInstalled(scope, cwd)) {
      const dest = path.join(skillsRoot(scope, cwd), s.dir);
      const rec = state[dest];
      if (!rec?.sha) continue;
      const source = index.sources.find((x) => x.id === rec.source);
      if (!source) continue;
      try {
        const tree = await getTree(source);
        const cur = (tree.tree ?? []).find((e) => e.type === "tree" && e.path === rec.path)?.sha;
        if (cur && cur !== rec.sha) out.push({ name: s.dir, scope, source: rec.source });
      } catch {
        // skip unreachable sources
      }
    }
  }
  return out;
}

export async function uninstallSkill({ name, scope, cwd }) {
  if (!isSafeName(name)) throw new Error(`Unsafe skill name: ${name}`);
  const dest = path.join(skillsRoot(scope, cwd), name);
  const ok = await fs.stat(path.join(dest, "SKILL.md")).then(() => true, () => false);
  if (!ok) return { status: "not-found", dest };
  await fs.rm(dest, { recursive: true, force: true });
  const state = await readJson(STATE_PATH, {});
  if (state[dest]) {
    delete state[dest];
    await writeJson(STATE_PATH, state);
  }
  return { status: "removed", dest };
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(" ");
    }
    out[kv[1]] = v.replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

export async function listInstalled(scope, cwd) {
  const root = skillsRoot(scope, cwd);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const state = await readJson(STATE_PATH, {});
  const result = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const fm = parseFrontmatter(await fs.readFile(path.join(root, e.name, "SKILL.md"), "utf8"));
      const rec = state[path.join(root, e.name)];
      result.push({ dir: e.name, name: fm.name || e.name, description: fm.description || "", scope, managed: !!rec, source: rec?.source });
    } catch {
      // not a skill directory
    }
  }
  return result;
}

// ---------- preview / description ----------
const mdCache = new Map();
export async function fetchSkillMd(source, skill) {
  if (!isSafeRelPath(skill.path)) throw new Error(`Unsafe skill path: ${skill.path}`);
  const k = `${source.id}/${skill.path}`;
  if (mdCache.has(k)) return mdCache.get(k);
  const { owner, repo } = parseRepo(source.url);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${skill.path.split("/").map(encodeURIComponent).join("/")}/SKILL.md?ref=${encodeURIComponent(source.branch || "main")}`;
  const text = await (await ghGet(url, "application/vnd.github.raw+json")).text();
  mdCache.set(k, text);
  return text;
}

// Fill in a missing description from SKILL.md and persist it in the index cache.
export async function describeSkill(index, skill) {
  if (skill.description) return skill.description;
  const source = index.sources.find((s) => s.id === skill.source);
  if (!source) return "";
  const desc = parseFrontmatter(await fetchSkillMd(source, skill)).description ?? "";
  const cache = await readJson(CACHE_PATH, { skills: [] });
  const hit = (cache.skills ?? []).find((s) => s.source === skill.source && s.path === skill.path);
  if (hit && desc) {
    hit.description = desc;
    await writeJson(CACHE_PATH, cache);
  }
  return desc;
}

// ---------- favorites ----------
export async function getFavorites() {
  return (await loadConfig()).favorites ?? [];
}

export async function toggleFavorite(key) {
  return toggleListed("favorites", key);
}

// ---------- pins (shown first in lists) ----------
export async function getPins() {
  return (await loadConfig()).pins ?? [];
}

export async function togglePin(key) {
  return toggleListed("pins", key);
}

async function toggleListed(field, key) {
  if (typeof key !== "string" || !key) throw new Error("invalid key");
  const cfg = await loadConfig();
  const set = new Set(cfg[field] ?? []);
  const on = !set.delete(key) && set.add(key).has(key);
  await writeJson(CONFIG_PATH, { ...cfg, [field]: [...set] });
  return on;
}

// ---------- import from the VS Code "Agent Skills Ninja" extension ----------
export function vscodeIndexCandidates() {
  const appData = process.env.APPDATA || path.join(os.homedir(), ".config");
  const mac = path.join(os.homedir(), "Library", "Application Support");
  const bases = process.platform === "darwin" ? [mac] : [appData];
  const out = [];
  for (const b of bases) {
    for (const app of ["Code", "Code - Insiders"]) {
      out.push(path.join(b, app, "User", "globalStorage", "yamapan.agent-skill-ninja", "skill-index.json"));
    }
  }
  out.push(path.join(os.homedir(), ".skill-ninja", "skill-index.json"));
  return out;
}

export async function importFromVsCode(files = vscodeIndexCandidates()) {
  const bundled = JSON.parse(await fs.readFile(BUNDLED_INDEX, "utf8"));
  const cfg = await loadConfig();
  const knownSources = new Set([...(bundled.sources ?? []), ...(cfg.sources ?? [])].map((s) => s.id));
  const cache = await readJson(CACHE_PATH, { skills: [] });
  const knownSkills = new Set([...(bundled.skills ?? []), ...(cache.skills ?? [])].map((s) => `${s.source}/${s.path}`));
  const addedSources = [];
  const addedSkills = [];
  const used = [];
  for (const file of files) {
    const idx = await readJson(file, null);
    if (!idx || !Array.isArray(idx.sources)) continue;
    used.push(file);
    for (const s of idx.sources) {
      if (!s?.id || !isSafeName(s.id) || knownSources.has(s.id)) continue;
      try {
        parseRepo(s.url);
      } catch {
        continue;
      }
      knownSources.add(s.id);
      addedSources.push({ id: s.id, name: s.name || s.id, url: s.url, type: s.type || "community", ...(s.branch ? { branch: s.branch } : {}), description: s.description || "" });
    }
    for (const sk of idx.skills ?? []) {
      const k = `${sk.source}/${sk.path}`;
      if (!sk?.name || !isSafeName(sk.name) || !isSafeRelPath(sk.path) || !knownSources.has(sk.source) || knownSkills.has(k)) continue;
      knownSkills.add(k);
      addedSkills.push({ name: sk.name, source: sk.source, path: sk.path, categories: sk.categories ?? [], description: sk.description ?? "", description_ja: sk.description_ja ?? "" });
    }
  }
  if (addedSources.length) await writeJson(CONFIG_PATH, { ...cfg, sources: [...(cfg.sources ?? []), ...addedSources] });
  if (addedSkills.length) await writeJson(CACHE_PATH, { ...cache, refreshedAt: cache.refreshedAt ?? new Date().toISOString().slice(0, 10), skills: [...(cache.skills ?? []), ...addedSkills] });
  return { files: used, sources: addedSources.map((s) => s.id), skills: addedSkills.length };
}

// ---------- project-aware recommendation context ----------
export async function projectContext(cwd) {
  const parts = [];
  const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
  parts.push(...entries.map((e) => e.name.replace(/\.[^.]+$/, "")));
  const pkg = await readJson(path.join(cwd, "package.json"), null);
  if (pkg) parts.push(...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 40), pkg.name ?? "", pkg.description ?? "");
  const exts = new Set(entries.map((e) => path.extname(e.name).slice(1)).filter(Boolean));
  parts.push(...exts);
  const readme = await fs.readFile(path.join(cwd, "README.md"), "utf8").catch(() => "");
  parts.push(readme.slice(0, 600));
  return parts.join(" ");
}

// ---------- recommend ----------
const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "have", "your", "are", "you"]);
export function recommendSkills(index, text, installedNames = [], limit = 8) {
  const words = [...new Set(String(text ?? "").toLowerCase().match(/[a-z0-9\u3040-\u30ff\u4e00-\u9fff]{3,}/g) ?? [])].filter((w) => !STOP.has(w)).slice(0, 12);
  const have = new Set(installedNames);
  const { items } = searchSkills(index, words.join(" "), 100);
  return items.filter((s) => !have.has(s.name)).slice(0, limit);
}
