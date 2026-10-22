// Pleiad の中継サーバー（docs/remote.md §5、issue #12）。
//
// 端末とホストの WebSocket を照合してつなぎ、バイト列を右から左へ流すだけ。
// 中身は端末とホストの間の Noise で暗号化されていて、ここでは読めない（読もうともしない）。
// ディスクには何も書かない。照合の表はメモリだけで、ホストが制御用の接続のたびに sync で送り直す。
//
//   RELAY_ENROLL_SECRET=<32 字以上の乱数> node server.mjs
//
// 依存は ws だけ。1 ファイルで完結させる（Dockerfile はこのファイルだけを入れる）。
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

/** 中継が閉じるときの close code。端末は 4401 と 4404 で案内を分ける（§7.4）。 */
export const CLOSE = Object.freeze({
  BAD_REQUEST: 4400,   // ヘッダーや制御メッセージの形が違う
  UNAUTHORIZED: 4401,  // 登録用の秘密・トークン・入場券が合わない、取り消された
  NOT_FOUND: 4404,     // ホストが居ない（制御用の接続が無い・sync 前）、accept の conn が無い
  TIMEOUT: 4408,       // 認証は通ったが accept が来ない・差し込みの判定を待つ間の時間切れ（§5.7）
  REPLACED: 4409,      // 同じ hostId の新しい制御用の接続に置き換わった
  OVERFLOW: 4413,      // 相手側に溜まる量が上限を超えた
  LIMIT: 4429,         // 数の上限・ペアリングの試行の上限
  SHUTDOWN: 1001,      // 中継の終了
  TRY_AGAIN: 1013,     // 差し込みの判定が例外・時間切れ・形が違う（§5.7。端末は少し待って張り直す）
});

export const DEFAULTS = Object.freeze({
  port: 8080,
  enrollSecret: '',
  trustProxy: true,
  maxHosts: 8,
  maxDevices: 16,
  maxConnsPerHost: 32,
  maxConnsPerDevice: 4,
  maxFrameBytes: 66000,
  maxBufferBytes: 8 * 1024 * 1024,
  pairingTtlMs: 5 * 60 * 1000,
  logLevel: 'info',
  // 以下は環境変数では変えない（§5.3 の決まり）。試験で短くするためだけに開けてある
  acceptTimeoutMs: 10_000,
  pingIntervalMs: 30_000,
  failureLimit: 10,
  failureWindowMs: 60_000,
  failureBlockMs: 10 * 60_000,
  pairingAttempts: 5,
  pairingWindowMs: 60_000,
  // 認可の差し込み（§5.7）: 判定を待つ上限と、admit の頻度
  authzTimeoutMs: 5_000,
  admitPerMinute: 10,
  // 通知の線（docs/remote.md §5.6）。通知の暗号文は読めないので、大きさと数と寿命だけで抑える
  notifyMaxBlobChars: 2048,
  notifyQueueMax: 16,
  notifyMaxTtlMs: 15 * 60_000,
  notifyDefaultTtlMs: 5 * 60_000,
  notifyPingIntervalMs: 300_000,
  notifyPerMinute: 120,
});

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const HOST_ID = /^[a-z2-7]{26}$/;           // base32(SHA-256(公開鍵)) の先頭 26 字（小文字に揃える）
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET32 = /^[A-Za-z0-9_-]{43}$/;     // 256bit の base64url（パディングなし）
const HASH_HEX = /^[0-9a-f]{64}$/;
const BLOB = /^[A-Za-z0-9_-]+$/;            // 通知の暗号文（base64url）
const MAX_FAILURE_ENTRIES = 10_000;
// 差し込み（§5.7）の判定を待つ間に溜める上限。時間は判定の待ち（authzTimeoutMs）より長い
const AUTHZ_BUFFER_BYTES = 64 * 1024;
const AUTHZ_BUFFER_MS = 10_000;
const DENY_CODES = new Set([CLOSE.BAD_REQUEST, CLOSE.UNAUTHORIZED, CLOSE.NOT_FOUND, CLOSE.LIMIT]);
const DENY_REASON = /^[a-z ]{1,32}$/;

