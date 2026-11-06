// 中継（core/chrome/relay.mjs）の移動の検査と、エージェントのコマンドの前後のふるい（ADR 0292 の 2 の 4）。
//   - 本体の port は、どのホスト名でも断る（Page.navigate・タブを開く・ページの中の JS の移動とサブリソース）。旗に依らない（ports().main は旗が off でも入る）
//   - ファイルのページの port は localhost のその会話の /_pleiad/s/<会話 id>/ だけ、隔離の port は localhost だけを通す（旗が off なら port が無いので何もしない）
//   - エージェントに pleiad_* の Cookie を見せない・2 つの port の Cookie を読み書きさせない
// 中継は会話の窓のタブのことしか渡さない。URL と Cookie の値はログに書かない。
import { PAGES_PATH } from '../page-auth.mjs';
import { createPageCookie } from './page-cookie.mjs';

/** Pleiad の Cookie の名前の前置き（pleiad_pages など） */
export const PLEIAD_COOKIE_PREFIX = 'pleiad_';
const COOKIE_READS = new Set(['Network.getCookies']);
const COOKIE_WRITES = new Set(['Network.setCookie', 'Network.setCookies', 'Network.deleteCookies']);
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

/** http(s)（認証情報なし）と about:blank だけ */
export function safeUrl(value) {
  try { const url = new URL(value); return (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) || url.href === 'about:blank'; }
  catch { return false; }
}

/** URL の scheme・ホスト名（小文字。WHATWG の URL が 10 進以外の IPv4 も直す）・実際の port・パス。読めなければ null */
function parts(value) {
  try {
    const url = new URL(value);
    const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
    if (!Number.isInteger(port)) return null;
    return { protocol: url.protocol, host: url.hostname.toLowerCase(), port, path: url.pathname };
  } catch { return null; }
}

