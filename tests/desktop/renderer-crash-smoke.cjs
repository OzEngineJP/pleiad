// 実物の Electron で本体の窓の renderer 落ち・復帰・連続打ち切り・desktop.log・crashDumps を確かめるスモーク試験。
// 利用者の実データ (~/.agent-host・%APPDATA%\Pleiad) には一切触れないため、--user-data-dir と AGENT_HOST_DATA を一時領域へ逃がす。
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, dialog, crashReporter } = require('electron');

// Chromium が起動直後に Crashpad を開く先はコマンドラインの --user-data-dir で決まる。
// 未指定のまま直接 `electron tests/desktop/renderer-crash-smoke.cjs` が呼ばれた場合は、専用の一時領域を付けて自分を起こし直す。
const hasUserDataFlag = process.argv.some(arg => arg.startsWith('--user-data-dir='));
if (!hasUserDataFlag) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-renderer-crash-smoke-'));
  const userDataDir = path.join(tmpRoot, 'user-data');
  const childEnv = { ...process.env, PLEIAD_SMOKE_ROOT: tmpRoot };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(
    process.execPath,
    [__filename, `--user-data-dir=${userDataDir}`],
    { env: childEnv, stdio: 'inherit' },
  );
  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  app.exit(result.status ?? 1);
  return;
}

const ownRoot = !process.env.PLEIAD_SMOKE_ROOT;
const tmpRoot = process.env.PLEIAD_SMOKE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-renderer-crash-smoke-'));
const userDataFlag = process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const userDataDir = path.resolve(userDataFlag);
const homeDir = path.join(tmpRoot, 'home');
const dataDir = path.join(tmpRoot, 'data');
const holderDir = path.join(tmpRoot, 'holder');
for (const dir of [userDataDir, homeDir, dataDir, holderDir, path.join(userDataDir, 'logs')]) {
  fs.mkdirSync(dir, { recursive: true });
}

for (const key of Object.keys(process.env)) {
  if (/^(PLEIAD_|PLY_|AGENT_BROWSER_)/.test(key) && key !== 'PLEIAD_SMOKE_ROOT') {
    delete process.env[key];
  }
}
process.env.AGENT_HOST_DATA = dataDir;
process.env.AGENT_HOST_RUNTIME_ROOT = holderDir;
process.env.AGENT_HOST_SERVER_LOG = path.join(userDataDir, 'logs', 'server-dev.log');
process.env.AGENT_HOST_BACKENDS = 'fake';
process.env.AGENT_HOST_HANDOVER = 'off';
process.env.AGENT_HOST_LOCALE = 'ja';

app.setPath('userData', userDataDir);
app.setPath('home', homeDir);

// スモーク専用のダイアログ・終了・relaunch のフック（モーダルで止まらず、選択ごとの分岐を検証する）
const dialogResponses = [];
const recordedDialogs = [];
const recordedRelaunches = [];
let quitCount = 0;

dialog.showMessageBox = async (...args) => {
  const options = args.length >= 2 ? args[1] : args[0];
  recordedDialogs.push(options);
  const response = dialogResponses.length > 0 ? dialogResponses.shift() : 0;
  return { response, checkboxChecked: false };
};
app.relaunch = opts => {
  recordedRelaunches.push(opts);
};

// 外部ブラウザーを開かない
const { shell } = require('electron');
shell.openExternal = async () => {};

function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

function waitFor(fn, { timeoutMs = 15000, intervalMs = 50, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        const value = await fn();
        if (value) return resolve(value);
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error(`Timeout waiting for ${label} after ${timeoutMs}ms`));
      }
      setTimeout(check, intervalMs);
    };
    void check();
  });
}

function getClosedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let mainWindow = null;
app.on('browser-window-created', (_event, win) => {
  if (!mainWindow && win.webContents) {
    mainWindow = win;
    // 無人のスモーク試験でユーザーの作業中の前面を奪わない
    win.show = () => {};
    win.focus = () => {};
  }
});

// テストの最後だけ本当の本プロセス終了を走らせる
const nativeQuit = app.quit.bind(app);
let allowExit = false;
app.quit = () => {
  quitCount++;
  if (allowExit) return nativeQuit();
};

const timer = setTimeout(() => {
  console.error('TIMEOUT in renderer-crash-smoke');
  app.exit(1);
}, 60_000);
timer.unref();

// 実物の desktop/main.cjs を読み込んで起動させる
require('../../desktop/main.cjs');

