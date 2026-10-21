// 同期の券（docs/plus.md「同期」）。v2 の api の /v1/sync/* は、ID トークンに加えて X-Pleiad-Sync-Ticket が要る。
//
// 取り方: POST /v1/tickets/challenge { purpose: 'sync', hostId, publicKey } → POST /v1/tickets { challengeId, proof } → { sync, expiresAt }。
//   proof は登録と同じ式で、最後の語だけ 'sync'（core/plus/hosts.mjs の hostProof）。
// 券は 5 分使える（一度きりではない）。4 分で取り直す。
// 403 ticket_invalid は、券を取り直して 1 回だけやり直す。
//
// 前の版の api（券を知らない）: challenge が 404 なら券を付けずに呼ぶ（今までの同期の流れ。legacy）。
//   10 分ごとに確かめ直し、券を付けない要求に 403 ticket_invalid が返ったら（api が新しくなった）すぐ確かめ直す。
import { hostProof } from '../hosts.mjs';

const REFRESH_MS = 4 * 60_000;
const PROBE_MS = 10 * 60_000;

/**
 * @param {object} o
 * @param {{ request: Function }} o.client createPlusClient の結果
 * @param {() => Promise<{ hostId: string, publicKey: Buffer, privateKey: Buffer }|null>} o.identity ホストの鍵（無ければ null）
 * @param {() => number} [o.now]
 */
export function createSyncTicket({ client, identity, now = Date.now }) {
  let held = null;            // { ticket, hostId, at }
  let legacyAt = 0;           // challenge が 404 だった時刻（0 = 券を取る api）
  let getting = null;

  async function issue() {
    const id = await identity();
    if (!id) throw Object.assign(new Error('no host key'), { code: 'no_identity' });
    const publicKey = Buffer.from(id.publicKey).toString('base64url');
    let ch;
    try {
      ch = await client.request('POST', '/v1/tickets/challenge', { body: { purpose: 'sync', hostId: id.hostId, publicKey } });
    } catch (e) {
      // 前の版の api は券の口を知らない
      if (e?.status === 404) { legacyAt = now(); held = null; return null; }
      throw tagged(e);
    }
    const proof = hostProof({ privateKey: id.privateKey, hostId: id.hostId, nonce: ch.nonce, serverPublicKey: ch.serverPublicKey, purpose: 'sync' });
    let out;
    try { out = await client.request('POST', '/v1/tickets', { body: { challengeId: ch.challengeId, proof } }); }
    catch (e) { throw tagged(e); }
    if (typeof out?.sync !== 'string') throw Object.assign(new Error('no sync ticket'), { code: 'bad_ticket' });
    legacyAt = 0;
    held = { ticket: out.sync, hostId: id.hostId, at: now() };
    return held.ticket;
  }

  /** 今の券（前の版の api なら null）。force で取り直す */
  async function get({ force = false } = {}) {
    if (!force) {
      if (legacyAt && now() - legacyAt < PROBE_MS) return null;
      // つなぎ直し（ホストの鍵の作り直し）の後は、前の hostId の券を使わない
      if (held && held.hostId !== (await identity())?.hostId) held = null;
      if (held && now() - held.at < REFRESH_MS) return held.ticket;
    }
    getting ??= issue().finally(() => { getting = null; });
    return getting;
  }

  /**
   * 同期の口を呼ぶ。券があれば付け、403 ticket_invalid は取り直して 1 回だけやり直す。
   * 券を付けずに呼んで ticket_invalid なら、api が新しくなったので券を取ってやり直す。
   */
  async function request(method, path, opts = {}) {
    const ticket = await get();
    try {
      return await client.request(method, path, withTicket(opts, ticket));
    } catch (e) {
      if (!(e?.status === 403 && e?.code === 'ticket_invalid')) throw e;
      held = null; legacyAt = 0;
      const again = await get({ force: true });
      if (!again) throw e;
      return await client.request(method, path, withTicket(opts, again));
    }
  }

  return {
    get,
    request,
    /** 前の版の api（券を知らない）と分かっているか。まだ確かめていなければ false */
    legacy: () => legacyAt > 0 && now() - legacyAt < PROBE_MS,
    /** 覚えを捨てる（アカウント・ホストの鍵が変わったとき） */
    forget() { held = null; legacyAt = 0; },
  };
}

/** 券を取るところの誤りに印を付ける（404 not_found・403 host_removed は、このホストが台帳に居ないことを表す） */
function tagged(e) {
  if (e && typeof e === 'object') e.ticket = true;
  return e;
}

function withTicket(opts, ticket) {
  if (!ticket) return opts;
  return { ...opts, headers: { ...opts.headers, 'x-pleiad-sync-ticket': ticket } };
}
