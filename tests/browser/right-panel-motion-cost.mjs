// 右の欄の開け閉めの間、重い処理を走らせないことを本物の画面（身代わりのバックエンドのサーバー）で確かめる
// （docs/design-system.md §8「動きの語彙」。web/panel-moving.mjs・web/panel-handoff.mjs）。
// - 頭のアイコンと ✖ の受け渡しは、動き始めに量って、あとのコマは書くだけ（量り直しは何度も強制レイアウトする）
// - 筋・会話の目次のように列の幅に反応する処理は、動いている間は走らせず、止まったときに 1 度だけやり直す
// - 毎コマ量り直す版（窓の大きさの変化で量り直させる）と動きが同じなこと、折り返し・窓の大きさ・会話の切り替えを挟んでも止まったままにならないこと
// tests/unit/right-panel-motion-cost.mjs から B1_BROWSER_TEST=1 のときだけ呼ぶ。利用者のデータ置き場・本物の Chrome は使わない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';

/** 量った回数を、動いている間とそれ以外に分けて数える（呼んだ側のファイルをスタックで見分ける） */
const install = page => page.evaluate(() => {
  if (window.__cost) return;
  const kinds = { handoff: /panel-handoff\.mjs/, spine: /branch-view\.mjs/, nav: /conversation-nav-view\.mjs/ };
  const cost = window.__cost = { moving: { handoff: 0, spine: 0, nav: 0 }, still: { handoff: 0, spine: 0, nav: 0 }, settled: 0, stacks: [], samples: [], sampling: false, forceMeasure: false };
  const note = () => {
    const stack = new Error().stack ?? '';
    for (const [kind, re] of Object.entries(kinds)) if (re.test(stack)) {
      const moving = document.body.classList.contains('file-preview-moving');
      (moving ? cost.moving : cost.still)[kind]++;
      if (moving && kind !== 'handoff' && cost.stacks.length < 6) cost.stacks.push(kind + ': ' + stack.split(String.fromCharCode(10)).slice(2, 7).map(line => line.trim().replace(/^at /, '').replace(/http:\/\/[^/]+\//, '')).join(' < '));
      return;
    }
  };
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function(...args) { note(); return original.apply(this, args); };
  const originalStyle = window.getComputedStyle;
  window.getComputedStyle = (...args) => { note(); return originalStyle.apply(window, args); };
  const wrapGetter = (proto, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { ...descriptor, get() { note(); return descriptor.get.call(this); } });
  };
  for (const key of ['offsetTop', 'offsetHeight', 'offsetWidth']) wrapGetter(HTMLElement.prototype, key);
  for (const key of ['clientWidth', 'clientHeight']) wrapGetter(Element.prototype, key);
  document.addEventListener('right-panel-settled', () => { cost.settled++; });
  let previous = null;
  const loop = () => {
    if (cost.forceMeasure) window.dispatchEvent(new Event('resize'));   // 受け渡しの両端を毎コマ量り直させる（旧来の動き）
    if (cost.sampling && document.body.classList.contains('file-preview-moving')) {
      const flier = document.querySelector('.panel-flier');
      const px = parseFloat(document.body.style.getPropertyValue('--file-preview-shown'));
      if (flier && !flier.hidden && Number.isFinite(px) && px !== previous) {
        cost.samples.push({ px, left: parseFloat(flier.style.left), top: parseFloat(flier.style.top), w: parseFloat(flier.style.width), g: parseFloat(flier.style.getPropertyValue('--g')) });
      }
      previous = px;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
const reset = (page, { sampling = false, forceMeasure = false } = {}) => page.evaluate(({ sampling, forceMeasure }) => {
  const cost = window.__cost;
  cost.moving = { handoff: 0, spine: 0, nav: 0 }; cost.still = { handoff: 0, spine: 0, nav: 0 }; cost.settled = 0;
  cost.samples = []; cost.stacks = []; cost.sampling = sampling; cost.forceMeasure = forceMeasure;
}, { sampling, forceMeasure });
const read = page => page.evaluate(() => {
  const { moving, still, settled, samples, stacks } = window.__cost;
  return { moving: { ...moving }, still: { ...still }, settled, samples: samples.slice(), stacks: stacks.slice() };
});

/** 動きが止まるまで待つ（動いている印・片付けの印・受け渡しの絵が全部消える） */
const waitStill = page => page.waitForFunction(() => {
  const cls = document.body.classList;
  return !cls.contains('file-preview-moving') && !cls.contains('file-preview-leaving') && !document.querySelector('.panel-flier:not([hidden])');
}, null, { timeout: 8000, polling: 'raf' });
/** 動きが始まって、列が全幅のおよそ ratio になるまで待つ */
const waitMid = (page, ratio) => page.waitForFunction(ratio => {
  const px = parseFloat(document.body.style.getPropertyValue('--file-preview-shown')), full = parseFloat(document.body.style.getPropertyValue('--file-preview-width'));
  return document.body.classList.contains('file-preview-moving') && Number.isFinite(px) && full > 0 && px / full >= ratio;
}, ratio, { timeout: 5000, polling: 'raf' });
const mouseOn = async (page, selector) => {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
};
const openPanel = page => mouseOn(page, '#browserEntry');
const closePanel = page => mouseOn(page, '#filePreview .bu-panel-close');
const state = page => page.evaluate(() => {
  const fp = document.querySelector('#filePreview'), flier = document.querySelector('.panel-flier');
  const shown = n => !!n && !n.hidden && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0;
  const cls = document.body.classList;
  return { open: cls.contains('file-preview-open') && shown(fp), moving: cls.contains('file-preview-moving'), leaving: cls.contains('file-preview-leaving') || fp.classList.contains('fp-leaving'),
    inert: fp.inert === true, flier: shown(flier), entry: shown(document.querySelector('#browserEntry')), close: shown(fp.querySelector('.bu-panel-close')), shownVar: document.body.style.getPropertyValue('--file-preview-shown') };
});
const cleanOpen = s => s.open && !s.moving && !s.leaving && !s.inert && !s.flier && !s.entry && s.close && s.shownVar === '';
const cleanClosed = s => !s.open && !s.moving && !s.leaving && !s.inert && !s.flier && s.entry && s.shownVar === '';
const total = o => o.handoff + o.spine + o.nav;

async function prepare(page, base, ws) {
  // 初回の案内の窓は閉じる口が無く（web/index.html）、使えるエージェントが無いと開く。この試験の対象ではないので出さない
  await page.addInitScript(() => {
    for (const key of ['showModal', 'show']) { const original = HTMLDialogElement.prototype[key]; HTMLDialogElement.prototype[key] = function(...args) { if (this.id === 'onboardingDialog') return undefined; return original.apply(this, args); }; }
  });
  await page.goto(base);
  await page.locator('#prompt').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.locator('#cwdChip').click();
  await page.locator('#cwdPop .cpath').fill(ws);
  await page.locator('#cwdPop .cpath').press('Enter');
  for (let i = 1; i <= 4; i++) {
    await page.locator('#prompt').fill(`echo:右の欄の動きの確認 ${i}`);
    await page.locator('#send').click();
    await page.waitForFunction(count => document.querySelectorAll('.mw .m[data-uuid]').length >= count && !document.querySelector('#send').disabled, i, { timeout: 20000 });
  }
}

/** 標本から px の所の値を線形に補う（範囲の外は null） */
function at(samples, x, key) {
  const sorted = [...samples].sort((a, b) => a.px - b.px);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (x >= a.px && x <= b.px) return b.px === a.px ? a[key] : a[key] + (b[key] - a[key]) * (x - a.px) / (b.px - a.px);
  }
  return null;
}
/** 2 組の標本を px で並べて、離れが最大でどれだけか（比べられた点の数も） */
function distance(a, b) {
  let worst = 0, n = 0, where = '';
  for (const sample of a) for (const key of ['left', 'top', 'w', 'g']) {
    const other = at(b, sample.px, key);
    if (other === null || !Number.isFinite(sample[key]) || !Number.isFinite(other)) continue;
    n++;
    if (Math.abs(sample[key] - other) > worst) { worst = Math.abs(sample[key] - other); where = `${key}@${sample.px.toFixed(0)}`; }
  }
  return { worst: Number(worst.toFixed(3)), n, where };
}
/** 折り返したあとの向き（px が減っていく標本）だけ */
const shrinking = list => list.filter((sample, i) => i > 0 && sample.px < list[i - 1].px);

export default async function rightPanelMotionCost({ browser, check }) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-right-panel-cost-'));
  const dataDir = path.join(scratch, 'data'), ws = path.join(scratch, 'rp-cost-ws');
  await fs.mkdir(ws, { recursive: true });
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
  const base = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ja-JP' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await prepare(page, base, ws);
    await page.waitForTimeout(2500);   // 返答のあとの静かな読み直し・実寸の確定が済むまで待つ（動きの間に発言が足されると、幅に関係なく量る）
    await install(page);

    // ---- 開く: 受け渡しは動き始めの量りだけ・幅に反応する処理は動く間は走らず、止まったあとに走る ----
    await reset(page, { sampling: true });
    await openPanel(page);
    await waitStill(page);
    await page.waitForTimeout(500);   // 目次の量りは間引くので、止まったあとの再実行を待つ
    const open = await read(page);
    const openState = await state(page);
    check('opening the panel leaves it open with no leftovers', cleanOpen(openState), JSON.stringify(openState));
    check('opening: the frames of the motion were really sampled', open.samples.length >= 12, `${open.samples.length} samples`);
    const handoffOpen = open.moving.handoff;
    check('opening: the head icon / ✖ handoff measures at the start only, not every frame', handoffOpen <= 12, `${handoffOpen} reads while moving, over ${open.samples.length} frames`);
    check('opening: nothing that reacts to the column width measures while the panel moves', open.moving.spine === 0 && open.moving.nav === 0, JSON.stringify({ moving: open.moving, stacks: open.stacks }));
    check('opening: the stopped work runs after the motion ends (spine and nav measure once it settles)', open.still.spine > 0 && open.still.nav > 0 && open.settled === 1, JSON.stringify({ still: open.still, settled: open.settled }));

    // ---- 閉じる ----
    await reset(page, { sampling: true });
    await closePanel(page);
    await waitStill(page);
    await page.waitForTimeout(500);
    const closed = await read(page);
    const closedState = await state(page);
    check('closing the panel leaves it closed with no leftovers', cleanClosed(closedState), JSON.stringify(closedState));
    check('closing: the handoff measures at the start only', closed.moving.handoff <= 12 && closed.samples.length >= 12, `${closed.moving.handoff} reads while moving, over ${closed.samples.length} frames`);
    check('closing: nothing that reacts to the column width measures while the panel moves, and it runs once after', closed.moving.spine === 0 && closed.moving.nav === 0 && closed.still.spine > 0 && closed.still.nav > 0 && closed.settled === 1,
      JSON.stringify({ moving: closed.moving, still: closed.still, settled: closed.settled }));

    // ---- 毎コマ量り直す旧来の動き（窓の大きさの変化で量り直させる）と同じ動きか ----
    await reset(page, { sampling: true, forceMeasure: true });
    await openPanel(page); await waitStill(page);
    const openB = await read(page);
    await reset(page, { sampling: true, forceMeasure: true });
    await closePanel(page); await waitStill(page);
    const closeB = await read(page);
    await reset(page);
    check('oracle sanity: re-measuring every frame really reads many times more', openB.moving.handoff > 3 * handoffOpen, `${openB.moving.handoff} vs ${handoffOpen}`);
    const dOpen = distance(open.samples, openB.samples), dClose = distance(closed.samples, closeB.samples);
    check('the flying icon follows the same positions and sizes as measuring every frame (opening)', dOpen.n >= 40 && dOpen.worst <= 0.6, JSON.stringify(dOpen));
    check('the flying icon follows the same positions and sizes as measuring every frame (closing)', dClose.n >= 40 && dClose.worst <= 0.6, JSON.stringify(dClose));

    // ---- 動きの途中で折り返す: 終点が替わる。毎コマ量り直す版と同じ動き・止まったままにならない ----
    const reversal = {};
    for (const forceMeasure of [false, true]) {
      await reset(page, { sampling: true, forceMeasure });
      await openPanel(page);
      await waitMid(page, 0.4);
      // 開く途中で、動いている絵（✖ に重なって上の層にある）を押す。今の位置と速さから戻る（座標で押すと、絵が動いて押し損なう）
      await page.evaluate(() => document.querySelector('.panel-flier').click());
      await waitStill(page);
      await page.waitForTimeout(500);
      reversal[forceMeasure ? 'b' : 'a'] = await read(page);
      if (!forceMeasure) {
        const s = await state(page), r = reversal.a;
        check('reversing mid-motion ends closed with no leftovers', cleanClosed(s), JSON.stringify(s));
        check('reversing mid-motion: the stopped work runs once at the end, not at the turn', r.settled === 1 && r.moving.spine === 0 && r.moving.nav === 0 && r.still.spine > 0 && r.still.nav > 0,
          JSON.stringify({ settled: r.settled, moving: r.moving, still: r.still }));
        check('reversing mid-motion: the handoff re-measures at the turn only', r.moving.handoff <= 20, `${r.moving.handoff} reads while moving`);
      }
    }
    await reset(page);
    {
      const a = shrinking(reversal.a.samples), b = shrinking(reversal.b.samples), d = distance(a, b);
      check('after the turn the flying icon follows the same positions as measuring every frame', a.length >= 4 && d.n >= 12 && d.worst <= 0.8, JSON.stringify({ closingA: a.length, closingB: b.length, ...d }));
    }

    // ---- 動きを減らす設定: 動かさず、止まった状態で幅に反応する処理が動く ----
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await reset(page);
    await openPanel(page);
    await waitStill(page);
    await page.waitForTimeout(500);
    const reduced = await read(page);
    const reducedState = await state(page);
    check('with reduced motion the panel opens straight to the open state', cleanOpen(reducedState), JSON.stringify(reducedState));
    check('with reduced motion the width-reactive work is not left stopped (spine and nav measure)', reduced.still.spine > 0 && reduced.still.nav > 0 && reduced.moving.spine + reduced.moving.nav === 0, JSON.stringify({ moving: reduced.moving, still: reduced.still }));
    await closePanel(page); await waitStill(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const reducedClosed = await state(page);
    check('with reduced motion closing also ends clean', cleanClosed(reducedClosed), JSON.stringify(reducedClosed));

    // ---- 動きの途中で窓の大きさが替わる: 終点が替わるので量り直し、止まったままにならない ----
    await reset(page, { sampling: true });
    await openPanel(page);
    await waitMid(page, 0.3);
    await page.setViewportSize({ width: 1100, height: 800 });
    await waitStill(page);
    await page.waitForTimeout(500);
    const resized = await read(page);
    const resizedState = await state(page);
    check('resizing the window mid-motion ends open with no leftovers', cleanOpen(resizedState), JSON.stringify(resizedState));
    const stray = resized.samples.filter(s => ![s.left, s.top, s.w, s.g].every(Number.isFinite) || s.left < -50 || s.left > 1300);
    check('resizing the window mid-motion: the flying icon always has finite positions inside the window', resized.samples.length >= 4 && stray.length === 0, JSON.stringify(stray.slice(0, 3)));
    check('resizing the window mid-motion: the width-reactive work ran after the motion', resized.still.spine > 0 && resized.still.nav > 0 && resized.settled >= 1, JSON.stringify({ still: resized.still, settled: resized.settled }));
    // 止まったあとの窓の大きさの変化には、すぐ反応する（止めたままにならない）
    await reset(page);
    await page.setViewportSize({ width: 1240, height: 800 });
    await page.waitForTimeout(500);
    const afterResize = await read(page);
    check('after the motion a window resize makes the width-reactive work run again', afterResize.still.spine + afterResize.still.nav > 0, JSON.stringify(afterResize.still));
    await closePanel(page); await waitStill(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);

    // ---- 動きの途中で会話を替える: 動きが止まったとき、止めた処理が止まったままにならない ----
    await reset(page);
    await openPanel(page);
    await waitMid(page, 0.3);
    await page.locator('#newSession').click();
    await waitStill(page);
    await page.waitForTimeout(500);
    const switchedState = await state(page);
    check('switching the conversation mid-motion ends without the moving mark left on', !switchedState.moving && !switchedState.leaving && !switchedState.flier && switchedState.shownVar === '', JSON.stringify(switchedState));
    await reset(page);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(500);
    const afterSwitch = await read(page);
    check('after switching mid-motion the page is not left in the moving state', !(await state(page)).moving && afterSwitch.settled === 0 && total(afterSwitch.moving) === 0, JSON.stringify({ moving: afterSwitch.moving, settled: afterSwitch.settled }));
    await page.setViewportSize({ width: 1280, height: 800 });

    check('no page errors during the motions', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } finally {
    await server.stop?.();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
