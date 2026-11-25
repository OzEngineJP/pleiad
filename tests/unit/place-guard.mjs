// 場所ごとの見張り（core/place-guard.mjs。ADR 0352）: 止めても終われない子の数・時間切れが続いた後の休み・同じ種類の裏の作業を 1 本ずつ。
// 時計と pid の生死は差し込む（待たずに確かめる）。git は呼ばない。LLM は呼ばない。
import { createPlaceGuard, placeKey, REST_LADDER_MS, REST_AFTER_TIMEOUTS } from '../../core/place-guard.mjs';

export const name = 'place-guard';
export const title = '場所の見張り: 止めても終われない子で BUSY・時間切れが続くと REST（自動で戻る）・同じ種類の裏の作業は 1 本ずつ（join・trailing・止める）';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

export default async function (t) {
  // ---- 場所の鍵と別名
  t.ok('placeKey: 区切りと末尾の / をそろえる', placeKey('C:\\a\\b\\') === placeKey('C:/a/b') && placeKey('') === '');
  {
    const g = createPlaceGuard();
    g.alias('C:/repo/sub', 'C:/repo');
    t.ok('alias: サブフォルダーへの問い合わせは、ルートの場所として数える', g.placeOf('C:\\repo\\sub') === placeKey('C:/repo') && g.placeOf('C:/other') === placeKey('C:/other'));
  }

  // ---- ① 止めても終われない子（BUSY）。子が終われば自動で戻る
  {
    let clock = 1_000_000;
    const living = new Set();
    const g = createPlaceGuard({ now: () => clock, isAlive: (pid) => living.has(pid) });
    const p = 'repo';
    t.ok('何も無い場所は止めない', g.blocked(p) === null && g.alive(p) === 0);
    const ended = defer();
    living.add(4242);
    g.leftover(p, { pid: 4242, ended: ended.promise });
    t.ok('生きている子がある間は BUSY（読み・撮影とも）', g.blocked(p) === 'BUSY' && g.blocked(p, 'heavy') === 'BUSY' && g.alive(p) === 1);
    t.ok('別の場所は止めない', g.blocked('other') === null);
    ended.resolve();
    await tick();
    t.ok('子が本当に終われば（ended）BUSY は自動で解ける', g.blocked(p) === null && g.alive(p) === 0);
    // ended を取りこぼしても、pid が居なくなっていれば解ける（生死の確認が保険）
    living.add(777);
    g.leftover(p, { pid: 777, ended: new Promise(() => {}) });
    t.ok('ended が来なくても、pid が生きている間は BUSY', g.blocked(p) === 'BUSY');
    living.delete(777);
    t.ok('pid が居なくなれば BUSY は解ける', g.blocked(p) === null);
    g.leftover(p, { pid: 0, ended: null });
    t.ok('pid の無い通知は数えない', g.alive(p) === 0);
  }

  // ---- ② 時間切れが続くと休む。1 度でも普通に終われば戻る。休みは時間で解ける
  {
    let clock = 5_000_000;
    const g = createPlaceGuard({ now: () => clock, isAlive: () => false });
    const p = 'repo';
    const [r1, r2, r3, r4] = REST_LADDER_MS;
    t.ok('休みは 30 秒・60 秒・120 秒・300 秒の段（2 回目の時間切れから）', REST_AFTER_TIMEOUTS === 2 && r1 === 30_000 && r2 === 60_000 && r3 === 120_000 && r4 === 300_000);
    g.timedOut(p, 'light', clock - 100);
    t.ok('1 回の時間切れでは休まない（ウイルス検査・初回の走査などの一時の遅れ）', g.blocked(p) === null);
    clock += 1_000;
    g.timedOut(p, 'light', clock - 100);
    t.ok('連続 2 回で REST', g.blocked(p) === 'REST' && g.snapshot(p).light.restUntil === clock + r1);
    clock += r1 - 1;
    t.ok('休みの間は止める', g.blocked(p) === 'REST');
    clock += 2;
    t.ok('休みが過ぎれば自動で戻る', g.blocked(p) === null);
    clock += 10;
    g.timedOut(p, 'light', clock - 100);
    t.ok('戻った後にまた時間切れなら、休みは次の段（60 秒）', g.blocked(p) === 'REST' && g.snapshot(p).light.restUntil === clock + r2);
    clock += r2 + 1;
    g.timedOut(p, 'light', clock - 100);
    clock += r3 + 1;
    g.timedOut(p, 'light', clock - 100);
    clock += r4 + 1;
    g.timedOut(p, 'light', clock - 100);
    t.ok('段は 300 秒で止まる（それより長くしない）', g.snapshot(p).light.restUntil === clock + r4);
    g.completed(p, 'light');
    t.ok('1 度でも時間切れにならずに終われば、休みも連続の数も戻る', g.blocked(p) === null && g.snapshot(p).light.consecutive === 0);
    g.timedOut(p, 'light', clock - 100);
    t.ok('戻った後は 1 回目から数え直す', g.blocked(p) === null && g.snapshot(p).light.consecutive === 1);
  }
  {
    // 同じ詰まりで一斉に時間切れになった分は 1 回に数える（7 つの会話が同時に頼んだ 7 本が、連続 7 回にならない）
    let clock = 9_000_000;
    const g = createPlaceGuard({ now: () => clock, isAlive: () => false });
    const started = clock;
    clock += 4_000;
    g.timedOut('repo', 'light', started);
    for (let i = 0; i < 6; i++) g.timedOut('repo', 'light', started);
    t.ok('同時に始めた分の時間切れは 1 回に数える（休まない）', g.snapshot('repo').light.consecutive === 1 && g.blocked('repo') === null);
    clock += 4_000;
    g.timedOut('repo', 'light', clock - 4_000);
    t.ok('その後に始めたものが時間切れなら、2 回目として数える', g.blocked('repo') === 'REST');
  }
  {
    // 撮影（heavy）の時間切れは、状態の確認（light）を休ませない。light が休んでいるなら撮影も止める
    let clock = 3_000_000;
    const g = createPlaceGuard({ now: () => clock, isAlive: () => false });
    g.timedOut('repo', 'heavy', clock - 10);
    clock += 100;
    g.timedOut('repo', 'heavy', clock - 10);
    t.ok('撮影が連続して時間切れ: 撮影は REST、状態の確認は動く', g.blocked('repo', 'heavy') === 'REST' && g.blocked('repo', 'light') === null);
    g.completed('repo', 'light');
    t.ok('読みが普通に終われても、撮影の休みは残る', g.blocked('repo', 'heavy') === 'REST');
    g.completed('repo', 'heavy');
    t.ok('撮影が普通に終われば戻る', g.blocked('repo', 'heavy') === null);
    clock += 10_000;
    g.timedOut('other', 'light', clock - 10);
    clock += 100;
    g.timedOut('other', 'light', clock - 10);
    t.ok('読みが休んでいる間は、撮影も止める', g.blocked('other', 'heavy') === 'REST' && g.blocked('other', 'light') === 'REST');
  }

  // ---- ③ 同じ種類の裏の作業は 1 本ずつ
  {
    const g = createPlaceGuard();
    let runs = 0;
    const gate = defer();
    const work = async () => { runs++; await gate.promise; return `result-${runs}`; };
    const a = g.coalesce('status:repo', work);
    const b = g.coalesce('status:repo', work);
    const c = g.coalesce('status:repo', work, { mode: 'join' });
    await tick();
    gate.resolve();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    t.ok('join: 走っているものに相乗りする（作業は 1 回）', runs === 1 && ra === 'result-1' && rb === 'result-1' && rc === 'result-1', String(runs));
    const d = await g.coalesce('status:repo', work);
    t.ok('終わった後の呼び出しは、新しく走る', runs === 2 && d === 'result-2');
    const other = await g.coalesce('status:other', work);
    t.ok('鍵が違えば別の仕事', runs === 3 && other === 'result-3');
  }
  {
    // trailing: 走っているものの次の 1 回を共有する（走り始めた後に頼んだ側へ、前の結果は渡さない）
    const g = createPlaceGuard();
    let runs = 0;
    const gates = [defer(), defer(), defer()];
    const work = async () => { const n = ++runs; await gates[n - 1].promise; return `result-${n}`; };
    const first = g.coalesce('snapshot:repo', work, { mode: 'trailing' });
    await tick();
    const second = g.coalesce('snapshot:repo', work, { mode: 'trailing' });
    const third = g.coalesce('snapshot:repo', work, { mode: 'trailing' });
    const fourth = g.coalesce('snapshot:repo', work, { mode: 'trailing' });
    await tick();
    t.ok('trailing: 走っている間は、次の回を始めない（1 本ずつ）', runs === 1);
    gates[0].resolve();
    await tick(); await tick();
    t.ok('trailing: 前のものが終わってから、次の 1 回を走らせる', runs === 2);
    gates[1].resolve();
    const [r1, r2, r3, r4] = await Promise.all([first, second, third, fourth]);
    t.ok('trailing: 走っていたものの結果は最初の 1 人だけ。後から頼んだ 3 人は次の 1 回の結果を共有する（合計 2 回）',
      runs === 2 && r1 === 'result-1' && r2 === 'result-2' && r3 === 'result-2' && r4 === 'result-2', JSON.stringify([runs, r1, r2, r3, r4]));
    // 空いてから頼めば、すぐ走る
    const gate3 = gates[2];
    gate3.resolve();
    t.ok('trailing: 何も走っていなければ、すぐ走る', await g.coalesce('snapshot:repo', work, { mode: 'trailing' }) === 'result-3');
  }
  {
    // 待つ側が全員諦めたら、走っている仕事を止める。1 人だけ諦めても止めない（もう 1 人が待っている）
    const g = createPlaceGuard();
    let signalSeen = null;
    const gate = defer();
    const work = async (signal) => { signalSeen = signal; await gate.promise; return 'done'; };
    const ca = new AbortController(), cb = new AbortController();
    const a = g.coalesce('k', work, { signal: ca.signal });
    const b = g.coalesce('k', work, { signal: cb.signal });
    await tick();
    ca.abort();
    t.ok('1 人だけ諦めた側は null で抜け、仕事は止まらない', await a === null && signalSeen.aborted === false);
    cb.abort();
    t.ok('待つ側が全員諦めたら、走っている仕事の signal が止まる', await b === null && signalSeen.aborted === true);
    gate.resolve();
    await tick();
    const fresh = await g.coalesce('k', async () => 'again');
    t.ok('止めた後の呼び出しは、新しく走る', fresh === 'again');
  }
  {
    // 始まる前の次の回（trailing）の待つ側が全員諦めたら、始めない
    const g = createPlaceGuard();
    let runs = 0;
    const gate = defer();
    const work = async () => { runs++; await gate.promise; return runs; };
    const running = g.coalesce('k', work, { mode: 'trailing' });
    const ctl = new AbortController();
    const waiting = g.coalesce('k', work, { mode: 'trailing', signal: ctl.signal });
    await tick();
    ctl.abort();
    t.ok('次の回を待つ側が諦めたら null', await waiting === null);
    gate.resolve();
    await running;
    await tick(); await tick();
    t.ok('待つ側の居ない次の回は始めない', runs === 1, String(runs));
  }
  {
    // 作業が投げても、待つ側みんなに伝わり、次の呼び出しは動く
    const g = createPlaceGuard();
    const failing = g.coalesce('k', async () => { throw new Error('boom'); });
    let caught = null;
    try { await failing; } catch (error) { caught = error; }
    t.ok('作業の失敗は呼び出し側へ伝わる', caught?.message === 'boom');
    t.ok('失敗の後も、次の呼び出しは動く', await g.coalesce('k', async () => 'ok') === 'ok');
  }
  {
    const g = createPlaceGuard({ isAlive: () => true });
    g.leftover('repo', { pid: 1, ended: new Promise(() => {}) });
    g.timedOut('repo', 'light', 0);
    g.alias('a/b', 'a');
    g.reset();
    t.ok('reset: 数え・休み・別名を全部戻す', g.blocked('repo') === null && g.placeOf('a/b') === placeKey('a/b'));
  }
}
