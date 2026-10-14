// Local web UI for the Skill Ninja canvas. Bound to 127.0.0.1 and protected by a random token.
import http from "node:http";
import crypto from "node:crypto";
import {
  loadIndex, searchSkills, getFacets, findSkill, installSkill, uninstallSkill, listInstalled, checkUpdates,
  fetchSkillMd, describeSkill, getFavorites, toggleFavorite, getPins, togglePin, importFromVsCode, recommendSkills, projectContext,
  loadConfig, addSource, removeSource, refreshIndex, staleSources, STALE_DAYS, MAX_STALE_PER_RUN,
  installBundle, setLocalized, webSearchSkills, createSkill, syncUpstream,
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
<div class="tabs"><button id="t-search" class="on">探す</button><button id="t-rec">おすすめ</button><button id="t-inst">インストール済み <span id="n-inst"></span></button><button id="t-upd">更新</button><button id="t-src">ソース</button></div>
<div class="row"><input id="q" type="search" placeholder="キーワードで検索（例: pdf, azure, docx）" autofocus>
<span class="seg" title="インストール先"><button id="s-user" class="on">user</button><button id="s-project">project</button></span>
<span class="seg" title="説明の言語"><button id="l-ja" class="on">日本語</button><button id="l-en">EN</button></span></div>
<div class="row" id="filters"><select id="src"><option value="">すべてのソース</option></select><select id="cat"><option value="">すべてのカテゴリ</option></select><label><input id="favonly" type="checkbox" style="flex:none;min-width:0"> ★のみ</label></div>
<div class="meta" id="scopehelp" style="margin-top:6px"></div>
<div id="stalebar" class="row" style="display:none;background:#bf870022;border-radius:6px;padding:4px 8px"><span id="staletxt"></span><button id="stalego" class="primary">今すぐ更新</button><button id="stalex">後で</button></div>
</header>
<div id="list"></div><div id="toast"></div>
<script>
const T=new URLSearchParams(location.search).get("t");
const S={tab:"search",scope:"user",lang:"ja",offset:0,installed:[],busy:new Set(),confirm:null,updates:[],md:{},open:null,favs:new Set(),pins:new Set(),rec:[]};
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
function descOf(s){return (S.lang==="ja"&&s.description_ja)||s.description||""}
function card(s){
  const st=stateOf(s),sc=S.scope,fk=(s.source||"")+"/"+s.name,fav=S.favs.has(fk);
  const inst=S.installed.find(i=>i.dir===s.name&&i.scope===sc);
  const tags=(st.here?'<span class="tag ok">✓ '+sc+' にインストール済み</span>':st.other?'<span class="tag">'+(sc==="user"?"project":"user")+' に導入済み</span>':'')
    +(inst&&!inst.managed?'<span class="tag" title="Skill Ninja 以外で導入されたため更新を追跡しません">手動導入</span>':'')
    +(S.updates.some(u=>u.name===s.name&&u.scope===sc)?'<span class="tag upd">更新あり</span>':'')
    +(s.source?'<span class="tag">'+esc(s.source)+'</span>':'')+(s.categories||[]).slice(0,3).map(c=>'<span class="tag">#'+esc(c)+'</span>').join("");
  const dd=descOf(s);
  const noJa=S.lang==="ja"&&s.source&&!s.description_ja&&dd;
  const locRow=S.loc===fk?'<div class="row"><input id="locin" placeholder="日本語の要約を入力" value="">'+'<button data-a="loc-save" data-n="'+esc(s.name)+'" data-s="'+esc(s.source)+'" class="primary">保存</button><button data-a="loc-x">×</button></div>':'';
  const locLink=noJa?' · <a href="#" data-a="loc" data-n="'+esc(s.name)+'" data-s="'+esc(s.source)+'">日本語要約を追加</a>':'';
  const d=dd?esc(dd):(s.source?'<i data-desc="'+esc(s.name)+'" data-s="'+esc(s.source)+'">説明を取得中…</i>':'<i>説明なし</i>');
  const link=s.url?' <a href="'+esc(s.url)+'" target="_blank" rel="noopener">GitHub</a>':'';
  const star=s.source?'<button data-a="pin" data-n="'+esc(s.name)+'" data-s="'+esc(s.source)+'" title="ピン留め（先頭に表示）" style="border:0;background:none;padding:0 2px;font-size:14px;opacity:'+(S.pins.has(fk)?1:.35)+'">📌</button><button class="star" data-a="fav" data-n="'+esc(s.name)+'" data-s="'+esc(s.source)+'" title="お気に入り" style="border:0;background:none;padding:0 4px;font-size:16px;color:'+(fav?'#e3b341':'var(--mut)')+'">'+(fav?'★':'☆')+'</button>':'';
  const open=S.open===fk&&s.source;
  const prev=s.source?'<a href="#" data-a="prev" data-n="'+esc(s.name)+'" data-s="'+esc(s.source)+'">'+(open?'プレビューを閉じる':'SKILL.md をプレビュー')+'</a>':'';
  const pv=open?'<pre style="white-space:pre-wrap;max-height:260px;overflow:auto;border:1px solid var(--bd);border-radius:6px;padding:8px;font-size:12px;margin:6px 0 0">'+(S.md[fk]===undefined?'読み込み中…':esc(S.md[fk]))+'</pre>':'';
  return '<div class="card"><div class="main"><div class="name">'+star+esc(s.name)+link+'</div><div class="desc">'+d+'</div><div>'+tags+'</div><div class="meta" style="margin-top:4px">'+prev+locLink+'</div>'+locRow+pv+'</div><div class="act">'+actions(s)+'</div></div>';
}
function bind(items){
  document.querySelectorAll("[data-a]").forEach(b=>b.onclick=e=>{e.preventDefault();act(b.dataset.a,b.dataset.n,b.dataset.s,items)});
  fillDescriptions();
}
async function fillDescriptions(){
  const els=[...document.querySelectorAll("[data-desc]")].slice(0,12);
  for(const el of els){
    try{const r=await api("describe?name="+encodeURIComponent(el.dataset.desc)+"&source="+encodeURIComponent(el.dataset.s));
      const sk=view.find(v=>v.name===el.dataset.desc&&v.source===el.dataset.s);if(sk&&r.description)sk.description=r.description;
      if(el.isConnected)el.outerHTML=r.description?esc(r.description):"<i>説明なし</i>"}
    catch{if(el.isConnected)el.outerHTML="<i>説明なし</i>"}
  }
}
async function act(a,name,source){
  const sc=S.scope,k=key(name,sc),fk=source+"/"+name;
  if(a==="fav"){const r=await api("favorite",{name,source}).catch(e=>toast(e.message,"err"));if(r){r.on?S.favs.add(fk):S.favs.delete(fk);if(S.tab==="search"&&$("#favonly").checked&&!r.on)view=view.filter(v=>!(v.name===name&&v.source===source));draw()}return}
  if(a==="prev"){const tab0=S.tab;if(S.open===fk){S.open=null;return draw()}S.open=fk;draw();
    if(S.md[fk]===undefined){try{S.md[fk]=(await api("preview?name="+encodeURIComponent(name)+"&source="+encodeURIComponent(source))).markdown}catch(e){S.md[fk]="取得できませんでした: "+e.message}if(S.tab===tab0)draw()}return}
  if(a==="pin"){const r=await api("pin",{name,source}).catch(e=>toast(e.message,"err"));if(r){r.on?S.pins.add(fk):S.pins.delete(fk);if(S.tab==="search")return fetchSearch(false);draw()}return}
  if(a==="loc"){S.loc=fk;return draw()}
  if(a==="loc-x"){S.loc=null;return draw()}
  if(a==="loc-save"){const text=($("#locin")||{}).value||"";if(!text.trim())return toast("要約を入力してください","err");
    try{await api("localize",{source,name,text});const sk=[...view,...S.rec].find(v=>v.name===name&&v.source===source);if(sk)sk.description_ja=text.trim();S.loc=null;toast("日本語要約を保存しました","ok");draw()}catch(e){toast(e.message,"err")}return}
  if(a==="upd-all"){return updateAll()}
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
async function updateAll(){
  const targets=S.updates.filter(u=>u.scope===S.scope);let ok=0,ng=0;
  for(const u of targets){const k=key(u.name,u.scope);S.busy.add(k);draw();
    try{await api("install",{name:u.name,source:u.source,scope:u.scope,overwrite:true});ok++;S.updates=S.updates.filter(x=>x!==u)}catch(e){ng++}
    S.busy.delete(k)}
  await loadInstalled();draw();toast(ok+" 件を更新"+(ng?"、"+ng+" 件失敗":""),ng?"err":"ok");
}
async function drawSources(){
  const l=$("#list");l.innerHTML='<div class="empty"><span class="spin"></span>読み込み中…</div>';
  try{
    const [r,st,bd]=await Promise.all([api("sources"),api("stale"),api("bundles")]);
    const stale=new Map(st.items.map(x=>[x.id,x]));
    S.stale=st.items;
    const banner=st.items.length?'<div class="card" style="border-color:#bf8700"><div class="main"><b>'+st.items.length+' 個のソースが '+st.days+' 日以上再スキャンされていません</b><div class="meta">一度に最大 '+st.max+' 件まで、古い順に再スキャンします（GitHub のレート制限対策）。</div></div><div class="act"><button id="sstale" class="primary">古いソースを更新</button></div></div>':'<div class="meta">すべてのソースが '+st.days+' 日以内にスキャン済みです</div>';
    l.innerHTML=banner
      +'<h3 style="font-size:14px;margin:14px 0 4px">ソースを追加</h3><div class="row"><input id="sid" placeholder="ID（例: my-skills）" style="max-width:150px"><input id="surl" placeholder="https://github.com/owner/repo"><button id="sadd" class="primary">追加</button></div>'
      +'<div class="row"><input id="wq" placeholder="GitHub でスキル集を探す（例: azure）"><button id="wgo">Web 検索</button></div><div id="wres"></div>'
      +'<div class="row"><button id="simport">VS Code 版からインポート</button><button id="srefresh">全ソースを再スキャン</button></div><div class="meta">インポートは VS Code 版 Agent Skills Ninja のソース・スキャン済みスキルを取り込みます。</div>'
      +(bd.items.length?'<h3 style="font-size:14px;margin:14px 0 4px">バンドル（まとめてインストール）</h3>'+bd.items.map(b=>'<div class="card"><div class="main"><div class="name">'+esc(b.name)+'</div><div class="desc">'+esc((S.lang==="ja"&&b.description_ja)||b.description||"")+'</div><div class="meta">'+esc((b.skills||[]).join(", "))+'</div></div><div class="act"><button class="primary" data-bundle="'+esc(b.id)+'">'+S.scope+' に導入</button></div></div>').join(""):"")
      +'<h3 style="font-size:14px;margin:14px 0 4px">登録済みソース（'+r.items.length+'）</h3>'
      +r.items.map(s=>{const k=stale.get(s.id);return '<div class="card"><div class="main"><div class="name">'+esc(s.name)+'</div><div class="meta"><a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.url)+'</a></div><div>'+(k?'<span class="tag upd">'+(k.unknown?'未スキャン':k.days+' 日前にスキャン')+'</span>':'<span class="tag ok">最新</span>')+'</div></div><div class="act"><button data-scan="'+esc(s.id)+'">再スキャン</button>'+(s.removable?'<button class="danger" data-rm="'+esc(s.id)+'">削除</button>':'<span class="meta" style="text-align:center">標準</span>')+'</div></div>'}).join("");
    const scan=async(body,btn,label)=>{if(btn){btn.disabled=true;btn.textContent="スキャン中…"}try{const x=await api("refresh",body);toast("新規 "+x.added+" 件（"+x.scanned+" ソース）"+(x.errors.length?"、エラー "+x.errors.length+" 件":""),x.errors.length?"err":"ok");S.dirtyFacets=true;await refreshFacets();drawSources()}catch(e){toast(e.message,"err");if(btn){btn.disabled=false;btn.textContent=label}}};
    $("#sadd").onclick=async()=>{try{await api("source",{id:$("#sid").value.trim(),url:$("#surl").value.trim()});toast("ソースを追加しました","ok");drawSources()}catch(e){toast(e.message,"err")}};
    $("#simport").onclick=async()=>{const b=$("#simport");b.disabled=true;try{const x=await api("import",{});toast(x.files.length?"ソース "+x.sources.length+" 件・スキル "+x.skills+" 件を取り込みました":"VS Code 版のデータが見つかりませんでした",x.files.length?"ok":"err");if(x.files.length){await refreshFacets();drawSources()}}catch(e){toast(e.message,"err")}b.disabled=false};
    $("#srefresh").onclick=()=>scan({},$("#srefresh"),"全ソースを再スキャン");
    const ss=$("#sstale");if(ss)ss.onclick=()=>scan({stale:true},ss,"古いソースを更新");
    l.querySelectorAll("[data-scan]").forEach(b=>b.onclick=()=>scan({ids:[b.dataset.scan]},b,"再スキャン"));
    l.querySelectorAll("[data-rm]").forEach(b=>b.onclick=async()=>{try{await api("source-remove",{id:b.dataset.rm});drawSources()}catch(e){toast(e.message,"err")}});
    l.querySelectorAll("[data-bundle]").forEach(b=>b.onclick=async()=>{b.disabled=true;try{const x=await api("bundle-install",{id:b.dataset.bundle,scope:S.scope});const n=x.items.filter(i=>i.status==="installed").length;toast(n+" 件をインストール（"+x.items.length+" 件中）",n?"ok":"err");await loadInstalled()}catch(e){toast(e.message,"err")}b.disabled=false});
    $("#wgo").onclick=async()=>{const w=$("#wres");w.innerHTML='<div class="empty"><span class="spin"></span>検索中…</div>';try{const x=await api("websearch?q="+encodeURIComponent($("#wq").value));w.innerHTML=x.items.length?x.items.map((i,n)=>'<div class="card"><div class="main"><div class="name">'+esc(i.id)+' <span class="meta">★'+i.stars+'</span></div><div class="desc">'+esc(i.description)+'</div><div class="meta"><a href="'+esc(i.url)+'" target="_blank" rel="noopener">'+esc(i.url)+'</a></div></div><div class="act"><button data-wadd="'+n+'">ソースに追加</button></div></div>').join(""):'<div class="empty">見つかりませんでした</div>';
      w.querySelectorAll("[data-wadd]").forEach(b=>b.onclick=async()=>{const i=x.items[b.dataset.wadd];try{await api("source",{id:i.id,url:i.url});toast(i.id+" を追加しました。再スキャンでスキルを取り込めます","ok");drawSources()}catch(e){toast(e.message,"err")}})}catch(e){w.innerHTML='';toast(e.message,"err")}};
  }catch(e){l.innerHTML='<div class="empty err">'+esc(e.message)+'</div>'}
}
async function refreshFacets(){const f=await api("facets");$("#count").textContent=f.total+" skills";$("#src").innerHTML='<option value="">すべてのソース</option>'+f.sources.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+' ('+s.count+')</option>').join("")}
let view=[],total=0,searchSeq=0;
const KEEP=["#cname","#cdesc","#locin"];
function draw(){
  const keep=KEEP.map(s=>{const e=$(s);return e?[s,e.value,document.activeElement===e]:null}).filter(Boolean);
  render();
  for(const [s,v,f] of keep){const e=$(s);if(e){e.value=v;if(f)e.focus()}}
}
function render(){
  const l=$("#list");
  if(S.tab==="search"){
    if(!view.length){l.innerHTML='<div class="empty">該当するスキルがありません</div>';return}
    l.innerHTML='<div class="meta">'+total+' 件中 '+view.length+' 件を表示</div>'+view.map(card).join("")+(view.length<total?'<div class="row"><button id="more">さらに表示（残り '+(total-view.length)+'）</button></div>':"");
    const m=$("#more");if(m)m.onclick=()=>fetchSearch(true);
  }else if(S.tab==="rec"){
    l.innerHTML=S.rec.length?'<div class="meta">このプロジェクトの内容から選んだおすすめ（導入済みを除く）</div>'+S.rec.map(card).join(""):'<div class="empty">おすすめはありません</div>';
  }else if(S.tab==="inst"){
    const q=$("#q").value.toLowerCase();
    const items=S.installed.filter(i=>i.scope===S.scope&&(!q||(i.name+" "+i.description).toLowerCase().includes(q)))
      .sort((a,b)=>(S.pins.has(b.source+"/"+b.dir)-S.pins.has(a.source+"/"+a.dir))||String(b.installedAt||"").localeCompare(String(a.installedAt||""))||a.dir.localeCompare(b.dir));
    const form='<div class="row"><input id="cname" placeholder="新しいスキル名（例: my-skill）" style="max-width:200px"><input id="cdesc" placeholder="説明（任意）"><button id="cmk">'+S.scope+' に新規作成</button></div>';
    l.innerHTML=form+(items.length?'<div class="meta">'+S.scope+' に '+items.length+' 件（ピン → 新しい順）</div>'+items.map(i=>card({name:i.dir,description:i.description,categories:[],source:i.source})).join(""):'<div class="empty">'+S.scope+' にインストール済みのスキルはありません</div>');
    $("#cmk").onclick=async()=>{try{const r=await api("create",{name:$("#cname").value.trim(),description:$("#cdesc").value,scope:S.scope});if(r.status==="exists")return toast("同名のスキルが既にあります","err");toast("作成しました: "+r.dest,"ok");await loadInstalled();draw()}catch(e){toast(e.message,"err")}};
  }else if(S.tab==="src"){
    return drawSources();
  }else{
    const us=S.updates.filter(u=>u.scope===S.scope);
    l.innerHTML=us.length?'<div class="row"><button class="primary" data-a="upd-all">すべて更新（'+us.length+'）</button></div>'+us.map(u=>card({name:u.name,source:u.source,description:"上流の内容が変更されています",categories:[]})).join(""):'<div class="empty">'+S.scope+' に更新はありません（更新確認は Skill Ninja で導入したスキルが対象です）</div>';
  }
  bind();
}
async function fetchSearch(append){
  const seq=++searchSeq;if(!append){S.offset=0}
  if(!append)$("#list").innerHTML='<div class="empty"><span class="spin"></span>検索中…</div>';
  try{
    const p=new URLSearchParams({q:$("#q").value,source:$("#src").value,category:$("#cat").value,fav:$("#favonly").checked?"1":"",offset:append?view.length:0,limit:${PAGE}});
    const r=await api("search?"+p);if(seq!==searchSeq)return;
    view=append?view.concat(r.items):r.items;total=r.total;draw();
  }catch(e){if(seq===searchSeq){$("#list").innerHTML='<div class="empty err">'+esc(e.message)+'</div>';toast(e.message,"err")}}
}
async function show(tab){
  S.tab=tab;S.confirm=null;
  for(const k of["search","rec","inst","upd","src"])$("#t-"+k).className=tab===k?"on":"";
  $("#filters").style.display=tab==="search"?"flex":"none";
  if(tab==="search")return fetchSearch(false);
  if(tab==="src")return drawSources();
  if(tab==="rec"){$("#list").innerHTML='<div class="empty"><span class="spin"></span>プロジェクトを解析中…</div>';try{S.rec=(await api("recommend")).items}catch(e){toast(e.message,"err")}return draw()}
  if(tab==="inst"){$("#list").innerHTML='<div class="empty"><span class="spin"></span>読み込み中…</div>';await loadInstalled().catch(e=>toast(e.message,"err"));return draw()}
  $("#list").innerHTML='<div class="empty"><span class="spin"></span>上流の変更を確認中…</div>';
  try{S.updates=(await api("updates")).items}catch(e){toast(e.message,"err")}
  draw();
}
const SCOPE_HELP={user:"<b>user</b>: あなたの全プロジェクトで使えます（~/.copilot/skills）。個人用はこちら。",project:"<b>project</b>: このリポジトリだけで使えます（.github/skills）。コミットすればチームで共有できます。"};
function setScope(sc){S.scope=sc;$("#s-user").className=sc==="user"?"on":"";$("#s-project").className=sc==="project"?"on":"";$("#scopehelp").innerHTML=SCOPE_HELP[sc];draw()}
let deb;$("#q").oninput=()=>{clearTimeout(deb);deb=setTimeout(()=>S.tab==="search"?fetchSearch(false):draw(),250)};
$("#src").onchange=$("#cat").onchange=()=>fetchSearch(false);
$("#t-search").onclick=()=>show("search");$("#t-rec").onclick=()=>show("rec");$("#t-inst").onclick=()=>show("inst");$("#t-upd").onclick=()=>show("upd");$("#t-src").onclick=()=>show("src");
$("#s-user").onclick=()=>setScope("user");$("#s-project").onclick=()=>setScope("project");
function setLang(l){S.lang=l;$("#l-ja").className=l==="ja"?"on":"";$("#l-en").className=l==="en"?"on":"";draw()}
$("#l-ja").onclick=()=>setLang("ja");$("#l-en").onclick=()=>setLang("en");
$("#favonly").onchange=()=>fetchSearch(false);
document.addEventListener("keydown",e=>{if(e.key==="/"&&document.activeElement!==$("#q")){e.preventDefault();$("#q").focus()}});
(async()=>{
  try{
    const f=await api("facets");
    $("#count").textContent=f.total+" skills";
    $("#src").innerHTML+=f.sources.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+' ('+s.count+')</option>').join("");
    $("#cat").innerHTML+=f.categories.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.id)+' ('+c.count+')</option>').join("");
    if(f.categories.length<3)$("#cat").style.display="none";
    const fv=await api("favorites");S.favs=new Set(fv.items);S.pins=new Set(fv.pins);
    await loadInstalled();
  }catch(e){toast(e.message,"err")}
  setScope("user");
  api("stale").then(st=>{if(!st.items.length)return;$("#staletxt").textContent=st.items.length+" 個のソースが "+st.days+" 日以上未更新です";$("#stalebar").style.display="flex";
    $("#stalex").onclick=()=>$("#stalebar").style.display="none";
    $("#stalego").onclick=async()=>{const b=$("#stalego");b.disabled=true;b.textContent="更新中…";try{const x=await api("refresh",{stale:true});toast("新規 "+x.added+" 件（"+x.scanned+" ソース、最大 "+st.max+" 件ずつ）"+(x.errors.length?"、エラー "+x.errors.length+" 件":""),x.errors.length?"err":"ok");await refreshFacets();const n=await api("stale");if(n.items.length){$("#staletxt").textContent=n.items.length+" 個のソースが "+n.days+" 日以上未更新です";b.disabled=false;b.textContent="続けて更新"}else $("#stalebar").style.display="none"}catch(e){toast(e.message,"err");b.disabled=false;b.textContent="今すぐ更新"}}}).catch(()=>{});
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
      if (url.pathname === "/api/favorites") return json(res, 200, { items: await getFavorites(), pins: await getPins() });
      if (req.method === "POST" && url.pathname === "/api/favorite") {
        const b = await readBody(req);
        return json(res, 200, { on: await toggleFavorite(`${b.source}/${b.name}`) });
      }
      if (req.method === "POST" && url.pathname === "/api/pin") {
        const b = await readBody(req);
        return json(res, 200, { on: await togglePin(`${b.source}/${b.name}`) });
      }
      if (req.method === "POST" && url.pathname === "/api/import") {
        const r = await importFromVsCode();
        return json(res, 200, r);
      }
      if (url.pathname === "/api/recommend") {
        const installed = (await Promise.all(["user", "project"].map((s) => listInstalled(s, cwd)))).flat().map((r) => r.name);
        const items = recommendSkills(index, await projectContext(cwd), installed, 12);
        return json(res, 200, { items });
      }
      if (url.pathname === "/api/preview" || url.pathname === "/api/describe") {
        const hits = findSkill(index, q.get("name"), q.get("source") || undefined);
        if (hits.length !== 1) return json(res, 400, { error: "skill not found" });
        const src = index.sources.find((s) => s.id === hits[0].source);
        if (!src) return json(res, 400, { error: "unknown source" });
        if (url.pathname === "/api/describe") return json(res, 200, { description: await describeSkill(index, hits[0]) });
        return json(res, 200, { markdown: (await fetchSkillMd(src, hits[0])).slice(0, 20000), url: hits[0].url || `${src.url}/tree/${src.branch || "main"}/${hits[0].path}` });
      }
      if (url.pathname === "/api/sources") {
        const cfg = await loadConfig();
        const mine = new Set((cfg.sources ?? []).map((s) => s.id));
        return json(res, 200, { items: index.sources.map((s) => ({ id: s.id, name: s.name, url: s.url, removable: mine.has(s.id) })) });
      }
      if (req.method === "POST" && url.pathname === "/api/source") {
        const b = await readBody(req);
        await addSource({ id: String(b.id ?? ""), url: String(b.url ?? "") });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/source-remove") {
        const b = await readBody(req);
        return json(res, 200, { ok: await removeSource(String(b.id ?? "")) });
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        const b = await readBody(req).catch(() => ({}));
        await syncUpstream().catch(() => {});
        return json(res, 200, await refreshIndex(b.ids, b.stale ? { limit: MAX_STALE_PER_RUN } : {}));
      }
      if (url.pathname === "/api/stale") return json(res, 200, { items: await staleSources(index), days: STALE_DAYS, max: MAX_STALE_PER_RUN });
      if (url.pathname === "/api/bundles") return json(res, 200, { items: index.bundles });
      if (req.method === "POST" && url.pathname === "/api/bundle-install") {
        const b = await readBody(req);
        const r = await installBundle({ bundleId: String(b.id ?? ""), scope: scopeOf(b.scope), cwd, overwrite: false });
        if (r.some((x) => x.status === "installed")) await onChange();
        return json(res, 200, { items: r });
      }
      if (req.method === "POST" && url.pathname === "/api/localize") {
        const b = await readBody(req);
        await setLocalized(String(b.source ?? ""), String(b.name ?? ""), String(b.text ?? ""));
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/websearch") return json(res, 200, { items: await webSearchSkills(q.get("q") ?? "") });
      if (req.method === "POST" && url.pathname === "/api/create") {
        const b = await readBody(req);
        const r = await createSkill({ name: String(b.name ?? ""), description: b.description, scope: scopeOf(b.scope), cwd });
        if (r.status === "created") await onChange();
        return json(res, 200, r);
      }
      if (url.pathname === "/api/search") {
        const limit = Math.min(Math.max(parseInt(q.get("limit")) || PAGE, 1), 100);
        const offset = Math.max(parseInt(q.get("offset")) || 0, 0);
        const favs = new Set(await getFavorites());
        const pins = new Set(await getPins());
        const base = q.get("fav") === "1" ? { ...index, skills: index.skills.filter((s) => favs.has(`${s.source}/${s.name}`)) } : index;
        const opts = { source: q.get("source") || undefined, category: q.get("category") || undefined };
        const all = searchSkills(base, q.get("q") ?? "", 100000, opts).items;
        const pinned = all.filter((s) => pins.has(`${s.source}/${s.name}`));
        const sorted = pinned.length ? [...pinned, ...all.filter((s) => !pins.has(`${s.source}/${s.name}`))] : all;
        const mark = (s) => ({ ...s, fav: favs.has(`${s.source}/${s.name}`), pinned: pins.has(`${s.source}/${s.name}`) });
        return json(res, 200, { total: sorted.length, items: sorted.slice(offset, offset + limit).map(mark) });
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
