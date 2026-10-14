// Agent Skills Ninja core: vscode-independent logic (search / index / GitHub fetch / install / scan).
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_INDEX = path.join(HERE, "..", "resources", "skill-index.json");
const PRESET_JA = path.join(HERE, "..", "resources", "ja-descriptions.json");
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

// ---------- shared sources manifest (cross-extension contract with the VS Code Agent Skills Ninja) ----------
const SHARED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHARED_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHARED_BRANCH = /^[A-Za-z0-9._\-/]{1,255}$/;
const SHARED_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
const SHARED_MAX_BYTES = 2 * 1024 * 1024;
const SHARED_MAX_ENTRIES = 500;
const SHARED_UPDATED_BY = "aktsmm.agent-skills-ninja-copilot-app";

export function sharedDir() {
  if (process.env.SKILL_NINJA_SHARED_DIR) return process.env.SKILL_NINJA_SHARED_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "agent-ninja");
  return path.join(os.homedir(), ".agent-ninja");
}

const sharedFile = () => path.join(sharedDir(), "sources.json");
const str = (v, max = 512) => (typeof v === "string" && v.length <= max ? v : undefined);

function sanitizeShared(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!SHARED_ID.test(raw.id ?? "") || !SHARED_URL.test(raw.url ?? "")) return null;
  const out = { id: raw.id, name: str(raw.name) || raw.id, url: raw.url, type: SHARED_TOKEN.test(raw.type ?? "") ? raw.type : "community", description: str(raw.description) ?? "" };
  if (SHARED_BRANCH.test(raw.branch ?? "")) out.branch = raw.branch;
  if (typeof raw.lastIndexedAt === "string" && Number.isFinite(Date.parse(raw.lastIndexedAt))) out.lastIndexedAt = raw.lastIndexedAt;
  for (const k of ["description_ja", "scanner", "lastIndexedBy"]) if (str(raw[k])) out[k] = raw[k];
  if (Number.isInteger(raw.repoId)) out.repoId = raw.repoId;
  for (const k of ["includePaths", "excludePaths"]) {
    if (Array.isArray(raw[k])) out[k] = raw[k].filter((p) => typeof p === "string" && p.length <= 256 && isSafeRelPath(p.replace(/\/$/, ""))).slice(0, 64);
  }
  return out;
}

// The file is untrusted input: size/entry capped, every entry validated, unknown shapes ignored.
export async function readSharedSources() {
  try {
    const st = await fs.stat(sharedFile());
    if (st.size > SHARED_MAX_BYTES) return { exists: true, sources: [] };
    const j = JSON.parse((await fs.readFile(sharedFile(), "utf8")).replace(/^\uFEFF/, ""));
    if (j?.schemaVersion !== 1 || !Array.isArray(j.sources) || j.sources.length > SHARED_MAX_ENTRIES) return { exists: true, sources: [] };
    return { exists: true, raw: j, sources: j.sources.map(sanitizeShared).filter(Boolean) };
  } catch {
    return { exists: false, sources: [] };
  }
}

// Best effort: only touches an existing manifest, skips while another writer holds index.lock, writes atomically.
async function writeShared(mutate) {
  const cur = await readSharedSources();
  if (!cur.exists || !cur.raw) return "skipped";
  if (await fs.stat(path.join(sharedDir(), "index.lock")).then(() => true, () => false)) return "locked";
  const sources = mutate(cur.raw.sources.filter((s) => s && typeof s === "object"));
  if (sources.length > SHARED_MAX_ENTRIES) return "skipped";
  const tmp = path.join(sharedDir(), `sources.json.tmp-${process.pid}`);
  await fs.writeFile(tmp, JSON.stringify({ ...cur.raw, schemaVersion: 1, sources, lastUpdated: new Date().toISOString(), updatedBy: SHARED_UPDATED_BY }, null, 2));
  await fs.rename(tmp, sharedFile());
  return "written";
}

export async function getTheme() {
  const t = (await loadConfig()).theme;
  return THEMES.includes(t) ? t : "auto";
}

export const THEMES = ["auto", "dark", "light", "ninja", "forest", "sakura"];

export async function setTheme(theme) {
  if (!THEMES.includes(theme)) throw new Error("invalid theme");
  await writeJson(CONFIG_PATH, { ...(await loadConfig()), theme });
}

