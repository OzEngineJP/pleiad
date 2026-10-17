'use strict';
// Chrome への接続の OS の層（macOS）。core/chrome/os.mjs の口の実装（docs/inapp-browser.md「OS ごとの層」）。
// 窓の列挙・確認のダイアログの検出と許可・chrome://inspect/#remote-debugging のトグルは Swift ヘルパー
// （desktop/computer/mac/ の pleiad-computer-helper）に JSON Lines で頼む。テストは偽の helper で動かす。

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DIALOG_TITLE = /リモート\s*デバッグ|remote debugging/i;
const MAX_DIALOG_DIP = { width: 1000, height: 700 };
const MAX_REFS = 200;
const MAX_AGENT_REFS = 64;
const HIDDEN_MARGIN = 1000;
const HIDDEN_X_MAX = 30000;

const PRODUCTS = {
  chrome: {
    exe: 'Google Chrome',
    candidates: env => {
      const home = env.HOME || os.homedir();
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      ];
    },
  },
};

const PROFILE_DIR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const NONCE = /^[a-f0-9]{8,64}$/;
const NONCE_URL = /^data:text\/html[,;]/;
const WS_PATH = /^\/devtools\/browser\/[A-Za-z0-9-]+$/;

const DEFAULT_FEATURES = Object.freeze({
  dialog: true,
  raise: true,
  launch: true,
  conceal: false,
  watch: false,
  bounds: true,
  allow: true,
  enable: true,
});

