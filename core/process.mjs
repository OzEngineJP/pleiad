// プロセスの口（ADR 0270 の規則 ①。docs/adr/0270-server-may-die-anytime.md）。
// 子を起こす API をこのファイルに集める。**ほかのモジュールは node:child_process を読まない**（tests/lint-child-process.mjs が数える）。
//
//   run()        完了を待つ短命の子（git・gh・--version・taskkill・`!` の 1 回のシェルなど）。プロセスのハンドルは返さない。
//                出力は上限つきで集め、onOutput で流す。止める・時間切れはこの中で木ごとに止める
//   start()      保持役（core/holder/）に起こさせる長く生きる子。戻り値は { id, client, source }（source は記録・write・ack）。
//                保持役を使えないときは null（呼び出し側は run() か、今のサーバーの子に落とす）
//   detach()     サーバーの子でない形で起こす（保持役自身の起動。core/holder/client.mjs）。pid だけ返す
//   spawnChild() 保持役の本体（core/holder/holder.mjs）が子を起こすための生の口。ほかからは使わない
//
// 保持役の置き場: AGENT_HOST_RUNTIME_ROOT（パッケージ版の main が渡す）が無ければ、データ置き場ごとの一時フォルダー
// （os.tmpdir()/pleiad-holder/<データ置き場のハッシュ>）を使う。同じデータ置き場のサーバーを起こし直しても同じ保持役につながる。
// Electron の utilityProcess もデータ置き場ごとの一時フォルダーで同じ保持役を使う。
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { bootEnv } from './boot-env.mjs';
import { holderKey } from './holder/protocol.mjs';

// 同期の終了処理を、process には 1 本だけ登録して配る。短命の子を片付けたら戻り値で解除する。
const exitCleanups = new Set();
const dispatchExit = code => { for (const cleanup of [...exitCleanups]) cleanup(code); };
export function onExit(cleanup) {
  const entry = code => cleanup(code);
  if (!exitCleanups.size) process.once('exit', dispatchExit);
  exitCleanups.add(entry);
  return () => {
    exitCleanups.delete(entry);
    if (!exitCleanups.size) process.off('exit', dispatchExit);
  };
}

/** 保持役の置き場が無いときの、データ置き場ごとの一時の置き場（同じデータ置き場なら同じ場所） */
export function defaultHolderRoot(dataDir, { tmpdir = os.tmpdir() } = {}) {
  return path.join(tmpdir, 'pleiad-holder', holderKey(dataDir));
}

/**
 * この起動で保持役を使える置き場。無ければ null。
 * root（AGENT_HOST_RUNTIME_ROOT）が無いときは、データ置き場ごとの一時の置き場を使う。
 */
export function holderRootFor({ dataDir, root = bootEnv('AGENT_HOST_RUNTIME_ROOT') } = {}) {
  if (!dataDir) return null;
  if (root) return root;
  return defaultHolderRoot(dataDir);
}

/**
 * 完了を待つ子を 1 回走らせる。プロセスのハンドルは返さない。
 * @returns Promise<{ exitCode, signal, stdout, stderr, durationMs, timedOut, stopped, truncated, leftover?, startError? }>
 *   exitCode は分からなければ null（止めた・時間切れ・起こせない）
 *   leftover は、子は終わったが出力のパイプを握ったプロセスが残った（exitCloseGraceMs を過ぎても close が来ない）
 *   onOutput(stream, piece) は、上限（maxOutputChars。文字数。runHostShell の OUTPUT_LIMIT と同じ数え方）に収まった分だけ呼ぶ
 */
export function run(command, args = [], {
  cwd, env, input = null, timeoutMs = 0, signal = null, onOutput = null,
  maxOutputChars = Infinity, windowsHide = true, detached = process.platform !== 'win32',
  stdio = ['ignore', 'pipe', 'pipe'], killTree = false, shell = false,
  exitCloseGraceMs = 0, killedCloseGraceMs = 0,
} = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const out = { stdout: '', stderr: '' };
    let truncated = false, timedOut = false, stopped = false, done = false;
    let child = null, exited = null, closeTimer = null, timer = null;
    let onAbort = () => {};
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ exitCode: null, signal: null, ...out, durationMs: Date.now() - started, timedOut, stopped, truncated, ...result });
    };
    const kill = () => {
      if (!child?.pid) return;
      if (!killTree) { try { child.kill('SIGKILL'); } catch { /* 既に終わっている */ } return; }
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 既に終わっている */ } } }
    };
    onAbort = () => { stopped = true; if (exited) finish({}); else kill(); };
    if (signal?.aborted) { stopped = true; finish({}); return; }
    // input を渡すときは、標準入力を開ける（既定は 'ignore'）
    const childStdio = input != null && stdio[0] === 'ignore' ? ['pipe', ...stdio.slice(1)] : stdio;
    try {
      child = spawn(command, Array.isArray(args) ? args.map(String) : [], { cwd, env, windowsHide, detached, stdio: childStdio, shell });
    } catch (error) { finish({ startError: String(error?.message ?? error) }); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; if (exited) finish({}); else kill(); }, timeoutMs);
    if (input != null && child.stdin) child.stdin.end(input);
    for (const stream of ['stdout', 'stderr']) {
      const readable = child[stream];
      if (!readable) continue;
      readable.setEncoding('utf8');
      readable.on('data', (text) => {
        const room = maxOutputChars - out[stream].length;
        if (room <= 0) { truncated = true; return; }
        const piece = text.length > room ? text.slice(0, Math.max(0, room)) : text;
        if (piece.length < text.length) truncated = true;
        out[stream] += piece;
        onOutput?.(stream, piece);
      });
    }
    child.on('error', error => finish({ startError: String(error?.message ?? error), startCode: error?.code ?? null }));
    child.on('close', (code, sig) => finish(stopped || timedOut ? {} : { exitCode: code, signal: sig ?? null }));
    child.on('exit', (code, sig) => {
      exited = { exitCode: code, signal: sig ?? null };
      const grace = stopped || timedOut ? killedCloseGraceMs : exitCloseGraceMs;
      if (grace <= 0) return;
      closeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(stopped || timedOut ? {} : { ...exited, leftover: true });
      }, grace);
      closeTimer.unref?.();
    });
  });
}

