// 試験の中継に差し込む「公式の中継」の認可（relay/server.mjs の authz。docs/remote.md §5.7）。
// 本物の中継はデプロイされていないので、試験はこの差し込みで確かめる:
//   host(ctx)   /v1/host と /v1/host/accept。
//               X-Pleiad-Ticket（中継の券 role:host）があれば券だけで判定する（下の「券の道」）。
//               無ければ X-Pleiad-Account の ID トークンを確かめ、uid がその hostId の登録主なら通す（tags に u:<uid> と h:<hostId>）
//   device(ctx) /v1/device と /v1/device/notify。ペアリングは受けない（4401 'pairing disabled'）。
//               券（role:device）があれば券で判定し、tags に k:<sub> も付ける。
//               無ければ ID トークンで。deviceId の無いものは通して admit: true を返す（トークンとアカウントは確かめる）。
//               deviceId のあるものはトークンの照合を中継に任せて通す（どちらも uid の確かめはする）
//   event(e)    host-open / host-close（今の制御の接続の券を覚える・捨てる）
//
// 券の道（本物の中継と同じ順）:
//   accept は、券が文字列ごと今の制御の接続の券と同じなら、一度きりも期限も見ずに通す（制御の接続が閉じたら使えない）。
//   それ以外は署名・期限・aud・hostId・role・sub を確かめ（落ちたら 4401 'ticket'）、/v1/host は lim.hosts の数を見て
//   （4429 'account limit'。券は使い切らない）、jti を一度きりで使う（使い回しは 4401 'ticket'）。
//   公開鍵は keysUrl から取り、取れないときは期限の切れた覚えを使う。覚えも無ければ投げる（中継が 1013 で閉じる）。
//
// state.blockHosts / state.blockDevices に { code, reason } を置くと、その判定を強制的に返す
// （4401 'account'・4429 'account limit'・1013 相当の試験に使う）。
// state.looseDevices = true の間は、ID トークンの道の device の uid と hostId の持ち主の照合を飛ばす
// （ほかのアカウントの端末をホストまで届けて、ホスト側の denied 'account' を確かめる）。
// state.v2Required = true の間は券の無い接続を 4401 'update required' で断る（api と中継のフラグ）。
// state.seen に { route, by: 'ticket' | 'account', ok, code?, reason? } を残す。
// attach() で受けた handle は authz.handle に残る（closeTag で接続を切る試験に使う）。
import crypto from 'node:crypto';
import { createJtiStore, createTicketVerifier, TicketError } from '../../core/plus/tickets.mjs';

const KEY_ID = /^[a-z2-7]{26}$/;
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('base64url');

/**
 * @param {object} o
 * @param {(token: string) => Promise<{ uid: string }>} o.verify  ID トークンの確かめ
 * @param {(uid: string, hostId: string) => Promise<boolean>} o.isBound
 * @param {string | (() => string)} [o.keysUrl]  券の公開鍵の一覧（偽の Plus の ticketKeysUrl。偽の Plus を後で立てるなら手で渡す）
 */
