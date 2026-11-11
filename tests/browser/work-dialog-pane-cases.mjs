// 作業のダイアログの右の欄の、中身の種類・切り替え・再接続（実ブラウザー。ADR 0315）:
//   1. 孫（子の子）の会話: 一覧から孫を選び、その本文のリンクが孫のタブ・孫の cwd で開く（modal の窓口は孫）
//   2. 欄を開いたまま別の子へ切り替える: 前の子の欄は閉じ、新しい子のリンクはその子のタブで開く
//   3. ネイティブのサブエージェント: 欄は親（その子）の会話のタブ（窓口は見ない）
//   4. 再接続: つなぎ直したあとに modal の窓口を子の会話で伝え直す
//   5. 可視化の「ページで開く」の出来事・欄の ⋮ メニューが、ダイアログの中で見える（ダイアログの外に隠れない）
//   委譲先ホストの子は、サーバーが 2 台要るので work-dialog-links.mjs の合成の確認と host-task-offline.mjs に任せる
// 実行: node tests/browser/work-dialog-pane-cases.mjs   （会話の agent-browser の窓を使う）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-pane-cases-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_PANE_SHOTS;
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

  // 孫の cwd にだけあるファイル・子（兄弟）の cwd にだけあるファイル
  const grandDir = path.join(base, 'grand-dir'), siblingDir = path.join(base, 'sibling-dir'), childDir = path.join(base, 'child-dir');
  for (const [dir, file] of [[grandDir, 'grand-note.md'], [siblingDir, 'sibling-note.md'], [childDir, 'child-note.md']]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), `# ${file}\n`);
  }
  const grandSteps = path.join(base, 'grand-steps.json');
  fs.writeFileSync(grandSteps, JSON.stringify({ steps: [{ text: 'Grand: see [grand note](grand-note.md).' }] }));
  const siblingSteps = path.join(base, 'sibling-steps.json');
  fs.writeFileSync(siblingSteps, JSON.stringify({ steps: [{ text: 'Sibling: see [sibling note](sibling-note.md).' }] }));

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Pane cases' });
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
  // 子 C: 本文の中身は自分の台本。孫 G を委譲して終わる
  const grandCall = { name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title: 'grand', task: `steps:@${grandSteps}`, cwd: grandDir } };
  const childSteps = path.join(base, 'child-steps.json');
  fs.writeFileSync(childSteps, JSON.stringify({ steps: [{ text: 'Child: see [child note](child-note.md).' }] }));
  const sibling = await delegate(parent, 'sibling', `steps:@${siblingSteps}`, siblingDir);
  const child = await delegate(parent, 'child', 'ply:' + JSON.stringify(grandCall), childDir);
  // 孫が走り終わるのを待つ（子の完了通知で親にターンが戻る間も含めて、一覧に孫の行が出るまで）
  await sleep(1500);

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 2), 'delegate cards');

  const snap = () => evaluate(() => {
    const d = document.getElementById('workDialog'), fp = document.getElementById('filePreview');
    return { dialogOpen: d.open, inSplit: fp.parentElement.id === 'workSplit', hidden: fp.hidden, cls: d.className,
      tabs: [...fp.querySelectorAll('[role=tab]')].map(t => t.textContent.trim()),
      selected: fp.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? '',
      text: fp.textContent, kind: document.getElementById('workBody').dataset.paneKind ?? '', sid: document.getElementById('workBody').dataset.sessionId ?? '' };
  });
  const clickOn = (sel, label) => {
    const ok = evaluate(s => { const n = document.querySelector(s); if (!n) return false; n.dataset.probe = 'pick'; n.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; }, sel);
    assert.ok(ok, `target exists: ${label}`);
    try { ab('click', '[data-probe="pick"]'); } finally { evaluate(() => document.querySelector('[data-probe="pick"]')?.removeAttribute('data-probe')); }
  };
  const closeDialog = async () => {
    evaluate(() => document.getElementById('workDialog').close());
    await wait(() => evaluate(() => !document.getElementById('workDialog').open), 'dialog closed');
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
  // 子の一覧の行を押して切り替える
  const selectRow = async (key, label) => {
    clickOn(`#workList [data-key="${key}"]`, `row ${label}`);
    await wait(() => evaluate(k => document.querySelector(`#workList [data-key="${k}"]`)?.getAttribute('aria-current') === 'true', key), `row selected: ${label}`);
  };
  // 本物のポインターで押し、欄が付け替わる（動きで幅が動く間は外れるので、落ち着いてから押し直す）まで
  const openLink = async (sel, label, ready) => {
    for (let tries = 0; ; tries++) {
      await sleep(700);
      clickOn(sel, label);
      const until = Date.now() + 4000;
      while (Date.now() < until && !ready()) await sleep(150);
      if (ready()) return;
      assert.ok(tries < 3, `pane opened for ${label}: ${JSON.stringify(await snap()).slice(0, 400)}`);
    }
  };
  // サーバーへ伝えた watchSession を記録する（再接続のあと伝え直すかを見る）
  const installHook = () => evaluate(() => {
    window.__watch = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const m = JSON.parse(data); if (m.command === 'watchSession') window.__watch.push({ sessionId: m.args?.sessionId ?? null, slot: m.args?.slot ?? 'main' }); } catch { /* 文字でないフレーム */ }
      window.__ws = this;
      return send.call(this, data);
    };
  });
  installHook();

  // ---- 1. 孫: 一覧から孫を選び、本文のリンクが孫のタブ・孫の cwd で開く ----
  await openCard(child.taskId, 'child');
  const childBodySid = evaluate(() => document.getElementById('workBody').dataset.sessionId);
  const rows = evaluate(() => [...document.querySelectorAll('#workList [data-key]')].map(r => ({ key: r.dataset.key, text: r.textContent.trim().replace(/\s+/g, ' ').slice(0, 60), sub: r.classList.contains('sub') })));
  console.log('list rows:', JSON.stringify(rows));
  const grandRow = rows.find(r => r.key.startsWith('t:') && r.key !== `t:${child.taskId}` && r.key !== `t:${sibling.taskId}`);
  assert.ok(grandRow, `the grandchild is in the list: ${JSON.stringify(rows)}`);
  await selectRow(grandRow.key, 'grandchild');
  await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="grand-note.md"]')), 'link in the grandchild');
  let s = await snap();
  assert.equal(s.kind, 'task');
  const grandId = s.sid;
  assert.ok(grandId && grandId !== childBodySid, 'the body shows the grandchild conversation, not the child');
  await openLink('#workBody a.file-link[data-file-path="grand-note.md"]', 'grandchild link', () => evaluate(() => document.getElementById('filePreview').parentElement.id === 'workSplit' && document.getElementById('filePreview').textContent.includes('grand-dir')));
  s = await snap();
  assert.equal(s.dialogOpen, true, 'the dialog stays open');
  assert.ok(s.tabs.some(x => x.includes('grand-note.md')), `grandchild tab: ${s.tabs}`);
  assert.ok(!s.text.includes('child-dir') && !s.text.includes('sibling-dir'), 'resolved in the grandchild cwd only');
  const watchAfterGrand = evaluate(() => window.__watch.filter(w => w.slot === 'modal').at(-1));
  assert.equal(watchAfterGrand?.sessionId, grandId, `the modal slot watches the grandchild: ${JSON.stringify(watchAfterGrand)}`);
  if (shots) { fs.mkdirSync(shots, { recursive: true }); ab('screenshot', path.join(shots, 'pane-grandchild.png')); }
  console.log('PASS: grandchild link opens in the grandchild tab and cwd; the modal slot watches the grandchild');

  // ---- 2. 欄を開いたまま別の子へ切り替える ----
  await selectRow(`t:${sibling.taskId}`, 'sibling');
  await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="sibling-note.md"]')), 'link in the sibling');
  s = await snap();
  assert.ok(s.hidden || !/file-preview-open/.test(s.cls) || !s.text.includes('grand-dir'), `the previous child's pane is closed or replaced: ${JSON.stringify({ hidden: s.hidden, cls: s.cls, tabs: s.tabs })}`);
  await openLink('#workBody a.file-link[data-file-path="sibling-note.md"]', 'sibling link', () => evaluate(() => document.getElementById('filePreview').parentElement.id === 'workSplit' && document.getElementById('filePreview').textContent.includes('sibling-dir')));
  s = await snap();
  assert.ok(s.tabs.some(x => x.includes('sibling-note.md')), `sibling tab: ${s.tabs}`);
  assert.ok(s.tabs.every(x => !x.includes('grand-note.md')), `no tab of the previous child: ${s.tabs}`);
  assert.ok(!s.text.includes('grand-dir'), 'not the previous child cwd');
  const watchAfterSwitch = evaluate(() => window.__watch.filter(w => w.slot === 'modal').at(-1));
  assert.equal(watchAfterSwitch?.sessionId, s.sid, `the modal slot follows the switch: ${JSON.stringify(watchAfterSwitch)}`);
  console.log('PASS: switching to another child gives that child its own tab and watch');

  // ---- 5a. 欄の ⋮ メニューがダイアログの中で見える ----
  const moreSel = '#filePreview .bu-more';
  clickOn(moreSel, 'pane more');
  await wait(() => evaluate(() => [...document.querySelectorAll('[role=menu]')].some(m => m.offsetWidth > 0)), 'menu shown');
  const menuProbe = evaluate(() => {
    const menu = [...document.querySelectorAll('[role=menu]')].find(m => m.offsetWidth > 0);
    const r = menu.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
    return { inDialog: !!menu.closest('#workDialog'), visible: r.width > 0 && r.height > 0, onTop: !!hit && (menu === hit || menu.contains(hit)), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
  });
  assert.ok(menuProbe.visible && menuProbe.onTop, `the pane menu is visible and on top: ${JSON.stringify(menuProbe)}`);
  if (shots) ab('screenshot', path.join(shots, 'pane-more-menu.png'));
  ab('press', 'Escape');
  await wait(() => evaluate(() => ![...document.querySelectorAll('[role=menu]')].some(m => m.offsetWidth > 0)), 'menu closed');
  assert.equal((await snap()).dialogOpen, true, 'Esc closed only the menu');
  console.log('PASS: the pane ⋮ menu is visible inside the dialog', JSON.stringify(menuProbe));

  // ---- 5b. 可視化の「ページで開く」の出来事をダイアログの中から出すと、ダイアログの欄に載る ----
  await selectRow(`t:${sibling.taskId}`, 'sibling (visualize)');
  await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="sibling-note.md"]')), 'sibling body');
  evaluate(() => {
    const b = document.createElement('button'); b.id = 'synthetic-viz'; b.type = 'button'; b.textContent = 'viz';
    document.getElementById('workBody').append(b);
    b.addEventListener('click', () => b.dispatchEvent(new CustomEvent('ply-visualize-browser', { bubbles: true, detail: { content: '<!doctype html><h1 id="viz-h">viz-body</h1>', title: 'viz-title', bundle: null, path: '' } })));
  });
  for (let tries = 0; tries < 4; tries++) {
    clickOn('#synthetic-viz', 'visualize open');
    const until = Date.now() + 3000;
    while (Date.now() < until && !(await snap()).inSplit) await sleep(150);
    if ((await snap()).inSplit) break;
  }
  s = await snap();
  assert.equal(s.dialogOpen, true, 'the dialog stays open for the visualization');
  assert.ok(s.inSplit && /file-preview-open/.test(s.cls), `the visualization opens in the dialog pane: ${JSON.stringify({ inSplit: s.inSplit, cls: s.cls })}`);
  assert.ok(s.text.includes('viz-title') || evaluate(() => !!document.querySelector('#filePreview iframe')), 'the visualization is in the pane');
  console.log('PASS: visualize "open in panel" opens inside the dialog pane');
  ab('press', 'Escape');
  await wait(() => evaluate(() => document.getElementById('filePreview').hidden || !document.getElementById('workDialog').classList.contains('file-preview-open')), 'pane closed by Esc');

  // ---- 4. 再接続: つなぎ直したあと、modal の窓口を子の会話で伝え直す ----
  const childSid = (await snap()).sid;
  evaluate(() => { window.__watch.length = 0; window.__ws.close(); });
  await wait(() => evaluate(() => window.__watch.some(w => w.slot === 'modal')), 'modal watch resent after reconnect', 30_000);
  const resent = evaluate(() => window.__watch.filter(w => w.slot === 'modal').at(-1));
  assert.equal(resent.sessionId, childSid, `the modal slot is restored after reconnect: ${JSON.stringify(resent)}`);
  assert.equal(evaluate(() => document.getElementById('workDialog').open), true, 'the dialog survives the reconnect');
  // つなぎ直したあとも、リンクが欄で開く
  await sleep(1500);
  await openLink('#workBody a.file-link[data-file-path="sibling-note.md"]', 'link after reconnect', () => evaluate(() => document.getElementById('filePreview').parentElement.id === 'workSplit' && !document.getElementById('filePreview').hidden && document.getElementById('filePreview').textContent.includes('sibling-dir')));
  console.log('PASS: after reconnect the modal slot is restored and links still open in the pane');
  await closeDialog();

  // ---- 3. ネイティブのサブエージェント: 欄は親（その子）の会話のタブ ----
  const sub = await delegate(parent, 'native', 'bg 1 8', childDir, e => e.type === 'turnEnd' && e.sessionId !== parent);
  await sleep(1500);
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list again');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 3), 'delegate cards again');
  installHook();
  await openCard(sub.taskId, 'native');
  const subParentSid = evaluate(() => document.getElementById('workBody').dataset.sessionId);
  await wait(() => evaluate(() => !!document.querySelector('#workList .sub[data-key], #workList [data-key]:not([data-key^="t:"])')), 'native subagent row');
  const subKey = evaluate(() => (document.querySelector('#workList .sub[data-key]') ?? document.querySelector('#workList [data-key]:not([data-key^="t:"])')).dataset.key);
  await selectRow(subKey, 'native subagent');
  await wait(() => evaluate(() => document.getElementById('workBody').dataset.paneKind === 'subagent'), 'subagent body');
  s = await snap();
  assert.equal(s.sid, subParentSid, 'the subagent pane belongs to the delegating child conversation');
  evaluate(() => {
    const a = document.createElement('a'); a.className = 'md-link file-link'; a.href = '/local-file?path=x'; a.dataset.filePath = 'child-note.md'; a.textContent = 'synthetic'; a.id = 'synthetic-sub';
    document.getElementById('workBody').append(a);
  });
  await openLink('#synthetic-sub', 'subagent link', () => evaluate(() => document.getElementById('filePreview').parentElement.id === 'workSplit' && document.getElementById('filePreview').textContent.includes('child-dir')));
  const watchSub = evaluate(() => window.__watch.filter(w => w.slot === 'modal').at(-1));
  assert.equal(watchSub?.sessionId ?? null, null, `a native subagent has no stream of its own to watch: ${JSON.stringify(watchSub)}`);
  console.log('PASS: native subagent opens its pane for the delegating child; modal watch =', JSON.stringify(watchSub));
  await closeDialog();
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
