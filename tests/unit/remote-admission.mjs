// 端末の受け入れ・取り消し・ホストだけの操作（ADR 0248、docs/remote.md §3.4）。
// 実物の中継（relay/server.mjs）に試験の authz を差し込んだ「公式の中継」と fake の Plus で、
//   A. 同じアカウントでも知らない鍵は、PC の承認の窓を通らないと入れない
//   B. 取り消した鍵は、新しい ID トークンを持ってきても入れない（取り消した鍵の一覧 revoked.json）
//   C. 取り消すと、同じ鍵の記録と、その端末が許可した端末も一緒に外れる
//   D. 端末の画面から来た接続は、ホストだけの操作（リモートの設定・ペアリングの開始と答え・Plus のログインとログアウト・同期のスイッチとやり直し・登録し直し）を断る。取り消しは通す
//   E. 前の版で確認コードなしに入った via:plus の端末は「もう一度の許可が要る端末」になり、許可し直すまで通らない
//   F. 公式の中継からの申し込みを 1 時間に 3 回断ると、そのアカウントからの申し込みを 1 時間止める（鍵を作り直しても窓を出さない）。
//      数は plus-requests.json に残り、再起動しても止めたまま。「再開する」で解く
// を往復する。LLM も外のネットワークも使わない。
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
import { admitDevice, connectDevice } from '../lib/remote-device.mjs';
import { generateKeyPair } from '../../core/remote/noise.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'remote-admission';
export const title = '端末の受け入れと取り消し: 同じアカウントの知らない鍵・取り消した鍵・一緒に外れる端末・ホストだけの操作・もう一度の許可';

const UID = 'user-1';
const SECRET = crypto.randomBytes(32).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rejects = p => p.then(() => null, e => e);
const keyText = kp => kp.publicKey.toString('base64url');
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

/** devices.json に置く 1 件（生のトークンも返す。中継へつなぐ試験に使う） */
function seeded({ via = 'plus', keyPair = generateKeyPair(), approvedBy, name }) {
  const raw = crypto.randomBytes(32);
  const at = new Date(Date.now() - 86_400_000).toISOString();
  const record = {
    id: `d${crypto.randomBytes(12).toString('base64url')}`, name, platform: 'android', app: 'test',
    publicKey: keyText(keyPair), tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
    createdAt: at, lastSeenAt: null, via,
    ...(via === 'plus' ? { plusUid: UID } : {}),
    ...(approvedBy ? { approvedBy, approvedAt: at } : {}),
  };
  return { record, keyPair, token: raw.toString('base64url') };
}

export default async function (t) {
  /** 1 つの場面が落ちても、残りの場面は確かめる */
  async function scene(label, fn) {
    try { await fn(); }
    catch (e) { t.ok(`${label}: 最後まで進む`, false, e?.stack ?? String(e)); }
  }

  await hostScenes(t, scene);
  await hostOnlyScenes(t, scene);
}

