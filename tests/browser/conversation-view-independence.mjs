// 会話の本文の面（web/conversation-view.mjs）の実例が、別の会話のものと互いに影響しないことを実ブラウザーで確かめる（ADR 0319 段 6-5）。
//   1. 主の画面（#thread）が会話 A を開いているところへ、別の会話 B の実例（role: 'child'・画面に付けていない DOM）を作り、
//      B の履歴を描き、B へ出来事（発言・本文の流れ・ツール・稼働表示・ターンの終わり）を流す。
//      → 主の #thread の中身・今の会話（localStorage）・題・スクロールの位置は 1 つも変わらない
//   2. 逆に、主の会話 A を本物のサーバーで走らせて #thread が伸びる間、B の実例の thread は 1 つも変わらない
//   3. 2 つの実例の行が混ざらない（B の語は B の thread にだけ、A の語は主の thread にだけある）
// 主の state は画面の外に出していないので、主は DOM（#thread・#log）・localStorage・document.title で見る。
// 部品が主の値（state.* など）を直に読んでいないことは、tests/unit/conversation-view-child.mjs が原稿の走査で守る。
// 実行: node tests/browser/conversation-view-independence.mjs
// 本物のサーバー（fake バックエンド・一時のデータ置き場・空いている別ポート）だけと話す。待ちは状態を待つ（上限つき）。
import assert from 'node:assert/strict';
import {
  startRig, openPage, makeRoot, openMain, runScript, writeScript, historyScript, tailScript, waitUntil,
} from '../lib/child-modal-rig.mjs';

