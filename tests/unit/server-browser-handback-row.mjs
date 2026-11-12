// hand_to_user → 人が触ったタブ → ブラウザーの枠の「AI に戻す」（サーバー越し・実の web/browser-unify.mjs）。
// server-browser-handback.mjs のカードと同じ結合を、残りの 2 つの入口で確かめる:
//   - PC: 右の欄のブラウザーのアドレスバーの下に出る札（paintControl は会話のどのタブが人のものでも出す。ADR 0296）
//   - スマホ: 全画面のブラウザーのアドレスバーのすぐ下の 1 行（人のタブを開いている間だけ。承認済み 2026-11-08）
// どちらも同じ createControlBadge（.b2-control）で、実の配線は browser-unify の onResume → chromeResume。
// サーバーの便り（tab:info・tab:holder）は watchSession の本物の流れで ui.onEvent へ流す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';
import { N } from '../lib/dom-stub.mjs';
import { createBrowserUnify } from '../../web/browser-unify.mjs';
import { createChromeControlStore } from '../../web/chrome-control.mjs';

export const name = 'server-browser-handback-row';
export const title = 'hand_to_user → 人が触ったタブ → ブラウザーの枠の「AI に戻す」（サーバー越し・実の browser-unify）: PC の右の欄の札・スマホのアドレスバーの下の 1 行 → chromeResume → 待ちの決着（偽の Chrome・fake バックエンド。ADR 0296）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (cond, ms = 10000, what = '') => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await cond();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(20);
  }
};

