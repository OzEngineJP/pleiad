// 審査用ホストの Plus ログインと自動承認（ADR 0339、core/review-plus-login.mjs・core/plus/session.mjs の loginWithPassword・core/remote/plus-link.mjs の 5a）。
// A. メールとパスワードでのログイン（偽の Plus）: 入る・間違いは入れない・再起動しても残る・失効のあと入り直す・別のメールの保管は入り直す
// B. 審査用アカウントの端末だけが承認の窓なしで入る。普段のホスト・別のアカウント・uid が合わない審査用ホストは今までどおり
// LLM も外のネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { createPlusLink } from '../../core/remote/plus-link.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createPlusSession } from '../../core/plus/session.mjs';
import { createIdTokenVerifier } from '../../core/plus/verify.mjs';
import { createPlusRelayAuthz } from '../lib/plus-relay-authz.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { startReviewPlusLogin, reviewPlusCredentials } from '../../core/review-plus-login.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { admitDevice } from '../lib/remote-device.mjs';
import { generateKeyPair } from '../../core/remote/noise.mjs';

export const name = 'review-plus-login';
export const title = '審査用ホストの Plus ログイン: メールとパスワードで入る・再起動で残る・審査用アカウントの端末だけ自動承認';

const EMAIL = 'reviewer@example.invalid';
const PASSWORD = 'pw-for-test-only-1';
const UID = 'review-uid';
const REVIEW = { AGENT_HOST_REVIEW: '1', AGENT_HOST_REVIEW_PLUS_EMAIL: EMAIL, AGENT_HOST_REVIEW_PLUS_PASSWORD: PASSWORD };
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

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-review-plus-')));
  const plus = await startFakePlus();
  plus.state.passwordUsers[EMAIL] = { password: PASSWORD, uid: UID };
  plus.state.accounts[UID] = {
    uid: UID, email: EMAIL, provider: 'password', status: 'plus', plan: { id: 'plus', name: 'Plus' },
    limits: { hosts: 4, devicesPerHost: 2, sessionsPerHost: 2 }, usage: { devices: 0, sessions: 0 }, sync: {},
  };

  const makeSession = (dir) => {
    const secrets = createSecretStore({ file: path.join(dir, 'plus-secrets.json'), cipher: plainCipher });
    const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url, AGENT_HOST_PLUS: '1' }, dataDir: dir, appVersion: 'test' });
    const session = createPlusSession({ config, secrets, openExternal: () => {}, fetchFn: fetch, appVersion: 'test', refreshRetries: 1, refreshRetryMs: 10 });
    return { session, secrets };
  };

  try {
    // ---- A. ログイン -------------------------------------------------------------------------
    t.ok('審査モードでなければ、環境変数があっても対象にしない', reviewPlusCredentials({ ...REVIEW, AGENT_HOST_REVIEW: '' }) === null);
    t.ok('メールかパスワードが欠けていれば対象にしない', reviewPlusCredentials({ AGENT_HOST_REVIEW: '1', AGENT_HOST_REVIEW_PLUS_EMAIL: EMAIL }) === null);

    const dirA = path.join(scratch, 'a');
    await fs.mkdir(dirA, { recursive: true });
    const a = makeSession(dirA);
    await a.session.init();
    t.ok('普段のホスト（審査モードでない）は何も始めない', startReviewPlusLogin({ session: a.session, env: {}, log: () => {} }) === null);

    const wrong = await rejects(a.session.loginWithPassword({ email: EMAIL, password: 'wrong-password-xyz' }));
    t.ok('パスワードが違うと入れず、誤りにパスワードを含めない', wrong?.code === 'unauthenticated' && !String(wrong.message).includes('wrong-password-xyz') && a.session.snapshot().signedIn === false, wrong?.message);
    const noUser = await rejects(a.session.loginWithPassword({ email: 'nobody@example.invalid', password: PASSWORD }));
    t.ok('登録の無いメールも入れない', noUser?.code === 'unauthenticated' && a.session.snapshot().signedIn === false);

    const logs = [];
    const rev = startReviewPlusLogin({ session: a.session, env: REVIEW, log: line => logs.push(line), sleep: ms => sleep(Math.min(ms, 20)), backoff: { minMs: 20, maxMs: 40 } });
    t.ok('審査用アカウントを設定すると、入る前の uid は null', rev !== null && rev.uid() === null);
    // 先に 2 回失敗させ、取り直しで入る
    const realPass = plus.state.passwordUsers[EMAIL].password;
    plus.state.passwordUsers[EMAIL].password = 'someone-changed-it';
    const pending = rev.ensure();
    await until(() => logs.filter(l => l.includes('sign-in failed')).length >= 2, 5000, '2 回失敗する');
    plus.state.passwordUsers[EMAIL].password = realPass;
    await pending;
    const snap = a.session.snapshot();
    t.ok('失敗は間をあけて取り直し、入れたら uid を返す', snap.signedIn === true && snap.uid === UID && rev.uid() === UID && snap.email === EMAIL, JSON.stringify({ s: snap.signedIn, u: snap.uid }));
    t.ok('ログにパスワードもトークンも出ない', !logs.join('\n').includes(PASSWORD) && !logs.join('\n').includes('rt-'), logs.join('|'));
    const stored = JSON.parse(await fs.readFile(path.join(dirA, 'plus-secrets.json'), 'utf8'));
    t.ok('保管にはパスワードを置かない（refresh token だけ）', !JSON.stringify(stored).includes(PASSWORD));

    // 再起動: 同じ保管で新しい session を作る。パスワードを使わずに入ったまま
    rev.stop();
    const calls0 = plus.state.calls.filter(c => c.path.startsWith('/v1/accounts:signInWithPassword')).length;
    const b = makeSession(dirA);
    await b.session.init();
    const rev2 = startReviewPlusLogin({ session: b.session, env: REVIEW, log: () => {} });
    await rev2.ensure();
    const calls1 = plus.state.calls.filter(c => c.path.startsWith('/v1/accounts:signInWithPassword')).length;
    t.ok('再起動しても入ったまま（パスワードでの入り直しをしない）', rev2.uid() === UID && calls1 === calls0, `${calls0} -> ${calls1}`);

    // 失効（Firebase が更新を拒む）→ 入り直す
    plus.state.refreshError = 'TOKEN_EXPIRED';
    await b.session.getIdToken({ force: true }).catch(() => {});
    plus.state.refreshError = null;
    await until(() => rev2.uid() === UID && b.session.snapshot().signedIn, 5000, '失効のあと入り直す');
    t.ok('更新を拒まれて出された（signedOut）あとは、自動で入り直す', plus.state.calls.filter(c => c.path.startsWith('/v1/accounts:signInWithPassword')).length === calls1 + 1);
    rev2.stop();

    // 別のメールの保管が残っていたら、入り直す
    const dirC = path.join(scratch, 'c');
    await fs.mkdir(dirC, { recursive: true });
    plus.state.accounts['other-uid'] = { ...plus.state.accounts[UID], uid: 'other-uid', email: 'other@example.invalid' };
    const c = makeSession(dirC);
    await c.secrets.set('plus', {
      refreshToken: plus.grantRefreshToken('other-uid'), uid: 'other-uid', email: 'other@example.invalid',
      tokenProjectId: 'test-project', apiKey: 'test-api-key', savedAt: new Date().toISOString(),
    });
    await c.session.init();
    const rev3 = startReviewPlusLogin({ session: c.session, env: REVIEW, log: () => {}, sleep: () => sleep(10) });
    t.ok('別のアカウントの保管のままでは uid を返さない', rev3.uid() === null);
    await rev3.ensure();
    t.ok('別のメールの保管は消して、審査用アカウントで入り直す', rev3.uid() === UID && c.session.snapshot().email === EMAIL);
    rev3.stop();

    // ---- B. 自動承認 -------------------------------------------------------------------------
    const relaySecret = crypto.randomBytes(32).toString('base64url');
    const verifier = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'test-project' });
    const authz = createPlusRelayAuthz({
      verify: token => verifier.verify(token), keysUrl: plus.ticketKeysUrl,
      isBound: async (uid, hostId) => plus.state.hosts[hostId]?.uid === uid,
    });
    const relay = createRelay({ enrollSecret: relaySecret, trustProxy: false, logger: () => {}, authz, admitPerMinute: 100 });
    const addr = await relay.listen(0, '127.0.0.1');
    const relayUrl = `http://127.0.0.1:${addr.port}`;
    const account = plus.state.accounts[UID];
    const plusConfig = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: scratch, appVersion: 'test' });
    const fakeSession = {
      snapshot: () => ({ signedIn: true, account }),
      getIdToken: async () => plus.issueIdToken(UID),
      client: createPlusClient({ config: plusConfig, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' }),
      setHost: () => {}, onChange: () => {},
    };
    const hosts = [];

    /** 1 つのホストを立てて、公式の中継へつなぐ（env と reviewPlusUid だけが違う） */
    async function startHost(label, env, reviewPlusUid) {
      const dataDir = path.join(scratch, label);
      const remote = createRemoteHost({ dataDir, cipher: plainCipher, target: () => ({ host: '127.0.0.1', port: 1 }), token: 'tok', env,
        backoff: { minMs: 60, maxMs: 200 }, log: () => {}, reviewPlusUid });
      const link = createPlusLink({ session: fakeSession, verifier, remote, log: () => {} });
      remote.setPlusProvider(link.provider);
      await remote.setSettings({ relayUrl, enrollSecret: relaySecret, enabled: true, hostName: label, plusConnect: true });
      const id = await remote.store.peekIdentity();
      plus.state.hosts[id.hostId] = { hostId: id.hostId, publicKey: id.publicKey, name: label, platform: 'linux', online: true, uid: UID, createdAt: new Date().toISOString(), deviceCount: 0 };
      link.update({ enabled: true, signedIn: true, uid: UID, accountStatus: 'plus', accountReadAt: Date.now(), connect: true, hostState: 'registered', limits: account.limits, relayUrl });
      remote.refreshPlus();
      await until(async () => (await remote.status()).links.plus?.state === 'connected', 20_000, `${label} が公式の中継につながる`);
      const h = { remote, id, label };
      hosts.push(h);
      return h;
    }
    const admit = (h, opts = {}) => admitDevice({ relayUrl, hostId: h.id.hostId, hostPublicKey: h.id.publicKey, idToken: plus.issueIdToken(UID), ...opts });

    // 審査用ホスト + 審査用アカウント: 承認の窓なし（裏のつなぎ直しでも、人が選んだつなぎでも）
    const review = await startHost('review-host', REVIEW, () => UID);
    const key1 = generateKeyPair();
    const r1 = await admit(review, { name: 'Reviewer iPad', platform: 'ios', keyPair: key1 });
    const dev1 = (await review.remote.store.devices()).find(d => d.id === r1.deviceId);
    t.ok('審査用ホスト: 審査用アカウントの初めての端末は、承認の窓なしで入る',
      Boolean(r1.deviceId) && /^[A-Za-z0-9_-]{43}$/.test(r1.token ?? '') && (await review.remote.status()).pairing.requests.length === 0, JSON.stringify(r1).slice(0, 120));
    t.ok('自動承認した端末は via:plus・plusUid・approvedBy: host で記録される', dev1?.via === 'plus' && dev1?.plusUid === UID && dev1?.approvedBy === 'host', JSON.stringify(dev1 && { v: dev1.via, p: dev1.plusUid, a: dev1.approvedBy }));
    const r1b = await admit(review, { name: 'Reviewer iPad', platform: 'ios', keyPair: key1 });
    t.ok('同じ鍵の 2 回目は同じ端末のまま（台数が増えない）', r1b.deviceId === r1.deviceId && (await review.remote.store.devices()).filter(d => d.via === 'plus').length === 1);
    const r2 = await admit(review, { name: 'Reviewer iPhone', platform: 'ios', mode: 'pair' });
    t.ok('人が選んだつなぎも、窓なしで入る', Boolean(r2.deviceId) && (await review.remote.status()).pairing.requests.length === 0, JSON.stringify(r2).slice(0, 120));
    const r3 = await admit(review, { name: 'Third', platform: 'ios' });
    t.ok('台数の上限（devicesPerHost）は守る', r3?.denied === true && r3?.reason === 'devices', JSON.stringify(r3));

    // 普段のホスト: reviewPlusUid が同じ uid を返しても、審査モードでなければ自動承認しない
    const normal = await startHost('normal-host', {}, () => UID);
    const n1 = await admit(normal, { name: 'Phone', platform: 'android' });
    t.ok('普段のホスト: 初めての端末は承認待ち（裏のつなぎ直しは denied approval）', n1?.denied === true && n1?.reason === 'approval' && (await normal.remote.store.devices()).length === 0, JSON.stringify(n1));
    t.ok('普段のホスト: 人が選んだつなぎは、今までどおり承認の窓に出る', await (async () => {
      const pending = admit(normal, { name: 'Phone', platform: 'android', mode: 'pair', pairTimeoutMs: 3000 }).catch(e => ({ error: String(e?.message ?? e) }));
      const req = await until(async () => (await normal.remote.status()).pairing.requests.find(r => r.via === 'plus'), 10_000, '承認の窓に出る');
      await normal.remote.deny(req.id);
      const res = await pending;
      return res?.denied === true && res?.reason === 'rejected';
    })());

    // 審査用ホストでも、審査用アカウントの uid と合わない（まだ入っていない・別のアカウント）なら自動承認しない
    const notYet = await startHost('review-not-signed-in', REVIEW, () => null);
    const o1 = await admit(notYet, { name: 'Phone', platform: 'ios' });
    t.ok('審査用ホストでも、審査用アカウントで入っていない間は自動承認しない', o1?.denied === true && o1?.reason === 'approval', JSON.stringify(o1));
    const otherUid = await startHost('review-other-uid', REVIEW, () => 'someone-else');
    const o2 = await admit(otherUid, { name: 'Phone', platform: 'ios' });
    t.ok('審査用ホストでも、uid が審査用アカウントと違えば自動承認しない', o2?.denied === true && o2?.reason === 'approval', JSON.stringify(o2));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
