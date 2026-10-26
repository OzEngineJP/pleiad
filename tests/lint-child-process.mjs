#!/usr/bin/env node
/* ==================== 子を起こす API の lint ====================
   ADR 0270 の規則 ①: 長く生きる子プロセスは保持役でしか起こせない。
   生の child_process API は口（core/process.mjs・desktop/process.cjs）と、固定例外の hook-adapter だけが読む。
   core/process.mjs の spawnChild は固定例外一覧にあるファイルだけが読む。例外は「移行中の基準」ではなく、
   ファイルと理由をこの lint に固定した決定事項。未登録の import は必ず失敗する。

     node tests/lint-child-process.mjs [--json]

   core/・desktop/・bin/ の JS で child_process（import・require・動的 import）、utilityProcess.fork、
   core/process.mjs からの spawnChild import を検査する。コメントは数えない。自己診断も行う。
   npm test からは tests/unit/child-process-lint.mjs が lintRepo() と selftest() を直接呼ぶ。 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_DIRS = ['core', 'desktop', 'bin'];
const JS_EXT = new Set(['.mjs', '.js', '.cjs']);
/** 生の child_process API を使う口 */
export const MOUTH = Object.freeze(['core/process.mjs', 'desktop/process.cjs']);
/** spawnChild の固定例外。各ファイルがこの起動を担当する理由を 1 行で書く */
export const SPAWN_CHILD_EXCEPTIONS = Object.freeze({
  'core/holder/holder.mjs': '保持役の本体が、管理する子プロセスを起動する',
  'core/cli-installation.mjs': 'spawnCli が保持役を使えない CLI shim の互換 fallback を起動する',
  'core/claude-login.mjs': 'Claude の対話ログインを端末へ接続して実行する',
  'core/hook-adapter.mjs': 'コピーされた単体アダプターも hook コマンドを実行できるようにする',
});

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

/** core/process.mjs から spawnChild を import または再 export している数 */
export function countSpawnChildImports(file, text) {
  const code = stripComments(String(text));
  let count = 0;
  const isProcessModule = source => path.posix.normalize(path.posix.join(path.posix.dirname(file), source)) === 'core/process.mjs';
  const hasName = names => names.split(',').some(spec => /^\s*spawnChild(?:\s+as\s+[\w$]+)?\s*$/.test(spec));
  for (const match of code.matchAll(/\b(?:import|export)\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (isProcessModule(match[2]) && hasName(match[1])) count++;
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s*)?import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (isProcessModule(match[2]) && hasName(match[1])) count++;
  }
  const namespacePatterns = [
    /\bimport\s+\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/g,
    /\b(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s*)?import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of namespacePatterns) for (const match of code.matchAll(pattern)) {
    if (isProcessModule(match[2]) && new RegExp(`\\b${match[1]}\\s*\\.\\s*spawnChild\\b`).test(code)) count++;
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (isProcessModule(match[2]) && hasName(match[1])) count++;
  }
  for (const match of code.matchAll(/\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g)) if (isProcessModule(match[1])) count++;
  return count;
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

/** 生の child_process API の直読みと spawnChild import を列挙する */
export function scanRepo(root = ROOT) {
  const found = {}, spawnChildImports = {};
  for (const file of listFiles(root)) {
    const source = readFileSync(path.join(root, file), 'utf8');
    const uses = countUses(source);
    if ((!MOUTH.includes(file) && !Object.hasOwn(SPAWN_CHILD_EXCEPTIONS, file) && uses.childProcess)
      || (!MOUTH.includes(file) && uses.utilityFork)) found[file] = uses;
    const imports = countSpawnChildImports(file, source);
    if (imports) spawnChildImports[file] = imports;
  }
  return { found, spawnChildImports };
}

/** 例外一覧に無いファイルからの spawnChild import は常に不合格 */
export function spawnChildProblem(file, count = 1) {
  if (!count || Object.hasOwn(SPAWN_CHILD_EXCEPTIONS, file)) return null;
  return { file, message: `${file}: core/process.mjs の spawnChild を import している。例外一覧に理由を追加しない限り使えない` };
}

/** リポジトリ全体。problems が空なら合格 */
export function lintRepo(root = ROOT) {
  const { found, spawnChildImports } = scanRepo(root);
  const problems = Object.entries(found).map(([file]) => ({ file, message: `${file}: child_process / utilityProcess.fork は口 ${MOUTH.join('・')} だけが使える` }));
  for (const [file, count] of Object.entries(spawnChildImports)) {
    const problem = spawnChildProblem(file, count);
    if (problem) problems.push(problem);
  }
  return { found, spawnChildImports, problems };
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
  check('一覧外の直読み', !MOUTH.includes('core/not-allowed.mjs') && countUses("import { spawn } from 'node:child_process';").childProcess > 0, true);
  check('固定例外 hook-adapter の直読み', Object.hasOwn(SPAWN_CHILD_EXCEPTIONS, 'core/hook-adapter.mjs'), true);
  check('登録外 spawnChild', spawnChildProblem('core/not-allowed.mjs', countSpawnChildImports('core/not-allowed.mjs', "import { spawnChild } from './process.mjs';"))?.file, 'core/not-allowed.mjs');
  check('別名 import', countSpawnChildImports('core/not-allowed.mjs', "import { spawnChild as rawSpawn } from './process.mjs';"), 1);
  check('許可された例外', spawnChildProblem('core/cli-installation.mjs', countSpawnChildImports('core/cli-installation.mjs', "import { spawnChild } from './process.mjs';")), null);
  check('動的 import', countSpawnChildImports('core/not-allowed.mjs', "const { spawnChild } = await import('./process.mjs');"), 1);
  check('namespace import', countSpawnChildImports('core/not-allowed.mjs', "import * as proc from './process.mjs'; proc.spawnChild('x');"), 1);
  check('require destructuring', countSpawnChildImports('core/not-allowed.mjs', "const { spawnChild } = require('./process.mjs');"), 1);
  check('同名のメソッド', countUses("db.exec('select 1'); re.exec(text);"), { childProcess: 0, utilityFork: 0 });
  check('複数', countUses("import { spawn } from 'node:child_process';\nimport { execFile } from 'node:child_process';\nutilityProcess.fork(x);"), { childProcess: 2, utilityFork: 1 });
  return fails;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const json = process.argv.includes('--json');
  const result = lintRepo();
  if (json) console.log(JSON.stringify({ ...result, selftest: selftest() }, null, 2));
  else {
    if (result.problems.length) console.log(result.problems.map((problem) => problem.message).join('\n'));
    const fails = selftest();
    if (fails.length) console.log(`自己診断: ${fails.join(' / ')}`);
    console.log(`spawnChild の固定例外 ${Object.keys(SPAWN_CHILD_EXCEPTIONS).length} ファイル、登録外 ${Object.keys(result.spawnChildImports).filter(file => !Object.hasOwn(SPAWN_CHILD_EXCEPTIONS, file)).length} ファイル${result.problems.length || fails.length ? ' — 不合格' : ''}`);
  }
  process.exitCode = result.problems.length || selftest().length ? 1 : 0;
}
