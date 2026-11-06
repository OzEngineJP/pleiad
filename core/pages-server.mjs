// ファイルのページのリスナー（http://localhost:<pages port>。ADR 0292 の 1・2）。
// /_pleiad/ の下だけを、ページの Cookie で認証してから core/pages-routes.mjs へ渡す（中身は A4）。
import { startPageListener, sendStatus } from './page-listener.mjs';
import { PAGES_PATH, PAGES_COOKIE, pageRequestOk, pagesSecret } from './page-auth.mjs';
import { ENTER_PATH } from './page-tickets.mjs';

/**
 * @param {object} options
 * @param {number} [options.port]   試す port（0 なら空いた port）
 * @param {number} [options.waitMs] 塞がっていたら待つ上限
 * @param {string} options.token    本体のトークン（ページの Cookie の値を作る元。core/page-auth.mjs）
 * @param {{ handle(req, res, { url, via }): any }} options.routes core/pages-routes.mjs の createPagesRoutes の返り値
 * @param {{ take(ticket): string|null }} [options.tickets] 既定のブラウザーで開くときの 1 回だけの入場券（core/page-tickets.mjs）。無ければ入口を開かない
 */
export function startPagesServer({ port = 0, waitMs = 0, token, routes, tickets = null, hosts, log = () => {} }) {
  return startPageListener({
    name: 'pages', port, waitMs, hosts, log,
    handle(req, res, { url }) {
      if (!url.pathname.startsWith(PAGES_PATH)) return sendStatus(req, res, 404, 'not found');
      // 入場券: OS から開いた既定のブラウザーにページの Cookie を置き、券を作ったときの行き先へ移す（ほかのページからの移動では使わない）
      if (url.pathname === ENTER_PATH) {
        const site = req.headers['sec-fetch-site'];
        const next = tickets && token && req.method === 'GET' && (site === undefined || site === 'none') ? tickets.take(url.searchParams.get('ticket')) : null;
        if (!next) return sendStatus(req, res, 401, 'unauthorized');
        res.writeHead(303, { location: next, 'cache-control': 'no-store',
          'set-cookie': `${PAGES_COOKIE}=${pagesSecret(token)}; HttpOnly; SameSite=Strict; Path=${PAGES_PATH}` });
        return res.end();
      }
      if (!pageRequestOk({ via: 'pages', cookie: req.headers.cookie, token, site: req.headers['sec-fetch-site'] })) return sendStatus(req, res, 401, 'unauthorized');
      return routes.handle(req, res, { url, via: 'pages' });
    },
  });
}
