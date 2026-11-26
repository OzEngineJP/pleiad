// 入力欄の bot の宛先の塊（ADR 0359）。本文の `@名前` のうち、今の bot の名前に当たるものを、顔＋名前の 1 つの塊（span.mb）に見せる。
// 文書（Markdown）は `@名前` のまま変えない。塊は contenteditable=false の span で、中の字（隠した `@` と名前）は
// web/md-editor.mjs の読みではただの字として数える（span・button は書式の印ではないので透ける。walk・Range.toString）。
// 塊の中にキャレットは置かない（md-editor の posToDom が手前か後ろへ寄せる）。
// 消し方: 塊の隣での Backspace / Delete（塊の直後の空白 1 つを挟んでもよい）と、塊の ×（「宛先から外す」）。どちらも塊ごと消える。
// 打っている途中（キャレットが名前の直後）と、変換の途中は塊にしない。コードの行・コード・リンクの中も塊にしない。
import { el, icon } from '../dom.mjs';
import { botIcon, botColorVar } from './bot-icon.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { t } from '../i18n.mjs';

const fold = (s) => String(s ?? '').normalize('NFKC').toLowerCase();
// `@` の直前に来てよい字（行頭・空白・日本語・開き括弧・読点。mention-complete.mjs の mentionToken と同じ）
const BEFORE = /[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}（(「『、。，,]/u;
// 名前の直後に来てよい字（core/channels/mentions.mjs と同じ。`_` と `-` は名前の続き）
const isBoundaryAfter = (ch) => ch === undefined || (!/[_-]/.test(ch) && /[\s\p{P}\p{S}]/u.test(ch));
const SPACE = /^[  ]/;

/**
 * 字の中の `@名前`（bot の名前に当たるもの）の位置。長い名前を先に見る。
 * @param {string} text
 * @param {{ id: string, name: string }[]} bots
 * @param {{ caret?: number|null }} [o] caret … この位置で終わる名前は塊にしない（打っている途中）
 * @returns {{ start: number, end: number, bot: object }[]}
 */
export function findMentionBlocks(text, bots, { caret = null } = {}) {
  const s = String(text ?? '');
  const list = (bots ?? []).filter((b) => b?.id && String(b.name ?? '').trim()).sort((a, b) => b.name.length - a.name.length);
  const out = [];
  if (!list.length) return out;
  for (let i = s.indexOf('@'); i >= 0; i = s.indexOf('@', i + 1)) {
    if (i > 0 && !BEFORE.test(s[i - 1])) continue;
    for (const bot of list) {
      const end = i + 1 + bot.name.length;
      if (end > s.length || fold(s.slice(i + 1, end)) !== fold(bot.name)) continue;
      if (!isBoundaryAfter(s[end]) || end === caret) continue;
      out.push({ start: i, end, bot });
      i = end - 1;
      break;
    }
  }
  return out;
}

const X_PATH = 'M7 7l10 10M17 7L7 17';

