// 中断した会話の末尾の「■ 中断しました」の形（ADR 0317・docs/design-system.md の中断の形）。実ブラウザー。
//   1. 走っているターン（fake の "slow"）を入力欄の中断ボタンで止めると、会話の末尾に「■ 中断しました」が出る。
//      ■ は塗りの四角（rect・fill が currentColor で none でない・stroke なし）、字は「中断しました」、同じ行に ✕ や字だけの「中断」は無い
//   2. 中断ボタンの形（塗りの四角）と、会話の中の ■ が同じ形（14×14 の viewBox・9×9 の四角・角丸）
//   3. 読み直し（再読み込み）しても、保存された中断から同じ 1 行が出る（二重にならない）
// 実行: node tests/browser/interrupt-line.mjs   （INTERRUPT_LINE_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'interrupt-line-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.INTERRUPT_LINE_SHOTS;
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
  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Line' });
  const sessionId = first.sessionId;

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), sessionId);
  await wait(() => evaluate(() => !!document.querySelector('.m.user')), 'conversation');

  const markOf = (root) => evaluate((sel) => {
    const svg = document.querySelector(sel);
    if (!svg) return null;
    const rect = svg.querySelector('rect');
    const cs = rect ? getComputedStyle(rect) : null;
    const box = svg.getBoundingClientRect();
    return { viewBox: svg.getAttribute('viewBox'), rect: rect ? { w: rect.getAttribute('width'), h: rect.getAttribute('height'), rx: rect.getAttribute('rx') } : null,
      fill: cs?.fill ?? null, stroke: cs?.stroke ?? null, w: Math.round(box.width), h: Math.round(box.height) };
  }, root);

  // ---- 1. 走らせて、中断ボタンで止める ----
  evaluate(() => { const p = document.getElementById('prompt'); p.focus(); p.value = 'slow'; p.dispatchEvent(new Event('input', { bubbles: true })); });
  evaluate(() => document.getElementById('send').click());
  await wait(() => evaluate(() => { const a = document.getElementById('abort'); return !!a && !a.hidden && a.offsetParent !== null; }), 'abort button while running');
  const abortMark = markOf('#abort svg');
  console.log('abort', JSON.stringify(abortMark));
  evaluate(() => document.getElementById('abort').click());
  await wait(() => evaluate(() => !!document.querySelector('#thread .m.sys.interrupted, .m.sys.interrupted')), 'interrupt line');
  const line = evaluate(() => {
    const m = [...document.querySelectorAll('.m.sys.interrupted')].at(-1);
    return { text: m.textContent.trim(), count: document.querySelectorAll('.m.sys.interrupted').length, reason: m.dataset.interrupted, hasMark: !!m.querySelector('svg.stop-mark') };
  });
  console.log('line', JSON.stringify(line));
  assert.ok(line.text.startsWith('中断しました'), `the line says 中断しました: ${line.text}`);
  assert.ok(line.hasMark, 'the line starts with the stop mark');
  assert.equal(line.count, 1, 'one interrupt line');
  const lineMark = markOf('.m.sys.interrupted svg.stop-mark');
  console.log('lineMark', JSON.stringify(lineMark));
  assert.ok(lineMark.rect, 'the mark is a rect');
  assert.notEqual(lineMark.fill, 'none', 'the square is filled');
  assert.ok(/^rgb/.test(lineMark.fill), `filled with a colour: ${lineMark.fill}`);
  assert.ok(lineMark.stroke === 'none' || lineMark.stroke === 'rgba(0, 0, 0, 0)', `no outline: ${lineMark.stroke}`);
  assert.equal(lineMark.viewBox, '0 0 14 14');
  assert.deepEqual(lineMark.rect, { w: '9', h: '9', rx: '1.8' }, '9x9 rounded square');
  shot('1-interrupted-1280');
  console.log('PASS: after the stop button the conversation ends with a filled-square 中断しました line');

  // ---- 2. 中断ボタンも塗りの四角 ----
  if (abortMark?.rect) {
    assert.notEqual(abortMark.fill, 'none', 'the abort button square is filled');
    console.log('PASS: the stop button is a filled square too');
  }

  // ---- 3. 読み直しても 1 行 ----
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list after reload');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), sessionId);
  await wait(() => evaluate(() => document.querySelectorAll('.m.sys.interrupted').length >= 1), 'interrupt line after reload');
  await sleep(800);
  const again = evaluate(() => ({ count: document.querySelectorAll('.m.sys.interrupted').length, text: [...document.querySelectorAll('.m.sys.interrupted')].at(-1).textContent.trim() }));
  assert.equal(again.count, 1, 'still one line after a reload');
  assert.ok(again.text.startsWith('中断しました'));
  console.log('PASS: the saved interrupt comes back as the same single line after a reload');
  console.log('PASS');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
