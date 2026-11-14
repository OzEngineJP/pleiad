#!/usr/bin/env node
// macOS のビルド（electron-builder の署名と公証）を、codesign のタイムスタンプのエラーのときだけやり直す包み。
//
//   node scripts/retry-on-codesign-timestamp.mjs [--clean <dir>]... -- <command> [args...]
//
// 渡されたコマンドを走らせ、出力はそのまま流す（ログに残る）。失敗し、かつ出力に
// `The timestamp service is not available`（Apple のタイムスタンプのサーバーに届かない）があるときだけ、
// ::warning:: を出し、--clean のディレクトリ（作りかけの出力）を消して、120 秒・240 秒あけて最大 2 回やり直す（合計 3 回）。
// それ以外の失敗は、やり直さずに同じ終了コードで落とす。最後まで落ちたら最後の終了コードで落とす。
// このエラーは署名（公証の前）で起きるので、やり直しで公証を二重に出すことは無い
// （electron-builder は署名 → afterSign の公証 → dmg・zip の順。docs/desktop-releases.md「macOS の配布」）。
// 署名・鍵・公証の手順には触れない。環境変数はそのまま子に継がせるだけで、値は出力にもファイルにも残さない。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TIMESTAMP_ERROR = /The timestamp service is not available/i;
export const RETRY_DELAYS_MS = Object.freeze([120_000, 240_000]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 実コマンドを走らせる。出力は流しながら、タイムスタンプのエラーが出たかだけを覚える（全文は持たない）
function runCommand(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], env, shell: process.platform === 'win32' && /^(npm|npx)$/.test(command) });
    let tail = '';
    let matched = false;
    const watch = (stream, sink) => {
      stream.on('data', chunk => {
        sink.write(chunk);
        // チャンクの境目をまたぐ当たりを拾うため、直前の少しを持ち越す
        tail = (tail + chunk.toString('utf8')).slice(-8192);
        if (TIMESTAMP_ERROR.test(tail)) matched = true;
      });
    };
    watch(child.stdout, process.stdout);
    watch(child.stderr, process.stderr);
    child.on('error', error => { process.stderr.write(`${error.message}\n`); resolve({ status: 127, matched }); });
    child.on('close', (code, signal) => resolve({ status: code ?? (signal ? 1 : 0), matched }));
  });
}

/**
 * @param {{ command: string, args?: string[], clean?: string[], delaysMs?: number[], run?: Function,
 *   wait?: (ms: number) => Promise<void>, remove?: (dir: string) => void, log?: (line: string) => void, env?: object }} options
 * @returns {Promise<number>} 終了コード
 */
export async function runWithTimestampRetry({ command, args = [], clean = [], delaysMs = RETRY_DELAYS_MS, run = runCommand, wait = sleep,
  remove = dir => fs.rmSync(dir, { recursive: true, force: true }), log = line => console.log(line), env = process.env } = {}) {
  const total = delaysMs.length + 1;
  for (let attempt = 1; ; attempt++) {
    const { status, matched } = await run(command, args, env);
    if (status === 0) return 0;
    if (!matched || attempt >= total) return status;
    const delay = delaysMs[attempt - 1];
    log(`::warning::codesign timestamp service was not available (attempt ${attempt} of ${total}); retrying in ${Math.round(delay / 1000)} s`);
    for (const dir of clean) remove(dir);
    await wait(delay);
  }
}

export function parseArgs(argv) {
  const clean = [];
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i++) {
    if (argv[i] === '--clean' && argv[i + 1]) clean.push(argv[++i]);
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  const [command, ...args] = argv.slice(i + 1);
  if (!command) throw new Error('Usage: retry-on-codesign-timestamp.mjs [--clean <dir>]... -- <command> [args...]');
  return { command, args, clean };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exit(2); }
  process.exit(await runWithTimestampRetry(options));
}
