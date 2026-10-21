// 同期の鍵の始め方と受け渡し（docs/plus.md「同期」）。鍵は端末の中で作り、api にはホストごとに包んだものだけを渡す。
//
//   plus:syncKey         このホストの同期用の X25519 の鍵対 { privateKey, publicKey }（raw 32 バイトの base64url）。ログアウトでも残す
//   plus:syncAccountKey  アカウントの同期鍵 { keyId, key }（key は raw 32 バイトの base64url）。ログアウトで消す
//
// 始め方（setup）:
//   1. GET /v1/sync/state?hostId=<自分>。enabled が false なら disabled
//   2. keyId が null → K を作り、自分宛てに包んで POST /v1/sync/reset（previousKeyId: null）
//   3. 手元の keyId と同じ → そのまま使う
//   4. 違う・無い → GET /v1/sync/keys/{自分} を wrappedBy の syncPublicKey で開いて保管する（開けなければ待つ）
//   5. 自分宛てが無い（404）→ 待つ。サーバーに項目が無く（itemCount が 0）、鍵を持つほかのホストも居なければ作り直す。
//      項目がある（古い api で itemCount が無いときも）なら黙って作り直さず、待つ（wait に件数・大きさ・鍵を持つ PC を載せる）。
//      人が件数を見て確かめたら、setup({ forceNew: true, confirm: { keyId, itemCount } }) で作り直す
//   reset の 409 conflict（previousKeyId）は、ほかの PC が先に作ったので state を読み直す。
//   409 reset_confirm（確かめが無い・数字が変わった）は confirm_needed に今の値を載せて返す（docs/plus.md「同期の始め直しと登録の外れ」）
import {
  b64url, fromB64url, deriveItemKeys, newAccountKey, newSyncKeyPair, syncKeyPairFromPrivate, wrapKey, unwrapKey, KEY_ID_RX,
} from './crypto.mjs';

export const SYNC_KEY_PAIR = 'plus:syncKey';
export const SYNC_ACCOUNT_KEY = 'plus:syncAccountKey';
const RESET_TRIES = 3;

/**
 * @param {object} o
 * @param {{ request: Function }} o.client  Plus の api の客（core/plus/client.mjs）
 * @param {object} o.secrets  createSecretStore の結果（<data>/plus-secrets.json）
 * @param {() => string|null} o.uid
 * @param {() => string|null} o.hostId  このホストの hostId（登録済みのもの）
 * @param {(line: string) => void} [o.log]
 * @param {(to: { hostId: string, name: string|null }) => void} [o.onShared]  鍵を新しい PC に渡したとき
 */
export function createSyncKeys({ client, secrets, uid, hostId, log = () => {}, onShared = () => {} }) {
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

  const ready = (k, state, changed) => ({ status: 'ready', key: { keyId: k.keyId, key: k.key, ...deriveItemKeys(k.key) }, state, changed });

  async function hostsList() {
    const list = await client.request('GET', '/v1/hosts');
    return Array.isArray(list?.hosts) ? list.hosts : [];
  }

  /**
   * 新しい K を作り、自分宛てに包んで reset する。409 previousKeyId → null（呼び出し側が読み直す）。
   * 409 reset_confirm → { confirmNeeded: 誤りの本文 }（今の keyId・itemCount・totalBytes・updatedAt・holders）
   */
  async function create(previousKeyId, confirm = null) {
    const self = hostId();
    const kp = await keyPair();
    const k = newAccountKey();
    const wrapped = wrapKey({ key: k.key, keyId: k.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, targetPublicKey: kp.publicKey, targetHostId: self });
    const body = { keyId: k.keyId, hostId: self, wrapped, previousKeyId };
    if (confirm) body.confirm = { keyId: confirm.keyId, itemCount: confirm.itemCount };
    try {
      const state = await client.request('POST', '/v1/sync/reset', { body });
      await secrets.set(SYNC_ACCOUNT_KEY, { keyId: k.keyId, key: b64url(k.key) });
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
  async function waitInfo(state, local) {
    const self = hostId();
    const listed = new Map((await hostsList()).map(h => [h?.hostId, h]));
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

  /** 自分宛ての包みを開く。開けなければ null（ログに sync key unwrap failed） */
  async function openMine(state) {
    let got;
    try { got = await client.request('GET', `/v1/sync/keys/${encodeURIComponent(hostId())}`); }
    catch (e) {
      if (e?.status === 404) return { missing: true };
      throw e;
    }
    if (got?.keyId !== state.keyId) return { missing: false, key: null };
    const wrapper = (await hostsList()).find(h => h?.hostId === got.wrappedBy);
    const wrapperPub = fromB64url(wrapper?.syncPublicKey);
    const kp = await keyPair();
    const key = wrapperPub.length === 32
      ? unwrapKey({ wrapped: got.wrapped, keyId: got.keyId, uid: uid(), privateKey: kp.privateKey, publicKey: kp.publicKey, wrapperPublicKey: wrapperPub, hostId: hostId() })
      : null;
    if (!key) { log('sync key unwrap failed'); return { missing: false, key: null }; }
    return { missing: false, key: { keyId: got.keyId, key } };
  }

  /**
   * 始め方。{ status: 'disabled'|'waiting_key'|'confirm_needed'|'ready', key?, state, changed?, wait? } を返す。
   * changed: 手元の鍵が替わった（項目を cursor 0 から読み直す）
   * wait: waiting_key・confirm_needed のときに見せるもの（waitInfo）
   * confirm: 人が件数を見て確かめた印 { keyId, itemCount }（forceNew のときだけ送る）
   */
  async function setup({ forceNew = false, confirm = null } = {}) {
    for (let i = 0; i < RESET_TRIES; i++) {
      const self = hostId();
      const state = await client.request('GET', self ? `/v1/sync/state?hostId=${encodeURIComponent(self)}` : '/v1/sync/state');
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
        await secrets.set(SYNC_ACCOUNT_KEY, { keyId: mine.key.keyId, key: b64url(mine.key.key) });
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

  /**
   * 鍵を持つホストとして、宛ての無いホスト（state.pending）に包んで渡す。
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
        await client.request('PUT', `/v1/sync/keys/${encodeURIComponent(target)}`, { body: { keyId: key.keyId, wrapped, wrappedBy: hostId() } });
        log('sync key shared');
        try { onShared({ hostId: target, name: hosts.find(h => h?.hostId === target)?.name ?? null }); } catch {}
      } catch (e) {
        if (e?.status === 409 && e.message === 'keyId') return 'rekey';
        log(`sync key share failed (${e?.code ?? 'error'})`);
      }
    }
    return 'ok';
  }

  /** ログアウト: アカウントの同期鍵だけ消す（ホストの鍵対は残す） */
  const forget = () => secrets.delete(SYNC_ACCOUNT_KEY).catch(() => {});

  return { keyPair, publicKey, setup, sharePending, forget, storedAccountKey };
}