export async function addSource({ id, url, branch, type = "community" }) {
  if (!isSafeName(id)) throw new Error(`Invalid source id: ${id}`);
  parseRepo(url);
  const entry = { id, name: id, url, type, ...(branch ? { branch } : {}), description: "" };
  const cfg = await loadConfig();
  const sources = (cfg.sources ?? []).filter((s) => s.id !== id);
  sources.push(entry);
  await writeJson(CONFIG_PATH, { ...cfg, sources });
  return writeShared((list) => (list.some((s) => s.id === id) ? list : [...list, entry])).catch(() => "skipped");
}

export async function removeSource(id) {
  const cfg = await loadConfig();
  const before = (cfg.sources ?? []).length;
  const sources = (cfg.sources ?? []).filter((s) => s.id !== id);
  await writeJson(CONFIG_PATH, { ...cfg, sources });
  const shared = (await readSharedSources()).sources.some((s) => s.id === id);
  if (shared) await writeShared((list) => list.filter((s) => s.id !== id)).catch(() => {});
  return before !== sources.length || shared;
}

// ---------- index ----------
export async function loadIndex() {
  const index = JSON.parse(await fs.readFile(BUNDLED_INDEX, "utf8"));
  const cfg = await loadConfig();
  const cache = await readJson(CACHE_PATH, { skills: [] });
  const shared = (await readSharedSources()).sources.map((s) => ({ ...s, origin: "shared" }));
  const extraSources = Array.isArray(cfg.sources) ? cfg.sources : [];
  const skills = [...(index.skills ?? [])];
  const seen = new Set(skills.map((s) => `${s.source}/${s.path}`));
  for (const s of cache.skills ?? []) if (!seen.has(`${s.source}/${s.path}`)) skills.push(s);
  const sources = [...(index.sources ?? [])];
  const haveSrc = new Set(sources.map((s) => s.id));
  for (const s of [...(cache.sources ?? []), ...extraSources, ...shared]) if (!haveSrc.has(s.id)) (haveSrc.add(s.id), sources.push(s));
  // Entries without a usable id/URL (e.g. malformed catalog rows) can't be tracked, so drop them.
  const overrides = cfg.overrides ?? {};
  const valid = sources
    .filter((s) => s && isSafeName(s.id ?? "") && /github\.com\/[^/]+\/[^/]+/.test(s.url ?? ""))
    .map((s) => (overrides[s.id] ? { ...s, ...overrides[s.id], overridden: true } : s));
  const localized = cfg.localized ?? {};
  // Bundled Japanese summaries live outside skill-index.json (size limit, survives catalog sync); user-saved ones win.
  const presetJa = await readJson(PRESET_JA, {});
  const merged = skills.map((s) => {
    const key = `${s.source}/${s.name}`;
    const ja = localized[key] || s.description_ja || presetJa[key];
    return ja ? { ...s, description_ja: ja } : s;
  });
  return {
    sources: valid,
    skills: merged,
    bundles: index.bundles ?? [],
    lastUpdated: cache.refreshedAt ?? index.lastUpdated,
  };
}

const UPSTREAM_URL = "https://raw.githubusercontent.com/aktsmm/vscode-agent-skill-ninja/master/resources/skill-index.json";
// Sources intentionally dropped from the preset catalog even if upstream still lists them.
export const EXCLUDED_SOURCES = new Set(["microsoftdocs-agent-skills"]);

