// 子の会話のモーダル（#workDialog）の「いまの形」を実ブラウザーで固定する（ADR 0318 段 6-1。段 6 で本文の描き方を主と同じ部品に替えても、見た目の約束を壊さないための土台）。
//   1. 走っている子の本文が、モーダルを開いたまま伸びていく（本文・ツール・「いま動いている」の行。終われば行は消える）
//   2. 追加の指示の 5 つの状態が、同じ行の中で切り替わる
//        送信中（sending）→ 配送済み（delivered）／待機（queued）／届かずに終わった（dropped）／次のターンで届く（queued ＋ nextTurn）
//      待機の 2 件は、子の次のターンで履歴の発言（待機の印なし・1 回だけ）に変わる。届かなかった行は残る
//   3. モーダルには枝（.branch-row）と git・worktree の札（.git-sum-row / .git-delegate）が出ない（無いことだけ。git の札を出す側の対照は未確認）
// 既に別の試験が守っているものは足さない: 承認カードの 1 秒以内の出入り・読み直しの回数・フォーカスとスクロールの保持（work-dialog-keep-open.mjs）、
//   名札（work-dialog-name-tags.mjs）、検索からの移動・Alt+↑↓・最新へ（work-dialog-search-menu.mjs / child-open-routes.mjs）
// 実行: node tests/browser/work-dialog-live-stream.mjs
// 本物のサーバー（fake バックエンド・一時のデータ置き場・空いている別ポート）だけと話す。待ちは状態を待つ（上限つき）。固定の待ちは使わない。
import assert from 'node:assert/strict';
import {
  startRig, openPage, makeRoot, callParent, delegateChild, waitChildDone, writeScript, tailScript, openChildModal, waitUntil, taskRow,
} from '../lib/child-modal-rig.mjs';

