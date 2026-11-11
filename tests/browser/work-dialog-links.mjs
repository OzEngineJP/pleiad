// 作業のダイアログ（モーダル）のリンク（実ブラウザー）:
//   委譲した子の会話をモーダルで開き、子の発言の中の外部リンクを押すと既定のブラウザーへ渡ることを確かめる。
//   殻の口（window.plyDesktop.openExternal）は画面の側で記録だけする身代わりにする。
//   ファイルのリンク（ADR 0315）: ダイアログを閉じずに、ダイアログの中の右の欄で子のタブとして開く。Esc は欄 → ダイアログの一段ずつ、
//   ダイアログを閉じると主の欄は親のタブで戻る。別の子（cwd も別）・サブエージェント・ホストの子・360px の幅も確かめる。
// 実行: node tests/browser/work-dialog-links.mjs   （会話の agent-browser の窓を使う）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'work-dialog-links-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.WORK_DIALOG_LINKS_SHOTS;
const ab = (...args) => execFileSync(process.env.AGENT_BROWSER_BIN || 'agent-browser', args, { encoding: 'utf8', timeout: 60_000 });
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const wait = async (fn, label) => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout: ${label}`);
};
const selector = '.tc[data-tool$="ply_delegate"]';
let server, client;
try {
  server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  console.log(`fake server pid=${server.child.pid} port=${server.port}`);
  client = await open({ ...server, autoAllow: true });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('completeSetup', { backend: 'fake' });
  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Work dialog links' });
  const parent = first.sessionId;
  const from = client.mark();
  await client.cmd('runTurn', { sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: {
    backend: 'fake', kind: 'mechanical', title: 'links', task: 'echo:See https://example.com/bare and [named](https://example.org/named) here.' } }) });
  const result = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from, ms: 30_000 });
  const { taskId } = JSON.parse(result.text);
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId !== parent, { from, ms: 30_000 });

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  ab('open', pageUrl);
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]')), 'session list');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent);
  await wait(() => evaluate(sel => !!document.querySelector(`${sel}[data-task-id] .tc-go`), selector), 'delegate card');
  evaluate(sel => document.querySelector(sel).querySelector('.tc-go').click(), selector);
  await wait(() => evaluate(() => !!document.querySelector('#workDialog[open]')), 'child dialog');
  await wait(() => evaluate(() => document.querySelectorAll('#workBody a.md-link[target="_blank"]').length >= 2), 'links in the child');
  assert.equal(evaluate(() => document.querySelector('#workList [aria-current="true"]')?.dataset.key), `t:${taskId}`);

  // 殻の口の身代わり（デスクトップ版のホストの画面と同じ判定を通す）
  evaluate(() => { window.__opened = []; window.plyDesktop = { ...(window.plyDesktop || {}), openExternal: url => { window.__opened.push(url); return Promise.resolve(true); } }; });
  if (shots) { fs.mkdirSync(shots, { recursive: true }); ab('screenshot', path.join(shots, 'work-dialog-links.png')); }
  // 本物のポインターで押す（ダイアログの上に別の層があれば届かない）
  const links = evaluate(() => [...document.querySelectorAll('#workBody a.md-link[target="_blank"]')].map((a, i) => { a.dataset.probe = String(i); return a.href; }));
  console.log('links:', JSON.stringify(links));
  for (let i = 0; i < links.length; i++) {
    evaluate(n => document.querySelector(`[data-probe="${n}"]`).scrollIntoView({ block: 'center' }), i);
    ab('click', `[data-probe="${i}"]`);
  }
  await wait(() => evaluate(() => window.__opened.length >= 2), 'links opened');
  const opened = evaluate(() => window.__opened);
  assert.deepEqual(opened, links);
  assert.ok(evaluate(() => !!document.querySelector('#workDialog[open]')), 'the dialog stays open');
  console.log('PASS: links in the work dialog open in the default browser', JSON.stringify(opened));

  // ---- ファイルのリンク: モーダルの右の欄（ADR 0315）----
  // 親の cwd には無く、子の cwd にだけあるファイルで、相対パスが子の cwd で解けることも確かめる
  const childDir = path.join(base, 'child-dir');
  fs.mkdirSync(path.join(childDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(work, 'parent-note.md'), '# parent note\n');
  fs.writeFileSync(path.join(childDir, 'child-note.md'), '# child note\n\nonly in the child cwd\n');
  fs.writeFileSync(path.join(childDir, 'docs', 'child-doc.md'), '# child doc\n');
  const stepsFile = path.join(base, 'child-steps.json');
  const childNote = path.join(childDir, 'child-note.md');
  fs.writeFileSync(stepsFile, JSON.stringify({ steps: [
    { tool: 'Read', input: { file_path: childNote }, result: 'ok' },
    { text: 'See [named doc](docs/child-doc.md) and [note](child-note.md).' } ] }));
  const parentLinkTurn = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:' + 'intro\n\n'.repeat(8) + 'parent see [pn](parent-note.md)' });
  const parent2 = parentLinkTurn.sessionId;
  const delegate = async (sessionId, title, task, cwd) => {
    const mark = client.mark();
    // 前の子の完了通知で親のターンが始まる間は送れない（切り替え中・実行中）。空くまで待って送り直す
    for (let tries = 0; ; tries++) {
      try {
        await client.cmd('runTurn', { sessionId, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title, task, ...(cwd ? { cwd } : {}) } }) });
        break;
      } catch (error) {
        if (tries >= 80) throw error;
        await new Promise(r => setTimeout(r, 250));
      }
    }
    const res = await client.waitFor(e => e.sessionId === sessionId && e.type === 'tool.result', { from: mark, ms: 30_000 });
    const childEnd = await client.waitFor(e => e.type === 'turnEnd' && e.sessionId !== sessionId, { from: mark, ms: 30_000 });
    return { taskId: JSON.parse(res.text).taskId, childId: childEnd.sessionId };
  };
  const files = await delegate(parent2, 'files', `steps:@${stepsFile}`, childDir);
  // 別の子（cwd も別）。同じ相対パスでも、その子の cwd のファイルが開く
  const otherDir = path.join(base, 'other-dir');
  fs.mkdirSync(path.join(otherDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'docs', 'child-doc.md'), '# other doc\n');
  const other = await delegate(parent2, 'other', 'echo:Other [other doc](docs/child-doc.md)', otherDir);

  const snap = () => evaluate(() => {
    const d = document.getElementById('workDialog'), fp = document.getElementById('filePreview');
    const a = document.activeElement;
    return { dialogOpen: d.open, dialogCls: d.className, bodyOpen: document.body.classList.contains('file-preview-open'),
      fpParent: fp.parentElement.id || fp.parentElement.tagName, fpHidden: fp.hidden,
      tabs: [...fp.querySelectorAll('[role=tab]')].map(t => t.textContent.trim()),
      selected: fp.querySelector('[role=tab][aria-selected=true]')?.textContent.trim() ?? '',
      srcs: [...fp.querySelectorAll('iframe')].map(f => f.getAttribute('src') || ''), text: fp.textContent,
      active: a?.dataset?.filePath ?? a?.id ?? a?.tagName ?? '' };
  });
  const press = key => ab('press', key);
  // 本物のポインターで押す（印を付けてから ab click）
  const clickOn = (sel, label) => {
    const ok = evaluate(s => { const n = document.querySelector(s); if (!n) return false; n.dataset.probe = 'pick'; n.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; }, sel);
    assert.ok(ok, `target exists: ${label}`);
    try { ab('click', '[data-probe="pick"]'); }
    catch (error) {
      console.log('click failed', label, JSON.stringify(evaluate(() => { const b = x => { const q = x.getBoundingClientRect(); return [Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)]; }; const n = document.querySelector('[data-probe="pick"]'); const q = n.getBoundingClientRect(); const top = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { target: b(n), top: top?.id || top?.className || top?.tagName, topRect: top && b(top), vh: innerHeight }; })));
      console.log(String(error.stderr).trim());
      throw error;
    }
    evaluate(() => document.querySelector('[data-probe="pick"]')?.removeAttribute('data-probe'));
  };
  const closeDialog = async () => {
    evaluate(() => document.getElementById('workDialog').close());
    await wait(() => evaluate(() => !document.getElementById('workDialog').open), 'dialog closed');
  };
  const openCard = async (taskId, label) => {
    const isOpen = () => evaluate(id => document.getElementById('workDialog').open && !!document.getElementById('workBody').dataset.sessionId && !!document.querySelector(`#workList [data-key="t:${id}"][aria-current="true"]`), taskId);
    // 右の欄の開閉の動き（ADR 0312）で会話の幅が動く間に押すと外れる。落ち着いてから押し、開かなければ押し直す
    for (let tries = 0; ; tries++) {
      await new Promise(r => setTimeout(r, 700));
      clickOn(`.tc[data-tool$="ply_delegate"][data-task-id="${taskId}"] .tc-go`, `card ${label}`);
      const until = Date.now() + 4000;
      while (Date.now() < until && !isOpen()) await new Promise(r => setTimeout(r, 150));
      if (isOpen()) return;
      assert.ok(tries < 3, `dialog for ${label}`);
    }
  };

  ab('set', 'viewport', '1280', '800');
  // 初回の案内の窓は、重なると Esc も押しも窓に取られる。閉じて、再び出ないようにする
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  // 前の確認で開いたままのダイアログを閉じてから、別の親の会話へ
  await closeDialog();
  evaluate(id => document.querySelector(`#groups .row[data-session="${id}"]`).click(), parent2);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 2), 'delegate cards');

  // 1. モーダルを一度も開かない主のパネル: 親のリンクで開き、モーダルを開いて閉じても変わらない
  // 画面が読み込み直しで描き直される間に押すと外れる。開くまで数回押し直す
  for (let tries = 0; ; tries++) {
    clickOn('#log a.file-link[data-file-path="parent-note.md"]', 'parent link');
    const until = Date.now() + 4000;
    while (Date.now() < until && !evaluate(() => document.body.classList.contains('file-preview-open'))) await new Promise(r => setTimeout(r, 150));
    if (evaluate(() => document.body.classList.contains('file-preview-open'))) break;
    assert.ok(tries < 3, 'main pane open: ' + JSON.stringify(await snap()).slice(0, 600));
  }
  const mainBefore = await snap();
  assert.ok(mainBefore.tabs.some(x => x.includes('parent-note.md')), `main tab: ${mainBefore.tabs}`);
  assert.equal(mainBefore.fpParent === 'workSplit', false);

  // 2. 子のモーダルのリンクは、モーダルを閉じずに右の欄で開く。主のパネルは子の欄のために閉じる
  await openCard(files.taskId, 'files');
  await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="docs/child-doc.md"]')), 'link in the child');
  assert.equal((await snap()).dialogOpen, true);
  assert.ok(evaluate(() => !!document.querySelector('#workBody a.tc-file')), 'tool row path link in the child');
  if (shots) ab('screenshot', path.join(shots, 'work-dialog-before-pane.png'));
  clickOn('#workBody a.file-link[data-file-path="docs/child-doc.md"]', 'child doc link');
  await wait(() => evaluate(() => document.getElementById('filePreview').parentElement.id === 'workSplit' && document.getElementById('filePreview').textContent.includes('child-doc.md')), 'pane in the dialog');
  let s = await snap();
  assert.equal(s.dialogOpen, true, 'the dialog stays open');
  assert.match(s.dialogCls, /file-preview-open/);
  assert.equal(s.bodyOpen, false, 'main does not show the pane while the dialog has it');
  assert.ok(s.tabs.some(x => x.includes('child-doc.md')), `child tab: ${s.tabs}`);
  assert.ok(s.tabs.every(x => !x.includes('parent-note.md')), `no parent tab in the child pane: ${s.tabs}`);
  assert.ok(s.srcs.some(src => src.includes(files.childId)) || s.text.includes('child-dir'), `child context: ${s.srcs}`);
  const dialogWidth = evaluate(() => Math.round(document.getElementById('workDialog').getBoundingClientRect().width));
  assert.ok(dialogWidth > 1100 && dialogWidth <= 1230, `dialog widens to fit the pane: ${dialogWidth}`);
  if (shots) ab('screenshot', path.join(shots, 'work-dialog-pane-1280.png'));
  // 二つ目のリンク（ツール行のパス・本文の別のリンク）も同じ欄の別タブ
  // 欄が開く動きの間は幅が動くので、落ち着いてから押し、開かなければ押し直す
  const toolTab = () => evaluate(() => [...document.querySelectorAll('#filePreview [role=tab]')].some(t => t.textContent.includes('child-note.md')));
  for (let tries = 0; ; tries++) {
    await new Promise(r => setTimeout(r, 700));
    clickOn('#workBody a.tc-file', 'tool row path');
    const until = Date.now() + 4000;
    while (Date.now() < until && !toolTab()) await new Promise(r => setTimeout(r, 150));
    if (toolTab()) break;
    assert.ok(tries < 3, 'tool row tab');
  }
  assert.equal((await snap()).dialogOpen, true);

  // 3. Esc は一段ずつ: 右の欄 → モーダル。閉じた欄から押したリンクへ焦点が戻る
  press('Escape');
  await wait(() => evaluate(() => !document.getElementById('workDialog').classList.contains('file-preview-open') || document.getElementById('filePreview').hidden), 'pane closed by Esc');
  s = await snap();
  assert.equal(s.dialogOpen, true, 'the first Esc keeps the dialog');
  assert.ok(s.active.includes('child-note.md') || s.active === 'workBody' || s.active.includes('child'), `focus returns near the link: ${s.active}`);
  press('Escape');
  await wait(() => evaluate(() => !document.getElementById('workDialog').open), 'the second Esc closes the dialog');

  // 4. モーダルを閉じると、主のパネルは親のタブで戻る
  s = await snap();
  assert.equal(s.fpParent === 'workSplit', false, 'the pane leaves the dialog');
  assert.equal(s.bodyOpen, true, 'main pane is back');
  assert.ok(s.tabs.some(x => x.includes('parent-note.md')), `parent tab is back: ${s.tabs}`);
  assert.ok(s.tabs.every(x => !x.includes('child')), `no child tab in main: ${s.tabs}`);
  assert.equal(s.selected.includes('parent-note.md'), true);

  // 5. ペインを開いたままモーダルを閉じる（Esc 以外）でも同じに戻る
  await openCard(files.taskId, 'files again');
  clickOn('#workBody a.file-link[data-file-path="child-note.md"]', 'child note link');
  await wait(() => evaluate(() => document.getElementById('filePreview').parentElement.id === 'workSplit'), 'pane in the dialog again');
  await closeDialog();
  await wait(() => evaluate(() => document.getElementById('filePreview').parentElement.id !== 'workSplit' && document.body.classList.contains('file-preview-open')), 'main pane returns');
  s = await snap();
  assert.ok(s.selected.includes('parent-note.md'), `parent tab is selected: ${s.selected}`);

  // 6. リンクを押さずに開閉しただけなら主のパネルは変わらない
  await openCard(files.taskId, 'files, no click');
  await closeDialog();
  s = await snap();
  assert.equal(s.bodyOpen, mainBefore.bodyOpen);
  assert.deepEqual(s.tabs, mainBefore.tabs);
  assert.equal(s.selected, mainBefore.selected);

  // 7. 別の子（cwd も別）を開き直しても、その子の欄になる。同じ相対パスがその子の cwd で解ける
  await openCard(other.taskId, 'other');
  await wait(() => evaluate(() => !!document.querySelector('#workBody a.file-link[data-file-path="docs/child-doc.md"]')), 'link in the other child');
  clickOn('#workBody a.file-link[data-file-path="docs/child-doc.md"]', 'other child link');
  await wait(() => evaluate(() => document.getElementById('filePreview').parentElement.id === 'workSplit' && document.getElementById('filePreview').textContent.includes('other-dir')), 'pane resolves in the other cwd');
  s = await snap();
  assert.equal(s.dialogOpen, true);
  assert.ok(!s.text.includes('child-dir'), 'not the first child cwd');
  await closeDialog();

  // 8. 中身の種類: 孫でなく「親の会話の発言」（subagent）は親の会話のタブ。ホストの子（会話の無い中身）は右の欄なし・従来どおりダイアログを閉じて主で開く
  await openCard(files.taskId, 'files, kinds');
  evaluate(parentId => {
    const body = document.getElementById('workBody');
    body.dataset.sessionId = parentId; body.dataset.paneKind = 'subagent';
    const a = document.createElement('a'); a.className = 'md-link file-link'; a.href = '/local-file?path=x'; a.dataset.filePath = 'parent-note.md'; a.textContent = 'synthetic'; a.id = 'synthetic-link';
    body.append(a);
  }, parent2);
  clickOn('#synthetic-link', 'subagent link');
  await wait(() => evaluate(() => document.getElementById('filePreview').parentElement.id === 'workSplit'), 'pane for the subagent');
  assert.equal((await snap()).dialogOpen, true);
  await closeDialog();
  await openCard(files.taskId, 'files, host');
  evaluate(() => {
    const body = document.getElementById('workBody');
    delete body.dataset.sessionId; delete body.dataset.paneKind;
    const a = document.createElement('a'); a.className = 'md-link file-link'; a.href = '/local-file?path=x'; a.dataset.filePath = 'parent-note.md'; a.textContent = 'synthetic'; a.id = 'synthetic-host';
    body.append(a);
  });
  clickOn('#synthetic-host', 'host link');
  await wait(() => evaluate(() => !document.getElementById('workDialog').open), 'host kind closes the dialog (old behavior)');
  assert.equal((await snap()).fpParent === 'workSplit', false);
  console.log('PASS: file links in the work dialog open in the dialog right pane (child tab / Esc one level / back to the parent tab / kinds)');

  // 9. 狭い幅（360px）: 一覧 → 会話 → ページの三段。欄が全面で重なり、Esc で会話へ戻る
  ab('set', 'viewport', '360', '780');
  // 主の欄が開いたままだと一覧の上に重なる。読み込み直して、欄の無い状態から始める
  ab('open', pageUrl);
  // 狭い幅では、読み込み直すと直前の会話がそのまま開くか、一覧だけが出る
  await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session]') || !!document.querySelector('.tc-go')), 'session list again');
  evaluate(() => document.getElementById('onboardingDialog')?.close());
  evaluate(id => { if (!document.querySelector('.tc-go')) document.querySelector(`#groups .row[data-session="${id}"]`).click(); }, parent2);
  await wait(() => evaluate(() => document.querySelectorAll('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').length >= 2), 'delegate cards again');
  await openCard(files.taskId, 'files, narrow');
  clickOn('#workBody a.file-link[data-file-path="docs/child-doc.md"]', 'narrow link');
  await wait(() => evaluate(() => document.getElementById('filePreview').parentElement.id === 'workSplit' && !document.getElementById('filePreview').hidden), 'narrow pane');
  const narrow = evaluate(() => { const d = document.getElementById('workDialog').getBoundingClientRect(), f = document.getElementById('filePreview').getBoundingClientRect(); return { dw: Math.round(d.width), fw: Math.round(f.width), fx: Math.round(f.left), vw: innerWidth }; });
  assert.ok(narrow.fw >= narrow.vw - 2 && narrow.dw <= narrow.vw + 1, `the pane covers the dialog at ${narrow.vw}px: ${JSON.stringify(narrow)}`);
  if (shots) ab('screenshot', path.join(shots, 'work-dialog-pane-360.png'));
  press('Escape');
  await wait(() => evaluate(() => document.getElementById('filePreview').hidden || !document.getElementById('workDialog').classList.contains('file-preview-open')), 'narrow pane closed by Esc');
  assert.equal((await snap()).dialogOpen, true);
  await closeDialog();
  ab('set', 'viewport', '1280', '800');
  console.log('PASS: narrow width (360px) shows the pane over the dialog');
} finally {
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
