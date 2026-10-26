// Electron main の側のプロセスの口（ADR 0270 の規則 ①。docs/adr/0270-server-may-die-anytime.md）。
// main が子を起こす API はここだけ（tests/lint-child-process.mjs が数える）。
//   forkUtility     サーバーを utilityProcess で起こす（AGENT_HOST_HANDOVER=off の経路）
//   run             完了を待つ短命の子（core/process.mjs の run() と同じ形。main は CJS なので、asar の中の ESM を読まずに写す）
//   spawnDetached   サーバーの子でない形で起こす（core/process.mjs の detach と同じ形。サーバー・Chrome の起動）
//   spawnRaw        main が自分で抱える子（computer use の補助・ログインシェルの読み込み）。stdio を自分で読み書きする
const { spawn } = require('node:child_process');

/** utilityProcess を起こす。options は utilityProcess.fork と同じ（electron は呼ぶときに読む。main の外の試験で読めるように） */
function forkUtility(modulePath, args = [], options = {}) {
  const { utilityProcess } = require('electron');
  return utilityProcess.fork(modulePath, args, options);
}

/**
 * 完了を待つ子を 1 回走らせる（core/process.mjs の run() の、main が使う範囲）。プロセスのハンドルは返さない。
 * 戻り値は { exitCode, signal, stdout, stderr, durationMs, timedOut, truncated, startError?, startCode? }
 */
function run(command, args = [], {
  cwd, env, input = null, timeoutMs = 0, maxOutputChars = Infinity, windowsHide = true, killTree = false, shell = false,
} = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const out = { stdout: '', stderr: '' };
    let truncated = false, timedOut = false, done = false, child = null, timer = null;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, ...out, durationMs: Date.now() - started, timedOut, stopped: false, truncated, ...result });
    };
    const kill = () => {
      if (!child?.pid) return;
      if (!killTree) { try { child.kill('SIGKILL'); } catch { /* 既に終わっている */ } return; }
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* 既に終わっている */ } });
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 既に終わっている */ } } }
    };
    const stdio = input != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    try {
      child = spawn(command, Array.isArray(args) ? args.map(String) : [], { cwd, env, windowsHide, stdio, shell });
    } catch (error) { finish({ startError: String(error?.message ?? error), startCode: error?.code ?? null }); return; }
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    if (input != null && child.stdin) child.stdin.end(input);
    for (const stream of ['stdout', 'stderr']) {
      const readable = child[stream];
      if (!readable) continue;
      readable.setEncoding('utf8');
      readable.on('data', text => {
        const room = maxOutputChars - out[stream].length;
        if (room <= 0) { truncated = true; return; }
        const piece = text.length > room ? text.slice(0, Math.max(0, room)) : text;
        if (piece.length < text.length) truncated = true;
        out[stream] += piece;
      });
    }
    child.on('error', error => finish({ startError: String(error?.message ?? error), startCode: error?.code ?? null }));
    child.on('close', (code, sig) => finish(timedOut ? {} : { exitCode: code, signal: sig ?? null }));
  });
}

/** サーバーの子でない形（detached・stdio なし）で起こす。子を返す（呼ぶ側が once('error') と unref をする） */
function spawnDetached(command, args = [], options = {}) {
  const child = spawn(command, Array.isArray(args) ? args.map(String) : [], { detached: true, stdio: 'ignore', windowsHide: true, ...options });
  child.unref();
  return child;
}

/** 生の spawn（stdio を自分で読み書きする、main の子）。ほかでは使わない */
function spawnRaw(command, args = [], options = {}) {
  return spawn(command, Array.isArray(args) ? args.map(String) : [], options);
}

module.exports = { forkUtility, run, spawnDetached, spawnRaw };