// Pull the latest catalog published by the VS Code extension and cache whatever the bundled one lacks.
export async function syncUpstream(fetchImpl = fetch) {
  const res = await fetchImpl(UPSTREAM_URL, { headers: { "User-Agent": "skill-ninja-copilot-app" } });
  if (!res.ok) throw new Error(`upstream catalog ${res.status}`);
  const up = JSON.parse((await res.text()).replace(/^\uFEFF/, ""));
  const index = await loadIndex();
  const cache = await readJson(CACHE_PATH, { skills: [], sources: [] });
  const haveSrc = new Set(index.sources.map((s) => s.id));
  const sources = [];
  for (const s of up.sources ?? []) {
    if (s.type === "user-added" || EXCLUDED_SOURCES.has(s.id) || haveSrc.has(s.id) || !isSafeName(s.id)) continue;
    try {
      parseRepo(s.url);
    } catch {
      continue;
    }
    haveSrc.add(s.id);
    sources.push(s);
  }
  const known = new Set(index.skills.map((s) => `${s.source}/${s.path}`));
  const skills = [];
  for (const s of up.skills ?? []) {
    const k = `${s.source}/${s.path}`;
    if (!haveSrc.has(s.source) || known.has(k) || !isSafeName(s.name) || !isSafeRelPath(s.path)) continue;
    known.add(k);
    skills.push(s);
  }
  await writeJson(CACHE_PATH, {
    ...cache,
    refreshedAt: new Date().toISOString().slice(0, 10),
    sources: [...(cache.sources ?? []), ...sources],
    skills: [...(cache.skills ?? []), ...skills],
  });
  return { sources: sources.length, skills: skills.length };
}

export const STALE_DAYS = 30;
export const MAX_STALE_PER_RUN = 5;

export const readCache = () => readJson(CACHE_PATH, {});

// ---------- source health: ignore / override URL / failure memory ----------
export async function setIgnored(id, on) {
  if (!isSafeName(id)) throw new Error("invalid id");
  const cfg = await loadConfig();
  const set = new Set(cfg.ignored ?? []);
  on ? set.add(id) : set.delete(id);
  await writeJson(CONFIG_PATH, { ...cfg, ignored: [...set] });
}

// Point an existing source (bundled, shared or user-added) at a different repository/branch.
export async function setSourceUrl(id, url, branch) {
  if (!isSafeName(id)) throw new Error("invalid id");
  parseRepo(url);
  if (branch && !SHARED_BRANCH.test(branch)) throw new Error("invalid branch");
  const cfg = await loadConfig();
  const fails = (await readJson(CACHE_PATH, {})).fails ?? {};
  await writeJson(CONFIG_PATH, { ...cfg, overrides: { ...(cfg.overrides ?? {}), [id]: { url, ...(branch ? { branch } : {}) } } });
  if (fails[id]) await clearFailure(id);
}

async function clearFailure(id) {
  const cache = await readJson(CACHE_PATH, { skills: [] });
  if (cache.fails?.[id]) {
    delete cache.fails[id];
    await writeJson(CACHE_PATH, cache);
  }
}

const repoLabel = (s) => {
  try {
    const { owner, repo } = parseRepo(s.url);
    return `${owner}/${repo}`;
  } catch {
    return s.url ?? s.id;
  }
};

// Sources that failed their last scan (and are not muted), with a human-readable reason.
export async function sourceProblems(index = null) {
  index ??= await loadIndex();
  const cache = await readJson(CACHE_PATH, {});
  const ignored = new Set((await loadConfig()).ignored ?? []);
  return index.sources
    .filter((s) => cache.fails?.[s.id] && !ignored.has(s.id))
    .map((s) => ({ id: s.id, name: s.name || s.id, repo: repoLabel(s), url: s.url, ...cache.fails[s.id] }));
}

// Sources whose last scan is older than STALE_DAYS (or unknown), oldest first.
// Muted and failing sources are excluded so the banner can't nag forever; failures surface via sourceProblems().
export async function staleSources(index = null, now = Date.now()) {
  index ??= await loadIndex();
  const cache = await readJson(CACHE_PATH, {});
  const scans = cache.scans ?? {};
  const ignored = new Set((await loadConfig()).ignored ?? []);
  const out = [];
  for (const s of index.sources) {
    if (ignored.has(s.id) || cache.fails?.[s.id]) continue;
    const at = Date.parse(scans[s.id] ?? s.lastIndexedAt ?? "");
    const days = Number.isFinite(at) ? Math.floor((now - at) / 86400000) : null;
    if (days === null || days >= STALE_DAYS) out.push({ id: s.id, name: s.name || s.id, repo: repoLabel(s), days, unknown: days === null });
  }
  return out.sort((a, b) => (b.days ?? 1e9) - (a.days ?? 1e9));
}

