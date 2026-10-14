// Heuristic risk report for a Copilot extension folder. This is NOT a security verdict:
// extensions can hide behavior in dependencies, encoded strings or downloaded code.
import crypto from "node:crypto";

const SEV = { info: 0, medium: 1, high: 2 };
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|COOKIE|PAT)\b/i;

const RULES = [
  { id: "child_process", sev: "high", label: "外部プロセスを起動できる (child_process)", re: /(?:from\s+|require\(\s*|import\(\s*)["'](?:node:)?child_process["']/ },
  { id: "spawn-call", sev: "high", label: "コマンド実行らしき呼び出し (spawn/exec)", re: /\b(?:execFile|execFileSync|execSync|spawnSync|spawn)\s*\(/ },
  { id: "eval", sev: "high", label: "動的コード実行 (eval / new Function)", re: /\beval\s*\(|new\s+Function\s*\(/ },
  { id: "auto-approve", sev: "high", label: "権限要求を自動承認する可能性 (onPermissionRequest)", re: /onPermissionRequest\s*:/ },
  { id: "env-dump", sev: "high", label: "環境変数をまとめて参照 (process.env 全体)", re: /process\.env\s*(?:\)|,|;|\}|$)|Object\.(?:keys|entries|values)\(\s*process\.env|\.\.\.\s*process\.env/m },
  { id: "dynamic-import", sev: "medium", label: "動的 import（読み込み先が不定）", re: /import\(\s*[^"'`\s)]/ },
  { id: "fs-write", sev: "medium", label: "ファイルの書き込み・削除", re: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmSync|rmdir|rename|renameSync|copyFile)\s*\(|\bfs(?:\.promises)?\.rm\s*\(/ },
  { id: "network", sev: "medium", label: "外部ネットワークアクセス (fetch / http / WebSocket)", re: /\bfetch\s*\(|https?\.(?:request|get)\s*\(|new\s+WebSocket\s*\(|net\.(?:connect|createConnection)\s*\(/ },
  { id: "send-prompt", sev: "medium", label: "エージェントへメッセージを送る (session.send)", re: /\bsession\.(?:send|sendAndWait)\s*\(/ },
  { id: "hooks", sev: "medium", label: "フック（ツール実行やプロンプトへ介入）", re: /\bhooks\s*:\s*\{|\bonPreToolUse\b|\bonPostToolUse\b|\bonUserPromptSubmitted\b/ },
  { id: "obfuscation", sev: "medium", label: "難読化の疑い（長い base64 / 16 進エスケープ）", re: /[A-Za-z0-9+/]{400,}={0,2}|(?:\\x[0-9a-fA-F]{2}){24,}/ },
];

const isText = (rel) => /\.(?:m?js|cjs|json|html?|css|md|txt|svg|ya?ml)$/i.test(rel) || !/\.[A-Za-z0-9]+$/.test(rel);
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

/** files: [{ rel, data: Buffer }] */
export function analyzeFiles(files) {
  const findings = [];
  const add = (f) => findings.push(f);
  const rels = files.map((f) => f.rel);
  const entry = files.find((f) => f.rel === "extension.mjs");
  if (!entry) add({ id: "no-entry", sev: "high", label: "extension.mjs が見つかりません（インストールしても動作しません）" });

  let meta = { canvases: [], tools: [], envVars: [], domains: [] };
  if (entry) meta = metaFrom(entry.data.toString("utf8"));

  for (const f of files) {
    if (!isText(f.rel)) {
      add({ id: "binary", sev: "medium", label: "バイナリファイルを含みます", file: f.rel });
      continue;
    }
    if (!/\.(?:m?js|cjs)$/i.test(f.rel)) continue;
    const text = f.data.toString("utf8");
    for (const r of RULES) {
      const m = r.re.exec(text);
      if (m) add({ id: r.id, sev: r.sev, label: r.label, file: f.rel, line: lineOf(text, m.index) });
    }
    const longLine = text.split("\n").find((l) => l.length > 3000);
    if (longLine && !/\.min\./.test(f.rel)) add({ id: "long-line", sev: "medium", label: "極端に長い行（minify / 難読化の疑い）", file: f.rel });
  }

  for (const v of meta.envVars) {
    add({ id: "env-request", sev: SECRET_NAME.test(v) ? "high" : "medium", label: `環境変数 ${v} へのアクセスを要求`, detail: v });
  }
  if (meta.domains.length) add({ id: "domains", sev: "info", label: `コード中の接続先ドメイン: ${meta.domains.slice(0, 12).join(", ")}${meta.domains.length > 12 ? " …" : ""}` });

  const jsCount = rels.filter((r) => /\.(?:m?js|cjs)$/i.test(r)).length;
  if (jsCount > 1) add({ id: "multi-file", sev: "info", label: `実行可能な JS が ${jsCount} ファイル（すべて解析対象）` });

  const pkg = files.find((f) => f.rel === "package.json");
  if (pkg) {
    try {
      const p = JSON.parse(pkg.data.toString("utf8"));
      const deps = Object.keys({ ...p.dependencies });
      if (deps.length && !rels.some((r) => r.startsWith("node_modules/"))) {
        add({ id: "needs-npm", sev: "medium", label: `依存パッケージ ${deps.length} 件（${deps.slice(0, 6).join(", ")}）。インストール後に npm install が必要で、本アプリは実行しません` });
      }
      if (p.scripts && Object.keys(p.scripts).some((k) => /^(?:pre|post)?install$|^prepare$/.test(k))) {
        add({ id: "install-script", sev: "high", label: "package.json にインストール時スクリプトがあります" });
      }
    } catch {
      add({ id: "bad-package-json", sev: "info", label: "package.json を解析できませんでした" });
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

export const RISK_NOTE = "ヒューリスティックな静的解析です。安全性を保証するものではありません。依存パッケージ・難読化・実行時に取得するコードは検出できません。";
