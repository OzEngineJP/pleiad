// 作業のダイアログ（#workDialog）の読むだけの筋のための、会話の移動の部品（web/conversation-toc.mjs の nav）。
// 本体の会話の部品（web/conversation-nav-view.mjs の createConversationNav）は、筋の要素を 1 つ固定で持ち、最新へのボタン・
// 末尾の目印・全発言の位置の記憶まで抱える重いもの。ダイアログの筋は読み直しのたびに作り直され（refreshDetail が筋ごと差し替える）、
// 子の会話は短いので、ここは「いまの筋」を関数で引き、位置は必要なときに測るだけの軽い版にする。
// 目次が使う口（turns・turnInfo・currentIndex・goTo・scrollToRow・onUpdate）は本体と同じ形・同じ意味。
// 足した口は hasContent だけ（本体の会話は発言が無ければ空だが、読むだけの子には依頼文の無い筋があり、返答だけでも探せるようにする）。
// frame を渡すと、本体と同じ「最新へ」のボタン（.nav-latest）と、Alt+↑↓・End のキーも持つ（会話の移動。docs/design-system.md「会話の移動」）。
// 本体との違い: 新着の青い丸は出さない（筋は読み直しのたびに作り直すので、届いた返答を数えられない）。位置は測るだけで記憶しない。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { userPieces, piecesText } from './conversation-nav.mjs';
import { CHAT_ROWS } from './conversation-nav-view.mjs';

/** 上端から見て、この位置より上に始まった発言を「いまの発言」とする（本体と同じ） */
const PROBE = 48;
/** 行を会話欄の上端から離す距離（本体の goTo と同じ） */
const GAP = 12;
/** 末尾からこの距離（px）以上離れたときだけ「最新へ」を出す（本体と同じ） */
const AWAY = 120;

/**
 * @param {{ log:HTMLElement, thread:() => (HTMLElement|null), rows?:object, frame?:HTMLElement, keys?:EventTarget, skip?:string, isRunning?:() => boolean }} o
 *   log は筋を入れてスクロールする要素（#workBody）、thread はいまの筋を返す関数。
 *   frame は log を包む相対位置の入れ物（最新へを置く先。省くと最新へ・キーは持たない）。
 *   keys はキーを受ける先（ダイアログ。最前面で開いている間、前面の筋に効かせる）、skip はそのキーを奪わない所の selector（一覧・右の欄など）
 */
export function createThreadNav({ log, thread, rows = CHAT_ROWS, frame = null, keys = null, skip = '', isRunning = () => false }) {
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
    settleScroll(() => (!row.isConnected ? log.scrollTop : row.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - gap), onSettled);
  }
  function settleScroll(want, onSettled = null) {
    settle?.abort();
    const run = settle = new AbortController();
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

  // ---- 最新へ（本体の createConversationNav と同じボタン・同じ文言）
  let latest = null, latestState = '', runningMark = null;
  if (frame) {
    latest = el('button', 'nav-latest');
    latest.type = 'button';
    latest.hidden = true;
    latest.setAttribute('aria-keyshortcuts', 'End');
    const arrow = svgEl('svg', { class: 'i nav-arrow', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    arrow.append(svgEl('path', { d: 'M12 5v14M6 13l6 6 6-6' }));
    latest.append(arrow);
    frame.append(latest);
    // 会話の本文はキーボードで届き、Alt+↑↓・End が効く領域（本体の #log と同じ）
    log.tabIndex = 0;
    log.setAttribute('role', 'region');
    log.setAttribute('aria-label', t('nav.log.label'));
    log.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown End');
  }
  const away = () => log.scrollHeight - log.clientHeight - log.scrollTop > AWAY;
  function paintLatest() {
    if (!latest) return;
    const off = away() && Boolean(thread());
    // 末尾へ戻って消えるとき、ボタンにあったフォーカスは会話へ返す（body に落とさない）
    if (!off && !latest.hidden && latest.contains(document.activeElement)) log.focus({ preventScroll: true });
    if (latest.hidden === off) latest.hidden = !off;
    const running = isRunning();
    if (`${running}` !== latestState) {
      latestState = `${running}`;
      latest.classList.toggle('running', running);
      const label = running ? t('nav.latest.withNote', { note: t('nav.latest.running') }) : t('nav.latest.label');
      latest.setAttribute('aria-label', label);
      latest.title = label;
    }
    if (running && off && !runningMark) { runningMark = runMark(); latest.prepend(runningMark); }
    else if ((!running || !off) && runningMark) { runningMark.remove(); runningMark = null; }
  }
  function toLatest() {
    const hadFocus = Boolean(latest?.contains(document.activeElement));
    // 画面の外の行は仮の高さなので、数フレームは合わせ直す（scrollToRow と同じ）
    settleScroll(() => log.scrollHeight - log.clientHeight);
    if (hadFocus) log.focus({ preventScroll: true });
  }
  /** いまの位置より前（direction < 0）・後に始まる発言。無ければ -1（本体の neighbour と同じ規則） */
  function neighbour(direction) {
    const list = collect();
    const box = log.getBoundingClientRect().top, y = log.scrollTop;
    const tops = list.map((turn) => turn.row.getBoundingClientRect().top - box + y - GAP);
    if (direction < 0) { for (let i = tops.length - 1; i >= 0; i--) if (tops[i] < y - 2) return i; return -1; }
    return tops.findIndex((top) => top > y + 2);
  }
  latest?.addEventListener('click', toLatest);
  keys?.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || !thread()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('input,textarea,select,[contenteditable="true"],[role="slider"],[role="menu"],.pop')) return;
    if (skip && target.closest(skip)) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const index = neighbour(event.key === 'ArrowUp' ? -1 : 1);
      event.preventDefault();
      if (index >= 0) goTo(index);
    } else if (event.key === 'End' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (target === log || !target.closest('summary,button,a,pre'))) {
      event.preventDefault();
      toLatest();
    }
  });

  const notify = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; paintLatest(); for (const fn of listeners) fn(false); });
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
    scrollToRow, neighbour, toLatest,
    refresh: notify,
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
