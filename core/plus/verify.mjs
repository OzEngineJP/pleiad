// ID トークン（RS256 の JWT）の検証。B4 が、つなぎに来た端末のトークンを見るのに使う。
//   1. ヘッダー: alg が RS256、kid が JWKS にある
//   2. ペイロード: iss = https://securetoken.google.com/<projectId>、aud = <projectId>、
//      exp > いま − 60 秒、iat ≤ いま + 60 秒、sub が空でない
//   3. projectId は /v1/auth/config の token.projectId（呼ぶたびに今の値を使う）
//   4. JWKS は応答の Cache-Control の max-age の間だけ覚える。知らない kid が来たら 1 分に 1 回まで読み直す
import crypto from 'node:crypto';
import { PlusError } from './client.mjs';

const CLOCK_SKEW_MS = 60_000;
const REFETCH_MIN_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const b64urlJson = part => {
  try { return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { return null; }
};

/**
 * @param {object} o
 * @param {string} o.jwksUrl 公開鍵の一覧（JWK の形）を返す URL
 * @param {() => string} o.projectId 今の projectId（/v1/auth/config の token.projectId）
 * @param {Function} [o.now] ミリ秒
 * @param {Function} [o.fetchFn]
 */
export function createIdTokenVerifier({ jwksUrl, projectId, now = Date.now, fetchFn = fetch }) {
  let cache = { keys: new Map(), expiresAt: 0, fetchedAt: 0 };
  let fetching = null;

  async function fetchJwks() {
    const res = await fetchFn(jwksUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new PlusError({ status: res.status, code: 'network', message: `jwks HTTP ${res.status}` });
    const body = await res.json().catch(() => null);
    const keys = new Map();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk && typeof jwk.kid === 'string' && jwk.kty === 'RSA') keys.set(jwk.kid, jwk);
    }
    const maxAge = /\bmax-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '');
    cache = { keys, fetchedAt: now(), expiresAt: now() + (maxAge ? Number(maxAge[1]) * 1000 : 0) };
    return cache;
  }

  /** kid の JWK。知らない kid は 1 分に 1 回まで読み直す */
  async function keyFor(kid) {
    if (cache.expiresAt <= now()) { fetching ??= fetchJwks().finally(() => { fetching = null; }); await fetching.catch(() => {}); }
    let jwk = cache.keys.get(kid);
    if (!jwk && now() - cache.fetchedAt >= REFETCH_MIN_MS) {
      fetching ??= fetchJwks().finally(() => { fetching = null; });
      await fetching.catch(() => {});
      jwk = cache.keys.get(kid);
    }
    return jwk ?? null;
  }

  /**
   * トークンを検証する。合えば { uid, email }。合わなければ PlusError({ code: 'bad_token' })。
   * トークンの値自体は誤りの文に入れない。
   */
  async function verify(token) {
    const bad = () => new PlusError({ code: 'bad_token', message: 'invalid ID token' });
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) throw bad();
    const header = b64urlJson(parts[0]);
    const payload = b64urlJson(parts[1]);
    if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string') throw bad();

    const jwk = await keyFor(header.kid);
    if (!jwk) throw bad();
    let key;
    try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw bad(); }
    const signature = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) throw bad();

    const pid = projectId();
    const t = now();
    if (payload.iss !== `https://securetoken.google.com/${pid}`) throw bad();
    if (payload.aud !== pid) throw bad();
    if (!(Number(payload.exp) * 1000 > t - CLOCK_SKEW_MS)) throw bad();
    if (!(Number(payload.iat) * 1000 <= t + CLOCK_SKEW_MS)) throw bad();
    if (typeof payload.sub !== 'string' || !payload.sub) throw bad();

    return { uid: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
  }

  return { verify };
}
