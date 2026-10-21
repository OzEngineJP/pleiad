// 試験用の偽の Pleiad Plus。本物の api には送らない（AGENT_HOST_PLUS_API にこの URL を渡す）。
//   GET  /jwks            試験用の RSA 鍵（起動のたびに作る。Cache-Control: max-age 付き）
//   GET  /v1/auth/config  state・token・minClient は state から変えられる。urls.login は /login、urls.refresh は /v1/token
//   GET  /login           偽のログインのページ。state.nextLogin に従い redirect_uri へ 302（code か error）
//   POST /v1/auth/token   verifier・redirectUri・期限 60 秒・1 回きりを照合。外れたら 400 invalid_grant
//   POST /v1/token        更新（form。?key=）。state.refreshError があれば 400 {"error":{"message":…}}
//   GET/PATCH /v1/account state.accounts[uid] から返す。無い uid は free
//   同期の口 /v1/sync/*（state・keys・reset・items）。暗号文・包んだ鍵・itemId だけを持ち、中身は読まない:
//     state.sync[uid] = { keyId, keys: { hostId: { keyId, wrapped, wrappedBy, lastSyncAt?, detachedAt?, name? } },
//                         items: { itemId: { rev, seq, keyId, ciphertext, deleted, size, updatedAt, updatedBy } }, seq, totalBytes,
//                         lastWriteAt, lastWriterHostId, resetAt, resetBy, resetByName }
//     state は docs/plus.md の「同期の始め直しと登録の外れ」の欄（itemCount・updatedAt・lastWriter・holders・resetAt・resetBy）も返す
//     state.syncLimitBytes   アカウントの容量の上限（limitBytes。試験から変える）。超える PUT items は 413 sync_quota（error に limitBytes）
//     state.syncItemLimit    暗号文の字数の上限（null なら本文の上限だけ）。超えると 413 too_large
//     state.syncBodies       /v1/sync/* が受けた本文の全部（生の文字列。試験が中身を調べる）
//     state.syncFail         誤りの差し込み [{ method?, path: RegExp, status, code, message, headers?, extra?, count? }]（count 回まで）
//     同期を切った人（account.sync.enabled === false）は state 以外が 403 forbidden（message sync_disabled）。state は enabled: false
//     reset は previousKeyId が今の keyId と違えば 409 previousKeyId。項目（墓標を除く）があり、呼んだホストが今の鍵を持たないときは
//     confirm: { keyId, itemCount }（今の値）が要り、無い・合わなければ 409 reset_confirm（今の値を載せる）。項目と宛てを全部消す
//     自分のものでないホストを渡すと 403 forbidden（message host）
//     PUT items は baseRev が今の rev と違えば 409 rev（一番外に current: { rev, updatedAt }）、keyId が違えば 409 keyId、
//     決めた欄（baseRev・keyId・ciphertext・deleted・hostId）のほかがあれば 400（message は欄の名前）
//     本文の上限は試験用の作り物の値（/v1/sync/items/* が 3,000,000 バイト、ほかは 100,000 バイト）
//   DELETE /v1/hosts/{id} は鍵の行を消さず detachedAt・name を付けて残し、state.hostsRemoved に by: 'user' を書く
//   （unbindHost(hostId, by) で運営が外したのも作れる）。GET /v1/hosts は removed も返す。
//   外した hostId の PUT は 403 host_removed（墓標。今の api）。state.allowReregister = true の間は前の版の api のふりで、
//   PUT で登録し直すと戻る
//   券（docs/plus.md「券」）:
//     GET  /.well-known/pleiad-keys  券の Ed25519 の公開鍵（state.ticketKeysDown = true の間は 503）
//     POST /v1/tickets/challenge・POST /v1/tickets  本物の api の順で確かめて、中継の券・受け入れの券を出す
//       （state.tickets = false の間は券の口が無い前の版の api のふりで 404。/v1/auth/config の admission も載せない）
//     state.ticketFail  誤りの差し込み [{ purpose?, path?, status, code, message?, extra?, count? }]（count 回まで）
//     state.issued      出した券の payload（{ purpose, relay?, admission?, sync? }）
//     signTicket(payload, { kid?, privateKey? }) で試験が任意の券を作れる
//   印 X-Pleiad-Admission: 2（state.calls の admission に残す）:
//     state.admission（既定 1）を 2 にすると、印の無い PUT /v1/hosts と syncPublicKey つきの PATCH は 426 update_required
//     印つきの PUT・PATCH に syncPublicKey があれば 400、印つきの /v1/sync/*（同期の券は無い）は 403 ticket_invalid
//   state.legacySync = true の間は前の版の api のふり（足した欄・removed・confirm の照合が無く、外すと鍵の行を消し、403 の message は forbidden）
//   state.down = true の間は全部の口が接続を切る。route() で後の issue が口を足せる
//   呼ばれた口と X-Pleiad-Client・X-Pleiad-Admission を state.calls に残す
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
    visibility: 'public',     // 'optin' にすると端末の印（pleiad://plus/enable）が無い限り入口が隠れる
    minClient: { desktop: '0.0.0', android: '0.0.0' },
    nextLogin: null,          // { uid, email } | { error: 'access_denied' }
    accounts: {},             // uid -> account の欄
    refreshError: null,       // 'TOKEN_EXPIRED' など
    rotateRefresh: false,     // 真なら refresh_token を替える
    down: false,              // 真の間は全部の口が接続を切る
    calls: [],                // { method, path, client, auth }
    proxy: {},                // pathname -> { status?, body?, headers? } | async (req, body) => 同じ形。中継の口の応答（未設定は 404）
    hosts: {},                // hostId -> { hostId, publicKey, name, platform, online, lastSeenAt, syncPublicKey, createdAt, deviceCount, uid }
    failNextProof: false,     // 真なら次の PUT /v1/hosts/{id} の証明の照合だけを 422 bad_proof にする（やり直しの試験）
    sync: {},                 // uid -> 同期の台帳（上の説明）
    hostsRemoved: {},         // hostId -> { uid, hostId, by: 'user' | 'admin', at }
    legacySync: false,        // 真なら前の版の api のふり（上の説明）
    syncLimitBytes: 7_340_032,
    syncItemLimit: null,
    syncBodies: [],           // { method, path, body }
    syncFail: [],
    allowReregister: false,   // 真なら外した hostId も PUT で登録し直せる（前の版の api）
    tickets: true,            // 偽なら券の口が無い前の版の api（challenge が 404）
    admission: 1,             // /v1/auth/config の admission（2 で印の無い登録を 426 で断る）
    ticketKeysDown: false,    // 真の間は /.well-known/pleiad-keys が 503
    ticketFail: [],
    issued: [],
  };
  const challenges = new Map(); // challengeId -> { purpose, nonce, serverPrivateKey, publicKey, hostId, uid, expiresAt }
  const ticketKeys = crypto.generateKeyPairSync('ed25519');
  const ticketKid = 'test-ticket-1';
  const ticketX = ticketKeys.publicKey.export({ format: 'jwk' }).x;
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

  /** 券を署名する（JWS のコンパクト形。試験が形の違う券・ほかのアカウントの券を作るのにも使う） */
  function signTicket(payload, { kid: k = ticketKid, privateKey: key = ticketKeys.privateKey, header = {} } = {}) {
    const h = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'pleiad-ticket+jwt', kid: k, ...header }));
    const p = b64url(JSON.stringify(payload));
    return `${h}.${p}.${b64url(crypto.sign(null, Buffer.from(`${h}.${p}`, 'ascii'), key))}`;
  }
  const ticketClaims = (aud, uid, extra) => {
    const iat = Math.floor(Date.now() / 1000);
    return { iss: 'pleiad-tickets', aud, uid, iat, exp: iat + 300, jti: b64url(crypto.randomBytes(16)), ...extra };
  };

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
    const mark = req.headers['x-pleiad-admission'] ?? null;
    state.calls.push({ method: req.method, path: url.pathname + url.search, client: req.headers['x-pleiad-client'] ?? null, auth: req.headers.authorization ?? null, admission: mark });
    if (state.down) { req.socket.destroy(); return; }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = typeof r.pattern === 'string' ? (r.pattern === url.pathname ? {} : null) : r.pattern.exec(url.pathname);
      if (m) return r.handler(req, res, url, m);
    }

    // キー無しの機能の中継の口（判定・書き起こし・読み上げ）。ID トークンを確かめ、state.proxy で試験が応答を決める
    if (url.pathname.startsWith('/v1/proxy/') && req.method === 'POST') {
      if (!uidOf(req)) return json(res, 401, { error: { code: 'unauthenticated', message: 'no token' } });
      const custom = state.proxy[url.pathname];
      if (!custom) return json(res, 404, { error: { code: 'not_found', message: 'not configured' } });
      const r = typeof custom === 'function' ? await custom(req, await readBody(req)) : custom;
      if (Buffer.isBuffer(r.body) || r.body instanceof Uint8Array) { res.writeHead(r.status ?? 200, r.headers ?? {}); return res.end(r.body); }
      return json(res, r.status ?? 200, r.body ?? r, r.headers ?? {});
    }

    if (url.pathname === '/jwks' && req.method === 'GET') {
      return json(res, 200, { keys: [jwk] }, { 'cache-control': 'public, max-age=3600' });
    }
    if (url.pathname === '/.well-known/pleiad-keys' && req.method === 'GET' && state.tickets) {
      if (state.ticketKeysDown) return json(res, 503, { error: { code: 'unavailable', message: 'unavailable' } });
      return json(res, 200, { keys: [{ kty: 'OKP', crv: 'Ed25519', x: ticketX, kid: ticketKid, alg: 'EdDSA', use: 'sig' }] }, { 'cache-control': 'public, max-age=300' });
    }
    if ((url.pathname === '/v1/tickets/challenge' || url.pathname === '/v1/tickets') && req.method === 'POST' && state.tickets) {
      return ticketRoute(req, res, url);
    }
    if (url.pathname === '/v1/auth/config' && req.method === 'GET') {
      return json(res, 200, {
        state: state.state,
        visibility: state.visibility ?? 'public',
        token: { projectId: PROJECT_ID, apiKey: API_KEY },
        urls: { login: `${origin}/login`, account: `${origin}/account`, profile: `${origin}/profile`, relay: relayUrl, refresh: `${origin}/v1/token` },
        minClient: state.minClient,
        ...(state.tickets ? { admission: state.admission } : {}),
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
        const hosts = Object.values(state.hosts).filter(h => h.uid === uid).map(publicHost);
        if (state.legacySync) return json(res, 200, { hosts });
        const removed = Object.values(state.hostsRemoved).filter(r => r.uid === uid)
          .sort((a, b) => String(a.at).localeCompare(String(b.at))).map(r => ({ hostId: r.hostId, by: r.by, at: r.at }));
        return json(res, 200, { hosts, removed });
      }
      if (url.pathname === '/v1/hosts/challenge' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const pub = b64urlToBuf(body.publicKey);
        if (pub.length !== 32 || body.hostId !== hostIdFor(pub)) return json(res, 422, { error: { code: 'bad_proof', message: 'bad proof' } });
        const kp = generateKeyPair();
        const challengeId = `ch-${++seq}`;
        challenges.set(challengeId, { purpose: 'register', nonce: crypto.randomBytes(32), serverPrivateKey: kp.privateKey, publicKey: pub, hostId: body.hostId, uid, expiresAt: Date.now() + 30_000 });
        return json(res, 200, { challengeId, nonce: b64url(challenges.get(challengeId).nonce), serverPublicKey: b64url(kp.publicKey), expiresAt: new Date(Date.now() + 30_000).toISOString() });
      }
      if (hostPath && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (state.tickets && mark === '2' && 'syncPublicKey' in body) return json(res, 400, { error: { code: 'bad_request', message: 'syncPublicKey' } });
        if (state.tickets && mark !== '2' && state.admission === 2) return json(res, 426, { error: { code: 'update_required', message: 'update required', feature: 'admission_v2' } });
        const ch = challenges.get(body.challengeId);
        challenges.delete(body.challengeId);
        const pub = b64urlToBuf(body.publicKey);
        const valid = ch && ch.purpose === 'register' && ch.uid === uid && ch.hostId === hostPath && Date.now() < ch.expiresAt && ch.publicKey.equals(pub);
        const k = valid ? hkdfLabel(dh(ch.serverPrivateKey, pub), 'pleiad host proof v1') : null;
        const expectedBuf = k ? crypto.createHmac('sha256', k).update(ch.nonce).update(Buffer.from(hostPath, 'utf8')).update(Buffer.from('register', 'utf8')).digest() : Buffer.alloc(32);
        const proofBuf = b64urlToBuf(body.proof);
        if (!valid || state.failNextProof || proofBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(proofBuf, expectedBuf)) {
          const bug = state.failNextProof && valid;
          state.failNextProof = false;
          return json(res, 422, { error: { code: 'bad_proof', message: bug ? 'bad proof (injected)' : 'bad proof' } });
        }
        if (state.hostsRemoved[hostPath] && !state.legacySync && !state.allowReregister) return json(res, 403, { error: { code: 'host_removed', message: 'host removed' } });
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
        if (!state.legacySync) {
          const k = state.sync[uid]?.keys[hostPath];
          if (k?.detachedAt) k.detachedAt = null;
          delete state.hostsRemoved[hostPath];
        }
        return json(res, 200, { host: publicHost(host) });
      }
      if (hostPath && req.method === 'PATCH') {
        const existing = state.hosts[hostPath];
        if (!existing) return json(res, 404, { error: { code: 'not_found', message: 'not found' } });
        if (existing.uid !== uid) return json(res, 403, { error: { code: 'forbidden', message: 'forbidden' } });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (state.tickets && 'syncPublicKey' in body) {
          if (mark === '2') return json(res, 400, { error: { code: 'bad_request', message: 'syncPublicKey' } });
          if (state.admission === 2) return json(res, 426, { error: { code: 'update_required', message: 'update required', feature: 'admission_v2' } });
        }
        if (typeof body.name === 'string' && body.name.length >= 1 && body.name.length <= 64) existing.name = body.name;
        if (typeof body.syncPublicKey === 'string' || body.syncPublicKey === null) existing.syncPublicKey = body.syncPublicKey;
        if (Number.isInteger(body.deviceCount) && body.deviceCount >= 0 && body.deviceCount <= 64) existing.deviceCount = body.deviceCount;
        if (typeof body.platform === 'string' && ['win32', 'darwin', 'linux'].includes(body.platform)) existing.platform = body.platform;
        return json(res, 200, { host: publicHost(existing) });
      }
      if (hostPath && req.method === 'DELETE') {
        const existing = state.hosts[hostPath];
        if (existing && existing.uid === uid) unbindHost(hostPath, 'user');
        res.writeHead(204); return res.end();
      }
    }
    if (url.pathname.startsWith('/v1/sync/')) return syncRoute(req, res, url);
    return json(res, 404, { error: { code: 'not_found', message: 'not found' } });
  });

  // ---- 同期の口 ----------------------------------------------------------------------------------------------
  const SYNC_ITEM_FIELDS = new Set(['baseRev', 'keyId', 'ciphertext', 'deleted', 'hostId']);
  const KEY_ID_RX = /^[0-9a-f]{16}$/;
  const ITEM_ID_RX = /^[A-Za-z0-9_-]{32}$/;
  const CIPHERTEXT_RX = /^v1\.([^.]*)\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;
  const isWrapped = v => typeof v === 'string' && /^[A-Za-z0-9_-]{80}$/.test(v) && b64urlToBuf(v).length === 60;
  const syncOf = uid => (state.sync[uid] ??= { keyId: null, keys: {}, items: {}, seq: 0, totalBytes: 0 });
  const err = (res, status, code, message, extra = {}, headers = {}) => json(res, status, { error: { code, message, ...extra } }, headers);
  const liveKey = (k, keyId) => !!k && !!keyId && k.keyId === keyId && !k.detachedAt;
  const itemCountOf = s => Object.values(s.items).filter(it => it.deleted !== true).length;
  const HOUR = 3_600_000;

  // ホストを外す（利用者の DELETE と同じ処理。by: 'admin' は運営が外したとき）。前の版の api は鍵の行も消した
  function unbindHost(hostId, by = 'admin') {
    const existing = state.hosts[hostId];
    if (!existing) return;
    const uid = existing.uid;
    delete state.hosts[hostId];
    const k = state.sync[uid]?.keys[hostId];
    if (state.legacySync) { if (k) delete state.sync[uid].keys[hostId]; return; }
    if (k) { k.detachedAt = new Date().toISOString(); k.name = existing.name ?? null; }
    state.hostsRemoved[hostId] = { uid, hostId, by, at: new Date().toISOString() };
  }

  // 今の keyId の鍵の行（外した行も registered: false で）。登録中 → lastSyncAt の新しい順 → hostId
  function holdersOf(uid, s) {
    if (!s.keyId) return [];
    return Object.entries(s.keys).filter(([, k]) => k.keyId === s.keyId).map(([hostId, k]) => {
      const host = state.hosts[hostId]?.uid === uid ? state.hosts[hostId] : null;
      return { hostId, name: host?.name ?? k.name ?? null, lastSyncAt: k.lastSyncAt ?? null, registered: !!host && !k.detachedAt };
    }).sort((a, b) => (Number(b.registered) - Number(a.registered))
      || String(b.lastSyncAt ?? '').localeCompare(String(a.lastSyncAt ?? '')) || a.hostId.localeCompare(b.hostId));
  }

  function touchLastSync(s, hostId) {
    const k = s.keys[hostId];
    if (!liveKey(k, s.keyId)) return;
    if (!k.lastSyncAt || Date.now() - Date.parse(k.lastSyncAt) >= HOUR) k.lastSyncAt = new Date().toISOString();
  }

  function syncState(uid) {
    const s = syncOf(uid);
    const hosts = Object.values(state.hosts).filter(h => h.uid === uid).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const withKey = new Set(Object.entries(s.keys).filter(([, k]) => liveKey(k, s.keyId)).map(([id]) => id));
    const out = {
      enabled: accountOf(uid).sync?.enabled !== false,
      keyId: s.keyId,
      hostsWithKey: hosts.filter(h => withKey.has(h.hostId)).map(h => h.hostId),
      pending: s.keyId ? hosts.filter(h => h.syncPublicKey && !withKey.has(h.hostId)).map(h => h.hostId) : [],
      totalBytes: s.totalBytes,
      limitBytes: state.syncLimitBytes,
      cursor: s.seq,
    };
    if (state.legacySync) return out;
    const nameOf = id => state.hosts[id]?.name ?? s.keys[id]?.name ?? null;
    return {
      ...out,
      itemCount: itemCountOf(s),
      updatedAt: s.lastWriteAt ?? null,
      lastWriter: s.lastWriterHostId ? { hostId: s.lastWriterHostId, name: nameOf(s.lastWriterHostId) } : null,
      holders: holdersOf(uid, s),
      resetAt: s.resetAt ?? null,
      resetBy: s.resetBy ? { hostId: s.resetBy, name: state.hosts[s.resetBy]?.name ?? s.resetByName ?? null } : null,
    };
  }

  async function syncRoute(req, res, url) {
    const uid = uidOf(req);
    if (!uid) return err(res, 401, 'unauthenticated', 'no token');
    if (accountOf(uid).status !== 'plus') return err(res, 403, 'not_plus', 'not plus');
    if (state.tickets && req.headers['x-pleiad-admission'] === '2' && !req.headers['x-pleiad-sync-ticket']) return err(res, 403, 'ticket_invalid', 'ticket invalid');
    if (state.tickets && state.admission === 2 && !req.headers['x-pleiad-sync-ticket']) return err(res, 426, 'update_required', 'update required', { feature: 'admission_v2' });
    const itemPath = /^\/v1\/sync\/items\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
    const raw = req.method === 'GET' ? '' : await readBody(req);
    if (Buffer.byteLength(raw) > (itemPath ? 3_000_000 : 100_000)) return err(res, 413, 'too_large', 'too large');
    state.syncBodies.push({ method: req.method, path: url.pathname + url.search, body: raw });
    const fail = state.syncFail.find(f => (!f.method || f.method === req.method) && f.path.test(url.pathname) && (f.count ?? 1) > 0);
    if (fail) {
      fail.count = (fail.count ?? 1) - 1;
      return err(res, fail.status, fail.code, fail.message ?? fail.code, fail.extra ?? {}, fail.headers ?? {});
    }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return err(res, 400, 'bad_request', 'body'); }
    const s = syncOf(uid);
    const ownHost = id => (typeof id === 'string' && state.hosts[id]?.uid === uid ? state.hosts[id] : null);
    const notOwn = () => err(res, 403, 'forbidden', state.legacySync ? 'forbidden' : 'host');

    if (url.pathname === '/v1/sync/state' && req.method === 'GET') {
      const self = url.searchParams.get('hostId');
      if (!state.legacySync && self && ownHost(self)) touchLastSync(s, self);
      return json(res, 200, syncState(uid));
    }
    if (accountOf(uid).sync?.enabled === false) return err(res, 403, 'forbidden', 'sync_disabled');

    const keyPath = /^\/v1\/sync\/keys\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
    if (keyPath && req.method === 'GET') {
      if (!ownHost(keyPath)) return notOwn();
      const k = s.keys[keyPath];
      if (!k || !s.keyId || k.keyId !== s.keyId) return err(res, 404, 'not_found', 'not found');
      if (!state.legacySync) touchLastSync(s, keyPath);
      return json(res, 200, { keyId: k.keyId, wrapped: k.wrapped, wrappedBy: k.wrappedBy });
    }
    if (keyPath && req.method === 'PUT') {
      if (typeof body.keyId !== 'string') return err(res, 400, 'bad_request', 'keyId');
      if (typeof body.wrappedBy !== 'string') return err(res, 400, 'bad_request', 'wrappedBy');
      if (!isWrapped(body.wrapped)) return err(res, 400, 'bad_request', 'wrapped');
      const target = ownHost(keyPath);
      if (!target || !ownHost(body.wrappedBy)) return notOwn();
      if (!target.syncPublicKey) return err(res, 400, 'bad_request', 'syncPublicKey');
      if (!s.keyId || body.keyId !== s.keyId) return err(res, 409, 'conflict', 'keyId');
      if (!liveKey(s.keys[body.wrappedBy], s.keyId)) return err(res, 409, 'conflict', 'wrappedBy');
      s.keys[keyPath] = { keyId: body.keyId, wrapped: body.wrapped, wrappedBy: body.wrappedBy };
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/v1/sync/reset' && req.method === 'POST') {
      if (typeof body.keyId !== 'string' || !KEY_ID_RX.test(body.keyId)) return err(res, 400, 'bad_request', 'keyId');
      if (typeof body.hostId !== 'string') return err(res, 400, 'bad_request', 'hostId');
      if (!isWrapped(body.wrapped)) return err(res, 400, 'bad_request', 'wrapped');
      if (body.previousKeyId !== null && typeof body.previousKeyId !== 'string') return err(res, 400, 'bad_request', 'previousKeyId');
      const confirm = state.legacySync ? null : (body.confirm ?? null);
      if (confirm !== null && (typeof confirm !== 'object' || Array.isArray(confirm)
        || typeof confirm.keyId !== 'string' || !KEY_ID_RX.test(confirm.keyId)
        || !Number.isSafeInteger(confirm.itemCount) || confirm.itemCount < 0)) return err(res, 400, 'bad_request', 'confirm');
      const host = ownHost(body.hostId);
      if (!host) return notOwn();
      if (!host.syncPublicKey) return err(res, 400, 'bad_request', 'syncPublicKey');
      if ((s.keyId ?? null) !== body.previousKeyId) return err(res, 409, 'conflict', 'previousKeyId');
      if (!state.legacySync) {
        const itemCount = itemCountOf(s);
        const byHolder = liveKey(s.keys[body.hostId], s.keyId);
        const needConfirm = !!s.keyId && itemCount > 0 && !byHolder;
        if (needConfirm && !(confirm?.keyId === s.keyId && confirm?.itemCount === itemCount)) {
          return err(res, 409, 'reset_confirm', 'confirm', {
            keyId: s.keyId, itemCount, totalBytes: s.totalBytes, updatedAt: s.lastWriteAt ?? null, holders: holdersOf(uid, s),
          });
        }
      }
      const now = new Date().toISOString();
      s.keyId = body.keyId;
      s.items = {};
      s.totalBytes = 0;
      s.lastWriteAt = null;
      s.lastWriterHostId = null;
      s.resetAt = now;
      s.resetBy = body.hostId;
      s.resetByName = host.name ?? null;
      s.keys = { [body.hostId]: { keyId: body.keyId, wrapped: body.wrapped, wrappedBy: body.hostId, lastSyncAt: now } };
      return json(res, 200, syncState(uid));
    }
    if (url.pathname === '/v1/sync/items' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
      if (!Number.isInteger(since) || since < 0) return err(res, 400, 'bad_request', 'since');
      const all = Object.entries(s.items).filter(([, it]) => it.seq > since).sort((a, b) => a[1].seq - b[1].seq);
      const page = all.slice(0, limit).map(([itemId, it]) => ({ itemId, rev: it.rev, seq: it.seq, keyId: it.keyId, ciphertext: it.ciphertext, deleted: it.deleted, updatedAt: it.updatedAt }));
      return json(res, 200, { items: page, cursor: page.length ? page.at(-1).seq : since, more: all.length > limit });
    }
    if (itemPath && req.method === 'PUT') {
      if (!ITEM_ID_RX.test(itemPath)) return err(res, 400, 'bad_request', 'itemId');
      if (!body || typeof body !== 'object' || Array.isArray(body)) return err(res, 400, 'bad_request', 'body');
      const unknown = Object.keys(body).find(k => !SYNC_ITEM_FIELDS.has(k));
      if (unknown) return err(res, 400, 'bad_request', unknown);
      if (!Number.isSafeInteger(body.baseRev) || body.baseRev < 0) return err(res, 400, 'bad_request', 'baseRev');
      if (typeof body.keyId !== 'string') return err(res, 400, 'bad_request', 'keyId');
      if (typeof body.deleted !== 'boolean') return err(res, 400, 'bad_request', 'deleted');
      if (typeof body.hostId !== 'string') return err(res, 400, 'bad_request', 'hostId');
      const ciphertext = body.ciphertext ?? null;
      if (ciphertext === null) {
        if (!body.deleted) return err(res, 400, 'bad_request', 'ciphertext');
      } else {
        if (typeof ciphertext !== 'string') return err(res, 400, 'bad_request', 'ciphertext');
        if (state.syncItemLimit != null && ciphertext.length > state.syncItemLimit) return err(res, 413, 'too_large', 'too large');
        const m = CIPHERTEXT_RX.exec(ciphertext);
        if (!m || m[1] !== body.keyId) return err(res, 400, 'bad_request', 'ciphertext');
      }
      if (!ownHost(body.hostId)) return notOwn();
      if (!s.keyId || body.keyId !== s.keyId) return err(res, 409, 'conflict', 'keyId');
      const cur = s.items[itemPath];
      const curRev = cur?.rev ?? 0;
      if (curRev !== body.baseRev) return json(res, 409, { error: { code: 'conflict', message: 'rev' }, current: { rev: curRev, updatedAt: cur?.updatedAt ?? null } });
      const size = ciphertext === null ? 0 : ciphertext.length;
      const totalBytes = Math.max(0, s.totalBytes - (cur?.size ?? 0)) + size;
      if (totalBytes > state.syncLimitBytes) return err(res, 413, 'sync_quota', 'sync quota', { limitBytes: state.syncLimitBytes });
      const rev = body.baseRev + 1;
      const seq = ++s.seq;
      const updatedAt = new Date().toISOString();
      s.items[itemPath] = { rev, seq, keyId: body.keyId, ciphertext, deleted: body.deleted, size, updatedAt, updatedBy: body.hostId };
      s.totalBytes = totalBytes;
      s.lastWriteAt = updatedAt;
      s.lastWriterHostId = body.hostId;
      if (!state.legacySync) touchLastSync(s, body.hostId);
      return json(res, 200, { rev, seq });
    }
    return err(res, 404, 'not_found', 'not found');
  }

  // ---- 券の口（本物の api の順に確かめる） ---------------------------------------------------------------------
  async function ticketRoute(req, res, url) {
    const uid = uidOf(req);
    if (!uid) return err(res, 401, 'unauthenticated', 'no token');
    if (accountOf(uid).status !== 'plus') return err(res, 403, 'not_plus', 'not plus');
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return err(res, 400, 'bad_request', 'body'); }
    const challenge = url.pathname === '/v1/tickets/challenge';
    const purposeOf = challenge ? body.purpose : challenges.get(body.challengeId)?.purpose;
    const fail = state.ticketFail.find(f => (!f.path || f.path === url.pathname) && (!f.purpose || f.purpose === purposeOf) && (f.count ?? 1) > 0);
    if (fail) {
      fail.count = (fail.count ?? 1) - 1;
      return err(res, fail.status, fail.code, fail.message ?? fail.code, fail.extra ?? {});
    }
    if (challenge) {
      if (!['host', 'device', 'sync'].includes(body.purpose)) return err(res, 400, 'bad_request', 'purpose');
      const pub = b64urlToBuf(body.publicKey);
      if (pub.length !== 32 || typeof body.hostId !== 'string' || !/^[a-z2-7]{26}$/.test(body.hostId)) return err(res, 400, 'bad_request', 'publicKey');
      if (body.purpose !== 'device' && hostIdFor(pub) !== body.hostId) return err(res, 422, 'bad_proof', 'bad proof');
      const kp = generateKeyPair();
      const challengeId = `tch-${++seq}`;
      const nonce = crypto.randomBytes(32);
      challenges.set(challengeId, { purpose: body.purpose, nonce, serverPrivateKey: kp.privateKey, publicKey: pub, hostId: body.hostId, uid, expiresAt: Date.now() + 30_000 });
      return json(res, 200, { challengeId, nonce: b64url(nonce), serverPublicKey: b64url(kp.publicKey), expiresAt: new Date(Date.now() + 30_000).toISOString() });
    }
    const ch = challenges.get(body.challengeId);
    challenges.delete(body.challengeId);
    const valid = ch && ch.purpose !== 'register' && ch.uid === uid && Date.now() < ch.expiresAt;
    const k = valid ? hkdfLabel(dh(ch.serverPrivateKey, ch.publicKey), 'pleiad host proof v1') : null;
    const expected = k ? crypto.createHmac('sha256', k).update(ch.nonce).update(Buffer.from(ch.hostId, 'utf8')).update(Buffer.from(ch.purpose, 'utf8')).digest() : Buffer.alloc(32);
    const proof = b64urlToBuf(body.proof);
    if (!valid || proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected)) return err(res, 422, 'bad_proof', 'bad proof');
    const { purpose, hostId } = ch;
    if (state.hostsRemoved[hostId]) return purpose === 'device' ? err(res, 404, 'not_found', 'not found') : err(res, 403, 'host_removed', 'host removed');
    const host = state.hosts[hostId];
    if (!host || host.uid !== uid) return err(res, 404, 'not_found', 'not found');
    if (purpose !== 'device' && host.publicKey !== b64url(ch.publicKey)) return err(res, 422, 'bad_proof', 'bad proof');
    if (state.state !== 'on') return err(res, 503, 'unavailable', 'unavailable');
    if (purpose === 'sync' && accountOf(uid).sync?.enabled === false) return err(res, 403, 'forbidden', 'sync_disabled');
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    if (purpose === 'sync') {
      const out = { sync: signTicket(ticketClaims('sync', uid, { hostId })), expiresAt };
      state.issued.push({ purpose, ...out });
      return json(res, 200, out);
    }
    const limits = accountOf(uid).limits ?? {};
    const lim = { hosts: Number.isInteger(limits.hosts) ? limits.hosts : null, devicesPerHost: Number.isInteger(limits.devicesPerHost) ? limits.devicesPerHost : null };
    const sub = hostIdFor(ch.publicKey);
    const out = { relay: signTicket(ticketClaims('relay', uid, { role: purpose, sub, hostId, lim })), expiresAt };
    if (purpose === 'device') out.admission = signTicket(ticketClaims('pleiad-host', uid, { hostId, devicePub: b64url(ch.publicKey) }));
    state.issued.push({ purpose, ...out });
    return json(res, 200, out);
  }

  const origin = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(`http://127.0.0.1:${server.address().port}`); });
  });

  return {
    url: origin,
    jwksUrl: `${origin}/jwks`,
    state,
    issueIdToken,
    /** その uid の更新トークンを発行して返す（ログインの往復を経ずにセッションの保管を仕込むため） */
    grantRefreshToken: (uid) => { const token = `rt-${++seq}`; refreshTokens.set(token, uid); return token; },
    /** ホストを外す（by: 'admin' は運営の管理画面から外したとき。'user' は利用者の DELETE と同じ） */
    unbindHost,
    signTicket,
    /** 券の公開鍵の一覧の URL */
    ticketKeysUrl: `${origin}/.well-known/pleiad-keys`,
    route,
    close: () => new Promise(r => { try { server.closeAllConnections?.(); } catch {} server.close(() => r()); }),
  };
}
