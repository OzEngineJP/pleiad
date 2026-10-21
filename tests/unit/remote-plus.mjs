// Pleiad Plus のつながり（core/remote/plus-link.mjs + core/plus/hosts.mjs、docs/plus.md、docs/remote.md §6.4）。
// 実物の中継（relay/server.mjs）に試験の authz（tests/lib/plus-relay-authz.mjs）を差し込んで「公式の中継」にし、
// fake の Plus（tests/lib/fake-plus.mjs）と試験用の端末（tests/lib/remote-device.mjs）で
// 登録 → つながり → 同じアカウントの受け入れ → 再接続 → 断り・止め・張り直し を往復する。
// 自分の中継（own）は別の実物の中継（authz 無し）で、ペアリングが変わらないことも確かめる。
// LLM も外のネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { admitDevice, connectDevice, pairDevice } from '../lib/remote-device.mjs';
import { pairingPayload } from '../../core/remote/pairing.mjs';

export const name = 'remote-plus';
export const title = 'Pleiad Plus のつながり: この PC の登録・同じアカウントの受け入れ・再接続・断り・止め・張り直し・own との共存';

const UID = 'user-1';
const SECRET = crypto.randomBytes(32).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rejects = p => p.then(() => null, e => e);
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`);
    await sleep(30);
  }
}
function within(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); }),
  ]);
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-remote-plus-')));
  const dataDir = path.join(scratch, 'data');
  // 自分の中継（own。authz 無しの今の中継）と、認可の差し込みを持つ「公式の中継」
  const ownRelay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const ownAddr = await ownRelay.listen(0, '127.0.0.1');
  const ownUrl = `http://127.0.0.1:${ownAddr.port}`;
  const plus = await startFakePlus();
  plus.state.accounts[UID] = {
    uid: UID, email: 'u@example.test', provider: 'test', status: 'plus',
    plan: { id: 'plus', name: 'Plus' },
    limits: { hosts: 4, devicesPerHost: 4, sessionsPerHost: 2 },
    usage: { devices: 0, sessions: 0 }, sync: {},
  };
  const verifier = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'test-project' });
  const authz = createPlusRelayAuthz({
    verify: token => verifier.verify(token),
    isBound: async (uid, hostId) => plus.state.hosts[hostId]?.uid === uid,
  });
  // ホストが公式の中継へ張りに来た回数（止まっている間に張りに来ないことを数える）
  let hostTries = 0;
  const authzHost = authz.host;
  authz.host = ctx => { hostTries++; return authzHost(ctx); };
  const officialRelay = createRelay({ enrollSecret: crypto.randomBytes(32).toString('base64url'), trustProxy: false, logger: () => {}, authz });
  const officialAddr = await officialRelay.listen(0, '127.0.0.1');
  const officialUrl = `http://127.0.0.1:${officialAddr.port}`;

  const st = { signedIn: true, account: plus.state.accounts[UID], hostId: null, publicKey: null };
  const plusConfig = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir, appVersion: 'test' });
  const session = {
    snapshot: () => ({ signedIn: st.signedIn, account: st.signedIn ? st.account : null }),
    getIdToken: async () => plus.issueIdToken(UID),
    client: createPlusClient({ config: plusConfig, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' }),
    setHost: s => { hostStateSeen.push(s); },
    onChange: () => {},
  };
  const hostStateSeen = [];
  let accountReadAt = 0;   // session の accountReadAt（GET /v1/account を最後に読めた時刻）の代役

  const remote = createRemoteHost({ dataDir, cipher: plainCipher, target: () => ({ host: '127.0.0.1', port: 1 }), token: 'tok', env: {}, backoff: { minMs: 60, maxMs: 200 }, log: () => {}, onIdentity: () => { void host.maybeRegister(); } });
  let plusCount = 0;
  const plusLink = createPlusLink({ session, verifier, remote, onAdmitted: async () => {
    plusCount = (await remote.store.devices()).filter(d => d.via === 'plus').length;
    await host.syncDeviceCount();
  }, log: () => {} });
  const host = createPlusHost({ session, store: remote.store, appVersion: 'test', hostName: () => 'plus-desk', plusDevices: () => plusCount, retryMs: 40, log: () => {}, onHostState: s => remote.setPlusHostState(s) });
  remote.setPlusProvider(plusLink.provider);
  /** server の syncPlusLink と同じ見直し（条件を変えたあとに呼ぶ） */
  async function sync() {
    await host.maybeRegister();
    const r = await remote.status();
    plusCount = r.plus?.devices ?? 0;
    plusLink.update({
      enabled: r.enabled, signedIn: st.signedIn, uid: st.signedIn ? st.account?.uid ?? null : null,
      accountStatus: st.account?.status ?? null, accountReadAt, connect: r.plus?.connect === true,
      hostState: host.host().state, limits: st.account?.limits ?? null, relayUrl: officialUrl,
    });
    remote.refreshPlus();
  }
  const account = () => ({ 'x-pleiad-account': plus.issueIdToken(UID) });
  const admit = opts => admitDevice({ relayUrl: officialUrl, hostId: st.hostId, hostPublicKey: st.publicKey, idToken: plus.issueIdToken(UID), ...opts });
  const live = [];

  try {
    // ---- 登録からつながりまで（自分の中継も設定して own・plus を並べる）
    await remote.setSettings({ relayUrl: ownUrl, enrollSecret: SECRET, enabled: true, hostName: 'plus-desk', plusConnect: true });
    const identity = await remote.store.peekIdentity();
    st.hostId = identity.hostId;
    st.publicKey = identity.publicKey;
    await sync();
    t.ok('Plus ならこの PC を登録する', host.host().state === 'registered' && Boolean(plus.state.hosts[st.hostId]), st.hostId);
    const s1 = await until(async () => (await remote.status()).links.plus.state === 'connected' ? remote.status() : null, 10_000, 'plus がつながる');
    t.ok('enabled・plus.connect・signedIn・plus・registered で公式の中継につながる', s1.links.plus.state === 'connected' && s1.links.own.state === 'connected', JSON.stringify(s1.links));
    t.ok('remoteStatus.plus に connect・link・host・devices が出る', s1.plus?.connect === true && s1.plus?.host?.state === 'registered' && s1.plus?.devices === 0);

    // ---- 同じアカウントの端末の受け入れ（確認コードなし）
    const creds = await within(admit({ name: 'Plus Phone', platform: 'android' }), 15_000, '端末の受け入れ');
    t.ok('同じアカウントなら確認コードなしで端末を登録する', Boolean(creds.deviceId) && /^[A-Za-z0-9_-]{43}$/.test(creds.token ?? ''), JSON.stringify(creds.deviceId));
    const rec = (await remote.store.devices()).find(d => d.id === creds.deviceId);
    t.ok('登録した端末は via:plus と plusUid を持つ', rec?.via === 'plus' && rec?.plusUid === UID, JSON.stringify(rec && { via: rec.via, plusUid: rec.plusUid }));
    await until(() => plus.state.hosts[st.hostId].deviceCount === 1, 3000, '台帳へ PATCH deviceCount');

    // ---- 再接続（deviceId + トークン + アカウントのヘッダー）
    const d1 = await within(connectDevice(creds, { extraHeaders: account() }), 15_000, '端末の再接続');
    live.push(d1);
    t.ok('受け入れた端末がそのままつながる（IK・HELLO）', d1.hello.hostName === 'plus-desk');

    // ---- 同じ公開鍵は置き換える（件数は増えない）
    const creds2 = await within(admit({ name: 'Plus Phone 2', keyPair: creds.keyPair }), 15_000, '同じ鍵の受け入れ');
    // 古い端末の取り消しは登録のあとに続けて行うので、一覧が 1 件になるまで待つ
    const after2 = await until(async () => {
      const list = (await remote.store.devices()).filter(d => d.via === 'plus');
      return list.length === 1 ? list : null;
    }, 10_000, '古い端末が消える');
    t.ok('同じ公開鍵は置き換わる（新しい deviceId、件数は増えない）',
      Boolean(creds2.deviceId) && creds2.deviceId !== creds.deviceId && after2[0].id === creds2.deviceId, creds2.deviceId);
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, '取り消しに伴う張り直し');
    live.push(await within(connectDevice(creds2, { extraHeaders: account() }), 15_000, '置き換えた端末がつながる'));

    // ---- 断り: ほかのアカウント（中継が断る経路と、ホストが暗号の中で断る経路）
    plus.state.accounts['user-2'] = { ...plus.state.accounts[UID], uid: 'user-2' };
    const wrong = await rejects(admitDevice({ relayUrl: officialUrl, hostId: st.hostId, hostPublicKey: st.publicKey, idToken: plus.issueIdToken('user-2') }));
    t.ok('ほかのアカウントの端末は中継が 4401 account で断る', wrong?.closeCode === 4401 && wrong?.closeReason === 'account', `${wrong?.closeCode} ${wrong?.closeReason}`);
    authz.state.looseDevices = true;
    const wrong2 = await admitDevice({ relayUrl: officialUrl, hostId: st.hostId, hostPublicKey: st.publicKey, idToken: plus.issueIdToken('user-2') });
    t.ok('中継を通っても、ホストが暗号の中で denied account にする', wrong2?.denied === true && wrong2?.reason === 'account', JSON.stringify(wrong2));
    authz.state.looseDevices = false;
    const badToken = await rejects(admitDevice({ relayUrl: officialUrl, hostId: st.hostId, hostPublicKey: st.publicKey, idToken: 'not-a-token' }));
    t.ok('読めない ID トークンは中継が 4401 token で断る', badToken?.closeCode === 4401 && badToken?.closeReason === 'token', `${badToken?.closeCode} ${badToken?.closeReason}`);

    // ---- 断り: 台数の上限・読めていない・回数
    plus.state.accounts[UID].limits.devicesPerHost = 1;
    await sync();
    const full = await admit({ name: 'over' });
    t.ok('台数の上限なら denied devices', full?.denied === true && full?.reason === 'devices', JSON.stringify(full));
    st.account = { ...st.account, limits: null };
    await sync();
    const unknown = await admit({ name: 'unknown' });
    t.ok('台数の上限を一度も読めていなければ denied unavailable', unknown?.denied === true && unknown?.reason === 'unavailable', JSON.stringify(unknown));
    st.account = plus.state.accounts[UID];
    plus.state.accounts[UID].limits.devicesPerHost = 8;
    await sync();
    // 1 時間の受け入れの上限（小さい値に差し替えた provider で確かめる。直近 1 時間の端末が 1 台居るので 1 で当たる）
    const small = createPlusLink({ session, verifier, remote, log: () => {}, admitLimit: 1 });
    small.update({ enabled: true, signedIn: true, uid: UID, accountStatus: 'plus', connect: true, hostState: 'registered', limits: st.account.limits, relayUrl: officialUrl });
    remote.setPlusProvider(small.provider);
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, '小さい上限の provider で張り直す');
    const rate = await admit({ name: 'rate' });
    t.ok('この 1 時間の受け入れが上限を超えると denied rate', rate?.denied === true && rate?.reason === 'rate', JSON.stringify(rate));
    remote.setPlusProvider(plusLink.provider);
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, '元の provider で張り直す');

    // ---- Plus のつながりがオフ → ホストは accept を 4401 'plus off' で閉じる（中継は端末へ 4401 を渡す。reason は中継の 'host closed'）
    plusLink.update({ hostState: 'taken' });
    const off = await rejects(admit({ name: 'off' }));
    t.ok('つながりがオフなら端末は 4401 で閉じられる', off?.closeCode === 4401, `${off?.closeCode} ${off?.closeReason}`);
    plusLink.update({ hostState: 'registered' });

    // ---- plus.connect を切ると link だけ閉じて記録は残る
    await remote.setSettings({ plusConnect: false });
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'disabled', 5000, 'plus を止める');
    t.ok('plus.connect を切っても端末の記録は残る', (await remote.store.devices()).some(d => d.via === 'plus'));
    const offline = await rejects(admit({ name: 'while off' }));
    t.ok('plus が閉じている間は端末がつながらない（中継にホストが居ない 4404）', offline?.closeCode === 4404, `${offline?.closeCode}`);
    await remote.setSettings({ plusConnect: true });
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, 'plus を戻す');

    // ---- own のペアリングは変わらない（plus と同時に張っている間も）
    const offer = await remote.startPairing();
    const pa = pairDevice({ payload: offer.payload, name: 'own-phone' });
    const req = await until(async () => (await remote.status()).pairing.requests[0], 10_000, 'own の承認待ち');
    await remote.approve(req.id);
    const ownCreds = await within(pa.result, 15_000, 'own のペアリングの結果');
    t.ok('plus につながっている間も own のペアリングは変わらない', Boolean(ownCreds.deviceId) && ownCreds.relayUrl === ownUrl);
    live.push(await within(connectDevice(ownCreds), 15_000, 'own の端末がつながる'));
    const plusPayload = pairingPayload({ relayUrl: officialUrl, hostId: st.hostId, publicKey: st.publicKey, secret: crypto.randomBytes(32), hostName: 'x' });
    const pd = await rejects(pairDevice({ payload: plusPayload }).result);
    t.ok('公式の中継はペアリングを受けない（4401 pairing disabled）', pd?.closeCode === 4401, String(pd?.closeCode ?? pd?.message));

    // ---- 中継が閉じたときの扱い（onClose の表）
    authz.state.blockHosts = { code: 4401, reason: 'account' };
    authz.handle.closeTag(`h:${st.hostId}`, 4401, 'account');
    const sErr1 = await until(async () => (await remote.status()).links.plus.state === 'error' ? remote.status() : null, 5000, 'account は張り直さない');
    t.ok('4401 account は error account で張り直さない', sErr1.links.plus.error?.code === 'account', JSON.stringify(sErr1.links.plus));
    // 止まっている間は、アカウントの状態が変わらなければ中継へ張りに行かない
    // （session の知らせのたびの見直し・設定の書き換えに伴う apply() でも）
    authz.state.blockHosts = null;
    const triesHeld = hostTries;
    await sync();
    await remote.setSettings({ hostName: 'plus-desk' });
    await sync();
    await sleep(400);
    const sHeld = await remote.status();
    t.ok('account で止まっている間は、アカウントの状態が変わらなければ中継へつながない',
      hostTries === triesHeld && sHeld.links.plus.state === 'error' && sHeld.links.plus.error?.code === 'account',
      `tries=${hostTries - triesHeld} ${JSON.stringify(sHeld.links.plus)}`);
    // アカウントを読み直して plus と分かった（GET /v1/account が status:'plus'）→ 止まりを解いてつなぎ直す
    accountReadAt = Date.now();
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, '読み直して plus ならつなぎ直す');
    t.ok('account で止まったあと、アカウントを読み直して plus ならつなぎ直す', true);
    // アカウントが disabled になってから plus に戻る（停止 → 再開）→ つなぎ直す
    authz.state.blockHosts = { code: 4401, reason: 'account' };
    authz.handle.closeTag(`h:${st.hostId}`, 4401, 'account');
    await until(async () => (await remote.status()).links.plus.error?.code === 'account', 5000, 'もう一度 account で止まる');
    plus.state.accounts[UID].status = 'disabled';
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'disabled', 5000, 'disabled なら閉じる');
    authz.state.blockHosts = null;
    plus.state.accounts[UID].status = 'plus';
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, 'plus に戻ればつなぎ直す');
    t.ok('account で止まったあと、アカウントが disabled → plus に戻ればつなぎ直す', true);
    // 設定 › リモートの Pleiad Plus のスイッチを切って入れ直す → つなぎ直す
    authz.state.blockHosts = { code: 4401, reason: 'account' };
    authz.handle.closeTag(`h:${st.hostId}`, 4401, 'account');
    await until(async () => (await remote.status()).links.plus.error?.code === 'account', 5000, 'また account で止まる');
    authz.state.blockHosts = null;
    await remote.setSettings({ plusConnect: false });
    await sync();
    await remote.setSettings({ plusConnect: true });
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, 'スイッチを入れ直すとつなぎ直す');
    t.ok('account で止まったあと、Pleiad Plus のスイッチを切って入れ直すとつなぎ直す', true);
    authz.state.blockHosts = { code: 4429, reason: 'account limit' };
    authz.handle.closeTag(`h:${st.hostId}`, 4429, 'account limit');
    const sErr2 = await until(async () => (await remote.status()).links.plus.state === 'error' ? remote.status() : null, 5000, 'account limit は張り直さない');
    t.ok('4429 account limit は error limit で張り直さない', sErr2.links.plus.error?.code === 'limit', JSON.stringify(sErr2.links.plus));
    authz.state.blockHosts = null;
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, '張り直す');
    authz.state.blockHosts = { code: 4401, reason: 'token' };
    authz.handle.closeTag(`h:${st.hostId}`, 4401, 'token');
    const sErr3 = await until(async () => {
      const s = await remote.status();
      return s.links.plus.state === 'error' && s.links.plus.error?.code === 'auth' ? s : null;
    }, 10_000, '4401 は 1 回張り直してから auth');
    t.ok('ほかの 4401 は 1 回張り直し、続けて 4401 なら error auth', sErr3.links.plus.error?.code === 'auth');
    authz.state.blockHosts = null;
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, '張り直す');
    const since1013 = Date.now();
    authz.handle.closeTag(`h:${st.hostId}`, 1013, 'try again');
    await until(async () => {
      const s = await remote.status();
      return s.links.plus.state === 'connected' && Date.parse(s.links.plus.since) >= since1013;
    }, 10_000, '1013 でも張り直す');
    t.ok('1013 は今の backoff で張り直す', true);

    // ---- アカウントが free に落ちる → link は閉じるが記録は残る
    plus.state.accounts[UID].status = 'free';
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'disabled', 5000, 'free なら閉じる');
    t.ok('free に落ちても端末の記録は残る', (await remote.store.devices()).some(d => d.via === 'plus'));
    plus.state.accounts[UID].status = 'plus';
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, 'plus に戻れば張る');

    // ---- ログアウト → via:plus の端末を全部取り消す（server の syncPlusLink と同じ処理をここでやる）
    st.signedIn = false;
    for (const d of (await remote.store.devices()).filter(d => d.via === 'plus')) await remote.revoke(d.id);
    st.account = null;
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'disabled', 5000, 'ログアウトで閉じる');
    const left = await remote.store.devices();
    t.ok('ログアウトで via:plus の端末を取り消す', !left.some(d => d.via === 'plus'));
    t.ok('ログアウトしても own の端末と link は残る',
      left.some(d => d.via === 'own') && (await remote.status()).links.own.state === 'connected', JSON.stringify(left.map(d => [d.id, d.via])));
  } finally {
    for (const d of live.splice(0)) { try { d.close(); } catch {} }
    remote.stop();
    await ownRelay.close().catch(() => {});
    await officialRelay.close().catch(() => {});
    await plus.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
