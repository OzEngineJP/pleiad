// 本体の窓（desktop/main.cjs）とリモートの窓（desktop/remote-windows.cjs）で共有する renderer 復帰・ログ記録・ダンプ保護。
// 短い間に続けて落ちるとき（既定: 60 秒に 3 回）は自動の読み直しを止め、利用者に「読み直す / Pleiad を再起動する」を選ばせる。
const fs = require('node:fs');
const path = require('node:path');
const { redactUrlTokens } = require('./desktop-log.cjs');

const MAX_RENDERER_CRASHES = 3;
const RENDERER_CRASH_WINDOW_MS = 60_000;
const MAX_CRASH_DUMPS = 10;
const MAX_CRASH_DUMP_BYTES = 50 * 1024 * 1024;
const CRASH_DUMP_SUBDIRS = ['', 'reports', 'pending', 'completed', 'new'];

/**
 * 指定時間窓内のクラッシュ回数を数え、連続クラッシュによる無限リロードを防ぐ。
 */
function createCrashTracker({ maxCrashes = MAX_RENDERER_CRASHES, windowMs = RENDERER_CRASH_WINDOW_MS, now = () => Date.now() } = {}) {
  let timestamps = [];
  function prune(current) {
    timestamps = timestamps.filter(ts => current - ts < windowMs);
  }
  return {
    recordCrash() {
      const timestamp = now();
      prune(timestamp);
      timestamps.push(timestamp);
      return { count: timestamps.length, loop: timestamps.length >= maxCrashes, timestamp };
    },
    recentCount() {
      prune(now());
      return timestamps.length;
    },
    reset() {
      timestamps = [];
    },
  };
}

/**
 * Crashpad / Breakpad の保存先を走査し、件数と合計サイズの上限を超える古い .dmp と添付を消す。
 */
function pruneCrashDumps(crashDumpsDir, { maxFiles = MAX_CRASH_DUMPS, maxBytes = MAX_CRASH_DUMP_BYTES, fsSync = fs } = {}) {
  const result = { dir: crashDumpsDir || null, removed: 0, kept: 0, totalBytes: 0 };
  if (!crashDumpsDir) return result;
  const seen = new Set();
  const dumps = [];
  for (const sub of CRASH_DUMP_SUBDIRS) {
    const dir = sub ? path.join(crashDumpsDir, sub) : crashDumpsDir;
    let entries;
    try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.dmp$/i.test(entry.name)) continue;
      const filePath = path.join(dir, entry.name);
      const key = path.resolve(filePath).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const stat = fsSync.statSync(filePath);
        dumps.push({ filePath, stem: entry.name.replace(/\.dmp$/i, ''), size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }
  dumps.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.size - a.size));
  for (const item of dumps) {
    if (result.kept < maxFiles && result.totalBytes + item.size <= maxBytes) {
      result.kept++;
      result.totalBytes += item.size;
      continue;
    }
    try {
      fsSync.unlinkSync(item.filePath);
      result.removed++;
      const attachmentDir = path.join(crashDumpsDir, 'attachments', item.stem);
      try { fsSync.rmSync(attachmentDir, { recursive: true, force: true }); } catch {}
    } catch {}
  }
  return result;
}

/**
 * 送信なし（uploadToServer: false）のローカル crashReporter を早い段階で始め、起動前に古いダンプを刈り込む。
 * app.setPath('crashDumps', ...) は Electron 44 の Windows で Crashpad 登録を壊すため呼ばず、
 * dev-identity.cjs が設定する app 名（userData の分離）をそのまま使う。
 */
function startCrashReporting({ app, crashReporter, logger, maxFiles = MAX_CRASH_DUMPS, maxBytes = MAX_CRASH_DUMP_BYTES, fsSync = fs } = {}) {
  let crashDumpsDir = null;
  try { crashDumpsDir = app?.getPath?.('crashDumps') || null; } catch {}
  const pruned = pruneCrashDumps(crashDumpsDir, { maxFiles, maxBytes, fsSync });
  let started = false;
  if (typeof crashReporter?.start === 'function') {
    try {
      crashReporter.start({ uploadToServer: false, productName: app?.getName?.() || 'Pleiad', compress: true });
      started = true;
    } catch (error) {
      logger?.warn?.(`crashReporter start failed: ${error?.message || error}`);
    }
  }
  if (started || pruned.removed > 0) {
    logger?.info?.(`crash-reporter started=${started} dir=${crashDumpsDir || ''} pruned=${pruned.removed} kept=${pruned.kept} bytes=${pruned.totalBytes}`);
  }
  return { started, crashDumpsDir, pruned };
}

