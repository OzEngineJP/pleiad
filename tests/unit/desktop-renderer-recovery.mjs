// main / リモートの窓の renderer 復帰・ログ記録・ローカル crashReporter の単体試験と vm 結合試験。
//   - 60 秒に 3 回の連続クラッシュ打ち切り、clean-exit・破棄済み・終了処理中の無視
//   - did-fail-load の token 伏せ（isMainFrame のみ）・unresponsive/responsive・child-process-gone の記録
//   - desktop.log の 1MB 境界での .old ローテーションと再起動なしでのダンプ上限管理（件数・容量・attachments 掃除）
//   - main.cjs / remote-windows.cjs が同じ renderer-recovery.cjs を使い、ポート/トークン更新後の最新 URL で読み直すこと
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const name = 'desktop-renderer-recovery';
export const title = 'renderer 落ちからの自動復帰・連続クラッシュ打ち切り・desktop.log・ローカル crashDumps の上限管理';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../desktop');
const mainSource = fs.readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
const { createDesktopLog, redactUrlTokens, redactLogText } = require('../../desktop/desktop-log.cjs');
const recovery = require('../../desktop/renderer-recovery.cjs');
const { createRemoteWindows } = require('../../desktop/remote-windows.cjs');
const { createWindowTrust } = require('../../desktop/window-trust.cjs');
const devIdentity = require('../../desktop/dev-identity.cjs');
const workerMessages = require('../../desktop/worker-messages.cjs');
const loginItem = require('../../desktop/login-item.cjs');
const plusLink = require('../../desktop/plus-link.cjs');
const { t: realT, initDesktopI18n, setLocale } = require('../../desktop/i18n.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));

function runMainForRecovery({
  updateRestartNotice = false,
  argv = ['Ply.exe', '--hidden'],
  handover = 'on',
  workerConnected = true,
  autoExitOnLeave = true,
  autoExitOnShutdown = true,
  runningWork = 0,
  onDialog = null,
  fakeTimers = false,
} = {}) {
  const calls = {
    loads: [], dialogs: [], relaunches: [], quits: 0, messages: [], leaves: [],
    crashStarts: [], desktopLogs: [], errors: [],
    chromeGuardStopped: 0, chromeClosedAll: 0,
    scheduledTimers: [], clearedTimers: 0, prunes: 0,
  };
  let nextTimerId = 1;
  const activeTimers = new Map();
  const vmSetTimeout = fakeTimers
    ? (fn, ms) => {
        const id = nextTimerId++;
        const entry = { id, fn, ms, cleared: false };
        activeTimers.set(id, entry);
        calls.scheduledTimers.push(entry);
        return { id, ref() { return this; }, unref() { return this; } };
      }
    : setTimeout;
  const vmClearTimeout = fakeTimers
    ? handle => {
        const id = handle && typeof handle === 'object' ? handle.id : handle;
        const entry = activeTimers.get(id);
        if (entry) {
          entry.cleared = true;
          activeTimers.delete(id);
          calls.clearedTimers++;
        }
      }
    : clearTimeout;

  const worker = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.connected = handover === 'on' ? workerConnected : true;
  worker.postMessage = message => {
    calls.messages.push(message);
    if (message?.type === 'running') {
      queueMicrotask(() => worker.emit('message', { type: 'running', id: message.id, count: runningWork, scheduled: [] }));
    }
    if (message?.type === 'shutdown' && autoExitOnShutdown) {
      queueMicrotask(() => worker.emit('exit', 0));
    }
  };
  worker.leave = reason => {
    calls.leaves.push(reason);
    worker.connected = false;
    if (autoExitOnLeave) {
      queueMicrotask(() => worker.emit('exit'));
    }
  };
  worker.kill = () => {};

  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true,
    exit: () => {},
    quit: () => { calls.quits++; },
    setName: name => { calls.appName = name; },
    getName: () => calls.appName || 'agent-host',
    setAppUserModelId: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
    relaunch: opts => { calls.relaunches.push(opts); },
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: () => true,
    whenReady: () => Promise.resolve(),
    getPath: name => name === 'crashDumps' ? path.join(os.tmpdir(), 'ply-nonexistent-crashdumps') : name === 'userData' ? 'test-user' : 'test-home',
    getPreferredSystemLanguages: () => ['ja-JP'],
    getVersion: () => '1.2.3',
  });

  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      calls.window = this;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.session = { setPermissionRequestHandler: () => {} };
      this.webContents.send = () => {};
    }
    isDestroyed() { return Boolean(this._destroyed); }
    isVisible() { return true; }
    isMinimized() { return false; }
    removeMenu() {}
    setAppDetails() {}
    loadURL(url) { calls.loads.push(url); return Promise.resolve(); }
    show() {}
    showInactive() {}
    minimize() {}
  }

  let remembered = 7499;
  const dialog = {
    showMessageBox: (...args) => {
      calls.dialogs.push(args);
      if (onDialog) return Promise.resolve(onDialog(args));
      return Promise.resolve({ response: 0 });
    },
  };
  const powerMonitor = new EventEmitter();
  const electron = {
    app, BrowserWindow, WebContentsView: class {}, dialog,
    utilityProcess: {
      fork: () => {
        queueMicrotask(() => worker.emit('message', { type: 'ready', port: 7499, token: 'boot-token' }));
        return worker;
      },
    },
    shell: { openExternal: () => Promise.resolve() },
    ipcMain: { on: () => {}, handle: () => {} },
    Notification: class {},
    nativeTheme: { shouldUseDarkColors: false },
    safeStorage: {}, session: {}, nativeImage: {}, Menu: {},
    powerMonitor,
    screen: new EventEmitter(),
    crashReporter: { start: opts => { calls.crashStarts.push(opts); } },
  };

  let switchReload = null;
  const autoUpdater = new EventEmitter();
  const wrappedRecovery = {
    ...recovery,
    pruneCrashDumps: (...args) => { calls.prunes++; return recovery.pruneCrashDumps(...args); },
  };
  const modules = {
    './process.cjs': {
      forkUtility: () => {
        queueMicrotask(() => worker.emit('message', { type: 'ready', port: 7499, token: 'boot-token' }));
        return worker;
      },
    },
    './updates.cjs': { Updates: class { constructor() { this.enabled = false; this.state = { phase: 'idle' }; } on() {} async init() {} snapshot() { return {}; } }, isStoreBuild: () => false, updaterEnabled: () => false },
    './msix.cjs': { packagedIdentity: () => false, stableLauncher: () => 'C:\\inst\\StorePly.exe' },
    './update-auth.cjs': { prepareUpdateCheck: () => {} },
    './update-log.cjs': { createUpdateLog: () => ({}) },
    './desktop-log.cjs': {
      createDesktopLog: file => ({
        file,
        info: (...a) => calls.desktopLogs.push(['info', ...a]),
        warn: (...a) => calls.desktopLogs.push(['warn', ...a]),
        error: (...a) => calls.desktopLogs.push(['error', ...a]),
      }),
    },
    './renderer-recovery.cjs': wrappedRecovery,
    './external-url.cjs': { externalUrl: url => url },
    './update-signature.cjs': { installUpdateSignatureVerifier: () => false },
    './server-port.cjs': { savedPort: () => 7499, rememberPort: (_file, port) => { remembered = port; } },
    './dev-identity.cjs': devIdentity,
    './secret-bridge.cjs': { attachSecretBridge: () => {}, warmSecretStorage: () => true },
    './i18n.cjs': { t: key => key, setLocale: () => {}, resolveLocale: () => 'ja', initDesktopI18n: async () => {} },
    './file-bridge.cjs': { attachFileBridge: () => {} },
    './resident.cjs': { attachResident: () => ({ keepOnClose: () => false }) },
    './login-item.cjs': loginItem,
    './window-trust.cjs': { createWindowTrust: () => ({ register: () => {}, update: () => {}, find: () => null, check: () => { throw new Error('no'); }, entries: () => [] }) },
    './remote-windows.cjs': { createRemoteWindows: () => ({ attach: () => {}, attachWorker: () => {}, handleArgv: () => false }) },
    './browser-partition-cleanup.cjs': { clearOldBrowserPartition: () => Promise.resolve() },
    './agent-browser-bin.cjs': { prepareAgentBrowserBin: () => null },
    './shell-env.cjs': { applyLoginShellEnv: async () => false },
    './plus-link.cjs': plusLink,
    './computer/service.cjs': { attachComputerService: () => ({ escape: () => {} }), withPerMonitorDpi: fn => fn },
    './computer/win32.cjs': { loadWin32: () => { throw Object.assign(new Error('not windows'), { reason: 'platform' }); } },
    './computer/mac.cjs': { loadMac: () => { throw Object.assign(new Error('not macOS'), { reason: 'platform' }); } },
    './chrome-os/index.cjs': {
      createChromeOs: () => ({
        raiseVisibleBrowser: () => false,
        reconceal: () => {},
        stopGuard: () => { calls.chromeGuardStopped++; },
        closeAllAgents: () => { calls.chromeClosedAll++; },
      }),
      attachChromeOs: () => {},
    },
    './notifications.cjs': { createDesktopNotifications: () => () => {}, windowInFront: () => false },
    './chrome-pill.cjs': { createChromePill: () => ({ attach: () => {}, close: () => {}, state: () => ({}), setHost: () => {} }), attachChromePill: () => ({ close: () => {} }) },
    './computer-overlay.cjs': { attachComputerOverlay: () => ({ close: () => {} }) },
    '../package.json': { version: '1.2.3' },
    './server-boot.cjs': {
      chooseServer: async () => (handover === 'on'
        ? {
            mode: 'attached',
            link: worker,
            root: 'R',
            prepared: 'P',
            connect: async () => {
              queueMicrotask(() => worker.emit('message', { type: 'ready', port: 7499, token: 'boot-token' }));
              return { attached: true, pid: 1234 };
            },
          }
        : { mode: 'utility' }),
      describeBootError: error => error?.message ?? String(error),
      reattachServer: async () => false,
      resolveDataDir: () => 'D:\\data',
      readLogTail: () => '',
    },
    './switch.cjs': {
      startSwitch: opts => { switchReload = opts.reload; return { replacing: false, cancel() {} }; },
      incompatibleDialog: () => async () => 'later',
    },
    './worker-messages.cjs': workerMessages,
    './server-restart.cjs': { createServerRestarter: () => ({ restart: async () => ({ ok: false }) }) },
  };

  const fsMock = {
    ...fs,
    readFileSync: (...args) => {
      if (String(args[0]).endsWith('update-restart-notice')) return updateRestartNotice ? '1' : '';
      return fs.readFileSync(...args);
    },
    unlinkSync: target => { if (String(target).endsWith('update-restart-notice')) return; return fs.unlinkSync(target); },
    mkdirSync: () => {},
  };

  const req = id => {
    if (id === 'electron') return electron;
    if (id === 'electron-updater') return { autoUpdater };
    if (id === 'node:fs') return fsMock;
    if (id === 'node:path') return path;
    if (id in modules) return modules[id];
    throw new Error(`unexpected require ${id}`);
  };
  vm.runInNewContext(mainSource, {
    require: req,
    __dirname: desktopDir,
    __filename: path.join(desktopDir, 'main.cjs'),
    process: { platform: 'linux', argv, env: { AGENT_HOST_HANDOVER: handover }, execPath: 'C:\\inst\\Ply.exe', resourcesPath: '' },
    console: { ...console, warn: () => {}, error: (...args) => calls.errors.push(args.map(String).join(' ')) },
    Buffer, URL, setTimeout: vmSetTimeout, clearTimeout: vmClearTimeout, setInterval, clearInterval, queueMicrotask,
  }, { filename: path.join(desktopDir, 'main.cjs') });

  return (async () => {
    for (let i = 0; i < 10; i++) await tick();
    return {
      app, calls, worker, powerMonitor, switchReload,
      getRememberedPort: () => remembered,
      activeTimers: () => [...activeTimers.values()],
      fireTimer: id => {
        const entry = activeTimers.get(id);
        if (!entry) return false;
        activeTimers.delete(id);
        entry.fn();
        return true;
      },
    };
  })();
}

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-renderer-recovery-'));
  try {
    // 1. 連続クラッシュ検知（60 秒に 3 回）と窓の滑り・リセット
    {
      let clock = 1_000_000;
      const tracker = recovery.createCrashTracker({ maxCrashes: 3, windowMs: 60_000, now: () => clock });
      const first = tracker.recordCrash();
      clock += 20_000;
      const second = tracker.recordCrash();
      clock += 20_000;
      const third = tracker.recordCrash();
      t.ok('60 秒以内の 1・2 回目は自動読み直し、3 回目で打ち切る', !first.loop && first.count === 1 && !second.loop && second.count === 2 && third.loop && third.count === 3);

      tracker.reset();
      t.ok('reset 後は再び 1 回目から数える', tracker.recentCount() === 0 && !tracker.recordCrash().loop);

      clock = 2_000_000;
      const wTracker = recovery.createCrashTracker({ maxCrashes: 3, windowMs: 60_000, now: () => clock });
      wTracker.recordCrash();
      clock += 35_000;
      wTracker.recordCrash();
      clock += 35_000; // 最初の 1 回目が 70 秒前になり窓から外れる
      const spaced = wTracker.recordCrash();
      t.ok('60 秒を超えた古い落ちが外れれば打ち切らない', !spaced.loop && spaced.count === 2);
    }

    // 2. token 伏せとログのローテーション
    {
      const url1 = redactUrlTokens('http://127.0.0.1:7420/?token=secret-123&open=sess-9&reason=update-restart');
      const url2 = redactUrlTokens('http://127.0.0.1:7420/#token=fragSecret');
      const url3 = redactUrlTokens('https://alice:topSecret@example.com/cb?api_key=K1&apikey=K2&key=K3&jwt=J4&auth=A5&password=P6&code=C7&open=ok&reason=r');
      const rawLine = redactLogText('did-fail-load code=-102 desc="ERR" url=http://127.0.0.1/?token=rawToken123 Bearer abcdefghijklmnopqrstuvwxyz123456 ghp_0123456789abcdefghijABCDEFGHIJ');
      t.ok('URL の token だけを伏せ、安全なクエリは残す', url1 === 'http://127.0.0.1:7420/?token=[redacted]&open=sess-9&reason=update-restart', url1);
      t.ok('フラグメント内の token も伏せる', url2 === 'http://127.0.0.1:7420/#token=[redacted]', url2);
      t.ok('URL の userinfo と認証系パラメーターを伏せ、open/reason は残す',
        url3 === 'https://[redacted]@example.com/cb?api_key=[redacted]&apikey=[redacted]&key=[redacted]&jwt=[redacted]&auth=[redacted]&password=[redacted]&code=[redacted]&open=ok&reason=r',
        url3);
      t.ok('文字列中の Bearer・token=・PAT は伏せつつ code=-102 等は壊さない',
        rawLine.includes('code=-102') && !/abcdefghijklmnopqrstuvwxyz|rawToken123|ghp_/.test(rawLine), rawLine);

      let fakeClock = Date.parse('2026-11-13T01:02:03.000Z');
      const logFile = path.join(dir, 'logs', 'desktop.log');
      const log = createDesktopLog(logFile, { maxBytes: 120, now: () => new Date(fakeClock) });
      log.info(`render-process-gone url=http://127.0.0.1:7420/?token=SECRET_VALUE_A ${'x'.repeat(80)}`);
      fakeClock += 1000;
      log.warn('second-entry http://127.0.0.1:7420/?token=SECRET_VALUE_B');
      const current = fs.readFileSync(logFile, 'utf8');
      const previous = fs.readFileSync(`${logFile}.old`, 'utf8');
      t.ok('desktop.log は 1 世代前を .old へ回して太り続けない', current.includes('2026-11-13T01:02:04.000Z warn second-entry') && previous.includes('render-process-gone'));
      t.ok('desktop.log に元の token は書かれない', !current.includes('SECRET_VALUE') && !previous.includes('SECRET_VALUE') && current.includes('token=[redacted]'));

      // renameSync 失敗時は切り詰めて上限内に抑える
      const lockedLogFile = path.join(dir, 'locked-logs', 'desktop.log');
      const lockedFs = { ...fs, renameSync: () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } };
      const lockedLog = createDesktopLog(lockedLogFile, { maxBytes: 120, fsSync: lockedFs, now: () => new Date(fakeClock) });
      lockedLog.info(`first-large-entry ${'a'.repeat(70)}`);
      lockedLog.info('second-truncated');
      const lockedContent = fs.readFileSync(lockedLogFile, 'utf8');
      t.ok('renameSync 失敗時は切り詰めて上限内に収め古い行を捨てる',
        Buffer.byteLength(lockedContent, 'utf8') <= 120 && lockedContent.includes('second-truncated') && !lockedContent.includes('first-large-entry'),
        lockedContent);

      // 実行中に logs/ が消えても ENOENT 時に作り直して 1 回再試行する
      const recreatedDir = path.join(dir, 'recreate-logs');
      const recreatedFile = path.join(recreatedDir, 'desktop.log');
      const recreatedLog = createDesktopLog(recreatedFile, { maxBytes: 1024, now: () => new Date(fakeClock) });
      recreatedLog.info('before-delete');
      fs.rmSync(recreatedDir, { recursive: true, force: true });
      recreatedLog.info('after-delete');
      t.ok('logs フォルダーを実行中に消されても再作成して記録できる',
        fs.existsSync(recreatedFile) && fs.readFileSync(recreatedFile, 'utf8').includes('after-delete'));
    }

    // 3. クラッシュダンプの上限管理（件数・合計サイズ・attachments）と dev/配布版の分離
    {
      const dumpsDir = path.join(dir, 'Crashpad');
      const reportsDir = path.join(dumpsDir, 'reports');
      const attachDir = path.join(dumpsDir, 'attachments');
      fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(path.join(dumpsDir, 'settings.dat'), 'keep');
      fs.writeFileSync(path.join(dumpsDir, 'metadata'), 'keep');
      for (let i = 1; i <= 5; i++) {
        const id = `dump-${i}`;
        const p = path.join(reportsDir, `${id}.dmp`);
        fs.writeFileSync(p, Buffer.alloc(400));
        const ts = new Date(Date.now() - (10 - i) * 10_000);
        fs.utimesSync(p, ts, ts);
        fs.mkdirSync(path.join(attachDir, id), { recursive: true });
        fs.writeFileSync(path.join(attachDir, id, 'note.txt'), 'a');
      }
      const resCount = recovery.pruneCrashDumps(dumpsDir, { maxFiles: 3, maxBytes: 100_000 });
      const leftAfterCount = fs.readdirSync(reportsDir).sort();
      t.ok('件数上限を超えた古い .dmp と attachments だけを消す', resCount.removed === 2 && resCount.kept === 3
        && leftAfterCount.join(',') === 'dump-3.dmp,dump-4.dmp,dump-5.dmp'
        && !fs.existsSync(path.join(attachDir, 'dump-1')) && fs.existsSync(path.join(attachDir, 'dump-5'))
        && fs.existsSync(path.join(dumpsDir, 'settings.dat')) && fs.existsSync(path.join(dumpsDir, 'metadata')));

      const resBytes = recovery.pruneCrashDumps(dumpsDir, { maxFiles: 10, maxBytes: 900 });
      t.ok('合計サイズ上限も超えないよう古い方から消す', resBytes.removed === 1 && resBytes.kept === 2 && resBytes.totalBytes === 800
        && fs.readdirSync(reportsDir).sort().join(',') === 'dump-4.dmp,dump-5.dmp');

      // stem が空になる ".dmp" を消すときに attachments フォルダー本体を消さない
      const dotDmp = path.join(reportsDir, '.dmp');
      fs.writeFileSync(dotDmp, Buffer.alloc(100));
      const oldTs = new Date(Date.now() - 1_000_000);
      fs.utimesSync(dotDmp, oldTs, oldTs);
      recovery.pruneCrashDumps(dumpsDir, { maxFiles: 2, maxBytes: 100_000 });
      t.ok('名前なしの .dmp を消しても attachments/ 本体（残存添付）を消さない',
        !fs.existsSync(dotDmp) && fs.existsSync(path.join(attachDir, 'dump-5', 'note.txt')));

      // dev と配布版での分離確認
      const devApp = { isPackaged: false, name: 'agent-host', setName(n) { this.name = n; }, getName() { return this.name; }, getPath: () => path.join(dir, 'AppData', devApp.name, 'Crashpad') };
      const prodApp = { isPackaged: true, name: 'agent-host', setName(n) { this.name = n; }, getName() { return this.name; }, getPath: () => path.join(dir, 'AppData', prodApp.name, 'Crashpad') };
      const devEnv = {};
      devIdentity.applyDevIdentity({ app: devApp, env: devEnv, home: path.join(dir, 'home') });
      devIdentity.applyDevIdentity({ app: prodApp, env: {}, home: path.join(dir, 'home') });
      const crashCalls = [];
      const devInfo = recovery.startCrashReporting({ app: devApp, crashReporter: { start: o => crashCalls.push(['dev', o]) } });
      const prodInfo = recovery.startCrashReporting({ app: prodApp, crashReporter: { start: o => crashCalls.push(['prod', o]) } });
      t.ok('uploadToServer: false で始め、開発版（Pleiad Dev）と配布版（agent-host）で保存先が混ざらない',
        devInfo.crashDumpsDir !== prodInfo.crashDumpsDir
        && devInfo.crashDumpsDir.includes('Pleiad Dev')
        && prodInfo.crashDumpsDir.includes('agent-host')
        && crashCalls.every(([, o]) => o.uploadToServer === false)
        && crashCalls[0][1].productName === 'Pleiad Dev'
        && crashCalls[1][1].productName === 'agent-host');
    }

    // 4. 共通部品 attachWindowHealth の単体挙動（clean-exit / 破棄 / 終了中 / did-fail-load / unresponsive / loop）
    {
      let clock = 5_000;
      const logs = [];
      const logger = {
        info: s => logs.push(['info', s]),
        warn: s => logs.push(['warn', s]),
        error: s => logs.push(['error', s]),
      };
      const win = new EventEmitter();
      win.webContents = new EventEmitter();
      let destroyed = false, quitting = false, reloaded = 0, restarted = 0, resolveDialog;
      win.isDestroyed = () => destroyed;
      const health = recovery.attachWindowHealth({
        win,
        label: 'unit-win',
        logger,
        startedAt: 1_000,
        now: () => clock,
        isQuitting: () => quitting,
        reload: async () => { reloaded++; },
        onRestart: async () => { restarted++; },
        onLoopPrompt: () => new Promise(r => { resolveDialog = r; }),
      });

      // clean-exit
      win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
      await tick();
      t.ok('clean-exit では読み直さず、ログだけ残す', reloaded === 0 && logs.some(([lvl, m]) => lvl === 'info' && m.includes('reason=clean-exit')));

      // did-fail-load（mainFrame のみ・token 伏せ）
      win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:7420/?token=SUB_SECRET', false);
      win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:7420/?token=MAIN_SECRET', true);
      t.ok('did-fail-load は mainFrame のみ token を伏せて記録し、挙動は変えない',
        reloaded === 0 && logs.filter(([, m]) => m.includes('did-fail-load')).length === 1
        && logs.some(([, m]) => m.includes('code=-102') && m.includes('token=[redacted]') && !m.includes('MAIN_SECRET')));

      // unresponsive / responsive
      clock += 2500;
      win.emit('unresponsive');
      clock += 500;
      win.emit('responsive');
      t.ok('unresponsive / responsive を起動からの時間付きで記録し、読み直さない',
        reloaded === 0
        && logs.some(([lvl, m]) => lvl === 'warn' && m.includes('window-unresponsive') && m.includes('uptimeMs=6500'))
        && logs.some(([lvl, m]) => lvl === 'info' && m.includes('window-responsive') && m.includes('uptimeMs=7000')));

      // 終了中・破棄済みは何もしない
      quitting = true;
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 2 });
      await tick();
      quitting = false;
      destroyed = true;
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 2 });
      await tick();
      destroyed = false;
      t.ok('終了処理中・破棄済みの間は何もしない', reloaded === 0 && health.tracker.recentCount() === 0);

      // 3 回目の連続クラッシュ中に 4 回目が重なってもダイアログを二重に出さない
      let prompts = 0;
      const win2 = new EventEmitter();
      win2.webContents = new EventEmitter();
      win2.isDestroyed = () => false;
      let finishPrompt;
      recovery.attachWindowHealth({
        win: win2,
        label: 'unit-win2',
        logger,
        now: () => clock,
        reload: async () => { reloaded++; },
        onRestart: async () => { restarted++; },
        onLoopPrompt: () => { prompts++; return new Promise(r => { finishPrompt = r; }); },
      });
      win2.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      win2.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 2 });
      win2.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 3 });
      win2.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 4 });
      await tick();
      t.ok('3 回目ダイアログ表示中の重複クラッシュでダイアログを積み上げない', prompts === 1 && reloaded === 2);
      finishPrompt('reload');
      await tick();
      t.ok('ダイアログで「読み直す」を選べばカウンターを戻して読み直す', reloaded === 3 && restarted === 0);

      // createLoopPrompter は Esc / 閉じる（cancelId: 0）で安全側の「読み直す」になる
      const dialogCalls = [];
      const prompter = recovery.createLoopPrompter({
        dialog: { showMessageBox: async (_w, opts) => { dialogCalls.push(opts); return { response: opts.cancelId }; } },
        t: k => k,
      });
      const fakePromptWin = { isDestroyed: () => false };
      const cancelChoice = await prompter({ win: fakePromptWin });
      t.ok('createLoopPrompter は defaultId: 0・cancelId: 0 で Esc 等を安全側の reload にする',
        cancelChoice === 'reload' && dialogCalls[0].defaultId === 0 && dialogCalls[0].cancelId === 0 && dialogCalls[0].noLink === true);

      // 非表示・最小化中は即ダイアログを出さず、可視に戻ってから 1 回だけ出す
      for (const scenario of ['hidden-only', 'minimized-only', 'hidden-then-restore-before-show', 'quitting-while-deferred', 'destroyed-while-deferred', 'closed-while-deferred']) {
        const w = new EventEmitter();
        w.webContents = new EventEmitter();
        let visible = scenario === 'minimized-only';
        let minimized = scenario === 'minimized-only' || scenario === 'hidden-then-restore-before-show';
        let wDestroyed = false;
        let wQuitting = false;
        w.isVisible = () => visible;
        w.isMinimized = () => minimized;
        w.isDestroyed = () => wDestroyed;
        let promptCount = 0;
        let reloadCount = 0;
        const sLogs = [];
        recovery.attachWindowHealth({
          win: w,
          label: scenario,
          logger: { info: s => sLogs.push(s), warn: s => sLogs.push(s), error: s => sLogs.push(s) },
          isQuitting: () => wQuitting,
          reload: async () => { reloadCount++; },
          onLoopPrompt: async () => { promptCount++; return 'reload'; },
        });
        for (let k = 0; k < 3; k++) { w.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }); await tick(); }
        t.ok(`${scenario}: 非可視中の 3 回目落ちはダイアログを保留する`,
          promptCount === 0 && sLogs.some(s => s.includes('renderer-crash-loop-deferred')));
        if (scenario === 'hidden-only') {
          visible = true;
          w.emit('show');
          await tick();
          t.ok('hidden-only: show で可視になったら保留していたダイアログを出す', promptCount === 1 && reloadCount === 3);
        } else if (scenario === 'minimized-only') {
          minimized = false;
          w.emit('restore');
          await tick();
          t.ok('minimized-only: restore で可視になったら保留していたダイアログを出す', promptCount === 1 && reloadCount === 3);
        } else if (scenario === 'hidden-then-restore-before-show') {
          minimized = false;
          w.emit('restore');
          await tick();
          const beforeShow = promptCount;
          visible = true;
          w.emit('show');
          await tick();
          t.ok('hidden+minimized: restore 後まだ非表示なら出さず show で出す', beforeShow === 0 && promptCount === 1 && reloadCount === 3);
        } else if (scenario === 'quitting-while-deferred') {
          wQuitting = true; visible = true; minimized = false;
          w.emit('show'); w.emit('restore'); await tick();
          t.ok('保留中に終了処理へ入ったら再表示されてもダイアログも読み直しも出さない', promptCount === 0 && reloadCount === 2);
        } else if (scenario === 'destroyed-while-deferred') {
          wDestroyed = true; visible = true; minimized = false;
          w.emit('show'); w.emit('restore'); await tick();
          t.ok('保留中に破棄されたらダイアログも読み直しも出さない', promptCount === 0 && reloadCount === 2);
        } else if (scenario === 'closed-while-deferred') {
          w.emit('closed'); visible = true; minimized = false;
          w.emit('show'); w.emit('restore'); await tick();
          t.ok('保留中に closed が発火したら解除されダイアログも出さない', promptCount === 0 && reloadCount === 2);
        }
      }
    }

    // 5. main.cjs 結合: 最新 port/token・update-restart 非再送・linked/!linked 再起動・引数・終了フラグ・タイマー統合
    {
      let dialogChoice = 0;
      const running = await runMainForRecovery({
        updateRestartNotice: true,
        handover: 'on',
        argv: ['Ply.exe', '--hidden', '--remote-hosts', '--remote-hosts=1', 'pleiad://plus/enable', 'PLEIAD://pair', '--no-sandbox'],
        onDialog: () => ({ response: dialogChoice }),
      });
      t.ok('起動の早い段階で uploadToServer: false の crashReporter を有効にする',
        running.calls.crashStarts.length === 1 && running.calls.crashStarts[0].uploadToServer === false);
      t.ok('初回のロードは &reason=update-restart 付き', running.calls.loads[0] === 'http://127.0.0.1:7499/?token=boot-token&reason=update-restart',
        JSON.stringify({ loads: running.calls.loads, errors: running.calls.errors, dialogs: running.calls.dialogs }));

      // 切り替え / 再起動でポート・トークンが変わる
      await running.switchReload({ port: 8123, token: 'switched-token' });
      t.ok('switch.reload がポート・トークンを更新して読み込む', running.calls.loads[1] === 'http://127.0.0.1:8123/?token=switched-token' && running.getRememberedPort() === 8123);

      // 1 回目の renderer 落ち: 古い boot-token/7499 でなく switched-token/8123 で読み直し、update-restart は付け直さない
      running.calls.window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
      await tick();
      t.ok('main の renderer 落ちは最新の port/token で読み直し、初回限定パラメーターを付け直さない',
        running.calls.loads.length === 3 && running.calls.loads[2] === 'http://127.0.0.1:8123/?token=switched-token',
        JSON.stringify(running.calls.loads));

      // child-process-gone と did-fail-load の記録
      running.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: -1073741819 });
      running.calls.window.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'http://127.0.0.1:8123/?token=switched-token', true);
      t.ok('child-process-gone を main と同じログへ記録する',
        running.calls.desktopLogs.some(([lvl, m]) => lvl === 'error' && m.includes('child-process-gone') && m.includes('type=GPU') && m.includes('reason=crashed')));
      t.ok('main 窓の did-fail-load も記録に残り元の token を隠す',
        running.calls.desktopLogs.some(([lvl, m]) => lvl === 'warn' && m.includes('did-fail-load') && m.includes('window=main') && m.includes('token=[redacted]') && !m.includes('switched-token')));

      // 2 回目（自動読み直し） → 3 回目（打ち切り → ダイアログ → 「Pleiad を再起動する」）
      running.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      await tick();
      dialogChoice = 1; // Pleiad を再起動する
      running.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      await tick();
      await tick();
      running.app.emit('will-quit');
      const relaunch = running.calls.relaunches[0];
      t.ok('linked 経路の再起動はサーバーへ shutdown を送らず leave(restart) し、会話 Chrome 窓も閉じない',
        running.calls.dialogs.length === 1
        && running.calls.dialogs[0][1].title === 'renderer.crashedTitle'
        && running.calls.dialogs[0][1].defaultId === 0
        && running.calls.dialogs[0][1].cancelId === 0
        && running.calls.dialogs[0][1].buttons.join() === 'renderer.reload,renderer.restart'
        && running.calls.leaves.includes('restart')
        && !running.calls.messages.some(m => m.type === 'shutdown')
        && running.calls.chromeGuardStopped >= 1
        && running.calls.chromeClosedAll === 0,
        JSON.stringify({ leaves: running.calls.leaves, messages: running.calls.messages, guard: running.calls.chromeGuardStopped, closed: running.calls.chromeClosedAll }));
      t.ok('app.relaunch に stableLauncher() を渡し、1 回限りの引数を外して通常フラグを残す',
        running.calls.relaunches.length === 1
        && relaunch.execPath === 'C:\\inst\\StorePly.exe'
        && !relaunch.args.includes('--hidden')
        && !relaunch.args.includes('--remote-hosts')
        && !relaunch.args.some(a => a.startsWith('--remote-hosts=') || /^pleiad:\/\//i.test(a))
        && relaunch.args.includes('--no-sandbox')
        && running.calls.quits === 1,
        JSON.stringify({ relaunches: running.calls.relaunches, quits: running.calls.quits }));

      // linked で未接続なら待機タイマーを張らず即再起動へ進む
      const disc = await runMainForRecovery({
        handover: 'on', workerConnected: false, autoExitOnLeave: false, fakeTimers: true,
        onDialog: () => ({ response: 1 }),
      });
      for (let i = 0; i < 3; i++) { disc.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }); await tick(); }
      await tick();
      t.ok('linked で未接続（!worker.connected）なら切断待ちせず即 relaunch する',
        disc.calls.leaves.includes('restart') && disc.calls.relaunches.length === 1 && disc.calls.quits === 1);

      // linked で leave 応答が返らなくても 2000ms でタイムアウトして再起動へ進む
      const leaveTimeout = await runMainForRecovery({
        handover: 'on', workerConnected: true, autoExitOnLeave: false, fakeTimers: true,
        onDialog: () => ({ response: 1 }),
      });
      for (let i = 0; i < 3; i++) { leaveTimeout.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }); await tick(); }
      await tick();
      const leaveWaitTimer = leaveTimeout.activeTimers().find(tm => tm.ms === 2_000);
      const beforeLeaveTimeout = leaveTimeout.calls.relaunches.length;
      if (leaveWaitTimer) leaveTimeout.fireTimer(leaveWaitTimer.id);
      await tick();
      t.ok('linked の離脱待ちは exit 未到着時に 2000ms で切り上げて relaunch する',
        beforeLeaveTimeout === 0 && Boolean(leaveWaitTimer) && leaveTimeout.calls.relaunches.length === 1 && leaveTimeout.calls.quits === 1);

      // !linked (utilityProcess) は shutdown 送信後に worker の exit を待ってから relaunch する
      const utilWait = await runMainForRecovery({
        handover: 'off', autoExitOnShutdown: false,
        onDialog: () => ({ response: 1 }),
      });
      for (let i = 0; i < 3; i++) { utilWait.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }); await tick(); }
      await tick();
      const sentShutdown = utilWait.calls.messages.some(m => m.type === 'shutdown' && m.stopHeld === true);
      const beforeUtilExit = utilWait.calls.relaunches.length;
      utilWait.worker.emit('exit', 0);
      await tick();
      await tick();
      t.ok('!linked (utilityProcess) は shutdown 送信後 worker の exit 完了を待ってから relaunch する',
        sentShutdown && beforeUtilExit === 0
        && utilWait.calls.relaunches.length === 1
        && utilWait.calls.relaunches[0].execPath === 'C:\\inst\\StorePly.exe'
        && utilWait.calls.quits === 1);

      // !linked で exit が来ない場合は 30000ms タイムアウトで relaunch する
      const utilTimeout = await runMainForRecovery({
        handover: 'off', autoExitOnShutdown: false, fakeTimers: true,
        onDialog: () => ({ response: 1 }),
      });
      for (let i = 0; i < 3; i++) { utilTimeout.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }); await tick(); }
      await tick();
      const utilWaitTimer = utilTimeout.activeTimers().find(tm => tm.ms === 30_000);
      const beforeUtilTimeout = utilTimeout.calls.relaunches.length;
      if (utilWaitTimer) utilTimeout.fireTimer(utilWaitTimer.id);
      await tick();
      t.ok('!linked は worker exit が来ないとき 30000ms タイムアウトで relaunch する',
        beforeUtilTimeout === 0 && Boolean(utilWaitTimer) && utilTimeout.calls.relaunches.length === 1 && utilTimeout.calls.quits === 1);

      // scheduleDumpPrune 統合
      const pruneDebounce = await runMainForRecovery({ handover: 'on', fakeTimers: true });
      const prunesAtStart = pruneDebounce.calls.prunes;
      pruneDebounce.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      await tick();
      pruneDebounce.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      await tick();
      const pruneTimers = pruneDebounce.activeTimers().filter(tm => tm.ms === 5000);
      t.ok('連続クラッシュ時の 5000ms ダンプ刈り込みタイマーは単一に統合される',
        pruneTimers.length === 1 && pruneDebounce.calls.clearedTimers >= 1 && pruneDebounce.calls.prunes === prunesAtStart);
      pruneDebounce.fireTimer(pruneTimers[0].id);
      t.ok('統合された 5000ms タイマー発火時に 1 回だけ pruneCrashDumps を呼ぶ',
        pruneDebounce.calls.prunes === prunesAtStart + 1 && pruneDebounce.activeTimers().filter(tm => tm.ms === 5000).length === 0);

      // closeSafely() の確認ダイアログ中にクラッシュしても抑止、キャンセル後は復帰再開
      let releaseCloseDialog;
      const lifecycle = await runMainForRecovery({
        handover: 'on', runningWork: 1,
        onDialog: () => new Promise(resolve => { releaseCloseDialog = resolve; }),
      });
      const loadsBeforeClose = lifecycle.calls.loads.length;
      lifecycle.calls.window.emit('close', { preventDefault() {} });
      await tick();
      await tick();
      lifecycle.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      await tick();
      const loadsDuringCloseDialog = lifecycle.calls.loads.length;
      releaseCloseDialog({ response: 0 }); // 作業に戻る（キャンセル）
      await tick();
      await tick();
      lifecycle.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      await tick();
      const loadsAfterCancel = lifecycle.calls.loads.length;
      t.ok('closeSafely 確認中は exitInProgress により復帰を抑止し、キャンセル後は復帰再開する',
        lifecycle.calls.dialogs.length === 1
        && loadsDuringCloseDialog === loadsBeforeClose
        && loadsAfterCancel === loadsBeforeClose + 1,
        JSON.stringify({ loadsBeforeClose, loadsDuringCloseDialog, loadsAfterCancel, dialogs: lifecycle.calls.dialogs.length }));

      // OS シャットダウン通知時は preventDefault せず exitInProgress を立てる
      let prevented = false;
      lifecycle.powerMonitor.emit('shutdown', { preventDefault() { prevented = true; } });
      lifecycle.calls.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      await tick();
      t.ok('powerMonitor shutdown は preventDefault せず以後の復帰を抑止する',
        !prevented && lifecycle.calls.loads.length === loadsAfterCancel);
    }

    // 6. リモートの窓 (desktop/remote-windows.cjs): 共通の復帰と最新 proxy URL の利用・close 時抑止・辞書
    {
      await initDesktopI18n({ systemLanguage: 'ja' });
      setLocale('ja');
      const hostId = 'abcdefghijklmnopqrstuvwxyz';
      const hostId2 = 'bcdefghijklmnopqrstuvwxyza';
      const loads = [];
      const trustUpdates = [];
      const logs = [];
      let proxyState = { port: 51001, token: 'remote-tok-1' };
      const proxyUrl = () => `http://127.0.0.1:${proxyState.port}/?token=${proxyState.token}`;
      let restarts = 0;
      const remoteWinHolder = [];
      class FakeRemoteBrowserWindow extends EventEmitter {
        constructor() {
          super();
          this.webContents = new EventEmitter();
          this.webContents.setWindowOpenHandler = () => {};
          this.webContents.session = { setPermissionRequestHandler: () => {} };
          this.webContents.send = () => {};
          this.webContents.reload = () => {};
          this._destroyed = false;
          remoteWinHolder.push(this);
        }
        isDestroyed() { return this._destroyed; }
        isMinimized() { return false; }
        removeMenu() {}
        show() {}
        focus() {}
        setOverlayIcon() {}
        setTitleBarOverlay() {}
        loadURL(u) { loads.push(u); return Promise.resolve(); }
      }
      const trust = createWindowTrust();
      const origUpdate = trust.update.bind(trust);
      trust.update = (win, patch) => { trustUpdates.push(patch.origin); return origUpdate(win, patch); };
      const ses = { setPermissionRequestHandler: () => {} };
      const recs = [
        { hostId, hostName: 'desk', relayUrl: 'https://relay.example.net', via: 'own', port: 51001 },
        { hostId: hostId2, hostName: 'desk2', relayUrl: 'https://relay.example.net', via: 'own', port: 51002 },
      ];
      const fakeDevice = {
        on() {},
        async list() { return recs; },
        pickHostRecord(rows, id) { return rows.find(r => r.hostId === id) || null; },
        async open() { return { port: proxyState.port, url: proxyUrl(), status: { state: 'connected' } }; },
        async proxy(id) { return id === hostId || id === hostId2 ? { url: proxyUrl() } : null; },
        async close() {},
      };
      const rw = createRemoteWindows({
        app: { getPath: () => path.join(dir, 'userData'), isPackaged: false, getVersion: () => '1.2.3' },
        BrowserWindow: FakeRemoteBrowserWindow,
        session: { fromPartition: () => ses },
        ipcMain: { handle() {}, on() {} },
        nativeImage: { createFromDataURL: () => null },
        nativeTheme: { shouldUseDarkColors: false, on() {} },
        Notification: class {},
        Menu: {},
        safeStorage: {},
        trust,
        icon: 'icon.png',
        external: () => {},
        createDevice: () => fakeDevice,
        desktopLog: { info: m => logs.push(['info', m]), warn: m => logs.push(['warn', m]), error: m => logs.push(['error', m]) },
        onLoopPrompt: async () => 'restart',
        onRestart: async () => { restarts++; },
        isQuitting: () => false,
        startedAt: Date.now() - 1000,
      });
      await rw.openHost(hostId, { sessionId: 'sess-init' });
      const rwin = remoteWinHolder[0];
      t.ok('リモートの窓を開くときは proxy.url + &open で開く', loads[0] === 'http://127.0.0.1:51001/?token=remote-tok-1&open=sess-init');

      // プロキシのポートとトークンが入れ替わった状態で renderer が落ちる
      proxyState = { port: 59999, token: 'remote-tok-NEW' };
      rwin.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
      await tick();
      t.ok('リモートの窓の復帰は落ちた時点の古い URL ではなく最新の proxy(hostId).url を使い trust も更新する',
        loads.length === 2 && loads[1] === 'http://127.0.0.1:59999/?token=remote-tok-NEW' && trustUpdates.includes('http://127.0.0.1:59999'),
        JSON.stringify({ loads, trustUpdates }));

      rwin.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', proxyUrl(), true);
      t.ok('リモートの窓の did-fail-load でも remote:<hostId> と伏せた token を残す',
        logs.some(([lvl, m]) => lvl === 'warn' && m.includes(`window=remote:${hostId}`) && m.includes('token=[redacted]') && !m.includes('remote-tok-NEW')));

      rwin.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 12 });
      await tick();
      rwin.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 13 });
      await tick();
      t.ok('リモートの窓でも 3 回連続で打ち切って onRestart を呼ぶ', restarts === 1 && loads.length === 3);

      // 閉じ始めた直後（close 発火、closed 前）に落ちても復帰しない
      await rw.openHost(hostId2);
      const rwin2 = remoteWinHolder[1];
      const loadsBeforeRemoteClose = loads.length;
      rwin2.emit('close');
      rwin2.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 15 });
      await tick();
      t.ok('リモートの窓が close を受けた直後は closed 前でも復帰しない', loads.length === loadsBeforeRemoteClose && restarts === 1);

      // 閉じた後は render-process-gone に反応しない
      rwin.emit('closed');
      rwin._destroyed = true;
      rwin.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 14 });
      await tick();
      t.ok('リモートの窓を閉じた後は復帰も再起動もしない', loads.length === loadsBeforeRemoteClose && restarts === 1);

      t.ok('ja / en 辞書に連続クラッシュダイアログの文言が揃っている',
        realT('renderer.reload', { lng: 'ja' }) === '読み直す'
        && realT('renderer.restart', { lng: 'ja' }) === 'Pleiad を再起動する'
        && realT('renderer.reload', { lng: 'en' }) === 'Reload'
        && realT('renderer.restart', { lng: 'en' }) === 'Restart Pleiad');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
