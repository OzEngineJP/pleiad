import { N } from '../lib/dom-stub.mjs';
import { createChromeControlView, createChromeControlStore, createControlBadge, createPhoneBrowserStrip, durationText, renderChromeHandoverLine, renderChromeClosedLine, setChromeHandoverAgentName, CONTROL_STATES } from '../../web/chrome-control.mjs';
import { renderPresent } from '../../web/render.mjs';
import * as history from '../../core/history.mjs';

export const name = 'chrome-control-ui';
export const title = 'エージェントの Chrome の窓の状態（web/chrome-control.mjs）: 一時停止中の帯と戻すボタン・押した位置の輪・スマホの帯の読み上げ・状態の置き場・会話の引き継ぎの行・記録（DOM の代役。ADR 0148・0154・0294）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default async function (t) {
  // ---- 字とボタンの表
  t.ok('状態は 4 つ', CONTROL_STATES.join() === 'running,idle,stopped,paused');
  t.ok('経過時間: 1 分 12 秒・45 秒（負・不正は 0 秒）', durationText(72) === '1 分 12 秒' && durationText(45) === '45 秒' && durationText(60) === '1 分 0 秒' && durationText(-3) === '0 秒' && durationText('x') === '0 秒');

  // ---- 部品
  const calls = [];
  let reply = async () => ({});
  const errors = [];
  const view = createChromeControlView({ resume: async () => { calls.push('resume'); return reply(); }, getName: () => 'Claude', onError: error => errors.push(error.message) });
  // ---- 札: 窓の大きさが変わったら閉じるだけで、札に焦点を移さない（スマホではキーボードが開くと窓が縮み、ページの欄から焦点が外れてキーボードが閉じた）
  {
    const oldDoc = globalThis.document, oldWindow = globalThis.window, oldFocus = N.prototype.focus;
    const doc = new N('document'); Object.assign(doc, { createElement: tag => new N(tag), getElementById: () => null, head: new N('head'), body: new N('body') });
    const win = new N('window');
    globalThis.document = doc; globalThis.window = win;
    N.prototype.focus = function () { doc.activeElement = this; };
    try {
      const badge = createControlBadge({ mount: new N('div') }), field = new N('textarea');
      badge.update({ agentUsed: true, name: 'Claude' }); field.focus();
      for (const fn of win.on?.resize ?? []) fn({ type: 'resize' });
      t.ok('窓の大きさが変わっても札に焦点を移さない', doc.activeElement === field);
      badge.destroy();
      // ---- スマホの帯: 押すと右の欄の映像を開く。読み上げは「画面を開く」と、ドメイン・状態の説明
      const mount = new N('div');
      let activated = 0;
      const strip = createPhoneBrowserStrip({ mount, onActivate: () => { activated++; } });
      const opener = strip.element.querySelector('.b2-strip-open');
      const described = opener.getAttribute('aria-describedby');
      t.ok('スマホの帯の押し口は「画面を開く」と読み、ドメインと状態の欄を説明に結ぶ', opener.getAttribute('aria-label') === '画面を開く' && !!described && strip.element.querySelector('.b2-strip-info').id === described, JSON.stringify({ label: opener.getAttribute('aria-label'), described }));
      t.ok('スマホの帯は開閉の状態を持たない（aria-expanded を付けない）', opener.getAttribute('aria-expanded') === undefined);
      opener.onclick?.(); for (const fn of opener.on?.click ?? []) fn({ type: 'click' });
      t.ok('帯を押すと onActivate を呼ぶ', activated === 1, String(activated));
      strip.destroy();
    } finally { globalThis.document = oldDoc; globalThis.window = oldWindow; N.prototype.focus = oldFocus; }
  }

  t.ok('状態が無いうちは隠れている', view.banner.hidden === true && view.state() === null);
  t.ok('状態の一行（view.root）は持たない。状態はアドレスバーの札が示す', !('root' in view));
  view.apply({ state: 'running', since: null });
  t.ok('操作中の印は映像の上の層の data-state（色は CSS のトークン）', view.overlay.dataset.state === 'running');
  t.ok('帯は一時停止中だけ。映像の上の層に幕は持たない（幕は映像の側の .cp-veil が 1 つだけ出す）', view.banner.hidden === true && view.overlay.querySelector('.cc-veil') === null);
  view.apply({ state: 'idle' });
  view.apply({ state: 'stopped' });
  t.ok('待機中・止めた後も帯は出さない', view.banner.hidden === true);

  view.apply({ state: 'paused', since: 1 });
  t.ok('一時停止中の帯（会話の中）に文と戻すボタン。帯は role=status にしない（札と二重に読み上げない）', view.banner.hidden === false && view.banner.getAttribute('role') === undefined && view.banner.textContent.includes('一時停止中 · あなたが Chrome で操作') && view.banner.querySelector('button').textContent === 'Claude に戻す', view.banner.textContent);
  t.ok('映像の上の層は読み上げない。一時停止中も幕は足さない（二重にしない）', view.overlay.querySelector('.cc-veil') === null && view.overlay.getAttribute('aria-hidden') === 'true');
  view.apply({ state: 'paused', since: 1 }, { banner: false });
  t.ok('右の欄が別の会話を映している間は帯を出さない', view.banner.hidden === true);
  view.apply({ state: 'paused', since: 1 });
  const resume = view.banner.querySelector('button');
  resume.onclick();
  await sleep(5);
  t.ok('帯の「Claude に戻す」は resume を呼ぶ', calls.join() === 'resume', calls.join());

  // 押している間は二重に押せない・失敗は onError
  let release;
  reply = () => new Promise(resolve => { release = resolve; });
  const before = calls.length;
  resume.onclick(); resume.onclick();
  await sleep(5);
  t.ok('実行中は二重に呼ばない・ボタンを無効にする', calls.length === before + 1 && resume.disabled === true);
  release({}); await sleep(5);
  t.ok('終われば押せる', resume.disabled === false);
  reply = async () => { throw new Error('boom'); };
  resume.onclick(); await sleep(5);
  t.ok('失敗は onError へ（投げない）', errors.join() === 'boom' && resume.disabled === false, errors.join());

  view.apply({ state: 'paused', since: 1, error: 'conceal-failed' });
  t.ok('戻せなかった（窓を隠せなかった）ときは、帯に理由を出す。paused のまま「戻す」を押せる', view.banner.textContent.includes('ウィンドウを隠せなかった') && view.banner.hidden === false && resume.disabled === false, view.banner.textContent);
  view.apply({ state: 'paused', since: 1 });
  t.ok('error が無くなれば元の語に戻る', view.banner.textContent.includes('一時停止中'));
  view.apply({ state: 'bogus' });
  t.ok('知らない状態は隠す', view.banner.hidden === true && view.state() === null);

  // 名前が替わったら描き直す
  let name = 'Codex';
  const named = createChromeControlView({ resume: async () => {}, getName: () => name });
  named.apply({ state: 'paused', since: 1 });
  t.ok('エージェントの名前が入る', named.banner.querySelector('button').textContent === 'Codex に戻す');
  name = 'Claude'; named.refresh();
  t.ok('refresh で名前を取り直す', named.banner.querySelector('button').textContent === 'Claude に戻す');

  // ---- 押した位置の輪
  view.ring(250, 100, { width: 1000, height: 400 });
  const rings = () => view.overlay.querySelectorAll('.cc-ring');
  t.ok('輪はページの座標を割合で置く（25% / 25%）', rings().length === 1 && rings()[0].style.left === '25%' && rings()[0].style.top === '25%', JSON.stringify(rings().map(r => r.style)));
  view.ring(2000, -5, { width: 1000, height: 400 });
  t.ok('はみ出す座標は縁に収める', rings()[1].style.left === '100%' && rings()[1].style.top === '0%');
  const n = rings().length;
  view.ring(10, 10); view.ring(10, 10, { width: 0, height: 5 }); view.ring(NaN, 1, { width: 5, height: 5 });
  t.ok('映像の大きさが分からない・座標が数でないときは出さない（位置を偽らない）', rings().length === n);
  await sleep(760);
  t.ok('輪は一定時間で消える', rings().length === 0);

  // ---- 状態の置き場
  const store = createChromeControlStore();
  const seen = [], taps = [];
  store.onChange((sessionId, state, since) => seen.push(`${sessionId}:${state}:${since ?? ''}`));
  store.onTap(tap => taps.push(tap));
  t.ok('知らない会話は idle', store.get('a').state === 'idle');
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'running', since: null });
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'running', since: null });
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'paused', since: 5 });
  t.ok('会話ごとに持ち、変わったときだけ聞き手へ', store.get('a').state === 'paused' && store.get('a').since === 5 && seen.join() === 'a:running:,a:paused:5', seen.join());
  store.event({ type: 'chromeControl', sessionId: 'b', state: 'stopped' });
  t.ok('別の会話の状態とは混ざらない', store.get('b').state === 'stopped' && store.get('a').state === 'paused');
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'idle' });
  t.ok('idle は持たずに idle へ戻す', store.get('a').state === 'idle' && seen.at(-1) === 'a:idle:');
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'weird' });
  store.event({ type: 'chromeControl', state: 'running' });
  t.ok('知らない状態・会話の id が無い便りは捨てる', store.get('a').state === 'idle' && seen.length === 4);
  store.event({ type: 'chromeTap', sessionId: 'b', x: 3, y: 4, windowId: 7 });
  store.event({ type: 'chromeTap', x: 3, y: 4 });
  t.ok('押した位置は会話の id つきで聞き手へ', taps.length === 1 && taps[0].sessionId === 'b' && taps[0].x === 3 && taps[0].windowId === 7);
  store.event({ type: 'chromeControl', sessionId: 'b', state: 'paused', since: 3, error: 'conceal-failed' });
  t.ok('error だけが変わっても聞き手へ知らせる・置き場が持つ', store.get('b').error === 'conceal-failed' && seen.at(-1) === 'b:paused:3', seen.join());
  store.clear();
  t.ok('clear は全部を idle に戻し、聞き手へ知らせる', store.get('b').state === 'idle' && seen.at(-1) === 'b:idle:', seen.join());
  const off = store.onChange(() => { throw new Error('listener'); });
  store.event({ type: 'chromeControl', sessionId: 'c', state: 'running' });
  off();
  t.ok('聞き手が投げても置き場は壊れない', store.get('c').state === 'running');

  // ---- 会話の引き継ぎの行（present kind: chromeHandover）
  setChromeHandoverAgentName(() => 'Claude');
  const line = renderChromeHandoverLine({ kind: 'chromeHandover', chromeHandover: { seconds: 72 } });
  t.ok('「あなたが引き継ぎ · Claude に戻しました · 1 分 12 秒」', line.textContent === 'あなたが引き継ぎ · Claude に戻しました · 1 分 12 秒', line.textContent);
  t.ok('印は読み上げない', line.querySelector('.cc-line-ic').getAttribute('aria-hidden') === 'true');
  t.ok('秒が無ければ 0 秒', renderChromeHandoverLine({ kind: 'chromeHandover' }).textContent.endsWith('0 秒'));
  t.ok('renderPresent が行へ回す（カードにしない）', renderPresent({ kind: 'chromeHandover', chromeHandover: { seconds: 5 } }).className === 'cc-line');
  setChromeHandoverAgentName(() => 'Codex');
  t.ok('名前は今の会話のエージェント', renderChromeHandoverLine({ chromeHandover: { seconds: 1 } }).textContent.includes('Codex に戻しました'));
  const closed = renderChromeClosedLine({ kind: 'chromeClosed', chromeClosed: { by: 'agent' }, path: 'C:/shot.png' });
  t.ok('閉じた行は今のエージェント名と静止画を示す', closed.textContent.includes('Codex がウィンドウを閉じました') && closed.querySelector('img')?.src?.includes('shot.png'));
  t.ok('人が × で閉じたときの行は画像がなくても残る', renderPresent({ kind: 'chromeClosed', chromeClosed: { by: 'human' } }).textContent.includes('Chrome のウィンドウが閉じました'));

  // ---- 記録（core/history.mjs recordPresent）
  const id = `chrome-control-ui-${Date.now()}`;
  const saved = await history.recordPresent(id, { kind: 'chromeHandover', chromeHandover: { seconds: 71.6 } });
  t.ok('引き継ぎの行は kind と秒（四捨五入）を残す。人の添付ではない（by: ai）', saved.kind === 'chromeHandover' && saved.chromeHandover.seconds === 72 && saved.by === 'ai' && saved.caption === null, JSON.stringify(saved));
  const odd = await history.recordPresent(id, { kind: 'chromeHandover', chromeHandover: { seconds: 'x' } });
  t.ok('秒が数でなければ 0', odd.chromeHandover.seconds === 0);
  const rows = (await history.readPresents(id)).filter(p => p.kind === 'chromeHandover');
  t.ok('読み戻せる', rows.length === 2 && rows[0].chromeHandover.seconds === 72);
  const other = await history.recordPresent(id, { kind: 'text', content: 'x', chromeHandover: { seconds: 9 } });
  t.ok('ほかの kind には載せない', !('chromeHandover' in other));
  const savedClose = await history.recordPresent(id, { kind: 'chromeClosed', chromeClosed: { by: 'agent' }, path: 'C:/shot.png' });
  t.ok('静止画は present にパスと閉じた人の印だけを保存し、画像本体は DB に入れない', savedClose.path === 'C:/shot.png' && savedClose.chromeClosed.by === 'agent' && !savedClose.dataUri);
}
