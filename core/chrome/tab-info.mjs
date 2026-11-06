// 中継（core/chrome/relay.mjs）の、タブごとの情報（URL・題・読み込み中・戻る進む・favicon）を集める口（ADR 0291 の 2）。
// S0 の既定は何もしない。中身は A5 が置き換え、集めた情報を 'tab:info' で出す。

/**
 * @param {object} [deps]
 * @param [deps.emit] (type, payload) => 中継の出来事（relay.onTabEvent）。情報が変わったら 'tab:info'
 * @param [deps.log]  ログの 1 行（URL・題を書かない）
 * @returns 中継が呼ぶ口。tab は { sessionId, targetId, windowId, info（Target の targetInfo の写し）, attach(onEvent) }。
 *   attach は中継自身のセッションをそのタブに付ける（relay.view.attach と同じ形の { sessionId, send, detach } を返す）
 *   - added(tab): タブが会話の範囲に入った
 *   - changed(tab): targetInfo が替わった（URL・題）
 *   - removed({ sessionId, targetId }): タブが無くなった
 */
export function createTabInfo({ emit = () => {}, log = () => {} } = {}) {
  void emit; void log;
  return { added: () => {}, changed: () => {}, removed: () => {} };
}
