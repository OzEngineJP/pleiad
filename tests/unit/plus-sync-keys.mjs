// 同期の鍵の始め方と受け渡し（core/plus/sync/keys.mjs、docs/plus.md「同期」）。偽の Plus（tests/lib/fake-plus.mjs）と本物の api の客で、
// 最初の 1 台・2 台目が待つ → 1 台目が渡す → 開ける・持つホストが居なくなったら作り直す・reset の 409 で読み直す・開けない包みで待ちのまま、を確かめる。
// 鍵を持たない PC はサーバーにデータがあれば黙って消さない（docs/plus.md「同期の始め直しと登録の外れ」）: 待つ・確かめの印・前の api も見る。
// LLM も外のネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { createSyncKeys, SYNC_ACCOUNT_KEY, SYNC_KEY_PAIR } from '../../core/plus/sync/keys.mjs';
import { newSyncKeyPair, wrapKey, KEY_ID_RX } from '../../core/plus/sync/crypto.mjs';

export const name = 'plus-sync-keys';
export const title = '同期の鍵: 最初の 1 台・2 台目が待つ → 渡す → 開ける・持つホストが居なくなったら作り直す・reset の 409 で読み直す・開けない包みで待つ・データがあれば確かめるまで消さない';

let hostSeq = 0;

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ps-keys-')));
  const plus = await startFakePlus({ relayUrl: 'http://127.0.0.1:9' });
  // 券を知らない前の版の api の流れ（券・承認のある v2 の流れは plus-sync-admission）
  plus.state.noTickets = true;
  const account = uid => {
    plus.state.accounts[uid] = { uid, email: 'user@example.com', provider: 'test', status: 'plus', plan: { id: 'plus', name: 'Plus' }, limits: null, usage: null, sync: {} };
  };
  const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: path.join(scratch, 'cfg'), appVersion: 'test' });

  /** 台帳に載ったホスト 1 台（自分の secret-store・keys）。syncPublicKey は keys の公開鍵 */
  async function makeHost(uid, label, { wrapClient } = {}) {
    const hostId = `host-${label}`;
    const logs = [];
    const shared = [];
    const secrets = createSecretStore({ file: path.join(scratch, `${uid}-${label}`, 'plus-secrets.json'), cipher: plainCipher });
    const base = createPlusClient({ config, getIdToken: async () => plus.issueIdToken(uid), appVersion: 'test' });
    const client = wrapClient ? wrapClient(base) : base;
    const keys = createSyncKeys({ client, secrets, uid: () => uid, hostId: () => hostId, log: line => logs.push(line), onShared: to => shared.push(to) });
    plus.state.hosts[hostId] = {
      hostId, uid, publicKey: 'not-used', name: label, platform: 'linux', online: false, lastSeenAt: null,
      syncPublicKey: await keys.publicKey(), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++hostSeq)).toISOString(), deviceCount: 0,
    };
    return { hostId, keys, secrets, logs, shared };
  }
  const resets = () => plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').length;
  /** 墓標でない項目を 1 つ台帳に置く（ほかの PC が同期したデータの代わり） */
  function putItem(uid, id, size = 4096) {
    const s = plus.state.sync[uid];
    s.items[id] = { rev: 1, seq: ++s.seq, keyId: s.keyId, ciphertext: 'v1.x.AAAAAAAAAAAAAAAA.AA', deleted: false, size, updatedAt: new Date().toISOString(), updatedBy: null };
    s.totalBytes += size;
    s.lastWriteAt = s.items[id].updatedAt;
  }

  try {
    const UID = 'test-user';
    account(UID);

    // ---- 最初の 1 台
    const a = await makeHost(UID, 'a');
    const pairBefore = await a.secrets.get(SYNC_KEY_PAIR);
    const r1 = await a.keys.setup();
    const ledger = plus.state.sync[UID];
    t.ok('最初の 1 台は K を作り、自分宛てに包んで reset する（ready・changed）',
      r1.status === 'ready' && r1.changed === true && KEY_ID_RX.test(r1.key.keyId) && ledger.keyId === r1.key.keyId && ledger.keys[a.hostId]?.wrappedBy === a.hostId, JSON.stringify({ status: r1.status, ledger }));
    const firstReset = plus.state.syncBodies.find(b => b.path === '/v1/sync/reset');
    t.ok('最初の reset の previousKeyId は null', JSON.parse(firstReset.body).previousKeyId === null);
    const stored = await a.secrets.get(SYNC_ACCOUNT_KEY);
    t.ok('K は手元の plus:syncAccountKey に { keyId, key } で保管する', stored?.keyId === r1.key.keyId && Buffer.from(stored.key, 'base64url').equals(r1.key.key));
    t.ok('ホストの同期の鍵対（plus:syncKey）は始め方で作り替えない', pairBefore && JSON.stringify(await a.secrets.get(SYNC_KEY_PAIR)) === JSON.stringify(pairBefore));
    t.ok('台帳の syncPublicKey は plus:syncKey の公開鍵', plus.state.hosts[a.hostId].syncPublicKey === pairBefore.publicKey);
    const again = await a.keys.setup();
    t.ok('手元の keyId が同じならそのまま使う（changed: false・reset しない）',
      again.status === 'ready' && again.changed === false && again.key.key.equals(r1.key.key) && plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').length === 1);

    // ---- 2 台目は待つ → 1 台目が渡す → 開ける
    const b = await makeHost(UID, 'b');
    const w1 = await b.keys.setup();
    t.ok('2 台目は自分宛てが無いので待つ（waiting_key）', w1.status === 'waiting_key' && !(await b.secrets.get(SYNC_ACCOUNT_KEY)));
    t.ok('state.pending に 2 台目が載る', w1.state?.pending?.includes(b.hostId) === true, JSON.stringify(w1.state));
    const share = await a.keys.sharePending(w1.state, again.key);
    t.ok('1 台目が宛ての無いホストに包んで渡す（PUT /v1/sync/keys/{T}）',
      share === 'ok' && ledger.keys[b.hostId]?.wrappedBy === a.hostId && ledger.keys[b.hostId]?.keyId === r1.key.keyId && a.logs.includes('sync key shared'));
    const r2 = await b.keys.setup();
    t.ok('2 台目は 1 台目の公開鍵で開いて同じ K を持つ（changed: true）', r2.status === 'ready' && r2.changed === true && r2.key.key.equals(r1.key.key) && r2.key.keyId === r1.key.keyId);
    const stateAfter = await createPlusClient({ config, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' }).request('GET', '/v1/sync/state');
    t.ok('渡したあとは pending から外れ、hostsWithKey に 2 台とも載る', stateAfter.pending.length === 0 && stateAfter.hostsWithKey.join() === [a.hostId, b.hostId].join(), JSON.stringify(stateAfter));
    t.ok('渡すと onShared に渡した先（hostId・名前）を知らせる', a.shared.length === 1 && a.shared[0].hostId === b.hostId && a.shared[0].name === 'b', JSON.stringify(a.shared));

    // ---- 開けない包み → 待ちのまま
    const c = await makeHost(UID, 'c');
    const stranger = newSyncKeyPair();
    ledger.keys[c.hostId] = {
      keyId: ledger.keyId, wrappedBy: a.hostId,
      wrapped: wrapKey({ key: r1.key.key, keyId: ledger.keyId, uid: UID, privateKey: stranger.privateKey, publicKey: stranger.publicKey, targetPublicKey: Buffer.from(plus.state.hosts[c.hostId].syncPublicKey, 'base64url'), targetHostId: c.hostId }),
    };
    const w2 = await c.keys.setup();
    t.ok('開けない包み（wrappedBy の公開鍵で開けない）なら使わずに待つ', w2.status === 'waiting_key' && !(await c.secrets.get(SYNC_ACCOUNT_KEY)));
    t.ok('ログに sync key unwrap failed を出す', c.logs.includes('sync key unwrap failed'));

    // ---- 鍵を持つホストが居なくなったら作り直す
    const resetsBefore = plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').length;
    const oldKeyId = ledger.keyId;
    ledger.items.fakeItemIdForTheWipeCheck = { rev: 1, seq: 1, keyId: oldKeyId, ciphertext: null, deleted: true, size: 0, updatedAt: null };
    delete ledger.keys[c.hostId];
    delete plus.state.hosts[a.hostId]; delete ledger.keys[a.hostId];
    const w3 = await c.keys.setup();
    t.ok('まだ鍵を持つホスト（b）が台帳に居れば作り直さずに待つ', w3.status === 'waiting_key' && plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').length === resetsBefore);
    t.ok('待つ間の wait に、鍵を持つ PC（b・台帳に居る）を載せる',
      w3.wait?.holder === true && w3.wait.holders.some(h => h.hostId === b.hostId && h.registered === true && h.name === 'b'), JSON.stringify(w3.wait));
    delete plus.state.hosts[b.hostId];
    const r3 = await c.keys.setup();
    const lastReset = JSON.parse(plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').at(-1).body);
    t.ok('持つホストが台帳に 1 台も居なく、項目も無ければ（墓標だけ）確かめずに作り直す（previousKeyId は今の keyId）',
      r3.status === 'ready' && r3.changed === true && r3.key.keyId !== oldKeyId && lastReset.previousKeyId === oldKeyId && ledger.keyId === r3.key.keyId);
    t.ok('作り直すと前の項目は消える', Object.keys(plus.state.sync[UID].items).length === 0);

    // ---- reset の 409 conflict（previousKeyId）→ 読み直す
    const UID2 = 'test-user-2';
    account(UID2);
    const d = await makeHost(UID2, 'd');
    let raced = null;
    const e = await makeHost(UID2, 'e', {
      wrapClient: base => ({
        request: async (method, p, opts) => {
          if (method === 'POST' && p === '/v1/sync/reset' && !raced) {
            raced = 'pending';
            await d.keys.setup();   // ほかの PC が先に作った
            try { return await base.request(method, p, opts); }
            catch (err) { raced = `${err.status} ${err.code} ${err.message}`; throw err; }
          }
          return base.request(method, p, opts);
        },
      }),
    });
    const w4 = await e.keys.setup();
    t.ok('同時に 2 台が作ると、遅れた方は 409 conflict（previousKeyId）を受ける', raced === '409 conflict previousKeyId', String(raced));
    t.ok('409 のあと state を読み直し、先に作った鍵を待つ（自分の K は保管しない）', w4.status === 'waiting_key' && !(await e.secrets.get(SYNC_ACCOUNT_KEY)) && plus.state.sync[UID2].keyId === (await d.secrets.get(SYNC_ACCOUNT_KEY)).keyId);
    const dKey = await d.keys.setup();
    await d.keys.sharePending(dKey.state, dKey.key);
    const r4 = await e.keys.setup();
    t.ok('先に作った方から渡されると開ける', r4.status === 'ready' && r4.key.key.equals(dKey.key.key));

    // ---- 同期をやり直す（forceNew）
    const before = plus.state.sync[UID2].keyId;
    const r5 = await d.keys.setup({ forceNew: true });
    const forced = JSON.parse(plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').at(-1).body);
    t.ok('やり直しは新しい K で reset する（previousKeyId は今の keyId）', r5.status === 'ready' && r5.changed === true && r5.key.keyId !== before && forced.previousKeyId === before);
    const r6 = await e.keys.setup();
    t.ok('やり直したあと、ほかのホストはまた待つ', r6.status === 'waiting_key');

    // ---- 同期を切っている
    plus.state.accounts[UID2].sync = { enabled: false };
    const off = await d.keys.setup();
    t.ok('enabled が false なら何もしない（disabled）', off.status === 'disabled');
    plus.state.accounts[UID2].sync = {};

    // ---- ログアウト
    await d.keys.forget();
    t.ok('ログアウトで plus:syncAccountKey を消し、plus:syncKey は残す', !(await d.secrets.get(SYNC_ACCOUNT_KEY)) && Boolean((await d.secrets.get(SYNC_KEY_PAIR))?.privateKey));

    // ---- サーバーにデータがあり、鍵を持つ PC が外れた（docs/plus.md「同期の始め直しと登録の外れ」）
    const UID3 = 'test-user-3';
    account(UID3);
    const f = await makeHost(UID3, 'f');
    const fKey = await f.keys.setup();
    putItem(UID3, 'item-f-1');
    putItem(UID3, 'item-f-2', 1024);
    const g = await makeHost(UID3, 'g');
    const gw1 = await g.keys.setup();
    t.ok('鍵を持つ PC（f）が居れば待ち、wait に件数・大きさ・その PC を載せる',
      gw1.status === 'waiting_key' && gw1.wait?.holder === true && gw1.wait.itemCount === 2 && gw1.wait.totalBytes === 5120 && gw1.wait.holders[0]?.hostId === f.hostId, JSON.stringify(gw1.wait));
    plus.unbindHost(f.hostId, 'admin');
    const gResets = resets();
    const gw2 = await g.keys.setup();
    t.ok('鍵を持つ PC が外れても、データがあれば作り直さずに待つ（reset を送らない）', gw2.status === 'waiting_key' && resets() === gResets && plus.state.sync[UID3].keyId === fKey.key.keyId);
    t.ok('wait は holder: false で、外れた PC を registered: false・名前つきで載せる',
      gw2.wait?.holder === false && gw2.wait.holders.length === 1 && gw2.wait.holders[0].hostId === f.hostId && gw2.wait.holders[0].registered === false && gw2.wait.holders[0].name === 'f', JSON.stringify(gw2.wait));
    t.ok('wait に keyId・itemCount・totalBytes・updatedAt を載せる',
      gw2.wait.keyId === fKey.key.keyId && gw2.wait.itemCount === 2 && gw2.wait.totalBytes === 5120 && typeof gw2.wait.updatedAt === 'string');
    // 人の確かめ無しの「やり直す」→ api が 409 reset_confirm で断り、何も消えない
    const gc1 = await g.keys.setup({ forceNew: true });
    t.ok('確かめ無しのやり直しは confirm_needed（何も消えない）',
      gc1.status === 'confirm_needed' && gc1.wait?.itemCount === 2 && gc1.wait.keyId === fKey.key.keyId && Object.keys(plus.state.sync[UID3].items).length === 2 && plus.state.sync[UID3].keyId === fKey.key.keyId, JSON.stringify(gc1));
    // 確かめの窓を開いている間に件数が変わった → 古い件数の confirm は断られ、新しい値が返る
    putItem(UID3, 'item-f-3', 512);
    const gc2 = await g.keys.setup({ forceNew: true, confirm: { keyId: fKey.key.keyId, itemCount: 2 } });
    t.ok('見た件数が今と違えば confirm_needed で、wait は新しい件数', gc2.status === 'confirm_needed' && gc2.wait?.itemCount === 3 && gc2.wait.totalBytes === 5632 && Object.keys(plus.state.sync[UID3].items).length === 3, JSON.stringify(gc2.wait));
    const sentConfirm = JSON.parse(plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').at(-1).body).confirm;
    t.ok('reset の本文に confirm { keyId, itemCount } を付ける', sentConfirm?.keyId === fKey.key.keyId && sentConfirm.itemCount === 2, JSON.stringify(sentConfirm));
    // 前の版のアプリ（reset の本文に confirm が無い）: 鍵を持たない PC の reset は 409 reset_confirm で断られ、何も消えない
    const oldErrs = [];
    const o = await makeHost(UID3, 'o-old-app', { wrapClient: base => ({
      async request(method, p, opts) {
        if (p === '/v1/sync/reset' && opts?.body) { const { confirm: _drop, ...rest } = opts.body; opts = { ...opts, body: rest }; }
        try { return await base.request(method, p, opts); } catch (e) { oldErrs.push(e); throw e; }
      },
    }) });
    await o.keys.setup({ forceNew: true, confirm: { keyId: gc2.wait.keyId, itemCount: gc2.wait.itemCount } });
    t.ok('confirm を送らない前の版の reset は 409 reset_confirm（今の値つき）で、項目も keyId も残る',
      oldErrs.at(-1)?.status === 409 && oldErrs.at(-1).code === 'reset_confirm' && oldErrs.at(-1).body?.error?.itemCount === 3
      && Object.keys(plus.state.sync[UID3].items).length === 3 && plus.state.sync[UID3].keyId === fKey.key.keyId,
      JSON.stringify({ status: oldErrs.at(-1)?.status, code: oldErrs.at(-1)?.code, body: oldErrs.at(-1)?.body }));
    const gr = await g.keys.setup({ forceNew: true, confirm: { keyId: gc2.wait.keyId, itemCount: gc2.wait.itemCount } });
    t.ok('今の件数で確かめれば作り直し、項目と鍵の行を消す',
      gr.status === 'ready' && gr.changed === true && gr.key.keyId !== fKey.key.keyId && Object.keys(plus.state.sync[UID3].items).length === 0 && Object.keys(plus.state.sync[UID3].keys).join() === g.hostId);
    // 項目が 1 つも無いアカウントは、鍵を持つ PC が居なければ確かめずに作り直す
    const UID4 = 'test-user-4';
    account(UID4);
    const h1 = await makeHost(UID4, 'h1');
    const h1Key = await h1.keys.setup();
    plus.unbindHost(h1.hostId, 'admin');
    const h2 = await makeHost(UID4, 'h2');
    const h2r = await h2.keys.setup();
    t.ok('項目が 0 件なら、鍵を持つ PC が外れていても確かめずに作り直す', h2r.status === 'ready' && h2r.key.keyId !== h1Key.key.keyId);

    // ---- 前の版の api（itemCount などを返さない・外すと鍵の行を消す）
    const UID5 = 'test-user-5';
    account(UID5);
    const p1 = await makeHost(UID5, 'p1');
    const p1Key = await p1.keys.setup();
    putItem(UID5, 'item-p-1');
    plus.state.legacySync = true;
    plus.unbindHost(p1.hostId, 'admin');
    const p2 = await makeHost(UID5, 'p2');
    const pResets = resets();
    const pw = await p2.keys.setup();
    t.ok('前の api では件数が分からないので、鍵を持つ PC が居なくても自分からは作り直さない',
      pw.status === 'waiting_key' && resets() === pResets && pw.wait?.itemCount === null && pw.wait.holder === false && plus.state.sync[UID5].keyId === p1Key.key.keyId, JSON.stringify(pw.wait));
    const pr = await p2.keys.setup({ forceNew: true });
    t.ok('前の api でも、人の「やり直す」なら作り直せる（confirm は送らない）',
      pr.status === 'ready' && pr.key.keyId !== p1Key.key.keyId && !('confirm' in JSON.parse(plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').at(-1).body)));
    plus.state.legacySync = false;

    // ---- 鍵は api に届かない
    const keysSeen = [r1.key.key, r3.key.key, dKey.key.key, r5.key.key].flatMap(k => [k.toString('base64url'), k.toString('base64'), k.toString('hex')]);
    const privs = [];
    for (const h of [a, b, c, d, e]) privs.push((await h.secrets.get(SYNC_KEY_PAIR)).privateKey);
    const wire = JSON.stringify(plus.state.syncBodies) + JSON.stringify(plus.state.calls) + JSON.stringify(plus.state.sync) + JSON.stringify(plus.state.hosts);
    t.ok('K（どの形でも）とホストの秘密鍵は、偽の api の受けた本文・台帳に 1 つも出ない', [...keysSeen, ...privs].every(s => !wire.includes(s)));
  } finally {
    await plus.close?.();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
