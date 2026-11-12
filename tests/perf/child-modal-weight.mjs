// 長い子の会話をモーダルで開いたときの重さと、同じ会話を主で開いたときの重さを測る（ADR 0318 段 6 の前後の比較用）。手で流す。npm test には入れない。
//
// 流れ（1 回の計測 = サーバーを 1 つ立て直して、次を順に行う。回ごとに独立）:
//   1. 履歴の台本（300 発言＋ツール 50）を、委譲の子と、主で開く根の会話の両方に流して終える
//   2. 画面を読み直し、CPU を絞った（既定 4 倍）まま、子をモーダルで開く。開くまでの時間・DOM の量・loadSession の回数と受け取ったバイト数
//   3. 続けて「流れている末尾」の台本（約 20 秒。ツール＋240 字の本文を 20 回）を子に流し、流れている間の
//      コマ間隔（rAF の p50/p95/p99/max）・longtask・LayoutCount・LayoutDuration・TaskDuration・ScriptDuration・loadSession の回数とバイト数
//   4. 画面を読み直し、同じ会話（根）を主で開いて、2・3 と同じことを測る（段 6 の後に、モーダルが近づく目標値）
//
// 実行: node tests/perf/child-modal-weight.mjs [--runs=3] [--throttle=4] [--messages=300] [--tools=50] [--rounds=20] [--out=<json のパス>]
//   同じ引数で流せば、後の段で同じ形の数字を取り直せる。ほかの重い node / chrome が走っていない時に流す
// 計測の値はこの PC・この時の負荷で動く。比べるのは同じ回の中の モーダル:主 と、同じ引数で流した前後
import fs from 'node:fs';
import path from 'node:path';
import {
  startRig, openPage, makeRoot, delegateChild, waitChildDone, writeScript, historyScript, tailScript, runScript,
  openMain, setThrottle, startFrameProbe, stopFrameProbe, metrics, median, waitUntil,
} from '../lib/child-modal-rig.mjs';

const arg = (name, fallback) => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const RUNS = Number(arg('runs', 3));
const THROTTLE = Number(arg('throttle', 4));
const MESSAGES = Number(arg('messages', 300));
const TOOLS = Number(arg('tools', 50));
const ROUNDS = Number(arg('rounds', 20));
const OUT = arg('out', null);
// 子と主で台本の見出しを変える（子の完了の通知は最後の本文を依頼元の会話に書くので、同じだと開く前から「見えた」と判定してしまう）
const lastOf = (tag) => `${tag} ${MESSAGES - 1}: `;

/** クリックしてから、最後の発言が見えるまで（rAF ごとに調べる）と、そのあと行の数が 1 秒変わらなくなるまで。ページの中で時刻を採る */
function probeOpen({ rootSelector, last }) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const root = document.querySelector(rootSelector);
    let seenAt = null, rows = -1, rowsAt = t0;
    const tick = () => {
      const now = performance.now();
      if (seenAt === null && root.textContent.includes(last)) seenAt = now - t0;
      const n = root.querySelectorAll('.mw').length;
      if (n !== rows) { rows = n; rowsAt = now; }
      if (seenAt !== null && now - rowsAt > 1000) return resolve({ lastVisibleMs: Math.round(seenAt), settledMs: Math.round(rowsAt - t0) });
      if (now - t0 > 90_000) return resolve({ lastVisibleMs: seenAt === null ? null : Math.round(seenAt), settledMs: null, timedOut: true });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const domOf = (rig, rootSelector) => rig.page.evaluate((sel) => {
  const root = document.querySelector(sel);
  return { rows: root.querySelectorAll('.mw').length, nodes: root.querySelectorAll('*').length, textLength: root.textContent.length };
}, rootSelector);

async function measureStream(rig, rootSelector, sessionId, tailFile) {
  rig.wire.reset();
  const before = await metrics(rig);
  await startFrameProbe(rig);
  const t0 = Date.now();
  await runScript(rig, sessionId, tailFile, { ms: 240_000 });
  // 最後の描き直し（読み直しの throttle は最長 3 秒）まで含めて、末尾が画面に出るまで待つ
  await waitUntil(() => rig.page.evaluate(([sel, text]) => document.querySelector(sel).textContent.includes(text), [rootSelector, `末尾 ${ROUNDS - 1}:`]), 'tail visible', 30_000, 100);
  const frames = await stopFrameProbe(rig);
  const after = await metrics(rig);
  // 終わりの読み直し（ターンの終わりに 1 回）の返事が届くまで、通信が静かになるのを待つ（上限 8 秒）
  const quietStart = Date.now();
  let quiet = rig.wire.snapshot().frames, quietAt = Date.now();
  while (Date.now() - quietAt < 1200 && Date.now() - quietStart < 8000) {
    await new Promise((r) => setTimeout(r, 200));
    const now = rig.wire.snapshot().frames;
    if (now !== quiet) { quiet = now; quietAt = Date.now(); }
  }
  const wire = rig.wire.snapshot();
  const d = (k) => Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000) / 1000;
  return {
    streamMs: Date.now() - t0, frames,
    layoutCount: d('LayoutCount'), layoutSec: d('LayoutDuration'), taskSec: d('TaskDuration'), scriptSec: d('ScriptDuration'), recalcCount: d('RecalcStyleCount'),
    loadSession: wire.loadSession, wireBytes: wire.bytes, wireFrames: wire.frames, commands: wire.commands,
    dom: await domOf(rig, rootSelector),
  };
}

