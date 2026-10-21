import assert from 'node:assert/strict';
import { createSlotLimits, MAX_BACKOFF_MS, MEMORY_MS, MIN_HOLD_MS } from '../../core/slot-limits.mjs';

export const name = 'slot-limits';
export const title = 'Slots stopped by short provider limits stay held, and a recurrence just after the reset extends the hold';

export default async function test(t) {
  let clock = 1_792_425_600_000;
  const slots = createSlotLimits({ now: () => clock });
  const devin = { backend: 'devin', model: 'swe-2-high', account: null };
  const get = () => slots.get(devin.backend, devin.model, devin.account);

  const first = slots.record({ ...devin, resetsAt: clock + 12_000 });
  assert.equal(first.until, clock + MIN_HOLD_MS);
  assert.equal(first.strikes, 0);
  t.ok('「12 seconds」の上限でも最低 1 分は同じ枠へ戻さない', get()?.until === clock + MIN_HOLD_MS, JSON.stringify(first));

  const long = createSlotLimits({ now: () => clock });
  const tenHours = long.record({ ...devin, resetsAt: clock + 10 * 3600_000 });
  t.ok('告げられた見込みが最低の保留より長ければ、見込みまで止める', tenHours.until === clock + 10 * 3600_000);

  clock += 30_000;
  const parallel = slots.record({ ...devin, resetsAt: clock + 45_000 });
  t.ok('保留の間に並べて走っていた子も止まったら、遅い方（その時点から最低 1 分）に合わせ、延ばす回数には数えない',
    parallel.until === clock + MIN_HOLD_MS && parallel.strikes === 0 && parallel.since === first.since, JSON.stringify(parallel));

  // 見込みを過ぎた直後に、同じ枠がまた止まる（Devin の見込みは下限で、試すたびに後ろへずれる）
  clock = parallel.until + 1000;
  assert.equal(get(), null);
  t.ok('見込みを過ぎたら自動の振り分けに戻す', slots.list('devin').length === 0);
  const again = slots.record({ ...devin, resetsAt: clock + 5000 });
  t.ok('見込みの直後の再発は、前回の保留の 2 倍に延ばす', again.strikes === 1 && again.until === clock + parallel.hold * 2, JSON.stringify({ again, prevHold: parallel.hold }));
  clock = again.until + 1000;
  const third = slots.record({ ...devin, resetsAt: clock + 5000 });
  t.ok('続けて再発すると、さらに 2 倍に延ばす', third.strikes === 2 && third.until - clock === again.hold * 2, JSON.stringify(third));
  for (let i = 0; i < 10; i++) { clock = get()?.until ?? clock; clock += 1000; slots.record({ ...devin, resetsAt: clock + 5000 }); }
  t.ok('延ばす長さは 30 分で頭打ち', get().until - clock === MAX_BACKOFF_MS, String(get().until - clock));

  clock = get().until + MEMORY_MS + 1000;
  const fresh = slots.record({ ...devin, resetsAt: clock + 5000 });
  t.ok('長く空いた後の上限は、初めての上限として扱う', fresh.strikes === 0 && fresh.until === clock + MIN_HOLD_MS);

  slots.clear(devin.backend, devin.model, devin.account);
  clock += 1000;
  const afterOk = slots.record({ ...devin, resetsAt: clock + 5000 });
  t.ok('同じ枠のターンが通ったら、延ばす回数も戻す', afterOk.strikes === 0 && afterOk.until === clock + MIN_HOLD_MS);

  const unknown = slots.record({ backend: 'devin', model: 'swe-1-6', account: 'work', resetsAt: null });
  clock += 24 * 3600_000;
  t.ok('解除時刻の分からない上限は、同じ枠のターンが通るまで止めたまま', unknown.until === null && slots.get('devin', 'swe-1-6', 'work')?.until === null);
  t.ok('枠はモデルとアカウントごとに分ける', slots.get('devin', 'swe-1-6', null) === null && slots.get('devin', 'swe-1-6', 'work') !== null);
  const known = slots.record({ backend: 'devin', model: 'swe-1-6', account: 'work', resetsAt: clock + 5 * 60_000 });
  t.ok('分からない保留の後に解除の見込みが届いたら、見込みまでにする', known.until === clock + 5 * 60_000 && slots.get('devin', 'swe-1-6', 'work')?.until === clock + 5 * 60_000, JSON.stringify(known));
  slots.clear('devin', 'swe-1-6', 'work');
  t.ok('通ったら外す', slots.get('devin', 'swe-1-6', 'work') === null);

  t.ok('告げられた見込みがもう過ぎた記録は覚えない', slots.record({ backend: 'grok', model: null, resetsAt: clock - 1 }) === null && slots.list('grok').length === 0);
  slots.record({ backend: 'grok', model: null, resetsAt: clock + 120_000 });
  t.ok('一覧はエージェントで絞れる', slots.list('grok').length === 1 && slots.list('grok')[0].until === clock + 120_000 && slots.list('devin').length === 0);
}
