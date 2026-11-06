// ファイルのページの Cookie（pleiad_pages）を Chrome に入れる（ADR 0292 の 2 の 2）。中継の移動の検査の口（page-policy.mjs）の connected・beforeOpen から呼ぶ。
// 入れる時点は、上りにつながるたびと、Pleiad のページを開く前。値はログに書かない。
// 実機（Chrome 156、2026-11-06）: ブラウザーの単位の Storage.setCookies が入るのは CDP の既定の context（Target.getBrowserContexts の defaultBrowserContextId）だけで、
// ほかのプロフィールの browserContextId を渡すと「Failed to find browser context」になる。ほかのプロフィールのタブには、そのタブのセッションの Network.setCookie で入れる（sessionCookie）。
import { PAGES_PATH } from '../page-auth.mjs';

/**
 * CDP の CookieParam。url で localhost の host-only にし、sourcePort を付ける（Chrome が Cookie を port に結ぶようになっても、ファイルのページの port にだけ送られる）
 * @param {{ cookie: object|null, pages: number|null }} given cookie は core/page-auth.mjs の pagesCookie の形
 * @returns CookieParam か null（Cookie か port がまだ無い）
 */
export function pageCookieParam({ cookie, pages }) {
  if (!cookie?.name || typeof cookie.value !== 'string' || !Number.isInteger(pages) || pages <= 0) return null;
  const path = cookie.path ?? PAGES_PATH;
  return {
    name: cookie.name, value: cookie.value, url: `http://localhost:${pages}${path}`, path,
    httpOnly: cookie.httpOnly !== false, sameSite: cookie.sameSite ?? 'Strict',
    sourceScheme: 'NonSecure', sourcePort: pages,
  };
}

/** ファイルのページの URL か（http://localhost:<pages>/_pleiad/…） */
export function isPagesUrl(value, pages) {
  if (!Number.isInteger(pages)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === 'localhost' && Number(url.port) === pages && url.pathname.startsWith(PAGES_PATH);
  } catch { return false; }
}

/**
 * @param {object} [deps]
 * @param [deps.ports]  () => { main, pages, isolated } か null
 * @param [deps.cookie] () => pagesCookie の形か null（サーバーが渡す前は null）
 * @param [deps.log]    ログの 1 行（値・URL を書かない）
 */
export function createPageCookie({ ports = () => null, cookie = () => null, log = () => {} } = {}) {
  const param = () => pageCookieParam({ cookie: cookie(), pages: ports()?.pages ?? null });
  const failed = error => log(`page-cookie: set failed: ${error?.message ?? error}`);
  /** ブラウザーの単位（CDP の既定の context）に入れる。入れたら true */
  async function browserCookie(send) {
    const value = param();
    if (!value || typeof send !== 'function') return false;
    try { await send('Storage.setCookies', { cookies: [value] }); return true; }
    catch (error) { failed(error); return false; }
  }
  return {
    /** 上りにつながった（つなぎ直しのたび） */
    connected: ({ send } = {}) => browserCookie(send),
    /** この URL を開く前に入れる物があるか（Cookie があって、ファイルのページを開く） */
    wanted: url => Boolean(param()) && isPagesUrl(url, ports()?.pages ?? null),
    /** タブを開く前。ファイルのページを開くときだけ入れ直す（人が閲覧データを消した後でも開けるように） */
    beforeOpen: async ({ url, send } = {}) => isPagesUrl(url, ports()?.pages ?? null) ? browserCookie(send) : false,
    /**
     * タブのセッションに入れる（既定の context でないプロフィールのタブ）。send(method, params) はそのタブのセッションで送るもの。
     * 中継がタブのセッションを渡す口を足したら、そこから呼ぶ
     */
    async sessionCookie(send) {
      const value = param();
      if (!value || typeof send !== 'function') return false;
      try { const result = await send('Network.setCookie', value); return result?.success !== false; }
      catch (error) { failed(error); return false; }
    },
  };
}
