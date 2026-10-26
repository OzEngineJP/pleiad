// コードから作る文書のページを組む（正本は core/。site/tools/build-site.mjs が、リリースのタグから取った写しか
// 作業ツリーの core/ を渡す）。組むのは「エージェント」の章の一覧・エージェントごとのページと「リファレンス」の章。
//
//     node scripts/generate.mjs [--agents <agents.mjs>] [--snap <ops-surface.snap.json>] [--source <タグ|worktree>]
//
// 出力は src/content/docs/agents/・reference/（日本語）と src/content/docs/en/agents/・en/reference/（英語）。追跡しない。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseOpsSurface } from "../../tools/docs-features.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, "..");
const REPO = path.resolve(DOCS, "..", "..");
const CONTENT = path.join(DOCS, "src", "content", "docs");

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const agentsFile = path.resolve(opt("agents", path.join(REPO, "core", "backends", "agents.mjs")));
const snapFile = path.resolve(opt("snap", path.join(REPO, "tests", "ops-surface.snap.json")));
const source = opt("source", "worktree");

const { AGENTS, DEFAULT_AGENT_IDS } = await import(pathToFileURL(agentsFile).href);
const { ops, settings } = parseOpsSurface(fs.readFileSync(snapFile, "utf8"));

/** Markdown の表の 1 つのセルにする（| と改行を潰す） */
const cell = (value) => String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code = (value) => (value ? `\`${String(value).replace(/`/g, "")}\`` : "—");
const mark = (value) => (value ? "○" : "—");

const fromSource = (ja) =>
  source === "worktree"
    ? ja
      ? "この一覧は開発中の Pleiad の情報から自動で作っています。"
      : "This list is generated automatically from the development version of Pleiad."
    : ja
      ? `この一覧は Pleiad ${source} の情報から自動で作っています。`
      : `This list is generated automatically from Pleiad ${source}.`;

function agentsPage(lang) {
  const ja = lang === "ja";
  const rows = DEFAULT_AGENT_IDS.map((id) => {
    const agent = AGENTS[id];
    const cli = agent.cli;
    const name = agent.shortLabel ?? id;
    const install = cli?.installUrl ? `[${ja ? "インストール" : "Install"}](${cli.installUrl})` : "—";
    return `| ${cell(name)} | ${cell(code(cli?.exe))} | ${install} |`;
  });
  const lead = ja ? "Pleiad がつなげるエージェントの一覧です。" : "The agents Pleiad can connect to.";
  return [
    "---",
    `title: ${ja ? "エージェントの一覧" : "Agent reference"}`,
    `description: ${ja ? "Pleiad がつなげるエージェントの一覧です。" : "The agents Pleiad can connect to."}`,
    "---",
    "",
    `${lead}${fromSource(ja)}`,
    "",
    ja ? "| エージェント | 実行ファイル | インストール |" : "| Agent | Executable | Install |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** 操作の一覧（reference/ops）。名前空間ごとの見出し + 表（操作・画面・MCP・CLI・危険度） */
function opsPage(lang) {
  const ja = lang === "ja";
  const lines = [
    "---",
    `title: ${ja ? "操作の一覧" : "Operations"}`,
    `description: ${ja ? "Pleiad が画面・MCP・CLI へ出す操作の一覧です。" : "The operations Pleiad exposes over the UI, MCP, and CLI."}`,
    "---",
    "",
    ja ? "Pleiad が外へ出す操作（オペレーション）の一覧です。" : "The operations Pleiad exposes.",
    fromSource(ja),
    "",
    ja ? "「画面・MCP・CLI」は、その操作がどの口から使えるかです。" : "The UI / MCP / CLI columns show which surface exposes each operation.",
    "",
  ];
  const byNs = {};
  for (const [id, op] of Object.entries(ops)) (byNs[id.split(".")[0]] ??= []).push([id, op]);
  for (const ns of Object.keys(byNs).sort()) {
    lines.push(`## ${ns}`, "");
    lines.push(ja ? "| 操作 | 画面 | MCP | CLI | 危険度 |" : "| Operation | UI | MCP | CLI | Risk |", "| --- | --- | --- | --- | --- |");
    for (const [id, op] of byNs[ns].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| ${code(id)} | ${mark(op.surfaces?.ui)} | ${mark(op.surfaces?.mcp)} | ${mark(op.surfaces?.cli)} | ${cell(code(op.risk))} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** 設定の一覧（reference/settings）。キー・書き込めるか・危険度 */
function settingsPage(lang) {
  const ja = lang === "ja";
  const lines = [
    "---",
    `title: ${ja ? "設定の一覧" : "Settings"}`,
    `description: ${ja ? "Pleiad の設定の一覧です。" : "The settings Pleiad exposes."}`,
    "---",
    "",
    ja ? "Pleiad の設定の一覧です。" : "The settings Pleiad exposes.",
    fromSource(ja),
    "",
    ja ? "| キー | 変更できる | 危険度 |" : "| Key | Writable | Risk |",
    "| --- | --- | --- |",
  ];
  for (const key of Object.keys(settings).sort()) {
    const s = settings[key];
    lines.push(`| ${code(key)} | ${mark(s.writable)} | ${cell(code(s.risk))} |`);
  }
  lines.push("");
  return lines.join("\n");
}

for (const lang of ["ja", "en"]) {
  const base = path.join(CONTENT, ...(lang === "ja" ? [] : [lang]));
  const agentsDir = path.join(base, "agents");
  const refDir = path.join(base, "reference");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "index.mdx"), agentsPage(lang));
  fs.writeFileSync(path.join(refDir, "ops.mdx"), opsPage(lang));
  fs.writeFileSync(path.join(refDir, "settings.mdx"), settingsPage(lang));
}
console.log(`generated (${source}): ${DEFAULT_AGENT_IDS.length} agents, ${Object.keys(ops).length} ops, ${Object.keys(settings).length} settings`);
