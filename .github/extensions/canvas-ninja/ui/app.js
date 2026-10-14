import { t, findingText } from "/i18n.mjs";

const TOKEN = new URLSearchParams(location.search).get("t");
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const S = {
  tab: "search", q: "", source: "", favonly: false, kind: "", scope: "user", offset: 0, total: 0, loading: false, lang: "ja", theme: "auto",
  sel: null, dtab: "about", review: {}, readme: {}, busy: new Set(), confirm: null, ack: false,
  installed: [], sessionExt: [], plugins: [], updates: [], updErrors: [], updChecked: false,
  favs: new Set(), pins: new Set(), facets: {}, bundles: [], srcData: null, problems: [], stale: [], webRes: null,
  reload: false, newSession: false, staleDismissed: false, cardCache: [], bundleState: {},
};
let view = [];
const T = (k, p) => t(S.lang, k, p);

async function api(p, body) {
  const r = await fetch(`/api/${p}${p.includes("?") ? "&" : "?"}t=${TOKEN}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { kind: j.kind, ssoUrl: j.ssoUrl });
  return j;
}
let tt;
function toast(m, k) {
  const el = $("#toast");
  el.textContent = m; el.className = k || ""; el.style.display = "block";
  clearTimeout(tt); tt = setTimeout(() => (el.style.display = "none"), k === "err" ? 7000 : 3200);
}
const fail = (e) => toast(e.message ?? String(e), "err");
const safeUrl = (u) => (/^https:\/\//.test(u) ? u : "#");
const repoUrl = (e) => `https://github.com/${e.repo}${e.path ? `/tree/${encodeURIComponent(e.sha || e.ref || "HEAD")}/${e.path}` : ""}`;
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = (e, lg) => `<div class="avatar${lg ? " lg" : ""}" style="background:linear-gradient(135deg,hsl(${hue(e.name)} 62% 46%),hsl(${(hue(e.name) + 40) % 360} 62% 36%))">${esc((e.displayName || e.name).slice(0, 2).toUpperCase())}</div>`;
const isPlugin = (e) => e?.kind === "plugin";
const rememberCards = (items) => { S.cardCache = [...items, ...S.cardCache].filter((e, i, a) => a.findIndex((x) => x.key === e.key) === i).slice(0, 400); };
const detailOf = (key) => view.find((e) => e.key === key) || S.cardCache.find((e) => e.key === key);

// ---------- minimal safe markdown (HTML is escaped first) ----------
function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```[a-z]*\n([\s\S]*?)```/g, (_, c) => (blocks.push(`<pre><code>${c}</code></pre>`), `\u0000${blocks.length - 1}\u0000`));
  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^##? (.+)$/gm, "<h2>$1</h2>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^(?:[-*] .+(?:\n|$))+/gm, (m) => `<ul>${m.trim().split("\n").map((l) => `<li>${l.slice(2)}</li>`).join("")}</ul>`)
    .replace(/\n{2,}/g, "<br><br>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

// ---------- state helpers ----------
const instOf = (e, scope = S.scope) => S.installed.find((i) => i.name === e.name && i.scope === scope);
const pluginInstalled = (e) => S.plugins.some((p) => p.name === e.name && p.marketplace === e.marketplace);
const sessionStatus = (i) => S.sessionExt.find((x) => x.name === i.name && x.source === i.scope);
const hasUpdate = (name, scope) => S.updates.some((u) => u.name === name && u.scope === scope);
const riskCls = (r) => (r === "high" ? "caut" : r === "medium" ? "warn" : "ok");
const riskTag = (r) => (r ? `<span class="tag ${riskCls(r)}">${esc(T("risk.label", { r: T(`risk.${r}`) }))}</span>` : "");

function stateTags(e) {
  if (isPlugin(e)) return pluginInstalled(e) ? `<span class="tag ok">${T("badge.pluginInstalled")}</span>` : "";
  const here = instOf(e);
  const other = instOf(e, S.scope === "user" ? "project" : "user");
  let h = "";
  if (here) {
    h += !here.key || here.key === e.key ? `<span class="tag ok">${esc(T("badge.installedHere", { scope: S.scope }))}</span>` : `<span class="tag warn">${T("badge.other")}</span>`;
    if (!here.managed) h += `<span class="tag">${T("badge.manual")}</span>`;
    if (hasUpdate(e.name, S.scope)) h += `<span class="tag warn">${T("badge.update")}</span>`;
  } else if (other) h += `<span class="tag">${esc(T("badge.installedOther", { scope: S.scope === "user" ? "project" : "user" }))}</span>`;
  return h;
}

const descOf = (e) => (S.lang === "ja" ? e.description_ja || e.description : e.description || e.description_ja) || "";

function card(e) {
  const fav = S.favs.has(e.key), pin = S.pins.has(e.key);
  const desc = descOf(e);
  return `<div class="card${S.sel === e.key ? " sel" : ""}" tabindex="0" data-key="${esc(e.key)}" data-source="${esc(e.source)}">
    ${avatar(e)}
    <div class="cmain">
      <div class="ctitle"><span class="cname">${esc(e.displayName || e.name)}</span><span class="cid mono">${esc(e.name)}</span></div>
      <div class="cdesc">${desc ? esc(desc) : `<i>${T("d.noDesc")}</i>`}</div>
      <div>${e.official ? `<span class="tag off">✔ ${T("badge.official")}</span>` : ""}${isPlugin(e) ? `<span class="tag ac">🧩 ${T("badge.plugin")}</span>` : ""}${stateTags(e)}<span class="tag">${esc(e.source)}</span>${e.toolCount ? `<span class="tag">🛠 ${e.toolCount}</span>` : ""}${e.origin === "external" ? `<span class="tag">${T("badge.external")}</span>` : ""}</div>
    </div>
    <div class="cside"><button class="star${fav ? " on" : ""}" data-a="fav" data-key="${esc(e.key)}" aria-label="favorite">${fav ? "★" : "☆"}</button><button class="pin${pin ? " on" : ""}" data-a="pin" data-key="${esc(e.key)}" aria-label="pin">📌</button></div>
  </div>`;
}

// ---------- rendering ----------
function renderBanners() {
  const b = [];
  if (S.reload || S.newSession) b.push(`<div class="banner info"><span>${S.reload ? T("banner.reload") : ""}${S.newSession ? ` ${T("confirm.pluginNote")}` : ""}</span><span class="sp"></span>${S.reload ? `<button class="primary" data-a="reload">${T("btn.reload")}</button>` : ""}<button data-a="reload-x">${T("btn.later")}</button></div>`);
  if (S.problems.length) b.push(`<div class="banner bad"><span>${esc(T("banner.problems", { n: S.problems.length }))}</span><span class="sp"></span><button data-a="goto-src">${T("banner.fix")}</button></div>`);
  if (S.stale.length && !S.staleDismissed) b.push(`<div class="banner warn"><span>${esc(T("banner.stale", { n: S.stale.length }))}</span><span class="sp"></span><button class="primary" data-a="refresh-stale">${T("banner.staleGo")}</button><button data-a="stale-x">${T("btn.later")}</button></div>`);
  $("#banners").innerHTML = b.join("");
}

const bundleMatches = (b) => {
  const kws = S.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!kws.length) return true;
  const hay = `${b.name.ja} ${b.name.en} ${b.description.ja} ${b.description.en} ${b.items.join(" ")}`.toLowerCase();
  return kws.every((k) => hay.includes(k));
};

function renderToolbar() {
  const hadFocus = document.activeElement?.id === "q";
  const caret = hadFocus ? document.activeElement.selectionStart : 0;
  renderToolbarInner();
  if (hadFocus) { const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(caret, caret); } }
}

