// Core logic for Agent Canvas Ninja: catalog, GitHub access, review, install. No UI / SDK dependencies.
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeFiles, metaOfExtension, RISK_NOTE } from "./review.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_CATALOG = path.join(HERE, "..", "resources", "catalog.json");
const COPILOT_HOME = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const DATA_DIR = process.env.CANVAS_NINJA_HOME || COPILOT_HOME;
const USER_EXT_ROOT = process.env.CANVAS_NINJA_EXT_ROOT || path.join(COPILOT_HOME, "extensions");
const CONFIG_PATH = path.join(DATA_DIR, "canvas-ninja.json");
const CACHE_PATH = path.join(DATA_DIR, "canvas-ninja-index-cache.json");
const STATE_PATH = path.join(DATA_DIR, "canvas-ninja-installed.json");

export const STALE_DAYS = 30;
export const MAX_STALE_PER_RUN = 5;
const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_PER_SOURCE = 80;

export const BUNDLED_SOURCES = [
  { id: "awesome-copilot", url: "https://github.com/github/awesome-copilot", scanPath: "extensions", externalList: "extensions/external.json", type: "official", bundled: true },
  { id: "aktsmm", url: "https://github.com/aktsmm/copilot-app-extensions", scanPath: ".github/extensions", type: "community", bundled: true },
  { id: "awesome-copilot-plugins", url: "https://github.com/github/awesome-copilot", marketplaceFile: ".github/plugin/marketplace.json", marketplaceName: "awesome-copilot", type: "official", bundled: true },
];

