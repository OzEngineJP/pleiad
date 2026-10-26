// main との接続・切断を通知する。再接続時は同じ server link を使い、最初の接続か付け直しかを区別する。
import { detach } from './process.mjs';
import path from 'node:path';

export function createMainAway({ mainPort }) {
  const listeners = { away: new Set(), back: new Set() };
  let connects = 0;
  const fire = (set, ...args) => { for (const cb of [...set]) { try { cb(...args); } catch (e) { console.error('main-away:', String(e?.message ?? e)); } } };
  if (mainPort.resumable) {
    mainPort.on('disconnect', () => fire(listeners.away));
    mainPort.on('connect', () => {
      const first = connects++ === 0;
      fire(listeners.back, { first });
    });
  }
  const on = set => cb => { set.add(cb); return () => set.delete(cb); };
  return {
    onAway: on(listeners.away),
    onBack: on(listeners.back),
    get connects() { return connects; },
  };
}

/** 既定のブラウザーで開いてよい URL か（desktop/secret-bridge.cjs の openableAuthUrl と同じ範囲: https と、ループバックの http） */
export function openableUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
    if (u.protocol === 'https:') return u.href;
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u.href;
  } catch { /* 開かない */ }
  return null;
}

/**
 * URL を OS の既定のブラウザーで開く内容を組み立てる（起動はしない）。シェルを通さず、起動するプログラムは絶対パスで指す
 * （core/os-open.mjs の launchPlan と同じ考え方）。引数の URL は URL として解釈し直した href（" を含まない）
 */
export function urlLaunchPlan(url, { platform = process.platform, env = process.env } = {}) {
  const href = openableUrl(url);
  if (!href) throw new Error('unopenable url');
  const detached = { detached: true, stdio: 'ignore', shell: false, windowsHide: false };
  if (platform === 'win32') {
    const explorer = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'explorer.exe');
    return { command: explorer, args: [`"${href}"`], options: { ...detached, windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [href], options: detached };
  return { command: 'xdg-open', args: [href], options: detached };
}

/**
 * OAuth の同意画面などを開く（claudeLogin・mcpOAuth の openExternal）。main が居れば main の shell に頼み（今のとおり）、
 * main の下の起動（hosted）で main が居ない間は、サーバーが OS の既定のブラウザーで開く。main の下でない起動（npm start）は何もしない
 * （画面の URL から人が開く）。spawnImpl は試験の差し替え（既定は core/process.mjs の detach。ADR 0270 の規則 ①）
 */
export function createExternalOpener({ mainPort, spawnImpl = null, log = () => {} }) {
  return url => {
    if (mainPort.postMessage({ type: 'open-external', url })) return true;
    if (!mainPort.hosted) return false;
    try {
      const plan = urlLaunchPlan(url);
      if (spawnImpl) {
        const child = spawnImpl(plan.command, plan.args, plan.options);
        child.once?.('error', error => log(`open-external failed: ${error?.message ?? error}`));
        child.unref?.();
      } else {
        void detach(plan.command, plan.args, { windowsHide: plan.options.windowsHide, windowsVerbatimArguments: plan.options.windowsVerbatimArguments })
          .catch(error => log(`open-external failed: ${error?.message ?? error}`));
      }
      return true;
    } catch (error) {
      log(`open-external failed: ${error?.message ?? error}`);
      return false;
    }
  };
}
