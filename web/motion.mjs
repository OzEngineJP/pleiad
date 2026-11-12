// 動きの共通の口（docs/design-system.md §8「動きの語彙」。Issue #184 の段 0 の最初の形）。
// - ばね: 弾み b と応答の長さ d（秒）で決める（ω₀ = 2π/d、ζ = 1 − b）。式で解くので、途中で目標を替えても
//   今の位置と速さから続く（逆向きにしても跳ばない）
// - 値は web/tokens.css の --spring-<name>-response / --spring-<name>-bounce から読む（smooth・snappy）
// - 動きを減らす設定の判定はここの reducedMotion() 1 か所。減らすときと、rAF の無い環境（試験の DOM の身代わり）では、
//   その場で終わりの値へ替える
// 時計は 1 本の rAF。撮影と試験のために、止めて決まった時間だけ進められる（motionClock）

/** 既定の値（tokens.css が読めないときに使う。tokens.css と同じ値） */
export const SPRING_DEFAULTS = Object.freeze({
  smooth: Object.freeze({ response: 0.45, bounce: 0 }),
  snappy: Object.freeze({ response: 0.3, bounce: 0.15 }),
});

let reduceOverride = null;
/** 動きを減らす設定か。試験と撮影では setReducedMotion(true / false) で上書きできる（null で OS の設定へ戻す） */
export function reducedMotion() {
  if (reduceOverride != null) return reduceOverride;
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches === true; }
  catch { return false; }
}
export function setReducedMotion(value) {
  reduceOverride = value == null ? null : Boolean(value);
  if (reduceOverride) finishAll();
}

const parseSeconds = (text) => {
  const value = String(text ?? '').trim();
  if (!value) return NaN;
  const number = parseFloat(value);
  return value.endsWith('ms') ? number / 1000 : number;
};
/** ばねの値（{ response 秒, bounce }）。tokens.css の変数を読み、無ければ既定の値 */
export function springPreset(name = 'smooth') {
  const fallback = SPRING_DEFAULTS[name] ?? SPRING_DEFAULTS.smooth;
  if (typeof name === 'object' && name) return { response: name.response ?? fallback.response, bounce: name.bounce ?? fallback.bounce };
  let style = null;
  try { style = typeof getComputedStyle === 'function' && typeof document !== 'undefined' && document.documentElement ? getComputedStyle(document.documentElement) : null; }
  catch { style = null; }
  const read = (key) => (typeof style?.getPropertyValue === 'function' ? style.getPropertyValue(`--spring-${name}-${key}`) : '');
  const response = parseSeconds(read('response')), bounce = parseFloat(String(read('bounce') ?? '').trim());
  return {
    response: Number.isFinite(response) && response > 0 ? response : fallback.response,
    bounce: Number.isFinite(bounce) ? Math.min(0.9, Math.max(0, bounce)) : fallback.bounce,
  };
}

/** 目標からのずれ x0・速さ v0 で始めたばねの、t 秒後のずれと速さ [x, v]（臨界減衰と不足減衰） */
export function solveSpring({ response, bounce }, x0, v0, t) {
  const w = (2 * Math.PI) / response, z = 1 - bounce;
  if (z >= 1) {
    const B = v0 + w * x0, e = Math.exp(-w * t);
    return [(x0 + B * t) * e, (B - w * (x0 + B * t)) * e];
  }
  const wd = w * Math.sqrt(1 - z * z), B = (v0 + z * w * x0) / wd, e = Math.exp(-z * w * t), c = Math.cos(wd * t), s = Math.sin(wd * t);
  const x = e * (x0 * c + B * s);
  return [x, -z * w * x + e * (-x0 * wd * s + B * wd * c)];
}

// ---- 時計（rAF 1 本。動いているばねがあるときだけ回す） ----
const live = new Set();
const clock = { manual: false, raf: 0, last: null };
const hasRaf = () => typeof requestAnimationFrame === 'function';

