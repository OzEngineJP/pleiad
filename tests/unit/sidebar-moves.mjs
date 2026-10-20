// 脇の行の移動を行ごとの列で直列に保存する（web/sidebar-moves.mjs）。ブラウザーは要らない。
// 連続して動かした最後の移動先がそのまま残る・保存は 1 行につき 1 本ずつ・失敗しても後続は続く・
// 保存の完了が取り直しを待たない、を順序を入れ替えて確かめる。
import { createMoveLanes, settleAll } from '../../web/sidebar-moves.mjs';

export const name = 'sidebar-moves';
export const title = '脇の移動: 最新の移動先を即時に出し、保存を直列にまとめる';

/** 解決・失敗を手で決められる保存 */
function gate() {
  const g = {};
  g.promise = new Promise((resolve, reject) => { g.resolve = resolve; g.reject = reject; });
  return g;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(extra = {}) {
  const log = [];
  const timers = [];
  let version = 0;
  const lanes = createMoveLanes({
    onChange: () => log.push('change'),
    describe: ({ queued, target }) => (queued ? `to:${target}` : 'moving'),
    stamp: () => version,
    setTimer: (fn) => { timers.push(fn); return fn; },
    clearTimer: (fn) => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); },
    ...extra,
  });
  const move = (id, status, run, over = {}) => lanes.accept({
    rows: [id], patches: new Map([[id, { status }]]), before: new Map([[id, { sessionId: id, status: 'old', ungrouped: false }]]),
    coalesceKey: `status:${id}`, run, ...over,
  });
  return { lanes, log, timers, move, bump: () => ++version };
}

