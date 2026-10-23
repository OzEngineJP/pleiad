// main の safeStorage が答えを返せない間（macOS でキーチェーンの確認を待っている）に起動したホストの接続口が、
// 再起動せずに戻ること（core/secret-store.mjs の parentPortCipher の onAvailable・core/remote/connector.mjs の retryLocked）。
// main の身代わりは「止まっている間の依頼をためて、動き出したらまとめて答える」口。実物の中継（relay/server.mjs）につなぐ。
// Electron も LLM も外のネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { parentPortCipher } from '../../core/secret-store.mjs';

const require = createRequire(import.meta.url);
const { createSecretHandler } = require('../../desktop/secret-bridge.cjs');

export const name = 'secret-pending-recover';
export const title = '秘密の暗号化が応答しない間に起動しても、答えた後に再起動なしでリモートがつながる';

const SECRET = crypto.randomBytes(32).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`);
    await sleep(40);
  }
}
function fakeSafeStorage() {
  const flip = s => Buffer.from(s, 'utf8').map(b => b ^ 0x5a);
  return {
    isEncryptionAvailable: () => true,
    encryptString: s => Buffer.concat([Buffer.from('v10'), flip(s)]),
    decryptString: b => { if (b.subarray(0, 3).toString() !== 'v10') throw new Error('bad'); return Buffer.from(flip(b.subarray(3).toString('utf8'))).toString('utf8'); },
  };
}
/** main の身代わり。frozen の間は依頼をためて答えず（キーチェーンの確認で main が止まっている）、thaw() でまとめて答える */
function mainPort(handle, { frozen = false } = {}) {
  const port = new EventEmitter();
  const held = [];
  const answer = message => setImmediate(() => port.emit('message', { data: handle(message) }));
  port.postMessage = message => { if (frozen) held.push(message); else answer(message); };
  port.thaw = () => { frozen = false; for (const m of held.splice(0)) answer(m); };
  port.held = held;
  return port;
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-secret-pending-')));
  const dataDir = path.join(scratch, 'data');
  const targetServer = http.createServer((q, s) => s.end('ok'));
  await new Promise(r => targetServer.listen(0, '127.0.0.1', r));
  const target = () => ({ host: '127.0.0.1', port: targetServer.address().port });
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const addr = await relay.listen(0, '127.0.0.1');
  const relayUrl = `http://127.0.0.1:${addr.port}`;
  const handle = createSecretHandler({ safeStorage: fakeSafeStorage(), platform: 'darwin' });
  const hosts = [];
  try {
    // 前の起動: 許可を入れ、登録用の秘密を暗号化して保存し、中継につながる
    const first = createRemoteHost({ dataDir, cipher: parentPortCipher(mainPort(handle)), target, token: 'tok', env: {}, backoff: { minMs: 60, maxMs: 300 }, log: () => {} });
    hosts.push(first);
    await first.setSettings({ relayUrl, enrollSecret: SECRET, enabled: true });
    await until(async () => (await first.status()).connection.state === 'connected', 5000, '前の起動の接続');
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'secrets.json'), 'utf8'));
    t.ok('前提: 登録用の秘密とホストの鍵は暗号化して保存されている', saved.entries.enrollSecret?.enc === 'safeStorage' && saved.entries.hostKey?.enc === 'safeStorage');
    first.stop();

    // 今の起動: main がキーチェーンの確認で止まっている間に始まる
    const port = mainPort(handle, { frozen: true });
    const cipher = parentPortCipher(port, { timeoutMs: 80 });
    const host = createRemoteHost({ dataDir, cipher, target, token: 'tok', env: {}, backoff: { minMs: 60, maxMs: 300 }, log: () => {} });
    hosts.push(host);
    let woke = 0;
    cipher.onAvailable(() => { woke++; host.retryLocked().catch(() => {}); });
    await host.start();
    const stuck = await host.status();
    t.ok('答えが来ない間は locked で止まり、理由に「応答しない」の文が載る', stuck.connection.state === 'error' && stuck.connection.error?.code === 'locked' && stuck.connection.error.message.length > 0, JSON.stringify(stuck.connection));
    t.ok('止まっている間も、保存した許可（enabled）と中継の URL は状態に出る（スイッチがオフに見えない）', stuck.enabled === true && stuck.relayUrl === relayUrl);
    t.ok('止まっている間の storage は「応答待ち」（pending）', stuck.storage?.pending === true && stuck.storage.encrypted === false, JSON.stringify(stuck.storage));
    t.ok('前提: main に依頼が届いてたまっている', port.held.length > 0);
    const started = Date.now();
    await host.status();
    await host.status();
    t.ok('止まっている間の状態の取得は、答えの待ちの上限まで待たない（画面のスイッチが押せないままにならない）', Date.now() - started < 80, `${Date.now() - started}ms`);

    // 確認に答えた: main が動き出し、ためていた依頼に遅れて答える
    port.thaw();
    await until(() => woke > 0, 2000, 'onAvailable の呼び出し');
    t.ok('遅れて届いた答えで onAvailable を 1 回だけ呼ぶ', woke === 1, String(woke));
    const back = await until(async () => { const s = await host.status(); return s.connection.state === 'connected' ? s : null; }, 5000, '再起動なしの接続');
    t.ok('再起動せずに中継につながる（locked が解ける）', back.connection.error == null && back.enabled === true);
    t.ok('つながった後の storage は暗号化済み', back.storage?.encrypted === true && !back.storage.pending, JSON.stringify(back.storage));
    t.ok('locked でなければ retryLocked は張り直さない', await host.retryLocked().then(() => true) && (await host.status()).connection.state === 'connected');

  } finally {
    for (const h of hosts) h.stop();
    await relay.close?.();
    await new Promise(r => targetServer.close(r));
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
