// 空の入力欄にグレーで出す、次のメッセージの候補（docs/design-system.md「入力欄の呼び出しと候補」。設定 › 入力でオン・オフ）。
//
// - 候補は案内（placeholder）と同じ弱い字。見分けるため末尾に Tab の印を付け、案内は隠す。長い候補は折り返し、欄もその高さまで伸ばす
// - 出ている間だけ Tab は「候補を入れる」（Shift+Tab はフォーカスの移動のまま）。何か打つと消え、欄を空に戻すとまた出る
// - 候補は送らない: 空の欄で Ctrl/⌘+Enter を押しても何も送らない（打たずに送ってしまうのを防ぐ）。代わりに Tab の印が 0.7 秒だけ青い輪で光り、読み上げに「Tab で候補を入れます」
// - Esc で候補を消す（120ms で薄れる）。次の返答で新しい候補が届くまで出さない
// - タッチの画面（Tab が無い）は、欄の右に「候補を入れる」の丸いボタン（Tab の記号 ⇥。下へ移動の矢印と取り違えない）。
//   ボタンは欄が使える間だけ出す: 欄か祖先が inert の間（設定が会話を覆っている・引き出しが開いている）は隠す。
//   ボタンは欄の上に重ねる z-index を持つので、出したままだと欄を覆う面（設定のページ）の上に浮く
// - 読み上げは欄の説明（aria-description）に「候補: …」
// - 出るときは 240ms で薄く出る（動きを減らす設定では即座に）
// 候補を会話ごとに持つのは呼び出し側（web/client.mjs）。ここは 1 つの欄の表示とキーだけ。
import { el, icon } from '../dom.mjs';

const ACCEPT_ICON = 'M4 12h12M11 7l5 5-5 5M20 5v14';
const FADE_MS = 120;
const NUDGE_MS = 700;

/**
 * @param {object} o
 * @param {HTMLElement} o.prompt 字の欄（web/md-editor.mjs）
 * @param {HTMLElement} o.box 入力の箱（.cbox）。候補は字の欄に重ねる
 * @param {Function} o.t 訳
 * @param {() => boolean} o.touch タッチの画面か
 * @param {() => boolean} o.enabled 設定がオンか
 * @param {() => boolean} o.blocked いま出さない（シェルの形・編集中・↑ で呼び出している・書けない待ち・返答の途中）
 * @param {(text: string) => void} o.accept 候補を欄に入れる（字を入れ、下書きを保存する）
 * @param {(text: string) => void} [o.announce] 読み上げに知らせる
 * @param {() => void} [o.dismiss] Esc で消した（呼び出し側が持つ候補も捨てる）
 * @param {() => void} [o.painted] 出す・隠すを決め直した（欄の右のボタンの位置を分け合う部品へ）
 */
