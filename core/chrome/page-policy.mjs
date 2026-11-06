// 中継（core/chrome/relay.mjs）の移動の検査と、エージェントのコマンドの前後のふるい（ADR 0292 の 2 の 4）。
// S0 の既定は今の動きのまま（移動は safeUrl だけ・ふるいは素通し・要求は止めない）。中身は A2 が置き換える（本体の port を断る・pleiad_* の Cookie を隠す）。
// 中継は会話の窓のタブのことしか渡さない。URL はログに書かない。

/** http(s)（認証情報なし）と about:blank だけ */
export function safeUrl(value) {
  try { const url = new URL(value); return (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) || url.href === 'about:blank'; }
  catch { return false; }
}

/**
 * @param {object} [deps]
 * @param [deps.ports] () => { main, pages, isolated }（数。立っていなければ null）。サーバーが relay.setPagePorts で渡したもの
 * @param [deps.log]   ログの 1 行（URL を書かない）
 * @returns 中継が呼ぶ口
 *   - allowUrl(url, { sessionId, via }): 移動を通すか。via は 'navigate'（Page.navigate）・'create'（Target.createTarget）・'open'（人がビューアから開く）
 *   - before({ sessionId, targetId, method, params }): 上りへ送る引数（そのまま返すか、変えた写しを返す）。断るなら Error を投げる（文はエージェントへ返る）
 *   - after({ sessionId, targetId, method, params, result }): エージェントへ返す結果
 *   - intercepts: true なら、確認（confirmAgentSites）が OFF でも中継のセッションをタブに付け、fetchPatterns の要求を止めて request に聞く
 *   - fetchPatterns(patterns): 中継のセッションの Fetch.enable の patterns（既定は確認のための主フレームの Document だけ）
 *   - request({ sessionId, targetId, url, resourceType, frameId }): 止めた要求を 'block' で失敗させる。null なら今の扱い（確認）へ
 */
export function createPagePolicy({ ports = () => null, log = () => {} } = {}) {
  void ports; void log;
  return {
    allowUrl: url => safeUrl(url),
    before: ({ params }) => params,
    after: ({ result }) => result,
    intercepts: false,
    fetchPatterns: patterns => patterns,
    request: () => null,
  };
}