/** ファイルのページのパスが、この会話の /_pleiad/s/<会話 id>/ の下か */
function ownPagesPath(path, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const prefix = `${PAGES_PATH}s/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return false;
  let id;
  try { id = decodeURIComponent(rest.slice(0, slash)); } catch { return false; }
  return id === sessionId;
}

/**
 * Pleiad の 3 つの port を指す URL を、この会話に通してよいか。
 * @returns null（Pleiad の port でない。今の扱い）・true（通す）・false（断る）
 */
export function pleiadVerdict(value, { ports, sessionId } = {}) {
  const url = parts(value);
  if (!url || !ports) return null;
  // 本体の port は、ホスト名に依らず断る（127.0.0.1・localhost・[::1]・0.0.0.0・*.localhost・127.0.0.0/8・ループバックを指す DNS の名前）
  if (ports.main && url.port === ports.main) return false;
  const exact = url.protocol === 'http:' && url.host === 'localhost';
  if (ports.pages && url.port === ports.pages) return exact && ownPagesPath(url.path, sessionId);
  if (ports.isolated && url.port === ports.isolated) return exact;
  return null;
}

/** Cookie の引数が Pleiad のものを指すか（名前が pleiad_*・url が 3 つの port・パスが /_pleiad/ の localhost） */
function pleiadCookie(cookie, ports) {
  if (!cookie || typeof cookie !== 'object') return false;
  if (typeof cookie.name === 'string' && cookie.name.startsWith(PLEIAD_COOKIE_PREFIX)) return true;
  if (cookie.url != null && pleiadVerdict(cookie.url, { ports, sessionId: null }) !== null) return true;
  const domain = typeof cookie.domain === 'string' ? cookie.domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '') : null;
  const host = domain ?? (cookie.url != null ? parts(cookie.url)?.host ?? null : null);
  return host === 'localhost' && typeof cookie.path === 'string' && cookie.path.startsWith(PAGES_PATH.slice(0, -1));
}

/** 結果の cookies（と associatedCookies）から pleiad_* を除いた写し */
function stripCookies(list) {
  return list.filter(item => {
    const name = item?.cookie?.name ?? item?.name;
    return !(typeof name === 'string' && name.startsWith(PLEIAD_COOKIE_PREFIX));
  });
}

/** Cookie の見出しの値から pleiad_* を除く（全部消えたら null） */
function stripHeader(value) {
  const kept = String(value).split(';').map(part => part.trim()).filter(part => part && !part.startsWith(PLEIAD_COOKIE_PREFIX));
  return kept.length ? kept.join('; ') : null;
}
function stripHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'cookie') { out[key] = value; continue; }
    const kept = stripHeader(value);
    if (kept !== null) out[key] = kept;
  }
  return out;
}

/** 生の見出しの文（"Cookie: a=1; pleiad_pages=…\r\n"）の Cookie の行から pleiad_* を除く */
function stripHeadersText(text) {
  return String(text).split('\r\n').flatMap(line => {
    const at = line.indexOf(':');
    if (at < 0 || line.slice(0, at).trim().toLowerCase() !== 'cookie') return [line];
    const kept = stripHeader(line.slice(at + 1));
    return kept === null ? [] : [`${line.slice(0, at)}: ${kept}`];
  }).join('\r\n');
}

/**
 * Network・Fetch のイベントから、要求に付いた Cookie の pleiad_* を除いた写し。
 * Cookie の値が載る所: requestWillBeSentExtraInfo の headers・associatedCookies、responseReceived の response.requestHeaders(Text)、
 * requestWillBeSent・requestPaused・webSocketWillSendHandshakeRequest の request.headers
 */
function stripEvent(params) {
  const out = { ...params };
  if (out.headers) out.headers = stripHeaders(out.headers);
  if (Array.isArray(out.associatedCookies)) out.associatedCookies = stripCookies(out.associatedCookies);
  if (out.request && typeof out.request === 'object' && out.request.headers) out.request = { ...out.request, headers: stripHeaders(out.request.headers) };
  if (out.response && typeof out.response === 'object') {
    const response = { ...out.response };
    if (response.requestHeaders) response.requestHeaders = stripHeaders(response.requestHeaders);
    if (typeof response.requestHeadersText === 'string') response.requestHeadersText = stripHeadersText(response.requestHeadersText);
    out.response = response;
  }
  return out;
}

class PolicyError extends Error {}
const refused = () => new PolicyError('Pleiad\'s own cookies are not available to agents');

/**
 * @param {object} [deps]
 * @param [deps.ports]  () => { main, pages, isolated }（数。立っていなければ null）。サーバーが relay.setPagePorts で渡したもの。main は旗に依らず入る
 * @param [deps.cookie] () => ファイルのページの Cookie（core/page-auth.mjs の pagesCookie の形）か null。旗が on のときだけ入る（relay.setPageCookie）
 * @param [deps.log]   ログの 1 行（URL を書かない）
 * @returns 中継が呼ぶ口
 *   - allowUrl(url, { sessionId, via }): 移動を通すか。via は 'navigate'（Page.navigate）・'create'（Target.createTarget）・'open'（人がビューアから開く）
 *   - before({ sessionId, targetId, method, params }): 上りへ送る引数（そのまま返すか、変えた写しを返す）。断るなら Error を投げる（文はエージェントへ返る）
 *   - after({ sessionId, targetId, method, params, result }): エージェントへ返す結果
 *   - intercepts: true なら、確認（confirmAgentSites）が OFF でも中継のセッションをタブに付け、fetchPatterns の要求を止めて request に聞く
 *   - fetchPatterns(patterns): 中継のセッションの Fetch.enable の patterns（既定は確認のための主フレームの Document だけ）
 *   - request({ sessionId, targetId, url, resourceType, frameId }): 止めた要求を 'block' で失敗させる。null なら今の扱い（確認）へ
 *   - connected({ send }): 上りにつながった（つなぎ直しのたび）。send(method, params) は中継自身の接続のブラウザーの単位のコマンド。中継は待たない
 *   - beforeOpen({ sessionId, url, send }): タブを開く前（Target.createTarget・人が開く）。中継は終わるのを待ってから開く
 *   - event({ sessionId, method, params }): エージェントへ送るイベントの params（Cookie の見出しから pleiad_* を除く）。中継はまだ呼んでいない（親に口を頼む）
 *   - tabCookie(send): タブのセッションでページの Cookie を入れる（既定の context でないプロフィールのタブ）。中継はまだ呼んでいない（親に口を頼む）
 *   before・after・beforeOpen は Promise を返してもよい。どの口も投げたら中継はログに書いて続ける（allowUrl は通さない、before はエージェントへ断る）
 */
export function createPagePolicy({ ports = () => null, cookie = () => null, log = () => {} } = {}) {
  const current = () => { try { return ports() ?? null; } catch { return null; } };
  const known = () => { const value = current(); return value ? [value.main, value.pages, value.isolated].filter(port => Number.isInteger(port) && port > 0) : []; };
  const pageCookie = createPageCookie({ ports: current, cookie, log });
  return {
    allowUrl(url, { sessionId } = {}) {
      if (!safeUrl(url)) return false;
      return pleiadVerdict(url, { ports: current(), sessionId }) !== false;
    },
    before({ method, params }) {
      if (!COOKIE_READS.has(method) && !COOKIE_WRITES.has(method)) return params;
      const value = current();
      if (COOKIE_READS.has(method)) {
        const urls = Array.isArray(params?.urls) ? params.urls : [];
        if (urls.some(url => pleiadVerdict(url, { ports: value, sessionId: null }) !== null)) throw refused();
        return params;
      }
      const list = method === 'Network.setCookies' ? (Array.isArray(params?.cookies) ? params.cookies : []) : [params];
      if (list.some(item => pleiadCookie(item, value))) throw refused();
      return params;
    },
    after({ result }) {
      if (!result || !Array.isArray(result.cookies)) return result;
      const cookies = stripCookies(result.cookies);
      return cookies.length === result.cookies.length ? result : { ...result, cookies };
    },
    /** 本体の port が分かっていれば（旗に依らない）、どのタブにも中継のセッションを付ける */
    get intercepts() { return known().length > 0; },
    fetchPatterns(patterns) {
      const extra = known().map(port => ({ urlPattern: port === 80 || port === 443 ? '*' : `*:${port}/*`, requestStage: 'Request' }));
      return [...(Array.isArray(patterns) ? patterns : []), ...extra];
    },
    request({ sessionId, url }) {
      return pleiadVerdict(url, { ports: current(), sessionId }) === false ? 'block' : null;
    },
    connected: ({ send } = {}) => { void pageCookie.connected({ send }); },
    // 入れる物が無い（旗が off・ファイルのページでない）ときは待たせない
    beforeOpen: ({ url, send } = {}) => {
      if (!pageCookie.wanted(url)) return undefined;
      return pageCookie.beforeOpen({ url, send }).then(() => undefined);
    },
    event({ method, params }) {
      if (typeof method !== 'string' || !(method.startsWith('Network.') || method.startsWith('Fetch.')) || !params || typeof params !== 'object') return params;
      return stripEvent(params);
    },
    tabCookie: send => pageCookie.sessionCookie(send),
  };
}
