#!/usr/bin/env node
/* ==================== 子を起こす API の lint ====================
   ADR 0270 の規則 ①: 長く生きる子プロセスは保持役でしか起こせない。そのために、子を起こす API を読んでよいモジュールを
   口（core/process.mjs・desktop/process.cjs）だけにする。ほかのモジュールが直に読むと、切り替えで止まる子がまた増える。

     node tests/lint-child-process.mjs [--update-baseline] [--json]

   検査すること（基準は tests/child-process-baseline.json。i18n・エージェントの id と同じ「下がる一方の基準（ラチェット）」）:
   1. core/・desktop/・bin/ の JS で、node:child_process（import・require・動的 import）と utilityProcess.fork を数える。
      口（core/process.mjs・desktop/process.cjs）は数えない。コメントの中は数えない。
   2. ファイルごとの件数を基準と比べ、増えた・基準に無いファイルに出た → 失敗。減った → 通す（--update-baseline で下げる）。
      基準は「移行中」の一覧で、段 4 の終わりに空になる。空にするときは --update-baseline を使う。
   3. 自己診断（selftest。npm test でも回す）。

   npm test からは tests/unit/child-process-lint.mjs が lintRepo() と selftest() を直接呼ぶ。 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_FILE = path.join(ROOT, 'tests', 'child-process-baseline.json');
export const BASELINE_VERSION = 1;

const SCAN_DIRS = ['core', 'desktop', 'bin'];
const JS_EXT = new Set(['.mjs', '.js', '.cjs']);
/** 子を起こしてよい口。サーバー・保持役の側（core/process.mjs）と Electron main の側（desktop/process.cjs） */
export const MOUTH = Object.freeze(['core/process.mjs', 'desktop/process.cjs']);

/** コメントを空白に置き換える（行番号は保つ）。// は行頭のものだけ。文字列の中の // は消さない */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, '$1');
}

