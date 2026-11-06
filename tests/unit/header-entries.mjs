// 会話の頭の行のアイコンボタン（docs/design-system.md「会話の頭の行のアイコン」、web/header-entries.mjs）。
//   - 右の欄（会話の Chrome のウィンドウ）の近道の判定（Ctrl+Shift+B・macOS は ⌘⇧B・IME の変換中は奪わない）
//   - 右の欄のボタンは会話を開いている間だけ出し、押すと開け閉めする
//   - 頭の行のアイコンは右の欄のボタン 1 つだけ（目次・プラグイン・git の入口は置かない。ADR 0294）
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { N, installDomStub } from '../lib/dom-stub.mjs';
import { isManagedContext, isBrowserShortcut, browserShortcutLabel, browserEntryMark, setupBrowserEntry } from '../../web/header-entries.mjs';

export const name = 'header-entries';
export const title = '会話の頭の行: 右の欄のボタン 1 つ・近道と開け閉め';

export default async function (t) {
  // ---- Pleiad が担当した記録か（エージェント任せの会話は読み込み記録を固定しない）
  assert.equal(isManagedContext({ status: 'ply', owners: {}, entries: [] }), true);
  assert.equal(isManagedContext({ status: 'native', owners: {}, entries: [] }), false);
  assert.equal(isManagedContext(null), false);
  t.ok('Pleiad が担当した記録だけを管理している記録とみなす', true);

  // ---- 近道
  const key = (over) => ({ key: 'B', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isComposing: false, keyCode: 66, defaultPrevented: false, ...over });
  assert.equal(isBrowserShortcut(key(), false), true, 'Ctrl+Shift+B');
  assert.equal(isBrowserShortcut(key({ key: 'b' }), false), true);
  assert.equal(isBrowserShortcut(key({ shiftKey: false }), false), false, 'Ctrl+B はサイドバー');
  assert.equal(isBrowserShortcut(key({ altKey: true }), false), false);
  assert.equal(isBrowserShortcut(key({ metaKey: true }), false), false);
  assert.equal(isBrowserShortcut(key({ isComposing: true }), false), false, 'IME の変換中は奪わない');
  assert.equal(isBrowserShortcut(key({ keyCode: 229 }), false), false, '変換の確定の keyCode 229 も奪わない');
  assert.equal(isBrowserShortcut(key({ defaultPrevented: true }), false), false);
  assert.equal(isBrowserShortcut(key({ ctrlKey: false, metaKey: true }), true), true, 'macOS は ⌘⇧B');
  assert.equal(isBrowserShortcut(key(), true), false, 'macOS の Ctrl+Shift+B は奪わない');
  assert.equal(browserShortcutLabel(false), 'Ctrl+Shift+B');
  assert.equal(browserShortcutLabel(true), '⌘⇧B');
  t.ok('近道: Ctrl+Shift+B（macOS は ⌘⇧B）。Ctrl+B・Alt 付き・IME の変換中は取らない', true);

  assert.equal(browserEntryMark({ requested:true, paused:true, working:true }), 'requested');
  assert.equal(browserEntryMark({ paused:true, working:true }), 'paused');
  assert.equal(browserEntryMark({ working:true }), 'working');
  assert.equal(browserEntryMark({}), '');
  t.ok('右の欄のボタンの印: 依頼待ち・人の操作・エージェントの操作の順', true);

  // ---- ボタンが無ければ何もしない。会話を開いていない間は隠す
  assert.equal(setupBrowserEntry({ button: null }), null);
  installDomStub();
  document.addEventListener = () => {};
  {
    let current = null;
    const entryButton = new N('button'); entryButton.hidden = false;
    const entry = setupBrowserEntry({ button: entryButton, mac: false, getSessionId: () => current });
    t.ok('会話を開いていない間はボタンを隠し、使えない', entryButton.hidden === true && entry.available() === false);
    current = 'a'; entry.paint();
    t.ok('会話を開くとボタンを出す（Chrome の窓がまだ無くても右の欄を開ける）', entryButton.hidden === false && entry.available() === true);
  }

  // ---- 押すと右の欄（会話の Chrome のウィンドウ）を開け閉めする
  {
    let isOpen = false, openedAt = null, closed = 0, focused = 0;
    const entryButton = new N('button'), menuAnchor = new N('button');
    menuAnchor.focus = () => { focused += 1; };
    const entry = setupBrowserEntry({ button: entryButton, mac: false, getSessionId: () => 'a', chromeAvailable: () => true,
      windows: { has: () => true, operating: () => false },
      chrome: () => ({ isOpen: () => isOpen, open: anchor => { isOpen = true; openedAt = anchor; }, close: () => { isOpen = false; closed += 1; } }) });
    entry.toggle(menuAnchor);
    t.ok('閉じているときに押すと、押した所を起点に右の欄を開く', isOpen && openedAt === menuAnchor && entryButton.getAttribute('aria-expanded') === 'true');
    entry.toggle(menuAnchor);
    t.ok('開いているときに押すと閉じ、押した所へ焦点を戻す', !isOpen && closed === 1 && focused === 1 && entryButton.getAttribute('aria-expanded') === 'false');
    t.ok('Chrome の窓のある会話はスマホのメニューの印を付ける', entryButton.hasAttribute('data-mobile-chrome'));
  }

  // ---- 依頼待ち・人の操作中が「変わった」ときだけ一度読み上げる
  {
    let waiting = false, state = 'idle';
    const said = [];
    const entryButton = new N('button');
    const entry = setupBrowserEntry({ button: entryButton, mac: false,
      windows: { has: () => true, operating: () => false }, getSessionId: () => 'a', chromeAvailable: () => true,
      waiting: () => waiting, getChromeState: () => state, announce: text => said.push(text) });
    entry.paint(); entry.paint();
    t.ok('開いた直後・何も変わらない再描画では読み上げない', said.length === 0);
    waiting = true; entry.paint(); entry.paint(); entry.paint();
    t.ok('依頼待ちになったら一度だけ読み上げる（再描画で繰り返さない）', said.length === 1 && /entryState\.requested|依頼/.test(said[0]), JSON.stringify(said));
    t.ok('currentMark は印を返す', entry.currentMark() === 'requested');
    waiting = false; entry.paint();
    t.ok('依頼待ちが片付いたら印は消え、読み上げも増えない', entry.currentMark() === '' && said.length === 1);
    state = 'paused'; entry.paint();
    t.ok('人の操作中になったら別の文を一度読み上げる', said.length === 2 && /entryState\.paused|操作中/.test(said[1]), JSON.stringify(said));
    state = 'running'; entry.paint();
    t.ok('エージェントの操作中（working）は読み上げない', said.length === 2);
  }

  // ---- 頭の行の並び
  const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<header class="top">');
  const header = html.slice(start, html.indexOf('</header>', start));
  assert.doesNotMatch(header, /id="(tocEntry|contextEntry|gitEntry)"/, '目次・プラグイン・git の入口は頭の行に置かない（＋の新しいタブから行く）');
  assert.match(header, /class="btn btn-icon" id="browserEntry"/, '右の欄のボタンは 30px のアイコンボタン');
  assert.match(header, /id="browserEntry" hidden/, 'ブラウザーは使える画面でだけ出す（既定は隠す）');
  assert.doesNotMatch(header, /id="chromeEntry"/, '頭の行のブラウザー入口は地球の一つ');
  assert.match(header, /id="browserEntry"[^>]*aria-controls="filePreview" aria-expanded="false"/, '開閉の ARIA を揃える');
  const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.entry-dot\{position:absolute;top:4px;right:4px;width:7px;height:7px;border-radius:50%;color:var\(--ink-strong\);background:currentColor;box-shadow:0 0 0 2px var\(--surface-paper\)/);
  assert.doesNotMatch(css, /\.ctxlink\.ply/, 'Pleiad が管理しているときの青い字はやめた');
  t.ok('頭の行: アイコンは右の欄のボタン 1 つだけ、変更ありの点は 7px の強い字', true);
}
