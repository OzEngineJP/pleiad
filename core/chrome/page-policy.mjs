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
/** Cookie の値が載りうるイベントの domain（event で見る） */
const EVENT_DOMAINS = ['Network.', 'Fetch.', 'Audits.'];

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
/** Set-Cookie の行が pleiad_* を入れるものか（名前の前の空白は読み飛ばす） */
const setsPleiad = line => String(line).trimStart().startsWith(PLEIAD_COOKIE_PREFIX);
/** Set-Cookie の見出しの値（Chrome は複数の行を改行でつなぐ）から pleiad_* の行を除く（全部消えたら null） */
function stripSetCookie(value) {
  const kept = String(value).split('\n').filter(line => line.trim() && !setsPleiad(line));
  return kept.length ? kept.join('\n') : null;
}
/** 見出しの写し。要求の Cookie と応答の Set-Cookie から pleiad_* を除く（名前は大文字小文字を問わない） */
function stripHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name !== 'cookie' && name !== 'set-cookie') { out[key] = value; continue; }
    const kept = name === 'cookie' ? stripHeader(value) : stripSetCookie(value);
    if (kept !== null) out[key] = kept;
  }
  return out;
}
/** Fetch の見出しの列（[{ name, value }]）の写し */
function stripHeaderEntries(list) {
  return list.flatMap(item => {
    const name = String(item?.name ?? '').toLowerCase();
    if (name !== 'cookie' && name !== 'set-cookie') return [item];
    const kept = name === 'cookie' ? stripHeader(item.value) : stripSetCookie(item.value);
    return kept === null ? [] : [{ ...item, value: kept }];
  });
}

/** 生の見出しの文（"Cookie: a=1; pleiad_pages=…\r\n"・"Set-Cookie: pleiad_pages=…\r\n"）の Cookie・Set-Cookie の行から pleiad_* を除く */
function stripHeadersText(text) {
  return String(text).split(/\r?\n/).flatMap(line => {
    const at = line.indexOf(':');
    const name = at < 0 ? '' : line.slice(0, at).trim().toLowerCase();
    if (name === 'set-cookie') return setsPleiad(line.slice(at + 1)) ? [] : [line];
    if (name !== 'cookie') return [line];
    const kept = stripHeader(line.slice(at + 1));
    return kept === null ? [] : [`${line.slice(0, at)}: ${kept}`];
  }).join('\r\n');
}

/** 応答（Network.Response・WebSocketResponse）の写し。応答の見出しと、載っていれば要求の見出し */
function stripResponse(response) {
  if (!response || typeof response !== 'object') return response;
  const out = { ...response };
  if (out.headers) out.headers = stripHeaders(out.headers);
  if (typeof out.headersText === 'string') out.headersText = stripHeadersText(out.headersText);
  if (out.requestHeaders) out.requestHeaders = stripHeaders(out.requestHeaders);
  if (typeof out.requestHeadersText === 'string') out.requestHeadersText = stripHeadersText(out.requestHeadersText);
  return out;
}

/** 断った・除外した Cookie の列（blockedCookies・exemptedCookies）から pleiad_* を除く */
function stripCookieLines(list) {
  return list.filter(item => {
    const name = item?.cookie?.name;
    if (typeof name === 'string' && name.startsWith(PLEIAD_COOKIE_PREFIX)) return false;
    return !(typeof item?.cookieLine === 'string' && setsPleiad(item.cookieLine));
  });
}

/**
 * Network・Fetch・Audits のイベントから、pleiad_* の Cookie の値を除いた写し。値が載る所（Chrome 156）:
 *   - 要求の Cookie: requestWillBeSent・requestPaused・authRequired・webSocketWillSendHandshakeRequest の request.headers、
 *     requestWillBeSentExtraInfo の headers・associatedCookies、responseReceived・requestWillBeSent の redirectResponse・
 *     webSocketHandshakeResponseReceived の response.requestHeaders(Text)
 *   - 応答の Set-Cookie: responseReceivedExtraInfo の headers・headersText・blockedCookies・exemptedCookies、
 *     responseReceived・redirectResponse・webSocketHandshakeResponseReceived の response.headers(Text)、responseReceivedEarlyHints の headers、
 *     requestPaused（応答の段）の responseHeaders
 *   - Audits.issueAdded の Cookie の問題の rawCookieLine（Chrome が読めなかった Set-Cookie の行）
 */
function stripEvent(params) {
  const out = { ...params };
  if (out.headers) out.headers = stripHeaders(out.headers);
  if (typeof out.headersText === 'string') out.headersText = stripHeadersText(out.headersText);
  if (Array.isArray(out.associatedCookies)) out.associatedCookies = stripCookies(out.associatedCookies);
  if (Array.isArray(out.blockedCookies)) out.blockedCookies = stripCookieLines(out.blockedCookies);
  if (Array.isArray(out.exemptedCookies)) out.exemptedCookies = stripCookieLines(out.exemptedCookies);
  if (Array.isArray(out.responseHeaders)) out.responseHeaders = stripHeaderEntries(out.responseHeaders);
  if (out.request && typeof out.request === 'object' && out.request.headers) out.request = { ...out.request, headers: stripHeaders(out.request.headers) };
  if (out.response) out.response = stripResponse(out.response);
  if (out.redirectResponse) out.redirectResponse = stripResponse(out.redirectResponse);
  const cookieIssue = out.issue?.details?.cookieIssueDetails;
  if (cookieIssue && typeof cookieIssue.rawCookieLine === 'string' && (setsPleiad(cookieIssue.rawCookieLine) || cookieIssue.rawCookieLine.includes(PLEIAD_COOKIE_PREFIX))) {
    out.issue = { ...out.issue, details: { ...out.issue.details, cookieIssueDetails: { ...cookieIssue, rawCookieLine: '' } } };
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
 *   - event({ sessionId, method, params }): エージェントへ送るイベントの params（Cookie・Set-Cookie の見出しから pleiad_* を除く）
 *   - tabCookie(send): タブのセッションでページの Cookie を入れる（既定の context でないプロフィールのタブ）。中継はタブに自分のセッションを付けたときと、ファイルのページへ移す前に呼ぶ
 *   - wantsCookie(url): その URL へ移す前にページの Cookie を入れるか
 *   - childPatterns(): iframe・popup の子のセッションの Fetch の patterns。browserPatterns(): ブラウザーの単位の Fetch の patterns（popup の最初の要求）
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
      if (typeof method !== 'string' || !EVENT_DOMAINS.some(prefix => method.startsWith(prefix)) || !params || typeof params !== 'object') return params;
      return stripEvent(params);
    },
    tabCookie: send => pageCookie.sessionCookie(send),
    wantsCookie: url => pageCookie.wanted(url),
    /** iframe・popup の子のセッションの Fetch の patterns（Pleiad の port だけ。port を知らなければ空） */
    childPatterns() { return this.fetchPatterns([]); },
    /**
     * ブラウザーの単位の Fetch の patterns。window.open の最初の要求は開いた元のタブの Fetch で止まらない（実機）ので、
     * Pleiad の port への主フレームの移動だけをブラウザーの単位で止める。80・443 は '*' になり利用者の全部の移動を止めるので入れない
     */
    browserPatterns() {
      return known().filter(port => port !== 80 && port !== 443).map(port => ({ urlPattern: `*:${port}/*`, resourceType: 'Document', requestStage: 'Request' }));
    },
  };
}
