// 作業のダイアログ（子の会話のモーダル）の会話内検索・発言のメニュー・ファイルのメニュー（実ブラウザー。ADR 0315 の段 3）:
//   1. Ctrl+F は最前面の面の会話を探す（ダイアログが開いている間は子の会話。閉じたら本体へ戻る）
//   2. Esc は 1 枚ずつ閉じる（目次 → ダイアログ。右の欄 → ダイアログ）
//   3. 発言の ⋮ / 右クリック: 子の会話にも出るが、分岐・編集して再送信・再送信は出さない。本体は従来どおり
//   4. リンクの右クリックとファイルの ⋮: ダイアログの中に出る。項目は本体と同じで「会話で使う」だけ出さない
//   5. 読むだけの子（ネイティブのサブエージェント）にも検索と同じメニューが出る
//   6. 本体の検索・メニューは今までどおり
//   7. 頭の右端（本体の頭と同じ部品・順）: 検索・パネルを開く・（狭いとき ⋯）・↗。パネルは子の会話の欄を開け閉めし、Ctrl+Shift+B は前面のモーダルに効く
//   8. 「最新へ」と Alt+↑↓・End、リンクの行き先の一行（.url-status）は本体と同じに出る
//   9. 狭い幅（760・360px）の目次: Esc 1 回は目次だけを閉じ、モーダルは残る
// 実行: node tests/browser/work-dialog-search-menu.mjs   （会話の agent-browser の窓を使う）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-search-menu-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_SEARCH_SHOTS;
const ab = (...args) => execFileSync(process.env.AGENT_BROWSER_BIN || 'agent-browser', args, { encoding: 'utf8', timeout: 60_000 });
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, label, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};
let server, client;
try {
  server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  console.log(`fake server pid=${server.child.pid} port=${server.port}`);
  client = await open({ ...server, autoAllow: true });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('completeSetup', { backend: 'fake' });

  const childDir = path.join(base, 'child-dir');
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(path.join(childDir, 'child-note.md'), '# child-note\n');
  const childSteps = path.join(base, 'child-steps.json');
  // 長い返答（本文がスクロールする）と、外のリンク（行き先の一行を確かめる）を含める
  const tail = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: filler for scrolling.`).join('\n\n');
  fs.writeFileSync(childSteps, JSON.stringify({ steps: [{ text: `Child reply: needle-child, see [child note](child-note.md) and [site](https://example.com/docs/page).\n\n${tail}` }] }));

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:zebra-main-only' });
  const parent = first.sessionId;
  const delegate = async (sessionId, title, task, cwd, until = e => e.type === 'turnEnd' && e.sessionId !== sessionId) => {
    const mark = client.mark();
    for (let tries = 0; ; tries++) {
      try {
        await client.cmd('runTurn', { sessionId, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title, task, ...(cwd ? { cwd } : {}) } }) });
        break;
      } catch (error) {
        if (tries >= 80) throw error;
        await sleep(250);
      }
    }
    const res = await client.waitFor(e => e.sessionId === sessionId && e.type === 'tool.result', { from: mark, ms: 30_000 });
    const childEnd = await client.waitFor(until, { from: mark, ms: 30_000 });
    return { taskId: JSON.parse(res.text).taskId, childId: childEnd.sessionId };
  };
  const child = await delegate(parent, 'child', `steps:@${childSteps}`, childDir);
  const sub = await delegate(parent, 'native', 'bg 1 8', childDir, e => e.type === 'turnEnd' && e.sessionId !== parent && e.sessionId !== child.childId);
  await sleep(1500);

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 1), 'delegate card');

  const clickOn = (sel, label) => {
    const ok = evaluate(s => { const n = document.querySelector(s); if (!n) return false; n.dataset.probe = 'pick'; n.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; }, sel);
    assert.ok(ok, `target exists: ${label}`);
    try { ab('click', '[data-probe="pick"]'); } finally { evaluate(() => document.querySelector('[data-probe="pick"]')?.removeAttribute('data-probe')); }
  };
  const dialogOpen = () => evaluate(() => document.getElementById('workDialog').open);
  const closeDialog = async () => {
    evaluate(() => document.getElementById('workDialog').close());
    await wait(() => !dialogOpen(), 'dialog closed');
  };
  const openCard = async (taskId, label) => {
    const isOpen = () => evaluate(id => document.getElementById('workDialog').open && !!document.getElementById('workBody').dataset.sessionId && !!document.querySelector(`#workList [data-key="t:${id}"][aria-current="true"]`), taskId);
    for (let tries = 0; ; tries++) {
      await sleep(700);
      clickOn(`.tc[data-tool$="ply_delegate"][data-task-id="${taskId}"] .tc-go`, `card ${label}`);
      const until = Date.now() + 4000;
      while (Date.now() < until && !isOpen()) await sleep(150);
      if (isOpen()) return;
      assert.ok(tries < 3, `dialog for ${label}`);
    }
  };
  // 目次の様子。root は検索の面（ダイアログの中か、本体の右の欄か）
  const tocState = () => evaluate(() => {
    const fp = document.getElementById('filePreview'), q = fp?.querySelector('.toc-query');
    const dlg = document.getElementById('workDialog');
    return { open: !!q && !fp.hidden, inDialog: !!q && dlg.contains(q), focused: !!q && document.activeElement === q,
      count: fp?.querySelector('.toc-count')?.textContent ?? '', rows: fp?.querySelectorAll('.toc-row').length ?? 0,
      width: Math.round(fp?.getBoundingClientRect().width ?? 0), scopes: [...(fp?.querySelectorAll('.toc-scope') ?? [])].map(n => n.textContent.trim()) };
  });
  const pressKey = async (key) => { ab('press', key); await sleep(250); };
  const menuItems = () => evaluate(() => {
    const menu = [...document.querySelectorAll('[role=menu]')].find(m => m.offsetWidth > 0);
    if (!menu) return null;
    const r = menu.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
    return { items: [...menu.querySelectorAll('[role=menuitem]')].map(i => i.textContent.trim()), inDialog: !!menu.closest('#workDialog'), onTop: !!hit && (menu === hit || menu.contains(hit)) };
  });
  const closeMenu = async () => {
    ab('press', 'Escape');
    await wait(() => evaluate(() => ![...document.querySelectorAll('[role=menu]')].some(m => m.offsetWidth > 0)), 'menu closed');
  };
  const contextOn = (sel) => evaluate(s => {
    const n = document.querySelector(s);
    n.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 12), clientY: Math.round(r.top + r.height / 2) }));
    return true;
  }, sel);

  // ---- 本体の基準（変更前と同じ）: 目次は本体の右の欄、⋮ には分岐・編集して再送信が出る ----
  await sleep(500);
  ab('press', 'Control+f');
  await wait(() => tocState().open, 'main toc opened by Ctrl+F');
  let toc = tocState();
  assert.equal(toc.inDialog, false, 'main toc is not inside the work dialog');
  assert.ok(toc.focused, 'the search field has focus');
  const mainScopes = toc.scopes, mainWidth = toc.width;
  await pressKey('Escape');
  await wait(() => !tocState().open, 'main toc closed by Esc');
  evaluate(() => { const m = document.querySelector('#log .m[data-role=user]'); m.querySelector('.who-more').click(); });
  await wait(() => menuItems(), 'main message menu');
  const mainMenu = menuItems();
  assert.ok(mainMenu.items.some(x => x.includes('分岐')), `main menu has fork: ${mainMenu.items}`);
  assert.ok(mainMenu.items.some(x => x.includes('編集して再送信')), `main menu has edit/resend: ${mainMenu.items}`);
  await closeMenu();
  console.log('PASS: main search and menu as before', JSON.stringify({ mainScopes, mainWidth, mainMenu: mainMenu.items }));

  // ---- 1. ダイアログの Ctrl+F は子の会話を探す ----
  await openCard(child.taskId, 'child');
  await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="child-note.md"]')), 'child body');
  await wait(() => evaluate(() => !document.getElementById('workTocEntry').hidden), 'modal toc button shown');
  const entry = evaluate(() => { const b = document.getElementById('workTocEntry'); return { label: b.getAttribute('aria-label'), mainLabel: document.getElementById('tocEntry').getAttribute('aria-label') }; });
  assert.equal(entry.label, entry.mainLabel, 'same wording as the main button');
  ab('press', 'Control+f');
  await wait(() => tocState().open, 'modal toc opened by Ctrl+F');
  toc = tocState();
  assert.ok(toc.inDialog && toc.focused, `the toc is inside the dialog with focus: ${JSON.stringify(toc)}`);
  const words = list => list.map(x => x.replace(/[0-9]/g, ''));
  assert.deepEqual(words(toc.scopes), words(mainScopes), 'same scope wording as main (counts differ by conversation)');
  ab('keyboard', 'type', 'needle-child');
  // 対象の初期は「発言」（自分の発言だけ）。返答・ツールの一致は、段ごとの件数（バッジ）に出る
  const tally = () => evaluate(() => [...document.querySelectorAll('#filePreview .toc-scope')].map(n => Number(n.querySelector('.toc-badge')?.textContent) || 0));
  // 段の件数は「その段まで」の累計。語が返答にだけあるので、発言は 0、返答は 1
  await wait(() => evaluate(() => document.querySelector('#filePreview .toc-query').value === 'needle-child') && tally()[1] > 0 && tally()[0] === 0, 'child reply found in the dialog toc');
  const found = { ...tocState(), tally: tally() };
  ab('press', 'Control+a'); ab('keyboard', 'type', 'zebra-main-only');
  await sleep(700);
  assert.deepEqual(tally(), [0, 0, 0], `the main conversation word does not match in the child: ${JSON.stringify(tally())}`);
  if (shots) { fs.mkdirSync(shots, { recursive: true }); ab('screenshot', path.join(shots, 'modal-toc-1280.png')); }
  console.log('PASS: Ctrl+F in the dialog searches the child conversation', JSON.stringify({ found: found.tally, width: found.width, mainWidth }));

  // ---- 2. Esc は 1 枚ずつ ----
  await pressKey('Escape');
  await sleep(300);
  assert.equal(tocState().open, false, 'first Esc closes the toc');
  assert.equal(dialogOpen(), true, 'the dialog stays open after the first Esc');
  await pressKey('Escape');
  await wait(() => !dialogOpen(), 'second Esc closes the dialog');
  console.log('PASS: Esc closes the toc first, then the dialog');

  // ---- 閉じたら Ctrl+F は本体へ戻る ----
  await sleep(300);
  ab('press', 'Control+f');
  await wait(() => tocState().open, 'toc after the dialog closed');
  toc = tocState();
  assert.equal(toc.inDialog, false, 'Ctrl+F goes to the main conversation after the dialog closes');
  ab('keyboard', 'type', 'zebra-main-only');
  await wait(() => /[1-9]/.test(tocState().count), 'main search finds main-only word');
  await pressKey('Escape');
  console.log('PASS: after the dialog closed Ctrl+F searches the main conversation');

  // ---- 3. 発言のメニュー ----
  await openCard(child.taskId, 'child (menu)');
  await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="child-note.md"]')), 'child body again');
  const userSel = '#workBody .m[data-role=user]', aiSel = '#workBody .m.ai';
  assert.ok(evaluate(s => !!document.querySelector(s), userSel), 'the request row exists');
  contextOn(userSel);
  await wait(() => menuItems(), 'child user menu');
  let menu = menuItems();
  assert.ok(menu.inDialog && menu.onTop, `menu is above the dialog: ${JSON.stringify(menu)}`);
  assert.deepEqual(menu.items.map(x => x.replace(/\s+/g, '')), ['コピー', 'エージェントに渡した原文を見る'], `user menu items: ${menu.items}`);
  await closeMenu();
  contextOn(aiSel);
  await wait(() => menuItems(), 'child ai menu');
  menu = menuItems();
  assert.deepEqual(menu.items, ['返答をコピー', '不適切な AI の内容を報告'], `ai menu items: ${menu.items}`);
  await closeMenu();
  // ⋮ のボタンからも同じ
  evaluate(s => document.querySelector(`${s} .who-more`).click(), userSel);
  await wait(() => menuItems(), 'child ⋮ menu');
  assert.ok(menuItems().items.every(x => !/分岐|編集|再送信/.test(x)), 'no fork/edit/resend from the ⋮ button');
  if (shots) ab('screenshot', path.join(shots, 'modal-message-menu-1280.png'));
  await closeMenu();
  console.log('PASS: child message menu has copy/source/report only');

  // ---- 4. リンクの右クリックとファイルのメニュー ----
  contextOn('#workBody a.file-link[data-file-path="child-note.md"]');
  await wait(() => menuItems(), 'file menu');
  menu = menuItems();
  assert.ok(menu.inDialog && menu.onTop, `file menu is above the dialog: ${JSON.stringify(menu)}`);
  assert.ok(menu.items.some(x => x.includes('パスをコピー')), `has copy path: ${menu.items}`);
  assert.ok(menu.items.every(x => !x.includes('会話で使う')), `no "use in conversation": ${menu.items}`);
  const fileMenu = menu.items;
  await closeMenu();
  console.log('PASS: file link menu in the dialog', JSON.stringify(fileMenu));

  // ---- 5. 右の欄（ファイル）と目次: 相対パスは子の作業場所で開く・中クリックも同じ・Esc は 1 枚ずつ（目次 → 欄 → ダイアログ） ----
  const paneState = () => evaluate(() => {
    const d = document.getElementById('workDialog'), fp = document.getElementById('filePreview');
    return { inSplit: fp.parentElement.id === 'workSplit', hidden: fp.hidden, open: d.open, cls: d.className,
      tabs: [...fp.querySelectorAll('[role=tab]')].map(x => x.textContent.trim()), selected: fp.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? '',
      hasToc: !!fp.querySelector('.toc-query') };
  });
  const paneReady = () => { const s = paneState(); return s.inSplit && !s.hidden && s.tabs.some(x => x.includes('child-note')); };
  const openPaneLink = async (how) => {
    for (let tries = 0; ; tries++) {
      await sleep(700);
      if (how === 'middle') evaluate(() => { const a = document.querySelector('#workBody a.file-link[data-file-path="child-note.md"]'); a.scrollIntoView({ block: 'center' }); a.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })); });
      else clickOn('#workBody a.file-link[data-file-path="child-note.md"]', 'child file link');
      const until = Date.now() + 4000;
      while (Date.now() < until && !paneReady()) await sleep(150);
      if (paneReady()) return;
      assert.ok(tries < 3, `pane opened (${how}): ${JSON.stringify(paneState())}`);
    }
  };
  await openPaneLink('click');
  console.log('PASS: relative path opens in the dialog pane (child workspace)', JSON.stringify(paneState()));
  ab('press', 'Escape');
  await wait(() => !paneState().inSplit || paneState().hidden || !/file-preview-open/.test(paneState().cls), 'pane closed by Esc');
  assert.equal(dialogOpen(), true, 'Esc closes the pane first and keeps the dialog');
  await openPaneLink('middle');
  console.log('PASS: middle-click opens the same pane as a click', JSON.stringify(paneState()));
  // 欄が開いているところへ Ctrl+F: 目次は同じ欄に出る。Esc は 目次 → 欄 → ダイアログ
  ab('press', 'Control+f');
  await wait(() => tocState().open, 'toc while the pane is open');
  assert.ok(tocState().inDialog, 'the toc is in the dialog while the pane is open');
  const withPane = paneState();
  await pressKey('Escape');
  await sleep(300);
  const afterToc = paneState();
  console.log('Esc #1 (toc open, pane open):', JSON.stringify({ withPane, afterToc, toc: tocState().open, dialog: dialogOpen() }));
  assert.equal(tocState().open && !afterToc.hasToc, false, 'first Esc closes the toc');
  assert.equal(dialogOpen(), true, 'the dialog is still open after closing the toc');
  if (paneState().inSplit && !paneState().hidden && /file-preview-open/.test(paneState().cls)) {
    await pressKey('Escape');
    await sleep(300);
    assert.equal(dialogOpen(), true, 'second Esc closes the pane, not the dialog');
  }
  await pressKey('Escape');
  await wait(() => !dialogOpen(), 'last Esc closes the dialog');
  console.log('PASS: Esc order toc -> pane -> dialog');

  // ---- 6. 読むだけの子（ネイティブのサブエージェント）: 検索と、自分のテキストだけで足りるメニューは本体と同じ ----
  await openCard(sub.taskId, 'native');
  await wait(() => evaluate(() => !!document.querySelector('#workList [data-key]:not([data-key^="t:"])')), 'native subagent row');
  const subKey = evaluate(() => document.querySelector('#workList [data-key]:not([data-key^="t:"])').dataset.key);
  clickOn(`#workList [data-key="${subKey}"]`, 'subagent row');
  await wait(() => evaluate(() => document.getElementById('workBody').dataset.paneKind === 'subagent'), 'subagent body');
  await wait(() => evaluate(() => !!document.querySelector('#workBody .thread .m[data-role]')), 'subagent messages');
  // 依頼文の無い筋（この fake の子）でも、返答があれば検索の入口が出る
  await wait(() => evaluate(() => !document.getElementById('workTocEntry').hidden), 'modal toc button shown for the subagent');
  ab('press', 'Control+f');
  await wait(() => tocState().open, 'toc for the subagent');
  assert.ok(tocState().inDialog && tocState().focused, 'the subagent toc is inside the dialog with focus');
  await pressKey('Escape');
  await wait(() => !tocState().open, 'subagent toc closed');
  const kinds = evaluate(() => [...document.querySelectorAll('#workBody .thread .m[data-role]')].map(n => n.dataset.role + (n.classList.contains('ai') ? '/ai' : '')));
  console.log('subagent rows:', JSON.stringify(kinds));
  const subMenus = {};
  for (const sel of ['#workBody .thread .m[data-role=user]', '#workBody .thread .m.ai']) {
    if (!evaluate(s => !!document.querySelector(s), sel)) continue;
    contextOn(sel);
    await wait(() => menuItems(), `subagent menu ${sel}`);
    const m = menuItems();
    assert.ok(m.inDialog && m.onTop, `subagent menu is above the dialog: ${JSON.stringify(m)}`);
    assert.ok(m.items.every(x => !/分岐|編集|再送信/.test(x)), `no fork/edit/resend for the subagent: ${m.items}`);
    subMenus[sel] = m.items;
    await closeMenu();
  }
  assert.ok(Object.keys(subMenus).length > 0, 'the subagent thread has at least one message with a menu');
  console.log('PASS: native subagent (read-only) has search and the copy/source/report menu', JSON.stringify(subMenus));

  // ---- 7. 頭の右端: 本体の頭と同じボタン・同じ名前・同じ順。パネルは開け閉めでき、Ctrl+Shift+B は前面のモーダルに効く ----
  const headButtons = () => evaluate(() => {
    const vis = n => n.offsetWidth > 0 && n.offsetHeight > 0;
    return [...document.querySelectorAll('#workHead .bg-dt-actions button')].filter(vis).map(b => ({ id: b.id || (b.classList.contains('bg-open') ? 'bg-open' : b.className), label: b.getAttribute('aria-label'), expanded: b.getAttribute('aria-expanded'), inHeading: !!b.closest('#workHead') && !b.closest('#workDialog > header') }));
  });
  const mainLabel = id => evaluate(i => document.getElementById(i).getAttribute('aria-label'), id);
  const paneOpen = () => { const s = paneState(); return s.inSplit && !s.hidden && /file-preview-open/.test(s.cls); };
  // 読むだけの子（サブエージェント）: 親の会話のタブを開け閉めする。ボタンは出る
  let buttons = headButtons();
  assert.deepEqual(buttons.map(b => b.id).slice(0, 2), ['workTocEntry', 'workBrowserEntry'], `subagent head buttons: ${JSON.stringify(buttons)}`);
  assert.ok(buttons.every(b => b.inHeading), 'the buttons are in the conversation heading, not in the top band');
  const subPane = buttons.find(b => b.id === 'workBrowserEntry');
  assert.equal(subPane.expanded, 'false', 'pane button starts closed');
  clickOn('#workBrowserEntry', 'subagent pane button');
  await wait(() => paneOpen(), 'subagent pane opened');
  // 開いている間、本体と同じに頭のボタンはタブの列の ✖ へ受け渡される（見えないが、押した状態は持つ）
  const entryNow = () => evaluate(() => { const b = document.getElementById('workBrowserEntry'); return { expanded: b.getAttribute('aria-expanded'), label: b.getAttribute('aria-label'), handed: b.classList.contains('entry-handed') }; });
  assert.equal(entryNow().expanded, 'true', 'pressed state follows the pane');
  await wait(() => !/file-preview-moving/.test(paneState().cls), 'the pane settles');
  await sleep(500);
  clickOn('#filePreview .bu-panel-close:not([hidden])', 'the pane close (✖) the button was handed to');
  await wait(() => !paneOpen(), 'subagent pane closed').catch(e => { throw new Error(`${e.message} ${JSON.stringify([paneState(), evaluate(() => { const c = document.querySelector('#filePreview .bu-panel-close'); const r = c?.getBoundingClientRect(); return c && { hidden: c.hidden, rect: [r.left, r.top, r.width, r.height], label: c.getAttribute('aria-label'), top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.outerHTML.slice(0, 120) }; })])}`); });
  assert.equal(entryNow().expanded, 'false', 'pressed state is released when the pane closes');
  console.log('PASS: subagent head has search + pane buttons; the pane toggles', JSON.stringify(buttons));
  // 委譲した子: 同じ並び。名前は本体のボタンと同じ。Ctrl+Shift+B はモーダルのパネルを開け閉めし、本体のは開かない
  clickOn(`#workList [data-key="t:${child.taskId}"]`, 'delegated child row');
  await wait(() => evaluate(() => document.getElementById('workBody').dataset.paneKind === 'task'), 'child body');
  buttons = headButtons();
  const ids = buttons.map(b => b.id);
  assert.deepEqual(ids.slice(0, 2), ['workTocEntry', 'workBrowserEntry'], `order: toc, pane first: ${JSON.stringify(buttons)}`);
  assert.equal(ids[ids.length - 1], 'bg-open', 'the open-as-conversation arrow stays last');
  assert.equal(buttons[0].label, mainLabel('tocEntry'), 'search button wording is the main one');
  assert.equal(buttons[1].label, mainLabel('browserEntry'), 'pane button wording is the main one');
  ab('press', 'Control+Shift+b');
  await wait(() => paneOpen(), 'Ctrl+Shift+B opens the modal pane');
  // 1 回で開いた（二重に切り替わっていない）。欄は本体の右ではなくモーダルの中にある
  assert.equal(evaluate(() => document.getElementById('filePreview').parentElement.id), 'workSplit', 'the pane opened inside the dialog');
  assert.notEqual(entryNow().label, buttons[1].label, 'the label turns into the close wording');
  ab('press', 'Control+Shift+b');
  await wait(() => !paneOpen(), 'Ctrl+Shift+B closes the modal pane');
  console.log('PASS: delegated child head: same order and wording as main, Ctrl+Shift+B acts on the modal', JSON.stringify(buttons));

  // ---- 8. 「最新へ」と Alt+↑↓・End。リンクの行き先の一行 ----
  const scrollState = () => evaluate(() => { const b = document.getElementById('workBody'); const n = document.querySelector('#workBodyFrame > .nav-latest'); return { top: Math.round(b.scrollTop), away: Math.round(b.scrollHeight - b.clientHeight - b.scrollTop), latest: !!n && !n.hidden && n.offsetWidth > 0, label: n?.getAttribute('aria-label') ?? '' }; });
  evaluate(() => { const b = document.getElementById('workBody'); b.scrollTop = b.scrollHeight; });
  await wait(() => scrollState().away < 4 && !scrollState().latest, 'at the end: no latest button');
  evaluate(() => { document.getElementById('workBody').scrollTop = 0; });
  await wait(() => scrollState().latest, 'away from the end: the latest button shows');
  const mainLatest = evaluate(() => document.querySelector('#logFrame > .nav-latest')?.getAttribute('aria-label') ?? '');
  assert.equal(scrollState().label, mainLatest, 'latest button wording is the main one');
  clickOn('#workBodyFrame > .nav-latest', 'latest button');
  await wait(() => scrollState().away < 4 && !scrollState().latest, 'the latest button goes to the end and disappears');
  // Alt+↑ はひとつ前の発言へ、End は末尾へ（本文にフォーカスがあるとき）
  evaluate(() => document.getElementById('workBody').focus());
  const before = scrollState().top;
  ab('press', 'Alt+ArrowUp');
  await wait(() => scrollState().top < before, 'Alt+ArrowUp moves to the previous message');
  ab('press', 'End');
  await wait(() => scrollState().away < 4, 'End goes to the latest');
  // 一覧にフォーカスがあるときは奪わない（一覧の ↑↓・End は一覧のもの）
  evaluate(() => document.querySelector('#workList [data-key]').focus());
  const keep = scrollState().top;
  ab('press', 'Alt+ArrowUp'); await sleep(500);
  assert.equal(scrollState().top, keep, 'Alt+ArrowUp does not act from the list');
  console.log('PASS: the latest button, Alt+Up/Down and End work in the dialog like main');
  // リンクの行き先の一行（デスクトップ版のホストのときだけ出る本体の規則と同じ。窓に plyDesktop が有るとき）
  evaluate(() => { window.plyDesktop = { openExternal() {} }; });
  const statusOf = () => evaluate(() => { const b = document.querySelector('#workBodyFrame > .url-status'); if (!b) return null; const r = b.getBoundingClientRect(), f = document.getElementById('workBodyFrame').getBoundingClientRect(); return { on: b.classList.contains('on'), text: b.textContent.trim(), inFrame: r.left >= f.left && r.bottom <= f.bottom + 1 && r.top >= f.top, left: Math.round(r.left - f.left), bottomGap: Math.round(f.bottom - r.bottom) }; });
  // 先にスクロールを終えてから乗せる（スクロールは一行を隠す。本体と同じ）
  evaluate(() => { [...document.querySelectorAll('#workBody a')].find(n => /example\.com/.test(n.href)).scrollIntoView({ block: 'center', behavior: 'instant' }); });
  await sleep(400);
  evaluate(() => { [...document.querySelectorAll('#workBody a')].find(n => /example\.com/.test(n.href)).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })); });
  await wait(() => statusOf()?.on, 'the url status line shows over a link in the dialog').catch(e => { throw new Error(`${e.message} ${JSON.stringify(evaluate(() => ({ link: [...document.querySelectorAll('#workBody a')].filter(n => /example/.test(n.href)).map(n => n.outerHTML.slice(0, 200)), status: [...document.querySelectorAll('.url-status')].map(n => n.parentElement.id || n.parentElement.tagName + ':' + n.className), desktop: typeof window.plyDesktop?.openExternal, remote: !!window.plyRemote })))}`); });
  const status = statusOf();
  assert.ok(status.inFrame && /example\.com\/docs\/page/.test(status.text), `url status is in the dialog frame: ${JSON.stringify(status)}`);
  assert.equal(evaluate(() => !!document.querySelector('main > .url-status.on')), false, 'the main status line stays off');
  if (shots) ab('screenshot', path.join(shots, 'modal-url-status-1280.png'));
  evaluate(() => { const a = [...document.querySelectorAll('#workBody a')].find(n => /example\.com/.test(n.href)); a.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body })); });
  await wait(() => !statusOf()?.on, 'the url status line hides');
  evaluate(() => { delete window.plyDesktop; });
  console.log('PASS: link destination line appears at the lower left of the conversation in the dialog', JSON.stringify(status));

  // ---- 9. 狭い幅: 760px は目次が全面、360px は下からのシート。Esc 1 回は目次だけを閉じる。⋯ の中にパネルがある ----
  const narrowStates = {};
  for (const [w, h] of [[760, 800], [360, 740]]) {
    await closeDialog();
    ab('set', 'viewport', String(w), String(h));
    await sleep(900);
    await openCard(child.taskId, `child at ${w}`);
    await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="child-note.md"]') && !document.getElementById('workTocEntry').hidden), `child body at ${w}`);
    const narrowButtons = headButtons();
    if (w === 360) {
      assert.deepEqual(narrowButtons.map(b => b.id), ['workTocEntry', 'workBrowserEntry', 'workMore', 'bg-open'], `360px head: toc, [N], ⋯, arrow: ${JSON.stringify(narrowButtons)}`);
      assert.match(narrowButtons[1].label, /\d/, 'at 360px the pane button is the [N] tab count form, like main');
    }
    ab('press', 'Control+f');
    await wait(() => evaluate(() => !!document.querySelector('#filePreview .toc-query, .toc-sheet .toc-query')), `toc at ${w}`);
    const form = evaluate(() => ({ sheet: !!document.querySelector('.toc-sheet .toc-query'), pane: !!document.querySelector('#filePreview .toc-query') }));
    await pressKey('Escape');
    await sleep(500);
    const afterOne = evaluate(() => ({ dialog: document.getElementById('workDialog').open, toc: !!document.querySelector('.toc-query') }));
    assert.deepEqual(afterOne, { dialog: true, toc: false }, `one Esc closes only the toc at ${w}px (${JSON.stringify(form)})`);
    await pressKey('Escape');
    await wait(() => !dialogOpen(), `the second Esc closes the dialog at ${w}px`);
    narrowStates[w] = { form, afterOne, head: narrowButtons.map(b => b.id) };
  }
  console.log('PASS: at 760px and 360px one Esc closes only the toc', JSON.stringify(narrowStates));
  // 360px の ⋯: パネルの開け閉めだけが入っている
  await openCard(child.taskId, 'child at 360 (more)');
  await wait(() => evaluate(() => !document.getElementById('workMore').hidden), 'more button');
  clickOn('#workMore', 'more button');
  await wait(() => menuItems(), 'the more menu');
  const moreMenu = menuItems();
  assert.ok(moreMenu.inDialog && moreMenu.onTop, `the more menu is above the dialog: ${JSON.stringify(moreMenu)}`);
  assert.equal(moreMenu.items.length, 1, `the more menu has only the pane item: ${moreMenu.items}`);
  await closeMenu();
  await closeDialog();
  ab('set', 'viewport', '1280', '800');
  console.log('PASS: the dialog menu at 360px holds the pane item', JSON.stringify(moreMenu.items));
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
