// 主の会話（#thread / #log）の「いまの形」を実ブラウザーで固定する（ADR 0318 段 6-1。段 6 で子のモーダルを主と同じ部品に替えるとき、主の側が壊れていないかを見る土台）。
//   1. 発言のあいだの移動: Alt+↑ / Alt+↓ で前後の人の発言へ、End で末尾へ。末尾から離れると「最新へ」が出て、押すと末尾へ戻り消える
//   2. 走っている最中の追記: 本文が伸び、ツールの行が増え、「いま動いている」の行が出て、終わると消える。末尾にいる間は追いかける
//   3. 承認カード: 出て、許可を押すと 1 秒以内に消え、続きが流れる
//   4. 履歴の窓: 長い会話は末尾の窓だけを描き、手前へ送ると読み足して行が増える（詳しい位置の保持は history-window.cjs が守る。ここは窓と読み足しの有無だけ）
// 既にあるもの: ツールの束（tool-bundle*.cjs・running-tools*.cjs）・承認カードの別の見え方（thread-deck.cjs）・最新へのボタンの位置（composer-overlay.cjs）
// 守れないもの: 思考の本文の逐次表示（fake は「考え中」の印しか出せない）
// 実行: node tests/browser/main-thread-nav.mjs
// 本物のサーバー（fake バックエンド・一時のデータ置き場・空いている別ポート）だけと話す。待ちは状態を待つ（上限つき）。固定の待ちは使わない。
import assert from 'node:assert/strict';
import {
  startRig, openPage, openMain, waitUntil, sleep, writeScript, historyScript, tailScript, startScript,
} from '../lib/child-modal-rig.mjs';

