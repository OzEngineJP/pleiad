// 作業のダイアログの「再開」（ADR 0317）。実ブラウザー。メインの入力欄の「▶ 再開」と同じ出し方・同じ字・同じ送り先。
//   1. 上限で止まった子（解除の後）: 中断と同じ位置に「再開」。欄の下に「送ると、この指示で続けます」（書いていない間は見えない）
//   2. 字を書くと「再開」は隠れ、一行が見える。消すとまた出る
//   3. 押すと resume が子の会話へ届く（メインの resumeSession と同じ）
//   4. 解除の前の子: 押せない時計（字は「◷ H:MM に解除」）
// 実行: node tests/browser/work-dialog-resume.mjs   （WORK_DIALOG_RESUME_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-resume-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_RESUME_SHOTS;
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

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Resume' });
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

  const readyT = await delegate('解除の後の子', `limit ${Date.now() - 60_000}`);
  await wait(async () => (await taskOf(readyT.taskId))?.status === 'failed', 'ready child failed');
  const clockT = await delegate('解除の前の子', `limit ${Date.now() + 3 * 3600_000}`);
  await wait(async () => (await taskOf(clockT.taskId))?.status === 'failed', 'clock child failed');
  const doneT = await delegate('終わった子', 'echo:済み');
  await wait(async () => (await taskOf(doneT.taskId))?.status === 'completed', 'finished child completed');
  const readyChild = (await taskOf(readyT.taskId)).sessionId;
  const clockChild = (await taskOf(clockT.taskId)).sessionId;

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 3), 'delegate cards');
  evaluate(() => {
    const log = window.__cmds = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const m = JSON.parse(data); if (m.command) log.push({ command: m.command, sessionId: m.args?.sessionId ?? null }); } catch { /* 文字でないフレーム */ }
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
  const state = () => evaluate(() => {
    const vis = n => !!n && !n.hidden && n.offsetParent !== null;
    const b = document.getElementById('wkResume'), note = document.getElementById('wkResumeNote'), abort = document.getElementById('wkAbort');
    return {
      shown: vis(b), disabled: !!b?.disabled, label: b?.getAttribute('aria-label') ?? '', limit: b?.classList.contains('is-limit') ?? false,
      note: vis(note) ? note.textContent : '', noteQuiet: note?.classList.contains('quiet') ?? null, noteVisible: vis(note) && getComputedStyle(note).visibility !== 'hidden',
      placeholder: document.getElementById('wkPrompt')?.placeholder ?? '', abort: vis(abort), send: vis(document.getElementById('wkSend')),
      w: Math.round(b?.getBoundingClientRect().width ?? 0), h: Math.round(b?.getBoundingClientRect().height ?? 0),
    };
  });
  const typeInto = (text) => evaluate((v) => { const n = document.getElementById('wkPrompt'); n.focus(); n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); }, text);

  // ---- 1. 解除の後の子 ----
  await openCard(readyT.taskId, 'ready');
  await wait(() => state().shown, 'resume button on the ready child');
  const s1 = state();
  console.log('ready', JSON.stringify(s1));
  assert.equal(s1.label, '再開', 'plain 再開 label');
  assert.equal(s1.limit, false);
  assert.equal(s1.disabled, false);
  assert.equal(s1.abort, false, 'no stop button while it is not running');
  assert.ok(s1.note.includes('この指示で続けます'), 'note under the field');
  assert.equal(s1.noteVisible, false, 'note is invisible while nothing is typed (the height stays)');
  assert.ok(s1.placeholder.includes('指示を変えて続ける'), 'placeholder for continuing with another instruction');
  shot('1-ready-1280');

  // ---- 2. 書くと隠れ、消すと出る ----
  typeInto('方針を変えて続けてください');
  await wait(() => !state().shown, 'resume hidden while typing');
  assert.equal(state().noteVisible, true, 'note is visible while typing');
  shot('2-typing-1280');
  typeInto('');
  await wait(() => state().shown, 'resume back after clearing');
  console.log('PASS: ready child — 再開 shows at the stop position; typing hides it and shows the note; clearing brings it back');

  // ---- 3. 押す ----
  clickOn('#wkResume', 'resume');
  await wait(() => cmds('resume').some(c => c.sessionId === readyChild), 'resume sent to the child');
  console.log('PASS: pressing 再開 sends resume to the child');

  // ---- 4. 解除の前の子: 押せない時計 ----
  await openCard(clockT.taskId, 'clock');
  await wait(() => state().shown, 'clock on the not-yet-released child');
  const s4 = state();
  console.log('clock', JSON.stringify(s4));
  assert.equal(s4.limit, true);
  assert.equal(s4.disabled, true, 'the clock is not pressable');
  assert.ok(/解除/.test(s4.label), 'label says when the limit is released');
  shot('4-clock-1280');
  console.log('PASS: before the limit is released — a clock that cannot be pressed');

  // ---- 5. 終わった子には出ない ----
  await openCard(doneT.taskId, 'done');
  await wait(() => !state().shown, 'no resume on a finished child');
  assert.equal(state().note, '', 'no note on a finished child');
  console.log('PASS: a finished child has no resume');
  console.log('PASS');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
