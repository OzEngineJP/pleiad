// 作業のダイアログ（モーダル）の一覧の開け閉め（実ブラウザー）:
//   一覧を畳むと左に 52px のレールが残り（開くボタンだけ）、押し出しで開閉する。会話の列は 360px を割らない。
//   右の欄を開いたとき、761〜1150px では一覧を自動で畳み、閉じるときに（自動で畳んだ分だけ）開き直す。1280px では畳まない。
//   Ctrl+B はモーダルが開いている間はモーダルの一覧だけを動かす。承認待ちの子がいる間は開くボタンに ◆。動きを減らす設定では動かない。
// 実行: node tests/browser/work-dialog-list.mjs   （会話の agent-browser の窓を使う）
//   WORK_DIALOG_LIST_SHOTS=<dir> を付けると、各幅の画面を撮る
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-list-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_LIST_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const ab = (...args) => execFileSync(process.env.AGENT_BROWSER_BIN || 'agent-browser', args, { encoding: 'utf8', timeout: 60_000 });
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, label) => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (fn()) return;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};
const STORE = 'agent-host-work-list';
let server, client;
try {
  server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  console.log(`fake server pid=${server.child.pid} port=${server.port}`);
  client = await open(server);
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('completeSetup', { backend: 'fake' });

  // ---- 準備: 親の会話と、ファイルのリンクを持つ子・承認を待つ子 ----
  const childDir = path.join(base, 'child-dir');
  fs.mkdirSync(path.join(childDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(childDir, 'docs', 'child-doc.md'), '# child doc\n\nbody of the child doc\n');
  const stepsFile = path.join(base, 'child-steps.json');
  fs.writeFileSync(stepsFile, JSON.stringify({ steps: [{ text: 'See [named doc](docs/child-doc.md) here.' }] }));
  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Work dialog list' });
  const parent = first.sessionId;
  const delegate = async (title, task, cwd) => {
    const mark = client.mark();
    // 前の子の完了通知で親のターンが始まる間は送れない。空くまで待って送り直す（上限つき）
    for (let tries = 0; ; tries++) {
      try {
        await client.cmd('runTurn', { sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title, task, ...(cwd ? { cwd } : {}) } }) });
        break;
      } catch (error) {
        if (tries >= 80) throw error;
        await sleep(250);
      }
    }
    const res = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
    return JSON.parse(res.text).taskId;
  };
  const filesTask = await delegate('files', `steps:@${stepsFile}`, childDir);
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId !== parent, { ms: 30_000 });
  await sleep(500);

  // ---- 画面の道具 ----
  const geo = () => evaluate(() => {
    const box = n => { if (!n) return null; const q = n.getBoundingClientRect(); return { x: Math.round(q.left), r: Math.round(q.right), w: Math.round(q.width), y: Math.round(q.top), h: Math.round(q.height) }; };
    const d = document.getElementById('workDialog'), fp = document.getElementById('filePreview');
    const paneIn = d.open && fp.parentElement?.id === 'workSplit' && !fp.hidden;
    const vis = id => { const n = document.getElementById(id), s = getComputedStyle(n); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01; };
    return { vw: innerWidth, open: d.open, folded: d.classList.contains('list-folded'), moving: d.classList.contains('list-moving'),
      paneOpen: d.classList.contains('file-preview-open'), paneMoving: d.classList.contains('file-preview-moving') || document.body.classList.contains('file-preview-moving'),
      dialog: box(d), side: box(document.getElementById('workSide')), detail: box(d.querySelector('.work-detail')), pane: paneIn ? box(fp) : null,
      openBtn: { ...box(document.getElementById('workOpenList')), visible: vis('workOpenList') }, closeBtn: { ...box(document.getElementById('workCloseList')), visible: vis('workCloseList') },
      focus: document.activeElement?.id || document.activeElement?.tagName || '', stored: localStorage.getItem('agent-host-work-list'),
      mainSideClosed: document.documentElement.classList.contains('side-closed') };
  });
  const settle = async label => {
    await wait(() => evaluate(() => { const d = document.getElementById('workDialog'); return !d.classList.contains('list-moving') && !d.classList.contains('file-preview-moving') && !document.body.classList.contains('file-preview-moving'); }), `settled: ${label}`);
    await sleep(120);
    return geo();
  };
  const clickOn = (sel, label) => {
    const ok = evaluate(s => { const n = document.querySelector(s); if (!n) return false; n.dataset.probe = 'pick'; n.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; }, sel);
    assert.ok(ok, `target exists: ${label}`);
    ab('click', '[data-probe="pick"]');
    evaluate(() => document.querySelector('[data-probe="pick"]')?.removeAttribute('data-probe'));
  };
  const closeDialog = async () => {
    evaluate(() => document.getElementById('workDialog').close());
    await wait(() => evaluate(() => !document.getElementById('workDialog').open), 'dialog closed');
  };
  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  const reload = async (vw, { store = 'open' } = {}) => {
    ab('set', 'viewport', String(vw), '800');
    ab('open', pageUrl);
    await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]') || !!document.querySelector('.tc-go')), `page at ${vw}`);
    evaluate(({ k, v }) => { document.getElementById('onboardingDialog')?.close(); if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); }, { k: STORE, v: store === 'open' ? '' : store });
  };
  const openChild = async label => {
    evaluate(id => { if (!document.querySelector('.tc-go')) document.querySelector(`#groups .row[data-session="${id}"]`)?.click(); }, parent);
    await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 1), `cards ${label}`);
    for (let tries = 0; ; tries++) {
      await sleep(500);
      clickOn(`.tc[data-tool$="ply_delegate"][data-task-id="${filesTask}"] .tc-go`, `card ${label}`);
      const until = Date.now() + 4000;
      const isOpen = () => evaluate(id => document.getElementById('workDialog').open && !!document.getElementById('workBody').dataset.sessionId && !!document.querySelector(`#workList [data-key="t:${id}"][aria-current="true"]`), filesTask);
      while (Date.now() < until && !isOpen()) await sleep(150);
      if (isOpen()) break;
      assert.ok(tries < 3, `dialog opens: ${label}`);
    }
    await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="docs/child-doc.md"]')), `link ${label}`);
    return settle(`open ${label}`);
  };
  const openPane = async label => {
    clickOn('#workBody a.file-link[data-file-path="docs/child-doc.md"]', `link ${label}`);
    await wait(() => evaluate(() => { const fp = document.getElementById('filePreview'); return fp.parentElement?.id === 'workSplit' && !fp.hidden && fp.textContent.includes('child-doc.md'); }), `pane ${label}`);
    return settle(`pane ${label}`);
  };
  const closePane = async label => {
    const closed = () => evaluate(() => document.getElementById('filePreview').hidden || !document.getElementById('workDialog').classList.contains('file-preview-open'));
    for (let tries = 0; tries < 5 && !closed(); tries++) {
      ab('press', 'Escape');
      const until = Date.now() + 3000;
      while (Date.now() < until && !closed()) await sleep(100);
    }
    assert.ok(closed(), `pane closed: ${label}`);
    return settle(`pane closed ${label}`);
  };
  // 動いている間の全フレームの位置を記録する（重なり・はみ出しを測る）
  const record = async (action, label) => {
    evaluate(() => {
      window.__frames = []; window.__rec = true;
      const loop = () => {
        const d = document.getElementById('workDialog'), fp = document.getElementById('filePreview');
        const r = n => { const q = n.getBoundingClientRect(); return [Math.round(q.left), Math.round(q.right)]; };
        const sideNode = document.getElementById('workSide'), close = document.getElementById('workCloseList'), title = document.getElementById('workTitle');
        const cs = getComputedStyle(close);
        const tq = title.getBoundingClientRect(), cq = close.getBoundingClientRect();
        const closeShown = cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
        window.__frames.push({ side: r(sideNode), detail: r(d.querySelector('.work-detail')),
          pane: fp.parentElement?.id === 'workSplit' && !fp.hidden ? r(fp) : null, dialog: r(d),
          sidePos: getComputedStyle(sideNode).position, listPos: getComputedStyle(document.getElementById('workList')).position,
          title: [Math.round(tq.left),Math.round(tq.right),Math.round(tq.top),Math.round(tq.bottom)], closeAt: [Math.round(cq.left),Math.round(cq.right),Math.round(cq.top),Math.round(cq.bottom)], closeShown, closeOverTitle: closeShown && cq.left < tq.right && cq.right > tq.left && cq.top < tq.bottom && cq.bottom > tq.top, moving: d.classList.contains('list-moving') });
        if (window.__rec) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await action();
    await settle(label);
    evaluate(() => { window.__rec = false; });
    await sleep(60);
    return evaluate(() => window.__frames);
  };
  const shot = name => { if (shots) ab('screenshot', path.join(shots, `${name}.png`)); };
  const paneLoaded = async () => {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const ok = evaluate(() => { const f = document.querySelector('#filePreview iframe'); try { return !!f && f.contentDocument?.readyState === 'complete' && (f.contentDocument.body?.innerText || '').trim().length > 0; } catch { return true; } });
      if (ok) break;
      await sleep(150);
    }
    await sleep(200);
  };

  // ======== 1. 1280px: 一覧の開け閉め（押し出し・重なりなし・フォーカス・保存） ========
  await reload(1280);
  let g = await openChild('1280');
  assert.equal(g.folded, false, 'the list is open by default');
  assert.equal(g.side.w, 320, `list column is 320px: ${g.side.w}`);
  assert.equal(g.closeBtn.visible, true, 'close button visible when open');
  assert.equal(g.openBtn.visible, false, 'open button hidden when open');
  assert.ok(g.detail.w >= 360, `conversation >= 360: ${g.detail.w}`);
  const name = id => evaluate(i => ({ label: document.getElementById(i).getAttribute('aria-label'), title: document.getElementById(i).title, keys: document.getElementById(i).getAttribute('aria-keyshortcuts') }), id);
  assert.equal((await name('workCloseList')).label, '一覧を閉じる');
  assert.match((await name('workCloseList')).title, /一覧を閉じる.*B/);
  assert.equal((await name('workOpenList')).label, '一覧を開く');
  assert.match((await name('workOpenList')).title, /一覧を開く.*B/);

  let frames = await record(() => ab('click', '#workCloseList'), 'close list');
  g = await geo();
  assert.equal(g.folded, true);
  assert.equal(g.side.w, 52, `folded column is the 52px rail: ${g.side.w}`);
  assert.equal(g.openBtn.visible, true, 'open button visible when folded');
  assert.equal(g.closeBtn.visible, false, 'close button hidden when folded');
  assert.equal(g.focus, 'workOpenList', 'focus moves to the opposite button');
  assert.equal(g.stored, 'folded', 'folded state is saved');
  assert.ok(frames.length >= 4, `the push is animated: ${frames.length} frames`);
  assert.ok(frames.some(f => f.side[1] - f.side[0] > 52 && f.side[1] - f.side[0] < 320), 'intermediate widths exist (push, not jump)');
  const checkFrames = (list, what) => {
    for (const f of list) {
      assert.ok(f.side[1] <= f.detail[0] + 1, `${what}: list does not overlap the conversation ${JSON.stringify(f)}`);
      if (f.pane) assert.ok(f.detail[1] <= f.pane[0] + 1, `${what}: conversation does not overlap the pane ${JSON.stringify(f)}`);
      assert.ok(!['absolute', 'fixed'].includes(f.sidePos) && !['absolute', 'fixed'].includes(f.listPos), `${what}: list is in the flow (no overlay) ${f.sidePos}/${f.listPos}`);
      assert.equal(f.closeOverTitle, false, `${what}: close button never overlaps the title ${JSON.stringify(f)}`);
    }
  };
  checkFrames(frames, 'closing');
  shot('closed-1280');

  frames = await record(() => ab('click', '#workOpenList'), 'open list');
  g = await geo();
  assert.equal(g.folded, false);
  assert.equal(g.side.w, 320);
  assert.equal(g.focus, 'workCloseList', 'focus moves to the close button');
  assert.equal(g.stored, 'open');
  assert.ok(frames.some(f => f.side[1] - f.side[0] > 52 && f.side[1] - f.side[0] < 320), 'intermediate widths while opening');
  checkFrames(frames, 'opening');

  // ======== 2. Ctrl+B: モーダルが開いている間はモーダルの一覧だけ ========
  const mainBefore = g.mainSideClosed;
  ab('press', 'Control+b');
  g = await settle('ctrl+b fold');
  assert.equal(g.folded, true, 'Ctrl+B folds the modal list');
  assert.equal(g.mainSideClosed, mainBefore, 'main side panel is untouched by Ctrl+B in the modal');
  ab('press', 'Control+b');
  g = await settle('ctrl+b open');
  assert.equal(g.folded, false, 'Ctrl+B opens the modal list');
  assert.equal(g.mainSideClosed, mainBefore);
  console.log('PASS: list close/open (push, no overlap, focus, saved) and Ctrl+B affects only the modal');

  // ======== 3. 閉じて開き直しても、畳んだ状態を覚えている ========
  ab('click', '#workCloseList');
  await settle('fold before reopen');
  await closeDialog();
  assert.equal(evaluate(() => localStorage.getItem('agent-host-work-list')), 'folded');
  g = await openChild('reopen folded');
  assert.equal(g.folded, true, 'folded state survives closing the dialog');
  assert.equal(g.side.w, 52);
  // 閉じたダイアログの後、Ctrl+B はメインの脇を動かす
  await closeDialog();
  const sideBefore = (await geo()).mainSideClosed;
  ab('press', 'Control+b');
  await sleep(500);
  assert.equal((await geo()).mainSideClosed, !sideBefore, 'Ctrl+B moves main side panel when the dialog is closed');
  ab('press', 'Control+b');
  await sleep(500);
  assert.equal((await geo()).mainSideClosed, sideBefore);
  console.log('PASS: folded state is saved across the dialog; main side panel still follows Ctrl+B');

  // ======== 4. 右の欄 × 幅: 自動で畳む範囲・会話の幅・欄を閉じたときの開き直し ========
  // 1280・1151 は畳まない（3 列）。1150〜761 は畳む。760 以下は欄が全面（一覧と会話の 2 列は残る）
  const widths = [1280, 1151, 1150, 1100, 1040, 900, 761, 760, 720, 701];
  const table = [];
  for (const vw of widths) {
    await reload(vw);
    const closedGeo = await openChild(`w${vw}`);
    assert.ok(closedGeo.detail.w >= 360, `${vw}px: conversation >= 360 with only the list: ${closedGeo.detail.w}`);
    assert.equal(closedGeo.folded, false);
    g = await openPane(`w${vw}`);
    const auto = vw >= 761 && vw <= 1150;
    assert.equal(g.folded, auto, `${vw}px: auto-fold ${auto}`);
    assert.equal(g.side.w, auto ? 52 : 320, `${vw}px: list column width`);
    assert.ok(g.detail.w >= 360, `${vw}px: conversation >= 360 with the pane: ${g.detail.w}`);
    assert.ok(g.pane, `${vw}px: pane is in the dialog`);
    assert.ok(g.pane.r <= g.dialog.r + 1 && g.dialog.r <= g.vw + 1, `${vw}px: nothing is cut off ${JSON.stringify(g)}`);
    if (vw <= 760) assert.ok(g.pane.w >= g.dialog.w - 2, `${vw}px: the pane covers the dialog`);
    else assert.ok(g.detail.r <= g.pane.x + 1, `${vw}px: the pane sits beside the conversation`);
    if (vw === 1280) { assert.ok(g.dialog.w > 1200 && g.dialog.w <= 1230, `1280px: dialog widens to the pane: ${g.dialog.w}`); assert.equal(g.openBtn.visible, false); }
    if (auto) { assert.equal(g.openBtn.visible, true, `${vw}px: the rail's open button shows`); assert.equal(g.stored, null, `${vw}px: an auto fold is not saved`); }
    table.push(`${vw}: list-only conv=${closedGeo.detail.w}, pane open folded=${g.folded} conv=${g.detail.w} pane=${g.pane.w} dialog=${g.dialog.w}`);
    if (vw === 1280) { await paneLoaded(); shot('3pane-1280'); }
    if (vw === 1100) { await paneLoaded(); shot('pane-1100'); }
    if (vw === 900) { await paneLoaded(); shot('pane-900'); }
    if (vw === 760) { await paneLoaded(); shot('pane-760'); }
    g = await closePane(`w${vw}`);
    assert.equal(g.folded, false, `${vw}px: the list is open again after the pane closes (only an auto fold is undone)`);
    assert.equal(g.side.w, 320);
  }
  console.log('widths:\n  ' + table.join('\n  '));
  console.log('PASS: conversation >= 360px at 701..1280, auto-fold only at 761..1150, list re-opens when the pane closes');

  // ======== 5. 自動で畳んだ後に一覧を開く: 3 列。会話は 360px を割らず、欄が縮む（1000px では欄の目安が余るので、会話がちょうど 360px） ========
  for (const vw of [1100, 1000]) {
    await reload(vw);
    await openChild(`${vw} user opens`);
    const paneIn = await openPane(`${vw} user opens`);
    assert.equal(paneIn.folded, true);
    const widthBefore = paneIn.pane.w;
    await record(() => ab('click', '#workOpenList'), `user opens after auto fold ${vw}`);
    g = await geo();
    assert.equal(g.folded, false, `${vw}px: opening after an auto fold gives 3 columns`);
    assert.equal(g.side.w, 320);
    assert.ok(g.detail.w >= 360, `${vw}px: conversation holds at 360px or more: ${JSON.stringify(g)}`);
    if (vw === 1000) assert.ok(g.detail.w <= 362, `1000px: the pane gives way until the conversation is exactly 360px: ${JSON.stringify(g)}`);
    assert.ok(g.pane.w < widthBefore, `${vw}px: the pane shrinks (${widthBefore} -> ${g.pane.w})`);
    assert.ok(g.pane.r <= g.dialog.r + 1, `${vw}px: the pane stays inside the dialog`);
    assert.equal(g.stored, 'open', 'the user choice is saved');
    shot(`3pane-${vw}-opened`);
    g = await closePane(`${vw} user opens`);
    assert.equal(g.folded, false, 'the list stays open (the user chose it)');
    // 利用者が畳んだ状態は、欄の開閉で変えない
    ab('click', '#workCloseList');
    await settle('user folds');
    await openPane(`${vw} user folded`);
    g = await closePane(`${vw} user folded`);
    assert.equal(g.folded, true, 'a list the user folded is not re-opened when the pane closes');
    assert.equal(g.stored, 'folded');
  }
  console.log('PASS: after an auto fold the list pushes open to 3 columns (conversation >= 360, pane shrinks); a user fold stays');

  // ======== 6. 承認待ちの子がいる間だけ、開くボタンに ◆ ========
  const asker = await delegate('asker', 'ask-slow');
  await wait(() => evaluate(() => !!document.querySelector('#workList [data-key]') && document.querySelectorAll('#workList [data-key]').length >= 2), 'asker in the list');
  await wait(() => evaluate(() => !!document.querySelector('#workOpenList .side-mark[data-kind="wait"]')), 'approval mark');
  const mark = evaluate(() => { const b = document.getElementById('workOpenList'); const m = b.querySelector('.side-mark'); return { text: m.textContent, count: b.querySelectorAll('.side-mark').length, label: b.getAttribute('aria-label'), content: getComputedStyle(m, '::before').content, hidden: m.getAttribute('aria-hidden') }; });
  assert.equal(mark.count, 1, 'exactly one mark');
  assert.equal(mark.text, '', 'no count in the mark');
  assert.equal(mark.label, '一覧を開く（承認待ちあり）');
  assert.match(mark.content, /◆/);
  assert.equal((await geo()).openBtn.visible, true);
  shot('closed-1100-waiting');
  // 答えると ◆ が消える
  // 答えた後にまた承認を求められることもあるので、新しく出た分を、◆ が消えるまで（上限つきで）答え続ける
  const answered = new Set();
  for (let round = 0; round < 40; round++) {
    for (const ev of client.events.filter(e => e.type === 'permission' && !answered.has(e.id))) {
      answered.add(ev.id);
      await client.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {});
    }
    if (evaluate(() => !document.querySelector('#workOpenList .side-mark'))) break;
    await sleep(250);
  }
  await wait(() => evaluate(() => !document.querySelector('#workOpenList .side-mark')), 'approval mark gone');
  assert.equal((await name('workOpenList')).label, '一覧を開く');
  console.log('PASS: one ◆ on the open button while a child awaits approval; name follows; gone after answering');
  await client.runTurn({ sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_task_cancel', arguments: { taskId: asker } }) }).catch(() => {});

  // ======== 7. 動きを減らす設定: 動かない（途中の幅も、動きのクラスも出ない） ========
  ab('set', 'media', 'light', 'reduced-motion');
  await reload(1280, { store: 'open' });
  ab('set', 'media', 'light', 'reduced-motion');
  await openChild('reduced');
  assert.equal(evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true, 'reduced motion is emulated');
  const reduced = await record(() => ab('click', '#workCloseList'), 'reduced fold');
  g = await geo();
  assert.equal(g.folded, true);
  assert.ok(reduced.every(f => !f.moving), 'no list-moving class under reduced motion');
  assert.ok(reduced.every(f => { const w = f.side[1] - f.side[0]; return w === 52 || w === 320; }), `no intermediate widths under reduced motion: ${[...new Set(reduced.map(f => f.side[1] - f.side[0]))]}`);
  const reducedOpen = await record(() => ab('click', '#workOpenList'), 'reduced open');
  assert.ok(reducedOpen.every(f => { const w = f.side[1] - f.side[0]; return w === 52 || w === 320; }), 'no intermediate widths when opening either');
  console.log('PASS: reduced motion — the list jumps with no intermediate frames');
  ab('set', 'media', 'light');

  // ======== 8. 暗い配色の撮影 ========
  if (shots) {
    ab('set', 'media', 'dark');
    await reload(1280, { store: 'open' });
    ab('set', 'media', 'dark');
    await openChild('dark');
    await openPane('dark');
    await paneLoaded();
    shot('dark-3pane-1280');
    ab('click', '#workCloseList');
    await settle('dark fold');
    shot('dark-closed-1280');
    ab('set', 'media', 'light');
  }

  // ======== 9. 360px: 3 段のまま（開閉ボタンは出ない） ========
  await reload(360);
  g = await openChild('360');
  assert.equal(g.openBtn.visible, false, '360px: no open button (3 steps)');
  assert.equal(g.closeBtn.visible, false, '360px: no close button');
  shot('narrow-360');
  await closeDialog();
  ab('set', 'viewport', '1280', '800');
  console.log('PASS: 360px keeps the three steps with no list toggle');
} finally {
  try { ab('set', 'media', 'light'); } catch { /* 窓が無ければそのまま */ }
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
