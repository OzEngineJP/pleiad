// 右の欄が動いている間は列の幅に反応する処理を止め、止まったときに 1 度だけやり直す（web/panel-moving.mjs）
import { whileStill, announceSettled, rightPanelMoving, RIGHT_MOVING_CLASS } from '../../web/panel-moving.mjs';

export const name = 'panel-moving';
export const title = '右の欄の動きの間は幅に反応する処理を止め、止まったら 1 度だけやり直す';

export default async function(t) {
  const target = new EventTarget();
  const classes = new Set();
  const frames = [];
  const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame };
  globalThis.document = Object.assign(target, { body: { classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) } } });
  globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  const nextFrame = () => { const run = frames.splice(0); for (const fn of run) fn(); };
  const flush = () => new Promise(resolve => queueMicrotask(() => queueMicrotask(resolve)));
  try {
    let runs = 0, replays = 0;
    const guarded = whileStill(() => { runs++; }, () => { replays++; });

    guarded();
    t.ok('動いていないときは呼ばれたとおりにすぐ走る', runs === 1 && replays === 0, `runs=${runs} replays=${replays}`);

    classes.add(RIGHT_MOVING_CLASS);
    t.ok('動いている印が付いている間は moving と読める', rightPanelMoving() === true);
    for (let i = 0; i < 40; i++) guarded();
    t.ok('動いている間は 40 回呼ばれても走らない', runs === 1 && replays === 0, `runs=${runs} replays=${replays}`);

    classes.delete(RIGHT_MOVING_CLASS);
    announceSettled();
    await flush();
    t.ok('止まった合図でやり直しが 1 度だけ走る', runs === 1 && replays === 1, `runs=${runs} replays=${replays}`);

    // 合図と同じコマで届く ResizeObserver は、落ち着いた幅で済んでいるので走らせない
    guarded();
    t.ok('合図と同じコマの後ろで届いた呼び出しは重ねて走らない', runs === 1 && replays === 1, `runs=${runs} replays=${replays}`);
    nextFrame();
    guarded();
    t.ok('次のコマからは、呼ばれたとおりに走る', runs === 2, `runs=${runs}`);

    // 動いている間に一度も呼ばれなければ、止まってもやり直さない
    announceSettled(); await flush();
    t.ok('動いている間に呼ばれていなければ、止まってもやり直さない', replays === 1, `replays=${replays}`);

    // 止まった直後に逆へ折り返したら、合図を出さない（次に止まったときに出す）
    classes.add(RIGHT_MOVING_CLASS); guarded();
    classes.delete(RIGHT_MOVING_CLASS);
    announceSettled();
    classes.add(RIGHT_MOVING_CLASS);
    await flush();
    t.ok('止まった直後に折り返したら合図は出ない', replays === 1, `replays=${replays}`);
    classes.delete(RIGHT_MOVING_CLASS);
    announceSettled(); await flush();
    t.ok('次に止まったときに 1 度だけやり直す', replays === 2, `replays=${replays}`);
    nextFrame();

    // 引数は走るときにそのまま渡る
    let seen = null;
    const withArgs = whileStill((...args) => { seen = args; });
    withArgs(1, 2);
    t.ok('止まっているときは引数がそのまま渡る', JSON.stringify(seen) === '[1,2]', JSON.stringify(seen));
  } finally {
    globalThis.document = saved.document;
    globalThis.requestAnimationFrame = saved.raf;
  }
}
