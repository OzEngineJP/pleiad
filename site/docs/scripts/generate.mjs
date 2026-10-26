// コードから作る文書のページを組む（正本は core/。site/tools/build-site.mjs が、リリースのタグから取った写しか
// 作業ツリーの core/ を渡す）。
//
//     node scripts/generate.mjs [--core <core/backends のディレクトリ>] [--snap <ops-surface.snap.json|none>] [--source <タグ|worktree>]
//
// 出力（追跡しない）:
//   src/content/docs/agents/index.mdx・src/content/docs/en/agents/index.mdx … エージェントの一覧
//   src/content/docs/agents/<id>.mdx・src/content/docs/en/agents/<id>.mdx … できること・できないこと・対応予定
//   src/content/docs/reference/{ops,settings}.mdx（英語は en/reference/）… 操作の一覧・設定の一覧（tests/ops-surface.snap.json から）
//
// エージェントごとのページは、core/backends/capability-marks.mjs（印の説明）と core/backends/agent-marks.mjs（状態）が
// あるときだけ作る。古いタグ（v0.40.0 など）には無いので、そのときは一覧だけを作る（ビルドを落とさない）。
// 手で書く「つなぎ方」は src/content/docs/agents/<id>/_connect.md（英語は en/agents/<id>/_connect.md）に置くと、
// ページの本文の先頭に入る。無ければ空。_ で始まるファイルは Astro の content に読まれない。
// 性質（traits。能力ではない）はページにも一覧にも出さない（ADR 0274）。
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

const coreDir = path.resolve(opt("core", path.join(REPO, "core", "backends")));
const source = opt("source", "worktree");
const agentsFile = path.join(coreDir, "agents.mjs");
const marksFile = path.join(coreDir, "capability-marks.mjs");
const statesFile = path.join(coreDir, "agent-marks.mjs");
// 操作・設定の一覧の元（tests/ops-surface.snap.json）。--snap none か無いファイルなら、リファレンスの章を作らない
const snapOpt = opt("snap", path.join(REPO, "tests", "ops-surface.snap.json"));
const snapFile = snapOpt === "none" ? null : path.resolve(snapOpt);

const { AGENTS, DEFAULT_AGENT_IDS } = await import(pathToFileURL(agentsFile).href);
const marks = fs.existsSync(marksFile) ? await import(pathToFileURL(marksFile).href) : null;
const states = fs.existsSync(statesFile) ? await import(pathToFileURL(statesFile).href) : null;
// 印の説明と状態がそろっているときだけ、エージェントごとのページを作る
const perAgent = Boolean(marks?.CAPABILITY_KEYS?.length && marks?.CAPABILITY_DOCS && marks?.isCapabilityState
  && states?.CAPABILITY_STATES && states?.AGENT_TRAITS);

/** Markdown の表の 1 つのセルにする（| と改行を潰す） */
const cell = (value) => String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code = (value) => (value ? `\`${String(value).replace(/`/g, "")}\`` : "—");
const mark = (value) => (value ? "○" : "—");
const surface = snapFile && fs.existsSync(snapFile) ? parseOpsSurface(fs.readFileSync(snapFile, "utf8")) : null;
const isJa = (lang) => lang === "ja";

function sourceNote(lang, what) {
  const ja = isJa(lang);
  if (source === "worktree") {
    return ja ? `この${what}は開発中の Pleiad の情報から自動で作っています。` : `This ${what} is generated automatically from the development version of Pleiad.`;
  }
  return ja ? `この${what}は Pleiad ${source} の情報から自動で作っています。` : `This ${what} is generated automatically from Pleiad ${source}.`;
}

function agentsPage(lang) {
  const ja = isJa(lang);
  const rows = DEFAULT_AGENT_IDS.map((id) => {
    const agent = AGENTS[id];
    const cli = agent.cli;
    const name = agent.shortLabel ?? id;
    const install = cli?.installUrl ? `[${ja ? "インストール" : "Install"}](${cli.installUrl})` : "—";
    const page = perAgent ? ` [${ja ? "できること" : "Capabilities"}](./${id}/) |` : "";
    return `| ${cell(name)} | ${cell(code(cli?.exe))} | ${install} |${page}`;
  });
  const lead = ja ? "Pleiad がつなげるエージェントの一覧です。" : "The agents Pleiad can connect to.";
  return [
    "---",
    `title: ${JSON.stringify(ja ? "エージェントの一覧" : "Agent reference")}`,
    `description: ${JSON.stringify(lead)}`,
    "---",
    "",
    `${lead}${ja ? "" : " "}${sourceNote(lang, ja ? "一覧" : "list")}`,
    "",
    ja ? `| エージェント | 実行ファイル | インストール |${perAgent ? " ページ |" : ""}` : `| Agent | Executable | Install |${perAgent ? " Page |" : ""}`,
    ja ? `| --- | --- | --- |${perAgent ? " --- |" : ""}` : `| --- | --- | --- |${perAgent ? " --- |" : ""}`,
    ...rows,
    "",
  ].join("\n");
}

/** 印の値の補足（値ごとの文があればそれ、無ければ短い説明） */
function capabilityText(doc, value, lang) {
  const key = typeof value === "string" ? value : value === true ? "true" : value?.images;
  return (key != null ? doc.values?.[key]?.[lang] : null) ?? doc.summary[lang];
}

