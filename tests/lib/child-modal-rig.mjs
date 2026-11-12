// 子の会話のモーダル（#workDialog）と主の会話を、本物のブラウザーで比べる試験・計測の共通の部品（ADR 0318。段 6-1）。
//   tests/perf/child-modal-weight.mjs（重さの計測）と tests/browser/work-dialog-live-stream.mjs・main-thread-nav.mjs が使う。
// 本物のサーバー（fake バックエンド・一時のデータ置き場・空いている別ポート）だけと話す。実データ・7477 には触れない。
// ブラウザーは playwright-core の headless shell（会話の共有の窓は使わない。CDP の計測を使うため）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, ROOT } from './server.mjs';
import { open } from './ws-client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 条件が満たされるまで待つ。上限を過ぎたら label つきで落ちる（固定の待ちは使わない） */
export async function waitUntil(fn, label, ms = 30_000, step = 100) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await sleep(step);
  }
  throw new Error(`timeout: ${label}${last instanceof Error ? ` (${last.message.slice(0, 120)})` : ''}`);
}

function browserPath() {
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const version = fs.readdirSync(base).filter((n) => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
  return process.env.PW_CHROMIUM || path.join(base, version, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
}

// ---------------------------------------------------------------- 台本（fake の steps:@file）

/** 履歴の台本: 短い本文を messages 件。tools 件のツール呼び出しを、等間隔に本文の前へ付ける（連続しないので発言ごとに 1 件） */
export function historyScript({ messages = 300, tools = 50, tag = '履歴' } = {}) {
  const every = Math.max(1, Math.floor(messages / Math.max(1, tools)));
  const steps = [];
  let placed = 0;
  for (let i = 0; i < messages; i++) {
    if (placed < tools && i % every === 0) {
      steps.push({ tool: 'Bash', input: { command: `echo ${tag} ${i}` }, result: `out ${i}`, ms: 1 });
      placed++;
    }
    steps.push({ text: `${tag} ${i}: 本文です。` });
  }
  return { steps };
}

/** いま流れている最後の発言（末尾）。重ねて呼べる。ツール 1 つ＋240 字ほどの本文を rounds 回（約 rounds ×1 秒） */
export function tailScript({ rounds = 20, tag = '末尾' } = {}) {
  const steps = [];
  for (let i = 0; i < rounds; i++) {
    steps.push({ tool: 'Bash', input: { command: `tail ${tag} ${i}` }, result: `t ${i}`, ms: 350 });
    steps.push({ text: `${tag} ${i}: ${'流れている本文。'.repeat(30)}` });
  }
  return { steps };
}

export function writeScript(dir, name, script) {
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(script));
  return file;
}

// ---------------------------------------------------------------- 試験の場

/**
 * サーバー・WebSocket・ブラウザーを立てる。close() で全部片づける（自分で起こしたものだけ）。
 * @param {{tag?:string, env?:object, viewport?:{width:number,height:number}, throttle?:number, mobile?:boolean}} o
 */
export async function startRig({ tag = 'rig', env = {}, viewport = { width: 1280, height: 800 }, throttle = 1, gates = false } = {}) {
  fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
  const base = fs.mkdtempSync(path.join(ROOT, 'temporary', `${tag}-`));
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  const rig = { base, work, throttle, errors: [], pageErrors: [] };
  // gates: fake の「ゲート」（bg 台本の gate:名前・HOLD_CONFIRM:名前）。rig.gates.open(名前) で進める
  if (gates) {
    const dir = path.join(base, 'gates');
    fs.mkdirSync(dir);
    rig.gates = { open: (name) => fs.writeFileSync(path.join(dir, name), '') };
    env = { ...env, AGENT_HOST_FAKE_GATE_DIR: dir };
  }
  try {
    rig.server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja', ...env } });
    rig.url = `http://127.0.0.1:${rig.server.port}/?token=${rig.server.token}`;
    rig.client = await open({ ...rig.server });
    await rig.client.cmd('authLogin', { backend: 'fake' });
    await rig.client.cmd('completeSetup', { backend: 'fake' });
    rig.browser = await chromium.launch({ executablePath: browserPath() });
    rig.ctx = await rig.browser.newContext({ viewport, locale: 'ja-JP' });
    rig.page = await rig.ctx.newPage();
    rig.page.on('pageerror', (e) => rig.pageErrors.push(e.message));
    rig.cdp = await rig.ctx.newCDPSession(rig.page);
    rig.wire = wireCounter(rig.cdp);
    await rig.cdp.send('Performance.enable');
  } catch (error) { await closeRig(rig); throw error; }
  rig.close = () => closeRig(rig);
  rig.evaluate = (fn, arg) => rig.page.evaluate(fn, arg);
  return rig;
}

async function closeRig(rig) {
  try { rig.client?.close(); } catch { /* 閉じ済み */ }
  try { await rig.browser?.close(); } catch { /* 閉じ済み */ }
  try { await rig.server?.stop(); } catch (error) { console.log('server stop:', error.message); }
  fs.rmSync(rig.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * WebSocket の通信量を CDP で数える（ページの中で JSON.parse しないので、計測する画面の重さに混ざらない）。
 * loadSession は、送ったコマンドの id と、返事の id を突き合わせて数える
 */
function wireCounter(cdp) {
  let sentIds = new Map();
  const zero = () => ({ frames: 0, bytes: 0, loadSession: { count: 0, bytes: 0 }, commands: {} });
  let acc = zero();
  const bytesOf = (data) => Buffer.byteLength(String(data ?? ''), 'utf8');
  cdp.send('Network.enable').catch(() => {});
  cdp.on('Network.webSocketFrameSent', ({ response }) => {
    const text = String(response?.payloadData ?? '');
    let m = null;
    try { m = JSON.parse(text); } catch { return; }
    if (!m?.command) return;
    acc.commands[m.command] = (acc.commands[m.command] ?? 0) + 1;
    if (m.command === 'loadSession') { acc.loadSession.count++; sentIds.set(String(m.id), true); }
  });
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    const text = String(response?.payloadData ?? '');
    const size = bytesOf(text);
    acc.frames++;
    acc.bytes += size;
    // 返事は { kind:'response', id, … }。頭の 200 字に id があれば解析せずに引く、無ければ解析する
    if (!text.includes('"response"')) return;
    const head = text.slice(0, 200);
    let id = /"id":"(\d+)"/.exec(head)?.[1];
    if (!id) { try { const m = JSON.parse(text); if (m.kind === 'response') id = String(m.id); } catch { return; } }
    if (id && sentIds.delete(id)) acc.loadSession.bytes += size;
  });
  return {
    reset() { acc = zero(); sentIds = new Map(); },
    snapshot() { return JSON.parse(JSON.stringify(acc)); },
  };
}

// ---------------------------------------------------------------- 画面を開く・会話を作る

/** 画面を開き、案内（onboarding）を閉じて、会話の一覧が出るまで待つ。reload のたびに呼ぶ */
export async function openPage(rig, { fresh = true } = {}) {
  const { page } = rig;
  await page.goto(rig.url, { waitUntil: 'load' });
  await page.waitForSelector('#groups .row[data-session]', { timeout: 30_000 });
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  if (fresh) await page.evaluate(() => { try { localStorage.removeItem('agent-host-current'); } catch { /* 無し */ } });
}

/** 根の会話を 1 つ作る（echo の 1 ターン）。委譲の依頼元にも、主として開く会話にもなる */
export async function makeRoot(rig, prompt = 'echo:根の会話') {
  const turn = await rig.client.runTurn({ backend: 'fake', cwd: rig.work, prompt });
  return turn.sessionId;
}

const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

/** 親の会話に ply_* を呼ばせて、結果の JSON を返す（走っている間は少し待って送り直す） */
export async function callParent(rig, parent, name, args) {
  const mark = rig.client.mark();
  for (let tries = 0; ; tries++) {
    try { await rig.client.cmd('runTurn', { sessionId: parent, prompt: ply(name, args) }); break; }
    catch (error) { if (tries >= 80) throw error; await sleep(250); }
  }
  const res = await rig.client.waitFor((e) => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
  return JSON.parse(res.text);
}

/** 子を 1 つ委譲する。子の会話の id が決まるまで待つ。task は台本（steps:@file）など */
export async function delegateChild(rig, parent, { title, task }) {
  const out = await callParent(rig, parent, 'ply_delegate', { backend: 'fake', kind: 'mechanical', title, task });
  const row = await waitUntil(async () => (await rig.client.cmd('agentTasks')).find((r) => r.taskId === out.taskId && r.sessionId), `child session of ${title}`);
  return { taskId: out.taskId, childId: row.sessionId };
}

export const taskRow = async (rig, taskId) => (await rig.client.cmd('agentTasks')).find((r) => r.taskId === taskId);

/** 子の会話が終わる（completed / failed / cancelled）まで待つ */
export async function waitChildDone(rig, taskId, ms = 180_000) {
  return waitUntil(async () => { const r = await taskRow(rig, taskId); return ['completed', 'failed', 'cancelled'].includes(r?.status) ? r : null; }, `child ${taskId} finished`, ms, 250);
}

/** 会話に台本を 1 回流して、ターンが終わるまで待つ（終わった会話にも、走っていない子にも使える） */
export async function runScript(rig, sessionId, file, { ms = 180_000 } = {}) {
  const mark = rig.client.mark();
  await rig.client.cmd('runTurn', { sessionId, prompt: `steps:@${file}` });
  await rig.client.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from: mark, ms });
}

