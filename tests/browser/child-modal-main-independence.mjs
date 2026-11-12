// 作業のダイアログ（モーダル）の子の本文と、主の会話の本文が、互いを書き換えないことを実ブラウザーで確かめる（ADR 0319 段 6-6）。
//   1. 主が親の会話を開いたまま、モーダルで走っている子を開く。子の本文が流れて伸びる間、主の本文（委譲カードを除く行）は 1 つも変わらず、
//      子の語は主の #thread に出ない
//   2. 子が終わったあと、モーダルを開いたまま、親の会話を本物のサーバーで走らせる。主の #thread は伸びるが、モーダルの本文は 1 つも変わらず、
//      親の語はモーダルに出ない
//   3. モーダルを閉じたあとに届く子の出来事は、閉じた実例（外れた本文の要素）に描かれず、ページのエラーも出ない
// 実行: node tests/browser/child-modal-main-independence.mjs   （CHILD_THREAD=reread で従来の読み直しの経路でも確かめる）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・空いている別ポート）だけと話す。待ちは状態を待つ（上限つき）。
import assert from 'node:assert/strict';
import {
  startRig, openPage, makeRoot, runScript, writeScript, historyScript, tailScript, delegateChild, waitChildDone, openChildModal, closeChildModal, waitUntil,
} from '../lib/child-modal-rig.mjs';

const rig = await startRig({ tag: 'child-main-indep' });
const { page } = rig;
try {
  console.log(`fake server pid=${rig.server.child.pid} port=${rig.server.port}`);
  const reread = process.env.CHILD_THREAD === 'reread';
  if (reread) rig.url += '&childThread=reread';
  const P = await makeRoot(rig, 'echo:親の会話');
  await runScript(rig, P, writeScript(rig.base, 'p-history', historyScript({ messages: 12, tools: 4, tag: '親の履歴' })));
  const child = await delegateChild(rig, P, { title: '流れる子', task: `steps:@${writeScript(rig.base, 'c-tail', tailScript({ rounds: 8, tag: '子末尾' }))}` });
  await openPage(rig);
  await openChildModal(rig, P, child.taskId);
  await waitUntil(() => page.evaluate(() => document.getElementById('workBody').textContent.includes('子末尾')), 'modal shows the child stream', 30_000);

  // 主の行の写し（委譲カードは子の状態で変わるので除く）
  const mainRows = () => page.evaluate(() => [...document.querySelectorAll('#thread .mw')]
    .filter((w) => !w.querySelector('.tc[data-tool$="ply_delegate"]') && !String(w.dataset.key).startsWith('activity'))
    .map((w) => w.dataset.key + '|' + w.textContent.trim()));
  const mainBefore = await mainRows();
  assert.ok(mainBefore.length >= 8, `main has its own rows (${mainBefore.length})`);
  assert.ok(!mainBefore.join('').includes('子末尾'), 'child words are not in main before the stream grows');

  // ---- 1. 子が流れる間、主は変わらない ----
  const rowsAt = () => page.evaluate(() => document.querySelectorAll('#workBody .bg-thread .mw').length);
  const rows0 = await rowsAt();
  await waitUntil(async () => (await rowsAt()) >= rows0 + 4, 'the modal grows while the child streams', 30_000, 150);
  const mainDuring = await mainRows();
  assert.deepEqual(mainDuring, mainBefore, 'main rows are unchanged while the modal child streams');
  assert.ok(!(await page.evaluate(() => document.getElementById('thread').textContent.includes('子末尾'))), 'child words never reach #thread');
  console.log(`PASS: modal child grew ${rows0} -> ${await rowsAt()} rows; main's ${mainBefore.length} rows unchanged${reread ? ' (reread)' : ''}`);

  // ---- 2. 子が終わったあと、親が流れる間、モーダルは変わらない ----
  await waitChildDone(rig, child.taskId);
  const modalSig = () => page.evaluate(() => {
    const th = document.querySelector('#workBody .bg-thread');
    return th ? [...th.querySelectorAll(':scope > .mw')].map((w) => w.dataset.key + '|' + w.textContent.trim()) : null;
  });
  // 終わりの描き直し・高さの確定が落ち着くのを待つ
  let last = null, same = 0;
  await waitUntil(async () => { const now = JSON.stringify(await modalSig()); same = now === last ? same + 1 : 0; last = now; return same >= 5; }, 'modal settles', 20_000, 200);
  const modalBefore = await modalSig();
  assert.ok(modalBefore?.some((r) => r.includes('子末尾 7')), 'the modal shows the whole child stream');
  const mainRowsBefore2 = await page.evaluate(() => document.querySelectorAll('#thread .mw').length);
  await runScript(rig, P, writeScript(rig.base, 'p-tail', tailScript({ rounds: 4, tag: '親末尾' })));
  await waitUntil(() => page.evaluate(() => document.getElementById('thread').textContent.includes('親末尾 3')), 'main shows the parent stream', 30_000);
  const modalAfter = await modalSig();
  assert.deepEqual(modalAfter, modalBefore, 'the modal rows are unchanged while the parent conversation streams');
  assert.ok(!modalAfter.join('').includes('親末尾'), 'parent words never reach the modal');
  const mainRowsAfter2 = await page.evaluate(() => document.querySelectorAll('#thread .mw').length);
  assert.ok(mainRowsAfter2 > mainRowsBefore2, 'main grew');
  console.log(`PASS: main grew ${mainRowsBefore2} -> ${mainRowsAfter2} rows; the modal's ${modalBefore.length} rows unchanged`);

  // ---- 3. モーダルを閉じたあとに届く子の出来事は、閉じた実例に描かれない ----
  await closeChildModal(rig);
  const child2 = await delegateChild(rig, P, { title: '閉じたあとの子', task: `steps:@${writeScript(rig.base, 'c2-tail', tailScript({ rounds: 8, tag: '閉後' }))}` });
  await openChildModal(rig, P, child2.taskId);
  await waitUntil(() => page.evaluate(() => document.getElementById('workBody').textContent.includes('閉後')), 'the second child streams in the modal', 30_000);
  await page.evaluate(() => { window.__closedThread = document.querySelector('#workBody .bg-thread'); });
  await closeChildModal(rig);
  const closedSig = () => page.evaluate(() => { const th = window.__closedThread; return th ? th.querySelectorAll('.mw').length + '|' + th.textContent.length : null; });
  const sigAtClose = await closedSig();
  assert.ok(sigAtClose, 'the closed thread node is still referenced');
  await waitChildDone(rig, child2.taskId);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await closedSig(), sigAtClose, 'events after the modal closed do not touch the disposed view');
  console.log(`PASS: after closing, the child's events did not reach the disposed view (${sigAtClose})`);
  assert.deepEqual(rig.pageErrors, [], 'no page errors');
  console.log('ALL PASS');
} finally {
  await rig.close();
}
