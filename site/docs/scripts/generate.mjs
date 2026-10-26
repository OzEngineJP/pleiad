// コードから作る文書のページを組む（正本は core/。site/tools/build-site.mjs が、リリースのタグから取った写しか
// 作業ツリーの core/ を渡す）。今は「エージェント」の章の一覧だけ。
//
//     node scripts/generate.mjs [--agents <agents.mjs>] [--source <タグ|worktree>]
//
// 出力は src/content/docs/agents/index.mdx（日本語）と src/content/docs/en/agents/index.mdx（英語）。追跡しない。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const source = opt("source", "worktree");

const { AGENTS, DEFAULT_AGENT_IDS } = await import(pathToFileURL(agentsFile).href);

/** Markdown の表の 1 つのセルにする（| と改行を潰す） */
const cell = (value) => String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code = (value) => (value ? `\`${String(value).replace(/`/g, "")}\`` : "—");

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
  const from =
    source === "worktree"
      ? ja
        ? "この一覧は開発中の Pleiad の情報から自動で作っています。"
        : " This list is generated automatically from the development version of Pleiad."
      : ja
        ? `この一覧は Pleiad ${source} の情報から自動で作っています。`
        : ` This list is generated automatically from Pleiad ${source}.`;
  return [
    "---",
    `title: ${ja ? "エージェントの一覧" : "Agent reference"}`,
    `description: ${ja ? "Pleiad がつなげるエージェントの一覧です。" : "The agents Pleiad can connect to."}`,
    "---",
    "",
    `${lead}${from}`,
    "",
    ja ? "| エージェント | 実行ファイル | インストール |" : "| Agent | Executable | Install |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

for (const lang of ["ja", "en"]) {
  const dir = path.join(CONTENT, ...(lang === "ja" ? [] : [lang]), "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.mdx"), agentsPage(lang));
}
console.log(`generated agents (${source}): ${DEFAULT_AGENT_IDS.length} agents`);