const rig = await startRig({ tag: 'cv-indep' });
const { page } = rig;
try {
  console.log(`fake server pid=${rig.server.child.pid} port=${rig.server.port}`);
  const A = await makeRoot(rig, 'echo:主の会話 A');
  const B = await makeRoot(rig, 'echo:別の会話 B');
  await runScript(rig, A, writeScript(rig.base, 'a-history', historyScript({ messages: 30, tools: 6, tag: 'Aの履歴' })));
  await runScript(rig, B, writeScript(rig.base, 'b-history', historyScript({ messages: 40, tools: 8, tag: 'Bの履歴' })));
  await openPage(rig);
  await openMain(rig, A);
  await waitUntil(() => page.evaluate(() => document.getElementById('thread').textContent.includes('Aの履歴 29')), 'main shows A history', 30_000);

  // 主の見た目の写し（主の state は画面の外に無いので、DOM・localStorage・題・位置で見る）
  const mainSnapshot = () => page.evaluate(() => ({
    thread: document.getElementById('thread').outerHTML,
    rows: document.querySelectorAll('#thread .mw').length,
    current: localStorage.getItem('agent-host-current'),
    title: document.title,
    scrollTop: document.getElementById('log').scrollTop,
    composer: document.getElementById('input')?.value ?? null,
  }));

  // 主が落ち着く（高さの確定・手前の足し込みが終わる）のを待ってから写す。主自身の後始末を、B の影響と取り違えない
  const settled = async (label) => {
    let last = null, same = 0;
    await waitUntil(async () => {
      const now = JSON.stringify(await mainSnapshot());
      same = now === last ? same + 1 : 0; last = now;
      return same >= 4;
    }, label, 20_000, 150);
    return mainSnapshot();
  };
  // 食い違ったとき、最初に違う場所を示す
  const sameMain = async (expected, label) => {
    const now = await mainSnapshot();
    for (const key of Object.keys(expected)) {
      if (now[key] === expected[key]) continue;
      const a = String(now[key]), b = String(expected[key]);
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      assert.fail(`${label}: main's ${key} changed. first difference at ${i}
  before: ...${b.slice(Math.max(0, i - 60), i + 120)}
  after:  ...${a.slice(Math.max(0, i - 60), i + 120)}`);
    }
  };

  // B の実例（画面に付けない DOM）を作る。hooks は、主の画面に触れない最小の作りもの（未知の hooks は何もしない）
  await page.evaluate(async () => {
    const { createConversationView } = await import('/conversation-view.mjs');
    const mk = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
    const who = (name) => { const w = mk('div', 'who'); const s = mk('span', 'name'); s.textContent = name; w.append(s, mk('span', 'when')); return w; };
    const log = mk('div', 'log'), thread = mk('div', 'thread'), frame = mk('div', 'frame');
    log.style.cssText = 'height:200px;overflow:auto';
    log.append(thread); frame.append(log);
    const detached = mk('div'); detached.append(frame);   // document に付けない
    const explicit = {
      userMsg: (text, opts = {}) => { const m = mk('div', 'm user'); m.dataset.role = 'user'; if (opts.at) m.dataset.at = opts.at; m.append(who('あなた')); const b = mk('div', 'body'); b.textContent = text; m.append(b); return m; },
      aiMsg: (opts = {}) => { const m = mk('div', 'm ai' + (opts.cont ? ' cont' : '')); m.dataset.role = 'assistant'; if (opts.at) m.dataset.at = opts.at; m.append(who('AI')); return m; },
      spine: () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'spine'); return s; },
      userRaw: (m) => m.querySelector('.body')?.textContent ?? '',
      paintUser: (m, text) => { const b = m.querySelector('.body'); if (b) b.textContent = text; },
      hhmm: () => '00:00',
      outbox: () => [], isEditing: () => false, isBusy: () => false, isLoadingSession: () => false, currentSession: () => 'not-this-one',
      isRunning: () => false, stopping: () => false, behind: () => false, backgroundCounts: () => ({}), turnStart: () => 0,
      activeBackendId: () => 'fake', subagentToolsOf: () => new Set(), isBoundaryTool: () => false, backendVocab: () => null,
      systemHistoryNode: () => undefined, paintable: (p) => p, batchPaint: (fn) => fn(),
      turnFailedRow: () => mk('div', 'm turn-failed'),
      // 値で渡すもの（子の会話は主だけの仕事を持たない: 声の配送は無し・仮の添付は自分の入れ物）
      voiceDelivery: null, provisionalByMessage: new Map(),
    };
    const hooks = new Proxy(explicit, { get: (own, key) => key in own ? own[key] : () => undefined });
    const view = createConversationView({ sessionId: 'other-B', log, thread, frame, role: 'child', hooks });
    window.__otherView = { view, log, thread, detached };
  });
  const otherSnapshot = () => page.evaluate(() => ({ thread: window.__otherView.thread.outerHTML, rows: window.__otherView.thread.querySelectorAll('.mw').length }));

  // ---------------------------------------------------------------- 1. B の実例を動かしても、主は変わらない
  const before = await settled('main settles before B is touched');
  assert.ok(before.rows > 20, `main shows A's history (${before.rows} rows)`);
  assert.ok(before.thread.includes('Aの履歴') && !before.thread.includes('Bの履歴'), 'main shows only A');
  const dataB = await rig.client.cmd('loadSession', { sessionId: B });
  assert.ok(dataB.messages.length >= 40, `B's history was read (${dataB.messages.length} messages)`);
  const painted = await page.evaluate(async (data) => {
    const { view } = window.__otherView;
    view.adopt(data);
    const res = await view.paint(data, { id: 'other-B', load: null, quiet: false });
    view.finish(res, { quiet: false });
    return { ok: !!res, sessionId: view.sessionId };
  }, dataB);
  assert.equal(painted.ok, true, 'B history was painted into the other instance');
  assert.equal(painted.sessionId, 'other-B', "the instance answers with its own conversation, not main's");
  // 長い会話は末尾を先に描き、手前は idle に足す。足し終えてから数える
  await waitUntil(() => page.evaluate(() => !window.__otherView.view.historyPane.backfill), 'the other instance finished its backfill', 15_000, 50);
  const afterPaint = await otherSnapshot();
  assert.ok(afterPaint.rows > 20, `the other instance has B's rows (${afterPaint.rows})`);
  assert.ok(afterPaint.thread.includes('Bの履歴 39') && !afterPaint.thread.includes('Aの履歴'), 'the other instance shows only B');
  await sameMain(before, "painting B's history did not change main");

  // B へ出来事を流す（人の発言・本文の流れ・ツール・稼働表示・ターンの終わり・追加の指示）
  const streamed = await page.evaluate(() => {
    const { view } = window.__otherView;
    const at = new Date().toISOString();
    const events = [
      { type: 'userMessage', messageId: 'b-m1', text: 'Bへの追加の質問', at, pending: false },
      { type: 'activity', state: 'running' },
      { type: 'text.delta', text: 'Bの流れ ' }, { type: 'text.delta', text: 'の続き' }, { type: 'text.end', uuid: 'b-u1' },
      { type: 'tool.start', id: 'b-t1', name: 'Bash', input: { command: 'echo Bのツール' }, at },
      { type: 'tool.result', id: 'b-t1', text: 'Bのツールの結果', at },
      { type: 'text.delta', text: 'Bの 2 つ目の発言' }, { type: 'text.end', uuid: 'b-u2' },
      { type: 'activity', state: 'idle' },
      { type: 'turnResult', outcome: 'ok', at },
      { type: 'turnEnd', sessionId: 'other-B' },
    ];
    for (const ev of events) view.apply(ev, false);
    view.liveTurn.flushStream?.();
    return window.__otherView.thread.textContent;
  });
  for (const word of ['Bへの追加の質問', 'Bの流れ の続き', 'Bのツールの結果', 'Bの 2 つ目の発言']) assert.ok(streamed.includes(word), `the other instance rendered: ${word}`);
  await sameMain(before, 'streaming events into B did not change main (thread, current conversation, title, scroll, composer)');
  const afterStream = await otherSnapshot();
  assert.ok(afterStream.rows > afterPaint.rows, `B grew by its own events (${afterPaint.rows} -> ${afterStream.rows})`);
  console.log(`PASS: painting and streaming into another conversation's instance leaves main unchanged (main ${before.rows} rows, B ${afterStream.rows} rows)`);

  // ---------------------------------------------------------------- 2. 逆: 主の会話が伸びても、B の実例は変わらない
  // B 自身の後始末（ツールの塊の描き込み・高さの確定）が済んでから写す。主の動きと取り違えない
  let otherBefore = null;
  await waitUntil(async () => {
    const a = JSON.stringify(await otherSnapshot()); await new Promise(r => setTimeout(r, 300));
    const b = JSON.stringify(await otherSnapshot());
    otherBefore = JSON.parse(b);
    return a === b;
  }, 'the other instance settles', 20_000, 50);
  await runScript(rig, A, writeScript(rig.base, 'a-tail', tailScript({ rounds: 4, tag: 'Aの末尾' })));
  await waitUntil(() => page.evaluate(() => document.getElementById('thread').textContent.includes('Aの末尾 3')), 'main shows the new tail of A', 30_000);
  const mainAfter = await mainSnapshot();
  assert.ok(mainAfter.rows > before.rows, `main grew by A's own turn (${before.rows} -> ${mainAfter.rows})`);
  assert.equal(mainAfter.current, before.current, 'main still shows A');
  assert.ok(!mainAfter.thread.includes('Bの'), 'no row of B leaked into main');
  assert.deepEqual(await otherSnapshot(), otherBefore, "main's streaming did not change B's instance");
  assert.ok(!otherBefore.thread.includes('Aの末尾'), "A's tail is not in B");
  console.log(`PASS: main streaming A's turn leaves B's instance unchanged (main ${before.rows} -> ${mainAfter.rows} rows)`);

  assert.deepEqual(rig.pageErrors, [], `no page errors: ${rig.pageErrors.join(' / ')}`);
  console.log('PASS: conversation-view-independence');
} finally {
  await rig.close();
}
