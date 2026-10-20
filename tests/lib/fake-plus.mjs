// 試験用の偽の Pleiad Plus。本物の api には送らない（AGENT_HOST_PLUS_API にこの URL を渡す）。
//   GET  /jwks            試験用の RSA 鍵（起動のたびに作る。Cache-Control: max-age 付き）
//   GET  /v1/auth/config  state・token・minClient は state から変えられる。urls.login は /login、urls.refresh は /v1/token
//   GET  /login           偽のログインのページ。state.nextLogin に従い redirect_uri へ 302（code か error）
//   POST /v1/auth/token   verifier・redirectUri・期限 60 秒・1 回きりを照合。外れたら 400 invalid_grant
//   POST /v1/token        更新（form。?key=）。state.refreshError があれば 400 {"error":{"message":…}}
//   GET/PATCH /v1/account state.accounts[uid] から返す。無い uid は free
//   state.down = true の間は全部の口が接続を切る。route() で後の issue が口を足せる
//   呼ばれた口と X-Pleiad-Client を state.calls に残す
import http from 'node:http';
import crypto from 'node:crypto';
import { generateKeyPair, dh, hkdfLabel, hostIdFor } from '../../core/remote/noise.mjs';

const PROJECT_ID = 'test-project';
const API_KEY = 'test-api-key';
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlToBuf = s => Buffer.from(String(s ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const readBody = async req => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); };
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