async function runSmoke() {
  await app.whenReady();

  // 1. 本体の BrowserWindow と初期 UI 読み込み完了を待つ
  await waitFor(() => mainWindow && !mainWindow.isDestroyed(), { label: 'mainWindow created' });
  await waitFor(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return false;
    const url = mainWindow.webContents.getURL();
    if (!url.startsWith('http://127.0.0.1:')) return false;
    const htmlLen = await mainWindow.webContents.executeJavaScript('document.body ? document.body.innerHTML.length : 0').catch(() => 0);
    return htmlLen > 100;
  }, { timeoutMs: 25_000, label: 'initial Pleiad UI load' });

  const initialUrl = mainWindow.webContents.getURL();
  const initialPort = new URL(initialUrl).port;

  // Crashpad の保存先が一時ディレクトリ（userData 配下）に隔離されていること
  const crashDumpsDir = app.getPath('crashDumps');
  assert(
    crashDumpsDir.toLowerCase().startsWith(userDataDir.toLowerCase()),
    `crashDumps must be under isolated userData (${crashDumpsDir} not under ${userDataDir})`,
  );

  // ダンプの上限掃除が本物のタイマーで効くかを見るため、reports に 12 個の古い .dmp を仕込む
  const reportsDir = path.join(crashDumpsDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    const f = path.join(reportsDir, `smoke-old-${String(i).padStart(2, '0')}.dmp`);
    fs.writeFileSync(f, 'x'.repeat(1024));
    const mtime = new Date(now - (20 - i) * 1000);
    fs.utimesSync(f, mtime, mtime);
  }

  // 2. did-fail-load を起こし、token が伏せられて desktop.log に残ること（挙動は変えない）
  const closedPort = await getClosedPort();
  await mainWindow.loadURL(`http://127.0.0.1:${closedPort}/?token=SMOKE_SECRET_TOKEN_XYZ`).catch(() => {});
  const desktopLogFile = path.join(userDataDir, 'logs', 'desktop.log');
  await waitFor(() => {
    if (!fs.existsSync(desktopLogFile)) return false;
    return fs.readFileSync(desktopLogFile, 'utf8').includes('did-fail-load');
  }, { label: 'did-fail-load logged' });

  // 3-4. did-finish-load を待ってから DOM を確かめる（crashed 直後の executeJavaScript ハングを避ける）
  async function crashAndWaitReload(label) {
    const gone = new Promise(resolve => mainWindow.webContents.once('render-process-gone', (_e, d) => resolve(d)));
    const loaded = new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
    mainWindow.webContents.forcefullyCrashRenderer();
    const detail = await gone;
    await loaded;
    await waitFor(async () => {
      if (mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame() || mainWindow.webContents.isCrashed()) return false;
      const url = mainWindow.webContents.getURL();
      if (!url.startsWith(`http://127.0.0.1:${initialPort}/`)) return false;
      const htmlLen = await mainWindow.webContents.executeJavaScript('document.body ? document.body.innerHTML.length : 0').catch(() => 0);
      return htmlLen > 100;
    }, { timeoutMs: 20_000, label });
    return detail;
  }

  // 3. 1 回目の renderer 落ち: 自動で正しい URL (initialUrl) へ読み直されて画面が戻る
  const detail1 = await crashAndWaitReload('renderer recovery #1');
  assert(detail1 && detail1.reason !== 'clean-exit', `unexpected crash reason: ${detail1?.reason}`);

  // 4. 2 回目も自動読み直し、3 回目で打ち切って 2 択ダイアログ → 0 ('読み直す') を選択 → 画面復帰
  await crashAndWaitReload('renderer recovery #2');

  dialogResponses.push(0); // 読み直す
  await crashAndWaitReload('manual reload after dialog #1');
  assert(recordedDialogs.length === 1, `expected 1 dialog after 3rd crash, got ${recordedDialogs.length}`);

  // 5. app の child-process-gone（GPU プロセス終了）が同じ desktop.log に残ること
  const gpuMetric = app.getAppMetrics().find(m => m.type === 'GPU');
  if (gpuMetric?.pid) {
    const goneChild = new Promise(resolve => app.once('child-process-gone', (_e, d) => resolve(d)));
    try { process.kill(gpuMetric.pid); } catch {}
    await Promise.race([goneChild, new Promise(r => setTimeout(r, 3000))]);
  }

  // 6. ダイアログで「読み直す」後は再び 1・2 回は自動復帰、3 回目 (#6) で 1 ('Pleiad を再起動する') を選んで relaunch
  await crashAndWaitReload('post-reset recovery #1');
  await crashAndWaitReload('post-reset recovery #2');
  dialogResponses.push(1); // Pleiad を再起動する
  mainWindow.webContents.forcefullyCrashRenderer();
  await waitFor(() => recordedDialogs.length === 2 && recordedRelaunches.length === 1, { label: 'crash loop dialog #2 + relaunch' });

  // 7. 5 秒タイマーによる crashDumps/reports の刈り込み（12 件 -> 10 件以下）完了を待つ
  await waitFor(() => {
    const dmps = fs.readdirSync(reportsDir).filter(f => f.endsWith('.dmp'));
    return dmps.length <= 10;
  }, { timeoutMs: 10_000, label: 'crashDumps pruned <= 10' });

  const finalDmps = fs.readdirSync(reportsDir).filter(f => f.endsWith('.dmp'));
  const logText = fs.readFileSync(desktopLogFile, 'utf8');
  assert(logText.includes('render-process-gone'), 'desktop.log must contain render-process-gone');
  assert(logText.includes('renderer-reload'), 'desktop.log must contain renderer-reload');
  assert(logText.includes('renderer-crash-loop'), 'desktop.log must contain renderer-crash-loop');
  assert(logText.includes('did-fail-load'), 'desktop.log must contain did-fail-load');
  assert(logText.includes('token=[redacted]'), 'desktop.log must redact token=');
  assert(!logText.includes('SMOKE_SECRET_TOKEN_XYZ'), 'desktop.log must NOT leak raw token');
  assert(recordedDialogs[0].buttons.length === 2, 'dialog must have 2 buttons');
  assert(quitCount >= 1, 'restarting from loop dialog must trigger app.quit');

  const summary = {
    ok: true,
    electron: process.versions.electron,
    initialPort,
    firstCrashReason: detail1.reason,
    dialogsShown: recordedDialogs.length,
    dialogTitle: recordedDialogs[0].title,
    dialogButtons: recordedDialogs[0].buttons,
    relaunches: recordedRelaunches.length,
    remainingDumps: finalDmps.length,
    gpuTested: Boolean(gpuMetric?.pid),
    logLines: logText.trim().split(/\r?\n/),
  };
  console.log(JSON.stringify(summary));

  allowExit = true;
  if (ownRoot) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
  app.exit(0);
}

runSmoke().catch(err => {
  console.error(err?.stack || String(err));
  if (ownRoot) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
  app.exit(1);
});
