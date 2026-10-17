// 入力欄の ↑ で送信済みのメッセージを呼び出す（docs/design-system.md「入力欄の呼び出しと候補」。設定 › 入力でオン・オフ）。
//
// - ↑ が効くのは、カーソルが一番上の行（見た目の行）にあり、範囲を選んでいないときだけ。↓ は呼び出している間の一番下の行で
// - 最初の ↑ で書きかけ（字と添付）を脇へ取る。↓ で一番新しいものを越えるか Esc で戻す。呼び出した文を直したら、それが新しい書きかけになる
// - 呼び出した直後のカーソルは先頭（↓ なら末尾）。↑ を続けて押せば遡れる
// - 欄の上に「3 / 5 · 10/14 18:20 [会話名]」の行を出す（ほかの会話の分だけ、吹き出しのアイコンと会話名の札。Esc の印を押しても戻る）
// - 一番古いものでさらに ↑ を押したら、数が小さく跳ねる（これ以上は無い合図）
// - タッチの画面（↑ のキーが無い）: 欄が空で候補も無いとき、欄の右に履歴のボタン。行の右端は Esc の印の代わりに「前へ」「次へ」「閉じる」
// - 順と中身は呼び出し側（load）が決める（この会話 → ほかの会話の新しい順。`!` の形では `!` で送ったコマンドだけ）
// - 並びは欄にフォーカスが来た・会話を替えたときに先に読む（prefetch）。読み終わる前の ↑ は、150ms 過ぎたら行に「読み込み中…」を出して待つ。
//   待つ間の ↑ は重ねない。待つ間に字を打った・会話を替えたら、読み終えても欄に入れない
// 欄に字を入れる・添付を戻すのも呼び出し側（put）。ここは位置と行と、キーを取るかの判断だけを持つ。
import { el, icon } from '../dom.mjs';
import { fmt } from '../i18n.mjs';

const HISTORY_ICON = 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2';
const CONV_ICON = 'M4 5h16v11H9l-5 4z';
const OLDER_ICON = 'M18 15l-6-6-6 6';
const NEWER_ICON = 'M6 9l6 6 6-6';
const CLOSE_ICON = 'M6 6l12 12M18 6L6 18';
const BUMP_MS = 220;
const SWAP_MS = 120;
const WAIT_SHOW_MS = 150;
const PREFETCH_MS = 250;

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
 * @param {() => boolean} [o.touch] タッチの画面か（履歴のボタンと、行の「前へ」「次へ」「閉じる」）
 * @param {() => boolean} [o.covered] 欄の右のボタンの位置が埋まっている（候補を入れるボタンが出ている）
 */
