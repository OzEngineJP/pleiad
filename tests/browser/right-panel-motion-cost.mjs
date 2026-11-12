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
  const cost = window.__cost = { moving: { handoff: 0, spine: 0, nav: 0 }, still: { handoff: 0, spine: 0, nav: 0 }, passes: 0, passesMoving: 0, settled: 0, stacks: [], samples: [], sampling: false, forceMeasure: false };
  const note = (self, key) => {
    const stack = new Error().stack ?? '';
    for (const [kind, re] of Object.entries(kinds)) if (re.test(stack)) {
      const moving = document.body.classList.contains('file-preview-moving');
      (moving ? cost.moving : cost.still)[kind]++;
      // 筋の置き直し 1 回（layoutBranchSpine）は、最後の発言の offsetTop を 1 度読む。止まったあとに何回走ったかの数え
      if (kind === 'spine' && key === 'offsetTop' && self?.matches?.('.mw.node,.mw.activity')) { cost.passes++; if (moving) cost.passesMoving++; }
      if (moving && kind !== 'handoff' && cost.stacks.length < 6) cost.stacks.push(kind + ': ' + stack.split(String.fromCharCode(10)).slice(2, 7).map(line => line.trim().replace(/^at /, '').replace(/http:\/\/[^/]+\//, '')).join(' < '));
      return;
    }
  };
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function(...args) { note(this, 'rect'); return original.apply(this, args); };
  const originalStyle = window.getComputedStyle;
  window.getComputedStyle = (...args) => { note(null, 'style'); return originalStyle.apply(window, args); };
  const wrapGetter = (proto, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { ...descriptor, get() { note(this, key); return descriptor.get.call(this); } });
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
  cost.moving = { handoff: 0, spine: 0, nav: 0 }; cost.still = { handoff: 0, spine: 0, nav: 0 }; cost.passes = 0; cost.passesMoving = 0; cost.settled = 0;
  cost.samples = []; cost.stacks = []; cost.sampling = sampling; cost.forceMeasure = forceMeasure;
}, { sampling, forceMeasure });
const read = page => page.evaluate(() => {
  const { moving, still, settled, samples, stacks, passes, passesMoving } = window.__cost;
  return { moving: { ...moving }, still: { ...still }, passes, passesMoving, settled, samples: samples.slice(), stacks: stacks.slice() };
});

/** 動きが止まるまで待つ（動いている印・片付けの印・受け渡しの絵が全部消える） */
const waitStill = page => page.waitForFunction(() => {
  const cls = document.body.classList;
  return !cls.contains('file-preview-moving') && !cls.contains('file-preview-leaving') && !document.querySelector('.panel-flier:not([hidden])');
}, null, { timeout: 8000, polling: 'raf' });
/** 止めた処理が止まったあとに走り終えるまで待つ（時間では待たない: 動きが止まる→合図→次のコマ→筋・目次の量り）。nav=false は目次を待たない（会話の無い画面） */
const waitWork = (page, { nav = true, signal = true } = {}) => page.waitForFunction(({ nav, signal }) => {
  const { settled, still } = window.__cost;
  return (!signal || settled >= 1) && still.spine > 0 && (!nav || still.nav > 0);
}, { nav, signal }, { timeout: 8000, polling: 'raf' });
/** 動きが始まって、列が全幅のおよそ ratio になるまで待つ */
const waitMid = (page, ratio) => page.waitForFunction(ratio => {
  const px = parseFloat(document.body.style.getPropertyValue('--file-preview-shown')), full = parseFloat(document.body.style.getPropertyValue('--file-preview-width'));
  return document.body.classList.contains('file-preview-moving') && Number.isFinite(px) && full > 0 && px / full >= ratio;
}, ratio, { timeout: 5000, polling: 'raf' });
/** 動きが始まった最初のコマで、画面の中から同じコマのうちに押す（試験側の往復を挟むと、重い実行で動きが終わった後に押してしまう） */
const clickMid = (page, selector, ratio = 0.1) => page.waitForFunction(({ selector, ratio }) => {
  const px = parseFloat(document.body.style.getPropertyValue('--file-preview-shown')), full = parseFloat(document.body.style.getPropertyValue('--file-preview-width'));
  if (!(document.body.classList.contains('file-preview-moving') && Number.isFinite(px) && full > 0 && px / full >= ratio)) return false;
  document.querySelector(selector).click();
  return true;
}, { selector, ratio }, { timeout: 8000, polling: 'raf' });
/** 止めた呼び出しを抱えている口の数（止まってやり直したあとは 0 に戻る） */
const watchers = page => page.evaluate(async () => (await import('/panel-moving.mjs')).stillWatchers());
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

// ---- 枝のある会話の筋・枝の線・会話の点（目次の地図）が、止まったあと「その幅でゼロから描いた位置」と同じか ----
const TURN = '#thread > .mw > .mw-body > .m.user:not(.cmd)';
/** 発言を 1 つ送り、返答が終わるまで待つ（発言の数と送信の可否で待つ） */
const sendEcho = async (page, text) => {
  const turns = await page.evaluate(selector => document.querySelectorAll(selector).length, TURN);
  await page.locator('#prompt').fill(`echo:${text}`);
  await page.locator('#send').click();
  await page.waitForFunction(({ selector, turns }) => document.querySelectorAll(selector).length > turns && !document.querySelector('#send').disabled, { selector: TURN, turns }, { timeout: 20000 });
};
/** 画面を開き直して今の会話を履歴から描かせ、量りの仕掛けを入れ直す（送った直後の発言は live: の行で、履歴の添字の行（m:N）になるのは開き直したあと） */
const reopen = async page => {
  await page.reload();
  await page.locator('#prompt').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.locator('.mw[data-key="m:1"] .m[data-uuid]').waitFor({ state: 'attached', timeout: 15000 });
  await page.waitForTimeout(1500);
  await install(page);
};
/** 最初の返答の終わりから分岐する（tests/browser/branches.cjs と同じ手順） */
const forkFirst = async page => {
  await page.locator('.mw[data-key="m:1"] .m').hover();
  await page.locator('.mw[data-key="m:1"] .who-more').click();
  await page.getByRole('menuitem', { name: 'ここから分岐', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.branch-tip').length === 2 && !document.querySelector('.branch-tip:disabled') && !document.querySelector('.branch-row[data-phase="growing"]'), null, { timeout: 15000 });
};
/** 筋の線・枝の行の線と位置・会話の点（地図）の位置と、点があるべき位置（発言の行の位置から計算）を読む */
const probe = page => page.evaluate(() => {
  const thread = document.querySelector('#thread'), log = document.querySelector('#log');
  const paths = node => [...node.querySelectorAll('path')].map(p => p.getAttribute('d'));
  const svg = thread.querySelector(':scope > .spine');
  const rows = [...thread.children].filter(row => row.classList.contains('branch-row')).map(row => ({ top: row.offsetTop, w: row.clientWidth, d: paths(row), tips: [...row.querySelectorAll('.branch-tip')].map(tip => tip.style.left) }));
  const users = [...thread.querySelectorAll(':scope > .mw > .mw-body > .m.user:not(.cmd)')];
  const logTop = log.getBoundingClientRect().top, h = log.clientHeight - 30, total = log.scrollHeight;   // 30 = conversation-rail.mjs の上下の余白
  const want = users.map(user => Math.max(8, Math.min(h - 8, (user.closest('.mw').getBoundingClientRect().top - logTop + log.scrollTop) / total * h)) - 8);
  const rail = document.querySelector('.nav-rail');
  const dots = [...document.querySelectorAll('.nav-rail .nav-dot')].map(dot => parseFloat((dot.style.transform.match(/-?[\d.]+/) ?? [NaN])[0]));
  return { spine: svg ? paths(svg) : null, rows, width: thread.clientWidth, turns: users.length, dots, want, railShown: !!rail && !rail.hidden };
});
/** ゼロから描いた位置にする（筋の置き場を作り直して置き場の記憶を捨て、枝の行は毎回描き直す） */
const redraw = page => page.evaluate(async () => {
  const { layoutBranchSpine } = await import('/branch-view.mjs');
  const thread = document.querySelector('#thread'), svg = thread.querySelector(':scope > .spine');
  svg.replaceWith(svg.cloneNode(true));
  layoutBranchSpine(thread);
});
const shape = p => JSON.stringify([p.spine, p.rows]);
const worstDot = p => p.dots.length === p.want.length ? Number(Math.max(0, ...p.dots.map((y, i) => Math.abs(y - p.want[i]))).toFixed(2)) : Infinity;
const railOk = p => p.railShown && p.turns >= 2 && p.dots.length === p.turns && worstDot(p) <= 1.5;
/** 点の置き直しは測り直しの 300ms 後なので、点が合うまで状態で待つ（上限あり）。合わなければ最後の読みを返す */
async function railSettled(page, limit = 4000) {
  const until = Date.now() + limit;
  for (;;) {
    const p = await probe(page);
    if (railOk(p) || Date.now() > until) return p;
    await page.waitForTimeout(60);
  }
}
/** 読みが 2 回続けて同じになるまで待つ（返答のあとの実寸の確定が済む） */
async function stable(page, limit = 6000) {
  const until = Date.now() + limit;
  let last = JSON.stringify(await probe(page));
  for (;;) {
    await page.waitForTimeout(250);
    const now = JSON.stringify(await probe(page));
    if (now === last || Date.now() > until) return;
    last = now;
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
    await waitWork(page);   // 目次の量りは間引くので、止まったあとの再実行を待つ
    const open = await read(page);
    const openState = await state(page);
    check('opening the panel leaves it open with no leftovers', cleanOpen(openState), JSON.stringify(openState));
    check('opening: the frames of the motion were really sampled', open.samples.length >= 12, `${open.samples.length} samples`);
    const handoffOpen = open.moving.handoff;
    check('opening: the head icon / ✖ handoff measures at the start only, not every frame', handoffOpen <= 12, `${handoffOpen} reads while moving, over ${open.samples.length} frames`);
    check('opening: nothing that reacts to the column width measures while the panel moves', open.moving.spine === 0 && open.moving.nav === 0, JSON.stringify({ moving: open.moving, stacks: open.stacks }));
    check('opening: the stopped work runs after the motion ends (spine and nav measure once it settles)', open.still.spine > 0 && open.still.nav > 0 && open.settled >= 1, JSON.stringify({ still: open.still, settled: open.settled }));

    check('opening: after the stop no stopped call is left waiting (the watcher list is empty)', (await watchers(page)) === 0, `watchers=${await watchers(page)}`);

    // ---- 閉じる ----
    await reset(page, { sampling: true });
    await closePanel(page);
    await waitStill(page);
    await waitWork(page);
    const closed = await read(page);
    const closedState = await state(page);
    check('closing the panel leaves it closed with no leftovers', cleanClosed(closedState), JSON.stringify(closedState));
    check('closing: the handoff measures at the start only', closed.moving.handoff <= 12 && closed.samples.length >= 12, `${closed.moving.handoff} reads while moving, over ${closed.samples.length} frames`);
    check('closing: nothing that reacts to the column width measures while the panel moves, and it runs once after', closed.moving.spine === 0 && closed.moving.nav === 0 && closed.still.spine > 0 && closed.still.nav > 0 && closed.settled >= 1,
      JSON.stringify({ moving: closed.moving, still: closed.still, settled: closed.settled }));
    check('closing: after the stop no stopped call is left waiting (the watcher list is empty)', (await watchers(page)) === 0, `watchers=${await watchers(page)}`);

    // ---- 閉じ方を持たない持ち主（会話の目次: Channels のスレッドは開くたびに作って捨てる）: 動いている間に抱えた分は、止まると 1 度で外れる ----
    const orphan = await page.evaluate(async () => {
      const { createConversationNav } = await import('/conversation-nav-view.mjs');
      const { announceSettled, stillWatchers } = await import('/panel-moving.mjs');
      const frames = n => new Promise(resolve => { const step = left => left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)); step(n); });
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:100px;overflow:hidden;opacity:0;pointer-events:none';
      document.body.append(host);
      const logs = [];
      for (let i = 0; i < 20; i++) {
        const frame = document.createElement('div'), log = document.createElement('div');
        log.style.cssText = 'width:150px;height:80px;overflow:auto';
        frame.append(log); host.append(frame);
        createConversationNav({ frame, log, thread: log, scrollToEnd() {}, isRunning: () => false, narrow: matchMedia('(max-width: 700px)') });
        logs.push(log);
      }
      await frames(3);
      const base = stillWatchers();
      document.body.classList.add('file-preview-moving');
      logs.forEach((log, i) => { log.style.width = `${100 + i}px`; });
      await frames(3);
      const held = stillWatchers();
      host.remove();   // 閉じ方を呼ばずに捨てる
      document.body.classList.remove('file-preview-moving');
      announceSettled();
      await frames(6);
      return { base, held, after: stillWatchers() };
    });
    check('a table of contents dropped without a disposer holds a stopped call only while the panel moves, and the list is empty after the stop',
      orphan.held >= orphan.base + 20 && orphan.after === orphan.base, JSON.stringify(orphan));

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
      await waitWork(page);
      reversal[forceMeasure ? 'b' : 'a'] = await read(page);
      if (!forceMeasure) {
        const s = await state(page), r = reversal.a;
        check('reversing mid-motion ends closed with no leftovers', cleanClosed(s), JSON.stringify(s));
        check('reversing mid-motion: the stopped work runs once at the end, not at the turn', r.settled >= 1 && r.moving.spine === 0 && r.moving.nav === 0 && r.still.spine > 0 && r.still.nav > 0,
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
    await waitWork(page, { signal: false });   // 動かさないので「止まった合図」は出ない
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
    await waitWork(page);
    const resized = await read(page);
    const resizedState = await state(page);
    check('resizing the window mid-motion ends open with no leftovers', cleanOpen(resizedState), JSON.stringify(resizedState));
    const stray = resized.samples.filter(s => ![s.left, s.top, s.w, s.g].every(Number.isFinite) || s.left < -50 || s.left > 1300);
    check('resizing the window mid-motion: the flying icon always has finite positions inside the window', resized.samples.length >= 4 && stray.length === 0, JSON.stringify(stray.slice(0, 3)));
    check('resizing the window mid-motion: the width-reactive work ran after the motion', resized.still.spine > 0 && resized.still.nav > 0 && resized.settled >= 1, JSON.stringify({ still: resized.still, settled: resized.settled }));
    // 止まったあとの窓の大きさの変化には、すぐ反応する（止めたままにならない）
    await reset(page);
    await page.setViewportSize({ width: 1240, height: 800 });
    await page.waitForFunction(() => window.__cost.still.spine + window.__cost.still.nav > 0, null, { timeout: 8000, polling: 'raf' });
    const afterResize = await read(page);
    check('after the motion a window resize makes the width-reactive work run again', afterResize.still.spine + afterResize.still.nav > 0, JSON.stringify(afterResize.still));
    await closePanel(page); await waitStill(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);

    // ---- 動きの途中で会話を替える: 動きが止まったとき、止めた処理が止まったままにならない ----
    await reset(page);
    await openPanel(page);
    await clickMid(page, '#newSession');
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

    // ---- 枝のある会話: 筋・枝の線・会話の点は、止まったあと「その幅でゼロから描いた位置」と同じ ----
    const LONG = '右の欄の動きの確認のための長い発言です。幅が替わると折り返しの行数が替わります。'.repeat(6);
    await page.locator('#newSession').click();
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 0, TURN, { timeout: 8000 });
    await sendEcho(page, `${LONG}0`);
    await reopen(page);   // 分岐は履歴の行（m:1）から。送った直後の行は live: のままなので、開き直して履歴から描かせる
    await forkFirst(page);
    for (let i = 1; i < 7; i++) await sendEcho(page, `${LONG}${i}`);
    await stable(page);
    const verify = async (label, r, { moved = null } = {}) => {
      const settled = await railSettled(page);
      await redraw(page);
      const fresh = await probe(page);
      check(`${label}: the spine and the branch rows equal the ones drawn from scratch at that width`, shape(settled) === shape(fresh), JSON.stringify({ width: settled.width, spine: settled.spine?.length, rows: settled.rows.length }));
      check(`${label}: the map dots sit where the turns are`, railOk(settled), JSON.stringify({ shown: settled.railShown, dots: settled.dots.length, turns: settled.turns, worst: worstDot(settled) }));
      if (r) check(`${label}: the stopped work ran once for the stop (spine passes)`, r.passes === 1, `passes=${r.passes} ${JSON.stringify({ duringMotion: r.passesMoving, moving: r.moving, still: r.still, settled: r.settled })}`);
      if (moved) check(`${label}: the width really changed the drawing (the test is not vacuous)`, settled.width !== moved.width && shape(settled) !== shape(moved), JSON.stringify({ was: moved.width, now: settled.width }));
      return settled;
    };
    const rest = await verify('branched conversation at rest', null);
    check('the branched conversation has a branch row and enough turns for the map', rest.rows.length >= 1 && rest.turns >= 6, JSON.stringify({ rows: rest.rows.length, turns: rest.turns }));

    await reset(page);
    await openPanel(page); await waitStill(page); await waitWork(page);
    const branchOpen = await verify('branched: opening', await read(page), { moved: rest });
    await reset(page);
    await closePanel(page); await waitStill(page); await waitWork(page);
    const branchClosed = await verify('branched: closing', await read(page));
    check('branched: closing returns the spine and branch rows to where they started', shape(branchClosed) === shape(rest));

    // 開く途中で折り返す（今の位置と速さから戻る）: 折り返した所ではなく、止まった所の幅で置く
    await reset(page);
    await openPanel(page); await waitMid(page, 0.4);
    await page.evaluate(() => document.querySelector('.panel-flier').click());
    await waitStill(page); await waitWork(page);
    await verify('branched: reversal mid-motion', await read(page));
    check('branched: reversal mid-motion ends where it started', shape(await probe(page)) === shape(rest));

    // 動いている間・止まった直後に発言が足されても、止まったときの置き直しが足された高さを取りこぼさない
    await reset(page);
    await openPanel(page); await waitMid(page, 0.5);
    await sendEcho(page, `${LONG}動きの間に足した`);
    await waitStill(page); await waitWork(page);
    await stable(page);
    await verify('branched: a turn added while the panel moves', null);
    await closePanel(page); await waitStill(page); await waitWork(page);
    await reset(page);
    await openPanel(page);
    await page.waitForFunction(() => window.__cost.settled >= 1, null, { timeout: 8000, polling: 'raf' });
    await sendEcho(page, `${LONG}止まった直後に足した`);   // 止まった合図の直後に足す（置き直しの前後で高さが変わる）
    await waitStill(page); await stable(page);
    await verify('branched: a turn added right after the stop', null);
    await closePanel(page); await waitStill(page);
    await stable(page);

    // 動きの途中で、いまのタブを閉じる（最後のタブは新しいタブに替わり、欄は開いたまま）: 動いている印が残らず、止めた処理が止まったままにならない
    await reset(page);
    await openPanel(page); await waitMid(page, 0.4);
    await page.evaluate(() => document.querySelector('#filePreview .bu-tab.on .bu-tab-close')?.click());
    await waitStill(page); await waitWork(page);
    const tabState = await state(page);
    check('closing the tab mid-motion ends open (the last tab becomes a new one) with no leftovers', cleanOpen(tabState), JSON.stringify(tabState));
    await verify('branched: tab closed mid-motion', await read(page));
    await reset(page);
    await closePanel(page); await waitStill(page); await waitWork(page);
    check('after the tab closed mid-motion the panel closes and the work runs again', cleanClosed(await state(page)), JSON.stringify(await state(page)));

    // 動いている間に頭の行の右側の並びが替わる（✖ の右に物が足される）: 終わりに近づいたときの量り直しで、最後のコマの絵が本物の ✖ に合う
    await reset(page, { sampling: true });
    await openPanel(page); await waitMid(page, 0.3);
    await page.evaluate(() => {
      const x = document.querySelector('#filePreview .bu-panel-close'), spacer = document.createElement('span');
      spacer.id = 'rpmcSpacer'; spacer.style.cssText = 'display:inline-block;flex:none;width:44px;height:1px';
      x.after(spacer);
    });
    await waitStill(page);
    const lateRead = await read(page);
    const lastFrame = lateRead.samples[lateRead.samples.length - 1];
    const realX = await page.evaluate(() => { const r = document.querySelector('#filePreview .bu-panel-close').getBoundingClientRect(); return { left: r.left, top: r.top }; });
    check('the head row changes mid-motion: the last frame of the flying icon lands on the real ✖', !!lastFrame && Math.abs(lastFrame.left - realX.left) <= 1.5, JSON.stringify({ lastFrame, realX }));
    await page.evaluate(() => document.getElementById('rpmcSpacer')?.remove());
    await closePanel(page); await waitStill(page); await waitWork(page);

    // ばねが動きの途中で例外を投げて外れる: 動いている印が残らず、止めた処理（筋・目次）に止まった合図が届く
    await reset(page);
    await openPanel(page); await waitMid(page, 0.4);
    await page.evaluate(() => {
      const style = document.body.style;
      style.setProperty = function() { delete style.setProperty; throw new Error('test: the spring update throws'); };
      window.__restoreSetProperty = () => { delete style.setProperty; };
    });
    await waitStill(page); await waitWork(page);
    await page.evaluate(() => window.__restoreSetProperty?.());
    const failedState = await state(page);
    check('a spring that throws mid-motion leaves no moving mark, and the page ends in a settled shape', !failedState.moving && !failedState.leaving && !failedState.flier && failedState.shownVar === '', JSON.stringify(failedState));
    const failedRead = await read(page);
    check('a spring that throws mid-motion: the settle signal reached the stopped work', failedRead.settled >= 1 && failedRead.still.spine > 0, JSON.stringify({ settled: failedRead.settled, still: failedRead.still }));
    if (failedState.open) { await closePanel(page); await waitStill(page); await waitWork(page); }

    // 動きの途中で会話を替える: 替えた先の筋でも止めた処理が走る（止まったままにならない）
    await reset(page);
    await openPanel(page); await waitMid(page, 0.3);
    await page.locator('#newSession').click();
    await waitStill(page);
    await page.waitForFunction(() => window.__cost.settled >= 1 && window.__cost.still.spine > 0, null, { timeout: 8000, polling: 'raf' });
    const other = await probe(page);
    await redraw(page);
    check('switching mid-motion: the new conversation draws its spine as from scratch', shape(other) === shape(await probe(page)));
    const switched = await state(page);
    if (switched.open) { await closePanel(page); await waitStill(page); }
    check('switching mid-motion: the page is not left in the moving state', !switched.moving && !switched.leaving && !switched.flier, JSON.stringify(switched));

    // ---- 作業のダイアログの子の会話: 右の欄を開け閉めしても、子の筋はゼロから描いた位置と同じ・実例を閉じたあとに見張りが残らない ----
    // ダイアログの中の欄が wantOpen の姿で止まるまで（開く印と、動いている・片付け中の印・受け渡しの絵が消えるまで）状態で待つ
    const dialogMoving = (wantOpen = true) => page.waitForFunction(open => {
      const dialog = document.querySelector('#workDialog');
      return dialog.classList.contains('file-preview-open') === open && !document.querySelector('.file-preview-moving, .file-preview-leaving, .fp-leaving') && !document.querySelector('.panel-flier:not([hidden])');
    }, wantOpen, { timeout: 15000, polling: 'raf' });
    const childShape = () => page.evaluate(async () => {
      const body = document.querySelector('#workBody'), svg = body.querySelector('.spine'), thread = svg?.parentElement;
      if (!thread) return null;
      const { layoutBranchSpine } = await import('/branch-view.mjs');
      const paths = n => [...n.querySelectorAll('path')].map(p => p.getAttribute('d'));
      const now = paths(svg);
      svg.replaceWith(svg.cloneNode(true)); layoutBranchSpine(thread);
      return { now, scratch: paths(thread.querySelector('.spine')), width: thread.clientWidth };
    });
    await page.locator('#prompt').fill('ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { backend: 'fake', kind: 'mechanical', title: '子の会話', task: 'echo:済み' } }));
    await page.locator('#send').click();
    const goCard = page.locator('.tc[data-tool$="ply_delegate"][data-task-id] .tc-go').first();
    await goCard.waitFor({ state: 'attached', timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('#send').disabled, null, { timeout: 30000 });
    const before = await watchers(page);
    const childWidths = [];
    for (let round = 1; round <= 3; round++) {
      await goCard.click();
      await page.waitForFunction(() => document.querySelector('#workDialog')?.open && !!document.querySelector('#workBody .spine'), null, { timeout: 15000 });
      await page.waitForFunction(() => { const b = document.querySelector('#workBrowserEntry'); return b && !b.hidden && b.getBoundingClientRect().width > 0; }, null, { timeout: 15000 });
      await page.waitForTimeout(500);
      await mouseOn(page, '#workBrowserEntry');
      await dialogMoving(true);
      await page.waitForTimeout(500);
      const opened = await childShape();
      check(`child conversation (round ${round}): after the panel opens in the dialog the spine equals a fresh draw`, !!opened && JSON.stringify(opened.now) === JSON.stringify(opened.scratch), JSON.stringify(opened));
      childWidths.push(opened?.width);
      await mouseOn(page, '#filePreview .bu-panel-close');
      await dialogMoving(false);
      await page.waitForTimeout(500);
      const closed = await childShape();
      check(`child conversation (round ${round}): after the panel closes in the dialog the spine equals a fresh draw`, !!closed && JSON.stringify(closed.now) === JSON.stringify(closed.scratch), JSON.stringify(closed));
      childWidths.push(closed?.width);
      await page.evaluate(() => document.querySelector('#workDialog')?.close());
      await page.waitForFunction(() => !document.querySelector('#workDialog')?.open, null, { timeout: 8000 });
      await page.waitForTimeout(300);
    }
    check('child conversation: opening and closing the dialog and its panel does not leave still-watchers behind', (await watchers(page)) === before, `before=${before} after=${await watchers(page)}`);
    check('child conversation: the panel really changed the child column width (the test is not vacuous)', childWidths.every((w, i) => i % 2 === 0 ? w < childWidths[i + 1] : true) && childWidths.length === 6, JSON.stringify(childWidths));

    check('no page errors during the motions', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } finally {
    await server.stop?.();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
