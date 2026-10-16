// 入力欄の ↑ で送信済みのメッセージを呼び出す（docs/design-system.md「入力欄の呼び出しと候補」。設定 › 入力でオン・オフ）。
//
// - ↑ が効くのは、カーソルが一番上の行（見た目の行）にあり、範囲を選んでいないときだけ。↓ は呼び出している間の一番下の行で
// - 最初の ↑ で書きかけ（字と添付）を脇へ取る。↓ で一番新しいものを越えるか Esc で戻す。呼び出した文を直したら、それが新しい書きかけになる
// - 呼び出した直後のカーソルは先頭（↓ なら末尾）。↑ を続けて押せば遡れる
// - 欄の上に「3 / 5 · 10/14 18:20 · 会話名」の行を出す（ほかの会話の分だけ会話名。Esc の印を押しても戻る）
// - 順と中身は呼び出し側（load）が決める（この会話 → ほかの会話の新しい順。`!` の形では `!` で送ったコマンドだけ）
// 欄に字を入れる・添付を戻すのも呼び出し側（put）。ここは位置と行と、キーを取るかの判断だけを持つ。
import { el, icon } from '../dom.mjs';
import { fmt } from '../i18n.mjs';

const HISTORY_ICON = 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2';
const SWAP_MS = 120;

