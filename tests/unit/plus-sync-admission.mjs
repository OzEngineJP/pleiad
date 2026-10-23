// 同期の鍵の受け渡しの承認（core/plus/sync/keys.mjs・ticket.mjs・engine.mjs、docs/plus.md「同期の鍵の受け渡し」）。
// 偽の Plus（tests/lib/fake-plus.mjs）の v2 の口（同期の券・申し込み・同期のリセット）と本物の api の客で、
// 承認を通した受け渡し・確認コード・断る・承認の途中から戻る・PC を外したときの作り直し（carry）・同期のリセット・前の版の K からの移行・
// 券の取り直し・券の口の無い api（今の流れのまま）・426 で更新を促す、を確かめる。
// 承認の無い受け渡し・鍵を持たない PC の始め直し・外した PC の読み出しが断られることも見る。
// サーバーが渡す包みをそのまま受けないこと（承認した PC 以外の包み・台帳の公開鍵のすり替え・前の K の印の無い包み・
// 前の K では確かめられない新しい K へは人が選ぶまで移らない）と、券を取れたアカウントで前の版の api に戻されたら止めることも見る。
// ログアウト（forget）で K を消した後も、覚えた指紋か自分で包んだ包みで戻れること（指紋と違う K・承認していない PC の包みは受けない）も見る。
// LLM も外のネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { fakeClock } from '../lib/fake-clock.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { createSyncKeys, SYNC_JOIN, SYNC_ACCOUNT_KEY, SYNC_CARRY, SYNC_V2_FINGERPRINTS } from '../../core/plus/sync/keys.mjs';
import { createSyncTicket } from '../../core/plus/sync/ticket.mjs';
import { createSyncTargets } from '../../core/plus/sync/targets.mjs';
import { createSyncEngine } from '../../core/plus/sync/engine.mjs';
import { b64url, newAccountKey, resetKeyPair, resetMessage, wrapKey, newSyncKeyPair } from '../../core/plus/sync/crypto.mjs';
import { generateKeyPair, hostIdFor } from '../../core/remote/noise.mjs';

export const name = 'plus-sync-admission';
export const title = '同期の鍵の受け渡しの承認: 確認コード・断る・承認の途中から戻る・外した PC の締め出しと作り直し・届いた包みの確かめ・リセット・移行・券・前の版の api・426';

