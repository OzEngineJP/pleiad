// 同期の鍵の始め方と受け渡し（docs/plus.md「同期」「同期の始め直しと登録の外れ」）。鍵は端末の中で作り、api にはホストごとに包んだものだけを渡す。
// 人に鍵を意識させない（ADR 0346）: 画面に出すのは同期の状態だけ。始め直し・戻り方は api の決まりに従って自動で進める。
//
//   plus:syncKey         このホストの同期用の X25519 の鍵対 { privateKey, publicKey }（raw 32 バイトの base64url）。ログアウトでも残す
//   plus:syncAccountKey  アカウントの同期鍵 { uid, keyId, key }（key は raw 32 バイトの base64url）。別の uid で同期を始めるときだけ消す
//   plus:syncJoin        鍵を受け取る側の申し込み { uid, syncPub, nonceN, commit, approverHostId, approverPub, nonceH, code }
//   plus:syncApprovals   鍵を渡す側の承認の途中 { [申し込んだ hostId]: { nonceH, commit, keyId } }
//   plus:syncCarry       作り直した K を引き継ぐ PC のうち、まだ渡せていないもの { keyId, hosts: [hostId], nonces: { [hostId]: nonce } }
//   plus:syncRestart     前の K では確かめられない新しい K（始め直し）へ移ると人が選んだ印 { uid, keyId }
//   plus:syncV2Seen      券を一度でも取れたアカウント { [uid]: 初めて取れた時刻 }。ログアウトでも残す
//   plus:syncV2Fingerprints  受け取った・作った K の指紋 { [uid]: { keyId, resetPublicKey } }。ログアウトでも残す
//
// api の版で 2 つの道がある。同期の券（ticket.mjs）を取れる api が v2、券の口が 404 の api は前の版（legacy）。
// 一度券を取れたアカウントで券の口が 404 になったら、前の版の道（K を自動で包んで渡す）へ戻らず止める（api_downgraded）。
//
// K の持ち方: K は uid に結んで保存する。サインアウトでは消さない。保存の uid が今の uid と違うときだけ捨てる（index.mjs）。
// 前の版で保存した uid の無い K は、指紋が今の uid のものと合えば今の uid に結び、ほかの uid の指紋と合えば捨てる。どちらでもなければ今の uid に結ぶ。
// 秘密の読み出しの誤りは「無い」と分ける（読めないときは投げて、次の回にやり直す。サーバーへ K を無くしたとは知らせない）。
//
// 前の版（setupLegacy・sharePending）:
//   1. GET /v1/sync/state?hostId=<自分>。enabled が false なら disabled
//   2. keyId が null → K を作り、自分宛てに包んで POST /v1/sync/reset（previousKeyId: null）
//   3. 手元の keyId と同じ → そのまま使う
//   4. 違う・無い → GET /v1/sync/keys/{自分} を wrappedBy の syncPublicKey で開いて保管する（開けなければ待つ）
//   5. 自分宛てが無い（404）→ 待つ。サーバーに項目が無く（itemCount が 0）、鍵を持つほかのホストも居なければ作り直す
//   鍵を持つホストは、宛ての無いホスト（state.pending）に自動で包んで渡す
//
// v2（setupV2。同期の口はすべて券つき）:
//   K を作る・作り直すときは、K から作った署名の鍵の公開鍵（resetPublicKey）を置く。作り直しは今の K の署名が要る
//   holder は「活動中」のものだけ数える（state.holders[] の registered && !lost && active。D11）
//   - keyId が null → K を作る（署名なし）
//   - 鍵を持つ PC（state.self.holder）:
//       signedReset が false（前の版で作った K）→ 移行: 署名なしで作り直し、外されていない前の holder へ carry する
//       rotate（鍵を持つ PC が外された）・容量のリセット → 今の K で署名して作り直し、残りの holder へ承認なしで渡す（carry）
//       自分の行があるのに K が無く、ほかに活動中の holder も居ない → DELETE /v1/sync/keys/{自分}（K を無くしたと知らせる。D9）
//   - 鍵を持たない PC:
//       手元の K が今の keyId と同じ → K の署名を付けて自分宛ての包みを置く（証明で戻る。PUT /v1/sync/keys/{自分} の proof）
//       活動中の holder が居る → 申し込む（commit–reveal）。前の K の PC は人が「{name} と同期する」を押してから
//       居ない → state.restart に従って自動で始め直す（POST /v1/sync/recovery → readyAt → POST /v1/sync/recovery/complete）。
//         restart が無い（古い api）なら自分から始め直さない。明けたかは complete の応答で知る（手元の時計で決めない）
//   申し込み（受け取る側 N）: nonceN と自分の同期の公開鍵の commit を置く → 渡す側 H が nonceH を置く（challenged）→ N が中身を明かす（revealed）
//     → 両方が同じ 6 桁の確認コードを出し、H の人が見比べて許可する・許可しないを選ぶ。
//     途中で committed に戻った（承認していた PC が外された・新しい K が置かれた）ら、承認の窓を最初からやり直す
//   受け取った包みの確かめ（サーバーが渡す K をそのまま受けない）:
//   - K を持たない PC: 承認の窓で確認コードに使った PC（approverHostId）が、その公開鍵（approverPub）で包んだものだけを開く
//   - 前の K を持つ PC: 作り直した PC が前の K から作った印（crypto.mjs の carryNonce）を包みに入れる。手元の前の K で
//     確かめられたものだけに切り替える。確かめられなければ切り替えず、手元の状態も消さない
//   - 始め直しで作った K は前の K の印を持たない。前の K を持つ PC は自動で切り替えず（wait.kind: restarted）、
//     人が「{name} と同期する」を押してから（acceptRestart）申し込み、承認の窓を通して受け取る
//   - 手元に K が無く承認した PC の覚えも無いときは、wrappedBy の台帳の公開鍵で開き、keyId と resetPublicKey が指紋と合うものだけを受ける
//   - wrappedBy が自分の hostId で、自分の鍵対で開けたもの（自分で作った・作り直した・始め直した K）も受ける
//
// 待つときの wait（engine の状態に載る。docs/plus.md「エンジンの状態」）:
//   { kind: 'approval', approvers: [名前], code, deniedAt }   ほかの PC の許可を待つ（code は承認の途中の確認コード）
//   { kind: 'preparing', startsAt, relogin }                準備しています（startsAt は始め直しの readyAt）
//   { kind: 'restarted', keyId, by, byName }                前の K の PC。「{name} と同期する」を押すまで待つ
import crypto from 'node:crypto';
import {
  b64url, fromB64url, deriveItemKeys, newAccountKey, newSyncKeyPair, syncKeyPairFromPrivate, wrapKey, unwrapKey, KEY_ID_RX,
  resetKeyPair, resetMessage, recoveryCancelMessage, rejoinMessage, joinCommit, joinCode, carryNonce, isCarryWrap,
} from './crypto.mjs';

