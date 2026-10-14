// Heuristic risk report for a Copilot extension / plugin folder. This is NOT a security verdict:
// code can hide behavior in dependencies, encoded strings or downloaded code.
// Findings carry ids + params only; the UI/tools localize them (see ui/i18n.js).
import crypto from "node:crypto";

const SEV = { info: 0, medium: 1, high: 2 };
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|COOKIE|PAT)\b/i;

const RULES = [
  { id: "child_process", sev: "high", re: /(?:from\s+|require\(\s*|import\(\s*)["'](?:node:)?child_process["']/ },
  { id: "spawn-call", sev: "high", re: /\b(?:execFile|execFileSync|execSync|spawnSync|spawn)\s*\(/ },
  { id: "eval", sev: "high", re: /\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*["'`]/ },
  { id: "dynamic-require", sev: "high", re: /\brequire\s*\(\s*(?:["'][^"']*["']\s*\+|[A-Za-z_$][\w$]*\s*[)+])|process\.binding\s*\(|process\.dlopen/ },
  { id: "auto-approve", sev: "high", re: /onPermissionRequest\s*:/ },
  { id: "env-dump", sev: "high", re: /process\.env\s*(?:\)|,|;|\}|$)|Object\.(?:keys|entries|values)\(\s*process\.env|\.\.\.\s*process\.env/m },
  { id: "dynamic-import", sev: "medium", re: /import\(\s*[^"'`\s)]/ },
  { id: "fs-write", sev: "medium", re: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmSync|rmdir|rename|renameSync|copyFile)\s*\(|\bfs(?:\.promises)?\.rm\s*\(/ },
  { id: "network", sev: "medium", re: /\bfetch\s*\(|globalThis\s*\.\s*fetch|(?:from\s+|require\(\s*|import\(\s*)["'](?:node:)?(?:https?|net|tls|dgram|http2)["']|new\s+WebSocket\s*\(|\bXMLHttpRequest\b/ },
  { id: "send-prompt", sev: "medium", re: /\bsession\.(?:send|sendAndWait)\s*\(/ },
  { id: "hooks", sev: "medium", re: /\bhooks\s*:\s*\{|\bonPreToolUse\b|\bonPostToolUse\b|\bonUserPromptSubmitted\b/ },
  { id: "obfuscation", sev: "medium", re: /[A-Za-z0-9+/]{400,}={0,2}|(?:\\x[0-9a-fA-F]{2}){24,}|\batob\s*\(|Buffer\.from\([^)]*["']base64["']/ },
];

const isText = (rel) => /\.(?:m?js|cjs|json|html?|css|md|txt|svg|ya?ml|sh|ps1|toml)$/i.test(rel) || !/\.[A-Za-z0-9]+$/.test(rel);
const isJs = (rel) => /\.(?:m?js|cjs)$/i.test(rel);
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

function metaFrom(extText) {
  const canvases = [];
  for (const m of extText.matchAll(/createCanvas\s*\(/g)) {
    const win = extText.slice(m.index, m.index + 2500);
    const pick = (k) => new RegExp(`\\b${k}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(win)?.[2];
    const id = pick("id");
    if (id) canvases.push({ id, displayName: pick("displayName") ?? id, description: pick("description") ?? "" });
  }
  const tools = new Set();
  for (const m of extText.matchAll(/\bname\s*:\s*["']([A-Za-z][A-Za-z0-9_.-]{2,63})["'][^]{0,600}?\bhandler\s*:/g)) tools.add(m[1]);
  const envVars = [];
  const env = /requestedEnvironmentVariables\s*:\s*\[([^\]]*)\]/.exec(extText);
  if (env) for (const s of env[1].matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) envVars.push(s[1]);
  const domains = [...new Set([...extText.matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?/g)].map((m) => m[1].toLowerCase()))].sort();
  return { canvases, tools: [...tools], envVars, domains };
}

export function metaOfExtension(text) {
  const m = metaFrom(text);
  return { canvasIds: m.canvases.map((c) => c.id), displayName: m.canvases[0]?.displayName, description: m.canvases[0]?.description, toolCount: m.tools.length };
}

function mcpCommands(files) {
  const out = [];
  for (const f of files) {
    if (!/(?:^|\/)\.?mcp(?:-servers)?\.json$|(?:^|\/)plugin\.json$/.test(f.rel)) continue;
    try {
      const j = JSON.parse(f.data.toString("utf8"));
      const servers = j.mcpServers ?? j.servers ?? (f.rel.endsWith("mcp.json") ? j : null);
      if (servers && typeof servers === "object") for (const [n, s] of Object.entries(servers)) if (s && typeof s === "object") out.push(`${n}: ${s.command ? [s.command, ...(s.args ?? [])].join(" ").slice(0, 80) : s.url ?? "remote"}`);
    } catch {}
  }
  return out;
}

/** files: [{ rel, data: Buffer }]; opts.kind: "extension" (default) | "plugin" */
export function analyzeFiles(files, { kind = "extension" } = {}) {
  const findings = [];
  const add = (f) => findings.push(f);
  const rels = files.map((f) => f.rel);
  const entries = files.filter((f) => (kind === "plugin" ? /(?:^|\/)extension\.mjs$/.test(f.rel) : f.rel === "extension.mjs"));
  if (!entries.length && kind === "extension") add({ id: "no-entry", sev: "high" });

  const meta = { canvases: [], tools: [], envVars: [], domains: [] };
  for (const e of entries) {
    const m = metaFrom(e.data.toString("utf8"));
    meta.canvases.push(...m.canvases);
    meta.tools.push(...m.tools);
    meta.envVars.push(...m.envVars);
    meta.domains.push(...m.domains);
  }
  meta.domains = [...new Set(meta.domains)].sort();

  for (const f of files) {
    if (!isText(f.rel)) {
      add({ id: "binary", sev: /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i.test(f.rel) ? "info" : "medium", file: f.rel });
      continue;
    }
    if (!isJs(f.rel)) continue;
    const text = f.data.toString("utf8");
    for (const r of RULES) {
      const m = r.re.exec(text);
      if (m) add({ id: r.id, sev: r.sev, file: f.rel, line: lineOf(text, m.index) });
    }
    if (!/\.min\./.test(f.rel) && text.split("\n").some((l) => l.length > 3000)) add({ id: "long-line", sev: "medium", file: f.rel });
  }

  for (const v of new Set(meta.envVars)) add({ id: "env-request", sev: SECRET_NAME.test(v) ? "high" : "medium", params: { v }, detail: v });
  if (meta.domains.length) add({ id: "domains", sev: "info", params: { list: meta.domains.slice(0, 12).join(", ") + (meta.domains.length > 12 ? " …" : "") } });

  const jsCount = rels.filter(isJs).length;
  if (jsCount > 1) add({ id: "multi-file", sev: "info", params: { n: jsCount } });

  if (kind === "plugin") {
    const cmds = mcpCommands(files);
    if (cmds.length) add({ id: "plugin-mcp", sev: "medium", params: { list: cmds.slice(0, 6).join("; ") } });
    if (rels.some((r) => /(?:^|\/)hooks(?:\.json|\/)/.test(r))) add({ id: "plugin-hooks", sev: "high" });
  }

  const pkg = files.find((f) => f.rel === "package.json");
  if (pkg) {
    try {
      const p = JSON.parse(pkg.data.toString("utf8"));
      const deps = Object.keys({ ...p.dependencies }).filter((d) => d !== "@github/copilot-sdk");
      if (deps.length && !rels.some((r) => r.startsWith("node_modules/"))) add({ id: "needs-npm", sev: "medium", params: { n: deps.length, list: deps.slice(0, 6).join(", ") } });
      if (p.scripts && Object.keys(p.scripts).some((k) => /^(?:pre|post)?install$|^prepare$/.test(k))) add({ id: "install-script", sev: "high" });
    } catch {
      add({ id: "bad-package-json", sev: "info" });
    }
  }

  const dedup = [];
  const seen = new Set();
  for (const f of findings) {
    const k = `${f.id}|${f.file ?? ""}|${f.detail ?? ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      dedup.push(f);
    }
  }
  dedup.sort((a, b) => SEV[b.sev] - SEV[a.sev]);
  const risk = dedup.some((f) => f.sev === "high") ? "high" : dedup.some((f) => f.sev === "medium") ? "medium" : "low";
  return { risk, findings: dedup, meta, treeHash: hashFiles(files), fileCount: files.length, bytes: files.reduce((n, f) => n + f.data.length, 0) };
}

export function hashFiles(files) {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    h.update(f.rel);
    h.update("\0");
    h.update(f.data);
    h.update("\0");
  }
  return h.digest("hex");
}

export const RISK_NOTE = "note";
