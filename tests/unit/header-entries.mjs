// 会話の頭の行のアイコンボタン（docs/design-system.md「会話の頭の行のアイコン」、web/header-entries.mjs）。
//   - 右の欄（会話の Chrome のウィンドウ）の近道の判定（Ctrl+Shift+B・macOS は ⌘⇧B・IME の変換中は奪わない）
//   - 右の欄のボタンは会話を開いている間だけ出し、押すと開け閉めする
//   - 頭の行の並び（目次・右の欄のボタンが同じ 30px のアイコンボタン。プラグイン・git の入口は置かない。ADR 0294）
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { t as translate, setLanguage } from '../../web/i18n.mjs';
import { N, installDomStub } from '../lib/dom-stub.mjs';
import { isManagedContext, isBrowserShortcut, browserShortcutLabel, browserEntryMark, setupBrowserEntry } from '../../web/header-entries.mjs';

export const name = 'header-entries';
export const title = '会話の頭の行: 目次と右の欄のボタン・近道と開け閉め・角の印（人が触っているタブがあれば ⏸、エージェントの操作中は弧）';

export default async function (t) {
  {
    await setLanguage('ja');
    assert.equal(translate('tabs:strip.open', { count:2 }), 'ブラウザーを開く（2 個のタブ）');
    assert.equal(translate('tabs:address.openTabs', { count:2 }), 'タブ一覧を開く（2 個）');
    await setLanguage('en');
    assert.equal(translate('tabs:strip.open', { count:1 }), 'Open browser (1 tab)');
    assert.equal(translate('tabs:strip.open', { count:2 }), 'Open browser (2 tabs)');
    assert.equal(translate('tabs:address.openTabs', { count:1 }), 'Open tab list (1 tab)');
    assert.equal(translate('tabs:address.openTabs', { count:2 }), 'Open tab list (2 tabs)');
    await setLanguage('ja');
    t.ok('ヘッダーとアドレスバーで、操作先に合う日本語・英語の読み上げ名を使う', true);
  }
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
    t.ok('スマホの帯をやめたので、窓の有無の印は付けない（入口は [N]）', !entryButton.hasAttribute('data-mobile-chrome'));
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

  // ---- 角の印: 人が触っているタブがあれば ⏸（一時停止と同じ印。見ているタブとは無関係。ADR 0296）
  {
    let held = false, state = 'idle', operating = false;
    const entryButton = new N('button');
    const entry = setupBrowserEntry({ button: entryButton, mac: false, getSessionId: () => 'a', chromeAvailable: () => true,
      windows: { has: () => true, operating: () => operating }, getChromeState: () => state, humanHeld: () => held });
    t.ok('人のタブも一時停止も無ければ印は無し', entry.currentMark() === '');
    held = true; entry.paint();
    t.ok('会話に人が触っているタブがあれば paused の印（どのタブを見ているかは聞かない）', entry.currentMark() === 'paused');
    state = 'running'; operating = true; entry.paint();
    t.ok('人のタブとエージェントの操作が重なっても ⏸ が先（requested > paused > working）', entry.currentMark() === 'paused');
    held = false; entry.paint();
    t.ok('人のタブが無くなれば印は working に戻る', entry.currentMark() === 'working');
    state = 'paused'; entry.paint();
    t.ok('一時停止も同じ ⏸ の印', entry.currentMark() === 'paused');
  }

  // ---- 動いている印は弧（runMark）。entry-run.run の形で CSS が当たる
  {
    const entryButton = new N('button');
    const entry = setupBrowserEntry({ button: entryButton, mac: false, getSessionId: () => 'a', chromeAvailable: () => true,
      windows: { has: () => true, operating: () => true }, getChromeState: () => 'running' });
    const mark = entryButton.querySelector('.entry-browser-mark');
    t.ok('エージェントの操作中は弧（.entry-run.run + svg）を角に置く', mark && mark.classList.contains('run') && mark.classList.contains('entry-run') && mark.tagName === 'SPAN' && mark.querySelector('svg'), entryButton.outerHTML);
    entry.paint();
    t.ok('再描画でも印は 1 つだけ', entryButton.querySelectorAll('.entry-browser-mark').length === 1);
  }

  // ---- 角の印: 依頼待ちは色の点でなく、人の操作と同じ II の丸に寄せる（承認済み 2026-11-08）
  {
    let waiting = false;
    const entryButton = new N('button');
    const entry = setupBrowserEntry({ button: entryButton, mac: false, getSessionId: () => 'a', chromeAvailable: () => true,
      windows: { has: () => true, operating: () => false }, waiting: () => waiting });
    waiting = true; entry.paint();
    const mark = entryButton.querySelector('.entry-browser-mark');
    t.ok('依頼待ちの間は II の丸（色の点は出さない）', mark && mark.classList.contains('entry-paused') && entryButton.querySelector('.entry-requested') === null);
    t.ok('読み上げの判定は変わらない（requested のまま）', entry.currentMark() === 'requested');
  }

  // ---- スマホの頭の行の [N]（承認済み 2026-11-08。temporary/mockups/phone-browser-header.html）: タブの数の四角を出し、押すとタブを全画面で開く
  {
    let mobile = true, count = 3, openState = false, held = false;
    const opened = [], closed = [];
    const entryButton = new N('button'); entryButton.hidden = false;
    const entry = setupBrowserEntry({ button: entryButton, mac: false, getSessionId: () => 'a', chromeAvailable: () => true,
      windows: { has: () => false, operating: () => false }, mobile: () => mobile, humanHeld: () => held,
      tabs: () => Array.from({ length: count }, (_, i) => ({ targetId: `T${i}` })),
      openEntry: id => opened.push(id),
      chrome: () => ({ isOpen: () => openState, open: () => { openState = true; }, close: () => { openState = false; closed.push('x'); } }) });
    const tabn = entryButton.querySelector('.entry-tabn');
    t.ok('スマホは共有の SVG 枠と数字でタブ数を出す', tabn && tabn.textContent === '3' && tabn.querySelector('svg')?.children[0]?.getAttribute('stroke') === 'currentColor');
    t.ok('読み上げの名は実数（aria-label に数を入れる）', (entryButton.getAttribute('aria-label') ?? '').includes('3'));
    entry.toggle();
    t.ok('押すと openEntry が開く（人のタブ・最後のタブの優先は browser-unify 側）', opened.join() === 'a' && openState === false);
    count = 12; entry.paint();
    t.ok('2 桁は字を詰める（two の印）', tabn.textContent === '12' && tabn.classList.contains('two'));
    count = 120; entry.paint();
    t.ok('100 以上は ∞ を出し、読み上げは実数', tabn.textContent === '∞' && tabn.classList.contains('sym') && (entryButton.getAttribute('aria-label') ?? '').includes('120'));
    count = 0; entry.paint();
    t.ok('タブが 0 でも「0」を出して消えない（ファイル・git への入口でもある）', tabn.textContent === '0' && entryButton.hidden === false);
    held = true; openState = false; entry.paint();
    t.ok('人のタブがある間は II の丸を出す', entryButton.querySelector('.entry-browser-mark')?.classList.contains('entry-paused') === true);
    openState = true; entry.paint();
    t.ok('ブラウザーを開いている間は角の印を出さない（中の UI が状態を見せる）', entryButton.querySelector('.entry-browser-mark') === null);
    entry.toggle();
    t.ok('開いているときに押すと閉じる（閉じる動作は PC と同じ）', closed.length === 1);
    mobile = false; openState = false; count = 4; entry.paint(); entry.toggle();
    t.ok('PC では押すと従来どおり右の欄を開く（openEntry は呼ばない）', opened.length === 1 && openState === true);
  }

  // ---- 頭の行の並び
  const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<header class="top">');
  const header = html.slice(start, html.indexOf('</header>', start));
  assert.doesNotMatch(header, /id="(contextEntry|gitEntry)"/, 'プラグイン・git の入口は頭の行に置かない（＋の新しいタブから行く）');
  const order = ['id="tocEntry"', 'id="browserEntry"'].map((id) => header.indexOf(id));
  assert(order[0] > 0 && order[0] < order[1], '目次・右の欄のボタンの順');
  for (const id of ['tocEntry', 'browserEntry']) assert.match(header, new RegExp(`class="btn btn-icon" id="${id}"`), `${id} は 30px のアイコンボタン`);
  assert.match(header, /id="tocEntry" hidden aria-controls="filePreview" aria-expanded="false" aria-keyshortcuts="Control\+F"/, '目次は発言がある会話でだけ出し、開閉の ARIA と Ctrl+F を持つ');
  const client = fs.readFileSync(new URL('../../web/client.mjs', import.meta.url), 'utf8');
  assert.match(client, /createConversationToc\(\{[^}]*button: \$\('tocEntry'\)/, '目次のボタンを目次につなぐ');
  assert.match(client, /headerBefore: \$\('tocEntry'\)/, '通話のボタンは目次の前（通話・目次・右の欄の順）');
  assert.match(header, /id="browserEntry" hidden/, 'ブラウザーは使える画面でだけ出す（既定は隠す）');
  assert.doesNotMatch(header, /id="chromeEntry"/, '頭の行のブラウザー入口は地球の一つ');
  assert.match(header, /id="browserEntry"[^>]*aria-controls="filePreview" aria-expanded="false"/, '開閉の ARIA を揃える');
  const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.entry-dot\{position:absolute;top:4px;right:4px;width:7px;height:7px;border-radius:50%;color:var\(--ink-strong\);background:currentColor;box-shadow:0 0 0 2px var\(--surface-paper\)/);
  assert.doesNotMatch(css, /\.ctxlink\.ply/, 'Pleiad が管理しているときの青い字はやめた');
  t.ok('頭の行: 通話・目次・右の欄のボタンを同じアイコンボタンで並べ、変更ありの点は 7px の強い字', true);
}
