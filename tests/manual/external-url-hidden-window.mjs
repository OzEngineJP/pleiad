// 本物の Windows の Chrome での確かめ（手元で明示的に流す。CI・npm test には入れない。macOS・Linux では何もせず終わる）。
//
//   「会話の専用窓を作って隠す → 外のアプリが URL を渡す（ShellExecute 相当） → そのタブが見える窓にある」
//
// 使い方:  node tests/manual/external-url-hidden-window.mjs          （Pleiad・利用者の Chrome は止めない。数十秒。Chrome の窓が一瞬、画面に出る）
// 前提:    Windows 11、Chrome（chrome.exe）、既定のブラウザーが Chrome、koffi（npm install 済み）。
// やること: 専用の User Data（一時フォルダー）で Chrome を 1 つ起こし（これが「利用者の窓」）、本物の層（desktop/chrome-os）と中継（core/chrome/relay.mjs）で
//           会話の窓を 1 つ作って隠す。次に chrome.exe --user-data-dir=<同じ> <URL> を起こす（Chrome が既存のプロセスへ渡し、last-active の窓に開く。
//           Slack などが ShellExecute で渡すのと同じ振る舞い）。そのタブが、画面の中にある窓に出ていることを確かめる。
//           利用者の Chrome・Pleiad には触らない。終わりに起こした Chrome を Browser.close で閉じ、一時フォルダーを消す。キー入力は送らない。
// 修正前の確かめ: git stash で core/chrome/relay.mjs を修正前に戻して流すと、「外の URL のタブが隠した窓に居る」で落ちる。
// 終了コード: 0 = 通過、1 = 失敗、2 = 前提が無い（試せなかった）。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';

const require = createRequire(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? '  OK ' : ' FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`); if (!ok) failures.push(name); };

if (process.platform !== 'win32') { console.log('skip: Windows only'); process.exit(2); }
const chromePath = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].map(k => process.env[k] && path.join(process.env[k], 'Google', 'Chrome', 'Application', 'chrome.exe')).find(p => p && fs.existsSync(p));
if (!chromePath) { console.log('skip: chrome.exe not found'); process.exit(2); }
const { loadWin32 } = require('../../desktop/computer/win32.cjs');
const { withPerMonitorDpi } = require('../../desktop/computer/service.cjs');
const { createChromeOs } = require('../../desktop/chrome-os/index.cjs');
const win32 = loadWin32();
if (!win32) { console.log('skip: koffi (Win32) is not available'); process.exit(2); }

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-it-'));
const logs = [];
const raw = createChromeOs({ platform: 'win32', win32: withPerMonitorDpi(win32), log: line => logs.push(`os: ${line}`), pointToDip: p => p, appHwnd: () => 0 });

// 本物の層を、core が使う形（非同期・generation・ready）に包む。main の openUrlVisibly の代わりに、見える窓を前に出したあと、同じ User Data の chrome.exe へ URL を渡す
const spawnChrome = args => { const child = spawn(chromePath, [`--user-data-dir=${userDataDir}`, ...args], { detached: true, stdio: 'ignore' }); child.unref(); return child; };
const layer = new Proxy({}, {
  get(_, key) {
    if (key === 'ready') return async () => raw.capabilities();
    if (key === 'generation') return () => 1;
    if (key === 'onReady') return () => () => {};
    if (key === 'capabilities' || key === 'watch' || key === 'guardTick' || key === 'stopGuard') return raw[key];
    if (key === 'openVisible') return async url => { const r = raw.raiseVisibleBrowser({ scheme: 'https', url }); if (!r?.ok) return false; await sleep(150); spawnChrome([url]); return true; };
    return typeof raw[key] === 'function' ? async (...args) => raw[key](...args) : raw[key];
  },
});