/** 台本を流し始めるだけ（終わりは待たない）。返すのは、終わりを待つ関数 */
export async function startScript(rig, sessionId, file, { ms = 180_000 } = {}) {
  const mark = rig.client.mark();
  await rig.client.cmd('runTurn', { sessionId, prompt: `steps:@${file}` });
  return () => rig.client.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from: mark, ms });
}

// ---------------------------------------------------------------- 画面の操作

/** 主の会話として開く（一覧の行を押す） */
export async function openMain(rig, sessionId) {
  await rig.page.click(`#groups .row[data-session="${sessionId}"]`, { timeout: 15_000 });
}

/** 親の会話（主）の委譲カードを押して、子の会話をモーダルで開く。開いた（本文が子の id になった）まで待つ */
export async function openChildModal(rig, parent, taskId) {
  const { page } = rig;
  await openMain(rig, parent);
  const sel = `.tc[data-tool$="ply_delegate"][data-task-id="${taskId}"] .tc-go`;
  await page.waitForSelector(sel, { timeout: 30_000 });
  const opened = () => page.evaluate(() => document.getElementById('workDialog').open && !!document.getElementById('workBody').dataset.sessionId);
  for (let tries = 0; ; tries++) {
    // 座標では押さない（カードが描き直されて高さが変わると、別の所に当たる）。DOM の click を送る
    const hit = await page.evaluate((s) => { const n = document.querySelector(s); if (!n) return false; n.click(); return true; }, sel);
    if (hit) {
      const until = Date.now() + 4_000;
      while (Date.now() < until && !(await opened())) await sleep(100);
      if (await opened()) return;
    }
    if (tries >= 4) throw new Error('modal did not open');
    await sleep(400);
  }
}