function renderToolbarInner() {
  const tb = $("#toolbar");
  if (S.tab !== "search" && S.tab !== "official") return void (tb.innerHTML = "");
  const srcs = Object.entries(S.facets.sources ?? {});
  const shownBundles = S.bundles.filter(bundleMatches);
  const bundles = shownBundles.length
    ? `${S.tab === "official" ? `<div class="hint">${T("official.hint")}</div>` : ""}<h3 class="sec">${T("official.bundles")}</h3><div class="bundles">${shownBundles.map((b) => `<div class="bundle"><div class="bhead"><span class="bicon">${esc(b.icon || "📦")}</span><b>${esc(b.name[S.lang] || b.name.en)}</b><span class="tag">${esc(T("bundle.items", { n: b.items.length }))}</span></div><div class="meta">${esc(b.description[S.lang] || b.description.en)}</div><div class="row" style="margin-top:6px"><button class="primary" data-a="bundle" data-id="${esc(b.id)}">${T("bundle.review")}</button>${b.custom ? `<button class="danger" data-a="bundle-del" data-id="${esc(b.id)}">${T("set.delete")}</button>` : ""}</div></div>`).join("")}</div>`
    : "";
  tb.innerHTML = `${bundles}<div class="row"><div class="search"><input id="q" type="search" placeholder="${esc(T("search.placeholder"))}" value="${esc(S.q)}" autocomplete="off"></div>
    <span class="seg" title="${esc(T("search.destLabel"))}"><button data-a="scope" data-v="user" class="${S.scope === "user" ? "on" : ""}">user</button><button data-a="scope" data-v="project" class="${S.scope === "project" ? "on" : ""}">project</button></span></div>
    <div class="chips"><button class="chip${S.kind === "" ? " on" : ""}" data-a="kind" data-v="">${T("chip.all")}</button><button class="chip${S.kind === "canvas" ? " on" : ""}" data-a="kind" data-v="canvas">🖼 ${T("chip.canvas")}</button><button class="chip${S.kind === "plugin" ? " on" : ""}" data-a="kind" data-v="plugin">🧩 ${T("chip.plugin")}</button><button class="chip${S.favonly ? " on" : ""}" data-a="favonly">${T("chip.fav")}</button>${srcs.map(([k, n]) => `<button class="chip${S.source === k ? " on" : ""}" data-a="src" data-v="${esc(k)}">${esc(k)} ${n}</button>`).join("")}</div>
    <div class="meta">${S.loading ? T("search.loading") : T("search.total", { n: S.total })} · ${T("search.destLabel")}: ${T(`search.dest.${S.scope}`)}</div>`;
  const q = $("#q");
  if (q) q.oninput = () => { S.q = q.value; clearTimeout(S.dt); S.dt = setTimeout(() => fetchSearch(true), 220); };
}

