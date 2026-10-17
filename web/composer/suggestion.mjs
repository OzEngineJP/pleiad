// 空の入力欄にグレーで出す、次のメッセージの候補（docs/design-system.md「入力欄の呼び出しと候補」。設定 › 入力でオン・オフ）。
//
// - 候補は案内（placeholder）と同じ弱い字。見分けるため末尾に Tab の印を付け、案内は隠す。長い候補は折り返し、欄もその高さまで伸ばす
// - 出ている間だけ Tab は「候補を入れる」（Shift+Tab はフォーカスの移動のまま）。何か打つと消え、欄を空に戻すとまた出る
// - 候補は送らない: 空の欄で Ctrl/⌘+Enter を押しても何も送らない（打たずに送ってしまうのを防ぐ）
// - タッチの画面（Tab が無い）は、欄の右に「候補を入れる」の丸いボタン
// - 読み上げは欄の説明（aria-description）に「候補: …」
// - 出るときは 240ms で薄く出る（動きを減らす設定では即座に）
// 候補を会話ごとに持つのは呼び出し側（web/client.mjs）。ここは 1 つの欄の表示とキーだけ。
import { el, icon } from '../dom.mjs';

const ACCEPT_ICON = 'M12 5v14M5 12l7 7 7-7';

/**
 * @param {object} o
 * @param {HTMLElement} o.prompt 字の欄（web/md-editor.mjs）
 * @param {HTMLElement} o.box 入力の箱（.cbox）。候補は字の欄に重ねる
 * @param {Function} o.t 訳
 * @param {() => boolean} o.touch タッチの画面か
 * @param {() => boolean} o.enabled 設定がオンか
 * @param {() => boolean} o.blocked いま出さない（シェルの形・編集中・↑ で呼び出している・書けない待ち・返答の途中）
 * @param {(text: string) => void} o.accept 候補を欄に入れる（字を入れ、下書きを保存する）
 */
export function createSuggestion({ prompt, box, t, touch = () => false, enabled, blocked = () => false, accept }) {
  let text = null;
  let visible = false;
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

  function place() {
    ghost.style.top = `${prompt.offsetTop}px`;
    ghost.style.left = `${prompt.offsetLeft}px`;
    ghost.style.width = `${prompt.offsetWidth}px`;
    take.style.top = `${prompt.offsetTop + 6}px`;
  }

  function paint() {
    const next = Boolean(text) && enabled() && !blocked() && empty() && !prompt.readOnly;
    const touchMode = touch();
    if (next) {
      body.textContent = text;
      key.hidden = touchMode;
      ghost.classList.toggle('touch', touchMode);
      place();
      if (!visible) { ghost.classList.remove('on'); requestAnimationFrame(() => requestAnimationFrame(() => { if (visible) ghost.classList.add('on'); })); }
      ghost.hidden = false;
      take.hidden = !touchMode;
      prompt.dataset.ghost = touchMode ? 'touch' : '1';
      prompt.style.minHeight = `${ghost.offsetHeight}px`;
      prompt.setAttribute('aria-description', t('chat.suggestion.described', { text }));
    } else {
      ghost.hidden = true;
      ghost.classList.remove('on');
      take.hidden = true;
      delete prompt.dataset.ghost;
      prompt.style.minHeight = '';
      prompt.removeAttribute('aria-description');
    }
    visible = next;
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

  return {
    get text() { return text; },
    get visible() { return visible; },
    /** 出す候補を替える（null で消す） */
    set(value) { text = typeof value === 'string' && value.trim() ? value : null; paint(); },
    /** 欄の中身・状態が変わった（input・フォーカス・会話の切り替え・送信） */
    refresh: paint,
    /** 入力欄の keydown（送信より先）。Tab で入れたら true */
    keydown(e) {
      if (!visible || e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
      e.preventDefault();
      use();
      return true;
    },
  };
}
