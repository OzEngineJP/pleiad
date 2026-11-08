import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';

export const name = 'server-browser-handback';
export const title = 'hand_to_user → 人が触ったタブ → chromeResume（サーバー越し）: 依頼のカード・「あなたが操作中」・人のタブを全部 AI に戻す releaseAll・待ちの決着（偽の Chrome・fake バックエンド。ADR 0148・0296）';

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

/** エージェントの側（agent-browser の代わり。server-chrome-screencast.mjs と同じ形） */
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

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-handback-'));
  const entry = path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs');
  const chrome = await startFakeChrome({ permission: 'auto' });
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir }, dataDir, entry });
  let c, a;
  try {
    c = await open({ port: server.port, token: server.token });
    await c.cmd('chromeConnect');
    t.ok('隔離した Chrome 接続を明示して、サーバーが接続する', await until(() => c.events.some(e => e.type === 'chromeBrowser' && e.state === 'connected'), 20000, 'chromeBrowser connected'));

    // hand_to_user を呼ぶターン。ツールは待ちに入るので runTurn は返さない
    const prompt = `browser:[{"name":"hand_to_user","arguments":{"reason":"login","message":"ログインしてください"}}]`;
    const from = c.mark();
    const turn = c.cmd('runTurn', { backend: 'fake', cwd: dataDir, prompt }).catch(() => null);
    const session = await c.waitFor(e => e.type === 'session' && e.sessionId, { from, ms: 20000 });
    const id = session.sessionId;
    // 依頼のカードが出る（outlivesTurn の browserHandoff。tool.start は mcp__ply_browser__hand_to_user）
    const asked = await c.waitFor(e => e.type === 'permission' && e.browserHandoff?.state === 'asked', { from, ms: 20000 });
    t.ok('hand_to_user の依頼のカード（種類・頼まれた本文）', asked.browserHandoff.reason === 'login' && asked.browserHandoff.message === 'ログインしてください', JSON.stringify(asked.browserHandoff));
    t.ok('ツールの呼び出しは ply_browser の hand_to_user', c.events.some(e => e.type === 'tool.start' && e.name === 'mcp__ply_browser__hand_to_user'), JSON.stringify(c.events.filter(e => e.type === 'tool.start').map(e => e.name)));

    // エージェントが窓を開く（agent-browser の中継。タブはこの会話のものになる）
    const cdpUrl = await until(async () => {
      const root = path.join(dataDir, 'agent-browser');
      for (const d of await fs.readdir(root).catch(() => [])) {
        const text = await fs.readFile(path.join(root, d, 'agent-browser.json'), 'utf8').catch(() => null);
        if (text) return JSON.parse(text).cdp;
      }
      return null;
    }, 20000, 'agent-browser config');
    a = await agent(cdpUrl);
    const first = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
    t.ok('エージェントが 1 枚目のタブを開いた', !!first && (await until(() => c.events.some(e => e.type === 'chromeWindow' && e.sessionId === id && e.windows > 0), 10000, 'chromeWindow')));

    // 人が映像に触れる（この端末で操作する）。タブの持ち手が人になり、カードは「あなたが操作中」へ
    const watch = await c.cmd('browserScreencast', { sessionId: id, source: 'chrome', width: 400, height: 300, device: 'phone' });
    t.ok('ホストの画面から映像を見始められる', typeof watch.tabId === 'string', JSON.stringify(watch));
    await until(() => chrome.browser.screencasting(first), 10000, 'screencasting');
    const tap = await c.cmd('browserScreencastInput', { sessionId: id, source: 'chrome', tabId: watch.tabId, input: { type: 'tap', x: 3, y: 3 } });
    t.ok('映像への入力を受ける', tap?.ok !== false, JSON.stringify(tap));
    const operating = await c.waitFor(e => e.type === 'permissionUpdate' && e.browserHandoff?.state === 'operating', { from, ms: 10000 });
    t.ok('人が触ったらカードは「あなたが操作中」（端末・映像からなので by: device）', operating.browserHandoff.by === 'device', JSON.stringify(operating.browserHandoff));
    const attachedFirst = await a.cmd('Target.attachToTarget', { targetId: first, flatten: true });
    const blockedFirst = await a.cmd('Page.navigate', { url: 'https://example.invalid/' }, attachedFirst.result?.sessionId);
    t.ok('人が操作中のタブへエージェントのページ操作は通らない', Boolean(blockedFirst.error), JSON.stringify(blockedFirst));

    // 2 枚目のタブも人が触る（別のタブを見ていても、戻す入口は会話のもの）
    const second = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
    t.ok('エージェントが 2 枚目のタブを開いた', !!second);
    await c.cmd('chromePinWindow', { sessionId: id, windowId: null, tabId: second });
    await until(() => chrome.browser.screencasting(second), 10000, 'screencast second');
    await c.cmd('browserScreencastInput', { sessionId: id, source: 'chrome', tabId: second, input: { type: 'tap', x: 4, y: 4 } });
    const attachedSecond = await a.cmd('Target.attachToTarget', { targetId: second, flatten: true });
    const blockedSecond = await a.cmd('Page.navigate', { url: 'https://example.invalid/second' }, attachedSecond.result?.sessionId);
    t.ok('別のタブを表示して人が触っても、そのタブもエージェントのページ操作から保護される', Boolean(blockedSecond.error), JSON.stringify(blockedSecond));

    // 「AI に戻す」（chromeResume）: 人の操作のタブを全部 AI に戻し、hand_to_user の待ちを決着させる
    const resume = await c.cmd('chromeResume', { sessionId: id });
    t.ok('chromeResume は今の状態（ターンの最中なので running）を返す', resume?.state === 'running' || resume?.state === 'idle', JSON.stringify(resume));
    const settled = await c.waitFor(e => e.type === 'permissionSettled' && e.id === asked.id, { from, ms: 10000 });
    t.ok('戻すと複数の人のタブが全部 AI に戻り、依頼のカードが決着する', settled.allow === true, JSON.stringify(settled));
    const refreshFirst = await a.cmd('Page.navigate', { url: 'https://example.invalid/returned-first' }, attachedFirst.result?.sessionId);
    const refreshSecond = await a.cmd('Page.navigate', { url: 'https://example.invalid/returned-second' }, attachedSecond.result?.sessionId);
    const resumedFirst = await a.cmd('Page.navigate', { url: 'https://example.invalid/returned-first' }, attachedFirst.result?.sessionId);
    const resumedSecond = await a.cmd('Page.navigate', { url: 'https://example.invalid/returned-second' }, attachedSecond.result?.sessionId);
    t.ok('戻した後は、両方のタブで安全策の snapshot 撮り直しを 1 回求め、その後は操作できる',
      refreshFirst.error?.message?.includes('snapshot') && refreshSecond.error?.message?.includes('snapshot') && !resumedFirst.error && !resumedSecond.error,
      JSON.stringify([refreshFirst, refreshSecond, resumedFirst, resumedSecond]));
    const result = await c.waitFor(e => e.type === 'tool.result' && /戻しました/.test(e.text ?? ''), { from, ms: 20000 });
    t.ok('hand_to_user は「人が操作を終えて戻しました」を返す', result.text.includes('人が操作を終えて戻しました'), result.text?.slice(0, 80));
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === id, { from, ms: 20000 });
    t.ok('ターンはそのまま終わる（エージェントは続けられる）', true);
    await turn;
  } finally {
    a?.close(); c?.close();
    await server.stop();
    await cleanupTestHolder(dataDir);
    await chrome.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