export async function startFakePlus({ relayUrl = 'wss://relay.example.invalid' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

  const state = {
    state: 'on',
    minClient: { desktop: '0.0.0', android: '0.0.0' },
    nextLogin: null,          // { uid, email } | { error: 'access_denied' }
    accounts: {},             // uid -> account の欄
    refreshError: null,       // 'TOKEN_EXPIRED' など
    rotateRefresh: false,     // 真なら refresh_token を替える
    down: false,              // 真の間は全部の口が接続を切る
    calls: [],                // { method, path, client }
    hosts: {},                // hostId -> { hostId, publicKey, name, platform, online, lastSeenAt, syncPublicKey, createdAt, deviceCount, uid }
    failNextProof: false,     // 真なら次の PUT /v1/hosts/{id} の証明の照合だけを 422 bad_proof にする（やり直しの試験）
  };
  const challenges = new Map(); // challengeId -> { nonce, serverPrivateKey, publicKey, uid, expiresAt }
  const codes = new Map();    // code -> { challenge, redirectUri, uid, email, expiresAt, used }
  const refreshTokens = new Map(); // refreshToken -> uid
  let seq = 0;

  function issueIdToken(uid, extra = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      iss: `https://securetoken.google.com/${PROJECT_ID}`, aud: PROJECT_ID,
      sub: uid, email: `${uid}@example.com`, iat: nowSec, exp: nowSec + 3600,
      ...extra,
    }));
    const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey));
    return `${header}.${payload}.${signature}`;
  }

  const uidOf = req => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const payload = token ? JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) : null;
    return payload?.sub ?? null;
  };

  const accountOf = uid => state.accounts[uid] ?? { uid, status: 'free', plan: null, limits: null, usage: null, sync: null };

  const routes = [];          // { method, pattern, handler } — route() で足す口（既定の口より先に見る）
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    state.calls.push({ method: req.method, path: url.pathname + url.search, client: req.headers['x-pleiad-client'] ?? null });
    if (state.down) { req.socket.destroy(); return; }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = typeof r.pattern === 'string' ? (r.pattern === url.pathname ? {} : null) : r.pattern.exec(url.pathname);
      if (m) return r.handler(req, res, url, m);
    }

    if (url.pathname === '/jwks' && req.method === 'GET') {
      return json(res, 200, { keys: [jwk] }, { 'cache-control': 'public, max-age=3600' });
    }
    if (url.pathname === '/v1/auth/config' && req.method === 'GET') {
      return json(res, 200, {
        state: state.state,
        token: { projectId: PROJECT_ID, apiKey: API_KEY },
        urls: { login: `${origin}/login`, account: `${origin}/account`, profile: `${origin}/profile`, relay: relayUrl, refresh: `${origin}/v1/token` },
        minClient: state.minClient,
      });
    }
    if (url.pathname === '/login' && req.method === 'GET') {
      const q = url.searchParams;
      const back = new URL(q.get('redirect_uri') ?? '/');
      back.searchParams.set('state', q.get('state') ?? '');
      const next = state.nextLogin;
      if (next?.error) {
        back.searchParams.set('error', next.error);
      } else {
        const code = `code-${++seq}`;
        const uid = next?.uid ?? 'user-1';
        codes.set(code, { challenge: q.get('code_challenge') ?? '', redirectUri: q.get('redirect_uri') ?? '', uid, email: next?.email ?? `${uid}@example.com`, expiresAt: Date.now() + 60_000 });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/v1/auth/token' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const entry = codes.get(body.code);
      codes.delete(body.code);   // 外れても消す（1 回きり）
      const ok = entry && !entry.used && Date.now() < entry.expiresAt && entry.redirectUri === body.redirectUri
        && b64url(crypto.createHash('sha256').update(String(body.codeVerifier ?? '')).digest()) === entry.challenge;
      if (!ok) return json(res, 400, { error: { code: 'invalid_grant', message: 'invalid grant' } });
      entry.used = true;
      const refreshToken = `rt-${++seq}`;
      refreshTokens.set(refreshToken, entry.uid);
      return json(res, 200, {
        idToken: issueIdToken(entry.uid, { email: entry.email }), refreshToken, expiresAt: Date.now() + 3600_000,
        uid: entry.uid, email: entry.email, tokenProjectId: PROJECT_ID, apiKey: API_KEY,
      });
    }
    if (url.pathname === '/v1/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (state.refreshError) return json(res, 400, { error: { message: state.refreshError } });
      const rt = form.get('refresh_token');
      const uid = form.get('grant_type') === 'refresh_token' && rt ? refreshTokens.get(rt) : undefined;
      if (!uid) return json(res, 400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
      const next = state.rotateRefresh ? `rt-${++seq}` : rt;
      if (next !== rt) { refreshTokens.delete(rt); refreshTokens.set(next, uid); }
      return json(res, 200, { id_token: issueIdToken(uid), refresh_token: next, expires_in: '3600' });
    }
    if (url.pathname === '/v1/account') {
      const uid = uidOf(req);
      if (!uid) return json(res, 401, { error: { code: 'unauthenticated', message: 'no token' } });
      if (req.method === 'GET') return json(res, 200, accountOf(uid));
      if (req.method === 'PATCH') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const cur = state.accounts[uid] ?? accountOf(uid);
        state.accounts[uid] = { ...cur, ...(body?.sync ? { sync: { ...cur.sync, ...body.sync } } : {}) };
        return json(res, 200, state.accounts[uid]);
      }
    }
    // ホストの登録（GET /v1/hosts・POST /v1/hosts/challenge・PUT/PATCH/DELETE /v1/hosts/{hostId}。Plus の利用者だけ）
    if (url.pathname === '/v1/hosts' || url.pathname.startsWith('/v1/hosts/')) {
      const uid = uidOf(req);
      if (!uid) return json(res, 401, { error: { code: 'unauthenticated', message: 'no token' } });
      if (accountOf(uid).status !== 'plus') return json(res, 403, { error: { code: 'not_plus', message: 'not plus' } });
      const hostPath = /^\/v1\/hosts\/([a-z2-7]{26})$/.exec(url.pathname)?.[1] ?? null;
      const publicHost = h => h && ({ hostId: h.hostId, publicKey: h.publicKey, name: h.name, platform: h.platform, online: h.online, lastSeenAt: h.lastSeenAt, syncPublicKey: h.syncPublicKey, createdAt: h.createdAt, deviceCount: h.deviceCount });

      if (url.pathname === '/v1/hosts' && req.method === 'GET') {
        return json(res, 200, { hosts: Object.values(state.hosts).filter(h => h.uid === uid).map(publicHost) });
      }
      if (url.pathname === '/v1/hosts/challenge' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const pub = b64urlToBuf(body.publicKey);
        if (pub.length !== 32 || body.hostId !== hostIdFor(pub)) return json(res, 422, { error: { code: 'bad_proof', message: 'bad proof' } });
        const kp = generateKeyPair();
        const challengeId = `ch-${++seq}`;
        challenges.set(challengeId, { nonce: crypto.randomBytes(32), serverPrivateKey: kp.privateKey, publicKey: pub, hostId: body.hostId, uid, expiresAt: Date.now() + 30_000 });
        return json(res, 200, { challengeId, nonce: b64url(challenges.get(challengeId).nonce), serverPublicKey: b64url(kp.publicKey), expiresAt: new Date(Date.now() + 30_000).toISOString() });
      }
      if (hostPath && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const ch = challenges.get(body.challengeId);
        challenges.delete(body.challengeId);
        const pub = b64urlToBuf(body.publicKey);
        const valid = ch && ch.uid === uid && ch.hostId === hostPath && Date.now() < ch.expiresAt && ch.publicKey.equals(pub);
        const k = valid ? hkdfLabel(dh(ch.serverPrivateKey, pub), 'pleiad host proof v1') : null;
        const expectedBuf = k ? crypto.createHmac('sha256', k).update(ch.nonce).update(Buffer.from(hostPath, 'utf8')).update(Buffer.from('register', 'utf8')).digest() : Buffer.alloc(32);
        const proofBuf = b64urlToBuf(body.proof);
        if (!valid || state.failNextProof || proofBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(proofBuf, expectedBuf)) {
          const bug = state.failNextProof && valid;
          state.failNextProof = false;
          return json(res, 422, { error: { code: 'bad_proof', message: bug ? 'bad proof (injected)' : 'bad proof' } });
        }
        const existing = state.hosts[hostPath];
        if (existing && existing.uid !== uid) return json(res, 409, { error: { code: 'host_taken', message: 'host taken' } });
        if (!existing) {
          const limit = accountOf(uid).limits?.hosts;
          if (limit != null && Object.values(state.hosts).filter(h => h.uid === uid).length >= limit) {
            return json(res, 429, { error: { code: 'host_limit', message: 'host limit' } });
          }
        }
        const name = typeof body.name === 'string' && body.name.length >= 1 && body.name.length <= 64 ? body.name : null;
        const platform = ['win32', 'darwin', 'linux'].includes(body.platform) ? body.platform : null;
        if (!name || !platform) return json(res, 400, { error: { code: 'bad_request', message: 'name/platform' } });
        const host = state.hosts[hostPath] = {
          hostId: hostPath, publicKey: body.publicKey, name, platform,
          online: existing?.online ?? false, lastSeenAt: existing?.lastSeenAt ?? null,
          syncPublicKey: typeof body.syncPublicKey === 'string' ? body.syncPublicKey : (existing?.syncPublicKey ?? null),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          deviceCount: existing?.deviceCount ?? 0, uid,
        };
        return json(res, 200, { host: publicHost(host) });
      }
      if (hostPath && req.method === 'PATCH') {
        const existing = state.hosts[hostPath];
        if (!existing) return json(res, 404, { error: { code: 'not_found', message: 'not found' } });
        if (existing.uid !== uid) return json(res, 403, { error: { code: 'forbidden', message: 'forbidden' } });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.name === 'string' && body.name.length >= 1 && body.name.length <= 64) existing.name = body.name;
        if (typeof body.syncPublicKey === 'string' || body.syncPublicKey === null) existing.syncPublicKey = body.syncPublicKey;
        if (Number.isInteger(body.deviceCount) && body.deviceCount >= 0 && body.deviceCount <= 64) existing.deviceCount = body.deviceCount;
        if (typeof body.platform === 'string' && ['win32', 'darwin', 'linux'].includes(body.platform)) existing.platform = body.platform;
        return json(res, 200, { host: publicHost(existing) });
      }
      if (hostPath && req.method === 'DELETE') {
        const existing = state.hosts[hostPath];
        if (existing && existing.uid === uid) delete state.hosts[hostPath];
        res.writeHead(204); return res.end();
      }
    }
    return json(res, 404, { error: { code: 'not_found', message: 'not found' } });
  });

  const origin = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(`http://127.0.0.1:${server.address().port}`); });
  });

  return {
    url: origin,
    jwksUrl: `${origin}/jwks`,
    state,
    issueIdToken,
    route,
    close: () => new Promise(r => { try { server.closeAllConnections?.(); } catch {} server.close(() => r()); }),
  };
}