export default async function (t) {
  // ---- 連続した移動: 最新の移動先が即座に出て、捨てられない ----
  {
    const { lanes, move } = setup();
    const first = gate();
    const saved = [];
    const a = move('a', 'B', async () => { saved.push('B'); await first.promise; });
    t.ok('受理した瞬間に移動先を画面へ出す', lanes.patchFor('a').status === 'B');
    const b = move('a', 'C', async () => { saved.push('C'); });
    t.ok('保存の途中でも次の移動先がすぐ最新になる', lanes.patchFor('a').status === 'C');
    t.ok('次の移動は列で待ち、先の保存と重ならない', saved.join() === 'B');
    first.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    t.ok('保存は受理した順に 1 本ずつ流れる', saved.join() === 'B,C' && ra.status === 'done' && rb.status === 'done');
  }

  // ---- 未送信の同じ対象への移動は、最新の 1 件へまとめる ----
  {
    const { lanes, move } = setup();
    const first = gate();
    const saved = [];
    const a = move('a', 'B', async () => { saved.push('B'); await first.promise; });
    const b = move('a', 'C', async () => { saved.push('C'); });
    const c = move('a', 'D', async () => { saved.push('D'); });
    t.ok('予約は最後の移動先だけを見せる', lanes.entries.get('a').queued && lanes.entries.get('a').target === 'D' && lanes.entries.get('a').text === 'to:D');
    first.resolve();
    const [, rb, rc] = await Promise.all([a, b, c]);
    t.ok('未送信だった途中の移動は送らずまとめる', saved.join() === 'B,D' && rb.status === 'superseded' && rc.status === 'done', saved.join());
    t.ok('まとめた移動の取り消し先は最初の操作の前の状態', rc.before.get('a').status === 'old');
  }

  // ---- まとめた後継は、旧操作が待っていた先の保存も待つ（A 実行中 → B 待ち → C が B をまとめる）----
  {
    const { move } = setup();
    const holdA = gate();
    const order = [];
    const a = move('a', 'B', async () => { order.push('A-start'); await holdA.promise; order.push('A-end'); });
    const b = move('a', 'C', async () => { order.push('B'); });
    const c = move('a', 'D', async () => { order.push('C'); });
    await tick(); await tick();
    t.ok('先の保存が終わる前に、まとめた後継は保存を始めない', order.join() === 'A-start', order.join());
    holdA.resolve();
    await Promise.all([a, b, c]);
    t.ok('先の保存の後にまとめた最新の 1 件だけが保存される', order.join() === 'A-start,A-end,C', order.join());
  }
  {
    const { lanes } = setup();
    const holdA = gate();
    const order = [];
    const patch = (status) => new Map([['x', { status }], ['y', { status }]]);
    const a = lanes.accept({ rows: ['x'], patches: new Map([['x', { status: 'B' }]]), coalesceKey: 'status:x', run: async () => { order.push('A-start'); await holdA.promise; order.push('A-end'); } });
    const b = lanes.accept({ rows: ['x', 'y'], patches: patch('C'), coalesceKey: 'group:x', run: async () => { order.push('B'); } });
    const c = lanes.accept({ rows: ['y', 'x'], patches: patch('D'), coalesceKey: 'group:x', run: async () => { order.push('C'); } });
    await tick(); await tick();
    t.ok('重複する複数行の操作をまとめても、行ごとの先の保存を待つ', order.join() === 'A-start', order.join());
    holdA.resolve();
    await Promise.all([a, b, c]);
    t.ok('複数行の後継も先の保存の後に 1 回だけ流れる', order.join() === 'A-start,A-end,C', order.join());
  }

  // ---- まとめられた操作の後ろに並んだ別の操作も、先の保存の途中で始まらない（A 実行中 → B 待ち → E 待ち → D が B をまとめる）----
  {
    const { lanes, move } = setup();
    const holdA = gate();
    const order = [];
    const a = move('a', 'B', async () => { order.push('A-start'); await holdA.promise; order.push('A-end'); });
    const b = move('a', 'C', async () => { order.push('B'); });
    const e = lanes.accept({ rows: ['a'], patches: new Map([['a', { ungrouped: true }]]), coalesceKey: 'grouped:a', run: async () => { order.push('E'); } });
    const d = move('a', 'D', async () => { order.push('D'); });
    await tick(); await tick();
    t.ok('まとめた旧操作の後ろに並んだ別の操作も、先の保存が終わるまで始まらない', order.join() === 'A-start', order.join());
    holdA.resolve();
    const results = await Promise.all([a, b, e, d]);
    t.ok('受理した順（先の保存・後ろに並んだ操作・まとめた後継）で流れる', order.join() === 'A-start,A-end,E,D', order.join());
    t.ok('まとめられた操作は結果で知らされる', results[1].status === 'superseded' && results[2].status === 'done' && results[3].status === 'done');
  }

  // ---- 複数の保存の 1 本が先に失敗しても、全部の応答が決着するまで次の操作へ持ち場を渡さない ----
  {
    const { lanes, move } = setup();
    const quick = gate(), slow = gate();
    const order = [];
    const group = lanes.accept({ rows: ['r', 'k'], patches: new Map([['r', { status: 'B' }], ['k', { status: 'B' }]]), coalesceKey: 'status:r',
      run: () => settleAll([quick.promise.then(() => order.push('quick')), slow.promise.then(() => order.push('slow'))]) });
    const next = move('k', 'C', async () => { order.push('next'); });
    quick.reject(new Error('first failed'));
    await tick(); await tick();
    t.ok('1 本が失敗しても、残りの保存が決着する前に次の操作は始まらない', order.join() === '', order.join());
    slow.resolve();
    const [rg, rn] = await Promise.all([group, next]);
    t.ok('全部が決着した後で失敗を返し、次の操作が流れる', rg.status === 'failed' && rg.error.message === 'first failed' && order.join() === 'slow,next' && rn.status === 'done', order.join());
  }
  {
    const settled = await settleAll([Promise.resolve(1), Promise.resolve(2)]);
    t.ok('全部成功なら値を順に返す', settled.join() === '1,2');
  }

  // ---- 対象が違えばまとめない・重ならない行は待たせない ----
  {
    const { move } = setup();
    const slow = gate();
    const order = [];
    const a = move('a', 'B', async () => { order.push('a'); await slow.promise; });
    const x = move('x', 'B', async () => { order.push('x'); });
    await x;
    t.ok('別の行の保存は先の行の保存を待たない', order.join() === 'a,x');
    slow.resolve();
    await a;
  }

  // ---- 単体とグループ（対象が重なる）は列で直列、対象は重複させない ----
  {
    const { lanes } = setup();
    const gateRoot = gate();
    const order = [];
    const group = lanes.accept({ rows: ['r', 'k1', 'r'], patches: new Map([['r', { status: 'B' }], ['k1', { status: 'B' }]]),
      coalesceKey: 'status:r', run: async () => { order.push('group'); await gateRoot.promise; } });
    const single = lanes.accept({ rows: ['k1'], patches: new Map([['k1', { status: 'C' }]]), coalesceKey: 'status:k1', run: async () => { order.push('single'); } });
    await tick();
    t.ok('グループの対象を重複させず、重なる単体は後ろに並ぶ', order.join() === 'group' && lanes.entries.size === 2, order.join());
    t.ok('重なった行は後から受理した移動先を見せる', lanes.patchFor('k1').status === 'C' && lanes.patchFor('r').status === 'B');
    gateRoot.resolve();
    await Promise.all([group, single]);
    t.ok('グループの後に単体が保存される', order.join() === 'group,single');
  }

  // ---- 失敗: 後続の移動は続く。後続が無ければ失敗の結果を返す ----
  {
    const { lanes, move } = setup();
    const first = gate();
    const saved = [];
    const a = move('a', 'B', async () => { await first.promise; });
    const b = move('a', 'C', async () => { saved.push('C'); });
    first.reject(new Error('boom'));
    const [ra, rb] = await Promise.all([a, b]);
    t.ok('先の保存が失敗しても列にいた移動は続く', ra.status === 'failed' && ra.error.message === 'boom' && rb.status === 'done' && saved.join() === 'C');
    t.ok('失敗した操作の移動先は外れ、後続の移動先が残る', lanes.patchFor('a').status === 'C');
  }
  {
    const { lanes, move } = setup();
    const r = await move('a', 'B', async () => { throw new Error('nope'); });
    t.ok('後続が無い失敗は表示から外れ、失敗を返す', r.status === 'failed' && lanes.patchFor('a') === undefined && !lanes.isActive('a') && lanes.entries.size === 0);
  }

  // ---- 完了: 保存の応答で印が消え、移動先は取り直しが届くまで保つ ----
  {
    const { lanes, move, bump } = setup();
    const stale = bump();   // 保存の前に始まった取り直し（古い一覧を返しうる）
    await move('a', 'B', async () => {});
    t.ok('保存の応答で移動中の印は消える（一覧の取り直しを待たない）', !lanes.isActive('a') && lanes.entries.size === 0);
    t.ok('保存済みの移動先は取り直しが届くまで保つ', lanes.patchFor('a').status === 'B');
    t.ok('保存の前に始まった取り直しの結果では外さない', lanes.confirm(stale) === false && lanes.patchFor('a').status === 'B');
    t.ok('保存の後に始めた取り直しが届いたら、その一覧に任せる', lanes.confirm(bump()) === true && lanes.patchFor('a') === undefined);
  }

  // ---- 取り直しの途中で次の移動を受理したら、まだ外さない ----
  {
    const { lanes, move, bump } = setup();
    await move('a', 'B', async () => {});
    const gateNext = gate();
    const next = move('a', 'C', () => gateNext.promise);
    t.ok('保存中の行は取り直しで外れない', lanes.confirm(bump()) === false && lanes.patchFor('a').status === 'C');
    gateNext.resolve();
    await next;
  }

  // ---- 先行が失敗して後続が成功: 元に戻す先は、保存されなかった途中の値ではなく、最後に確かだった値 ----
  {
    const { lanes } = setup();
    const first = gate();
    const snap = (id, status) => new Map([[id, { sessionId: id, status, ungrouped: false }]]);
    // A（保存済み）→ B（保存中）→ C（受理。受理時の表示は B の楽観値なので、C の before は B）
    const ab = lanes.accept({ rows: ['a'], patches: new Map([['a', { status: 'B' }]]), before: snap('a', 'A'), coalesceKey: '', run: () => first.promise });
    const bc = lanes.accept({ rows: ['a'], patches: new Map([['a', { status: 'C' }]]), before: snap('a', 'B'), coalesceKey: '', run: async () => {} });
    first.reject(new Error('保存できない'));
    const [rab, rbc] = await Promise.all([ab, bc]);
    t.ok('先行は失敗し、後続は成功する', rab.status === 'failed' && rbc.status === 'done');
    t.ok('後続の元に戻す先は、保存されなかった B ではなく A', rbc.before.get('a').status === 'A');
    // 先行が成功なら、その値が後続の元に戻す先（実際に保存された値）
    const ok = gate();
    const xy = lanes.accept({ rows: ['x'], patches: new Map([['x', { status: 'B' }]]), before: snap('x', 'A'), coalesceKey: '', run: () => ok.promise });
    const yz = lanes.accept({ rows: ['x'], patches: new Map([['x', { status: 'C' }]]), before: snap('x', 'B'), coalesceKey: '', run: async () => {} });
    ok.resolve();
    const [, ryz] = await Promise.all([xy, yz]);
    t.ok('先行が成功した後続は、先行が保存した値へ戻す', ryz.before.get('x').status === 'B');
    // 先行が 2 つ続けて失敗しても、最初に確かだった値へ寄る
    const g1 = gate(), g2 = gate();
    const o1 = lanes.accept({ rows: ['m'], patches: new Map([['m', { status: 'B' }]]), before: snap('m', 'A'), coalesceKey: '', run: () => g1.promise });
    const o2 = lanes.accept({ rows: ['m'], patches: new Map([['m', { status: 'C' }]]), before: snap('m', 'B'), coalesceKey: '', run: () => g2.promise });
    const o3 = lanes.accept({ rows: ['m'], patches: new Map([['m', { status: 'D' }]]), before: snap('m', 'C'), coalesceKey: '', run: async () => {} });
    g1.reject(new Error('1')); await tick(); g2.reject(new Error('2'));
    const [, , r3] = await Promise.all([o1, o2, o3]);
    t.ok('先行が続けて失敗しても、元に戻す先は最後に確かだった A', r3.before.get('m').status === 'A');
  }

  // ---- 失敗した操作が動かした項目だけ引き継ぐ・複数の行をまとめた失敗は確かでない印を付ける ----
  {
    const { lanes } = setup();
    const snap = (id, status, ungrouped = false) => new Map([[id, { sessionId: id, status, ungrouped }]]);
    // 失敗した操作は status だけ動かした。後続の操作前の値の ungrouped は、後続自身の値のまま（古い値で上書きしない）
    const g = gate();
    const first = lanes.accept({ rows: ['a'], patches: new Map([['a', { status: 'B' }]]), before: snap('a', 'A', false), coalesceKey: '', run: () => g.promise });
    const second = lanes.accept({ rows: ['a'], patches: new Map([['a', { ungrouped: true }]]), before: snap('a', 'B', true), coalesceKey: '', run: async () => {} });
    g.reject(new Error('保存できない'));
    const [, r2] = await Promise.all([first, second]);
    t.ok('失敗した操作が動かした項目（status）だけ引き継ぐ', r2.before.get('a').status === 'A');
    t.ok('失敗した操作と関係のない項目（ungrouped）は後続の値のまま', r2.before.get('a').ungrouped === true);
    t.ok('1 行だけの操作の失敗は、保存されていないと見て確かな値として引き継ぐ', !r2.before.get('a').uncertain);

    // 複数の行をまとめた操作の失敗は、どの行まで保存できたか分からない
    const g2 = gate();
    const rows = ['r', 'c'];
    const group = lanes.accept({ rows, patches: new Map(rows.map((id) => [id, { status: 'B' }])), before: new Map([...snap('r', 'A'), ...snap('c', 'A')]), coalesceKey: '', run: () => g2.promise });
    const follow = lanes.accept({ rows, patches: new Map(rows.map((id) => [id, { status: 'C' }])), before: new Map([...snap('r', 'B'), ...snap('c', 'B')]), coalesceKey: 'x', run: async () => {} });
    g2.reject(new Error('一部だけ保存できた'));
    const [, rf] = await Promise.all([group, follow]);
    t.ok('複数の行をまとめた操作の失敗は、後続の戻し先に確かでない印を付ける（全行）', rf.before.get('r').uncertain === true && rf.before.get('c').uncertain === true);
    t.ok('確かでない印がついても、失敗した操作の前の値は引き継ぐ（呼び手が書くかを決める）', rf.before.get('r').status === 'A');

    // 確かでない印は後続へ引き継がれる
    const g3 = gate(), g4 = gate();
    const o1 = lanes.accept({ rows: ['p', 'q'], patches: new Map([['p', { status: 'B' }], ['q', { status: 'B' }]]), before: new Map([...snap('p', 'A'), ...snap('q', 'A')]), coalesceKey: '', run: () => g3.promise });
    const o2 = lanes.accept({ rows: ['p'], patches: new Map([['p', { status: 'C' }]]), before: snap('p', 'B'), coalesceKey: '', run: () => g4.promise });
    const o3 = lanes.accept({ rows: ['p'], patches: new Map([['p', { status: 'D' }]]), before: snap('p', 'C'), coalesceKey: '', run: async () => {} });
    g3.reject(new Error('1')); await tick(); g4.reject(new Error('2'));
    const [, , r3] = await Promise.all([o1, o2, o3]);
    t.ok('確かでない印は、続けて失敗した後続にも残る', r3.before.get('p').uncertain === true);
  }

  // ---- 描き直しが例外を投げても、列の持ち場と結果の約束は解ける ----
  {
    const errors = [];
    let boom = false;
    const { lanes, move } = setup({ onChange: () => { if (boom) throw new Error('描き直しの例外'); }, onError: (e) => errors.push(e.message) });
    boom = true;
    const first = gate();
    const a = move('a', 'B', () => first.promise);
    const b = move('a', 'C', async () => {});
    first.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    t.ok('描き直しが例外でも、結果の約束は解ける', ra.status === 'superseded' || ra.status === 'done');
    t.ok('例外は握りつぶさず onError へ渡す', errors.includes('描き直しの例外'));
    t.ok('持ち場は空き、後続は保存まで進む', rb.status === 'done' && !lanes.isActive('a'));
    await lanes.idle('a');
    t.ok('すべて決着すれば idle が解ける', true);
  }

  // ---- idle: 受理済みの移動がすべて決着してから解ける（削除はこの後に始める） ----
  {
    const { lanes, move } = setup();
    const g = gate();
    const a = move('a', 'B', () => g.promise);
    const b = move('a', 'C', async () => {});
    let idle = false;
    lanes.idle('a').then(() => { idle = true; });
    await tick();
    t.ok('保存中は idle が解けない', idle === false);
    g.resolve();
    await Promise.all([a, b]);
    await tick();
    t.ok('受理済みの移動がすべて終わったら解ける', idle === true);
    t.ok('移動の無い行は、すぐ解ける', await Promise.race([lanes.idle('none').then(() => true), tick().then(() => false)]));
  }

  // ---- 印: 150ms を越えるまで見せない。予約があれば先に見せる ----
  {
    const { lanes, move, timers } = setup();
    const hold = gate();
    const a = move('a', 'B', () => hold.promise);
    t.ok('受理してすぐは移動中の字を出さない', lanes.entries.get('a').visible === false && lanes.entries.get('a').text === 'moving');
    timers.splice(0).forEach((fn) => fn());
    t.ok('150ms を越えたら出す', lanes.entries.get('a').visible === true);
    hold.resolve();
    await a;
    t.ok('終わったら印と待ちの時計を片づける', lanes.entries.size === 0 && timers.length === 0);
  }
}