/**
 * 完了を待つ短命の子の同期版（spawnSync）。**イベントループを止める**ので、起動の準備・後片付けの小さなコマンドだけが使う
 * （core/backends/opencode-accounts.mjs の whoami・icacls。同期の prepareAccount から呼ばれる）。ふだんは run()
 * 戻り値の形は run() と同じ
 */
export function runSync(command, args = [], { cwd, env, input = null, timeoutMs = 0, maxOutputChars = Infinity, windowsHide = true, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  const started = Date.now();
  const result = spawnSync(command, Array.isArray(args) ? args.map(String) : [], {
    cwd, env, windowsHide, timeout: timeoutMs > 0 ? timeoutMs : undefined, input: input ?? undefined, encoding: 'utf8', stdio,
    ...(Number.isFinite(maxOutputChars) ? { maxBuffer: Math.max(1024, maxOutputChars * 4) } : {}),
  });
  const stdout = String(result.stdout ?? ''), stderr = String(result.stderr ?? '');
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return {
    exitCode: result.error ? null : result.status, signal: result.signal ?? null,
    stdout: stdout.slice(0, maxOutputChars), stderr: stderr.slice(0, maxOutputChars),
    durationMs: Date.now() - started, timedOut, stopped: false,
    truncated: stdout.length > maxOutputChars || stderr.length > maxOutputChars,
    ...(result.error && !timedOut ? { startError: String(result.error.message ?? result.error), startCode: result.error.code ?? null } : {}),
  };
}

/**
 * サーバーの子でない形（detached・stdio なし）で起こし、pid を返す。保持役自身の起動と、OS の既定のアプリで開くのが使う。
 * 起こせなければ投げる（ENOENT など）。起こした後の終了は見ない（unref）。
 * windowsVerbatimArguments は explorer.exe の /select,"…" を Node に引用させないために要る（core/os-open.mjs）
 */
export async function detach(command, args = [], { cwd, env, windowsHide = true, windowsVerbatimArguments = false } = {}) {
  const child = spawn(command, Array.isArray(args) ? args.map(String) : [], {
    cwd, env, detached: true, stdio: 'ignore', windowsHide, windowsVerbatimArguments,
  });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  child.on('error', () => {});
  child.unref();
  return { pid: child.pid };
}

/** 保持役の本体が子を起こすための生の口（stdin・stdout・stderr・pid・kill を持つハンドルを返す）。ほかからは使わない */
export function spawnChild(command, args = [], options = {}) {
  return spawn(command, Array.isArray(args) ? args.map(String) : [], options);
}

/** 親（サーバー）が居ないまま残った子を、保持役が止めるまでの既定（アプリが落ちた後も残り続けない保険。ADR 0270 決定 4） */
export const KEEP_MS = 10 * 60_000;

/**
 * 保持役に子を起こさせる。戻り値は { id, client, source }。source は core/adopt.mjs の holderSource（記録・write・ack）。
 * marks は { 名前: 通番 }（既定は 1）。起こした子の記録を、起動で拾い直せるように印を置く。
 * keepMs は、親が居ない状態が続いたら保持役が子を止めるまでの ms（既定は KEEP_MS。0 で止めない）。
 * 保持役を使えない（置き場が無い）ときは null。起こせない・つなげないときは投げる（呼び出し側が今の流れに落とす）
 */
export async function start({
  id, command, args = [], cwd, env, policy = 'none', label = null, marks = {}, keepMs = KEEP_MS,
  dataDir, root, key = '', appVersion = '', log = () => {}, idleMs = undefined,
} = {}) {
  const holderRoot = holderRootFor({ dataDir, root });
  if (!holderRoot || !id || !command) return null;
  const { holderLink } = await import('./holder/link.mjs');
  const { holderSource } = await import('./adopt.mjs');
  const client = await holderLink({
    dataDir, root: holderRoot, key, appVersion, log,
    ...(idleMs !== undefined ? { idleMs } : bootEnv('AGENT_HOST_HOLDER_IDLE_MS') ? { idleMs: Number(bootEnv('AGENT_HOST_HOLDER_IDLE_MS')) } : {}),
  });
  // 出来事の購読は spawn より前に始める（spawn の直後の行を取りこぼさない。core/adopt.mjs の holderSource）
  const source = holderSource(client, { id, acked: 0, seq: 0, marks }, { spawned: true });
  const sent = client.spawn({ id, command, args, cwd, env: env ?? process.env, policy, label, keepMs });
  if (!sent) { source.dispose(); throw Object.assign(new Error('the holder connection is closed'), { code: 'HOLDER_CLOSED' }); }
  for (const [name, seq] of Object.entries(marks)) client.mark(id, name, Number.isInteger(seq) && seq >= 1 ? seq : 1);
  return { id, client, source };
}
