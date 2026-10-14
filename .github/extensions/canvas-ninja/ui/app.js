const T = new URLSearchParams(location.search).get("t");
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const S = {
  tab: "search", q: "", source: "", favonly: false, scope: "user", offset: 0, items: [], total: 0, loading: false,
  sel: null, dtab: "about", review: {}, readme: {}, busy: new Set(), confirm: null,
  installed: [], sessionExt: [], updates: [], updErrors: [], favs: new Set(), pins: new Set(), sources: [], problems: [], stale: [],
  facets: {}, reload: false, srcData: null, webRes: null, ack: false, cwd: "",
};
let view = [];

async function api(p, body) {
  const r = await fetch(`/api/${p}${p.includes("?") ? "&" : "?"}t=${T}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { kind: j.kind, ssoUrl: j.ssoUrl });
  return j;
}
let tt;
function toast(m, k) {
  const t = $("#toast");
  t.textContent = m; t.className = k || ""; t.style.display = "block";
  clearTimeout(tt); tt = setTimeout(() => (t.style.display = "none"), k === "err" ? 7000 : 3200);
}
const fail = (e) => toast(e.message ?? String(e), "err");
const safeUrl = (u) => (/^https:\/\//.test(u) ? u : "#");
const repoUrl = (e) => `https://github.com/${e.repo}${e.path ? `/tree/HEAD/${e.path}` : ""}`;
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = (e, lg) => `<div class="avatar${lg ? " lg" : ""}" style="background:linear-gradient(135deg,hsl(${hue(e.name)} 62% 46%),hsl(${(hue(e.name) + 40) % 360} 62% 36%))">${esc((e.displayName || e.name).slice(0, 2).toUpperCase())}</div>`;

// ---------- minimal safe markdown ----------
function md(src) {
  const blocks = [];
  let t = esc(src).replace(/```[a-z]*\n([\s\S]*?)```/g, (_, c) => (blocks.push(`<pre><code>${c}</code></pre>`), `\u0000${blocks.length - 1}\u0000`));
  t = t.replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^##? (.+)$/gm, "<h2>$1</h2>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^(?:[-*] .+(?:\n|$))+/gm, (m) => `<ul>${m.trim().split("\n").map((l) => `<li>${l.slice(2)}</li>`).join("")}</ul>`)
    .replace(/\n{2,}/g, "<br><br>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

// ---------- state helpers ----------
const instOf = (e, scope = S.scope) => S.installed.find((i) => i.name === e.name && i.scope === scope);
const sessionStatus = (i) => S.sessionExt.find((x) => x.name === i.name && x.source === i.scope);
const hasUpdate = (name, scope) => S.updates.some((u) => u.name === name && u.scope === scope);
const riskTag = (r) => (r ? `<span class="tag ${r === "high" ? "bad" : r === "medium" ? "warn" : "ok"}">リスク: ${{ high: "高", medium: "中", low: "低" }[r]}</span>` : "");

function stateTags(e) {
  const here = instOf(e);
  const other = instOf(e, S.scope === "user" ? "project" : "user");
  let t = "";
  if (here) {
    const same = !here.key || here.key === e.key;
    t += same ? `<span class="tag ok">✓ ${S.scope} に導入済み</span>` : `<span class="tag warn">同名の別拡張が導入済み</span>`;
    if (!here.managed) t += `<span class="tag">手動導入</span>`;
    if (hasUpdate(e.name, S.scope)) t += `<span class="tag warn">更新あり</span>`;
  } else if (other) t += `<span class="tag">${S.scope === "user" ? "project" : "user"} に導入済み</span>`;
  return t;
}

function card(e) {
  const fav = S.favs.has(e.key), pin = S.pins.has(e.key);
  const desc = e.description_ja || e.description || "";
  return `<div class="card${S.sel === e.key ? " sel" : ""}" tabindex="0" data-key="${esc(e.key)}" data-source="${esc(e.source)}">
    ${avatar(e)}
    <div class="cmain">
      <div class="ctitle"><span class="cname">${esc(e.displayName || e.name)}</span><span class="cid mono">${esc(e.name)}</span></div>
      <div class="cdesc">${desc ? esc(desc) : "<i>説明なし</i>"}</div>
      <div>${stateTags(e)}<span class="tag ac">${esc(e.source)}</span>${e.toolCount ? `<span class="tag">🛠 ${e.toolCount}</span>` : ""}${e.canvasIds?.length ? `<span class="tag">🖼 ${e.canvasIds.length}</span>` : ""}${e.origin === "external" ? '<span class="tag">external</span>' : ""}</div>
    </div>
    <div class="cside"><button class="star${fav ? " on" : ""}" data-a="fav" data-key="${esc(e.key)}" title="お気に入り" aria-label="お気に入り">${fav ? "★" : "☆"}</button><button class="pin${pin ? " on" : ""}" data-a="pin" data-key="${esc(e.key)}" title="ピン留め（先頭に表示）" aria-label="ピン留め">📌</button></div>
  </div>`;
}

// ---------- rendering ----------
function renderBanners() {
  const b = [];
  if (S.reload) b.push(`<div class="banner info"><span>🔄 変更を反映するには拡張の再読み込みが必要です（このキャンバスも一度閉じて開き直されます）</span><span class="sp"></span><button class="primary" data-a="reload">今すぐ再読み込み</button><button data-a="reload-x">後で</button></div>`);
  if (S.problems.length) b.push(`<div class="banner bad"><span>⚠ 取得に失敗したソースが ${S.problems.length} 件あります</span><span class="sp"></span><button data-a="goto-src">対応する</button></div>`);
  if (S.stale.length && !S.staleDismissed) b.push(`<div class="banner warn"><span>🕒 ${S.stale.length} 件のソースが 30 日以上更新されていません</span><span class="sp"></span><button class="primary" data-a="refresh-stale">古い順に最大 5 件更新</button><button data-a="stale-x">後で</button></div>`);
  $("#banners").innerHTML = b.join("");
}

function renderToolbar() {
  const srcs = Object.entries(S.facets.sources ?? {});
  if (S.tab === "search") {
    $("#toolbar").innerHTML = `<div class="row"><div class="search"><input id="q" type="search" placeholder="キーワードで検索（例: diagram, pr, kanban）  /" value="${esc(S.q)}" autocomplete="off"></div>
      <span class="seg" title="インストール先"><button data-a="scope" data-v="user" class="${S.scope === "user" ? "on" : ""}">user</button><button data-a="scope" data-v="project" class="${S.scope === "project" ? "on" : ""}">project</button></span></div>
      <div class="chips"><button class="chip${S.source === "" ? " on" : ""}" data-a="src" data-v="">すべて</button>${srcs.map(([k, n]) => `<button class="chip${S.source === k ? " on" : ""}" data-a="src" data-v="${esc(k)}">${esc(k)} ${n}</button>`).join("")}<button class="chip${S.favonly ? " on" : ""}" data-a="favonly">★ お気に入り</button></div>
      <div class="meta">${S.loading ? "検索中…" : `${S.total} 件`} ・ インストール先: ${S.scope === "user" ? "~/.copilot/extensions（全プロジェクト）" : ".github/extensions（このプロジェクト）"}</div>`;
    const q = $("#q");
    if (q) q.oninput = () => { S.q = q.value; clearTimeout(S.dt); S.dt = setTimeout(() => fetchSearch(true), 220); };
  } else $("#toolbar").innerHTML = "";
}

function renderList() {
  const el = $("#list");
  if (S.tab === "search") {
    if (S.loading && !view.length) return (el.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>');
    if (!view.length) return (el.innerHTML = '<div class="empty">該当する拡張がありません。<br>ソースタブで GitHub リポジトリを追加できます。</div>');
    const more = S.offset + view.length < S.total;
    el.innerHTML = view.map(card).join("") + (more ? `<div class="more"><button data-a="more">さらに表示（残り ${S.total - view.length - S.offset}）</button></div>` : "");
  } else if (S.tab === "installed") el.innerHTML = renderInstalled();
  else if (S.tab === "updates") el.innerHTML = renderUpdates();
  else el.innerHTML = renderSources();
}

function renderInstalled() {
  if (!S.installed.length) return '<div class="empty">インストール済みの拡張はありません</div>';
  return S.installed.map((i) => {
    const st = sessionStatus(i);
    const k = `${i.scope}/${i.name}`;
    const stTag = st ? `<span class="tag ${st.status === "running" ? "ok" : st.status === "failed" ? "bad" : ""}">${esc(st.status)}</span>` : '<span class="tag warn">未読み込み（再読み込みが必要）</span>';
    const busy = S.busy.has(k);
    let act = busy ? '<button disabled><span class="spin"></span>処理中</button>' : S.confirm === k
      ? `${i.managed ? "" : `<label class="meta"><input type="checkbox" id="force"> 手動導入の拡張も削除する</label>`}<button class="danger" data-a="del-yes" data-name="${esc(i.name)}" data-scope="${i.scope}">本当に削除</button><button data-a="del-no">キャンセル</button>`
      : `<button class="danger" data-a="del" data-name="${esc(i.name)}" data-scope="${i.scope}" data-k="${esc(k)}">削除</button>`;
    return `<div class="card" style="cursor:default" data-open="${esc(i.key ?? "")}">${avatar(i)}<div class="cmain"><div class="ctitle"><span class="cname">${esc(i.displayName)}</span><span class="cid mono">${esc(i.name)}</span></div><div class="cdesc">${esc(i.description)}</div><div><span class="tag ac">${i.scope}</span>${stTag}${i.managed ? "" : '<span class="tag">手動導入</span>'}${riskTag(i.risk)}${hasUpdate(i.name, i.scope) ? '<span class="tag warn">更新あり</span>' : ""}${i.repo ? `<span class="tag mono">${esc(i.repo)}</span>` : ""}</div></div><div class="cside" style="align-items:stretch;gap:6px">${act}</div></div>`;
  }).join("");
}

function renderUpdates() {
  const head = `<div class="row" style="margin-bottom:8px"><button class="primary" data-a="check-upd">${S.busy.has("upd") ? '<span class="spin"></span>' : ""}更新を確認</button>${S.updates.length ? '<button data-a="upd-all">すべて確認して更新…</button>' : ""}<span class="meta">本アプリで導入した拡張の、上流ディレクトリの変更を検出します</span></div>`;
  const errs = S.updErrors.map((e) => `<div class="meta">⚠ ${esc(e)}</div>`).join("");
  if (S.updChecked === undefined) return head + '<div class="empty">「更新を確認」を押してください</div>';
  if (!S.updates.length) return head + errs + '<div class="empty">更新はありません 🎉</div>';
  return head + errs + S.updates.map((u) => `<div class="srcrow"><div class="grow"><b>${esc(u.name)}</b> <span class="tag ac">${u.scope}</span> <span class="meta mono">${esc(u.repo)}</span></div><button class="primary" data-a="upd-one" data-key="${esc(u.key)}" data-scope="${u.scope}" data-source="${esc(u.source)}">レビューして更新</button></div>`).join("");
}

function renderSources() {
  const d = S.srcData;
  if (!d) return '<div class="empty"><span class="spin"></span>読み込み中…</div>';
  const prob = Object.fromEntries(d.problems.map((p) => [p.id, p]));
  const kindText = { sso: "SSO 認可が必要", notfound: "見つからない（削除・改名・非公開）", rate: "レート制限", auth: "認証失敗", forbidden: "アクセス拒否", network: "ネットワークエラー", toolarge: "リポジトリが大きすぎる" };
  const rows = d.sources.map((s) => {
    const p = prob[s.id];
    const at = d.scanned[s.id];
    const busy = S.busy.has(`src:${s.id}`);
    return `<div class="srcrow"><div class="grow"><b>${esc(s.id)}</b> <span class="tag">${esc(s.type)}</span>${s.ignored ? '<span class="tag">無視中</span>' : ""}
      <div class="meta mono">${esc(s.url.replace("https://github.com/", ""))}${s.scanPath ? `/${esc(s.scanPath)}` : ""}${s.branch ? ` @${esc(s.branch)}` : ""} ・ ${d.counts[s.id] ?? 0} 件 ・ ${at ? `最終スキャン ${new Date(at).toLocaleDateString("ja-JP")}` : "同梱カタログ"}</div>
      ${p ? `<div class="meta" style="color:var(--bad)">⚠ ${esc(kindText[p.kind] ?? p.kind)}: ${esc(p.message)} ${p.ssoUrl ? `<a href="${esc(safeUrl(p.ssoUrl))}" target="_blank" rel="noopener noreferrer">SSO 認可を開く</a>` : ""}</div>` : ""}</div>
      ${busy ? '<button disabled><span class="spin"></span></button>' : `<button data-a="src-scan" data-id="${esc(s.id)}">${p ? "再試行" : "再スキャン"}</button>
      ${p || s.ignored ? `<button data-a="src-ignore" data-id="${esc(s.id)}" data-on="${s.ignored ? 0 : 1}">${s.ignored ? "無視を解除" : "無視する"}</button>` : ""}
      ${p ? `<button data-a="src-url" data-id="${esc(s.id)}">URL を変更</button>` : ""}
      ${s.bundled ? "" : `<button class="danger" data-a="src-del" data-id="${esc(s.id)}">削除</button>`}`}</div>`;
  }).join("");
  const web = S.webRes ? (S.webRes.items.length ? S.webRes.items.map((r) => `<div class="srcrow"><div class="grow"><b class="mono">${esc(r.repo)}</b> <span class="tag">★ ${r.stars}</span>${r.paths.length ? `<span class="tag ac">extension.mjs ${r.paths.length} 件</span>` : ""}<div class="meta">${esc(r.description)}</div></div><a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">GitHub</a><button data-a="web-add" data-url="${esc(r.url)}">ソースに追加</button></div>`).join("") : '<div class="empty">見つかりませんでした</div>') + (S.webRes.note ? `<div class="meta">${esc(S.webRes.note)}</div>` : "") : "";
  return `<div class="meta">GitHub の ${d.sources.length} ソースを参照しています。${d.stale.length} 件が ${d.staleDays} 日以上未更新。</div>
    <div class="row" style="margin:8px 0"><button data-a="refresh-all">すべて再スキャン</button><button data-a="refresh-stale">古いソースを更新（最大 ${d.perRun} 件）</button></div>
    ${rows}
    <h3 class="sec">ソースを追加</h3><div class="meta">リポジトリまたはフォルダの URL（例: https://github.com/owner/repo, …/tree/main/extensions/foo）</div>
    <div class="form"><input id="addurl" type="text" placeholder="https://github.com/owner/repo"><input id="addid" type="text" placeholder="ID（省略可）" style="max-width:150px"><button class="primary" data-a="src-add">追加してスキャン</button></div>
    <h3 class="sec">GitHub で探す</h3>
    <div class="form"><input id="webq" type="text" placeholder="キーワード（例: kanban, azure）"><button data-a="web-search">${S.busy.has("web") ? '<span class="spin"></span>' : ""}検索</button></div>${web}`;
}

// ---------- detail ----------
function detailOf(key) { return [...view, ...(S.cardCache ?? [])].find((e) => e.key === key); }

function renderDetail() {
  const pane = $("#detail"), main = $("#main");
  const e = S.sel ? detailOf(S.sel) : null;
  if (!e || S.tab !== "search") { pane.hidden = true; main.classList.add("nodetail"); return; }
  pane.hidden = false; main.classList.remove("nodetail");
  const here = instOf(e);
  const rv = S.review[e.key];
  const busyKey = `ins:${e.key}`;
  let actions = "";
  if (S.busy.has(busyKey)) actions = '<button disabled><span class="spin"></span>処理中…</button>';
  else if (here && (!here.key || here.key === e.key)) actions = `${hasUpdate(e.name, S.scope) ? '<button class="primary" data-a="review" data-key="' + esc(e.key) + '" data-overwrite="1">レビューして更新</button>' : ""}<span class="tag ok">✓ ${S.scope} に導入済み</span><button data-a="goto-inst">インストール済みを見る</button>`;
  else actions = `<button class="primary" data-a="review" data-key="${esc(e.key)}">${here ? "上書きのレビューへ" : "レビューしてインストール"}</button>`;
  const tabs = [["about", "概要"], ["risk", "リスクレポート"], ["readme", "README"], ["files", "ファイル"]];
  let body = "";
  if (S.dtab === "about") {
    const ja = e.description_ja;
    body = `<p>${esc(e.description || "説明なし")}</p>${ja ? `<p>${esc(ja)}</p>` : ""}
      <dl class="kv"><dt>拡張名</dt><dd class="mono">${esc(e.name)}</dd><dt>リポジトリ</dt><dd><a href="${esc(repoUrl(e))}" target="_blank" rel="noopener noreferrer">${esc(e.repo)}</a>${e.path ? ` / <span class="mono">${esc(e.path)}</span>` : ""}</dd>
      <dt>ソース</dt><dd>${esc(e.source)}${e.origin === "external" ? "（external）" : ""}</dd><dt>作者</dt><dd>${esc(e.author || "-")}</dd><dt>キャンバス</dt><dd>${e.canvasIds?.length ? e.canvasIds.map((c) => `<code>${esc(c)}</code>`).join(" ") : "-"}</dd>
      <dt>ツール数</dt><dd>${e.toolCount ?? "-"}（概算）</dd><dt>リポジトリ ★</dt><dd>${e.stars ?? "-"}</dd></dl>
      <h3 class="sec">日本語の要約</h3><div class="form"><input id="jain" type="text" placeholder="日本語の説明を保存（任意）" value="${esc(ja ?? "")}"><button data-a="ja-save" data-key="${esc(e.key)}">保存</button></div>`;
  } else if (S.dtab === "risk") body = renderReview(e, rv);
  else if (S.dtab === "readme") {
    const r = S.readme[e.key];
    body = r === undefined ? '<span class="spin"></span>読み込み中…' : `<div class="md">${md(r)}</div>`;
  } else body = rv ? `<div class="files">${rv.files.map((f) => `<div><span class="mono">${esc(f.rel)}</span><span class="meta">${f.size} B</span></div>`).join("")}</div>` : '<div class="meta">「レビューしてインストール」を押すとファイル一覧を取得します</div>';
  pane.innerHTML = `<button class="back ghost" data-a="close-detail">← 戻る</button>
    <div class="dhead">${avatar(e, true)}<div style="min-width:0"><h2>${esc(e.displayName || e.name)}</h2><div class="meta mono">${esc(e.repo)}${e.path ? "/" + esc(e.path) : ""}</div></div></div>
    <div class="dactions">${actions}<a href="${esc(repoUrl(e))}" target="_blank" rel="noopener noreferrer"><button>GitHub で開く</button></a></div>
    <div class="dtabs">${tabs.map(([k, l]) => `<button data-a="dtab" data-v="${k}" class="${S.dtab === k ? "on" : ""}">${l}</button>`).join("")}</div>${body}`;
}

function renderReview(e, rv) {
  if (rv === undefined) return '<div class="meta">まだレビューしていません。「レビューしてインストール」を押してください。</div>';
  if (rv === "loading") return '<span class="spin"></span>コミットを固定して取得・解析中…';
  if (rv.error) return `<div class="banner bad">${esc(rv.error)}</div>`;
  const label = { high: "高", medium: "中", low: "低" }[rv.risk];
  const items = rv.findings.map((f) => `<div class="finding"><span class="dot ${f.sev}"></span><div>${esc(f.label)}${f.file ? ` <span class="meta mono">${esc(f.file)}${f.line ? `:${f.line}` : ""}</span>` : ""}</div></div>`).join("") || '<div class="meta">指摘事項はありません</div>';
  const here = instOf(e);
  const overwrite = rv.wantOverwrite || (here && here.key === e.key);
  const key = `ins:${e.key}`;
  const confirm = S.busy.has(key) ? "" : `<div class="confirm"><div><b>インストール内容</b>: <span class="mono">${esc(rv.repo)}@${esc(rv.commit.slice(0, 7))}</span> → <span class="mono">${S.scope === "user" ? "~/.copilot/extensions" : ".github/extensions"}/${esc(e.name)}</span>（${rv.fileCount} ファイル, ${Math.round(rv.bytes / 1024)} KB）</div>
    ${rv.risk !== "low" ? `<label><input type="checkbox" id="ack" ${S.ack ? "checked" : ""}> 上記の指摘事項を確認し、${rv.risk === "high" ? "<b>リスクが高い</b>ことを理解した上で" : ""}このコードの実行を許可します</label>` : ""}
    ${here && !overwrite ? '<div class="meta" style="color:var(--warn)">同名の別拡張が導入済みです。上書きされます</div>' : ""}
    <div class="row" style="margin-top:6px"><button class="primary" data-a="install" data-key="${esc(e.key)}" ${rv.risk !== "low" && !S.ack ? "disabled" : ""}>${overwrite || here ? "上書きしてインストール" : "インストール"}</button><button data-a="cancel-review" data-key="${esc(e.key)}">キャンセル</button></div></div>`;
  return `<div class="risk ${rv.risk}"><b>リスク: ${label}</b><span class="meta">ヒューリスティック判定</span></div>${confirm}${items}
    ${rv.meta.envVars.length ? `<div class="note">要求する環境変数: ${rv.meta.envVars.map((v) => `<code>${esc(v)}</code>`).join(" ")}</div>` : ""}
    <div class="note">⚠ ${esc(rv.note)}</div><div class="note mono">tree ${esc(rv.treeHash.slice(0, 16))}… / commit ${esc(rv.commit)}</div>`;
}

function draw() { renderBanners(); renderToolbar(); renderList(); renderDetail(); document.documentElement.dataset.theme = S.theme || "auto"; }

// ---------- data ----------
async function fetchSearch(reset) {
  if (reset) { S.offset = 0; view = []; }
  S.loading = true; renderToolbar(); renderList();
  try {
    const r = await api(`search?q=${encodeURIComponent(S.q)}&source=${encodeURIComponent(S.source)}&favonly=${S.favonly ? 1 : 0}&offset=${S.offset}`);
    view = reset ? r.items : [...view, ...r.items];
    S.total = r.total;
    S.cardCache = [...view, ...(S.cardCache ?? [])].filter((e, i, a) => a.findIndex((x) => x.key === e.key) === i).slice(0, 300);
  } catch (e) { fail(e); }
  S.loading = false; draw();
}
async function loadInstalled() {
  try {
    const [i, s] = await Promise.all([api("installed"), api("session-extensions").catch(() => ({ items: [] }))]);
    S.installed = i.items; S.sessionExt = s.items;
    $("#n-inst").textContent = S.installed.length || "";
  } catch (e) { fail(e); }
}
async function loadSources() {
  try {
    S.srcData = await api("sources"); S.problems = S.srcData.problems; S.stale = S.srcData.stale;
    $("#n-prob").textContent = S.problems.length || "";
  } catch (e) { fail(e); }
}

async function review(key, overwrite) {
  S.dtab = "risk"; S.ack = false; S.review[key] = "loading"; draw();
  const e = detailOf(key);
  try {
    const r = await api(`review?key=${encodeURIComponent(key)}&source=${encodeURIComponent(e?.source ?? "")}`);
    S.review[key] = { ...r, wantOverwrite: !!overwrite };
  } catch (err) { S.review[key] = { error: err.message }; }
  draw();
}

async function install(key) {
  const e = detailOf(key), rv = S.review[key];
  const bk = `ins:${key}`;
  S.busy.add(bk); draw();
  try {
    const r = await api("install", { key, source: e.source, scope: S.scope, overwrite: !!instOf(e), commit: rv.commit, branch: rv.branch, treeHash: rv.treeHash, acknowledge: S.ack });
    if (r.status === "risk") toast("リスクの確認が必要です", "err");
    else {
      toast(`${e.name} をインストールしました（${r.fileCount} ファイル）`, "ok");
      (r.warnings ?? []).forEach((w) => setTimeout(() => toast(w), 1600));
      S.reload = true; delete S.review[key]; S.dtab = "about";
      await loadInstalled();
    }
  } catch (err) { fail(err); }
  S.busy.delete(bk); draw();
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
    case "src": S.source = d.v; return fetchSearch(true);
    case "favonly": S.favonly = !S.favonly; return fetchSearch(true);
    case "more": S.offset += 24; return fetchSearch(false);
    case "dtab": S.dtab = d.v; if (d.v === "readme" && S.readme[S.sel] === undefined) loadReadme(S.sel); draw(); return;
    case "close-detail": S.sel = null; return draw();
    case "review": return review(d.key, d.overwrite === "1");
    case "cancel-review": delete S.review[d.key]; S.dtab = "about"; return draw();
    case "install": return install(d.key);
    case "goto-inst": return setTab("installed");
    case "goto-src": return setTab("sources");
    case "ja-save": {
      const text = ($("#jain") || {}).value || "";
      await api("localize", { key: d.key, text }).catch(fail);
      const e = detailOf(d.key); if (e) e.description_ja = text.trim();
      toast("保存しました", "ok"); return draw();
    }
    case "reload": S.reload = false; toast("再読み込み中… キャンバスが開き直されます"); await api("reload", {}).catch(fail); return draw();
    case "reload-x": S.reload = false; return draw();
    case "del": S.confirm = d.k; return draw();
    case "del-no": S.confirm = null; return draw();
    case "del-yes": {
      const k = `${d.scope}/${d.name}`;
      S.busy.add(k); S.confirm = null; draw();
      try {
        const r = await api("uninstall", { name: d.name, scope: d.scope, force: !!($("#force") || {}).checked });
        if (r.status === "removed") { toast(`${d.name} を削除しました`, "ok"); S.reload = true; }
        else if (r.status === "unmanaged") toast("手動導入の拡張です。確認チェックを付けて再度削除してください", "err");
        else toast("見つかりませんでした", "err");
        await loadInstalled();
      } catch (e) { fail(e); }
      S.busy.delete(k); return draw();
    }
    case "check-upd": {
      S.busy.add("upd"); draw();
      try { const r = await api("updates"); S.updates = r.updates; S.updErrors = r.errors; S.updChecked = true; $("#n-upd").textContent = S.updates.length || ""; } catch (e) { fail(e); }
      S.busy.delete("upd"); return draw();
    }
    case "upd-one": case "upd-all": {
      const u = a === "upd-one" ? [d] : S.updates;
      if (!u.length) return;
      await setTab("search");
      S.scope = u[0].scope; S.source = ""; S.q = ""; await fetchSearch(true);
      const key = u[0].key;
      S.sel = key; S.cardCache = S.cardCache ?? [];
      if (!detailOf(key)) { S.q = key.split(":").pop().split("/").pop(); await fetchSearch(true); }
      return review(key, true);
    }
    case "refresh-all": case "refresh-stale": {
      S.busy.add("refresh"); toast("スキャン中…（数十秒かかることがあります）");
      try {
        const r = await api("source/refresh", a === "refresh-stale" ? { stale: true } : {});
        toast(`${r.scanned} ソースをスキャン: 新規 ${r.added} 件${r.errors.length ? ` / 失敗 ${r.errors.length} 件` : ""}`, r.errors.length ? "err" : "ok");
        S.staleDismissed = false;
      } catch (e) { fail(e); }
      S.busy.delete("refresh"); await Promise.all([loadSources(), reinit()]); return fetchSearch(true);
    }
    case "stale-x": S.staleDismissed = true; return draw();
    case "src-scan": case "src-ignore": case "src-del": case "src-url": {
      const id = d.id, bk = `src:${id}`;
      if (a === "src-del" && !confirm(`ソース '${id}' を削除しますか？`)) return;
      if (a === "src-url") {
        const url = prompt("新しい GitHub URL（リポジトリ、または /tree/<branch>/<path>）", ""); if (!url) return;
        S.busy.add(bk); draw();
        try { await api("source/set-url", { id, url }); toast("URL を更新して再スキャンしました", "ok"); } catch (e) { fail(e); }
      } else {
        S.busy.add(bk); draw();
        try {
          if (a === "src-scan") { const r = await api("source/refresh", { ids: [id] }); toast(r.errors.length ? r.errors[0] : `スキャン完了（新規 ${r.added} 件）`, r.errors.length ? "err" : "ok"); }
          else if (a === "src-ignore") await api("source/ignore", { id, on: d.on === "1" });
          else await api("source/remove", { id });
        } catch (e) { fail(e); }
      }
      S.busy.delete(bk); await Promise.all([loadSources(), reinit()]); return fetchSearch(true);
    }
    case "src-add": case "web-add": {
      const url = a === "web-add" ? d.url : ($("#addurl") || {}).value || "";
      if (!url.trim()) return toast("URL を入力してください", "err");
      const bk = "addsrc"; S.busy.add(bk); toast("追加してスキャン中…");
      try {
        const r = await api("source/add", { url: url.trim(), id: a === "src-add" ? ($("#addid") || {}).value || undefined : undefined });
        toast(`${r.repo} を追加（${r.scanned ? "スキャン成功" : "スキャン失敗"}${r.errors[0] ? `: ${r.errors[0]}` : ""}）`, r.errors.length ? "err" : "ok");
        if (a === "web-add" && S.webRes) S.webRes.items = S.webRes.items.filter((x) => x.url !== url);
      } catch (e) { fail(e); }
      S.busy.delete(bk); await Promise.all([loadSources(), reinit()]); return fetchSearch(true);
    }
    case "web-search": {
      const q = ($("#webq") || {}).value || "";
      S.busy.add("web"); draw();
      try { S.webRes = await api("websearch", { query: q }); } catch (e) { fail(e); }
      S.busy.delete("web"); return draw();
    }
  }
}

async function loadReadme(key) {
  const e = detailOf(key); if (!e) return;
  S.readme[key] = undefined;
  try { S.readme[key] = (await api(`readme?key=${encodeURIComponent(key)}&source=${encodeURIComponent(e.source)}`)).markdown; }
  catch (err) { S.readme[key] = `取得できませんでした: ${err.message}`; }
  if (S.sel === key && S.dtab === "readme") draw();
}

async function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (tab === "installed") await loadInstalled();
  if (tab === "sources") { S.srcData = null; draw(); await loadSources(); }
  draw();
}

async function reinit() {
  const i = await api("init").catch(() => null);
  if (!i) return;
  S.facets = i.facets; S.favs = new Set(i.favs); S.pins = new Set(i.pins); S.cwd = i.cwd; S.theme = i.theme;
  $("#sub").textContent = `${i.total} 件の Canvas 拡張 ・ ${i.sources.length} ソース`;
}

// ---------- events ----------
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-a]");
  if (t) { ev.preventDefault(); ev.stopPropagation(); return void act(t.dataset.a, t).catch(fail); }
  const c = ev.target.closest(".card[data-key]");
  if (c) { S.sel = c.dataset.key; S.dtab = "about"; S.ack = false; draw(); }
});
document.addEventListener("change", (ev) => {
  if (ev.target.id === "ack") { S.ack = ev.target.checked; const b = document.querySelector('[data-a="install"]'); if (b) b.disabled = !S.ack; }
});
document.addEventListener("keydown", (ev) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (ev.key === "/" && !typing && S.tab === "search") { ev.preventDefault(); $("#q")?.focus(); }
  else if (ev.key === "Escape" && S.sel && !typing) { S.sel = null; draw(); }
  else if (ev.key === "Enter" && document.activeElement?.classList.contains("card") && document.activeElement.dataset.key) document.activeElement.click();
  else if (ev.key === "Enter" && ["addurl", "addid"].includes(document.activeElement?.id)) document.querySelector('[data-a="src-add"]')?.click();
  else if (ev.key === "Enter" && document.activeElement?.id === "webq") document.querySelector('[data-a="web-search"]')?.click();
});
$("#tabs").addEventListener("click", (ev) => { const b = ev.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
$("#theme").onchange = async (ev) => { S.theme = ev.target.value; document.documentElement.dataset.theme = S.theme; await api("theme", { theme: S.theme }).catch(fail); };
$("#about").onclick = () => {
  const d = $("#dlg");
  d.innerHTML = `<h3 style="margin-top:0">🥷 Agent Canvas Ninja</h3><p>Copilot App の Canvas 拡張を探し、リスクをレビューしてからインストールするアプリです。</p>
    <ul><li>インストールはコミット SHA を固定し、レビューした内容と同一であることを検証します</li><li>リスクレポートは<b>ヒューリスティック</b>であり、安全を保証しません</li><li>反映には拡張の再読み込みが必要です</li></ul>
    <p class="meta">Skills 版: <a href="https://github.com/aktsmm/copilot-app-extensions" target="_blank" rel="noopener noreferrer">aktsmm/copilot-app-extensions</a> ・ 作者: yamapan (<a href="https://github.com/aktsmm" target="_blank" rel="noopener noreferrer">@aktsmm</a>)<br>CC BY-NC-SA 4.0</p>
    <p><b>キー操作</b>: <kbd>/</kbd> 検索 ・ <kbd>Esc</kbd> 詳細を閉じる ・ <kbd>Enter</kbd> カードを開く</p><div class="row"><button data-d="x">閉じる</button></div>`;
  d.querySelector("[data-d]").onclick = () => d.close();
  d.showModal();
};

(async () => {
  await reinit();
  $("#theme").value = S.theme || "auto";
  draw();
  await Promise.all([fetchSearch(true), loadInstalled(), loadSources()]);
  draw();
})();
