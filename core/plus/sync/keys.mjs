// 同期の鍵の始め方と受け渡し（docs/plus.md「同期」）。鍵は端末の中で作り、api にはホストごとに包んだものだけを渡す。
//
//   plus:syncKey         このホストの同期用の X25519 の鍵対 { privateKey, publicKey }（raw 32 バイトの base64url）。ログアウトでも残す
//   plus:syncAccountKey  アカウントの同期鍵 { keyId, key }（key は raw 32 バイトの base64url）。ログアウトで消す
//   plus:syncJoin        鍵を受け取る側の申し込み { uid, syncPub, nonceN, commit, approverHostId, approverPub, nonceH, code }
//   plus:syncApprovals   鍵を渡す側の承認の途中 { [申し込んだ hostId]: { nonceH, commit, keyId } }
//   plus:syncCarry       作り直した K を引き継ぐ PC のうち、まだ渡せていないもの { keyId, hosts: [hostId], nonces: { [hostId]: nonce } }
//   plus:syncRestart     前の K では確かめられない新しい K（回復・移行）へ移ると人が選んだ印 { uid, keyId }
//   plus:syncV2Seen      券を一度でも取れたアカウント { [uid]: 初めて取れた時刻 }。ログアウトでも残す
//
// api の版で 2 つの道がある。同期の券（ticket.mjs）を取れる api が v2、券の口が 404 の api は前の版（legacy）。
// 一度券を取れたアカウントで券の口が 404 になったら、前の版の道（K を自動で包んで渡す）へ戻らず止める（api_downgraded）。
//
// 前の版（setupLegacy・sharePending）:
//   1. GET /v1/sync/state?hostId=<自分>。enabled が false なら disabled
//   2. keyId が null → K を作り、自分宛てに包んで POST /v1/sync/reset（previousKeyId: null）
//   3. 手元の keyId と同じ → そのまま使う
//   4. 違う・無い → GET /v1/sync/keys/{自分} を wrappedBy の syncPublicKey で開いて保管する（開けなければ待つ）
//   5. 自分宛てが無い（404）→ 待つ。サーバーに項目が無く（itemCount が 0）、鍵を持つほかのホストも居なければ作り直す。
//      項目がある（古い api で itemCount が無いときも）なら黙って作り直さず、待つ（wait に件数・大きさ・鍵を持つ PC を載せる）。
//      人が件数を見て確かめたら、setup({ forceNew: true, confirm: { keyId, itemCount } }) で作り直す
//   鍵を持つホストは、宛ての無いホスト（state.pending）に自動で包んで渡す
//   reset の 409 conflict（previousKeyId）は、ほかの PC が先に作ったので state を読み直す。
//   409 reset_confirm（確かめが無い・数字が変わった）は confirm_needed に今の値を載せて返す（docs/plus.md「同期の始め直しと登録の外れ」）
//
// v2（setupV2。同期の口はすべて券つき）:
//   K を作る・作り直すときは、K から作った署名の鍵の公開鍵（resetPublicKey）を置く。作り直しは今の K の署名が要る（K を持たない PC は始め直せない）
//   - keyId が null → K を作る（署名なし）
//   - 鍵を持つ PC（state.self.holder）:
//       signedReset が false（前の版で作った K）→ 移行: 署名なしで作り直す（ほかの PC は承認を 1 回ずつ通して受け取る）
//       rotate（鍵を持つ PC が外された）・人の始め直し → 今の K で署名して作り直し、残りの鍵を持つ PC へ承認なしで渡す（carry）
//   - 鍵を持たない PC: 鍵を持つ PC が居れば申し込む（commit–reveal）。居なければ回復（最近のログイン → 72 時間 → 仕上げ）を待つ
//   申し込み（受け取る側 N）: nonceN と自分の同期の公開鍵の commit を置く → 渡す側 H が nonceH を置く（challenged）→ N が中身を明かす（revealed）
//     → 両方が同じ 6 桁の確認コードを出し、H の人が見比べて渡す・渡さないを選ぶ。
//     途中で committed に戻った（承認していた PC が外された・新しい K が置かれた）ら、承認の窓を最初からやり直す
//   受け取った包みの確かめ（サーバーが渡す K をそのまま受けない）:
//   - K を持たない PC: 承認の窓で確認コードに使った PC（approverHostId）が、その公開鍵（approverPub）で包んだものだけを開く。
//     台帳の syncPublicKey は使わない
//   - 前の K を持つ PC: 作り直した PC が前の K から作った印（crypto.mjs の carryNonce）を包みに入れる。手元の前の K で
//     確かめられたものだけに切り替える。確かめられなければ切り替えず、手元の状態も消さない
//   - 回復・移行で作った K は前の K の印を持たない。前の K を持つ PC は自動で切り替えず（wait.restarted を出す）、
//     人が「新しい鍵を受け取る」を選んでから（acceptRestart）申し込み、承認の窓を通して受け取る
import crypto from 'node:crypto';
import {
  b64url, fromB64url, deriveItemKeys, newAccountKey, newSyncKeyPair, syncKeyPairFromPrivate, wrapKey, unwrapKey, KEY_ID_RX,
  resetKeyPair, resetMessage, recoveryCancelMessage, joinCommit, joinCode, carryNonce, isCarryWrap,
} from './crypto.mjs';

