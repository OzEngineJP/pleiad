// 作業のダイアログの右の欄の「会話で使う」（ADR 0317）。実ブラウザー。
//   1. 子の会話のモーダルでファイルのリンクを押して右の欄に開き、欄の ⋮（今のタブのメニュー）の「会話で使う」を押すと、
//      そのモーダルの子の入力欄に入る。メインの入力欄は変わらない
//   2. 右の欄のフッターに「会話で使う」があるなら、同じく子の入力欄に入る
//   3. 入力欄の無い子（ネイティブのサブエージェント）では、右の欄の ⋮ に「会話で使う」を出さない
//   4. モーダルを閉じて本体へ戻った後の本体の右の欄の ⋮ には「会話で使う」が出て、本体の入力欄に入る（従来どおり）
// 実行: node tests/browser/work-dialog-use-file.mjs   （WORK_DIALOG_USE_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-use-file-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_USE_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const ab = (...args) => execFileSync(process.env.AGENT_BROWSER_BIN || 'agent-browser', args, { encoding: 'utf8', timeout: 60_000 });
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, label, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};
const shot = (name) => { if (shots) { try { ab('screenshot', path.join(shots, `${name}.png`)); } catch (e) { console.log('shot failed', name, e.message.slice(0, 80)); } } };
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
  fs.writeFileSync(path.join(work, 'main-note.md'), '# main-note\n');
  const childSteps = path.join(base, 'child-steps.json');
  fs.writeFileSync(childSteps, JSON.stringify({ steps: [{ text: 'Child reply: see [child note](child-note.md).' }] }));

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Main reply: see [main note](main-note.md).' });
  const parent = first.sessionId;
  const delegate = async (title, task, cwd, until) => {
    const mark = client.mark();
    for (let tries = 0; ; tries++) {
      try {
        await client.cmd('runTurn', { sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title, task, ...(cwd ? { cwd } : {}) } }) });
        break;
      } catch (error) {
        if (tries >= 80) throw error;
        await sleep(250);
      }
    }
    const res = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
    const childEnd = await client.waitFor(until, { from: mark, ms: 30_000 });
    return { taskId: JSON.parse(res.text).taskId, childId: childEnd.sessionId };
  };
  const child = await delegate('child', `steps:@${childSteps}`, childDir, e => e.type === 'turnEnd' && e.sessionId !== parent);
  const sub = await delegate('native', 'bg 1 8', childDir, e => e.type === 'turnEnd' && e.sessionId !== parent && e.sessionId !== child.childId);
  await sleep(1500);

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 2), 'delegate cards');

  const clickOn = (sel, label) => {
    const ok = evaluate(s => { const n = document.querySelector(s); if (!n) return false; n.dataset.probe = 'pick'; n.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; }, sel);
    assert.ok(ok, `target exists: ${label}`);
    try { ab('click', '[data-probe="pick"]'); } finally { evaluate(() => document.querySelector('[data-probe="pick"]')?.removeAttribute('data-probe')); }
  };
  const dialogOpen = () => evaluate(() => document.getElementById('workDialog').open);
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
  const closeDialog = async () => {
    evaluate(() => document.getElementById('workDialog').close());
    await wait(() => !dialogOpen(), 'dialog closed');
  };
  const visibleMenu = () => evaluate(() => {
    const menu = [...document.querySelectorAll('[role=menu]')].find(m => m.offsetWidth > 0);
    return menu ? { items: [...menu.querySelectorAll('[role=menuitem]')].map(i => i.textContent.trim()), inDialog: !!menu.closest('#workDialog') } : null;
  });
  const closeMenu = async () => {
    ab('press', 'Escape');
    await wait(() => evaluate(() => ![...document.querySelectorAll('[role=menu]')].some(m => m.offsetWidth > 0)), 'menu closed');
  };
  const paneState = () => evaluate(() => {
    const fp = document.getElementById('filePreview');
    return { inSplit: fp.parentElement.id === 'workSplit', hidden: fp.hidden, tabs: [...fp.querySelectorAll('[role=tab]')].map(x => x.textContent.trim()) };
  });
  const text = (id) => evaluate(i => { const n = document.getElementById(i); return n ? (n.value ?? n.textContent ?? '') + '|' + (n.closest('form')?.textContent ?? '') : ''; }, id);
  const openMore = async () => {
    await wait(() => evaluate(() => { const b = document.querySelector('#filePreview .bu-more'); return !!b && b.offsetWidth > 0; }), 'the pane ⋮ is shown');
    await sleep(500);
    clickOn('#filePreview .bu-more', 'pane ⋮');
    await wait(() => visibleMenu(), 'pane ⋮ menu');
    return visibleMenu();
  };
  const useItem = () => evaluate(() => { const m = [...document.querySelectorAll('[role=menu]')].find(x => x.offsetWidth > 0); [...m.querySelectorAll('[role=menuitem]')].find(i => i.textContent.includes('会話で使う')).click(); });
  const footerUse = () => evaluate(() => { const b = [...document.querySelectorAll('#filePreview button')].find(n => n.textContent.trim() === '会話で使う' && n.offsetWidth > 0); if (!b) return false; b.dataset.probe = 'pick'; return true; });

  // ---- 1・2. 子の会話の右の欄 ----
  await openCard(child.taskId, 'child');
  await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="child-note.md"]')), 'child link');
  for (let tries = 0; ; tries++) {
    await sleep(700);
    clickOn('#workBody a.file-link[data-file-path="child-note.md"]', 'child file link');
    const until = Date.now() + 4000;
    while (Date.now() < until && !paneState().tabs.some(x => x.includes('child-note'))) await sleep(150);
    if (paneState().tabs.some(x => x.includes('child-note'))) break;
    assert.ok(tries < 3, 'the pane opens');
  }
  assert.ok(paneState().inSplit, 'the pane is mounted in the dialog');
  await wait(() => evaluate(() => !!document.getElementById('wkPrompt')), 'child composer');
  const mainBefore = text('prompt');
  const menu = await openMore();
  console.log('pane ⋮', JSON.stringify(menu));
  assert.ok(menu.inDialog, 'the ⋮ menu is inside the dialog');
  assert.ok(menu.items.some(x => x.includes('会話で使う')), `the pane ⋮ offers 会話で使う for a child with a composer: ${menu.items}`);
  shot('1-pane-menu');
  useItem();
  await wait(() => text('wkPrompt').includes('child-note.md'), 'the file lands in the child composer');
  assert.equal(text('prompt'), mainBefore, 'the main composer did not get the file (⋮)');
  assert.ok(evaluate(() => document.activeElement?.id === 'wkPrompt'), 'focus goes to the child composer');
  shot('2-after-use');
  console.log('PASS: the pane ⋮ 会話で使う puts the file into the child composer, not the main one');

  // 取り除いてから、フッターの「会話で使う」
  evaluate(() => { const c = document.querySelector('#wkAttachments .remove, #workDialog .wk-composer [aria-label*="削除"], #workDialog .wk-composer .chip-x'); c?.click(); });
  const hasFooter = footerUse();
  console.log('footer use button:', hasFooter);
  if (hasFooter) {
    const before = text('wkPrompt');
    try { ab('click', '[data-probe="pick"]'); } finally { evaluate(() => document.querySelector('[data-probe="pick"]')?.removeAttribute('data-probe')); }
    await sleep(800);
    assert.equal(text('prompt'), mainBefore, 'the main composer did not get the file (footer)');
    console.log('footer click: child composer changed =', text('wkPrompt') !== before);
    console.log('PASS: the pane footer 会話で使う does not touch the main composer');
  }

  // ---- 3. 入力欄の無い子（ネイティブのサブエージェント）: 項目を出さない ----
  await closeDialog();
  await openCard(sub.taskId, 'native');
  await wait(() => evaluate(() => !!document.querySelector('#workList [data-key]:not([data-key^="t:"])')), 'native subagent row');
  const subKey = evaluate(() => document.querySelector('#workList [data-key]:not([data-key^="t:"])').dataset.key);
  clickOn(`#workList [data-key="${subKey}"]`, 'subagent row');
  await wait(() => evaluate(() => document.getElementById('workBody').dataset.paneKind === 'subagent'), 'subagent body');
  // fake のサブエージェントの発言にはファイルのリンクが無いので、同じ作りのリンクを発言に足して押す（欄に出る ⋮ だけを見る）
  await wait(() => evaluate(() => !!document.querySelector('#workBody .thread .m')), 'subagent messages');
  evaluate(() => {
    const m = document.querySelector('#workBody .thread .m.ai') ?? document.querySelector('#workBody .thread .m');
    const a = document.createElement('a');
    a.className = 'file-link'; a.href = 'child-note.md'; a.dataset.filePath = 'child-note.md'; a.textContent = 'child-note.md'; a.id = 'injectedLink';
    m.appendChild(a);
  });
  for (let tries = 0; ; tries++) {
    await sleep(700);
    clickOn('#injectedLink', 'injected link in the subagent');
    const until = Date.now() + 4000;
    while (Date.now() < until && !paneState().tabs.some(x => x.includes('child-note'))) await sleep(150);
    if (paneState().tabs.some(x => x.includes('child-note'))) break;
    assert.ok(tries < 3, `the subagent pane opens a file tab: ${JSON.stringify(paneState())}`);
  }
  const subMenu = await openMore();
  console.log('subagent pane ⋮', JSON.stringify(subMenu));
  assert.ok(subMenu.inDialog, 'the subagent ⋮ menu is inside the dialog');
  assert.ok(subMenu.items.some(x => x.includes('パスをコピー')), `the subagent ⋮ still has the other file items: ${subMenu.items}`);
  assert.ok(!subMenu.items.some(x => x.includes('会話で使う')), `no 会話で使う for a child without a composer: ${subMenu.items}`);
  shot('3-subagent-pane-menu');
  await closeMenu();
  console.log('PASS: no 会話で使う in the pane ⋮ for the native subagent');
  await closeDialog();

  // ---- 4. 本体の右の欄: 従来どおり本体の入力欄へ ----
  if (!paneState().tabs.some(x => x.includes('main-note')) || evaluate(() => document.getElementById('filePreview').hidden)) clickOn('.m a.file-link[data-file-path="main-note.md"]', 'main file link');
  await wait(() => !evaluate(() => document.getElementById('filePreview').hidden) && paneState().tabs.some(x => x.includes('main-note')), 'main pane opened');
  const mainMenu = await openMore();
  console.log('main pane ⋮', JSON.stringify(mainMenu));
  assert.ok(!mainMenu.inDialog, 'the main ⋮ menu is not inside the dialog');
  assert.ok(mainMenu.items.some(x => x.includes('会話で使う')), `the main pane ⋮ offers 会話で使う: ${mainMenu.items}`);
  useItem();
  await wait(() => text('prompt').includes('main-note.md') || evaluate(() => document.getElementById('attachments')?.textContent.includes('main-note.md') ?? false), 'the file lands in the main composer');
  console.log('PASS: the main pane ⋮ 会話で使う puts the file into the main composer');
  console.log('PASS');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
