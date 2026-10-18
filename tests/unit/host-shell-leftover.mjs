// ホストのシェル（core/host-shell.mjs）: シェルが終わった後も、裏で起こしたプロセスが出力のパイプを握ったまま残るとき。LLM は呼ばない。
//   - 自分で終わったシェルは、少し待って締める（終了コードを残し、leftover を立てる）。残ったプロセスが終わるまで待たない
//   - 上限・止めるも、シェルが先に終わっていれば待たずに締める
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHostShell, EXIT_CLOSE_GRACE_MS } from '../../core/host-shell.mjs';

export const name = 'host-shell-leftover';
export const title = 'ホストのシェル: 出力のパイプを握ったまま残ったプロセスを待たずに締める';

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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
