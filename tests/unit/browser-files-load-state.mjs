// 右の欄の待っている間の見せ方（ADR 0320）を、実の web/browser-unify.mjs と DOM の代役で確かめる:
//   60 秒の打ち切り（時間は差し替え）・打ち切りの後に遅れて届いた中身が失敗の文を外す・dispose・pleiad:page-state の扱い・
//   描きかけのタブへ戻ったときの線と打ち切り・HTML の読み直しの線。
//   Chrome の映像のタブ（ADR 0321 の最初の絵の骨組みと同じ待ち）: 絵で下ろす・映しているタブでは出さない・打ち切りの後に絵が届いても何も残らない。
// 実ブラウザーでの見た目は tests/browser/browser-files-load.cjs（手元の確認）。
import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { createBrowserUnify } from '../../web/browser-unify.mjs';

export const name = 'browser-files-load-state';
export const title = '右の欄の待ち: 60 秒の打ち切り・遅れて届いた中身が失敗を外す・dispose・page-state・描きかけへ戻る・HTML の読み直しの線（実の browser-unify・DOM の代役）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (cond, ms = 3000, what = '') => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await cond();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(5);
  }
};
const DELAY = 15, LIMIT = 150;                  // 差し替えた時間（本番は 150 ms と 60 秒）
const ORIGIN = globalThis.location.origin;      // 本体と同じ出どころ（Pleiad のページ）
const ISOLATED = 'http://f0123456789abcdef.localhost:23456';

