// 記憶の自動整理の状態の決まり（DOM に触れない。設定 › 記憶 › bot と、bot のページの「自動整理: …」の導線が使う。docs/design-system.md「設定 › 記憶」）。
// 材料は memory.learnStatus の返り（core/ops/memory.mjs）と、整理に使うエージェントの受動のログイン状態（probe なし）。
// 検査は tests/unit/memory-model.mjs。
import { shortTime } from './channels/bot-model.mjs';
//
// パネルの状態は優先度の高い順に 1 つ:
//   off          … 自動整理が止まっている（設定の実効 OFF。旧 memoryLearnPaused も OFF 扱い）
//   running      … いま走っている
//   halted       … 失敗で自動再試行をやめた（明示の「もう一度」か再有効化で戻る。再起動で残っている停止を未確認の認証で隠さない）
//   failed       … 一時的な失敗。自動再試行を待っている
//   authWait     … 整理に使うエージェントのログインが切れていると確定
//   unconfirmed  … 受動では分からない（［接続を確認］で明示確認 = agents.authStatus に probe:true）
//   waiting      … 次の予定を待っている
// 認証の未確定（out / unconfirmed）は補助情報: 止まっている・失敗しているときはその状態と［もう一度］を残した上で、認証の注記と入口を添える。

/** 自動整理が動くか。新しい core は status.enabled が実効値（memoryAutoLearn && !memoryLearnPaused）。
    無いときは設定キーで決める（memoryAutoLearn が欠けたままの利用者は OFF。paused の逆にはしない） */
export const learnEnabledOf = (status, prefs) =>
  typeof status?.enabled === 'boolean' ? status.enabled
    : prefs?.memoryAutoLearn === true && prefs?.memoryLearnPaused !== true;

/** 確定の未ログインだけ true。unconfirmed（受動で分からない）・pending（確認中）は「切れている」ではない */
export const authOutOf = (st) =>
  st?.supported === true && st.installed !== false && st.loggedIn === false && !st.pending && !st.unconfirmed;

/** 受動で分からない（明示の確認で確かめる） */
export const authUnconfirmedOf = (st) =>
  st?.supported === true && st.installed !== false && st.unconfirmed === true && !st.pending;

/** 設定 › 記憶 › bot の状態の行。actions は settings.memory.act.<name> のボタン。authNote は止まった状態の脇に出す認証の注記 */
export function learnPanelView(status, { enabled, authOut, unconfirmed } = {}) {
  const authNote = authOut ? 'authWait' : unconfirmed ? 'unconfirmed' : null;
  if (!enabled) return { mode: 'off', actions: [] };
  if (status?.running) return { mode: 'running', actions: [] };
  const stopped = (kind) => ({
    mode: kind, warn: true, authNote,
    actions: authOut ? ['login', 'retry'] : unconfirmed ? ['check', 'retry'] : ['retry'],
  });
  if (status?.halted) return stopped('halted');
  if (status?.failure) return stopped('failed');
  if (authOut) return { mode: 'authWait', actions: ['login'], warn: true };
  if (unconfirmed) return { mode: 'unconfirmed', actions: ['check', 'now'] };
  return { mode: 'waiting', actions: ['now'] };
}

/** bot のページの導線ボタンの短い状態（認証までは見ない。失敗・停止はどちらも「失敗」。詳しくは設定 › 記憶 を開く） */
export function learnRouteView(status, { enabled } = {}) {
  if (!status) return { key: 'open' };
  if (!enabled) return { key: 'off' };
  if (status.running) return { key: 'running' };
  if (status.halted || status.failure) return { key: 'failed' };
  return { key: 'next', params: { at: status.nextAt ? shortTime(status.nextAt) : '' } };
}
