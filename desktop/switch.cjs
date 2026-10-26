// 更新後の main が旧サーバーへ付け直した後、新しい版へ通常再起動する。
//
// createSwitch は副作用を全部 effects で受ける状態機械（実時間・実プロセスなしでテストする。tests/unit/desktop-switch.mjs）。
// createSwitchEffects が main の部品（ServerLink・desktop/server-boot.cjs・desktop/runtime.cjs）から effects を組み、startSwitch が両方をつなぐ。
//
// 状態（snapshot().state）:
//   current       切り替えは要らない（S1 がこの版）
//   preparing     新しい版の実行場所（chooseServer が裏で組み始めたもの）を待つ・起こせるか（Job）を見る
//   checking      事前の確かめ（core/compat-check.mjs）と、新しい版が固定した Claude Agent SDK の先取り（core/claude-sdk-fetch.mjs。ADR 0208）
//   incompatible  実行場所・データ形式が合わず、新しい main の起動確認が必要。reason は INCOMPATIBLE_REASONS
//   held          互換性の確認で「あとで」を選び、旧サーバーのまま待っている
//   locking       update-lock を取っている
//   stopping      S1 の shutdown の終わり（プロセスの終了）を待っている
//   starting      S2 を起こしている
//   fallback      S2 が立たなかったので、前の版（S1 の版）で起こし直している
//   reloading     窓を読み直している
//   restarting    新しい版を実行場所で起こせない更新: S1 を止めて main を起動し直す（起動で今の utilityProcess に落ちる）
//   done          切り替え終わり（previous: true なら前の版で動いている。retry() でやり直せる）
//   failed        S2 も前の版も起こせなかった
//   cancelled     main が終わる
//
// 切り替えの形（ADR 0270 決定 5）: 旧サーバーを普通に止め（shutdown）、新しい版を同じトークン・ポートで普通に起こす。新しいサーバーは起動で、
// 保持役に残った子（ターン・`!` の行・ply_shell のジョブ・外部 MCP・Chrome の接続）を自分で拾う。
//
// 互換性に問題がある場合だけ確認を行う。作業数・停止対象・待機時間では切り替えを止めない。
const path = require('node:path');
const { run } = require('./process.cjs');

/** S1 が shutdown を受けてから終わるまでの上限（plan.md 1-6 の 3） */
const STOP_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 30_000;
/** Claude Agent SDK の先取り（npm から 1.5 MB ほど）の上限。遅い回線とプロキシを見込む */
const CLAUDE_SDK_FETCH_TIMEOUT_MS = 5 * 60_000;
/** 事前の確かめで合わなかったときの理由。runtime・job・ipc は新しい版を実行場所で起こせないので、中断した後は main を起動し直す */
const INCOMPATIBLE_REASONS = ['schema', 'ipc', 'runtime', 'job', 'check'];
const RESTART_REASONS = new Set(['runtime', 'job', 'ipc']);
/** S1 を手放している間（onServerExit の「サーバーが終了しました」を出さない） */
const REPLACING = new Set(['stopping', 'starting', 'fallback', 'reloading', 'restarting']);
/** main との口の版（desktop/server-link.cjs の IPC_RANGE と同じ） */
const MAIN_IPC = [1, 1];

const errorText = error => (error ? String(error.message ?? error) : null);

/** 版とビルドで、S1 を S2 へ替えるか。ビルドが両方分かればビルドで、どちらかが分からなければ版で比べる */
function needsSwitch(server, target) {
  if (!server || !target) return false;
  if (server.build && target.build) return server.build !== target.build;
  return String(server.appVersion ?? '') !== String(target.appVersion ?? '');
}


/** compat-check の出力を、この main と今のデータ置き場で使えるか判定する。{ ok: true } か { ok: false, reason, detail } */
function judgeCheck(check, { ipc = MAIN_IPC } = {}) {
  if (!check || check.error || check.check !== 1) return { ok: false, reason: 'check', detail: check?.error ?? 'no result' };
  const range = check.ipc;
  if (!Array.isArray(range) || range.length !== 2 || !(range[0] <= ipc[1] && range[1] >= ipc[0])) return { ok: false, reason: 'ipc', detail: `ipc ${JSON.stringify(range)}` };
  if (Number.isInteger(check.dataSchemaFound) && check.dataSchemaFound !== check.dataSchema) {
    return { ok: false, reason: 'schema', detail: `data schema ${check.dataSchemaFound} -> ${check.dataSchema}` };
  }
  return { ok: true };
}

