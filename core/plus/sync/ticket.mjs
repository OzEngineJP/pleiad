// 同期の券（docs/plus.md「同期」）。v2 の api の /v1/sync/* は、ID トークンに加えて X-Pleiad-Sync-Ticket が要る。
//
// 取り方は中継・受け入れの券と同じ手（core/plus/tickets.mjs の createTicketIssuer。purpose 'sync' → { sync, expiresAt }）。
//   proof は登録と同じ式で、最後の語だけ 'sync'（tickets.mjs の proofFor）。
// 同期の券は 5 分使える（一度きりではない）。4 分で取り直す。
// 403 ticket_invalid は、券を取り直して 1 回だけやり直す。
//
// 前の版の api（券を知らない）: 券の手が null を返したら券を付けずに呼ぶ（今までの同期の流れ。legacy）。
//   確かめ直すまでの間は券の手が決める（中継の券と同じ 5 分）。券を付けない要求に 403 ticket_invalid が返ったら
//   （api が新しくなった）すぐ確かめ直す。
import { createTicketIssuer } from '../tickets.mjs';

const REFRESH_MS = 4 * 60_000;

/**
 * @param {object} o
 * @param {{ request: Function }} o.client createPlusClient の結果
 * @param {() => Promise<{ hostId: string, publicKey: Buffer, privateKey: Buffer }|null>} o.identity ホストの鍵（無ければ null）
 * @param {ReturnType<typeof createTicketIssuer>|null} [o.issuer]  券の手（中継の券と同じものを渡す）。無ければ client で作る
 * @param {() => number} [o.now]
 */
export function createSyncTicket({ client, identity, issuer = null, now = Date.now }) {
  const tickets = issuer ?? createTicketIssuer({ request: (m, p, body) => client.request(m, p, { body }), now });
  let held = null;            // { ticket, hostId, at }
  let getting = null;

  async function issue(force) {
    const id = await identity();
    if (!id) throw Object.assign(new Error('no host key'), { code: 'no_identity' });
    let out;
    // 券を出すと言う api の券の口が 404（unsupported）なのは台帳の外れではないので、印を付けない
    try { out = await tickets.issue({ purpose: 'sync', keyPair: id, hostId: id.hostId, force }); }
    catch (e) { throw e?.unsupported ? e : tagged(e); }
    if (out === null) { held = null; return null; }   // 前の版の api
    if (typeof out?.sync !== 'string') throw Object.assign(new Error('no sync ticket'), { code: 'bad_ticket' });
    held = { ticket: out.sync, hostId: id.hostId, at: now() };
    return held.ticket;
  }

  /** 今の券（前の版の api なら null）。force で取り直す */
  async function get({ force = false } = {}) {
    if (!force) {
      if (tickets.unsupported()) return null;
      // つなぎ直し（ホストの鍵の作り直し）の後は、前の hostId の券を使わない
      if (held && held.hostId !== (await identity())?.hostId) held = null;
      if (held && now() - held.at < REFRESH_MS) return held.ticket;
    }
    getting ??= issue(force).finally(() => { getting = null; });
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
      held = null;
      const again = await get({ force: true });
      if (!again) throw e;
      return await client.request(method, path, withTicket(opts, again));
    }
  }

  return {
    get,
    request,
    /** 前の版の api（券を知らない）と分かっているか。まだ確かめていなければ false */
    legacy: () => tickets.unsupported(),
    /** 覚えを捨てる（アカウント・ホストの鍵が変わったとき） */
    forget() { held = null; tickets.forget(); },
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
