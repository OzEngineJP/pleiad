// 同期の鍵の始め方と受け渡し（core/plus/sync/keys.mjs、docs/plus.md「同期」）。偽の Plus（tests/lib/fake-plus.mjs）と本物の api の客で、
// 最初の 1 台・2 台目が待つ → 1 台目が渡す → 開ける・持つホストが居なくなったら作り直す・reset の 409 で読み直す・開けない包みで待ちのまま、を確かめる。
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
export const title = '同期の鍵: 最初の 1 台・2 台目が待つ → 渡す → 開ける・持つホストが居なくなったら作り直す・reset の 409 で読み直す・開けない包みで待つ';

let hostSeq = 0;

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ps-keys-')));
  const plus = await startFakePlus({ relayUrl: 'http://127.0.0.1:9' });
  const account = uid => {
    plus.state.accounts[uid] = { uid, email: 'user@example.com', provider: 'test', status: 'plus', plan: { id: 'plus', name: 'Plus' }, limits: null, usage: null, sync: {} };
  };
  const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: path.join(scratch, 'cfg'), appVersion: 'test' });

  /** 台帳に載ったホスト 1 台（自分の secret-store・keys）。syncPublicKey は keys の公開鍵 */
  async function makeHost(uid, label, { wrapClient } = {}) {
    const hostId = `host-${label}`;
    const logs = [];
    const secrets = createSecretStore({ file: path.join(scratch, `${uid}-${label}`, 'plus-secrets.json'), cipher: plainCipher });
    const base = createPlusClient({ config, getIdToken: async () => plus.issueIdToken(uid), appVersion: 'test' });
    const client = wrapClient ? wrapClient(base) : base;
    const keys = createSyncKeys({ client, secrets, uid: () => uid, hostId: () => hostId, log: line => logs.push(line) });
    plus.state.hosts[hostId] = {
      hostId, uid, publicKey: 'not-used', name: label, platform: 'linux', online: false, lastSeenAt: null,
      syncPublicKey: await keys.publicKey(), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++hostSeq)).toISOString(), deviceCount: 0,
    };
    return { hostId, keys, secrets, logs };
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
    delete plus.state.hosts[b.hostId];
    const r3 = await c.keys.setup();
    const lastReset = JSON.parse(plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').at(-1).body);
    t.ok('持つホストが台帳に 1 台も居なければ作り直す（previousKeyId は今の keyId）',
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
