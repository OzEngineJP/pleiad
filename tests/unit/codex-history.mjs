// Codex の履歴の読み出し（core/backends/codex-history.mjs）と、保持役が長すぎる行を捨てたときの CodexRpc（codex-rpc.mjs・codex-held.mjs）。app-server は偽物。
//   1. 画像の base64: 保存先（savedPath）のある画像からだけ外す
//   2. paginated のスレッド: thread/read はメタデータだけ・ページに分けて読み、1 回で読んだもの（base64 を外したもの）と同じ。どの応答も 1 行の上限を超えない。
//      上限を超えたページは小さくして読み直す・ターンの一覧の後に始まったターンは末尾に足す
//   3. 1 件でも上限を超える・時間切れ: 待ち続けず、履歴の言葉（historyTooLarge・historyTimeout）で失敗にする
//   4. legacy のスレッドとページ読みを知らない版は 1 回で読む（base64 は外す。知らない版と分かったら以後はページ読みを試さない）
//   5. CodexRpc: 保持役の overflow（reason: line）で、大きな答えになりうる依頼だけをすぐ失敗にする。時間切れには RPC_TIMEOUT
//   6. HeldAppServer: 自分の子の reason: line の overflow だけを CodexRpc に渡す
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexRpc } from '../../core/backends/codex-rpc.mjs';
import { HeldAppServer, CODEX_CHILD } from '../../core/backends/codex-held.mjs';
import { readThread, stripImageData, resetHistoryState, HISTORY_TIMEOUT_MS, LINE_OVERFLOW, RPC_TIMEOUT } from '../../core/backends/codex-history.mjs';

export const name = 'codex-history';
export const title = 'Codex の履歴の読み出し: 画像の base64 を運ばないページ読み・上限超えと時間切れで待ち続けない・保持役の overflow で依頼を失敗にする';

const MiB = 1024 * 1024;
const line = value => JSON.stringify({ jsonrpc: '2.0', ...value });
const tick = () => new Promise(resolve => setImmediate(resolve));
const unknownVariant = method => Object.assign(new Error(`Invalid request: unknown variant \`${method}\``), { code: -32600 });

/** 画像を作ったスレッド。turns[n].items に user・画像（count 枚）・返答 */
function imageThread({ id = 'T', historyMode = 'paginated', turns = [[2, true], [14, true], [0, true]], imageBytes = 1_600_000 } = {}) {
  const data = 'A'.repeat(imageBytes);
  return {
    id, historyMode, preview: 'p', updatedAt: 1000,
    turns: turns.map(([count, saved], n) => ({
      id: `tn${n}`, status: 'completed', startedAt: 100 + n, completedAt: 101 + n,
      items: [
        { id: `u${n}`, type: 'userMessage', content: [{ type: 'text', text: `images:${count}` }] },
        ...Array.from({ length: count }, (_, i) => ({ id: `ig${n}_${i}`, type: 'imageGeneration', status: 'completed', revisedPrompt: `p${i}`, result: data, ...(saved ? { savedPath: `C:/img/${n}_${i}.png` } : {}) })),
        { id: `m${n}`, type: 'agentMessage', text: `done ${n}` },
      ],
    })),
  };
}

/**
 * app-server の偽物（rpc.request の口）。maxLine を超える応答は、保持役が行を捨てたときの CodexRpc と同じく LINE_OVERFLOW で失敗にする。
 * paging: false はページ読みを知らない版。late: ターンの一覧の後に始まったターン（items/list にだけ出る）
 */
function fakeRpc(thread, { maxLine = 16 * MiB, paging = true, late = null, fail = null } = {}) {
  const calls = [];
  const send = (method, params, result) => {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    calls.push({ method, params, bytes });
    if (bytes > maxLine) throw Object.assign(new Error('overflow'), { code: LINE_OVERFLOW, bytes });
    return result;
  };
  const page = (rows, params) => {
    const start = params.cursor == null ? 0 : Number(params.cursor);
    const end = Math.min(rows.length, start + params.limit);
    return { data: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null };
  };
  return {
    calls,
    async request(method, params, timeoutMs) {
      assert.equal(timeoutMs, HISTORY_TIMEOUT_MS, `${method} は 30 秒で打ち切る`);
      const err = fail?.(method, params);
      if (err) { calls.push({ method, params, bytes: 0 }); throw err; }
      if (params.threadId !== thread?.id) return send(method, params, {});
      switch (method) {
        case 'thread/read':
          return send(method, params, { thread: { ...thread, turns: params.includeTurns ? thread.turns : [] } });
        case 'thread/turns/list':
          if (!paging) throw unknownVariant(method);
          assert.equal(params.itemsView, 'notLoaded', 'ターンの一覧はアイテムを載せない');
          return send(method, params, page(thread.turns.map(({ items: _i, ...turn }) => ({ ...turn, items: [], itemsView: 'notLoaded' })), params));
        case 'thread/items/list': {
          if (!paging) throw unknownVariant(method);
          const rows = [...thread.turns, ...(late ? [late] : [])].flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item, startedAtMs: turn.startedAt * 1000 })));
          return send(method, params, page(rows, params));
        }
        default: throw new Error(`知らない method: ${method}`);
      }
    },
  };
}

