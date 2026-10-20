// 設定 › Pleiad Plus のブラウザー試験（tests/browser/plus-settings.mjs）だけで使うサーバーの入口。
// main（Electron）が居るふりをして、open-external に届く URL（ログインのページなど）を PLUS_EXTERNAL_CAPTURE のファイルに記録する。
// 秘密の暗号の状態の問い合わせには「使えない（平文）」と答える（main の代わり。core/secret-store.mjs の parentPortCipher）。
import fs from 'node:fs';
import { setMainPortSource } from '../../core/main-port.mjs';

const capture = process.env.PLUS_EXTERNAL_CAPTURE;
const listeners = new Map(); // type -> Set<fn>
const reply = data => { for (const fn of listeners.get('message') ?? []) fn({ data }); };

setMainPortSource({
  connected: true,
  on(type, fn) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn); },
  off(type, fn) { listeners.get(type)?.delete(fn); },
  postMessage(msg) {
    if (msg?.type === 'open-external' && capture) { try { fs.appendFileSync(capture, `${msg.url}\n`); } catch {} }
    if (msg?.type === 'secret') queueMicrotask(() => reply({ type: 'secret', id: msg.id, ok: true, value: msg.op === 'status' ? { available: false, backend: 'test', reason: 'test' } : msg.value }));
    return true;
  },
});
await import('../../core/server.mjs');
