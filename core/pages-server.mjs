// ファイルのページのリスナー（http://localhost:<pages port>。ADR 0292 の 1・2）。
// /_pleiad/ の下だけを、ページの Cookie で認証してから core/pages-routes.mjs へ渡す（中身は A4）。
import { startPageListener, sendStatus } from './page-listener.mjs';
import { PAGES_PATH, pageRequestOk } from './page-auth.mjs';

/**
 * @param {object} options
 * @param {number} [options.port]   試す port（0 なら空いた port）
 * @param {number} [options.waitMs] 塞がっていたら待つ上限
 * @param {string} options.token    本体のトークン（ページの Cookie の値を作る元。core/page-auth.mjs）
 * @param {{ handle(req, res, { url, via }): any }} options.routes core/pages-routes.mjs の createPagesRoutes の返り値
 */
export function startPagesServer({ port = 0, waitMs = 0, token, routes, hosts, log = () => {} }) {
  return startPageListener({
    name: 'pages', port, waitMs, hosts, log,
    handle(req, res, { url }) {
      if (!url.pathname.startsWith(PAGES_PATH)) return sendStatus(req, res, 404, 'not found');
      if (!pageRequestOk({ via: 'pages', cookie: req.headers.cookie, token })) return sendStatus(req, res, 401, 'unauthorized');
      return routes.handle(req, res, { url, via: 'pages' });
    },
  });
}
