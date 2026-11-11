// 作業のダイアログ（#workDialog）の中断ボタン（ADR 0317）。実ブラウザー。
//   1. 見出しに「停止」は無い。止めるのは入力欄の中断ボタン 1 つ（塗りの四角・34×34・字なし・名前は「中断」）
//   2. 走っている子: 押すと abort が子の会話へ届き、子が止まる。一覧の印・見出しの印が同時に「中止」へ変わる
//   3. 承認待ちの子: 出る。押すと承認も片づき、子が止まる
//   4. 順番待ち（queued）の子: 出る。押すと止まる（abort で止まらなければ cancelAgentTask に切り替える根拠をここで測る）
//   5. ターンの外で孫の完了を待っている子: 出る。押すと子も孫も止まる
//   6. 止めた後の依頼元の次のターンに、止めた子が伝わる
//   7. メインの中断ボタンも同じ形（塗りの四角・34×34・字なし）
// 実行: node tests/browser/work-dialog-stop.mjs   （WORK_DIALOG_STOP_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-stop-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_STOP_SHOTS;
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
  client = await open({ ...server });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('completeSetup', { backend: 'fake' });

  const stream = (label, n, ms) => Array.from({ length: n }, (_, i) => ({ tool: 'Bash', input: { command: `${label} ${i}` }, result: `out ${label} ${i}`, ms }));
  const runFile = path.join(base, 'run-steps.json');
  fs.writeFileSync(runFile, JSON.stringify({ steps: [{ text: 'はじめます。' }, ...stream('run', 400, 250), { text: 'おわり。' }] }));

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Stop' });
  const parent = first.sessionId;
  const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
  const callParent = async (name, args) => {
    const mark = client.mark();
    for (let tries = 0; ; tries++) {
      try { await client.cmd('runTurn', { sessionId: parent, prompt: ply(name, args) }); break; }
      catch (error) { if (tries >= 80) throw error; await sleep(250); }
    }
    const res = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
    return JSON.parse(res.text);
  };
  const delegate = async (title, task) => (await callParent('ply_delegate', { backend: 'fake', kind: 'mechanical', title, task }));
  const tasks = async () => await client.cmd('agentTasks');
  const taskOf = async (taskId) => (await tasks()).find(r => r.taskId === taskId);

  // ---- 子を用意する
  const runT = await delegate('走っている子', `steps:@${runFile}`);
  await sleep(1200);
  const askT = await delegate('承認待ちの子', 'ask');
  await wait(async () => (await taskOf(askT.taskId))?.sessionId, 'ask child session');
  const askChildId = (await taskOf(askT.taskId)).sessionId;
  const askPerm = await client.waitFor(e => e.type === 'permission' && e.sessionId === askChildId, { from: 0, ms: 30_000 });
  console.log('ask permission', askPerm.id, askPerm.toolName ?? askPerm.tool);
  const resetsAt = Date.now() + 3 * 3600_000;
  const limT = await delegate('順番待ちの子', `limit ${resetsAt}`);
  await wait(async () => (await taskOf(limT.taskId))?.status === 'failed', 'limit child failed');
  const sent = await callParent('ply_task_send', { taskId: limT.taskId, message: 'echo:続き' });
  assert.equal(sent.status, 'queued', 'the limited child holds a queued send');
  await sleep(1500);
  assert.equal((await taskOf(limT.taskId)).status, 'queued', 'the limited child is a stable queued task');
  const grandArgs = { backend: 'fake', kind: 'mechanical', title: '孫', task: 'slow' };
  const grT = await delegate('孫を待つ子', ply('ply_delegate', grandArgs));
  await wait(async () => { const all = await tasks(); return all.some(r => r.parentSessionId === (all.find(x => x.taskId === grT.taskId)?.sessionId ?? '-') && ['running', 'queued'].includes(r.status)); }, 'grandchild running');
  await sleep(1500);
  console.log('grand parent task', JSON.stringify((await taskOf(grT.taskId)) && { status: (await taskOf(grT.taskId)).status }));

  const doneT = await delegate('終わった子', 'echo:済み');
  await wait(async () => (await taskOf(doneT.taskId))?.status === 'completed', 'finished child completed');

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 4), 'delegate cards');
  evaluate(() => {
    const log = window.__cmds = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const m = JSON.parse(data); if (m.command) log.push({ command: m.command, sessionId: m.args?.sessionId ?? null, taskId: m.args?.taskId ?? null }); } catch { /* 文字でないフレーム */ }
      return send.call(this, data);
    };
  });
  const cmds = (name) => evaluate(n => window.__cmds.filter(c => c.command === n), name);

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
      if (!dialogOpen()) clickOn(`.tc[data-tool$="ply_delegate"][data-task-id="${taskId}"] .tc-go`, `card ${label}`);
      else clickOn(`#workList [data-key="t:${taskId}"]`, `row ${label}`);
      const until = Date.now() + 4000;
      while (Date.now() < until && !isOpen()) await sleep(150);
      if (isOpen()) return;
      assert.ok(tries < 3, `dialog for ${label}`);
    }
  };
  const stopBtn = () => evaluate(() => {
    const b = document.getElementById('wkAbort');
    const vis = n => !!n && !n.hidden && n.offsetParent !== null;
    const svg = b?.querySelector('svg');
    const r = b?.getBoundingClientRect(), s = svg?.getBoundingClientRect();
    return {
      shown: vis(b), disabled: !!b?.disabled, w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0),
      svgW: Math.round(s?.width ?? 0), svgH: Math.round(s?.height ?? 0), text: (b?.textContent ?? '').trim(),
      label: b?.getAttribute('aria-label'), title: b?.title, fill: svg ? getComputedStyle(svg).fill : null,
      bg: b ? getComputedStyle(b).backgroundColor : null,
      headStop: [...document.querySelectorAll('#workHead button')].some(x => /停止/.test(x.textContent)),
    };
  });
  const marks = (taskId) => evaluate(id => ({
    head: document.querySelector('#workHead .bg-dt-title [aria-label]')?.getAttribute('aria-label') ?? null,
    row: document.querySelector(`#workList [data-key="t:${id}"] [aria-label]`)?.getAttribute('aria-label') ?? null,
  }), taskId);
  const childIdOf = async (taskId) => (await taskOf(taskId)).sessionId;
  const pressStop = () => clickOn('#wkAbort', 'stop');

  // ---- 1・2. 走っている子 ----
  await openCard(runT.taskId, 'running');
  const runChild = await childIdOf(runT.taskId);
  await wait(() => stopBtn().shown, 'stop button on the running child');
  const s1 = stopBtn();
  console.log('stop button', JSON.stringify(s1));
  assert.equal(s1.headStop, false, 'no 停止 text button in the heading');
  assert.deepEqual([s1.w, s1.h], [34, 34], 'stop button is 34x34');
  assert.deepEqual([s1.svgW, s1.svgH], [15, 15], 'stop square is 15x15');
  assert.equal(s1.text, '', 'no text on the stop button');
  assert.equal(s1.label, '中断'); assert.equal(s1.title, '中断');
  assert.notEqual(s1.fill, 'none', 'the square is filled');
  shot('1-running-1280');
  const before = marks(runT.taskId);
  pressStop();
  await wait(() => cmds('abort').some(c => c.sessionId === runChild), 'abort sent to the child');
  assert.equal(cmds('cancelAgentTask').length, 0, 'abort only; no cancelAgentTask');
  await wait(async () => ['cancelled', 'interrupted'].includes((await taskOf(runT.taskId)).status), 'running task stopped');
  console.log('running task ->', (await taskOf(runT.taskId)).status);
  await wait(() => { const m = marks(runT.taskId); return m.head && m.head === m.row && m.head !== before.head; }, 'list marker and heading changed together', 8000);
  await wait(() => !stopBtn().shown, 'stop button hidden after the stop', 8000);
  console.log('PASS: running child — one stop button (filled square 34px, no heading 停止); abort stops it; list/heading marks change together', JSON.stringify({ before, after: marks(runT.taskId) }));

  // ---- 2a. 止めた子へ人が直接送ると、会話は走り直す。タスクの状態は変わらない（メインと同じ）が、
  //          詳細の見出し・一覧の行・■ は「実行中」に合わせる。止まれば「中断」に戻る ----
  const stoppedStatus = (await taskOf(runT.taskId)).status;
  const stoppedMark = marks(runT.taskId).head;
  await client.cmd('sendMessage', { sessionId: runChild, messageId: 'stop-rerun-0001', prompt: `steps:@${runFile}` });
  await wait(() => stopBtn().shown, 'stop button on the re-run child', 10_000);
  await wait(() => { const m = marks(runT.taskId); return m.head && m.head === m.row && m.head !== stoppedMark; }, 'marks show running again', 8000);
  assert.equal((await taskOf(runT.taskId)).status, stoppedStatus, 'the task row itself keeps its terminal state (same as main)');
  assert.deepEqual(marks(runT.taskId), { head: '実行中', row: '実行中' }, 'heading and list row both say running');
  shot('2a-rerun-1280');
  pressStop();
  await wait(() => !stopBtn().shown, 'stop button hidden after stopping the re-run', 12_000);
  await wait(() => { const m = marks(runT.taskId); return m.head && m.head === m.row && m.head === stoppedMark; }, 'marks back to stopped', 8000);
  console.log('PASS: re-run after a stop — heading, list row and ■ follow the running turn, and return to stopped', JSON.stringify({ stoppedStatus, marks: marks(runT.taskId) }));

  // ---- 2b. 終わった子: 入力欄の上の帯に、この子の文脈の使用量が出る（表示だけ。メインの帯の値ではなく子の値） ----
  await openCard(doneT.taskId, 'finished');
  await wait(() => evaluate(() => { const s = document.getElementById('wkContextStrip'); return !!s && !s.hidden && /コンテキスト/.test(s.textContent) && /82%/.test(s.textContent); }), 'child context meter in the strip', 10_000);
  console.log('context strip', JSON.stringify(evaluate(() => { const m = document.getElementById('wkContextMeter'); return { text: document.getElementById('wkContextStrip').textContent.trim(), label: m.getAttribute('aria-label'), haspopup: m.getAttribute('aria-haspopup'), pop: !!document.getElementById('wkContextMeterPop') }; })));
  assert.equal(evaluate(() => document.getElementById('wkContextMeter').getAttribute('aria-haspopup')), null, 'the modal meter is display-only');
  assert.equal(stopBtn().shown, false, 'no stop button on a finished child');
  shot('2b-finished-context-1280');
  console.log('PASS: finished child — the strip above the composer shows the child context meter (display only)');

  // ---- 3. 承認待ちの子 ----
  await openCard(askT.taskId, 'ask');
  const askChild = await childIdOf(askT.taskId);
  await wait(() => stopBtn().shown, 'stop button on the approval-waiting child');
  assert.ok(evaluate(() => !!document.querySelector('#workBody .m.card .card:not(.done) .card-actions')), 'the approval card is in the modal');
  shot('3-approval-1280');
  pressStop();
  await wait(() => cmds('abort').some(c => c.sessionId === askChild), 'abort sent for the approval child');
  await wait(async () => ['cancelled', 'interrupted'].includes((await taskOf(askT.taskId)).status), 'approval task stopped');
  await wait(() => evaluate(() => !document.querySelector('.m.card .card:not(.done) .card-actions, .tc-appr:not(.done)')), 'no pending approval card remains anywhere', 8000);
  await wait(() => !stopBtn().shown, 'stop button hidden after the stop', 8000);
  console.log('PASS: approval-waiting child — the button shows; pressing stops the child and clears the approval');

  // ---- 4. 順番待ち（queued）の子 ----
  await openCard(limT.taskId, 'queued');
  const limChild = await childIdOf(limT.taskId);
  await wait(() => stopBtn().shown, 'stop button on the queued child');
  assert.equal((await taskOf(limT.taskId)).status, 'queued');
  shot('4-queued-1280');
  pressStop();
  await wait(() => cmds('abort').some(c => c.sessionId === limChild), 'abort sent for the queued child');
  let queuedStopped = false;
  try { await wait(async () => ['cancelled', 'interrupted'].includes((await taskOf(limT.taskId)).status), 'queued task stopped', 8000); queuedStopped = true; } catch { /* 下で切り替える */ }
  console.log('queued: abort alone stopped it =', queuedStopped, '(status', (await taskOf(limT.taskId)).status + ')');
  assert.ok(queuedStopped, 'abort stops a queued child (otherwise the queued case must send cancelAgentTask)');
  console.log('PASS: queued child — the button shows and abort stops it');

  // ---- 5. 孫を待っている子（ターンの外） ----
  await openCard(grT.taskId, 'grandchild wait');
  const grChild = await childIdOf(grT.taskId);
  const grBefore = await taskOf(grT.taskId);
  console.log('grand-wait child task', grBefore.status);
  await wait(() => stopBtn().shown, 'stop button on the child waiting for a grandchild');
  shot('5-grandchild-1280');
  pressStop();
  await wait(() => cmds('abort').some(c => c.sessionId === grChild), 'abort sent for the child waiting on a grandchild');
  await wait(async () => ['cancelled', 'interrupted'].includes((await taskOf(grT.taskId)).status), 'waiting child stopped');
  await wait(async () => (await tasks()).filter(r => r.parentSessionId === grChild).every(r => !['queued', 'running', 'cancelling'].includes(r.status)), 'the grandchild stopped too');
  console.log('PASS: child waiting for a grandchild — the button shows; abort stops both');

  // ---- 6. 依頼元の次のターンで、止めた子が伝わる ----
  evaluate(() => document.getElementById('workDialog').close());
  const mark = client.mark();
  await client.cmd('runTurn', { sessionId: parent, prompt: 'echo:つづき' });
  const note = await client.waitFor(e => e.type === 'interruptionNote' && e.sessionId === parent, { from: mark, ms: 30_000 });
  for (const id of [runT.taskId, askT.taskId, limT.taskId, grT.taskId]) assert.ok(note.text.includes(id), `the parent next turn learns of ${id}`);
  console.log('PASS: the parent learns of the stopped children on its next turn');

  // ---- 7. メインの中断ボタンも同じ形 ----
  const known = new Set([parent, first.sessionId, ...(await tasks()).flatMap(r => [r.sessionId, r.parentSessionId])]);
  const slowMark = client.mark();
  await client.cmd('runTurn', { backend: 'fake', cwd: work, prompt: 'slow' });
  const slowSession = (await client.waitFor(e => e.type === 'session' && e.sessionId && !known.has(e.sessionId), { from: slowMark, ms: 15_000 })).sessionId;
  assert.ok(slowSession, 'a second session is running');
  await wait(() => evaluate(id => { const row = document.querySelector(`#groups .row[data-session="${id}"]`); if (!row) return false; row.click(); return true; }, slowSession), 'the running session row in the list');
  try { await wait(() => evaluate(() => { const b = document.getElementById('abort'); return !!b && !b.hidden && b.offsetParent !== null; }), 'main stop button'); }
  catch (e) { console.log('DEBUG', JSON.stringify(evaluate(() => ({ cur: document.querySelector('#groups .row[aria-current]')?.dataset.session, abort: document.getElementById('abort')?.hidden, dlg: document.getElementById('workDialog').open }))), slowSession); throw e; }
  const m = evaluate(() => {
    const b = document.getElementById('abort'); const r = b.getBoundingClientRect(); const s = b.querySelector('svg').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), svgW: Math.round(s.width), svgH: Math.round(s.height), text: b.textContent.trim(), label: b.getAttribute('aria-label'), title: b.title };
  });
  console.log('main stop', JSON.stringify(m));
  assert.deepEqual([m.w, m.h, m.svgW, m.svgH, m.text, m.label, m.title], [34, 34, 15, 15, '', '中断', '中断'], 'the main stop button has the same shape');
  shot('7-main-1280');
  clickOn('#abort', 'main stop');
  await wait(() => cmds('abort').some(c => c.sessionId === slowSession), 'main stop sends abort');
  console.log('PASS: the main stop button has the same shape and still sends abort');
  console.log('PASS');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
