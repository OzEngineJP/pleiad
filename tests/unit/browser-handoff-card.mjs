import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readWeb, cutFunction } from '../lib/cut-source.mjs';
import { browserHandoffView, handoffSummary } from '../../web/browser-handoff-card.mjs';

export const name = 'browser-handoff-card';
export const title = 'Chrome の操作待ちのカード: 人が操作している間も頼まれた本文を出し続け、操作中は「あなたが操作中」と戻す入口（「AI に戻す」・「画面を開く」）';

const el = (tag, cls = null, value = '') => ({ tag, className: cls, textContent: value, children: [],
  append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
  setAttribute() {}, removeAttribute() {} });
const words = { 'chat.browserHandoff.operating': 'あなたが操作中', 'control:openScreen': '画面を開く', 'chat.browserHandoff.operate': 'Chrome で操作する',
  'tabs:display.resume': 'AI に戻す', 'chat.browserHandoff.returnHint': '終わったら「AI に戻す」を押してください' };
const t = key => words[key] ?? key;
const texts = view => view.body.children.map(child => child.textContent);
const message = view => view.body.children.find(child => child.className === 'bh-message');
const hint = view => view.body.children.find(child => child.className === 'browser-setting-note');

export default async function (t_) {
  const commands = [], opened = [];
  const view = browserHandoffView({ id: 'card', sessionId: 's', browserHandoff: { reason: 'other', state: 'asked', message: '同意のチェックを入れて「アプリを作成」を押してください', dialog: false } },
    { el, t, cmd: async (name, args) => { commands.push([name, args]); }, openScreen: id => opened.push(id) });
  t_.ok('お願いの段階では本文を出す', message(view)?.textContent === '同意のチェックを入れて「アプリを作成」を押してください', JSON.stringify(texts(view)));

  await view.buttons.at(-1).onclick();
  // サーバーの差し替えの便りは変わった項目だけを運ぶ（handoff.mjs の patch）。本文はその前の値のまま残る
  view.update({ state: 'operating', by: 'pc', windowTitle: 'アプリを作成 - Google Cloud' });
  t_.ok('引き継いだあと（あなたが操作中）も本文が消えない', message(view)?.textContent === '同意のチェックを入れて「アプリを作成」を押してください', JSON.stringify(texts(view)));
  t_.ok('操作中は「あなたが操作中」・本文・戻す案内・窓の題だけ（自動で戻る文は出さない）', texts(view).join('|') === `あなたが操作中|${message(view).textContent}|終わったら「AI に戻す」を押してください|アプリを作成 - Google Cloud`, JSON.stringify(texts(view)));
  t_.ok('案内は「終わったら『AI に戻す』を押してください」（秒で自動で戻るとは言わない）', hint(view)?.textContent === '終わったら「AI に戻す」を押してください', hint(view)?.textContent);
  t_.ok('ボタンは「画面を開く」（控えめ）と「AI に戻す」（主ボタン）', view.buttons.length === 2 && view.buttons[0].textContent === '画面を開く' && view.buttons[0].className === 'btn btn-quiet' && view.buttons[1].textContent === 'AI に戻す' && view.buttons[1].className === 'btn btn-primary', JSON.stringify(view.buttons.map(b => [b.textContent, b.className])));
  const sent = commands.length;
  await view.buttons[0].onclick();
  t_.ok('「画面を開く」はその会話の Chrome の映像を開くだけで、サーバーへは何も送らない', opened.length === 1 && opened[0] === 's' && commands.length === sent, JSON.stringify({ opened, commands }));
  await view.buttons[1].onclick();
  t_.ok('「AI に戻す」はその会話へ chromeResume を送る（人のタブを全部 AI に戻すのはサーバー側）', commands.length === sent + 1 && commands.at(-1)[0] === 'chromeResume' && commands.at(-1)[1]?.sessionId === 's', JSON.stringify(commands));

  // 画面を開く口が無い呼び出し元でも、操作中の戻すボタンは出す（カードが入口の 1 つ）
  const quiet = browserHandoffView({ id: 'card4', sessionId: 's', browserHandoff: { reason: 'login', state: 'operating', by: 'pc' } }, { el, t, cmd: async (name, args) => { commands.push([name, args]); } });
  t_.ok('openScreen が無くても「AI に戻す」は出る', quiet.buttons.length === 1 && quiet.buttons[0].textContent === 'AI に戻す', JSON.stringify(quiet.buttons.map(b => b.textContent)));

  // 端末で操作している間も同じ
  const device = browserHandoffView({ id: 'card2', sessionId: 's', browserHandoff: { reason: 'login', state: 'asked', message: 'ログインしてください' } }, { el, t, cmd: async () => {} });
  device.update({ state: 'operating', by: 'device' });
  t_.ok('別の端末で操作している間も本文が消えない', message(device)?.textContent === 'ログインしてください', JSON.stringify(texts(device)));
  t_.ok('別の端末でも「AI に戻す」を出す', device.buttons.length === 1 && device.buttons[0].textContent === 'AI に戻す', JSON.stringify(device.buttons.map(b => b.textContent)));

  // 子の会話のカード（targetSessionId）にはその会話へ戻す命令を送る
  const child = browserHandoffView({ id: 'card5', sessionId: 'parent', targetSessionId: 'child', browserHandoff: { reason: 'login', state: 'operating', by: 'pc', targetSessionId: 'child' } }, { el, t, cmd: async (name, args) => { commands.push([name, args]); } });
  await child.buttons.at(-1).onclick();
  t_.ok('子の会話のカードの「AI に戻す」は targetSessionId へ送る', commands.at(-1)[0] === 'chromeResume' && commands.at(-1)[1]?.sessionId === 'child', JSON.stringify(commands.at(-1)));

  // 本文の無い依頼（message 無し）は空の行を作らない（案内の行は出す）
  const bare = browserHandoffView({ id: 'card3', sessionId: 's', browserHandoff: { reason: 'captcha', state: 'asked', message: null } }, { el, t, cmd: async () => {} });
  bare.update({ state: 'operating', by: 'pc' });
  t_.ok('本文が無い依頼は、操作中に空の行を足さない', !message(bare) && texts(bare).join('|') === 'あなたが操作中|終わったら「AI に戻す」を押してください', JSON.stringify(texts(bare)));

  // 見出しの「…からの依頼」は、頼んだエージェントの表示名（辞書に Claude を直書きしない。右の欄の映像の行と同じ名前の引き方）
  const dict = lang => JSON.parse(readFileSync(new URL(`../../web/locales/${lang}/ui.json`, import.meta.url), 'utf8')).chat.browserHandoff;
  for (const lang of ['ja', 'en']) {
    const lead = dict(lang).askedLead;
    t_.ok(`${lang}: askedLead は {{agent}} を取り、Claude を直書きしない`, lead.includes('{{agent}}') && !lead.includes('Claude'), lead);
  }
  const ja = dict('ja');
  const FALLBACK = JSON.parse(readFileSync(new URL('../../web/locales/ja/ui.json', import.meta.url), 'utf8')).browser.agentFallback;
  const tr = (key, params = {}) => (key === 'chat.browserHandoff.askedLead' ? ja.askedLead : key === 'chat.browserHandoff.reason.login' ? 'ログイン' : key === 'browser.agentFallback' ? FALLBACK : key)
    .replace(/\{\{(\w+)\}\}/g, (_, k) => params[k]);
  const asked = (names, id = 'fake-session', extra = {}) => browserHandoffView({ id: 'c', sessionId: 'parent', ...extra, browserHandoff: { reason: 'login', state: 'asked', message: null } },
    { el, t: tr, cmd: async () => {}, agentName: names });
  const looked = [];
  const fake = asked(sid => { looked.push(sid); return 'Fake'; });
  t_.ok('Claude 以外のエージェントでも、見出しとリードがそのエージェントの表示名になる', fake.summary() === 'Fake からの依頼 · ログイン' && texts(fake)[0] === 'Fake からの依頼 · ログイン' && !fake.summary().includes('Claude'), JSON.stringify([fake.summary(), texts(fake)]));
  t_.ok('Claude では今までどおり「Claude からの依頼」', asked(() => 'Claude').summary() === 'Claude からの依頼 · ログイン');
  asked(sid => `name-of-${sid}`, null, { targetSessionId: 'child' });
  const byChild = asked(sid => `name-of-${sid}`, null, { targetSessionId: 'child' });
  t_.ok('子の会話が頼んだときは、子の会話の id で名前を引く', byChild.summary() === 'name-of-child からの依頼 · ログイン', byChild.summary());
  t_.ok('名前が分からないときは映像の行と同じ「AI」', asked(() => '').summary() === 'AI からの依頼 · ログイン' && asked(null).summary() === 'AI からの依頼 · ログイン');
  t_.ok('handoffSummary は connect のときは名前を使わない', handoffSummary(tr, { reason: 'connect' }, 'Fake') === 'chat.browserHandoff.connect.lead');
  t_.ok('既定名は辞書の 1 つのキー（browser.agentFallback）から引く（ja・en とも）', ['ja', 'en'].every(lang => typeof JSON.parse(readFileSync(new URL(`../../web/locales/${lang}/ui.json`, import.meta.url), 'utf8')).browser.agentFallback === 'string'));

  // サーバーが依頼に載せた表示名（h.agent）が先。子の会話が一覧に無くても、親のエージェントの名前に化けない
  const carried = browserHandoffView({ id: 'c', sessionId: 'parent', targetSessionId: 'child', browserHandoff: { reason: 'login', state: 'asked', message: null, agent: 'Codex' } },
    { el, t: tr, cmd: async () => {}, agentName: () => 'Claude' });
  t_.ok('依頼に載った表示名（h.agent）を先に使う', carried.summary() === 'Codex からの依頼 · ログイン' && texts(carried)[0] === 'Codex からの依頼 · ログイン', carried.summary());

  // 実物の chromeAgentName（web/client.mjs）を、一覧が子を含まない・エージェントの一覧が後から届く状態で通す
  const clientSrc = readWeb('client.mjs');
  const sandbox = { state: { current: 'parent', backendId: 'claude', backends: [], sessions: [{ id: 'parent', backend: 'claude' }, { id: 'listed', backend: 'codex' }] } };
  vm.createContext(sandbox);
  vm.runInContext(`${cutFunction(clientSrc, 'activeBackendId')}
${cutFunction(clientSrc, 'chromeAgentName')}`, sandbox);
  const real = id => sandbox.chromeAgentName(id);
  t_.ok('エージェントの一覧が未着のうちは、id（claude）を字にしない', real('parent') === '' && real('listed') === '', JSON.stringify([real('parent'), real('listed')]));
  const early = asked(real, null, { targetSessionId: 'child' });
  t_.ok('未着のうちの見出しは辞書の既定名', early.summary() === 'AI からの依頼 · ログイン', early.summary());
  const waiting = asked(real, null, { targetSessionId: 'listed' });
  t_.ok('未着のうちに作ったカードは既定名', waiting.summary() === 'AI からの依頼 · ログイン' && texts(waiting)[0] === 'AI からの依頼 · ログイン');
  sandbox.state.backends = [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }];
  t_.ok('一覧が届けば、親の会話と一覧にある別の会話はそれぞれのエージェントの名前', real('parent') === 'Claude' && real('listed') === 'Codex', JSON.stringify([real('parent'), real('listed')]));
  t_.ok('一覧に無い子の会話は、親のエージェントの名前で代用しない', real('child') === '', real('child'));
  waiting.refresh();
  t_.ok('名前が分かった後は、未着の間に作ったカードの見出しと本文が引き直して正しくなる', waiting.summary() === 'Codex からの依頼 · ログイン' && texts(waiting)[0] === 'Codex からの依頼 · ログイン', JSON.stringify([waiting.summary(), texts(waiting)]));
  t_.ok('一覧に無い子のカードは既定名のまま（親の名前にならない）', early.summary() === 'AI からの依頼 · ログイン');
  const late = asked(real, null, { targetSessionId: 'listed' });
  t_.ok('子が一覧に載れば、見出しがその子のエージェントになる', late.summary() === 'Codex からの依頼 · ログイン', late.summary());
  // 引き直しの結線: エージェントの一覧と会話の一覧が届いた所で、カードの名前を引き直す
  t_.ok('エージェントの一覧・会話の一覧が届いた所でカードの名前を引き直す', (clientSrc.match(/renameHandoffCards\(\);/g) ?? []).length >= 2 && /view\.refresh\(\);\s*desc\.textContent = view\.summary\(\)/.test(clientSrc));
}
