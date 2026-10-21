// Pleiad Plus の券での中継と受け入れ（docs/plus.md「券」、docs/remote.md §3.4）。
// 実物の中継（relay/server.mjs）に試験の authz（tests/lib/plus-relay-authz.mjs。本物の中継と同じ順に券を確かめる）を差し込み、
// fake の Plus が出す券で、
//   H. この PC の制御の接続は中継の券で張り、受け入れ（accept）は今の制御の接続の券を使う。閉じると新しい券で張り直す
//   D. 端末は中継の券と受け入れの券で入る。PC は受け入れの券の署名・aud・hostId・devicePub・uid・jti を確かめる
//   U. 券を出す api なのに ID トークンだけの端末は update_required。426・中継の 'update required' は「更新してください」。
//      PC の券が断られたら、種類ごとに止める（426）・止めて伝える（403 account_disabled・not_plus）・待つ（503）
//   E. 端末の側（core/remote/device.mjs）: 券で受け入れを受け、券で中継へつなぐ。券の 426・中継の 'update required' は 'update' で止まる。
//      券の 503 は paused、403 account_disabled・not_plus は blocked、外された PC（404・403 host_removed・中継の 4401 host）は removed
//   L. 券の口が無い前の版の api なら ID トークンの道へ戻る
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
import { createTicketIssuer, createTicketVerifier, issueTicket } from '../../core/plus/tickets.mjs';
import { createPlusRelayAuthz } from '../lib/plus-relay-authz.mjs';
import { plainCipher } from '../../core/secret-store.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { admitDevice, connectDevice } from '../lib/remote-device.mjs';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { generateKeyPair, hostIdFor } from '../../core/remote/noise.mjs';

export const name = 'remote-tickets';
export const title = '券での中継と受け入れ: 制御の接続の券・accept・受け入れの券の確かめ（他のアカウント・鍵違い・使い回し）・端末の側・更新の要求・前の版の api';

