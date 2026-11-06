// ホストの接続口の防火壁（docs/remote.md §4.2）。復号したストリームを、ホストの既存サーバーへの HTTP / WebSocket に組み立て直す。
//
// - `/hooks`（webhook は利用者のトンネルで公開する）・`/mcp` で始まるパス（エージェント CLI 用の内部口）と、`/api/ops`（CLI 用の操作の一覧の口。ADR 0083）は通さない
// - HTTP は GET と HEAD だけ、WebSocket は /ws だけ
// - 端末から来たヘッダーは決まったものだけを通す（Cookie・Authorization・Host・Origin・hop-by-hop などは落ちる）。
//   `?token=` も落とし、ホストの UI トークンは接続口が付ける（HTTP は Cookie、/ws は ?token=）
// - 応答の Set-Cookie と hop-by-hop を落とす。ホストの UI トークンは端末に届かない
// 通さないものは RESET 3（防火壁が通さない）で返す。
import http from 'node:http';
import WebSocket from 'ws';
import { RESET_CODE } from './frames.mjs';
import { AGENT_PATH } from './agent-protocol.mjs';

const COOKIE_NAME = 'agent_host_token';
/** 端末から通す要求のヘッダー（小文字）。これ以外は捨てる。 */
const PASS_REQUEST = new Set([
  'accept', 'accept-language', 'accept-encoding', 'cache-control', 'pragma',
  'if-none-match', 'if-modified-since', 'if-range', 'range', 'user-agent',
]);
/** 応答から捨てるヘッダー。 */
const DROP_RESPONSE = new Set([
  'set-cookie', 'set-cookie2', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-connection', 'te', 'trailer',
]);
const WS_RELEASE_BELOW = 64 * 1024;
const WS_PAUSE_ABOVE = 256 * 1024;

/** ADR 0292 §5。圧縮された本体で上限を逃れないよう、ページの転送は identity にする。 */
export function pageResponseLimit(path, isolated = false) {
  let p;
  try { p = decodeURIComponent(new URL(path, 'http://host.invalid').pathname); } catch { return 0; }
  if (isolated) return 32 * 1024 * 1024;
  if (!p.startsWith('/_pleiad/')) return 0;
  return /\/api\/raw$/.test(p) ? 32 * 1024 * 1024 : 8 * 1024 * 1024;
}

export function isIsolatedPagePath(path) {
  const checked = checkPath(path);
  if (!checked) return false;
  let p;
  try { p = decodeURIComponent(checked.pathname); } catch { return false; }
  if (p.split('/').some(part => part === '.' || part === '..') || p.includes('\\')) return false;
  return p.startsWith('/viz/') || p.startsWith('/f/');
}

function validPort(port) { return Number.isInteger(port) && port > 0 && port <= 65535; }

function devicePagePorts(ports) {
  return ports && validPort(ports.main) && validPort(ports.isolated)
    ? { main: ports.main, pages: ports.main, isolated: ports.isolated } : null;
}

/**
 * 端末の言うパスを検める。通すなら { path }（組み立て直したもの。token は落とす）、通さないなら null。
 * WHATWG の URL で読み直してから判定し、判定したものをそのまま送る（`/x/../mcp` や `\mcp` の抜け道を作らない）。
 */
export function checkPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.length > 8192) return null;
  let u;
  try { u = new URL(raw, 'http://host.invalid'); } catch { return null; }
  if (u.host !== 'host.invalid') return null;
  const lower = u.pathname.toLowerCase();
  let decoded = lower;
  try { decoded = decodeURIComponent(lower); } catch { return null; }
  for (const p of [lower, decoded]) if (p === '/mcp' || p.startsWith('/mcp/') || p === '/api/ops' || p.startsWith('/api/ops/') || p === '/hooks' || p.startsWith('/hooks/')) return null;
  u.searchParams.delete('token');
  return { path: u.pathname + u.search, pathname: u.pathname };
}

/** 端末から来た Sec-Fetch-Site。知らない値は cross-site として渡す（ホストで断られる） */
function fetchSiteOf(from) {
  if (!from || typeof from !== 'object' || Array.isArray(from)) return null;
  const entry = Object.entries(from).find(([k]) => String(k).toLowerCase() === 'sec-fetch-site');
  if (!entry) return null;
  const value = String(entry[1] ?? '');
  return ['same-origin', 'same-site', 'cross-site', 'none'].includes(value) ? value : 'cross-site';
}