/** 1 つのファイルの直の使用。{ childProcess, utilityFork } */
export function countUses(text) {
  const code = stripComments(String(text));
  const childProcess = code.match(/(?:from\s*['"](?:node:)?child_process['"]|require\s*\(\s*['"](?:node:)?child_process['"]|import\s*\(\s*['"](?:node:)?child_process['"])/g)?.length ?? 0;
  const utilityFork = code.match(/\butilityProcess\s*\.\s*fork\s*\(/g)?.length ?? 0;
  return { childProcess, utilityFork };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (JS_EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}

export function listFiles(root = ROOT) {
  return SCAN_DIRS.filter((dir) => existsSync(path.join(root, dir))).flatMap((dir) => walk(path.join(root, dir)))
    .map((file) => path.relative(root, file).replace(/\\/g, '/')).sort();
}

/** 直に子を起こしているファイルと件数（口は除く） */
export function scanRepo(root = ROOT) {
  const found = {};
  for (const file of listFiles(root)) {
    if (MOUTH.includes(file)) continue;
    const uses = countUses(readFileSync(path.join(root, file), 'utf8'));
    if (uses.childProcess || uses.utilityFork) found[file] = uses;
  }
  return found;
}

export function readBaseline(file = BASELINE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed?.version === BASELINE_VERSION && parsed.files && typeof parsed.files === 'object' ? parsed.files : {};
  } catch { return {}; }
}

const totalOf = uses => (uses.childProcess ?? 0) + (uses.utilityFork ?? 0);

/** 基準と今の使用を比べる。増えた・基準に無い → problems。減った → reduced（通す） */
export function compare(found, baseline) {
  const problems = [];
  const reduced = [];
  for (const [file, uses] of Object.entries(found)) {
    const limit = baseline[file];
    if (limit === undefined) {
      problems.push({ file, message: `${file}: 子を起こす API を直に読んでいる（口は ${MOUTH.join('・')} だけ。移行中なら基準に載せる）` });
      continue;
    }
    if (totalOf(uses) > totalOf(limit)) problems.push({ file, message: `${file}: 子を起こす API が ${totalOf(limit)} → ${totalOf(uses)} に増えた` });
    else if (totalOf(uses) < totalOf(limit)) reduced.push({ file, from: totalOf(limit), to: totalOf(uses) });
  }
  const stale = Object.keys(baseline).filter((file) => !(file in found));
  return { problems, reduced, stale };
}

/** リポジトリ全体。problems が空なら合格 */
export function lintRepo(root = ROOT) {
  const found = scanRepo(root);
  const baseline = readBaseline(path.join(root, 'tests', 'child-process-baseline.json'));
  const { problems, reduced, stale } = compare(found, baseline);
  return { found, baseline, problems, reduced, stale, migrating: Object.keys(baseline).filter((file) => file in found), baselineCount: Object.keys(baseline).length };
}

/** 基準を今の使用に合わせる（減らすときだけ。増えるなら書かずに失敗する） */
export function updateBaseline(root = ROOT) {
  const result = lintRepo(root);
  if (result.problems.length && result.baselineCount) throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  const files = Object.fromEntries(Object.entries(result.found).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path.join(root, 'tests', 'child-process-baseline.json'), `${JSON.stringify({ version: BASELINE_VERSION, files }, null, 2)}\n`);
  return { files, previous: result.baselineCount };
}

/** 走査の自己診断。失敗の理由の配列（空なら合格） */
export function selftest() {
  const fails = [];
  const check = (label, actual, want) => { if (JSON.stringify(actual) !== JSON.stringify(want)) fails.push(`${label}: ${JSON.stringify(actual)} / ${JSON.stringify(want)}`); };
  check('import', countUses("import { spawn } from 'node:child_process';"), { childProcess: 1, utilityFork: 0 });
  check('require', countUses("const { spawn } = require('child_process');"), { childProcess: 1, utilityFork: 0 });
  check('動的 import', countUses("const cp = await import('node:child_process');"), { childProcess: 1, utilityFork: 0 });
  check('utilityProcess.fork', countUses('utilityProcess.fork(module, [], {});'), { childProcess: 0, utilityFork: 1 });
  check('コメント', countUses("// import { spawn } from 'node:child_process';\n/* require('child_process') */\n"), { childProcess: 0, utilityFork: 0 });
  check('口の経由', countUses("import { run, start } from './process.mjs';"), { childProcess: 0, utilityFork: 0 });
  check('同名のメソッド', countUses("db.exec('select 1'); re.exec(text);"), { childProcess: 0, utilityFork: 0 });
  check('複数', countUses("import { spawn } from 'node:child_process';\nimport { execFile } from 'node:child_process';\nutilityProcess.fork(x);"), { childProcess: 2, utilityFork: 1 });
  const base = { 'a.mjs': { childProcess: 1, utilityFork: 0 } };
  check('増えた', compare({ 'a.mjs': { childProcess: 2, utilityFork: 0 } }, base).problems.length, 1);
  check('基準に無い', compare({ 'b.mjs': { childProcess: 1, utilityFork: 0 } }, base).problems.length, 1);
  check('同じ', compare({ 'a.mjs': { childProcess: 1, utilityFork: 0 } }, base).problems.length, 0);
  check('減った', compare({ 'a.mjs': { childProcess: 0, utilityFork: 0 } }, base).reduced.length, 1);
  check('消えた', compare({}, base).stale, ['a.mjs']);
  return fails;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const json = process.argv.includes('--json');
  if (process.argv.includes('--update-baseline')) {
    const { files, previous } = updateBaseline();
    console.log(`基準を ${previous} → ${Object.keys(files).length} ファイルに更新しました`);
  }
  const result = lintRepo();
  if (json) console.log(JSON.stringify({ ...result, selftest: selftest() }, null, 2));
  else {
    if (result.problems.length) console.log(result.problems.map((problem) => problem.message).join('\n'));
    if (result.reduced.length) console.log(`減った（--update-baseline で基準を下げられます）: ${result.reduced.map((item) => item.file).join(', ')}`);
    if (result.stale.length) console.log(`基準から消えた（--update-baseline で下げられます）: ${result.stale.join(', ')}`);
    const fails = selftest();
    if (fails.length) console.log(`自己診断: ${fails.join(' / ')}`);
    console.log(`移行中 ${result.migrating.length} ファイル（基準 ${result.baselineCount}）${result.problems.length || fails.length ? ' — 不合格' : ''}`);
  }
  process.exitCode = result.problems.length || selftest().length ? 1 : 0;
}
