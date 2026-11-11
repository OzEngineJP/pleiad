// 作業のダイアログの入力欄の送信待ち（ADR 0317）。実ブラウザー。
//   1. 走っている子へ「つぎの指示A」（添付つき）を送ると送信待ちになり、［編集］で本文と添付が入力欄へ戻る（サーバー側では取り下げ）
//   2. 戻した本文をもう一度送ると、添付の印が二重にならない
//   3. 添付つきで終わった子へ送ると、添付が子へ届く（送信の要求に attachments が載る）
//   4. 人からの指示の数は渡った分だけ（編集・取り消しで下げた送信待ちは数えず、届いた 1 件は 1 と数える）
// 実行: node tests/browser/work-dialog-outbox.mjs   （会話の agent-browser の窓を使う。WORK_DIALOG_OUTBOX_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-outbox-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_OUTBOX_SHOTS;
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
    if (fn()) return;
    await sleep(120);
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

  const stream = (label, n, ms) => Array.from({ length: n }, (_, i) => ({ tool: 'Bash', input: { command: `${label} ${i}` }, result: `out ${label} ${i}`, ms }));
  const runFile = path.join(base, 'run-steps.json');
  fs.writeFileSync(runFile, JSON.stringify({ steps: [{ text: 'はじめます。' }, ...stream('run', 400, 250), { text: 'おわり。' }] }));

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Outbox' });
  const parent = first.sessionId;
  const delegate = async (title, task) => {
    const mark = client.mark();
    for (let tries = 0; ; tries++) {
      try {
        await client.cmd('runTurn', { sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title, task } }) });
        break;
      } catch (error) {
        if (tries >= 80) throw error;
        await sleep(250);
      }
    }
    const res = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
    return { taskId: JSON.parse(res.text).taskId };
  };
  const running = await delegate('走っている子', `steps:@${runFile}`);
  await sleep(1200);
  const done = await delegate('終わった子', 'steps:' + JSON.stringify({ steps: [{ text: 'ひとつめの子です。' }] }));
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId !== parent, { from: 0, ms: 30_000 });

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
      if (!dialogOpen()) clickOn(`.tc[data-tool$="ply_delegate"][data-task-id="${taskId}"] .tc-go`, `card ${label}`);
      else clickOn(`#workList [data-key="t:${taskId}"]`, `row ${label}`);
      const until = Date.now() + 4000;
      while (Date.now() < until && !isOpen()) await sleep(150);
      if (isOpen()) return;
      assert.ok(tries < 3, `dialog for ${label}`);
    }
  };
  evaluate(() => {
    const log = window.__cmds = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const m = JSON.parse(data); if (m.command) log.push({ command: m.command, sessionId: m.args?.sessionId ?? null, prompt: m.args?.prompt ?? null, attachments: m.args?.attachments ?? null, action: m.args?.action ?? null }); } catch { /* 文字でないフレーム */ }
      return send.call(this, data);
    };
  });
  const cmds = (name) => evaluate(n => window.__cmds.filter(c => c.command === n), name);
  const typeInto = (id, text) => evaluate(([i, v]) => { const n = document.getElementById(i); n.focus(); n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); }, [id, text]);
  const attachFile = (name, body) => evaluate(([n, b]) => {
    const input = document.querySelector('#workDialog input[type=file]');
    const dt = new DataTransfer();
    dt.items.add(new File([b], n, { type: 'text/plain' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [name, body]);
  const childOf = () => evaluate(() => document.getElementById('workBody').dataset.sessionId);
  const chips = () => evaluate(() => [...document.querySelectorAll('#workDialog .wk-composer .att-chip, #workDialog .wk-composer [data-attachment], #workDialog .wk-composer .att')].map(n => n.textContent.trim()).filter(Boolean));
  const outboxText = () => evaluate(() => (document.getElementById('wkOutbox')?.textContent ?? '').replace(/\s+/g, ' ').trim());

  // ---- 1. 走っている子: 添付つきで送る → 送信待ち → ［編集］で本文と添付が戻る ----
  await openCard(running.taskId, 'running');
  await wait(() => evaluate(() => !!document.getElementById('wkPrompt') && document.getElementById('wkPrompt').offsetParent !== null), 'composer');
  const runChild = childOf();
  attachFile('memo.txt', 'メモの中身');
  await wait(() => evaluate(() => /memo\.txt/.test(document.querySelector('#workDialog .wk-composer').textContent)), 'attachment shows', 20_000);
  typeInto('wkPrompt', 'つぎの指示A');
  await sleep(400);
  clickOn('#wkSend', 'send');
  await wait(() => /送信待ち|作業が終わると自動で送信/.test(outboxText()), 'queued');
  assert.ok(/つぎの指示A/.test(outboxText()), 'the queued row shows the text');
  assert.equal(evaluate(() => document.getElementById('wkPrompt').value), '', 'draft cleared once queued');
  shot('1-queued');
  const queuedSend = cmds('sendMessage').filter(c => c.sessionId === runChild).at(-1);
  console.log('queued send', JSON.stringify(queuedSend));
  assert.ok(queuedSend?.attachments?.length === 1, 'the send carries the attachment');
  const cancelMark = cmds('messageAction').length;
  evaluate(() => { const b = [...document.querySelectorAll('#wkOutbox button')].find(x => /編集/.test(x.textContent)); b?.click(); });
  await wait(() => cmds('messageAction').length > cancelMark && cmds('messageAction').at(-1).action === 'cancel', 'edit cancels the queued message');
  await wait(() => evaluate(() => (document.getElementById('wkPrompt').value ?? '').includes('つぎの指示A')), 'the text came back into the composer');
  await wait(() => !/つぎの指示A/.test(outboxText()), 'queued row gone after edit');
  const back = evaluate(() => document.getElementById('wkPrompt').value);
  console.log('restored value', JSON.stringify(back));
  assert.ok(/memo\.txt/.test(evaluate(() => document.querySelector('#workDialog .wk-composer').textContent)), 'the attachment came back');
  shot('1-edited');
  console.log('PASS: 編集 puts the text and the attachment back into the composer, and withdraws the queued send');

  // ---- 2. 戻した本文をもう一度送る: 添付の印が二重にならない ----
  clickOn('#wkSend', 'send again');
  await wait(() => cmds('sendMessage').filter(c => c.sessionId === runChild).length >= 2, 'sent again');
  const again = cmds('sendMessage').filter(c => c.sessionId === runChild).at(-1);
  console.log('second send', JSON.stringify(again));
  assert.ok(/つぎの指示A/.test(again.prompt), 'the second send keeps the text');
  assert.equal((again.prompt.match(/memo\.txt/g) ?? []).length, 1, 'the attachment mark appears once');
  assert.equal(again.attachments?.length, 1, 'one attachment');
  console.log('PASS: sending the restored text again does not double the attachment mark');
  evaluate(() => { const b = [...document.querySelectorAll('#wkOutbox button')].find(x => /取り消す/.test(x.textContent)); b?.click(); });
  await sleep(500);

  // ---- 3. 終わった子へ添付つきで送る ----
  await openCard(done.taskId, 'done');
  await wait(() => evaluate(id => document.getElementById('workBody').dataset.sessionId && document.getElementById('workBody').dataset.sessionId !== id, runChild), 'on the done child');
  const doneChild = childOf();
  attachFile('note.txt', '二つ目');
  await wait(() => evaluate(() => /note\.txt/.test(document.querySelector('#workDialog .wk-composer').textContent)), 'attachment shows for the done child', 20_000);
  typeInto('wkPrompt', 'これを見て');
  await sleep(400);
  clickOn('#wkSend', 'send to done');
  await wait(() => cmds('sendMessage').some(c => c.sessionId === doneChild && /これを見て/.test(c.prompt ?? '')), 'sent to the done child');
  const sentDone = cmds('sendMessage').find(c => c.sessionId === doneChild && /これを見て/.test(c.prompt ?? ''));
  assert.equal(sentDone.attachments?.length, 1, 'the attachment rides on the send');
  assert.ok(/note\.txt/.test(sentDone.prompt), 'the prompt carries the attachment mark');
  await wait(() => evaluate(() => /これを見て/.test(document.getElementById('workBody').textContent)), 'shows in the thread');
  shot('3-attached-sent');
  console.log('PASS: a send with an attachment reaches the child with the attachment');

  // ---- 4. 人からの指示の数: 送信待ちのまま取り下げた分は数えず、渡った 1 件だけ数える ----
  const countOf = async taskId => (await client.cmd('agentTasks')).find(r => r.taskId === taskId)?.humanInstructions ?? 0;
  const counted = Date.now() + 20_000;
  while (Date.now() < counted && (await countOf(done.taskId)) !== 1) await sleep(200);
  assert.equal(await countOf(done.taskId), 1, 'the delivered send is counted once');
  assert.equal(await countOf(running.taskId), 0, 'withdrawn queued sends are not counted');
  console.log('PASS: human instruction count follows deliveries only');
  console.log('PASS');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