function requestHeaders(from) {
  const out = {};
  if (from && typeof from === 'object' && !Array.isArray(from)) {
    for (const [k, v] of Object.entries(from)) {
      const key = String(k).toLowerCase();
      if (!PASS_REQUEST.has(key)) continue;
      const value = Array.isArray(v) ? v.map(String).join(', ') : String(v ?? '');
      if (/[\r\n\0]/.test(value) || value.length > 4096) continue;
      out[key] = value;
    }
  }
  return out;
}

function responseHeaders(from) {
  const out = {};
  for (const [k, v] of Object.entries(from ?? {})) {
    const key = k.toLowerCase();
    if (DROP_RESPONSE.has(key) || key.startsWith('proxy-')) continue;
    out[key] = v;
  }
  return out;
}

/** 端末の WebSocket の close code を、ws が送れるものに揃える。 */
function sendableCode(code) {
  return code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : 1000;
}

/**
 * チャネルのストリーム 1 本を扱う。target() は { host, port }（ホストの既存サーバー）、token はホストの UI トークン。
 * device は { id, platform }（この線の端末。ハンドシェイクで確かめた端末）。/ws には x-pleiad-device で渡し、
 * サーバーが「どの端末の画面か」（スマホへの通知の見ている印・通知鍵の登録）を知る。端末が自分で名乗ったヘッダーは通さない（requestHeaders）。
 */
export function forwardStream(stream, { target, token, device = null, pagePorts = null }) {
  const head = stream.request ?? {};
  const checked = checkPath(head.path);
  const isolated = head.destination === 'isolated';
  if (head.destination != null && head.destination !== 'main' && !isolated) return stream.reset(RESET_CODE.FORBIDDEN);
  const ports = devicePagePorts(head.pagePorts);
  // /agent は接続口が自分で受ける（connector.mjs → agent-port.mjs）。ローカルのサーバーへは通さない（docs/remote.md §4.5）
  if (checked?.pathname === AGENT_PATH) return stream.reset(RESET_CODE.FORBIDDEN);
  if (stream.kind === 'http') {
    const method = String(head.method ?? '').toUpperCase();
    if (!checked || (method !== 'GET' && method !== 'HEAD')) return stream.reset(RESET_CODE.FORBIDDEN);
    const limit = pageResponseLimit(checked.path, isolated);
    if ((isolated || limit) && !validPort(pagePorts?.isolated)) return stream.reset(RESET_CODE.FORBIDDEN);
    if (isolated && !isIsolatedPagePath(checked.path)) return stream.reset(RESET_CODE.FORBIDDEN);
    const headers = requestHeaders(head.headers);
    if (limit) headers['accept-encoding'] = 'identity';
    // このヘッダーは端末の HTTP 要求からは通さず、認証済みチャネルの頭からだけ作る。
    // ファイルページの api/env と CSP を端末の origin にするための情報（ADR 0292 §5）。
    if (!isolated && limit && ports) headers['x-pleiad-page-ports'] = JSON.stringify(ports);
    // ファイルのページの出どころ（Sec-Fetch-Site）は、ページの道だけ通す。ホストの入口が same-origin・none のほかを断る（core/page-auth.mjs）
    if (!isolated && limit) { const site = fetchSiteOf(head.headers); if (site) headers['sec-fetch-site'] = site; }
    const dest = isolated ? { host: '127.0.0.1', port: pagePorts.isolated } : target();
    return forwardHttp(stream, method, checked.path, headers, dest, isolated ? null : token, limit, pagePorts, ports);
  }
  if (isolated || !checked || checked.pathname !== '/ws') return stream.reset(RESET_CODE.FORBIDDEN);
  return forwardWs(stream, checked.path, head.protocols, target(), token, device, ports, validPort(pagePorts?.isolated));
}