export const SYNC_KEY_PAIR = 'plus:syncKey';
export const SYNC_ACCOUNT_KEY = 'plus:syncAccountKey';
export const SYNC_JOIN = 'plus:syncJoin';
export const SYNC_APPROVALS = 'plus:syncApprovals';
export const SYNC_CARRY = 'plus:syncCarry';
export const SYNC_RESTART = 'plus:syncRestart';
export const SYNC_V2_SEEN = 'plus:syncV2Seen';
export const SYNC_V2_FINGERPRINTS = 'plus:syncV2Fingerprints';
const RESET_TRIES = 4;
const DENY_WAIT_MS = 60 * 60_000;
const APPROVERS_SHOWN = 3;

const random32 = () => crypto.randomBytes(32);
const pub32 = s => { const b = fromB64url(s); return b.length === 32 ? b : null; };

/** 活動中の holder（登録していて、K を無くしておらず、7 日以内に同期した。active の無い古い api は活動中と見る） */
export const isActiveHolder = h => typeof h?.hostId === 'string' && h.registered === true && h.lost !== true && h.active !== false;

const approval = (approvers, code = null, deniedAt = null) => ({ kind: 'approval', approvers, code, deniedAt });
const preparing = (startsAt = null, relogin = false) => ({ kind: 'preparing', startsAt, relogin });

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
  /** 証明で戻るのを断られた keyId（同じ K で何度も送らない。起動し直すと忘れる） */
  let rejoinRefused = null;

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

  /**
   * 今の uid の K。無い・形が違う・別の uid のもの → null。秘密を読めない（読み出しの誤り）→ 投げる。
   * uid の無い前の版の形は、指紋で持ち主を決めて今の uid に結ぶ（ほかの uid のものなら捨てる）
   */
  async function keyOwner(v) {
    if (typeof v?.uid === 'string') return v.uid;
    if (!v?.keyId) return null;
    const prints = (await secrets.get(SYNC_V2_FINGERPRINTS)) ?? {};
    const id = uid();
    if (prints[id]?.keyId === v.keyId) return id;
    return Object.keys(prints).find(owner => prints[owner]?.keyId === v.keyId) ?? null;
  }

  async function readAccountKey() {
    const v = await secrets.get(SYNC_ACCOUNT_KEY);
    const key = fromB64url(v?.key);
    if (!(typeof v?.keyId === 'string' && KEY_ID_RX.test(v.keyId) && key.length === 32)) return null;
    const id = uid();
    if (!id) return null;
    if (typeof v.uid === 'string') return v.uid === id ? { keyId: v.keyId, key } : null;
    const owner = await keyOwner(v);
    if (id !== uid()) throw new Error('sync account changed');
    if (owner && owner !== id) {
      await secrets.delete(SYNC_ACCOUNT_KEY);
      log('sync key of another account dropped');
      return null;
    }
    await secrets.set(SYNC_ACCOUNT_KEY, { uid: id, keyId: v.keyId, key: v.key });
    return { keyId: v.keyId, key };
  }
  /** 読めなければ null（承認・見張りなど、読めないときは何もしない所で使う） */
  const storedAccountKey = () => readAccountKey().catch(() => null);
  const assertAccount = accountUid => { if (accountUid !== uid()) throw new Error('sync account changed'); };
  const saveAccountKey = (accountUid, k) => {
    if (uid()) assertAccount(accountUid);
    return secrets.set(SYNC_ACCOUNT_KEY, { uid: accountUid, keyId: k.keyId, key: b64url(k.key) });
  };
  /** 保存した K の持ち主の uid（分からないときは null） */
  const ownerUid = () => secrets.get(SYNC_ACCOUNT_KEY).then(keyOwner).catch(() => null);

  /** 受け取った・作った K の指紋（keyId と resetPublicKey。公開鍵だけ）を uid ごとに覚える。ログアウトでは消さない */
  async function rememberKey(id, k) {
    if (!id || !k) return;
    const resetPublicKey = resetKeyPair(k.key).publicKey;
    const prev = (await secrets.get(SYNC_V2_FINGERPRINTS).catch(() => null))?.[id];
    if (prev?.keyId === k.keyId && prev.resetPublicKey === resetPublicKey) return;   // 変わっていなければ書かない
    await secrets.update(SYNC_V2_FINGERPRINTS, cur => ({ ...(cur ?? {}), [id]: { keyId: k.keyId, resetPublicKey } }));
  }

  /** 覚えた指紋（このアカウントのもの。無ければ null） */
  async function rememberedKey() {
    const v = await secrets.get(SYNC_V2_FINGERPRINTS);
    const f = v?.[uid()];
    return f && KEY_ID_RX.test(String(f.keyId)) && typeof f.resetPublicKey === 'string' ? f : null;
  }

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

  /** 開いてほしい PC の名前（自分を除く活動中の holder。新しい順に 3 台まで。名前の無いものは null） */
  const approverNames = (holders, listed) => holders.filter(h => h.hostId !== hostId() && isActiveHolder(h))
    .slice(0, APPROVERS_SHOWN).map(h => h.name ?? listed?.get(h.hostId)?.name ?? null);

  /** 新しい K を作り、自分宛てに包んで reset する（前の版の api）。409（ほかの PC が先に作った・確かめが要る）→ null（呼び出し側が読み直す） */
  async function create(accountUid, previousKeyId) {
    const { self, k, wrapped } = await newKeyForSelf();
    assertAccount(accountUid);
    try {
      const state = await api('POST', '/v1/sync/reset', { body: { keyId: k.keyId, hostId: self, wrapped, previousKeyId } });
      await saveAccountKey(accountUid, k);
      log('sync key created');
      return ready(k, state, true);
    } catch (e) {
      if (e?.status === 409 && ((e.code === 'conflict' && e.message === 'previousKeyId') || e.code === 'reset_confirm')) return null;
      throw e;
    }
  }

  /**
   * 自分宛ての包みを開く（前の版の api）。開けなければ null（ログに sync key unwrap failed）
   */
  async function openMine(state) {
    let got;
    try { got = await api('GET', `/v1/sync/keys/${encodeURIComponent(hostId())}`); }
    catch (e) {
      if (e?.status === 404) return { missing: true };
      throw e;
    }
    if (got?.keyId !== state.keyId) return { missing: false, key: null };
    const wrapperPub = pub32((await hostsList()).find(h => h?.hostId === got.wrappedBy)?.syncPublicKey);
    const kp = await keyPair();
    const key = wrapperPub
      ? unwrapKey({ wrapped: got.wrapped, keyId: got.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, wrapperPublicKey: wrapperPub, hostId: hostId() })
      : null;
    if (!key) { log('sync key unwrap failed'); return { missing: false, key: null }; }
    return { missing: false, key: { keyId: got.keyId, key } };
  }

  /**
   * 始め方。{ status: 'disabled'|'waiting_key'|'ready', key?, state, changed?, wait?, join?, v2? } を返す。
   * changed: 手元の鍵が替わった（項目を cursor 0 から読み直す）
   * wait: waiting_key のときに見せるもの（ファイルの冒頭の 3 つの形）。join: 申し込みの途中（engine が短い間隔で読み直す）
   * forceNew: 容量のリセット（今の K で署名して作り直す）
   */
  async function setup(opts = {}) {
    const accountUid = uid();
    const v2 = await isV2();
    assertAccount(accountUid);
    const out = v2 ? await setupV2(accountUid, opts) : await setupLegacy(accountUid, opts);
    // K を受け取る・作るたびに指紋を覚える（覚えられなくても同期は続ける）
    if (out?.status === 'ready' && out.key) await rememberKey(accountUid, out.key).catch(() => {});
    assertAccount(accountUid);
    return out;
  }

  async function setupLegacy(accountUid, { forceNew = false } = {}) {
    for (let i = 0; i < RESET_TRIES; i++) {
      assertAccount(accountUid);
      const self = hostId();
      const state = await api('GET', self ? `/v1/sync/state?hostId=${encodeURIComponent(self)}` : '/v1/sync/state');
      if (!state?.enabled) return { status: 'disabled', state };
      const local = await readAccountKey();
      if (forceNew && local?.keyId === state.keyId) {
        forceNew = false;
        const made = await create(accountUid, state.keyId ?? null);
        if (made) return made;
        continue;   // ほかの PC が先に作り直した・確かめが要る → 読み直して今の鍵を受け取る
      }
      if (state.keyId == null) {
        const made = await create(accountUid, null);
        if (made) return made;
        continue;
      }
      if (local?.keyId === state.keyId) return ready(local, state, false);
      const mine = await openMine(state);
      if (mine.key) {
        await saveAccountKey(accountUid, mine.key);
        return ready(mine.key, state, true);
      }
      const listed = new Map((await hostsList()).map(h => [h?.hostId, h]));
      const holders = Array.isArray(state.holders)
        ? state.holders.filter(h => typeof h?.hostId === 'string' && h.hostId !== self && h.registered === true && listed.has(h.hostId))
        : (Array.isArray(state.hostsWithKey) ? state.hostsWithKey : []).filter(id => id !== self && listed.has(id)).map(id => ({ hostId: id, registered: true }));
      // サーバーに項目が無く、鍵を持つほかの PC も居なければ、消えるものが無いので作り直す
      if (mine.missing && state.itemCount === 0 && !holders.length) {
        const made = await create(accountUid, state.keyId);
        if (made) return made;
        continue;   // その間に項目が書かれた・ほかの PC が作った → 読み直す
      }
      const names = approverNames(holders, listed);
      return { status: 'waiting_key', state, wait: names.length ? approval(names) : preparing() };
    }
    return { status: 'waiting_key', state: null, wait: preparing() };
  }

  // ---- v2 ------------------------------------------------------------------------------------------------

  /**
   * v2 の K を置く（POST /v1/sync/reset）。prev: 手元の今の K（carry の印を作る。署名は signedReset のときだけ）。
   * carryTo: 作り直しのあと承認なしで渡す PC（外されていない前の holder − 自分）。409 previousKeyId → null
   */
  async function placeV2(accountUid, state, prev, carryTo = []) {
    const { self, kp, k, wrapped } = await newKeyForSelf();
    assertAccount(accountUid);
    const resetPublicKey = resetKeyPair(k.key).publicKey;
    const previousKeyId = state.keyId ?? null;
    const usable = prev && previousKeyId && prev.keyId === previousKeyId ? prev : null;
    // 引き継ぐ PC ごとの印（前の K から作る）。置いた後に前の K を捨てても carry を続けられるよう、先に作って覚える
    const nonces = usable ? Object.fromEntries(carryTo.map(t => [t,
      b64url(carryNonce({ prevKey: usable.key, uid: uid(), previousKeyId, keyId: k.keyId, resetPublicKey, targetHostId: t }))])) : {};
    const body = { keyId: k.keyId, hostId: self, wrapped, previousKeyId, resetPublicKey, syncPublicKey: b64url(kp.publicKey) };
    const signed = !!usable && state.signedReset === true;
    if (signed) body.signature = resetKeyPair(usable.key).sign(resetMessage({ uid: uid(), previousKeyId, keyId: k.keyId, hostId: self, resetPublicKey }));
    let next;
    try { next = await api('POST', '/v1/sync/reset', { body }); }
    catch (e) {
      if (e?.status === 409 && e.code === 'conflict' && e.message === 'previousKeyId') return null;
      throw e;
    }
    await saveAccountKey(accountUid, k);
    assertAccount(accountUid);
    await secrets.delete(SYNC_APPROVALS).catch(() => {});
    log(previousKeyId == null ? 'sync key created' : signed ? 'sync key rotated' : 'sync key migrated');
    await clearRestart();
    if (carryTo.length && Object.keys(nonces).length) {
      await secrets.set(SYNC_CARRY, { keyId: k.keyId, hosts: carryTo, nonces });
      await carry(k);
    } else {
      await secrets.delete(SYNC_CARRY).catch(() => {});
    }
    return ready(k, next, true, true);
  }

  /** 作り直した K を運ぶ先（外されておらず、K を無くしていない前の holder − 自分。活動していないものも運ぶ） */
  const carryTargets = state => (Array.isArray(state.holders) ? state.holders : [])
    .filter(h => h?.registered === true && h.lost !== true && typeof h.hostId === 'string' && h.hostId !== hostId()).map(h => h.hostId);

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
        if (e?.status === 403 || e?.status === 404) continue;      // carry から外れた・台帳に居ない（古い api は移行の carry を 403 approval で断る）
        log(`sync key carry failed (${e?.code ?? 'error'})`);
        left.push(target);
      }
    }
    if (left.length) await secrets.set(SYNC_CARRY, { keyId: k.keyId, hosts: left, nonces: held.nonces });
    else await secrets.delete(SYNC_CARRY).catch(() => {});
  }

  /**
   * 手元の今の K を持つ証明で、自分宛ての包みを置く（hostId が変わった・外されて登録し直した PC）。
   * 戻り値 'ok' | 'reauth'（rotate が残る間は最近のログインが要る）| 'refused'（古い api・署名の無い K・合わない）
   */
  async function rejoin(k) {
    const self = hostId();
    const kp = await keyPair();
    const syncPublicKey = b64url(kp.publicKey);
    const wrapped = wrapKey({ key: k.key, keyId: k.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, targetPublicKey: kp.publicKey, targetHostId: self });
    const signature = resetKeyPair(k.key).sign(rejoinMessage({ uid: uid(), keyId: k.keyId, hostId: self, syncPublicKey, wrapped }));
    try {
      await api('PUT', `/v1/sync/keys/${encodeURIComponent(self)}`, { body: { keyId: k.keyId, hostId: self, wrapped, wrappedBy: self, syncPublicKey, proof: { signature } } });
    } catch (e) {
      if (e?.status === 403 && e.code === 'reauth_required') return 'reauth';
      if ([403, 404, 409, 422].includes(e?.status)) { log(`sync rejoin refused (${e?.code ?? e?.status})`); return 'refused'; }
      throw e;
    }
    rejoinRefused = null;
    log('sync key rejoined');
    return 'ok';
  }

  /** 前の K では確かめられない新しい K（keyId）へ移ると人が選んだか */
  async function acceptedRestart(keyId) {
    const v = await secrets.get(SYNC_RESTART);
    return !!v && v.uid === uid() && v.keyId === keyId;
  }
  const clearRestart = () => secrets.delete(SYNC_RESTART).catch(() => {});

  /**
   * 人が「{name} と同期する」を押した（始め直された K）。今の keyId が見せたものと同じときだけ覚える。
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
    const v = await secrets.get(SYNC_JOIN);
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
        if (e?.status === 409 && e.message === 'join') {
          await api('DELETE', '/v1/sync/join');
          return { reread: true };
        }
        if (e?.status === 429) return { state: 'denied', code: null, approver: null, deniedAt: j?.deniedAt ?? null };
        if (e?.status === 409 && e.message === 'no_holder') { await clearJoin(); return { reread: true }; }
        throw e;
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
   * - 手元に K が無い: 承認した PC（approverHostId）が、承認の窓で見た公開鍵で包んだもの。
   *   承認の覚えが無ければ、台帳の公開鍵で開いた K の指紋（keyId・resetPublicKey）が覚えたものと合う包み、
   *   または自分で包んだ包み（wrappedBy が自分）
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
    const approved = !local || accepted ? await approverPubs() : null;
    const approver = approved?.get(got.wrappedBy);
    if (approver) {
      const key = open(approver);
      if (key) return { missing: false, key: { keyId: got.keyId, key } };
    }
    // 自分で包んだ K（自分で作った・作り直した・始め直した PC）。包む鍵は自分の秘密鍵からしか作れない
    if (got.wrappedBy === self) {
      const key = open(kp.publicKey);
      if (key) return { missing: false, key: { keyId: got.keyId, key } };
    }
    // K と承認の覚えを失った PC: 台帳の公開鍵で開き、覚えた指紋（keyId と resetPublicKey）と合うときだけ受ける
    if (!local && !approved) {
      const seen = await rememberedKey();
      if (seen && seen.keyId === got.keyId) {
        const pub = pub32((await hostsList()).find(h => h?.hostId === got.wrappedBy)?.syncPublicKey);
        const key = pub ? open(pub) : null;
        if (key && resetKeyPair(key).publicKey === seen.resetPublicKey) return { missing: false, key: { keyId: got.keyId, key } };
      }
    }
    log('sync key unverified');
    return { missing: false, key: null, unverified: true };
  }

  /** 始め直した K を受け取った後の片付け（申し込み・承認・carry・人の選んだ印は前の K のもの） */
  async function clearAfterNewKey() {
    await clearJoin();
    await secrets.delete(SYNC_APPROVALS).catch(() => {});
    await secrets.delete(SYNC_CARRY).catch(() => {});
    await clearRestart();
  }

  /**
   * 頼んだ始め直しを仕上げる: 新しい K を置く（サーバーのデータは消え、この PC の手元のファイルが入る）。
   * 戻り値 { done } | { waiting: readyAt } | { again }（holder が現れた・取り消された。読み直す）
   */
  async function completeRestart(accountUid) {
    const { self, kp, k, wrapped } = await newKeyForSelf();
    assertAccount(accountUid);
    const body = { keyId: k.keyId, hostId: self, wrapped, resetPublicKey: resetKeyPair(k.key).publicKey, syncPublicKey: b64url(kp.publicKey) };
    try { await api('POST', '/v1/sync/recovery/complete', { body }); }
    catch (e) {
      if (e?.status === 409 && (e.message === 'recovery_waiting' || e.code === 'recovery_waiting')) {
        return { waiting: e.body?.error?.readyAt ?? e.readyAt ?? null };
      }
      if (e?.status === 409 || e?.status === 404) return { again: true };
      throw e;
    }
    await saveAccountKey(accountUid, k);
    await rememberKey(accountUid, k).catch(() => {});
    await clearAfterNewKey();
    log('sync restart completed');
    return { done: true };
  }

  /** 始め直しを頼む。戻り値 { requested } | { reauth } | { again }（holder が現れた・ほかの PC が頼んだ・止められた）| { later } */
  async function requestRestart() {
    try {
      await api('POST', '/v1/sync/recovery', { body: {} });
      log('sync restart requested');
      return { requested: true };
    } catch (e) {
      if (e?.status === 403 && e.code === 'reauth_required') return { reauth: true };
      if (e?.status === 409) return { again: true };
      if (e?.status === 429) return { later: true };
      throw e;
    }
  }

  async function setupV2(accountUid, { forceNew = false } = {}) {
    let changedKey = false;     // この回で始め直した（engine は手元の状態を読み直す）
    let reportedLost = false;   // この回で K を無くしたと知らせた（同じ回で何度も送らない）
    let shortened = false;
    for (let i = 0; i < RESET_TRIES; i++) {
      assertAccount(accountUid);
      const self = hostId();
      const state = await api('GET', self ? `/v1/sync/state?hostId=${encodeURIComponent(self)}` : '/v1/sync/state');
      if (!state?.enabled) return { status: 'disabled', state, v2: true };
      const local = await readAccountKey();   // 読めなければ投げる（次の回にやり直す。K を無くしたとは知らせない）
      assertAccount(accountUid);
      if (state.keyId == null) {
        const made = await placeV2(accountUid, state, null);
        if (made) return made;
        continue;
      }
      const holders = Array.isArray(state.holders) ? state.holders : [];
      const others = holders.filter(h => h.hostId !== self && isActiveHolder(h));
      const current = local?.keyId === state.keyId ? local : null;
      // 手元の K が前のもの: 前の K で確かめられる包み（carry）か、人が移ると選んだ後の承認だけで替える
      const stale = !!local && !current;
      const restartOk = current ? false : await acceptedRestart(state.keyId);
      let unverified = false;
      const waiting = (wait, join = null) => ({ status: 'waiting_key', state, wait, ...(join ? { join } : {}), v2: true });

      if (state.self?.holder) {
        let k = current;
        let changed = changedKey;
        if (!k) {
          const mine = await openV2(state, local, restartOk);
          if (mine.key) { k = mine.key; await saveAccountKey(accountUid, k); await clearRestart(); changed = true; log('sync key received'); }
          else unverified = !!mine.unverified;
        }
        if (k) {
          // 鍵を受け取ったら、残っている自分の申し込みは取り下げる（ほかの PC の承認の窓に残さない）
          if (state.join && state.join.state !== 'granted') await api('DELETE', '/v1/sync/join').catch(() => {});
          await clearJoin();
          // 前の版で作った K: 最初の v2 の PC が作り直し、前の holder へ運ぶ（D4）
          if (!state.signedReset) {
            const made = await placeV2(accountUid, state, k, carryTargets(state));
            if (made) return made;
            continue;
          }
          if (state.rotate || forceNew) {
            const made = await placeV2(accountUid, state, k, carryTargets(state));
            forceNew = false;
            if (made) return made;
            continue;
          }
          return ready(k, state, changed, true);
        }
        // 行が残っていると承認を申し込めず、他に活動中の PC がいなければ始め直しもできない。
        if (!reportedLost && ((!stale && !unverified) || restartOk || !others.length)) {
          reportedLost = true;
          try { await api('DELETE', `/v1/sync/keys/${encodeURIComponent(self)}`); log('sync key reported lost'); }
          catch (e) { if (e?.status !== 404 && e?.status !== 403) throw e; }
          continue;
        }
      }

      // 証明で戻る: 手元の K が今のもので、サーバーはこの PC を holder と見ていない（hostId が変わった・登録し直した）
      if (current && !state.self?.holder && state.signedReset && rejoinRefused !== state.keyId) {
        const r = await rejoin(current);
        if (r === 'ok') continue;
        if (r === 'reauth') return waiting(preparing(null, true));
        rejoinRefused = state.keyId;
      }

      const listed = new Map((await hostsList()).map(h => [h?.hostId, h]));
      assertAccount(accountUid);
      // 前の K の PC・届いた K を確かめられなかった PC: 自動で移らない（人が「{name} と同期する」を押す。scene 04）
      if (others.length && (stale || unverified) && !restartOk) {
        const by = state.resetBy?.hostId ?? null;
        return waiting({ kind: 'restarted', keyId: state.keyId, by, byName: state.resetBy?.name ?? listed.get(by)?.name ?? null });
      }
      if (others.length) {
        const join = await joinStep(state, listed);
        if (join.reread) continue;
        const names = join.approver ? [join.approver.name] : approverNames(holders, listed);
        return waiting(approval(names, join.state === 'revealed' ? join.code : null, join.state === 'denied' ? (join.deniedAt ?? null) : null), join);
      }

      // 活動中の holder が居ない: api の決まり（state.restart）に従って自動で始め直す
      if (!('restart' in state)) return waiting(preparing());   // 古い api: 自分から始め直さない
      const rec = state.recovery ?? null;
      const mineRec = !!rec && rec.requestedBy === self;
      if (mineRec && !shortened && Date.parse(rec.readyAt) - Date.parse(rec.requestedAt) > 24 * 60 * 60_000) {
        shortened = true;
        const r = await requestRestart();
        if (r.requested || r.again) continue;
      }
      if (!mineRec) {
        const rs = state.restart;
        if (rs?.allowed) {
          const r = await requestRestart();
          if (r.reauth) return waiting(preparing(null, true));
          if (r.later) return waiting(preparing());
          if (r.requested || r.again) continue;
        } else if (rs?.reason === 'reauth') {
          return waiting(preparing(null, true));
        } else if (rs?.reason === 'recovery' || rs?.reason === 'stopped') {
          // ほかの PC が始め直そうとしている・止められた: その PC（止めた PC）が始め直したら承認の道に入る
          const names = rec?.requestedByName ? [rec.requestedByName]
            : holders.filter(h => h.hostId !== self && h.lost !== true).slice(0, APPROVERS_SHOWN).map(h => h.name ?? listed.get(h.hostId)?.name ?? null);
          return waiting(approval(names));
        } else {
          return waiting(preparing());
        }
      }
      // 頼んだ（今頼んだ）始め直し: 明けたかは complete の応答で知る
      const c = await completeRestart(accountUid);
      if (c.done) { changedKey = true; continue; }
      if (c.waiting !== undefined) return waiting(preparing(c.waiting ?? rec?.readyAt ?? null));
      continue;
    }
    return { status: 'waiting_key', state: null, wait: preparing(), v2: true };
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
   * 渡すのは人が許可したとき（approve）だけ。引き継ぐ PC（carry）への残りもここで渡す。
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
   * 人が許可した: 申し込みを読み直して照らし、見せた確認コードと同じなら包んで渡す。
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

  /** 人が許可しなかった。申し込んだ PC は 1 時間たつまで申し込み直せない */
  async function deny(target) {
    try { await api('DELETE', `/v1/sync/joins/${encodeURIComponent(target)}`); }
    catch (e) { if (e?.status !== 404 && e?.status !== 409) throw e; }
    const { [target]: _done, ...rest } = await approvalsSecret();
    await secrets.set(SYNC_APPROVALS, rest);
    log('sync join denied');
    return { denied: true };
  }

  // ---- ほかの PC の始め直しを止める（外された・活動していない holder。scene 05） --------------------------------

  /**
   * 始め直しの頼みを読む（券は要らない。外された PC でも読める）。
   * 戻り値: 今の K を手元に持っていて始め直しが頼まれていれば { recovery }、ほかは null
   */
  async function recoveryWatch() {
    const local = await storedAccountKey();
    if (!local) return null;
    const got = await client.request('GET', '/v1/sync/recovery');
    return got?.recovery && got.keyId === local.keyId && got.signedReset ? { recovery: got.recovery } : null;
  }

  /** 始め直しを K の署名で止める（外された PC でも止められる。止めると 7 日は頼み直せない）。戻り値 { stopped } */
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

  /** 別の uid で同期を始める: アカウントの同期鍵と、申し込み・承認の途中の覚えを消す（ホストの鍵対と K の指紋は残す） */
  const forget = async () => {
    rejoinRefused = null;
    for (const name of [SYNC_ACCOUNT_KEY, SYNC_JOIN, SYNC_APPROVALS, SYNC_CARRY, SYNC_RESTART]) await secrets.delete(name).catch(() => {});
  };

  return {
    keyPair, publicKey, setup, sharePending, forget, storedAccountKey, ownerUid,
    approvals, approve, deny, acceptRestart, recoveryWatch, recoveryStop,
  };
}