/** エージェントの側（agent-browser の代わり。server-browser-handback.mjs と同じ形） */
function agent(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let next = 0;
    ws.on('message', data => { const msg = JSON.parse(data.toString()); if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } });
    ws.once('open', () => resolve({
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}

/** web/browser-unify.mjs が触る面を dom-stub（document.createElement だけ）へ足す。同じ worker のほかの suite へ残さないよう元に戻す */
function browserEnv(phone) {
  const doc = globalThis.document;
  const restore = [];
  const put = (obj, key, value) => { restore.push([obj, key, obj[key]]); obj[key] = value; };
  put(doc, 'head', new N('head'));
  put(doc, 'body', new N('body'));
  put(doc, 'getElementById', () => null);
  put(doc, 'querySelector', () => null);
  put(doc, 'querySelectorAll', () => []);
  put(doc, 'addEventListener', () => {});
  put(doc, 'removeEventListener', () => {});
  put(doc, 'dispatchEvent', () => true);
  put(doc, 'createTextNode', text => ({ textContent: String(text), outerHTML: String(text), shown: String(text), children: [], parent: null, dataset: {}, remove() {} }));
  put(globalThis, 'window', { addEventListener() {}, removeEventListener() {} });
  put(globalThis, 'ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  put(globalThis, 'CustomEvent', class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init?.detail ?? null; } });
  put(globalThis, 'matchMedia', query => ({ matches: phone, media: query, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  return () => { for (const [obj, key, value] of restore) obj[key] = value; };
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-handback-row-'));
  const entry = path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs');
  const chrome = await startFakeChrome({ permission: 'auto' });
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir }, dataDir, entry });
  const controlStore = createChromeControlStore();
  let c, a, ui = null;
  try {
    c = await open({ port: server.port, token: server.token,
      // 画面（web/client.mjs）と同じく、サーバーの便りはそのまま置き場と browser-unify へ流す
      onEvent: ev => { try { controlStore.event(ev); ui?.onEvent(ev); } catch { /* 便りの形はサーバーの管轄 */ } } });
    await c.cmd('chromeConnect');
    t.ok('隔離した Chrome 接続を明示して、サーバーが接続する', await until(() => c.events.some(e => e.type === 'chromeBrowser' && e.state === 'connected'), 20000, 'chromeBrowser connected'));

    for (const variant of ['pc', 'phone']) {
      const phone = variant === 'phone';
      const restoreEnv = browserEnv(phone);
      try {
        // hand_to_user を呼ぶターン。ツールは待ちに入るので runTurn は返さない
        const prompt = `browser:[{"name":"hand_to_user","arguments":{"reason":"login","message":"ログインしてください"}}]`;
        const from = c.mark();
        // この会話の agent-browser の置き場だけを拾うよう、ターンの前に居る分を覚えておく（hand_to_user が立てるので早く現れる）
        const root = path.join(dataDir, 'agent-browser');
        const known = new Set(await fs.readdir(root).catch(() => []));
        const turn = c.cmd('runTurn', { backend: 'fake', cwd: dataDir, prompt }).catch(() => null);
        const session = await c.waitFor(e => e.type === 'session' && e.sessionId, { from, ms: 20000 });
        const id = session.sessionId;
        const asked = await c.waitFor(e => e.type === 'permission' && e.browserHandoff?.state === 'asked', { from, ms: 20000 });
        t.ok(`${variant}: hand_to_user の依頼が出る`, asked.browserHandoff.reason === 'login', JSON.stringify(asked.browserHandoff));

        // エージェントの中継（この会話の agent-browser）の口を拾う
        const cdpUrl = await until(async () => {
          for (const d of await fs.readdir(root).catch(() => [])) {
            if (known.has(d)) continue;
            const text = await fs.readFile(path.join(root, d, 'agent-browser.json'), 'utf8').catch(() => null);
            if (text) return JSON.parse(text).cdp;
          }
          return null;
        }, 20000, 'agent-browser config');
        a?.close();
        a = await agent(cdpUrl);

        // 人の操作になるタブと、見ているだけの別のタブ（スマホは別のタブを見ている間は行を出さない）
        // 後に開いたほうがエージェントのタブ（AI のタブ）。人が引き継ぐ（[引き継ぐ]）タブは後のほう
        const other = phone ? (await a.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId : null;
        const held = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;

        // 実の browser-unify を、サーバーへの本物の cmd と本物の便りで組み立てる。
        // chrome() は画面の枠（右の欄・全画面のブラウザー）の代わり。mountBrowserChrome には根を渡す
        const fixture = { sessionId: id, tabId: other ?? held, opened: false, mounted: null,
          isOpen() { return this.opened; }, open() { this.opened = true; }, close() { this.opened = false; },
          mountBrowserChrome(root) { this.mounted = root; },
          onOpenChange() {}, onTargetChange() {}, onTabChange() {} };
        const commands = [];
        ui = createBrowserUnify({ state: { current: id, cwd: dataDir }, chrome: () => fixture,
          controlStore, notify: () => {}, showMenu: () => {},
          cmd: (name, args) => { commands.push([name, args]); return c.cmd(name, args); } });
        ui.capsChanged({ browserUnify: true });
        // capsChanged → watchSession（本物）→ tab:info の reset が便りとして返る
        t.ok(`${variant}: watchSession はブラウザーの枠の側から出る`, await until(() => commands.some(([name]) => name === 'watchSession'), 5000, 'watchSession'));
        await until(() => ui.tabsOf(id).length >= (phone ? 2 : 1), 10000, 'tab:info reset');

        // 人が映像に触れる → タブの持ち手が人に（tab:holder の便りが枠へ届く）。
        // 見るタブは pin で決める（browserScreencast の tabId は start には乗らない。server-browser-handback.mjs と同じ手順）
        await c.cmd('browserScreencast', { sessionId: id, source: 'chrome', width: 400, height: 300, ...(phone ? { device: 'phone' } : {}) });
        await c.cmd('chromePinWindow', { sessionId: id, windowId: null, tabId: held });
        await until(() => chrome.browser.screencasting(held), 10000, 'screencasting');
        // AI のタブの映像は見るだけ（ADR 0320）。[引き継ぐ]（chromeTakeOver by: screen）を押してから触れる
        const refused = await c.cmd('browserScreencastInput', { sessionId: id, source: 'chrome', tabId: held, input: { type: 'tap', x: 3, y: 3 } }).then(() => null, error => error?.code);
        t.ok(`${variant}: 引き継ぐ前の AI のタブの映像への入力はサーバーが断る`, refused === 'view-only', String(refused));
        await c.cmd('chromeTakeOver', { sessionId: id, by: 'screen', tabId: held });
        await c.cmd('browserScreencastInput', { sessionId: id, source: 'chrome', tabId: held, input: { type: 'tap', x: 3, y: 3 } });
        await c.waitFor(e => e.type === 'permissionUpdate' && e.browserHandoff?.state === 'operating', { from, ms: 10000 });
        await until(() => fixture.mounted?.querySelector('.b2-control'), 10000, 'badge row');

        const row = () => fixture.mounted.querySelector('.b2-control');
        const action = () => row()?.querySelector('.b2-action');
        if (phone) {
          // 別のタブを見ている間は 1 行は出ない（見ているタブが人のものの間だけ。承認済み 2026-11-08）
          t.ok('phone: 人でないタブを見ている間は「AI に戻す」の行は出ない', row()?.hidden === true, `hidden=${row()?.hidden}`);
          // 頭の行の [N] の入口（openEntry）は人のタブを先に開く → chromePinWindow（本物）が出る
          await ui.openEntry(id);
          await until(() => commands.some(([name, args]) => name === 'chromePinWindow' && args?.tabId === held), 5000, 'chromePinWindow');
        }
        await until(() => row()?.hidden === false, 10000, 'badge row visible');
        t.ok(`${variant}: 「II あなたが操作中 [AI に戻す]」の 1 行が出る`,
          row()?.querySelector('.b2-pause') !== null && row()?.querySelector('.b2-grow') !== null && action()?.textContent === 'AI に戻す', row()?.outerHTML);

        // 実のボタンを押す → browser-unify の onResume → 本物の chromeResume
        const before = commands.length;
        await action().click();
        t.ok(`${variant}: 「AI に戻す」のクリックは実サーバーの chromeResume を呼ぶ`,
          commands.slice(before).length === 1 && commands.at(-1)[0] === 'chromeResume' && commands.at(-1)[1].sessionId === id, JSON.stringify(commands.slice(before)));
        const settled = await c.waitFor(e => e.type === 'permissionSettled' && e.id === asked.id, { from, ms: 10000 });
        t.ok(`${variant}: 戻すと hand_to_user の待ちが決着する`, settled.allow === true, JSON.stringify(settled));
        const result = await c.waitFor(e => e.type === 'tool.result' && /戻しました/.test(e.text ?? ''), { from, ms: 20000 });
        t.ok(`${variant}: hand_to_user は「人が操作を終えて戻しました」を返す`, result.text.includes('人が操作を終えて戻しました'), result.text?.slice(0, 80));
        await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === id, { from, ms: 20000 });
        t.ok(`${variant}: ターンはそのまま終わる（エージェントは続けられる）`, true);
        await turn;
      } finally {
        ui = null;
        restoreEnv();
      }
    }
  } finally {
    a?.close(); c?.close();
    await server.stop();
    await cleanupTestHolder(dataDir);
    await chrome.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
