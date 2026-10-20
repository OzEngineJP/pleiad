import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

export const name = 'refresh-batch';
export const title = '会話一覧の更新: 起動時の重複と他会話の連続イベントをまとめる';

export default async function (t) {
  const source = await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('let refreshRun ='), source.indexOf('let refreshVersion ='));
  const runs = [], timers = [];
  const context = vm.createContext({
    runRefresh: () => new Promise((resolve) => runs.push(resolve)),
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); },
  });
  vm.runInContext(code, context);
  const call = (name) => vm.runInContext(`${name}()`, context);

  const first = call('refresh');
  assert.equal(vm.runInContext('refresh({ sharePending: true })', context), first);
  assert.equal(runs.length, 1, '一覧の応答前の重複は一度だけ取得する');
  runs.shift()();
  await first;
  t.ok('起動時の重複した取り直しは一度だけ', true);

  const batched = call('scheduleRefresh');
  assert.equal(call('scheduleRefresh'), batched);
  assert.equal(call('scheduleRefresh'), batched);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 400);
  assert.equal(runs.length, 0, '他会話のイベント直後はまだ取得しない');
  timers.shift().fn();
  assert.equal(runs.length, 1);
  runs.shift()();
  await batched;
  t.ok('他会話の連続イベントは 400ms に一度だけ', true);

  const active = call('refresh');
  const newer = call('refresh');
  assert.notEqual(newer, active, '自分の操作後は応答前でも次の写しを待つ');
  assert.equal(call('refresh'), newer);
  runs.shift()();
  await active;
  await Promise.resolve();
  assert.equal(runs.length, 1);
  runs.shift()();
  await newer;
  t.ok('自分の操作後の変更は一度だけ再取得する', true);

  const alreadyRunning = call('refresh');
  const eventDuringRun = call('scheduleRefresh');
  timers.shift().fn();
  assert.equal(runs.length, 1, '取得中の古い写しは共有しない');
  runs.shift()();
  await alreadyRunning;
  await Promise.resolve();
  assert.equal(runs.length, 1, '他会話の変更を次の写しで取得する');
  runs.shift()();
  await eventDuringRun;
  t.ok('取得の途中に届いた他会話の変更も取りこぼさない', true);

  // ---- 一覧だけを待つ呼び手（新しい会話の作成）: 補足の取り直しを待たず、本体の失敗も握る ----
  {
    const passes = [];
    const ctx = vm.createContext({
      runRefresh: (listed) => new Promise((resolve, reject) => passes.push({ listed, resolve, reject })),
      setTimeout: () => {},
    });
    vm.runInContext(code, ctx);
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const listedAfterFail = vm.runInContext('refresh({ sharePending: true, listedOnly: true })', ctx);
      passes[0].reject(new Error('補足の取得に失敗'));
      await listedAfterFail;
      await new Promise((r) => setTimeout(r, 20));
      t.ok('一覧だけを待つ呼び手でも、本体の失敗で unhandled rejection を出さない', unhandled.length === 0);

      // 前の取り直しが一覧を載せ終え、補足（syncTopbar）の遅い取得中。新しい呼び出しはそれを待たない
      const slowTopbar = vm.runInContext('refresh()', ctx);
      passes[1].listed();   // 一覧を載せ終えた（補足は返らないまま）
      await new Promise((r) => setTimeout(r, 0));
      const created = vm.runInContext('refresh({ sharePending: true, listedOnly: true })', ctx);
      await new Promise((r) => setTimeout(r, 0));
      t.ok('前の取り直しが補足を待っている間でも、新しい一覧の取り直しをすぐ始める', passes.length === 3);
      passes[2].listed();
      const raced = await Promise.race([created.then(() => 'listed'), new Promise((r) => setTimeout(() => r('waiting'), 50))]);
      t.ok('補足が遅いままでも、一覧を載せ終えたら listedOnly の呼び手は先へ進む', raced === 'listed');
      const third = vm.runInContext('refresh()', ctx);   // 一覧を取っている最中の取り直し
      await new Promise((r) => setTimeout(r, 0));
      passes[1].resolve();   // 一番前の取り直しが、いまの取り直しより後に終わる
      await slowTopbar;
      t.ok('前の取り直しが後から終わっても、いま一覧を取っている取り直しの状態を壊さない', vm.runInContext('refreshRun', ctx) !== null && passes.length === 4);
      passes[2].resolve();
      passes[3].listed(); passes[3].resolve();
      await third;
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }
}
