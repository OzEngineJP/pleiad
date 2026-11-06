// 隔離の origin の中身（/viz/<束のハッシュ>/…・/f/<鍵>/…。ADR 0292 の 3）。
// S0 では 404 を返すだけ。中身は A3 が置く（束の置き場は viz-blobs/、鍵は core/html-keys.mjs）。
import { sendStatus } from './page-listener.mjs';

/**
 * @param {object} [deps] サーバーから渡すもの（core/server.mjs が作る）
 * @param [deps.dataDir] データの置き場
 * @param [deps.ports]   () => { main, pages, isolated }
 * @param [deps.log]     ログの 1 行
 * @returns {{ handle(req, res, { url: URL }): any }}
 */
export function createIsolatedRoutes(deps = {}) {
  void deps;
  return {
    handle(req, res) { return sendStatus(req, res, 404, 'not found'); },
  };
}