const T0 = Date.parse('2026-03-01T00:00:00.000Z');
let hostSeq = 0;

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ps-adm-')));
  const plus = await startFakePlus({ relayUrl: 'http://127.0.0.1:9' });
  const account = uid => {
    plus.state.accounts[uid] = { uid, email: 'user@example.com', provider: 'test', status: 'plus', plan: { id: 'plus', name: 'Plus' }, limits: null, usage: null, sync: {} };
  };
  const config = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: path.join(scratch, 'cfg'), appVersion: 'test' });
  const engines = [];

  /**
   * 台帳に載った PC 1 台（ホストの鍵・自分の secret-store・券・keys）。tokenExtra を変えると ID トークンの欄が変わる（最近のログインの試験）。
   * ticket: false なら券を使わない前の版のクライアント。syncKey: true なら登録に同期の公開鍵を載せる（前の版の api の登録）
   */
  async function makeHost(uid, label, { ticket: useTicket = true, syncKey = !useTicket } = {}) {
    const id = generateKeyPair();
    const hostId = hostIdFor(id.publicKey);
    const identity = { hostId, publicKey: id.publicKey, privateKey: id.privateKey };
    const logs = [];
    const shared = [];
    const h = { label, hostId, identity, logs, shared, tokenExtra: {} };
    const secrets = createSecretStore({ file: path.join(scratch, `${uid}-${label}`, 'plus-secrets.json'), cipher: plainCipher });
    const client = createPlusClient({ config, getIdToken: async () => plus.issueIdToken(uid, h.tokenExtra), appVersion: 'test' });
    const ticket = useTicket ? createSyncTicket({ client, identity: async () => identity }) : null;
    const keys = createSyncKeys({ client, ticket, secrets, uid: () => uid, hostId: () => hostId, log: line => logs.push(line), onShared: to => shared.push(to) });
    plus.state.hosts[hostId] = {
      hostId, uid, publicKey: b64url(id.publicKey), name: label, platform: 'linux', online: false, lastSeenAt: null,
      syncPublicKey: syncKey ? await keys.publicKey() : null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++hostSeq)).toISOString(), deviceCount: 0, appVersion: '0.34.0',
    };
    return Object.assign(h, { secrets, client, ticket, keys, api: (m, p, o) => (ticket ? ticket.request(m, p, o) : client.request(m, p, o)) });
  }
  /** keys.setup のあと、鍵を持つ PC として承認の流れを 1 回回す（engine の回と同じ順） */
  async function holderPass(h) {
    const r = await h.keys.setup();
    if (r.status !== 'ready') return { r, list: [], waiting: 0 };
    return { r, ...(await h.keys.approvals(r.state, r.key)) };
  }
  const caught = async p => { try { await p; return null; } catch (e) { return e; } };
  const syncCalls = () => plus.state.calls.filter(c => c.path.startsWith('/v1/sync/'));
  const resets = () => plus.state.syncBodies.filter(b => b.path === '/v1/sync/reset').length;
  const ledger = uid => plus.state.sync[uid];

  try {
    // ================= 最初の 1 台と同期の券 =================
    const UID = 'adm-user';
    account(UID);
    const a = await makeHost(UID, 'a');
    const callsBefore = plus.state.calls.length;
    const r1 = await a.keys.setup();
    t.ok('最初の 1 台は K を作り、署名の公開鍵（resetPublicKey）を置いて ready',
      r1.status === 'ready' && r1.v2 === true && !!ledger(UID).resetPublicKey && ledger(UID).keyId === r1.key.keyId, JSON.stringify(r1.status));
    const aSync = plus.state.calls.slice(callsBefore).filter(c => c.path.startsWith('/v1/sync/'));
    t.ok('同期の口はすべて同期の券と印（X-Pleiad-Admission: 2）を付けて呼ぶ',
      aSync.length > 0 && aSync.every(c => c.ticket === true && c.admission === '2'), JSON.stringify(aSync));
    t.ok('券は同期の用途（aud sync）で 1 枚だけ取る（5 分の間は使い回す）',
      plus.state.tickets.filter(x => x.purpose === 'sync' && x.hostId === a.hostId).length === 1);

    // ================= 2 台目: 承認を通した受け渡し =================
    const b = await makeHost(UID, 'b');
    const w1 = await b.keys.setup();
    t.ok('鍵を持たない PC は申し込んで待つ（waiting_key・v2・承認する PC がまだ決まっていない）',
      w1.status === 'waiting_key' && w1.wait?.v2 === true && w1.wait?.holder === true && w1.wait?.join?.state === 'committed' && w1.wait.join.code === null,
      JSON.stringify(w1.wait));
    t.ok('申し込みは commit だけ（nonceN と同期の公開鍵はまだ明かさない）',
      ledger(UID).joins[b.hostId]?.state === 'committed' && ledger(UID).joins[b.hostId].nonceN === null && ledger(UID).joins[b.hostId].syncPublicKey === null);

    // 承認の無い受け渡しは断られる
    const bKp = newSyncKeyPair();
    const aKey = r1.key;
    const aKp = await a.keys.keyPair();
    const wrappedForB = wrapKey({ key: aKey.key, keyId: aKey.keyId, uid: UID, privateKey: aKp.privateKey, publicKey: aKp.publicKey, targetPublicKey: bKp.publicKey, targetHostId: b.hostId });
    const noApproval = await caught(a.api('PUT', `/v1/sync/keys/${b.hostId}`, { body: { keyId: aKey.keyId, wrapped: wrappedForB, wrappedBy: a.hostId } }));
    t.ok('鍵を持つ PC でも、承認の無い PC へは包みを置けない（403 approval）',
      noApproval?.status === 403 && noApproval.message === 'approval' && !ledger(UID).keys[b.hostId], String(noApproval?.message));
    const selfGive = await caught(b.api('PUT', `/v1/sync/keys/${b.hostId}`, { body: { keyId: aKey.keyId, wrapped: wrappedForB, wrappedBy: b.hostId } }));
    t.ok('鍵を持たない PC は自分宛てにも置けない（403 not_holder）', selfGive?.status === 403 && selfGive.code === 'not_holder');
    t.ok('前の版の自動の包み（sharePending）は v2 の state では誰にも渡さない（pending が空）',
      (await a.keys.sharePending((await a.keys.setup()).state, aKey)) === 'ok' && !ledger(UID).keys[b.hostId]);

    const p1 = await holderPass(a);
    t.ok('鍵を持つ PC は申し込みに nonceH を置く（challenged）。明かされるまで窓は出さない',
      p1.list.length === 0 && p1.waiting === 1 && ledger(UID).joins[b.hostId].state === 'challenged' && ledger(UID).joins[b.hostId].approverHostId === a.hostId);
    // 明かされる前にもう 1 回見る（engine は 5 秒ごとに見る）。state の joins は自分が担う challenged を数えない（0）が、置いた nonceH は捨てない
    const p1b = await holderPass(a);
    t.ok('明かされる前に見直しても、置いた nonceH を覚えたまま待つ（state の joins は 0）',
      p1b.r.state?.joins === 0 && p1b.list.length === 0 && p1b.waiting === 1, JSON.stringify({ joins: p1b.r.state?.joins, waiting: p1b.waiting }));
    const w2 = await b.keys.setup();
    const codeB = w2.wait?.join?.code;
    t.ok('新しい PC は中身を明かし、6 桁の確認コードと承認する PC の名前を出す',
      w2.wait?.join?.state === 'revealed' && /^\d{6}$/.test(codeB ?? '') && w2.wait.join.approver?.name === 'a', JSON.stringify(w2.wait?.join));
    const p2 = await holderPass(a);
    t.ok('鍵を持つ PC の承認の窓に、同じ確認コードと PC の名前・種類・版が出る',
      p2.list.length === 1 && p2.list[0].hostId === b.hostId && p2.list[0].code === codeB && p2.list[0].name === 'b'
      && p2.list[0].platform === 'linux' && p2.list[0].app === '0.34.0', JSON.stringify(p2.list));
    t.ok('窓を出しただけでは渡さない', !ledger(UID).keys[b.hostId] && ledger(UID).joins[b.hostId].state === 'revealed');
    const wrong = await a.keys.approve(b.hostId, codeB === '000000' ? '111111' : '000000');
    t.ok('見せたコードと読み直したコードが違えば渡さない（changed）', wrong.shared === false && wrong.reason === 'changed' && !ledger(UID).keys[b.hostId]);
    const ok = await a.keys.approve(b.hostId, codeB);
    t.ok('人が承認すると包んで渡す（申し込みは granted）',
      ok.shared === true && ledger(UID).keys[b.hostId]?.keyId === aKey.keyId && ledger(UID).joins[b.hostId].state === 'granted' && a.shared.some(s => s.hostId === b.hostId));
    const r2 = await b.keys.setup();
    t.ok('新しい PC は承認した PC の鍵で開いて ready（同じ K）', r2.status === 'ready' && r2.key.keyId === aKey.keyId && r2.changed === true, JSON.stringify(r2.status));
    t.ok('受け取ったら申し込みの覚えを消す', (await b.secrets.get(SYNC_JOIN)) == null);
    t.ok('受け取った PC は項目を読める', Array.isArray((await b.api('GET', '/v1/sync/items?since=0'))?.items));

    // ================= 断る =================
    const c = await makeHost(UID, 'c');
    await c.keys.setup();
    await holderPass(a);
    const cw = await c.keys.setup();
    t.ok('3 台目も確認コードまで進む', cw.wait?.join?.state === 'revealed');
    await a.keys.deny(c.hostId);
    const cd = await c.keys.setup();
    t.ok('断ると、申し込んだ PC は denied で待つ（コードを出さない）', cd.wait?.join?.state === 'denied' && cd.wait.join.code === null && !ledger(UID).keys[c.hostId]);
    const again = await caught(c.api('POST', '/v1/sync/join', { body: { commit: b64url(crypto.randomBytes(32)) } }));
    t.ok('断られた PC は 1 時間申し込み直せない（429）', again?.status === 429);
    const cd2 = await c.keys.setup();
    t.ok('1 時間の間は申し込み直さずに denied のまま', cd2.wait?.join?.state === 'denied');
    t.ok('鍵を持つ PC の窓からは消える', (await holderPass(a)).list.length === 0);

    // ================= 鍵を持たない PC の始め直しは断られる =================
    const keyId0 = ledger(UID).keyId;
    const resets0 = resets();
    const forced = await c.keys.setup({ forceNew: true });
    t.ok('鍵を持たない PC は「同期をリセット」でも作り直さない（reset を送らない）',
      forced.status === 'waiting_key' && resets() === resets0 && ledger(UID).keyId === keyId0);
    const fake = newAccountKey();
    const fakeReset = resetKeyPair(fake.key);
    const cKp = await c.keys.keyPair();
    const cWrapped = wrapKey({ key: fake.key, keyId: fake.keyId, uid: UID, privateKey: cKp.privateKey, publicKey: cKp.publicKey, targetPublicKey: cKp.publicKey, targetHostId: c.hostId });
    const resetBody = { keyId: fake.keyId, hostId: c.hostId, wrapped: cWrapped, previousKeyId: keyId0, resetPublicKey: fakeReset.publicKey, syncPublicKey: b64url(cKp.publicKey) };
    const unsigned = await caught(c.api('POST', '/v1/sync/reset', { body: resetBody }));
    const ownSig = await caught(c.api('POST', '/v1/sync/reset', { body: { ...resetBody,
      signature: fakeReset.sign(resetMessage({ uid: UID, previousKeyId: keyId0, keyId: fake.keyId, hostId: c.hostId, resetPublicKey: fakeReset.publicKey })) } }));
    t.ok('今の K の署名の無い reset は断られる（署名なし・自分で作った鍵の署名とも 422）',
      unsigned?.status === 422 && ownSig?.status === 422 && ledger(UID).keyId === keyId0 && ledger(UID).keys[a.hostId]?.keyId === keyId0,
      `${unsigned?.status} ${ownSig?.status}`);

    // ================= 承認していた PC が外された → 承認の窓をやり直す =================
    const d = await makeHost(UID, 'd');
    await d.keys.setup();
    await holderPass(b);   // b が担う
    const dw1 = await d.keys.setup();
    const codeD1 = dw1.wait?.join?.code;
    t.ok('b が担った申し込みに確認コードが出る', dw1.wait?.join?.state === 'revealed' && dw1.wait.join.approver?.hostId === b.hostId);
    plus.unbindHost(b.hostId, 'user');
    t.ok('承認していた PC を外すと、申し込みは committed に戻る', ledger(UID).joins[d.hostId].state === 'committed');
    const dw2 = await d.keys.setup();
    t.ok('新しい PC は committed を再び見たら、出していたコードを消して最初から',
      dw2.wait?.join?.state === 'committed' && dw2.wait.join.code === null && d.logs.includes('sync join restarted'), JSON.stringify(dw2.wait?.join));

    // ================= 外した PC は読めない・K を作り直して残りの PC へ渡す =================
    const removedTicket = await caught(b.ticket.get({ force: true }));
    t.ok('外した PC は同期の券を取れない（403 host_removed）', removedTicket?.status === 403 && removedTicket.code === 'host_removed');
    const removedRead = await caught(b.client.request('GET', '/v1/sync/items?since=0', { headers: { 'x-pleiad-sync-ticket': 'stale' } }));
    t.ok('外した PC は項目を読めない', removedRead?.status === 403);
    t.ok('鍵を持つ PC が外されると、台帳に作り直しの印（rotate）が付く', !!ledger(UID).rotate);
    const ra = await a.keys.setup();
    t.ok('鍵を持つ PC は今の K で署名して作り直す（sync key rotated）',
      ra.status === 'ready' && ra.key.keyId !== keyId0 && ledger(UID).keyId === ra.key.keyId && !ledger(UID).rotate && a.logs.includes('sync key rotated'));
    t.ok('外した PC の包みは新しい K に残らない', !ledger(UID).keys[b.hostId]);
    // d を承認して鍵を持たせてから、もう一度作り直して carry を見る
    await holderPass(a);
    const dw3 = await d.keys.setup();
    await a.keys.approve(d.hostId, dw3.wait?.join?.code);
    t.ok('やり直した窓で承認して d も受け取る（前のコードとは別）',
      (await d.keys.setup()).status === 'ready' && dw3.wait?.join?.code !== codeD1);
    const keyId1 = ledger(UID).keyId;
    const e = await makeHost(UID, 'e');
    await e.keys.setup();
    await holderPass(d);   // d が e の申し込みを担う
    t.ok('e の申し込みは d が担う', (await e.keys.setup()).wait?.join?.state === 'revealed');
    const rf = await a.keys.setup({ forceNew: true });
    t.ok('人の始め直し（鍵を持つ PC）: 署名して作り直す', rf.status === 'ready' && rf.key.keyId !== keyId1);
    t.ok('ほかの PC が新しい K を置くと、承認の途中の申し込みは committed に戻る', ledger(UID).joins[e.hostId].state === 'committed');
    const rd = await d.keys.setup();
    t.ok('作り直す前の鍵を持っていた PC は、承認なしで新しい K を受け取る（carry）',
      rd.status === 'ready' && rd.key.keyId === rf.key.keyId && !(ledger(UID).carry ?? []).includes(d.hostId));
    t.ok('鍵を持っていなかった PC は carry に入らない', !ledger(UID).keys[e.hostId] && !(ledger(UID).carry ?? []).includes(e.hostId));
    const ew = await e.keys.setup();
    t.ok('戻された申し込みの PC は承認の窓を最初から', ew.wait?.join?.state === 'committed' && ew.wait.join.code === null);

    // ================= 届いた包みの確かめ（サーバーが渡す K をそのまま受けない） =================
    const keyIdF = ledger(UID).keyId;
    await holderPass(a);   // a が e の申し込みを担う
    const ew2 = await e.keys.setup();
    t.ok('（準備）e は a の承認の窓まで進む', ew2.wait?.join?.state === 'revealed' && ew2.wait.join.approver?.hostId === a.hostId);
    const ePub = Buffer.from(plus.state.hosts[e.hostId].syncPublicKey, 'base64url');
    // 承認していない PC（d・今の K を持つ）が包んだものを、サーバーが e に渡す
    const dKp = await d.keys.keyPair();
    ledger(UID).keys[e.hostId] = { keyId: keyIdF, wrappedBy: d.hostId,
      wrapped: wrapKey({ key: rd.key.key, keyId: keyIdF, uid: UID, privateKey: dKp.privateKey, publicKey: dKp.publicKey, targetPublicKey: ePub, targetHostId: e.hostId }) };
    const eNot = await e.keys.setup();
    t.ok('新しい PC は、承認した PC 以外が包んだ K を受けない（台帳の公開鍵で開けても）',
      eNot.status === 'waiting_key' && eNot.wait?.unverified === true && !e.logs.includes('sync key received') && (await e.secrets.get(SYNC_ACCOUNT_KEY)) == null,
      JSON.stringify({ status: eNot.status, unverified: eNot.wait?.unverified }));
    // 台帳の承認した PC（a）の公開鍵をすり替え、その鍵で包んだものを渡す
    const evil = newSyncKeyPair();
    const aPubReal = plus.state.hosts[a.hostId].syncPublicKey;
    plus.state.hosts[a.hostId].syncPublicKey = b64url(evil.publicKey);
    ledger(UID).keys[e.hostId] = { keyId: keyIdF, wrappedBy: a.hostId,
      wrapped: wrapKey({ key: rd.key.key, keyId: keyIdF, uid: UID, privateKey: evil.privateKey, publicKey: evil.publicKey, targetPublicKey: ePub, targetHostId: e.hostId }) };
    const eSpoof = await e.keys.setup();
    t.ok('新しい PC は、承認の窓で見た公開鍵でしか開かない（台帳の公開鍵のすり替えでは受けない）',
      eSpoof.status === 'waiting_key' && eSpoof.wait?.unverified === true && (await e.secrets.get(SYNC_ACCOUNT_KEY)) == null);
    plus.state.hosts[a.hostId].syncPublicKey = aPubReal;
    delete ledger(UID).keys[e.hostId];
    await a.keys.approve(e.hostId, ew2.wait.join.code);
    const eOk = await e.keys.setup();
    t.ok('承認した PC が渡し直せば受け取る', eOk.status === 'ready' && eOk.key.keyId === keyIdF);

    // 前の K を持つ PC: 作り直しの包みに前の K の印が無ければ切り替えない
    const rf2 = await a.keys.setup({ forceNew: true });
    const keyIdG = rf2.key.keyId;
    const carried = ledger(UID).keys[d.hostId];
    t.ok('（準備）作り直すと d に前の K の印の付いた包みが置かれる', carried?.keyId === keyIdG && carried.wrappedBy === a.hostId);
    const aKp2 = await a.keys.keyPair();
    const dPub = Buffer.from(plus.state.hosts[d.hostId].syncPublicKey, 'base64url');
    ledger(UID).keys[d.hostId] = { keyId: keyIdG, wrappedBy: a.hostId,
      wrapped: wrapKey({ key: rf2.key.key, keyId: keyIdG, uid: UID, privateKey: aKp2.privateKey, publicKey: aKp2.publicKey, targetPublicKey: dPub, targetHostId: d.hostId }) };
    const dLogs0 = d.logs.length;
    const dJoinAt = ledger(UID).joins[d.hostId]?.updatedAt;
    const dNot = await d.keys.setup();
    const dLocal = await d.secrets.get(SYNC_ACCOUNT_KEY);
    t.ok('前の K の印の無い包みでは切り替えない（手元の K はそのまま・申し込みもしない）',
      dNot.status === 'waiting_key' && dNot.wait?.unverified === true && dLocal?.keyId === keyIdF && !d.logs.slice(dLogs0).includes('sync key received')
      && ledger(UID).joins[d.hostId]?.updatedAt === dJoinAt, JSON.stringify({ status: dNot.status, wait: dNot.wait, local: dLocal?.keyId }));
    ledger(UID).keys[d.hostId] = carried;
    const dOk = await d.keys.setup();
    t.ok('前の K の印が合う包みなら承認なしで切り替える', dOk.status === 'ready' && dOk.key.keyId === keyIdG && dOk.changed === true);
    // 前の版の覚え（印の無い carry）は渡さずに捨てる
    await a.secrets.set(SYNC_CARRY, { keyId: keyIdG, hosts: [e.hostId] });
    ledger(UID).carry = [e.hostId];
    const keyE = ledger(UID).keys[e.hostId];
    delete ledger(UID).keys[e.hostId];
    await holderPass(a);
    t.ok('印の無い carry の覚えは渡さずに捨てる', !ledger(UID).keys[e.hostId] && (await a.secrets.get(SYNC_CARRY)) == null);
    ledger(UID).keys[e.hostId] = keyE;
    ledger(UID).carry = [];

    // ================= ログアウトの後（K を消しても、指紋か自分で包んだ K で戻る） =================
    const UID6 = 'adm-forget';
    account(UID6);
    const g1 = await makeHost(UID6, 'g1');
    const gr1 = await g1.keys.setup();                 // 最初の 1 台（K を自分で作る）
    const g2 = await makeHost(UID6, 'g2');
    await g2.keys.setup();
    await holderPass(g1);
    const g2w = await g2.keys.setup();
    await g1.keys.approve(g2.hostId, g2w.wait?.join?.code);
    const g2r = await g2.keys.setup();
    t.ok('（準備）g2 は承認で K を受け取る', g2r.status === 'ready' && g2r.key.keyId === gr1.key.keyId, JSON.stringify(g2r.status));
    const fingerprint = resetKeyPair(gr1.key.key).publicKey;
    const g2Seen = (await g2.secrets.get(SYNC_V2_FINGERPRINTS))?.[UID6];
    t.ok('受け取った K の指紋（keyId・resetPublicKey。公開鍵だけ）を uid ごとに覚える',
      g2Seen?.keyId === gr1.key.keyId && g2Seen.resetPublicKey === fingerprint && !('key' in (g2Seen ?? {})), JSON.stringify(g2Seen));
    await g2.keys.forget();
    const g2SeenAfter = (await g2.secrets.get(SYNC_V2_FINGERPRINTS))?.[UID6];
    t.ok('指紋は forget（ログアウト）で消えない',
      (await g2.secrets.get(SYNC_ACCOUNT_KEY)) == null && g2SeenAfter?.keyId === gr1.key.keyId && g2SeenAfter.resetPublicKey === fingerprint);
    const keyIdH = ledger(UID6).keyId;
    const g2Back = await g2.keys.setup();
    t.ok('承認で受け取った PC は、ログアウトして戻っても承認なしで ready（指紋）',
      g2Back.status === 'ready' && g2Back.key.keyId === keyIdH && g2Back.changed === true
      && ledger(UID6).joins?.[g2.hostId]?.state === 'granted' && (await g2.secrets.get(SYNC_JOIN)) == null,
      JSON.stringify({ status: g2Back.status, key: g2Back.key?.keyId }));

    // B: K を自分で作った PC（指紋を入れる前の版と同じく、指紋が無くても戻る）
    await g1.keys.forget();
    await g1.secrets.delete(SYNC_V2_FINGERPRINTS);
    const g1Back = await g1.keys.setup();
    t.ok('K を自分で作った PC は、指紋が無くてもログアウトから戻れる（自分で包んだ包み）',
      g1Back.status === 'ready' && g1Back.key.keyId === keyIdH && g1Back.changed === true, JSON.stringify(g1Back.status));

    // 指紋と違う K の包み（承認した PC の鍵で包み直したもの）は受けない
    await g2.keys.forget();
    const g1Kp = await g1.keys.keyPair();
    const g2Pub = (await g2.keys.keyPair()).publicKey;
    const otherKey = newAccountKey();
    ledger(UID6).keys[g2.hostId] = { keyId: keyIdH, wrappedBy: g1.hostId,
      wrapped: wrapKey({ key: otherKey.key, keyId: keyIdH, uid: UID6, privateKey: g1Kp.privateKey, publicKey: g1Kp.publicKey, targetPublicKey: g2Pub, targetHostId: g2.hostId }) };
    const g2Mismatch = await g2.keys.setup();
    t.ok('forget の後、指紋と違う K の包みは受けない（unverified）',
      g2Mismatch.status === 'waiting_key' && g2Mismatch.wait?.unverified === true && (await g2.secrets.get(SYNC_ACCOUNT_KEY)) == null,
      JSON.stringify({ status: g2Mismatch.status, unverified: g2Mismatch.wait?.unverified }));

    // 承認していない PC の包み（台帳の公開鍵で開けても、指紋と違う K）は受けない
    const g3 = await makeHost(UID6, 'g3');
    await g3.keys.setup();
    const g3Kp = await g3.keys.keyPair();
    plus.state.hosts[g3.hostId].syncPublicKey = b64url(g3Kp.publicKey);
    ledger(UID6).keys[g2.hostId] = { keyId: keyIdH, wrappedBy: g3.hostId,
      wrapped: wrapKey({ key: otherKey.key, keyId: keyIdH, uid: UID6, privateKey: g3Kp.privateKey, publicKey: g3Kp.publicKey, targetPublicKey: g2Pub, targetHostId: g2.hostId }) };
    const g2Other = await g2.keys.setup();
    t.ok('承認していない PC の包みは受けない（unverified のまま）',
      g2Other.status === 'waiting_key' && g2Other.wait?.unverified === true && (await g2.secrets.get(SYNC_ACCOUNT_KEY)) == null);

    // ================= 同期のリセット（鍵を持つ PC が 1 台も無い） =================
    const UID2 = 'adm-recovery';
    account(UID2);
    const x = await makeHost(UID2, 'x');
    await x.keys.setup();
    const y = await makeHost(UID2, 'y');
    const z = await makeHost(UID2, 'z');
    plus.unbindHost(x.hostId, 'user');
    const yw = await y.keys.setup();
    t.ok('鍵を持つ PC が全部外れていたら、申し込まずにリセットを待つ（holder false・リセットなし）',
      yw.status === 'waiting_key' && yw.wait?.holder === false && yw.wait.recovery === null && !yw.wait.join && !ledger(UID2).joins?.[y.hostId], JSON.stringify(yw.wait));
    y.tokenExtra = { auth_time: Math.floor(Date.now() / 1000) - 3600 };
    t.ok('リセットを頼むには最近のログインが要る（reauth）', (await y.keys.recoveryRequest()).reauth === true && !ledger(UID2).recovery);
    y.tokenExtra = {};
    const req1 = await y.keys.recoveryRequest();
    const readyIn = Date.parse(req1.recovery?.readyAt) - Date.parse(req1.recovery?.requestedAt);
    t.ok('リセットを頼むと 72 時間の待ちが始まる', req1.recovery?.requestedBy === y.hostId && Math.abs(readyIn - 72 * 3_600_000) < 1000, JSON.stringify(req1));
    t.ok('ほかの PC は重ねて頼めない（other）', (await z.keys.recoveryRequest()).other === true);
    const yw2 = await y.keys.setup();
    t.ok('待っている間は waiting_key に自分のリセットが載る', yw2.wait?.recoveryMine === true && yw2.wait.recovery?.readyAt === req1.recovery.readyAt);
    t.ok('待ちが明ける前は仕上げられない（waiting）', !!(await y.keys.recoveryComplete()).waiting && ledger(UID2).keyId !== null);
    // 外された PC（x）でも、手元の K の署名で止められる
    const watch = await x.keys.recoveryWatch();
    t.ok('外された PC でも、今の K を持っていれば券なしでリセットを見られる', watch?.recovery?.requestedBy === y.hostId);
    const stop = await x.keys.recoveryStop();
    t.ok('鍵を持つ PC は K の署名でリセットを止められる', stop.stopped === true && !ledger(UID2).recovery);
    // リセットを頼んだ PC を外すと、リセットも取り消し
    await z.keys.recoveryRequest();
    t.ok('z が頼み直す', ledger(UID2).recovery?.requestedBy === z.hostId);
    plus.unbindHost(z.hostId, 'user');
    t.ok('リセットを頼んだ PC を外すと、リセットも取り消される', !ledger(UID2).recovery);
    // 待ちが明けたら仕上げる
    await y.keys.recoveryRequest();
    ledger(UID2).recovery.readyAt = new Date(Date.now() - 1000).toISOString();
    const done = await y.keys.recoveryComplete();
    const yr = await y.keys.setup();
    t.ok('待ちが明けたら新しい K で始め直す（前のデータは消える）',
      done.done === true && yr.status === 'ready' && ledger(UID2).resetBy === y.hostId && !ledger(UID2).recovery && Object.keys(ledger(UID2).keys).join() === y.hostId);
    t.ok('リセットで始め直した後は、外された PC の K では止められない', (await x.keys.recoveryStop()).stopped === false);

    // ================= 移行: 前の版で作った K → 最初の v2 の PC が作り直す =================
    const UID3 = 'adm-migrate';
    account(UID3);
    plus.state.noTickets = true;
    const m1old = await makeHost(UID3, 'm1', { ticket: false });
    const m2old = await makeHost(UID3, 'm2', { ticket: false });
    const lr1 = await m1old.keys.setup();
    await m2old.keys.setup();
    await m1old.keys.sharePending((await m1old.keys.setup()).state, lr1.key);
    const lr2 = await m2old.keys.setup();
    t.ok('（準備）前の版の api では 2 台が同じ K を持つ', lr1.status === 'ready' && lr2.status === 'ready' && lr2.key.keyId === lr1.key.keyId && !ledger(UID3).resetPublicKey);
    plus.state.noTickets = false;
    // 同じ PC（同じ secret-store・ホストの鍵）を、更新した版のクライアントで作り直す
    const upgrade = (old) => {
      const ticket = createSyncTicket({ client: old.client, identity: async () => old.identity });
      const keys = createSyncKeys({ client: old.client, ticket, secrets: old.secrets, uid: () => UID3, hostId: () => old.hostId, log: l => old.logs.push(l), onShared: to => old.shared.push(to) });
      return { ...old, ticket, keys, api: (m, p, o) => ticket.request(m, p, o) };
    };
    const legacyClient = await caught(m2old.client.request('GET', '/v1/sync/state', { headers: { 'x-pleiad-admission': undefined } }));
    t.ok('更新した PC がまだ無い間も、前の版のクライアントは券なしの印で ticket_invalid（取り直しの合図）',
      legacyClient?.status === 403 && legacyClient.code === 'ticket_invalid');
    const m1 = upgrade(m1old);
    const mr1 = await m1.keys.setup();
    t.ok('更新した最初の鍵を持つ PC が K を作り直す（署名なし・sync key migrated）',
      mr1.status === 'ready' && mr1.key.keyId !== lr1.key.keyId && !!ledger(UID3).resetPublicKey && m1.logs.includes('sync key migrated'));
    t.ok('移行ではほかの PC に承認なしで渡さない（carry が空）', !(ledger(UID3).carry ?? []).length && !ledger(UID3).keys[m2old.hostId]?.keyId?.startsWith(mr1.key.keyId));
    const m2 = upgrade(m2old);
    const mw0 = await m2.keys.setup();
    t.ok('前の K を持つほかの PC は、前の K で確かめられない新しい K へ自動で移らない（申し込まずに人が選ぶのを待つ）',
      mw0.status === 'waiting_key' && mw0.wait?.restarted?.keyId === mr1.key.keyId && mw0.wait.restarted.unverified === false
      && !mw0.wait.join && !ledger(UID3).joins?.[m2.hostId], JSON.stringify(mw0.wait));
    t.ok('「新しい鍵を受け取る」は、見せた keyId がその間に替わっていたら移らない（changed）',
      (await m2.keys.acceptRestart('0000000000000000')).changed === true);
    t.ok('「新しい鍵を受け取る」を選ぶ', (await m2.keys.acceptRestart(mr1.key.keyId)).accepted === true);
    const mw = await m2.keys.setup();
    t.ok('選んだ後は申し込んで承認を待つ', mw.status === 'waiting_key' && !mw.wait?.restarted && mw.wait?.join?.state === 'committed');
    await holderPass(m1);
    const mw2 = await m2.keys.setup();
    await m1.keys.approve(m2.hostId, mw2.wait?.join?.code);
    const mr2 = await m2.keys.setup();
    t.ok('承認を 1 回通すと新しい K で ready', mr2.status === 'ready' && mr2.key.keyId === mr1.key.keyId);

    // ================= 券の取り直し・券の口の無い api =================
    const issued = () => plus.state.tickets.filter(x => x.purpose === 'sync' && x.hostId === m1.hostId).length;
    const before = issued();
    plus.rotateTicketKey();
    const rr = await m1.keys.setup();
    t.ok('券が通らなくなったら（403 ticket_invalid）取り直して 1 回だけやり直す', rr.status === 'ready' && issued() === before + 1);
    plus.state.syncFail.push({ path: /^\/v1\/sync\/state$/, status: 403, code: 'ticket_invalid', message: 'ticket', count: 2 });
    const before2 = issued();
    const twice = await caught(m1.keys.setup());
    t.ok('取り直しても断られたら、それ以上は繰り返さずに投げる', twice?.status === 403 && twice.code === 'ticket_invalid' && issued() === before2 + 1);
    plus.state.syncFail.length = 0;

    const UID4 = 'adm-legacy';
    account(UID4);
    plus.state.noTickets = true;
    const l1 = await makeHost(UID4, 'l1', { syncKey: true });
    const lc0 = syncCalls().length;
    const lres = await l1.keys.setup();
    t.ok('券の口が 404 の api（前の版）では、今の流れで K を作る（券を付けない）',
      lres.status === 'ready' && !lres.v2 && l1.ticket.legacy() === true && syncCalls().slice(lc0).every(cl => cl.ticket === false));
    plus.state.noTickets = false;

    // ================= 券を取れたアカウントで、api が前の版に戻った =================
    // 同じ PC（同じ secret-store）の新しい券・keys で、券の口が 404 を返す
    plus.state.noTickets = true;
    const aTicket = createSyncTicket({ client: a.client, identity: async () => a.identity });
    const aKeys = createSyncKeys({ client: a.client, ticket: aTicket, secrets: a.secrets, uid: () => UID, hostId: () => a.hostId, log: l => a.logs.push(l), onShared: to => a.shared.push(to) });
    const dc0 = syncCalls().length;
    const keyIdNow = ledger(UID).keyId;
    const down = await caught(aKeys.setup());
    t.ok('券を 1 度でも取れたアカウントで api が前の版を名乗ったら、前の版の道に戻らず 426 api_downgraded で止まる',
      down?.status === 426 && down.code === 'api_downgraded' && syncCalls().length === dc0 && ledger(UID).keyId === keyIdNow,
      JSON.stringify({ status: down?.status, code: down?.code, calls: syncCalls().slice(dc0).map(cl => cl.path) }));
    const downShare = await caught(aKeys.setup({ forceNew: true }));
    t.ok('始め直し（forceNew）でも前の版の道で作り直さない', downShare?.code === 'api_downgraded' && syncCalls().length === dc0 && ledger(UID).keyId === keyIdNow);
    plus.state.noTickets = false;

    // ================= engine: 状態に申し込みが並び、承認で渡す。426 で止まる =================
    const UID5 = 'adm-engine';
    account(UID5);
    async function makeEngineHost(label) {
      const h = await makeHost(UID5, label);
      const root = path.join(scratch, `eng-${label}`);
      const dataDir = path.join(root, 'data');
      const targets = createSyncTargets({ dataDir, home: path.join(root, 'home'), env: {} });
      const clock = fakeClock(T0);
      const watch = () => ({ close() {}, on() {} });
      const statuses = [];
      const engine = createSyncEngine({
        client: { request: (m, p, o) => h.ticket.request(m, p, o) }, keys: h.keys, targets, dataDir, uid: () => UID5, hostId: () => h.hostId,
        log: l => h.logs.push(l), clock, watch, onStatus: s => statuses.push(s),
      });
      engines.push(engine);
      return Object.assign(h, { engine, clock, statuses });
    }
    const settle = async h => { await h.clock.flush(); await h.engine.idle(); };
    const ea = await makeEngineHost('ea');
    await ea.engine.start(); await settle(ea);
    t.ok('engine: 最初の 1 台は idle', ea.engine.status().state === 'idle', JSON.stringify(ea.engine.status()));
    const eb = await makeEngineHost('eb');
    await eb.engine.start(); await settle(eb);
    t.ok('engine: 2 台目は waiting_key（申し込み）', eb.engine.status().state === 'waiting_key' && eb.engine.status().wait?.join?.state === 'committed');
    await ea.engine.run({ full: false }); await settle(ea);
    await eb.engine.run({ full: false }); await settle(eb);
    const ebCode = eb.engine.status().wait?.join?.code;
    await ea.engine.run({ full: false }); await settle(ea);
    const ap = ea.engine.status().approvals;
    t.ok('engine: 鍵を持つ PC の状態の approvals に、同じ確認コードの申し込みが並ぶ',
      /^\d{6}$/.test(ebCode ?? '') && ap.length === 1 && ap[0].hostId === eb.hostId && ap[0].code === ebCode, JSON.stringify(ap));
    const out = await ea.engine.approve(eb.hostId, ebCode);
    t.ok('engine: 承認すると渡し、approvals から消える', out.shared === true && out.status.approvals.length === 0);
    await eb.engine.run(); await settle(eb);
    t.ok('engine: 新しい PC は受け取って idle', eb.engine.status().state === 'idle', JSON.stringify(eb.engine.status()));
    plus.state.syncFail.push({ path: /^\/v1\/sync\/state$/, status: 426, code: 'update_required', message: 'update required', extra: { feature: 'admission_v2' } });
    await ea.engine.run(); await settle(ea);
    t.ok('engine: 426 update_required を受けたら止めて、更新を促す状態（update_required）', ea.engine.status().state === 'update_required');
    const stopped = plus.state.calls.length;
    await ea.clock.advance(30 * 60_000); await settle(ea);
    t.ok('engine: 426 の後は自分で回し直さない', plus.state.calls.length === stopped);
    // 券を取れていた PC で api が前の版に戻る → 前の版の道で K を渡さず、更新を促す状態で止まる
    plus.state.noTickets = true;
    eb.ticket.forget();
    const ebc0 = syncCalls().length;
    await eb.engine.run(); await settle(eb);
    t.ok('engine: 券を取れていたアカウントで api が前の版に戻ったら update_required（api_downgraded）で止まる',
      eb.engine.status().state === 'update_required' && eb.engine.status().error === 'api_downgraded' && syncCalls().length === ebc0,
      JSON.stringify({ status: eb.engine.status(), calls: syncCalls().slice(ebc0).map(cl => cl.path) }));
    plus.state.noTickets = false;
  } finally {
    for (const en of engines) en.stop();
    await plus.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