/** 1 回で読んだもの（includeTurns）から、保存先のある画像の base64 を外した形 */
const expected = thread => ({ ...thread, turns: thread.turns.map(turn => ({ ...turn, items: turn.items.map(stripImageData) })) });

export default async function (t) {
  // ---- 1. 画像の base64
  {
    const saved = { id: 'a', type: 'imageGeneration', result: 'BASE64', savedPath: 'C:/x.png' };
    const unsaved = { id: 'b', type: 'imageGeneration', result: 'BASE64' };
    const text = { id: 'c', type: 'agentMessage', text: 'hi', result: 'kept' };
    assert.deepEqual(stripImageData(saved), { id: 'a', type: 'imageGeneration', savedPath: 'C:/x.png' });
    assert.equal(stripImageData(unsaved), unsaved, '保存先が無い画像は base64 が画面に出す元なので残す');
    assert.equal(stripImageData(text), text, '画像でないアイテムはそのまま');
    t.ok('画像の base64 は保存先（savedPath）のある画像からだけ外す', true);
  }

  // ---- 2. paginated: 22 MB の会話（14 枚 + 2 枚）
  {
    resetHistoryState();
    const thread = imageThread();
    const fullBytes = Buffer.byteLength(JSON.stringify({ thread }));
    assert.ok(fullBytes > 16 * MiB, `作り物の会話は 1 回で読むと上限を超える（${fullBytes} バイト）`);
    const rpc = fakeRpc(thread);
    const got = await readThread(rpc, 'T');
    assert.deepEqual(got, expected(thread), '1 回で読んで base64 を外したものと同じ（ターンの順・時刻・アイテム）');
    assert.equal(JSON.stringify(got).includes('AAAAAAAAAA'), false, 'base64 を運ばない');
    assert.ok(!rpc.calls.some(c => c.method === 'thread/read' && c.params.includeTurns), '会話を丸ごと返す thread/read を使わない');
    const overflowed = rpc.calls.filter(c => c.bytes > 16 * MiB);
    const ok = rpc.calls.filter(c => c.bytes <= 16 * MiB);
    assert.ok(overflowed.length > 0 && overflowed.every(c => c.method === 'thread/items/list'), '上限を超えたのはアイテムのページだけ');
    const limits = rpc.calls.filter(c => c.method === 'thread/items/list').map(c => c.params.limit);
    assert.deepEqual(limits.slice(0, 3), [32, 16, 8], '上限を超えたページは半分にして同じ位置から読み直す');
    assert.ok(limits.slice(3).every(l => l <= 4), `画像のあるページの後は小さく読む: ${limits.join(',')}`);
    t.ok('paginated: 22 MB の会話をページに分けて読み、1 回で読んで base64 を外したものと同じ。上限を超えたページは半分にして読み直す',
      true, `呼び出し ${rpc.calls.length} 回・捨てられた ${overflowed.length} 回・最大の応答 ${Math.max(...ok.map(c => c.bytes))} バイト・ページ ${limits.join(',')}`);

    // 画像の無い長い会話はページを大きく戻す
    const plain = imageThread({ turns: Array.from({ length: 150 }, () => [0, true]) });
    const rpc2 = fakeRpc(plain);
    assert.deepEqual(await readThread(rpc2, 'T'), expected(plain));
    assert.equal(rpc2.calls.filter(c => c.method === 'thread/turns/list').length, 2, 'ターンの一覧も 100 件ずつ読む');
    assert.equal(rpc2.calls.filter(c => c.method === 'thread/items/list').length, Math.ceil(300 / 32), 'アイテムは 32 件ずつ');
    t.ok('画像の無い 150 ターンの会話: ターンは 100 件・アイテムは 32 件ずつ読み、1 回で読んだものと同じ', true);

    // ターンの一覧の後に始まったターン（items/list にだけ出る）
    const late = { id: 'tnLate', status: 'inProgress', startedAt: 999, items: [{ id: 'uL', type: 'userMessage', content: [{ type: 'text', text: 'late' }] }] };
    const got3 = await readThread(fakeRpc(imageThread({ turns: [[1, true]] }), { late }), 'T');
    assert.deepEqual(got3.turns.map(turn => turn.id), ['tn0', 'tnLate'], '末尾に足す');
    assert.deepEqual(got3.turns[1], { id: 'tnLate', status: 'inProgress', startedAt: 999, items: late.items });
    t.ok('ターンの一覧を読んだ後に始まったターンのアイテムは、末尾のターンとして足す', true);

    assert.equal(await readThread(fakeRpc(thread), 'nope'), null, '無いスレッドは null');
  }

  // ---- 3. 読めないときは待ち続けずに失敗にする
  {
    resetHistoryState();
    // 保存先の無い 20 MB の画像: 1 件でも上限を超える
    const huge = imageThread({ turns: [[1, false]], imageBytes: 20 * MiB });
    const rpc = fakeRpc(huge);
    const err = await readThread(rpc, 'T').then(() => null, e => e);
    assert.ok(err, '読めたことにしない');
    assert.equal(err.code, LINE_OVERFLOW);
    assert.match(err.message, /大きすぎて|too large/i);
    assert.match(err.message, /thread\/items\/list/);
    assert.equal(rpc.calls.filter(c => c.method === 'thread/items/list').at(-1).params.limit, 1, '1 件ずつまで小さくしてから諦める');
    t.ok('1 件でも上限を超えるときは、1 件ずつまで小さくしてから「大きすぎて読み込めない」で失敗にする', true, err.message);

    const timeout = Object.assign(new Error('timeout'), { code: RPC_TIMEOUT });
    const slow = await readThread(fakeRpc(imageThread(), { fail: m => (m === 'thread/turns/list' ? timeout : null) }), 'T').then(() => null, e => e);
    assert.equal(slow?.code, RPC_TIMEOUT);
    assert.match(slow.message, /30/);
    assert.match(slow.message, /thread\/turns\/list/);
    const slowMeta = await readThread(fakeRpc(imageThread(), { fail: () => timeout }), 'T').then(() => null, e => e);
    assert.match(slowMeta?.message ?? '', /thread\/read/);
    t.ok('時間切れは「30 秒で読み込めなかった」と、応答の無かった依頼の名前で失敗にする', true, slow.message);

    const other = new Error('boom');
    const e3 = await readThread(fakeRpc(imageThread(), { fail: m => (m === 'thread/items/list' ? other : null) }), 'T').then(() => null, e => e);
    assert.equal(e3, other, 'ほかのエラーはそのまま');
  }

  // ---- 4. legacy とページ読みを知らない版
  {
    resetHistoryState();
    const legacy = imageThread({ historyMode: 'legacy', turns: [[2, true], [1, false]], imageBytes: 1000 });
    const rpc = fakeRpc(legacy);
    assert.deepEqual(await readThread(rpc, 'T'), expected(legacy));
    assert.deepEqual(rpc.calls.map(c => [c.method, Boolean(c.params.includeTurns)]), [['thread/read', false], ['thread/read', true]], 'legacy はページ読みを試さず 1 回で読む');
    assert.equal(JSON.stringify(await readThread(fakeRpc(legacy), 'T')).match(/A{1000}/g)?.length, 1, '保存先の無い 1 枚だけ base64 を残す');
    t.ok('legacy のスレッドは 1 回で読み、保存先のある画像の base64 を外す', true);

    const small = imageThread({ turns: [[1, true]], imageBytes: 1000 });
    const old = fakeRpc(small, { paging: false });
    assert.deepEqual(await readThread(old, 'T'), expected(small));
    const again = fakeRpc(small, { paging: false });
    await readThread(again, 'T');
    assert.deepEqual(again.calls.map(c => c.method), ['thread/read', 'thread/read'], '知らない版と分かったら以後はページ読みを試さない');
    resetHistoryState();
    t.ok('ページ読みを知らない版（unknown variant）は 1 回で読み直し、以後は試さない', true);
  }

  // ---- 5. CodexRpc: 保持役の overflow と時間切れ
  {
    const writes = [];
    const state = { sink: null };
    const held = {
      adopted: true, expected: [],
      get writable() { return true; },
      write(text) { writes.push(JSON.parse(text)); return true; },
      ack() {}, kill() {}, stop() { return Promise.resolve(); }, dispose() {},
      run(sink) { state.sink = sink; },
    };
    const rpc = new CodexRpc({}, { acquire: async () => held });
    await rpc.start();
    const settle = p => p.then(v => ({ v }), e => ({ e }));
    const asks = {
      full: settle(rpc.request('thread/read', { threadId: 'T', includeTurns: true })),
      meta: settle(rpc.request('thread/read', { threadId: 'T' })),
      items: settle(rpc.request('thread/items/list', { threadId: 'T', limit: 32 })),
      turns: settle(rpc.request('thread/turns/list', { threadId: 'T', itemsView: 'notLoaded' })),
      resumeAll: settle(rpc.request('thread/resume', { threadId: 'T' })),
      resume: settle(rpc.request('thread/resume', { threadId: 'T', excludeTurns: true })),
    };
    await tick();
    const started = Date.now();
    state.sink.overflow({ id: CODEX_CHILD, reason: 'line', bytes: 23_000_000 });
    for (const key of ['full', 'items', 'resumeAll']) {
      const { e } = await asks[key];
      assert.equal(e?.code, LINE_OVERFLOW, `${key} は失敗にする`);
      assert.equal(e.bytes, 23_000_000);
      assert.match(e.message, /大きすぎて|too large/i);
    }
    assert.ok(Date.now() - started < 1000, 'すぐ失敗にする（待ち続けない）');
    // 小さな答えの依頼は待ち続ける。答えが来たら受け取る
    const byMethod = (method, pred = () => true) => writes.find(w => w.method === method && pred(w.params));
    state.sink.line(line({ id: byMethod('thread/read', p => !p.includeTurns).id, result: { thread: { id: 'T' } } }), 1);
    state.sink.line(line({ id: byMethod('thread/turns/list').id, result: { data: [] } }), 2);
    state.sink.line(line({ id: byMethod('thread/resume', p => p.excludeTurns).id, result: { thread: { id: 'T' } } }), 3);
    assert.deepEqual((await asks.meta).v, { thread: { id: 'T' } });
    assert.deepEqual((await asks.turns).v, { data: [] });
    assert.deepEqual((await asks.resume).v, { thread: { id: 'T' } });
    t.ok('保持役が長すぎる行を捨てたら、大きな答えになりうる依頼（中身つきの thread/read・items/list・excludeTurns の無い resume）だけをすぐ失敗にする', true);

    const keep = setTimeout(() => {}, 5000);   // 時間切れの timer は unref なので、待つ間プロセスを生かしておく
    const timedOut = await rpc.request('thread/read', { threadId: 'T' }, 20).then(() => null, e => e);
    clearTimeout(keep);
    assert.equal(timedOut?.code, RPC_TIMEOUT, '時間切れには RPC_TIMEOUT');
    t.ok('依頼の時間切れは code: RPC_TIMEOUT で失敗にする（履歴の読み出しが言葉を直す）', true);
  }

  // ---- 6. HeldAppServer は自分の子の reason: line だけを渡す
  {
    const client = Object.assign(new EventEmitter(), {
      connected: true,
      write: () => true, ack() {}, mark() {}, unmark() {}, label() {}, kill() {},
      detach: async () => ({ children: [] }),
      attach: async () => ({ alive: true, pendingRequests: [] }),
    });
    const held = new HeldAppServer({ client, state: { acked: 0, seq: 0, marks: {} }, spawned: true });
    const seen = [];
    held.run({ line() {}, err() {}, exit() {}, lost() {}, handedOff() {}, overflow: frame => seen.push(frame) });
    client.emit('overflow', { id: 'someone-else', reason: 'line', bytes: 1 });
    client.emit('overflow', { id: CODEX_CHILD, reason: 'record', first: 3 });
    client.emit('overflow', { id: CODEX_CHILD, reason: 'line', bytes: 2 });
    assert.deepEqual(seen.map(f => f.bytes), [2], '自分の子の、捨てた行（reason: line）だけ');
    held.offErr();
    client.emit('overflow', { id: CODEX_CHILD, reason: 'line', bytes: 3 });
    assert.equal(seen.length, 1, '読みを止めたら渡さない');
    t.ok('HeldAppServer は自分の子の捨てた行（reason: line）の overflow だけを CodexRpc に渡す', true);
  }
}