function renderList() {
  const el = $("#list");
  if (S.tab === "search" || S.tab === "official") {
    if (S.loading && !view.length) return void (el.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>');
    if (!view.length) return void (el.innerHTML = `<div class="empty">${T("empty.search")}</div>`);
    const more = S.offset + view.length < S.total;
    el.innerHTML = view.map(card).join("") + (more ? `<div class="more"><button data-a="more">${esc(T("more", { n: S.total - view.length - S.offset }))}</button></div>` : "");
  } else if (S.tab === "installed") el.innerHTML = renderInstalled();
  else if (S.tab === "updates") el.innerHTML = renderUpdates();
  else el.innerHTML = renderSources();
}

function renderInstalled() {
  const pl = S.plugins.length ? `<h3 class="sec">${T("installed.pluginsTitle")}</h3>${S.plugins.map((p) => `<div class="srcrow"><div class="grow"><b>${esc(p.name)}</b> <span class="tag mono">@${esc(p.marketplace)}</span>${p.version ? `<span class="tag">v${esc(p.version)}</span>` : ""}${p.enabled ? "" : '<span class="tag warn">disabled</span>'}</div></div>`).join("")}` : "";
  if (!S.installed.length && !pl) return `<div class="empty">${T("empty.installed")}</div>`;
  const ext = S.installed.map((i) => {
    const st = sessionStatus(i);
    const k = `${i.scope}/${i.name}`;
    const stTag = st ? `<span class="tag ${st.status === "running" ? "ok" : st.status === "failed" ? "bad" : ""}">${esc(st.status)}</span>` : `<span class="tag warn">${T("badge.notLoaded")}</span>`;
    const act = S.busy.has(k) ? `<button disabled><span class="spin"></span>${T("btn.working")}</button>` : S.confirm === k
      ? `${i.managed ? "" : `<label class="meta"><input type="checkbox" id="force"> ${T("badge.manual")}</label>`}<button class="danger" data-a="del-yes" data-name="${esc(i.name)}" data-scope="${i.scope}">${T("btn.deleteYes")}</button><button data-a="del-no">${T("btn.cancel")}</button>`
      : `<button class="danger" data-a="del" data-k="${esc(k)}">${T("btn.delete")}</button>`;
    return `<div class="card" style="cursor:default">${avatar(i)}<div class="cmain"><div class="ctitle"><span class="cname">${esc(i.displayName)}</span><span class="cid mono">${esc(i.name)}</span></div><div class="cdesc">${esc(i.description)}</div><div><span class="tag ac">${i.scope}</span>${stTag}${i.managed ? "" : `<span class="tag">${T("badge.manual")}</span>`}${riskTag(i.risk)}${hasUpdate(i.name, i.scope) ? `<span class="tag warn">${T("badge.update")}</span>` : ""}${i.repo ? `<span class="tag mono">${esc(i.repo)}</span>` : ""}</div></div><div class="cside" style="align-items:stretch;gap:6px">${act}</div></div>`;
  }).join("");
  return (ext ? `<h3 class="sec">${T("installed.extTitle")}</h3>${ext}` : "") + pl;
}

function renderUpdates() {
  const head = `<div class="row" style="margin-bottom:8px"><button class="primary" data-a="check-upd">${S.busy.has("upd") ? '<span class="spin"></span>' : ""}${T("btn.checkUpdates")}</button>${S.updates.length ? `<button data-a="upd-first">${T("btn.reviewFirst")}</button>` : ""}<span class="meta">${T("upd.hint")}</span></div>`;
  const errs = S.updErrors.map((e) => `<div class="meta">⚠ ${esc(e)}</div>`).join("");
  if (!S.updChecked) return head + `<div class="empty">${T("empty.updates.start")}</div>`;
  if (!S.updates.length) return head + errs + `<div class="empty">${T("empty.updates")}</div>`;
  return head + errs + S.updates.map((u) => `<div class="srcrow"><div class="grow"><b>${esc(u.name)}</b> <span class="tag ac">${u.scope}</span> <span class="meta mono">${esc(u.repo)}</span></div><button class="primary" data-a="upd-one" data-key="${esc(u.key)}" data-scope="${u.scope}">${T("upd.review")}</button></div>`).join("");
}

function renderSources() {
  const d = S.srcData;
  if (!d) return '<div class="empty"><span class="spin"></span></div>';
  const prob = Object.fromEntries(d.problems.map((p) => [p.id, p]));
  const rows = d.sources.map((s) => {
    const p = prob[s.id], at = d.scanned[s.id], busy = S.busy.has(`src:${s.id}`);
    return `<div class="srcrow"><div class="grow"><b>${esc(s.id)}</b> <span class="tag">${esc(s.type)}</span>${s.ignored ? `<span class="tag">${T("src.ignored")}</span>` : ""}
      <div class="meta mono">${esc(s.url.replace("https://github.com/", ""))}${s.scanPath ? `/${esc(s.scanPath)}` : ""}${s.marketplaceFile ? " (marketplace)" : ""}${s.branch ? ` @${esc(s.branch)}` : ""} · ${esc(T("src.count", { n: d.counts[s.id] ?? 0 }))} · ${at ? esc(T("src.lastScan", { d: new Date(at).toLocaleDateString(S.lang === "ja" ? "ja-JP" : "en-US") })) : T("src.bundled")}</div>
      ${p ? `<div class="meta" style="color:var(--bad)">⚠ ${esc(T(`err.${p.kind}`))}: ${esc(p.message)} ${p.ssoUrl ? `<a href="${esc(safeUrl(p.ssoUrl))}" target="_blank" rel="noopener noreferrer">${T("src.ssoOpen")}</a>` : ""}</div>` : ""}</div>
      ${busy ? '<button disabled><span class="spin"></span></button>' : `<button data-a="src-scan" data-id="${esc(s.id)}">${p ? T("src.retry") : T("src.rescan")}</button>
      ${p || s.ignored ? `<button data-a="src-ignore" data-id="${esc(s.id)}" data-on="${s.ignored ? 0 : 1}">${s.ignored ? T("src.unignore") : T("src.ignore")}</button>` : ""}
      ${p ? `<button data-a="src-url" data-id="${esc(s.id)}">${T("src.setUrl")}</button>` : ""}
      ${s.bundled ? "" : `<button class="danger" data-a="src-del" data-id="${esc(s.id)}">${T("btn.delete")}</button>`}`}</div>`;
  }).join("");
  const web = S.webRes ? (S.webRes.items.length ? S.webRes.items.map((r) => `<div class="srcrow"><div class="grow"><b class="mono">${esc(r.repo)}</b> <span class="tag">★ ${r.stars}</span>${r.paths.length ? `<span class="tag ac">extension.mjs ${r.paths.length}</span>` : ""}<div class="meta">${esc(r.description)}</div></div><a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">GitHub</a><button data-a="web-add" data-url="${esc(r.url)}">${T("src.addToSources")}</button></div>`).join("") : `<div class="empty">${T("empty.web")}</div>`) + (S.webRes.note ? `<div class="meta">${esc(S.webRes.note)}</div>` : "") : "";
  return `<div class="meta">${esc(T("src.intro", { n: d.sources.length, stale: d.stale.length, days: d.staleDays }))}</div>
    <div class="row" style="margin:8px 0"><button data-a="refresh-all">${T("src.rescanAll")}</button><button data-a="refresh-stale">${esc(T("src.rescanStale", { n: d.perRun }))}</button></div>${rows}
    <h3 class="sec">${T("src.add")}</h3><div class="meta">${T("src.addHint")}</div>
    <div class="form"><input id="addurl" type="text" placeholder="https://github.com/owner/repo"><input id="addid" type="text" placeholder="${esc(T("src.idPh"))}" style="max-width:150px"><button class="primary" data-a="src-add">${T("src.addBtn")}</button></div>
    <h3 class="sec">${T("src.web")}</h3><div class="form"><input id="webq" type="text" placeholder="${esc(T("src.webPh"))}"><button data-a="web-search">${S.busy.has("web") ? '<span class="spin"></span>' : ""}${T("src.search")}</button></div>${web}`;
}

// ---------- detail ----------
const contentsTags = (c) => c ? [c.skills ? T("c.skills", { n: c.skills }) : "", c.agents ? T("c.agents", { n: c.agents }) : "", c.extensions ? T("c.canvas", { n: c.extensions }) : "", c.mcp ? T("c.mcp") : "", c.hooks ? T("c.hooks") : ""].filter(Boolean).map((x) => `<span class="tag">${esc(x)}</span>`).join("") : "";

function renderDetail() {
  const pane = $("#detail"), main = $("#main");
  const e = S.sel ? detailOf(S.sel) : null;
  if (!e || (S.tab !== "search" && S.tab !== "official")) { pane.hidden = true; main.classList.add("nodetail"); return; }
  pane.hidden = false; main.classList.remove("nodetail");
  const plugin = isPlugin(e), here = plugin ? pluginInstalled(e) : instOf(e);
  let actions;
  if (S.busy.has(`ins:${e.key}`)) actions = `<button disabled><span class="spin"></span>${T("btn.working")}</button>`;
  else if (plugin) actions = here ? `<span class="tag ok">${T("badge.pluginInstalled")}</span>` : `<button class="primary" data-a="review" data-key="${esc(e.key)}">${T("btn.reviewPlugin")}</button>`;
  else if (here && (!here.key || here.key === e.key)) actions = `${hasUpdate(e.name, S.scope) ? `<button class="primary" data-a="review" data-key="${esc(e.key)}">${T("btn.reviewUpdate")}</button>` : ""}<span class="tag ok">${esc(T("badge.installedHere", { scope: S.scope }))}</span><button data-a="goto-inst">${T("btn.gotoInstalled")}</button>`;
  else actions = `<button class="primary" data-a="review" data-key="${esc(e.key)}">${here ? T("btn.reviewOverwrite") : T("btn.review")}</button>`;
  const tabs = ["about", "risk", "readme", "files"];
  const rv = S.review[e.key];
  let body = "";
  if (S.dtab === "about") {
    const ja = e.description_ja;
    body = `<p>${esc(e.description || T("d.noDesc"))}</p>${ja && S.lang === "ja" ? `<p>${esc(ja)}</p>` : ""}
      <dl class="kv"><dt>${T("d.name")}</dt><dd class="mono">${esc(e.name)}</dd><dt>${T("d.repo")}</dt><dd><a href="${esc(repoUrl(e))}" target="_blank" rel="noopener noreferrer">${esc(e.repo)}</a>${e.path ? ` / <span class="mono">${esc(e.path)}</span>` : ""}</dd>
      <dt>${T("d.source")}</dt><dd>${esc(e.source)}${e.official ? ` <span class="tag off">✔ ${T("badge.official")}</span>` : ""}</dd><dt>${T("d.author")}</dt><dd>${esc(e.author || "-")}</dd>
      ${plugin ? `<dt>${T("d.version")}</dt><dd>${esc(e.version || "-")}</dd><dt>${T("d.pinned")}</dt><dd class="mono">${esc((e.sha || e.ref || "-").slice(0, 12))}</dd><dt>${T("d.contents")}</dt><dd>${contentsTags(e.contents)}</dd>`
        : `<dt>${T("d.canvases")}</dt><dd>${e.canvasIds?.length ? e.canvasIds.map((c) => `<code>${esc(c)}</code>`).join(" ") : "-"}</dd><dt>${T("d.tools")}</dt><dd>${e.toolCount ?? "-"}${T("d.approx")}</dd><dt>${T("d.stars")}</dt><dd>${e.stars ?? "-"}</dd>`}</dl>
      <h3 class="sec">${T("d.ja")}</h3><div class="form"><input id="jain" type="text" placeholder="${esc(T("d.jaPh"))}" value="${esc(ja ?? "")}"><button data-a="ja-save" data-key="${esc(e.key)}">${T("btn.save")}</button></div>`;
  } else if (S.dtab === "risk") body = renderReview(e, rv);
  else if (S.dtab === "readme") {
    const r = S.readme[e.key];
    body = r === undefined ? `<span class="spin"></span>${T("d.readmeLoading")}` : `<div class="md">${md(r)}</div>`;
  } else body = rv && rv.files ? `<div class="files">${rv.files.map((f) => `<div><span class="mono">${esc(f.rel)}</span><span class="meta">${f.size} B</span></div>`).join("")}</div>` : `<div class="meta">${T("d.filesHint")}</div>`;
  pane.innerHTML = `<button class="back ghost" data-a="close-detail">${T("btn.back")}</button>
    <div class="dhead">${avatar(e, true)}<div style="min-width:0"><h2>${esc(e.displayName || e.name)} ${e.official ? `<span class="tag off">✔ ${T("badge.official")}</span>` : ""}</h2><div class="meta mono">${esc(e.repo)}${e.path ? "/" + esc(e.path) : ""}</div></div></div>
    <div class="dactions">${actions}<button data-a="addset" data-key="${esc(e.key)}">${T("btn.addToSet")}</button><a href="${esc(repoUrl(e))}" target="_blank" rel="noopener noreferrer"><button>${T("btn.github")}</button></a></div>
    <div class="dtabs">${tabs.map((k) => `<button data-a="dtab" data-v="${k}" class="${S.dtab === k ? "on" : ""}">${T(`dtab.${k}`)}</button>`).join("")}</div>${body}`;
}

const BLOCKING = ["needs-npm", "install-script", "no-entry"];
function renderReview(e, rv) {
  if (rv === undefined) return `<div class="meta">${T("risk.notReviewed")}</div>`;
  if (rv === "loading") return `<span class="spin"></span>${T("risk.loading")}`;
  if (rv.error) return `<div class="banner bad">${esc(rv.error)}</div>`;
  const plugin = rv.kind === "plugin";
  const items = rv.findings.map((f) => `<div class="finding"><span class="dot ${f.sev}"></span><div>${esc(findingText(S.lang, f))}${f.file ? ` <span class="meta mono">${esc(f.file)}${f.line ? `:${f.line}` : ""}</span>` : ""}</div></div>`).join("") || `<div class="meta">${T("risk.none")}</div>`;
  const blocked = !plugin && rv.findings.find((f) => BLOCKING.includes(f.id));
  const key = `ins:${e.key}`;
  const here = plugin ? null : instOf(e);
  let confirm = "";
  if (!S.busy.has(key)) {
    const ack = rv.risk === "high" ? `<label><input type="checkbox" id="ack" ${S.ack ? "checked" : ""}> ${T("confirm.ack", { high: rv.risk === "high" ? T("confirm.ackHigh") : "" })}</label>` : "";
    const needAck = rv.risk === "high" && !S.ack;
    confirm = blocked
      ? `<div class="banner bad">${T(`confirm.blocked.${blocked.id}`)}</div>`
      : `<div class="confirm"><div><b>${T("confirm.what")}</b>: ${plugin ? T("confirm.plugin", { spec: esc(e.pluginSpec), commit: esc(rv.commit.slice(0, 7)) }) : `<span class="mono">${esc(rv.repo)}@${esc(rv.commit.slice(0, 7))}</span> → <span class="mono">${S.scope === "user" ? "~/.copilot/extensions" : ".github/extensions"}/${esc(e.name)}</span>（${esc(T("confirm.files", { n: rv.fileCount, kb: Math.round(rv.bytes / 1024) }))}）`}</div>
      ${plugin && rv.contents ? `<div style="margin:6px 0">${contentsTags(rv.contents)}</div>` : ""}${ack}
      ${here ? `<div class="meta" style="color:var(--warn)">${T("confirm.overwrite")}</div>` : ""}
      <div class="row" style="margin-top:6px"><button class="primary" data-a="install" data-key="${esc(e.key)}" ${needAck ? "disabled" : ""}>${plugin ? T("btn.installPlugin") : here ? T("btn.installOverwrite") : T("btn.install")}</button><button data-a="cancel-review" data-key="${esc(e.key)}">${T("btn.cancel")}</button></div></div>`;
  }
  return `<div class="risk ${rv.risk}"><b>${esc(T("risk.label", { r: T(`risk.${rv.risk}`) }))}</b><span class="meta">${T("risk.heuristic")}</span></div>${confirm}${items}
    ${rv.meta.envVars.length ? `<div class="note">${T("risk.env")}: ${rv.meta.envVars.map((v) => `<code>${esc(v)}</code>`).join(" ")}</div>` : ""}
    <div class="note">⚠ ${T("risk.note")}</div><div class="note mono">tree ${esc(rv.treeHash.slice(0, 16))}… / commit ${esc(rv.commit)}</div>`;
}

function applyStatic() {
  document.documentElement.lang = S.lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = T(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = T(el.dataset.i18nTitle)));
  document.querySelectorAll("#langseg [data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === S.lang));
  $("#about").title = T("about.title");
  document.documentElement.dataset.theme = S.theme || "auto";
}
function draw() { applyStatic(); renderBanners(); renderToolbar(); renderList(); renderDetail(); }

// ---------- data ----------
async function fetchSearch(reset) {
  if (reset) { S.offset = 0; view = []; }
  S.loading = true; renderToolbar(); renderList();
  try {
    const r = await api(`search?q=${encodeURIComponent(S.q)}&source=${encodeURIComponent(S.source)}&favonly=${S.favonly ? 1 : 0}&offset=${S.offset}&official=${S.tab === "official" ? 1 : 0}&kind=${S.kind}`);
    view = reset ? r.items : [...view, ...r.items];
    S.total = r.total;
    rememberCards(view);
  } catch (e) { fail(e); }
  S.loading = false; draw();
}
async function loadInstalled() {
  try {
    const [i, s, p] = await Promise.all([api("installed"), api("session-extensions").catch(() => ({ items: [] })), api("plugins").catch(() => ({ items: [] }))]);
    S.installed = i.items; S.sessionExt = s.items; S.plugins = p.items;
    $("#n-inst").textContent = S.installed.length + S.plugins.length || "";
  } catch (e) { fail(e); }
}
async function loadSources() {
  try {
    S.srcData = await api("sources"); S.problems = S.srcData.problems; S.stale = S.srcData.stale;
    $("#n-prob").textContent = S.problems.length || "";
  } catch (e) { fail(e); }
}
async function reinit() {
  const i = await api("init").catch(() => null);
  if (!i) return;
  S.facets = i.facets; S.favs = new Set(i.favs); S.pins = new Set(i.pins); S.bundles = i.bundles; S.theme = i.theme;
  if (i.lang) S.lang = i.lang;
  $("#sub").textContent = `${T("app.sub")} · ${T("app.count", { n: i.total, s: i.sources.length })}`;
}

async function review(key) {
  S.dtab = "risk"; S.ack = false; S.review[key] = "loading"; draw();
  const e = detailOf(key);
  try { S.review[key] = await api(`review?key=${encodeURIComponent(key)}&source=${encodeURIComponent(e?.source ?? "")}`); }
  catch (err) { S.review[key] = { error: err.message }; }
  draw();
}

async function install(key) {
  const e = detailOf(key), rv = S.review[key], bk = `ins:${key}`;
  S.busy.add(bk); draw();
  try {
    if (isPlugin(e)) {
      const r = await api("install-plugin", { key, source: e.source, reviewId: rv.reviewId, acknowledge: S.ack });
      if (r.status === "risk") toast(T("toast.riskAck"), "err");
      else { toast(T("toast.pluginInstalled", { name: e.name }), "ok"); S.newSession = true; delete S.review[key]; S.dtab = "about"; await loadInstalled(); }
    } else {
      const r = await api("install", { key, source: e.source, scope: S.scope, overwrite: !!instOf(e), reviewId: rv.reviewId, acknowledge: S.ack });
      if (r.status === "risk") toast(T("toast.riskAck"), "err");
      else {
        toast(T("toast.installed", { name: e.name, n: r.fileCount }), "ok");
        if ((r.warnings ?? []).includes("shadowed")) setTimeout(() => toast(T("toast.shadowed")), 1600);
        S.reload = true; delete S.review[key]; S.dtab = "about"; await loadInstalled();
      }
    }
  } catch (err) { fail(err); }
  S.busy.delete(bk); draw();
}

// ---------- bundles ----------
async function openBundle(id) {
  const b = S.bundles.find((x) => x.id === id);
  if (!b) return;
  const d = $("#dlg");
  const st = { items: [], prereq: [], ack: false, phase: "reviewing", results: null };
  S.bundleState = st;
  const render = () => {
    const rows = st.items.map((it) => `<div class="finding"><span class="dot ${it.rv?.risk === "high" ? "high" : it.rv?.risk === "medium" ? "medium" : "info"}"></span><div><b>${esc(it.e.displayName || it.e.name)}</b> ${it.rv ? riskTag(it.rv.risk) : it.err ? `<span class="tag bad">${esc(it.err)}</span>` : '<span class="spin"></span>'}${it.rv ? `<div class="meta">${contentsTags(it.rv.contents)} ${it.rv.findings.filter((f) => f.sev !== "info").slice(0, 4).map((f) => esc(findingText(S.lang, f))).join(" / ")}</div>` : ""}${it.result ? `<div class="meta">${it.result}</div>` : ""}</div>${b.custom && st.phase !== "installing" ? `<button class="ghost" data-rm="${esc(it.e.key)}" title="${esc(T("set.removeItem"))}">✕</button>` : ""}</div>`).join("");
    const pre = st.prereq.map((p) => `<span class="tag ${p.ok === undefined ? "" : p.ok ? "ok" : "bad"}">${p.ok === undefined ? "…" : p.ok ? "✓" : "✗"} ${esc(T(`prereq.${p.id}`))}</span>`).join("");
    const ready = st.phase === "ready";
    const needAck = st.items.some((i) => i.rv && i.rv.risk === "high");
    d.innerHTML = `<h3 style="margin-top:0">${esc(b.icon || "")} ${esc(b.name[S.lang] || b.name.en)} — ${T("bundle.title")}</h3>
      ${pre ? `<div class="meta">${T("bundle.prereq")}</div><div>${pre}</div>` : ""}${rows}
      <div class="note">⚠ ${T("risk.note")}</div>
      ${ready && needAck ? `<label class="meta"><input type="checkbox" id="back" ${st.ack ? "checked" : ""}> ${T("bundle.ackAll")}</label>` : ""}
      <div class="row" style="margin-top:10px">${ready ? `<button class="primary" id="binst" ${needAck && !st.ack ? "disabled" : ""}>${T("bundle.installAll")}</button>` : st.phase === "reviewing" ? `<span class="meta"><span class="spin"></span>${T("bundle.reviewing")}</span>` : ""}<button id="bclose">${T("btn.close")}</button></div>`;
    d.querySelector("#bclose").onclick = () => d.close();
    d.querySelectorAll("[data-rm]").forEach((x) => (x.onclick = async () => { await api("bundle/remove-item", { bundleId: b.id, key: x.dataset.rm }).catch(fail); st.items = st.items.filter((i) => i.e.key !== x.dataset.rm); await reinit(); if (!st.items.length) { d.close(); draw(); } else render(); }));
    d.querySelector("#back")?.addEventListener("change", (ev) => { st.ack = ev.target.checked; render(); });
    d.querySelector("#binst")?.addEventListener("click", doInstall);
  };
  const doInstall = async () => {
    st.phase = "installing"; render();
    let ok = 0, ng = 0;
    for (const it of st.items) {
      if (!it.rv || it.rv.findings.some((f) => BLOCKING.includes(f.id) && !isPlugin(it.e))) { ng++; continue; }
      try {
        const r = isPlugin(it.e)
          ? await api("install-plugin", { key: it.e.key, source: it.e.source, reviewId: it.rv.reviewId, acknowledge: st.ack })
          : await api("install", { key: it.e.key, source: it.e.source, scope: S.scope, overwrite: !!instOf(it.e), reviewId: it.rv.reviewId, acknowledge: st.ack });
        if (r.status === "installed") { ok++; it.result = "✓"; isPlugin(it.e) ? (S.newSession = true) : (S.reload = true); } else { ng++; it.result = r.status; }
      } catch (e) { ng++; it.result = e.message; }
      render();
    }
    st.phase = "done"; render();
    toast(T("bundle.done", { ok, ng }), ng ? "err" : "ok");
    await loadInstalled(); draw();
  };
  d.showModal(); render();
  const pre = (b.prereq ?? []).map((id) => ({ id }));
  st.prereq = pre; render();
  pre.forEach((p) => api(`prereq?id=${encodeURIComponent(p.id)}`).then((r) => { p.ok = !!r.ok; render(); }).catch(() => { p.ok = false; render(); }));
  try {
    const { items } = await api(`entries?keys=${encodeURIComponent(b.items.join(","))}`);
    rememberCards(items);
    const order = new Map(b.items.map((k, i) => [k, i]));
    st.items = items.sort((a, c) => order.get(a.key) - order.get(c.key)).map((e) => ({ e }));
    render();
    for (const it of st.items) {
      try { it.rv = await api(`review?key=${encodeURIComponent(it.e.key)}&source=${encodeURIComponent(it.e.source)}`); } catch (e) { it.err = e.message; }
      render();
    }
    st.phase = st.items.some((i) => i.rv) ? "ready" : "done"; render();
  } catch (e) { st.phase = "done"; fail(e); render(); }
}

function openAddToSet(key) {
  const e = detailOf(key); if (!e) return;
  const d = $("#dlg");
  const mine = S.bundles.filter((b) => b.custom);
  d.innerHTML = `<h3 style="margin-top:0">${T("set.title")}: ${esc(e.displayName || e.name)}</h3><div class="meta">${T("set.hint")}</div>
    ${mine.length ? `<div class="meta" style="margin-top:8px">${T("set.existing")}</div>${mine.map((b) => `<div class="srcrow"><div class="grow">${esc(b.icon || "⭐")} <b>${esc(b.name[S.lang] || b.name.en)}</b> <span class="tag">${esc(T("bundle.items", { n: b.items.length }))}</span>${b.items.includes(key) ? '<span class="tag ok">✓</span>' : ""}</div><button data-set="${esc(b.id)}" ${b.items.includes(key) ? "disabled" : ""}>${T("btn.addToSet")}</button></div>`).join("")}` : ""}
    <div class="form"><input id="newset" type="text" maxlength="60" placeholder="${esc(T("set.newPh"))}"><button class="primary" id="mkset">${T("set.create")}</button></div>
    <div class="row"><button id="setclose">${T("btn.close")}</button></div>`;
  const done = async (r, created, name) => { toast(created ? T("set.created", { name }) : T("set.added", { name }), "ok"); d.close(); await reinit(); draw(); };
  d.querySelectorAll("[data-set]").forEach((b) => (b.onclick = async () => { try { await api("bundle/add", { key, bundleId: b.dataset.set }); const bb = mine.find((x) => x.id === b.dataset.set); await done(null, false, bb.name[S.lang] || bb.name.en); } catch (err) { fail(err); } }));
  const mk = async () => { const name = d.querySelector("#newset").value.trim(); if (!name) return; try { await api("bundle/add", { key, name }); await done(null, true, name); } catch (err) { fail(err); } };
  d.querySelector("#mkset").onclick = mk;
  d.querySelector("#newset").addEventListener("keydown", (ev) => { if (ev.key === "Enter") mk(); });
  d.querySelector("#setclose").onclick = () => d.close();
  d.showModal();
}
// ---------- actions ----------
async function loadReadme(key) {
  const e = detailOf(key); if (!e) return;
  try { S.readme[key] = (await api(`readme?key=${encodeURIComponent(key)}&source=${encodeURIComponent(e.source)}`)).markdown; }
  catch (err) { S.readme[key] = T("d.readmeFail", { m: err.message }); }
  if (S.sel === key && S.dtab === "readme") draw();
}

async function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (tab === "installed") await loadInstalled();
  if (tab === "sources") { S.srcData = null; draw(); await loadSources(); }
  if (tab === "search" || tab === "official") { S.sel = null; await fetchSearch(true); }
  draw();
}

