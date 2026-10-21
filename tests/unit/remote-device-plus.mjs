// リモートの端末側（Plus 経由。core/remote/device.mjs・device-link.mjs・device-proxy.mjs、docs/remote.md §6.4・§7、issue B6）。
// 偽の Plus（tests/lib/fake-plus.mjs）と認可付き公式中継（relay/server.mjs + tests/lib/plus-relay-authz.mjs）、
// ホスト（core/remote/connector.mjs + core/plus/hosts.mjs）を立て、
// 端末の createRemoteDevice で初回受け入れ（admit）、4ヘッダー接続、HTTP/WS疎通、鍵不一致拒否、Close制御を検証する。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { createPlusLink } from '../../core/remote/plus-link.mjs';
import { createPlusHost } from '../../core/plus/hosts.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createIdTokenVerifier } from '../../core/plus/verify.mjs';
import { createPlusRelayAuthz } from '../lib/plus-relay-authz.mjs';
import { plainCipher } from '../../core/secret-store.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { createRemoteDevice, admitWithHost } from '../../core/remote/device.mjs';
import { Handshake, generateKeyPair, hostIdFor, prologueFor } from '../../core/remote/noise.mjs';

export const name = 'remote-device-plus';
export const title = 'リモートの端末側（Plus 経由）: 初回受け入れ・4ヘッダー接続・HTTP/WS疎通・鍵不一致拒否・再接続とClose制御・denied理由';

const UID = 'user-plus-dev-1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rejects = p => p.then(() => null, e => e);

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
    await sleep(30);
  }
}

function waitState(device, hostId, pred, ms, label) {
  return within(new Promise(resolve => {
    const on = s => { if (s.hostId === hostId && pred(s.state)) { device.off('status', on); resolve(s); } };
    device.on('status', on);
    device.proxy(hostId).then(px => { if (px && pred(px.status.state)) { device.off('status', on); resolve({ hostId, ...px.status }); } });
  }), ms, label);
}

function request(port, pathname, { method = 'GET', headers = {}, timeoutMs = 10_000 } = {}) {
  return within(new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, agent: false, headers }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  }), timeoutMs, `${method} ${pathname}`);
}

