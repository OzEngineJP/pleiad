// ホストのシェル（core/host-shell.mjs）: シェルが終わった後も、裏で起こしたプロセスが出力のパイプを握ったまま残るとき。LLM は呼ばない。
//   - 自分で終わったシェルは、少し待って締める（終了コードを残し、leftover を立てる）。残ったプロセスが終わるまで待たない
//   - 上限・止めるも、シェルが先に終わっていれば待たずに締める
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHostShell, powershellCommand, EXIT_CLOSE_GRACE_MS } from '../../core/host-shell.mjs';

export const name = 'host-shell-leftover';
export const title = 'ホストのシェル: 出力のパイプを握ったまま残ったプロセスを待たずに締める・PowerShell の出力を UTF-8 で読む';

const POWERSHELL = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 裏でパイプを継いだまま 15 秒生きる node を起こし、PID をファイルに書くコマンド（Git Bash・sh の `&`） */
function leftoverCommand(pidFile) {
  const node = process.execPath.replace(/\\/g, '/');
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile.replace(/\\/g, '/'))}, String(process.pid)); setTimeout(() => {}, 15000)`;
  return `"${node}" -e "${script.replace(/"/g, '\\"')}" & echo started`;
}

async function stopLeftover(pidFile) {
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(50);
  const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : NaN);
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid); } catch {}
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await sleep(50); }
  }
  return pid;
}

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-host-shell-'));
  try {
    {
      const pidFile = path.join(dir, 'a.pid');
      const started = Date.now();
      const r = await runHostShell({ command: leftoverCommand(pidFile), cwd: os.tmpdir(), timeoutMs: 20000 });
      const elapsed = Date.now() - started;
      const pid = await stopLeftover(pidFile);
      t.ok('自分で終わったシェルは、残ったプロセスを待たずに締める', elapsed < EXIT_CLOSE_GRACE_MS + 8000, `${elapsed}ms`);
      t.ok('終了コードと、そこまでの出力を残す', r.exitCode === 0 && r.stdout.includes('started') && !r.timedOut && !r.stopped, JSON.stringify(r));
      t.ok('パイプが残ったことを leftover で返す', r.leftover === true && pid > 0, JSON.stringify({ leftover: r.leftover, pid }));
    }
    {
      const r = await runHostShell({ command: 'echo done', cwd: dir, timeoutMs: 20000 });
      t.ok('普通のコマンドは leftover を付けない', r.exitCode === 0 && r.stdout.includes('done') && !r.leftover, JSON.stringify(r));
    }
    {
      const pidFile = path.join(dir, 'b.pid');
      const started = Date.now();
      const r = await runHostShell({ command: leftoverCommand(pidFile), cwd: os.tmpdir(), timeoutMs: 300 });
      const elapsed = Date.now() - started;
      await stopLeftover(pidFile);
      t.ok('上限がシェルの終わりより後でも、残ったプロセスを待たずに締める', elapsed < EXIT_CLOSE_GRACE_MS + 8000, `${elapsed}ms ${JSON.stringify(r)}`);
    }

    // ---- PowerShell: 出力の文字コードを UTF-8 にして走らせる（日本語の Windows の PowerShell 5.1 は cp932 で書き、化ける。2026-11-25）
    {
      const cmd = "Write-Output 'こんにちは'";
      const wrapped = powershellCommand(cmd);
      t.ok('powershellCommand: 先頭で出力を UTF-8 にし、コマンドは base64 で渡す（構文エラーも設定の後で出る）',
        wrapped.startsWith('try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)') && wrapped.includes(Buffer.from(cmd, 'utf8').toString('base64')) && !wrapped.includes('こんにちは'), wrapped);
      const long = `Write-Output '${'あ'.repeat(15_000)}'`;
      const fallback = powershellCommand(long);
      t.ok('powershellCommand: コマンドラインの上限に近い長さは包まず、先頭の設定だけ付ける', fallback.startsWith('try{[Console]::OutputEncoding') && fallback.endsWith(long) && fallback.length < long.length + 200, String(fallback.length));
    }
    if (process.platform === 'win32' && fs.existsSync(POWERSHELL)) {
      const env = { ...process.env, AGENT_HOST_SHELL: POWERSHELL };
      const ps = (command) => runHostShell({ command, cwd: dir, timeoutMs: 30000, env });
      const nodeExe = process.execPath.replace(/\\/g, '/');
      let r = await ps("Write-Output 'こんにちは日本語'");
      t.ok('PowerShell: コマンドレットの日本語の出力が化けない', r.exitCode === 0 && r.stdout.trim() === 'こんにちは日本語', JSON.stringify(r.stdout));
      r = await ps(`'あいう' | & '${nodeExe}' -e "process.stdin.on('data', d => console.log(d.toString('utf8').trim()))"`);
      t.ok('PowerShell: パイプで native へ渡す日本語も UTF-8', r.stdout.trim() === 'あいう', JSON.stringify(r.stdout));
      r = await ps('Get-Item C:/no/such/dir-ply3205');
      t.ok('PowerShell: 実行時のエラーの文面が化けない（U+FFFD が出ない）・最後の文が失敗なら終了コード 1', r.exitCode === 1 && r.stderr.includes('ItemNotFoundException') && !r.stderr.includes('\ufffd'), JSON.stringify(r));
      r = await ps('Write-Output a && Write-Output b');
      t.ok('PowerShell: `&&` のような構文エラーの文面も化けない・終了コード 1・どこが悪いか分かる', r.exitCode === 1 && r.stderr.includes('&&') && !r.stderr.includes('\ufffd') && r.stdout === '', JSON.stringify(r));
      r = await ps(`& '${nodeExe}' -e "process.exit(5)"`);
      t.ok('PowerShell: native が失敗して終わるなら終了コード 1（包む前と同じ）', r.exitCode === 1, JSON.stringify(r));
      r = await ps(`& '${nodeExe}' -e "process.exit(5)"; Write-Output ok`);
      t.ok('PowerShell: 失敗の後に成功した文が続くなら終了コード 0（包む前と同じ）', r.exitCode === 0 && r.stdout.trim() === 'ok', JSON.stringify(r));
      r = await ps('Write-Output a; exit 3; Write-Output b');
      t.ok('PowerShell: exit の番号をそのまま返し、後ろの文は走らない', r.exitCode === 3 && r.stdout.trim() === 'a', JSON.stringify(r));
      r = await ps('$z = 3\nfunction f { $z }\nf');
      t.ok('PowerShell: 複数行・変数・関数は今までどおり（同じスコープで走る）', r.exitCode === 0 && r.stdout.trim() === '3', JSON.stringify(r));
      r = await ps("throw 'だめ'");
      t.ok('PowerShell: throw は終了コード 1 で、文面が化けない', r.exitCode === 1 && r.stderr.includes('だめ') && !r.stderr.includes('\ufffd'), JSON.stringify(r));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