export async function closeChildModal(rig) {
  await rig.page.evaluate(() => document.getElementById('workDialog').close());
  await waitUntil(() => rig.page.evaluate(() => !document.getElementById('workDialog').open), 'modal closed', 5_000, 50);
}

// ---------------------------------------------------------------- 計測

/** ページの中で、コマ間隔（rAF）と longtask を採り始める。止めると { frames, longtasks } を返す */
export async function startFrameProbe(rig) {
  await rig.page.evaluate(() => {
    const probe = window.__probe = { deltas: [], longtasks: [], stop: false, last: performance.now() };
    const tick = (now) => { probe.deltas.push(now - probe.last); probe.last = now; if (!probe.stop) requestAnimationFrame(tick); };
    requestAnimationFrame((now) => { probe.last = now; requestAnimationFrame(tick); });
    try {
      probe.observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) probe.longtasks.push(e.duration); });
      probe.observer.observe({ type: 'longtask', buffered: false });
    } catch { /* 無い環境 */ }
  });
}

export async function stopFrameProbe(rig) {
  const raw = await rig.page.evaluate(() => { const p = window.__probe; p.stop = true; try { p.observer?.disconnect(); } catch { /* 無し */ } return { deltas: p.deltas, longtasks: p.longtasks }; });
  const sorted = [...raw.deltas].sort((a, b) => a - b);
  const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
  const r1 = (n) => n == null ? null : Math.round(n * 10) / 10;
  return {
    frames: sorted.length, p50: r1(q(0.5)), p95: r1(q(0.95)), p99: r1(q(0.99)), max: r1(sorted.at(-1) ?? null),
    longtasks: raw.longtasks.length, longtaskMs: r1(raw.longtasks.reduce((s, n) => s + n, 0)),
  };
}

/** CDP の Performance.getMetrics を { 名前: 値 } で */
export async function metrics(rig) {
  const { metrics: list } = await rig.cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

export async function setThrottle(rig, rate) {
  await rig.cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

export const median = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