const rig = await startRig({ tag: 'main-nav' });
const { page } = rig;
const ev = (fn, arg) => page.evaluate(fn, arg);
try {
  console.log(`fake server pid=${rig.server.child.pid} port=${rig.server.port}`);

  // ---------------------------------------------------------------- 会話を作る
  // 人の発言が 12 回ある会話（各回の返答は 5 段落。画面より長くなる）
  const TURNS = 12;
  const paragraphs = (n) => Array.from({ length: 5 }, (_, i) => `回 ${n} の段落 ${i}: ${'本文です。'.repeat(18)}`).join('\n\n');
  let nav = null;
  for (let n = 0; n < TURNS; n++) {
    const turn = await rig.client.runTurn(nav ? { sessionId: nav, prompt: `echo:質問 ${n}\n\n${paragraphs(n)}` } : { backend: 'fake', cwd: rig.work, prompt: `echo:質問 ${n}\n\n${paragraphs(n)}` });
    nav ??= turn.sessionId;
  }
  // 長い会話（窓の確認用）: 300 発言＋ツール 50
  const history = writeScript(rig.base, 'history', historyScript({ messages: 300, tools: 50, tag: '長い会話' }));
  const long = (await rig.client.runTurn({ backend: 'fake', cwd: rig.work, prompt: `steps:@${history}` }, { ms: 180_000 })).sessionId;

  await openPage(rig);

  // ---------------------------------------------------------------- 1. 発言のあいだの移動
  await openMain(rig, nav);
  await waitUntil(() => ev(() => document.querySelectorAll('#thread .m.user').length >= 12), 'all 12 user turns are painted');
  const log = () => ev(() => {
    const l = document.getElementById('log');
    const latest = document.querySelector('#logFrame > .nav-latest');
    return { top: Math.round(l.scrollTop), away: Math.round(l.scrollHeight - l.clientHeight - l.scrollTop), latest: !!latest && !latest.hidden && latest.offsetWidth > 0 };
  });
  // スクロールが落ち着く（送った先へ合わせ直す数フレームを含めて、連続して動かなくなる）まで待つ
  const settled = async () => {
    let still = 0, prev = null;
    await waitUntil(async () => {
      const now = (await log()).top;
      still = now === prev ? still + 1 : 0;
      prev = now;
      return still >= 4;
    }, 'scroll settles', 10_000, 80);
    return log();
  };
  await waitUntil(async () => (await log()).away < 40, 'the conversation opens at the end', 15_000);
  const atEnd = await settled();
  assert.equal(atEnd.latest, false, 'the 最新へ button is hidden at the end');
  const keys = await ev(() => ({ log: document.getElementById('log').getAttribute('aria-keyshortcuts'), tab: document.getElementById('log').tabIndex }));
  assert.equal(keys.log, 'Alt+ArrowUp Alt+ArrowDown End', 'the log advertises its shortcuts');
  assert.equal(keys.tab, 0, 'the log can take focus');
  // 本文にフォーカスを置いて（OS のキー入力ではなく、ページへの入力）移動する
  await ev(() => document.getElementById('log').focus({ preventScroll: true }));
  const userTop = () => ev(() => {
    const l = document.getElementById('log').getBoundingClientRect().top;
    return [...document.querySelectorAll('#thread .m.user')].map((m) => Math.round(m.closest('.mw').getBoundingClientRect().top - l));
  });

  const tops = [atEnd.top];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Alt+ArrowUp');
    const now = await waitUntil(async () => { const s = await settled(); return s.top < tops.at(-1) ? s : null; }, `Alt+ArrowUp #${i + 1} moves up`, 15_000, 100);
    tops.push(now.top);
    // 行き先の発言の上端が、会話欄の上端から 12px ほどのところに来る
    const near = (await userTop()).some((y) => y >= 0 && y <= 30);
    assert.ok(near, `after Alt+ArrowUp #${i + 1} a user message sits at the top of the log (tops=${(await userTop()).join(',')})`);
  }
  assert.ok(new Set(tops).size === tops.length && tops.every((v, i) => i === 0 || v < tops[i - 1]), `each Alt+ArrowUp goes further up: ${tops.join(' > ')}`);
  assert.equal((await log()).latest, true, 'the 最新へ button appears once away from the end');
  await page.keyboard.press('Alt+ArrowDown');
  const down = await waitUntil(async () => { const s = await settled(); return s.top > tops.at(-1) ? s : null; }, 'Alt+ArrowDown moves down', 15_000, 100);
  assert.ok(down.top > tops.at(-1) && down.top < tops.at(-2) + 2, `Alt+ArrowDown returns to the neighbour below (${tops.at(-1)} -> ${down.top}; was ${tops.at(-2)})`);
  console.log(`PASS: Alt+ArrowUp x4 / Alt+ArrowDown move between user turns (${tops.join(' > ')} < ${down.top})`);

  await page.keyboard.press('End');
  const ended = await waitUntil(async () => { const s = await settled(); return s.away < 4 ? s : null; }, 'End goes to the end', 15_000, 100);
  await waitUntil(async () => !(await log()).latest, 'the 最新へ button hides at the end', 5_000, 80);
  assert.ok(ended.top > down.top, 'End goes below the previous position');
  console.log('PASS: End goes to the end and the 最新へ button goes away');

  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await waitUntil(async () => (await log()).latest, 'the 最新へ button shows after Alt+ArrowUp x2', 15_000, 100);
  await settled();
  await page.click('#logFrame > .nav-latest', { timeout: 10_000 });
  await waitUntil(async () => { const s = await settled(); return s.away < 4 ? s : null; }, 'the 最新へ button returns to the end', 15_000, 100);
  await waitUntil(async () => !(await log()).latest, 'the 最新へ button hides after returning', 5_000, 80);
  console.log('PASS: the 最新へ button returns to the end and goes away');

  // ---------------------------------------------------------------- 2. 走っている最中の追記（末尾にいる間は追いかける）
  const ROUNDS = 25;
  const tail = writeScript(rig.base, 'tail', tailScript({ rounds: ROUNDS }));
  const sample = () => ev(() => {
    const t = document.getElementById('thread'), l = document.getElementById('log');
    return { length: t.textContent.length, tools: t.querySelectorAll('.tc').length, activity: t.querySelectorAll('.m.activity').length, away: Math.round(l.scrollHeight - l.clientHeight - l.scrollTop) };
  });
  const before = await sample();
  const finish = await startScript(rig, nav, tail, { ms: 120_000 });
  const lengths = new Set([before.length]), toolCounts = new Set([before.tools]);
  let sawActivity = false, maxAway = 0;
  await waitUntil(async () => {
    const now = await sample();
    lengths.add(now.length); toolCounts.add(now.tools); if (now.activity > 0) sawActivity = true; maxAway = Math.max(maxAway, now.away);
    return ev((text) => document.getElementById('thread').textContent.includes(text), `末尾 ${ROUNDS - 1}:`);
  }, 'the last round streams in', 90_000, 80);
  await finish();
  console.log(`growth: ${lengths.size} distinct lengths, ${toolCounts.size} distinct tool counts, activity seen=${sawActivity}, max distance from end=${maxAway}px`);
  assert.ok(lengths.size >= 6, `the body grows while the turn runs (${lengths.size} distinct lengths)`);
  assert.ok(toolCounts.size >= 4, `tool rows are added while the turn runs (${toolCounts.size} distinct counts)`);
  assert.ok(sawActivity, 'a running row (.m.activity) is shown while the turn runs');
  await waitUntil(async () => (await sample()).activity === 0, 'the running row goes away when the turn ends', 15_000, 80);
  await waitUntil(async () => (await sample()).away < 40, 'the view stays at the end while it streams', 10_000, 80);
  assert.ok(maxAway < 400, `following the end while it streams (at most ${maxAway}px away)`);
  console.log('PASS: the running turn grows at the end, the running row goes away, and the view follows the end');

  // ---------------------------------------------------------------- 3. 承認カード
  const gateScript = writeScript(rig.base, 'gate', { steps: [
    { text: '承認の前の本文。' },
    { tool: 'Edit', input: { file_path: 'D:/x/main-gate.txt' }, result: 'edited', ms: 50, ask: true },
    { text: '承認の後の本文。' },
  ] });
  const finishGate = await startScript(rig, nav, gateScript, { ms: 60_000 });
  const card = '#thread .tc-appr[data-perm-id]';
  await waitUntil(() => ev((s) => !!document.querySelector(s), card), 'the approval card shows in the main conversation', 15_000, 60);
  assert.ok(!(await ev(() => document.getElementById('thread').textContent.includes('承認の後の本文。'))), 'the turn waits at the approval');
  const clickedAt = Date.now();
  await page.click(`${card} .btn-primary`, { timeout: 10_000 });
  let goneAt = null;
  await waitUntil(async () => { const gone = !(await ev((s) => !!document.querySelector(s), card)); if (gone && goneAt === null) goneAt = Date.now(); return gone; }, 'the approval card goes away', 5_000, 30);
  await waitUntil(() => ev(() => document.getElementById('thread').textContent.includes('承認の後の本文。')), 'the turn continues after the approval', 15_000, 60);
  await finishGate();
  assert.ok(goneAt - clickedAt <= 1000, `the approval card goes away within 1s of the click (${goneAt - clickedAt}ms)`);
  console.log(`PASS: approval card shown, gone ${goneAt - clickedAt}ms after the click, the turn continues`);

  // ---------------------------------------------------------------- 4. 履歴の窓
  await openMain(rig, long);
  await waitUntil(() => ev(() => document.querySelectorAll('#thread > .mw').length > 20), 'the long conversation is painted');
  const rowsNow = async () => ev(() => ({ rows: document.querySelectorAll('#thread > .mw').length, first: Number((document.querySelector('#thread > .mw[data-key^="m:"]')?.dataset.key ?? 'm:-1').slice(2)) }));
  // 行の数が落ち着く（手前を足す仕事・実寸の確定）まで
  let stable = 0, prevRows = -1;
  await waitUntil(async () => { const n = (await rowsNow()).rows; stable = n === prevRows ? stable + 1 : 0; prevRows = n; return stable >= 12; }, 'row count settles', 30_000, 100);
  const opened = await rowsNow();
  assert.ok(opened.rows > 20 && opened.rows < 300, `only a window of the 300 messages is painted (${opened.rows} rows)`);
  assert.ok(opened.first > 100, `the window starts well inside the conversation (m:${opened.first})`);
  const asks = rig.wire.snapshot();
  rig.wire.reset();
  await ev(() => { document.getElementById('log').scrollTop = 0; });
  await waitUntil(async () => (await rowsNow()).rows > opened.rows, 'scrolling to the top reads older messages', 30_000, 100);
  const older = await rowsNow();
  assert.ok(older.first < opened.first, `older messages are added in front (m:${opened.first} -> m:${older.first})`);
  assert.ok(rig.wire.snapshot().loadSession.count >= 1, 'a loadSession (older) was asked for');
  console.log(`PASS: window of ${opened.rows} rows (from m:${opened.first}); scrolling up read older messages (${opened.rows} -> ${older.rows} rows, from m:${older.first})`);
  void asks;

  assert.deepEqual(rig.pageErrors, [], 'no page errors');
  console.log('PASS');
} finally {
  await rig.close();
}
