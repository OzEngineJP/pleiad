'use strict';
// Chrome への接続の OS の層（docs/inapp-browser.md「OS ごとの層」、ADR 0153・0154）を選び、core の parentPort の依頼につなぐ。
// 実装があるのは Windows（win32.cjs）と macOS（mac.cjs）。ほかの OS・ネイティブ層を読めないときは「使えない」を返す層（どの口も null / false）。
// core は main の `chrome-os-ready { supported, reason, features, epoch }` を見て、エージェントのブラウザーを出すか決める。epoch は main の起動ごとの印
// （起動時の ready と chrome-os-ready-request への返事は重なって届く。core は epoch が替わったときだけ「main が入れ替わった」と見る）。
const crypto = require('node:crypto');
const { createWin32ChromeOs } = require('./win32.cjs');
const { createMacChromeOs } = require('./mac.cjs');

const FEATURES_NONE = Object.freeze({ dialog: false, raise: false, launch: false, conceal: false, watch: false, bounds: false, allow: false, enable: false });
const ACTIONS = new Set(['snapshotWindows', 'findPermissionDialog', 'allowPermission', 'enableRemoteDebugging', 'raise', 'yieldForeground', 'foreground', 'appWindow', 'close',
  'locateBrowser', 'launchWindow', 'findWindowByNonce', 'findWindowByBounds', 'hiddenSpot', 'conceal', 'reveal', 'release', 'closeAgent', 'exportAgent', 'adoptAgent']);

/**
 * @param {{ platform?: string, win32?: object|null, mac?: object|null, helper?: object|null, reason?: string, log?: (line: string) => void }} options
 *   win32 は desktop/computer/win32.cjs の表、mac / helper は desktop/computer/mac.cjs のヘルパー。該当する OS の実装が無ければ unsupported
 */
function createChromeOs({ platform = process.platform, win32 = null, mac = null, helper = null, reason = 'native', log = () => {}, ...deps } = {}) {
  if (platform === 'win32' && win32) return createWin32ChromeOs({ win32, log, ...deps });
  if (platform === 'darwin' && (mac || helper)) return createMacChromeOs({ mac, helper, log, ...deps });
  const why = (platform === 'win32' || platform === 'darwin') ? reason : 'platform';
  return {
    capabilities: () => ({ supported: false, reason: why, features: FEATURES_NONE }),
    snapshotWindows: () => null,
    findPermissionDialog: () => null,
    allowPermission: () => false,
    enableRemoteDebugging: () => ({ ok: false, reason: 'unsupported' }),
    raise: () => ({ ok: false, method: 'unsupported' }),
    yieldForeground: () => false,
    foreground: () => null,
    bounds: () => null,
    watch: () => () => {},
    appWindow: () => null,
    close: () => false,
    locateBrowser: () => null,
    launchWindow: () => ({ ok: false, reason: 'unsupported' }),
    findWindowByNonce: () => null,
    findWindowByBounds: () => null,
    hiddenSpot: () => null,
    conceal: () => false,
    reveal: () => false,
    release: () => false,
    closeAgent: () => false,
    exportAgent: () => null,
    adoptAgent: () => null,
    reconceal: () => 0,
    closeAllAgents: () => 0,
  };
}

/** core（utilityProcess）の `chrome-os` の依頼を受けて口を呼び、`chrome-os-result` を返す。起動時と chrome-os-ready-request に chrome-os-ready を送る */
function attachChromeOs(worker, { chromeOs, log = () => {} }) {
  const post = message => { try { worker.postMessage(message); } catch (error) { log(`postMessage failed: ${error.message}`); } };
  const epoch = crypto.randomBytes(8).toString('hex');
  const ready = () => { const c = chromeOs.capabilities(); post({ type: 'chrome-os-ready', supported: c.supported === true, ...(c.reason ? { reason: c.reason } : {}), features: c.features ?? FEATURES_NONE, epoch }); };
  worker.on('message', message => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'chrome-os-ready-request') { ready(); return; }
    if (message.type !== 'chrome-os') return;
    const { id, action, args } = message;
    if (!ACTIONS.has(action)) { post({ type: 'chrome-os-result', id, ok: false, error: `unknown action: ${String(action).slice(0, 40)}` }); return; }
    try {
      const a = args ?? {};
      let result;
      switch (action) {
        case 'findPermissionDialog': result = chromeOs.findPermissionDialog({ since: a.since, port: a.port }); break;
        case 'allowPermission': result = chromeOs.allowPermission(a.ref); break;
        case 'enableRemoteDebugging': result = chromeOs.enableRemoteDebugging({ browser: a.browser, profileDir: a.profileDir, userDataDir: a.userDataDir }); break;
        case 'raise': result = chromeOs.raise(a.ref); break;
        case 'yieldForeground': result = chromeOs.yieldForeground(a.ref, { to: a.to }); break;
        case 'close': result = chromeOs.close(a.ref); break;
        case 'locateBrowser': result = chromeOs.locateBrowser({ product: a.product }); break;
        case 'launchWindow': result = chromeOs.launchWindow(a); break;
        case 'findWindowByNonce': result = chromeOs.findWindowByNonce(a.nonce); break;
        case 'findWindowByBounds': result = chromeOs.findWindowByBounds({ bounds: a.bounds, port: a.port, since: a.since, tolerance: a.tolerance }); break;
        case 'conceal': result = chromeOs.conceal(a.ref); break;
        case 'reveal': result = chromeOs.reveal(a.ref, { near: a.near }); break;
        case 'release': result = chromeOs.release(a.ref); break;
        case 'closeAgent': result = chromeOs.closeAgent(a.ref); break;
        case 'exportAgent': result = chromeOs.exportAgent(a.ref); break;
        case 'adoptAgent': result = chromeOs.adoptAgent(a.token, { revealed: a.revealed === true }); break;
        default: result = chromeOs[action](); break;
      }
      if (result && typeof result.then === 'function') {
        result.then(
          resolved => post({ type: 'chrome-os-result', id, ok: true, result: resolved }),
          error => { log(`${action} failed: ${error?.message ?? error}`); post({ type: 'chrome-os-result', id, ok: false, error: String(error?.message ?? error) }); },
        );
      } else {
        post({ type: 'chrome-os-result', id, ok: true, result });
      }
    } catch (error) {
      log(`${action} failed: ${error.message}`);
      post({ type: 'chrome-os-result', id, ok: false, error: String(error.message ?? error) });
    }
  });
  ready();
}

module.exports = { createChromeOs, attachChromeOs };
