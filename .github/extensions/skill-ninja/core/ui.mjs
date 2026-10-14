// Local web UI for the Skill Ninja canvas. Bound to 127.0.0.1 and protected by a random token.
import http from "node:http";
import crypto from "node:crypto";
import {
  loadIndex, searchSkills, getFacets, findSkill, installSkill, uninstallSkill, listInstalled, checkUpdates,
} from "./core.mjs";

const PAGE = 24;

const HTML = String.raw`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill Ninja</title>
<style>
:root{color-scheme:light dark;--bd:#8884;--mut:#8a8a8a;--ac:#2f81f7;--ok:#2da44e;--bad:#d1242f;font-family:system-ui,"Segoe UI",sans-serif;font-size:14px}
*{box-sizing:border-box}
body{margin:0;padding:0 14px 40px}
header{position:sticky;top:0;background:Canvas;padding:12px 0 8px;z-index:5;border-bottom:1px solid var(--bd)}
h1{font-size:17px;margin:0 0 8px;display:flex;align-items:center;gap:8px}
h1 small{font-weight:400;color:var(--mut);font-size:12px}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}
input,select,button{font:inherit;padding:6px 10px;border:1px solid var(--bd);border-radius:6px;background:Field;color:FieldText}
input{flex:1;min-width:160px}
button{cursor:pointer}button:hover:not(:disabled){border-color:var(--ac)}button:disabled{opacity:.5;cursor:default}
.tabs{display:flex;gap:2px}.tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;padding:6px 12px}
.tabs button.on{border-bottom-color:var(--ac);font-weight:600}
.seg{display:inline-flex}.seg button{border-radius:0}.seg button:first-child{border-radius:6px 0 0 6px}.seg button:last-child{border-radius:0 6px 6px 0;border-left:0}
.seg button.on{background:var(--ac);color:#fff;border-color:var(--ac)}
.primary{background:var(--ac);color:#fff;border-color:var(--ac)}
.danger{color:var(--bad)}
.card{border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin:8px 0;display:flex;gap:12px;align-items:flex-start}
.card .main{flex:1;min-width:0}
.name{font-weight:600;font-size:14px;word-break:break-all}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid var(--bd);color:var(--mut);margin:0 4px 0 0}
.tag.ok{color:var(--ok);border-color:var(--ok)}.tag.upd{color:#bf8700;border-color:#bf8700}
.desc{margin:4px 0;color:var(--mut);font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.act{display:flex;flex-direction:column;gap:4px;align-items:stretch;min-width:92px}
.meta{font-size:12px;color:var(--mut)}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}
#toast{position:fixed;left:14px;right:14px;bottom:12px;padding:8px 12px;border-radius:8px;background:#1f2328;color:#fff;display:none;z-index:9;font-size:13px}
#toast.err{background:var(--bad)}#toast.ok{background:var(--ok)}
.empty{padding:30px;text-align:center;color:var(--mut)}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--bd);border-top-color:var(--ac);border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes s{to{transform:rotate(360deg)}}
</style>
<header>
<h1>🥷 Skill Ninja <small id="count"></small></h1>
<div class="tabs"><button id="t-search" class="on">探す</button><button id="t-inst">インストール済み <span id="n-inst"></span></button><button id="t-upd">更新</button></div>
<div class="row"><input id="q" type="search" placeholder="キーワードで検索（例: pdf, azure, docx）" autofocus>
<span class="seg" title="インストール先"><button id="s-user" class="on">user</button><button id="s-project">project</button></span></div>
<div class="row" id="filters"><select id="src"><option value="">すべてのソース</option></select><select id="cat"><option value="">すべてのカテゴリ</option></select></div>
</header>
<div id="list"></div><div id="toast"></div>
<script>
const T=new URLSearchParams(location.search).get("t");
const S={tab:"search",scope:"user",offset:0,installed:[],busy:new Set(),confirm:null,updates:[]};
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let tt;function toast(m,k){const t=$("#toast");t.textContent=m;t.className=k||"";t.style.display="block";clearTimeout(tt);tt=setTimeout(()=>t.style.display="none",k==="err"?6000:3000)}
async function api(p,body){const r=await fetch("/api/"+p+(p.includes("?")?"&":"?")+"t="+T,body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j}
const isInst=(name,scope)=>S.installed.some(i=>i.dir===name&&i.scope===scope);
const key=(n,sc)=>n+"|"+sc;
async function loadInstalled(){S.installed=(await api("installed")).items;$("#n-inst").textContent=S.installed.length?"("+S.installed.length+")":""}
function stateOf(s){const here=isInst(s.name,S.scope),other=isInst(s.name,S.scope==="user"?"project":"user");return{here,other}}
function actions(s){
  const sc=S.scope,k=key(s.name,sc),busy=S.busy.has(k);
  if(busy)return '<button disabled><span class="spin"></span>処理中</button>';
  const st=stateOf(s);
  if(S.confirm===k)return '<button class="danger" data-a="del-yes" data-n="'+esc(s.name)+'">本当に削除</button><button data-a="del-no">キャンセル</button>';
  const upd=S.updates.some(u=>u.name===s.name&&u.scope===sc);
  if(st.here)return (upd?'<button class="primary" data-a="update" data-n="'+esc(s.name)+'" data-s="'+esc(s.source||"")+'">更新</button>':'')+'<button class="danger" data-a="del" data-n="'+esc(s.name)+'">削除</button>';
  return '<button class="primary" data-a="install" data-n="'+esc(s.name)+'" data-s="'+esc(s.source||"")+'">インストール</button>';
}
function card(s){
  const st=stateOf(s),sc=S.scope;
  const tags=(st.here?'<span class="tag ok">✓ '+sc+' にインストール済み</span>':st.other?'<span class="tag">'+(sc==="user"?"project":"user")+' に導入済み</span>':'')
    +(S.updates.some(u=>u.name===s.name&&u.scope===sc)?'<span class="tag upd">更新あり</span>':'')
    +(s.source?'<span class="tag">'+esc(s.source)+'</span>':'')+(s.categories||[]).slice(0,3).map(c=>'<span class="tag">#'+esc(c)+'</span>').join("");
  const d=s.description?esc(s.description):'<i>説明なし</i>';
  const link=s.url?' <a href="'+esc(s.url)+'" target="_blank" rel="noopener">GitHub</a>':'';
  return '<div class="card"><div class="main"><div class="name">'+esc(s.name)+link+'</div><div class="desc">'+d+'</div><div>'+tags+'</div></div><div class="act">'+actions(s)+'</div></div>';
}
function bind(items){
  document.querySelectorAll("[data-a]").forEach(b=>b.onclick=()=>act(b.dataset.a,b.dataset.n,b.dataset.s,items));
}
async function act(a,name,source){
  const sc=S.scope,k=key(name,sc);
  if(a==="del"){S.confirm=k;return draw()}
  if(a==="del-no"){S.confirm=null;return draw()}
  S.confirm=null;S.busy.add(k);draw();
  try{
    if(a==="del-yes"){await api("uninstall",{name,scope:sc});toast(name+" を削除しました","ok")}
    else{const r=await api("install",{name,source,scope:sc,overwrite:a==="update"});toast(name+(a==="update"?" を更新しました":" をインストールしました"),"ok");if(r.status==="exists")toast(name+" は既に存在します")}
    await loadInstalled();
    S.updates=S.updates.filter(u=>!(u.name===name&&u.scope===sc));
  }catch(e){toast(name+": "+e.message,"err")}
  S.busy.delete(k);draw();
}
let view=[],total=0,searchSeq=0;
function draw(){
  const l=$("#list");
  if(S.tab==="search"){
    if(!view.length){l.innerHTML='<div class="empty">該当するスキルがありません</div>';return}
    l.innerHTML='<div class="meta">'+total+' 件中 '+view.length+' 件を表示</div>'+view.map(card).join("")+(view.length<total?'<div class="row"><button id="more">さらに表示（残り '+(total-view.length)+'）</button></div>':"");
    const m=$("#more");if(m)m.onclick=()=>fetchSearch(true);
  }else if(S.tab==="inst"){
    const q=$("#q").value.toLowerCase();
    const items=S.installed.filter(i=>i.scope===S.scope&&(!q||(i.name+" "+i.description).toLowerCase().includes(q)));
    l.innerHTML=items.length?'<div class="meta">'+S.scope+' に '+items.length+' 件</div>'+items.map(i=>card({name:i.dir,description:i.description,categories:[]})).join(""):'<div class="empty">'+S.scope+' にインストール済みのスキルはありません</div>';
  }else{
    l.innerHTML=S.updates.length?S.updates.filter(u=>u.scope===S.scope).map(u=>card({name:u.name,source:u.source,description:"上流の内容が変更されています",categories:[]})).join("")||'<div class="empty">'+S.scope+' に更新はありません</div>':'<div class="empty">更新はありません（更新確認はインストール時の記録があるスキルが対象です）</div>';
  }
  bind();
}
async function fetchSearch(append){
  const seq=++searchSeq;if(!append){S.offset=0}
  if(!append)$("#list").innerHTML='<div class="empty"><span class="spin"></span>検索中…</div>';
  try{
    const p=new URLSearchParams({q:$("#q").value,source:$("#src").value,category:$("#cat").value,offset:append?view.length:0,limit:${PAGE}});
    const r=await api("search?"+p);if(seq!==searchSeq)return;
    view=append?view.concat(r.items):r.items;total=r.total;draw();
  }catch(e){if(seq===searchSeq){$("#list").innerHTML='<div class="empty err">'+esc(e.message)+'</div>';toast(e.message,"err")}}
}
async function show(tab){
  S.tab=tab;S.confirm=null;
  for(const [k,v] of [["search","search"],["inst","inst"],["upd","upd"]])$("#t-"+k).className=tab===v?"on":"";
  $("#filters").style.display=tab==="search"?"flex":"none";
  if(tab==="search")return fetchSearch(false);
  if(tab==="inst"){$("#list").innerHTML='<div class="empty"><span class="spin"></span>読み込み中…</div>';await loadInstalled().catch(e=>toast(e.message,"err"));return draw()}
  $("#list").innerHTML='<div class="empty"><span class="spin"></span>上流の変更を確認中…</div>';
  try{S.updates=(await api("updates")).items}catch(e){toast(e.message,"err")}
  draw();
}
function setScope(sc){S.scope=sc;$("#s-user").className=sc==="user"?"on":"";$("#s-project").className=sc==="project"?"on":"";draw()}
let deb;$("#q").oninput=()=>{clearTimeout(deb);deb=setTimeout(()=>S.tab==="search"?fetchSearch(false):draw(),250)};
$("#src").onchange=$("#cat").onchange=()=>fetchSearch(false);
$("#t-search").onclick=()=>show("search");$("#t-inst").onclick=()=>show("inst");$("#t-upd").onclick=()=>show("upd");
$("#s-user").onclick=()=>setScope("user");$("#s-project").onclick=()=>setScope("project");
(async()=>{
  try{
    const f=await api("facets");
    $("#count").textContent=f.total+" skills";
    $("#src").innerHTML+=f.sources.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+' ('+s.count+')</option>').join("");
    $("#cat").innerHTML+=f.categories.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.id)+' ('+c.count+')</option>').join("");
    if(f.categories.length<3)$("#cat").style.display="none";
    await loadInstalled();
  }catch(e){toast(e.message,"err")}
  fetchSearch(false);
})();
</script></html>`;

