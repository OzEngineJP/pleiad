// Pleiad Plus の券を取る・確かめる（docs/plus.md「券」）。
//
// 券は api が Ed25519 で署名した JWS のコンパクト形（header {"alg":"EdDSA","typ":"pleiad-ticket+jwt","kid"}）。
//   中継の券     aud:"relay"        { role: 'host' | 'device', sub, hostId, lim }  中継の X-Pleiad-Ticket に載せる
//   受け入れの券 aud:"pleiad-host"  { hostId, devicePub }                         端末が Noise のメッセージ 1 に載せ、PC が確かめる
// どれも iss:"pleiad-plus"・uid・iat・exp（iat + 300）・jti を持ち、一度きり。
//
// 取り方（issueTicket）: POST /v1/tickets/challenge { purpose, publicKey, hostId }
//   → proof = b64u(HMAC-SHA256(HKDF(X25519(自分の秘密鍵, serverPublicKey), "pleiad host proof v1"), nonce ‖ utf8(hostId) ‖ utf8(purpose)))
//   → POST /v1/tickets { challengeId, proof } → host: { relay } / device: { relay, admission }
//   challenge の口が 404 の api（券の無い前の版）なら、createTicketIssuer は null を返す（呼ぶ側は ID トークンの道へ戻る）。
//
// 確かめ方（createTicketVerifier）: 公開鍵は <api>/.well-known/pleiad-keys を 5 分覚える。知らない kid の取り直しは
//   30 秒に 1 回まで。取れないときは期限の切れた覚えでも使い、覚えが無いときだけ unavailable を投げる。
//   時計のずれは ±60 秒まで（iat <= now + 60、exp > now - 60）。長さは 2048 バイトまで。
import crypto from 'node:crypto';
import { dh, hkdfLabel } from '../remote/noise.mjs';

export const TICKET_ISS = 'pleiad-plus';
export const TICKET_TYP = 'pleiad-ticket+jwt';
export const TICKET_MAX_BYTES = 2048;
const SKEW_SEC = 60;
const PROOF_INFO = 'pleiad host proof v1';
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const SEG = /^[A-Za-z0-9_-]+$/;
const B64U_32 = /^[A-Za-z0-9_-]{43}$/;
const KEYS_TTL_MS = 5 * 60_000;
const KEYS_MIN_REFETCH_MS = 30_000;
const KEYS_TIMEOUT_MS = 10_000;
const UNSUPPORTED_MS = 5 * 60_000;

const b64url = buf => Buffer.from(buf).toString('base64url');
const b64urlToBuf = s => Buffer.from(String(s ?? ''), 'base64url');

/** 鍵の持ち主の証明（登録の 'register' と券の 'host' / 'device' で同じ式。最後の語だけが違う） */
export function proofFor({ privateKey, hostId, nonce, serverPublicKey, purpose }) {
  const k = hkdfLabel(dh(privateKey, b64urlToBuf(serverPublicKey)), PROOF_INFO);
  const mac = crypto.createHmac('sha256', k);
  mac.update(b64urlToBuf(nonce));
  mac.update(Buffer.from(hostId, 'utf8'));
  mac.update(Buffer.from(purpose, 'utf8'));
  return b64url(mac.digest());
}

/**
 * challenge → proof → 発行。request(method, path, body) は ID トークンを付けて api を呼び、誤りは
 * PlusError（status・code）で投げる手（Electron の主プロセスからは worker 越しの手を渡す）。
 * @param {{ request: Function, purpose: 'host' | 'device', keyPair: { publicKey: Buffer, privateKey: Buffer }, hostId: string }} o
 */
export async function issueTicket({ request, purpose, keyPair, hostId }) {
  let ch;
  try { ch = await request('POST', '/v1/tickets/challenge', { purpose, publicKey: b64url(keyPair.publicKey), hostId }); }
  catch (e) {
    if (e?.status === 404 && e && typeof e === 'object') e.unsupported = true;   // 券の口が無い api
    throw e;
  }
  const proof = proofFor({ privateKey: keyPair.privateKey, hostId, nonce: ch?.nonce, serverPublicKey: ch?.serverPublicKey, purpose });
  return request('POST', '/v1/tickets', { challengeId: ch?.challengeId, proof });
}

/**
 * 券を取る手。券の口が無い api（challenge が 404）なら null を返し、5 分はそのまま null を返す（ID トークンの道へ戻る）。
 * admission() が数（/v1/auth/config の admission）を返す api は券を出すので、404 でも戻らずに投げる。
 * @param {{ request: Function, admission?: () => (number | null | Promise<number | null>), now?: () => number }} o
 */
export function createTicketIssuer({ request, admission = () => null, now = Date.now }) {
  let unsupportedUntil = 0;
  return {
    /** @returns {Promise<{ relay: string, admission?: string } | null>} */
    async issue({ purpose, keyPair, hostId }) {
      if (now() < unsupportedUntil && await admission() == null) return null;
      try {
        const out = await issueTicket({ request, purpose, keyPair, hostId });
        unsupportedUntil = 0;
        return out;
      } catch (e) {
        if (e?.unsupported && await admission() == null) {
          unsupportedUntil = now() + UNSUPPORTED_MS;
          return null;
        }
        throw e;
      }
    },
  };
}

