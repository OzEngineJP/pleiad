// 子の会話のモーダル（#workDialog）の履歴の読み方が、主の会話の画面と同じであることを実ブラウザーで固定する（ADR 0319 段 6-6 の追補）。
//   1. 差分の読み直し: 走っていた子のターンが終わったあとの静かな読み直しは、持っている窓の続きだけを頼む（loadSession に from / check）。
//      描いた結果は、同じ発言が 2 回出ず、順も崩れず、手前の履歴も残る（ADR 0062）
//   2. 大きい返事は WS の外（/bulk/<id>）で受ける（bulk。ADR 0179）。中継越しを装う（x-forwarded-for を足す小さい中継を挟む）と、サーバーが本当に
//      bulk の返事を出す。その返事を中継で止めている間に、同じ子の次のターンの出来事が流れても、あとで受けた返事は出来事より前の状態として
//      先に適用され、出来事が後ろに続く（順序が逆にならない）。ターンが終わった印は、読み直しをもう 1 回走らせる
//   3. 画面の外の行は描かない: モーダルの子の本文の .mw に、主の #thread と同じ content-visibility:auto が掛かる（実寸が決まる .height-ready まで）。
//      実寸の確定（createHeightSettler）がモーダルでも働いて .height-ready が付くこと、読み取り専用の .bg-thread には掛からないことも見る
//   4. 目次を開くと、手前の履歴を全部読み足す（主の目次の onOpen: loadAllOlder と同じ）
// 実行: node tests/browser/child-modal-history-read.mjs
// 本物のサーバー（fake バックエンド・一時のデータ置き場・空いている別ポート）だけと話す。待ちは状態を待つ（上限つき）。固定の待ちは使わない。
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  startRig, openPage, makeRoot, delegateChild, waitChildDone, writeScript, historyScript, tailScript, startScript, openChildModal, closeChildModal, waitUntil,
} from '../lib/child-modal-rig.mjs';