// ---------- validation ----------
export const isSafeName = (n) => typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n) && !n.includes("..");
export function isSafeRelPath(p) {
  if (typeof p !== "string" || !p || p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((s) => s && s !== "." && s !== "..");
}
export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function extensionsRoot(scope, cwd = process.cwd()) {
  if (scope === "project") return path.join(cwd, ".github", "extensions");
  return USER_EXT_ROOT;
}

// ---------- json state ----------
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
// All read-modify-write cycles on a state file are serialized; temp names are unique per write.
const locks = new Map();
function withLock(file, fn) {
  const prev = locks.get(file) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(file, next);
  next.finally(() => locks.get(file) === next && locks.delete(file)).catch(() => {});
  return next;
}
async function writeJsonRaw(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}
const writeJson = (file, data) => withLock(file, () => writeJsonRaw(file, data));
const updateJson = (file, fallback, fn) =>
  withLock(file, async () => {
    const data = await readJson(file, fallback);
    const r = await fn(data);
    await writeJsonRaw(file, data);
    return r;
  });
export async function loadConfig() {
  const c = await readJson(CONFIG_PATH, {});
  return { sources: [], favorites: [], pins: [], overrides: {}, ignored: [], failures: {}, ja: {}, customBundles: [], ...c };
}
const mutateConfig = (fn) => updateJson(CONFIG_PATH, {}, async (raw) => {
  const c = { sources: [], favorites: [], pins: [], overrides: {}, ignored: [], failures: {}, ja: {}, customBundles: [], ...raw };
  const r = await fn(c);
  for (const k of Object.keys(raw)) delete raw[k];
  Object.assign(raw, c);
  return r;
});
export const readCache = () => readJson(CACHE_PATH, { sources: {} });

export const getTheme = async () => (await loadConfig()).theme || "auto";
export const setTheme = (theme) => mutateConfig((c) => void (c.theme = theme));
export const getLang = async () => (await loadConfig()).lang || "";
export const setLang = (lang) => mutateConfig((c) => void (c.lang = lang === "en" ? "en" : "ja"));
export async function loadBundles() {
  const [base, cfg] = await Promise.all([readJson(path.join(HERE, "..", "resources", "bundles.json"), { bundles: [] }), loadConfig()]);
  return { bundles: [...(base.bundles ?? []), ...cfg.customBundles.map((b) => ({ ...b, custom: true }))] };
}

export async function addToBundle({ key, bundleId, name }) {
  if (typeof key !== "string" || !key) throw new Error("key required");
  return mutateConfig((c) => {
    let b = bundleId ? c.customBundles.find((x) => x.id === bundleId) : null;
    if (!b) {
      const nm = String(name ?? "").trim().slice(0, 60);
      if (!nm) throw new Error("name required");
      if (c.customBundles.length >= 20) throw new Error("too many sets");
      b = { id: `my-${crypto.randomBytes(4).toString("hex")}`, icon: "⭐", name: { ja: nm, en: nm }, description: { ja: "自分で作ったセット", en: "My own set" }, items: [], prereq: [] };
      c.customBundles.push(b);
    }
    if (b.items.length >= 40) throw new Error("too many items");
    if (!b.items.includes(key)) b.items.push(key);
    return { id: b.id, count: b.items.length };
  });
}
export const removeFromBundle = ({ bundleId, key }) =>
  mutateConfig((c) => {
    const b = c.customBundles.find((x) => x.id === bundleId);
    if (!b) return false;
    b.items = b.items.filter((k) => k !== key);
    if (!b.items.length) c.customBundles = c.customBundles.filter((x) => x !== b);
    return true;
  });
export const deleteBundle = (id) =>
  mutateConfig((c) => {
    const n = c.customBundles.length;
    c.customBundles = c.customBundles.filter((x) => x.id !== id);
    return c.customBundles.length < n;
  });
export async function toggleListed(field, key) {
  return mutateConfig((c) => {
    const set = new Set(c[field]);
    const on = !set.has(key);
    on ? set.add(key) : set.delete(key);
    c[field] = [...set];
    return { on };
  });
}
export const setLocalized = (key, text) => mutateConfig((c) => void (c.ja[key] = String(text).trim().slice(0, 300)));

// ---------- GitHub ----------
let fetchImpl = (...a) => globalThis.fetch(...a);
export const __setFetch = (f) => ((fetchImpl = f), blobCache.clear(), ssoOwners.clear());

let tokenCache;
export async function getToken() {
  if (tokenCache !== undefined) return tokenCache;
  if (process.env.GITHUB_TOKEN) return (tokenCache = process.env.GITHUB_TOKEN);
  tokenCache = await new Promise((resolve) =>
    execFile("gh", ["auth", "token"], { timeout: 10000, windowsHide: true }, (err, out) => resolve(err ? "" : out.trim())),
  );
  return tokenCache;
}
export const __resetToken = () => (tokenCache = undefined);

export class GhError extends Error {
  constructor(status, kind, message, extra = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// Owners whose org enforces SSO for our token: go anonymous directly instead of burning two requests each time.
const ssoOwners = new Set();
async function ghGet(url, accept = "application/vnd.github+json", anon = false) {
  const owner = /\/repos\/([^/]+)\//.exec(url)?.[1]?.toLowerCase();
  if (owner && ssoOwners.has(owner)) anon = true;
  const headers = { Accept: accept, "User-Agent": "canvas-ninja-copilot-app", "X-GitHub-Api-Version": "2022-11-28" };
  const token = anon ? "" : await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    throw new GhError(0, "network", `ネットワークエラー: ${e.name === "TimeoutError" ? "タイムアウト" : (e.message ?? e)}`);
  }
  if (res.ok) return res;
  const sso = /url=(\S+)/.exec(res.headers.get("x-github-sso") ?? "")?.[1];
  const remaining = res.headers.get("x-ratelimit-remaining");
  // A token that is SSO-blocked (or invalid) must not break public repositories: retry anonymously once.
  if (token && (sso || res.status === 401 || (res.status === 403 && remaining !== "0"))) {
    try {
      const r = await ghGet(url, accept, true);
      if (sso && owner) ssoOwners.add(owner);
      return r;
    } catch (e) {
      if (e.kind === "notfound") throw new GhError(403, sso ? "sso" : "forbidden", sso ? "組織の SSO 認可が必要です" : "アクセスが拒否されました", { ssoUrl: sso });
      throw e;
    }
  }
  if (sso) throw new GhError(res.status, "sso", "組織の SSO 認可が必要です", { ssoUrl: sso });
  if (res.status === 429 || (res.status === 403 && remaining === "0")) throw new GhError(res.status, "rate", "GitHub のレート制限に達しました。時間をおくか `gh auth login` してください");
  if (res.status === 401) throw new GhError(401, "auth", "認証に失敗しました（`gh auth login` を確認）");
  if (res.status === 404) throw new GhError(404, "notfound", token ? "見つかりません（削除・改名・または非公開でアクセス権なし）" : "見つかりません（非公開の場合は `gh auth login` が必要）");
  if (res.status === 403) throw new GhError(403, "forbidden", "アクセスが拒否されました（権限不足または SSO 未認可）");
  throw new GhError(res.status, "http", `GitHub ${res.status}`);
}
const ghJson = async (url) => (await ghGet(url)).json();
const API = "https://api.github.com";

export function parseGithubUrl(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(String(url ?? "").trim());
  if (!m) throw new Error(`GitHub のリポジトリまたはフォルダ URL ではありません: ${url}`);
  const sub = m[4]?.replace(/\/extension\.mjs$/, "");
  if (sub && !isSafeRelPath(sub)) throw new Error("不正なパスです");
  return { owner: m[1], repo: m[2], ref: m[3], path: sub };
}

const repoInfoCache = new Map();
async function repoInfo(repo) {
  if (!repoInfoCache.has(repo)) repoInfoCache.set(repo, await ghJson(`${API}/repos/${repo}`));
  return repoInfoCache.get(repo);
}
async function resolveCommit(repo, ref) {
  const branch = ref || (await repoInfo(repo)).default_branch || "main";
  const res = await ghGet(`${API}/repos/${repo}/commits/${encodeURIComponent(branch)}`, "application/vnd.github.sha");
  return { branch, commit: (await res.text()).trim() };
}
const treeCache = new Map();
async function getTree(repo, commit) {
  const k = `${repo}@${commit}`;
  if (!treeCache.has(k)) {
    const t = await ghJson(`${API}/repos/${repo}/git/trees/${commit}?recursive=1`);
    if (t.truncated) throw new GhError(0, "toolarge", "リポジトリが大きすぎてファイル一覧を取得できません");
    treeCache.set(k, t);
    if (treeCache.size > 30) treeCache.delete(treeCache.keys().next().value);
  }
  return treeCache.get(k);
}
// Blob contents are immutable per sha: cache them. raw.githubusercontent.com does not count against the API rate limit.
const blobCache = new Map();
async function blobRaw(repo, sha, hint) {
  const ck = `${repo}@${sha}`;
  if (blobCache.has(ck)) return blobCache.get(ck);
  let buf;
  if (hint?.commit && hint?.path) {
    try {
      const r = await fetchImpl(`https://raw.githubusercontent.com/${repo}/${hint.commit}/${hint.path.split("/").map(encodeURIComponent).join("/")}`, { headers: { "User-Agent": "canvas-ninja-copilot-app" }, signal: AbortSignal.timeout(25000) });
      if (r.ok) buf = Buffer.from(await r.arrayBuffer());
    } catch {}
  }
  buf ??= Buffer.from(await (await ghGet(`${API}/repos/${repo}/git/blobs/${sha}`, "application/vnd.github.raw+json")).arrayBuffer());
  if (buf.length < 1024 * 1024) {
    blobCache.set(ck, buf);
    if (blobCache.size > 400) blobCache.delete(blobCache.keys().next().value);
  }
  return buf;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

// ---------- catalog ----------
const keyOf = (e) => `${e.repo}:${e.path || "."}`;
const shortName = (repo, p) => (p ? p.split("/").pop() : repo.split("/")[1]);

export async function scanRepo({ repo, branch, scanPath }) {
  const { commit } = await resolveCommit(repo, branch);
  const tree = await getTree(repo, commit);
  const info = await repoInfo(repo);
  const prefix = scanPath ? `${scanPath.replace(/\/+$/, "")}/` : "";
  const dirs = [];
  const direct = scanPath ? (tree.tree ?? []).find((e) => e.type === "blob" && e.path === `${scanPath.replace(/\/+$/, "")}/extension.mjs`) : null;
  if (direct) dirs.push({ dir: scanPath.replace(/\/+$/, ""), sha: direct.sha });
  else {
    for (const e of tree.tree ?? []) {
      if (e.type !== "blob" || (e.path !== "extension.mjs" && !e.path.endsWith("/extension.mjs"))) continue;
      if (e.path.includes("node_modules/")) continue;
      const dir = e.path === "extension.mjs" ? "" : e.path.slice(0, -"/extension.mjs".length);
      if (prefix) {
        if (!dir.startsWith(prefix) || dir.slice(prefix.length).includes("/")) continue;
      } else if (dir && !/^(?:\.github\/extensions\/|extensions\/)?[^/]+$/.test(dir)) continue;
      dirs.push({ dir, sha: e.sha });
    }
  }
  const entries = await pool(dirs.slice(0, MAX_SCAN_PER_SOURCE), 6, async ({ dir, sha }) => {
    let meta = {};
    try {
      meta = metaOfExtension((await blobRaw(repo, sha, { commit, path: dir ? `${dir}/extension.mjs` : "extension.mjs" })).toString("utf8"));
    } catch (e) {
      if (e.kind === "rate") throw e;
    }
    const name = shortName(repo, dir);
    return {
      key: `${repo}:${dir || "."}`,
      name,
      repo,
      path: dir,
      displayName: meta.displayName || name,
      description: meta.description || (dir ? "" : info.description || ""),
      canvasIds: meta.canvasIds ?? [],
      toolCount: meta.toolCount ?? 0,
      stars: info.stargazers_count ?? 0,
      updatedAt: info.pushed_at,
      author: info.owner?.login,
    };
  });
  return { entries, skipped: Math.max(0, dirs.length - MAX_SCAN_PER_SOURCE) };
}

async function readExternalList(source) {
  const repo = parseGithubUrl(source.url);
  const r = await ghGet(`${API}/repos/${repo.owner}/${repo.repo}/contents/${source.externalList}`, "application/vnd.github.raw+json");
  const list = JSON.parse(await r.text());
  return Array.isArray(list) ? list : [];
}

async function loadBundled() {
  return readJson(BUNDLED_CATALOG, { generatedAt: null, extensions: [] });
}

export async function allSources() {
  const c = await loadConfig();
  const list = [...BUNDLED_SOURCES, ...c.sources.map((s) => ({ ...s, type: s.type || "community", bundled: false }))];
  return list.map((s) => ({ ...s, ...(c.overrides[s.id] ?? {}), ignored: c.ignored.includes(s.id) }));
}

export async function loadIndex() {
  const [bundled, cache, sources, bundledJa] = await Promise.all([loadBundled(), readCache(), allSources(), readJson(path.join(HERE, "..", "resources", "catalog-ja.json"), {})]);
  const byKey = new Map();
  for (const e of bundled.extensions ?? []) byKey.set(e.key, e);
  for (const [sid, c] of Object.entries(cache.sources ?? {})) {
    for (const [k, e] of byKey) if (e.source === sid) byKey.delete(k);
    for (const e of c.entries ?? []) byKey.set(e.key, { ...e, source: sid });
  }
  const c = await loadConfig();
  const ignored = new Set(c.ignored);
  const extensions = [...byKey.values()].filter((e) => !ignored.has(e.source)).map((e) => ({ kind: "extension", ...e, description_ja: bundledJa[e.key], official: isOfficialRepo(e.repo) }));
  return { sources, extensions, generatedAt: bundled.generatedAt, cache };
}

function score(e, kws) {
  const hay = {
    name: `${e.name} ${e.displayName}`.toLowerCase(),
    ids: (e.canvasIds ?? []).join(" ").toLowerCase(),
    desc: `${e.description ?? ""} ${e.description_ja ?? ""}`.toLowerCase(),
    other: `${e.repo} ${e.author ?? ""} ${(e.keywords ?? []).join(" ")}`.toLowerCase(),
  };
  let s = 0;
  for (const k of kws) {
    let hit = false;
    if (hay.name.includes(k)) (s += hay.name.split(/[\s_-]+/).includes(k) ? 10 : 6), (hit = true);
    if (hay.ids.includes(k)) (s += 4), (hit = true);
    if (hay.desc.includes(k)) (s += 3), (hit = true);
    if (hay.other.includes(k)) (s += 2), (hit = true);
    if (!hit) return 0;
  }
  return s;
}

export function searchExtensions(index, query, { source, limit = 24, offset = 0, ja = {}, official = false, kind } = {}) {
  const kws = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  let list = index.extensions.map((e) => ({ ...e, description_ja: ja[e.key] ?? e.description_ja }));
  if (source) list = list.filter((e) => e.source === source);
  if (official) list = list.filter((e) => e.official);
  if (kind === "plugin") list = list.filter((e) => e.kind === "plugin");
  else if (kind === "canvas") list = list.filter((e) => e.kind !== "plugin" || e.hasCanvas);
  let rows = kws.length ? list.map((e) => [e, score(e, kws)]).filter(([, s]) => s > 0) : list.map((e) => [e, 0]);
  rows.sort((a, b) => b[1] - a[1] || (b[0].official ? 1 : 0) - (a[0].official ? 1 : 0) || (b[0].stars ?? 0) - (a[0].stars ?? 0) || a[0].name.localeCompare(b[0].name));
  return { total: rows.length, items: rows.slice(offset, offset + limit).map(([e]) => e) };
}

export function findExtension(index, nameOrKey, source) {
  const q = String(nameOrKey).toLowerCase();
  return index.extensions.filter((e) => (e.key.toLowerCase() === q || e.name.toLowerCase() === q) && (!source || e.source === source));
}

export function getFacets(index) {
  const sources = {};
  for (const e of index.extensions) sources[e.source] = (sources[e.source] ?? 0) + 1;
  return { sources };
}

// ---------- source failures / refresh ----------
async function recordFailure(id, err) {
  await mutateConfig((c) => void (c.failures[id] = { kind: err.kind ?? "http", message: String(err.message ?? err), ssoUrl: err.ssoUrl, at: new Date().toISOString() }));
}
const clearFailure = (id) => mutateConfig((c) => void delete c.failures[id]);

export async function sourceProblems() {
  const c = await loadConfig();
  const sources = await allSources();
  return Object.entries(c.failures)
    .filter(([id]) => !c.ignored.includes(id))
    .map(([id, f]) => {
      const s = sources.find((x) => x.id === id);
      return { id, repo: s ? repoLabel(s.url) : id, ...f };
    });
}
const repoLabel = (url) => {
  try {
    const p = parseGithubUrl(url);
    return `${p.owner}/${p.repo}`;
  } catch {
    return url;
  }
};

export const setIgnored = (id, on) =>
  mutateConfig((c) => {
    const set = new Set(c.ignored);
    on ? set.add(id) : set.delete(id);
    c.ignored = [...set];
    if (on) delete c.failures[id];
  });

export async function setSourceUrl(id, url, branch) {
  const p = parseGithubUrl(url);
  await mutateConfig((c) => {
    c.overrides[id] = { url: `https://github.com/${p.owner}/${p.repo}`, ...(branch || p.ref ? { branch: branch || p.ref } : {}) };
    delete c.failures[id];
    c.ignored = c.ignored.filter((x) => x !== id);
  });
}

export async function addSource({ id, url, branch, scanPath }) {
  const p = parseGithubUrl(url);
  const sid = id || `${p.owner}-${p.repo}`;
  if (!SOURCE_ID.test(sid)) throw new Error("ソース ID は英数字・._- のみ（64 文字まで）");
  const sources = await allSources();
  if (sources.some((s) => s.id === sid)) throw new Error(`ソース '${sid}' は既に存在します`);
  const dup = sources.find((s) => repoLabel(s.url).toLowerCase() === `${p.owner}/${p.repo}`.toLowerCase() && (s.scanPath || "") === (scanPath ?? p.path ?? ""));
  if (dup) throw new Error(`同じリポジトリが既にソース '${dup.id}' として登録されています`);
  await mutateConfig((c) => {
    c.sources.push({ id: sid, url: `https://github.com/${p.owner}/${p.repo}`, ...(branch || p.ref ? { branch: branch || p.ref } : {}), ...(scanPath ?? p.path ? { scanPath: scanPath ?? p.path } : {}), type: "community" });
  });
  return sid;
}

export async function removeSource(id) {
  return mutateConfig((c) => {
    const n = c.sources.length;
    c.sources = c.sources.filter((s) => s.id !== id);
    delete c.failures[id];
    return c.sources.length < n;
  });
}

export async function staleSources(index = null, now = Date.now()) {
  const idx = index ?? (await loadIndex());
  const c = await loadConfig();
  const bundledAt = idx.generatedAt ? Date.parse(idx.generatedAt) : 0;
  return idx.sources
    .filter((s) => !s.ignored && !c.failures[s.id])
    .map((s) => ({ s, at: Date.parse(idx.cache.sources?.[s.id]?.scannedAt ?? "") || (s.bundled ? bundledAt : 0) }))
    .filter(({ at }) => now - at > STALE_DAYS * 86400000)
    .sort((a, b) => a.at - b.at)
    .map(({ s }) => s.id);
}

export async function refreshIndex(sourceIds, { limit } = {}) {
  const sources = (await allSources()).filter((s) => !s.ignored && (!sourceIds?.length || sourceIds.includes(s.id)));
  const targets = limit ? sources.slice(0, limit) : sources;
  const fresh = {};
  const prevCache = await readCache();
  const errors = [];
  let scanned = 0;
  let added = 0;
  for (const s of targets) {
    try {
      let all;
      if (s.marketplaceFile) {
        const r = await scanMarketplace(s);
        all = r.entries;
        errors.push(...r.errors.map((m) => `${s.id}: ${m}`));
      } else {
        const p = parseGithubUrl(s.url);
        const repo = `${p.owner}/${p.repo}`;
        const { entries } = await scanRepo({ repo, branch: s.branch, scanPath: s.scanPath });
        all = entries.map((e) => ({ ...e, source: s.id }));
      }
      if (s.externalList) {
        try {
          const ext = (await readExternalList(s)).filter((x) => typeof x?.installUrl === "string");
          const found = await pool(ext.slice(0, 40), 3, async (x) => {
            try {
              const u = parseGithubUrl(x.installUrl);
              const r = await scanRepo({ repo: `${u.owner}/${u.repo}`, branch: u.ref, scanPath: u.path });
              return r.entries.slice(0, 5).map((e) => ({
                ...e,
                source: s.id,
                origin: "external",
                displayName: x.name || e.displayName,
                description: x.description || e.description,
                keywords: x.keywords ?? [],
                author: x.author?.name || e.author,
              }));
            } catch (e) {
              errors.push(`${s.id}/${x.id ?? x.installUrl}: ${e.message}`);
              return [];
            }
          });
          all = all.concat(found.flat());
        } catch (e) {
          errors.push(`${s.id}: external list: ${e.message}`);
        }
      }
      const prev = prevCache.sources?.[s.id]?.entries?.length ?? 0;
      fresh[s.id] = { scannedAt: new Date().toISOString(), entries: all };
      scanned++;
      added += Math.max(0, all.length - prev);
      await clearFailure(s.id);
    } catch (e) {
      errors.push(`${s.id}: ${e.message}`);
      if (e.kind === "rate") break;
      await recordFailure(s.id, e);
    }
  }
  await updateJson(CACHE_PATH, { sources: {} }, (c) => {
    c.sources ??= {};
    Object.assign(c.sources, fresh);
  });
  return { scanned, added, errors };
}

// ---------- official marketplace (plugins) ----------
export const OFFICIAL_ORGS = new Set(["github", "microsoft", "azure", "microsoftdocs", "dotnet", "azure-samples"]);
export const isOfficialRepo = (repo) => OFFICIAL_ORGS.has(String(repo).split("/")[0].toLowerCase());
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export async function readMarketplace(source) {
  const p = parseGithubUrl(source.url);
  const r = await ghGet(`${API}/repos/${p.owner}/${p.repo}/contents/${source.marketplaceFile}`, "application/vnd.github.raw+json");
  const j = JSON.parse(await r.text());
  return Array.isArray(j.plugins) ? j.plugins : [];
}

export function summarizePluginTree(tree, dir) {
  const prefix = dir ? `${dir}/` : "";
  const rels = (tree.tree ?? []).filter((e) => e.type === "blob" && e.path.startsWith(prefix)).map((e) => e.path.slice(prefix.length));
  return {
    skills: rels.filter((r) => /(^|\/)SKILL\.md$/.test(r)).length,
    agents: rels.filter((r) => /\.agent\.md$/.test(r)).length,
    extensions: rels.filter((r) => /(^|\/)extension\.mjs$/.test(r) && !/node_modules\//.test(r)).length,
    mcp: rels.some((r) => /(^|\/)\.?mcp(\.json|-servers\.json)$/.test(r)),
    hooks: rels.some((r) => /(^|\/)hooks(\.json|\/)/.test(r)),
  };
}

export async function scanMarketplace(source) {
  const list = await readMarketplace(source);
  const name = source.marketplaceName;
  const cand = list.filter((p) => p?.source && typeof p.source === "object" && typeof p.source.repo === "string" && PLUGIN_NAME.test(p.name ?? "") && (isOfficialRepo(p.source.repo) || /canvas/i.test(`${p.name} ${p.description} ${(p.keywords ?? []).join(" ")}`)));
  const errors = [];
  const entries = (
    await pool(cand, 4, async (p) => {
      try {
        const { repo, path: dir = "", sha, ref } = p.source;
        if (dir && !isSafeRelPath(dir)) throw new Error("unsafe path");
        const { commit } = await resolveCommit(repo, sha || ref);
        const contents = summarizePluginTree(await getTree(repo, commit), dir);
        return {
          key: `plugin:${source.id}/${p.name}`,
          kind: "plugin",
          name: p.name,
          displayName: p.name,
          description: p.description ?? "",
          author: p.author?.name || repo.split("/")[0],
          version: p.version,
          keywords: p.keywords ?? [],
          repo,
          path: dir,
          sha,
          ref,
          marketplace: name,
          pluginSpec: `${p.name}@${name}`,
          hasCanvas: contents.extensions > 0 || /canvas/i.test(p.description ?? ""),
          contents,
          canvasIds: [],
          toolCount: 0,
          stars: 0,
          source: source.id,
        };
      } catch (e) {
        if (e.kind === "rate") throw e;
        errors.push(`${p.name}: ${e.message}`);
        return null;
      }
    })
  ).filter(Boolean);
  return { entries, errors };
}

export async function webSearch(query) {
  const q = encodeURIComponent(String(query ?? "").trim());
  const out = new Map();
  const repos = await ghJson(`${API}/search/repositories?q=${q}+copilot+extension+canvas+in:name,description,readme&sort=stars&per_page=15`);
  for (const r of repos.items ?? []) out.set(r.full_name, { repo: r.full_name, url: r.html_url, stars: r.stargazers_count, description: r.description ?? "", paths: [] });
  let note = "";
  if (await getToken()) {
    try {
      const code = await ghJson(`${API}/search/code?q=createCanvas+filename:extension.mjs${q ? `+${q}` : ""}&per_page=20`);
      for (const it of code.items ?? []) {
        const n = it.repository.full_name;
        const cur = out.get(n) ?? { repo: n, url: it.repository.html_url, stars: 0, description: it.repository.description ?? "", paths: [] };
        cur.paths.push(it.path);
        out.set(n, cur);
      }
    } catch (e) {
      note = `コード検索はスキップ: ${e.message}`;
    }
  } else note = "コード検索には GitHub 認証が必要です（`gh auth login`）";
  const have = new Set((await allSources()).map((s) => repoLabel(s.url).toLowerCase()));
  const items = [...out.values()].filter((r) => !have.has(r.repo.toLowerCase())).sort((a, b) => b.paths.length - a.paths.length || b.stars - a.stars);
  return { items, note };
}

// ---------- fetch / review ----------
export async function fetchExtensionFiles(entry, commit) {
  if (entry.path && !isSafeRelPath(entry.path)) throw new Error(`不正なパス: ${entry.path}`);
  const tree = await getTree(entry.repo, commit);
  const prefix = entry.path ? `${entry.path}/` : "";
  const blobs = (tree.tree ?? []).filter((e) => {
    if (e.type !== "blob" || !e.path.startsWith(prefix)) return false;
    const rel = e.path.slice(prefix.length);
    if (/(^|\/)(?:node_modules|\.git)\//.test(rel) || (!prefix && rel.startsWith(".github/"))) return false;
    return true;
  });
  if (!blobs.some((b) => b.path === `${prefix}extension.mjs`)) throw new Error(`extension.mjs が見つかりません (${entry.path || "ルート"})`);
  if (blobs.length > MAX_FILES) throw new Error(`ファイル数が多すぎます (${blobs.length})`);
  const total = blobs.reduce((n, b) => n + (b.size ?? 0), 0);
  if (total > MAX_TOTAL_BYTES) throw new Error(`サイズが大きすぎます (${Math.round(total / 1024)} KB)`);
  const symlinks = [];
  const files = (
    await pool(blobs, 6, async (b) => {
      const rel = b.path.slice(prefix.length);
      if (b.mode === "120000") return symlinks.push(rel), null;
      if (!isSafeRelPath(rel)) return null;
      if ((b.size ?? 0) > MAX_FILE_BYTES) throw new Error(`${rel} が大きすぎます`);
      return { rel, data: await blobRaw(entry.repo, b.sha, { commit, path: b.path }) };
    })
  ).filter(Boolean);
  const dirTreeSha = prefix ? (tree.tree ?? []).find((e) => e.type === "tree" && e.path === entry.path)?.sha ?? null : tree.sha;
  return { files, dirTreeSha, symlinks };
}

// Reviews are the unit of consent: an install must reference a reviewId, and installs write exactly the reviewed bytes.
const reviews = new Map();
const REVIEW_TTL = 30 * 60000;
function storeReview(rec) {
  const now = Date.now();
  for (const [k, v] of reviews) if (v.expires < now) reviews.delete(k);
  while (reviews.size >= 24) reviews.delete(reviews.keys().next().value);
  const id = crypto.randomUUID();
  reviews.set(id, { ...rec, expires: now + REVIEW_TTL });
  return id;
}
export function getReview(reviewId, entryKey) {
  const r = reviews.get(String(reviewId ?? ""));
  if (!r || r.expires < Date.now()) throw Object.assign(new Error("レビューの有効期限が切れたか、見つかりません。もう一度レビューしてください"), { code: 400, kind: "review" });
  if (entryKey && r.entryKey !== entryKey) throw Object.assign(new Error("レビュー対象が一致しません"), { code: 400, kind: "review" });
  return r;
}

export async function reviewExtension(entry) {
  const resolved = await resolveCommit(entry.repo, entry.branch);
  const { files, dirTreeSha, symlinks } = await fetchExtensionFiles(entry, resolved.commit);
  const report = analyzeFiles(files);
  if (symlinks.length) report.findings.push({ id: "symlink", sev: "info", params: { n: symlinks.length } });
  const rec = { kind: "extension", entryKey: entry.key ?? keyOf(entry), commit: resolved.commit, branch: resolved.branch, dirTreeSha, treeHash: report.treeHash, risk: report.risk, files, report };
  const reviewId = storeReview(rec);
  return {
    reviewId,
    kind: "extension",
    entryKey: rec.entryKey,
    repo: entry.repo,
    path: entry.path,
    commit: resolved.commit,
    branch: resolved.branch,
    dirTreeSha,
    ...report,
    note: RISK_NOTE,
    files: files.map((f) => ({ rel: f.rel, size: f.data.length })),
  };
}
export const publicReview = (r) => r;

// ---------- plugins (official marketplace) ----------
const TEXT_RE = /\.(?:m?js|cjs|json|md|ya?ml|sh|ps1|toml)$/i;
export async function reviewPlugin(entry) {
  if (entry.kind !== "plugin") throw new Error("not a plugin entry");
  const ref = entry.sha || entry.ref || entry.branch;
  const { commit } = await resolveCommit(entry.repo, ref);
  const tree = await getTree(entry.repo, commit);
  const prefix = entry.path ? `${entry.path}/` : "";
  const all = (tree.tree ?? []).filter((e) => e.type === "blob" && e.path.startsWith(prefix) && !/(^|\/)(?:node_modules|\.git)\//.test(e.path));
  const cand = all
    .map((e) => ({ e, rel: e.path.slice(prefix.length) }))
    .filter(({ rel, e }) => isSafeRelPath(rel) && TEXT_RE.test(rel) && !/\.test\.|(^|\/)(?:tests?|__tests__|docs)\//.test(rel) && (e.size ?? 0) <= MAX_FILE_BYTES)
    .sort((a, b) => (/extension\.mjs$|plugin\.json$|mcp|hooks/i.test(b.rel) ? 1 : 0) - (/extension\.mjs$|plugin\.json$|mcp|hooks/i.test(a.rel) ? 1 : 0))
    .slice(0, 150);
  const files = await pool(cand, 6, async ({ e, rel }) => ({ rel, data: await blobRaw(entry.repo, e.sha, { commit, path: e.path }) }));
  const report = analyzeFiles(files, { kind: "plugin" });
  const contents = summarizePluginTree(tree, entry.path);
  if (all.length > cand.length) report.findings.push({ id: "partial-review", sev: "info", params: { n: cand.length, total: all.length } });
  const rec = { kind: "plugin", entryKey: entry.key, commit, treeHash: report.treeHash, risk: report.risk, spec: entry.pluginSpec, report, files: [] };
  const reviewId = storeReview(rec);
  return { reviewId, kind: "plugin", entryKey: entry.key, repo: entry.repo, path: entry.path, commit, ...report, contents, note: RISK_NOTE, files: files.map((f) => ({ rel: f.rel, size: f.data.length })) };
}

// Install through the app's native plugin manager (policy-aware). The marketplace must still pin the reviewed commit.
export async function installPlugin({ entry, reviewId, acknowledgeRisk, plugins }) {
  const rec = getReview(reviewId, entry.key);
  if (rec.kind !== "plugin") throw new Error("review kind mismatch");
  if (rec.risk === "high" && !acknowledgeRisk) return { status: "risk" };
  const src = (await allSources()).find((s) => s.id === entry.source && s.marketplaceFile);
  if (!src) throw new Error("marketplace source not found");
  const fresh = (await readMarketplace(src)).find((p) => p.name === entry.name);
  const pinned = fresh?.source?.sha || fresh?.source?.ref;
  if (!fresh || (entry.sha && pinned && pinned !== entry.sha)) throw new Error("マーケットプレイス側の固定コミットが変わりました。再レビューしてください");
  const mkts = await plugins.marketplaces();
  if (!mkts.some((m) => m.name === entry.marketplace)) throw new Error(`マーケットプレイス '${entry.marketplace}' が未登録です（Customize > Plugins で追加）`);
  const r = await plugins.install(entry.pluginSpec);
  return { status: "installed", message: r.postInstallMessage, skills: r.skillsInstalled, warning: r.deprecationWarning };
}

// ---------- install / uninstall / list ----------
export async function installExtension({ entry, scope = "user", cwd = process.cwd(), overwrite = false, reviewId, acknowledgeRisk = false }) {
  const name = entry.name;
  if (!isSafeName(name)) throw new Error(`不正な拡張名: ${name}`);
  const root = extensionsRoot(scope, cwd);
  const dest = path.join(root, name);
  if (!isInside(root, dest)) throw new Error("不正なインストール先");
  const rec = getReview(reviewId, entry.key ?? keyOf(entry));
  if (rec.kind !== "extension") throw new Error("review kind mismatch");
  const exists = await fs.stat(dest).then(() => true, () => false);
  if (exists && !overwrite) return { status: "exists", dest };
  const blocked = rec.report.findings.find((f) => f.id === "no-entry" || f.id === "needs-npm" || f.id === "install-script");
  if (blocked) throw Object.assign(new Error(`blocked:${blocked.id}`), { kind: "blocked", findingId: blocked.id });
  if (rec.risk === "high" && !acknowledgeRisk) return { status: "risk", dest, review: { ...rec.report, reviewId } };

  await fs.mkdir(root, { recursive: true });
  const id = crypto.randomUUID().slice(0, 8);
  const tmp = path.join(root, `.canvas-ninja-tmp-${id}-${name}`);
  const backup = path.join(root, `.canvas-ninja-bak-${id}-${name}`);
  let movedOld = false;
  let placed = false;
  try {
    for (const f of rec.files) {
      const target = path.join(tmp, f.rel);
      if (!isInside(tmp, target)) throw new Error(`パスの外へ出ます: ${f.rel}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, f.data);
    }
    if (exists) (await fs.rename(dest, backup), (movedOld = true));
    await fs.rename(tmp, dest);
    placed = true;
    await updateJson(STATE_PATH, {}, (state) => {
      state[dest] = { name, key: rec.entryKey, repo: entry.repo, path: entry.path, source: entry.source, commit: rec.commit, branch: rec.branch, dirTreeSha: rec.dirTreeSha, treeHash: rec.treeHash, risk: rec.risk, installedAt: new Date().toISOString() };
    });
  } catch (e) {
    if (placed) await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    if (movedOld) await fs.rename(backup, dest).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  if (movedOld) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  const warnings = [];
  if (scope === "user" && (await fs.stat(path.join(cwd, ".github", "extensions", name)).then(() => true, () => false))) warnings.push("shadowed");
  return { status: "installed", dest, fileCount: rec.files.length, risk: rec.risk, commit: rec.commit, warnings, needsReload: true };
}

export async function uninstallExtension({ name, scope = "user", cwd = process.cwd(), force = false }) {
  if (!isSafeName(name)) throw new Error(`不正な拡張名: ${name}`);
  const root = extensionsRoot(scope, cwd);
  const dest = path.join(root, name);
  if (!isInside(root, dest)) throw new Error("不正なパス");
  if (!(await fs.stat(path.join(dest, "extension.mjs")).then(() => true, () => false))) return { status: "notfound", dest };
  const state = await readJson(STATE_PATH, {});
  if (!state[dest] && !force) return { status: "unmanaged", dest };
  await fs.rm(dest, { recursive: true, force: true });
  await updateJson(STATE_PATH, {}, (s) => void delete s[dest]);
  return { status: "removed", dest, needsReload: true };
}

export async function listInstalled(scope, cwd = process.cwd()) {
  const root = extensionsRoot(scope, cwd);
  const state = await readJson(STATE_PATH, {});
  let dirs = [];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith("."));
  } catch {}
  const out = [];
  for (const d of dirs) {
    const dest = path.join(root, d.name);
    let text;
    try {
      const st = await fs.stat(path.join(dest, "extension.mjs"));
      if (st.size > MAX_FILE_BYTES) continue;
      text = await fs.readFile(path.join(dest, "extension.mjs"), "utf8");
    } catch {
      continue;
    }
    const meta = metaOfExtension(text);
    const s = state[dest];
    out.push({ name: d.name, scope, dest, managed: !!s, key: s?.key, repo: s?.repo, installedAt: s?.installedAt, risk: s?.risk, commit: s?.commit, displayName: meta.displayName || d.name, description: meta.description || "", canvasIds: meta.canvasIds, toolCount: meta.toolCount });
  }
  return out.sort((a, b) => (b.installedAt ?? "").localeCompare(a.installedAt ?? "") || a.name.localeCompare(b.name));
}

export async function checkUpdates(cwd = process.cwd()) {
  const state = await readJson(STATE_PATH, {});
  const live = new Set([...(await listInstalled("user", cwd)), ...(await listInstalled("project", cwd))].map((i) => i.dest));
  const updates = [];
  const byRepo = new Map();
  for (const [dest, s] of Object.entries(state)) {
    if (!live.has(dest) || !s.dirTreeSha) continue;
    (byRepo.get(s.repo) ?? byRepo.set(s.repo, []).get(s.repo)).push([dest, s]);
  }
  const errors = [];
  for (const [repo, list] of byRepo) {
    try {
      const { commit } = await resolveCommit(repo, list[0][1].branch);
      const tree = await getTree(repo, commit);
      for (const [dest, s] of list) {
        const cur = s.path ? (tree.tree ?? []).find((e) => e.type === "tree" && e.path === s.path)?.sha : tree.sha;
        if (cur && cur !== s.dirTreeSha) updates.push({ name: s.name, dest, scope: dest.startsWith(path.resolve(cwd)) ? "project" : "user", key: s.key, source: s.source, repo });
      }
    } catch (e) {
      errors.push(`${repo}: ${e.message}`);
    }
  }
  return { updates, errors };
}

// ---------- preview ----------
const readmeCache = new Map();
export async function fetchReadme(entry) {
  const k = entry.key ?? keyOf(entry);
  if (readmeCache.has(k)) return readmeCache.get(k);
  const { commit } = await resolveCommit(entry.repo, entry.kind === "plugin" ? entry.sha || entry.ref || entry.branch : entry.branch);
  const tries = [];
  if (entry.path) tries.push(`${entry.path}/README.md`, `${entry.path}/readme.md`);
  else tries.push("README.md");
  let text = null;
  for (const p of tries) {
    try {
      text = (await (await ghGet(`${API}/repos/${entry.repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`, "application/vnd.github.raw+json")).text()).slice(0, 60000);
      break;
    } catch (e) {
      if (e.kind !== "notfound") throw e;
    }
  }
  if (text === null) {
    try {
      text = (await (await ghGet(`${API}/repos/${entry.repo}/readme?ref=${commit}`, "application/vnd.github.raw+json")).text()).slice(0, 60000);
      text = `（拡張フォルダに README がないため、リポジトリの README を表示しています）\n\n${text}`;
    } catch (e) {
      if (e.kind !== "notfound") throw e;
      text = "README はありません。";
    }
  }
  readmeCache.set(k, text);
  return text;
}

export async function projectContext(cwd) {
  const out = [];
  for (const f of ["package.json", "README.md"]) {
    try {
      out.push((await fs.readFile(path.join(cwd, f), "utf8")).slice(0, 2000));
    } catch {}
  }
  return out.join("\n");
}
