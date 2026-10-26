// 公開リファレンス（site/docs）向けの「利用者に見える機能」の一覧を、コードの写しから作る。
// 正本はコード。作る先:
//   - tests/unit/docs-coverage.mjs   機能と載せるページの対応表（site/docs/docs-coverage.json）の検査
//   - scripts/release-bump.mjs       前の版のタグと比べて、見える機能が変わったのに文書が変わっていなければ止める
//
// エージェントの一覧は core/backends/agents.mjs を import して取る（node:path だけに依存する軽いモジュール。
// 正規表現では読まない）。`git show <tag>:<file>` で取った中身は、いったん一時ファイルに書いて import する
// （loadAgentsFromSource）。それ以外（snapshot・能力の印）はテキストのまま読むので、タグの写しにも node_modules は要らない。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 機能一覧の元になるファイル（リポジトリの根からの相対。テキストで読む分）。
 * core/backends/agents.mjs に module として書かれたバックエンドのファイルも、実行時にここへ足される
 * （sourceFiles()）。能力の印はバックエンドごとの capabilities ブロックと、index.mjs が画面へ出す派生の印。
 */
export const INVENTORY_STATIC_FILES = [
  'tests/ops-surface.snap.json',   // 操作の一覧と設定の一覧の snapshot（tests/unit/ops-surface.mjs が registry から作る）
  'core/backends/index.mjs',       // 画面へ出す派生の能力の印（suggestTitle・submitCode など）
];

/** import した AGENTS の記述から、文書に要る分だけを取り出す。fake は除く（DEFAULT_AGENT_IDS と同じ分） */
const pickAgent = (d) => ({
  module: String(d?.module ?? '').replace(/^\.\//, '') || null,
  exe: d?.cli?.exe ?? null,
  installUrl: d?.cli?.installUrl ?? null,
  shortLabel: d?.shortLabel ?? null,
});

/**
 * core/backends/agents.mjs（パス）を import して、エージェントの一覧 { id: { module, exe, installUrl, shortLabel } }。
 * agents.mjs は SDK・ネットワークに依存しない軽いモジュール（node:path だけ）なので、正規表現ではなく import する。
 */
export async function loadAgentsFromPath(agentsPath) {
  const mod = await import(pathToFileURL(agentsPath).href);
  const ids = mod.DEFAULT_AGENT_IDS ?? Object.keys(mod.AGENTS ?? {}).filter((id) => id !== 'fake');
  const agents = {};
  for (const id of ids) if (mod.AGENTS?.[id]) agents[id] = pickAgent(mod.AGENTS[id]);
  return agents;
}

/**
 * `git show <tag>:core/backends/agents.mjs` で取った中身からエージェントの一覧。
 * import するため、いったん tempDir（worktree 内）に一時ファイルを書いて読み、終わったら消す。
 * 空・import できない中身なら {}（前の版との差分として検出される側に回す）
 */
export async function loadAgentsFromSource(source, tempDir) {
  if (!source || !source.trim()) return {};
  fs.mkdirSync(tempDir, { recursive: true });
  const file = path.join(tempDir, `agents-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  try {
    fs.writeFileSync(file, source);
    return await loadAgentsFromPath(file);
  } catch {
    return {};
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmdirSync(tempDir); // 空なら消す（中身があれば残し、失敗は無視）
  }
}

/**
 * 能力の印の状態を core/backends/agent-marks.mjs から import して取る（ADR 0274 で印の置き場がここに移った）。
 * read(rel) はリポジトリの根からの相対パスの中身（今の作業ツリーでもタグの写しでもよい）。印のデータの閉包
 * （site/tools/docs-sources.mjs の DOCS_SOURCE_FILES）を tempDir に書いて import し、終わったら消す。
 * agent-marks.mjs が無い（古い版）なら null を返し、inventory() はバックエンドのファイルの capabilities ブロックを読む。
 * 性質（traits）は能力ではないので含めない。{ <印>: { <agent>: 状態 } }
 */
export async function loadMarks(read, tempDir) {
  if (!read('core/backends/agent-marks.mjs')) return null;
  const { DOCS_SOURCE_FILES } = await import('./docs-sources.mjs');
  const dir = path.join(tempDir, `marks-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    for (const rel of DOCS_SOURCE_FILES) {
      const file = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, read(rel));
    }
    const { CAPABILITY_STATES } = await import(pathToFileURL(path.join(dir, 'core', 'backends', 'agent-marks.mjs')).href);
    const caps = {};
    for (const [id, states] of Object.entries(CAPABILITY_STATES ?? {})) {
      for (const [key, value] of Object.entries(states)) {
        const state = value && typeof value === 'object' && ['covered', 'impossible', 'todo'].includes(value.state) ? value.state : 'supported';
        (caps[key] ??= {})[id] = state;
      }
    }
    return caps;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    try { fs.rmdirSync(tempDir); } catch { /* 空でなければ残す */ }
  }
}