/** 塊の要素。text は文書の字（`@名前`）。そのまま中に持つ */
export function mentionBlock(bot, text) {
  const b = el('span', 'mb');
  b.contentEditable = 'false';
  b.dataset.bot = bot.id;
  b.dataset.name = bot.name;
  b.style.setProperty('--bot-color', botColorVar(bot));
  const face = botIcon(bot, 'mention-av mb-face');
  face.setAttribute('aria-hidden', 'true');
  const x = el('button', 'mx');
  x.type = 'button';
  x.tabIndex = -1;
  x.dataset.act = 'unmention';
  x.setAttribute('aria-label', t('channels:feed.mention.remove'));
  x.append(icon(X_PATH));
  b.append(face, el('span', 'mb-at', text.slice(0, 1)), el('span', 'mb-nm', text.slice(1)), x);
  return b;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.input 編集欄（web/md-editor.mjs。value・selectionStart / End・setSelectionRange を持つ）
 * @param {() => { id: string, name: string, color?: number }[]} o.bots 塊にする bot（毎回呼ぶ）
 * @returns {{ decorate: () => void, keydown: (e: KeyboardEvent) => boolean }}
 */
export function setupMentionBlocks({ input, bots }) {
  let composing = false;
  const focused = () => document.activeElement === input;

  /** 名前が変わった・消えた bot の塊を字に戻す */
  function unwrapStale(list) {
    for (const mb of input.querySelectorAll('.mb')) {
      const bot = list.find((b) => b.id === mb.dataset.bot);
      const text = mb.textContent;
      if (bot && fold(text.slice(1)) === fold(bot.name)) continue;
      mb.replaceWith(document.createTextNode(text));
    }
  }

  function decorate() {
    if (composing) return;
    const list = (bots() ?? []).filter((b) => b?.id && b?.name);
    unwrapStale(list);
    if (!list.length) return;
    const sel = getSelection();
    let saved = null;
    for (const row of input.querySelectorAll(':scope > .md-b')) {
      if (row.dataset.k === 'code' || row.dataset.k === 'att') continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const n of nodes) {
        if (!n.nodeValue.includes('@') || n.parentElement?.closest('code, a, .mb')) continue;
        const caret = sel?.isCollapsed && sel.anchorNode === n ? sel.anchorOffset : null;
        const found = findMentionBlocks(n.nodeValue, list, { caret });
        if (!found.length) continue;
        // 文書は変わらないので、Markdown の位置で選択を覚えておき、描き直した後に戻す
        saved ??= focused() ? [input.selectionStart, input.selectionEnd] : null;
        for (const m of found.reverse()) {
          n.splitText(m.end);
          const mid = n.splitText(m.start);
          mid.replaceWith(mentionBlock(m.bot, mid.nodeValue));
        }
      }
    }
    if (saved) input.setSelectionRange(saved[0], saved[1]);
  }

  /** 塊を消す（直後の空白 1 つも）。md-editor は DOM を読み直して履歴に積む（input） */
  function remove(mb) {
    const parent = mb.parentNode;
    if (!parent) return;
    const next = mb.nextSibling;
    if (next?.nodeType === 3 && SPACE.test(next.nodeValue)) next.nodeValue = next.nodeValue.slice(1);
    const at = [...parent.childNodes].indexOf(mb);
    mb.remove();
    input.focus();
    getSelection().setBaseAndExtent(parent, at, parent, at);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }

  const isBlock = (n) => n?.nodeType === 1 && n.classList.contains('mb');

  /** キャレットの隣の塊（dir: -1 は手前、1 は後ろ）。手前は、間に空白 1 つを挟んでもよい（`@名前 ` の直後の Backspace） */
  function adjacent(node, off, dir) {
    const inside = (node.nodeType === 1 ? node : node.parentElement)?.closest('.mb');
    if (inside && input.contains(inside)) return inside;
    if (node.nodeType === 3) {
      const v = node.nodeValue;
      if (dir < 0) {
        if (off === 0 || (off === 1 && SPACE.test(v))) return isBlock(node.previousSibling) ? node.previousSibling : null;
        return null;
      }
      return off >= v.length && isBlock(node.nextSibling) ? node.nextSibling : null;
    }
    const n = dir < 0 ? node.childNodes[off - 1] : node.childNodes[off];
    return isBlock(n) ? n : null;
  }

  /** Backspace / Delete で塊ごと消す。取ったら true */
  function keydown(e) {
    if (isComposingKey(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
    const s = getSelection();
    if (!s?.rangeCount || !s.isCollapsed || !input.contains(s.anchorNode)) return false;
    const mb = adjacent(s.anchorNode, s.anchorOffset, e.key === 'Backspace' ? -1 : 1);
    if (!mb) return false;
    e.preventDefault();
    remove(mb);
    return true;
  }

  input.addEventListener('compositionstart', () => { composing = true; });
  // md-editor は変換の後の読み直しを次の tick で行う。その後で塊にする
  input.addEventListener('compositionend', () => { composing = false; setTimeout(decorate, 0); });
  input.addEventListener('input', decorate);
  // × は押してもキャレットを動かさない（mousedown を止める）。click で外す
  input.addEventListener('mousedown', (e) => { if (e.target.closest?.('.mb .mx')) e.preventDefault(); });
  input.addEventListener('click', (e) => {
    const x = e.target.closest?.('.mb .mx');
    if (!x || !input.contains(x)) return;
    e.preventDefault();
    remove(x.closest('.mb'));
  });

  return { decorate, keydown };
}
