// 主の会話が流れている間の追従と、利用者のスクロールの関係を、本物のホイール（Playwright の信頼された入力）で固定する（ADR 0319 段 6-6）。
//   1. 末尾にいる間は付いていく（流れる本文・ツールの行が増えても、末尾から離れない）
//   2. 流れている間に本物のホイールで上へ読み戻すと、その位置が保たれる（追従は利用者の操作でやめる）。その間も本文は伸びている
//   3. 末尾へ戻ると（End）、次の出来事からまた付いていく
// 直す前の followBottom（利用者の操作で止まらず、320ms の間 rAF ごとに末尾へ戻す）では 2 が落ちる。
// 実行: node tests/browser/main-follow-bottom.mjs
// 本物のサーバー（fake バックエンド・一時のデータ置き場・空いている別ポート）だけと話す。待ちは状態を待つ（上限つき）。
import assert from 'node:assert/strict';
import { startRig, openPage, openMain, waitUntil, sleep, writeScript, tailScript, startScript } from '../lib/child-modal-rig.mjs';

const rig = await startRig({ tag: 'main-follow' });
const { page } = rig;
const ev = (fn, arg) => page.evaluate(fn, arg);
try {
  console.log(`fake server pid=${rig.server.child.pid} port=${rig.server.port}`);
  const paragraphs = (n) => Array.from({ length: 5 }, (_, i) => `回 ${n} の段落 ${i}: ${'本文です。'.repeat(18)}`).join('\n\n');
  let nav = null;
  for (let n = 0; n < 6; n++) {
    const turn = await rig.client.runTurn(nav ? { sessionId: nav, prompt: `echo:質問 ${n}\n\n${paragraphs(n)}` } : { backend: 'fake', cwd: rig.work, prompt: `echo:質問 ${n}\n\n${paragraphs(n)}` });
    nav ??= turn.sessionId;
  }
  await openPage(rig);
  await openMain(rig, nav);
  const shape = () => ev(() => {
    const l = document.getElementById('log');
    return { top: Math.round(l.scrollTop), height: l.scrollHeight, away: Math.round(l.scrollHeight - l.clientHeight - l.scrollTop) };
  });
  await waitUntil(async () => (await shape()).away < 40, 'the conversation opens at the end', 15_000);
  await sleep(1500);

  const tail = writeScript(rig.base, 'tail', tailScript({ rounds: 45 }));
  const finish = await startScript(rig, nav, tail, { ms: 180_000 });

  // ---------------------------------------------------------------- 1. 末尾にいる間は付いていく
  const start = await waitUntil(async () => { const s = await shape(); return s.height > 0 && (await ev(() => document.querySelectorAll('#thread .tc').length)) >= 2 ? s : null; }, 'the turn streams', 30_000, 80);
  let maxAway = 0, grew = start.height;
  for (let i = 0; i < 20; i++) { const s = await shape(); maxAway = Math.max(maxAway, s.away); grew = Math.max(grew, s.height); await sleep(100); }
  console.log(`1. at the end: max distance ${maxAway}px, height ${start.height} -> ${grew}`);
  assert.ok(maxAway < 60, `follows the end while streaming (max ${maxAway}px away)`);
  assert.ok(grew > start.height, 'the body kept growing during the check');

  // ---------------------------------------------------------------- 2. 本物のホイールで上へ読み戻す
  const rect = await ev(() => { const r = document.getElementById('log').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
  await page.mouse.move(rect.x, rect.y);
  for (let k = 0; k < 3; k++) await page.mouse.wheel(0, -180);
  await sleep(150);
  const up = await shape();
  assert.ok(up.away > 40, `the wheel moved the view up (${up.away}px from the end)`);
  const heights = new Set([up.height]);
  let drift = 0;
  for (let i = 0; i < 25; i++) {
    await sleep(100);
    const s = await shape();
    heights.add(s.height);
    drift = Math.max(drift, Math.abs(s.top - up.top));
  }
  const after = await shape();
  console.log(`2. wheel up: top ${up.top} -> ${after.top} (max drift ${drift}px), away ${up.away} -> ${after.away}, ${heights.size} distinct heights`);
  assert.ok(heights.size >= 3, 'the body kept growing while the position was read back');
  assert.ok(drift <= 2 && after.away > 40, `the reading position is kept while it streams (drift ${drift}px, ${after.away}px from the end)`);

  // ---------------------------------------------------------------- 3. 末尾へ戻ると、また付いていく
  await ev(() => document.getElementById('log').focus({ preventScroll: true }));
  await page.keyboard.press('End');
  await waitUntil(async () => (await shape()).away < 40, 'End goes to the end', 10_000, 80);
  const back = await shape();
  let maxAway2 = 0, grew2 = back.height;
  for (let i = 0; i < 20; i++) { const s = await shape(); maxAway2 = Math.max(maxAway2, s.away); grew2 = Math.max(grew2, s.height); await sleep(100); }
  console.log(`3. back at the end: max distance ${maxAway2}px, height ${back.height} -> ${grew2}`);
  assert.ok(maxAway2 < 60, `follows the end again after returning (max ${maxAway2}px away)`);
  assert.ok(grew2 > back.height, 'the body kept growing during the check');
  await finish();
  console.log('PASS: follows the end; keeps a reading position set by the wheel while it streams; follows again after returning to the end');
} finally {
  await rig.close();
}