async function act(a, el) {
  const d = el.dataset;
  switch (a) {
    case "fav": case "pin": {
      const r = await api(a === "fav" ? "favorite" : "pin", { key: d.key }).catch(fail);
      if (!r) return;
      const set = a === "fav" ? S.favs : S.pins;
      r.on ? set.add(d.key) : set.delete(d.key);
      if (a === "pin" || (a === "fav" && S.favonly)) return fetchSearch(true);
      return draw();
    }
    case "scope": S.scope = d.v; return draw();
    case "src": S.source = S.source === d.v ? "" : d.v; return fetchSearch(true);
    case "kind": S.kind = d.v; return fetchSearch(true);
    case "favonly": S.favonly = !S.favonly; return fetchSearch(true);
    case "more": S.offset += 24; return fetchSearch(false);
    case "bundle": return openBundle(d.id);
    case "bundle-del": {
      const b = S.bundles.find((x) => x.id === d.id);
      if (!b || !confirm(T("set.confirmDelete", { name: b.name[S.lang] || b.name.en }))) return;
      await api("bundle/delete", { id: d.id }).catch(fail); toast(T("set.deleted"), "ok"); await reinit(); return draw();
    }
    case "addset": return openAddToSet(d.key);
    case "dtab": S.dtab = d.v; if (d.v === "readme" && S.readme[S.sel] === undefined) loadReadme(S.sel); return draw();
    case "close-detail": S.sel = null; return draw();
    case "review": return review(d.key);
    case "cancel-review": delete S.review[d.key]; S.dtab = "about"; return draw();
    case "install": return install(d.key);
    case "goto-inst": return setTab("installed");
    case "goto-src": return setTab("sources");
    case "ja-save": {
      const text = ($("#jain") || {}).value || "";
      await api("localize", { key: d.key, text }).catch(fail);
      const e = detailOf(d.key); if (e) e.description_ja = text.trim();
      toast(T("toast.saved"), "ok"); return draw();
    }
    case "reload": S.reload = false; S.newSession = false; toast(T("toast.reloading")); await api("reload", {}).catch(fail); return draw();
    case "reload-x": S.reload = false; S.newSession = false; return draw();
    case "del": S.confirm = d.k; return draw();
    case "del-no": S.confirm = null; return draw();
    case "del-yes": {
      const k = `${d.scope}/${d.name}`;
      S.busy.add(k); S.confirm = null; draw();
      try {
        const r = await api("uninstall", { name: d.name, scope: d.scope, force: !!($("#force") || {}).checked });
        if (r.status === "removed") { toast(T("toast.removed", { name: d.name }), "ok"); S.reload = true; }
        else if (r.status === "unmanaged") toast(T("toast.unmanaged"), "err");
        else toast(T("toast.notFound"), "err");
        await loadInstalled();
      } catch (e) { fail(e); }
      S.busy.delete(k); return draw();
    }
    case "check-upd": {
      S.busy.add("upd"); draw();
      try { const r = await api("updates"); S.updates = r.updates; S.updErrors = r.errors; S.updChecked = true; $("#n-upd").textContent = S.updates.length || ""; } catch (e) { fail(e); }
      S.busy.delete("upd"); return draw();
    }
    case "upd-one": case "upd-first": {
      const u = a === "upd-one" ? d : S.updates[0];
      if (!u) return;
      await setTab("search");
      S.scope = u.scope; S.source = ""; S.kind = ""; S.q = u.key.split(":").pop().split("/").pop();
      await fetchSearch(true);
      S.sel = u.key;
      return review(u.key);
    }
    case "refresh-all": case "refresh-stale": {
      toast(T("toast.scanning"));
      try {
        const r = await api("source/refresh", a === "refresh-stale" ? { stale: true } : {});
        toast(T("toast.scanned", { n: r.scanned, a: r.added, err: r.errors.length ? T("toast.scanFail", { n: r.errors.length }) : "" }), r.errors.length ? "err" : "ok");
        S.staleDismissed = false;
      } catch (e) { fail(e); }
      await Promise.all([loadSources(), reinit()]); return S.tab === "sources" ? draw() : fetchSearch(true);
    }
    case "stale-x": S.staleDismissed = true; return draw();
    case "src-scan": case "src-ignore": case "src-del": case "src-url": {
      const id = d.id, bk = `src:${id}`;
      if (a === "src-del" && !confirm(T("src.confirmDel", { id }))) return;
      let url;
      if (a === "src-url") { url = prompt(T("src.promptUrl"), ""); if (!url) return; }
      S.busy.add(bk); draw();
      try {
        if (a === "src-url") { await api("source/set-url", { id, url }); toast(T("toast.urlSet"), "ok"); }
        else if (a === "src-scan") { const r = await api("source/refresh", { ids: [id] }); toast(r.errors.length ? r.errors[0] : T("toast.scanDone", { n: r.added }), r.errors.length ? "err" : "ok"); }
        else if (a === "src-ignore") await api("source/ignore", { id, on: d.on === "1" });
        else await api("source/remove", { id });
      } catch (e) { fail(e); }
      S.busy.delete(bk); await Promise.all([loadSources(), reinit()]); return draw();
    }
    case "src-add": case "web-add": {
      const url = a === "web-add" ? d.url : ($("#addurl") || {}).value || "";
      if (!url.trim()) return toast(T("toast.needUrl"), "err");
      toast(T("toast.addingScan"));
      try {
        const r = await api("source/add", { url: url.trim(), id: a === "src-add" ? ($("#addid") || {}).value || undefined : undefined });
        toast(T("toast.added", { repo: r.repo, r: r.scanned ? T("toast.scanOk") : T("toast.scanNg") }) + (r.errors[0] ? `: ${r.errors[0]}` : ""), r.errors.length ? "err" : "ok");
        if (a === "web-add" && S.webRes) S.webRes.items = S.webRes.items.filter((x) => x.url !== url);
      } catch (e) { fail(e); }
      await Promise.all([loadSources(), reinit()]); return draw();
    }
    case "web-search": {
      S.busy.add("web"); draw();
      try { S.webRes = await api("websearch", { query: ($("#webq") || {}).value || "" }); } catch (e) { fail(e); }
      S.busy.delete("web"); return draw();
    }
  }
}

