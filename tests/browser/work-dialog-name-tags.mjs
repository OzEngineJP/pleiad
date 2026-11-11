// 子の会話の名札と、親の AI への「人からの指示 N 件」（ADR 0317）。実ブラウザー。
//   1. 最初の依頼は「依頼」、モーダルの入力欄から人が送った発言は「あなた」、親の AI が後から送った発言（ply_task_send）は「追加の指示」
//   2. 閉じて開き直しても（履歴を読み直しても）同じ名札
//   3. 子の完了通知（親の AI に渡る）に「人からの指示 1 件」が 1 回だけ載り、人の送信ごとの通知は無い
// 実行: node tests/browser/work-dialog-name-tags.mjs   （WORK_DIALOG_TAGS_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-tags-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_TAGS_SHOTS;
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

  const runFile = path.join(base, 'run-steps.json');
  const stream = Array.from({ length: 30 }, (_, i) => ({ tool: 'Bash', input: { command: `run ${i}` }, result: `out ${i}`, ms: 400 }));
  fs.writeFileSync(runFile, JSON.stringify({ steps: [{ text: 'はじめます。' }, ...stream, { text: 'おわり。' }] }));

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Tags' });
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
  const tasks = async () => await client.cmd('agentTasks');
  const taskOf = async (taskId) => (await tasks()).find(r => r.taskId === taskId);

  const child = await callParent('ply_delegate', { backend: 'fake', kind: 'mechanical', title: '名札の子', task: `steps:@${runFile}` });
  await wait(async () => (await taskOf(child.taskId))?.sessionId, 'child session');
  const childId = (await taskOf(child.taskId)).sessionId;
  await wait(async () => (await taskOf(child.taskId))?.status === 'running', 'child running');
  const sentByParent = await callParent('ply_task_send', { taskId: child.taskId, message: '親の AI からの追加の指示' });
  console.log('ply_task_send ->', sentByParent.status);

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
  const openChild = async () => {
    for (let tries = 0; ; tries++) {
      await sleep(500);
      clickOn(`.tc[data-tool$="ply_delegate"][data-task-id="${child.taskId}"] .tc-go`, 'card');
      const until = Date.now() + 4000;
      while (Date.now() < until && !evaluate(() => document.getElementById('workDialog').open && !!document.getElementById('workBody').dataset.sessionId)) await sleep(150);
      if (evaluate(() => document.getElementById('workDialog').open)) return;
      assert.ok(tries < 3, 'dialog opens');
    }
  };
  // 名札と本文の対（依頼・追加の指示は親の発言の枠、あなたは人の発言）
  const tags = () => evaluate(() => [...document.querySelectorAll('#workBody .m.user')].map(m => ({
    who: (m.querySelector('.who > span')?.textContent ?? '').trim(), text: (m.querySelector('.txt, .body, .md')?.textContent ?? m.textContent).trim().slice(0, 40) })));

  await openChild();
  await wait(() => evaluate(() => !!document.getElementById('wkPrompt') && document.getElementById('wkPrompt').offsetParent !== null), 'modal composer');
  ab('fill', '#wkPrompt', '人がモーダルから送る指示');
  await wait(() => evaluate(() => { const b = document.getElementById('wkSend'); return !!b && !b.disabled; }), 'send enabled');
  clickOn('#wkSend', 'send');
  // 走っている子への送信は、送信待ち（または途中送信）を経て履歴に入る。名札は「あなた」
  await wait(() => tags().some(t => t.who === 'あなた' && t.text.includes('人がモーダルから送る指示')), 'human tag あなた', 60_000);
  let now = tags();
  console.log('tags (live)', JSON.stringify(now));
  assert.equal(now.filter(t => t.who === 'あなた').length, 1, 'exactly one あなた');
  assert.ok(now.some(t => t.who === '依頼'), 'the first request is 依頼');
  await wait(() => tags().some(t => t.who === '追加の指示' && t.text.includes('親の AI からの追加の指示')), 'parent instruction tag', 30_000);
  now = tags();
  assert.ok(!now.some(t => t.who === '追加の指示' && t.text.includes('人がモーダルから送る指示')), 'the human message is not 追加の指示');
  assert.ok(!now.some(t => t.who === 'あなた' && t.text.includes('親の AI')), 'the parent instruction is not あなた');
  shot('tags-live-1280');
  console.log('PASS: live — 依頼 / あなた / 追加の指示');

  // 子が終わるまで待ち、閉じて開き直しても名札が変わらない
  await wait(async () => ['completed', 'failed', 'cancelled'].includes((await taskOf(child.taskId)).status), 'child finished', 120_000);
  evaluate(() => document.getElementById('workDialog').close());
  await openChild();
  await wait(() => tags().some(t => t.who === 'あなた'), 'tags after reopen');
  const again = tags();
  console.log('tags (reopened)', JSON.stringify(again));
  assert.equal(again.filter(t => t.who === 'あなた').length, 1, 'still exactly one あなた after reopening');
  assert.ok(again.some(t => t.who === '依頼') && again.some(t => t.who === '追加の指示' && t.text.includes('親の AI')), 'the other tags are unchanged');
  assert.ok(!again.some(t => t.who === '追加の指示' && t.text.includes('人がモーダル')), 'the human message never turns into 追加の指示');
  shot('tags-reopened-1280');
  console.log('PASS: reopened — the same three tags');

  // 親の AI への完了通知に「人からの指示 1 件」が 1 回だけ
  await wait(() => client.since(0).some(e => e.type === 'taskNotice' && e.sessionId === parent && e.text.includes(child.taskId)), 'completion notice', 60_000);
  const notices = client.since(0).filter(e => e.type === 'taskNotice' && e.sessionId === parent && e.text.includes(child.taskId));
  console.log('notice', JSON.stringify(notices.map(n => n.text.split('\n').filter(l => /人からの指示|状態/.test(l)))));
  assert.equal(notices.length, 1, 'one completion notice');
  assert.ok(/人からの指示 1 件/.test(notices[0].text), 'the report carries 人からの指示 1 件');
  assert.equal(client.since(0).filter(e => e.type === 'taskNotice' && e.sessionId === parent && e.text.includes('人からの指示')).length, 1, 'only the completion report mentions it');
  console.log('PASS: the completion report carries 人からの指示 1 件, once');
  console.log('PASS');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