async function oneRun(index) {
  const rig = await startRig({ tag: 'ply-s6-weight', throttle: THROTTLE });
  try {
    const hist = writeScript(rig.base, 'history-child', historyScript({ messages: MESSAGES, tools: TOOLS, tag: '履歴子' }));
    const histMain = writeScript(rig.base, 'history-main', historyScript({ messages: MESSAGES, tools: TOOLS, tag: '履歴主' }));
    const tail = writeScript(rig.base, 'tail', tailScript({ rounds: ROUNDS }));
    const parent = await makeRoot(rig, 'echo:根の会話（子の依頼元）');
    // 主で開く会話（同じ台本を直接流す）と、委譲の子（同じ台本）を並べて作る
    const mainTurn = rig.client.runTurn({ backend: 'fake', cwd: rig.work, prompt: `steps:@${histMain}` }, { ms: 240_000 });
    const child = await delegateChild(rig, parent, { title: '長い子', task: `steps:@${hist}` });
    const [{ sessionId: mainId }] = await Promise.all([mainTurn, waitChildDone(rig, child.taskId, 240_000)]);
    console.log(`  run ${index + 1}: history ready (child=${child.childId} main=${mainId})`);
    const result = {};

    // ---- モーダル
    await openPage(rig);
    await openMain(rig, parent);
    await rig.page.waitForSelector(`.tc[data-tool$="ply_delegate"][data-task-id="${child.taskId}"] .tc-go`, { timeout: 30_000 });
    await setThrottle(rig, THROTTLE);
    rig.wire.reset();
    const modalOpen = rig.page.evaluate(probeOpen, { rootSelector: '#workBody', last: lastOf('履歴子') });
    await rig.page.evaluate((id) => document.querySelector(`.tc[data-tool$="ply_delegate"][data-task-id="${id}"] .tc-go`).click(), child.taskId);
    const modalTime = await modalOpen;
    const openWire = rig.wire.snapshot();
    result.modal = { open: { ...modalTime, dom: await domOf(rig, '#workBody'), loadSession: openWire.loadSession, wireBytes: openWire.bytes } };
    result.modal.stream = await measureStream(rig, '#workBody', child.childId, tail);
    await setThrottle(rig, 1);

    // ---- 主（同じ会話）
    await openPage(rig);
    // 起動の自動選択（いちばん新しい会話）に重ならないよう、別の会話（依頼元）を先に開いてから、測る会話へ切り替える
    await openMain(rig, parent);
    await waitUntil(() => rig.page.evaluate(() => document.getElementById('thread').textContent.includes('子の依頼元')), 'parent shown', 30_000);
    await setThrottle(rig, THROTTLE);
    rig.wire.reset();
    const mainOpen = rig.page.evaluate(probeOpen, { rootSelector: '#thread', last: lastOf('履歴主') });
    await rig.page.click(`#groups .row[data-session="${mainId}"]`);
    const mainTime = await mainOpen;
    const mainWire = rig.wire.snapshot();
    result.main = { open: { ...mainTime, dom: await domOf(rig, '#thread'), loadSession: mainWire.loadSession, wireBytes: mainWire.bytes } };
    result.main.stream = await measureStream(rig, '#thread', mainId, tail);
    result.pageErrors = rig.pageErrors.slice();
    return result;
  } finally {
    await rig.close();
  }
}