// ---------------------------------------------------------------- 中継越しを装う小さい中継（x-forwarded-for を足す。/bulk/ を止められる）
//   サーバーは、ループバックからでも中継の印（x-forwarded-for など）があれば「遠隔」とみなし、大きい返事を /bulk/<id> に置く（core/os-open.mjs の isLocalRequest）
function startForwardProxy(targetPort) {
  const state = { bulkRequests: 0, hold: false, held: [], port: 0 };
  const sockets = new Set();   // upgrade した WebSocket は http.Server の管理から外れるので、自分で覚えて止めるときに壊す
  const track = (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const FORWARD = { 'x-forwarded-for': '203.0.113.7' };
  const server = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, ...FORWARD } }, (reply) => {
      const send = () => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); };
      if (req.url.startsWith('/bulk/')) {
        state.bulkRequests++;
        if (state.hold) { state.held.push(send); reply.pause(); return; }
      }
      send();
    });
    up.on('error', () => { try { res.destroy(); } catch { /* 閉じ済み */ } });
    req.pipe(up);
  });
  // WebSocket は、要求の頭にヘッダーを足して、あとは両方向に流すだけ
  server.on('upgrade', (req, socket, head) => {
    track(socket);
    const up = track(net.connect(targetPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      for (const [k, v] of Object.entries(FORWARD)) lines.push(`${k}: ${v}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    }));
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.release = () => { state.hold = false; for (const send of state.held.splice(0)) send(); };
      state.close = () => new Promise((r) => {
        state.release();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections?.();
        server.close(() => r());
      });
      resolve(state);
    });
  });
}

const BIG = 28;   // 大きい返事（bulk は 64KB から）にするための発言数。fake は 8 文字ごとに待つので、超える最小に近い数にして時間を縮める
const rig = await startRig({ tag: 'cm-read', env: {} });
const { page } = rig;
let proxy = null;
try {
  console.log(`fake server pid=${rig.server.child.pid} port=${rig.server.port}`);
  proxy = await startForwardProxy(rig.server.port);
  rig.url = `http://127.0.0.1:${proxy.port}/?token=${rig.server.token}`;   // 画面は中継越しにつなぐ（中継越しの線を装う）

  // 送った loadSession と、WS の返事の bulk（置き場の URL）を数える
  const sent = [];
  let bulkReplies = 0;
  rig.cdp.on('Network.webSocketFrameSent', ({ response }) => {
    try { const m = JSON.parse(String(response?.payloadData ?? '')); if (m.command === 'loadSession') sent.push({ args: m.args ?? {}, bulk: m.bulk === true }); } catch { /* JSON でない */ }
  });
  rig.cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    const text = String(response?.payloadData ?? '');
    if (text.includes('"response"') && /"bulk":"\/bulk\//.test(text.slice(0, 300))) bulkReplies++;
  });

  const parent = await makeRoot(rig, 'echo:履歴の読み方の依頼元');
  await openPage(rig);

  // 手前を省く窓（50 発言）より長い履歴を持つ子。終わらせてからモーダルで開く
  const history = writeScript(rig.base, 'history', historyScript({ messages: 130, tools: 10, tag: '履歴' }));
  const child = await delegateChild(rig, parent, { title: '長い履歴の子', task: `steps:@${history}` });
  await waitChildDone(rig, child.taskId, 120_000);
  const forChild = () => sent.filter((f) => f.args.sessionId === child.childId);
  const body = (fn, arg) => page.evaluate(fn, arg);
  const text = () => body(() => document.getElementById('workBody').textContent);
  const count = async (needle) => (await text()).split(needle).length - 1;

  // ---------------------------------------------------------------- 開く: 窓を bulk つきで頼む（差分ではない）
  await openChildModal(rig, parent, child.taskId);
  await waitUntil(async () => (await text()).includes('履歴 129:'), 'the modal shows the tail of the history', 30_000, 100);
  const opened = forChild().at(-1);
  assert.ok(opened, 'the modal asked the server for the child history');
  assert.equal(opened.bulk, true, 'the open request allows a bulk reply');
  assert.equal(opened.args.from, undefined, 'the first read is not a differential one');
  assert.ok(opened.args.tail > 0, `the open request asks for the window: ${JSON.stringify(opened.args)}`);
  assert.ok(!(await text()).includes('履歴 0:'), 'the older history is not read yet (windowed)');
  console.log('PASS: opening the modal reads the window with bulk allowed (not a differential)');

  // ---------------------------------------------------------------- 3. 画面の外の行を描かない（モーダルの .mw にも content-visibility）
  await waitUntil(() => body(() => document.querySelectorAll('#workBody .mw.height-ready').length > 0), 'the height settler marks rows in the modal', 15_000, 100);
  const verdict = await body(() => {
    const live = document.querySelector('.thread.live-child');
    const view = (el) => getComputedStyle(el).contentVisibility;
    const probe = (parent, cls) => { const d = document.createElement('div'); d.className = cls; parent.append(d); const v = view(d); d.remove(); return v; };
    const readonly = document.createElement('div');
    readonly.className = 'thread bg-thread';
    document.body.append(readonly);
    const out = {
      hasLive: !!live,
      unsettled: probe(live, 'mw'), settled: probe(live, 'mw height-ready'), activity: probe(live, 'mw activity'),
      readonly: probe(readonly, 'mw'), main: probe(document.getElementById('thread'), 'mw'),
    };
    readonly.remove();
    return out;
  });
  assert.equal(verdict.hasLive, true, 'the modal thread carries .live-child');
  assert.equal(verdict.main, 'auto', 'the main thread skips painting rows whose height is not settled (the reference)');
  assert.equal(verdict.unsettled, 'auto', `the modal rows skip painting until settled: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.settled, 'visible', 'a settled row is painted normally');
  assert.equal(verdict.activity, 'visible', 'the running row is never skipped');
  assert.equal(verdict.readonly, 'visible', 'the read-only .bg-thread (no settler) is not affected');
  console.log('PASS: modal rows skip painting until their height is settled (content-visibility), like the main thread');

  // ---------------------------------------------------------------- 1・2. ターンが終わったあとの差分の読み直し（bulk の返事）
  const big = (tag, n) => ({ steps: Array.from({ length: n }, (_, i) => ({ text: `[${tag}${String(i).padStart(2, '0')}] ${'大きい本文です。'.repeat(120)}` })) });
  const scriptA = writeScript(rig.base, 'bigA', big('A', BIG));
  const mark1 = forChild().length;
  const bulk1 = bulkReplies;
  const doneA = await startScript(rig, child.childId, scriptA);
  await waitUntil(async () => (await count('[A00]')) >= 1, 'the modal streams the new turn', 60_000, 100);
  await doneA();
  const diff = await waitUntil(() => forChild().slice(mark1).find((f) => f.args.from !== undefined), 'a differential re-read after the turn ends', 30_000, 100);
  assert.equal(diff.bulk, true, 'the differential re-read allows a bulk reply');
  assert.equal(typeof diff.args.from, 'number', `the differential request carries from: ${JSON.stringify(diff.args)}`);
  assert.ok(diff.args.check !== undefined && diff.args.check !== null, 'the differential request carries check (the signature of what is held)');
  assert.ok(diff.args.from > 0, 'the differential request starts after the head of what is held');
  await waitUntil(() => bulkReplies > bulk1 && proxy.bulkRequests >= 1, 'the large differential reply came out of the WS (/bulk/)', 30_000, 100);
  const lastA = `[A${String(BIG - 1).padStart(2, '0')}]`;
  await waitUntil(async () => (await body(() => document.querySelectorAll('#workBody .m.live, #workBody [data-key^="live:"]').length)) === 0 && (await count(lastA)) === 1, 'the live rows give way to the read history', 30_000, 100);
  for (let i = 0; i < BIG; i++) assert.equal(await count(`[A${String(i).padStart(2, '0')}]`), 1, `message A${i} appears exactly once after the differential re-read`);
  const orderA = await text();
  assert.ok(orderA.indexOf('[A00]') < orderA.indexOf('[A10]') && orderA.indexOf('[A10]') < orderA.indexOf(lastA), 'the new messages keep their order');
  assert.ok(orderA.indexOf('履歴 129:') < orderA.indexOf('[A00]'), 'the history before the new turn is kept in front of it');
  const keys = await body(() => [...document.querySelectorAll('#workBody .thread.live-child > .mw[data-key]')].map((n) => n.dataset.key));
  assert.equal(new Set(keys).size, keys.length, 'no row is drawn twice');
  console.log(`PASS: after the turn ends, only the tail is asked for (from=${diff.args.from}), the reply comes through /bulk/, and the rows are exactly once and in order`);

  // ---------------------------------------------------------------- 2'. 止めた bulk の返事と、同じ子の次のターンの出来事（順序）
  const scriptC = writeScript(rig.base, 'bigC', big('C', BIG));
  const scriptB = writeScript(rig.base, 'tailB', tailScript({ rounds: 3, tag: 'B' }));
  proxy.hold = true;
  const mark2 = forChild().length;
  const doneC = await startScript(rig, child.childId, scriptC);
  await doneC();
  await waitUntil(() => proxy.held.length === 1, 'the bulk reply of the re-read is being held on the line', 30_000, 100);
  // 返事が止まっている間も、WS は流れる。同じ子に次のターンを走らせる（出来事は取り置かれ、返事のあとに適用される）
  const doneB = await startScript(rig, child.childId, scriptB);
  await waitUntil(async () => (await count('B 0:')) >= 1, 'the next turn streams while the reply is held', 30_000, 100).catch(() => null);
  await doneB();
  assert.equal(proxy.held.length, 1, 'the reply is still held while the next turn finished');
  proxy.release();
  const lastB = 'B 2:';
  await waitUntil(async () => (await count(lastB)) === 1 && (await count(`[C${BIG - 1}]`)) === 1, 'the held reply and the events of the next turn are both drawn', 60_000, 100);
  // 2 回目の読み直しが走る（流し直しの間にターンが終わった印）
  await waitUntil(() => forChild().slice(mark2).filter((f) => f.args.from !== undefined).length >= 2, 'a second re-read runs after the replay (the turn ended while the first was loading)', 30_000, 100);
  await waitUntil(async () => (await body(() => document.querySelectorAll('#workBody [data-key^="live:"]').length)) === 0, 'the live rows give way to the read history again', 30_000, 100);
  for (let i = 0; i < BIG; i++) assert.equal(await count(`[C${String(i).padStart(2, '0')}]`), 1, `message C${i} appears exactly once`);
  for (const mark of ['B 0:', 'B 1:', 'B 2:']) assert.equal(await count(mark), 1, `${mark} appears exactly once`);
  const orderC = await text();
  assert.ok(orderC.indexOf(lastA) < orderC.indexOf('[C00]') && orderC.indexOf(`[C${BIG - 1}]`) < orderC.indexOf('B 0:') && orderC.indexOf('B 0:') < orderC.indexOf('B 2:'),
    'the events of the next turn come after the held reply, in order');
  const keys2 = await body(() => [...document.querySelectorAll('#workBody .thread.live-child > .mw[data-key]')].map((n) => n.dataset.key));
  assert.equal(new Set(keys2).size, keys2.length, 'no row is drawn twice after the replay');
  console.log('PASS: a late /bulk/ reply is applied before the events that came while it was held (order kept, nothing doubled)');

  // ---------------------------------------------------------------- 4. 目次を開くと手前を全部読み足す
  assert.ok(!(await text()).includes('履歴 0:'), 'the oldest message is still not read before the table of contents opens');
  await waitUntil(() => body(() => !document.getElementById('workTocEntry').hidden), 'the table of contents button is shown', 15_000, 100);
  await body(() => document.getElementById('workTocEntry').click());
  await waitUntil(async () => (await text()).includes('履歴 0:'), 'opening the table of contents reads all the older history', 60_000, 100);
  assert.equal(await count('履歴 0:'), 1, 'the oldest message is drawn once');
  console.log('PASS: opening the table of contents reads all the older history (like the main screen)');

  await closeChildModal(rig).catch(() => {});
  assert.deepEqual(rig.pageErrors, [], 'no page errors');
  console.log('PASS');
} finally {
  await rig.close();
  await proxy?.close().catch(() => {});
}
