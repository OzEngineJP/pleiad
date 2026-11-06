// 中継（core/chrome/relay.mjs）の、エージェントの操作（OPERATES）の前の門（ADR 0293 の 1）。
// S0 の既定は今の動きのまま（会話の一時停止 entry.paused の間だけ断る）。中身は A6 が置き換える（タブごとの持ち手・60 秒・戻した後の 1 回の断り）。

// i18n-ignore: エージェントへの断りの文。会話の言語に依らず、日本語と英語を並べる（中継は言語を持たない）
export const PAUSED_MESSAGE = 'The user is operating the Chrome window now (paused). Call hand_to_user and wait until they hand it back. / 人が Chrome のウィンドウを操作中です（一時停止）。hand_to_user を呼んで、戻るのを待ってください';

/**
 * @param {object} [deps]
 * @param [deps.emit] (type, payload) => 中継の出来事（relay.onTabEvent）。持ち手が替わったら 'tab:holder'
 * @param [deps.now]  時計（試験が差し替える）
 * @param [deps.log]  ログの 1 行
 * @returns 中継が呼ぶ口
 *   - gate({ sessionId, targetId, method, paused }): 断る文（エージェントへ返る）か null。paused は会話の一時停止（entry.paused）
 *   - forget({ sessionId, targetId }): タブが無くなった
 */
export function createTabHolder({ emit = () => {}, now = Date.now, log = () => {} } = {}) {
  void emit; void now; void log;
  return {
    gate: ({ paused }) => (paused ? PAUSED_MESSAGE : null),
    forget: () => {},
  };
}
