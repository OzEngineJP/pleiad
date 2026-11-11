// 委譲の子（孫を含む）の会話は、メインの画面には出ない。会話を開く入口は、依頼元の根の会話をメインに、子をモーダルで出す（ADR 0318）。実ブラウザー。
//   1. 電話の承認通知の ?open=<子の id>: 根がメイン（agent-host-current）・子がモーダル。Esc で根に戻る（モーダルが閉じるだけ）
//   2. ?open=<孫の id>: 孫でも同じ（根まで辿る）
//   3. 依頼元の会話を消した子（ADR 0147）は根として扱い、メインで開く（モーダルは開かない）
//   4. 保存していた「開いていた会話」が子の id なら、起動で根になる（モーダルは復元しない）
//   5. 脇の検索（委譲した会話を含める）の結果を押す: 根がメイン・子がモーダルで、一致した発言のところへ着く
//   6. モーダルの見出しに「会話として開く ↗」が無く、メインの見出しに「↖ 依頼元」の入口が無い
// 実行: node tests/browser/child-open-routes.mjs   （CHILD_OPEN_SHOTS=<dir> で画面も撮る）
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）だけと話す。実データには触れない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

fs.mkdirSync(path.join(ROOT, 'temporary'), { recursive: true });
const base = fs.mkdtempSync(path.join(ROOT, 'temporary', 'child-open-routes-'));
const work = path.join(base, 'work');
fs.mkdirSync(work);
const shots = process.env.CHILD_OPEN_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
// agent-browser が起こすデーモンが出力の口を握り続けることがある（Windows）。出力はパイプでなくファイルへ書かせて読む
const abOut = path.join(base, 'ab-out.txt');
const ab = (...args) => {
  const fd = fs.openSync(abOut, 'w');
  try { execFileSync(process.env.AGENT_BROWSER_BIN || 'agent-browser', args, { stdio: ['ignore', fd, fd], timeout: 60_000 }); }
  finally { fs.closeSync(fd); }
  return fs.readFileSync(abOut, 'utf8');
};
const evaluate = (fn, arg) => {
  const code = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
  return JSON.parse(ab('eval', '--json', '--base64', Buffer.from(code).toString('base64'))).data.result;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, label, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};
