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

// PowerShell は出力を、コンソールの文字コード（日本語の Windows は cp932）で書く。Pleiad は子の出力を UTF-8 で読むので、日本語が化ける
// （ply_shell の記録で、powershell の run 162 本のうち 23 本。コマンドレットの出力も、エラーの文面も）。
// 先に出力の文字コードを UTF-8（BOM なし）にする。入力側（`$OutputEncoding`。パイプで native に渡す文字）も揃える。
// 利用者のコマンドは、構文エラーの文面も UTF-8 で読めるよう、その設定の後で組み立てて走らせる（`&&` のように PowerShell 5.1 で通らない書き方の
// エラーは、設定より前の構文解析で出て化ける。化けた 25 本のうち 7 本）。同じスコープで走らせるので変数・関数は今までどおり。
// 終了コードは今までどおり、最後の文の成否（`$?`。失敗なら 1）で返す。コマンドラインの上限（32767 字）に近いときは包まず、先頭の設定だけ付ける
const PS_UTF8 = 'try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding}catch{}';
export const powershellCommand = (command) => {
  const b64 = Buffer.from(command, 'utf8').toString('base64');
  const wrapped = [
    PS_UTF8,
    `$__plyCommand=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
    // 行末のバッククォート（次の行へ続く）で終わるコマンドでも、控えの文が前の文の引数にならないよう、改行を 2 つ挟む
    '. ([scriptblock]::Create($__plyCommand+"`n`n"+\'$global:__plyOk=$?\'))',
    'if($global:__plyOk -eq $false){exit 1}',
  ].join('\n');
  return wrapped.length <= 30_000 ? wrapped : `${PS_UTF8};${command}`;
};

const argsFor = (file, command) => {
  const base = path.basename(file).toLowerCase().replace(/\.exe$/, '');
  if (base === 'powershell' || base === 'pwsh') return ['-NoProfile', '-NonInteractive', '-Command', powershellCommand(command)];
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
