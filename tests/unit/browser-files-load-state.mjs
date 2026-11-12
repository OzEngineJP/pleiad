// 右の欄の待っている間の見せ方（ADR 0320）を、実の web/browser-unify.mjs と DOM の代役で確かめる:
//   60 秒の打ち切り（時間は差し替え）・打ち切りの後に遅れて届いた中身が失敗の文を外す・dispose・pleiad:page-state の扱い・
//   描きかけのタブへ戻ったときの線と打ち切り・HTML の読み直しの線。
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
    const rig = async (limit = LIMIT) => {
      const opens = [];
      const box = pane('s1');
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
  } finally {
    for (const ui of uis) ui.dispose();
    env.undo();
  }
}
