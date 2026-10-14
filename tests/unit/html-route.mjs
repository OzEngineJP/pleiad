// HTML の開き先（docs/file-preview.md「HTML の開き先」。web/file-preview.mjs の htmlRoute）: 列ごとの行き先と、起点ごとの通り道。
// 列: H-in（ホストの画面・内蔵ブラウザー）/ H-ex（ホストの画面・既定のブラウザー）/ L（ホストの PC の普通のブラウザー）/ R（リモート・映像あり）/ R0（リモート・映像なし）
// 起点: クリック・Ctrl/⌘+クリック・中クリック・パスのチップ/添付/コンテキストの「開く」（preview.open）・ファイルのメニュー・可視化のカード
// 実際の OS の窓は開かない（cmd・内蔵ブラウザーの橋・リモートの映像はすべて偽物で、呼ばれた先を覚える）。
import assert from 'node:assert/strict';
import { htmlOpenRoute } from '../../web/browser-address.mjs';
import { setupFilePreview } from '../../web/file-preview.mjs';
import { createBrowserPanel } from '../../web/browser-panel.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'html-route';
export const title = 'HTML の開き先: 列（H-in / H-ex / L / R / R0）ごとの行き先と、起点（クリック・Ctrl・中クリック・チップ・メニュー・可視化のカード）が同じ振り分けを通ること';

// ---- 列 → 入力（htmlOpenRoute の引数）と期待する行き先
const COLUMNS = {
  'H-in': { args: { hasCmd: true, hostScreen: true, inappAvailable: true, prefs: { linkOpen: 'inapp' }, remoteView: false }, route: 'inapp' },
  'H-in（設定が空 = 既定）': { args: { hasCmd: true, hostScreen: true, inappAvailable: true, prefs: {}, remoteView: false }, route: 'inapp' },
  'H-ex': { args: { hasCmd: true, hostScreen: true, inappAvailable: true, prefs: { linkOpen: 'external' }, remoteView: false }, route: 'external' },
  'L（plyDesktop 無し・ホストの PC のブラウザー）': { args: { hasCmd: true, hostScreen: true, inappAvailable: false, prefs: { linkOpen: 'inapp' }, remoteView: false }, route: 'external' },
  R: { args: { hasCmd: true, hostScreen: false, inappAvailable: false, prefs: {}, remoteView: true }, route: 'remote' },
  R0: { args: { hasCmd: true, hostScreen: false, inappAvailable: false, prefs: {}, remoteView: false }, route: 'source' },
  '命令を送れない画面': { args: { hasCmd: false, hostScreen: true, inappAvailable: true, prefs: {}, remoteView: true }, route: 'source' },
  'リモートで linkOpen=external でも映像へ': { args: { hasCmd: true, hostScreen: false, inappAvailable: false, prefs: { linkOpen: 'external' }, remoteView: true }, route: 'remote' },
};

// ---- 画面の部品を動かすための最小の代役
function flush() { return new Promise(resolve => setTimeout(resolve, 0)); }

/** 偽の preload の橋（plyDesktop.browser）。command と layout を覚える */
function fakeBridge() {
  const calls = [];
  let n = 0, state = { tabs: [], current: null };
  return {
    calls,
    command: async (action, args) => {
      calls.push([action, args]);
      if (action === 'open') {
        const id = `t${++n}`;
        state = { tabs: [...state.tabs, { id, url: args?.url ?? '', title: '', loading: false, canGoBack: false, canGoForward: false }], current: id };
      }
      return state;
    },
    layout() {}, onState() { return () => {}; },
  };
}