export function createRecall({ prompt, box, t, enabled, blocked = () => false, shell = () => false, load, current = () => null, take, restore, put,
  touch = () => false, covered = () => false }) {
  let items = null;       // 読んだ並び（最初の ↑ で読む）
  let loadedFor = null;   // 並びを読んだときの形（'text' | 'shell'）と会話
  let idx = -1;           // 呼び出している位置（-1 = 書きかけ）
  let draft = null;       // 脇へ取った書きかけ
  let shown = null;       // 欄に入れた字（直したかを見分ける）
  let loading = null;     // 読んでいる途中の並び（loadingKey の分）
  let loadingKey = null;
  let waiting = false;    // ↑ を押して並びを待っている
  let waitTimer = null;
  let prefetchTimer = null;
  let swapTimer = null;
  let bumpTimer = null;
  let lastOther = false;  // 前に出した分がほかの会話のものだったか（札が入る動きは、移った 1 回目だけ）

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
  const conv = el('span', 'recall-conv');
  const convName = el('span');
  conv.append(icon(CONV_ICON), convName);
  conv.hidden = true;
  const rowButton = (path, label, act) => {
    const b = el('button', 'recall-btn');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(path));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.onclick = act;
    b.hidden = true;
    return b;
  };
  const older = rowButton(OLDER_ICON, t('chat.recall.older'), () => stepUp());
  const newer = rowButton(NEWER_ICON, t('chat.recall.newer'), () => stepDown());
  const close = rowButton(CLOSE_ICON, t('chat.recall.backToDraft'), () => back());
  row.append(icon(HISTORY_ICON), pos, from, conv, el('span', 'recall-sp'), esc, older, newer, close);
  box.insertBefore(row, prompt);
  // タッチの画面の履歴のボタン（欄が空で候補も無いときだけ。候補を入れるボタンと同じ位置）
  const open = el('button', 'recall-open');
  open.type = 'button';
  open.title = t('chat.recall.open');
  open.setAttribute('aria-label', t('chat.recall.open'));
  open.append(icon(HISTORY_ICON));
  open.addEventListener('mousedown', (e) => e.preventDefault());
  open.onclick = () => { void up(); };
  open.hidden = true;
  prompt.insertAdjacentElement('afterend', open);

  const active = () => idx >= 0;

  function paintRow() {
    const item = active() ? items[idx] : null;
    const touchMode = touch();
    row.classList.remove('loading');
    esc.hidden = touchMode;
    older.hidden = newer.hidden = close.hidden = !touchMode;
    row.classList.toggle('on', Boolean(item));
    if (!item) { lastOther = false; paintOpen(); return; }
    pos.textContent = `${idx + 1} / ${items.length}`;
    const when = recallWhen(item.at);
    from.textContent = when ? `· ${when}` : '';
    from.title = when;
    const other = Boolean(item.sessionId && item.sessionId !== current());
    conv.hidden = !other;
    if (other) {
      const name = item.title || t('session.untitled');
      convName.textContent = name;
      conv.title = name;
      if (!lastOther) { conv.classList.remove('enter'); void conv.offsetWidth; conv.classList.add('enter'); }
    }
    lastOther = other;
    older.disabled = idx >= items.length - 1;
    paintOpen();
  }

  /** 履歴のボタン（タッチの画面だけ）。欄が空・呼び出していない・候補のボタンが出ていないときに、欄の右上に置く */
  function paintOpen() {
    const show = touch() && enabled() && !blocked() && !prompt.readOnly && !active() && !waiting && !String(prompt.value ?? '').length && !covered();
    open.hidden = !show;
    if (show) { open.style.top = `${prompt.offsetTop + 6}px`; prompt.dataset.recallOpen = '1'; }
    else delete prompt.dataset.recallOpen;
  }
  // 欄の上の行が開閉する間も欄は動くので、箱の大きさが変わるたびに置き直す
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (!open.hidden) paintOpen(); }).observe(box);
  box.addEventListener?.('transitionend', () => { if (!open.hidden) paintOpen(); });

  /** 一番古いものでさらに ↑: 数が小さく跳ねる */
  function bump() {
    clearTimeout(bumpTimer);
    pos.classList.remove('bump');
    void pos.offsetWidth;
    pos.classList.add('bump');
    bumpTimer = setTimeout(() => pos.classList.remove('bump'), BUMP_MS + 80);
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

  /** ↑・「前へ」: 古い方へ。一番古いものなら跳ねるだけ */
  function stepUp() {
    if (active() && idx >= (items?.length ?? 0) - 1) { bump(); return; }
    void up();
  }

  /** ↓・「次へ」: 新しい方へ。一番新しいものを越えたら書きかけへ戻る */
  function stepDown() {
    if (!active()) return;
    idx -= 1;
    show(true);
  }

  /** 並びの持ち主（形と会話）。替わったら読み直す */
  const keyNow = () => `${shell() ? 'shell' : 'text'}|${current() ?? ''}`;
  const ready = () => Boolean(items) && loadedFor === keyNow();

  async function ensureItems() {
    const key = keyNow();
    if (items && loadedFor === key) return items;
    if (loading && loadingKey === key) return loading;
    const p = load({ shell: key.startsWith('shell|') }).then((list) => {
      if (loading === p) { items = Array.isArray(list) ? list : []; loadedFor = key; }
      return Array.isArray(list) ? list : [];
    }).finally(() => { if (loading === p) { loading = null; loadingKey = null; } });
    loading = p; loadingKey = key;
    return p;
  }

  /** 待っている間の行（「読み込み中…」）。150ms 以内に読み終えたら出さない */
  function paintWait() {
    pos.textContent = t('chat.recall.loading');
    from.textContent = ''; from.title = '';
    conv.hidden = true;
    esc.hidden = older.hidden = newer.hidden = close.hidden = true;
    row.classList.add('on', 'loading');
  }

  /** 並びを先に読んでおく（欄にフォーカスが来た・会話を替えた・送った）。続けて呼ばれたら最後の 1 回だけ */
  function prefetch() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      if (enabled() && !ready()) ensureItems().catch(() => {});
    }, PREFETCH_MS);
  }
  prompt.addEventListener?.('focus', prefetch);

  async function up() {
    if (waiting) return;
    let list = items;
    if (!ready()) {
      const key = keyNow(), before = String(prompt.value ?? '');
      waiting = true;
      paintOpen();
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => { if (waiting) paintWait(); }, WAIT_SHOW_MS);
      try { await ensureItems(); } catch { /* 読めなければ何も入れない */ } finally { waiting = false; clearTimeout(waitTimer); }
      // 待つ間に打った・会話や形を替えた（並びを捨てた）・書けなくなったなら入れない
      if (String(prompt.value ?? '') !== before || keyNow() !== key || !ready() || prompt.readOnly || !enabled()) { paintRow(); return; }
      list = items;
    }
    if (!list.length || idx >= list.length - 1) { paintRow(); return; }
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
        e.preventDefault();
        stepUp();
        return true;
      }
      if (e.key === 'ArrowDown' && active() && caretAtEdge(prompt, 'bottom')) {
        e.preventDefault();
        stepDown();
        return true;
      }
      return false;
    },
    /** 字の欄の input。呼び出した文を直したら、呼び出しは終わり（それが新しい書きかけ） */
    input() {
      if (active() && String(prompt.value ?? '') !== shown) { idx = -1; draft = null; shown = null; paintRow(); }
      else paintOpen();
    },
    /** 欄・候補・設定が変わった（履歴のボタンを出すかを決め直す） */
    refresh: paintOpen,
    /** 呼び出している間なら、動きを付けずに書きかけへ戻す（会話を替える前。呼び出した文を下書きとして保存しない） */
    release() {
      if (!active()) return;
      idx = -1;
      restore(draft);
      draft = null; shown = null;
      paintRow();
    },
    /** 会話を替えた・送った。並びは読み直す（書きかけは戻さない。替えた先の書きかけが入る）。読んでいる途中の古い並びも使わない */
    reset() {
      idx = -1; draft = null; shown = null; items = null; loadedFor = null; loading = null; loadingKey = null;
      paintRow();
      if (prompt.contains?.(globalThis.document?.activeElement)) prefetch();
    },
  };
}