export const SYNC_KEY_PAIR = 'plus:syncKey';
export const SYNC_ACCOUNT_KEY = 'plus:syncAccountKey';
export const SYNC_JOIN = 'plus:syncJoin';
export const SYNC_APPROVALS = 'plus:syncApprovals';
export const SYNC_CARRY = 'plus:syncCarry';
export const SYNC_RESTART = 'plus:syncRestart';
export const SYNC_V2_SEEN = 'plus:syncV2Seen';
const RESET_TRIES = 3;
const DENY_WAIT_MS = 60 * 60_000;

const random32 = () => crypto.randomBytes(32);
const pub32 = s => { const b = fromB64url(s); return b.length === 32 ? b : null; };

/**
 * @param {object} o
 * @param {{ request: Function }} o.client  Plus の api の客（core/plus/client.mjs）
 * @param {{ get: Function, request: Function, legacy: () => boolean }|null} [o.ticket]  同期の券（ticket.mjs）。無ければ前の版の道だけ
 * @param {object} o.secrets  createSecretStore の結果（<data>/plus-secrets.json）
 * @param {() => string|null} o.uid
 * @param {() => string|null} o.hostId  このホストの hostId（登録済みのもの）
 * @param {(line: string) => void} [o.log]
 * @param {(to: { hostId: string, name: string|null }) => void} [o.onShared]  鍵を新しい PC に渡したとき
 * @param {() => number} [o.now]
 */
