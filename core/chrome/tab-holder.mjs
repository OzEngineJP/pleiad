// 中継（core/chrome/relay.mjs）の、エージェントの操作（OPERATES）の前の門（ADR 0293 の 1）。
// タブごとに操作の持ち手（ai / human）・人の操作の始まり・どの画面から触ったか・最後に触った時刻を持つ。
//   - 人がタブに触るとそのタブは人の操作になり、そのタブへのエージェントの操作のコマンドは HUMAN_MESSAGE で断る
//     （読むコマンド・ほかのタブの操作は通る。同じウィンドウの別のタブでエージェントは続けられる）
//   - AI に戻すのは、最後に触ってから 60 秒・「任せる」（releaseAll）・「PC で操作する」の窓を画面の外へ戻したとき。
//     AI が hand_to_user で人に頼んでいる間（handoffs.current）と、PC の窓を出している間（pinned）は時間では戻さない
//   - 戻した直後のそのタブへの最初の操作のコマンドは 1 回だけ RESNAPSHOT_MESSAGE で断る
//     （古い snapshot の参照で、入力の途中のフォームをエージェントが送らないため）
//   - 会話の一時停止（entry.paused。「止める」・旗が off の引き継ぎ）の間は、タブの持ち手に関係なく全部 PAUSED_MESSAGE で断る
// 手元の拡大・移動（映像を見るためのもの）では人の操作に移さない（呼び手が送らない）。
// 旗 AGENT_HOST_BROWSER_UNIFY が off なら、人の操作に移す呼び口を呼ぶものが無いので、今の動き（一時停止だけを断る）のまま。

// i18n-ignore: エージェントへの断りの文。会話の言語に依らず、日本語と英語を並べる（中継は言語を持たない）
export const PAUSED_MESSAGE = 'The user is operating the Chrome window now (paused). Call hand_to_user and wait until they hand it back. / 人が Chrome のウィンドウを操作中です（一時停止）。hand_to_user を呼んで、戻るのを待ってください';
// i18n-ignore: 同上。人の操作のタブへの操作を断る文
export const HUMAN_MESSAGE = 'A person is operating this tab. Do not touch it until they finish. Continue in another tab, or wait and take a fresh snapshot. / 人がこのタブを操作しています。終わるまで、このタブには触らないでください。ほかのタブで続けるか、待ってから snapshot を撮り直してください';
// i18n-ignore: 同上。人の操作から戻した直後の最初の操作を 1 回だけ断る文
export const RESNAPSHOT_MESSAGE = 'A person has touched this tab. Take a fresh snapshot before operating it. / 人が触った後です。snapshot を撮り直してから操作してください';

/** 人の操作から AI に戻すまでの、最後に触ってからの時間（ADR 0293 の 1 の 4） */
export const HUMAN_TIMEOUT_MS = 60_000;
/** hand_to_user の頼みの最中に、時間で戻すかを見直す周期 */
export const DEFER_RECHECK_MS = 5_000;

/**
 * @param {object} [deps]
 * @param [deps.emit] (type, payload) => 中継の出来事（relay.onTabEvent）。持ち手・触った画面・最後に触った時刻が変わったら 'tab:holder'。
 *   payload は { sessionId, targetId, holder: 'human', by, since, last, pinned, viewport } か { sessionId, targetId, holder: 'ai' }
 * @param [deps.now]  時計（試験が差し替える）
 * @param [deps.log]  ログの 1 行（URL・題を書かない）
 * @param [deps.timeoutMs] 人の操作から AI に戻す時間（既定 60 秒。試験が短くするためのもの）
 * @param [deps.recheckMs] hand_to_user の最中の見直しの周期（既定 5 秒。試験用）
 * @returns 中継が呼ぶ口
 *   - gate({ sessionId, targetId, method, paused }): 断る文（エージェントへ返る）か null。paused は会話の一時停止（entry.paused）
 *   - forget({ sessionId, targetId }): タブが無くなった。targetId が無ければ会話の持ち手を全部捨てる
 *   - attach({ handoffs }): サーバーが起動のときに 1 回呼ぶ。handoffs は core/chrome/handoff.mjs の台帳（current(sessionId) で hand_to_user の頼みの最中か）
 *   人の側の呼び口（control・組 B が relay.unify.tabHolder で呼ぶ）:
 *   - touch({ sessionId, targetId, by, viewport }): 人がタブに触った（映像の上の操作・アドレスバー・ページのメニュー・スマホのページ内の移動）。
 *     by はどの画面から触ったか（'device'・'pc' などの札）、viewport は端末の映像の箱（{ width, height, scale }。大きさの決め方が読む）
 *   - holdByPc({ sessionId, targetId }): 「PC で操作する」。そのタブを人の操作にし、窓を出している間は時間で戻さない（pinned）
 *   - release(sessionId, targetId): 1 つのタブを AI に戻す（窓を画面の外へ戻したとき）
 *   - releaseAll(sessionId): 「任せる」。その会話の人の操作のタブを全部 AI に戻す
 *   - holder(sessionId, targetId): そのタブの今の持ち手（emit と同じ形）
 *   - held(sessionId): その会話の人の操作のタブの一覧
 *   - rebind(from, to): 会話の id が替わった（中継の rebind に合わせる口。呼ぶものが無ければ無害）
 */