let observer = null, relay = null, conn = null, agent = null;
async function cdpClient(url) {
  const ws = new WebSocket(url);
  let next = 0; const waiting = new Map();
  ws.on('message', data => { const m = JSON.parse(data.toString()); if (m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, cmd: (method, params = {}) => new Promise(done => { const id = ++next; waiting.set(id, done); ws.send(JSON.stringify({ id, method, params })); }), close: () => ws.close() };
}
const pages = async () => (await observer.cmd('Target.getTargets')).result.targetInfos.filter(t => t.type === 'page');
const boundsOf = async targetId => {
  const w = await observer.cmd('Browser.getWindowForTarget', { targetId });
  return w.result ? { windowId: w.result.windowId, ...w.result.bounds } : null;
};
const monitors = () => win32.monitors();
const onScreen = b => { const cx = b.left + b.width / 2, cy = b.top + b.height / 2; return monitors().some(m => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height); };

try {
  // 1. 「利用者の窓」を持つ Chrome（専用の User Data）
  spawnChrome(['--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--new-window', 'about:blank']);
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i += 1) await sleep(150);
  if (!fs.existsSync(portFile)) { console.log('skip: Chrome did not start'); process.exit(2); }
  const [port, browserPath] = fs.readFileSync(portFile, 'utf8').split('\n');
  observer = await cdpClient(`ws://127.0.0.1:${port.trim()}${browserPath.trim()}`);
  await sleep(1500);
  check('前提: 利用者の窓が画面の中にある', (await pages()).length > 0 && onScreen(await boundsOf((await pages())[0].targetId)));

  // 2. 会話の窓を作って隠す（本物の層・中継）
  const locate = { browser: 'chrome', userDataDir, custom: true };
  conn = createChromeConnection({ locate, os: layer, pollMs: 200 });
  relay = createChromeRelay({ connection: conn, os: layer, locate, deniedMessage: () => 'denied', log: line => logs.push(`relay: ${line}`), authorize: async () => ({ allow: true }) });
  await Promise.race([conn.demand({ consent: true }), sleep(20000).then(() => { throw new Error('Chrome connection timed out'); })]);
  agent = await cdpClient(await relay.endpoint('it'));
  await agent.cmd('Target.setDiscoverTargets', { discover: true });
  const created = await agent.cmd('Target.createTarget', { url: 'about:blank' });
  const agentTab = created.result?.targetId;
  check('専用窓を作れた', Boolean(agentTab), JSON.stringify(created));
  await sleep(1500);
  const agentBounds = agentTab ? await boundsOf(agentTab) : null;
  check('前提: 専用窓は隠れている（画面の外）', Boolean(agentBounds) && !onScreen(agentBounds), JSON.stringify(agentBounds));
  if (failures.length) throw new Error('precondition failed: no hidden window, so the URL step would pass vacuously');

  // 3. 外のアプリが URL を渡す（既存の Chrome のプロセスへ。last-active の窓に開く）
  const marker = `pleiad-it-${Date.now()}`;
  const url = `https://example.com/?${marker}`;
  spawnChrome([url]);
  let found = null, landedAt = null;
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    await sleep(300);
    const hits = (await pages()).filter(t => t.url.includes(marker));
    // 隠した窓に入ったタブは移して閉じるので、最後まで残る（閉じない）タブが見える窓にあることを見る
    const settled = [];
    for (const t of hits) { const b = await boundsOf(t.targetId); if (b) settled.push({ t, b }); }
    const visible = settled.find(x => x.b.windowId !== agentBounds?.windowId && onScreen(x.b));
    if (visible) { found = visible; if (!settled.some(x => !onScreen(x.b))) break; }
    landedAt = settled.map(x => x.b);
  }
  await sleep(1500);
  const final = [];
  for (const t of (await pages()).filter(x => x.url.includes(marker))) { const b = await boundsOf(t.targetId); if (b) final.push(b); }
  check('渡した URL のタブが、画面の中の窓にある', final.length > 0 && final.some(onScreen), JSON.stringify({ final, landedAt }));
  check('外の URL のタブが隠した窓に居ない（隠した窓の見えないタブとして残らない）', !final.some(b => b.windowId === agentBounds?.windowId || !onScreen(b)), JSON.stringify(final));
  check('専用窓のタブは残っている', (await pages()).some(t => t.targetId === agentTab));
  check('エージェントには外の URL を見せない', !(await agent.cmd('Target.getTargets')).result.targetInfos.some(t => t.url.includes(marker)));
} catch (error) {
  failures.push(`error: ${error?.message ?? error}`);
  console.log(`error: ${error?.stack ?? error}`);
} finally {
  try { agent?.close(); relay?.close(); await conn?.close(); } catch {}
  try { raw.closeAllAgents(); } catch {}
  try { await observer?.cmd('Browser.close'); } catch {}
  observer?.close();
  await sleep(1500);
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {}
  if (failures.length) { console.log('--- logs'); for (const line of logs.slice(-30)) console.log(line); }
}
console.log(failures.length ? `\n失敗 ${failures.length} 件` : '\n全て通過');
process.exit(failures.length ? 1 : 0);