async function hostScenes(t, scene) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-remote-admission-')));
  const dataDir = path.join(scratch, 'data');
  const ownRelay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const ownAddr = await ownRelay.listen(0, '127.0.0.1');
  const ownUrl = `http://127.0.0.1:${ownAddr.port}`;
  const plus = await startFakePlus();
  plus.state.accounts[UID] = {
    uid: UID, email: 'u@example.com', provider: 'test', status: 'plus',
    plan: { id: 'plus', name: 'Plus' },
    limits: { hosts: 4, devicesPerHost: 16, sessionsPerHost: 2 },
    usage: { devices: 0, sessions: 0 }, sync: {},
  };
  const verifier = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'test-project' });
  const authz = createPlusRelayAuthz({
    verify: token => verifier.verify(token), keysUrl: plus.ticketKeysUrl,
    isBound: async (uid, hostId) => plus.state.hosts[hostId]?.uid === uid,
  });
  // 試験は 1 分の間に何度も受け入れを試す（中継の 1 分の受け入れの上限を広げる）
  const officialRelay = createRelay({ enrollSecret: crypto.randomBytes(32).toString('base64url'), trustProxy: false, logger: () => {}, authz, admitPerMinute: 100 });
  const officialAddr = await officialRelay.listen(0, '127.0.0.1');
  const officialUrl = `http://127.0.0.1:${officialAddr.port}`;

  // 前の版の台帳: 確認コードなしに入った via:plus の端末（M）と、許可の鎖（A → B → C、A と同じ鍵の D）と、関係の無い端末（Z）
  const migrated = seeded({ name: 'Old Plus Phone' });
  const a = seeded({ via: 'own', approvedBy: 'host', name: 'A' });
  const b = seeded({ approvedBy: a.record.id, name: 'B' });
  const c = seeded({ approvedBy: b.record.id, name: 'C' });
  const d = seeded({ keyPair: a.keyPair, approvedBy: 'host', name: 'D' });
  const z = seeded({ via: 'own', approvedBy: 'host', name: 'Z' });
  await fs.mkdir(path.join(dataDir, 'remote'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'remote', 'devices.json'),
    JSON.stringify({ version: 1, devices: [migrated, a, b, c, d, z].map(s => s.record) }, null, 2));

  const st = { hostId: null, publicKey: null };
  const account = plus.state.accounts[UID];
  const plusConfig = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir, appVersion: 'test' });
  const session = {
    snapshot: () => ({ signedIn: true, account }),
    getIdToken: async () => plus.issueIdToken(UID),
    client: createPlusClient({ config: plusConfig, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' }),
    setHost: () => {}, onChange: () => {},
  };
  const remote = createRemoteHost({ dataDir, cipher: plainCipher, target: () => ({ host: '127.0.0.1', port: 1 }), token: 'tok', env: {}, backoff: { minMs: 60, maxMs: 200 }, log: () => {}, onIdentity: () => { void host.maybeRegister(); } });
  let plusCount = 0;
  const plusLink = createPlusLink({ session, verifier, remote, onAdmitted: async () => {
    plusCount = (await remote.store.devices()).filter(x => x.via === 'plus').length;
    await host.syncDeviceCount();
  }, log: () => {} });
  const host = createPlusHost({ session, store: remote.store, appVersion: 'test', hostName: () => 'admission-desk', plusDevices: () => plusCount, retryMs: 40, log: () => {}, onHostState: s => remote.setPlusHostState(s) });
  remote.setPlusProvider(plusLink.provider);
  async function sync() {
    await host.maybeRegister();
    const r = await remote.status();
    plusCount = r.plus?.devices ?? 0;
    plusLink.update({
      enabled: r.enabled, signedIn: true, uid: UID, accountStatus: 'plus', connect: r.plus?.connect === true,
      hostState: host.host().state, limits: account.limits, relayUrl: officialUrl,
    });
    remote.refreshPlus();
  }
  const accountHeader = () => ({ 'x-pleiad-account': plus.issueIdToken(UID) });
  const admit = opts => admitDevice({ relayUrl: officialUrl, hostId: st.hostId, hostPublicKey: st.publicKey, idToken: plus.issueIdToken(UID), ...opts });
  const windowFor = name => remote.status().then(s => s.pairing.requests.find(r => r.via === 'plus' && (!name || r.name === name)));
  /** 人が選んだつなぎ（mode 'pair'）を出し、PC の承認の窓に出た申し込みへ answer（approve / deny）で答える。 */
  async function answered(answer, opts = {}) {
    let shown = null;
    const pending = admit({ ...opts, mode: 'pair', onCode: code => { shown = code; } });
    pending.catch(() => {});   // 窓に出ないまま閉じられたときは、下の until が落ちる
    const req = await until(() => windowFor(opts.name), 10_000, '承認の窓に出る');
    await until(() => shown, 5000, '端末に確認コードが出る');
    if (answer === 'approve') await remote.approve(req.id); else await remote.deny(req.id);
    return { req, shown, result: await within(pending, 15_000, '承認の答え') };
  }
  /** つなぎ直しが通らない（中継かホストが閉じる・HELLO が来ない）こと */
  async function refused(creds) {
    const err = await rejects(within(connectDevice({ ...creds, relayUrl: officialUrl, hostId: st.hostId, hostPublicKey: st.publicKey }, { extraHeaders: accountHeader(), helloTimeoutMs: 4000 }), 8000, 'つなぎ直し'));
    if (!err) return { ok: false, detail: 'つながってしまった' };
    return { ok: true, detail: `${err.closeCode ?? ''} ${err.closeReason ?? ''} ${err.status ?? ''} ${err.message}` };
  }
  const live = [];
  let reapproved = null;   // E で許可し直した端末（F で、止めている間も許可済みの端末は通ることを見る）
  let restarted = null;

  try {
    await remote.setSettings({ relayUrl: ownUrl, enrollSecret: SECRET, enabled: true, hostName: 'admission-desk', plusConnect: true });
    const identity = await remote.store.peekIdentity();
    st.hostId = identity.hostId;
    st.publicKey = identity.publicKey;
    await sync();
    await until(async () => (await remote.status()).links.plus.state === 'connected', 10_000, 'plus がつながる');

    // ---- E. 前の版で確認コードなしに入った via:plus の端末
    await scene('E', async () => {
      const s = await remote.status();
      const row = s.devices.find(x => x.id === migrated.record.id);
      t.ok('E: 承認の記録の無い via:plus の端末は「もう一度の許可が要る端末」として出る', row?.reapprove === true, JSON.stringify(row));
      const conn = await refused({ deviceId: migrated.record.id, token: migrated.token, keyPair: migrated.keyPair });
      t.ok('E: もう一度の許可が済むまで、持っているトークンでもつながらない', conn.ok, conn.detail);
      const quiet = await admit({ name: 'Old Plus Phone', keyPair: migrated.keyPair });
      t.ok('E: 裏のつなぎ直しは denied approval（窓を出さない）',
        quiet?.denied === true && quiet?.reason === 'approval' && (await remote.status()).pairing.requests.length === 0, JSON.stringify(quiet));
      const again = await answered('approve', { name: 'Old Plus Phone', keyPair: migrated.keyPair });
      t.ok('E: 人が選んだつなぎは、もう一度の許可の印を付けて承認の窓に出る', again.req.again === true && again.req.code === again.shown, JSON.stringify(again.req));
      const rec = (await remote.store.devices()).find(x => x.id === migrated.record.id);
      t.ok('E: 許可し直すと同じ端末のまま approvedBy: host が付く',
        again.result?.deviceId === migrated.record.id && rec?.approvedBy === 'host' && (await remote.status()).devices.find(x => x.id === migrated.record.id)?.reapprove !== true,
        JSON.stringify({ id: again.result?.deviceId, approvedBy: rec?.approvedBy }));
      reapproved = again.result;
      const ch = await within(connectDevice(again.result, { extraHeaders: accountHeader() }), 15_000, '許可し直した端末のつなぎ直し');
      live.push(ch);
      t.ok('E: 許可し直した端末は新しいトークンでつながる', ch.hello?.hostName === 'admission-desk');
    });

    // ---- A. 同じアカウントでも、知らない鍵は PC の承認の窓を通らないと入れない
    await scene('A', async () => {
      const before = (await remote.store.devices()).length;
      const stranger = generateKeyPair();
      const quiet = await admit({ name: 'Stranger', keyPair: stranger });
      const after = await remote.store.devices();
      t.ok('A: 同じアカウントの別の鍵は、裏のつなぎ直しでは denied approval（登録しない・窓を出さない）',
        quiet?.denied === true && quiet?.reason === 'approval' && after.length === before && !after.some(x => x.publicKey === keyText(stranger))
          && (await remote.status()).pairing.requests.length === 0, JSON.stringify(quiet));
      let shown = null;
      let settled = false;
      const pending = admit({ name: 'Stranger', keyPair: stranger, mode: 'pair', onCode: code => { shown = code; } });
      pending.then(() => { settled = true; }, () => { settled = true; });
      pending.catch(() => {});
      const req = await until(() => windowFor(), 10_000, '承認の窓に出る');
      await until(() => shown, 5000, '端末に確認コードが出る');
      await sleep(300);
      t.ok('A: 人が選んだつなぎは承認の窓で待つ（許可するまで入らない）',
        !settled && req.code === shown && !(await remote.store.devices()).some(x => x.publicKey === keyText(stranger)), JSON.stringify(req));
      await remote.deny(req.id);
      const no = await within(pending, 15_000, '拒否の答え');
      t.ok('A: 窓で拒否すると denied rejected', no?.denied === true && no?.reason === 'rejected', JSON.stringify(no));
    });

    // ---- B. 取り消した鍵は、新しい ID トークンを持ってきても入れない
    await scene('B', async () => {
      const keyPair = generateKeyPair();
      const first = await answered('approve', { name: 'Lost Phone', keyPair });
      const creds = first.result;
      t.ok('B: 承認の窓で許可した端末を登録する', Boolean(creds?.deviceId), JSON.stringify(creds?.deviceId));
      await remote.revoke(creds.deviceId);
      const file = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'revoked.json'), 'utf8'));
      t.ok('B: 取り消すと鍵を revoked.json に書く', file.keys?.some(k => k.publicKey === keyText(keyPair) && k.by === 'host'), JSON.stringify(file));
      t.ok('B: 取り消した端末は状態の revoked に出る', (await remote.status()).revoked?.some(k => k.key === keyText(keyPair)));
      const quiet = await admit({ name: 'Lost Phone', keyPair });
      t.ok('B: 取り消した鍵は、新しい ID トークンでも denied revoked', quiet?.denied === true && quiet?.reason === 'revoked', JSON.stringify(quiet));
      const asked = await admit({ name: 'Lost Phone', keyPair, mode: 'pair', pairTimeoutMs: 3000 });
      t.ok('B: 人が選んだつなぎでも窓に出さず denied revoked',
        asked?.denied === true && asked?.reason === 'revoked' && (await remote.status()).pairing.requests.length === 0, JSON.stringify(asked));
      const conn = await refused(creds);
      t.ok('B: 取り消した端末は前のトークンでもつながらない', conn.ok, conn.detail);
      // 「一覧から消す」は表示だけ外す。鍵は通さないまま
      await remote.hideRevoked(keyText(keyPair));
      const hidden = await admit({ name: 'Lost Phone', keyPair });
      t.ok('B: 一覧から消しても、鍵は通さない', !(await remote.status()).revoked?.some(k => k.key === keyText(keyPair)) && hidden?.reason === 'revoked', JSON.stringify(hidden));
    });

    // ---- C. 取り消すと、同じ鍵の記録と、その端末が許可した端末も一緒に外れる
    await scene('C', async () => {
      await remote.revoke(a.record.id, { by: z.record.id });
      const left = (await remote.store.devices()).map(x => x.id);
      const chain = [a, b, c, d];
      t.ok('C: 取り消した端末・同じ鍵の記録・許可した端末（孫まで）が外れる',
        chain.every(s => !left.includes(s.record.id)), JSON.stringify(chain.map(s => [s.record.name, left.includes(s.record.id)])));
      t.ok('C: 関係の無い端末は残る', left.includes(z.record.id));
      const keys = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'revoked.json'), 'utf8')).keys ?? [];
      t.ok('C: 一緒に外れた端末の鍵も取り消した鍵に入る（取り消した機器も残る）',
        [a, b, c].every(s => keys.some(k => k.publicKey === s.record.publicKey && k.by === z.record.id)), JSON.stringify(keys.map(k => [k.name, k.by])));
      const back = await admit({ name: 'B', keyPair: b.keyPair, mode: 'pair', pairTimeoutMs: 3000 });
      t.ok('C: 一緒に外れた端末の鍵も入れない', back?.denied === true && back?.reason === 'revoked', JSON.stringify(back));
    });

    // ---- F. 断り続けると、公式の中継からの申し込みを止める（A で 1 回断っている）
    await scene('F', async () => {
      const file = path.join(dataDir, 'remote', 'plus-requests.json');
      const denials = () => fs.readFile(file, 'utf8').then(x => JSON.parse(x).accounts?.[UID]?.denials?.length ?? 0, () => 0);
      t.ok('F: 断った数を plus-requests.json に残す', (await denials()) === 1, String(await denials()));
      const second = await answered('deny', { name: 'Again 2', keyPair: generateKeyPair() });
      t.ok('F: 2 回目までは止めない', second.result?.reason === 'rejected' && !(await remote.status()).plus.paused, JSON.stringify((await remote.status()).plus));
      // 3 回目を断るとき、同じアカウントのもう 1 つの申し込みが窓で待っている
      const waiting = admit({ name: 'Again 4', keyPair: generateKeyPair(), mode: 'pair' });
      waiting.catch(() => {});
      await until(async () => (await remote.status()).pairing.requests.some(r => r.name === 'Again 4'), 10_000, '4 つ目が窓に出る');
      const third = await answered('deny', { name: 'Again 3', keyPair: generateKeyPair() }).catch(e => ({ error: e.message }));
      const s = await remote.status();
      const until1h = Date.parse(s.plus.paused?.until ?? '') - Date.now();
      t.ok('F: 1 時間に 3 回断ると、申し込みを 1 時間止める', third.result?.reason === 'rejected' && until1h > 59 * 60_000 && until1h <= 60 * 60_000,
        JSON.stringify({ third, paused: s.plus.paused }));
      const closed = await within(waiting, 15_000, '待っていた申し込みの答え');
      t.ok('F: 止めると、窓で待っていた申し込みも閉じる', closed?.denied === true && closed?.reason === 'rejected'
        && !s.pairing.requests.some(r => r.via === 'plus'), JSON.stringify(closed));
      const fresh = await admit({ name: 'New Key', keyPair: generateKeyPair(), mode: 'pair', pairTimeoutMs: 3000 });
      t.ok('F: 止めている間は、鍵を作り直した申し込みも窓に出さず denied rejected',
        fresh?.denied === true && fresh?.reason === 'rejected' && (await remote.status()).pairing.requests.length === 0, JSON.stringify(fresh));
      if (reapproved) {
        const ch = await within(connectDevice(reapproved, { extraHeaders: accountHeader() }), 15_000, '許可済みの端末のつなぎ直し');
        live.push(ch);
        t.ok('F: 止めている間も、許可済みの端末はつながる', ch.hello?.hostName === 'admission-desk');
      }
      const saved = JSON.parse(await fs.readFile(file, 'utf8')).accounts?.[UID];
      t.ok('F: 止めた期限をファイルに残す', saved?.pausedUntil === s.plus.paused?.until, JSON.stringify(saved));

      // 再起動（同じデータの置き場で作り直す）しても止めたまま
      remote.stop();
      restarted = createRemoteHost({ dataDir, cipher: plainCipher, target: () => ({ host: '127.0.0.1', port: 1 }), token: 'tok', env: {}, backoff: { minMs: 60, maxMs: 200 }, log: () => {} });
      restarted.start();
      const after = await until(async () => (await restarted.status()).plus.paused, 10_000, '再起動の後の止めている状態');
      t.ok('F: 再起動しても止めたまま', after.until === s.plus.paused?.until, JSON.stringify(after));
      const resumed = await restarted.resumePlusRequests();
      const cleared = JSON.parse(await fs.readFile(file, 'utf8')).accounts ?? {};
      t.ok('F: 「再開する」で止めた記録と断った数を消す', resumed.plus.paused === null && Object.keys(cleared).length === 0,
        JSON.stringify({ paused: resumed.plus.paused, cleared }));
    });
  } finally {
    for (const x of live.splice(0)) { try { x.close(); } catch {} }
    restarted?.stop();
    remote.stop();
    await ownRelay.close().catch(() => {});
    await officialRelay.close().catch(() => {});
    await plus.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- D. 端末の画面から来た接続（中継の接続口は x-forwarded-for と x-pleiad-device を付ける）は、ホストだけの操作を断る
async function hostOnlyScenes(t, scene) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-host-only-')));
  // Plus は隠す（断られなかったときに、本物の Plus へ出ていかない）
  const server = await startServer({ dataDir, env: { AGENT_HOST_DATA: dataDir, AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_PLUS: '0' } });
  const conns = [];
  try {
    await scene('D', async () => {
      const local = await open({ port: server.port, token: server.token });
      const remoteScreen = await open({ port: server.port, token: server.token, headers: { 'x-forwarded-for': 'pleiad-remote' } });
      conns.push(local, remoteScreen);
      const code = p => p.then(() => 'ok', e => e.code ?? e.message);
      const commands = [
        ['setRemoteSettings', { hostName: 'changed-from-device' }],
        ['remotePairingStart', {}],
        ['remotePairingCancel', {}],
        ['remotePairingApprove', { id: 'nothing' }],
        ['remotePairingDeny', { id: 'nothing' }],
        ['plusHostRebind', {}],
        ['plusLogin', {}],
        ['plusLoginCancel', {}],
        ['plusLogout', {}],
      ];
      for (const [command, args] of commands) {
        const got = await code(remoteScreen.cmd(command, args));
        t.ok(`D: 端末の画面からの ${command} は host_only で断る`, got === 'host_only', String(got));
      }
      // 操作の一覧の口（invoke { op }）で来るもの: アカウントの全部の PC に効く同期のスイッチ・やり直しと、登録し直し
      for (const [op, args] of [['plus.syncSetEnabled', { enabled: false }], ['plus.syncReset', {}], ['plus.hostReregister', {}]]) {
        const got = await code(remoteScreen.cmd('invoke', { op, args }));
        t.ok(`D: 端末の画面からの invoke ${op} は HOST_SCREEN_ONLY で断る`, got === 'HOST_SCREEN_ONLY', String(got));
      }
      const settings = await local.cmd('remoteStatus', {}).catch(() => null);
      t.ok('D: 断った操作は設定を変えない', settings?.hostName !== 'changed-from-device', JSON.stringify(settings?.hostName));
      const fromHost = await code(local.cmd('setRemoteSettings', { hostName: 'host-desk' }));
      t.ok('D: ホストの PC の画面からは変えられる', fromHost !== 'host_only', String(fromHost));
      const revoke = await code(remoteScreen.cmd('remoteRevoke', { id: 'dnothing' }));
      t.ok('D: 端末の画面からの取り消しは断らない（host_only にしない）', revoke !== 'host_only', String(revoke));
    });
  } finally {
    for (const ws of conns) { try { ws.close(); } catch {} }
    await server.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