const UID = 'user-1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rejects = p => p.then(() => null, e => e);
const b64url = buf => Buffer.from(buf).toString('base64url');
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
  async function scene(label, fn) {
    try { await fn(); }
    catch (e) { t.ok(`${label}: 最後まで進む`, false, e?.stack ?? String(e)); }
  }

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-remote-tickets-')));
  const dataDir = path.join(scratch, 'data');
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
  // この PC が中継に出した券を経路ごとに残す（accept が制御の接続の券を使うかを見る）
  const hostTickets = [];
  const authzHost = authz.host;
  authz.host = async ctx => {
    hostTickets.push({ route: ctx.route, ticket: ctx.headers['x-pleiad-ticket'] ?? null, account: Boolean(ctx.headers['x-pleiad-account']) });
    return authzHost(ctx);
  };
  const relay = createRelay({ enrollSecret: crypto.randomBytes(32).toString('base64url'), trustProxy: false, logger: () => {}, authz, admitPerMinute: 100 });
  const relayAddr = await relay.listen(0, '127.0.0.1');
  const relayUrl = `http://127.0.0.1:${relayAddr.port}`;

  const st = { hostId: null, publicKey: null };
  const account = plus.state.accounts[UID];
  const plusConfig = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir, appVersion: 'test' });
  const client = createPlusClient({ config: plusConfig, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' });
  const session = {
    snapshot: () => ({ signedIn: true, account }),
    getIdToken: async () => plus.issueIdToken(UID),
    client, setHost: () => {}, onChange: () => {},
  };
  const request = (method, p, body) => client.request(method, p, { body });
  let admission = 1;   // /v1/auth/config の admission（券を出す api）
  const issuer = createTicketIssuer({ request, admission: () => admission });
  let keysClockOffset = 0;   // PC の公開鍵の覚えを古くする（期限の切れた覚えの場面）
  const ticketVerifier = createTicketVerifier({ keysUrl: () => plus.ticketKeysUrl, now: () => Date.now() + keysClockOffset });
  const remote = createRemoteHost({ dataDir, cipher: plainCipher, target: () => ({ host: '127.0.0.1', port: 1 }), token: 'tok', env: {}, backoff: { minMs: 60, maxMs: 200 }, log: () => {}, onIdentity: () => { void host.maybeRegister(); } });
  let plusCount = 0;
  let hostLost = 0;
  const plusLink = createPlusLink({
    session, verifier, issuer, ticketVerifier, remote,
    onAdmitted: async () => { plusCount = (await remote.store.devices()).filter(x => x.via === 'plus').length; },
    onHostLost: () => { hostLost++; }, log: () => {},
  });
  const host = createPlusHost({ session, store: remote.store, appVersion: 'test', hostName: () => 'ticket-desk', plusDevices: () => plusCount, retryMs: 40, log: () => {}, onHostState: s => remote.setPlusHostState(s) });
  remote.setPlusProvider(plusLink.provider);
  async function sync() {
    await host.maybeRegister();
    const r = await remote.status();
    plusLink.update({
      enabled: r.enabled, signedIn: true, uid: UID, accountStatus: 'plus', connect: r.plus?.connect === true,
      hostState: host.host().state, limits: account.limits, relayUrl, admission,
    });
    remote.refreshPlus();
  }
  const linkState = async () => (await remote.status()).links.plus;
  const connected = label => until(async () => (await linkState()).state === 'connected', 10_000, label);
  /** その鍵の端末の券（偽の Plus の券の口から。uid は UID） */
  const deviceTicket = keyPair => issueTicket({ request, purpose: 'device', keyPair, hostId: st.hostId });
  const admit = opts => admitDevice({ relayUrl, hostId: st.hostId, hostPublicKey: st.publicKey, ...opts });
  const windowFor = () => remote.status().then(s => s.pairing.requests.find(r => r.via === 'plus'));
  const noWindow = async () => (await remote.status()).pairing.requests.length === 0;
  /** 受け入れの券の中身を差し替えて署名し直す（偽の Plus の鍵で。差し替えた中身だけが違う券） */
  const forged = (ticket, patch) => {
    const p = JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url').toString('utf8'));
    return plus.signTicket({ ...p, jti: b64url(crypto.randomBytes(16)), ...patch });
  };
  const live = [];
  const device = createRemoteDevice({ dir: path.join(scratch, 'device'), cipher: plainCipher, app: 'test', name: 'Ticket Laptop', platform: 'desktop', log: () => {} });
  const deviceState = async () => (await device.proxy(st.hostId))?.status?.state ?? null;

  try {
    await remote.setSettings({ enabled: true, hostName: 'ticket-desk', plusConnect: true });
    const identity = await remote.store.identity();
    st.hostId = identity.hostId;
    st.publicKey = identity.publicKey;
    await sync();
    await connected('plus がつながる');

    // ---- H. 制御の接続と accept
    await scene('H', async () => {
      const control = hostTickets.filter(x => x.route === '/v1/host');
      t.ok('H: 制御の接続は中継の券（X-Pleiad-Ticket）で張り、ID トークンは送らない',
        control.length >= 1 && control.every(x => x.ticket && !x.account), JSON.stringify(control.map(x => ({ t: Boolean(x.ticket), a: x.account }))));
      const issuedHost = plus.state.tickets.filter(x => x.purpose === 'host');
      t.ok('H: 券は PC の鍵で取る（purpose host・役は host）', issuedHost.length >= 1, String(issuedHost.length));

      // 端末を 1 台入れて、accept を通す
      const keyPair = generateKeyPair();
      let shown = null;
      const pending = admit({ ticket: await deviceTicket(keyPair), keyPair, name: 'Ticket Phone', mode: 'pair', onCode: c => { shown = c; } });
      pending.catch(() => {});
      const req = await until(() => windowFor(), 10_000, '承認の窓に出る');
      await until(() => shown, 5000, '確認コード');
      await remote.approve(req.id);
      const creds = await within(pending, 15_000, '承認の答え');
      t.ok('D: 端末の券で入る端末は、知らない鍵なら PC の承認の窓に出て、許可で入る', Boolean(creds?.deviceId) && req.code === shown, JSON.stringify(creds?.denied ? creds : creds?.deviceId));
      const seenDevice = authz.state.seen.filter(x => x.route === '/v1/device' && x.by === 'ticket');
      t.ok('D: 端末の中継の接続は券で通る', seenDevice.some(x => x.ok), JSON.stringify(seenDevice));
      st.device = { creds, keyPair };

      const lastControl = hostTickets.filter(x => x.route === '/v1/host').at(-1);
      const accepts = hostTickets.filter(x => x.route === '/v1/host/accept');
      t.ok('H: accept は今の制御の接続の券をそのまま使う（新しい券を取らない）',
        accepts.length >= 1 && accepts.every(x => x.ticket === lastControl.ticket), JSON.stringify({ accepts: accepts.length }));
      t.ok('H: accept を中継が通す', authz.state.seen.filter(x => x.route === '/v1/host/accept').every(x => x.ok));
      t.ok('H: accept のたびに券を取らない（取ったのは制御の接続の分だけ）',
        plus.state.tickets.filter(x => x.purpose === 'host').length === hostTickets.filter(x => x.route === '/v1/host').length);

      // 制御の接続が閉じると、その券は accept に使えない（中継の取り決め）。PC は新しい券で張り直す
      const oldTicket = lastControl.ticket;
      const before = hostTickets.filter(x => x.route === '/v1/host').length;
      const since = Date.now();
      authz.handle.closeTag(`h:${st.hostId}`, 1013, 'try again');
      await until(async () => { const s = await linkState(); return s.state === 'connected' && Date.parse(s.since) >= since; }, 10_000, '張り直す');
      const control2 = hostTickets.filter(x => x.route === '/v1/host');
      t.ok('H: 張り直すときは新しい券を取る', control2.length > before && control2.at(-1).ticket !== oldTicket);
      const stale = await authz.host({ route: '/v1/host/accept', hostId: st.hostId, headers: { 'x-pleiad-ticket': oldTicket } });
      t.ok('H: 閉じた制御の接続の券は、accept に使えない（4401 ticket）', !stale.ok && stale.code === 4401 && stale.reason === 'ticket', JSON.stringify(stale));
      const replay = await authz.host({ route: '/v1/host', hostId: st.hostId, headers: { 'x-pleiad-ticket': oldTicket } });
      t.ok('H: 使った券で制御の接続は張れない（4401 ticket）', !replay.ok && replay.code === 4401 && replay.reason === 'ticket', JSON.stringify(replay));
      const ch = await within(connectDevice(creds, { extraHeaders: { 'x-pleiad-ticket': (await deviceTicket(keyPair)).relay } }), 15_000, '張り直した後のつなぎ');
      live.push(ch);
      t.ok('H: 張り直した後の accept は新しい制御の接続の券で通る',
        ch.hello?.hostName === 'ticket-desk' && hostTickets.filter(x => x.route === '/v1/host/accept').at(-1).ticket === control2.at(-1).ticket);
    });

    // ---- 中継の取り決め: 4429 は券を使い切らない
    await scene('R', async () => {
      const other = generateKeyPair();
      const out = await issueTicket({ request, purpose: 'host', keyPair: { ...other }, hostId: st.hostId }).then(() => null, e => e);
      t.ok('R: ほかの鍵ではこの PC の券を取れない（422 bad_proof）', out?.status === 422, String(out?.status));
      // lim.hosts を 1 にした券（このアカウントの PC はすでに 1 台つながっている）で、別の hostId の制御の接続
      const second = generateKeyPair();
      const { hostIdFor } = await import('../../core/remote/noise.mjs');
      const secondId = hostIdFor(second.publicKey);
      const now = Math.floor(Date.now() / 1000);
      const limited = plus.signTicket({ iss: 'pleiad-tickets', aud: 'relay', uid: UID, iat: now, exp: now + 300, jti: b64url(crypto.randomBytes(16)), role: 'host', sub: secondId, hostId: secondId, lim: { hosts: 1, devicesPerHost: 16 } });
      const r1 = await authz.host({ route: '/v1/host', hostId: secondId, headers: { 'x-pleiad-ticket': limited } });
      t.ok('R: 台数の上限は 4429 account limit', !r1.ok && r1.code === 4429 && r1.reason === 'account limit', JSON.stringify(r1));
      const r2 = await authz.host({ route: '/v1/host', hostId: secondId, headers: { 'x-pleiad-ticket': limited } });
      t.ok('R: 4429 で断った券は使い切らない（もう一度出しても 4429。4401 ticket にならない）', !r2.ok && r2.code === 4429, JSON.stringify(r2));
    });

    // ---- D. 受け入れの券の確かめ
    await scene('D', async () => {
      const { keyPair } = st.device;
      const quiet = await admit({ ticket: await deviceTicket(keyPair), keyPair, name: 'Ticket Phone' });
      t.ok('D: 許可した鍵は、新しい券で裏のつなぎ直し（mode admit）ができる', Boolean(quiet?.deviceId) && !quiet.denied, JSON.stringify(quiet?.denied ? quiet : quiet?.deviceId));

      // ほかのアカウントの受け入れの券（中継の券は本物）
      const stranger = generateKeyPair();
      const real = await deviceTicket(stranger);
      const otherUid = await admit({ ticket: { relay: real.relay, admission: forged(real.admission, { uid: 'user-2' }) }, keyPair: stranger, mode: 'pair', pairTimeoutMs: 3000 });
      t.ok('D: ほかのアカウントの受け入れの券は denied account（窓を出さない）', otherUid?.denied === true && otherUid?.reason === 'account' && await noWindow(), JSON.stringify(otherUid));

      // 鍵違い: X の鍵で取った券を Y の鍵で使う
      const x = generateKeyPair();
      const y = generateKeyPair();
      const forX = await deviceTicket(x);
      const swapped = await admit({ ticket: forX, keyPair: y, mode: 'pair', pairTimeoutMs: 3000 });
      t.ok('D: ほかの鍵の受け入れの券（devicePub が違う）は denied account（窓を出さない）', swapped?.denied === true && swapped?.reason === 'account' && await noWindow(), JSON.stringify(swapped));

      // 別の PC の券
      const real2 = await deviceTicket(stranger);
      const otherHost = await admit({ ticket: { relay: real2.relay, admission: forged(real2.admission, { hostId: 'a'.repeat(26) }) }, keyPair: stranger, mode: 'pair', pairTimeoutMs: 3000 });
      t.ok('D: ほかの PC 宛ての受け入れの券は denied account', otherHost?.denied === true && otherHost?.reason === 'account', JSON.stringify(otherHost));

      // aud 違い（中継の券を受け入れの券として出す）
      const real3 = await deviceTicket(stranger);
      const wrongAud = await admit({ ticket: { relay: real3.relay, admission: real3.relay }, keyPair: stranger, mode: 'pair', pairTimeoutMs: 3000 });
      t.ok('D: 中継の券を受け入れの券として出すと denied account', wrongAud?.denied === true && wrongAud?.reason === 'account', JSON.stringify(wrongAud));

      // 期限切れ
      const real4 = await deviceTicket(stranger);
      const past = Math.floor(Date.now() / 1000) - 1000;
      const expired = await admit({ ticket: { relay: real4.relay, admission: forged(real4.admission, { iat: past, exp: past + 300 }) }, keyPair: stranger, mode: 'pair', pairTimeoutMs: 3000 });
      t.ok('D: 期限の切れた受け入れの券は denied account', expired?.denied === true && expired?.reason === 'account', JSON.stringify(expired));

      // 使い回し: 通った受け入れの券を、新しい中継の券と組んでもう一度
      const once = await deviceTicket(keyPair);
      const first = await admit({ ticket: once, keyPair, name: 'Ticket Phone' });
      const fresh = await deviceTicket(keyPair);
      const again = await admit({ ticket: { relay: fresh.relay, admission: once.admission }, keyPair, name: 'Ticket Phone' });
      t.ok('D: 受け入れの券は一度きり（2 回目は denied account）', Boolean(first?.deviceId) && again?.denied === true && again?.reason === 'account', JSON.stringify(again));

      // 中継の券の使い回しは中継が断る
      const relayReplay = await rejects(admit({ ticket: { relay: once.relay, admission: fresh.admission }, keyPair, name: 'Ticket Phone' }));
      t.ok('D: 使った中継の券では中継が 4401 ticket で閉じる', relayReplay?.closeCode === 4401 && relayReplay?.closeReason === 'ticket', `${relayReplay?.closeCode} ${relayReplay?.closeReason} ${relayReplay?.message}`);

      // 公開鍵が取れない間は、期限の切れた覚えで確かめる
      plus.state.ticketKeysDown = true;
      keysClockOffset = 330_000;   // PC の覚えは 5 分を過ぎた（券はまだ期限内）
      const staleOk = await admit({ ticket: await deviceTicket(keyPair), keyPair, name: 'Ticket Phone' });
      t.ok('D: 公開鍵が取れない間は期限の切れた覚えで受け入れる', Boolean(staleOk?.deviceId) && !staleOk.denied, JSON.stringify(staleOk?.denied ? staleOk : staleOk?.deviceId));
      plus.state.ticketKeysDown = false;
      keysClockOffset = 0;
    });

    // ---- U. 更新の要求
    await scene('U', async () => {
      const { keyPair } = st.device;
      const real = await deviceTicket(keyPair);
      const idOnly = await admit({ ticket: real, plusHello: { idToken: plus.issueIdToken(UID) }, keyPair, name: 'Old App' });
      t.ok('U: 券を出す api なのに ID トークンだけの端末は denied update_required', idOnly?.denied === true && idOnly?.reason === 'update_required', JSON.stringify(idOnly));

      // 券の発行が 426 → 線は error update（張り直さない）
      plus.state.ticketFail = [{ purpose: 'host', path: '/v1/tickets/challenge', status: 426, code: 'update_required', count: 1000 }];
      authz.handle.closeTag(`h:${st.hostId}`, 1013, 'try again');
      const upd = await until(async () => { const s = await linkState(); return s.state === 'error' ? s : null; }, 10_000, '426 で止まる');
      t.ok('U: 券の発行が 426 なら、線は error update で止まる', upd.error?.code === 'update', JSON.stringify(upd));
      const challenges = () => plus.state.calls.filter(c => c.path === '/v1/tickets/challenge').length;
      const c0 = challenges();
      await sleep(600);   // backoff は 60〜200ms。張り直していれば券を取りに行く
      t.ok('U: 426 の後は張り直さない（券を取りに行かない）', challenges() === c0 && (await linkState()).state === 'error', String(challenges() - c0));
      plus.state.ticketFail = [];
      await sync();
      await connected('426 が直れば張り直す');
      t.ok('U: api が券を出すようになれば、条件の見直しで張り直す', true);

      // 券の発行が 403 host_removed → error host（登録を確かめ直す）
      const lostBefore = hostLost;
      plus.state.ticketFail = [{ purpose: 'host', path: '/v1/tickets', status: 403, code: 'host_removed', count: 1000 }];
      authz.handle.closeTag(`h:${st.hostId}`, 1013, 'try again');
      const lost = await until(async () => { const s = await linkState(); return s.state === 'error' ? s : null; }, 10_000, 'host_removed で止まる');
      t.ok('U: 券の発行が 403 host_removed なら error host で、登録を確かめ直す', lost.error?.code === 'host' && hostLost > lostBefore, JSON.stringify(lost));
      plus.state.ticketFail = [];
      await sync();
      await connected('戻れば張り直す');

      // 券の発行が 403 account_disabled・not_plus → 中継の 4401 account と同じく error account で止まり、張り直さない。
      // 条件の見直しだけでは解かず、GET /v1/account を読み直せた（accountReadAt が進んだ）ときに張り直す
      for (const code of ['account_disabled', 'not_plus']) {
        plus.state.ticketFail = [{ purpose: 'host', path: '/v1/tickets/challenge', status: 403, code, count: 1000 }];
        const c1 = challenges();
        authz.handle.closeTag(`h:${st.hostId}`, 1013, 'try again');
        await until(async () => challenges() > c1, 10_000, `${code} の券を取りに行く`);
        await sleep(600);
        const held = await linkState();
        t.ok(`U: 券の発行が 403 ${code} なら、線は error account で止まり、張り直さない`,
          held.state === 'error' && held.error?.code === 'account' && challenges() === c1 + 1, JSON.stringify({ held, tries: challenges() - c1 }));
        plus.state.ticketFail = [];
        await sync();
        await sleep(300);
        const still = await linkState();
        t.ok(`U: ${code} の止まりは、アカウントを読み直すまで条件の見直しでは解かない`, still.state === 'error' && still.error?.code === 'account', JSON.stringify(still));
        plusLink.update({ accountReadAt: Date.now() });
        remote.refreshPlus();
        await connected(`${code} のあと、アカウントを読み直せば張り直す`);
      }

      // 券の発行が 503（Plus が止まっている）→ 中継の 4401 plus unavailable と同じく、待って張り直す（止めない）
      plus.state.ticketFail = [{ purpose: 'host', path: '/v1/tickets/challenge', status: 503, code: 'unavailable', count: 1000 }];
      const c2 = challenges();
      authz.handle.closeTag(`h:${st.hostId}`, 1013, 'try again');
      const waiting = await until(async () => { const s = await linkState(); return s.state === 'retrying' && s.error?.code === 'unavailable' && challenges() >= c2 + 2 ? s : null; }, 5000, '503 で待つ').catch(() => null);
      t.ok('U: 券の発行が 503 なら、線は retrying（unavailable）で待ち、券を取り直し続ける', waiting?.retryAt != null, JSON.stringify(waiting ?? await linkState()));
      plus.state.ticketFail = [];
      await connected('Plus が戻れば、そのまま張り直す');

      // 中継の 4401 plus unavailable も待つ（券の取り直しの 1 回で使い切って 'auth' で止まらない）
      for (const n of [1, 2]) {
        const since = Date.now();
        authz.handle.closeTag(`h:${st.hostId}`, 4401, 'plus unavailable');
        const back = await until(async () => { const s = await linkState(); return s.state === 'error' || (s.state === 'connected' && Date.parse(s.since) >= since) ? s : null; }, 10_000, `plus unavailable の ${n} 回目`);
        t.ok(`U: 中継の 4401 plus unavailable（${n} 回目）は待って張り直す`, back.state === 'connected', JSON.stringify(back));
      }
    });

    // ---- E. 端末の側（createRemoteDevice の admit / open）
    await scene('E', async () => {
      const hostPublicKey = Buffer.from(st.publicKey, 'base64url');
      const base = { hostId: st.hostId, hostPublicKey, relayUrl, uid: UID };
      let code = null;
      const pending = device.admit({ ...base, ticketFor: kp => deviceTicket(kp), mode: 'pair', onCode: c => { code = c; } });
      pending.catch(() => {});
      const req = await until(() => windowFor(), 10_000, '端末の承認の窓');
      await until(() => code, 5000, '端末の確認コード');
      await remote.approve(req.id);
      const creds = await within(pending, 15_000, '端末の受け入れ');
      t.ok('E: 端末は券で受け入れを受ける（ID トークンを渡さない）', creds?.hostId === st.hostId && creds?.via === 'plus' && req.code === code, JSON.stringify(creds?.hostId));

      const seen0 = authz.state.seen.length;
      await device.open(st.hostId, { via: 'plus', relayUrl, getTicket: async ({ keyPair }) => (await deviceTicket(keyPair)).relay });
      await until(async () => (await deviceState()) === 'connected', 10_000, '端末の線がつながる');
      const seen = authz.state.seen.slice(seen0).filter(x => x.route === '/v1/device');
      t.ok('E: 端末の線は中継の券でつなぐ', seen.length >= 1 && seen.every(x => x.by === 'ticket' && x.ok), JSON.stringify(seen));
      await device.close(st.hostId);

      await device.open(st.hostId, { via: 'plus', relayUrl, getTicket: async () => { throw Object.assign(new Error('update required'), { code: 'update' }); } });
      const upd = await until(async () => { const s = await deviceState(); return s === 'update' ? s : null; }, 10_000, '端末の線が update で止まる');
      t.ok('E: 券の発行が 426 なら、端末の線は update で止まる', upd === 'update');
      await device.close(st.hostId);

      // 外された PC（券の発行が 403 host_removed・404）へは、オフラインとして張り直し続けず removed で止まる
      for (const [status, code] of [[403, 'host_removed'], [404, 'not_found']]) {
        let calls = 0;
        await device.open(st.hostId, { via: 'plus', relayUrl, getTicket: async () => { calls++; throw Object.assign(new Error('host removed'), { status, code }); } });
        const got = await until(async () => { const s = await deviceState(); return s === 'removed' || s === 'offline' ? s : null; }, 10_000, `端末の線が ${status} で止まる`);
        await sleep(1500);
        t.ok(`E: 券の発行が ${status} なら、端末の線は removed で止まり、張り直さない`, got === 'removed' && (await deviceState()) === 'removed' && calls === 1,
          JSON.stringify({ got, now: await deviceState(), calls }));
        await device.close(st.hostId);
      }

      // Plus が止まっている（503）→ paused、アカウントが止まった・Plus でない（403）→ blocked。中継の切断の理由と同じ状態で止まる
      for (const [status, code, want] of [[503, 'unavailable', 'paused'], [403, 'account_disabled', 'blocked'], [403, 'not_plus', 'blocked']]) {
        let calls = 0;
        await device.open(st.hostId, { via: 'plus', relayUrl, getTicket: async () => { calls++; throw Object.assign(new Error(code), { status, code }); } });
        const got = await until(async () => { const s = await deviceState(); return s && s !== 'connecting' ? s : null; }, 10_000, `端末の線が ${status} ${code} で止まる`);
        await sleep(1500);
        t.ok(`E: 券の発行が ${status} ${code} なら、端末の線は ${want} で止まり、張り直さない`, got === want && (await deviceState()) === want && calls === 1,
          JSON.stringify({ got, now: await deviceState(), calls }));
        await device.close(st.hostId);
      }

      // 中継が 4401 host で閉じた（PC が外された）→ 受け入れ直しに回さず removed
      {
        let sub = null;
        await device.open(st.hostId, { via: 'plus', relayUrl, getTicket: async ({ keyPair }) => { sub = hostIdFor(keyPair.publicKey); return (await deviceTicket(keyPair)).relay; } });
        await until(async () => (await deviceState()) === 'connected', 10_000, '端末の線がつながる（4401 host の前）');
        authz.handle.closeTag(`k:${sub}`, 4401, 'host');
        const got = await until(async () => { const s = await deviceState(); return s && s !== 'connected' && s !== 'connecting' ? s : null; }, 10_000, '4401 host で止まる');
        t.ok('E: 中継の 4401 host なら、端末の線は removed で止まる', got === 'removed', got);
        await device.close(st.hostId);
      }

      // 受け入れのやり直しで券が取れない: 外された PC → removed、アカウント → blocked、Plus が止まっている → paused
      for (const [status, code, want] of [[403, 'host_removed', 'removed'], [404, 'not_found', 'removed'], [403, 'account_disabled', 'blocked'], [503, 'unavailable', 'paused']]) {
        let sub = null;
        const onReadmit = () => device.admit({ ...base, mode: 'admit', ticketFor: async () => { throw Object.assign(new Error(code), { status, code }); } });
        await device.open(st.hostId, { via: 'plus', relayUrl, onReadmit, getTicket: async ({ keyPair }) => { sub = hostIdFor(keyPair.publicKey); return (await deviceTicket(keyPair)).relay; } });
        await until(async () => (await deviceState()) === 'connected', 10_000, `端末の線がつながる（受け入れ直し ${status} ${code} の前）`);
        authz.handle.closeTag(`k:${sub}`, 4401, 'revoked');
        const got = await until(async () => { const s = await deviceState(); return s && s !== 'connected' && s !== 'connecting' ? s : null; }, 10_000, `受け入れ直しが ${status} ${code} で止まる`);
        t.ok(`E: 受け入れ直しの券の発行が ${status} ${code} なら、端末の線は ${want} で止まる`, got === want, got);
        await device.close(st.hostId);
      }

      authz.state.v2Required = true;
      await device.open(st.hostId, { via: 'plus', relayUrl, getTicket: async () => null, getIdToken: async () => plus.issueIdToken(UID) });
      const upd2 = await until(async () => { const s = await deviceState(); return s === 'update' ? s : null; }, 10_000, '中継の update required で止まる');
      t.ok('E: 中継が券の無い接続を 4401 update required で断ると、端末の線は update で止まる', upd2 === 'update');
      authz.state.v2Required = false;
      await device.close(st.hostId);

      const e426 = await rejects(device.admit({ ...base, ticketFor: async () => { throw Object.assign(new Error('update required'), { status: 426, code: 'update_required' }); } }));
      t.ok('E: 受け入れの券の発行が 426 なら update', e426?.code === 'update', e426?.code);
      const e404 = await rejects(device.admit({ ...base, ticketFor: async () => { throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' }); } }));
      t.ok('E: 受け入れの券の発行が 404（PC が台帳に無い）なら unknown-host', e404?.code === 'unknown-host', e404?.code);
      const admitFails = [[403, 'host_removed', 'unknown-host'], [403, 'account_disabled', 'blocked'], [403, 'not_plus', 'blocked'], [503, 'unavailable', 'unavailable']];
      for (const [status, code, want] of admitFails) {
        const e = await rejects(device.admit({ ...base, ticketFor: async () => { throw Object.assign(new Error(code), { status, code }); } }));
        t.ok(`E: 受け入れの券の発行が ${status} ${code} なら ${want}`, e?.code === want, e?.code);
      }
      const eOld = await rejects(device.admit({ ...base, idToken: plus.issueIdToken(UID) }));
      t.ok('E: 券を出す api のホストへ ID トークンだけで入ろうとすると update', eOld?.code === 'update', eOld?.code);
    });

    // ---- L. 券の口が無い前の版の api
    await scene('L', async () => {
      plus.state.noTickets = true;
      admission = null;
      const since = Date.now();
      const before = hostTickets.length;
      authz.handle.closeTag(`h:${st.hostId}`, 1013, 'try again');
      await sync();
      await until(async () => { const s = await linkState(); return s.state === 'connected' && Date.parse(s.since) >= since; }, 10_000, 'ID トークンで張り直す');
      const after = hostTickets.slice(before).filter(x => x.route === '/v1/host');
      t.ok('L: 券の口が無い api なら、制御の接続は ID トークンで張る', after.length >= 1 && after.at(-1).account && !after.at(-1).ticket, JSON.stringify(after));
      const { keyPair } = st.device;
      const legacy = await admit({ idToken: plus.issueIdToken(UID), keyPair, name: 'Ticket Phone' });
      t.ok('L: 前の版の api の間は、ID トークンの端末も受け入れる', Boolean(legacy?.deviceId) && !legacy.denied, JSON.stringify(legacy?.denied ? legacy : legacy?.deviceId));

      // 中継が券を求める（'update required'）と、線は error update
      authz.state.v2Required = true;
      authz.handle.closeTag(`h:${st.hostId}`, 1013, 'try again');
      const upd = await until(async () => { const s = await linkState(); return s.state === 'error' ? s : null; }, 10_000, 'update required で止まる');
      t.ok('L: 中継が 4401 update required で断ると、線は error update', upd.error?.code === 'update', JSON.stringify(upd));
      authz.state.v2Required = false;
      plus.state.noTickets = false;
      admission = 1;
    });
  } finally {
    for (const c of live) { try { c.close(); } catch {} }
    await device.closeAll().catch(() => {});
    remote.stop();
    await relay.close?.();
    await plus.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