const isInt = v => Number.isInteger(v) && Math.abs(v) < 100000;
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function defaultProbePort(port, timeoutMs = 400) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = ok => { try { socket.destroy(); } catch {} resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function parseActivePortText(text) {
  if (typeof text !== 'string') return null;
  const [first = '', second = ''] = text.split(/\r?\n/);
  if (!/^\d{1,5}$/.test(first.trim())) return null;
  const port = Number(first.trim());
  const wsPath = second.trim();
  if (port < 1 || port > 65535 || !WS_PATH.test(wsPath)) return null;
  return { port, path: wsPath };
}

/**
 * @param {object} deps
 * @param deps.helper desktop/computer/mac-helper.cjs のクライアント（{ call(op, args, timeoutMs?) }）
 * @param [deps.spawn] Chrome を起こす（既定は child_process.spawn）
 * @param [deps.env] 環境変数
 * @param [deps.exists] ファイルがあるか（既定は fs.existsSync）
 * @param [deps.readFile] ファイルを読む（既定は fs.readFileSync）
 * @param [deps.probePort] ポートが生きているか確かめる関数
 * @param [deps.sleep] 待ち関数
 * @param [deps.features] 機能の表の上書き
 */
function createMacChromeOs({
  helper,
  mac = null,
  log = () => {},
  spawn = childProcess.spawn,
  env = process.env,
  exists = fs.existsSync,
  readFile = p => fs.readFileSync(p, 'utf8'),
  probePort = defaultProbePort,
  sleep = defaultSleep,
  features: featureOverrides = null,
  timing = {},
} = {}) {
  const client = helper ?? mac?.helper ?? null;
  const features = Object.freeze({ ...DEFAULT_FEATURES, ...(featureOverrides ?? {}) });
  const time = {
    findSetupMs: 8000,
    toggleMs: 14000,
    activateAfterMs: 1200,
    portWaitMs: 5000,
    pollMs: 120,
    ...timing,
  };

  const refs = new Map();     // id -> { id, kind: 'dialog' | 'foreign' | 'agent', pid?, info?, concealed? }
  const browsers = new Map(); // id -> { path, product }
  let browserSeq = 0;

  const remember = (id, kind, info = null) => {
    const key = String(id);
    const prev = refs.get(key);
    const keep = prev && prev.kind !== 'foreign' ? prev : null;
    const entry = keep ?? { id: key, kind };
    if (info && typeof info === 'object') {
      entry.pid = info.pid ?? entry.pid;
      entry.info = info;
    }
    refs.set(key, entry);
    if (refs.size > MAX_REFS) {
      for (const [k, e] of refs) { if (e.kind !== 'agent') { refs.delete(k); break; } }
    }
    return { id: key };
  };

  const rememberAgent = (id, info = null) => {
    const key = String(id);
    if (refs.get(key)?.kind === 'dialog') return null;
    const out = remember(key, 'agent', info);
    const agents = [...refs].filter(([, e]) => e.kind === 'agent');
    if (agents.length > MAX_AGENT_REFS) {
      const [oldKey, old] = agents[0];
      if (!old.concealed) refs.delete(oldKey);
    }
    return out;
  };

  const known = ref => (ref && typeof ref.id === 'string' ? refs.get(ref.id) : undefined);
  const knownAgent = ref => { const entry = known(ref); return entry?.kind === 'agent' ? entry : undefined; };

  async function callHelper(op, args = {}, timeoutMs) {
    if (!client || typeof client.call !== 'function') return null;
    try { return await client.call(op, args, timeoutMs); }
    catch (error) { log(`mac-chrome-os ${op} failed: ${error.message}`); return null; }
  }

  async function snapshotWindows() {
    const res = await callHelper('chromeWindows', {});
    if (!res || !Array.isArray(res.windows)) return null;
    for (const w of res.windows) {
      if (w && typeof w.id === 'string' && refs.has(w.id)) refs.get(w.id).info = w;
    }
    return res.windows.map(w => String(w.id));
  }

  async function findPermissionDialog({ since = [], port = null } = {}) {
    const cleanSince = Array.isArray(since) ? since.map(String) : [];
    const cleanPort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
    const res = await callHelper('chromeFindDialog', { since: cleanSince, port: cleanPort });
    const d = res?.dialog;
    if (!d || typeof d.id !== 'string') return null;
    return remember(d.id, 'dialog', d);
  }

  async function allowPermission(ref) {
    const entry = known(ref);
    if (!entry || entry.kind !== 'dialog') return false;
    const res = await callHelper('chromeAllowDialog', { id: entry.id });
    return res?.ok === true;
  }

  function resolveUserDataDir(userDataDir) {
    if (userDataDir != null) {
      if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir) || userDataDir.split(/[\\/]/).includes('..')) return null;
      return userDataDir;
    }
    if (env.AGENT_HOST_CHROME_USER_DATA) return env.AGENT_HOST_CHROME_USER_DATA;
    const home = env.HOME || os.homedir();
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }

  async function isActivePortListening(dir) {
    if (!dir) return false;
    let text;
    try { text = readFile(path.join(dir, 'DevToolsActivePort')); } catch { return false; }
    const parsed = parseActivePortText(text);
    if (!parsed) return false;
    return (await probePort(parsed.port)) === true;
  }

  async function enableRemoteDebugging({ browser, profileDir = 'Default', userDataDir = null } = {}) {
    const targetDir = resolveUserDataDir(userDataDir);
    if (userDataDir != null && !targetDir) return { ok: false, reason: 'invalid-user-data-dir' };
    if (await isActivePortListening(targetDir)) return { ok: true };

    let resolvedBrowser = null;
    let browserRef = browser;
    if (browser != null) {
      resolvedBrowser = typeof browser.id === 'string' ? browsers.get(browser.id) : null;
      if (!resolvedBrowser) return { ok: false, reason: 'invalid-browser' };
    } else {
      browserRef = locateBrowser({ product: 'chrome' });
      if (browserRef) resolvedBrowser = browsers.get(browserRef.id);
      if (!resolvedBrowser) return { ok: false, reason: 'browser-not-found' };
    }

    const prof = typeof profileDir === 'string' && PROFILE_DIR.test(profileDir) ? profileDir : 'Default';
    const nonce = crypto.randomBytes(8).toString('hex');
    const marker = `PLY-ENABLE-${nonce}`;
    const url = `data:text/html,<title>${marker}</title>`;
    const customDir = userDataDir ?? (env.AGENT_HOST_CHROME_USER_DATA || null);

    const fgBefore = await callHelper('foreground', {});
    let prevFrontPid = Number.isInteger(fgBefore?.app?.pid) ? fgBefore.app.pid : 0;

    const launched = launchWindow({
      browser: browserRef,
      profileDir: prof,
      url,
      nonce,
      userDataDir: customDir,
    });
    if (!launched?.ok) return { ok: false, reason: launched?.reason ?? 'launch-failed' };

    // 1. 開いた設定用の窓を題のマーカーで見つける
    let setupId = null;
    const findDeadline = Date.now() + time.findSetupMs;
    while (Date.now() < findDeadline) {
      const res = await callHelper('chromeWindows', {});
      const hit = res?.windows?.find(w => typeof w.title === 'string' && w.title.includes(marker));
      if (hit?.id) { setupId = String(hit.id); break; }
      await sleep(time.pollMs);
    }
    if (!setupId) return { ok: false, reason: 'window-not-found' };

    try {
      // 2. chrome://inspect/#remote-debugging へ遷移し、チェックボックスをオンにする
      let navigated = false;
      let activated = false;
      let stillOnMarker = true;
      let lastLogKey = '';
      const start = Date.now();
      const deadline = start + time.toggleMs;
      while (Date.now() < deadline) {
        const elapsed = Date.now() - start;
        const shouldActivate = navigated && !activated && stillOnMarker && elapsed >= time.activateAfterMs;
        if (shouldActivate) activated = true;
        const step = await callHelper('chromeEnableStep', {
          id: setupId,
          url: 'chrome://inspect/#remote-debugging',
          marker,
          navigate: !navigated,
          activateFallback: shouldActivate,
        });
        const logKey = `${step?.state}:${step?.title}:${step?.checked}:${step?.checkboxes?.length ?? 0}`;
        if (logKey !== lastLogKey) {
          log(`enableStep (${elapsed}ms): ${JSON.stringify(step)}`);
          lastLogKey = logKey;
        }
        if (step?.prevFrontPid > 0 && !prevFrontPid) prevFrontPid = step.prevFrontPid;
        if (typeof step?.stillOnMarker === 'boolean') stillOnMarker = step.stillOnMarker;
        else if (typeof step?.title === 'string' && !step.title.includes(marker)) stillOnMarker = false;

        if (step?.state === 'navigated-bg' || step?.state === 'navigated-active' || step?.state === 'navigated-hotkey') {
          navigated = true;
        } else if (step?.state === 'already-on' || (step?.state === 'toggled' && step?.checked !== false)) {
          const portDeadline = Date.now() + time.portWaitMs;
          while (Date.now() < portDeadline) {
            if (await isActivePortListening(targetDir)) return { ok: true };
            await sleep(time.pollMs);
          }
          return { ok: true };
        }
        await sleep(time.pollMs);
      }
      return { ok: false, reason: 'toggle-timeout' };
    } finally {
      await callHelper('chromeClose', { id: setupId });
      if (prevFrontPid > 0) await callHelper('activate', { pid: prevFrontPid });
    }
  }

  async function raise(ref) {
    const entry = known(ref);
    if (!entry) return { ok: false, method: 'unknown-ref' };
    const res = await callHelper('chromeRaise', { id: entry.id });
    return { ok: res?.ok === true, method: res?.method ?? (res?.ok ? 'direct' : 'failed') };
  }

  async function foreground() {
    const res = await callHelper('foreground', {});
    const app = res?.app;
    if (!app || !Number.isInteger(app.pid)) return null;
    const isBrowser = app.bundleId === 'com.google.Chrome' || app.bundleId === 'com.microsoft.edgemac' ||
      app.name === 'Google Chrome' || app.name === 'Microsoft Edge';
    if (isBrowser) {
      const wins = await callHelper('chromeWindows', {});
      const top = wins?.windows?.[0];
      if (top?.id) {
        const r = remember(top.id, 'foreign', top);
        return { id: r.id, browser: true };
      }
    }
    const id = `pid:${app.pid}`;
    remember(id, 'foreign', { pid: app.pid });
    return { id, browser: isBrowser };
  }

  async function yieldForeground(ref, { to } = {}) {
    const entry = known(ref);
    const target = known(to);
    if (!entry || !target || entry.id === target.id) return false;
    const fg = await foreground();
    if (!fg || (fg.id !== entry.id && !(fg.browser && target.id.startsWith('pid:')))) return false;
    if (target.id.startsWith('pid:')) {
      const pid = Number(target.id.slice(4));
      if (!Number.isInteger(pid) || pid <= 0) return false;
      const res = await callHelper('activate', { pid });
      return res?.activated === true;
    }
    const res = await callHelper('chromeRaise', { id: target.id });
    return res?.ok === true;
  }

  function appWindow() {
    return null;
  }

  async function close(ref) {
    const entry = known(ref);
    if (!entry || entry.kind !== 'dialog') return false;
    const res = await callHelper('chromeClose', { id: entry.id });
    return res?.ok === true;
  }

  function bounds(ref) {
    const entry = known(ref);
    const info = entry?.info;
    if (!info || typeof info.x !== 'number' || typeof info.width !== 'number') return null;
    return { x: info.x, y: info.y, width: info.width, height: info.height };
  }

  function watch() {
    return () => {};
  }

  function locateBrowser({ product = 'chrome' } = {}) {
    const spec = PRODUCTS[product];
    if (!spec) return null;
    for (const candidate of spec.candidates(env)) {
      if (exists(candidate)) {
        const hit = [...browsers].find(([, v]) => v.path === candidate && v.product === product);
        if (hit) return { id: hit[0], product };
        const id = `b${++browserSeq}`;
        browsers.set(id, { path: candidate, product });
        return { id, product };
      }
    }
    return null;
  }

  function launchWindow({ browser, profileDir, url, nonce, userDataDir = null, position = null, size = null } = {}) {
    const entry = browser && typeof browser.id === 'string' ? browsers.get(browser.id) : null;
    if (!entry) return { ok: false, reason: 'invalid-browser' };
    if (typeof profileDir !== 'string' || !PROFILE_DIR.test(profileDir)) return { ok: false, reason: 'invalid-profile' };
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return { ok: false, reason: 'invalid-nonce' };
    if (typeof url !== 'string' || !NONCE_URL.test(url) || !url.includes(nonce)) return { ok: false, reason: 'invalid-url' };
    if (userDataDir != null && (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir) || userDataDir.split(/[\\/]/).includes('..'))) {
      return { ok: false, reason: 'invalid-user-data-dir' };
    }
    const args = [`--profile-directory=${profileDir}`];
    if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
    if (position && isInt(position.x) && isInt(position.y)) args.push(`--window-position=${position.x},${position.y}`);
    if (size && isInt(size.width) && isInt(size.height) && size.width > 0 && size.height > 0) args.push(`--window-size=${size.width},${size.height}`);
    args.push('--no-first-run', '--no-default-browser-check', '--new-window', url);
    try {
      const child = spawn(entry.path, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child?.on?.('error', error => log(`launchWindow error: ${error.message}`));
      child?.unref?.();
      return { ok: true };
    } catch (error) {
      log(`launchWindow failed: ${error.message}`);
      return { ok: false, reason: 'spawn-failed' };
    }
  }

  async function findWindowByNonce(nonce) {
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return null;
    const res = await callHelper('chromeWindows', {});
    if (!res || !Array.isArray(res.windows)) return null;
    const hit = res.windows.find(w => typeof w.title === 'string' && w.title.includes(nonce) && refs.get(String(w.id))?.kind !== 'dialog');
    return hit ? rememberAgent(hit.id, hit) : null;
  }

  async function findWindowByBounds({ bounds: b, port = null, since = [], tolerance = null } = {}) {
    if (!b || ![b.left, b.top, b.width, b.height].every(Number.isFinite)) return null;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const res = await callHelper('chromeWindows', { port });
    const ownerPid = res?.ownerPid;
    if (!ownerPid || !Array.isArray(res?.windows)) return null;
    const tol = Number.isFinite(tolerance) && tolerance >= 1 ? tolerance : 16;
    const before = new Set(Array.isArray(since) ? since.map(String) : []);
    const near = (a, c) => Math.abs(a - c) <= tol;
    const hits = res.windows.filter(w => {
      const id = String(w.id);
      if (w.pid !== ownerPid || before.has(id) || !w.visible) return false;
      const k = refs.get(id);
      if (k && (k.kind === 'agent' || k.kind === 'dialog')) return false;
      if (DIALOG_TITLE.test(w.title || '') && w.width <= MAX_DIALOG_DIP.width && w.height <= MAX_DIALOG_DIP.height) return false;
      return near(w.x, b.left) && near(w.y, b.top) && near(w.width, b.width) && near(w.height, b.height);
    });
    if (hits.length !== 1) return null;
    return rememberAgent(hits[0].id, hits[0]);
  }

  async function hiddenSpot() {
    const res = await callHelper('chromeDisplays', {});
    const displays = res?.displays;
    if (!Array.isArray(displays) || !displays.length) return null;
    let right = displays[0];
    for (const d of displays) if (d.x + d.width > right.x + right.width) right = d;
    const x = Math.round(right.x + right.width + HIDDEN_MARGIN);
    const y = Math.round(right.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x > HIDDEN_X_MAX) return null;
    return { x, y };
  }

  async function conceal(ref) {
    if (!features.conceal) return false;
    const entry = knownAgent(ref);
    if (!entry) return false;
    const spot = await hiddenSpot();
    if (!spot) return false;
    const res = await callHelper('chromeMoveWindow', { id: entry.id, x: spot.x, y: spot.y });
    if (res?.ok !== true) return false;
    entry.concealed = true;
    if (entry.info) { entry.info.x = res.x ?? spot.x; entry.info.y = res.y ?? spot.y; }
    return true;
  }

  async function reveal(ref) {
    const entry = knownAgent(ref);
    if (!entry) return false;
    const res = await callHelper('chromeDisplays', {});
    const main = res?.displays?.find(d => d.isMain) ?? res?.displays?.[0] ?? { x: 0, y: 0, width: 1440, height: 900 };
    const x = Math.round(main.x + 80);
    const y = Math.round(main.y + 80);
    const moved = await callHelper('chromeMoveWindow', { id: entry.id, x, y, minimized: false });
    if (moved?.ok !== true) return false;
    entry.concealed = false;
    if (entry.info) { entry.info.x = moved.x ?? x; entry.info.y = moved.y ?? y; }
    return true;
  }

  function release(ref) {
    const entry = knownAgent(ref);
    if (!entry) return false;
    refs.delete(entry.id);
    return true;
  }

  async function closeAgent(ref) {
    const entry = knownAgent(ref);
    if (!entry) return false;
    const res = await callHelper('chromeClose', { id: entry.id });
    if (res?.ok === true) { refs.delete(entry.id); return true; }
    await reveal(ref);
    refs.delete(entry.id);
    return false;
  }

  function exportAgent(ref) {
    const entry = knownAgent(ref);
    if (!entry || !entry.concealed) return null;
    return `mac:${entry.id}`;
  }

  async function adoptAgent(token, { revealed = false } = {}) {
    if (typeof token !== 'string' || !token.startsWith('mac:')) return null;
    const id = token.slice(4);
    const res = await callHelper('chromeWindows', {});
    const hit = res?.windows?.find(w => String(w.id) === id);
    if (!hit) return null;
    const out = rememberAgent(id, hit);
    if (!out) return null;
    const entry = refs.get(out.id);
    entry.concealed = !revealed;
    if (!revealed && features.conceal) await conceal(out);
    return out;
  }

  return {
    capabilities: () => ({ supported: Boolean(client), ...(client ? { reason: null } : { reason: 'native' }), features: client ? features : Object.freeze({ ...features, dialog: false, raise: false, launch: false, conceal: false, watch: false, bounds: false, allow: false, enable: false }) }),
    snapshotWindows,
    findPermissionDialog,
    allowPermission,
    enableRemoteDebugging,
    raise,
    yieldForeground,
    foreground,
    appWindow,
    close,
    bounds,
    watch,
    locateBrowser,
    launchWindow,
    findWindowByNonce,
    findWindowByBounds,
    hiddenSpot,
    conceal,
    reveal,
    release,
    closeAgent,
    exportAgent,
    adoptAgent,
    reconceal: () => 0,
    closeAllAgents: () => 0,
  };
}

module.exports = { createMacChromeOs, DEFAULT_FEATURES, parseActivePortText };
