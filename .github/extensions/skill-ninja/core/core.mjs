// Skill Ninja core: vscode-independent logic (search / index / GitHub fetch / install / scan).
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_INDEX = path.join(HERE, "..", "resources", "skill-index.json");
export const CONFIG_PATH = path.join(os.homedir(), ".copilot", "skill-ninja.json");
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

// ---------- index ----------
export async function loadIndex() {
  const index = JSON.parse(await fs.readFile(BUNDLED_INDEX, "utf8"));
  const cfg = await loadConfig();
  const extraSources = Array.isArray(cfg.sources) ? cfg.sources : [];
  return {
    sources: [...(index.sources ?? []), ...extraSources],
    skills: index.skills ?? [],
    lastUpdated: index.lastUpdated,
  };
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

export function searchSkills(index, query, limit = MAX_RESULTS) {
  const prio = (id) => SOURCE_PRIORITY[index.sources.find((s) => s.id === id)?.type] ?? 99;
  const keywords = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const scored = index.skills
    .map((skill) => ({ skill, score: keywords.length ? score(skill, keywords) : 1 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => prio(a.skill.source) - prio(b.skill.source) || b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return { total: scored.length, items: scored.slice(0, limit).map((x) => x.skill) };
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

export async function fetchSkillFiles(source, skill) {
  if (!isSafeRelPath(skill.path)) throw new Error(`Unsafe skill path: ${skill.path}`);
  const { owner, repo } = parseRepo(source.url);
  const branch = source.branch || "main";
  const tree = await (await ghGet(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)).json();
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
  return { status: "installed", dest, fileCount: files.length };
}

export async function uninstallSkill({ name, scope, cwd }) {
  if (!isSafeName(name)) throw new Error(`Unsafe skill name: ${name}`);
  const dest = path.join(skillsRoot(scope, cwd), name);
  const ok = await fs.stat(path.join(dest, "SKILL.md")).then(() => true, () => false);
  if (!ok) return { status: "not-found", dest };
  await fs.rm(dest, { recursive: true, force: true });
  return { status: "removed", dest };
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

export async function listInstalled(scope, cwd) {
  const root = skillsRoot(scope, cwd);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const fm = parseFrontmatter(await fs.readFile(path.join(root, e.name, "SKILL.md"), "utf8"));
      result.push({ dir: e.name, name: fm.name || e.name, description: fm.description || "", scope });
    } catch {
      // not a skill directory
    }
  }
  return result;
}

// ---------- recommend ----------
const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "have", "your", "are", "you"]);
export function recommendSkills(index, text, installedNames = [], limit = 8) {
  const words = [...new Set(String(text ?? "").toLowerCase().match(/[a-z0-9\u3040-\u30ff\u4e00-\u9fff]{3,}/g) ?? [])].filter((w) => !STOP.has(w)).slice(0, 12);
  const have = new Set(installedNames);
  const { items } = searchSkills(index, words.join(" "), 100);
  return items.filter((s) => !have.has(s.name)).slice(0, limit);
}