export function createPlusRelayAuthz({ verify, isBound, keysUrl = null }) {
  const state = { blockHosts: null, blockDevices: null, looseDevices: false, v2Required: false, seen: [] };
  const tickets = keysUrl ? createTicketVerifier({ keysUrl: typeof keysUrl === 'function' ? keysUrl : () => keysUrl }) : null;
  const jtis = createJtiStore();
  const controlByHost = new Map();   // hostId -> uid
  const controlTicket = new Map();   // hostId -> { tokenHash, uid, open }

  const result = (ctx, by, r) => { state.seen.push({ route: ctx.route, by, ok: r.ok, code: r.code, reason: r.reason }); return r; };
  const ticketOf = ctx => (typeof ctx.headers['x-pleiad-ticket'] === 'string' && ctx.headers['x-pleiad-ticket']) || null;

  async function checkTicket(ctx, token, role) {
    if (!tickets) return { ok: false };
    let p;
    try { p = await tickets.verify(token, { aud: 'relay' }); }
    catch (e) {
      if (e instanceof TicketError && e.reason === 'unavailable') throw e;   // 中継が 1013 で閉じる
      return { ok: false };
    }
    if (p.role !== role || p.hostId !== ctx.hostId || typeof p.sub !== 'string' || !KEY_ID.test(p.sub)) return { ok: false };
    if (role === 'host' && p.sub !== ctx.hostId) return { ok: false };
    return { ok: true, payload: p };
  }

  async function hostByTicket(ctx, token) {
    if (ctx.route === '/v1/host/accept') {
      const bound = controlTicket.get(ctx.hostId);
      if (bound && bound.tokenHash === sha256(token)) return { ok: true, tags: [`u:${bound.uid}`, `h:${ctx.hostId}`] };
    }
    const c = await checkTicket(ctx, token, 'host');
    if (!c.ok) return { ok: false, code: 4401, reason: 'ticket' };
    const p = c.payload;
    if (ctx.route === '/v1/host') {
      const max = Number.isInteger(p.lim?.hosts) ? p.lim.hosts : Infinity;
      let n = 0;
      for (const [hid, u] of controlByHost) if (u === p.uid && hid !== ctx.hostId) n++;
      if (n >= max) return { ok: false, code: 4429, reason: 'account limit' };
    }
    if (!jtis.consume(p.jti, p.exp)) return { ok: false, code: 4401, reason: 'ticket' };
    if (ctx.route === '/v1/host') controlTicket.set(ctx.hostId, { tokenHash: sha256(token), uid: p.uid, open: false });
    return { ok: true, tags: [`u:${p.uid}`, `h:${ctx.hostId}`] };
  }

  async function deviceByTicket(ctx, token) {
    const c = await checkTicket(ctx, token, 'device');
    if (!c.ok) return { ok: false, code: 4401, reason: 'ticket' };
    const p = c.payload;
    if (!jtis.consume(p.jti, p.exp)) return { ok: false, code: 4401, reason: 'ticket' };
    const tags = [`u:${p.uid}`, `h:${ctx.hostId}`, `k:${p.sub}`];
    if (ctx.route === '/v1/device' && ctx.deviceId == null) return { ok: true, admit: true, tags };
    return { ok: true, tags };
  }

  const authz = {
    state,
    handle: null,
    async host(ctx) {
      if (state.blockHosts) return { ok: false, ...state.blockHosts };
      const ticket = ticketOf(ctx);
      if (ticket) return result(ctx, 'ticket', await hostByTicket(ctx, ticket));
      if (state.v2Required) return result(ctx, 'account', { ok: false, code: 4401, reason: 'update required' });
      let uid;
      try { uid = (await verify(ctx.headers['x-pleiad-account'])).uid; }
      catch { return result(ctx, 'account', { ok: false, code: 4401, reason: 'token' }); }
      if (!(await isBound(uid, ctx.hostId))) return result(ctx, 'account', { ok: false, code: 4401, reason: 'account' });
      return result(ctx, 'account', { ok: true, tags: [`u:${uid}`, `h:${ctx.hostId}`] });
    },
    async device(ctx) {
      if (state.blockDevices) return { ok: false, ...state.blockDevices };
      if (ctx.pairing) return { ok: false, code: 4401, reason: 'pairing disabled' };
      const ticket = ticketOf(ctx);
      if (ticket) return result(ctx, 'ticket', await deviceByTicket(ctx, ticket));
      if (state.v2Required) return result(ctx, 'account', { ok: false, code: 4401, reason: 'update required' });
      let uid;
      try { uid = (await verify(ctx.headers['x-pleiad-account'])).uid; }
      catch { return result(ctx, 'account', { ok: false, code: 4401, reason: 'token' }); }
      if (!state.looseDevices && !(await isBound(uid, ctx.hostId))) return result(ctx, 'account', { ok: false, code: 4401, reason: 'account' });
      if (ctx.deviceId == null) return result(ctx, 'account', { ok: true, tags: [`u:${uid}`], admit: true });
      return result(ctx, 'account', { ok: true, tags: [`u:${uid}`, `d:${ctx.deviceId}`] });
    },
    event(e) {
      if (e?.type === 'host-open') {
        controlByHost.set(e.hostId, (e.tags ?? []).find(t => t.startsWith('u:'))?.slice(2) ?? null);
        const bound = controlTicket.get(e.hostId);
        if (bound) bound.open = true;
      } else if (e?.type === 'host-close') {
        controlByHost.delete(e.hostId);
        if (controlTicket.get(e.hostId)?.open) controlTicket.delete(e.hostId);
      }
    },
    attach(handle) { authz.handle = handle; },
  };
  return authz;
}
