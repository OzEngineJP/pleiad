// 隔離の origin のリスナー（http://localhost:<isolated port>。ADR 0295 の 1・3）。
// 可視化と HTML のファイルの中身を出す。Cookie は見ない（URL の鍵だけ）。中身は core/isolated-routes.mjs（A3）。
import { startPageListener } from './page-listener.mjs';

/**
 * @param {object} options
 * @param {number} [options.port]   試す port（0 なら空いた port）
 * @param {number} [options.waitMs] 塞がっていたら待つ上限
 * @param {{ handle(req, res, { url }): any }} options.routes core/isolated-routes.mjs の createIsolatedRoutes の返り値
 */
export function startIsolatedServer({ port = 0, waitMs = 0, routes, hosts, log = () => {} }) {
  return startPageListener({
    name: 'isolated', port, waitMs, hosts, log,
    handle: (req, res, { url }) => routes.handle(req, res, { url }),
  });
}