/** window・document まわりを差し替えて fn を走らせ、必ず戻す */
async function withDom(win, fn) {
  const keys = ['window', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener',
    'getComputedStyle', 'matchMedia', 'innerWidth'];
  const saved = Object.fromEntries(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const docKeys = ['body', 'documentElement', 'querySelector', 'querySelectorAll', 'getElementById', 'createTextNode', 'activeElement', 'addEventListener'];
  const savedDoc = Object.fromEntries(docKeys.map(k => [k, Object.getOwnPropertyDescriptor(document, k)]));
  const observer = class { observe() {} disconnect() {} };
  Object.assign(globalThis, { window: win, ResizeObserver: observer, MutationObserver: observer, requestAnimationFrame: f => { f(); return 1; }, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ borderTopLeftRadius: '12px', visibility: 'visible' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(globalThis, 'innerWidth', { value: 1280, configurable: true, writable: true });
  const listeners = {};
  document.body = new N('body'); document.documentElement = new N('html');
  const mainNode = new N('main'), sidebarNode = Object.assign(new N('div'), { offsetWidth: 0 });
  document.querySelector = selector => (selector === 'body > main' ? mainNode : null); document.querySelectorAll = () => [];
  document.getElementById = id => (id === 'sidebar' ? sidebarNode : null);
  document.createTextNode = text => ({ textContent: text, children: [], parent: null, remove() {} });
  document.activeElement = null;
  document.addEventListener = (type, fn) => { (listeners[type] ??= []).push(fn); };
  N.prototype.getBoundingClientRect = function () { return this.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
  try { return await fn(listeners); }
  finally {
    for (const k of keys) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; }
    for (const k of docKeys) { if (savedDoc[k]) Object.defineProperty(document, k, savedDoc[k]); else delete document[k]; }
    delete N.prototype.getBoundingClientRect;
  }
}

/** 押されるリンク（会話の中の <a data-file-path>）。closest は #log の中にいることだけ答える */
function link(path) {
  const anchor = new N('a');
  anchor.dataset.filePath = path;
  anchor.isConnected = true;
  anchor.closest = selector => (selector === 'a' || selector === '#log' ? anchor : null);
  return anchor;
}
/** event.target に使う: セレクターに合うものだけ返す */
const clickOn = (anchor, extra = {}) => ({ target: anchor, button: 0, ctrlKey: false, metaKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra });
const fire = (listeners, type, event) => { for (const fn of listeners[type] ?? []) fn(event); };

/**
 * 1 つの列を組んで、起点を順に叩く。
 * host: true = ホストの画面（osActions が真）。desktop: 内蔵ブラウザーの橋がある。remote: browser が remote で映像が出せるか（null = browser 無し）
 */
async function rig(listeners, { host, desktop = false, remote = null, prefs = {}, sessionId = 's1' }) {
  const bridge = desktop ? fakeBridge() : null;
  if (bridge) window.plyDesktop.browser = bridge;
  const cmds = [], shown = [], menus = [];
  const remoteCalls = { tab: [], snapshot: [] };
  let browser = null;
  if (desktop) {
    browser = createBrowserPanel({ bridge, showMenu: () => {}, getSessionId: () => sessionId });
    browser.body.rect = { left: 700, top: 120, right: 1180, bottom: 820, width: 480, height: 700 };
    browser.body.isConnected = true; browser.body.parentElement = new N('div');
  } else if (remote !== null) {
    browser = { remote: true, available: () => remote, tabsRow: new N('div'), guardRow: new N('div'), buttons: {}, body: new N('div'),
      connect() {}, sessionChanged() {}, hide() {}, show() {}, sync() {},
      showTab: async id => { remoteCalls.tab.push(id); }, showSnapshot: async query => { remoteCalls.snapshot.push(query); } };
  }
  const cmd = async (name, args) => {
    cmds.push([name, args]);
    if (name === 'openPath') return args.returnPath ? { path: 'D:\\work\\out\\demo.html', cwd: 'D:\\work' } : { ok: true };
    if (name === 'openVisualization') return args.returnPath ? { path: 'D:\\tmp\\snapshot.html' } : { ok: true };
    if (name === 'invoke') return { tabId: 'host-tab-7' };
    return {};
  };
  const preview = setupFilePreview({ getContext: () => ({ sessionId }), useFile() {}, onLayout() {}, showMenu: (x, y, items) => menus.push(items), cmd,
    osActions: () => host, getPrefs: () => prefs, browser, onBrowsing() {} });
  return { preview, cmds, menus, bridge, browser, remoteCalls, shown };
}

const names = r => r.cmds.map(([n]) => n);
const PATH = 'out/demo.html';

export default async function (t) {
  // ---- 1. 列ごとの行き先（表）
  for (const [column, { args, route }] of Object.entries(COLUMNS)) assert.equal(htmlOpenRoute(args), route, column);
  assert.equal(htmlOpenRoute(), 'source', '引数が無ければ開けない');
  t.ok('htmlOpenRoute: H-in=inapp / H-ex・L=external / R=remote / R0・命令なし=source', true);

  const snapshotDetail = { content: '<p>hi</p>', title: '図', path: 'D:\\work\\a.md', at: 1234, id: 'v1' };

  // ---- 2. 起点ごと
  // H-in: 内蔵ブラウザー
  await withDom({ plyDesktop: {} }, async listeners => {
    const r = await rig(listeners, { host: true, desktop: true, prefs: { linkOpen: 'inapp' } });
    const anchor = link(PATH);
    fire(listeners, 'click', clickOn(anchor)); await flush();
    assert.deepEqual(names(r), ['openPath'], 'クリック: サーバーに実体パスを尋ねる');
    assert.equal(r.cmds[0][1].returnPath, true, 'パスだけ返してもらい OS のブラウザーは開かせない');
    const open = r.bridge.calls.find(c => c[0] === 'open');
    assert(open && /^file:\/\/\/D:\/work\/out\/demo\.html$/.test(open[1].url) && open[1].newTab === true, JSON.stringify(open));
    assert.equal(r.bridge.calls.filter(c => c[0] === 'open').length, 1);
    assert.equal(anchor.getAttribute('aria-current'), 'true', '内蔵ブラウザーで開けたリンクに「表示中」');
    t.ok('H-in クリック: 内蔵ブラウザーのタブ（file:///…）', true);

    // Ctrl/⌘+クリック・中クリック: 設定によらず既定のブラウザー（returnPath 無しの openPath のみ。内蔵ブラウザーは開かない）
    for (const [label, type, extra] of [['Ctrl+クリック', 'click', { ctrlKey: true }], ['⌘+クリック', 'click', { metaKey: true }], ['中クリック', 'auxclick', { button: 1 }]]) {
      r.cmds.length = 0; r.bridge.calls.length = 0;
      fire(listeners, type, clickOn(link(PATH), extra)); await flush();
      assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openPath', false]], label);
      assert.equal(r.bridge.calls.filter(c => c[0] === 'open').length, 0, `${label}: 内蔵ブラウザーは開かない`);
    }
    t.ok('H-in Ctrl/⌘/中クリック: 既定のブラウザー（内蔵ブラウザーには出ない）', true);

    // チップ・添付・コンテキストの「開く」 = preview.open
    r.cmds.length = 0; r.bridge.calls.length = 0;
    await r.preview.open({ path: PATH, line: null }, null); await flush();
    assert.deepEqual(names(r), ['openPath']);
    assert.equal(r.bridge.calls.filter(c => c[0] === 'open').length, 1, 'preview.open も内蔵ブラウザーのタブ');
    // 行番号つきは HTML でも右パネル（ブラウザーではない）
    r.cmds.length = 0; r.bridge.calls.length = 0;
    r.preview.open({ path: PATH, line: 3 }, null); await flush();
    assert.equal(r.bridge.calls.filter(c => c[0] === 'open').length, 0, '行を指すリンクは内蔵ブラウザーに出さない');
    // 非 HTML は今までどおり右パネル
    r.cmds.length = 0; r.bridge.calls.length = 0;
    r.preview.open({ path: 'notes.md', line: null }, null); await flush();
    assert(!names(r).includes('openPath') && r.bridge.calls.filter(c => c[0] === 'open').length === 0, 'Markdown は HTML の道を通らない');
    t.ok('H-in チップ/添付/コンテキスト: 同じ道（HTML だけ）', true);

    // ファイルのメニュー「ブラウザーで開く」
    r.cmds.length = 0; r.bridge.calls.length = 0;
    r.preview.menu(10, 10, { path: PATH, element: null });
    const items = r.menus.at(-1).filter(i => !i.sep);
    assert(items[0].label.includes('ブラウザー'), items.map(i => i.label).join('|'));
    items[0].onClick(); await flush();
    assert.equal(r.bridge.calls.filter(c => c[0] === 'open').length, 1, 'メニュー: 内蔵ブラウザー');
    t.ok('H-in ファイルのメニューの先頭「ブラウザーで開く」: 内蔵ブラウザー', true);

    // 可視化のカード
    r.cmds.length = 0; r.bridge.calls.length = 0;
    const target = new N('div'); target.isConnected = true;
    fire(listeners, 'ply-visualize-browser', { detail: snapshotDetail, target }); await flush();
    assert.deepEqual(names(r), ['openVisualization']);
    assert.equal(r.cmds[0][1].returnPath, true); assert.equal(r.cmds[0][1].sessionId, 's1'); assert.equal(r.cmds[0][1].id, 'v1');
    const visual = r.bridge.calls.find(c => c[0] === 'open');
    assert(visual && visual[1].url.startsWith('file:///D:/tmp/snapshot.html'), JSON.stringify(visual));
    t.ok('H-in 可視化のカード: 写しを内蔵ブラウザーのタブで', true);
  });

  // H-ex: 既定のブラウザー（プレビューも内蔵ブラウザーも経ない）
  await withDom({ plyDesktop: {}, open: () => null }, async listeners => {
    const r = await rig(listeners, { host: true, desktop: true, prefs: { linkOpen: 'external' } });
    fire(listeners, 'click', clickOn(link(PATH))); await flush();
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openPath', false]], 'クリック');
    r.cmds.length = 0;
    await r.preview.open({ path: PATH, line: null }, null); await flush();
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openPath', false]], 'チップ/添付/開く');
    r.cmds.length = 0;
    fire(listeners, 'click', clickOn(link(PATH), { ctrlKey: true })); await flush();
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openPath', false]], 'Ctrl+クリック');
    r.cmds.length = 0;
    r.preview.menu(10, 10, { path: PATH, element: null }); r.menus.at(-1).filter(i => !i.sep)[0].onClick(); await flush();
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openPath', false]], 'メニュー');
    r.cmds.length = 0;
    fire(listeners, 'ply-visualize-browser', { detail: snapshotDetail, target: Object.assign(new N('div'), { isConnected: true }) }); await flush();
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openVisualization', false]], '可視化のカード');
    assert.equal(r.bridge.calls.filter(c => c[0] === 'open').length, 0, '内蔵ブラウザーには出ない');
    t.ok('H-ex: 全部の起点が既定のブラウザー（returnPath 無し = サーバーが OS で開く）', true);
  });

  // L: ホストの PC の普通のブラウザー（plyDesktop 無し・osActions 真）
  let popup = 0;
  await withDom({ open: () => { popup++; return null; } }, async listeners => {
    const r = await rig(listeners, { host: true, desktop: false, remote: null, prefs: { linkOpen: 'inapp' } });
    fire(listeners, 'click', clickOn(link(PATH))); await flush();
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openPath', false]], 'クリック');
    r.cmds.length = 0;
    fire(listeners, 'click', clickOn(link(PATH), { ctrlKey: true })); await flush();
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openPath', false]], 'Ctrl+クリック');
    r.cmds.length = 0;
    await r.preview.open({ path: PATH, line: null }, null); await flush();
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openPath', false]], 'チップ');
    r.cmds.length = 0;
    r.preview.menu(10, 10, { path: PATH, element: null }); r.menus.at(-1).filter(i => !i.sep)[0].onClick(); await flush();
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openPath', false]], 'メニュー');
    r.cmds.length = 0;
    // 可視化のカードは window.open を使わず、OS の既定のブラウザーへ渡す
    fire(listeners, 'ply-visualize-browser', { detail: snapshotDetail, target: Object.assign(new N('div'), { isConnected: true }) }); await flush();
    assert.equal(popup, 1, '空の窓を開いてみて（ポップアップ）…');
    assert.deepEqual(r.cmds.map(([n, a]) => [n, !!a.returnPath]), [['openVisualization', false]], '…止められたらサーバーが既定のブラウザーで開く');
    t.ok('L: 内蔵ブラウザーが無いので、全部の起点が既定のブラウザー（可視化はポップアップ → サーバー経由）', true);
  });

  // R: リモート（映像あり）→ ホストの内蔵ブラウザーのタブ
  await withDom({ plyRemote: {} }, async listeners => {
    const r = await rig(listeners, { host: false, remote: true });
    fire(listeners, 'click', clickOn(link(PATH))); await flush();
    assert.deepEqual(r.cmds, [['invoke', { op: 'browser.openFile', args: { path: PATH, sessionId: 's1' } }]], 'クリック');
    assert.deepEqual(r.remoteCalls.tab, ['host-tab-7'], '映像でそのタブを見る');
    r.cmds.length = 0;
    await r.preview.open({ path: PATH, line: null }, null); await flush();
    assert.equal(r.cmds[0]?.[0], 'invoke', 'チップ/添付/開く');
    r.cmds.length = 0;
    // Ctrl+クリックはホストの画面だけの操作。リモートでは普通のクリックと同じ道
    fire(listeners, 'click', clickOn(link(PATH), { ctrlKey: true })); await flush();
    assert.equal(r.cmds[0]?.[0], 'invoke', 'Ctrl+クリックもホストの OS のブラウザーは開かせない');
    assert(!names(r).includes('openPath'));
    r.cmds.length = 0;
    // 中クリックも同じ（ブラウザーの既定のまま相対パスを新しいタブで開かせない）
    const middle = clickOn(link(PATH), { button: 1 });
    fire(listeners, 'auxclick', middle); await flush();
    assert.equal(middle.defaultPrevented, true, '中クリック: 既定の動き（相対パスの新しいタブ）を止める');
    assert.equal(r.cmds[0]?.[0], 'invoke', '中クリックもホストの内蔵ブラウザーのタブ');
    assert(!names(r).includes('openPath'));
    r.cmds.length = 0;
    r.preview.menu(10, 10, { path: PATH, element: null });
    const items = r.menus.at(-1).filter(i => !i.sep);
    assert(items[0].label.includes('ブラウザー'));
    items[0].onClick(); await flush();
    assert.equal(r.cmds[0]?.[0], 'invoke', 'メニュー');
    r.cmds.length = 0;
    fire(listeners, 'ply-visualize-browser', { detail: snapshotDetail, target: Object.assign(new N('div'), { isConnected: true }) }); await flush();
    assert.deepEqual(r.remoteCalls.snapshot, [{ sessionId: 's1', id: 'v1' }], '可視化のカード: ホストの内蔵ブラウザーで写しを見る');
    assert.deepEqual(r.cmds, [], '可視化はサーバーの OS 操作を呼ばない');
    t.ok('R: 全部の起点がホストの内蔵ブラウザーのタブ（browser.openFile / 写しの映像）', true);
  });

  // R0: リモート（映像なし）→ 原文
  await withDom({ plyRemote: {} }, async listeners => {
    const r = await rig(listeners, { host: false, remote: false });
    for (const [label, run] of [
      ['クリック', () => fire(listeners, 'click', clickOn(link(PATH)))],
      ['Ctrl+クリック', () => fire(listeners, 'click', clickOn(link(PATH), { ctrlKey: true }))],
      ['中クリック', () => fire(listeners, 'auxclick', clickOn(link(PATH), { button: 1 }))],
      ['チップ', () => r.preview.open({ path: PATH, line: null }, null)],
    ]) {
      r.cmds.length = 0; run(); await flush();
      assert(!r.cmds.some(([n]) => ['openPath', 'invoke', 'openVisualization'].includes(n)), `${label}: ホストの OS・内蔵ブラウザーへ何も送らない: ${JSON.stringify(r.cmds)}`);
      assert.equal(document.body.classList.contains('file-preview-open'), true, `${label}: 右パネルが開く`);
      document.body.classList.remove('file-preview-open');
    }
    assert.deepEqual(r.remoteCalls.tab, []);
    // ファイルのメニューには「ブラウザーで開く」が無い
    r.preview.menu(10, 10, { path: PATH, element: null });
    assert(!r.menus.at(-1).filter(i => !i.sep).some(i => i.label.includes('ブラウザーで開く')), r.menus.at(-1).map(i => i.label).join('|'));
    t.ok('R0: ホストへは何も送らず、右パネルに原文（メニューにもブラウザーで開くは無い）', true);
  });

  // 映像の部品が無い殻（browser = null）のリモート・ブラウザー（LAN の普通のブラウザーからのリモート）も source
  await withDom({}, async listeners => {
    const r = await rig(listeners, { host: false, remote: null });
    r.cmds.length = 0;
    fire(listeners, 'click', clickOn(link(PATH))); await flush();
    assert(!r.cmds.some(([n]) => ['openPath', 'invoke'].includes(n)), JSON.stringify(r.cmds));
    t.ok('リモート（browser の部品なし）: 原文', true);
  });
}
