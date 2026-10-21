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
export const title = 'この PC の Pleiad Plus への登録: 証明つきの登録・同じ鍵なら PATCH・host_taken・host_limit・bad_proof の 1 回のやり直し・届かない・名前と端末数・つなぎ直し・登録の外れ';

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
/** 約束を待つ。来ないときだけ ms で落とす（通るときは実時間に頼らない） */
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} が ${ms}ms で終わらない`)), ms); })]);
  } finally { clearTimeout(timer); }
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
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plus-hosts-')));
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
    t.ok('台帳には名前・platform・公開鍵が載り、同期の公開鍵を渡さなければ syncPublicKey は送らない',
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

    // ---- 同期の公開鍵（syncPublicKey）: 前の版の api（受け入れの v2 を知らない）には、載せずに登録済みなら PATCH で足し、
    //      新規の登録なら PUT に載せる。ここから 30 分ごとの見直しまでは前の版の api のふり（v2 は最後に確かめる）
    plus.state.noTickets = true;
    const syncPub = generateKeyPair().publicKey.toString('base64url');
    const withSync = createPlusHost({
      session, store: remote.store, appVersion: 'test', hostName: () => nameNow,
      plusDevices: () => devicesNow, retryMs: 40, log: () => {}, syncPublicKey: async () => syncPub,
    });
    const putBeforeSync = callsTo(plus, 'PUT', '/v1/hosts/').length;
    await withSync.maybeRegister();
    t.ok('登録済みで syncPublicKey が無ければ PATCH { syncPublicKey } で足す（PUT は増えない）',
      plus.state.hosts[identity.hostId].syncPublicKey === syncPub && callsTo(plus, 'PUT', '/v1/hosts/').length === putBeforeSync);
    const patchesBefore = callsTo(plus, 'PATCH', '/v1/hosts/').length;
    await withSync.maybeRegister();
    t.ok('同じ syncPublicKey なら PATCH しない', callsTo(plus, 'PATCH', '/v1/hosts/').length === patchesBefore);
    delete plus.state.hosts[identity.hostId];
    await withSync.maybeRegister();
    t.ok('新規の登録では PUT に syncPublicKey を載せる',
      plus.state.hosts[identity.hostId]?.syncPublicKey === syncPub && callsTo(plus, 'PUT', '/v1/hosts/').length === putBeforeSync + 1);

    // ---- bad_proof は新しい challenge で 1 回だけやり直す
    const hostId2 = identity.hostId;   // 同じ hostId を別 uid に取らせるため、まず台帳から外す
    delete plus.state.hosts[hostId2];
    plus.state.failNextProof = true;
    const challengesBefore = callsTo(plus, 'POST', '/v1/hosts/challenge').length;
    await host.maybeRegister();
    t.ok('bad_proof はやり直しで登録できる（challenge は 2 回）',
      host.host().state === 'registered' && callsTo(plus, 'POST', '/v1/hosts/challenge').length === challengesBefore + 2 && Boolean(plus.state.hosts[hostId2]));

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

    // ---- 登録の外れ（docs/plus.md「同期の始め直しと登録の外れ」）
    const hid = host.host().hostId;
    const puts = () => callsTo(plus, 'PUT', '/v1/hosts/').length;
    const putsBefore = puts();
    await host.recheck();
    t.ok('台帳に自分が居れば recheck は登録し直さない', puts() === putsBefore && host.host().state === 'registered' && !host.host().notice);
    // 運営が外した → 確かめ直して登録し直す（鍵の行が戻る）
    plus.state.sync[UID] = { keyId: 'key-1', keys: { [hid]: { keyId: 'key-1', wrapped: 'w', wrappedBy: hid } }, items: {}, seq: 0, totalBytes: 0 };
    const hidName = plus.state.hosts[hid].name;
    plus.unbindHost(hid, 'admin');
    t.ok('外すと鍵の行は消えず、detachedAt と名前が付く', Boolean(plus.state.sync[UID].keys[hid]?.detachedAt) && plus.state.sync[UID].keys[hid].name === hidName);
    await host.recheck();
    t.ok('運営が外した PC は recheck で登録し直す', plus.state.hosts[hid]?.uid === UID && host.host().state === 'registered', JSON.stringify(host.host()));
    t.ok('外れていたのを登録し直したら notice: reregistered', host.host().notice === 'reregistered');
    t.ok('登録し直すと外した記録（removed）は消える', !plus.state.hostsRemoved[hid]);
    t.ok('登録し直すと鍵の行が戻る（detachedAt が外れ、同じ包みのまま）', plus.state.sync[UID].keys[hid]?.detachedAt === null && plus.state.sync[UID].keys[hid].wrapped === 'w');
    // 利用者が外した → 登録し直さず removed で待つ
    await st.client.request('DELETE', `/v1/hosts/${hid}`);
    t.ok('利用者の DELETE は removed に by: user で残る', plus.state.hostsRemoved[hid]?.by === 'user');
    await host.recheck();
    t.ok('利用者が外した PC は recheck で登録し直さず removed で待つ',
      !plus.state.hosts[hid] && host.host().state === 'removed' && host.host().error?.code === 'host_removed', JSON.stringify(host.host()));
    await host.maybeRegister();
    t.ok('removed の間は、条件の見直し（maybeRegister）でも登録し直さない', !plus.state.hosts[hid] && host.host().state === 'removed');
    await host.reregister();
    t.ok('人の「この PC を登録し直す」（reregister）なら登録する', plus.state.hosts[hid]?.uid === UID && host.host().state === 'registered' && !plus.state.hostsRemoved[hid]);
    t.ok('利用者が外した PC も、登録し直せば鍵の行が戻る', plus.state.sync[UID].keys[hid]?.detachedAt === null);
    // 台帳の removed を返さない前の api: 外れていたら登録し直す
    plus.state.legacySync = true;
    plus.unbindHost(hid, 'user');
    await host.recheck();
    t.ok('前の api（removed を返さない）では、外れていたら登録し直す', plus.state.hosts[hid]?.uid === UID && host.host().state === 'registered');
    plus.state.legacySync = false;

    // ---- 30 分ごとの見直し（タイマーは差し替え、試験から刻む。実時間は待たない）
    const intervals = [];
    let onTimedState = () => {};
    const timed = createPlusHost({
      session, store: remote.store, appVersion: 'test', hostName: () => nameNow,
      plusDevices: () => devicesNow, retryMs: 40, log: () => {}, onHostState: s => onTimedState(s),
      timers: { setTimeout, clearTimeout, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; } },
    });
    await timed.maybeRegister();
    t.ok('登録すると 30 分ごとの見直しのタイマーを 1 つ張る', intervals.length === 1 && intervals[0].ms === 30 * 60_000, JSON.stringify(intervals.map(i => i.ms)));
    plus.unbindHost(hid, 'admin');
    // 刻んだ見直しが登録し直して、この PC の側の状態が変わるのを待つ（台帳の側は PUT の応答より先に変わる）
    const reregistered = new Promise(resolve => { onTimedState = s => { if (s.state === 'registered' && s.notice === 'reregistered') resolve(s); }; });
    intervals[0].fn();
    await withTimeout(reregistered, 10_000, '見直しで外れに気付いて登録し直す');
    t.ok('登録したあとは recheckMs ごとに見直し、外れていたら登録し直す',
      plus.state.hosts[hid]?.uid === UID && timed.host().state === 'registered' && timed.host().notice === 'reregistered', JSON.stringify(timed.host()));

    // ---- v2 の api（受け入れの版 2）: 同期の公開鍵は台帳の登録に載せない。外された PC は同じ鍵で戻れない
    plus.state.noTickets = false;
    const v2 = createPlusHost({
      session, store: remote.store, appVersion: 'test', hostName: () => nameNow,
      plusDevices: () => devicesNow, retryMs: 40, log: () => {}, syncPublicKey: async () => syncPub, apiAdmission: async () => 2,
    });
    plus.state.hosts[hid].syncPublicKey = null;
    const v2Patches = callsTo(plus, 'PATCH', '/v1/hosts/').length;
    await v2.maybeRegister();
    t.ok('v2 の api には、登録済みでも PATCH で同期の公開鍵を足さない',
      v2.host().state === 'registered' && plus.state.hosts[hid].syncPublicKey === null && callsTo(plus, 'PATCH', '/v1/hosts/').length === v2Patches);
    // admission の覚えが古い（前の版と読んでいた）: 400 bad_request syncPublicKey を受けたら、載せずにやり直す
    const stale = createPlusHost({
      session, store: remote.store, appVersion: 'test', hostName: () => nameNow,
      plusDevices: () => devicesNow, retryMs: 40, log: () => {}, syncPublicKey: async () => syncPub, apiAdmission: async () => null,
    });
    await stale.maybeRegister();
    t.ok('admission の覚えが古くても、400 syncPublicKey で載せずにやり直して登録のまま',
      stale.host().state === 'registered' && plus.state.hosts[hid].syncPublicKey === null);
    const stalePatches = callsTo(plus, 'PATCH', '/v1/hosts/').length;
    await stale.maybeRegister();
    t.ok('一度断られたら、その後は同期の公開鍵を送らない', callsTo(plus, 'PATCH', '/v1/hosts/').length === stalePatches);
    // 運営が外した: v2 では誰が外しても戻れない（登録し直さず removed・permanent で待つ）
    plus.unbindHost(hid, 'admin');
    const v2Puts = puts();
    await v2.recheck();
    t.ok('v2 の api では、運営が外した PC も登録し直さず removed（permanent）で待つ',
      v2.host().state === 'removed' && v2.host().error?.permanent === true && puts() === v2Puts && !plus.state.hosts[hid], JSON.stringify(v2.host()));
    await v2.reregister();
    t.ok('v2 の api では「この PC を登録し直す」でも同じ鍵では戻らない（PUT を送らない）',
      v2.host().state === 'removed' && v2.host().error?.permanent === true && puts() === v2Puts && !plus.state.hosts[hid]);
    // api の版を知らない（admission を読めない）PC でも、PUT の 403 host_removed で同じく止まり、やり直しの時計を回さない
    await host.reregister();
    t.ok('PUT の 403 host_removed は removed（permanent）で止まる',
      host.host().state === 'removed' && host.host().error?.code === 'host_removed' && host.host().error?.permanent === true, JSON.stringify(host.host()));
    const afterRemoved = plus.state.calls.length;
    await sleep(150);
    t.ok('403 host_removed のあとは自動でやり直さない', plus.state.calls.length === afterRemoved);
    // 戻すのは人の「つなぎ直す」（ホストの鍵を作り直す → 新しい hostId）
    const rebound = await remote.plusHostRebind();
    await until(() => host.host().state === 'registered' && host.host().hostId === rebound.hostId, 3000, 'つなぎ直して新しい鍵で登録する');
    t.ok('外された PC は、つなぎ直すと新しい hostId で登録できる', rebound.hostId !== hid && plus.state.hosts[rebound.hostId]?.uid === UID);
  } finally {
    remote.stop();
    await plus.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
