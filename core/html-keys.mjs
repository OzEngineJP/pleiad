// HTML のファイルを隔離の origin で読ませる鍵（ADR 0292 の 3 の 1）。ファイルのページの api/html-key（core/pages-routes.mjs）が出し、
// 隔離の /f/<鍵>/…（core/isolated-routes.mjs）が引く。サーバーが 1 つだけ作り、両方へ同じものを渡す（core/server.mjs）。
// S0 では鍵を出さない。中身は A3 が置く（128 ビットの乱数・HTML のファイルのフォルダーに結ぶ・メモリだけ・24 時間かサーバーの終わりで消える）。

/**
 * @param {object} [deps]
 * @param [deps.now] 時計（試験が差し替える）
 * @param [deps.log] ログの 1 行（パスを書かない）
 * @returns
 *   - issue({ sessionId, path }): 鍵（文字列）か null。path は ADR 0050 の検査を通した後の HTML のファイルの実体のパス
 *   - resolve(key): { sessionId, root（鍵で読めるフォルダー）, entry（HTML のファイルの相対パス） } か null
 *   - close(): 全部捨てる
 */
export function createHtmlKeys({ now = Date.now, log = () => {} } = {}) {
  void now; void log;
  return {
    issue: () => null,
    resolve: () => null,
    close: () => {},
  };
}
