import { botIcon } from '../../web/channels/bot-icon.mjs';

export const name = 'bot-icon';
export const title = 'bot の識別表示: 書記素・画像失敗時の代替・明示した絵文字';

export default async function (t) {
  for (const [name, first] of [['営業', '営'], ['e\u0301clair', 'e\u0301'], ['👩🏽‍💻開発', '👩🏽‍💻'], ['🇯🇵日本', '🇯🇵']]) {
    t.ok(`未設定は名前の先頭の書記素を表示する: ${name}`, botIcon({ name, icon: '' }).textContent === first);
  }
  t.ok('名前が空なら山と太陽の写真の線画', botIcon({ name: '', icon: '' }).querySelector('circle') !== null);
  t.ok('既存のロボットと組み込みの星はそのまま表示する', botIcon({ name: '営業', icon: '🤖' }).textContent === '🤖' && botIcon({ name: 'エージェント', icon: '✦' }).textContent === '✦');
  for (const [icon, expected] of [['', '営'], ['🦉', '🦉']]) {
    const av = botIcon({ name: '営業', icon, iconImage: 'missing.webp' });
    const img = av.querySelector('img');
    t.ok('画像があるときは画像を優先する', !!img && !av.textContent);
    img.onerror();
    t.ok('画像が読めなければ絵文字または名前へ戻る', av.textContent === expected && !av.querySelector('img'));
  }
}