/** 呼び出した時刻の言い方。今日なら時刻、それより前なら月日と時刻 */
export function recallWhen(at, now = Date.now()) {
  const ms = Date.parse(at ?? '');
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toDateString() === new Date(now).toDateString()
    ? fmt.time(ms, { hour: '2-digit', minute: '2-digit' })
    : fmt.dateTime(ms, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * カーソルが欄の一番上（edge: 'top'）・一番下（'bottom'）の見た目の行にあるか。
 * 論理の行（改行）で先に見て、同じ段落が折り返しているときは位置で見る（折り返した 2 行目の ↑ はふつうに上へ動く）
 */
export function caretAtEdge(prompt, edge) {
  const value = String(prompt.value ?? '');
  if (!value) return true;
  const start = prompt.selectionStart ?? 0, end = prompt.selectionEnd ?? 0;
  if (start !== end) return false;
  if (edge === 'top' ? value.lastIndexOf('\n', start - 1) !== -1 : value.indexOf('\n', end) !== -1) return false;
  const sel = globalThis.getSelection?.();
  if (!sel?.rangeCount || !prompt.contains?.(sel.anchorNode)) return true;
  const range = sel.getRangeAt(0).cloneRange();
  const rect = range.getClientRects?.()[0] ?? null;
  const block = edge === 'top' ? prompt.firstElementChild : prompt.lastElementChild;
  if (!rect || !block || (!rect.height && !rect.top)) return true;
  const box = block.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(prompt).lineHeight) || 22;
  return edge === 'top' ? rect.top - box.top < line * 0.8 : box.bottom - rect.bottom < line * 0.8;
}

const plainArrow = (e) => !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;

/**
 * @param {object} o
 * @param {HTMLElement} o.prompt 字の欄（web/md-editor.mjs。value・selectionStart・setSelectionRange を持つ）
 * @param {HTMLElement} o.box 入力の箱（.cbox）。行は字の欄のすぐ上に置く
 * @param {Function} o.t 訳
 * @param {() => boolean} o.enabled 設定がオンか
 * @param {() => boolean} o.blocked いま ↑ を取らない（候補の一覧が開いている・編集中・書けない待ち）
 * @param {() => boolean} o.shell `!` の形か（`!` で送ったコマンドだけを辿る）
 * @param {(o: { shell: boolean }) => Promise<Array<{ sessionId, title, at, text }>>} o.load 呼び出す並び（新しい順）
 * @param {() => string|null} o.current いまの会話の id（ほかの会話の分にだけ会話名を出す）
 * @param {() => object} o.take 書きかけを取る（{ text, ... }）
 * @param {(draft: object) => void} o.restore 書きかけを戻す
 * @param {(item: object) => void} o.put 呼び出したものを欄に入れる
 */
export function createRecall({ prompt, box, t, enabled, blocked = () => false, shell = () => false, load, current = () => null, take, restore, put }) {
  let items = null;       // 読んだ並び（最初の ↑ で読む）
  let loadedFor = null;   // 並びを読んだときの形（'text' | 'shell'）と会話
  let idx = -1;           // 呼び出している位置（-1 = 書きかけ）
  let draft = null;       // 脇へ取った書きかけ
  let shown = null;       // 欄に入れた字（直したかを見分ける）
  let loading = null;
  let swapTimer = null;

  const row = el('div', 'recall-row');
  row.setAttribute('role', 'status');
  row.setAttribute('aria-live', 'polite');
  const pos = el('span', 'recall-pos');
  const from = el('span', 'recall-from');
  const esc = el('button', 'recall-esc kc', 'Esc');
  esc.type = 'button';
  esc.title = t('chat.recall.backToDraft');
  esc.setAttribute('aria-label', t('chat.recall.backToDraft'));
  esc.addEventListener('mousedown', (e) => e.preventDefault());
  esc.onclick = () => { back(); prompt.focus?.(); };
  row.append(icon(HISTORY_ICON), pos, from, el('span', 'recall-sp'), esc);
  box.insertBefore(row, prompt);

  const active = () => idx >= 0;

  function paintRow() {
    const item = active() ? items[idx] : null;
    row.classList.toggle('on', Boolean(item));
    if (!item) return;
    pos.textContent = `${idx + 1} / ${items.length}`;
    const when = recallWhen(item.at);
    const other = item.sessionId && item.sessionId !== current();
    const parts = [when, other ? (item.title || t('session.untitled')) : ''].filter(Boolean);
    from.textContent = parts.length ? `· ${parts.join(' · ')}` : '';
    from.title = from.textContent.slice(2);
  }

  function swap(down) {
    clearTimeout(swapTimer);
    prompt.classList.remove('recall-swap', 'down');
    void prompt.offsetWidth;
    prompt.classList.add('recall-swap');
    if (down) prompt.classList.add('down');
    swapTimer = setTimeout(() => prompt.classList.remove('recall-swap', 'down'), SWAP_MS + 40);
  }

  function show(down) {
    const item = active() ? items[idx] : null;
    if (item) put(item); else restore(draft);
    shown = String(prompt.value ?? '');
    const at = down ? shown.length : 0;
    prompt.setSelectionRange?.(at, at);
    if (!item) { draft = null; shown = null; }
    swap(down);
    paintRow();
  }

  function back() {
    if (!active()) return;
    idx = -1;
    show(true);
  }

  async function ensureItems() {
    const kind = shell() ? 'shell' : 'text';
    const key = `${kind}|${current() ?? ''}`;
    if (items && loadedFor === key) return items;
    loading ??= load({ shell: kind === 'shell' }).then((list) => { items = Array.isArray(list) ? list : []; loadedFor = key; return items; })
      .finally(() => { loading = null; });
    return loading;
  }

  async function up() {
    const list = await ensureItems();
    if (!list.length || idx >= list.length - 1) return;
    if (idx === -1) draft = take();
    idx += 1;
    show(false);
  }

  return {
    row,
    get active() { return active(); },
    /** 入力欄の keydown（送信より先）。取ったら true */
    keydown(e) {
      if (!enabled() || blocked() || prompt.readOnly) return false;
      if (e.key === 'Escape' && active()) { e.preventDefault(); back(); return true; }
      if (!plainArrow(e)) return false;
      if (e.key === 'ArrowUp' && caretAtEdge(prompt, 'top')) {
        if (active() && idx >= (items?.length ?? 0) - 1) return false;
        e.preventDefault();
        void up();
        return true;
      }
      if (e.key === 'ArrowDown' && active() && caretAtEdge(prompt, 'bottom')) {
        e.preventDefault();
        idx -= 1;
        show(true);
        return true;
      }
      return false;
    },
    /** 字の欄の input。呼び出した文を直したら、呼び出しは終わり（それが新しい書きかけ） */
    input() {
      if (!active() || String(prompt.value ?? '') === shown) return;
      idx = -1; draft = null; shown = null;
      paintRow();
    },
    /** 呼び出している間なら、動きを付けずに書きかけへ戻す（会話を替える前。呼び出した文を下書きとして保存しない） */
    release() {
      if (!active()) return;
      idx = -1;
      restore(draft);
      draft = null; shown = null;
      paintRow();
    },
    /** 会話を替えた・送った。並びは次の ↑ で読み直す（書きかけは戻さない。替えた先の書きかけが入る） */
    reset() {
      idx = -1; draft = null; shown = null; items = null; loadedFor = null;
      paintRow();
    },
  };
}
