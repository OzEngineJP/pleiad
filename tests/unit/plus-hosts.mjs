// この PC の Pleiad Plus への登録（core/plus/hosts.mjs、docs/plus.md）。
// fake の Plus（tests/lib/fake-plus.mjs。証明の照合も本物と同じ）に、登録・PATCH・誤りの扱いを確かめる。
// LLM も外のネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createPlusHost } from '../../core/plus/hosts.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { plainCipher } from '../../core/secret-store.mjs';
import { generateKeyPair, hostIdFor } from '../../core/remote/noise.mjs';
import crypto from 'node:crypto';

export const name = 'plus-hosts';
export const title = 'この PC の Pleiad Plus への登録: 証明つきの登録・同じ鍵なら PATCH・host_taken・host_limit・bad_proof の 1 回のやり直し・届かない・名前と端末数・つなぎ直し';

const UID = 'user-1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`);
    await sleep(30);
  }
}
const callsTo = (plus, method, prefix) => plus.state.calls.filter(c => c.method === method && c.path.startsWith(prefix));

/** session の身代わり（本物の client を使い、snapshot/setHost だけ差し替える）。 */
function fakeSession(plus, st, hostSeen) {
  return {
    snapshot: () => ({ signedIn: st.signedIn, account: st.signedIn ? st.account : null }),
    getIdToken: async () => plus.issueIdToken(st.account?.uid ?? UID),
    client: st.client,
    setHost: s => { st.hostState = s; hostSeen.push(s); },
    onChange: () => {},
  };
}

