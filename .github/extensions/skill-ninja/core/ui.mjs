// Local web UI for the Skill Ninja canvas. Bound to 127.0.0.1 and protected by a random token.
import http from "node:http";
import crypto from "node:crypto";
import {
  loadIndex, searchSkills, findSkill, installSkill, uninstallSkill, listInstalled,
} from "./core.mjs";

const HTML = String.raw`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Skill Ninja</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;padding:12px;max-width:900px}
h1{font-size:18px;margin:0 0 8px}
.bar{display:flex;gap:6px;margin-bottom:8px}
input,select,button{font:inherit;padding:5px 8px}
input{flex:1}
.tabs button{margin-right:4px}.tabs button.on{font-weight:700;text-decoration:underline}
.item{border:1px solid #8884;border-radius:6px;padding:8px;margin:6px 0}
.item b{font-size:14px}.src{opacity:.6;font-size:12px;margin-left:6px}
.desc{font-size:13px;margin:4px 0;opacity:.85}
#msg{min-height:18px;font-size:13px;margin:4px 0}.err{color:#d33}
</style>
<h1>🥷 Skill Ninja</h1>
<div class="tabs"><button id="t-search" class="on">検索</button><button id="t-inst">インストール済み</button><button id="t-upd">更新確認</button></div>
<div class="bar"><input id="q" placeholder="キーワード（例: pdf, azure bicep）"><select id="scope"><option value="user">user</option><option value="project">project</option></select><button id="go">検索</button></div>
<div id="msg"></div><div id="list"></div>
<script>
const T=new URLSearchParams(location.search).get("t");let tab="search";
const $=s=>document.querySelector(s),msg=(t,e)=>{$("#msg").textContent=t;$("#msg").className=e?"err":""};
async function api(p,body){const r=await fetch("/api/"+p+(p.includes("?")?"&":"?")+"t="+T,body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function card(s,btn){return '<div class="item"><b>'+esc(s.name)+'</b><span class="src">'+esc(s.source||s.scope||"")+'</span><div class="desc">'+esc((s.description||"").slice(0,220))+'</div>'+btn+'</div>'}
async function render(){
  const l=$("#list");l.innerHTML="";
  try{
    if(tab==="search"){msg("検索中…");const r=await api("search?q="+encodeURIComponent($("#q").value));msg(r.total+" 件（上位 "+r.items.length+" 件）");
      l.innerHTML=r.items.map((s,i)=>card(s,'<button data-i="'+i+'" class="ins">Install</button>')).join("");
      l.querySelectorAll(".ins").forEach(b=>b.onclick=()=>install(r.items[b.dataset.i]));}
    else if(tab==="inst"){const r=await api("installed");msg(r.items.length+" 件");
      l.innerHTML=r.items.map((s,i)=>card(s,'<button data-i="'+i+'" class="del">Uninstall</button>')).join("");
      l.querySelectorAll(".del").forEach(b=>b.onclick=()=>remove(r.items[b.dataset.i]));}
    else{msg("確認中…");const r=await api("updates");msg(r.items.length?r.items.length+" 件に更新あり":"すべて最新です");
      l.innerHTML=r.items.map((s,i)=>card(s,'<button data-i="'+i+'" class="upd">Update</button>')).join("");
      l.querySelectorAll(".upd").forEach(b=>b.onclick=()=>install(r.items[b.dataset.i],true,r.items[b.dataset.i].scope));}
  }catch(e){msg(e.message,1)}
}
async function install(s,overwrite,scope){
  try{msg("インストール中…");const r=await api("install",{name:s.name,source:s.source,scope:scope||$("#scope").value,overwrite:!!overwrite});
    if(r.status==="exists"){if(confirm(s.name+" は既にあります。上書きしますか？"))return install(s,true,scope);return msg("キャンセル")}
    msg("インストール完了: "+r.dest)}catch(e){msg(e.message,1)}}
async function remove(s){if(!confirm(s.name+" ("+s.scope+") を削除しますか？"))return;
  try{await api("uninstall",{name:s.dir,scope:s.scope});msg("削除しました");render()}catch(e){msg(e.message,1)}}
function tabTo(t){tab=t;for(const k of["search","inst","upd"])$("#t-"+k).className=k===t?"on":"";render()}
$("#t-search").onclick=()=>tabTo("search");$("#t-inst").onclick=()=>tabTo("inst");$("#t-upd").onclick=()=>tabTo("upd");
$("#go").onclick=()=>tabTo("search");$("#q").onkeydown=e=>{if(e.key==="Enter")tabTo("search")};
render();
</script></html>`;

export async function startUiServer(getCwd) {
  const token = crypto.randomBytes(16).toString("hex");
  const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (c) => {
        s += c;
        if (s.length > 1e5) reject(new Error("body too large"));
      });
      req.on("end", () => resolve(s ? JSON.parse(s) : {}));
    });

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
      if (url.pathname === "/api/search") {
        const { total, items } = searchSkills(index, url.searchParams.get("q") ?? "", 30);
        return json(res, 200, { total, items });
      }
      if (url.pathname === "/api/installed") {
        const items = (await Promise.all(["user", "project"].map((s) => listInstalled(s, cwd)))).flat();
        return json(res, 200, { items });
      }
      if (url.pathname === "/api/updates") return json(res, 200, { items: await checkUpdates(index, cwd) });
      if (req.method === "POST" && url.pathname === "/api/install") {
        const b = await readBody(req);
        const hits = findSkill(index, b.name, b.source);
        if (hits.length !== 1) return json(res, 400, { error: hits.length ? "ambiguous skill" : "skill not found" });
        const src = index.sources.find((s) => s.id === hits[0].source);
        if (!src) return json(res, 400, { error: "unknown source" });
        const scope = b.scope === "project" ? "project" : "user";
        return json(res, 200, await installSkill({ skill: hits[0], source: src, scope, cwd, overwrite: !!b.overwrite }));
      }
      if (req.method === "POST" && url.pathname === "/api/uninstall") {
        const b = await readBody(req);
        return json(res, 200, await uninstallSkill({ name: b.name, scope: b.scope === "project" ? "project" : "user", cwd }));
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: String(e.message ?? e) });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, token, port: server.address().port };
}