/** 1 本の onUpdate・onEnd が投げても、ほかのばねと時計は止めない（その 1 本は外して終わらせ、例外は出す） */
function guard(spring, run) {
  try { run(); }
  catch (error) { console.error('ばねの更新で例外が出たので、そのばねを止めました', error); spring._fail(); }
}
function stepAll(ms) {
  const dt = ms / 1000;
  for (const spring of [...live]) guard(spring, () => spring._step(dt));
}
function tick(now) {
  clock.raf = 0;
  const dt = clock.last == null ? 0 : Math.min(64, Math.max(0, now - clock.last));
  clock.last = now;
  stepAll(dt);
  if (live.size && !clock.manual) clock.raf = requestAnimationFrame(tick);
}
function kick() {
  if (clock.manual || clock.raf || !hasRaf()) return;
  clock.last = null;
  clock.raf = requestAnimationFrame(tick);
}
function finishAll() { for (const spring of [...live]) guard(spring, () => spring.finish()); }

/** 撮影と試験用: 時計を止める・決まった時間だけ進める（8ms 刻み）・戻す・動いているものを全部終える */
export const motionClock = Object.freeze({
  freeze() { clock.manual = true; if (clock.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(clock.raf); clock.raf = 0; },
  advance(ms) { let left = ms; while (left > 0) { const d = Math.min(8, left); stepAll(d); left -= d; } },
  thaw() { clock.manual = false; if (live.size) kick(); },
  finishAll,
  get moving() { return live.size; },
});

/**
 * ばね 1 本。onUpdate(value) は値が変わるたびに呼ぶ。epsilon は「止まった」とみなすずれ（値の単位）。
 * to(target, { preset, onEnd }) で目標へ向かう（動いている途中なら今の位置と速さから続ける）。
 * set(value) は動かさずに置く。stop() はその場で止める。finish() は目標へ飛ばして終える。
 * onFail は、onUpdate・onEnd が投げてばねを外したとき（_fail）の後始末。動いている間だけ付けた印などを外す（既定は何もしない）
 */
export function createSpring(value = 0, { preset = 'smooth', onUpdate = null, epsilon = 0.5, onFail = null } = {}) {
  let x = value, v = 0, target = value, x0 = 0, v0 = 0, t = 0, params = springPreset(preset), end = null, moving = false;
  const emit = () => { onUpdate?.(x); };
  const settle = () => {
    x = target; v = 0; moving = false; live.delete(spring);
    emit();
    const done = end; end = null; done?.();
  };
  const spring = {
    get value() { return x; },
    get velocity() { return v; },
    get target() { return target; },
    get moving() { return moving; },
    to(next, { preset: name, onEnd = null } = {}) {
      if (name) params = springPreset(name);
      end = onEnd;
      target = next;
      if (reducedMotion() || !hasRaf()) { settle(); return spring; }
      if (!moving && Math.abs(x - next) < epsilon && Math.abs(v) < epsilon * 8) { settle(); return spring; }
      x0 = x - next; v0 = v; t = 0; moving = true;
      live.add(spring); kick();
      return spring;
    },
    set(next) { live.delete(spring); moving = false; end = null; x = target = next; v = 0; emit(); return spring; },
    stop() { live.delete(spring); moving = false; end = null; target = x; v = 0; return spring; },
    finish() { if (moving || end) settle(); return spring; },
    /** 投げたばね: 目標に置いて外し、まだ呼んでいない onEnd を呼ぶ（後片付けの onEnd を飛ばさない） */
    _fail() {
      live.delete(spring); moving = false; x = target; v = 0;
      const done = end; end = null;
      try { done?.(); } catch (error) { console.error('ばねの終わりの処理で例外が出ました', error); }
      try { onFail?.(); } catch (error) { console.error('ばねの失敗の後始末で例外が出ました', error); }
    },
    _step(dt) {
      if (!moving) { live.delete(spring); return; }
      t += dt;
      const [dx, dv] = solveSpring(params, x0, v0, t);
      x = target + dx; v = dv;
      if (Math.abs(dx) < epsilon && Math.abs(dv) < epsilon * 8) { settle(); return; }
      emit();
    },
  };
  return spring;
}