function agentPage(lang, id) {
  const ja = isJa(lang);
  const agent = AGENTS[id];
  const name = agent.shortLabel ?? id;
  const caps = states.CAPABILITY_STATES[id] ?? {};
  const docs = marks.CAPABILITY_DOCS;
  const works = [];
  const cannot = [];
  const planned = [];
  for (const key of marks.CAPABILITY_KEYS) {
    const value = caps[key];
    const doc = docs[key];
    if (!doc) continue;
    if (marks.isCapabilityState(value)) {
      if (value.state === "covered") works.push(`- **${doc.label[lang]}** — ${doc.summary[lang]}${ja ? "（Pleiad が補います）" : " (Pleiad provides this)"}`);
      else if (value.state === "impossible") cannot.push(`- **${doc.label[lang]}** — ${doc.unavailable[lang]}`);
      else if (value.state === "todo") planned.push(`- **${doc.label[lang]}** — ${ja ? "対応予定" : "Planned"}`);
      continue;
    }
    // 承認モードが「確認なし」だけのエージェントは、できることではなく「できないこと」に出す
    if (key === "approvals" && value === "none") {
      cannot.push(`- **${doc.label[lang]}** — ${capabilityText(doc, value, lang)}`);
      continue;
    }
    works.push(`- **${doc.label[lang]}** — ${capabilityText(doc, value, lang)}`);
  }
  const fragmentFile = path.join(CONTENT, ...(ja ? [] : [lang]), "agents", id, "_connect.md");
  // 断片の頭の <!-- --> は書く人への注記。ページは MDX で HTML のコメントを読めないので外す
  const fragment = fs.existsSync(fragmentFile) ? fs.readFileSync(fragmentFile, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";
  const description = ja ? `${name} でできること・できないこと` : `What ${name} can and cannot do`;
  const body = [
    "---",
    `title: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    sourceNote(lang, ja ? "ページ" : "page"),
    "",
  ];
  if (fragment) body.push(fragment, "");
  if (works.length) body.push(`## ${ja ? "できること" : "What it can do"}`, "", ...works, "");
  if (cannot.length) body.push(`## ${ja ? "できないこと" : "What it cannot do"}`, "", ...cannot, "");
  if (planned.length) body.push(`## ${ja ? "対応予定" : "Planned"}`, "", ...planned, "");
  body.push(`[${ja ? "エージェントの一覧に戻る" : "Back to the agent list"}](../)`, "");
  return body.join("\n");
}

/** 操作の一覧（reference/ops）。名前空間ごとの見出し + 表（操作・画面・MCP・CLI・危険度） */
function opsPage(lang) {
  const ja = isJa(lang);
  const lines = [
    "---",
    `title: ${JSON.stringify(ja ? "操作の一覧" : "Operations")}`,
    `description: ${JSON.stringify(ja ? "Pleiad が画面・MCP・CLI へ出す操作の一覧です。" : "The operations Pleiad exposes over the UI, MCP, and CLI.")}`,
    "---",
    "",
    `${ja ? "Pleiad が外へ出す操作（オペレーション）の一覧です。" : "The operations Pleiad exposes."}${ja ? "" : " "}${sourceNote(lang, ja ? "一覧" : "list")}`,
    "",
    ja ? "「画面・MCP・CLI」は、その操作がどの口から使えるかです。" : "The UI / MCP / CLI columns show which surface exposes each operation.",
    "",
  ];
  const byNs = {};
  for (const [id, op] of Object.entries(surface.ops)) (byNs[id.split(".")[0]] ??= []).push([id, op]);
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
  const ja = isJa(lang);
  const lines = [
    "---",
    `title: ${JSON.stringify(ja ? "設定の一覧" : "Settings")}`,
    `description: ${JSON.stringify(ja ? "Pleiad の設定の一覧です。" : "The settings Pleiad exposes.")}`,
    "---",
    "",
    `${ja ? "Pleiad の設定の一覧です。" : "The settings Pleiad exposes."}${ja ? "" : " "}${sourceNote(lang, ja ? "一覧" : "list")}`,
    "",
    ja ? "| キー | 変更できる | 危険度 |" : "| Key | Writable | Risk |",
    "| --- | --- | --- |",
  ];
  for (const key of Object.keys(surface.settings).sort()) {
    const s = surface.settings[key];
    lines.push(`| ${code(key)} | ${mark(s.writable)} | ${cell(code(s.risk))} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** 前の回に作ったページを消す（手書きの断片は agents/<id>/ の下なので消えない） */
function cleanGenerated(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".mdx") && name !== "index.mdx") fs.rmSync(path.join(dir, name));
  }
}

for (const lang of ["ja", "en"]) {
  const dir = path.join(CONTENT, ...(lang === "ja" ? [] : [lang]), "agents");
  fs.mkdirSync(dir, { recursive: true });
  cleanGenerated(dir);
  fs.writeFileSync(path.join(dir, "index.mdx"), agentsPage(lang));
  if (!perAgent) continue;
  for (const id of DEFAULT_AGENT_IDS) fs.writeFileSync(path.join(dir, `${id}.mdx`), agentPage(lang, id));
}
for (const lang of ["ja", "en"]) {
  const dir = path.join(CONTENT, ...(lang === "ja" ? [] : [lang]), "reference");
  if (!surface) {
    fs.rmSync(dir, { recursive: true, force: true });
    continue;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ops.mdx"), opsPage(lang));
  fs.writeFileSync(path.join(dir, "settings.mdx"), settingsPage(lang));
}
console.log(`generated (${source}): ${DEFAULT_AGENT_IDS.length} agents${perAgent ? " with pages" : " (list only)"}`
  + (surface ? `, ${Object.keys(surface.ops).length} ops, ${Object.keys(surface.settings).length} settings` : ", no reference"));