/** browser-unify が触る面を代役へ足す。同じ worker のほかの suite へ残さないよう元に戻す */
function browserEnv() {
  const doc = globalThis.document;
  const restore = [];
  const put = (obj, key, value) => { restore.push([obj, key, Object.getOwnPropertyDescriptor(obj, key)]); obj[key] = value; };
  const handlers = [];
  put(doc, 'head', new N('head'));
  put(doc, 'body', new N('body'));
  put(doc, 'getElementById', () => null);
  put(doc, 'querySelector', () => null);
  put(doc, 'querySelectorAll', () => []);
  put(doc, 'addEventListener', () => {});
  put(doc, 'removeEventListener', () => {});
  put(doc, 'dispatchEvent', () => true);
  put(doc, 'createTextNode', text => ({ textContent: String(text), outerHTML: String(text), shown: String(text), children: [], parent: null, dataset: {}, remove() {} }));
  const make = doc.createElement;
  const frames = [];
  // iframe は contentWindow（postMessage の記録・同じ出どころの文書）を持つ
  put(doc, 'createElement', tag => {
    const node = make(tag);
    if (String(tag).toLowerCase() === 'iframe') {
      const posted = [];
      node.contentWindow = { postMessage: (message, origin) => posted.push({ message, origin }), location: { get href() { return node.src; } }, document: new N('document') };
      node.posted = posted;
      frames.push(node);
    }
    return node;
  });
  put(globalThis, 'window', { addEventListener: (type, fn) => { if (type === 'message') handlers.push(fn); }, removeEventListener() {} });
  put(globalThis, 'ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  put(globalThis, 'CustomEvent', class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init?.detail ?? null; } });
  put(globalThis, 'matchMedia', query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const undo = () => {
    for (const [obj, key, descriptor] of restore.reverse()) { if (descriptor) Object.defineProperty(obj, key, descriptor); else delete obj[key]; }
  };
  return { undo, handlers, frames };
}

/** 右の欄の代役。mountPage に渡された箱（pageHost）を覚える */
function pane(sessionId) {
  const box = { sessionId, tabId: null, host: null, opened: true,
    isOpen() { return this.opened; }, open() { this.opened = true; }, close() { this.opened = false; },
    mountBrowserChrome() {}, mountPage(host) { this.host = host; },
    onOpenChange() {}, onTargetChange() {}, onTabChange() {} };
  return box;
}

export default async function (t) {
  const env = browserEnv();
  const uis = [];
  try {
    const rig = async (limit = LIMIT, extend = null) => {
      const opens = [];
      const box = pane('s1');
      if (extend) Object.assign(box, extend(box));
      const commands = [];
      const ui = createBrowserUnify({
        state: { current: 's1', cwd: '/w' }, chrome: () => box, notify: () => {}, showMenu: () => {}, loadDelay: DELAY, loadLimit: limit,
        pageOpen: async request => {
          opens.push(request);
          if (request.kind === 'html') return { kind: 'html', path: request.path, stamp: '1:1', url: `${ISOLATED}/f/key/${encodeURIComponent(String(request.path).split('/').pop())}` };
          return { kind: request.kind, path: request.path, stamp: '1:1', suffix: `/_pleiad/s/s1/file?path=${encodeURIComponent(request.path ?? '')}`, url: `${ORIGIN}/_pleiad/s/s1/file?path=${encodeURIComponent(request.path ?? '')}` };
        },
        cmd: async (name, args) => { commands.push([name, args]); return name === 'resolvePath' ? { kind: 'file', path: args.path } : {}; } });
      uis.push(ui);
      ui.capsChanged({ browserUnify: true });
      const line = () => ui.root.querySelector('.bu-load');
      const host = () => box.host;
      const find = cls => host()?.querySelector(`.${cls}`);
      const lineShown = () => line()?.hidden === false;
      const frameOf = tab => env.frames.find(frame => frame.src === tab.url);
      const say = (frame, data, origin = ORIGIN) => env.handlers.at(-1)({ source: frame.contentWindow, origin, data });
      // タブの列の押下（pick）。会話のリンクからの開き直し（focusTab）とは別の、ただ戻る操作
      const back = tab => { const button = ui.root.querySelectorAll('.bu-tab-pick').find(node => node.textContent.includes(String(tab.page?.path ?? '').split('/').pop())); assert.ok(button, 'タブの列にある'); return button.onclick(); };
      return { ui, box, opens, commands, line, lineShown, find, frameOf, say, back,
        failedShown: () => find('bu-page-failed')?.hidden === false,
        skShown: () => find('bu-page-sk')?.hidden === false,
        busy: () => host()?.getAttribute('aria-busy') };
    };

    // ---- 1. 最初の読み込み: 150ms を超えたら線を出し、描き終えの知らせで下ろす ----
    {
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/a.md' });
      assert.equal(r.lineShown(), false, '開いてすぐは何も出さない（速い操作でちらつかせない）');
      await until(() => r.lineShown(), 1000, '線が出る');
      assert.equal(r.busy(), 'true', '待っている間は aria-busy');
      const frame = r.frameOf(tab);
      r.say(frame, { type: 'pleiad:page-state', state: 'ready' });
      assert.equal(r.lineShown(), false, '描き終えたら線を下ろす');
      assert.equal(r.busy(), 'false');
      t.ok('最初の読み込み: 待ちが 150ms を超えたら線を出し、ready で下ろす', true);

      // pleiad:page-state の扱い: 別の窓・別の出どころからの知らせは無視、loading で線をもう一度、failed で下ろす
      r.say({ contentWindow: {} }, { type: 'pleiad:page-state', state: 'loading' });
      assert.equal(r.lineShown(), false, '知らない窓からの loading は無視');
      r.say(frame, { type: 'pleiad:page-state', state: 'loading' }, ISOLATED);
      await sleep(DELAY * 3);
      assert.equal(r.lineShown(), false, '別の出どころからの loading は無視');
      r.say(frame, { type: 'pleiad:page-state', state: 'loading' });
      await until(() => r.lineShown(), 1000, 'loading で線');
      r.say(frame, { type: 'pleiad:page-state', state: 'failed' });
      assert.equal(r.lineShown(), false, 'failed でも線は下ろす');
      assert.equal(r.failedShown(), false, '一度中身を出したタブの failed は、前の中身を残して失敗の文を出さない（ページ自身が失敗を出す）');
      t.ok('page-state: loading で線・ready/failed で下ろす・知らない窓と別の出どころは無視', true);
    }

    // ---- 2. 60 秒の打ち切り（時間は差し替え）: 失敗の文に替わる。遅れて届いたら失敗の文が外れる ----
    {
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/never.md' });
      await until(() => r.lineShown(), 1000, '線');
      assert.equal(r.failedShown(), false, '上限の前は失敗を出さない');
      await until(() => r.failedShown(), 2000, '打ち切りで失敗の文');
      assert.equal(r.lineShown(), false, '打ち切りで線を止める');
      assert.equal(r.busy(), 'false');
      assert.ok(r.find('bu-page-failed').textContent.length > 0, '失敗の文が入っている');
      const strip = r.ui.tabs.root.querySelectorAll('.bu-loading');
      assert.equal(strip.length, 0, 'タブの印の脈も止める');
      // 打ち切りの後に描き終えの知らせが遅れて届いた → 失敗の文が外れる
      r.say(r.frameOf(tab), { type: 'pleiad:page-state', state: 'ready' });
      assert.equal(r.failedShown(), false, '遅れて届いた中身は失敗の文を外す');
      t.ok('60 秒の打ち切り（時間を差し替え）: 失敗の文・線とタブの印を止める・遅れて届いたら失敗を外す（Pleiad のページ）', true);
    }

    // ---- 3. 隔離の HTML: 打ち切り → 遅れて文書が届いたら失敗の文を外す ----
    {
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'html', path: '/w/page.html' });
      const frame = r.frameOf(tab);
      assert.ok(frame, 'HTML のタブの枠がある');
      await until(() => r.failedShown(), 2000, 'HTML の打ち切り');
      assert.equal(r.skShown(), false, '失敗のときは骨組みを残さない');
      frame.dispatchEvent({ type: 'load' });
      assert.equal(r.failedShown(), false, '遅れて文書が届いたら失敗の文を外す（HTML）');
      t.ok('隔離の HTML: 打ち切りの後に load が届くと失敗の文が外れる', true);
    }

    // ---- 4. 読み直しの打ち切りは失敗を出さず、前の中身を残す ----
    {
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/again.md' });
      const frame = r.frameOf(tab);
      r.say(frame, { type: 'pleiad:page-state', state: 'ready' });
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/again.md', stamp: '2:2' });
      await until(() => r.lineShown(), 1000, '読み直しの線');
      assert.ok(frame.posted.some(item => item.message?.command?.type === 'reread'), '前の中身のまま読み直すよう頼む（reread）');
      await sleep(LIMIT + 60);
      assert.equal(r.lineShown(), false, '読み直しの打ち切りも線を止める');
      assert.equal(r.failedShown(), false, '読み直しの打ち切りは失敗の文を出さない（前の中身を残す）');
      t.ok('読み直しの打ち切りは、線を止めて前の中身を残す（失敗の文を出さない）', true);
    }

    // ---- 5. dispose: 後片付けのあとにタイマーが走らない ----
    {
      const r = await rig(60);
      await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/disposed.md' });
      r.ui.dispose();
      await sleep(DELAY + 120);
      assert.equal(r.lineShown(), false, 'dispose のあとは線を出さない');
      assert.equal(r.failedShown(), false, 'dispose のあとは打ち切りも走らない');
      t.ok('dispose: 線の遅延と打ち切りのタイマーを止める', true);
    }

    // ---- 6. 描きかけのタブへ戻ったとき: 線をもう一度出し、打ち切りも数え直す ----
    {
      const r = await rig();
      const first = await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/drawing.md' });
      const second = await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/done.md' });
      r.say(r.frameOf(second), { type: 'pleiad:page-state', state: 'ready' });
      await sleep(30);
      assert.equal(r.lineShown(), false, '別のタブへ移ると前の待ちは下ろす');
      await r.back(first);
      await until(() => r.lineShown(), 1000, '描きかけへ戻ったら線');
      await until(() => r.failedShown(), 2000, '描きかけへ戻っても 60 秒の打ち切りは働く');
      t.ok('描きかけの Pleiad のページへ戻ると、線と打ち切りをもう一度立てる', true);
    }
    {
      const r = await rig();
      const html = await r.ui.openTab({ sessionId: 's1', kind: 'html', path: '/w/draw.html' });
      const other = await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/x.md' });
      r.say(r.frameOf(other), { type: 'pleiad:page-state', state: 'ready' });
      await sleep(30);
      await r.back(html);
      await until(() => r.lineShown(), 1000, '描きかけの HTML へ戻ったら線');
      r.frameOf(html).dispatchEvent({ type: 'load' });
      assert.equal(r.lineShown(), false, '文書が届いたら線を下ろす');
      await r.back(other);
      await r.back(html);
      await sleep(DELAY * 3);
      assert.equal(r.lineShown(), false, '描き終えた HTML へ戻っても線は出さない');
      t.ok('描きかけの HTML へ戻ると線を出す・描き終えたものへ戻っても出さない', true);
    }

    // ---- 7. HTML の読み直し（same-document reload）の間も線を出す（前の中身は残す） ----
    {
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'html', path: '/w/re.html' });
      const frame = r.frameOf(tab);
      frame.dispatchEvent({ type: 'load' });
      assert.equal(r.lineShown(), false);
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/re.html', stamp: '3:3' });
      await until(() => r.lineShown(), 1000, 'HTML の読み直しの線');
      assert.ok(frame.posted.some(item => item.message?.command?.type === 'reload'), '隔離のページは reload を頼む');
      assert.equal(r.skShown(), false, '読み直しは前の中身を残す（骨組みを重ねない）');
      frame.dispatchEvent({ type: 'load' });
      assert.equal(r.lineShown(), false, '読み直しが届いたら線を下ろす');
      t.ok('HTML・可視化の読み直しの間も、線を出して前の中身を残す', true);
    }

    // ---- 7b. HTML・可視化の読み直しは、読み直す前の位置（縦・横）を橋から預かり、読み込み直した文書へ戻すよう頼む ----
    {
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'html', path: '/w/long.html' });
      const frame = r.frameOf(tab);
      frame.dispatchEvent({ type: 'load' });
      const restores = () => frame.posted.filter(item => item.message?.command?.type === 'scroll-restore');
      // 読み直しの外で届いた位置は預からない（読み直しのときだけ戻す）
      r.say(frame, { type: 'pleiad:page-scroll', x: 5, y: 5 }, ISOLATED);
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/long.html', stamp: '4:4' });
      frame.dispatchEvent({ type: 'load' });
      assert.equal(restores().length, 0, '読み直しの外で届いた位置は戻さない');
      // 読み直し: reload を頼み → 位置が届き → 読み込み直したら戻すよう頼む（隔離の出どころ宛て・値は数だけ）
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/long.html', stamp: '5:5' });
      await until(() => frame.posted.filter(item => item.message?.command?.type === 'reload').length >= 2, 1000, 'reload を頼む');
      r.say(frame, { type: 'pleiad:page-scroll', x: 120, y: 900 }, ORIGIN);
      r.say({ contentWindow: {} }, { type: 'pleiad:page-scroll', x: 1, y: 1 }, ISOLATED);
      r.say(frame, { type: 'pleiad:page-scroll', x: 'a', y: 900 }, ISOLATED);
      assert.equal(restores().length, 0, '読み込み直す前に戻すとは頼まない');
      frame.dispatchEvent({ type: 'load' });
      assert.equal(restores().length, 0, '本体の出どころ・知らない窓・数でない値の位置は預からない');
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/long.html', stamp: '6:6' });
      await until(() => frame.posted.filter(item => item.message?.command?.type === 'reload').length >= 3, 1000, '2 回目の reload');
      r.say(frame, { type: 'pleiad:page-scroll', x: 120, y: 900 }, ISOLATED);
      assert.equal(restores().length, 0, '読み込み直すまでは戻さない');
      frame.dispatchEvent({ type: 'load' });
      assert.equal(restores().length, 1, '読み込み直したら戻すよう 1 回頼む');
      assert.deepEqual(restores()[0].message.command, { type: 'scroll-restore', x: 120, y: 900 }, '預かった縦・横の位置');
      assert.equal(restores()[0].origin, ISOLATED, '宛先は隔離の出どころ');
      frame.dispatchEvent({ type: 'load' });
      assert.equal(restores().length, 1, '位置は使い切り（次の読み込みで古い位置を戻さない）');
      // 手動の ⟳ も同じ道（pages.reload）
      const before = frame.posted.filter(item => item.message?.command?.type === 'reload').length;
      await r.ui.navigate('reload', { targetId: tab.targetId });
      await until(() => frame.posted.filter(item => item.message?.command?.type === 'reload').length > before, 1000, '⟳ で reload');
      r.say(frame, { type: 'pleiad:page-scroll', x: 0, y: 300 }, ISOLATED);
      frame.dispatchEvent({ type: 'load' });
      assert.deepEqual(restores().at(-1).message.command, { type: 'scroll-restore', x: 0, y: 300 }, '⟳ の読み直しでも位置を戻す');
      t.ok('HTML・可視化の読み直し（自動・⟳・更新を表示）: 読み直す前の位置を預かり、読み込み直したあと 1 回だけ戻すよう頼む（隔離の出どころ宛て・外の出どころ/窓/値は預からない）', true);
    }
    {
      // 別のファイルへ替えたタブは戻さない（上から始める）
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'html', path: '/w/one.html' });
      const frame = r.frameOf(tab);
      frame.dispatchEvent({ type: 'load' });
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/one.html', stamp: '7:7' });
      await until(() => frame.posted.some(item => item.message?.command?.type === 'reload'), 1000, 'reload');
      r.say(frame, { type: 'pleiad:page-scroll', x: 10, y: 700 }, ISOLATED);
      await r.ui.navigate('navigate', { targetId: tab.targetId, input: '/w/two.html' });
      frame.dispatchEvent({ type: 'load' });
      assert.equal(frame.posted.filter(item => item.message?.command?.type === 'scroll-restore').length, 0, '別のファイルへ替えたら、前のファイルの位置は戻さない');
      t.ok('同じタブを別のファイルへ替えたときは、前のファイルの位置を戻さない', true);
    }

    {
      // 題（?title）だけが違う URL は同じ文書。枠を張り直さず（位置が飛ぶ）、読み直しで位置を保つ
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'html', path: '/w/titled.html' });
      const frame = r.frameOf(tab);
      frame.dispatchEvent({ type: 'load' });
      const src = frame.src;
      tab.url = `${tab.url}?title=${encodeURIComponent('題')}`;
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/titled.html', stamp: '8:8' });
      await until(() => frame.posted.some(item => item.message?.command?.type === 'reload'), 1000, '題だけの違いは読み直しを頼む');
      assert.equal(frame.src, src, '題だけの違いでは枠の src を張り直さない');
      r.say(frame, { type: 'pleiad:page-scroll', x: 0, y: 640 }, ISOLATED);
      frame.dispatchEvent({ type: 'load' });
      assert.deepEqual(frame.posted.filter(item => item.message?.command?.type === 'scroll-restore').at(-1)?.message.command, { type: 'scroll-restore', x: 0, y: 640 }, '題だけが違っても位置を戻す');
      t.ok('URL が題（?title）だけ違う読み直しは src を張り直さず、位置を戻す', true);
    }

    {
      // 読み直しの途中に次の読み直しが重なったとき: 同時に 2 本走らせない。届いてから続けて 1 本送り、最初の位置が保たれる
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'html', path: '/w/burst.html' });
      const frame = r.frameOf(tab);
      frame.dispatchEvent({ type: 'load' });
      const cmds = type => frame.posted.filter(item => item.message?.command?.type === type);
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/burst.html', stamp: '10:10' });
      await until(() => cmds('reload').length === 1, 1000, '1 本目の reload');
      r.say(frame, { type: 'pleiad:page-scroll', x: 30, y: 800 }, ISOLATED);
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/burst.html', stamp: '11:11' });
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/burst.html', stamp: '12:12' });
      await sleep(60);
      assert.equal(cmds('reload').length, 1, '読み直しの途中に重なった頼みは、まだ送らない（同時に 2 本走らせない）');
      // 読み込み直した文書: 位置を戻し、続けて重なった分を 1 本だけ送る（橋は追っている間、目的地を返す）
      frame.dispatchEvent({ type: 'load' });
      assert.deepEqual(cmds('scroll-restore').at(-1).message.command, { type: 'scroll-restore', x: 30, y: 800 });
      assert.equal(cmds('reload').length, 2, '重なった頼みは load の後に 1 本だけ送る');
      assert.equal(r.lineShown(), true, '続きの読み直しの間は線を下ろさない');
      r.say(frame, { type: 'pleiad:page-scroll', x: 30, y: 800 }, ISOLATED);   // 橋は追っている間、目的地を返す
      frame.dispatchEvent({ type: 'load' });
      assert.equal(cmds('scroll-restore').length, 2, '2 本目の load でも位置を戻す');
      assert.deepEqual(cmds('scroll-restore').at(-1).message.command, { type: 'scroll-restore', x: 30, y: 800 }, '続けて読み直しても最初の位置が保たれる');
      assert.equal(cmds('reload').length, 2, '重なった頼みは使い切り');
      t.ok('連続した読み直し: 重なった頼みは load の後に 1 本だけ送り、最初の位置を保つ', true);
    }
    {
      // 別のファイルへの張り直しで読み直し中を下ろす。遅れて届いた前の文書の位置を、別のファイルに使わない
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'html', path: '/w/a.html' });
      const frame = r.frameOf(tab);
      frame.dispatchEvent({ type: 'load' });
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/a.html', stamp: '13:13' });
      await until(() => frame.posted.some(item => item.message?.command?.type === 'reload'), 1000, 'reload');
      await r.ui.navigate('navigate', { targetId: tab.targetId, input: '/w/b.html' });
      r.say(frame, { type: 'pleiad:page-scroll', x: 10, y: 700 }, ISOLATED);   // 直前の reload 由来の位置が張り直しの後に届く
      frame.dispatchEvent({ type: 'load' });
      assert.equal(frame.posted.filter(item => item.message?.command?.type === 'scroll-restore').length, 0, '張り直しの後に届いた前の文書の位置は使わない');
      t.ok('別のファイルへの張り直しで読み直し中を下ろす（遅れた位置を使わない）', true);
    }
    {
      // 返事の無い橋・来ない load: 打ち切りで読み直し中を下ろす。以後の読み直しは送り直す（詰まったままにしない）
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'html', path: '/w/stuck.html' });
      const frame = r.frameOf(tab);
      frame.dispatchEvent({ type: 'load' });
      const cmds = type => frame.posted.filter(item => item.message?.command?.type === type);
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/stuck.html', stamp: '14:14' });
      await until(() => cmds('reload').length === 1, 1000, 'reload');
      r.say(frame, { type: 'pleiad:page-scroll', x: 5, y: 500 }, ISOLATED);
      await sleep(LIMIT + 80);   // load が来ないまま打ち切り
      r.ui.onEvent({ type: 'page:changed', sessionId: 's1', path: '/w/stuck.html', stamp: '15:15' });
      await until(() => cmds('reload').length === 2, 1000, '打ち切りの後の読み直しは送り直す');
      frame.dispatchEvent({ type: 'load' });
      assert.equal(cmds('scroll-restore').length, 0, '打ち切りの前に預かった位置は捨てる');
      assert.equal(r.lineShown(), false, '届いたら線を下ろす');
      t.ok('読み直しの打ち切りで読み直し中と預かった位置を下ろし、次の読み直しを詰まらせない', true);
    }

    // ---- 8. 会話のリンクで開いているファイルをもう一度開く（focusTab）は、読み直す ----
    {
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/link.md' });
      const other = await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/other.md' });
      r.say(r.frameOf(tab), { type: 'pleiad:page-state', state: 'ready' });
      r.say(r.frameOf(other), { type: 'pleiad:page-state', state: 'ready' });
      await sleep(30);
      const rereads = frame => frame.posted.filter(item => item.message?.command?.type === 'reread').length;
      const before = rereads(r.frameOf(tab));
      await r.ui.focusTab(tab, 's1');
      await until(() => rereads(r.frameOf(tab)) > before, 1000, 'リンクから開き直したら読み直しを頼む');
      t.ok('会話のリンクで開いているファイルをもう一度開くと、前面へ出して読み直す', true);
    }

    // ---- 9. 描き終えたタブを、アドレスバーで別のファイルへ替えて待ちが続いたら、新しい文書の最初の読み込みとして打ち切る ----
    {
      const r = await rig();
      const tab = await r.ui.openTab({ sessionId: 's1', kind: 'file', path: '/w/first.md' });
      r.say(r.frameOf(tab), { type: 'pleiad:page-state', state: 'ready' });
      await sleep(30);
      await r.ui.navigate('navigate', { targetId: tab.targetId, input: '/w/second.md' });
      await until(() => r.failedShown(), 2000, '別のファイルへ替えた後の待ちも打ち切る');
      t.ok('同じタブで別のファイルへ替えて応答が無いときも、前の文書の「描き終えた」を引きずらず、打ち切りで失敗の文を出す', true);
    }

    // ---- 10. Chrome の映像のタブ（ADR 0321 の 6）: 骨組みと同じ判断で線を出し、二重の面や失敗の文を出さない ----
    {
      // 右の欄の代役に映像の面を足す: expectFrame は映しているタブなら false（絵は来ない）、ほかは骨組みの待ちを記録して true
      const chromeBox = box => ({
        scState: { tabId: 'shown', agentTabId: 'shown' }, waits: [], pins: [], listeners: [],
        get screencastState() { return this.scState; },
        expectFrame({ tabId, follow }) { this.waits.push({ tabId, follow }); return tabId !== this.scState.tabId; },
        cancelFrameWait() { this.waits.push('cancel'); }, cancelTabPin() {},
        async pinTab(sessionId, pin) { this.pins.push(pin); },
        onTabChange(fn) { box.listeners.push(fn); },
        frame(tabId) { for (const fn of box.listeners) fn({ type: 'frame', tabId }); },
      });
      const r = await rig(LIMIT, chromeBox);
      for (const [targetId, title] of [['shown', '映している'], ['other', 'ほかのタブ']]) r.ui.onEvent({ type: 'tab:info', sessionId: 's1', targetId, windowId: 1, title, url: `https://${targetId}.example/` });
      const pickChrome = title => { const button = r.ui.root.querySelectorAll('.bu-tab-pick').find(node => node.textContent.includes(title)); assert.ok(button, `タブの列に ${title}`); return button.onclick(); };

      // a. 映していないタブ: 150ms を超えたら線（骨組みは映像の面が出す。端末内のページの面は出さない）、そのタブの絵で下ろす
      await pickChrome('ほかのタブ');
      assert.deepEqual(r.box.waits.at(-1), { tabId: 'other', follow: false }, '骨組みの待ちを映像の面へ頼む');
      await until(() => r.lineShown(), 1000, 'Chrome のタブの線');
      assert.equal(r.skShown(), false, '端末内のページの面（.bu-page-sk）は重ねない');
      r.box.frame('shown');
      assert.equal(r.lineShown(), true, '前のタブの絵では下ろさない');
      r.box.frame('other');
      assert.equal(r.lineShown(), false, '選んだタブの最初の絵で線を下ろす');
      t.ok('Chrome のタブ: 待ちが 150ms を超えたら線、選んだタブの絵で下ろす（端末内の面は重ねない）', true);

      // b. もう映しているタブを選び直した: 新しい絵は来ない（サーバーは同じタブへ付け直さない）ので、線を出さない
      r.box.scState = { tabId: 'other', agentTabId: 'shown' };
      await pickChrome('ほかのタブ');
      assert.equal(r.box.waits.at(-1)?.tabId, 'other', '映像の面に聞く');
      await sleep(DELAY * 4);
      assert.equal(r.lineShown(), false, '映しているタブでは線を出さない（打ち切りまで残さない）');
      t.ok('Chrome のタブ: もう映しているタブを選び直したら、骨組みと同じく線も出さない', true);

      // c. 打ち切り: 絵が来ないまま上限を過ぎたら線を止め、失敗の文は出さない。その後に絵が届いても何も残らない
      r.box.scState = { tabId: 'shown', agentTabId: 'shown' };
      await pickChrome('ほかのタブ');
      await until(() => r.lineShown(), 1000, '線');
      await until(() => !r.lineShown(), 2000, '打ち切りで線を止める');
      assert.equal(r.failedShown(), false, 'Chrome のタブには失敗の文を出さない（打ち切りは最初の読み込みの端末内のページだけ）');
      r.box.frame('other');
      assert.equal(r.lineShown(), false, '打ち切りの後に絵が届いても、線は出し直さない');
      assert.equal(r.failedShown(), false, '打ち切りの後に絵が届いても、失敗の文は残らない');
      t.ok('Chrome のタブ: 打ち切りで線を止め、失敗の文は出さず、遅れて届いた絵の後も何も残らない', true);
    }
  } finally {
    for (const ui of uis) ui.dispose();
    env.undo();
  }
}
