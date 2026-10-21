// 試験用の偽の Pleiad Plus。本物の api には送らない（AGENT_HOST_PLUS_API にこの URL を渡す）。
//   GET  /jwks            試験用の RSA 鍵（起動のたびに作る。Cache-Control: max-age 付き）
//   GET  /.well-known/pleiad-keys  券の署名の公開鍵（Ed25519。起動のたびに作る。rotateTicketKey() で替えると生きている券が落ちる）
//   GET  /v1/auth/config  state・token・minClient は state から変えられる。urls.login は /login、urls.refresh は /v1/token
//                         admission は state.admissionRequired で 1 か 2（state.noTickets の間は欄が無い = 前の版の api）
//   GET  /login           偽のログインのページ。state.nextLogin に従い redirect_uri へ 302（code か error）
//   POST /v1/auth/token   verifier・redirectUri・期限 60 秒・1 回きりを照合。外れたら 400 invalid_grant。ID トークンの auth_time は今
//   POST /v1/token        更新（form。?key=）。state.refreshError があれば 400 {"error":{"message":…}}。auth_time は元のログインのまま
//   GET/PATCH /v1/account state.accounts[uid] から返す。無い uid は free
//   POST /v1/tickets/challenge・POST /v1/tickets  券の発行（purpose host・device・sync。証明は登録と同じ式で、最後の語が purpose）
//   同期の口 /v1/sync/*。暗号文・包んだ鍵・itemId だけを持ち、中身は読まない:
//     state.sync[uid] = { keyId, keys: { hostId: { keyId, wrapped, wrappedBy, lastSyncAt?, detachedAt?, name? } },
//                         items: { itemId: { rev, seq, keyId, ciphertext, deleted, size, updatedAt, updatedBy } }, seq, totalBytes,
//                         lastWriteAt, lastWriterHostId, resetAt, resetBy, resetByName,
//                         resetPublicKey, carry: [hostId], rotate: { removedHostId, at } | null,
//                         recovery: { requestedBy, requestedAt, readyAt } | null, joins: { hostId: 申し込み } }
//     券（X-Pleiad-Sync-Ticket）のある要求は受け入れの規則（券の PC で判定。鍵の受け渡しは承認・始め直しは K の署名・項目は鍵を持つ PC だけ）
//     券の無い要求（前の版のクライアント）は前の規則（自動の包み・reset_confirm）。ただし v2 の K のアカウントと
//     state.admissionRequired の間は 426 update_required。X-Pleiad-Admission: 2 だけで券が無ければ 403 ticket_invalid
//     （申し込み・回復の口は券が要り、印が無くても 403 ticket_invalid）。v2 の K のアカウントでは、印の無い PATCH の
//     syncPublicKey は 426、印の無い登録し直しは syncPublicKey を変えない
//     承認の途中の申し込みは、承認を担う PC を外したとき・別の PC が新しい K を置いたときに committed に戻る。
//     回復を頼んだ PC を外すと回復の待ちも消える
//     state も docs/plus.md の「同期の始め直しと登録の外れ」の欄（itemCount・updatedAt・lastWriter・holders・resetAt・resetBy）を返す
//     state.syncLimitBytes   アカウントの容量の上限（limitBytes。試験から変える）。超える PUT items は 413 sync_quota（error に limitBytes）
//     state.syncItemLimit    暗号文の字数の上限（null なら本文の上限だけ）。超えると 413 too_large
//     state.syncBodies       /v1/sync/* が受けた本文の全部（生の文字列。試験が中身を調べる）
//     state.syncFail         誤りの差し込み [{ method?, path: RegExp, hostId?, status, code, message, headers?, extra?, count? }]（count 回まで。hostId は券の PC）
//     state.recoveryWaitMs   回復の待ち（既定 72 時間）
//     同期を切った人（account.sync.enabled === false）は state 以外が 403 forbidden（message sync_disabled）。state は enabled: false
//     前の規則の reset は previousKeyId が今の keyId と違えば 409 previousKeyId。項目（墓標を除く）があり、呼んだホストが今の鍵を
//     持たないときは confirm: { keyId, itemCount }（今の値）が要り、無い・合わなければ 409 reset_confirm（今の値を載せる）
//     自分のものでないホストを渡すと 403 forbidden（message host）
//     PUT items は baseRev が今の rev と違えば 409 rev（一番外に current: { rev, updatedAt }）、keyId が違えば 409 keyId、
//     決めた欄（baseRev・keyId・ciphertext・deleted・hostId）のほかがあれば 400（message は欄の名前）
//     本文の上限は試験用の作り物の値（/v1/sync/items/* が 3,000,000 バイト、ほかは 100,000 バイト）
//   DELETE /v1/hosts/{id} は最近のログイン（auth_time が 300 秒以内）が要り、鍵の行を消さず detachedAt・name を付けて残し、
//   state.hostsRemoved に by: 'user' を書く（unbindHost(hostId, by) で運営が外したのも作れる）。墓標は消えず、同じ PC の登録・券は
//   403 host_removed。GET /v1/hosts は removed も返す
//   state.noTickets = true の間は券を知らない前の版の api のふり（券の口・承認の口が 404、墓標は登録し直すと消え、syncPublicKey を受ける）
//   state.legacySync = true の間はさらに前の版の api のふり（noTickets に加えて、足した欄・removed・confirm の照合が無く、
//   外すと鍵の行を消し、403 の message は forbidden）
//   state.down = true の間は全部の口が接続を切る。route() で後の issue が口を足せる
//   呼ばれた口と X-Pleiad-Client・X-Pleiad-Admission・券の有無を state.calls に残す
import http from 'node:http';
import crypto from 'node:crypto';
import { generateKeyPair, dh, hkdfLabel, hostIdFor } from '../../core/remote/noise.mjs';