/** GPU / Utility など子プロセスの終了を同じログへ残す。 */
function attachChildProcessCrashLogging({ app, logger, startedAt = Date.now(), now = () => Date.now() } = {}) {
  if (typeof app?.on !== 'function') return () => {};
  const handler = (_event, details = {}) => {
    const uptimeMs = Math.max(0, now() - startedAt);
    const extra = [];
    if (details.serviceName) extra.push(`service=${JSON.stringify(String(details.serviceName))}`);
    if (details.name) extra.push(`name=${JSON.stringify(String(details.name))}`);
    if (details.systemErrorCode !== undefined) extra.push(`systemErrorCode=${details.systemErrorCode}`);
    const suffix = extra.length ? ` ${extra.join(' ')}` : '';
    logger?.error?.(`child-process-gone type=${details.type ?? 'unknown'} reason=${details.reason ?? 'unknown'} exitCode=${details.exitCode ?? ''} uptimeMs=${uptimeMs}${suffix}`);
  };
  app.on('child-process-gone', handler);
  return () => app.off?.('child-process-gone', handler);
}

/** 連続クラッシュ時に「読み直す / Pleiad を再起動する」を選ぶ共通ダイアログを作る。 */
function createLoopPrompter({ dialog, t }) {
  return async ({ win } = {}) => {
    if (typeof dialog?.showMessageBox !== 'function') return 'reload';
    const options = {
      type: 'warning',
      title: t('renderer.crashedTitle'),
      message: t('renderer.crashedMessage'),
      buttons: [t('renderer.reload'), t('renderer.restart')],
      defaultId: 0,
      noLink: true,
    };
    const result = win && !win.isDestroyed?.() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return result?.response === 1 ? 'restart' : 'reload';
  };
}

/**
 * 1 枚の BrowserWindow に renderer 復帰・連続クラッシュ打ち切り・読み込み失敗/無応答の記録を付ける。
 */
function attachWindowHealth({ win, label = 'window', reload, onRestart, onLoopPrompt, isQuitting = () => false, logger, tracker = createCrashTracker(), startedAt = Date.now(), now = () => Date.now(), onCrashDumped = null } = {}) {
  if (!win) return { tracker, dispose: () => {} };
  const wc = win.webContents;
  let promptOpen = false;
  const isDead = () => Boolean(win.isDestroyed?.() || isQuitting?.());

  const onGone = async (_event, details = {}) => {
    if (isDead()) return;
    const reason = details.reason ?? 'unknown';
    const exitCode = details.exitCode ?? '';
    const uptimeMs = Math.max(0, now() - startedAt);
    if (reason === 'clean-exit') {
      logger?.info?.(`render-process-gone window=${label} reason=clean-exit exitCode=${exitCode} uptimeMs=${uptimeMs} action=ignored`);
      return;
    }
    logger?.error?.(`render-process-gone window=${label} reason=${reason} exitCode=${exitCode} uptimeMs=${uptimeMs}`);
    try { onCrashDumped?.(); } catch {}
    const state = tracker.recordCrash();
    if (!state.loop) {
      logger?.info?.(`renderer-reload window=${label} attempt=${state.count}`);
      try {
        if (!isDead()) await reload?.();
      } catch (error) {
        logger?.warn?.(`renderer-reload window=${label} failed=${error?.message || error}`);
      }
      return;
    }
    logger?.warn?.(`renderer-crash-loop window=${label} crashes=${state.count}`);
    if (promptOpen) return;
    promptOpen = true;
    try {
      const choice = await onLoopPrompt?.({ win, label, details, count: state.count });
      if (isDead()) return;
      if (choice === 'restart') {
        logger?.info?.(`renderer-loop-action window=${label} action=restart`);
        await onRestart?.();
      } else if (choice === 'reload') {
        logger?.info?.(`renderer-loop-action window=${label} action=reload`);
        tracker.reset();
        if (!isDead()) await reload?.();
      }
    } catch (error) {
      logger?.warn?.(`renderer-loop-action window=${label} failed=${error?.message || error}`);
    } finally {
      promptOpen = false;
    }
  };

  const onDidFailLoad = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isDead() || !isMainFrame) return;
    logger?.warn?.(`did-fail-load window=${label} code=${errorCode} desc=${JSON.stringify(String(errorDescription ?? ''))} url=${redactUrlTokens(validatedURL)}`);
  };

  const onUnresponsive = () => {
    if (isDead()) return;
    logger?.warn?.(`window-unresponsive window=${label} uptimeMs=${Math.max(0, now() - startedAt)}`);
  };

  const onResponsive = () => {
    if (isDead()) return;
    logger?.info?.(`window-responsive window=${label} uptimeMs=${Math.max(0, now() - startedAt)}`);
  };

  wc?.on?.('render-process-gone', onGone);
  wc?.on?.('did-fail-load', onDidFailLoad);
  win.on?.('unresponsive', onUnresponsive);
  win.on?.('responsive', onResponsive);

  return {
    tracker,
    dispose() {
      wc?.off?.('render-process-gone', onGone);
      wc?.off?.('did-fail-load', onDidFailLoad);
      win.off?.('unresponsive', onUnresponsive);
      win.off?.('responsive', onResponsive);
    },
  };
}

module.exports = {
  MAX_RENDERER_CRASHES,
  RENDERER_CRASH_WINDOW_MS,
  MAX_CRASH_DUMPS,
  MAX_CRASH_DUMP_BYTES,
  createCrashTracker,
  pruneCrashDumps,
  startCrashReporting,
  attachChildProcessCrashLogging,
  createLoopPrompter,
  attachWindowHealth,
};
