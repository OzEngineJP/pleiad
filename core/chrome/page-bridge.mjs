// 中継（core/chrome/relay.mjs）の、Pleiad のページから Pleiad への頼み（plyPage の binding）を受ける口（ADR 0292 の 2 の 5）。
// S0 の既定は何もしない。中身は B4 が置き換え、頼みを 'tab:page-request' で出す。

/**
 * @param {object} [deps]
 * @param [deps.emit]  (type, payload) => 中継の出来事（relay.onTabEvent）。頼みが届いたら 'tab:page-request'
 * @param [deps.ports] () => { main, pages, isolated }（Pleiad のページのタブかを見分ける）
 * @param [deps.log]   ログの 1 行
 * @returns 中継が呼ぶ口。tab は core/chrome/tab-info.mjs と同じ形
 *   - added(tab): タブが会話の範囲に入った（binding を付けるなら tab.attach で中継のセッションを付ける）
 *   - changed(tab): targetInfo が替わった
 *   - removed({ sessionId, targetId }): タブが無くなった
 */
export function createPageBridge({ emit = () => {}, ports = () => null, log = () => {} } = {}) {
  void emit; void ports; void log;
  return { added: () => {}, changed: () => {}, removed: () => {} };
}