function forwardHttp(stream, method, path, headers, { host, port }, token, limit, pagePorts, ports) {
  let responded = false;
  const req = http.request({
    host, port, method, path, agent: false,
    headers: token == null ? { ...headers, host: `localhost:${port}` }
      : { ...headers, cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` },
  });
  stream.on('reset', () => req.destroy());
  req.on('error', () => {
    if (stream.destroyed) return;
    if (responded) return stream.reset(RESET_CODE.INTERNAL);
    responded = true;
    stream.respond({ status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } }).catch(() => {});
    stream.end('bad gateway').catch(() => {});
  });
  req.on('response', res => {
    if (stream.destroyed) { res.destroy(); return; }
    const tooLarge = () => { stream.reset(RESET_CODE.FORBIDDEN); res.destroy(); req.destroy(); };
    if (limit && method !== 'HEAD' && (Number(res.headers['content-length']) > limit ||
      (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity'))) return tooLarge();
    responded = true;
    const out = responseHeaders(res.headers);
    if (limit && ports && typeof out['content-security-policy'] === 'string') {
      out['content-security-policy'] = out['content-security-policy'].split(/(\s+|;)/).map(source =>
        source === `http://localhost:${pagePorts.isolated}` ? `http://localhost:${ports.isolated}` : source).join('');
    }
    stream.respond({ status: res.statusCode ?? 502, headers: out }).catch(() => {});
    let received = 0;
    res.on('data', chunk => {
      received += chunk.length;
      if (limit && received > limit) return tooLarge();
      res.pause();
      stream.write(chunk).then(() => res.resume(), () => res.destroy());
    });
    res.on('end', () => { stream.end().catch(() => {}); });
    res.on('error', () => { if (!stream.destroyed) stream.reset(RESET_CODE.INTERNAL); });
  });
  req.end();
}

function forwardWs(stream, path, protocols, { host, port }, token, device, ports, pagesEnabled) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `ws://${host.includes(':') ? `[${host}]` : host}:${port}${path}${sep}token=${encodeURIComponent(token)}`;
  const list = Array.isArray(protocols) ? protocols.filter(p => typeof p === 'string' && /^[\x21-\x7e]{1,64}$/.test(p)).slice(0, 8) : [];
  // ホストのサーバーから見るとループバックの接続なので、印を付けて「サーバーのある PC の画面」と区別させる
  // （core/os-open.mjs の isLocalRequest。エクスプローラーで表示・ブラウザーで開くをリモートの端末から動かさない）
  const local = new WebSocket(url, list, { perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10_000,
    headers: { 'x-forwarded-for': 'pleiad-remote', ...(device?.id ? { 'x-pleiad-device': String(device.id) } : {}) } });
  let opened = false;
  let inflight = 0;

  stream.on('reset', () => local.terminate());
  local.on('unexpected-response', (req, res) => {
    const status = res.statusCode ?? 502;
    res.resume();
    req.destroy();
    if (!stream.destroyed) stream.reject(status >= 400 && status <= 599 ? status : 502).catch(() => {});
  });
  local.on('error', () => {
    if (stream.destroyed) return;
    if (!opened) stream.reject(502).catch(() => {});
    else stream.reset(RESET_CODE.INTERNAL);
  });
  local.on('open', () => {
    if (stream.destroyed) { local.terminate(); return; }
    opened = true;
    stream.accept().catch(() => {});
  });
  // ホスト → 端末。窓が詰まったらローカルの読み出しを止める
  local.on('message', (data, isBinary) => {
    let buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    if (pagesEnabled && !isBinary) {
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        if (msg.kind === 'response' && msg.result?.browserUnify) {
          if (ports) msg.result.browserUnify = { ...msg.result.browserUnify, pages: ports.pages, isolated: ports.isolated };
          else delete msg.result.browserUnify;
          buf = Buffer.from(JSON.stringify(msg));
        }
      } catch { /* JSON 以外のメッセージはそのまま通す */ }
    }
    inflight += buf.length;
    if (inflight > WS_PAUSE_ABOVE && !local.isPaused) local.pause();
    stream.send(buf, { text: !isBinary }).then(() => {
      inflight -= buf.length;
      if (inflight <= WS_PAUSE_ABOVE && local.isPaused && local.readyState === WebSocket.OPEN) local.resume();
    }, () => local.terminate());
  });
  local.on('close', (code, reason) => {
    if (stream.destroyed || !opened) return;
    stream.close(sendableCode(code), reason?.toString('utf8') ?? '').catch(() => {});
  });
  // 端末 → ホスト。ローカルへの送りが溜まっていないときに窓を返す（§4.3）
  stream.on('message', (data, text, release) => {
    if (local.readyState !== WebSocket.OPEN) { release(); return; }
    local.send(text ? data.toString('utf8') : data, { binary: !text });
    const tryRelease = () => {
      if (local.readyState !== WebSocket.OPEN || local.bufferedAmount < WS_RELEASE_BELOW) release();
      else setTimeout(tryRelease, 10);
    };
    tryRelease();
  });
  stream.on('close', (code, reason) => {
    if (local.readyState === WebSocket.OPEN || local.readyState === WebSocket.CONNECTING) {
      try { local.close(sendableCode(code), reason); } catch { local.terminate(); }
    }
    stream.close(sendableCode(code), reason).catch(() => {});
  });
}