const results = [];
for (let i = 0; i < RUNS; i++) {
  results.push(await oneRun(i));
  console.log(JSON.stringify(results.at(-1)));
}

// ---- まとめ（中央値と範囲）
const pick = (get) => results.map(get).filter((v) => typeof v === 'number');
const fmt = (values) => values.length ? `${median(values)}（${Math.min(...values)}〜${Math.max(...values)}）` : '—';
const rows = [
  ['開く: 最後の発言が見えるまで ms', (r, k) => r[k].open.lastVisibleMs],
  ['開く: 行の数が落ち着くまで ms', (r, k) => r[k].open.settledMs],
  ['開いた後の行（.mw）の数', (r, k) => r[k].open.dom.rows],
  ['開いた後の DOM 要素の数', (r, k) => r[k].open.dom.nodes],
  ['開く: loadSession の回数', (r, k) => r[k].open.loadSession.count],
  ['開く: loadSession の返事のバイト数', (r, k) => r[k].open.loadSession.bytes],
  ['流れる間: コマ間隔 p50 ms', (r, k) => r[k].stream.frames.p50],
  ['流れる間: コマ間隔 p95 ms', (r, k) => r[k].stream.frames.p95],
  ['流れる間: コマ間隔 p99 ms', (r, k) => r[k].stream.frames.p99],
  ['流れる間: コマ間隔 max ms', (r, k) => r[k].stream.frames.max],
  ['流れる間: longtask の数', (r, k) => r[k].stream.frames.longtasks],
  ['流れる間: LayoutCount', (r, k) => r[k].stream.layoutCount],
  ['流れる間: LayoutDuration 秒', (r, k) => r[k].stream.layoutSec],
  ['流れる間: TaskDuration 秒', (r, k) => r[k].stream.taskSec],
  ['流れる間: ScriptDuration 秒', (r, k) => r[k].stream.scriptSec],
  ['流れる間: loadSession の回数', (r, k) => r[k].stream.loadSession.count],
  ['流れる間: loadSession の返事のバイト数', (r, k) => r[k].stream.loadSession.bytes],
  ['流れる間: 受け取った全バイト数', (r, k) => r[k].stream.wireBytes],
  ['流れ終わりの行（.mw）の数', (r, k) => r[k].stream.dom.rows],
  ['流れ終わりの DOM 要素の数', (r, k) => r[k].stream.dom.nodes],
];
const table = [
  `計測の設定: runs=${RUNS} throttle=${THROTTLE}x messages=${MESSAGES} tools=${TOOLS} rounds=${ROUNDS}`,
  '',
  '| 項目 | モーダル（中央値（範囲）） | 主（中央値（範囲）） |',
  '|---|---|---|',
  ...rows.map(([label, get]) => `| ${label} | ${fmt(pick((r) => get(r, 'modal')))} | ${fmt(pick((r) => get(r, 'main')))} |`),
].join('\n');
console.log('\n' + table);
const errors = results.flatMap((r) => r.pageErrors ?? []);
if (errors.length) console.log('page errors:', JSON.stringify(errors));
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ args: { RUNS, THROTTLE, MESSAGES, TOOLS, ROUNDS }, results, table }, null, 2));
  console.log(`wrote ${OUT}`);
}
