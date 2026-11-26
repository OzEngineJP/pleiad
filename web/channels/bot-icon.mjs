import { el, svgEl } from '../dom.mjs';

export const BOT_COLOR_COUNT = 8;

const FACES = {
  32: {
    viewBox: '0 0 32 32',
    body: 'M2.36 14.6A6.26 6.26 0 0 1 10.4 6.41A6.19 6.19 0 0 1 21.6 6.41A6.26 6.26 0 0 1 29.64 14.6A15 10.26 0 1 1 2.36 14.6Z',
    eye: 'M6.58 15.32A3.61 3.61 0 0 1 13.81 15.32V20.35A3.61 3.61 0 0 1 6.58 20.35ZM18.19 15.32A3.61 3.61 0 0 1 25.42 15.32V20.35A3.61 3.61 0 0 1 18.19 20.35Z',
    pupil: 'M8.71 18.1A1.87 3.16 0 1 1 12.45 18.1A1.87 3.16 0 1 1 8.71 18.1ZM19.55 18.1A1.87 3.16 0 1 1 23.29 18.1A1.87 3.16 0 1 1 19.55 18.1Z',
  },
  20: {
    viewBox: '0 0 20 20',
    body: 'M1.47 9.12A3.91 3.91 0 0 1 6.5 4.01A3.87 3.87 0 0 1 13.5 4.01A3.91 3.91 0 0 1 18.52 9.12A9.38 6.41 0 1 1 1.47 9.12Z',
    eye: 'M5.8 7H7.2A1.8 1.8 0 0 1 9 8.8V13.2A1.8 1.8 0 0 1 7.2 15H5.8A1.8 1.8 0 0 1 4 13.2V8.8A1.8 1.8 0 0 1 5.8 7ZM12.8 7H14.2A1.8 1.8 0 0 1 16 8.8V13.2A1.8 1.8 0 0 1 14.2 15H12.8A1.8 1.8 0 0 1 11 13.2V8.8A1.8 1.8 0 0 1 12.8 7Z',
    pupil: 'M6 8H6A1 1 0 0 1 7 9V12A1 1 0 0 1 6 13H6A1 1 0 0 1 5 12V9A1 1 0 0 1 6 8ZM13 8H13A1 1 0 0 1 14 9V12A1 1 0 0 1 13 13H13A1 1 0 0 1 12 12V9A1 1 0 0 1 13 8Z',
  },
  16: {
    viewBox: '0 0 16 16',
    body: 'M1.18 7.3A3.13 3.13 0 0 1 5.2 3.21A3.1 3.1 0 0 1 10.8 3.21A3.13 3.13 0 0 1 14.82 7.3A7.5 5.13 0 1 1 1.18 7.3Z',
    eye: 'M4.6 6H5.4A1.6 1.6 0 0 1 7 7.6V10.4A1.6 1.6 0 0 1 5.4 12H4.6A1.6 1.6 0 0 1 3 10.4V7.6A1.6 1.6 0 0 1 4.6 6ZM10.6 6H11.4A1.6 1.6 0 0 1 13 7.6V10.4A1.6 1.6 0 0 1 11.4 12H10.6A1.6 1.6 0 0 1 9 10.4V7.6A1.6 1.6 0 0 1 10.6 6Z',
    pupil: 'M5 7H5A1 1 0 0 1 6 8V10A1 1 0 0 1 5 11H5A1 1 0 0 1 4 10V8A1 1 0 0 1 5 7ZM11 7H11A1 1 0 0 1 12 8V10A1 1 0 0 1 11 11H11A1 1 0 0 1 10 10V8A1 1 0 0 1 11 7Z',
  },
};

export const botColorIndex = (bot) => (Number.isInteger(bot?.color) && bot.color >= 1 && bot.color <= BOT_COLOR_COUNT ? bot.color : 1);
export const botColorVar = (bot) => `var(--bc${botColorIndex(bot)})`;

const inferVariant = (className) => {
  const c = String(className ?? '');
  if (/\bmention-av\b|\bav xs\b|\bts-bot-icon\b|\bsrc-bot-icon\b|\bbt-menu-av\b|\bth-band-icon\b/.test(c)) return 16;
  if (/\bbot-row-icon\b|\bch-av\b|\bch-hash\b/.test(c)) return 20;
  return 32;
};

/** 色の顔。bot の色（1〜8）を --bot-color に置き、大きさに合わせて 16・20・32 の画素合わせの形を選ぶ。絵文字・画像の保存値は読まない */
export function botIcon(bot, className, variant = null) {
  const root = el('span', className);
  root.classList.add('bot-face-icon');
  root.style.setProperty('--bot-color', botColorVar(bot));
  const face = FACES[variant ?? inferVariant(className)] ?? FACES[32];
  const svg = svgEl('svg', { class: 'bot-face-svg', viewBox: face.viewBox, 'aria-hidden': 'true', focusable: 'false' });
  svg.append(
    svgEl('path', { fill: 'var(--bot-color, #5665CD)', d: face.body }),
    svgEl('path', { fill: 'var(--bot-eye, #FFFFFF)', d: face.eye }),
    svgEl('path', { fill: 'var(--bot-pupil, #1C2247)', d: face.pupil }),
  );
  root.append(svg);
  return root;
}
