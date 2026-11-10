// 作業のダイアログ（モーダル）のリンク（実ブラウザー）:
//   委譲した子の会話をモーダルで開き、子の発言の中の外部リンクを押すと既定のブラウザーへ渡ることを確かめる。
//   殻の口（window.plyDesktop.openExternal）は画面の側で記録だけする身代わりにする。
// 実行: node tests/browser/work-dialog-links.mjs   （会話の agent-browser の窓を使う）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-links-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_LINKS_SHOTS;
const ab = (...args) => execFileSync(process.env.AGENT_BROWSER_BIN || 'agent-browser', args, { encoding: 'utf8', timeout: 60_000 });
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const wait = async (fn, label) => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout: ${label}`);
};
const selector = '.tc[data-tool$="ply_delegate"]';
let server, client;
try {
  server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  console.log(`fake server pid=${server.child.pid} port=${server.port}`);
  client = await open({ ...server, autoAllow: true });
  await client.cmd('authLogin', { backend: 'fake' });
  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Work dialog links' });
  const parent = first.sessionId;
  const from = client.mark();
  await client.cmd('runTurn', { sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: {
    backend: 'fake', kind: 'mechanical', title: 'links', task: 'echo:See https://example.com/bare and [named](https://example.org/named) here.' } }) });
  const result = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from, ms: 30_000 });
  const { taskId } = JSON.parse(result.text);
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId !== parent, { from, ms: 30_000 });

  ab('open', `http://127.0.0.1:${server.port}/?token=${server.token}`);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(sel => !!document.querySelector(`${sel}[data-task-id] .tc-go`), selector), 'delegate card');
  evaluate(sel => document.querySelector(sel).querySelector('.tc-go').click(), selector);
  await wait(() => evaluate(() => !!document.querySelector('#workDialog[open]')), 'child dialog');
  await wait(() => evaluate(() => document.querySelectorAll('#workBody a.md-link[target="_blank"]').length >= 2), 'links in the child');
  assert.equal(evaluate(() => document.querySelector('#workList [aria-current="true"]')?.dataset.key), `t:${taskId}`);

  // 殻の口の身代わり（デスクトップ版のホストの画面と同じ判定を通す）
  evaluate(() => { window.__opened = []; window.plyDesktop = { ...(window.plyDesktop || {}), openExternal: url => { window.__opened.push(url); return Promise.resolve(true); } }; });
  if (shots) { fs.mkdirSync(shots, { recursive: true }); ab('screenshot', path.join(shots, 'work-dialog-links.png')); }
  // 本物のポインターで押す（ダイアログの上に別の層があれば届かない）
  const links = evaluate(() => [...document.querySelectorAll('#workBody a.md-link[target="_blank"]')].map((a, i) => { a.dataset.probe = String(i); return a.href; }));
  console.log('links:', JSON.stringify(links));
  for (let i = 0; i < links.length; i++) {
    evaluate(n => document.querySelector(`[data-probe="${n}"]`).scrollIntoView({ block: 'center' }), i);
    ab('click', `[data-probe="${i}"]`);
  }
  await wait(() => evaluate(() => window.__opened.length >= 2), 'links opened');
  const opened = evaluate(() => window.__opened);
  assert.deepEqual(opened, links);
  assert.ok(evaluate(() => !!document.querySelector('#workDialog[open]')), 'the dialog stays open');
  console.log('PASS: links in the work dialog open in the default browser', JSON.stringify(opened));
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