function openWs(url, { timeoutMs = 10_000 } = {}) {
  return within(new Promise(resolve => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    const inbox = [];
    const waiters = [];
    const closed = new Promise(res => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => { const m = isBinary ? data : data.toString('utf8'); const w = waiters.shift(); if (w) w(m); else inbox.push(m); });
    ws.once('open', () => resolve({
      ws, closed,
      next: (ms = 10_000) => inbox.length ? Promise.resolve(inbox.shift()) : within(new Promise(res => waiters.push(res)), ms, 'WS のメッセージ'),
    }));
    ws.once('unexpected-response', (req, res) => { res.resume(); req.destroy(); resolve({ status: res.statusCode }); });
    ws.once('error', e => resolve({ error: e.message }));
  }), timeoutMs, `WS ${url}`);
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-remote-dev-plus-')));
  const hostDataDir = path.join(scratch, 'host-data');
  const deviceDataDir = path.join(scratch, 'device-data');

  // 1. 偽の Plus
  const plus = await startFakePlus();
  plus.state.accounts[UID] = {
    uid: UID, email: 'user@example.test', provider: 'test', status: 'plus',
    plan: { id: 'plus', name: 'Plus' },
    limits: { hosts: 4, devicesPerHost: 4, sessionsPerHost: 2 },
    usage: { devices: 0, sessions: 0 }, sync: {},
  };

  // 2. 認可付き公式中継
  const verifier = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'test-project' });
  const relayAuthzCalls = [];
  const authz = createPlusRelayAuthz({
    verify: token => verifier.verify(token), keysUrl: plus.ticketKeysUrl,
    isBound: async (uid, hostId) => {
      const bound = plus.state.hosts[hostId]?.uid === uid;
      relayAuthzCalls.push({ uid, hostId, bound });
      return bound;
    },
  });
  // 試験は 1 分の間に何度も受け入れを試す（中継の 1 分の受け入れの上限を広げる）
  const officialRelay = createRelay({ enrollSecret: crypto.randomBytes(32).toString('base64url'), trustProxy: false, logger: () => {}, authz, admitPerMinute: 100 });
  const officialAddr = await officialRelay.listen(0, '127.0.0.1');
  const officialUrl = `http://127.0.0.1:${officialAddr.port}`;

  // 3. ホストのダミー HTTP サーバー（ホスト画面用）
  const dummyTarget = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>Pleiad Host</h1></body></html>');
  });
  const wss = new WebSocketServer({ server: dummyTarget });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ kind: 'ready' }));
  });
  await new Promise(r => dummyTarget.listen(0, '127.0.0.1', r));
  const dummyPort = dummyTarget.address().port;

  // 4. B4 ホスト（Plus 連携）
  const st = { signedIn: true, account: plus.state.accounts[UID] };
  const plusConfig = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: hostDataDir, appVersion: 'test' });
  const session = {
    snapshot: () => ({ signedIn: st.signedIn, account: st.signedIn ? st.account : null }),
    getIdToken: async () => plus.issueIdToken(UID),
    client: createPlusClient({ config: plusConfig, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' }),
    setHost: () => {},
    onChange: () => {},
  };

  const remoteHost = createRemoteHost({
    dataDir: hostDataDir, cipher: plainCipher,
    target: () => ({ host: '127.0.0.1', port: dummyPort }),
    token: 'test-host-token', env: {}, backoff: { minMs: 60, maxMs: 200 }, log: () => {},
    onIdentity: () => { void hostService.maybeRegister(); },
  });
  let plusDeviceCount = 0;
  const plusLink = createPlusLink({
    session, verifier, remote: remoteHost,
    onAdmitted: async () => {
      plusDeviceCount = (await remoteHost.store.devices()).filter(d => d.via === 'plus').length;
      await hostService.syncDeviceCount();
    },
    log: () => {},
  });
  const hostService = createPlusHost({
    session, store: remoteHost.store, appVersion: 'test',
    hostName: () => 'my-plus-pc', plusDevices: () => plusDeviceCount, retryMs: 40, log: () => {},
    onHostState: s => remoteHost.setPlusHostState(s),
  });
  remoteHost.setPlusProvider(plusLink.provider);

  async function syncHost() {
    await hostService.maybeRegister();
    const r = await remoteHost.status();
    plusDeviceCount = r.plus?.devices ?? 0;
    plusLink.update({
      enabled: r.enabled, signedIn: st.signedIn, uid: st.signedIn ? st.account?.uid ?? null : null,
      accountStatus: st.account?.status ?? null, connect: r.plus?.connect === true,
      hostState: hostService.host().state, limits: st.account?.limits ?? null, relayUrl: officialUrl,
    });
    remoteHost.refreshPlus();
  }

  // ホストの起動と中継接続
  await remoteHost.start();
  await remoteHost.setSettings({ enabled: true, hostName: 'my-plus-pc', plusConnect: true });
  const identity = await remoteHost.store.identity();
  const hostId = identity.hostId;
  const hostPublicKey = Buffer.from(identity.publicKey, 'base64url');
  await syncHost();

  // ホストが公式中継につながるのを待つ
  const s1 = await until(async () => {
    const s = await remoteHost.status();
    return s.links.plus?.state === 'connected' ? s : null;
  }, 10_000, 'ホストが公式中継につながる');
  t.ok('ホストが公式中継に connected でつながる', s1?.links?.plus?.state === 'connected');

  // 5. 端末の作成
  const device = createRemoteDevice({
    dir: deviceDataDir,
    cipher: plainCipher,
    app: 'pleiad-desktop-test',
    name: 'laptop-client',
    platform: 'desktop',
    log: () => {},
  });

  const sockets = [];

  try {
    // ---- 鍵不一致・パラメータ異常の拒否 ----
    const fakeKey = crypto.randomBytes(32);
    const errBadKey = await rejects(device.admit({
      hostId, hostPublicKey: fakeKey, relayUrl: officialUrl, idToken: plus.issueIdToken(UID), uid: UID,
    }));
    t.ok('hostId と一致しない hostPublicKey は bad-host で拒否される', errBadKey?.code === 'bad-host');

    const errNoToken = await rejects(device.admit({
      hostId, hostPublicKey, relayUrl: officialUrl, idToken: '', uid: UID,
    }));
    t.ok('idToken が空の場合は account で拒否される', errNoToken?.code === 'account');

    // ---- 初回受け入れ: 裏のつなぎ直し（admit）では許可の無い鍵は通らない。人が選んだつなぎ（pair）は PC の承認の窓へ ----
    const errQuiet = await rejects(device.admit({ hostId, hostPublicKey, relayUrl: officialUrl, idToken: plus.issueIdToken(UID), uid: UID }));
    t.ok('許可の無い鍵の裏のつなぎ直しは reapprove（ホストに窓を出さない）',
      errQuiet?.code === 'reapprove' && (await remoteHost.status()).pairing.requests.length === 0, errQuiet?.code);
    let shownCode = null;
    const admitting = device.admit({
      hostId, hostPublicKey, relayUrl: officialUrl, idToken: plus.issueIdToken(UID), uid: UID, mode: 'pair', onCode: c => { shownCode = c; },
    });
    const req = await until(async () => (await remoteHost.status()).pairing.requests.find(r => r.via === 'plus'), 10_000, 'ホストの承認の窓');
    await until(() => shownCode, 5000, '端末の確認コード');
    t.ok('端末とホストの窓に同じ確認コードが出る', req.code === shownCode, `${req.code} ${shownCode}`);
    await remoteHost.approve(req.id);
    const admitted = await admitting;
    t.ok('ホストで許可すると受け入れに成功し、ホスト情報が返る', admitted?.hostId === hostId && admitted?.via === 'plus');

    const hostsList = await device.list();
    const savedHost = hostsList.find(h => h.hostId === hostId && h.via === 'plus');
    t.ok('hosts.json に via: "plus" と uid が保存されている', savedHost?.via === 'plus' && savedHost?.uid === UID && savedHost?.hostName === 'my-plus-pc');

    // ---- プロキシ起動と 4ヘッダー接続 ----
    let readmitCalled = 0;
    const px = await device.open(hostId, {
      via: 'plus',
      getIdToken: async () => plus.issueIdToken(UID),
      onReadmit: async () => { readmitCalled++; },
    });
    t.ok('open でプロキシが生成される', Boolean(px && px.port));

    const connectedState = await waitState(device, hostId, s => s === 'connected', 10_000, '端末の接続');
    t.ok('端末が connected 状態になる', connectedState?.state === 'connected');

    // HTTP 通信疎通確認
    const httpRes = await request(px.port, `/?token=${px.token}`);
    t.ok('プロキシ経由でホストの HTML が返る', httpRes.status === 200 && httpRes.body.toString().includes('Pleiad Host'));

    // WS 通信疎通確認
    const wsRes = await openWs(`ws://127.0.0.1:${px.port}/ws?token=${px.token}`);
    sockets.push(wsRes);
    t.ok('プロキシ経由の WS 接続が開く', Boolean(wsRes.ws), wsRes.error || wsRes.status || 'closed');
    const firstMsg = JSON.parse(await wsRes.next());
    t.ok('ホストから ready メッセージを受信する', firstMsg?.kind === 'ready');

    // ---- リレー URL 更新の動作 ----
    // 別のリレー URL を指定して open を呼ぶ
    await device.close(hostId);
    const px2 = await device.open(hostId, {
      via: 'plus',
      relayUrl: officialUrl,
      getIdToken: async () => plus.issueIdToken(UID),
    });
    const connectedAgain = await waitState(device, hostId, s => s === 'connected', 10_000, '再接続');
    t.ok('再接続後も connected になる', connectedAgain?.state === 'connected');

    // ---- denied の理由コード検証 (admitWithHost) ----
    const keyPair = await device.store.identity();
    const errHostOffline = await rejects(admitWithHost({
      hostId: 'nonexistenthost1234567890a',
      hostPublicKey: crypto.randomBytes(32),
      relayUrl: officialUrl,
      keyPair,
      idToken: plus.issueIdToken(UID),
    }));
    t.ok('存在しない hostId の場合は bad-host または host-offline になる', ['bad-host', 'host-offline'].includes(errHostOffline?.code));

    // ホストから denied: 'account' が返る場合（別アカウントの ID トークンをホストまで届ける）
    const UID2 = 'user-plus-dev-2';
    plus.state.accounts[UID2] = { uid: UID2, email: 'u2@example.test', status: 'plus' };
    authz.state.looseDevices = true;
    const errDeniedAccount = await rejects(device.admit({
      hostId, hostPublicKey, relayUrl: officialUrl, idToken: plus.issueIdToken(UID2), uid: UID2,
    }));
    authz.state.looseDevices = false;
    t.ok('別アカウントのトークンは denied account -> blocked になる', errDeniedAccount?.code === 'blocked');

    // 台数・limits の断りは、許可の無い鍵を窓へ回す前に確かめる（新しい鍵の人が選んだつなぎで見る）
    const newcomer = () => admitWithHost({ hostId, hostPublicKey, relayUrl: officialUrl, keyPair: generateKeyPair(), idToken: plus.issueIdToken(UID), mode: 'pair' });
    // ホストから denied: 'devices' が返る場合（端末上限オーバー）
    st.account.limits = { ...st.account.limits, devicesPerHost: 0 };
    await syncHost();
    const errDeniedDevices = await rejects(newcomer());
    t.ok('端末台数制限オーバーは denied devices -> limit になる', errDeniedDevices?.code === 'limit');

    // ホストから denied: 'unavailable' が返る場合（limits が null）
    st.account.limits = null;
    await syncHost();
    const errDeniedUnavailable = await rejects(newcomer());
    t.ok('limits 未設定時は denied unavailable -> unavailable になる', errDeniedUnavailable?.code === 'unavailable');

    // limits を元に戻す
    st.account.limits = { hosts: 4, devicesPerHost: 4, sessionsPerHost: 2 };
    await syncHost();

    // ---- 忘れる (remove) ----
    await device.remove(hostId, 'plus');
    const hostsAfterRemove = await device.list();
    t.ok('remove 後は hosts.json から消える', !hostsAfterRemove.some(h => h.hostId === hostId && h.via === 'plus'));

  } finally {
    for (const s of sockets) { try { s.ws?.terminate(); } catch {} }
    await device.closeAll().catch(() => {});
    try { remoteHost.stop(); } catch {}
    dummyTarget.close();
    await officialRelay.close().catch(() => {});
    await plus.close().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
