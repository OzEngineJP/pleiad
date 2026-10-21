// ホストの接続口の「つながり（link）」（core/remote/connector.mjs、docs/remote.md §6.4）。
// 自分の中継（own）と差し込みの provider の中継（plus）の 2 本を、実物の中継（relay/server.mjs）2 台と、
// incoming を試験から差し込む偽の中継で確かめる。LLM も外のネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { plainCipher } from '../../core/secret-store.mjs';
import { generateKeyPair } from '../../core/remote/noise.mjs';
import { connectDevice } from '../lib/remote-device.mjs';

export const name = 'remote-conn-links';
export const title = 'つながり（link）: own と plus を同時に張る・片方の障害でもう片方は動く・via で端末を分ける・provider の差し込み口';

const SECRET = crypto.randomBytes(32).toString('base64url');
const SECRET2 = crypto.randomBytes(32).toString('base64url');

const rejects = p => p.then(() => null, e => e);
function within(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); }),
  ]);
}
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

async function startRelay(secret, port = 0) {
  const relay = createRelay({ enrollSecret: secret, trustProxy: false, logger: () => {} });
  const addr = await relay.listen(port, '127.0.0.1');
  return { relay, url: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

/** devices.json の 1 件を直接作る（ペアリングを通さず、via ごとの振り分けだけを見るため）。 */
function deviceRecord({ name, via } = {}) {
  const keyPair = generateKeyPair();
  const token = crypto.randomBytes(32);
  return {
    keyPair,
    token: token.toString('base64url'),
    record: {
      id: `d${crypto.randomBytes(12).toString('base64url')}`,
      name: name ?? 'test device', platform: 'android', app: 'test',
      publicKey: keyPair.publicKey.toString('base64url'),
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      createdAt: new Date().toISOString(), lastSeenAt: null,
      ...(via ? { via } : {}),
      // via:'plus' は PC の画面で許可した端末として置く（approvedBy の無い plus は、もう一度の許可が済むまで通らない）
      ...(via === 'plus' ? { approvedBy: 'host', approvedAt: new Date().toISOString() } : {}),
    },
  };
}

/**
 * incoming を試験から差し込む偽の中継。/v1/host の制御用の接続を受けて届いた制御メッセージを記録し、
 * inject() で送った conn への /v1/host/accept を受ける（返すのは { ws, closed }）。端末側（/v1/device）は持たない。
 */
async function startFakeRelay() {
  const server = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  const wss = new WebSocketServer({ noServer: true });
  let control = null;
  const controlClosed = [];          // 閉じた制御用の接続の close code
  const received = [];               // 制御用の接続へ届いたメッセージ
  const acceptWaiters = new Map();   // conn → (ws) => void
  server.on('upgrade', (req, socket, head) => {
    let u;
    try { u = new URL(req.url, 'http://fake-relay'); } catch { return socket.destroy(); }
    if (u.pathname !== '/v1/host' && u.pathname !== '/v1/host/accept') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      if (u.pathname === '/v1/host') {
        control = ws;
        ws.on('message', d => { try { received.push(JSON.parse(d.toString())); } catch { /* 形の誤りは捨てる */ } });
        ws.on('close', code => { if (control === ws) control = null; controlClosed.push(code); });
      } else {
        const conn = u.searchParams.get('conn') ?? '';
        const w = acceptWaiters.get(conn);
        if (!w) return ws.close(4404);
        acceptWaiters.delete(conn);
        w(ws);
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    received,
    controlClosed,
    hasControl: () => control !== null,
    /** incoming を差し込み、ホストが張った accept の ws（と close の promise）を返す。 */
    inject(fields, ms = 8000) {
      const conn = `c${crypto.randomBytes(6).toString('base64url')}`;
      const accept = new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`accept ${conn} が来ない`)), ms);
        acceptWaiters.set(conn, ws => {
          clearTimeout(t);
          res({ ws, closed: new Promise(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() }))) });
        });
      });
      control.send(JSON.stringify({ type: 'incoming', conn, ...fields }));
      return accept;
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      return new Promise(r => server.close(r));
    },
  };
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-links-')));
  const dataDir = path.join(scratch, 'data');
  const targetServer = http.createServer((q, s) => s.end('ok'));
  await new Promise(r => targetServer.listen(0, '127.0.0.1', r));
  const target = () => ({ host: '127.0.0.1', port: targetServer.address().port });
  const host = createRemoteHost({ dataDir, cipher: plainCipher, target, token: 'tok', env: {}, backoff: { minMs: 60, maxMs: 300 }, log: () => {} });
  const live = [];
  const fakes = [];
  const r1 = await within(startRelay(SECRET), 5000, 'own の中継の起動');
  let plus2 = await within(startRelay(SECRET2), 5000, 'plus の中継の起動');
  const url1 = r1.url;

  // plus 側の provider（URL・ヘッダー・引き受ける端末を差し込む口。中身は別 issue が入れる）
  const plusProvider = (url, extra = {}) => ({
    name: 'plus',
    ready: () => true,
    url: p => `${url.replace(/^http/, 'ws')}${p}`,
    headers: async () => ({ authorization: `Bearer ${SECRET2}`, 'x-pleiad-host': (await host.store.identity()).hostId }),
    owns: d => d.via === 'plus',
    allowPairing: false,
    ...extra,
  });

  try {
    // ---- via ごとの端末を先に置く（via 無し = 今の形の devices.json = own）
    const ownDev = deviceRecord({ name: 'own phone', via: 'own' });
    const plusDev = deviceRecord({ name: 'plus phone', via: 'plus' });
    const legacyDev = deviceRecord({ name: 'legacy phone' });
    for (const d of [ownDev, plusDev, legacyDev]) await host.store.addDevice(d.record);

    await host.setSettings({ relayUrl: url1, enrollSecret: SECRET, enabled: true, hostName: 'links-test' });
    await until(async () => (await host.status()).links.own.state === 'connected', 10_000, 'own がつながる');
    const identity = await host.store.identity();
    const creds = (dev, url) => ({ hostId: identity.hostId, hostPublicKey: identity.publicKey, relayUrl: url, deviceId: dev.record.id, token: dev.token, keyPair: dev.keyPair });

    const s0 = await host.status();
    t.ok('provider が無い plus は disabled', s0.links.plus.state === 'disabled', JSON.stringify(s0.links));

    // ---- 2 本を並べて張る
    await within(host.setPlusProvider(plusProvider(plus2.url)), 5000, 'plus provider の差し込み');
    await until(async () => (await host.status()).links.plus.state === 'connected', 10_000, 'plus がつながる');
    const s1 = await host.status();
    t.ok('2 本がともに connected で links に出る', s1.links.own.state === 'connected' && s1.links.plus.state === 'connected', JSON.stringify(s1.links));
    t.ok('connection は links.own と同じもの', s1.connection.state === s1.links.own.state && s1.connection.since === s1.links.own.since && s1.connection.retryAt === s1.links.own.retryAt);

    // ---- sync の振り分け（実物の中継: 載っていない端末は中継が 4401 で断る）
    live.push(await within(connectDevice(creds(ownDev, url1)), 15_000, 'own の端末が own でつながる'));
    live.push(await within(connectDevice(creds(legacyDev, url1)), 15_000, 'via 無しの端末が own でつながる'));
    live.push(await within(connectDevice(creds(plusDev, plus2.url)), 15_000, 'plus の端末が plus でつながる'));
    t.ok('via ごとに端末が別々の中継でつながる', live.length === 3);
    const wrongWay1 = await rejects(connectDevice(creds(plusDev, url1)));
    const wrongWay2 = await rejects(connectDevice(creds(ownDev, plus2.url)));
    t.ok('own の中継には via:plus が、plus の中継には via:own の端末が sync されない（中継が 4401 で断る）',
      wrongWay1?.closeCode === 4401 && wrongWay2?.closeCode === 4401, `${wrongWay1?.closeCode} / ${wrongWay2?.closeCode}`);
    const listed = (await host.status()).devices;
    t.ok('端末一覧の各行に via が出る（via 無しは own。plusUid は出さない）',
      listed.find(d => d.id === plusDev.record.id)?.via === 'plus'
      && listed.filter(d => d.via === 'own').length === 2
      && listed.every(d => !('plusUid' in d)), JSON.stringify(listed.map(d => [d.id, d.via])));
    const fileNow = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'devices.json'), 'utf8'));
    t.ok('devices.json は via を持ち、via の無い古い記録はそのまま読める',
      fileNow.devices.find(d => d.id === plusDev.record.id)?.via === 'plus'
      && !('via' in fileNow.devices.find(d => d.id === legacyDev.record.id)));

    // ---- 片方の中継が落ちても、もう片方は動く
    const dropAt = Date.now();
    await within(plus2.relay.close(), 5000, 'plus の中継を止める');
    await until(async () => (await host.status()).links.plus.state === 'retrying', 10_000, 'plus が retrying になる');
    const s2 = await host.status();
    t.ok('plus の中継が落ちても own は connected のまま', s2.links.own.state === 'connected' && s2.links.plus.state === 'retrying', JSON.stringify(s2.links));
    plus2 = await within(startRelay(SECRET2, plus2.port), 5000, 'plus の中継の立て直し');
    await until(async () => {
      const s = await host.status();
      return s.links.plus.state === 'connected' && Date.parse(s.links.plus.since) >= dropAt;
    }, 10_000, 'plus が張り直す');
    t.ok('中継が戻ると plus は張り直す', (await host.status()).links.plus.state === 'connected');

    // ---- own が設定不足でも plus は張る
    const errAt = Date.now();
    await host.setSettings({ relayUrl: '' });
    await until(async () => {
      const s = await host.status();
      return s.links.own.state === 'error' && s.links.plus.state === 'connected';
    }, 10_000, 'own が設定不足でも plus が張る');
    const s3 = await host.status();
    t.ok('own の中継の設定が無くても plus は張れる', s3.links.own.state === 'error' && s3.links.plus.state === 'connected', JSON.stringify(s3.links));
    await host.setSettings({ relayUrl: url1 });
    await until(async () => {
      const s = await host.status();
      return s.links.own.state === 'connected' && Date.parse(s.links.own.since) >= errAt;
    }, 10_000, 'own が張り直す');

    // ---- 偽の中継: incoming の差し込み
    const fake = await startFakeRelay();
    fakes.push(fake);
    await host.setPlusProvider(plusProvider(fake.url));
    await until(async () => (await host.status()).links.plus.state === 'connected' && fake.hasControl(), 10_000, 'plus が偽の中継につながる');
    await until(() => fake.received.some(m => m.type === 'sync'), 5000, '偽の中継へ sync が届く');
    const syncedPlus = fake.received.filter(m => m.type === 'sync').at(-1).devices.map(d => d.id);
    t.ok('plus の中継へ sync するのは via:plus の端末だけ', syncedPlus.length === 1 && syncedPlus[0] === plusDev.record.id, JSON.stringify(syncedPlus));

    let acc = await fake.inject({ pairing: true });
    let closed = await acc.closed;
    t.ok('ペアリングを受けない link の pairing incoming は 4401 pairing で閉じる', closed.code === 4401 && closed.reason === 'pairing', JSON.stringify(closed));

    acc = await fake.inject({ admit: true });
    closed = await acc.closed;
    t.ok('onIncomingAdmit の無い provider では admit: true を 4401 admit で閉じる', closed.code === 4401 && closed.reason === 'admit', JSON.stringify(closed));

    acc = await fake.inject({ deviceId: ownDev.record.id });
    closed = await acc.closed;
    t.ok('link が引き受けない端末の incoming は 4401 revoked で閉じる（via:own の端末が plus から）', closed.code === 4401 && closed.reason === 'revoked', JSON.stringify(closed));

    // ---- admit を受ける provider
    let seen = null;
    const admitKey = generateKeyPair();
    let admittedId = null;
    await host.setPlusProvider(plusProvider(fake.url, {
      async onIncomingAdmit(ctx) {
        seen = ctx;
        const { device } = await ctx.admit({ name: 'admitted device', platform: 'android', app: 'test', publicKey: admitKey.publicKey, plusUid: 'uid-test', approvedBy: 'host' });
        admittedId = device.id;
        ctx.ws.close(1000);
      },
    }));
    await until(async () => (await host.status()).links.plus.state === 'connected' && fake.hasControl(), 10_000, 'admit 付き provider で張り直す');
    acc = await fake.inject({ admit: true });
    closed = await acc.closed;
    t.ok('admit: true は provider の onIncomingAdmit に渡る', Boolean(seen) && seen.link === 'plus' && closed.code === 1000, JSON.stringify(closed));
    const s4 = await host.status();
    const ad = s4.devices.find(d => d.id === admittedId);
    t.ok('onIncomingAdmit が登録した端末は via:plus で一覧に載る', ad?.via === 'plus' && ad?.name === 'admitted device', JSON.stringify(ad));
    const adFile = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'devices.json'), 'utf8')).devices.find(d => d.id === admittedId);
    t.ok('devices.json に via と plusUid が残る（plusUid は状態に出さない）', adFile?.via === 'plus' && adFile?.plusUid === 'uid-test' && ad && !('plusUid' in ad));
    t.ok('登録した端末の allow はその link へ行く', fake.received.some(m => m.type === 'allow' && m.id === admittedId));

    // ---- 逆方向: via:plus の端末が own の link から来る（own も偽の中継へ向けて差し込む）
    const fake2 = await startFakeRelay();
    fakes.push(fake2);
    await host.setSettings({ relayUrl: fake2.url });
    await until(async () => (await host.status()).links.own.state === 'connected' && fake2.hasControl(), 10_000, 'own が偽の中継につながる');
    const syncedOwn = fake2.received.filter(m => m.type === 'sync').at(-1).devices.map(d => d.id);
    t.ok('own の中継へ sync するのは via が無いか own の端末だけ',
      syncedOwn.includes(ownDev.record.id) && syncedOwn.includes(legacyDev.record.id)
      && !syncedOwn.includes(plusDev.record.id) && !syncedOwn.includes(admittedId), JSON.stringify(syncedOwn));
    const acc2 = await fake2.inject({ deviceId: plusDev.record.id });
    const closed2 = await acc2.closed;
    t.ok('via:plus の端末が own の link から来ても 4401 revoked', closed2.code === 4401 && closed2.reason === 'revoked', JSON.stringify(closed2));

    // ---- setPlusProvider(null) で plus だけ閉じる
    const ownSince = (await host.status()).links.own.since;
    await host.setPlusProvider(null);
    await until(async () => (await host.status()).links.plus.state === 'disabled', 5000, 'plus を外す');
    const s5 = await host.status();
    t.ok('setPlusProvider(null) で plus だけが閉じる（own は動き続ける）',
      s5.links.plus.state === 'disabled' && s5.links.own.state === 'connected' && s5.links.own.since === ownSince, JSON.stringify(s5.links));
    await until(() => !fake.hasControl() && fake.controlClosed.length > 0, 5000, '偽の中継の制御が閉じる');

    // ---- enabled:false で 2 本とも閉じる
    await host.setSettings({ enabled: false });
    await until(async () => {
      const s = await host.status();
      return s.links.own.state === 'disabled' && s.links.plus.state === 'disabled';
    }, 10_000, 'enabled:false で全部閉じる');
    t.ok('enabled:false で 2 本とも閉じる（own の制御も切れる）', !fake2.hasControl() && fake2.controlClosed.length > 0);
  } finally {
    for (const d of live.splice(0)) { try { d.close(); } catch { /* 既に切れている */ } }
    host.stop();
    await r1.relay.close().catch(() => {});
    await plus2.relay.close().catch(() => {});
    for (const f of fakes) await f.close().catch(() => {});
    await new Promise(r => targetServer.close(r));
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
