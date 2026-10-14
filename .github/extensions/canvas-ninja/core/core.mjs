// Core logic for Agent Canvas Ninja: catalog, GitHub access, review, install. No UI / SDK dependencies.
import fs from "node:fs/promises";
import os from "node:os";
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
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}
export async function loadConfig() {
  const c = await readJson(CONFIG_PATH, {});
  return { sources: [], favorites: [], pins: [], overrides: {}, ignored: [], failures: {}, ja: {}, ...c };
}
const saveConfig = (c) => writeJson(CONFIG_PATH, c);
async function mutateConfig(fn) {
  const c = await loadConfig();
  const r = await fn(c);
  await saveConfig(c);
  return r;
}
export const readCache = () => readJson(CACHE_PATH, { sources: {} });

export const getTheme = async () => (await loadConfig()).theme || "auto";
export const setTheme = (theme) => mutateConfig((c) => void (c.theme = theme));
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
export const __setFetch = (f) => (fetchImpl = f);

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

async function ghGet(url, accept = "application/vnd.github+json") {
  const headers = { Accept: accept, "User-Agent": "canvas-ninja-copilot-app", "X-GitHub-Api-Version": "2022-11-28" };
  const token = await getToken();
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
const blobRaw = async (repo, sha) => Buffer.from(await (await ghGet(`${API}/repos/${repo}/git/blobs/${sha}`, "application/vnd.github.raw+json")).arrayBuffer());

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
      meta = metaOfExtension((await blobRaw(repo, sha)).toString("utf8"));
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
  const [bundled, cache, sources] = await Promise.all([loadBundled(), readCache(), allSources()]);
  const byKey = new Map();
  for (const e of bundled.extensions ?? []) byKey.set(e.key, e);
  for (const [sid, c] of Object.entries(cache.sources ?? {})) {
    for (const [k, e] of byKey) if (e.source === sid) byKey.delete(k);
    for (const e of c.entries ?? []) byKey.set(e.key, { ...e, source: sid });
  }
  const c = await loadConfig();
  const ignored = new Set(c.ignored);
  const extensions = [...byKey.values()].filter((e) => !ignored.has(e.source));
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

export function searchExtensions(index, query, { source, limit = 24, offset = 0, ja = {} } = {}) {
  const kws = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  let list = index.extensions.map((e) => ({ ...e, description_ja: ja[e.key] }));
  if (source) list = list.filter((e) => e.source === source);
  let rows = kws.length ? list.map((e) => [e, score(e, kws)]).filter(([, s]) => s > 0) : list.map((e) => [e, 0]);
  rows.sort((a, b) => b[1] - a[1] || (b[0].stars ?? 0) - (a[0].stars ?? 0) || a[0].name.localeCompare(b[0].name));
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
  const cache = await readCache();
  cache.sources ??= {};
  const errors = [];
  let scanned = 0;
  let added = 0;
  for (const s of targets) {
    try {
      const p = parseGithubUrl(s.url);
      const repo = `${p.owner}/${p.repo}`;
      const { entries } = await scanRepo({ repo, branch: s.branch, scanPath: s.scanPath });
      let all = entries.map((e) => ({ ...e, source: s.id }));
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
      const prev = cache.sources[s.id]?.entries?.length ?? 0;
      cache.sources[s.id] = { scannedAt: new Date().toISOString(), entries: all };
      scanned++;
      added += Math.max(0, all.length - prev);
      await clearFailure(s.id);
    } catch (e) {
      errors.push(`${s.id}: ${e.message}`);
      if (e.kind === "rate") break;
      await recordFailure(s.id, e);
    }
  }
  await writeJson(CACHE_PATH, cache);
  return { scanned, added, errors };
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
      return { rel, data: await blobRaw(entry.repo, b.sha) };
    })
  ).filter(Boolean);
  const dirTreeSha = prefix ? (tree.tree ?? []).find((e) => e.type === "tree" && e.path === entry.path)?.sha ?? null : tree.sha;
  return { files, dirTreeSha, symlinks };
}

