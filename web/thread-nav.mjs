// 作業のダイアログ（#workDialog）の読むだけの筋のための、会話の移動の部品（web/conversation-toc.mjs の nav）。
// 本体の会話の部品（web/conversation-nav-view.mjs の createConversationNav）は、筋の要素を 1 つ固定で持ち、最新へのボタン・
// 末尾の目印・全発言の位置の記憶まで抱える重いもの。ダイアログの筋は読み直しのたびに作り直され（refreshDetail が筋ごと差し替える）、
// 子の会話は短いので、ここは「いまの筋」を関数で引き、位置は必要なときに測るだけの軽い版にする。
// 目次が使う口（turns・turnInfo・currentIndex・goTo・scrollToRow・onUpdate）は本体と同じ形・同じ意味。
// 足した口は hasContent だけ（本体の会話は発言が無ければ空だが、読むだけの子には依頼文の無い筋があり、返答だけでも探せるようにする）。
// 本体との違い: 「最新へ」のボタンと、Alt+↑↓・End のキーは持たない（docs/design-system.md「バックグラウンド」）。
import { userPieces, piecesText } from './conversation-nav.mjs';
import { CHAT_ROWS } from './conversation-nav-view.mjs';

/** 上端から見て、この位置より上に始まった発言を「いまの発言」とする（本体と同じ） */
const PROBE = 48;
/** 行を会話欄の上端から離す距離（本体の goTo と同じ） */
const GAP = 12;

/**
 * @param {{ log:HTMLElement, thread:() => (HTMLElement|null), rows?:object }} o
 *   log は筋を入れてスクロールする要素（#workBody）、thread はいまの筋を返す関数
 */
export function createThreadNav({ log, thread, rows = CHAT_ROWS }) {
  let turns = [], raf = 0, settle = null;
  const texts = new WeakMap();
  const listeners = new Set();

  /** 発言の並び。同じ並びなら同じ配列を返す */
  const collect = () => {
    const th = thread();
    const users = th ? rows.users(th) : [];
    if (users.length === turns.length && users.every((user, i) => user === turns[i].user)) return turns;
    turns = users.map((user) => ({ user, row: rows.rowOf(user), top: 0 }));
    return turns;
  };
  const turnInfo = (turn) => {
    const body = rows.bodyOf(turn.user);
    const raw = body?.dataset.raw ?? body?.textContent ?? '';
    let text = texts.get(turn.user);
    if (text === undefined || text.raw !== raw) {
      text = { raw, pieces: userPieces(raw), at: rows.whenOf(turn.user) };
      text.plain = piecesText(text.pieces);
      texts.set(turn.user, text);
    }
    return text;
  };
  const currentIndex = () => {
    const list = collect();
    if (!list.length) return -1;
    const box = log.getBoundingClientRect().top;
    let current = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].row.getBoundingClientRect().top - box <= PROBE) current = i; else break;
    }
    return current;
  };

  /** 行の上端を会話欄の上端から gap の位置へ送る。画面の外の行は仮の高さなので、数フレームは合わせ直し、利用者が触れたらやめる（本体と同じ） */
  function scrollToRow(row, gap = GAP, onSettled = null) {
    settle?.abort();
    const run = settle = new AbortController();
    const want = () => (!row.isConnected ? log.scrollTop : row.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - gap);
    log.scrollTop = want();
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) log.addEventListener(type, () => run.abort(), { signal: run.signal, passive: true });
    let frames = 0, calm = 0;
    const tick = () => {
      if (run.signal.aborted) return;
      const target = want();
      if (Math.abs(target - log.scrollTop) > 1) { log.scrollTop = target; calm = 0; } else calm++;
      if (++frames > 30 || calm >= 3) { const aborted = run.signal.aborted; run.abort(); if (!aborted) onSettled?.(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const goTo = (index, onSettled = null) => {
    const list = collect();
    const turn = list[Math.max(0, Math.min(list.length - 1, index))];
    if (turn) scrollToRow(turn.row, GAP, onSettled);
  };

  const notify = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; for (const fn of listeners) fn(false); });
  };
  log.addEventListener('scroll', notify, { passive: true });
  // 筋が差し替わった（子を替えた・読み直した）。発言の増減はここで知らせる
  const threadWatch = new MutationObserver(notify);
  let watched = null;
  const watch = () => {
    const now = thread();
    if (now === watched) return;
    threadWatch.disconnect();
    watched = now;
    if (now) threadWatch.observe(now, { childList: true });
  };
  watch();
  new MutationObserver(() => { watch(); notify(); }).observe(log, { childList: true });

  return {
    hasContent: () => Boolean(thread()?.querySelector(':scope > .mw')),
    turns: collect,
    turnInfo,
    currentIndex,
    goTo,
    scrollToRow,
    refresh: notify,
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