export function createTabHolder({ emit = () => {}, now = Date.now, log = () => {}, timeoutMs = HUMAN_TIMEOUT_MS, recheckMs = DEFER_RECHECK_MS } = {}) {
  const sessions = new Map();   // 会話の id -> Map<タブの id, 持ち手の記録>
  let handoffs = null;          // hand_to_user の台帳（attach で受ける）
  let timer = null;             // いちばん早い期限の見張り（実時間。now が試験の時計でも呼び直しで帳尻を合わせる）

  const tabsOf = sessionId => sessions.get(sessionId);
  const shape = tab => tab.holder === 'human'
    ? { holder: 'human', by: tab.by ?? null, since: tab.since ?? null, last: tab.last ?? null, pinned: tab.pinned === true, ...(tab.viewport ? { viewport: { ...tab.viewport } } : {}) }
    : { holder: 'ai' };
  /** hand_to_user の頼みの最中か（台帳が投げても「最中」にしない） */
  const asking = sessionId => { try { return Boolean(handoffs?.current?.(sessionId)); } catch { return false; } };
  const tell = (sessionId, targetId, payload) => { try { emit('tab:holder', { sessionId, targetId, ...payload }); } catch (error) { log(`chrome-tab-holder: emit failed: ${error?.message ?? error}`); } };

  /** いちばん早い期限に見張りを合わせる（pinned のタブは期限を持たない） */
  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    let next = Infinity;
    for (const [sessionId, tabs] of sessions) {
      for (const tab of tabs.values()) {
        if (tab.holder !== 'human' || tab.pinned) continue;
        const deadline = asking(sessionId) ? now() + recheckMs : tab.last + timeoutMs;
        if (deadline < next) next = deadline;
      }
    }
    if (!Number.isFinite(next)) return;
    timer = setTimeout(expire, Math.max(0, next - now()));
    timer.unref?.();
  }

  /** 期限を過ぎた人の操作を AI に戻す。頼みの最中の会話は戻さず、頼みが終わってからの見直しに任せる */
  function expire() {
    const time = now();
    for (const [sessionId, tabs] of [...sessions]) {
      for (const [targetId, tab] of [...tabs]) {
        if (tab.holder !== 'human' || tab.pinned || asking(sessionId) || time - tab.last < timeoutMs) continue;
        release(sessionId, targetId);
      }
    }
    schedule();
  }

  /** タブを人の操作にする（触るたびに最後に触った時刻を更新する）。pinned なら時間では戻さない */
  function mark(sessionId, targetId, { by = null, pinned = false, viewport = null } = {}) {
    if (typeof sessionId !== 'string' || typeof targetId !== 'string' || !sessionId || !targetId) return;
    let tabs = sessions.get(sessionId);
    if (!tabs) { tabs = new Map(); sessions.set(sessionId, tabs); }
    let tab = tabs.get(targetId);
    const before = tab ? JSON.stringify(shape(tab)) : null;
    if (!tab) tabs.set(targetId, tab = { holder: 'ai', by: null, since: null, last: 0, pinned: false, viewport: null, resnapshot: false });
    tab.holder = 'human';
    if (before === null || JSON.parse(before).holder !== 'human') tab.since = now();
    tab.last = now();
    if (by != null) tab.by = String(by).slice(0, 60);
    if (pinned) tab.pinned = true;
    if (viewport && typeof viewport === 'object') tab.viewport = { width: viewport.width, height: viewport.height, scale: viewport.scale };
    schedule();
    if (JSON.stringify(shape(tab)) !== before) tell(sessionId, targetId, shape(tab));
  }

  /** タブを AI に戻す。戻した直後の最初の操作のコマンドを 1 回だけ断る印を付ける */
  function release(sessionId, targetId) {
    const tab = tabsOf(sessionId)?.get(targetId);
    if (!tab || tab.holder !== 'human') return false;
    Object.assign(tab, { holder: 'ai', by: null, since: null, last: 0, pinned: false, viewport: null, resnapshot: true });
    tell(sessionId, targetId, { holder: 'ai' });
    schedule();
    return true;
  }

  return {
    // ---- 中継が呼ぶ口
    gate({ sessionId, targetId, paused }) {
      expire();   // 期限の見直し（時計が進んだ分）
      if (paused) return PAUSED_MESSAGE;
      const tab = tabsOf(sessionId)?.get(targetId);
      if (tab?.holder === 'human') return HUMAN_MESSAGE;
      if (tab?.resnapshot) { tab.resnapshot = false; return RESNAPSHOT_MESSAGE; }
      return null;
    },
    forget({ sessionId, targetId }) {
      if (targetId == null) sessions.delete(sessionId);
      else {
        const tabs = tabsOf(sessionId);
        tabs?.delete(targetId);
        if (tabs && !tabs.size) sessions.delete(sessionId);
      }
      schedule();
    },
    attach({ handoffs: next } = {}) { handoffs = next ?? null; schedule(); },

    // ---- 人の側の呼び口
    touch({ sessionId, targetId, by = null, viewport = null }) { mark(sessionId, targetId, { by, viewport }); },
    holdByPc({ sessionId, targetId }) { mark(sessionId, targetId, { by: 'pc', pinned: true }); },
    release,
    releaseAll(sessionId) {
      let count = 0;
      for (const targetId of [...(tabsOf(sessionId)?.keys() ?? [])]) if (release(sessionId, targetId)) count += 1;
      return count;
    },
    holder(sessionId, targetId) {
      const tab = tabsOf(sessionId)?.get(targetId);
      return tab ? shape(tab) : { holder: 'ai' };
    },
    held(sessionId) {
      const list = [];
      for (const [targetId, tab] of tabsOf(sessionId) ?? []) if (tab.holder === 'human') list.push({ targetId, ...shape(tab) });
      return list;
    },
    rebind(from, to) {
      if (from === to || !sessions.has(from)) return;
      if (sessions.has(to)) return;   // 新しい id に既に記録があるときは、古い分を混ぜない
      sessions.set(to, sessions.get(from));
      sessions.delete(from);
      schedule();
    },
  };
}
