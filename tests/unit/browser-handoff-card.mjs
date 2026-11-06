import { browserHandoffView } from '../../web/browser-handoff-card.mjs';

export const name = 'browser-handoff-card';
export const title = 'Chrome の操作待ちのカード: 人が操作している間も頼まれた本文を出し続け、操作中は「あなたが操作中」と「画面を開く」だけ';

const el = (tag, cls = null, value = '') => ({ tag, className: cls, textContent: value, children: [],
  append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
  setAttribute() {}, removeAttribute() {} });
const words = { 'chat.browserHandoff.operating': 'あなたが操作中', 'control:openScreen': '画面を開く', 'chat.browserHandoff.operate': 'Chrome で操作する' };
const t = key => words[key] ?? key;
const texts = view => view.body.children.map(child => child.textContent);
const message = view => view.body.children.find(child => child.className === 'bh-message');

export default async function (t_) {
  const commands = [], opened = [];
  const view = browserHandoffView({ id: 'card', sessionId: 's', browserHandoff: { reason: 'other', state: 'asked', message: '同意のチェックを入れて「アプリを作成」を押してください', dialog: false } },
    { el, t, cmd: async (name, args) => { commands.push([name, args]); }, openScreen: id => opened.push(id) });
  t_.ok('お願いの段階では本文を出す', message(view)?.textContent === '同意のチェックを入れて「アプリを作成」を押してください', JSON.stringify(texts(view)));

  await view.buttons.at(-1).onclick();
  // サーバーの差し替えの便りは変わった項目だけを運ぶ（handoff.mjs の patch）。本文はその前の値のまま残る
  view.update({ state: 'operating', by: 'pc', windowTitle: 'アプリを作成 - Google Cloud' });
  t_.ok('引き継いだあと（あなたが操作中）も本文が消えない', message(view)?.textContent === '同意のチェックを入れて「アプリを作成」を押してください', JSON.stringify(texts(view)));
  t_.ok('操作中は「あなたが操作中」・本文・窓の題だけ（操作の案内の説明文は出さない）', texts(view).join('|') === `あなたが操作中|${message(view).textContent}|アプリを作成 - Google Cloud`, JSON.stringify(texts(view)));
  t_.ok('ボタンは「画面を開く」だけ（任せるのは札・帯・⋮）', view.buttons.length === 1 && view.buttons[0].textContent === '画面を開く', JSON.stringify(view.buttons.map(b => b.textContent)));
  const sent = commands.length;
  await view.buttons[0].onclick();
  t_.ok('「画面を開く」はその会話の Chrome の映像を開くだけで、サーバーへは何も送らない', opened.length === 1 && opened[0] === 's' && commands.length === sent, JSON.stringify({ opened, commands }));

  // 画面を開く口が無い呼び出し元では、操作中のボタンを出さない
  const quiet = browserHandoffView({ id: 'card4', sessionId: 's', browserHandoff: { reason: 'login', state: 'operating', by: 'pc' } }, { el, t, cmd: async () => {} });
  t_.ok('openScreen が無ければ操作中のボタンは無い', quiet.buttons.length === 0);

  // 端末で操作している間も同じ
  const device = browserHandoffView({ id: 'card2', sessionId: 's', browserHandoff: { reason: 'login', state: 'asked', message: 'ログインしてください' } }, { el, t, cmd: async () => {} });
  device.update({ state: 'operating', by: 'device' });
  t_.ok('別の端末で操作している間も本文が消えない', message(device)?.textContent === 'ログインしてください', JSON.stringify(texts(device)));

  // 本文の無い依頼（message 無し）は空の行を作らない
  const bare = browserHandoffView({ id: 'card3', sessionId: 's', browserHandoff: { reason: 'captcha', state: 'asked', message: null } }, { el, t, cmd: async () => {} });
  bare.update({ state: 'operating', by: 'pc' });
  t_.ok('本文が無い依頼は、操作中に空の行を足さない', !message(bare) && texts(bare).join('|') === 'あなたが操作中', JSON.stringify(texts(bare)));
}