// Scan source repos for SKILL.md and cache skills missing from the catalog. `limit` caps sources per run.
// Explicitly requested ids are scanned even if muted/failed (that's the "retry" path).
export async function refreshIndex(sourceIds, { limit } = {}) {
  const index = await loadIndex();
  const known = new Set(index.skills.map((s) => `${s.source}/${s.path}`));
  const cache = await readJson(CACHE_PATH, { skills: [] });
  const scans = { ...(cache.scans ?? {}) };
  const fails = { ...(cache.fails ?? {}) };
  const ignored = new Set((await loadConfig()).ignored ?? []);
  const added = [];
  const errors = [];
  const failed = [];
  let targets = index.sources.filter((s) => (sourceIds?.length ? sourceIds.includes(s.id) : !ignored.has(s.id) && !fails[s.id]));
  if (limit) {
    const order = new Map((await staleSources(index)).map((s, i) => [s.id, i]));
    targets = targets.filter((s) => order.has(s.id)).sort((a, b) => order.get(a.id) - order.get(b.id)).slice(0, limit);
  }
  let scanned = 0;
  for (const source of targets) {
    try {
      const tree = await getTree(source, true);
      for (const e of tree.tree ?? []) {
        if (e.type !== "blob" || !/(^|\/)SKILL\.md$/.test(e.path)) continue;
        const dir = e.path.replace(/\/?SKILL\.md$/, "");
        const name = dir.split("/").pop();
        if (!dir || !isSafeName(name) || known.has(`${source.id}/${dir}`)) continue;
        known.add(`${source.id}/${dir}`);
        added.push({ name, source: source.id, path: dir, categories: [], description: "" });
      }
      scans[source.id] = new Date().toISOString();
      delete fails[source.id];
      scanned++;
    } catch (e) {
      const kind = e.kind ?? "error";
      const info = { id: source.id, name: source.name || source.id, repo: repoLabel(source), kind, message: String(e.message ?? e), ssoUrl: e.ssoUrl };
      failed.push(info);
      errors.push(`${info.repo}: ${info.message}`);
      // A rate limit says nothing about this source, so don't mark it broken; stop, since the rest would fail too.
      if (kind === "rate") break;
      fails[source.id] = { at: new Date().toISOString(), kind, message: info.message, ...(e.ssoUrl ? { ssoUrl: e.ssoUrl } : {}) };
    }
  }
  const skills = [...(cache.skills ?? []), ...added];
  await writeJson(CACHE_PATH, { ...cache, refreshedAt: new Date().toISOString().slice(0, 10), skills, scans, fails });
  return { added: added.length, scanned, errors, failed };
}

// ---------- localization (Japanese summaries supplied by the agent or user) ----------
export async function setLocalized(source, name, text) {
  if (!source || !isSafeName(name) || typeof text !== "string" || !text.trim()) throw new Error("source, name and text are required");
  const cfg = await loadConfig();
  await writeJson(CONFIG_PATH, { ...cfg, localized: { ...(cfg.localized ?? {}), [`${source}/${name}`]: text.trim().slice(0, 400) } });
}

// ---------- bundles ----------
export async function installBundle({ bundleId, scope, cwd, overwrite = false }) {
  const index = await loadIndex();
  const bundle = index.bundles.find((b) => b.id === bundleId);
  if (!bundle) throw new Error(`Bundle not found: ${bundleId}`);
  const src = index.sources.find((s) => s.id === bundle.source);
  if (!src) throw new Error(`Unknown source: ${bundle.source}`);
  const results = [];
  for (const name of bundle.installOrder?.length ? bundle.installOrder : bundle.skills) {
    const skill = findSkill(index, name, bundle.source)[0];
    if (!skill) {
      results.push({ name, status: "missing" });
      continue;
    }
    try {
      results.push({ name, status: (await installSkill({ skill, source: src, scope, cwd, overwrite })).status });
    } catch (e) {
      results.push({ name, status: "error", error: String(e.message ?? e) });
    }
  }
  return results;
}

