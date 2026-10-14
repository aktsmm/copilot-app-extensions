// Local web UI server for the Agent Canvas Ninja canvas. Loopback only, random token, Host/Origin checks.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadIndex, searchExtensions, getFacets, findExtension, reviewExtension, publicReview, installExtension, uninstallExtension,
  listInstalled, checkUpdates, fetchReadme, loadConfig, toggleListed, getTheme, setTheme, setLocalized, addSource, removeSource,
  refreshIndex, staleSources, sourceProblems, setIgnored, setSourceUrl, webSearch, STALE_DAYS, MAX_STALE_PER_RUN, parseGithubUrl,
} from "./core.mjs";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const PAGE = 24;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors *";

const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(code, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": CSP, ...(isObj ? { "Content-Type": "application/json; charset=utf-8" } : {}), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw Object.assign(new Error("リクエストが大きすぎます"), { code: 413 });
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw Object.assign(new Error("不正な JSON"), { code: 400 });
  }
}

const entryOf = async (key, source) => {
  const index = await loadIndex();
  const hits = findExtension(index, key, source);
  if (hits.length !== 1) throw Object.assign(new Error(hits.length ? "候補が複数あります" : `カタログに見つかりません: ${key}`), { code: 404 });
  return hits[0];
};

export async function startUiServer({ cwd, reload, sessionExtensions, askAgent }) {
  const token = crypto.randomBytes(18).toString("hex");
  let port = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, { error: "bad host" });
      if (!url.pathname.startsWith("/api/")) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!/^[a-z0-9.-]+$/i.test(file) || !TYPES[path.extname(file)]) return send(res, 404, "not found");
        return send(res, 200, await fs.readFile(path.join(UI_DIR, file)), { "Content-Type": TYPES[path.extname(file)] });
      }
      if (url.searchParams.get("t") !== token) return send(res, 401, { error: "unauthorized" });
      const post = req.method === "POST";
      if (post && req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return send(res, 403, { error: "bad origin" });
      const body = post ? await readBody(req) : {};
      const q = url.searchParams;
      const route = url.pathname.slice(5);
      send(res, 200, await handle(route, q, body, post));
    } catch (e) {
      send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: String(e.message ?? e), kind: e.kind, ssoUrl: e.ssoUrl });
    }
  });

  async function handle(route, q, body, post) {
    if (!post) {
      switch (route) {
        case "init": {
          const [index, cfg, theme] = await Promise.all([loadIndex(), loadConfig(), getTheme()]);
          return { theme, total: index.extensions.length, facets: getFacets(index), sources: index.sources, favs: cfg.favorites, pins: cfg.pins, generatedAt: index.generatedAt, cwd: cwd() };
        }
        case "search": {
          const [index, cfg] = await Promise.all([loadIndex(), loadConfig()]);
          const offset = Number(q.get("offset")) || 0;
          let r = searchExtensions({ ...index, extensions: q.get("favonly") === "1" ? index.extensions.filter((e) => cfg.favorites.includes(e.key)) : index.extensions }, q.get("q") ?? "", { source: q.get("source") || undefined, limit: 5000, ja: cfg.ja });
          const pinned = r.items.filter((e) => cfg.pins.includes(e.key));
          const items = [...pinned, ...r.items.filter((e) => !cfg.pins.includes(e.key))];
          return { total: r.total, items: items.slice(offset, offset + PAGE), offset, page: PAGE };
        }
        case "installed": {
          const [user, project] = await Promise.all([listInstalled("user", cwd()), listInstalled("project", cwd())]);
          return { items: [...user, ...project] };
        }
        case "session-extensions":
          return { items: await sessionExtensions() };
        case "updates":
          return await checkUpdates(cwd());
        case "review": {
          const e = await entryOf(q.get("key"), q.get("source") || undefined);
          return publicReview(await reviewExtension(e));
        }
        case "readme":
          return { markdown: await fetchReadme(await entryOf(q.get("key"), q.get("source") || undefined)) };
        case "sources": {
          const [index, problems] = await Promise.all([loadIndex(), sourceProblems()]);
          return { sources: index.sources, problems, stale: await staleSources(index), staleDays: STALE_DAYS, perRun: MAX_STALE_PER_RUN, scanned: Object.fromEntries(Object.entries(index.cache.sources ?? {}).map(([k, v]) => [k, v.scannedAt])), counts: getFacets(index).sources };
        }
        default:
          throw Object.assign(new Error("not found"), { code: 404 });
      }
    }
    switch (route) {
      case "install": {
        const e = await entryOf(body.key, body.source);
        if (!body.treeHash || !body.commit) throw Object.assign(new Error("先にリスクレポートを確認してください"), { code: 400 });
        return await installExtension({ entry: e, scope: body.scope === "project" ? "project" : "user", cwd: cwd(), overwrite: !!body.overwrite, commit: body.commit, branch: body.branch, expectTreeHash: body.treeHash, acknowledgeRisk: !!body.acknowledge });
      }
      case "uninstall":
        return await uninstallExtension({ name: body.name, scope: body.scope === "project" ? "project" : "user", cwd: cwd(), force: !!body.force });
      case "reload":
        setTimeout(() => reload().catch(() => {}), 400);
        return { ok: true };
      case "ask-agent":
        await askAgent(String(body.prompt ?? "").slice(0, 2000));
        return { ok: true };
      case "favorite":
        return await toggleListed("favorites", body.key);
      case "pin":
        return await toggleListed("pins", body.key);
      case "theme":
        await setTheme(String(body.theme));
        return { ok: true };
      case "localize":
        await setLocalized(body.key, body.text);
        return { ok: true };
      case "source/add": {
        const p = parseGithubUrl(body.url);
        const id = await addSource({ id: body.id || undefined, url: body.url, branch: body.branch || undefined });
        const r = await refreshIndex([id]);
        return { id, repo: `${p.owner}/${p.repo}`, ...r };
      }
      case "source/remove":
        return { removed: await removeSource(body.id) };
      case "source/ignore":
        await setIgnored(body.id, !!body.on);
        return { ok: true };
      case "source/set-url":
        await setSourceUrl(body.id, body.url, body.branch || undefined);
        return await refreshIndex([body.id]);
      case "source/refresh":
        return await refreshIndex(body.ids?.length ? body.ids : body.stale ? (await staleSources()).slice(0, MAX_STALE_PER_RUN) : undefined);
      case "websearch":
        return await webSearch(body.query);
      default:
        throw Object.assign(new Error("not found"), { code: 404 });
    }
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  return { server, port, token };
}
