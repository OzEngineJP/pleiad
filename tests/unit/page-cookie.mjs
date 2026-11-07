// ファイルのページの Cookie を Chrome に入れる（core/chrome/page-cookie.mjs、ADR 0295 の 2 の 2）。
//   - 形: localhost の host-only・Path=/_pleiad/・HttpOnly・SameSite=Strict・ファイルのページの port（sourcePort）。値は本体のトークンから導いた値で、トークンそのものではない
//   - 時点: つながったとき（ブラウザーの単位の Storage.setCookies）・ファイルのページを開く前・タブのセッション（Network.setCookie）
//   - cookie が null（ページの port が立たなかった）・port が立っていないときは何もしない。失敗しても投げず、ログに値を書かない
import { createPageCookie, isPagesUrl, pageCookieParam } from '../../core/chrome/page-cookie.mjs';
import { pagesCookie, pagesSecret } from '../../core/page-auth.mjs';

export const name = 'page-cookie';
export const title = 'ファイルのページの Cookie: 形（localhost・Path・HttpOnly・Strict・port）と入れる時点（つながったとき・開く前・タブのセッション）';

const PAGES = 7431;
const TOKEN = 'main-token-value';

export default async function (t) {
  // ---- 形
  {
    const param = pageCookieParam({ cookie: pagesCookie(TOKEN), pages: PAGES });
    t.ok('localhost の host-only（url で入れ、domain を付けない）・Path・HttpOnly・Strict・port', param.url === `http://localhost:${PAGES}/_pleiad/` && !('domain' in param)
      && param.path === '/_pleiad/' && param.httpOnly === true && param.sameSite === 'Strict' && param.sourcePort === PAGES && param.sourceScheme === 'NonSecure' && !('expires' in param));
    t.ok('値は本体のトークンから導いた値で、トークンそのものではない', param.name === 'pleiad_pages' && param.value === pagesSecret(TOKEN) && param.value !== TOKEN && !JSON.stringify(param).includes(TOKEN));
    t.ok('cookie が null・port が無い・壊れた port なら null', pageCookieParam({ cookie: null, pages: PAGES }) === null && pageCookieParam({ cookie: pagesCookie(TOKEN), pages: null }) === null
      && pageCookieParam({ cookie: pagesCookie(TOKEN), pages: 0 }) === null && pageCookieParam({ cookie: pagesCookie(TOKEN), pages: '7431' }) === null && pageCookieParam({ cookie: { name: 'x' }, pages: PAGES }) === null);
    t.ok('ファイルのページの URL の見分け', isPagesUrl(`http://localhost:${PAGES}/_pleiad/s/a/file`, PAGES) && !isPagesUrl(`http://localhost:${PAGES}/`, PAGES) && !isPagesUrl(`http://127.0.0.1:${PAGES}/_pleiad/s/a/`, PAGES)
      && !isPagesUrl(`http://localhost:${PAGES + 1}/_pleiad/s/a/`, PAGES) && !isPagesUrl('nope', PAGES) && !isPagesUrl(`http://localhost:${PAGES}/_pleiad/s/a/`, null));
  }

  // ---- 時点
  {
    let ports = { main: 7420, pages: PAGES, isolated: 7432 }, cookie = pagesCookie(TOKEN);
    const logs = [];
    const jar = createPageCookie({ ports: () => ports, cookie: () => cookie, log: line => logs.push(line) });
    const calls = [];
    const send = async (method, params) => { calls.push({ method, params }); return {}; };
    t.ok('つながると、ブラウザーの単位の Storage.setCookies で 1 つ入れる', (await jar.connected({ send })) === true && calls.length === 1 && calls[0].method === 'Storage.setCookies'
      && calls[0].params.cookies.length === 1 && calls[0].params.cookies[0].value === pagesSecret(TOKEN) && !('browserContextId' in calls[0].params));
    t.ok('ファイルのページを開く前は入れ直す', (await jar.beforeOpen({ url: `http://localhost:${PAGES}/_pleiad/s/a/file`, send })) === true && calls.length === 2);
    t.ok('ほかの URL を開く前は入れない', (await jar.beforeOpen({ url: 'https://example.com/', send })) === false && (await jar.beforeOpen({ url: `http://localhost:7432/viz/x/`, send })) === false && calls.length === 2);
    t.ok('wanted はファイルのページで入れる物があるときだけ', jar.wanted(`http://localhost:${PAGES}/_pleiad/s/a/`) && !jar.wanted('https://example.com/'));
    const tab = [];
    t.ok('タブのセッションには Network.setCookie で入れる', (await jar.sessionCookie(async (method, params) => { tab.push({ method, params }); return { success: true }; })) === true
      && tab[0].method === 'Network.setCookie' && tab[0].params.url === `http://localhost:${PAGES}/_pleiad/` && tab[0].params.httpOnly === true);
    t.ok('Network.setCookie が success: false なら false', (await jar.sessionCookie(async () => ({ success: false }))) === false);

    const fail = async () => { throw new Error(`boom ${cookie.value}`.replace(cookie.value, '…')); };
    t.ok('入れるのに失敗しても投げない（false）・ログに値を書かない', (await jar.connected({ send: fail })) === false && (await jar.sessionCookie(fail)) === false
      && logs.length === 2 && logs.every(line => line.startsWith('page-cookie: set failed') && !line.includes(pagesSecret(TOKEN))));
    t.ok('send が無ければ何もしない', (await jar.connected({})) === false && (await jar.connected()) === false && (await jar.sessionCookie(null)) === false);

    cookie = null;
    t.ok('cookie が null（ページの port が立たなかった）なら何もしない', (await jar.connected({ send })) === false && (await jar.beforeOpen({ url: `http://localhost:${PAGES}/_pleiad/s/a/file`, send })) === false
      && !jar.wanted(`http://localhost:${PAGES}/_pleiad/s/a/`) && calls.length === 2);
    cookie = pagesCookie(TOKEN); ports = null;
    t.ok('port が分かる前は何もしない', (await jar.connected({ send })) === false && calls.length === 2);
  }
}
