// 右の欄が動いている間は列の幅に反応する処理を止め、止まったときに 1 度だけやり直す（web/panel-moving.mjs）
import { whileStill, announceSettled, rightPanelMoving, stillWatchers, RIGHT_MOVING_CLASS } from '../../web/panel-moving.mjs';

export const name = 'panel-moving';
export const title = '右の欄の動きの間は幅に反応する処理を止め、止まったら 1 度だけやり直す';

export default async function(t) {
  const target = new EventTarget();
  const classes = new Set();
  const frames = [];
  const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.document = Object.assign(target, { body: { classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) } } });
  let serial = 0;
  globalThis.requestAnimationFrame = fn => { frames.push([++serial, fn]); return serial; };
  globalThis.cancelAnimationFrame = id => { const i = frames.findIndex(([n]) => n === id); if (i >= 0) frames.splice(i, 1); };
  const nextFrame = () => { const run = frames.splice(0); for (const [, fn] of run) fn(); };
  const flush = () => new Promise(resolve => queueMicrotask(() => queueMicrotask(resolve)));
  // 合図は止まったコマの次のコマで走る: 合図を出し、マイクロタスクが済んでから次のコマへ進める
  const settle = async () => { classes.delete(RIGHT_MOVING_CLASS); announceSettled(); await flush(); nextFrame(); };
  try {
    let runs = 0, replays = 0;
    const guarded = whileStill(() => { runs++; }, { replay: () => { replays++; } });

    guarded();
    t.ok('動いていないときは呼ばれたとおりにすぐ走る', runs === 1 && replays === 0, `runs=${runs} replays=${replays}`);

    classes.add(RIGHT_MOVING_CLASS);
    t.ok('動いている印が付いている間は moving と読める', rightPanelMoving() === true);
    for (let i = 0; i < 40; i++) guarded();
    t.ok('動いている間は 40 回呼ばれても走らない', runs === 1 && replays === 0, `runs=${runs} replays=${replays}`);

    classes.delete(RIGHT_MOVING_CLASS);
    announceSettled();
    await flush();
    t.ok('止まった合図の中（ばねの最後のコマ）ではまだやり直さない', replays === 0, `replays=${replays}`);
    nextFrame();
    t.ok('止まった合図の次のコマでやり直しが 1 度だけ走る', runs === 1 && replays === 1, `runs=${runs} replays=${replays}`);

    // 合図の後・次のコマの前に届く呼び出し（止まったコマの ResizeObserver）は捨てず、やり直しに束ねる
    classes.add(RIGHT_MOVING_CLASS); guarded(); classes.delete(RIGHT_MOVING_CLASS);
    announceSettled(); await flush();
    guarded(); guarded();
    t.ok('合図の後・次のコマの前に届いた呼び出しは、その場では走らない', runs === 1 && replays === 1, `runs=${runs} replays=${replays}`);
    nextFrame();
    t.ok('それはやり直しに束ねられて、1 度だけ走る', runs === 1 && replays === 2, `runs=${runs} replays=${replays}`);
    guarded();
    t.ok('そのあとは呼ばれたとおりに走る（以前の守りのように捨てない）', runs === 2 && replays === 2, `runs=${runs} replays=${replays}`);
    t.ok('次のコマの後は、また呼ばれたとおりに走る', (guarded(), runs === 3), `runs=${runs}`);
    // ページが裏に回って rAF が止まっても、時間で拾う
    classes.add(RIGHT_MOVING_CLASS); guarded(); classes.delete(RIGHT_MOVING_CLASS);
    announceSettled(); await flush();
    await new Promise(resolve => setTimeout(resolve, 250));
    t.ok('rAF が回らなくても、時間でやり直しが走る', replays === 3, `replays=${replays}`);
    frames.splice(0);

    // 動いている間に一度も呼ばれなければ、止まってもやり直さない
    await settle();
    t.ok('動いている間に呼ばれていなければ、止まってもやり直さない', replays === 3, `replays=${replays}`);

    // 止まった直後に逆へ折り返したら、合図を出さない（次に止まったときに出す）
    classes.add(RIGHT_MOVING_CLASS); guarded();
    classes.delete(RIGHT_MOVING_CLASS);
    announceSettled();
    classes.add(RIGHT_MOVING_CLASS);
    await flush(); nextFrame();
    t.ok('止まった直後に折り返したら合図は出ない', replays === 3, `replays=${replays}`);
    await settle();
    t.ok('次に止まったときに 1 度だけやり直す', replays === 4, `replays=${replays}`);

    // 合図が出てから次のコマまでの間に折り返したら、そのコマでは走らせず、次に止まったときに回す
    classes.add(RIGHT_MOVING_CLASS); guarded();
    classes.delete(RIGHT_MOVING_CLASS); announceSettled(); await flush();
    classes.add(RIGHT_MOVING_CLASS);
    nextFrame();
    t.ok('合図の後に折り返したら、次のコマでは走らない', replays === 4, `replays=${replays}`);
    await settle();
    t.ok('折り返しのあとに止まったら、取りこぼさずやり直す', replays === 5, `replays=${replays}`);

    // 引数は走るときにそのまま渡る
    let seen = null;
    const withArgs = whileStill((...args) => { seen = args; });
    withArgs(1, 2);
    t.ok('止まっているときは引数がそのまま渡る', JSON.stringify(seen) === '[1,2]', JSON.stringify(seen));

    // 止まった合図の受け口は document に 1 本。呼ぶたびに増えない・signal で外れて、外れた後は走らない
    let listeners = 0;
    const addOriginal = target.addEventListener.bind(target);
    target.addEventListener = (type, ...rest) => { if (type === 'right-panel-settled') listeners++; return addOriginal(type, ...rest); };
    const before = stillWatchers();
    const owners = [];
    for (let i = 0; i < 50; i++) {
      const life = new AbortController();
      let ran = 0;
      owners.push({ life, count: () => ran, call: whileStill(() => { ran++; }, { signal: life.signal }) });
    }
    t.ok('whileStill を 50 回作っても、document のリスナーは増えない', listeners === 0, `listeners=${listeners}`);
    t.ok('作った口は見張りの数に入る', stillWatchers() === before + 50, `${stillWatchers()} vs ${before}`);
    classes.add(RIGHT_MOVING_CLASS);
    for (const owner of owners) owner.call();
    for (const owner of owners.slice(0, 25)) owner.life.abort();   // 半分は持ち主が閉じた
    t.ok('閉じた持ち主の分は見張りから外れる', stillWatchers() === before + 25, `${stillWatchers()} vs ${before}`);
    await settle();
    const ranClosed = owners.slice(0, 25).reduce((n, owner) => n + owner.count(), 0);
    const ranOpen = owners.slice(25).reduce((n, owner) => n + owner.count(), 0);
    t.ok('閉じた持ち主の分は、止まっても走らない', ranClosed === 0, `ran=${ranClosed}`);
    t.ok('閉じていない分は、止まったときに 1 度ずつ走る', ranOpen === 25, `ran=${ranOpen}`);
    owners[0].call();
    t.ok('閉じた後は、動いていないときに呼んでも走らない', owners[0].count() === 0);
    for (const owner of owners.slice(25)) owner.life.abort();
    t.ok('全部閉じたら見張りの数は元へ戻る', stillWatchers() === before, `${stillWatchers()} vs ${before}`);
    const dead = new AbortController(); dead.abort();
    whileStill(() => {}, { signal: dead.signal });
    t.ok('閉じた後の signal を渡しても見張りは増えない', stillWatchers() === before, `${stillWatchers()} vs ${before}`);
  } finally {
    globalThis.document = saved.document;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
  }
}
