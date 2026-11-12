// 動きの共通の口（web/motion.mjs）: ばねの式・トークンの読み・減らす設定・rAF の無い環境
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSpring, solveSpring, springPreset, reducedMotion, setReducedMotion, motionClock, SPRING_DEFAULTS } from '../../web/motion.mjs';

export const name = 'motion';
export const title = '動きの口: ばねの式・途中で逆向き・トークン・動きを減らす設定・rAF の無い環境でその場で替わる';

export default async function (t) {
  const hadRoot = 'documentElement' in globalThis.document, savedRoot = globalThis.document.documentElement;
  const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, mm: globalThis.matchMedia, gcs: globalThis.getComputedStyle };
  try {
    // ---- 式 ----
    const smooth = SPRING_DEFAULTS.smooth, snappy = SPRING_DEFAULTS.snappy;
    assert.deepEqual(solveSpring(smooth, 1, 0, 0).map(n => +n.toFixed(9)), [1, 0], 't=0 は初めの値');
    const [xs] = solveSpring(smooth, 1, 0, 0.45);
    assert.ok(Math.abs(xs) < 0.07, `応答の長さで 1 から 7% 未満へ寄る（${xs}）`);
    let min = 1;
    for (let k = 0; k <= 200; k++) min = Math.min(min, solveSpring(smooth, 1, 0, k / 200)[0]);
    assert.ok(min >= -1e-9, 'smooth（弾み 0）は行き過ぎない');
    let under = 1;
    for (let k = 0; k <= 200; k++) under = Math.min(under, solveSpring(snappy, 1, 0, k / 200)[0]);
    assert.ok(under < -0.005 && under > -0.2, `snappy（弾み 0.15）は少しだけ行き過ぎる（${under}）`);
    // 速さは位置の微分と合う（数値微分）
    for (const preset of [smooth, snappy]) {
      const h = 1e-5, [a] = solveSpring(preset, 1, 3, 0.1), [b, v] = solveSpring(preset, 1, 3, 0.1 + h);
      assert.ok(Math.abs((b - a) / h - v) < 1e-2, '速さが位置の微分と合う');
    }
    t.ok('ばねの式: 応答の長さで寄る・smooth は行き過ぎない・snappy は少し弾む・速さが微分と合う', true);

    // ---- トークン ----
    globalThis.getComputedStyle = () => ({ getPropertyValue: (key) => ({ '--spring-smooth-response': ' .6s', '--spring-smooth-bounce': '0.1', '--spring-snappy-response': '250ms', '--spring-snappy-bounce': '' })[key] ?? '' });
    globalThis.document.documentElement ??= {};
    assert.deepEqual(springPreset('smooth'), { response: 0.6, bounce: 0.1 });
    assert.deepEqual(springPreset('snappy'), { response: 0.25, bounce: 0.15 }, 'ms で書いた長さ・空の弾みは既定');
    delete globalThis.getComputedStyle;
    assert.deepEqual(springPreset('snappy'), { response: 0.3, bounce: 0.15 }, '読めなければ既定');
    const css = readFileSync(fileURLToPath(new URL('../../web/tokens.css', import.meta.url)), 'utf8');
    assert.match(css, /--spring-smooth-response:\.45s;--spring-smooth-bounce:0;/);
    assert.match(css, /--spring-snappy-response:\.3s;--spring-snappy-bounce:\.15;/);
    t.ok('トークン: tokens.css の値を読む・既定の値は tokens.css と同じ', true);

    // ---- rAF の無い環境（試験の DOM の身代わり）: その場で終わりの値へ ----
    delete globalThis.requestAnimationFrame;
    const seen = []; let ended = 0;
    const plain = createSpring(0, { onUpdate: x => seen.push(x) });
    plain.to(100, { onEnd: () => ended++ });
    assert.equal(plain.value, 100); assert.equal(plain.moving, false); assert.equal(ended, 1);
    assert.deepEqual(seen, [100], '途中の値を出さない');
    t.ok('rAF が無ければ、その場で終わりの値になり onEnd も呼ぶ', true);

    // ---- 時計を差し替えて進める ----
    const frames = [];
    globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
    globalThis.cancelAnimationFrame = () => {};
    globalThis.matchMedia = () => ({ matches: false });
    motionClock.freeze();
    const values = [];
    const s = createSpring(0, { onUpdate: x => values.push(x), epsilon: 0.01 });
    s.to(100);
    assert.equal(s.moving, true); assert.equal(s.value, 0, '目標を替えただけでは動かない（次のコマから）');
    motionClock.advance(120);
    const mid = s.value;
    assert.ok(mid > 20 && mid < 90, `途中の値（${mid}）`);
    for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1] - 1e-9, 'smooth は単調に進む');
    // 途中で逆向き: 今の位置と速さから続く（跳ばない）
    const velocity = s.velocity;
    assert.ok(velocity > 0);
    s.to(0);
    const before = s.value;
    motionClock.advance(8);
    assert.ok(Math.abs(s.value - before) < 6, `逆向きにした直後のコマで跳ばない（${before} → ${s.value}）`);
    assert.ok(s.value > before, '速さを引き継ぐので、逆向きにした直後はまだ少し進む');
    let ended2 = 0;
    s.to(0, { onEnd: () => ended2++ });
    motionClock.advance(2000);
    assert.equal(s.value, 0); assert.equal(s.moving, false); assert.equal(ended2, 1);
    assert.equal(motionClock.moving, 0);
    t.ok('時計: 途中の値・単調・逆向きで跳ばず速さを引き継ぐ・止まると onEnd', true);

    // set・stop・finish
    const u = createSpring(5);
    u.to(50); motionClock.advance(40);
    u.stop(); const stopped = u.value; motionClock.advance(200);
    assert.equal(u.value, stopped, 'stop はその場で止める');
    u.to(80); u.finish(); assert.equal(u.value, 80);
    u.set(3); assert.equal(u.value, 3); assert.equal(u.moving, false);
    t.ok('set・stop・finish', true);

    // rAF で回す（止めていない時計）: dt は 64ms で頭打ち
    motionClock.thaw();
    const r = createSpring(0, { epsilon: 0.01 });
    frames.length = 0;
    r.to(1);
    assert.equal(frames.length, 1, 'rAF を 1 本だけ頼む');
    frames.shift()(1000); // 1 コマ目は dt 0
    assert.equal(r.value, 0);
    frames.shift()(6000); // 5 秒空いても 64ms 分だけ進む
    assert.ok(r.value > 0 && r.value < 0.9, `間が空いても跳ばない（${r.value}）`);
    r.finish();

    // ---- 1 本の onUpdate が投げても、ほかのばねは止まらない（投げた 1 本は外して onEnd を呼び、例外は console.error へ） ----
    motionClock.freeze();
    const errors = [], savedError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      let badEnd = 0, goodEnd = 0, calls = 0;
      const bad = createSpring(0, { onUpdate: () => { calls++; if (calls === 2) throw new Error('boom'); } });
      const good = createSpring(0, { epsilon: 0.01 });
      bad.to(100, { onEnd: () => badEnd++ });
      good.to(100, { onEnd: () => goodEnd++ });
      motionClock.advance(16);
      assert.equal(bad.moving, false, '投げたばねは外す');
      assert.equal(bad.value, 100, '投げたばねは目標に置く');
      assert.equal(badEnd, 1, '投げたばねの onEnd も呼ぶ（後片付けを飛ばさない）');
      assert.equal(errors.length, 1, '例外は飲み込まず console.error へ出す');
      assert.equal(errors[0].at(-1)?.message, 'boom');
      assert.equal(good.moving, true, 'ほかのばねは動き続ける');
      motionClock.advance(2000);
      assert.equal(good.value, 100); assert.equal(goodEnd, 1);
      assert.equal(motionClock.moving, 0);
      // onEnd が投げても、次のばねは進む
      const loud = createSpring(0), next = createSpring(0, { epsilon: 0.01 }); let nextEnd = 0;
      loud.to(1, { onEnd: () => { throw new Error('end'); } });
      next.to(100, { onEnd: () => nextEnd++ });
      motionClock.advance(2000);
      assert.equal(next.value, 100); assert.equal(nextEnd, 1);
      assert.equal(errors.length, 2); assert.equal(motionClock.moving, 0);
      // finishAll でも同じ
      const bad2 = createSpring(0, { onUpdate: () => { throw new Error('fin'); } }), ok2 = createSpring(0); let ok2End = 0;
      bad2.to(5); ok2.to(5, { onEnd: () => ok2End++ });
      motionClock.finishAll();
      assert.equal(ok2.value, 5); assert.equal(ok2End, 1); assert.equal(motionClock.moving, 0); assert.equal(errors.length, 3);
    } finally { console.error = savedError; motionClock.thaw(); }
    t.ok('1 本の onUpdate・onEnd が投げても、ほかのばねは終わりまで進み、投げた 1 本は外して onEnd を呼び、例外は console.error へ出す', true);

    // ---- onFail: 投げて外れたときだけ、onEnd の後に 1 度呼ぶ（動いている間だけ付けた印を外す口）。普通に終われば呼ばない ----
    motionClock.freeze();
    console.error = (...args) => errors.push(args);
    try {
      const order = [];
      const failing = createSpring(0, { onUpdate: () => { if (order.includes('go')) throw new Error('boom2'); }, onFail: () => order.push('fail') });
      failing.to(100, { onEnd: () => order.push('end') });
      order.push('go');
      motionClock.advance(16);
      assert.deepEqual(order, ['go', 'end', 'fail'], 'onEnd の後に onFail を 1 度');
      const fine = createSpring(0, { epsilon: 0.01, onFail: () => order.push('fine-fail') });
      fine.to(100); motionClock.advance(3000);
      assert.equal(fine.value, 100); assert.ok(!order.includes('fine-fail'), '普通に終われば onFail は呼ばない');
      const loudFail = createSpring(0, { onUpdate: () => { throw new Error('x'); }, onFail: () => { throw new Error('y'); } });
      loudFail.to(1); motionClock.advance(16);
      assert.equal(motionClock.moving, 0, 'onFail が投げても時計は止まらない');
    } finally { console.error = savedError; motionClock.thaw(); }
    t.ok('onFail: 投げて外れたときだけ onEnd の後に 1 度呼ぶ・普通に終われば呼ばない・onFail が投げても止まらない', true);

    // ---- 動きを減らす設定: その場で終わり、動いているものも終える ----
    globalThis.matchMedia = q => ({ matches: /reduce/.test(q) });
    assert.equal(reducedMotion(), true);
    const z = createSpring(0); let zEnd = 0;
    z.to(10, { onEnd: () => zEnd++ });
    assert.equal(z.value, 10); assert.equal(zEnd, 1);
    globalThis.matchMedia = () => ({ matches: false });
    motionClock.freeze();
    const w = createSpring(0); w.to(10); motionClock.advance(16);
    setReducedMotion(true);
    assert.equal(w.value, 10, '減らす設定へ替えたら、動いているものを終える');
    assert.equal(reducedMotion(), true);
    setReducedMotion(null);
    assert.equal(reducedMotion(), false);
    delete globalThis.matchMedia;
    assert.equal(reducedMotion(), false, 'matchMedia が無ければ減らさない');
    t.ok('動きを減らす設定: その場で終わる・切り替えで動いているものを終える・matchMedia が無くても落ちない', true);
  } finally {
    motionClock.finishAll(); motionClock.thaw(); setReducedMotion(null);
    if (hadRoot) globalThis.document.documentElement = savedRoot; else delete globalThis.document.documentElement;
    for (const [key, value] of [['requestAnimationFrame', saved.raf], ['cancelAnimationFrame', saved.caf], ['matchMedia', saved.mm], ['getComputedStyle', saved.gcs]]) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}
