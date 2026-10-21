// 中継への制御用の接続の張り直し（core/remote/connector.mjs、docs/remote.md §6.4）。
// 張ってよい link は、どの失敗の仕方でも張り直しの予定が残り続けることを確かめる:
//   ・中継が落ちている / 接続を拒む（接続の先が居ない）
//   ・名前が引けない（DNS の失敗）
//   ・中継が shutdown を送って閉じる（中継の再起動）
//   ・Upgrade に 101 でない応答が返る（中継が立つ前に前段の逆プロキシが 502 などを返す。
//     ws はこのとき 'close' を出さないので、ホスト側で張り直しを予定しないと止まる）
//   ・provider の headers() が一時的に失敗する（plus の ID トークンの取り直しが届かないなど）
// LLM も外のネットワークも使わない（中継は実物をこのプロセスで立てる）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { plainCipher } from '../../core/secret-store.mjs';

export const name = 'remote-reconnect';
export const title = 'つながり（link）の張り直し: 拒否・DNS・shutdown・101 でない応答・headers の失敗でも張り直しが続く';

const SECRET = crypto.randomBytes(32).toString('base64url');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function within(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); }),
  ]);
}
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`);
    await sleep(40);
  }
}

async function startRelay(secret, port = 0) {
  const relay = createRelay({ enrollSecret: secret, trustProxy: false, logger: () => {} });
  const addr = await relay.listen(port, '127.0.0.1');
  return { relay, url: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

/** 止めたばかりのポートへ張り直すときに備えて、空くまで少し待って listen する。 */
async function startRelayOn(secret, port) {
  let last;
  for (let i = 0; i < 20; i++) {
    try { return await startRelay(secret, port); } catch (e) { last = e; await sleep(100); }
  }
  throw last;
}

/** 誰も待ち受けていないポートの番号を得る（listen してすぐ閉じる）。 */
async function closedPort() {
  const s = http.createServer((q, r) => r.end());
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}

/** 前段の逆プロキシの身代わり。Upgrade に 101 でない応答（既定 502）を返すか、応答せず接続を切る（'drop'）。 */
async function startBrokenGate() {
  const state = { status: 502 };
  const sockets = new Set();
  const server = http.createServer((q, s) => { s.writeHead(500); s.end(); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (state.status === 'drop') return socket.destroy();
    try { socket.end(`HTTP/1.1 ${state.status} ${http.STATUS_CODES[state.status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
    catch { /* 既に切れている */ }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

/** 張り直しの予定（status().links.<name>.retryAt）が n 回新しくなるまで待ち、観測した回数を返す。 */
async function retryAtMoves(host, linkName, n, ms) {
  const seen = new Set();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const l = (await host.status()).links[linkName];
    if (l.retryAt) seen.add(l.retryAt);
    if (seen.size >= n) break;
    await sleep(30);
  }
  return seen.size;
}

const ownState = async host => (await host.status()).links.own;

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-reconnect-')));
  const dataDir = path.join(scratch, 'data');
  const targetServer = http.createServer((q, s) => s.end('ok'));
  await new Promise(r => targetServer.listen(0, '127.0.0.1', r));
  const target = () => ({ host: '127.0.0.1', port: targetServer.address().port });
  const host = createRemoteHost({ dataDir, cipher: plainCipher, target, token: 'tok', env: {}, backoff: { minMs: 50, maxMs: 250 }, log: () => {} });
  let relay = null;
  let relay2 = null;
  let gate = null;
  try {
    // ---- 中継が居ない（接続を拒む）ところへ向けても、張り直しが続く
    const port = await closedPort();
    await host.setSettings({ relayUrl: `http://127.0.0.1:${port}`, enrollSecret: SECRET, enabled: true, hostName: 'reconnect-test' });
    await until(async () => (await ownState(host)).state === 'retrying', 10_000, '拒否されて retrying になる');
    t.ok('接続を拒む中継へは張り直しが続く', await retryAtMoves(host, 'own', 2, 10_000) >= 2, 'retryAt が動き続ける');

    // ---- 中継が立つとつながる
    relay = await within(startRelayOn(SECRET, port), 10_000, '中継の起動');
    await until(async () => (await ownState(host)).state === 'connected', 10_000, '中継が立つとつながる');

    // ---- 中継が shutdown（1001）を送って閉じる（中継の再起動）。張り直しが続き、戻るとつながる
    await within(relay.relay.close(), 10_000, '中継を止める');
    relay = null;
    await until(async () => (await ownState(host)).state === 'retrying', 10_000, 'shutdown で retrying になる');
    t.ok('shutdown を送って閉じたあとも張り直しが続く', await retryAtMoves(host, 'own', 2, 10_000) >= 2, 'retryAt が動き続ける');
    relay = await within(startRelayOn(SECRET, port), 10_000, '中継の立て直し');
    await until(async () => (await ownState(host)).state === 'connected', 10_000, '中継が戻るとつながる');

    // ---- Upgrade に 101 でない応答（前段が中継の代わりに 502 を返す）。それでも張り直しが続く
    gate = await startBrokenGate();
    await host.setSettings({ relayUrl: gate.url });
    const moved502 = await retryAtMoves(host, 'own', 2, 10_000);
    t.ok('Upgrade に 101 でない応答（前段の 502）でも張り直しが続く', moved502 >= 2, `retryAt の更新 ${moved502} 回`);
    const s502 = await host.status();
    t.ok('101 でない応答は link のエラーに残る（HTTP の状態が分かる）', /502/.test(s502.links.own.error?.message ?? ''), JSON.stringify(s502.links.own.error));
    // 応答が変われば次の張り直しで別のエラーになる（新しい試みが動き続けている証拠）
    gate.state.status = 429;
    const s429 = await until(async () => {
      const l = (await host.status()).links.own;
      return /一時的に接続を止め/.test(l.error?.message ?? '') ? l : null;
    }, 10_000, '429 のエラーに変わる');
    t.ok('張り直しごとに新しい応答のエラーが載る', s429.state === 'retrying', JSON.stringify(s429));
    // 前段が応答すら返さず切るだけでも同じ
    gate.state.status = 'drop';
    t.ok('前段が応答せず切るだけでも張り直しが続く', await retryAtMoves(host, 'own', 2, 10_000) >= 2, 'retryAt が動き続ける');

    // ---- 前段が直れば（中継が戻れば）つながる
    await host.setSettings({ relayUrl: relay.url });
    await until(async () => (await ownState(host)).state === 'connected', 10_000, '中継へ向け直すとつながる');

    // ---- 名前が引けない（DNS の失敗）でも張り直しが続き、直るとつながる
    await host.setSettings({ relayUrl: 'wss://no-such-host.invalid' });
    t.ok('名前が引けない中継へも張り直しが続く', await retryAtMoves(host, 'own', 2, 15_000) >= 2, 'retryAt が動き続ける');
    await host.setSettings({ relayUrl: relay.url });
    await until(async () => (await ownState(host)).state === 'connected', 10_000, '名前が直るとつながる');

    // ---- plus の link: headers() が一時的に失敗しても張り直しが続く（ID トークンの取り直しが届かないなど）
    // （同じ hostId の制御用の接続を中継は 1 本だけ許すので、plus の行き先は別の中継にする）
    relay2 = await within(startRelay(SECRET, 0), 10_000, 'plus 用の中継の起動');
    let headersOk = false;
    let headerCalls = 0;
    await host.setPlusProvider({
      name: 'plus',
      ready: () => true,
      url: p => `${relay2.url.replace(/^http/, 'ws')}${p}`,
      headers: async () => {
        headerCalls++;
        if (!headersOk) throw new Error('temporary token failure');
        return { authorization: `Bearer ${SECRET}`, 'x-pleiad-host': (await host.store.identity()).hostId };
      },
      owns: () => false,
      allowPairing: false,
    });
    const sHeaders = await until(async () => {
      const l = (await host.status()).links.plus;
      return l.state === 'retrying' && headerCalls >= 3 ? l : null;
    }, 10_000, 'headers() の失敗でも張り直しが続く（3 回以上試す）');
    t.ok('headers() の一時的な失敗で link が error に停まらない', sHeaders.state === 'retrying', JSON.stringify(sHeaders));
    headersOk = true;
    await until(async () => (await host.status()).links.plus.state === 'connected', 10_000, 'headers() が直ると plus がつながる');
    t.ok('own は終始 connected のまま', (await ownState(host)).state === 'connected');
  } finally {
    host.stop();
    if (relay) await relay.relay.close().catch(() => {});
    if (relay2) await relay2.relay.close().catch(() => {});
    if (gate) await gate.close().catch(() => {});
    await new Promise(r => targetServer.close(r));
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