const reviewCache = new Map();
export async function reviewExtension(entry, { commit: pinned, branch: pinnedBranch } = {}) {
  const resolved = pinned ? { commit: pinned, branch: pinnedBranch } : await resolveCommit(entry.repo, entry.branch);
  const ck = `${entry.repo}@${resolved.commit}:${entry.path}`;
  let hit = reviewCache.get(ck);
  if (!hit || Date.now() - hit.at > 10 * 60000) {
    const { files, dirTreeSha, symlinks } = await fetchExtensionFiles(entry, resolved.commit);
    const report = analyzeFiles(files);
    if (symlinks.length) report.findings.push({ id: "symlink", sev: "info", label: `シンボリックリンク ${symlinks.length} 件は取り込みません` });
    hit = { at: Date.now(), files, dirTreeSha, report };
    reviewCache.set(ck, hit);
    if (reviewCache.size > 8) reviewCache.delete(reviewCache.keys().next().value);
  }
  return {
    entryKey: entry.key ?? keyOf(entry),
    repo: entry.repo,
    path: entry.path,
    commit: resolved.commit,
    branch: resolved.branch,
    dirTreeSha: hit.dirTreeSha,
    ...hit.report,
    note: RISK_NOTE,
    files: hit.files.map((f) => ({ rel: f.rel, size: f.data.length })),
    _files: hit.files,
  };
}
export const publicReview = ({ _files, ...r }) => r;

// ---------- install / uninstall / list ----------
export async function installExtension({ entry, scope = "user", cwd = process.cwd(), overwrite = false, commit, branch, expectTreeHash, acknowledgeRisk = false }) {
  const name = entry.name;
  if (!isSafeName(name)) throw new Error(`不正な拡張名: ${name}`);
  const root = extensionsRoot(scope, cwd);
  const dest = path.join(root, name);
  if (!isInside(root, dest)) throw new Error("不正なインストール先");
  const exists = await fs.stat(dest).then(() => true, () => false);
  if (exists && !overwrite) return { status: "exists", dest };

  const review = await reviewExtension(entry, { commit, branch });
  if (expectTreeHash && review.treeHash !== expectTreeHash) {
    throw new Error("レビュー後に内容が変わりました。もう一度レビューしてください");
  }
  if (review.findings.some((f) => f.id === "no-entry")) throw new Error("extension.mjs がないためインストールできません");
  if (review.risk === "high" && !acknowledgeRisk) return { status: "risk", dest, review: publicReview(review) };

  const tmp = path.join(root, `.canvas-ninja-tmp-${process.pid}-${name}`);
  await fs.rm(tmp, { recursive: true, force: true });
  try {
    for (const f of review._files) {
      const target = path.join(tmp, f.rel);
      if (!isInside(tmp, target)) throw new Error(`パスの外へ出ます: ${f.rel}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, f.data);
    }
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  const state = await readJson(STATE_PATH, {});
  state[dest] = { name, key: review.entryKey, repo: entry.repo, path: entry.path, source: entry.source, commit: review.commit, branch: review.branch, dirTreeSha: review.dirTreeSha, treeHash: review.treeHash, risk: review.risk, installedAt: new Date().toISOString() };
  await writeJson(STATE_PATH, state);
  const warnings = [];
  if (scope === "user" && (await fs.stat(path.join(cwd, ".github", "extensions", name)).then(() => true, () => false))) warnings.push(`同名のプロジェクト拡張があるため、このプロジェクトではそちらが優先されます`);
  if (review.findings.some((f) => f.id === "needs-npm")) warnings.push("依存パッケージがあります。拡張フォルダで npm install が必要な場合があります");
  return { status: "installed", dest, fileCount: review._files.length, risk: review.risk, commit: review.commit, warnings, needsReload: true };
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
  delete state[dest];
  await writeJson(STATE_PATH, state);
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
  const { commit } = await resolveCommit(entry.repo, entry.branch);
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
