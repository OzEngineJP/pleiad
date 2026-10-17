// macOS ランナー（macos-15）で Pleiad の Chrome の層（mac.cjs + pleiad-computer-helper）を実機 Chrome に対して実証するスクリプト。
//   1. ヘルパーの Accessibility 権限（AXIsProcessTrusted）を確かめる
//   2. Google Chrome を一時の --user-data-dir で起動する（--remote-debugging-port は付けない）
//   3. enableRemoteDebugging で新しい窓を開き、chrome://inspect/#remote-debugging のトグルをオンにして窓を閉じ、DevToolsActivePort が書かれることを確かめる
//   4. core/chrome/connection.mjs で接続を始め、findPermissionDialog + allowPermission で「Allow / 許可する」を押して connected になることを確かめる
//   5. core/chrome/relay.mjs と同梱の agent-browser（darwin 版）で open・snapshot・screenshot を 1 回通す
//   6. conceal の候補（AXPosition 画面外・Browser.setWindowBounds 画面外・最小化）を試して結果を JSON と画像で保存する
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActivePort } from '../core/chrome/locate.mjs';
import { parentPortChromeOs } from '../core/chrome/os.mjs';
import { createChromeConnection } from '../core/chrome/connection.mjs';
import { createChromeRelay } from '../core/chrome/relay.mjs';
import { chromeRelayBrowser, browserEnvironment } from '../core/agent-browser.mjs';