const shot = (name) => { if (shots) { try { ab('screenshot', path.join(shots, `${name}.png`)); } catch (e) { console.log('shot failed', name, e.message.slice(0, 80)); } } };
let server, client;
try {
  server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
  console.log(`fake server pid=${server.child.pid} port=${server.port}`);
  client = await open({ ...server });
  await client.cmd('authLogin', { backend: 'fake' });
  await client.cmd('completeSetup', { backend: 'fake' });

  const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
  const delegate = async (parent, args) => {
    const mark = client.mark();
    for (let tries = 0; ; tries++) {
      try { await client.cmd('runTurn', { sessionId: parent, prompt: ply('ply_delegate', { backend: 'fake', kind: 'mechanical', ...args }) }); break; }
      catch (error) { if (tries >= 80) throw error; await sleep(250); }
    }
    const res = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
    return JSON.parse(res.text);
  };
  const completed = async (taskId) => {
    await wait(async () => (await client.cmd('agentTasks')).find(r => r.taskId === taskId)?.status === 'completed', `task ${taskId} completed`, 60_000);
    return (await client.cmd('agentTasks')).find(r => r.taskId === taskId);
  };

  // 根 → 子 → 孫
  const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:根の会話' });
  const root = first.sessionId;
  const kid = await delegate(root, { title: '子の仕事', task: `echo:子のしるし ${'KIDMARK'}` });
  const kidRow = await completed(kid.taskId);
  const grand = await delegate(kidRow.sessionId, { title: '孫の仕事', task: 'echo:孫のしるし GRANDMARK' });
  const grandRow = await completed(grand.taskId);
  // 依頼元を消した子（別の木）
  const second = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:消す根' });
  const orphanTask = await delegate(second.sessionId, { title: '取り残された子', task: 'echo:取り残しのしるし' });
  const orphanRow = await completed(orphanTask.taskId);
  // 依頼元のターンがまだ終わっていないと消せない（CANNOT_DELETE）。終わるまで待つ
  for (let tries = 0; ; tries++) {
    try { await client.cmd('deleteSession', { sessionId: second.sessionId }); break; }
    catch (error) { if (error.code !== 'CANNOT_DELETE' || tries >= 80) throw error; await sleep(250); }
  }
  console.log('root', root, 'child', kidRow.sessionId, 'grandchild', grandRow.sessionId, 'orphan', orphanRow.sessionId);

  const pageUrl = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  ab('set', 'viewport', '1280', '800');
  const boot = (extra = '') => {
    ab('open', pageUrl + extra);
  };
  const current = () => evaluate(() => localStorage.getItem('agent-host-current'));
  const modal = () => evaluate(() => ({ open: document.getElementById('workDialog').open, sessionId: document.getElementById('workBody').dataset.sessionId ?? null, kind: document.getElementById('workBody').dataset.paneKind ?? null }));
  const ready = async () => {
    await wait(() => evaluate(() => !!document.querySelector('#groups .row[data-session], #groups [role=treeitem]')), 'session list');
    evaluate(() => document.getElementById('onboardingDialog')?.close());
  };

  // ---- 1. ?open=<子>
  boot(`&open=${kidRow.sessionId}`);
  await ready();
  await wait(async () => (await modal()).open && (await modal()).sessionId === kidRow.sessionId, 'the child opens in the modal');
  assert.equal(await current(), root, 'the root conversation is the main one');
  assert.equal(evaluate(() => document.getElementById('parentChatEntry')), null, 'no "requester" entry in the main heading');
  assert.equal(evaluate(() => document.querySelectorAll('#workHead .bg-open').length), 0, 'no "open as conversation" arrow in the modal heading');
  assert.ok(evaluate(() => document.getElementById('workBody').textContent.includes('KIDMARK')), 'the child thread is shown');
  shot('child-1280');
  ab('press', 'Escape');
  await wait(async () => !(await modal()).open, 'Esc closes the modal');
  assert.equal(await current(), root, 'Esc returns to the root (the main conversation never changed)');
  console.log('PASS: ?open=<child> → root in main, child in the modal, Esc returns to the root');

  // ---- 2. ?open=<孫>
  boot(`&open=${grandRow.sessionId}`);
  await ready();
  await wait(async () => (await modal()).open && (await modal()).sessionId === grandRow.sessionId, 'the grandchild opens in the modal');
  assert.equal(await current(), root, 'a grandchild also puts the root in main');
  assert.ok(evaluate(() => document.getElementById('workBody').textContent.includes('GRANDMARK')), 'the grandchild thread is shown');
  ab('press', 'Escape');
  await wait(async () => !(await modal()).open, 'Esc closes the modal (grandchild)');
  console.log('PASS: ?open=<grandchild> → root in main, grandchild in the modal');

  // ---- 3. 依頼元を消した子は根: メインで開く
  boot(`&open=${orphanRow.sessionId}`);
  await ready();
  await wait(async () => (await current()) === orphanRow.sessionId, 'the orphan child opens in main');
  assert.equal((await modal()).open, false, 'no modal for a child whose requester was deleted');
  console.log('PASS: a child whose requester was deleted opens in main (ADR 0147)');

  // ---- 4. 保存していた子の id は、起動で根になる
  evaluate((id) => localStorage.setItem('agent-host-current', id), kidRow.sessionId);
  boot();
  await ready();
  await wait(async () => (await current()) === root, 'the saved child id becomes the root');
  await sleep(600);
  assert.equal((await modal()).open, false, 'the modal is not restored');
  console.log('PASS: a saved child id is remapped to the root on start; the modal is not restored');

  // ---- 5. 脇の検索（委譲した会話を含める）
  evaluate(() => { const q = document.getElementById('q'); q.focus(); });
  evaluate(() => { const q = document.getElementById('q'); q.value = 'GRANDMARK'; q.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(600);
  evaluate(() => document.getElementById('filterBtn').click());
  await sleep(300);
  evaluate(() => { const li = [...document.querySelectorAll('#filterPop .li')].find(n => /委譲した会話/.test(n.textContent)); li?.click(); });
  await wait(() => evaluate(() => !!document.querySelector('#groups .row.res[data-session]')), 'a search result row');
  // 依頼元の子の会話にも孫への依頼文（GRANDMARK）が残るので、結果は複数。孫の行を選ぶ
  const ids = evaluate(() => [...document.querySelectorAll('#groups .row.res[data-session]')].map((n) => n.dataset.session));
  assert.ok(ids.includes(grandRow.sessionId), 'the grandchild is in the results when delegated conversations are included: ' + ids.join(','));
  // 着いた発言に輪（flash）が付く瞬間は 1.3 秒しかないので、押す前に見張りを置く
  evaluate(() => {
    window.__hit = { flashed: false, uuid: null };
    new MutationObserver((list) => {
      for (const r of list) if (r.type === 'attributes' && r.target.classList?.contains('flash') && r.target.closest('#workBody')) {
        window.__hit.flashed = true; window.__hit.uuid = r.target.closest('[data-hit-uuid]')?.dataset.hitUuid ?? null;
      }
    }).observe(document.getElementById('workDialog'), { attributes: true, subtree: true, attributeFilter: ['class'] });
  });
  evaluate((id) => [...document.querySelectorAll('#groups .row.res[data-session]')].find((n) => n.dataset.session === id).click(), grandRow.sessionId);
  await wait(async () => (await modal()).open && (await modal()).sessionId === grandRow.sessionId, 'the result opens in the modal');
  assert.equal(await current(), root, 'the root is in main after opening a result');
  await wait(() => evaluate(() => window.__hit.flashed), 'the matched message is flashed inside the modal thread');
  const hit = evaluate(() => window.__hit);
  assert.ok(hit.uuid, 'the flashed message is a real message row (data-hit-uuid)');
  shot('search-1280');
  console.log('PASS: a search result for a grandchild → root in main, grandchild in the modal');

  // ---- 画面の撮影（CHILD_OPEN_SHOTS のときだけ）: 1280・760・360・暗い画面で、モーダルの見出し（↗ なし）と検索から開いた直後
  if (shots) {
    const variants = [['760', 760, 800, false], ['360', 360, 760, false], ['dark', 1280, 800, true]];
    for (const [label, w, h, dark] of variants) {
      ab('set', 'viewport', String(w), String(h));
      ab('set', 'media', dark ? 'dark' : 'light');
      boot(`&open=${grandRow.sessionId}`);
      await wait(async () => (await modal()).open && (await modal()).sessionId === grandRow.sessionId, `shot ${label}: the grandchild opens`);
      evaluate(() => document.getElementById('onboardingDialog')?.close());
      await sleep(500);
      shot(`child-${label}`);
      ab('press', 'Escape');
      await wait(async () => !(await modal()).open, `shot ${label}: Esc closes the modal`);
      // 検索から開いた直後。狭い画面は脇が引き出しなので、開いてから探す
      try {
        if (w <= 700) { evaluate(() => document.getElementById('openSidebar')?.click()); await sleep(500); }
        evaluate(() => { const q = document.getElementById('q'); q.focus(); q.value = 'GRANDMARK'; q.dispatchEvent(new Event('input', { bubbles: true })); });
        await sleep(600);
        // 「委譲した会話を含める」は保存されるので、入っていなければ入れる（入っているものを押すと切れる）
        evaluate(() => document.getElementById('filterBtn').click());
        await sleep(300);
        evaluate(() => { const li = [...document.querySelectorAll('#filterPop .li')].find(n => /委譲した会話/.test(n.textContent)); if (li && li.getAttribute('aria-pressed') !== 'true') li.click(); document.getElementById('filterBtn').click(); });
        await sleep(300);
        await wait(() => evaluate(() => !!document.querySelector('#groups .row.res[data-session]')), `shot ${label}: a search result row`, 10_000);
        evaluate((id) => [...document.querySelectorAll('#groups .row.res[data-session]')].find((n) => n.dataset.session === id)?.click(), grandRow.sessionId);
        await wait(async () => (await modal()).open && (await modal()).sessionId === grandRow.sessionId, `shot ${label}: the result opens in the modal`, 10_000);
        await sleep(300);
        shot(`search-${label}`);
      } catch (error) { console.log(`shot search-${label} skipped:`, error.message); }
    }
  }
  console.log('ALL PASS');
} finally {
  try { ab('close'); } catch { /* 開いていなくてもよい */ }
  client?.close();
  await server?.stop();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
