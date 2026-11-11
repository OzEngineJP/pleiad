// 子の会話のモーダル（#workDialog）の本文を、出来事に合わせて読み直すための部品（ADR 0315 の段 2）。
// 読み直し本体は web/client.mjs の refreshDetail。ここは「いつ読み直すか」だけを決める（描画は触らない）。
//
//  - どの出来事がこの詳細のものか（followsEvent）
//  - 続けて来る出来事を間引く（createDetailGate。先頭はすぐ、続きは間隔を空けて 1 回にまとめる）
//  - 入力中・文字の選択中は読み直しを待たせる（shouldHold）
//  - 読み直しで作り直す DOM のうち、フォーカスだけは同じ場所へ戻す（markFocus / restoreFocus）
import { streamEvents } from './session-stream.mjs';

/** 出来事の読み直しの最短の間隔。読み込みが重いときは、読み込みの時間に合わせて空ける（gapFor） */
export const FOLLOW_MIN_MS = 400;
export const FOLLOW_MAX_MS = 3000;
/** ネイティブのサブエージェントは親の会話の出来事の一部でしか動かないので、間隔を長めに取る */
export const SUBAGENT_MIN_MS = 1000;
/** 出来事が届く詳細の、取りこぼしに備えた読み直し（running の配信ごとに読んでいた従来の 2.5 秒の代わり） */
export const FOLLOW_INSURANCE_MS = 10000;

/** 子の会話の出来事のうち読み直しのきっかけにするもの。承認は見ている会話に関わらず届く（streamEvents には含まれない） */
const TASK_EVENTS = new Set([...streamEvents, 'permission', 'permissionSettled']);
/** サブエージェントは親の会話の中で動く。親の本文の流れ（text.delta など）は関係が薄いので、道具・活動・承認・終わりだけ */
const SUBAGENT_EVENTS = new Set(['tool.start', 'tool.result', 'activity', 'turnResult', 'turnEnd', 'taskNotice', 'permission', 'permissionSettled']);
/** 待たせずに読み直す出来事（承認のカードが出る・消える、ターンの終わり） */
const URGENT_EVENTS = new Set(['permission', 'permissionSettled', 'turnEnd']);

/**
 * この項目の詳細に、出来事が届く道があるか。
 * 'task': 委譲した子（モーダルの口で見ている会話の出来事が届く）。
 * 'subagent': 開いている会話のサブエージェント（親の会話の出来事が届く）。親が別の子の会話などで出来事が届かないものは null（従来どおり配信で読み直す）。
 * ホストに任せた子（item.host）・コマンドは出来事が届かない。
 */
export function followMode(item, current) {
  if (!item) return null;
  if (item.group === 'command') return null;
  if (item.source === 'task') return item.host || !item.childId ? null : 'task';
  if (item.parentId && item.parentId === current) return 'subagent';
  return null;
}

/** この出来事は、その詳細を読み直すきっかけか。返り値は null（無関係）か { urgent } */
export function followsEvent(item, current, ev) {
  if (!ev || typeof ev.type !== 'string' || !ev.sessionId) return null;
  const mode = followMode(item, current);
  if (mode === 'task') {
    if (ev.sessionId !== item.childId || !TASK_EVENTS.has(ev.type)) return null;
  } else if (mode === 'subagent') {
    if (ev.sessionId !== item.parentId || !SUBAGENT_EVENTS.has(ev.type)) return null;
  } else return null;
  return { urgent: URGENT_EVENTS.has(ev.type) };
}

/** 直前の読み直しにかかった時間（ms）から、次の読み直しまで空ける間隔を決める。軽ければ最短、重ければ時間の 2 倍（上限あり） */
export function gapFor(lastReadMs, min = FOLLOW_MIN_MS) {
  const spent = Number.isFinite(lastReadMs) ? lastReadMs : 0;
  return Math.min(FOLLOW_MAX_MS, Math.max(min, Math.round(spent * 2)));
}

/**
 * 読み直しの間引き。poke() のたびに、先頭の 1 回はすぐ（前の読み直しから間隔が空いていれば）、
 * 間隔の内に来た分は間隔が明けたときの 1 回にまとめる。urgent は待たずに今読む（予定している分は取り消す）。
 * cancel() の後は何も走らない（詳細を閉じた・別の項目へ替えた）。
 */
export function createDetailGate({ run, gap = () => FOLLOW_MIN_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let last = -Infinity;
  let timer = null;
  let cancelled = false;
  const fire = (urgent = false) => {
    timer = null;
    if (cancelled) return;
    last = now();
    run({ urgent });
  };
  return {
    poke({ urgent = false } = {}) {
      if (cancelled) return false;
      if (timer) {
        if (!urgent) return true;     // もう予定している。1 回にまとめる
        clearTimer(timer); timer = null;
      }
      const wait = urgent ? 0 : Math.max(0, last + gap() - now());
      if (wait === 0) fire(urgent); else timer = setTimer(() => fire(false), wait);
      return true;
    },
    /** ほかの道（配信・最初の読み込み）で読んだことを知らせる。この時刻から間隔を数える */
    note() { last = now(); },
    cancel() { cancelled = true; if (timer) { clearTimer(timer); timer = null; } },
    get pending() { return timer != null; },
    get cancelled() { return cancelled; },
  };
}

/**
 * 読み直しを待たせるか。入力中（文字を打っている欄がある）は、承認でも待たせる（打った文字が消えるので）。
 * 文字を選んでいる間は、普段は待たせる（読み直すと選びが外れる）が、承認の出入りは待たせない。
 */
export function shouldHold({ typing = false, selecting = false, urgent = false } = {}) {
  return Boolean(typing) || (Boolean(selecting) && !urgent);
}

const FIELD = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';
const FOCUSABLE = 'button,a[href],summary,input,textarea,select,[tabindex]';

/** 本文の中の、文字を打てる欄にフォーカスがあるか */
export function typingIn(root, active) {
  return Boolean(active && root?.contains?.(active) && active.matches?.(FIELD));
}

/** 本文の中で文字を選んでいるか（何も選んでいない・外にある選びは false） */
export function selectingIn(root, selection) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  return Boolean(root?.contains?.(range.commonAncestorContainer));
}

/** フォーカスがある要素を、作り直した後に探し直せる印にする（行の data-key と、行の中の何番目か）。本文の外・印を付けられない所は null */
export function markFocus(root, active) {
  if (!active || active === root || !root?.contains?.(active)) return null;
  const row = active.closest?.('.mw[data-key]');
  if (!row || !root.contains(row)) return null;
  const index = [...row.querySelectorAll(FOCUSABLE)].indexOf(active);
  return index < 0 ? null : { key: row.dataset.key, index };
}

/** markFocus の印の場所へ、位置を動かさずにフォーカスを戻す。行が無くなっていたら何もしない */
export function restoreFocus(root, mark) {
  if (!mark || !root) return false;
  const row = [...root.querySelectorAll('.mw[data-key]')].find(x => x.dataset.key === mark.key);
  const target = row ? [...row.querySelectorAll(FOCUSABLE)][mark.index] : null;
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}
