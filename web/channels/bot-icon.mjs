import { el, svgEl } from '../dom.mjs';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const botInitial = (name) => graphemes.segment(String(name ?? '').trim())[Symbol.iterator]().next().value?.segment ?? '';

/** 画像・選んだ絵文字・名前の先頭の順で表示する。名前も無ければ写真の線画。 */
export function botIcon(bot, className) {
  const root = el('span', className);
  const fallback = () => {
    const text = bot?.icon || botInitial(bot?.name);
    root.classList.toggle('bot-icon-initial', !bot?.icon);
    if (text) { root.textContent = text; return; }
    const photo = svgEl('svg', { class: 'bot-icon-placeholder', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    photo.append(svgEl('rect', { x: '3', y: '3', width: '18', height: '18', rx: '3' }), svgEl('circle', { cx: '8.5', cy: '8.5', r: '1.5' }), svgEl('path', { d: 'm3 17 6-6 4 4 3-3 5 5' }));
    root.replaceChildren(photo);
  };
  if (bot?.iconImage) {
    const img = el('img', 'bot-icon-image');
    img.src = `/local-file?path=${encodeURIComponent(bot.iconImage)}`;
    img.alt = '';
    img.draggable = false;
    img.onerror = fallback;
    root.append(img);
  } else fallback();
  return root;
}