/**
 * 切り替えの状態機械。
 *   server   S1 の { appVersion, build }（ready から）
 *   target   この版の { appVersion, build }、またはそれを返す関数（Promise でもよい）
 *   effects  {
 *     prepare()            → { ok: true, runtime, mode } / { ok: false, reason: 'runtime'|'job', detail }
 *     check(runtime)       → compat-check の出力
 *     claudeSdk(runtime)   → claude-sdk-fetch の出力（{ ready, consent, kind? }。無くてもよい。無ければ先取りしない）
 *     ask({ reason })       → 'now' | 'later'（互換性が無い場合の確認）。
 *                          画面が答える（answer）ときは null・undefined を返す（ダイアログを出さない）
 *     lock() / unlock()    update-lock（{ ok, reason }）/ update-unlock
 *     stopOld()            S1 に shutdown を送り、プロセスが終わるのを待つ → { ok } / { ok: false, error }
 *     reattachOld()        S1 が終わらなかったとき付け直す → boolean
 *     startNew(runtime, mode) / startPrevious(runtime, mode) → S2 の ready（失敗は例外）
 *     reload(ready)        窓を読み直す
 *     restart()            main を起動し直す
 *     fallback(error)      前の版で動いていることを知らせる
 *     failed(error)        どちらも起こせなかった
 *     delay(ms)
 *   }
 */
