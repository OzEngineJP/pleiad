// 作業のダイアログで、ホストに任せた子（根）を開いたときの形（ADR 0317）。実ブラウザー。
//   fake のサーバーは別の PC のホストを持てないので、サーバーが返す agentTasks の行に、ホストに任せたタスクの行を 1 つ足して読ませる
//   （ブラウザー側で JSON.parse の結果にだけ足す。サーバーとデータには触れない）。
//   1. 入力欄（本文・送信・添付・モデル）は出ない。入力欄の位置に「中断」だけが出る（#wkStopOnly・塗りの四角・名前は「中断」）
//   2. 見出しに「↗ ホストで開く」（手元の窓にホストのリモートの窓を開く入口がある場合）。押すと入口へ渡る
//   3. 中断を押すと cancelAgentTask がそのタスクへ届く（abort は送らない）
//   （終わったホストのタスクに中断が出ないことは tests/unit の work-stop が確かめる）
// 実行: node tests/browser/work-dialog-host-root.mjs   （WORK_DIALOG_HOST_ROOT_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-host-root-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_HOST_ROOT_SHOTS;
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

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Host' });
  const parent = first.sessionId;
  const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
  const mark = client.mark();
  for (let tries = 0; ; tries++) {
    try { await client.cmd('runTurn', { sessionId: parent, prompt: ply('ply_delegate', { backend: 'fake', kind: 'mechanical', title: '本物の子', task: 'echo:済み' }) }); break; }
    catch (error) { if (tries >= 80) throw error; await sleep(250); }
  }
  const res = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
  const real = JSON.parse(res.text);
  await wait(async () => (await client.cmd('agentTasks')).find(r => r.taskId === real.taskId)?.status === 'completed', 'real child completed');

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => !!document.querySelector('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go')), 'delegate card');

  // ホストに任せたタスクの行を、agentTasks の返事に足す。手元の窓で「ホストで開く」を出すための入口の偽物も置く
  evaluate((parentId) => {
    window.__hostOpened = [];
    window.plyDesktop = { ...(window.plyDesktop ?? {}), openRemoteSession: (...args) => { window.__hostOpened.push(args); return Promise.resolve(); } };
    window.__hostStatus = 'running';  // 返事に足す行の状態
    const parse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const m = parse.call(this, text, reviver);
      try {
        if (m && m.kind === 'response' && Array.isArray(m.result) && m.result.some(r => r && r.taskId && r.parentSessionId)) {
          const sample = m.result.find(r => r && r.taskId && r.parentSessionId);
          const now = Date.now();
          if (!m.result.some(r => r.taskId === 'fake-host-task')) {
            m.result.push({ ...sample, taskId: 'fake-host-task', sessionId: null, status: window.__hostStatus, task: 'ホストに任せた子', title: 'ホストの子',
              parentSessionId: parentId, host: { hostId: 'h-fake', name: 'ホストA' }, remoteSessionId: 'rs-fake', createdAt: now - 60_000, updatedAt: now });
          } else {
            const row = m.result.find(r => r.taskId === 'fake-host-task'); row.status = window.__hostStatus;
          }
        }
      } catch { /* 形が違う返事はそのまま */ }
      return m;
    };
  }, parent);
  evaluate(() => {
    const log = window.__cmds = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const m = JSON.parse(data); if (m.command) log.push({ command: m.command, args: m.args ?? null }); } catch { /* 文字でないフレーム */ }
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
  const hostRow = '#workList [data-key="t:fake-host-task"]';

  // ダイアログを開く（本物の子のカード）。開くとサーバーから読み直すので、足した行が一覧に出る
  for (let tries = 0; !dialogOpen(); tries++) {
    assert.ok(tries < 4, 'the dialog opens from the card');
    await sleep(700);
    clickOn('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go', 'real card');
    const until = Date.now() + 4000;
    while (Date.now() < until && !dialogOpen()) await sleep(150);
  }
  await wait(() => evaluate(sel => !!document.querySelector(sel), hostRow), 'the host task row is listed');
  clickOn(hostRow, 'host row');
  await wait(() => evaluate(() => document.getElementById('workList').querySelector('[data-key="t:fake-host-task"][aria-current="true"]') !== null), 'host row selected');
  await sleep(600);

  const state = () => evaluate(() => {
    const vis = n => !!n && !n.hidden && n.offsetParent !== null;
    const abort = document.getElementById('wkStopOnly');
    const cs = abort ? getComputedStyle(abort.querySelector('rect') ?? abort) : null;
    return {
      composerShown: vis(document.querySelector('.wk-composer')) && vis(document.getElementById('wkPrompt')),
      prompt: vis(document.getElementById('wkPrompt')), send: vis(document.getElementById('wkSend')), attach: vis(document.getElementById('wkAttach')),
      abort: vis(abort), abortName: abort?.getAttribute('aria-label') ?? '', abortFill: cs?.fill ?? null, abortDisabled: !!abort?.disabled,
      open: [...document.querySelectorAll('#workBody .bg-open, #workDialog .bg-open')].filter(vis).map(n => n.getAttribute('aria-label')),
      title: document.querySelector('#workBody .bg-dt-title h3, #workBody h3')?.textContent ?? '',
    };
  });

  // ---- 1. 入力欄は無く、中断だけ ----
  await wait(() => state().abort, 'abort for the host root');
  const s1 = state();
  console.log('host root', JSON.stringify(s1));
  assert.equal(s1.prompt, false, 'no prompt field for a host-delegated root');
  assert.equal(s1.send, false, 'no send button');
  assert.equal(s1.attach, false, 'no attach button');
  assert.equal(s1.abortName, '中断', 'the stop button is named 中断');
  assert.notEqual(s1.abortFill, 'none', 'the stop button is a filled square');
  shot('1-host-root-1280');
  console.log('PASS: a host-delegated root has no composer; only the 中断 button sits in its place');

  // ---- 2. ホストで開く ----
  assert.ok(s1.open.includes('ホストで開く'), `the heading has ホストで開く: ${JSON.stringify(s1.open)}`);
  clickOn('#workDialog .bg-open', 'open on host');
  await wait(() => evaluate(() => window.__hostOpened.length >= 1), 'openRemoteSession called');
  console.log('PASS: ↗ ホストで開く hands the task to the remote-window entry');
  if (!dialogOpen()) {
    // 入口を押すと閉じる作りのとき、続きのために開き直す
    clickOn('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go', 'real card again');
    await wait(() => dialogOpen(), 'dialog reopened');
    clickOn(hostRow, 'host row again');
    await wait(() => state().abort, 'abort again');
  }

  // ---- 3. 中断で cancelAgentTask ----
  clickOn('#wkStopOnly', 'abort host root');
  await wait(() => cmds('cancelAgentTask').some(c => c.args?.taskId === 'fake-host-task'), 'cancelAgentTask sent for the host task');
  assert.equal(cmds('abort').length, 0, 'no abort is sent for a host-delegated root');
  console.log('PASS: the stop button sends cancelAgentTask for the task, not abort');

  console.log('PASS');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
