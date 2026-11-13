// Chrome の中継（core/chrome/relay.mjs）の試験の道具: 偽のエージェントの接続と、偽の Chrome の上の中継の組み立て。
// tests/unit/chrome-relay.mjs から分けた（ブラウザーの一本化の段が、自分の試験のファイルから同じ組み立てを使えるように）。
import { WebSocket } from 'ws';
import { startFakeChrome } from './fake-chrome.mjs';
import { fakeChromeOs } from './fake-chrome-os.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';

/** エージェントの側（agent-browser の代わり）。受けた生の文字列も全部残す（範囲の外の URL が漏れていないかを見る） */
export function agent(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const events = [], raw = [], waiting = new Map();
    let next = 0;
    ws.on('message', data => {
      const text = data.toString();
      raw.push(text);
      const msg = JSON.parse(text);
      if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
      else events.push(msg);
    });
    ws.once('open', () => resolve({
      ws, events, raw,
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      closed: new Promise(done => ws.once('close', (code, reason) => done({ code, reason: reason.toString() }))),
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}
export const refused = (url, options) => agent(url, options).then(client => { client.close(); return false; }, () => true);

/** 偽の Chrome・偽の OS の層・接続・中継をそろえる。hooks は中継の口の差し替え（createChromeRelay の hooks） */
export async function rig({ permission = 'auto', connectWaitMs, authorize, handoff, connectWaitText, downloadDeniedText, turnLive, turnSignal, hooks } = {}) {
  const chrome = await startFakeChrome({ permission });
  const os_ = fakeChromeOs({ chrome });
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: os_, pollMs: 20 });
  const logs = [];
  const asked = [];
  let answer = async () => ({ allow: true });
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true };
  const relay = createChromeRelay({ connection: conn, os: os_, locate, deniedMessage: () => 'DENIED-TEXT', log: line => logs.push(line), ...(connectWaitMs ? { connectWaitMs } : {}), ...(handoff ? { handoff } : {}), ...(connectWaitText ? { connectWaitText } : {}), ...(downloadDeniedText ? { downloadDeniedText } : {}), ...(turnLive ? { turnLive } : {}), ...(turnSignal ? { turnSignal } : {}), ...(hooks ? { hooks } : {}),
    authorize: authorize ?? (async (request, signal) => { asked.push(request); return answer(request, signal); }) });
  return {
    chrome, conn, relay, logs, asked, fake: chrome.browser, os: os_,
    answer: fn => { answer = fn; },
    async stop() { relay.close(); await conn.close(); await chrome.stop(); },
  };
}