function createSwitch({ server, target, effects, log = () => {}, now = () => Date.now() }) {
  let snap = { state: 'idle', server, target: typeof target === 'function' ? null : target, reason: null, error: null, previous: false, at: null };
  const listeners = new Set();
  let cancelled = false;
  let release = null;
  let pendingAnswer = null;
  let running = null;

  const emit = patch => {
    snap = { ...snap, ...patch };
    for (const listener of [...listeners]) {
      try { listener(snap); } catch (error) { log(`state listener threw: ${errorText(error)}`); }
    }
  };
  /** 新しい版の実行場所で Claude Agent SDK を取っておく（更新後に保持役の Claude のターンを付け直すため）。置き場にあれば true */
  async function fetchClaudeSdk(runtime) {
    const out = await Promise.resolve(effects.claudeSdk(runtime)).catch(error => ({ ready: false, kind: 'run', detail: errorText(error) }));
    if (out?.ready === true) return true;
    log(`the Claude Agent SDK of the new version is not ready (${out?.consent === false ? 'no consent' : `${out?.kind ?? '?'}${out?.detail ? `: ${out.detail}` : ''}`}): Claude turns on the holder will not be adopted`);
    return false;
  }

  /** 画面かダイアログの答えを待つ（effects.ask が答えを返さなければ answer() だけを待つ） */
  const askUser = info => new Promise(resolve => {
    pendingAnswer = resolve;
    Promise.resolve(effects.ask?.(info)).then(answer => { if (answer) resolve(answer); }, () => resolve('later'));
  }).finally(() => { pendingAnswer = null; });

  /** 保持役の子を残したまま、通常の停止と通常起動に切り替える。更新を作業の終了まで待たせない。 */
  async function beginSwitch() {
    if (cancelled) return false;
    emit({ state: 'locking' });
    const lock = await effects.lock().catch(error => ({ ok: false, reason: errorText(error) }));
    if (cancelled) { if (lock?.ok) effects.unlock(); return false; }
    if (!lock?.ok) {
      emit({ state: 'failed', error: lock?.reason ?? 'update lock is unavailable' });
      return false;
    }
    emit({ error: null });
    return true;
  }

  async function run() {
    const goal = typeof target === 'function' ? await target() : target;
    emit({ target: goal ?? null });
    if (!needsSwitch(snap.server, goal)) { emit({ state: 'current' }); return snap; }
    log(`the running server is ${snap.server.appVersion || '?'} (${snap.server.build || '?'}), this version is ${goal.appVersion || '?'} (${goal.build || '?'}): switching`);
    emit({ state: 'preparing' });
    let plan = await Promise.resolve(effects.prepare()).catch(error => ({ ok: false, reason: 'runtime', detail: errorText(error) }));
    if (plan?.ok) {
      emit({ state: 'checking' });
      const check = await Promise.resolve(effects.check(plan.runtime)).catch(error => ({ error: errorText(error) }));
      plan = { ...plan, ...judgeCheck(check) };
      // 新しい版が固定した SDK を、切り替えの前に取っておく（取れなくても切り替えは止めない。取れていなければ、保持役の Claude のターンは付け直せず中断になる）
      if (plan.ok && effects.claudeSdk && !cancelled) plan = { ...plan, claudeSdk: await fetchClaudeSdk(plan.runtime) };
    }
    if (cancelled) return cancel();
    let restart = false;
    if (!plan?.ok) {
      const reason = INCOMPATIBLE_REASONS.includes(plan?.reason) ? plan.reason : 'check';
      log(`the new version cannot take over while work is running (${reason}${plan?.detail ? `: ${plan.detail}` : ''})`);
      emit({ state: 'incompatible', reason, error: plan?.detail ?? null });
      const answer = await askUser({ reason });
      if (cancelled) return cancel();
      if (answer !== 'now') {
        emit({ state: 'held' });
        await new Promise(resolve => { release = resolve; });
        release = null;
        if (cancelled) return cancel();
      }
      restart = RESTART_REASONS.has(reason);
    }

    if (!await beginSwitch()) return snap;
    emit({ state: 'stopping' });
    const stopped = await Promise.resolve(effects.stopOld()).catch(error => ({ ok: false, error: errorText(error) }));
    if (!stopped?.ok) {
      log(`the old server did not stop: ${stopped?.error ?? '?'}`);
      if (await Promise.resolve(effects.reattachOld()).catch(() => false)) effects.unlock();
      emit({ state: 'failed', error: stopped?.error ?? 'the old server did not stop' });
      return snap;
    }

    if (restart) {
      emit({ state: 'restarting' });
      await effects.restart();
      return snap;
    }
    let ready = null;
    let failure = null;
    emit({ state: 'starting' });
    try { ready = await effects.startNew(plan.runtime, plan.mode); }
    catch (error) { failure = error; }
    let previous = false;
    if (!ready) {
      log(`the new server did not start: ${errorText(failure)}; starting the previous version again`);
      emit({ state: 'fallback', error: errorText(failure) });
      try { ready = await effects.startPrevious(plan.runtime, plan.mode); previous = true; }
      catch (error) {
        log(`the previous version did not start either: ${errorText(error)}`);
        emit({ state: 'failed', error: errorText(error) });
        await Promise.resolve(effects.failed(failure ?? error)).catch(() => {});
        return snap;
      }
    }
    emit({ state: 'reloading', previous });
    try { await effects.reload(ready); }
    catch (error) { log(`reloading the window failed: ${errorText(error)}`); }
    emit({ state: 'done', previous, server: { appVersion: ready.appVersion ?? null, build: ready.build ?? null }, at: now() });
    if (previous) await Promise.resolve(effects.fallback(failure)).catch(() => {});
    return snap;
  }

  function cancel() {
    emit({ state: 'cancelled' });
    return snap;
  }

  return {
    run() { running ??= run(); return running; },
    snapshot: () => snap,
    onState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** 互換性の確認で「あとで」を選ぶ。 */
    answer(value) {
      if (value !== 'later' || !pendingAnswer) return false;
      pendingAnswer('later');
      return true;
    },
    /** 前の版で動いているとき、切り替えをやり直す。 */
    retry() {
      if (snap.state !== 'done' || !snap.previous) return false;
      emit({ state: 'idle', previous: false, error: null, reason: null, at: null });
      running = run();
      running.catch(error => log(`switching failed: ${errorText(error)}`));
      return true;
    },
    /** main が終わる。互換性確認の待ちだけを解く。 */
    cancel() {
      cancelled = true;
      release?.();
      pendingAnswer?.('later');
    },
    /** S1 を手放している間か（main.cjs の onServerExit が「サーバーが終了しました」を出さない） */
    get replacing() { return REPLACING.has(snap.state); },
  };
}

// ---- 副作用

/** 組んだ実行場所で core/<script> を走らせ、標準出力の最後の行の JSON を返す（中は desktop/process.cjs の run） */
async function runAppScript(script, { nodeExe, appDir, dataDir, env = process.env, runFile = run, timeoutMs }) {
  const childEnv = { ...env, AGENT_HOST_DATA: dataDir };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const name = path.basename(script, '.mjs');
  const result = await runFile(nodeExe, [path.join(appDir, 'core', script)], { cwd: appDir, env: childEnv, timeoutMs, windowsHide: true, maxOutputChars: 1024 * 1024 });
  if (result.startError || result.exitCode !== 0 || result.timedOut) {
    const detail = result.startError ?? (result.timedOut ? 'timed out' : `exit ${result.exitCode}`);
    throw new Error(`${name} failed: ${detail}${result.stderr ? `\n${String(result.stderr).slice(-500)}` : ''}`);
  }
  const line = String(result.stdout).trim().split(/\r?\n/).pop();
  try { return JSON.parse(line); } catch { throw new Error(`${name} printed no JSON`); }
}