/** 環境変数から設定を組む。おかしな値なら投げる（起動しない）。 */
export function configFromEnv(env = process.env) {
  const int = (name, fallback) => {
    const raw = env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} は正の整数: ${raw}`);
    return n;
  };
  const level = env.RELAY_LOG || DEFAULTS.logLevel;
  if (!(level in LEVELS)) throw new Error(`RELAY_LOG は ${Object.keys(LEVELS).join(' / ')}: ${level}`);
  return {
    port: int('PORT', DEFAULTS.port),
    enrollSecret: env.RELAY_ENROLL_SECRET || '',
    trustProxy: (env.RELAY_TRUST_PROXY ?? '1') !== '0',
    maxHosts: int('RELAY_MAX_HOSTS', DEFAULTS.maxHosts),
    maxDevices: int('RELAY_MAX_DEVICES', DEFAULTS.maxDevices),
    maxConnsPerHost: int('RELAY_MAX_CONNS_PER_HOST', DEFAULTS.maxConnsPerHost),
    maxConnsPerDevice: int('RELAY_MAX_CONNS_PER_DEVICE', DEFAULTS.maxConnsPerDevice),
    maxFrameBytes: int('RELAY_MAX_FRAME_BYTES', DEFAULTS.maxFrameBytes),
    maxBufferBytes: int('RELAY_MAX_BUFFER_BYTES', DEFAULTS.maxBufferBytes),
    pairingTtlMs: int('RELAY_PAIRING_TTL_MS', DEFAULTS.pairingTtlMs),
    logLevel: level,
  };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

/** 256bit の秘密（base64url 43 字）を生のバイトに。形が違えば null。 */
function secret32(value) {
  if (typeof value !== 'string' || !SECRET32.test(value)) return null;
  const raw = Buffer.from(value, 'base64url');
  return raw.length === 32 ? raw : null;
}

function bearer(header) {
  const m = /^Bearer ([\x21-\x7e]+)$/.exec(typeof header === 'string' ? header : '');
  return m ? m[1] : null;
}

function hostIdOf(header) {
  if (typeof header !== 'string') return null;
  const id = header.toLowerCase();
  return HOST_ID.test(id) ? id : null;
}

function hashOf(value) {
  return typeof value === 'string' && HASH_HEX.test(value) ? Buffer.from(value, 'hex') : null;
}

/** 相手の close code を反対側へ渡す。送れない番号（1005・1006 など）は 1001 にする。 */
function passCode(code) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1001;
}

function closeWs(ws, code, reason = '') {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  try { ws.close(code, reason); } catch { ws.terminate(); return; }
  // 相手が読まない（背圧で詰まった）と close の往復が終わらない。長く待たずに落とす
  setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }, 1000).unref();
}

function rejectUpgrade(socket, status) {
  try {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* 既に切れている */ }
  socket.destroy();
}

/**
 * 中継を作る。listen するまでは待ち受けない。
 * opts は DEFAULTS と同じ名前。opts.logger を渡すとログをそこへ出す（試験用）。
 */
export function createRelay(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (typeof o.enrollSecret !== 'string' || o.enrollSecret.length < 32) {
    throw new Error('RELAY_ENROLL_SECRET が無いか短い（32 字以上の乱数を指定する）');
  }
  // 空白・改行の混じった秘密は、ホストが送る値と食い違って拒否が続くだけになるので、起動で止める（末尾の改行に気づけるように）
  if (/\s/.test(o.enrollSecret)) throw new Error('RELAY_ENROLL_SECRET に空白か改行が含まれている（末尾の改行を確かめる）');
  const secretHash = sha256(Buffer.from(o.enrollSecret, 'utf8'));
  const minLevel = LEVELS[o.logLevel] ?? LEVELS.info;
  const logger = o.logger ?? ((line) => process.stdout.write(JSON.stringify(line) + '\n'));
  const log = (level, event, fields = {}) => {
    if (LEVELS[level] < minLevel) return;
    logger({ t: new Date().toISOString(), level, event, ...fields });
  };
  const short = (hostId) => hostId?.slice(0, 8);
  // 認可の差し込み（§5.7）。無ければ今までどおりの照合だけを行う
  const authz = o.authz || null;

  /** 差し込みへ出来事を知らせる。待たない。例外はログに残すだけ。 */
  function emit(e) {
    if (typeof authz?.event !== 'function') return;
    try { authz.event(e); } catch (err) { log('warn', 'authz-event', { error: String(err?.message ?? err) }); }
  }

  /** 判定の tags: 文字列・1 つ 64 字まで・16 個まで。外れたものは捨てる。 */
  function cleanTags(tags) {
    const out = [];
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (typeof t === 'string' && t.length <= 64 && !out.includes(t)) out.push(t);
        if (out.length >= 16) break;
      }
    }
    return out;
  }

  /** hostId → 制御用の接続と照合の表。制御用の接続がある間だけ居る。 */
  const hosts = new Map();
  /** conn → 端末 1 本（accept 待ち・つながり中）。 */
  const conns = new Map();
  /** hostId → その hostId の端末の接続。制御用の接続の張り直しをまたいで数える。 */
  const hostConns = new Map();
  /** IP → 認証の失敗の記録。 */
  const failures = new Map();
  /** hostId → deviceId → 通知の線（端末が張る軽い線。docs/remote.md §5.6）。制御用の接続の張り直しをまたいで残す。 */
  const notifyLines = new Map();
  /** hostId → deviceId → 溜めた通知 [{ i, blob, expiresAt }]。暗号文のまま持つだけで、ディスクには書かない。 */
  const notifyQueues = new Map();
  let notifySeq = 0;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: o.maxFrameBytes,  // 超えたら ws が 1009 で切る
    perMessageDeflate: false,     // 暗号文は縮まない。展開の爆弾も避ける
  });

  const server = http.createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : 'ok');
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.on('upgrade', onUpgrade);
  server.on('clientError', (_err, socket) => socket.destroy());

  // 30 秒ごとに ping。2 回続けて pong が返らない接続を捨てる（§4.4・§5.3）。通知の線は電池のために間隔を長くする（§5.6）
  const pingAll = (wanted) => {
    for (const ws of wss.clients) {
      if (Boolean(ws.notifyLine) !== wanted) continue;
      if (ws.missedPongs >= 2) { ws.terminate(); continue; }
      ws.missedPongs = (ws.missedPongs ?? 0) + 1;
      try { ws.ping(); } catch { /* 閉じかけ */ }
    }
  };
  const pinger = setInterval(() => pingAll(false), o.pingIntervalMs);
  pinger.unref();
  const notifyPinger = setInterval(() => { pingAll(true); sweepNotify(); }, o.notifyPingIntervalMs);
  notifyPinger.unref();

  // ── 認証の失敗と遮断 ──────────────────────────────────────────

  function clientIp(req) {
    if (o.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? '?';
  }

  function blocked(ip) {
    const e = failures.get(ip);
    return Boolean(e && e.blockedUntil > Date.now());
  }

  function recordFailure(ip) {
    const now = Date.now();
    if (!failures.has(ip) && failures.size >= MAX_FAILURE_ENTRIES) {
      for (const [k, e] of failures) {
        if (e.blockedUntil <= now && e.times.every((t) => now - t > o.failureWindowMs)) failures.delete(k);
      }
      // それでも溢れるなら古い順に捨てる（遮断中を捨てることがあっても、表が際限なく育つよりよい）
      while (failures.size >= MAX_FAILURE_ENTRIES) failures.delete(failures.keys().next().value);
    }
    const e = failures.get(ip) ?? { times: [], blockedUntil: 0 };
    e.times = e.times.filter((t) => now - t < o.failureWindowMs);
    e.times.push(now);
    if (e.times.length >= o.failureLimit) {
      e.blockedUntil = now + o.failureBlockMs;
      e.times = [];
      log('warn', 'blocked', { minutes: Math.round(o.failureBlockMs / 60000) });
    }
    failures.set(ip, e);
  }

  function fail(ws, code, reason) {
    recordFailure(ws.ip);
    log('info', 'auth-failed', { path: ws.route, reason });
    closeWs(ws, code, reason);
  }

  // ── 入口 ────────────────────────────────────────────────────

  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const ip = clientIp(req);
    if (blocked(ip)) return rejectUpgrade(socket, 429);
    let url;
    try { url = new URL(req.url, 'http://relay'); } catch { return rejectUpgrade(socket, 400); }
    const route = url.pathname;
    if (route !== '/v1/host' && route !== '/v1/host/accept' && route !== '/v1/device' && route !== '/v1/device/notify') {
      return rejectUpgrade(socket, 404);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = ip;
      ws.route = route;
      ws.missedPongs = 0;
      ws.on('pong', () => { ws.missedPongs = 0; });
      ws.on('error', () => {});   // 1009 などは close で扱う
      const decide = (route === '/v1/host' || route === '/v1/host/accept') ? authz?.host
        : authz?.device;
      if (typeof decide === 'function') {
        authzGate(ws, req, url, decide).catch((err) => {
          log('error', 'authz-gate', { route, error: String(err?.message ?? err) });
          try { ws.terminate(); } catch { /* 閉じかけ */ }
        });
      } else {
        dispatch(ws, req, url, null);
      }
    });
  }

  function dispatch(ws, req, url, grant) {
    if (ws.route === '/v1/host') onControl(ws, req, grant);
    else if (ws.route === '/v1/host/accept') onAccept(ws, req, url, grant);
    else if (ws.route === '/v1/device/notify') onNotifyLine(ws, req, grant);
    else onDevice(ws, req, grant);
  }

  /**
   * 差し込みの判定を待つ（§5.7）。判定が出るまで届いたメッセージは溜め、
   * 通ったら経路ごとの処理へ着いた順に流す。溜めは 64KB・10 秒まで。
   */
  async function authzGate(ws, req, url, decide) {
    const route = ws.route;
    // hostId の形は差し込みを呼ぶ前に、今と同じ閉じ方で確かめる
    const hostId = hostIdOf(req.headers['x-pleiad-host']);
    if (!hostId) {
      if (route === '/v1/host' || route === '/v1/host/accept') return closeWs(ws, CLOSE.BAD_REQUEST, 'host id');
      return fail(ws, CLOSE.BAD_REQUEST, 'host id');
    }
    let gating = true;
    const pending = [];
    let pendingBytes = 0;
    const ungate = () => {
      if (!gating) return;
      gating = false;
      ws.off('message', onMsg);
      clearTimeout(bufTimer);
    };
    const onMsg = (data, isBinary) => {
      pendingBytes += data.length;
      if (pendingBytes > AUTHZ_BUFFER_BYTES) { ungate(); return closeWs(ws, CLOSE.OVERFLOW, 'buffer'); }
      pending.push([data, isBinary]);
    };
    ws.on('message', onMsg);
    const bufTimer = setTimeout(() => { ungate(); closeWs(ws, CLOSE.TIMEOUT, 'authz timeout'); }, AUTHZ_BUFFER_MS);
    bufTimer.unref();

    const secret = bearer(req.headers.authorization);
    const deviceHeader = req.headers['x-pleiad-device'];
    const ctx = {
      route,
      hostId,
      deviceId: typeof deviceHeader === 'string' ? deviceHeader : null,
      pairing: req.headers['x-pleiad-pairing'] !== undefined,
      enrollOk: Boolean(secret && sameHash(sha256(Buffer.from(secret, 'utf8')), secretHash)),
      headers: Object.freeze({ ...req.headers }),
      ip: ws.ip,
    };

    let verdict = null;
    let verdictTimer = null;
    try {
      verdict = await Promise.race([
        Promise.resolve().then(() => decide.call(authz, ctx)),
        new Promise((_, rej) => {
          verdictTimer = setTimeout(() => rej(new Error('authz timeout')), o.authzTimeoutMs);
          verdictTimer.unref();
        }),
      ]);
    } catch (err) {
      log('warn', 'authz-error', { route, error: String(err?.message ?? err) });
    } finally {
      clearTimeout(verdictTimer);
    }
    ungate();
    if (ws.readyState !== WebSocket.OPEN) return;

    if (!verdict || typeof verdict !== 'object' || typeof verdict.ok !== 'boolean') {
      if (verdict !== null) log('warn', 'authz-verdict', { route });
      return closeWs(ws, CLOSE.TRY_AGAIN, 'try again later');
    }
    if (!verdict.ok) {
      const code = DENY_CODES.has(verdict.code) ? verdict.code : CLOSE.UNAUTHORIZED;
      const reason = typeof verdict.reason === 'string' && DENY_REASON.test(verdict.reason) ? verdict.reason : 'denied';
      // 4401 の断りは今の失敗と同じく IP ごとの回数に数える。数えないのは、サーバー全体の停止中を表す
      // 'plus unavailable' と、差し込みが count: false を付けた断り（正しいクライアントでも起きる断り。
      // 数えると同じ IP のほかの接続まで止めてしまう）
      if (code === CLOSE.UNAUTHORIZED && reason !== 'plus unavailable' && verdict.count !== false) {
        return fail(ws, code, reason);
      }
      if (verdict.count === false) log('info', 'auth-denied', { path: route, reason });
      return closeWs(ws, code, reason);
    }
    dispatch(ws, req, url, { hostId, tags: cleanTags(verdict.tags), admit: verdict.admit === true, pending });
  }

  /** ホストの認証。通れば hostId、通らなければ閉じて null。 */
  function hostAuth(ws, req) {
    const secret = bearer(req.headers.authorization);
    if (!secret || !sameHash(sha256(Buffer.from(secret, 'utf8')), secretHash)) {
      fail(ws, CLOSE.UNAUTHORIZED, 'enroll secret');
      return null;
    }
    const hostId = hostIdOf(req.headers['x-pleiad-host']);
    if (!hostId) {
      closeWs(ws, CLOSE.BAD_REQUEST, 'host id');
      return null;
    }
    return hostId;
  }

  // ── ホストの制御用の接続 ──────────────────────────────────────

  function onControl(ws, req, grant = null) {
    const hostId = grant ? grant.hostId : hostAuth(ws, req);
    if (!hostId) return;
    const old = hosts.get(hostId);
    if (!old && hosts.size >= o.maxHosts) {
      log('warn', 'host-limit', { host: short(hostId) });
      return closeWs(ws, CLOSE.LIMIT, 'too many hosts');
    }
    const h = {
      id: hostId,
      ws,
      devices: new Map(),   // deviceId → SHA-256(トークン)
      synced: false,
      notifyTimes: [],      // 通知を受け取った時刻（1 分あたりの上限）
      pairing: null,        // { hash, expiresAt }
      pairTimes: old?.pairTimes ?? [],
      admitTimes: old?.admitTimes ?? [],   // admit の接続を受けた時刻（1 分あたりの上限。張り直しをまたぐ）
      tags: grant?.tags ?? [],  // 差し込みの判定が返した印（§5.7）
      openedAt: Date.now(),
    };
    ws.tags = h.tags;
    hosts.set(hostId, h);
    if (old) {
      closeWs(old.ws, CLOSE.REPLACED, 'replaced');
      closePending(hostId, CLOSE.NOT_FOUND, 'host reconnected');
    }
    log('info', 'host-open', { host: short(hostId), replaced: Boolean(old) });
    emit({ type: 'host-open', hostId, tags: h.tags });

    ws.on('message', (data, isBinary) => onControlMessage(h, data, isBinary));
    for (const [data, isBinary] of grant?.pending ?? []) onControlMessage(h, data, isBinary);
    ws.on('close', (code) => {
      log('info', 'host-close', { host: short(hostId), code, ms: Date.now() - h.openedAt });
      if (hosts.get(hostId) !== h) return;   // 置き換わった古い方
      hosts.delete(hostId);
      emit({ type: 'host-close', hostId, tags: h.tags });
      closePending(hostId, CLOSE.NOT_FOUND, 'host offline');
    });
  }

  function onControlMessage(h, data, isBinary) {
    if (hosts.get(h.id) !== h) return;
    let msg = null;
    if (!isBinary) { try { msg = JSON.parse(data.toString('utf8')); } catch { /* 下で閉じる */ } }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return closeWs(h.ws, CLOSE.BAD_REQUEST, 'control message');
    }
    switch (msg.type) {
      case 'sync': {
        if (!Array.isArray(msg.devices)) return closeWs(h.ws, CLOSE.BAD_REQUEST, 'sync');
        const next = new Map();
        for (const d of msg.devices) {
          const hash = hashOf(d?.tokenHash);
          if (!hash || typeof d.id !== 'string' || !DEVICE_ID.test(d.id)) return closeWs(h.ws, CLOSE.BAD_REQUEST, 'sync');
          if (!next.has(d.id) && next.size >= o.maxDevices) {
            log('warn', 'device-limit', { host: short(h.id), device: d.id });
            continue;
          }
          next.set(d.id, hash);
        }
        h.devices = next;
        h.synced = true;
        log('debug', 'sync', { host: short(h.id), devices: next.size });
        return cutRevoked(h);
      }
      case 'allow': {
        const hash = hashOf(msg.tokenHash);
        if (!hash || typeof msg.id !== 'string' || !DEVICE_ID.test(msg.id)) return closeWs(h.ws, CLOSE.BAD_REQUEST, 'allow');
        if (!h.devices.has(msg.id) && h.devices.size >= o.maxDevices) {
          return log('warn', 'device-limit', { host: short(h.id), device: msg.id });
        }
        h.devices.set(msg.id, hash);
        return cutRevoked(h);   // トークンを差し替えたら古いトークンの接続を切る
      }
      case 'revoke': {
        if (typeof msg.id !== 'string') return closeWs(h.ws, CLOSE.BAD_REQUEST, 'revoke');
        h.devices.delete(msg.id);
        log('info', 'revoke', { host: short(h.id), device: msg.id });
        return cutRevoked(h);
      }
      case 'notify':
        return onNotify(h, msg);
      case 'pairing': {
        if (msg.ticketHash == null) { h.pairing = null; return; }   // 取り下げ
        const hash = hashOf(msg.ticketHash);
        if (!hash) return closeWs(h.ws, CLOSE.BAD_REQUEST, 'pairing');
        const asked = Number(msg.ttlMs);
        const ttl = Number.isFinite(asked) && asked > 0 ? Math.min(asked, o.pairingTtlMs) : o.pairingTtlMs;
        h.pairing = { hash, expiresAt: Date.now() + ttl };   // 入場券は 1 枚だけ。新しいものが古いものを置き換える
        return;
      }
      default:
        return;   // 知らない種類は無視する（新しいホストと古い中継の組み合わせで切らない）
    }
  }

  /** 表から消えた・トークンが変わった端末の接続を切る。 */
  function cutRevoked(h) {
    for (const c of hostConns.get(h.id) ?? []) {
      // pairing・admit（受け入れの最中）は deviceId を持たないので対象外（受け入れの結果が届く前に切らない。§5.7）
      if (c.pairing || (c.admit && c.deviceId == null)) continue;
      const hash = h.devices.get(c.deviceId);
      if (!hash || !sameHash(hash, c.tokenHash)) endConn(c, CLOSE.UNAUTHORIZED, 'revoked');
    }
    for (const [deviceId, line] of notifyLines.get(h.id) ?? []) {
      const hash = h.devices.get(deviceId);
      if (!hash || !sameHash(hash, line.tokenHash)) closeWs(line.ws, CLOSE.UNAUTHORIZED, 'revoked');
    }
    const queues = notifyQueues.get(h.id);
    for (const deviceId of [...(queues?.keys() ?? [])]) if (!h.devices.has(deviceId)) queues.delete(deviceId);
    if (queues && !queues.size) notifyQueues.delete(h.id);
  }

  // ── 通知の線（docs/remote.md §5.6） ───────────────────────────────
  // ホストが端末ごとの鍵で暗号化した通知を、deviceId 宛てに流すだけ。中身（種類・会話名）は読めないし、読もうともしない。
  // 端末が切れている間は暗号文のまま短く溜め（寿命と件数に上限）、つながったら渡す。端末が受け取りの印（ack）を返すまで残し、
  // 線が半開きで落ちたときも次の線で送り直す（端末は通し番号で重複を捨てる）。

  function pruneQueue(queue, now = Date.now()) {
    while (queue.length && queue[0].expiresAt <= now) queue.shift();
    return queue;
  }

  function sweepNotify() {
    const now = Date.now();
    for (const [hostId, queues] of notifyQueues) {
      for (const [deviceId, queue] of queues) if (!pruneQueue(queue, now).length) queues.delete(deviceId);
      if (!queues.size) notifyQueues.delete(hostId);
    }
  }

  function sendLine(line, entry) {
    const ws = line.ws;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 64 * 1024) { ws.terminate(); return; }   // 読まない線に溜めない
    ws.send(JSON.stringify({ type: 'notify', i: entry.i, blob: entry.blob }));
  }

  function onNotify(h, msg) {
    const ok = typeof msg.deviceId === 'string' && DEVICE_ID.test(msg.deviceId)
      && typeof msg.blob === 'string' && msg.blob.length > 0 && msg.blob.length <= o.notifyMaxBlobChars && BLOB.test(msg.blob);
    if (!ok) return log('warn', 'notify-bad', { host: short(h.id) });   // 形が違っても制御用の接続は切らない
    const now = Date.now();
    h.notifyTimes = h.notifyTimes.filter((t) => now - t < 60_000);
    if (h.notifyTimes.length >= o.notifyPerMinute) return log('warn', 'notify-rate', { host: short(h.id) });
    h.notifyTimes.push(now);
    if (!h.devices.has(msg.deviceId)) return log('debug', 'notify-unknown-device', { host: short(h.id), device: msg.deviceId });
    const asked = Number(msg.ttlMs);
    const ttl = Number.isFinite(asked) && asked > 0 ? Math.min(asked, o.notifyMaxTtlMs) : o.notifyDefaultTtlMs;
    if (!notifyQueues.has(h.id)) notifyQueues.set(h.id, new Map());
    const queues = notifyQueues.get(h.id);
    if (!queues.has(msg.deviceId)) queues.set(msg.deviceId, []);
    const queue = pruneQueue(queues.get(msg.deviceId), now);
    const entry = { i: ++notifySeq, blob: msg.blob, expiresAt: now + ttl };
    queue.push(entry);
    while (queue.length > o.notifyQueueMax) queue.shift();
    const line = notifyLines.get(h.id)?.get(msg.deviceId);
    if (line) sendLine(line, entry);
    log('debug', 'notify', { host: short(h.id), device: msg.deviceId, bytes: msg.blob.length, online: Boolean(line) });
  }

  function onNotifyLine(ws, req, grant = null) {
    ws.notifyLine = true;
    const hostId = grant ? grant.hostId : hostIdOf(req.headers['x-pleiad-host']);
    if (!hostId) return fail(ws, CLOSE.BAD_REQUEST, 'host id');
    const h = hosts.get(hostId);
    if (!h || !h.synced) return closeWs(ws, CLOSE.NOT_FOUND, 'host offline');
    const deviceId = req.headers['x-pleiad-device'];
    const raw = secret32(bearer(req.headers.authorization));
    const hash = typeof deviceId === 'string' ? h.devices.get(deviceId) : undefined;
    if (!raw || !hash || !sameHash(sha256(raw), hash)) return fail(ws, CLOSE.UNAUTHORIZED, 'device token');
    if (!notifyLines.has(hostId)) notifyLines.set(hostId, new Map());
    const lines = notifyLines.get(hostId);
    const old = lines.get(deviceId);
    if (!old && lines.size >= o.maxDevices) return closeWs(ws, CLOSE.LIMIT, 'too many lines');
    if (old) closeWs(old.ws, CLOSE.REPLACED, 'replaced');
    const line = { ws, deviceId, tokenHash: hash, openedAt: Date.now(), tags: grant?.tags ?? [] };
    ws.tags = line.tags;
    lines.set(deviceId, line);
    const onLine = (data, isBinary) => {
      if (isBinary) return;
      let msg = null;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg?.type !== 'ack' || !Number.isSafeInteger(msg.i)) return;
      const queue = notifyQueues.get(hostId)?.get(deviceId);
      while (queue?.length && queue[0].i <= msg.i) queue.shift();
    };
    ws.on('message', onLine);
    for (const [data, isBinary] of grant?.pending ?? []) onLine(data, isBinary);
    ws.on('close', (code) => {
      log('info', 'notify-close', { host: short(hostId), device: deviceId, code, ms: Date.now() - line.openedAt });
      if (lines.get(deviceId) === line) lines.delete(deviceId);
      if (!lines.size && notifyLines.get(hostId) === lines) notifyLines.delete(hostId);
    });
    log('info', 'notify-open', { host: short(hostId), device: deviceId });
    for (const entry of pruneQueue(notifyQueues.get(hostId)?.get(deviceId) ?? [])) sendLine(line, entry);
  }

  function closePending(hostId, code, reason) {
    for (const c of [...(hostConns.get(hostId) ?? [])]) if (!c.hostWs) endConn(c, code, reason);
  }

  function sendControl(hostId, msg) {
    const h = hosts.get(hostId);
    if (h && h.ws.readyState === WebSocket.OPEN) h.ws.send(JSON.stringify(msg));
  }

  // ── 端末の接続 ──────────────────────────────────────────────

  function onDevice(ws, req, grant = null) {
    const hostId = grant ? grant.hostId : hostIdOf(req.headers['x-pleiad-host']);
    if (!hostId) return fail(ws, CLOSE.BAD_REQUEST, 'host id');
    const h = hosts.get(hostId);
    // sync の前は表が空なので、正しい端末まで 4401 にしないよう「居ない」として返す
    if (!h || !h.synced) return closeWs(ws, CLOSE.NOT_FOUND, 'host offline');
    const active = hostConns.get(hostId) ?? new Set();

    const ticket = req.headers['x-pleiad-pairing'];
    if (ticket !== undefined) {
      const now = Date.now();
      h.pairTimes = h.pairTimes.filter((t) => now - t < o.pairingWindowMs);
      if (h.pairTimes.length >= o.pairingAttempts) return closeWs(ws, CLOSE.LIMIT, 'pairing rate');
      h.pairTimes.push(now);
      const raw = secret32(ticket);
      const p = h.pairing;
      if (p && p.expiresAt <= now) h.pairing = null;
      if (!raw || !h.pairing || !sameHash(sha256(raw), h.pairing.hash)) return fail(ws, CLOSE.UNAUTHORIZED, 'pairing ticket');
      if (active.size >= o.maxConnsPerHost) return closeWs(ws, CLOSE.LIMIT, 'too many connections');
      h.pairing = null;   // 1 回きり
      return startConn(ws, h, { pairing: true, tags: grant?.tags, pending: grant?.pending });
    }

    const deviceId = req.headers['x-pleiad-device'];
    // admit: 差し込みが deviceId も入場券も無い接続を受け入れるとき。トークンの照合をせず、
    // 相手を確かめるのはホスト（Noise のハンドシェイクの中）。ほかの経路・ほかの場合は無視する（§5.7）
    if (grant?.admit && deviceId == null) {
      const now = Date.now();
      h.admitTimes = h.admitTimes.filter((t) => now - t < 60_000);
      if (h.admitTimes.length >= o.admitPerMinute) return closeWs(ws, CLOSE.LIMIT, 'admit rate');
      h.admitTimes.push(now);
      if (active.size >= o.maxConnsPerHost) return closeWs(ws, CLOSE.LIMIT, 'too many connections');
      return startConn(ws, h, { admit: true, tags: grant.tags, pending: grant.pending });
    }
    const raw = secret32(bearer(req.headers.authorization));
    const hash = typeof deviceId === 'string' ? h.devices.get(deviceId) : undefined;
    if (!raw || !hash || !sameHash(sha256(raw), hash)) return fail(ws, CLOSE.UNAUTHORIZED, 'device token');
    let perDevice = 0;
    for (const c of active) if (c.deviceId === deviceId) perDevice++;
    if (active.size >= o.maxConnsPerHost || perDevice >= o.maxConnsPerDevice) {
      return closeWs(ws, CLOSE.LIMIT, 'too many connections');
    }
    startConn(ws, h, { deviceId, tokenHash: hash, tags: grant?.tags, pending: grant?.pending });
  }

  function startConn(ws, h, { deviceId = null, tokenHash = null, pairing = false, admit = false, tags = [], pending = [] } = {}) {
    const c = {
      id: crypto.randomBytes(16).toString('base64url'),
      hostId: h.id,
      deviceId,
      tokenHash,
      pairing,
      admit,
      tags: [...(tags ?? [])],
      deviceWs: ws,
      hostWs: null,
      pending: [...pending],
      pendingBytes: pending.reduce((n, [data]) => n + data.length, 0),
      up: 0,
      down: 0,
      startedAt: Date.now(),
      ended: false,
      timer: null,
    };
    ws.tags = c.tags;
    conns.set(c.id, c);
    if (!hostConns.has(h.id)) hostConns.set(h.id, new Set());
    hostConns.get(h.id).add(c);
    c.timer = setTimeout(() => endConn(c, CLOSE.TIMEOUT, 'accept timeout'), o.acceptTimeoutMs);
    c.timer.unref();

    ws.on('message', (data, isBinary) => {
      if (c.ended) return;
      if (c.hostWs) return forward(c, c.hostWs, data, isBinary, 'up');
      // accept が来るまで溜める（Noise のメッセージ 1 がすぐ来る）。溜める量も上限で抑える
      c.pendingBytes += data.length;
      if (c.pendingBytes > o.maxBufferBytes) return endConn(c, CLOSE.OVERFLOW, 'buffer');
      c.pending.push([data, isBinary]);
    });
    ws.on('close', (code) => endConn(c, passCode(code), 'device closed'));

    log('info', 'device-open', { host: short(h.id), device: deviceId, pairing, admit, conn: c.id });
    emit({ type: 'device-open', hostId: h.id, deviceId, tags: c.tags, admit });
    sendControl(h.id, admit ? { type: 'incoming', conn: c.id, admit: true }
      : pairing ? { type: 'incoming', conn: c.id, pairing: true }
      : { type: 'incoming', conn: c.id, deviceId });
  }

  // ── ホストのデータ用の接続 ────────────────────────────────────

  function onAccept(ws, req, url, grant = null) {
    const hostId = grant ? grant.hostId : hostAuth(ws, req);
    if (!hostId) return;
    const c = conns.get(url.searchParams.get('conn') ?? '');
    // 別のホストの conn は「無い」と同じに扱う（行き先は端末を登録したホストだけ）
    if (!c || c.ended || c.hostId !== hostId || c.hostWs) return closeWs(ws, CLOSE.NOT_FOUND, 'no such conn');
    // 差し込みの tags に、対応する制御用の接続の tags を足す（重ねない。§5.7）
    ws.tags = [...new Set([...(grant?.tags ?? []), ...(hosts.get(hostId)?.tags ?? [])])];
    c.tags = [...new Set([...c.tags, ...ws.tags])];
    clearTimeout(c.timer);
    c.hostWs = ws;
    for (const [data, isBinary] of c.pending) forward(c, ws, data, isBinary, 'up');
    c.pending = [];
    c.pendingBytes = 0;
    ws.on('message', (data, isBinary) => { if (!c.ended) forward(c, c.deviceWs, data, isBinary, 'down'); });
    for (const [data, isBinary] of grant?.pending ?? []) if (!c.ended) forward(c, c.deviceWs, data, isBinary, 'down');
    ws.on('close', (code) => endConn(c, passCode(code), 'host closed'));
    log('debug', 'accept', { host: short(hostId), conn: c.id });
  }

  function forward(c, to, data, isBinary, dir) {
    if (to.readyState !== WebSocket.OPEN) return;
    if (to.bufferedAmount + data.length > o.maxBufferBytes) {
      // 読まない相手に際限なく溜めない。詰まった側は close の往復も終わらないので落とす
      to.terminate();
      return endConn(c, CLOSE.OVERFLOW, 'buffer');
    }
    to.send(data, { binary: isBinary });
    c[dir] += data.length;
  }

  function endConn(c, code, reason) {
    if (c.ended) return;
    c.ended = true;
    clearTimeout(c.timer);
    conns.delete(c.id);
    const set = hostConns.get(c.hostId);
    set?.delete(c);
    if (set && !set.size) hostConns.delete(c.hostId);
    closeWs(c.deviceWs, code, reason === 'device closed' ? '' : reason);
    closeWs(c.hostWs, code, reason === 'host closed' ? '' : reason);
    c.pending = [];
    sendControl(c.hostId, { type: 'closed', conn: c.id });
    log('info', 'device-close', {
      host: short(c.hostId), device: c.deviceId, pairing: c.pairing, conn: c.id,
      code, reason, up: c.up, down: c.down, ms: Date.now() - c.startedAt,
    });
    emit({ type: 'device-close', hostId: c.hostId, deviceId: c.deviceId, tags: c.tags, admit: c.admit });
  }

  // ── 起動と終了 ──────────────────────────────────────────────

  /** 試験と監視用の数。中身は含まない。 */
  const stats = () => ({ hosts: hosts.size, conns: conns.size, lines: [...notifyLines.values()].reduce((n, m) => n + m.size, 0), blocked: [...failures.values()].filter((e) => e.blockedUntil > Date.now()).length });

  /** 差し込みの attach(handle) に渡す、中継を操作する手（§5.7）。 */
  const handle = {
    stats,
    /** その tag を持つ接続（制御・データ・端末・通知の線）を全部閉じ、閉じた数を返す。 */
    closeTag(tag, code, reason) {
      const ok = Number.isSafeInteger(code) && ((code >= 4000 && code <= 4999) || code === 1000 || code === 1001 || code === 1008 || code === 1013);
      if (!ok) throw new Error(`closeTag の code が範囲外: ${code}`);
      let n = 0;
      for (const h of [...hosts.values()]) {
        if (h.ws.tags?.includes(tag)) { closeWs(h.ws, code, reason); n++; }
      }
      for (const c of [...conns.values()]) {
        const hit = [c.deviceWs, c.hostWs].filter((w) => w?.tags?.includes(tag)).length;
        if (hit) { endConn(c, code, reason); n += hit; }   // 端末の接続は両側を閉じる
      }
      for (const lines of [...notifyLines.values()]) {
        for (const line of [...lines.values()]) {
          if (line.tags.includes(tag)) { closeWs(line.ws, code, reason); n++; }
        }
      }
      return n;
    },
  };

  return {
    server,
    options: o,
    stats,
    listen(port = o.port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          try { authz?.attach?.(handle); } catch (err) { log('warn', 'authz-attach', { error: String(err?.message ?? err) }); }
          resolve(server.address());
        });
      });
    },
    async close() {
      clearInterval(pinger);
      clearInterval(notifyPinger);
      for (const c of [...conns.values()]) endConn(c, CLOSE.SHUTDOWN, 'shutdown');
      for (const ws of wss.clients) closeWs(ws, CLOSE.SHUTDOWN, 'shutdown');
      try { await authz?.close?.(); } catch (err) { log('warn', 'authz-close', { error: String(err?.message ?? err) }); }
      return new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(() => { for (const ws of wss.clients) ws.terminate(); server.closeAllConnections?.(); }, 200).unref();
      });
    },
  };
}

// node server.mjs で直接起動したときだけ待ち受ける（試験は createRelay を import する）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let cfg;
  try {
    cfg = configFromEnv();
    // 認可の差し込み（§5.7）: RELAY_AUTHZ_MODULE のモジュールの createAuthz が返したものを使う。
    // createRelay を import して使う側はこの環境変数を見ない（opts.authz だけ）
    const authzModule = process.env.RELAY_AUTHZ_MODULE;
    if (authzModule) {
      const mod = await import(pathToFileURL(authzModule).href);
      if (typeof mod.createAuthz !== 'function') throw new Error(`RELAY_AUTHZ_MODULE に createAuthz が無い: ${authzModule}`);
      const authzLog = (level, event, fields = {}) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }) + '\n');
      cfg.authz = await mod.createAuthz({ log: authzLog, env: process.env });
    }
    const relay = createRelay(cfg);
    const addr = await relay.listen(cfg.port);
    console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', event: 'listening', port: addr.port }));
    const stop = () => relay.close().then(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (err) {
    console.error(`relay: ${err.message}`);
    process.exit(1);
  }
}
