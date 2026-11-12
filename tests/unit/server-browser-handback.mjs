import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';
import { browserHandoffView } from '../../web/browser-handoff-card.mjs';

export const name = 'server-browser-handback';
export const title = 'hand_to_user → 人が触ったタブ → chromeResume（サーバー越し）: 依頼のカード・「あなたが操作中」・人のタブを全部 AI に戻す releaseAll・待ちの決着（偽の Chrome・fake バックエンド。ADR 0148・0296）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const require = createRequire(import.meta.url);
const cardElement = (tag, className = null, textContent = '') => ({ tag, className, textContent, children:[], disabled:false,
  append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
  setAttribute() {}, removeAttribute() {}, click() { return this.onclick?.(); } });
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
    // AI のタブの映像は見るだけ（ADR 0320）。[引き継ぐ]（chromeTakeOver by: screen。スマホは映像の箱の大きさを添える）を押してから触れる
    const refused = await c.cmd('browserScreencastInput', { sessionId: id, source: 'chrome', tabId: watch.tabId, input: { type: 'tap', x: 3, y: 3 } }).then(() => null, error => error?.code);
    t.ok('引き継ぐ前の AI のタブへの入力は断る（人の操作に数えない）', refused === 'view-only', String(refused));
    await c.cmd('chromeTakeOver', { sessionId: id, by: 'screen', width: 400, height: 300, scale: 1 });
    const tap = await c.cmd('browserScreencastInput', { sessionId: id, source: 'chrome', tabId: watch.tabId, input: { type: 'tap', x: 3, y: 3 } });
    t.ok('引き継いだあとは映像への入力を受ける', tap?.ok !== false, JSON.stringify(tap));
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
    await c.cmd('chromeTakeOver', { sessionId: id, by: 'screen', width: 400, height: 300, scale: 1 });   // 2 枚目が AI のタブ。引き継いでから触れる
    await c.cmd('browserScreencastInput', { sessionId: id, source: 'chrome', tabId: second, input: { type: 'tap', x: 4, y: 4 } });
    const attachedSecond = await a.cmd('Target.attachToTarget', { targetId: second, flatten: true });
    const blockedSecond = await a.cmd('Page.navigate', { url: 'https://example.invalid/second' }, attachedSecond.result?.sessionId);
    t.ok('別のタブを表示して人が触っても、そのタブもエージェントのページ操作から保護される', Boolean(blockedSecond.error), JSON.stringify(blockedSecond));

    // 「AI に戻す」（chromeResume）: 人の操作のタブを全部 AI に戻し、hand_to_user の待ちを決着させる
    const cardCommands = [];
    if (process.env.SERVER_BROWSER_HANDBACK_BROWSER === '1') {
      const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
      const cardSource = await fs.readFile(path.join(ROOT, 'web', 'browser-handoff-card.mjs'), 'utf8');
      const cardServer = http.createServer(async (req, res) => {
        if (req.url === '/browser-handoff-card.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(cardSource); return; }
        if (req.url === '/cmd' && req.method === 'POST') {
          const parts = [];
          for await (const part of req) parts.push(part);
          const { name, args } = JSON.parse(Buffer.concat(parts).toString('utf8'));
          cardCommands.push([name, args]);
          try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await c.cmd(name, args))); }
          catch (error) { res.writeHead(500); res.end(JSON.stringify({ message:error.message })); }
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<main id="card"></main><script type="module">
          import { browserHandoffView } from '/browser-handoff-card.mjs';
          const el=(tag,cls,text='')=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node};
          const t=key=>key==='tabs:display.resume'?'AI に戻す':key==='chat.browserHandoff.operating'?'あなたが操作中':key;
          const view=browserHandoffView({id:${JSON.stringify(asked.id)},sessionId:${JSON.stringify(id)},browserHandoff:{...${JSON.stringify(asked.browserHandoff)},state:'operating',by:'pc'}},{el,t,cmd:async(name,args)=>{const response=await fetch('/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})});if(!response.ok)throw new Error('command failed');return response.json()}});
          document.querySelector('#card').append(view.body,...view.buttons);
        </script>`);
      });
      await new Promise(resolve => cardServer.listen(0, '127.0.0.1', resolve));
      let browser;
      try {
        browser = await chromium.launch({ headless:true, ...(process.env.PW_CHROMIUM ? { executablePath:process.env.PW_CHROMIUM } : {}) });
        const page = await browser.newPage({ viewport:{width:1280,height:720} });
        await page.goto(`http://127.0.0.1:${cardServer.address().port}/`);
        await page.getByRole('button', { name:'AI に戻す' }).click();
      } finally {
        await browser?.close();
        await new Promise(resolve => cardServer.close(resolve));
      }
    } else {
      const card = browserHandoffView({ id:asked.id, sessionId:id, browserHandoff: { ...asked.browserHandoff, state:'operating', by:'pc' } }, {
        el:cardElement, t:key => key === 'tabs:display.resume' ? 'AI に戻す' : key === 'chat.browserHandoff.operating' ? 'あなたが操作中' : key,
        cmd:(name, args) => { cardCommands.push([name, args]); return c.cmd(name, args); },
      });
      await card.buttons.at(-1).click();
    }
    t.ok('カードのボタン操作は実サーバーの chromeResume を呼ぶ', cardCommands.length === 1 && cardCommands[0][0] === 'chromeResume' && cardCommands[0][1].sessionId === id, JSON.stringify(cardCommands));
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