export async function startUiServer(getCwd, onChange = async () => {}) {
  const token = crypto.randomBytes(16).toString("hex");
  const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (c) => {
        s += c;
        if (s.length > 1e5) reject(new Error("body too large"));
      });
      req.on("end", () => {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch {
          reject(new Error("invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  const scopeOf = (v) => (v === "project" ? "project" : "user");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.searchParams.get("t") !== token) return json(res, 403, { error: "forbidden" });
      const cwd = getCwd();
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(HTML);
      }
      const index = await loadIndex();
      const q = url.searchParams;
      if (url.pathname === "/api/facets") return json(res, 200, { ...getFacets(index), total: index.skills.length });
      if (url.pathname === "/api/search") {
        const limit = Math.min(Math.max(parseInt(q.get("limit")) || PAGE, 1), 100);
        const offset = Math.max(parseInt(q.get("offset")) || 0, 0);
        const r = searchSkills(index, q.get("q") ?? "", limit, {
          source: q.get("source") || undefined,
          category: q.get("category") || undefined,
          offset,
        });
        return json(res, 200, r);
      }
      if (url.pathname === "/api/installed") {
        const items = (await Promise.all(["user", "project"].map((s) => listInstalled(s, cwd)))).flat();
        return json(res, 200, { items });
      }
      if (url.pathname === "/api/updates") return json(res, 200, { items: await checkUpdates(index, cwd) });
      if (req.method === "POST" && url.pathname === "/api/install") {
        const b = await readBody(req);
        const hits = findSkill(index, b.name, b.source || undefined);
        if (hits.length !== 1) return json(res, 400, { error: hits.length ? "ambiguous skill" : "skill not found" });
        const src = index.sources.find((s) => s.id === hits[0].source);
        if (!src) return json(res, 400, { error: "unknown source" });
        const r = await installSkill({ skill: hits[0], source: src, scope: scopeOf(b.scope), cwd, overwrite: !!b.overwrite });
        if (r.status === "installed") await onChange();
        return json(res, 200, r);
      }
      if (req.method === "POST" && url.pathname === "/api/uninstall") {
        const b = await readBody(req);
        const r = await uninstallSkill({ name: b.name, scope: scopeOf(b.scope), cwd });
        if (r.status === "removed") await onChange();
        return json(res, 200, r);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: String(e.message ?? e) });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, token, port: server.address().port };
}
