// 入力欄の `!`（シェルの行）で、人が打ったコマンドをホストのシェルで走らせる（ADR 0054、docs/multi-backend.md「シェルの行」）。
// Claude と fake はここで走らせ、結果を次の発言と一緒にエージェントへ渡す（core/shell-runs.mjs）。Codex は app-server が走らせる。
//
// - シェル: AGENT_HOST_SHELL があればそれ。Windows は Git Bash（CLI の `!` の既定と同じ bash）、無ければ PowerShell。
//   ほかの OS は $SHELL、無ければ /bin/sh
// - 標準入力は渡さない（閉じる）。対話が要るコマンドは入力を待たずに終わるか、止めるまで止まっている
// - 上限の時間を過ぎたら、子のプロセスごと止める
import { run } from './process.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifySystemMessages } from './system-messages.mjs';

/** 出力を貯める上限（stdout・stderr それぞれ）。越えた分は捨て、truncated を立てる */
export const OUTPUT_LIMIT = 256 * 1024;
/** 止めた・上限のシェルが終わってから、出力のパイプが閉じるのを待つ上限 */
const KILLED_CLOSE_GRACE_MS = 1000;
/** 自分で終わったシェルの後、出力のパイプが閉じるのを待つ上限（過ぎたら、パイプを握ったまま残ったプロセスがあるとみなして締める） */
export const EXIT_CLOSE_GRACE_MS = 2000;

const argsFor = (file, command) => {
  const base = path.basename(file).toLowerCase().replace(/\.exe$/, '');
  if (base === 'powershell' || base === 'pwsh') return ['-NoProfile', '-NonInteractive', '-Command', command];
  if (base === 'cmd') return ['/d', '/s', '/c', command];
  return ['-c', command];
};

/** 走らせるシェル。{ file, name } か、見つからなければ null */
export function hostShell(env = process.env) {
  if (env.AGENT_HOST_SHELL) return { file: env.AGENT_HOST_SHELL, name: path.basename(env.AGENT_HOST_SHELL).replace(/\.exe$/i, '') };
  if (process.platform === 'win32') {
    const bash = [env.CLAUDE_CODE_GIT_BASH_PATH, 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].filter(Boolean).find(p => fs.existsSync(p));
    if (bash) return { file: bash, name: 'bash' };
    const root = env.SystemRoot || 'C:/Windows';
    return { file: path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'), name: 'powershell' };
  }
  const file = env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : '/bin/sh';
  return { file, name: path.basename(file) };
}

/**
 * コマンドを 1 回走らせる。
 * @returns Promise<{ exitCode, signal, stdout, stderr, durationMs, timedOut, stopped, truncated, leftover?, startError? }>
 *   exitCode は分からなければ null（止めた・上限・起動できない）
 *   leftover は、シェルは終わったが出力のパイプを握ったプロセスが残った（裏で起こしたサーバーなど。その後の出力は読まない）
 */
export function runHostShell({ command, cwd, timeoutMs, signal, onOutput = () => {}, env = process.env }) {
  // シェルが終わっても、出力のパイプを握った子が残って close が来ないことがある。
  //   - 止めたとき: Git Bash のループを止めると、fork の途中の子が親を失って止まったまま残る（40 回に 1 回ほど）
  //   - 自分で終わったとき: PowerShell の `Start-Process -RedirectStandardOutput` で起こしたサーバーが、シェルの出力のパイプを継いで握り続ける
  //     （シェルの子でなくなるので、上限で木ごと止めても届かない。2026-10-18）
  // どちらも、シェルが終わってから少し待って締める。自分で終わったときは終了コードを残し、パイプが残ったこと（leftover）を返す（core/process.mjs の exitCloseGraceMs）
  const shell = hostShell(env);
  return run(shell.file, argsFor(shell.file, command), {
    cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs, signal, onOutput, maxOutputChars: OUTPUT_LIMIT, killTree: true,
    exitCloseGraceMs: EXIT_CLOSE_GRACE_MS, killedCloseGraceMs: KILLED_CLOSE_GRACE_MS,
  });
}

/**
 * エージェントへ渡す 2 行（Claude の CLI の `!` と同じ形。core/system-messages.mjs が同じ形で読む）。
 * 終了コードは CLI の形に入らないので、ここにも入れない（会話の記録の shellExits に控える）
 */
export function shellLines({ command, stdout, stderr }) {
  return [
    `<bash-input>${command}</bash-input>`,
    `<bash-stdout>${stdout ?? ''}</bash-stdout><bash-stderr>${stderr ?? ''}</bash-stderr>`,
  ];
}

/**
 * 履歴の `!` の行（kind: 'shell'）と、Pleiad が走らせた結果を照らす鍵。履歴で読んだときと同じ形に揃えてから取る
 * （classifySystemMessages を通す。改行・色の指定・末尾の空白の扱いがずれない）
 */
export function shellKey({ command, stdout, stderr }) {
  const [shell] = classifySystemMessages(shellLines({ command, stdout, stderr }).map(text => ({ role: 'user', text })));
  return messageShellKey(shell);
}

/** 読んだ履歴の kind: 'shell' の発言の鍵 */
export function messageShellKey(m) {
  return crypto.createHash('sha256').update(JSON.stringify([m?.command ?? '', m?.stdout ?? null, m?.stderr ?? null])).digest('hex').slice(0, 32);
}