export function createSuggestion({ prompt, box, t, touch = () => false, enabled, blocked = () => false, accept,
  announce = () => {}, dismiss = () => {}, painted = () => {} }) {
  let text = null;
  let visible = false;
  let fadeTimer = null;
  let nudgeTimer = null;
  const ghost = el('div', 'composer-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  const body = el('span', 'cg-text');
  const key = el('kbd', 'kc cg-key', 'Tab');
  ghost.append(body, key);
  const take = el('button', 'cg-take');
  take.type = 'button';
  take.setAttribute('aria-label', t('chat.suggestion.accept'));
  take.title = t('chat.suggestion.accept');
  take.append(icon(ACCEPT_ICON));
  take.addEventListener('mousedown', (e) => e.preventDefault());
  take.onclick = () => { if (visible) use(); };
  prompt.insertAdjacentElement('afterend', ghost);
  ghost.insertAdjacentElement('afterend', take);

  const empty = () => !String(prompt.value ?? '').length;
  // 欄が使えない（自分か祖先が inert）。覆った面の上にボタンだけが残らないように見る
  const covered = () => Boolean(prompt.closest('[inert]'));
  const syncTake = () => { take.hidden = !visible || !touch() || covered(); };

  function place() {
    ghost.style.top = `${prompt.offsetTop}px`;
    ghost.style.left = `${prompt.offsetLeft}px`;
    ghost.style.width = `${prompt.offsetWidth}px`;
    take.style.top = `${prompt.offsetTop + 6}px`;
  }

  function paint(fade = false) {
    const next = Boolean(text) && enabled() && !blocked() && empty() && !prompt.readOnly;
    const touchMode = touch();
    clearTimeout(fadeTimer);
    ghost.classList.remove('out');
    if (next) {
      body.textContent = text;
      key.hidden = touchMode;
      ghost.classList.toggle('touch', touchMode);
      place();
      if (!visible) { ghost.classList.remove('on'); requestAnimationFrame(() => requestAnimationFrame(() => { if (visible) ghost.classList.add('on'); })); }
      ghost.hidden = false;
      take.hidden = !touchMode || covered();
      prompt.dataset.ghost = touchMode ? 'touch' : '1';
      prompt.style.minHeight = `${ghost.offsetHeight}px`;
      prompt.setAttribute('aria-description', t('chat.suggestion.described', { text }));
    } else if (fade && visible) {
      // Esc で消す: 字は 120ms で薄れてから隠す（その間も欄の高さは保つ）
      ghost.classList.add('out');
      ghost.classList.remove('on');
      take.hidden = true;
      prompt.removeAttribute('aria-description');
      fadeTimer = setTimeout(() => {
        ghost.classList.remove('out');
        ghost.hidden = true;
        delete prompt.dataset.ghost;
        prompt.style.minHeight = '';
      }, FADE_MS);
    } else {
      ghost.hidden = true;
      ghost.classList.remove('on');
      take.hidden = true;
      delete prompt.dataset.ghost;
      prompt.style.minHeight = '';
      prompt.removeAttribute('aria-description');
    }
    visible = next;
    painted();
  }

  /** 空の欄の Ctrl/⌘+Enter: 送らずに、Tab の印を光らせる */
  function nudge() {
    clearTimeout(nudgeTimer);
    key.classList.remove('nudge');
    void key.offsetWidth;
    key.classList.add('nudge');
    nudgeTimer = setTimeout(() => key.classList.remove('nudge'), NUDGE_MS + 80);
    announce(t('chat.suggestion.useTab'));
  }

  function use() {
    const value = text;
    text = null;
    paint();
    accept(value);
  }

  ghost.hidden = true;
  take.hidden = true;
  // 位置は出した瞬間の 1 回では決まらない: 欄の上の行（↑ の呼び出しの行など）が 240ms で開閉する間も欄は動くので、
  // 箱の大きさが変わるたびと、箱の中の動きが終わったときに測り直す
  const replace = () => { if (visible) { place(); prompt.style.minHeight = `${ghost.offsetHeight}px`; } };
  addEventListener('resize', replace);
  if (typeof ResizeObserver === 'function') new ResizeObserver(replace).observe(box);
  box.addEventListener?.('transitionend', replace);
  // 欄を覆う側（設定の画面・引き出し）は inert を付け外しするだけで、ここへは知らせない。欄と祖先の inert の変化を見て、ボタンを付け直す
  if (typeof MutationObserver === 'function') {
    const watch = new MutationObserver(syncTake);
    for (let node = prompt; node; node = node.parentElement) watch.observe(node, { attributes: true, attributeFilter: ['inert'] });
  }

  return {
    get text() { return text; },
    get visible() { return visible; },
    /** 出す候補を替える（null で消す） */
    set(value) { text = typeof value === 'string' && value.trim() ? value : null; paint(); },
    /** 欄の中身・状態が変わった（input・フォーカス・会話の切り替え・送信） */
    refresh: () => paint(),
    /** 入力欄の keydown（送信より先）。Tab で入れたら true */
    keydown(e) {
      if (!visible) return false;
      const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
      if (e.key === 'Tab' && plain) { e.preventDefault(); use(); return true; }
      if (e.key === 'Escape' && plain) { e.preventDefault(); text = null; paint(true); dismiss(); return true; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) { e.preventDefault(); nudge(); return true; }
      return false;
    },
  };
}