/** 確かめに落ちたとき。reason: form / kid / sig / claims / time / unavailable（公開鍵が取れない） */
export class TicketError extends Error {
  constructor(reason) { super(`ticket ${reason}`); this.reason = reason; }
}

/** 券の形・署名・iss・aud・時刻を確かめる（一度きりは呼ぶ側で）。keyFor(kid) → KeyObject | null */
export function verifyTicket(token, { keyFor, aud, nowSec }) {
  if (typeof token !== 'string' || token.length > TICKET_MAX_BYTES) return { ok: false, reason: 'form' };
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every(p => SEG.test(p))) return { ok: false, reason: 'form' };
  let header, payload;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
  } catch { return { ok: false, reason: 'form' }; }
  if (!header || typeof header !== 'object' || header.alg !== 'EdDSA' || header.typ !== TICKET_TYP || typeof header.kid !== 'string') return { ok: false, reason: 'form' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'form' };
  const key = keyFor(header.kid);
  if (!key) return { ok: false, reason: 'kid' };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), key, b64urlToBuf(parts[2])); } catch { ok = false; }
  if (!ok) return { ok: false, reason: 'sig' };
  if (payload.iss !== TICKET_ISS || payload.aud !== aud) return { ok: false, reason: 'claims' };
  if (typeof payload.uid !== 'string' || !payload.uid || typeof payload.jti !== 'string' || !payload.jti) return { ok: false, reason: 'claims' };
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return { ok: false, reason: 'claims' };
  if (payload.iat > nowSec + SKEW_SEC || payload.exp <= nowSec - SKEW_SEC) return { ok: false, reason: 'time' };
  return { ok: true, payload };
}

/**
 * @param {object} o
 * @param {() => string} o.keysUrl  公開鍵の一覧の URL（<api>/.well-known/pleiad-keys）
 * @param {Function} [o.fetchFn]
 * @param {() => number} [o.now]  ミリ秒
 */
export function createTicketVerifier({ keysUrl, fetchFn = fetch, now = Date.now }) {
  let cache = { at: 0, keys: new Map() };
  let lastFetchAt = -Infinity;
  let inflight = null;

  const fetchKeys = () => (inflight ??= (async () => {
    lastFetchAt = now();
    const res = await fetchFn(keysUrl(), { signal: AbortSignal.timeout(KEYS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`pleiad-keys HTTP ${res.status}`);
    const body = await res.json();
    const keys = new Map();
    for (const k of Array.isArray(body?.keys) ? body.keys : []) {
      if (k?.kty !== 'OKP' || k?.crv !== 'Ed25519' || typeof k.kid !== 'string' || typeof k.x !== 'string' || !B64U_32.test(k.x)) continue;
      try { keys.set(k.kid, crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, b64urlToBuf(k.x)]), format: 'der', type: 'spki' })); }
      catch { /* 壊れた鍵は飛ばす */ }
    }
    cache = { at: now(), keys };
  })().finally(() => { inflight = null; }));

  async function load({ force = false } = {}) {
    const stale = cache.at === 0 || now() - cache.at >= KEYS_TTL_MS;
    if (!stale && !(force && now() - lastFetchAt >= KEYS_MIN_REFETCH_MS)) return;
    try { await fetchKeys(); }
    catch (e) { if (cache.at === 0) throw new TicketError('unavailable'); }
  }

  return {
    /** 券を確かめて payload を返す。落ちたら TicketError */
    async verify(token, { aud }) {
      await load();
      const keyFor = kid => cache.keys.get(kid) ?? null;
      let r = verifyTicket(token, { keyFor, aud, nowSec: Math.floor(now() / 1000) });
      if (!r.ok && r.reason === 'kid') {
        await load({ force: true });   // 鍵の入れ替えの直後
        r = verifyTicket(token, { keyFor, aud, nowSec: Math.floor(now() / 1000) });
      }
      if (!r.ok) throw new TicketError(r.reason);
      return r.payload;
    },
  };
}

/** 一度きりの券の jti を exp + 60 秒まで覚える。いっぱいで古いものを捨てられないときは投げる（捨てると使い回しが通る） */
export function createJtiStore({ now = Date.now, max = 10_000 } = {}) {
  const seen = new Map();
  const sweep = t => { for (const [jti, until] of seen) if (until <= t) seen.delete(jti); };
  return {
    /** 初めての jti なら覚えて true、使い回しなら false */
    consume(jti, expSec) {
      const t = now();
      const until = seen.get(jti);
      if (until !== undefined && until > t) return false;
      if (seen.size >= max) sweep(t);
      if (seen.size >= max) throw new TicketError('unavailable');
      seen.set(jti, (expSec + SKEW_SEC) * 1000);
      return true;
    },
    size: () => seen.size,
  };
}
