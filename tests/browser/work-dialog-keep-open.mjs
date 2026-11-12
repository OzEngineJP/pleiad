// 作業のダイアログ（#workDialog）で走っている子の詳細が、出来事に合わせて読み直される（ADR 0315 の段 2。web/detail-follow.mjs）。実ブラウザー。
//   1. 子が承認を待っている: 承認のカード・一覧の「承認待ち」・見出しの経過が、待った状態で出る
//   2. 承認を押す: カードがすぐ消え、子の続き（ツールの行）が 1 秒ほどで増える（従来は running の配信ごと = 数秒おきの読み直しだった）
//   3. 流れている間の読み直しで、開いたまとまり・ツールの詳細・読んでいる位置・フォーカスが変わらない（ここでは読み直しを何度も数える）
//   4. 文字を選んでいる間は読み直さず、選びを解くと続きを読む
//   5. 次の承認のカードも出来事からすぐ出て、押せばすぐ消える
//   6. 別の子へ切り替えた・ダイアログを閉じたあとは、前の子の出来事（承認を含む）で読み直さない
//   7. 再接続のあとは読み直す。メインの会話の流れは変わらない
//   旧 work-dialog-keep-open.cjs が落ちていた理由: 子の台本が最後に無言の `sleep 600` で終わり、出来事も running の配信も来ないので、
//   「筋が作り直される」のを 15 秒待って timeout した（running の配信は、中身が変わらないと送らなくなった = 7d0ef930 より前に書いた試験だった）
// 実行: node tests/browser/work-dialog-keep-open.mjs   （会話の agent-browser の窓を使う。WORK_DIALOG_KEEP_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-keep-open-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_KEEP_SHOTS;
const ab = (...args) => execFileSync(process.env.AGENT_BROWSER_BIN || 'agent-browser', args, { encoding: 'utf8', timeout: 60_000 });
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, label, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await sleep(120);
  }
  throw new Error(`timeout: ${label}`);
};
let server, client;
try {
  server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  console.log(`fake server pid=${server.child.pid} port=${server.port}`);
  // 子の承認は画面で押す。委譲そのもの（ply_delegate）の承認だけ、ここで通す
  client = await open({
    ...server,
    onEvent: (ev, api) => {
      if (ev.type === 'permission' && /ply_delegate$/.test(ev.toolName ?? '')) api.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {});
    },
  });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('completeSetup', { backend: 'fake' });

  // 子の台本: 6 手（1 つのまとまりになる）→ 承認 1 → 流れる 60 手 → 承認 2 → 流れる 40 手 → 承認 3 → 終わり
  const stream = (label, n, ms) => Array.from({ length: n }, (_, i) => ({ tool: 'Bash', input: { command: `${label} ${i}` }, result: `out ${label} ${i}`, ms }));
  const script = { steps: [
    { tool: 'Read', input: { file_path: 'D:/x/a.mjs' }, result: '1\ta', ms: 50 },
    { tool: 'Grep', input: { pattern: 'foo' }, result: 'No matches found', ms: 50 },
    { tool: 'Bash', input: { command: 'node a.mjs' }, result: 'hello from a', ms: 50 },
    { text: 'ここまで調べました。' },
    { tool: 'Read', input: { file_path: 'D:/x/b.mjs' }, result: '1\tb', ms: 50 },
    { tool: 'Bash', input: { command: 'node b.mjs' }, result: 'hello from b', ms: 50 },
    { tool: 'Edit', input: { file_path: 'D:/x/gate1.txt' }, result: 'edited', ms: 50, ask: true },
    ...stream('stream-b', 60, 250),
    { tool: 'Write', input: { file_path: 'D:/x/gate2.txt' }, result: 'written', ms: 50, ask: true },
    ...stream('stream-c', 40, 250),
    { tool: 'Write', input: { file_path: 'D:/x/gate3.txt' }, result: 'written', ms: 50, ask: true },
    { text: 'おわり。' },
  ] };
  const otherScript = { steps: [{ text: 'もう一つの子です。' }] };
  // 台本はファイルで渡す（依頼の欄に台本の JSON が長く出ない）
  const scriptFile = path.join(base, 'child-steps.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script));

  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Keep open' });
  const parent = first.sessionId;
  const delegate = async (title, task, until) => {
    const mark = client.mark();
    for (let tries = 0; ; tries++) {
      try {
        await client.cmd('runTurn', { sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title, task } }) });
        break;
      } catch (error) {
        if (tries >= 80) throw error;
        await sleep(250);
      }
    }
    const res = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
    const hit = await client.waitFor(until, { from: mark, ms: 30_000 });
    return { taskId: JSON.parse(res.text).taskId, childId: hit.sessionId };
  };
  const other = await delegate('もう一つの子', 'steps:' + JSON.stringify(otherScript), e => e.type === 'turnEnd' && e.sessionId !== parent);
  const child = await delegate('長い子', `steps:@${scriptFile}`, e => e.type === 'permission' && e.sessionId !== parent && e.sessionId !== other.childId && e.toolName === 'Edit');
  console.log(`parent=${parent} child=${child.childId} other=${other.childId}`);
  await sleep(800);

  // CHILD_THREAD=reread: 子の本文を従来の読み直しで描く（ADR 0319 段 6-6 の切り替え）。既定は子の役の実例（live）
  const live = process.env.CHILD_THREAD !== 'reread';
  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}${live ? '' : '&childThread=reread'}`;
  // まとまりの件数: live は発言ごとに切れる（メインと同じ。台本の最初のまとまりは 3 件）、reread は発言をまたいで 6 件
  const BUNDLE = live ? 3 : 6;
  ab('set', 'viewport', '1280', '520');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 2), 'delegate cards');

  // 印を付けてから押すまでに一覧・カードが描き直されると、印ごと要素が消える。末尾へ付いていく追従（メインと同じ 320ms の合わせ直し）が押す点を動かすと、見出しが覆う。
  // どちらも付け直して押す（押した後で起きたのではない）
  const clickOn = (sel, label) => {
    for (let tries = 0; ; tries++) {
      const ok = evaluate(s => { const n = document.querySelector(s); if (!n) return false; n.dataset.probe = 'pick'; n.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; }, sel);
      assert.ok(ok, `target exists: ${label}`);
      try { ab('click', '[data-probe="pick"]'); return; }
      catch (e) { if (tries >= 12 || !/Element not found|is covered by/.test(String(e?.message))) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); }
      finally { evaluate(() => document.querySelector('[data-probe="pick"]')?.removeAttribute('data-probe')); }
    }
  };
  // 押した結果が出なければ、もう一度押す（描き直しの最中に押すと、押しが新しい要素に届かないことがある）。結果を待つ間は押し直さない
  const clickUntil = async (sel, label, done) => {
    for (let tries = 0; ; tries++) {
      clickOn(sel, label);
      const until = Date.now() + 1500;
      while (Date.now() < until && !done()) await sleep(100);
      if (done()) return;
      assert.ok(tries < 2, `${label}: no effect after ${tries + 1} clicks`);
    }
  };
  const dialogOpen = () => evaluate(() => document.getElementById('workDialog').open);
  const openCard = async (taskId, label) => {
    const isOpen = () => evaluate(id => document.getElementById('workDialog').open && !!document.getElementById('workBody').dataset.sessionId && !!document.querySelector(`#workList [data-key="t:${id}"][aria-current="true"]`), taskId);
    for (let tries = 0; ; tries++) {
      await sleep(700);
      // 座標では押さない: 子の承認のカードがメインの会話にも出て、押す直前に高さが変わると、メインの［拒否］が当たる（子の承認が拒否されて台本がずれる）
      const hit = evaluate(id => { const n = document.querySelector(`.tc[data-tool$="ply_delegate"][data-task-id="${id}"] .tc-go`); if (!n) return false; n.click(); return true; }, taskId);
      assert.ok(hit, `target exists: card ${label}`);
      const until = Date.now() + 4000;
      while (Date.now() < until && !isOpen()) await sleep(150);
      if (isOpen()) return;
      assert.ok(tries < 3, `dialog for ${label}`);
    }
  };
  const closeDialog = async () => {
    evaluate(() => document.getElementById('workDialog').close());
    await wait(() => !dialogOpen(), 'dialog closed');
  };
  const selectRow = async (key, label) => {
    clickOn(`#workList [data-key="${key}"]`, `row ${label}`);
    await wait(() => evaluate(k => document.querySelector(`#workList [data-key="${k}"]`)?.getAttribute('aria-current') === 'true', key), `row selected: ${label}`);
  };

  // 画面の中で時刻を採る（ab の往復の遅れを入れないため）: 送ったコマンド・届いた承認・承認のカードの出入り・一覧の「承認待ち」・ツールの行の数
  evaluate(() => {
    const t0 = performance.now();
    const log = window.__log = { cmds: [], perm: [], settled: [], card: [], waitRow: [], tcs: [], clicks: [] };
    const now = () => Math.round(performance.now() - t0);
    window.__now = now;
    const watched = new WeakSet();
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const m = JSON.parse(data); if (m.command) log.cmds.push({ t: now(), command: m.command, sessionId: m.args?.sessionId ?? null, slot: m.args?.slot ?? null }); } catch { /* 文字でないフレーム */ }
      window.__ws = this;
      if (!watched.has(this)) {
        watched.add(this);
        this.addEventListener('message', (e) => {
          try {
            const m = JSON.parse(e.data);
            if (m.kind !== 'event') return;
            if (m.event.type === 'permission') log.perm.push({ t: now(), id: m.event.id, tool: m.event.toolName, sessionId: m.event.sessionId });
            if (m.event.type === 'permissionSettled') log.settled.push({ t: now(), id: m.event.id });
          } catch { /* 文字でないフレーム */ }
        });
      }
      return send.call(this, data);
    };
    document.addEventListener('click', () => log.clicks.push(now()), true);
    let card = false, waitRow = false, tcs = -1;
    const note = () => {
      const c = !!document.querySelector('#workBody :is(.mw[data-key^="perm:"], .tc-appr)');
      if (c !== card) { card = c; log.card.push({ t: now(), shown: c }); }
      const w = !!document.querySelector('#workList .bg-waiting');
      if (w !== waitRow) { waitRow = w; log.waitRow.push({ t: now(), shown: w }); }
      const n = document.querySelectorAll('#workBody .bg-thread .tc').length;
      if (n !== tcs) { tcs = n; log.tcs.push({ t: now(), n }); }
    };
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true });
  });
  const log = () => evaluate(() => window.__log);
  const rereads = (sid, from = 0) => evaluate(([id, f]) => window.__log.cmds.filter(c => c.command === 'loadSession' && c.sessionId === id && c.t >= f).length, [child.childId, from]);
  const nowMs = () => evaluate(() => window.__now());

  // ---- 1. 承認を待っている子を開く ----
  await openCard(child.taskId, 'child');
  await wait(() => evaluate(() => document.querySelectorAll('#workBody .bg-thread .tc').length >= 6 && !!document.querySelector('#workBody :is(.mw[data-key^="perm:"], .tc-appr)')), 'thread with approval card');
  await wait(() => evaluate(() => !!document.querySelector('#workList .bg-waiting')), 'list row says waiting');
  const head1 = evaluate(() => document.querySelector('#workHead .bg-elapsed')?.textContent ?? null);
  console.log('PASS: the waiting child shows the approval card and a "waiting" list row; elapsed =', head1);

  // 開く: まとまり（6 件）を全部開き、その中の行の詳細を開く。窓が低いので詳細の欄はスクロールする
  await clickUntil('#workBody .bg-thread .bundle .rhead', 'bundle head', () => evaluate(() => document.querySelector('#workBody .bundle .rhead').getAttribute('aria-expanded') === 'true'));
  evaluate(() => document.querySelectorAll('#workBody .bundle .tc')[2].querySelector('.tc-head').click());
  await sleep(700);   // 開く動き（240ms）が終わってから位置を置く
  const scrollable = evaluate(() => { const w = document.getElementById('workBody'); w.scrollTop = 90; return w.scrollHeight > w.clientHeight + 90 && w.scrollTop === 90; });
  assert.ok(scrollable, 'the detail body can be scrolled');
  const shape = () => evaluate((n) => {
    const b = document.querySelector('#workBody .bundle');
    return {
      expanded: b?.querySelector('.rhead')?.getAttribute('aria-expanded'),
      detail: [...(b?.querySelectorAll('.tc') ?? [])].slice(0, n).map(c => c.querySelector('.tc-details')?.open ? 1 : 0).join(''),
      top: document.getElementById('workBody').scrollTop,
    };
  }, BUNDLE);
  // 位置を置いた直後に描き直しや高さの変化で動くことがある。置き直して落ち着いた形を基準にする
  let before = shape();
  for (let tries = 0; before.top !== 90 && tries < 5; tries++) {
    evaluate(() => { document.getElementById('workBody').scrollTop = 90; });
    await sleep(250);
    before = shape();
  }
  assert.deepEqual(before, { expanded: 'true', detail: live ? '001' : '001000', top: 90 }, 'setup');
  // 読み直し = 筋の要素が作り直されたこと
  const reread = async (label, ms = 8000) => {
    if (live) {
      // live: 筋は作り直されない。目印が残ったまま、続きの行が増える
      evaluate(() => { document.querySelector('#workBody .bg-thread').dataset.stale = '1'; window.__tc0 = document.querySelectorAll('#workBody .bg-thread .tc').length; });
      await wait(() => evaluate(() => document.querySelectorAll('#workBody .bg-thread .tc').length > window.__tc0), `grows: ${label}`, ms);
      assert.equal(evaluate(() => document.querySelector('#workBody .bg-thread')?.dataset.stale), '1', 'the thread element is not rebuilt');
      return;
    }
    evaluate(() => { document.querySelector('#workBody .bg-thread').dataset.stale = '1'; });
    await wait(() => evaluate(() => !document.querySelector('#workBody .bg-thread')?.dataset.stale), `reread: ${label}`, ms);
  };

  // ---- 2. 承認を押す: カードがすぐ消え、子の続きが 1 秒ほどで増える ----
  const tcBefore = evaluate(() => document.querySelectorAll('#workBody .bg-thread .tc').length);
  await clickUntil('#workBody :is(.mw[data-key^="perm:"], .tc-appr) .btn-primary', 'allow gate1', () => evaluate(() => !document.querySelector('#workBody :is(.mw[data-key^="perm:"], .tc-appr)')));
  const clickedAt = evaluate(() => window.__log.clicks.at(-1));
  await wait(() => evaluate(n => document.querySelectorAll('#workBody .bg-thread .tc').length >= n + 3, tcBefore), 'the thread grows after the approval', 8000);
  let L = log();
  const goneAt = L.card.find(c => !c.shown && c.t >= clickedAt)?.t;
  const grewAt = L.tcs.find(x => x.t >= clickedAt && x.n >= tcBefore + 3)?.t;
  assert.ok(goneAt !== undefined && goneAt - clickedAt <= 1000, `the approval card disappears promptly: ${goneAt - clickedAt}ms after the click`);
  assert.ok(grewAt !== undefined && grewAt - clickedAt <= 1500, `the child's next tool rows appear within 1.5s of the approval: ${grewAt - clickedAt}ms`);
  assert.ok(L.waitRow.some(x => !x.shown && x.t >= clickedAt && x.t - clickedAt <= 1500), `the list row stops saying "waiting" promptly: ${JSON.stringify(L.waitRow.filter(x => x.t >= clickedAt))}`);
  console.log(`PASS: approval card gone ${goneAt - clickedAt}ms and +3 tool rows ${grewAt - clickedAt}ms after the click`);

  // ---- 3. 流れている間: 読み直しを数え、位置・開いたまとまり・フォーカスが変わらない ----
  const streamFrom = nowMs();
  const sample = [];
  // 開いたまとまりに戻る位置を置き直す（承認のカードが消えて高さが変わった）
  // 末尾に付いて流れていた間の追従（メインと同じ。事象のたびに 320ms、フレームごとに末尾へ合わせ直す）の最中に置くと、すぐ末尾へ戻される
  // （メインも同じ。実測）。追従が動いていない間に置けば、置いたあとは末尾でないので追従は始まらず、位置は保たれる。置けるまで置き直す
  let pinned;
  for (let tries = 0; tries < 40; tries++) {
    evaluate(() => { document.getElementById('workBody').scrollTop = 90; });
    await sleep(150);
    pinned = shape();
    if (pinned.top === 90) { await sleep(450); pinned = shape(); if (pinned.top === 90) break; }
  }
  // live: 末尾に付いた追従は主と同じで、流れている間は位置を置いても末尾へ戻される。位置を保つ確かめは reread（追従が動かない）でだけ行う
  if (!live) assert.equal(pinned.top, 90, 'reading position re-set');
  const keep = (x) => (live ? { expanded: x.expanded, detail: x.detail } : x);
  evaluate(() => document.querySelector('#workBody .bundle .rhead').focus({ preventScroll: true }));
  for (let i = 0; i < 3; i++) {
    await reread(`stream ${i}`);
    sample.push(shape());
    const focusKept = evaluate(() => document.activeElement === document.querySelector('#workBody .bundle .rhead'));
    assert.deepEqual(keep(sample.at(-1)), keep(pinned), `round ${i}: still open${live ? '' : ' and at the same position'}`);
    assert.ok(focusKept, `round ${i}: the focus stays on the bundle head`);
  }
  const reads = rereads(child.childId, streamFrom);
  const spanMs = nowMs() - streamFrom;
  console.log(`PASS: ${reads} re-reads in ${spanMs}ms while streaming; open bundle/detail, position and focus kept`);
  if (live) assert.equal(reads, 0, 'live: no loadSession while streaming (the window was read once at open)');
  else {
    assert.ok(reads >= 3, 'the thread is re-read by events');
    assert.ok(reads <= Math.ceil(spanMs / 350) + 2, `re-reads are throttled (${reads} in ${spanMs}ms)`);
  }
  evaluate(() => document.activeElement?.blur?.());

  // 画面の撮影: 流れている間の 1280 と 360
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    ab('set', 'viewport', '1280', '800');
    await sleep(900);
    ab('screenshot', path.join(shots, 'keep-open-1280-streaming.png'));
    ab('set', 'viewport', '360', '780');
    await sleep(900);
    ab('screenshot', path.join(shots, 'keep-open-360-streaming.png'));
    const narrow = evaluate(() => ({ dialogOpen: document.getElementById('workDialog').open, tcs: document.querySelectorAll('#workBody .bg-thread .tc').length, overflowX: document.documentElement.scrollWidth > innerWidth }));
    console.log('360px:', JSON.stringify(narrow));
    ab('set', 'viewport', '1280', '520');
    await sleep(900);
    evaluate(() => { document.getElementById('workBody').scrollTop = 90; });
    await sleep(300);
  }

  // ---- 4. 文字を選んでいる間は読み直さず、選びを解くと続きを読む ----
  const selected = evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('#workBody .bg-thread'), NodeFilter.SHOW_TEXT);
    let node = null;
    while (walker.nextNode()) if (walker.currentNode.textContent.includes('ここまで調べました')) { node = walker.currentNode; break; }
    if (!node) return 'no-node';
    const range = document.createRange();
    range.selectNodeContents(node.parentElement);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.querySelector('#workBody .bg-thread').dataset.stale = '1';
    return sel.toString();
  });
  assert.ok(selected?.includes('ここまで調べました'), `text selected: ${selected}`);
  await sleep(1800);
  const heldState = evaluate(() => ({ stale: document.querySelector('#workBody .bg-thread')?.dataset.stale ?? null, sel: getSelection().toString() }));
  assert.equal(heldState.stale, '1', 'no re-read while text is selected');
  assert.ok(heldState.sel.includes('ここまで調べました'), 'the selection is kept');
  evaluate(() => getSelection().removeAllRanges());
  if (live) assert.equal(evaluate(() => document.querySelector('#workBody .bg-thread')?.dataset.stale), '1', 'live: the thread is never rebuilt, so the mark stays');
  else await wait(() => evaluate(() => !document.querySelector('#workBody .bg-thread')?.dataset.stale), 'the held re-read runs once the selection is gone', 5000);
  console.log('PASS: selected text is not re-read away; the held read runs after the selection is released');

  // ---- 5. 次の承認のカードも出来事からすぐ出て、押せばすぐ消える ----
  await wait(() => log().perm.some(p => p.tool === 'Write' && p.sessionId === child.childId), 'gate2 permission reached the page', 60_000);
  await wait(() => evaluate(() => !!document.querySelector('#workBody :is(.mw[data-key^="perm:"], .tc-appr)')), 'gate2 card in the dialog', 8000);
  L = log();
  const gate2Perm = L.perm.find(p => p.tool === 'Write' && p.sessionId === child.childId); // 親の側に写った同じ承認（別の id）を拾わない
  const permAt = gate2Perm.t;
  const shownAt = L.card.find(c => c.shown && c.t >= permAt - 50)?.t;
  assert.ok(shownAt !== undefined && shownAt - permAt <= 1000, `the second approval card appears promptly: ${shownAt - permAt}ms after the event`);
  assert.ok(L.waitRow.some(x => x.shown && x.t >= permAt - 50 && x.t - permAt <= 1500), 'the list row says waiting promptly');
  const head2 = evaluate(() => document.querySelector('#workHead .bg-elapsed')?.textContent ?? null);
  console.log(`PASS: second approval card ${shownAt - permAt}ms after the event; heading elapsed ${head1} -> ${head2}`);
  clickOn('#workBody :is(.mw[data-key^="perm:"], .tc-appr) .btn-primary', 'allow gate2');
  const clicked2 = evaluate(() => window.__log.clicks.at(-1));
  // 行の数では比べない（まとまりが畳まれると数が減り、前の数に追いつくまで増えないことがある）。承認 2 のあとにしか出ない stream-c の行が 2 つ出るのを待つ
  await wait(() => evaluate(() => [...document.querySelectorAll('#workBody .bg-thread .tc')].filter(n => n.textContent.includes('stream-c')).length >= 2), 'the thread grows after the second approval', 8000);
  L = log();
  const gone2 = L.card.find(c => !c.shown && c.t >= clicked2)?.t;
  assert.ok(gone2 !== undefined && gone2 - clicked2 <= 1000, `the second card disappears promptly: ${gone2 - clicked2}ms`);
  console.log(`PASS: second approval card gone ${gone2 - clicked2}ms after the click`);

  // ---- 6a. 別の子へ切り替えたら、前の子の出来事で読み直さない ----
  await selectRow(`t:${other.taskId}`, 'other child');
  await wait(() => evaluate(id => document.getElementById('workBody').dataset.sessionId === id, other.childId), 'the body shows the other child');
  await sleep(500);
  const switchedAt = nowMs();
  await sleep(2200);
  assert.equal(rereads(child.childId, switchedAt), 0, 'no re-read from the old child after switching');
  const otherReads = evaluate(([id, f]) => window.__log.cmds.filter(c => c.command === 'loadSession' && c.sessionId === id && c.t >= f).length, [other.childId, switchedAt]);
  assert.ok(otherReads <= 2, `the idle child is not hammered (${otherReads} reads in 2.2s)`);
  const watch = evaluate(() => window.__log.cmds.filter(c => c.command === 'watchSession' && c.slot === 'modal').at(-1));
  assert.equal(watch?.sessionId, other.childId, `the modal slot follows the switch: ${JSON.stringify(watch)}`);
  console.log(`PASS: after switching, 0 re-reads from the old child (${otherReads} for the new one)`);

  // ---- 6b. ダイアログを閉じたら読み直さない（次の承認が届いても） ----
  await closeDialog();
  const closedAt = nowMs();
  await wait(() => log().perm.some(p => p.tool === 'Write' && p.sessionId === child.childId && p.id !== gate2Perm.id), 'gate3 permission reached the page', 60_000);
  await sleep(1500);
  assert.equal(rereads(child.childId, closedAt), 0, 'no re-read while the dialog is closed, even for the child approval');
  const anyRead = evaluate(f => window.__log.cmds.filter(c => c.command === 'loadSession' && c.t >= f).length, closedAt);
  assert.equal(anyRead, 0, 'no detail read at all while the dialog is closed');
  console.log('PASS: no re-read while the dialog is closed (stream + approval from the old child)');

  // ---- 7. メインの会話の流れは変わらない / 再接続のあとは読み直す ----
  const mainMark = 'MAIN-STREAM-OK-1234';
  await client.runTurn({ sessionId: parent, prompt: `echo:${mainMark}` });
  await wait(() => evaluate(m => document.getElementById('messages')?.textContent.includes(m) ?? document.body.textContent.includes(m), mainMark), 'the main conversation shows its own stream', 10_000);
  if (shots) ab('screenshot', path.join(shots, 'keep-open-main-after.png'));
  console.log('PASS: the main conversation streams as before while the dialog is closed');

  const gate3 = log().perm.filter(p => p.tool === 'Write' && p.sessionId === child.childId).at(-1);
  await client.cmd('resolvePermission', { id: gate3.id, allow: true });
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === child.childId, { ms: 30_000 }).catch(() => {});
  await openCard(child.taskId, 'child again');
  await wait(() => evaluate(() => document.querySelectorAll('#workBody .bg-thread .tc').length >= 6), 'child thread again');
  const reopened = evaluate((n) => ({ expanded: document.querySelector('#workBody .bundle .rhead')?.getAttribute('aria-expanded') ?? null, detail: [...document.querySelectorAll('#workBody .bundle .tc')].slice(0, n).map(c => c.querySelector('.tc-details')?.open ? 1 : 0).join('') }), BUNDLE);
  assert.deepEqual(reopened, { expanded: 'false', detail: '0'.repeat(BUNDLE) }, 'reopening starts closed (nothing carried over)');
  await sleep(1200);
  const dropAt = nowMs();
  evaluate(() => window.__ws.close());
  await wait(() => rereads(child.childId, dropAt) >= 1, 'a re-read after reconnect', 30_000);
  assert.equal(dialogOpen(), true, 'the dialog survives the reconnect');
  console.log('PASS: reopening starts closed; after a reconnect the dialog is re-read');
  await closeDialog();
  console.log('ALL PASS');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