const require = createRequire(import.meta.url);
const { createHelperClient } = require('../desktop/computer/mac-helper.cjs');
const { createChromeOs, attachChromeOs } = require('../desktop/chrome-os/index.cjs');
const { prepareAgentBrowserBin, commandName } = require('../desktop/agent-browser-bin.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.VERIFY_OUT_DIR || path.join(os.tmpdir(), `ply-chrome-mac-out-${Date.now()}`);
const HELPER_BIN = process.env.VERIFY_HELPER_BIN || path.join(ROOT, 'desktop', 'computer', 'mac', 'dist', 'pleiad-computer-helper');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout (${ms}ms): ${label}`)), ms);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

function runCmd(bin, args, { env = process.env, timeoutMs = 30_000 } = {}) {
  return new Promise(resolve => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
        ...(error ? { error: error.message } : {}),
      });
    });
  });
}

async function startLocalTestServer() {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Pleiad macOS Chrome Verify</title></head>
<body style="font-family: sans-serif; padding: 24px; background: #f4f7fb;">
  <h1 id="heading">Pleiad Agent Browser on macOS</h1>
  <p id="status">Ready</p>
  <button id="action-btn" onclick="document.getElementById('status').textContent = 'Clicked!'">Verify Action</button>
</body>
</html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const logs = [];
  const log = line => {
    const msg = `[${new Date().toISOString()}] ${line}`;
    console.log(msg);
    logs.push(msg);
  };

  const results = {
    startedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    helperBin: HELPER_BIN,
    stages: {},
    logs,
  };

  let helper = null;
  let chromeProc = null;
  let conn = null;
  let relay = null;
  let testServer = null;
  const userDataDir = await fs.mkdtemp(path.join('/tmp', 'ply-chrome-ud-'));
  const dataDir = await fs.mkdtemp(path.join('/tmp', 'ply-data-'));
  process.env.AGENT_HOST_CHROME_USER_DATA = userDataDir;

  try {
    // ---- Stage 1: Helper & TCC Accessibility 確認 -----------------------------------------------
    log(`Starting helper: ${HELPER_BIN}`);
    helper = createHelperClient({ command: HELPER_BIN, log: l => log(`[helper] ${l}`) });
    const ping = await helper.call('ping', {});
    const hello = helper.hello;
    const perms = await helper.call('permissions', {});
    const displays = await helper.call('chromeDisplays', {});
    results.stages.permissions = {
      ok: perms?.accessibility === true,
      hello,
      ping,
      accessibility: perms?.accessibility === true,
      screen: perms?.screen === true,
      displays: displays?.displays ?? [],
    };
    log(`Permissions: accessibility=${perms?.accessibility}, screen=${perms?.screen}, displays=${JSON.stringify(displays?.displays)}`);

    let lastAllowHelperResult = null;
    const rawHelperCall = helper.call.bind(helper);
    helper.call = async (op, args, timeoutMs) => {
      const res = await rawHelperCall(op, args, timeoutMs);
      if (op === 'chromeAllowDialog') lastAllowHelperResult = res;
      return res;
    };

    // IPC 往復の配線（parentPortChromeOs ⇄ attachChromeOs ⇄ createChromeOs(darwin)）
    const toWorker = [], toPort = [];
    const worker = { on: (_t, fn) => toWorker.push(fn), postMessage: m => queueMicrotask(() => toPort.forEach(fn => fn({ data: m }))) };
    const port = { on: (_t, fn) => toPort.push(fn), postMessage: m => queueMicrotask(() => toWorker.forEach(fn => fn(m))) };
    const macOs = createChromeOs({
      platform: 'darwin',
      helper,
      env: process.env,
      log: l => log(`[mac-os] ${l}`),
    });
    attachChromeOs(worker, { chromeOs: macOs, log: l => log(`[attach] ${l}`) });
    const osClient = parentPortChromeOs(port, { timeoutMs: 20_000, readyWaitMs: 5000 });
    const caps = await osClient.ready();
    results.stages.osLayer = { capabilities: caps };
    log(`OS Layer ready: ${JSON.stringify(caps)}`);

    // ---- Stage 2: Google Chrome の起動（--remote-debugging-port 無し）と enableRemoteDebugging ----
    const browser = await osClient.locateBrowser({ product: 'chrome' });
    log(`Located browser: ${JSON.stringify(browser)}`);
    if (!browser) throw new Error('Google Chrome not found on runner');

    const chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const verOut = await runCmd(chromeBin, ['--version']);
    log(`Google Chrome version: ${verOut.stdout || verOut.stderr}`);
    results.chromeVersion = verOut.stdout;

    log(`Launching initial Google Chrome window with --user-data-dir=${userDataDir}`);
    chromeProc = spawn(chromeBin, [
      `--user-data-dir=${userDataDir}`,
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    chromeProc.unref();

    // 最初の窓が立ち上がるのを待つ
    let initialWindows = [];
    const waitWinEnd = Date.now() + 15_000;
    while (Date.now() < waitWinEnd) {
      const snap = await osClient.snapshotWindows();
      if (Array.isArray(snap) && snap.length > 0) {
        initialWindows = snap;
        break;
      }
      await sleep(300);
    }
    log(`Initial Chrome windows: ${JSON.stringify(initialWindows)}`);
    const portBefore = await readActivePort(userDataDir);
    log(`DevToolsActivePort before enableRemoteDebugging: ${JSON.stringify(portBefore)}`);

    // 起動直後の AX ツリーを記録
    const initialAx = await helper.call('chromeDumpAx', { maxDepth: 12 }).catch(e => ({ error: e.message }));
    await fs.writeFile(path.join(OUT_DIR, 'ax-initial.json'), JSON.stringify(initialAx, null, 2));

    log('Calling osClient.enableRemoteDebugging...');
    const enableStart = Date.now();
    const enableRes = await osClient.enableRemoteDebugging({
      browser,
      profileDir: 'Default',
      userDataDir,
    });
    const enableElapsedMs = Date.now() - enableStart;
    log(`enableRemoteDebugging result (${enableElapsedMs}ms): ${JSON.stringify(enableRes)}`);

    // DevToolsActivePort が書かれるのを確かめる
    let activePort = null;
    const waitPortEnd = Date.now() + 5000;
    while (Date.now() < waitPortEnd) {
      activePort = await readActivePort(userDataDir);
      if (activePort) break;
      await sleep(200);
    }
    const udEntries = await fs.readdir(userDataDir).catch(() => []);
    log(`userDataDir entries after enableRemoteDebugging: ${JSON.stringify(udEntries)}`);
    if (!enableRes?.ok || !activePort) {
      const failAx = await helper.call('chromeDumpAx', { maxDepth: 15 }).catch(e => ({ error: e.message }));
      await fs.writeFile(path.join(OUT_DIR, 'ax-enable-failed.json'), JSON.stringify(failAx, null, 2));
    }
    const windowsAfterEnable = await osClient.snapshotWindows();
    results.stages.enableRemoteDebugging = {
      ok: enableRes?.ok === true && Boolean(activePort),
      enableRes,
      elapsedMs: enableElapsedMs,
      portBefore,
      activePort,
      udEntries,
      initialWindows,
      windowsAfterEnable,
    };
    log(`ActivePort after enableRemoteDebugging: ${JSON.stringify(activePort)}, windowsAfterEnable=${JSON.stringify(windowsAfterEnable)}`);

    if (!activePort) {
      throw new Error(`DevToolsActivePort was not written after enableRemoteDebugging: ${JSON.stringify(enableRes)}`);
    }

    // ---- Stage 3: core/chrome/connection.mjs で接続 + findPermissionDialog + allowPermission ------
    log('Starting Chrome connection via createChromeConnection...');
    const stateHistory = [];
    conn = createChromeConnection({
      locate: { browser: 'chrome', userDataDir, custom: true },
      os: osClient,
      log: l => log(`[conn] ${l}`),
    });
    conn.onChange(s => {
      log(`[conn-state] ${ JSON.stringify(s) }`);
      stateHistory.push({ at: new Date().toISOString(), ...s });
    });

    // 確認なし・制限なしのモードの会話と同じ流れ（ADR 0218）: Pleiad の中の許可（consent）を付けて接続を求め、
    // 出た確認は接続の部品（connection.mjs）が findPermissionDialog → allowPermission で押す。ここでは押さない
    const demandPromise = conn.demand({ consent: true });
    const cdp = await withTimeout(demandPromise, 30_000, 'conn.demand({ consent: true })');
    const foundDialog = stateHistory.some(s => s.state === 'permission' && s.dialog === true);
    const allowResult = lastAllowHelperResult?.ok === true;
    const pressedByConnection = stateHistory.some(s => s.state === 'permission' && s.assist === 'allowing');
    const version = await cdp.send('Browser.getVersion');
    const allowMethod = lastAllowHelperResult?.method ?? null;
    const validAllowMethod = allowMethod === 'ax-press' || allowMethod === 'ax-confirm';
    results.stages.connectionAndPermission = {
      ok: conn.state().state === 'connected' && foundDialog && allowResult === true && validAllowMethod && pressedByConnection,
      pressedByConnection,
      foundDialog,
      allowResult,
      allowMethod,
      allowHelperResult: lastAllowHelperResult,
      connectedState: conn.state(),
      browserVersion: version,
      stateHistory,
    };
    log(`Connected to Chrome! allowMethod=${allowMethod}, Version: ${JSON.stringify(version)}`);

    // ---- Stage 4: core/chrome/relay.mjs + 同梱 agent-browser で open / snapshot / screenshot -------
    testServer = await startLocalTestServer();
    log(`Local test server listening at ${testServer.url}`);
    relay = createChromeRelay({
      connection: conn,
      os: osClient,
      locate: { browser: 'chrome', userDataDir, custom: true },
      authorize: async () => ({ allow: true }),
      turnLive: () => true,
      log: l => log(`[relay] ${l}`),
    });
    const bridge = chromeRelayBrowser(relay, { dataDir });
    const sessionId = 'mac-verify-session';
    const abEnv = await browserEnvironment({ bridge, dataDir, sessionId, unlock: true });
    const abDir = prepareAgentBrowserBin({ packaged: false, root: ROOT, dataDir });
    const abBin = path.join(abDir, commandName());
    log(`Prepared agent-browser binary: ${abBin}, env=${JSON.stringify(abEnv)}`);

    const runEnv = { ...process.env, ...abEnv };
    const openOut = await runCmd(abBin, ['open', testServer.url], { env: runEnv, timeoutMs: 30_000 });
    log(`agent-browser open: ${JSON.stringify(openOut)}`);
    const snapOut = await runCmd(abBin, ['snapshot', '-i'], { env: runEnv, timeoutMs: 20_000 });
    log(`agent-browser snapshot -i: ${JSON.stringify(snapOut)}`);
    const abScreenshotPath = path.join(OUT_DIR, 'agent-browser-screenshot.png');
    const shotOut = await runCmd(abBin, ['screenshot', abScreenshotPath], { env: runEnv, timeoutMs: 20_000 });
    log(`agent-browser screenshot: ${JSON.stringify(shotOut)}`);
    const abScreenshotExists = existsSync(abScreenshotPath);

    // CDP でも直接スクリーンショットを撮る
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    const agentTarget = targetInfos.find(t => t.type === 'page' && t.url.includes('127.0.0.1'));
    let cdpScreenshotSaved = false;
    let agentWindowId = null;
    if (agentTarget) {
      const winForTarget = await cdp.send('Browser.getWindowForTarget', { targetId: agentTarget.targetId });
      agentWindowId = winForTarget.windowId;
      const { sessionId: targetSession } = await cdp.send('Target.attachToTarget', { targetId: agentTarget.targetId, flatten: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, targetSession);
      if (shot?.data) {
        await fs.writeFile(path.join(OUT_DIR, 'cdp-screenshot.png'), Buffer.from(shot.data, 'base64'));
        cdpScreenshotSaved = true;
      }
      await cdp.send('Target.detachFromTarget', { sessionId: targetSession }).catch(() => {});
    }

    results.stages.agentBrowser = {
      ok: openOut.ok && snapOut.ok && shotOut.ok && abScreenshotExists,
      open: openOut,
      snapshot: snapOut,
      screenshot: shotOut,
      abScreenshotExists,
      cdpScreenshotSaved,
      agentWindowId,
    };

    // ---- Stage 5: conceal の実証実験（AXPosition・Browser.setWindowBounds・最小化） -----------------
    if (agentTarget && agentWindowId != null) {
      log(`Running conceal experiments on windowId=${agentWindowId}...`);
      const { sessionId: ts } = await cdp.send('Target.attachToTarget', { targetId: agentTarget.targetId, flatten: true });
      const winSnap = await helper.call('chromeWindows', { port: activePort.port });
      const cdpBounds0 = (await cdp.send('Browser.getWindowBounds', { windowId: agentWindowId }))?.bounds;
      const axWin = winSnap?.windows?.find(w =>
        cdpBounds0 && Math.abs(w.x - cdpBounds0.left) <= 20 && Math.abs(w.y - cdpBounds0.top) <= 20
      ) ?? winSnap?.windows?.at(-1);

      const spot = await osClient.hiddenSpot() ?? { x: 3000, y: 0 };
      const concealReport = { initialCdpBounds: cdpBounds0, axWindow: axWin, hiddenSpot: spot };

      // 実験 1: AXPosition で画面外（spot）へ移動
      if (axWin?.id) {
        const axMove = await helper.call('chromeMoveWindow', { id: axWin.id, x: spot.x, y: spot.y });
        await sleep(300);
        const cdpAfterAx = (await cdp.send('Browser.getWindowBounds', { windowId: agentWindowId }))?.bounds;
        let axShotOk = false;
        try {
          const s = await withTimeout(cdp.send('Page.captureScreenshot', { format: 'png' }, ts), 3000, 'AX offscreen screenshot');
          if (s?.data) {
            await fs.writeFile(path.join(OUT_DIR, 'conceal-ax-move.png'), Buffer.from(s.data, 'base64'));
            axShotOk = true;
          }
        } catch (err) {
          axMove.screenshotError = err.message;
        }
        concealReport.axPositionOffscreen = {
          requested: spot,
          axResult: axMove,
          cdpBoundsAfter: cdpAfterAx,
          fullyOffscreen: (axMove?.x ?? 0) >= spot.x - 10,
          screenshotOk: axShotOk,
        };
      }

      // 実験 2: CDP Browser.setWindowBounds で画面外（spot）へ移動
      await cdp.send('Browser.setWindowBounds', {
        windowId: agentWindowId,
        bounds: { left: spot.x, top: spot.y, width: 800, height: 800 },
      }).catch(e => { concealReport.cdpSetBoundsError = e.message; });
      await sleep(300);
      const cdpAfterSet = (await cdp.send('Browser.getWindowBounds', { windowId: agentWindowId }))?.bounds;
      const winAfterSet = await helper.call('chromeWindows', { port: activePort.port });
      const axAfterSet = winAfterSet?.windows?.find(w => w.id === axWin?.id);
      let cdpShotOk = false;
      try {
        const s = await withTimeout(cdp.send('Page.captureScreenshot', { format: 'png' }, ts), 3000, 'CDP offscreen screenshot');
        if (s?.data) cdpShotOk = true;
      } catch {}
      concealReport.cdpSetWindowBoundsOffscreen = {
        requested: spot,
        cdpBoundsAfter: cdpAfterSet,
        axBoundsAfter: axAfterSet ? { x: axAfterSet.x, y: axAfterSet.y, width: axAfterSet.width, height: axAfterSet.height } : null,
        fullyOffscreen: (cdpAfterSet?.left ?? 0) >= spot.x - 10,
        screenshotOk: cdpShotOk,
      };

      // 実験 3: 最小化（AXMinimized = true）の状態で描画・captureScreenshot・入力が効くか
      if (axWin?.id) {
        const minRes = await helper.call('chromeMoveWindow', { id: axWin.id, minimized: true });
        await sleep(500);
        await cdp.send('Runtime.evaluate', {
          expression: `document.getElementById('status').textContent = 'Minimized-' + Date.now()`,
        }, ts).catch(() => {});
        let minShotOk = false;
        let minShotError = null;
        const shotStart = Date.now();
        try {
          const s = await withTimeout(cdp.send('Page.captureScreenshot', { format: 'png' }, ts), 3000, 'Minimized screenshot');
          if (s?.data) {
            await fs.writeFile(path.join(OUT_DIR, 'conceal-minimized.png'), Buffer.from(s.data, 'base64'));
            minShotOk = true;
          }
        } catch (err) {
          minShotError = err.message;
        }
        const minShotMs = Date.now() - shotStart;
        await helper.call('chromeMoveWindow', { id: axWin.id, x: 100, y: 100, minimized: false });
        concealReport.minimized = {
          minimizedState: minRes?.minimized === true,
          screenshotOk: minShotOk,
          screenshotMs: minShotMs,
          screenshotError: minShotError,
        };
      }

      await cdp.send('Target.detachFromTarget', { sessionId: ts }).catch(() => {});
      results.stages.conceal = concealReport;
      log(`Conceal experiments: ${JSON.stringify(concealReport)}`);
    }

    // 任意のデスクトップ全体の撮影（TCC Screen Recording が無ければ失敗してもよい）
    const desktopShot = path.join(OUT_DIR, 'desktop-screencapture.png');
    const scRes = await runCmd('/usr/sbin/screencapture', ['-x', desktopShot], { timeoutMs: 5000 });
    results.stages.desktopScreencapture = { ok: scRes.ok && existsSync(desktopShot), detail: scRes };
  } catch (error) {
    log(`Verification failed with error: ${error?.stack ?? error}`);
    results.error = String(error?.stack ?? error);
  } finally {
    results.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
    try { await relay?.close?.(); } catch {}
    try { await conn?.close?.(); } catch {}
    try { await testServer?.close?.(); } catch {}
    try { helper?.stop?.(); } catch {}
    if (chromeProc?.pid) {
      try { process.kill(chromeProc.pid, 'SIGTERM'); } catch {}
    }
    await runCmd('/usr/bin/killall', ['Google Chrome'], { timeoutMs: 5000 }).catch(() => {});
  }

  const allOk = results.stages.permissions?.ok === true &&
    results.stages.enableRemoteDebugging?.ok === true &&
    results.stages.connectionAndPermission?.ok === true &&
    results.stages.agentBrowser?.ok === true;
  if (!allOk) {
    console.error('Verification did not pass all required stages.');
    process.exit(1);
  } else {
    console.log('All verification stages passed!');
    process.exit(0);
  }
}

main();
