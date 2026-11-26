import { botIcon, botColorIndex, botColorVar } from '../../web/channels/bot-icon.mjs';

export const name = 'bot-icon';
export const title = 'bot の識別表示: 色の顔・大きさごとの形・前の版の絵文字と画像は読まない';

export default async function (t) {
  const bot = { name: '営業', icon: '🤖', iconImage: 'missing.webp', color: 2 };
  const post = botIcon(bot, 'post-av');
  t.ok('色の顔の SVG を出し、絵文字・画像・名前の文字は読まない', post.querySelector('svg')?.getAttribute('class') === 'bot-face-svg' && !post.querySelector('img') && post.textContent === '');
  t.ok('bot の色を --bot-color に置く', post.style.getPropertyValue('--bot-color') === 'var(--bc2)');
  t.ok('発言などの大きい顔は 32 版', post.querySelector('svg')?.getAttribute('viewBox') === '0 0 32 32');
  t.ok('@ の候補などの小さい顔は 16 版', botIcon(bot, 'mention-av').querySelector('svg')?.getAttribute('viewBox') === '0 0 16 16');
  t.ok('脇の bot の行の 20px の顔は画素合わせの 20 版', botIcon(bot, 'bot-row-icon').querySelector('svg')?.getAttribute('viewBox') === '0 0 20 20');
  t.ok('明示した variant を優先する', botIcon(bot, 'post-av', 16).querySelector('svg')?.getAttribute('viewBox') === '0 0 16 16');
  t.ok('色が無い・範囲外の前の版の行は 1 番に寄せる', botColorIndex({ color: null }) === 1 && botColorIndex({ color: 9 }) === 1 && botColorVar({ color: 8 }) === 'var(--bc8)');
}