function deviceRecord(via = 'plus') {
  const keyPair = generateKeyPair();
  const token = crypto.randomBytes(32);
  return {
    id: `d${crypto.randomBytes(12).toString('base64url')}`,
    name: 'phone', platform: 'android', app: 'test',
    publicKey: keyPair.publicKey.toString('base64url'),
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    createdAt: new Date().toISOString(), lastSeenAt: null,
    ...(via ? { via, plusUid: UID } : {}),
  };
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-plus-hosts-')));
  const plus = await startFakePlus({ relayUrl: 'http://127.0.0.1:9' });
  plus.state.accounts[UID] = {
    uid: UID, email: 'u@example.test', provider: 'test', status: 'plus',
    plan: { id: 'plus', name: 'Plus' },
    limits: { hosts: 2, devicesPerHost: 4, sessionsPerHost: 2 },
    usage: { devices: 0, sessions: 0 }, sync: {},
  };
  const dataDir = path.join(scratch, 'data');
  const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir, appVersion: 'test' });
  const st = { signedIn: true, account: plus.state.accounts[UID], client: null, hostState: null };
  st.client = createPlusClient({ config, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' });
  const hostSeen = [];
  const session = fakeSession(plus, st, hostSeen);
  const remote = createRemoteHost({ dataDir, cipher: plainCipher, target: () => ({ host: '127.0.0.1', port: 1 }), token: 'tok', env: {}, backoff: { minMs: 30, maxMs: 60 }, log: () => {}, onIdentity: () => { void host.maybeRegister(); } });
  let nameNow = 'desk-b4';
  let devicesNow = 0;
  const host = createPlusHost({
    session, store: remote.store, appVersion: 'test', hostName: () => nameNow,
    plusDevices: () => devicesNow, retryMs: 40, log: () => {},
  });

  try {
    // ---- 新規登録（challenge → proof → PUT）
    await host.maybeRegister();
    const identity = await remote.store.peekIdentity();
    t.ok('ログインしていて plus なら、この PC を登録する（registered）', host.host().state === 'registered' && host.host().hostId === identity.hostId, JSON.stringify(host.host()));
    const rec = plus.state.hosts[identity.hostId];
    t.ok('台帳には名前・platform・公開鍵が載り、syncPublicKey は送らない',
      rec?.name === 'desk-b4' && rec?.publicKey === identity.publicKey.toString('base64url') && rec.syncPublicKey === null
      && ['win32', 'darwin', 'linux'].includes(rec?.platform), JSON.stringify(rec));
    t.ok('GET → challenge → PUT の順で呼ぶ',
      callsTo(plus, 'GET', '/v1/hosts').length === 1 && callsTo(plus, 'POST', '/v1/hosts/challenge').length === 1 && callsTo(plus, 'PUT', '/v1/hosts/').length === 1);
    t.ok('host の状態が session.setHost に渡る', hostSeen.at(-1).state === 'registered' && hostSeen.at(-1).hostId === identity.hostId);

    // ---- 同じ公開鍵なら PATCH だけ（無ければ何も送らない）
    const putBefore = callsTo(plus, 'PUT', '/v1/hosts/').length;
    await host.maybeRegister();
    t.ok('もう一度登録すると GET で照合するだけ（PUT は増えない）',
      callsTo(plus, 'PUT', '/v1/hosts/').length === putBefore && host.host().state === 'registered');
    nameNow = 'desk-renamed';
    await host.syncName();
    const lastPatch = callsTo(plus, 'PATCH', '/v1/hosts/').at(-1);
    t.ok('ホスト名が変わると PATCH { name } だけ送る', lastPatch !== undefined && plus.state.hosts[identity.hostId].name === 'desk-renamed');
    nameNow = 'desk-renamed';
    devicesNow = 2;
    await host.syncDeviceCount();
    t.ok('via:plus の端末数が変わると PATCH { deviceCount }', plus.state.hosts[identity.hostId].deviceCount === 2);

    // ---- bad_proof は新しい challenge で 1 回だけやり直す
    const hostId2 = identity.hostId;   // 同じ hostId を別 uid に取らせるため、まず台帳から外す
    delete plus.state.hosts[hostId2];
    plus.state.failNextProof = true;
    await host.maybeRegister();
    t.ok('bad_proof はやり直しで登録できる（challenge は 2 回）',
      host.host().state === 'registered' && callsTo(plus, 'POST', '/v1/hosts/challenge').length === 3 && Boolean(plus.state.hosts[hostId2]));

    // ---- host_taken（ほかのアカウントに同じ hostId）
    delete plus.state.hosts[hostId2];
    plus.state.hosts[hostId2] = { hostId: hostId2, publicKey: identity.publicKey.toString('base64url'), name: 'other', platform: 'linux', online: false, lastSeenAt: null, syncPublicKey: null, createdAt: new Date().toISOString(), deviceCount: 0, uid: 'other-user' };
    await host.maybeRegister();
    t.ok('409 host_taken は taken で止まり、自動ではやり直さない', host.host().state === 'taken' && host.host().error?.code === 'host_taken');
    const callsTaken = plus.state.calls.length;
    await sleep(150);
    t.ok('taken のあとは api を呼ばない（自動のやり直しをしない）', plus.state.calls.length === callsTaken);
    delete plus.state.hosts[hostId2];
    await host.maybeRegister();
    t.ok('取り消されればまた登録できる', host.host().state === 'registered');

    // ---- host_limit
    const otherKey = generateKeyPair();
    const otherId = hostIdFor(otherKey.publicKey);
    plus.state.hosts[otherId] = { hostId: otherId, publicKey: otherKey.publicKey.toString('base64url'), name: 'other', platform: 'linux', online: false, lastSeenAt: null, syncPublicKey: null, createdAt: new Date().toISOString(), deviceCount: 0, uid: UID };
    plus.state.accounts[UID].limits.hosts = 1;
    delete plus.state.hosts[identity.hostId];
    await host.maybeRegister();
    t.ok('429 host_limit は limit で止まる', host.host().state === 'limit' && host.host().error?.code === 'host_limit');
    plus.state.accounts[UID].limits.hosts = 2;
    delete plus.state.hosts[otherId];
    await host.maybeRegister();
    t.ok('上限が戻ればまた登録できる', host.host().state === 'registered');

    // ---- api に届かない → error で 1 分おき（試験では 40ms）にやり直す
    delete plus.state.hosts[identity.hostId];
    plus.state.down = true;
    await host.maybeRegister();
    t.ok('api に届かないときは error', host.host().state === 'error', JSON.stringify(host.host()));
    plus.state.down = false;
    await until(() => host.host().state === 'registered', 3000, '届くようになったらやり直して登録');

    // ---- 条件を満たさないときは何もしない
    st.signedIn = false;
    const callsBefore = plus.state.calls.length;
    await host.maybeRegister();
    t.ok('ログインしていなければ api を呼ばない', plus.state.calls.length === callsBefore);
    st.signedIn = true;

    // ---- つなぎ直し（plusHostRebind）: ホストの鍵を作り直し、端末を全部取り消し、登録し直す
    await remote.store.addDevice(deviceRecord('plus'));
    await remote.store.addDevice(deviceRecord('own'));
    await remote.setSettings({});   // deviceCache に読み込ませる
    const oldId = identity.hostId;
    const out = await remote.plusHostRebind();
      t.ok('つなぎ直すと hostId が変わり、端末は全部取り消される',
      out.hostId !== oldId && out.devices.length === 0 && (await remote.store.devices()).length === 0, out.hostId);
    await until(() => host.host().state === 'registered' && host.host().hostId === out.hostId, 3000, '新しい鍵で登録し直す');
    t.ok('新しい hostId が台帳に載る', Boolean(plus.state.hosts[out.hostId]), out.hostId);
  } finally {
    remote.stop();
    await plus.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
