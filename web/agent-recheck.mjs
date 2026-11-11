// 案内・空の会話の一覧・設定のエージェントの面が見えている間、裏で状態を読み直す（docs/desktop-onboarding.md「使えるエージェントが無いとき」）。
// 4 秒おき（使えるようになったのを 5 秒以内に見つける）・窓が前面のときだけ・10 分で止める。窓が前面へ戻ったときは、止めた後でも 1 回すぐ確かめる。
// 入れ終わった・ログインし終えたことを、再起動なしで見つけるため。見つけた行の見せ方は web/agent-row.mjs の paintAgentRows

const foreground = () => document.visibilityState === 'visible' && document.hasFocus();

/**
 * @param {object} o
 * @param {() => boolean} o.visible  対象の面のどれかが見えているか
 * @param {() => Promise<unknown>} o.check  状態を読み直す（失敗しても止めない）
 */
export function createRecheck({ visible, check, intervalMs = 4000, capMs = 10 * 60 * 1000, now = () => Date.now() }) {
  let since = null, running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await check(); } catch { /* 次の周期で読み直す */ } finally { running = false; }
  };
  function tick() {
    if (!visible() || !foreground()) { since = null; return; }
    since ??= now();
    if (now() - since > capMs) return;
    run();
  }
  const timer = setInterval(tick, intervalMs);
  const back = () => { if (foreground() && visible()) run(); };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
  return { tick, stop() { clearInterval(timer); window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); } };
}