/** 組んだ実行場所で core/compat-check.mjs を走らせ、出力の JSON を返す */
function runCompatCheck({ timeoutMs = CHECK_TIMEOUT_MS, ...options }) {
  return runAppScript('compat-check.mjs', { ...options, timeoutMs });
}

/** 組んだ実行場所で core/claude-sdk-fetch.mjs を走らせ、新しい版が固定した Claude Agent SDK を置き場に取っておく（ADR 0208） */
function runClaudeSdkFetch({ timeoutMs = CLAUDE_SDK_FETCH_TIMEOUT_MS, ...options }) {
  return runAppScript('claude-sdk-fetch.mjs', { ...options, timeoutMs });
}

/** 次に届く ready を待つ（S2 はつながった直後に ready を送る。つなぐ前に付ける） */
function waitForReady(link, timeoutMs) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    const onMessage = message => { if (message?.type === 'ready') { done(); resolve(message); } };
    const timer = setTimeout(() => { done(); reject(Object.assign(new Error('the new server sent no ready'), { code: 'timeout' })); }, timeoutMs);
    const done = () => { clearTimeout(timer); link.off('message', onMessage); };
    cancel = done;
    link.on('message', onMessage);
  });
  promise.catch(() => {});
  return { promise, cancel: () => cancel() };
}

/**
 * main の部品から effects を組む。
 *   link      S1 につながっている ServerLink（S2 にも同じ包みでつなぐ。'message' の登録が残る）
 *   ready     S1 の ready（port・token・runtimeKey。S2 は同じトークン・ポートで起こす。design.md §8）
 *   prepared  この版の実行場所（chooseServer の prepared）
 *   ask / reload / restart / fallback / failed  main の窓と互換性ダイアログ（main.cjs が渡す）
 *   rearm     同じ包みにつなぎ直した後に呼ぶ（main.cjs が once('exit') の見張りを付け直す）
 */
function createSwitchEffects({ link, ready, prepared, dataDir, resourcesPath, execPath, systemLocale = '', cwd, env = process.env,
  request, ask, reload, restart, fallback, failed, rearm = () => {}, log = () => {},
  boot = require('./server-boot.cjs'), job = () => require('./job.cjs'), runtimeLib = () => require('./runtime.cjs'), check = runCompatCheck, fetchClaudeSdk = runClaudeSdkFetch,
  alive = pid => boot.isAlive(pid), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(),
  stopTimeoutMs = STOP_TIMEOUT_MS, readyTimeoutMs = boot.START_TIMEOUT_MS,
  exists = file => require('node:fs').existsSync(file) }) {
  const oldPid = () => link.pid ?? ready.pid ?? null;

  async function start(runtime, mode) {
    const env2 = boot.serverEnv({ baseEnv: env, agentBrowserDir: runtime.agentBrowserDir, root: runtime.root, key: runtime.key, logFile: boot.serverLogFile(runtime.root),
      port: ready.port, token: ready.token, systemLocale, execPath, resourcesPath, stableCliEnv: runtimeLib().stableCliEnv({ execPath, resourcesPath }) });
    let launched = null;
    const next = waitForReady(link, readyTimeoutMs);
    try {
      await boot.startAndConnect({ link, dataDir, logFile: boot.serverLogFile(runtime.root), log,
        launch: async () => (launched = await boot.launchServer({ mode, nodeExe: runtime.nodeExe, args: [path.join(runtime.appDir, 'core', 'server.mjs')], cwd, env: env2 })) });
      rearm();
      const started = await next.promise;
      // 切り替えをやり直すとき（前の版で動いている）の古いサーバーは、今起こしたもの
      Object.assign(ready, { port: started.port, token: started.token, pid: started.pid, runtimeKey: started.runtimeKey });
      return started;
    } catch (error) {
      next.cancel();
      // 立ちかけたサーバーがデータ置き場を持ったままだと、前の版で起こし直せない。自分が起こしたものだけを止める
      if (launched?.pid && alive(launched.pid)) {
        link.leave?.('switch-failed');
        try { process.kill(launched.pid); } catch { /* もう居ない */ }
      }
      throw error;
    }
  }

  return {
    delay: sleep,
    async prepare() {
      const decision = job().decideLaunch(job().inspectJob());
      if (decision.mode === 'unsupported') return { ok: false, reason: 'job', detail: decision.reason };
      const runtime = await prepared;
      if (!runtime) return { ok: false, reason: 'runtime', detail: 'the runtime location could not be prepared' };
      return { ok: true, runtime, mode: decision.mode };
    },
    check: runtime => check({ nodeExe: runtime.nodeExe, appDir: runtime.appDir, dataDir, env }),
    claudeSdk: runtime => fetchClaudeSdk({ nodeExe: runtime.nodeExe, appDir: runtime.appDir, dataDir, env }),
    ask,
    lock: () => request('update-lock'),
    unlock: () => { link.postMessage({ type: 'update-unlock' }); },
    async stopOld() {
      const pid = oldPid();
      link.postMessage({ type: 'shutdown' });
      const until = now() + stopTimeoutMs;
      while (pid && alive(pid)) {
        if (now() >= until) return { ok: false, error: `the old server (pid ${pid}) did not stop in ${Math.round(stopTimeoutMs / 1000)}s` };
        await sleep(100);
      }
      return { ok: true };
    },
    async reattachOld() {
      if (!alive(oldPid())) return false;
      if (link.connected) return true;
      const attached = await boot.reattachServer({ link, dataDir, log });
      if (attached) rearm();
      return attached;
    },
    startNew: (runtime, mode) => start(runtime, mode),
    async startPrevious(runtime, mode) {
      const previous = ready.runtimeKey ? await runtimeLib().locate({ root: runtime.root, key: ready.runtimeKey }) : null;
      if (!previous) throw new Error(`the previous version is not in the runtime location (${ready.runtimeKey ?? 'unknown'})`);
      return start(previous, mode);
    },
    reload,
    restart,
    fallback,
    failed,
  };
}