// ---------- events ----------
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-a]");
  if (el) { ev.preventDefault(); ev.stopPropagation(); return void act(el.dataset.a, el).catch(fail); }
  const c = ev.target.closest(".card[data-key]");
  if (c) { S.sel = c.dataset.key; S.dtab = "about"; S.ack = false; draw(); }
});
document.addEventListener("change", (ev) => {
  if (ev.target.id === "ack") { S.ack = ev.target.checked; const b = document.querySelector('[data-a="install"]'); if (b) b.disabled = !S.ack; }
});
document.addEventListener("keydown", (ev) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (ev.key === "/" && !typing && (S.tab === "search" || S.tab === "official")) { ev.preventDefault(); $("#q")?.focus(); }
  else if (ev.key === "Escape" && S.sel && !typing) { S.sel = null; draw(); }
  else if (ev.key === "Enter" && document.activeElement?.classList.contains("card") && document.activeElement.dataset.key) document.activeElement.click();
  else if (ev.key === "Enter" && ["addurl", "addid"].includes(document.activeElement?.id)) document.querySelector('[data-a="src-add"]')?.click();
  else if (ev.key === "Enter" && document.activeElement?.id === "webq") document.querySelector('[data-a="web-search"]')?.click();
});
$("#tabs").addEventListener("click", (ev) => { const b = ev.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
$("#langseg").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-lang]"); if (!b) return;
  S.lang = b.dataset.lang; await api("lang", { lang: S.lang }).catch(fail); await reinit(); draw();
});
$("#theme").onchange = async (ev) => { S.theme = ev.target.value; document.documentElement.dataset.theme = S.theme; await api("theme", { theme: S.theme }).catch(fail); };
$("#about").onclick = () => {
  const d = $("#dlg");
  d.innerHTML = `<h3 style="margin-top:0">🥷 Agent Canvas Ninja</h3><p>${T("about.body")}</p>
    <ul><li>${T("about.l1")}</li><li>${T("about.l2")}</li><li>${T("about.l3")}</li><li>${T("about.l4")}</li></ul>
    <p class="meta">Skills: <a href="https://github.com/aktsmm/copilot-app-extensions" target="_blank" rel="noopener noreferrer">aktsmm/copilot-app-extensions</a> · yamapan (<a href="https://github.com/aktsmm" target="_blank" rel="noopener noreferrer">@aktsmm</a>) · CC BY-NC-SA 4.0</p>
    <p><b>${T("about.keys")}</b>: <kbd>/</kbd> ${T("about.k1")} · <kbd>Esc</kbd> ${T("about.k2")} · <kbd>Enter</kbd> ${T("about.k3")}</p><div class="row"><button data-d="x">${T("btn.close")}</button></div>`;
  d.querySelector("[data-d]").onclick = () => d.close();
  d.showModal();
};

(async () => {
  S.lang = navigator.language?.startsWith("ja") ? "ja" : "en";
  await reinit();
  $("#theme").value = S.theme || "auto";
  draw();
  await Promise.all([fetchSearch(true), loadInstalled(), loadSources()]);
  draw();
})();