const PROJECT_ID = 'test-project';
const API_KEY = 'test-api-key';
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlToBuf = s => Buffer.from(String(s ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const readBody = async req => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); };
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const edPublic = raw => crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' });
const B64U32_RX = /^[A-Za-z0-9_-]{43}$/;
const TICKET_TYP = 'pleiad-ticket+jwt';
const REAUTH_SECONDS = 300;

export async function startFakePlus({ relayUrl = 'wss://relay.example.invalid' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  let ticketKey = null;
  let ticketKid = '';
  let ticketGen = 0;
  const rotateTicketKey = () => { ticketKey = crypto.generateKeyPairSync('ed25519'); ticketKid = `t${++ticketGen}`; };
  rotateTicketKey();

  const state = {
    state: 'on',
    visibility: 'public',     // 'optin' にすると端末の印（pleiad://plus/enable）が無い限り入口が隠れる
    minClient: { desktop: '0.0.0', android: '0.0.0' },
    nextLogin: null,          // { uid, email } | { error: 'access_denied' }
    accounts: {},             // uid -> account の欄
    refreshError: null,       // 'TOKEN_EXPIRED' など
    rotateRefresh: false,     // 真なら refresh_token を替える
    down: false,              // 真の間は全部の口が接続を切る
    calls: [],                // { method, path, client, auth, admission, ticket }
    proxy: {},                // pathname -> { status?, body?, headers? } | async (req, body) => 同じ形。中継の口の応答（未設定は 404）
    hosts: {},                // hostId -> { hostId, publicKey, name, platform, online, lastSeenAt, syncPublicKey, createdAt, deviceCount, uid }
    failNextProof: false,     // 真なら次の PUT /v1/hosts/{id} の証明の照合だけを 422 bad_proof にする（やり直しの試験）
    sync: {},                 // uid -> 同期の台帳（上の説明）
    hostsRemoved: {},         // hostId -> { uid, hostId, by: 'user' | 'admin', at }
    noTickets: false,         // 真なら券を知らない前の版の api のふり（上の説明）
    legacySync: false,        // 真ならさらに前の版の api のふり（上の説明）
    admissionRequired: false, // ADMISSION_V2_REQUIRED（真なら券・印の無い要求を 426 で断る）
    tickets: [],              // 出した券 { purpose, hostId, uid, jti }
    syncLimitBytes: 7_340_032,
    syncItemLimit: null,
    recoveryWaitMs: 72 * 3_600_000,
    syncBodies: [],           // { method, path, body }
    syncFail: [],
  };
  const challenges = new Map(); // challengeId -> { nonce, serverPrivateKey, publicKey, hostId, uid, purpose, expiresAt }
  const codes = new Map();    // code -> { challenge, redirectUri, uid, email, expiresAt, used }
  const refreshTokens = new Map(); // refreshToken -> { uid, authTime }
  const ticketRate = new Map(); // uid -> 発行の challenge の時刻（1 分 60 回）
  let seq = 0;
  const oldApi = () => state.noTickets || state.legacySync;
  const nowSec = () => Math.floor(Date.now() / 1000);

  function issueIdToken(uid, extra = {}) {
    const now = nowSec();
    const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      iss: `https://securetoken.google.com/${PROJECT_ID}`, aud: PROJECT_ID,
      sub: uid, email: `${uid}@example.com`, iat: now, exp: now + 3600, auth_time: now,
      ...extra,
    }));
    const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey));
    return `${header}.${payload}.${signature}`;
  }

  const tokenOf = req => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    try { return token ? JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) : null; } catch { return null; }
  };
  const uidOf = req => tokenOf(req)?.sub ?? null;
  const recentLogin = req => Number(tokenOf(req)?.auth_time) >= nowSec() - REAUTH_SECONDS;

  const accountOf = uid => state.accounts[uid] ?? { uid, status: 'free', plan: null, limits: null, usage: null, sync: null };

  // ---- 券 -------------------------------------------------------------------------------------------------------
  function signTicket(claims) {
    const iat = nowSec();
    const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: TICKET_TYP, kid: ticketKid }));
    const payload = b64url(JSON.stringify({ iss: 'fake-plus', iat, exp: iat + 300, jti: b64url(crypto.randomBytes(16)), ...claims }));
    return `${header}.${payload}.${b64url(crypto.sign(null, Buffer.from(`${header}.${payload}`), ticketKey.privateKey))}`;
  }
  /** 同期の券を確かめ、payload か null */
  function verifySyncTicket(token, uid) {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
      if (header.alg !== 'EdDSA' || header.typ !== TICKET_TYP || header.kid !== ticketKid) return null;
      if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), ticketKey.publicKey, b64urlToBuf(parts[2]))) return null;
      const p = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
      const now = nowSec();
      if (p.iss !== 'fake-plus' || p.aud !== 'sync' || p.uid !== uid || !(p.iat <= now + 60) || !(p.exp > now - 60)) return null;
      return p;
    } catch { return null; }
  }
  /** 登録・券の発行の鍵の持ち主の証明（式は同じで、最後の語が purpose） */
  function proofOk(ch, pub, hostId, purpose, proof) {
    const k = hkdfLabel(dh(ch.serverPrivateKey, pub), 'pleiad host proof v1');
    const expected = crypto.createHmac('sha256', k).update(ch.nonce).update(Buffer.from(hostId, 'utf8')).update(Buffer.from(purpose, 'utf8')).digest();
    const got = b64urlToBuf(proof);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }
  function newChallenge(fields) {
    const kp = generateKeyPair();
    const challengeId = `ch-${++seq}`;
    const ch = { nonce: crypto.randomBytes(32), serverPrivateKey: kp.privateKey, expiresAt: Date.now() + 30_000, ...fields };
    challenges.set(challengeId, ch);
    return { challengeId, nonce: b64url(ch.nonce), serverPublicKey: b64url(kp.publicKey), expiresAt: new Date(ch.expiresAt).toISOString() };
  }

  const routes = [];          // { method, pattern, handler } — route() で足す口（既定の口より先に見る）
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    state.calls.push({ method: req.method, path: url.pathname + url.search, client: req.headers['x-pleiad-client'] ?? null, auth: req.headers.authorization ?? null,
      admission: req.headers['x-pleiad-admission'] ?? null, ticket: req.headers['x-pleiad-sync-ticket'] ? true : false });
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
    if (url.pathname === '/.well-known/pleiad-keys' && req.method === 'GET' && !oldApi()) {
      const x = b64url(ticketKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
      return json(res, 200, { keys: [{ kty: 'OKP', crv: 'Ed25519', x, kid: ticketKid, alg: 'EdDSA', use: 'sig' }] }, { 'cache-control': 'public, max-age=300' });
    }
    if (url.pathname === '/v1/auth/config' && req.method === 'GET') {
      return json(res, 200, {
        state: state.state,
        visibility: state.visibility ?? 'public',
        token: { projectId: PROJECT_ID, apiKey: API_KEY },
        urls: { login: `${origin}/login`, account: `${origin}/account`, profile: `${origin}/profile`, relay: relayUrl, refresh: `${origin}/v1/token` },
        minClient: state.minClient,
        ...(oldApi() ? {} : { admission: state.admissionRequired ? 2 : 1 }),
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
      const authTime = nowSec();
      refreshTokens.set(refreshToken, { uid: entry.uid, authTime });
      return json(res, 200, {
        idToken: issueIdToken(entry.uid, { email: entry.email, auth_time: authTime }), refreshToken, expiresAt: Date.now() + 3600_000,
        uid: entry.uid, email: entry.email, tokenProjectId: PROJECT_ID, apiKey: API_KEY,
      });
    }
    if (url.pathname === '/v1/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (state.refreshError) return json(res, 400, { error: { message: state.refreshError } });
      const rt = form.get('refresh_token');
      const entry = form.get('grant_type') === 'refresh_token' && rt ? refreshTokens.get(rt) : undefined;
      if (!entry) return json(res, 400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
      const next = state.rotateRefresh ? `rt-${++seq}` : rt;
      if (next !== rt) { refreshTokens.delete(rt); refreshTokens.set(next, entry); }
      return json(res, 200, { id_token: issueIdToken(entry.uid, { auth_time: entry.authTime }), refresh_token: next, expires_in: '3600' });
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
    // 券の発行（POST /v1/tickets/challenge・POST /v1/tickets）。前の版の api には無い
    if ((url.pathname === '/v1/tickets/challenge' || url.pathname === '/v1/tickets') && req.method === 'POST' && !oldApi()) {
      const uid = uidOf(req);
      if (!uid) return err(res, 401, 'unauthenticated', 'no token');
      if (accountOf(uid).status !== 'plus') return err(res, 403, 'not_plus', 'not plus');
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return err(res, 400, 'bad_request', 'body'); }
      if (url.pathname === '/v1/tickets/challenge') {
        if (!['host', 'device', 'sync'].includes(body.purpose)) return err(res, 400, 'bad_request', 'purpose');
        const pub = b64urlToBuf(body.publicKey);
        if (pub.length !== 32 || typeof body.hostId !== 'string') return err(res, 400, 'bad_request', 'publicKey');
        if (body.purpose !== 'device' && body.hostId !== hostIdFor(pub)) return err(res, 422, 'bad_proof', 'bad proof');
        const recent = (ticketRate.get(uid) ?? []).filter(at => Date.now() - at < 60_000);
        if (recent.length >= 60) return err(res, 429, 'rate_limited', 'rate limited');
        ticketRate.set(uid, [...recent, Date.now()]);
        if (body.purpose !== 'device' && state.hostsRemoved[body.hostId]) return err(res, 403, 'host_removed', 'host removed');
        return json(res, 200, newChallenge({ publicKey: pub, hostId: body.hostId, uid, purpose: body.purpose }));
      }
      const ch = challenges.get(body.challengeId);
      challenges.delete(body.challengeId);
      if (!ch || ch.uid !== uid || Date.now() >= ch.expiresAt || !proofOk(ch, ch.publicKey, ch.hostId, ch.purpose, body.proof)) return err(res, 422, 'bad_proof', 'bad proof');
      if (state.hostsRemoved[ch.hostId]) return ch.purpose === 'device' ? err(res, 404, 'not_found', 'not found') : err(res, 403, 'host_removed', 'host removed');
      const host = state.hosts[ch.hostId];
      if (!host || host.uid !== uid) return err(res, 404, 'not_found', 'not found');
      if (ch.purpose !== 'device' && !b64urlToBuf(host.publicKey).equals(ch.publicKey)) return err(res, 422, 'bad_proof', 'bad proof');
      if (state.state !== 'on') return err(res, 503, 'unavailable', 'unavailable');
      if (ch.purpose === 'sync' && accountOf(uid).sync?.enabled === false) return err(res, 403, 'forbidden', 'sync_disabled');
      const expiresAt = new Date((nowSec() + 300) * 1000).toISOString();
      if (ch.purpose === 'sync') {
        const ticket = signTicket({ aud: 'sync', uid, hostId: ch.hostId });
        state.tickets.push({ purpose: 'sync', hostId: ch.hostId, uid });
        return json(res, 200, { sync: ticket, expiresAt });
      }
      const lim = { hosts: accountOf(uid).limits?.hosts ?? 3, devicesPerHost: accountOf(uid).limits?.devicesPerHost ?? 5 };
      const sub = hostIdFor(ch.publicKey);
      state.tickets.push({ purpose: ch.purpose, hostId: ch.hostId, uid });
      const relay = signTicket({ aud: 'relay', uid, role: ch.purpose, sub, hostId: ch.hostId, lim });
      if (ch.purpose === 'host') return json(res, 200, { relay, expiresAt });
      return json(res, 200, { relay, admission: signTicket({ aud: 'pleiad-host', uid, hostId: ch.hostId, devicePub: b64url(ch.publicKey) }), expiresAt });
    }
    // ホストの登録（GET /v1/hosts・POST /v1/hosts/challenge・PUT/PATCH/DELETE /v1/hosts/{hostId}。Plus の利用者だけ）
    if (url.pathname === '/v1/hosts' || url.pathname.startsWith('/v1/hosts/')) {
      const uid = uidOf(req);
      if (!uid) return json(res, 401, { error: { code: 'unauthenticated', message: 'no token' } });
      if (accountOf(uid).status !== 'plus') return json(res, 403, { error: { code: 'not_plus', message: 'not plus' } });
      const hostPath = /^\/v1\/hosts\/([a-z2-7]{26})$/.exec(url.pathname)?.[1] ?? null;
      const publicHost = h => h && ({ hostId: h.hostId, publicKey: h.publicKey, name: h.name, platform: h.platform, online: h.online, lastSeenAt: h.lastSeenAt, syncPublicKey: h.syncPublicKey, createdAt: h.createdAt, deviceCount: h.deviceCount, appVersion: h.appVersion ?? null });
      const marked = !oldApi() && req.headers['x-pleiad-admission'] === '2';

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
        return json(res, 200, newChallenge({ publicKey: pub, hostId: body.hostId, uid, purpose: 'register' }));
      }
      if (hostPath && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!oldApi() && !marked && state.admissionRequired) return err(res, 426, 'update_required', 'update required', { feature: 'admission_v2' });
        if (marked && body.syncPublicKey !== undefined) return err(res, 400, 'bad_request', 'syncPublicKey');
        const ch = challenges.get(body.challengeId);
        challenges.delete(body.challengeId);
        const pub = b64urlToBuf(body.publicKey);
        const valid = ch && ch.uid === uid && ch.hostId === hostPath && ch.purpose === 'register' && Date.now() < ch.expiresAt && ch.publicKey.equals(pub);
        if (!valid || state.failNextProof || !proofOk(ch, pub, hostPath, 'register', body.proof)) {
          const bug = state.failNextProof && valid;
          state.failNextProof = false;
          return json(res, 422, { error: { code: 'bad_proof', message: bug ? 'bad proof (injected)' : 'bad proof' } });
        }
        // 墓標は消さない（どのアカウントからでも、フラグに関係なく断る）。前の版の api は登録し直すと戻した
        if (!oldApi() && state.hostsRemoved[hostPath]) return err(res, 403, 'host_removed', 'host removed');
        const existing = state.hosts[hostPath];
        if (existing && existing.uid !== uid) return json(res, 409, { error: { code: 'host_taken', message: 'host taken' } });
        const keepSyncKey = marked || (!oldApi() && !!state.sync[uid]?.resetPublicKey);
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
          syncPublicKey: existing && keepSyncKey ? (existing.syncPublicKey ?? null)
            : !marked && typeof body.syncPublicKey === 'string' ? body.syncPublicKey : (existing?.syncPublicKey ?? null),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          deviceCount: existing?.deviceCount ?? 0, uid,
          appVersion: typeof body.appVersion === 'string' && body.appVersion ? body.appVersion : (existing?.appVersion ?? null),
        };
        if (state.noTickets && !state.legacySync) {
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
        if (body.syncPublicKey !== undefined) {
          if (marked) return err(res, 400, 'bad_request', 'syncPublicKey');
          if (!oldApi() && (state.admissionRequired || state.sync[uid]?.resetPublicKey)) return err(res, 426, 'update_required', 'update required', { feature: 'admission_v2' });
        }
        if (typeof body.name === 'string' && body.name.length >= 1 && body.name.length <= 64) existing.name = body.name;
        if (typeof body.syncPublicKey === 'string' || body.syncPublicKey === null) existing.syncPublicKey = body.syncPublicKey;
        if (Number.isInteger(body.deviceCount) && body.deviceCount >= 0 && body.deviceCount <= 64) existing.deviceCount = body.deviceCount;
        if (typeof body.platform === 'string' && ['win32', 'darwin', 'linux'].includes(body.platform)) existing.platform = body.platform;
        return json(res, 200, { host: publicHost(existing) });
      }
      if (hostPath && req.method === 'DELETE') {
        if (!oldApi() && !recentLogin(req)) return err(res, 403, 'reauth_required', 'reauth required', { maxAgeSeconds: REAUTH_SECONDS });
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
  /** 鍵を持つ PC（今の keyId の行があり、外されておらず、台帳に居る） */
  const isHolder = (uid, s, hostId) => liveKey(s.keys[hostId], s.keyId) && state.hosts[hostId]?.uid === uid;

  // ホストを外す（利用者の DELETE と同じ処理。by: 'admin' は運営が外したとき）。前の版の api は鍵の行も消した
  function unbindHost(hostId, by = 'admin') {
    const existing = state.hosts[hostId];
    if (!existing) return;
    const uid = existing.uid;
    const s = state.sync[uid];
    const wasHolder = !!s && liveKey(s.keys[hostId], s.keyId);
    delete state.hosts[hostId];
    const k = s?.keys[hostId];
    if (state.legacySync) { if (k) delete s.keys[hostId]; return; }
    if (k) { k.detachedAt = new Date().toISOString(); k.name = existing.name ?? null; }
    state.hostsRemoved[hostId] = { uid, hostId, by, at: new Date().toISOString() };
    if (s && !state.noTickets) {
      if (wasHolder && s.resetPublicKey) s.rotate = { removedHostId: hostId, at: new Date().toISOString() };
      if (s.joins) {
        delete s.joins[hostId];
        for (const j of Object.values(s.joins)) {
          if (j.approverHostId === hostId && (j.state === 'challenged' || j.state === 'revealed')) backToCommitted(j);
        }
      }
      if (Array.isArray(s.carry)) s.carry = s.carry.filter(id => id !== hostId);
      if (s.recovery?.requestedBy === hostId) s.recovery = null;
    }
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

  /** 申し込みの応答の形（uid を除く） */
  const publicJoin = j => j && ({ hostId: j.hostId, state: j.state, commit: j.commit, nonceH: j.nonceH ?? null, approverHostId: j.approverHostId ?? null,
    nonceN: j.nonceN ?? null, syncPublicKey: j.syncPublicKey ?? null, createdAt: j.createdAt ?? null, updatedAt: j.updatedAt ?? null, deniedAt: j.deniedAt ?? null });
  /** 承認の途中の申し込みを、最初（committed）に戻す */
  const backToCommitted = j => Object.assign(j, { state: 'committed', nonceH: null, approverHostId: null, nonceN: null, syncPublicKey: null, updatedAt: new Date().toISOString() });

  const recoveryOf = s => (s.recovery ? { ...s.recovery, requestedByName: state.hosts[s.recovery.requestedBy]?.name ?? null } : null);

  /** 券のある要求の state（§5.2 の欄を足し、pending は空） */
  function syncStateV2(uid, self) {
    const s = syncOf(uid);
    const holder = isHolder(uid, s, self);
    const joins = holder ? Object.values(s.joins ?? {}).filter(j => j.hostId !== self
      && (j.state === 'committed' || (j.state === 'revealed' && j.approverHostId === self))).length : 0;
    return {
      ...syncState(uid),
      pending: [],
      self: { hostId: self, holder },
      signedReset: !!s.resetPublicKey,
      rotate: !!s.rotate,
      join: publicJoin(s.joins?.[self] ?? null),
      joins,
      recovery: recoveryOf(s),
    };
  }

  /** K の署名（reset・回復の取り消し）を、今の resetPublicKey で確かめる */
  const resetSigOk = (s, msg, signature) => {
    try {
      const sig = b64urlToBuf(signature);
      return !!s.resetPublicKey && sig.length === 64 && crypto.verify(null, Buffer.from(msg, 'utf8'), edPublic(b64urlToBuf(s.resetPublicKey)), sig);
    } catch { return false; }
  };

  /** 新しい K を置く（始め直し・回復の仕上げ。項目と包みを消す） */
  function placeKey(uid, s, body, host, carry) {
    const now = new Date().toISOString();
    s.keyId = body.keyId;
    s.resetPublicKey = body.resetPublicKey;
    s.items = {};
    s.totalBytes = 0;
    s.lastWriteAt = null;
    s.lastWriterHostId = null;
    s.resetAt = now;
    s.resetBy = body.hostId;
    s.resetByName = host.name ?? null;
    s.keys = { [body.hostId]: { keyId: body.keyId, wrapped: body.wrapped, wrappedBy: body.hostId, lastSyncAt: now } };
    s.rotate = null;
    s.recovery = null;
    s.carry = carry;
    if (typeof body.syncPublicKey === 'string') host.syncPublicKey = body.syncPublicKey;
    for (const j of Object.values(s.joins ?? {})) {
      if ((j.state === 'challenged' || j.state === 'revealed') && j.approverHostId !== body.hostId) backToCommitted(j);
    }
  }

  async function syncRoute(req, res, url) {
    const uid = uidOf(req);
    if (!uid) return err(res, 401, 'unauthenticated', 'no token');
    if (accountOf(uid).status !== 'plus') return err(res, 403, 'not_plus', 'not plus');
    const itemPath = /^\/v1\/sync\/items\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
    const raw = req.method === 'GET' ? '' : await readBody(req);
    if (Buffer.byteLength(raw) > (itemPath ? 3_000_000 : 100_000)) return err(res, 413, 'too_large', 'too large');
    state.syncBodies.push({ method: req.method, path: url.pathname + url.search, body: raw });
    const failHost = f => !f.hostId || verifySyncTicket(req.headers['x-pleiad-sync-ticket'], uid)?.hostId === f.hostId;
    const fail = state.syncFail.find(f => (!f.method || f.method === req.method) && f.path.test(url.pathname) && failHost(f) && (f.count ?? 1) > 0);
    if (fail) {
      fail.count = (fail.count ?? 1) - 1;
      return err(res, fail.status, fail.code, fail.message ?? fail.code, fail.extra ?? {}, fail.headers ?? {});
    }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return err(res, 400, 'bad_request', 'body'); }
    if (oldApi()) return oldSyncRoute(req, res, url, uid, body, itemPath);
    const s = syncOf(uid);
    const ticket = req.headers['x-pleiad-sync-ticket'];
    // 券の要らない口（回復の読みと、K の署名での取り消し）
    if (url.pathname === '/v1/sync/recovery' && req.method === 'GET') return json(res, 200, { keyId: s.keyId, signedReset: !!s.resetPublicKey, recovery: recoveryOf(s) });
    if (url.pathname === '/v1/sync/recovery' && req.method === 'DELETE' && !ticket) {
      if (typeof body.keyId !== 'string' || !KEY_ID_RX.test(body.keyId)) return err(res, 400, 'bad_request', 'keyId');
      if (typeof body.signature !== 'string') return err(res, 400, 'bad_request', 'signature');
      if (!s.recovery) return err(res, 404, 'not_found', 'recovery not found');
      if (body.keyId !== s.keyId) return err(res, 409, 'conflict', 'keyId');
      const msg = `pleiad sync recovery cancel v1\n${uid}\n${s.keyId}\n${s.recovery.requestedAt}`;
      if (!resetSigOk(s, msg, body.signature)) return err(res, 422, 'bad_proof', 'bad proof');
      s.recovery = null;
      res.writeHead(204); return res.end();
    }
    if (!ticket) {
      // 印があれば、または券が要る口（申し込み・回復）なら、古い道に落とさない
      if (req.headers['x-pleiad-admission'] === '2' || /^\/v1\/sync\/(join|joins|recovery)(\/|$)/.test(url.pathname)) return err(res, 403, 'ticket_invalid', 'ticket');
      if (s.resetPublicKey || state.admissionRequired) return err(res, 426, 'update_required', 'update required', { feature: 'admission_v2' });
      return oldSyncRoute(req, res, url, uid, body, itemPath);
    }
    const t = verifySyncTicket(ticket, uid);
    if (!t) return err(res, 403, 'ticket_invalid', 'ticket');
    if (state.hostsRemoved[t.hostId]) return err(res, 403, 'host_removed', 'host removed');
    if (state.hosts[t.hostId]?.uid !== uid) return err(res, 403, 'host_removed', 'host removed');
    return v2SyncRoute(req, res, url, uid, body, itemPath, s, t.hostId);
  }

  // 券のある要求（受け入れの規則）。self は券の PC
  async function v2SyncRoute(req, res, url, uid, body, itemPath, s, self) {
    const host = state.hosts[self];
    const queryHost = url.searchParams.get('hostId');
    if ((queryHost && queryHost !== self) || (typeof body?.hostId === 'string' && body.hostId !== self)) return err(res, 403, 'forbidden', 'host');
    const holder = isHolder(uid, s, self);
    const done = () => { res.writeHead(204); res.end(); };
    s.joins ??= {};

    if (url.pathname === '/v1/sync/state' && req.method === 'GET') {
      touchLastSync(s, self);
      return json(res, 200, syncStateV2(uid, self));
    }
    if (url.pathname === '/v1/sync/join' && req.method === 'DELETE') {
      if (s.joins[self] && s.joins[self].state !== 'granted') delete s.joins[self];
      return done();
    }
    if (accountOf(uid).sync?.enabled === false) return err(res, 403, 'forbidden', 'sync_disabled');

    const keyPath = /^\/v1\/sync\/keys\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
    if (keyPath && req.method === 'GET') {
      if (keyPath !== self) return err(res, 403, 'forbidden', 'host');
      const k = s.keys[keyPath];
      if (!k || !s.keyId || k.keyId !== s.keyId) return err(res, 404, 'not_found', 'not found');
      touchLastSync(s, keyPath);
      return json(res, 200, { keyId: k.keyId, wrapped: k.wrapped, wrappedBy: k.wrappedBy });
    }
    if (keyPath && req.method === 'PUT') {
      if (typeof body.keyId !== 'string') return err(res, 400, 'bad_request', 'keyId');
      if (typeof body.wrappedBy !== 'string') return err(res, 400, 'bad_request', 'wrappedBy');
      if (!isWrapped(body.wrapped)) return err(res, 400, 'bad_request', 'wrapped');
      if (body.wrappedBy !== self) return err(res, 403, 'forbidden', 'host');
      if (!holder) return err(res, 403, 'not_holder', 'not holder');
      const target = state.hosts[keyPath]?.uid === uid ? state.hosts[keyPath] : null;
      if (!target) return err(res, 403, 'forbidden', 'host');
      if (!s.keyId || body.keyId !== s.keyId) return err(res, 409, 'conflict', 'keyId');
      const join = s.joins[keyPath];
      if (join?.state === 'revealed' && join.approverHostId === self) {
        join.state = 'granted';
        join.updatedAt = new Date().toISOString();
      } else if ((s.carry ?? []).includes(keyPath)) {
        s.carry = s.carry.filter(id => id !== keyPath);
      } else {
        return err(res, 403, 'forbidden', 'approval');
      }
      s.keys[keyPath] = { keyId: body.keyId, wrapped: body.wrapped, wrappedBy: self };
      return done();
    }
    const keyBodyOk = () => {
      if (typeof body.keyId !== 'string' || !KEY_ID_RX.test(body.keyId)) return 'keyId';
      if (typeof body.hostId !== 'string') return 'hostId';
      if (!isWrapped(body.wrapped)) return 'wrapped';
      if (typeof body.resetPublicKey !== 'string' || !B64U32_RX.test(body.resetPublicKey)) return 'resetPublicKey';
      if (body.syncPublicKey !== undefined && (typeof body.syncPublicKey !== 'string' || !B64U32_RX.test(body.syncPublicKey))) return 'syncPublicKey';
      return null;
    };
    if (url.pathname === '/v1/sync/reset' && req.method === 'POST') {
      const bad = keyBodyOk();
      if (bad) return err(res, 400, 'bad_request', bad);
      if (body.previousKeyId !== null && typeof body.previousKeyId !== 'string') return err(res, 400, 'bad_request', 'previousKeyId');
      if ((s.keyId ?? null) !== body.previousKeyId) return err(res, 409, 'conflict', 'previousKeyId');
      let carry = [];
      if (!s.keyId) {
        if (typeof body.syncPublicKey !== 'string') return err(res, 400, 'bad_request', 'syncPublicKey');
      } else if (s.resetPublicKey) {
        const msg = `pleiad sync reset v1\n${uid}\n${body.previousKeyId ?? '-'}\n${body.keyId}\n${body.hostId}\n${body.resetPublicKey}`;
        if (!resetSigOk(s, msg, body.signature)) return err(res, 422, 'bad_proof', 'bad proof');
        carry = Object.keys(s.keys).filter(id => id !== self && isHolder(uid, s, id));
      } else if (!holder) {
        return err(res, 403, 'not_holder', 'not holder');
      }
      if (typeof body.syncPublicKey !== 'string' && !host.syncPublicKey) return err(res, 400, 'bad_request', 'syncPublicKey');
      placeKey(uid, s, body, host, carry);
      return json(res, 200, syncStateV2(uid, self));
    }
    if (url.pathname === '/v1/sync/items' && req.method === 'GET') {
      if (!holder) return err(res, 403, 'not_holder', 'not holder');
      return listItems(res, url, s);
    }
    if (itemPath && req.method === 'PUT') {
      if (!holder) return err(res, 403, 'not_holder', 'not holder');
      return putItem(res, uid, body, itemPath, s);
    }
    // 鍵の受け渡し（commit–reveal）
    const now = new Date().toISOString();
    if (url.pathname === '/v1/sync/join' && req.method === 'POST') {
      if (typeof body.commit !== 'string' || !B64U32_RX.test(body.commit)) return err(res, 400, 'bad_request', 'commit');
      if (!s.keyId) return err(res, 409, 'conflict', 'no_key');
      if (holder) return err(res, 409, 'conflict', 'holder');
      const j = s.joins[self];
      if (j?.state === 'denied' && Date.now() - Date.parse(j.deniedAt) < HOUR) return err(res, 429, 'rate_limited', 'denied');
      if (j && j.state === 'committed' && j.commit === body.commit) return json(res, 200, { join: publicJoin(j) });
      if (j && j.state !== 'denied' && j.state !== 'granted') return err(res, 409, 'conflict', 'join');
      s.joins[self] = { uid, hostId: self, state: 'committed', commit: body.commit, nonceH: null, approverHostId: null, nonceN: null, syncPublicKey: null,
        createdAt: now, updatedAt: now, deniedAt: null };
      return json(res, 200, { join: publicJoin(s.joins[self]) });
    }
    if (url.pathname === '/v1/sync/join' && req.method === 'GET') {
      const j = s.joins[self];
      if (!j) return json(res, 200, { join: null });
      const a = j.approverHostId ? state.hosts[j.approverHostId] : null;
      return json(res, 200, { join: { ...publicJoin(j), approver: a ? { hostId: a.hostId, name: a.name, syncPublicKey: a.syncPublicKey ?? null } : null } });
    }
    if (url.pathname === '/v1/sync/join/reveal' && req.method === 'POST') {
      const j = s.joins[self];
      if (!j || j.state !== 'challenged') return err(res, 409, 'conflict', 'join');
      const nonceN = b64urlToBuf(body.nonceN);
      const pub = b64urlToBuf(body.syncPublicKey);
      if (nonceN.length !== 32 || pub.length !== 32) return err(res, 400, 'bad_request', 'nonceN');
      if (b64url(crypto.createHash('sha256').update(nonceN).update(pub).digest()) !== j.commit) return err(res, 422, 'bad_proof', 'bad proof');
      Object.assign(j, { state: 'revealed', nonceN: body.nonceN, syncPublicKey: body.syncPublicKey, updatedAt: now });
      host.syncPublicKey = body.syncPublicKey;
      return json(res, 200, { join: publicJoin(j) });
    }
    if (url.pathname === '/v1/sync/joins' && req.method === 'GET') {
      if (!holder) return err(res, 403, 'not_holder', 'not holder');
      const joins = Object.values(s.joins).filter(j => j.hostId !== self)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(j => ({ ...publicJoin(j), name: state.hosts[j.hostId]?.name ?? null }));
      return json(res, 200, { joins });
    }
    const joinPath = /^\/v1\/sync\/joins\/([a-z2-7]{26})(\/challenge)?$/.exec(url.pathname);
    if (joinPath && ((req.method === 'POST' && joinPath[2]) || (req.method === 'DELETE' && !joinPath[2]))) {
      if (!holder) return err(res, 403, 'not_holder', 'not holder');
      const j = s.joins[joinPath[1]];
      if (req.method === 'POST' && (typeof body.nonceH !== 'string' || !B64U32_RX.test(body.nonceH))) return err(res, 400, 'bad_request', 'nonceH');
      if (!j) return err(res, 404, 'not_found', 'join not found');
      if (req.method === 'DELETE') {
        if (j.state === 'granted') return err(res, 409, 'conflict', 'join');
        Object.assign(j, { state: 'denied', deniedAt: now, nonceH: null, approverHostId: null, nonceN: null, syncPublicKey: null, updatedAt: now });
        return done();
      }
      if (j.state !== 'committed') return err(res, 409, 'conflict', 'join');
      Object.assign(j, { state: 'challenged', nonceH: body.nonceH, approverHostId: self, updatedAt: now });
      return json(res, 200, { join: publicJoin(j) });
    }
    // 回復（K を持つ PC が 1 台も無いとき）
    const anyHolder = () => Object.keys(s.keys).some(id => isHolder(uid, s, id));
    if (url.pathname === '/v1/sync/recovery' && req.method === 'POST') {
      if (!recentLogin(req)) return err(res, 403, 'reauth_required', 'reauth required', { maxAgeSeconds: REAUTH_SECONDS });
      if (!s.keyId) return err(res, 409, 'conflict', 'no_key');
      if (anyHolder()) return err(res, 409, 'conflict', 'holder');
      if (s.recovery && s.recovery.requestedBy !== self) return err(res, 409, 'conflict', 'recovery');
      s.recovery ??= { requestedBy: self, requestedAt: now, readyAt: new Date(Date.now() + state.recoveryWaitMs).toISOString() };
      return json(res, 200, { recovery: recoveryOf(s) });
    }
    if (url.pathname === '/v1/sync/recovery' && req.method === 'DELETE') {
      if (!s.recovery) return err(res, 404, 'not_found', 'recovery not found');
      if (s.recovery.requestedBy !== self) return err(res, 403, 'forbidden', 'host');
      s.recovery = null;
      return done();
    }
    if (url.pathname === '/v1/sync/recovery/complete' && req.method === 'POST') {
      const bad = keyBodyOk() ?? (typeof body.syncPublicKey !== 'string' ? 'syncPublicKey' : null);
      if (bad) return err(res, 400, 'bad_request', bad);
      if (!s.recovery) return err(res, 404, 'not_found', 'recovery not found');
      if (s.recovery.requestedBy !== self) return err(res, 403, 'forbidden', 'host');
      if (Date.now() < Date.parse(s.recovery.readyAt)) return err(res, 409, 'conflict', 'recovery_waiting', { readyAt: s.recovery.readyAt });
      if (anyHolder()) { s.recovery = null; return err(res, 409, 'conflict', 'holder'); }
      placeKey(uid, s, body, host, []);
      return json(res, 200, syncStateV2(uid, self));
    }
    return err(res, 404, 'not_found', 'not found');
  }

  function listItems(res, url, s) {
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
    if (!Number.isInteger(since) || since < 0) return err(res, 400, 'bad_request', 'since');
    const all = Object.entries(s.items).filter(([, it]) => it.seq > since).sort((a, b) => a[1].seq - b[1].seq);
    const page = all.slice(0, limit).map(([itemId, it]) => ({ itemId, rev: it.rev, seq: it.seq, keyId: it.keyId, ciphertext: it.ciphertext, deleted: it.deleted, updatedAt: it.updatedAt }));
    return json(res, 200, { items: page, cursor: page.length ? page.at(-1).seq : since, more: all.length > limit });
  }

  function putItem(res, uid, body, itemPath, s) {
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
    if (state.hosts[body.hostId]?.uid !== uid) return err(res, 403, 'forbidden', state.legacySync ? 'forbidden' : 'host');
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

  // 券の無い要求（前の版のクライアント・前の版の api）。自動の包みと reset_confirm の規則
  async function oldSyncRoute(req, res, url, uid, body, itemPath) {
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
    if (url.pathname === '/v1/sync/items' && req.method === 'GET') return listItems(res, url, s);
    if (itemPath && req.method === 'PUT') return putItem(res, uid, body, itemPath, s);
    return err(res, 404, 'not_found', 'not found');
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
    /** その uid の更新トークンを発行して返す（ログインの往復を経ずにセッションの保管を仕込むため）。authTime は元のログインの時刻（秒） */
    grantRefreshToken: (uid, { authTime = nowSec() } = {}) => { const token = `rt-${++seq}`; refreshTokens.set(token, { uid, authTime }); return token; },
    /** ホストを外す（by: 'admin' は運営の管理画面から外したとき。'user' は利用者の DELETE と同じ） */
    unbindHost,
    /** 券の署名の鍵を替える（生きている券が ticket_invalid になる） */
    rotateTicketKey,
    route,
    close: () => new Promise(r => { try { server.closeAllConnections?.(); } catch {} server.close(() => r()); }),
  };
}
