// Pleiad のページ（/_pleiad/s/<会話 id>/<ページ>・/_pleiad/s/<会話 id>/api/…）の中身（ADR 0292 の 2、0291 の 2 の 5・6）。
// 2 つの入口（ファイルのページの port と本体の port の /_pleiad/）から、認証を済ませた要求だけが来る（core/page-auth.mjs）。
// S0 では 404 を返すだけ。中身は A4 が置く。
import { sendStatus } from './page-listener.mjs';

/**
 * @param {object} [deps] サーバーから渡すもの（core/server.mjs が作る）
 * @param [deps.ops]               (caller, id, input) => 操作の呼び出し（registry.invoke。caller は { by, via, sessionId? }）
 * @param [deps.store]             会話の台帳（core/store.mjs）
 * @param [deps.fileRoots]         (sessions) => プレビューのツリーの基準（読み取りの許可には使わない。ADR 0050）
 * @param [deps.fileAccessFor]     (sessionId) => ファイルの読み取りの範囲（inspectFile に渡す。審査モードは confine 付き）
 * @param [deps.resolveSessionFile] ({ path, sessionId, at, base }, sessions, roots) => 会話の中のファイル参照の絶対パス
 * @param [deps.ports]             () => { main, pages, isolated }（CSP の frame-src・frame-ancestors に使う）
 * @param [deps.log]               ログの 1 行
 * @returns {{ handle(req, res, { url: URL, via: 'pages'|'main' }): any }}
 */
export function createPagesRoutes(deps = {}) {
  void deps;
  return {
    handle(req, res) { return sendStatus(req, res, 404, 'not found'); },
  };
}