export function createSyncKeys({ client, ticket = null, secrets, uid, hostId, log = () => {}, onShared = () => {}, now = Date.now }) {
  /** 同期の口（券があれば付ける）。台帳（/v1/hosts）と券の要らない回復の口は client で呼ぶ */
  const api = (method, path, opts) => (ticket ? ticket.request(method, path, opts) : client.request(method, path, opts));

  /**
   * この api が v2（券を取れる）か。券を取れない誤り（登録が無い・外された）はそのまま投げる。
   * 券を取れたアカウントは覚え、それ以後に券の口が 404 になったら前の版とは見なさず 426 api_downgraded を投げる
   */
  async function isV2() {
    if (!ticket) return false;
    await ticket.get();
    const id = uid();
    if (!ticket.legacy()) {
      if (id) await secrets.update(SYNC_V2_SEEN, cur => (cur?.[id] ? cur : { ...(cur ?? {}), [id]: now() }));
      return true;
    }
    const seen = await secrets.get(SYNC_V2_SEEN).catch(() => null);
    if (id && seen?.[id]) {
      log('sync api answered as the previous version after a ticket was issued');
      throw Object.assign(new Error('api_downgraded'), { status: 426, code: 'api_downgraded' });
    }
    return false;
  }

  /** このホストの同期の鍵対（無ければ作って保管する） */
  async function keyPair() {
    const stored = await secrets.update(SYNC_KEY_PAIR, cur => {
      const priv = fromB64url(cur?.privateKey);
      if (priv.length === 32) return cur;
      const kp = newSyncKeyPair();
      return { privateKey: b64url(kp.privateKey), publicKey: b64url(kp.publicKey) };
    });
    return syncKeyPairFromPrivate(fromB64url(stored.privateKey));
  }

  /** 台帳に載せる同期の公開鍵（base64url） */
  const publicKey = async () => b64url((await keyPair()).publicKey);

  async function storedAccountKey() {
    const v = await secrets.get(SYNC_ACCOUNT_KEY).catch(() => undefined);
    const key = fromB64url(v?.key);
    return typeof v?.keyId === 'string' && KEY_ID_RX.test(v.keyId) && key.length === 32 ? { keyId: v.keyId, key } : null;
  }
  const saveAccountKey = k => secrets.set(SYNC_ACCOUNT_KEY, { keyId: k.keyId, key: b64url(k.key) });

  const ready = (k, state, changed, v2 = false) => ({ status: 'ready', key: { keyId: k.keyId, key: k.key, ...deriveItemKeys(k.key) }, state, changed, v2 });

  async function hostsList() {
    const list = await client.request('GET', '/v1/hosts');
    return Array.isArray(list?.hosts) ? list.hosts : [];
  }

  /** 新しい K を自分宛てに包む */
  async function newKeyForSelf() {
    const self = hostId();
    const kp = await keyPair();
    const k = newAccountKey();
    const wrapped = wrapKey({ key: k.key, keyId: k.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, targetPublicKey: kp.publicKey, targetHostId: self });
    return { self, kp, k, wrapped };
  }

  /**
   * 新しい K を作り、自分宛てに包んで reset する（前の版の api）。409 previousKeyId → null（呼び出し側が読み直す）。
   * 409 reset_confirm → { confirmNeeded: 誤りの本文 }（今の keyId・itemCount・totalBytes・updatedAt・holders）
   */
  async function create(previousKeyId, confirm = null) {
    const { self, k, wrapped } = await newKeyForSelf();
    const body = { keyId: k.keyId, hostId: self, wrapped, previousKeyId };
    if (confirm) body.confirm = { keyId: confirm.keyId, itemCount: confirm.itemCount };
    try {
      const state = await api('POST', '/v1/sync/reset', { body });
      await saveAccountKey(k);
      log(confirm ? 'sync key created (confirmed)' : 'sync key created');
      return ready(k, state, true);
    } catch (e) {
      if (e?.status === 409 && e.code === 'conflict' && e.message === 'previousKeyId') return null;
      if (e?.status === 409 && e.code === 'reset_confirm') return { confirmNeeded: e.body?.error ?? {} };
      throw e;
    }
  }

  /**
   * 鍵を待つ間に見せるもの。鍵を持つ PC（自分を除く。外された PC も registered: false で）・件数・大きさ・最後の更新。
   * itemCount は古い api では null（「データがあるかもしれない」）。stale: 前の鍵を持っていた（ほかの PC が始め直した）
   */
  async function waitInfo(state, local, listed = null) {
    const self = hostId();
    listed ??= new Map((await hostsList()).map(h => [h?.hostId, h]));
    const holders = Array.isArray(state?.holders)
      ? state.holders.filter(h => typeof h?.hostId === 'string' && h.hostId !== self).map(h => ({
        hostId: h.hostId, name: h.name ?? listed.get(h.hostId)?.name ?? null, lastSyncAt: h.lastSyncAt ?? null,
        registered: h.registered === true && listed.has(h.hostId),
      }))
      : (Array.isArray(state?.hostsWithKey) ? state.hostsWithKey : []).filter(id => id !== self).map(id => ({
        hostId: id, name: listed.get(id)?.name ?? null, lastSyncAt: null, registered: listed.has(id),
      }));
    return {
      holder: holders.some(h => h.registered),
      holders,
      keyId: state?.keyId ?? null,
      itemCount: Number.isSafeInteger(state?.itemCount) ? state.itemCount : null,
      totalBytes: Number.isFinite(state?.totalBytes) ? state.totalBytes : 0,
      updatedAt: state?.updatedAt ?? null,
      lastWriter: state?.lastWriter ?? null,
      resetAt: state?.resetAt ?? null,
      resetBy: state?.resetBy ?? null,
      stale: !!local && local.keyId !== state?.keyId,
    };
  }

  /** 409 reset_confirm の本文（今の値）で、見せるものを作り直す */
  const confirmWait = (body, state, local) => waitInfo({
    ...state,
    keyId: typeof body.keyId === 'string' ? body.keyId : state?.keyId,
    itemCount: body.itemCount, totalBytes: body.totalBytes, updatedAt: body.updatedAt ?? state?.updatedAt ?? null,
    holders: Array.isArray(body.holders) ? body.holders : state?.holders,
  }, local);

  /**
   * 自分宛ての包みを開く。開けなければ null（ログに sync key unwrap failed）。
   * wrapperPub: 包んだ PC の同期の公開鍵（承認の窓で確認コードに使ったもの）。無ければ台帳の値
   */
  async function openMine(state, wrapperPubs = null) {
    let got;
    try { got = await api('GET', `/v1/sync/keys/${encodeURIComponent(hostId())}`); }
    catch (e) {
      if (e?.status === 404) return { missing: true };
      throw e;
    }
    if (got?.keyId !== state.keyId) return { missing: false, key: null };
    const wrapperPub = wrapperPubs?.get(got.wrappedBy)
      ?? pub32((await hostsList()).find(h => h?.hostId === got.wrappedBy)?.syncPublicKey);
    const kp = await keyPair();
    const key = wrapperPub
      ? unwrapKey({ wrapped: got.wrapped, keyId: got.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, wrapperPublicKey: wrapperPub, hostId: hostId() })
      : null;
    if (!key) { log('sync key unwrap failed'); return { missing: false, key: null }; }
    return { missing: false, key: { keyId: got.keyId, key } };
  }

  /**
   * 始め方。{ status: 'disabled'|'waiting_key'|'confirm_needed'|'ready', key?, state, changed?, wait?, v2? } を返す。
   * changed: 手元の鍵が替わった（項目を cursor 0 から読み直す）
   * wait: waiting_key・confirm_needed のときに見せるもの（waitInfo。v2 では申し込み・回復の欄を足す）
   * confirm: 人が件数を見て確かめた印 { keyId, itemCount }（前の版の api で forceNew のときだけ送る）
   */
  async function setup(opts = {}) {
    return (await isV2()) ? setupV2(opts) : setupLegacy(opts);
  }

  async function setupLegacy({ forceNew = false, confirm = null } = {}) {
    for (let i = 0; i < RESET_TRIES; i++) {
      const self = hostId();
      const state = await api('GET', self ? `/v1/sync/state?hostId=${encodeURIComponent(self)}` : '/v1/sync/state');
      if (!state?.enabled) return { status: 'disabled', state };
      const local = await storedAccountKey();
      if (forceNew) {
        const made = await create(state.keyId ?? null, confirm);
        if (made?.confirmNeeded) return { status: 'confirm_needed', state, wait: await confirmWait(made.confirmNeeded, state, local) };
        if (made) return made;
        forceNew = false;   // ほかの PC が先に作り直した → その鍵を受け取る
        confirm = null;
        continue;
      }
      if (state.keyId == null) {
        const made = await create(null);
        if (made && !made.confirmNeeded) return made;
        continue;
      }
      if (local?.keyId === state.keyId) return ready(local, state, false);
      const mine = await openMine(state);
      if (mine.key) {
        await saveAccountKey(mine.key);
        return ready(mine.key, state, true);
      }
      const wait = await waitInfo(state, local);
      // サーバーに項目が無く、鍵を持つほかの PC も居なければ、消えるものが無いので作り直す。
      // 項目がある・数が分からない（古い api）ときは、人が確かめるまで待つ
      if (mine.missing && wait.itemCount === 0 && !wait.holder) {
        const made = await create(state.keyId);
        if (made && !made.confirmNeeded) return made;
        continue;   // その間に項目が書かれた・ほかの PC が作った → 読み直す
      }
      return { status: 'waiting_key', state, wait };
    }
    return { status: 'waiting_key', state: null, wait: null };
  }

  // ---- v2 ------------------------------------------------------------------------------------------------

  /**
   * v2 の K を置く（POST /v1/sync/reset）。prev: 今の K（署名に使う。null なら署名しない＝初めて・移行）。
   * carryTo: 作り直しのあと承認なしで渡す PC（作り直す前の鍵を持つ PC）。409 previousKeyId → null
   */
  async function placeV2(state, prev, carryTo = []) {
    const { self, kp, k, wrapped } = await newKeyForSelf();
    const resetPublicKey = resetKeyPair(k.key).publicKey;
    const previousKeyId = state.keyId ?? null;
    // 引き継ぐ PC ごとの印（前の K から作る）。置いた後に前の K を捨てても carry を続けられるよう、先に作って覚える
    const nonces = prev && previousKeyId ? Object.fromEntries(carryTo.map(t => [t,
      b64url(carryNonce({ prevKey: prev.key, uid: uid(), previousKeyId, keyId: k.keyId, resetPublicKey, targetHostId: t }))])) : {};
    const body = { keyId: k.keyId, hostId: self, wrapped, previousKeyId, resetPublicKey, syncPublicKey: b64url(kp.publicKey) };
    if (prev) body.signature = resetKeyPair(prev.key).sign(resetMessage({ uid: uid(), previousKeyId, keyId: k.keyId, hostId: self, resetPublicKey }));
    let next;
    try { next = await api('POST', '/v1/sync/reset', { body }); }
    catch (e) {
      if (e?.status === 409 && e.code === 'conflict' && e.message === 'previousKeyId') return null;
      throw e;
    }
    await saveAccountKey(k);
    await secrets.delete(SYNC_APPROVALS).catch(() => {});
    log(previousKeyId == null ? 'sync key created' : prev ? 'sync key rotated' : 'sync key migrated');
    await clearRestart();
    if (carryTo.length && Object.keys(nonces).length) {
      await secrets.set(SYNC_CARRY, { keyId: k.keyId, hosts: carryTo, nonces });
      await carry(k);
    } else {
      await secrets.delete(SYNC_CARRY).catch(() => {});
    }
    return ready(k, next, true, true);
  }

  /**
   * 作り直した K を、引き継ぐ PC（carry）へ承認なしで渡す。渡せた・断られた（もう carry に居ない）ものは覚えから外す。
   * 包みの nonce は前の K から作った印（受け取る PC が確かめる）。印の無い覚え（前の版の覚え）は渡さずに捨てる
   */
  async function carry(k) {
    const held = await secrets.get(SYNC_CARRY).catch(() => null);
    if (!held || held.keyId !== k.keyId || !Array.isArray(held.hosts) || !held.hosts.length) return;
    const hosts = await hostsList();
    const kp = await keyPair();
    const left = [];
    for (const target of held.hosts) {
      const nonce = fromB64url(held.nonces?.[target]);
      if (nonce.length !== 12) continue;   // 印が無い: 受け取る PC が確かめられないので渡さない
      const pub = pub32(hosts.find(h => h?.hostId === target)?.syncPublicKey);
      if (!pub) continue;   // 台帳に居ない（外された）
      const wrapped = wrapKey({ key: k.key, keyId: k.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, targetPublicKey: pub, targetHostId: target, nonce });
      try {
        await api('PUT', `/v1/sync/keys/${encodeURIComponent(target)}`, { body: { keyId: k.keyId, wrapped, wrappedBy: hostId() } });
        log('sync key carried');
      } catch (e) {
        if (e?.status === 409 && e.message === 'keyId') return;   // ほかの PC がさらに作り直した
        if (e?.status === 403 || e?.status === 404) continue;      // carry から外れた・台帳に居ない
        log(`sync key carry failed (${e?.code ?? 'error'})`);
        left.push(target);
      }
    }
    if (left.length) await secrets.set(SYNC_CARRY, { keyId: k.keyId, hosts: left, nonces: held.nonces });
    else await secrets.delete(SYNC_CARRY).catch(() => {});
  }

  /** 前の K では確かめられない新しい K（keyId）へ移ると人が選んだか */
  async function acceptedRestart(keyId) {
    const v = await secrets.get(SYNC_RESTART).catch(() => null);
    return !!v && v.uid === uid() && v.keyId === keyId;
  }
  const clearRestart = () => secrets.delete(SYNC_RESTART).catch(() => {});

  /**
   * 人が「新しい鍵を受け取る」を選んだ（回復・移行で作り直された K）。今の keyId が見せたものと同じときだけ覚える。
   * この後の回で申し込み、承認の窓を通して受け取る。戻り値 { accepted } か { changed: true }（その間にまた替わった）
   */
  async function acceptRestart(keyId) {
    const state = await api('GET', '/v1/sync/state');
    if (!state?.keyId || state.keyId !== keyId) return { changed: true };
    await secrets.set(SYNC_RESTART, { uid: uid(), keyId });
    log('sync restart accepted');
    return { accepted: true };
  }

  /** 受け取る側の申し込みの覚え（このアカウント・この同期の鍵対のものだけ） */
  async function joinSecret(myPub) {
    const v = await secrets.get(SYNC_JOIN).catch(() => null);
    return v && v.uid === uid() && v.syncPub === myPub && typeof v.commit === 'string' && pub32(v.nonceN) ? v : null;
  }
  const clearJoin = () => secrets.delete(SYNC_JOIN).catch(() => {});

  /** 承認していた PC の同期の公開鍵（申し込みの覚えから。確認コードに使った鍵で開く） */
  async function approverPubs() {
    const v = await secrets.get(SYNC_JOIN).catch(() => null);
    const pub = pub32(v?.approverPub);
    return v?.uid === uid() && pub && v.approverHostId ? new Map([[v.approverHostId, pub]]) : null;
  }

  /**
   * 受け取る側（N）の 1 歩。申し込み・中身を明かす・確認コードを出す。
   * 戻り値: { state: committed|challenged|revealed|denied, code, approver: { hostId, name }|null, deniedAt }
   */
  async function joinStep(state, hostsById) {
    const kp = await keyPair();
    const myPub = b64url(kp.publicKey);
    let mine = await joinSecret(myPub);
    let j = state.join ?? null;

    if (j?.state === 'denied' && now() - Date.parse(j.deniedAt) < DENY_WAIT_MS) {
      return { state: 'denied', code: null, approver: null, deniedAt: j.deniedAt };
    }
    const fresh = !j || j.state === 'denied' || j.state === 'granted' || !mine || mine.commit !== j.commit;
    if (fresh) {
      // 覚えの無い申し込み（覚えを失った・前の鍵対のもの）は取り下げてから、新しい nonceN で申し込む
      if (j && j.state !== 'denied' && j.state !== 'granted') await api('DELETE', '/v1/sync/join');
      const nonceN = random32();
      mine = { uid: uid(), syncPub: myPub, nonceN: b64url(nonceN), commit: joinCommit(nonceN, kp.publicKey), approverHostId: null, approverPub: null, nonceH: null, code: null };
      await secrets.set(SYNC_JOIN, mine);
      try {
        j = (await api('POST', '/v1/sync/join', { body: { commit: mine.commit } }))?.join ?? null;
      } catch (e) {
        if (e?.status === 429) return { state: 'denied', code: null, approver: null, deniedAt: j?.deniedAt ?? null };
        if (e?.status === 409 && e.message === 'join') {
          await api('DELETE', '/v1/sync/join');
          j = (await api('POST', '/v1/sync/join', { body: { commit: mine.commit } }))?.join ?? null;
        } else throw e;
      }
      log('sync join requested');
    }
    if (!j) return { state: 'committed', code: null, approver: null, deniedAt: null };

    if (j.state === 'committed') {
      // 承認の途中から戻った（承認していた PC が外された・新しい K が置かれた）: 承認の窓を最初から
      if (mine.approverHostId || mine.code) {
        mine = { ...mine, approverHostId: null, approverPub: null, nonceH: null, code: null };
        await secrets.set(SYNC_JOIN, mine);
        log('sync join restarted');
      }
      return { state: 'committed', code: null, approver: null, deniedAt: null };
    }
    if (j.state !== 'challenged' && j.state !== 'revealed') return { state: 'committed', code: null, approver: null, deniedAt: null };

    // 承認する PC（approver）の同期の公開鍵は GET /v1/sync/join で読む
    const sameRound = mine.code && mine.approverHostId === j.approverHostId && mine.nonceH === j.nonceH;
    if (j.state === 'revealed' && sameRound) {
      return { state: 'revealed', code: mine.code, approver: { hostId: j.approverHostId, name: hostsById.get(j.approverHostId)?.name ?? null }, deniedAt: null };
    }
    const full = (await api('GET', '/v1/sync/join'))?.join ?? null;
    const approverPub = pub32(full?.approver?.syncPublicKey);
    const nonceH = pub32(full?.nonceH);
    if (!full || full.commit !== mine.commit || !approverPub || !nonceH || full.approverHostId !== full.approver?.hostId) {
      return { state: 'committed', code: null, approver: null, deniedAt: null };
    }
    const approver = { hostId: full.approverHostId, name: full.approver?.name ?? hostsById.get(full.approverHostId)?.name ?? null };
    if (full.state === 'challenged') {
      try {
        await api('POST', '/v1/sync/join/reveal', { body: { nonceN: mine.nonceN, syncPublicKey: myPub } });
      } catch (e) {
        if (e?.status === 409) return { state: 'challenged', code: null, approver, deniedAt: null };   // 状態が変わった。次の回で読み直す
        if (e?.status === 422) { await clearJoin(); return { state: 'committed', code: null, approver: null, deniedAt: null }; }
        throw e;
      }
    } else if (full.state !== 'revealed' || full.nonceN !== mine.nonceN || full.syncPublicKey !== myPub) {
      return { state: 'committed', code: null, approver: null, deniedAt: null };
    }
    const code = joinCode({ nonceN: fromB64url(mine.nonceN), nonceH, syncPubN: kp.publicKey, syncPubH: approverPub });
    mine = { ...mine, approverHostId: approver.hostId, approverPub: b64url(approverPub), nonceH: full.nonceH, code };
    await secrets.set(SYNC_JOIN, mine);
    return { state: 'revealed', code, approver, deniedAt: null };
  }

  /**
   * v2 の自分宛ての包みを開く（サーバーが渡す K をそのまま受けない）。
   * - 手元に前の K がある: 前の K から作った印（carry）が合うものだけ。合わなければ、人が移ると選んでいて
   *   承認した PC が包んだものだけ（accepted）
   * - 手元に K が無い: 承認した PC（approverHostId）が、承認の窓で見た公開鍵で包んだものだけ
   * 戻り値 { missing } | { key } | { key: null, unverified }（開けたが確かめられなかった）
   */
  async function openV2(state, local, accepted) {
    const self = hostId();
    let got;
    try { got = await api('GET', `/v1/sync/keys/${encodeURIComponent(self)}`); }
    catch (e) {
      if (e?.status === 404) return { missing: true };
      throw e;
    }
    if (got?.keyId !== state.keyId || typeof got.wrappedBy !== 'string') return { missing: false, key: null };
    const kp = await keyPair();
    const open = pub => unwrapKey({ wrapped: got.wrapped, keyId: got.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, wrapperPublicKey: pub, hostId: self });
    if (local && local.keyId !== got.keyId) {
      const pub = pub32((await hostsList()).find(h => h?.hostId === got.wrappedBy)?.syncPublicKey);
      const key = pub ? open(pub) : null;
      if (key) {
        const nonce = carryNonce({ prevKey: local.key, uid: uid(), previousKeyId: local.keyId, keyId: got.keyId, resetPublicKey: resetKeyPair(key).publicKey, targetHostId: self });
        if (isCarryWrap(got.wrapped, nonce)) return { missing: false, key: { keyId: got.keyId, key } };
      }
    }
    const approver = !local || accepted ? (await approverPubs())?.get(got.wrappedBy) : null;
    if (approver) {
      const key = open(approver);
      if (key) return { missing: false, key: { keyId: got.keyId, key } };
    }
    log('sync key unverified');
    return { missing: false, key: null, unverified: true };
  }

  async function setupV2({ forceNew = false } = {}) {
    for (let i = 0; i < RESET_TRIES; i++) {
      const self = hostId();
      const state = await api('GET', '/v1/sync/state');
      if (!state?.enabled) return { status: 'disabled', state, v2: true };
      const local = await storedAccountKey();
      if (state.keyId == null) {
        const made = await placeV2(state, null);
        if (made) return made;
        continue;
      }
      // 手元の K が前のもの: 前の K で確かめられる包み（carry）か、人が移ると選んだ後の承認だけで替える
      const stale = !!local && local.keyId !== state.keyId;
      const restartOk = stale ? await acceptedRestart(state.keyId) : false;
      let unverified = false;
      if (state.self?.holder) {
        let k = local?.keyId === state.keyId ? local : null;
        let changed = false;
        if (!k) {
          const mine = await openV2(state, local, restartOk);
          if (mine.key) { k = mine.key; await saveAccountKey(k); await clearRestart(); changed = true; log('sync key received'); }
          else unverified = !!mine.unverified;
        }
        if (k) {
          // 鍵を受け取ったら、残っている自分の申し込みは取り下げる（ほかの PC の承認の窓に残さない）
          if (state.join && state.join.state !== 'granted') await api('DELETE', '/v1/sync/join').catch(() => {});
          await clearJoin();
          // 前の版で作った K: 最初の v2 の PC が作り直す（ほかの PC は承認を通して受け取る）
          if (!state.signedReset) {
            const made = await placeV2(state, null);
            if (made) return made;
            continue;
          }
          if (state.rotate || forceNew) {
            const carryTo = (Array.isArray(state.holders) ? state.holders : [])
              .filter(h => h?.registered === true && typeof h.hostId === 'string' && h.hostId !== self).map(h => h.hostId);
            const made = await placeV2(state, k, carryTo);
            forceNew = false;
            if (made) return made;
            continue;
          }
          return ready(k, state, changed, true);
        }
      }
      const listed = new Map((await hostsList()).map(h => [h?.hostId, h]));
      const wait = await waitInfo(state, local, listed);
      wait.recovery = state.recovery ?? null;
      wait.recoveryMine = !!state.recovery && state.recovery.requestedBy === self;
      // 回復を頼まれていて、今の K をこの PC が持っている（外されて受け取り直す前など）: K の署名で止められる
      wait.recoveryStop = !!state.recovery && !wait.recoveryMine && local?.keyId === state.keyId;
      wait.v2 = true;
      // 確かめられない包みが来ている（サーバーはこの PC を鍵を持つ PC と見ている）: 受けずに止める。申し込みもしない
      wait.unverified = unverified;
      if (stale && (!restartOk || unverified)) {
        // 前の K を持つ PC: 前の K で確かめられない新しい K へは自動で移らない（人が選ぶ。確かめられない包みが来ていたら止める）
        wait.restarted = {
          keyId: state.keyId, unverified,
          by: state.resetBy?.hostId ?? null, byName: state.resetBy?.name ?? listed.get(state.resetBy?.hostId)?.name ?? null,
          at: state.resetAt ?? null,
        };
      } else if (wait.holder && !unverified) wait.join = await joinStep(state, listed);
      return { status: 'waiting_key', state, wait, v2: true };
    }
    return { status: 'waiting_key', state: null, wait: null, v2: true };
  }

  /**
   * 鍵を持つホストとして、宛ての無いホスト（state.pending）に包んで渡す（前の版の api だけ）。
   * 戻り値: 'ok' | 'rekey'（409 keyId。state を読み直して始め方へ）
   */
  async function sharePending(state, key) {
    const pending = (Array.isArray(state?.pending) ? state.pending : []).filter(h => h !== hostId());
    if (!pending.length || !key || state.keyId !== key.keyId) return 'ok';
    const hosts = await hostsList();
    const kp = await keyPair();
    for (const target of pending) {
      const pub = fromB64url(hosts.find(h => h?.hostId === target)?.syncPublicKey);
      if (pub.length !== 32) continue;
      const wrapped = wrapKey({ key: key.key, keyId: key.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, targetPublicKey: pub, targetHostId: target });
      try {
        await api('PUT', `/v1/sync/keys/${encodeURIComponent(target)}`, { body: { keyId: key.keyId, wrapped, wrappedBy: hostId() } });
        log('sync key shared');
        try { onShared({ hostId: target, name: hosts.find(h => h?.hostId === target)?.name ?? null }); } catch {}
      } catch (e) {
        if (e?.status === 409 && e.message === 'keyId') return 'rekey';
        log(`sync key share failed (${e?.code ?? 'error'})`);
      }
    }
    return 'ok';
  }

  // ---- 渡す側（H）の承認 -------------------------------------------------------------------------------

  async function approvalsSecret() {
    const v = await secrets.get(SYNC_APPROVALS).catch(() => null);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  /** 申し込みを照らして確認コードを出す。照らせない（覚えと違う・commit が合わない）なら null */
  function codeFor(j, mine, kp, keyId) {
    if (!mine || mine.keyId !== keyId || mine.commit !== j.commit || mine.nonceH !== j.nonceH) return null;
    const nonceN = pub32(j.nonceN), syncPubN = pub32(j.syncPublicKey), nonceH = pub32(mine.nonceH);
    if (!nonceN || !syncPubN || !nonceH || joinCommit(nonceN, syncPubN) !== j.commit) return null;
    return joinCode({ nonceN, nonceH, syncPubN, syncPubH: kp.publicKey });
  }

  /**
   * 鍵を持つ PC の承認の流れ（v2）。新しい申し込みに nonceH を置き（challenge）、明かされたものに確認コードを付けて返す。
   * 渡すのは人が承認したとき（approve）だけ。引き継ぐ PC（carry）への残りもここで渡す。
   * 戻り値: { list: [{ hostId, name, platform, app, code, at }], waiting: 明かされるのを待っている数 }
   */
  async function approvals(state, key) {
    if (key) await carry(key);
    let store = await approvalsSecret();
    // state の joins は、自分が challenge して明かされるのを待つもの（challenged）を数えない。覚えがあれば一覧を読んで確かめる
    if (!(Number(state?.joins) > 0) && !Object.keys(store).length) return { list: [], waiting: 0 };
    const self = hostId();
    const joins = (await api('GET', '/v1/sync/joins'))?.joins ?? [];
    const kp = await keyPair();
    let hosts = null;
    const list = [];
    let waiting = 0;
    const asked = new Set();   // この回で challenge したもの（読んだ一覧ではまだ committed）
    for (const j of joins) {
      if (typeof j?.hostId !== 'string' || j.hostId === self) continue;
      if (j.state === 'committed') {
        const nonceH = b64url(random32());
        store = { ...store, [j.hostId]: { nonceH, commit: j.commit, keyId: key.keyId } };
        await secrets.set(SYNC_APPROVALS, store);   // challenge の前に覚える（応答を失っても照らせるように）
        try {
          await api('POST', `/v1/sync/joins/${encodeURIComponent(j.hostId)}/challenge`, { body: { nonceH } });
          waiting++;
          asked.add(j.hostId);
          log('sync join challenged');
        } catch (e) {
          if (e?.status !== 409 && e?.status !== 404) throw e;   // ほかの PC が先に担った・取り下げられた
        }
        continue;
      }
      if (j.approverHostId !== self) continue;
      if (j.state === 'challenged') { waiting++; continue; }
      if (j.state !== 'revealed') continue;
      const code = codeFor(j, store[j.hostId], kp, key.keyId);
      if (!code) { log('sync join unverified'); continue; }
      hosts ??= new Map((await hostsList()).map(h => [h?.hostId, h]));
      const h = hosts.get(j.hostId);
      list.push({ hostId: j.hostId, name: j.name ?? h?.name ?? null, platform: h?.platform ?? null, app: h?.appVersion ?? null, code, at: j.updatedAt ?? null });
    }
    // 担っていない・終わった申し込みの覚えは捨てる
    const live = new Set([...asked, ...joins.filter(j => j?.approverHostId === self && (j.state === 'challenged' || j.state === 'revealed')).map(j => j.hostId)]);
    const pruned = Object.fromEntries(Object.entries(store).filter(([id]) => live.has(id)));
    if (Object.keys(pruned).length !== Object.keys(store).length) await secrets.set(SYNC_APPROVALS, pruned);
    return { list, waiting };
  }

  /**
   * 人が承認した: 申し込みを読み直して照らし、見せた確認コードと同じなら包んで渡す。
   * 戻り値 { shared: true } か { shared: false, reason: 'gone'|'changed'|'no_key' }
   */
  async function approve(target, shownCode = null) {
    const key = await storedAccountKey();
    if (!key) return { shared: false, reason: 'no_key' };
    const j = ((await api('GET', '/v1/sync/joins'))?.joins ?? []).find(x => x?.hostId === target);
    if (!j || j.state !== 'revealed' || j.approverHostId !== hostId()) return { shared: false, reason: 'gone' };
    const kp = await keyPair();
    const store = await approvalsSecret();
    const code = codeFor(j, store[target], kp, key.keyId);
    if (!code || (shownCode != null && code !== shownCode)) return { shared: false, reason: 'changed' };
    const wrapped = wrapKey({ key: key.key, keyId: key.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, targetPublicKey: pub32(j.syncPublicKey), targetHostId: target });
    try {
      await api('PUT', `/v1/sync/keys/${encodeURIComponent(target)}`, { body: { keyId: key.keyId, wrapped, wrappedBy: hostId() } });
    } catch (e) {
      if (e?.status === 409 || (e?.status === 403 && e.message === 'approval')) return { shared: false, reason: 'gone' };
      throw e;
    }
    const { [target]: _done, ...rest } = store;
    await secrets.set(SYNC_APPROVALS, rest);
    log('sync key shared');
    try { onShared({ hostId: target, name: j.name ?? null }); } catch {}
    return { shared: true };
  }

  /** 人が断った（渡さない）。申し込んだ PC は 1 時間たつまで申し込み直せない */
  async function deny(target) {
    try { await api('DELETE', `/v1/sync/joins/${encodeURIComponent(target)}`); }
    catch (e) { if (e?.status !== 404 && e?.status !== 409) throw e; }
    const { [target]: _done, ...rest } = await approvalsSecret();
    await secrets.set(SYNC_APPROVALS, rest);
    log('sync join denied');
    return { denied: true };
  }

  // ---- 回復（鍵を持つ PC が 1 台も無いとき） ---------------------------------------------------------------

  /** 回復を頼む。最近のログインが要る（無ければ { reauth: true }）。戻り値 { recovery } か { reauth } か { holder } か { other } */
  async function recoveryRequest() {
    try {
      const out = await api('POST', '/v1/sync/recovery', { body: {} });
      log('sync recovery requested');
      return { recovery: out?.recovery ?? null };
    } catch (e) {
      if (e?.status === 403 && e.code === 'reauth_required') return { reauth: true };
      if (e?.status === 409 && e.message === 'holder') return { holder: true };
      if (e?.status === 409 && e.message === 'recovery') return { other: true };   // ほかの PC が頼んで待っている
      throw e;
    }
  }

  /** 自分の頼んだ回復を取り下げる */
  async function recoveryCancel() {
    try { await api('DELETE', '/v1/sync/recovery'); }
    catch (e) { if (e?.status !== 404) throw e; }
    log('sync recovery cancelled');
    return { cancelled: true };
  }

  /**
   * 待ちが明けた回復を仕上げる: 新しい K を置く（前のデータは消える）。
   * 戻り値 { done: true } か { waiting: readyAt } か { holder: true } か { gone: true }
   */
  async function recoveryComplete() {
    const { self, kp, k, wrapped } = await newKeyForSelf();
    const body = { keyId: k.keyId, hostId: self, wrapped, resetPublicKey: resetKeyPair(k.key).publicKey, syncPublicKey: b64url(kp.publicKey) };
    try { await api('POST', '/v1/sync/recovery/complete', { body }); }
    catch (e) {
      if (e?.status === 409 && e.message === 'recovery_waiting') return { waiting: e.body?.error?.readyAt ?? e.readyAt ?? null };
      if (e?.status === 409 && e.message === 'holder') return { holder: true };
      if (e?.status === 404) return { gone: true };
      throw e;
    }
    await saveAccountKey(k);
    await clearJoin();
    await secrets.delete(SYNC_APPROVALS).catch(() => {});
    await secrets.delete(SYNC_CARRY).catch(() => {});
    await clearRestart();
    log('sync recovery completed');
    return { done: true };
  }

  /**
   * 回復の待ちを読む（券は要らない。外された PC でも読める）。
   * 戻り値: 今の K を手元に持っていて回復が頼まれていれば { recovery }、ほかは null
   */
  async function recoveryWatch() {
    const local = await storedAccountKey();
    if (!local) return null;
    const got = await client.request('GET', '/v1/sync/recovery');
    return got?.recovery && got.keyId === local.keyId && got.signedReset ? { recovery: got.recovery } : null;
  }

  /** 回復を K の署名で止める（鍵を持つ PC から。外された PC でも止められる）。戻り値 { stopped } */
  async function recoveryStop() {
    const local = await storedAccountKey();
    if (!local) return { stopped: false, reason: 'no_key' };
    const got = await client.request('GET', '/v1/sync/recovery');
    if (!got?.recovery) return { stopped: false, reason: 'gone' };
    if (got.keyId !== local.keyId) return { stopped: false, reason: 'no_key' };
    const signature = resetKeyPair(local.key).sign(recoveryCancelMessage({ uid: uid(), keyId: local.keyId, requestedAt: got.recovery.requestedAt }));
    try { await client.request('DELETE', '/v1/sync/recovery', { body: { keyId: local.keyId, signature } }); }
    catch (e) {
      if (e?.status === 404) return { stopped: false, reason: 'gone' };
      if (e?.status === 409 || e?.status === 422) return { stopped: false, reason: 'no_key' };
      throw e;
    }
    log('sync recovery stopped');
    return { stopped: true };
  }

  /** ログアウト: アカウントの同期鍵と、申し込み・承認の途中の覚えを消す（ホストの鍵対は残す） */
  const forget = async () => {
    for (const name of [SYNC_ACCOUNT_KEY, SYNC_JOIN, SYNC_APPROVALS, SYNC_CARRY, SYNC_RESTART]) await secrets.delete(name).catch(() => {});
  };

  return {
    keyPair, publicKey, setup, sharePending, forget, storedAccountKey,
    approvals, approve, deny, acceptRestart, recoveryRequest, recoveryCancel, recoveryComplete, recoveryWatch, recoveryStop,
  };
}
