// 作業のダイアログの入力欄の＋（ADR 0317）。実ブラウザー。
//   1. ＋ の名前（title / aria-label）はメインの＋と同じ「添付（この端末から / ホストから）」
//   2. ＋ を押すと、メインと同じ「この端末から / ホストから」のメニューがダイアログの中に開く（ファイル選択を直に開かない）
//   3. 「ホストから」でその子の作業場所のファイルを選んで添付すると、子の入力欄の添付に入る。メインの入力欄は変わらない
//   4. Esc でメニューだけが閉じ、ダイアログは開いたまま
// 実行: node tests/browser/work-dialog-attach-menu.mjs   （WORK_DIALOG_ATTACH_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-attach-menu-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_ATTACH_SHOTS;
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
  await sleep(1500);

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 1), 'delegate cards');

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

  // ---- 1〜4 ----
  await openCard(child.taskId, 'child');
  await wait(() => evaluate(() => !!document.getElementById('wkPrompt') && !document.getElementById('wkPrompt').closest('form').hidden), 'child composer');
  const titles = evaluate(() => ({ main: document.getElementById('attach').title, modal: document.getElementById('wkAttach').title, modalLabel: document.getElementById('wkAttach').getAttribute('aria-label') }));
  console.log('titles', JSON.stringify(titles));
  assert.equal(titles.modal, titles.main, 'the modal + has the same name as the main +');
  assert.equal(titles.modalLabel, titles.main, 'aria-label too');
  assert.ok(titles.main.includes('ホストから'), titles.main);
  console.log('PASS: the modal + is named like the main +');

  const mainBefore = evaluate(() => (document.getElementById('prompt').value ?? '') + '|' + document.getElementById('prompt').closest('form').textContent);
  clickOn('#wkAttach', 'modal +');
  await wait(() => evaluate(() => { const p = document.getElementById('wkAttachPop'); return !!p && !p.hidden && p.offsetWidth > 0; }), 'the + menu opens');
  const menu = evaluate(() => {
    const p = document.getElementById('wkAttachPop');
    return { inDialog: !!p.closest('#workDialog'), heads: [...p.querySelectorAll('.chead')].map(x => x.textContent.trim()), keys: [...p.querySelectorAll('[data-key]')].map(x => x.dataset.key), expanded: document.getElementById('wkAttach').getAttribute('aria-expanded') };
  });
  console.log('+ menu', JSON.stringify(menu));
  assert.ok(menu.inDialog, 'the + menu is inside the dialog');
  assert.deepEqual(menu.keys, ['files', 'host'], 'device files + host files');
  assert.ok(menu.heads[0].includes('この端末から') && menu.heads[1].includes('ホストから'), menu.heads.join());
  assert.equal(menu.expanded, 'true');
  shot('1-attach-menu');
  console.log('PASS: the modal + opens the same menu (inside the dialog)');

  // Esc: メニューだけ閉じる
  ab('press', 'Escape');
  await wait(() => evaluate(() => document.getElementById('wkAttachPop').hidden), 'menu closed by Esc');
  assert.ok(dialogOpen(), 'the dialog stays open after Esc closes the menu');
  console.log('PASS: Esc closes only the menu');

  // ホストのファイル
  clickOn('#wkAttach', 'modal + again');
  await wait(() => evaluate(() => !document.getElementById('wkAttachPop').hidden), 'menu reopens');
  clickOn('#wkAttachPop [data-key="host"]', 'host files');
  await wait(() => evaluate(() => !!document.querySelector('#wkAttachPop .hf-file')), 'host listing');
  const listing = evaluate(() => ({ files: [...document.querySelectorAll('#wkAttachPop .hf-file .hf-name')].map(x => x.textContent), crumb: document.querySelector('#wkAttachPop .hf-crumb')?.textContent }));
  console.log('host listing', JSON.stringify(listing));
  assert.ok(listing.files.includes('child-note.md'), 'the listing starts at the child working directory');
  shot('2-host-files');
  clickOn('#wkAttachPop .hf-file[data-path$="child-note.md"]', 'pick child-note.md');
  await sleep(300);
  clickOn('#wkAttachPop [data-key="hostAttach"]', 'attach');
  await wait(() => evaluate(() => (document.getElementById('wkPrompt').value ?? '').includes('child-note.md') || document.getElementById('wkPrompt').closest('form').textContent.includes('child-note.md')), 'file lands in the child composer');
  const mainAfter = evaluate(() => (document.getElementById('prompt').value ?? '') + '|' + document.getElementById('prompt').closest('form').textContent);
  assert.equal(mainAfter, mainBefore, 'the main composer did not change');
  shot('3-after-attach');
  console.log('PASS: a host file attached from the modal + goes into the child composer only');
  console.log('PASS');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