/** tests/ops-surface.snap.json の中身から、操作の一覧 { id: { risk, surfaces: {ui,mcp,cli} } } と設定の一覧 { key: { writable, risk } } */
export function parseOpsSurface(snapshotText) {
  const snap = JSON.parse(snapshotText);
  const ops = {};
  for (const op of snap.ops ?? []) {
    ops[op.id] = {
      risk: op.risk ?? null,
      surfaces: Object.fromEntries(['ui', 'mcp', 'cli'].map((s) => [s, !!op.surfaces?.[s]])),
    };
  }
  const settings = {};
  for (const s of snap.settings ?? []) settings[s.key] = { writable: !!s.writable, risk: s.risk ?? null };
  return { ops, settings };
}

/** `capabilities: { … }` のブロックの、1 行の項目を拾う（値は 1 行で読める形にする決まり。contract.mjs） */
const CAP_LINE = /^ {4,}([A-Za-z_][\w]*): *(\S.*?)?[,\s]*$/;

/**
 * バックエンドのファイル（core/backends/<module> か index.mjs）の中身から、能力の印の一覧。
 * 値を 4 つの状態に分ける: supported（対応の値）/ covered / impossible / todo。{ key: 状態 }
 */
export function parseCapabilities(source) {
  const caps = {};
  // 閉じる } は capabilities: と同じ字下げ（ネストの深いバックエンド（devin など）でも取れるよう後方参照で）
  for (const block of source.matchAll(/(^ *)capabilities: \{\r?\n([\s\S]*?)\r?\n\1\},?/gm)) {
    for (const line of block[2].split(/\r?\n/)) {
      const m = CAP_LINE.exec(line);
      if (!m) continue;
      const [, key, raw = ''] = m;
      const value = raw.replace(/\s*\/\/.*$/, '').replace(/,$/, '').trim();
      let state = 'supported';
      if (/^impossible\(/.test(value)) state = 'impossible';
      else if (/^todo\(/.test(value)) state = 'todo';
      else if (value === 'covered') state = 'covered';
      caps[key] = { state, value: value.replace(/'[^']*'/g, "'…'").slice(0, 80) };
    }
  }
  return caps;
}

/**
 * 機能一覧。files は { 相対パス: 中身 }（INVENTORY_STATIC_FILES とバックエンドの各ファイル。sourceFiles() の一覧）。
 * agents は loadAgentsFromPath / loadAgentsFromSource の結果（agents.mjs は import で読むので files に入れない）。
 * marks は loadMarks() の結果（今の形）。null なら古い版としてバックエンドのファイルから読む。
 * { agents, ops, settings, capabilities: { <印>: { <agent>: 状態 } } }
 */
export function inventory(files, agents, marks = null) {
  const { ops, settings } = parseOpsSurface(files['tests/ops-surface.snap.json'] ?? '{}');
  const capabilities = {};
  if (marks) {
    // 今の形: 印の状態は agent-marks.mjs（loadMarks で import した結果）。fake など一覧に無いエージェントは除く
    for (const [key, byAgent] of Object.entries(marks)) {
      for (const [id, state] of Object.entries(byAgent)) if (Object.hasOwn(agents, id)) (capabilities[key] ??= {})[id] = state;
    }
  } else {
    // 古い版: バックエンドのファイルごとの capabilities ブロック
    for (const [id, a] of Object.entries(agents)) {
      const source = files[`core/backends/${a.module}`] ?? '';
      for (const [key, cap] of Object.entries(parseCapabilities(source))) {
        (capabilities[key] ??= {})[id] = cap.state;
      }
    }
  }
  for (const [key, cap] of Object.entries(parseCapabilities(files['core/backends/index.mjs'] ?? ''))) {
    capabilities[key] ??= {};
    capabilities[key]['(画面)'] = cap.state;
  }
  return { agents, ops, settings, capabilities };
}

/** 機能の一覧を作るのに要るファイルの相対パス全部（エージェントの module から導くバックエンドのファイルを含む） */
export function sourceFiles(agents) {
  const extra = Object.values(agents).map((a) => a.module && `core/backends/${a.module}`).filter(Boolean);
  return [...INVENTORY_STATIC_FILES, ...[...new Set(extra)].sort()];
}

/** 対応表に並べる機能のキーの一覧: agent:<id> / ops:<名前空間> / setting:<key> / cap:<印> */
export function featureKeys(inv) {
  const keys = [];
  for (const id of Object.keys(inv.agents)) keys.push(`agent:${id}`);
  const namespaces = new Set(Object.keys(inv.ops).map((id) => id.split('.')[0]));
  for (const ns of namespaces) keys.push(`ops:${ns}`);
  for (const key of Object.keys(inv.settings)) keys.push(`setting:${key}`);
  for (const key of Object.keys(inv.capabilities)) keys.push(`cap:${key}`);
  return keys.sort((a, b) => a.localeCompare(b));
}

/** 一覧の確定した形のハッシュ（見える機能が変わったかの判定に使う） */
export function digest(inv) {
  const keys = featureKeys(inv);
  return { keys, body: JSON.stringify({ a: inv.agents, o: inv.ops, s: inv.settings, c: inv.capabilities }) };
}