/**
 * 実行場所やデータ形式が互換でない版を起動し直す確認。t は desktop/i18n.cjs の t。
 */
function incompatibleDialog({ dialog, getWindow, t }) {
  const reasons = { schema: () => t('switch.reasonSchema'), ipc: () => t('switch.reasonIpc'), runtime: () => t('switch.reasonRuntime'), job: () => t('switch.reasonJob'), check: () => t('switch.reasonCheck') };
  return async ({ reason }) => {
    const message = [(reasons[reason] ?? reasons.check)(), t('switch.incompatibleLater')].join('\n\n');
    const options = { type: 'info', title: t('switch.incompatibleTitle'), message, buttons: [t('switch.later'), t('switch.updateNow')], defaultId: 0, cancelId: 0, noLink: true };
    const window = getWindow();
    const { response } = await (window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
    return response === 1 ? 'now' : 'later';
  };
}

/** 状態の移り変わりを 1 行ずつログに残す */
function logStates(control, log) {
  let last = '';
  return control.onState(s => {
    const line = `${s.state}${s.reason ? ` (${s.reason})` : ''}${s.error ? ` — ${s.error}` : ''}`;
    if (line !== last && s.state !== 'idle') log(line);
    last = line;
  });
}

/**
 * 付け直したサーバーが古い版なら切り替えを始める。戻り値は createSwitch の制御（run は始まっている）。
 *   linked         chooseServer の戻り値（link・prepared）
 *   ready          S1 の ready
 *   resourcesPath  この版の resources\（app\manifest.json の版とビルドが切り替えの先）
 * ほかは createSwitchEffects の引数
 */
function startSwitch({ linked, ready, resourcesPath, log = () => {}, readManifest = dir => require('./runtime-manifest.cjs').readManifest(dir), ...rest }) {
  const { shortBuildHash } = require('./runtime-manifest.cjs');
  const server = { appVersion: ready.appVersion ?? linked.link.serverInfo?.appVersion ?? '', build: ready.build ?? null };
  const target = async () => {
    try {
      const manifest = await readManifest(path.join(resourcesPath, 'app'));
      return { appVersion: manifest.appVersion, build: shortBuildHash(manifest.buildHash) };
    } catch (error) {
      log(`the manifest of this version could not be read (${errorText(error)}): not switching`);
      return null;
    }
  };
  const effects = createSwitchEffects({ link: linked.link, ready, prepared: linked.prepared, resourcesPath, log, ...rest });
  const control = createSwitch({ server, target, effects, log });
  logStates(control, log);
  control.run().catch(error => log(`switching failed: ${errorText(error)}`));
  return control;
}

module.exports = {
  STOP_TIMEOUT_MS, INCOMPATIBLE_REASONS, RESTART_REASONS, MAIN_IPC,
  needsSwitch, judgeCheck, createSwitch, runCompatCheck, runClaudeSdkFetch, waitForReady, createSwitchEffects, incompatibleDialog, startSwitch,
};
