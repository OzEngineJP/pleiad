// 会話内検索（目次）の部品を面ごとの別のものとして作れること（web/conversation-toc.mjs。ADR 0315 の段 3）:
//   本体の会話（既定: document の keydown・body の下のシート・main と sidebar を止める）と、
//   作業のダイアログ（自分の host・keyScope・inertNodes・筋を返す関数）を同時に持っても、
//   片方のシートの開閉・Esc・inert がもう片方に及ばない。筋が無いときは発言の一覧を作りに行かない。
import assert from 'node:assert/strict';
import { setLanguage } from '../../web/i18n.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'conversation-toc-instances';
export const title = '会話内検索を面ごとに持てる: 本体とダイアログの目次で keydown・シート・inert が混ざらない';

/** 目次が触る分だけ足した要素 */
class TN extends N {
  inert = false;
  focus() { TN.focused = this; }
  select() {}
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  closest() { return null; }
  get parentElement() { return this.parent; }
}

const keydown = (key, extra = {}) => ({ type: 'keydown', key, isComposing: false, shiftKey: false, preventDefault() { this.prevented = true; }, ...extra });

export default async function (t) {
  await setLanguage('ja');
  const saved = {};
  for (const k of ['document', 'MutationObserver', 'IntersectionObserver', 'NodeFilter', 'requestAnimationFrame', 'getSelection']) saved[k] = globalThis[k];
  const docKeydown = [];
  const body = new TN('body'), main = new TN('main'), sidebar = new TN('aside');
  globalThis.document = {
    createElement: (tag) => new TN(tag), createElementNS: (_ns, tag) => new TN(tag),
    createDocumentFragment: () => new TN('fragment'),
    body, activeElement: null, hidden: false, documentElement: new TN('html'),
    querySelector: (sel) => (sel === 'body > main' ? main : null),
    getElementById: (id) => (id === 'sidebar' ? sidebar : null),
    addEventListener: (type, fn) => { if (type === 'keydown') docKeydown.push(fn); },
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.requestAnimationFrame = () => 0;
  try {
    const { createConversationToc } = await import('../../web/conversation-toc.mjs');
    const narrow = { matches: true, addEventListener() {} };   // 狭い画面: 下からのシート
    const preview = { openPanel() {}, close() {}, panelOpen: () => false };
    let navCalls = 0;
    const nav = { turns: () => { navCalls++; return []; }, turnInfo: () => ({ plain: '', pieces: [], at: '' }), currentIndex: () => -1, goTo() {}, scrollToRow() {}, onUpdate() {} };

    // 本体（既定の面）と、ダイアログの面
    const mainThread = new TN('div'), mainLog = new TN('div');
    const dialog = new TN('dialog'), listA = new TN('button'), head = new TN('header'), split = new TN('div');
    let dialogThread = new TN('div');
    const mainToc = createConversationToc({ thread: mainThread, log: mainLog, nav, preview, narrow, button: new TN('button') });
    const dialogToc = createConversationToc({ thread: () => dialogThread, log: new TN('div'), nav, preview, narrow, button: new TN('button'),
      host: dialog, keyScope: dialog, inertNodes: () => [listA, head, split] });
    assert.equal(docKeydown.length, 1, '既定の面だけが document の keydown を受ける');
    assert.equal(dialog.on?.keydown?.length, 1, 'ダイアログの面は自分の keydown を受ける');

    const sheetsIn = (node) => node.children.filter((c) => c.matches?.('.toc-sheet-wrap'));

    // ---- ダイアログの目次を開く: シートはダイアログの中、止まるのはダイアログの面だけ
    dialogToc.open();
    assert.equal(dialogToc.isOpen(), true);
    assert.equal(sheetsIn(dialog).length, 1, 'シートはダイアログの中に出る（showModal の面は body の下に出したものを隠す）');
    assert.equal(sheetsIn(body).length, 0, 'body の下には出さない');
    assert.deepEqual([listA, head, split].map((n) => n.inert), [true, true, true], 'ダイアログの面は止まる');
    assert.deepEqual([main, sidebar].map((n) => n.inert), [false, false], '本体の面は止まらない');
    assert.equal(mainToc.isOpen(), false, '本体の目次は開かない');
    t.ok('ダイアログの目次: シートはダイアログの中・止まるのはダイアログの面だけ', true);

    // ---- Esc は自分の面だけ
    const stray = keydown('Escape');
    for (const fn of docKeydown) fn(stray);
    assert.equal(dialogToc.isOpen(), true, 'document の Esc ではダイアログの目次は閉じない（本体の目次のキー）');
    assert.equal(stray.prevented, undefined);
    const own = keydown('Escape');
    for (const fn of dialog.on.keydown) fn(own);
    assert.equal(dialogToc.isOpen(), false, 'ダイアログの Esc で閉じる');
    assert.equal(sheetsIn(dialog).length, 0, 'シートは外れる');
    assert.deepEqual([listA, head, split].map((n) => n.inert), [false, false, false], '止めた面は戻る');
    t.ok('Esc は開いている面のキーだけで閉じる', true);

    // ---- 本体の目次: 従来どおり body と main・sidebar
    mainToc.open();
    assert.equal(sheetsIn(body).length, 1, '本体のシートは body の下');
    assert.deepEqual([main, sidebar].map((n) => n.inert), [true, true]);
    assert.deepEqual([listA, head, split].map((n) => n.inert), [false, false, false], 'ダイアログの面は止まらない');
    for (const fn of dialog.on.keydown) fn(keydown('Escape'));
    assert.equal(mainToc.isOpen(), true, 'ダイアログの Esc では本体の目次は閉じない');
    for (const fn of docKeydown) fn(keydown('Escape'));
    assert.equal(mainToc.isOpen(), false);
    assert.deepEqual([main, sidebar].map((n) => n.inert), [false, false]);
    t.ok('本体の目次は従来どおり（body・main・sidebar・document のキー）', true);

    // ---- 2 つ同時に開いても互いに影響しない
    mainToc.open(); dialogToc.open();
    assert.equal(sheetsIn(body).length, 1); assert.equal(sheetsIn(dialog).length, 1);
    for (const fn of dialog.on.keydown) fn(keydown('Escape'));
    assert.equal(dialogToc.isOpen(), false); assert.equal(mainToc.isOpen(), true);
    assert.deepEqual([main, sidebar].map((n) => n.inert), [true, true], '本体の面は止まったまま');
    for (const fn of docKeydown) fn(keydown('Escape'));
    t.ok('2 つ同時に開いても、閉じる・止めるが混ざらない', true);

    // ---- 筋が無い（子の会話を開く前・差し替えの間）: 一覧を作りに行かない
    dialogThread = null;
    navCalls = 0;
    dialogToc.open();
    assert.equal(navCalls, 0, '筋が無いときは発言の並びを引かない');
    dialogToc.close();
    dialogThread = new TN('div');
    dialogToc.reset();
    t.ok('筋を返す関数が null のときは何も読まない', true);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
}