const rig = await startRig({ tag: 'wd-live', gates: true, env: { AGENT_HOST_FAKE_STEER_CONFIRM_MS: '20' } });
const { page } = rig;
const modal = (fn, arg) => page.evaluate(fn, arg);
const has = (selector) => modal((s) => document.querySelectorAll(`#workBody ${s}`).length, selector);
try {
  console.log(`fake server pid=${rig.server.child.pid} port=${rig.server.port}`);
  const parent = await makeRoot(rig, 'echo:指示の状態の依頼元');
  await openPage(rig);

  // ---------------------------------------------------------------- 1. 走っている本文が伸びる
  const ROUNDS = 25;
  const tail = writeScript(rig.base, 'tail', tailScript({ rounds: ROUNDS }));
  const live = await delegateChild(rig, parent, { title: '流れる子', task: `steps:@${tail}` });
  await openChildModal(rig, parent, live.taskId);
  const sample = () => modal(() => {
    const body = document.getElementById('workBody');
    return {
      length: body.textContent.length,
      rows: body.querySelectorAll('.mw').length,
      tools: body.querySelectorAll('.tc').length,
      activity: body.querySelectorAll('.m.activity').length,
      last: [...body.querySelectorAll('.m.assistant')].at(-1)?.textContent.length ?? 0,
    };
  });
  const first = await sample();
  assert.equal((await taskRow(rig, live.taskId)).status, 'running', 'the child is still running when the modal opens');
  const lengths = new Set([first.length]);
  const toolCounts = new Set([first.tools]);
  let sawActivity = first.activity > 0;
  const lastRound = `末尾 ${ROUNDS - 1}:`;
  await waitUntil(async () => {
    const now = await sample();
    lengths.add(now.length); toolCounts.add(now.tools); if (now.activity > 0) sawActivity = true;
    return modal((text) => document.getElementById('workBody').textContent.includes(text), lastRound);
  }, 'the last round streams in', 90_000, 80);
  console.log(`growth: ${lengths.size} distinct body lengths, ${toolCounts.size} distinct tool counts, activity row seen=${sawActivity}`);
  assert.ok(lengths.size >= 6, `the body grows while the child runs (${lengths.size} distinct lengths)`);
  assert.ok(toolCounts.size >= 4, `tool rows are added while the child runs (${toolCounts.size} distinct counts)`);
  assert.ok(sawActivity, 'a running row (.m.activity) is shown while the child runs');
  await waitChildDone(rig, live.taskId, 60_000);
  await waitUntil(async () => (await has('.m.activity')) === 0, 'the running row goes away when the child ends', 15_000, 80);
  assert.equal(await modal(() => document.getElementById('workDialog').open), true, 'the modal stays open while it streams');
  console.log('PASS: the running child grows in the open modal, and the running row goes away at the end');

  // ---------------------------------------------------------------- 3. 枝・git・worktree の札は出ない（上の子の本文が全部描かれた後で数える）
  for (const selector of ['.branch-row', '.git-sum-row', '.git-delegate', '.branch-transition']) {
    assert.equal(await has(selector), 0, `no ${selector} in the child modal`);
  }
  console.log('PASS: no branch row and no git / worktree chip in the modal (absence only; the positive control is not covered here)');

  // ---------------------------------------------------------------- 2. 追加の指示の状態（待ちに入る子 + ゲート）
  await modal(() => document.getElementById('workDialog').close());
  const mark = rig.client.mark();
  const waiting = await delegateChild(rig, parent, { title: '待つ子', task: 'bg 1 gate:child-wait' });
  await rig.client.waitFor((e) => e.type === 'phase' && e.sessionId === waiting.childId && e.state === 'waiting', { from: mark, ms: 30_000 });
  await openChildModal(rig, parent, waiting.taskId);
  const send = (message, extra = {}) => callParent(rig, parent, 'ply_task_send', { taskId: waiting.taskId, message, ...extra });
  const row = (text) => modal((t) => {
    const m = [...document.querySelectorAll('#workBody [data-instruction-id]')].find((n) => n.textContent.includes(t));
    if (!m) return null;
    return {
      queued: m.classList.contains('queued'),
      clock: m.querySelectorAll('.who-queued').length,
      statuses: [...m.querySelectorAll('.outbox-status')].map((n) => ({ mark: n.classList.contains('outbox-status-mark'), text: n.textContent.trim() })),
      who: (m.querySelector('.who > span')?.textContent ?? '').trim(),
    };
  }, text);
  const rowIs = (text, want, label, ms = 15_000) => waitUntil(async () => { const r = await row(text); return r && want(r) ? r : null; }, label, ms, 60);
  const idle = (r) => !r.queued && r.clock === 0 && r.statuses.length === 0;

  // 送信中 → 配送済み（合図をゲートで止めている間は「まだ渡っていない」。開けたら行から印が消え、返事が続く）
  await send('echo:SENT HOLD_CONFIRM:confirm-sent');
  const sending = await rowIs('echo:SENT', (r) => r.statuses.length === 1 && r.statuses[0].mark, 'sending row shows the delivery mark');
  assert.ok(!sending.queued && sending.who === '追加の指示', `sending row is a plain 追加の指示 row: ${JSON.stringify(sending)}`);
  rig.gates.open('confirm-sent');
  await rowIs('echo:SENT', idle, 'sending turns into delivered (no extras on the row)');
  await waitUntil(() => modal(() => document.getElementById('workBody').textContent.includes('受け取った: echo:SENT')), 'the child answers the delivered instruction', 15_000, 80);
  console.log('PASS: sending → delivered, on the same row');

  // 届かずに終わった（結果不明）。待機の指示が先頭にあると後ろの指示は試されないので、待機より先に送る
  await send('echo:DROPPED THROW_STEER');
  const dropped = await rowIs('echo:DROPPED', (r) => r.statuses.length === 1, 'dropped row');
  assert.ok(!dropped.queued && !dropped.statuses[0].mark, `dropped row is not queued and not sending: ${JSON.stringify(dropped)}`);
  assert.ok(dropped.statuses[0].text.includes('届かずに終わった'), `dropped row says it did not arrive: ${dropped.statuses[0].text}`);
  console.log('PASS: dropped (the not-arrived line)');

  // 待機（受理されない）
  await send('echo:QUEUED DECLINE_STEER');
  const queued = await rowIs('echo:QUEUED', (r) => r.queued, 'queued row');
  assert.equal(queued.clock, 1, 'queued row has the clock mark');
  assert.deepEqual(queued.statuses, [], 'a queued row that could be steered has no extra line');
  console.log('PASS: queued (clock mark, no extra line)');

  // 次のターンで届く（設定の変更と同じ呼び出しで積んだ指示）
  await send('echo:NEXTTURN', { model: 'smart' });
  const next = await rowIs('echo:NEXTTURN', (r) => r.queued && r.statuses.length === 1, 'next-turn row');
  assert.ok(next.statuses[0].text.includes('次のターンで届く') && !next.statuses[0].mark, `next-turn row carries the next-turn line: ${JSON.stringify(next)}`);
  assert.equal(next.clock, 1, 'next-turn row also has the clock mark');
  console.log('PASS: next-turn (clock mark + next-turn line)');

  // 4 行そろった状態で、行の順序は送った順のまま
  const order = await modal(() => [...document.querySelectorAll('#workBody [data-instruction-id]')].map((n) => (n.textContent.match(/echo:[A-Z]+/) ?? [''])[0]));
  assert.deepEqual(order, ['echo:SENT', 'echo:DROPPED', 'echo:QUEUED', 'echo:NEXTTURN'], 'instruction rows keep the order they were sent');

  // 子が終われば、待機の 2 件は次のターンで配送済みになる。届かなかった行はそのまま
  rig.gates.open('child-wait');
  // 子の次のターンで届くと、指示の行は履歴の発言に置き換わる（待機の印は消え、同じ本文が 1 回だけ残る）
  const asMessage = (text) => modal((t) => {
    const rows = [...document.querySelectorAll('#workBody .m.user')].filter((n) => n.textContent.includes(t));
    return { count: rows.length, queued: rows.some((n) => n.classList.contains('queued') || n.querySelector('.who-queued')), pendingRows: document.querySelectorAll(`#workBody [data-instruction-id]`).length };
  }, text);
  for (const text of ['echo:QUEUED', 'echo:NEXTTURN']) {
    const got = await waitUntil(async () => { const r = await asMessage(text); return r.count === 1 && !r.queued ? r : null; }, `${text} becomes a delivered message`, 90_000, 150);
    assert.equal(got.count, 1, `${text} appears exactly once`);
  }
  await waitChildDone(rig, waiting.taskId, 90_000);
  const stillDropped = await row('echo:DROPPED');
  assert.ok(stillDropped && !stillDropped.queued && stillDropped.statuses.length === 1, `the dropped row stays dropped: ${JSON.stringify(stillDropped)}`);
  console.log('PASS: queued and next-turn rows are delivered by the next turn; the dropped row stays');

  assert.deepEqual(rig.pageErrors, [], 'no page errors');
  console.log('PASS');
} finally {
  await rig.close();
}
