// 会話内の可視化を、列の幅（760px）を越えて横に広げる（docs/design-system.md「可視化を広げる」、ADR 0252）。
//
// 広げた先は、列の入れ物（LANE。style.css の「列」）の padding の箱の 4px 内側。
// Chats は発言の中身（#thread .mw-body）で、時間の線の右から本文の領域の右端まで。可視化があるときは overflow:clip の外へ 5px だけ見せる
// （style.css の .mw-body:has(.present-visualization.visualize-seamless)）。
// チャンネルのスレッドは投稿の列（.col-lane。web/channels-thread.css）で、時間の線が無いので欄の左端から地図の筋の手前まで。
// 広げたかどうかは覚えない（描き直すと元の幅）。Esc でも戻る。動きは margin の --dur-slow / --ease-organic
// （動きを減らす設定では tokens.css が 0ms にするので、すぐ切り替わる）。
import { t } from './i18n.mjs';

const INSET = 4;
/** 列の入れ物。style.css の :is(.col-lane,#thread .mw-body) と同じ（［広げる］を出す条件もこれ） */
export const LANE = '.col-lane, #thread .mw-body';
export const growIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12h17M7.5 8l-4 4 4 4M16.5 8l4 4-4 4"/></svg>';
export const shrinkIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h6.5M21 12h-6.5M6.5 8.5L10 12l-3.5 3.5M17.5 8.5L14 12l3.5 3.5"/></svg>';

/** 広げた枠の左右の margin。親の内容の箱を基準に測るので、動きの途中に測っても同じ値になる */
function margins(card) {
  const body = card.closest(LANE), parent = card.parentElement;
  if (!body || !parent) return null;
  const b = body.getBoundingClientRect(), p = parent.getBoundingClientRect(), ps = getComputedStyle(parent);
  const left = p.left + parent.clientLeft + parseFloat(ps.paddingLeft);
  const right = p.left + parent.clientLeft + parent.clientWidth - parseFloat(ps.paddingRight);
  return { left: Math.min(0, b.left + INSET - left), right: Math.min(0, right - (b.right - INSET)) };
}

/**
 * 可視化の枠（.present-visualization）に「広げる / 元の幅に戻す」を結ぶ。
 * @param {HTMLElement} card 可視化の枠
 * @param {HTMLButtonElement} button 道具の並びの左端のボタン（中身はここで入れる）
 */
export function wireWiden(card, button) {
  card.classList.add('visualize-widen-able');
  button.classList.add('visualize-widen');
  let observer = null;
  const label = () => {
    const wide = card.classList.contains('visualize-widened');
    const text = wide ? t('timeline.present.narrow') : t('timeline.present.widen');
    button.innerHTML = wide ? shrinkIcon : growIcon;
    button.title = text; button.setAttribute('aria-label', text);
  };
  const place = () => {
    const m = margins(card);
    if (!m) return;
    card.style.setProperty('--widen-l', `${m.left}px`);
    card.style.setProperty('--widen-r', `${m.right}px`);
  };
  const onKey = (e) => {
    if (!card.isConnected) { set(false); return; }
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    // 入力欄や開いている面の Esc は横取りしない。フォーカスが枠の中か、どこにも無いときだけ戻す
    const at = document.activeElement;
    if (at && at !== document.body && !card.contains(at)) return;
    e.preventDefault();
    set(false);
  };
  const set = (wide) => {
    if (wide) {
      place();
      observer = new ResizeObserver(place);
      // 列の入れ物は列の幅を保つよう padding が伸び縮みし、内容の箱は変わらない。外側の箱で見る
      observer.observe(card.closest(LANE) ?? card, { box: 'border-box' });
      document.addEventListener('keydown', onKey);
    } else {
      observer?.disconnect(); observer = null;
      document.removeEventListener('keydown', onKey);
    }
    card.classList.toggle('visualize-widened', wide);
    label();
  };
  button.addEventListener('click', () => set(!card.classList.contains('visualize-widened')));
  label();
}