// ---------- create a new skill scaffold ----------
export async function createSkill({ name, description, scope, cwd }) {
  if (!isSafeName(name)) throw new Error(`Unsafe skill name: ${name}`);
  const dest = path.join(skillsRoot(scope, cwd), name);
  if (await fs.stat(dest).then(() => true, () => false)) return { status: "exists", dest };
  await fs.mkdir(dest, { recursive: true });
  const desc = String(description ?? "").replace(/\r?\n/g, " ").trim() || "TODO: describe what this skill does and when to use it.";
  await fs.writeFile(path.join(dest, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${name}\n\n## When to use\n\n- TODO\n\n## Steps\n\n1. TODO\n`);
  return { status: "created", dest };
}

// ---------- discover new skill repositories on GitHub ----------
export async function webSearchSkills(query) {
  const term = String(query ?? "").trim();
  const run = async (q) => (await (await ghGet(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=10`)).json()).items ?? [];
  let items = await run(`${term} topic:agent-skills`);
  if (items.length < 5) {
    const seen = new Set(items.map((x) => x.id));
    items = [...items, ...(await run(`${term} agent skills SKILL.md in:readme,description`)).filter((x) => !seen.has(x.id))].slice(0, 10);
  }
  return items.map((x) => ({ id: x.name, url: x.html_url, stars: x.stargazers_count, description: x.description ?? "", branch: x.default_branch }));
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

export function searchSkills(index, query, limit = MAX_RESULTS, { source, category, type, offset = 0 } = {}) {
  const typeOf = (id) => index.sources.find((s) => s.id === id)?.type;
  const prio = (id) => SOURCE_PRIORITY[typeOf(id)] ?? 99;
  const keywords = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const scored = index.skills
    .filter((s) => (!source || s.source === source) && (!type || typeOf(s.source) === type) && (!category || (s.categories ?? []).includes(category)))
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
  const typeCount = new Map();
  for (const s of index.skills) {
    const t = index.sources.find((x) => x.id === s.source)?.type;
    if (t) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
  }
  const types = [...typeCount].map(([id, count]) => ({ id, count })).sort((a, b) => (SOURCE_PRIORITY[a.id] ?? 99) - (SOURCE_PRIORITY[b.id] ?? 99));
  return { sources, categories, types };
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

export class GhError extends Error {
  constructor(status, kind, message, extra = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
    Object.assign(this, extra);
  }
}

async function ghGet(url, accept = "application/vnd.github+json") {
  const headers = { Accept: accept, "User-Agent": "skill-ninja-copilot-app", "X-GitHub-Api-Version": "2022-11-28" };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const sso = /url=(\S+)/.exec(res.headers.get("x-github-sso") ?? "")?.[1];
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (sso) throw new GhError(res.status, "sso", "組織の SSO 認可が必要です", { ssoUrl: sso });
    if (res.status === 429 || (res.status === 403 && remaining === "0")) throw new GhError(res.status, "rate", "GitHub のレート制限に達しました。時間をおくか `gh auth login` してください");
    if (res.status === 401) throw new GhError(401, "auth", "認証に失敗しました（`gh auth login` を確認）");
    if (res.status === 404) throw new GhError(404, "notfound", token ? "見つかりません（削除・改名・または非公開でアクセス権なし）" : "見つかりません（非公開の場合は `gh auth login` が必要）");
    if (res.status === 403) throw new GhError(403, "forbidden", "アクセスが拒否されました（権限不足または SSO 未認可）");
    throw new GhError(res.status, "http", `GitHub ${res.status}`);
  }
  return res;
}

export function parseRepo(url) {
  const m = /github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/.exec(url ?? "");
  if (!m) throw new Error(`Unsupported source URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

const branchCache = new Map();
async function defaultBranch(owner, repo) {
  const k = `${owner}/${repo}`;
  if (!branchCache.has(k)) branchCache.set(k, (await (await ghGet(`https://api.github.com/repos/${owner}/${repo}`)).json()).default_branch || "main");
  return branchCache.get(k);
}

const treeCache = new Map();
export async function getTree(source, fresh = false) {
  const { owner, repo } = parseRepo(source.url);
  const branch = source.branch || (await defaultBranch(owner, repo));
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
  state[dest] = { name: skill.name, source: source.id, path: skill.path, sha: files.treeSha, installedAt: new Date().toISOString() };
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
      result.push({ dir: e.name, name: fm.name || e.name, description: fm.description || "", scope, managed: !!rec, source: rec?.source, installedAt: rec?.installedAt });
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
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${skill.path.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent("SKILL.md")}${source.branch ? `?ref=${encodeURIComponent(source.branch)}` : ""}`;
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
