// 稼働表示（web/client.mjs の activity）は会話の筋の末尾の節。入力欄の上の帯（#contextStrip）には入れない（ADR 0265）。
// 帯は作業ボタン・文脈・使用量だけで出し入れし、稼働表示の有無で変えない。
import fs from 'node:fs';
import vm from 'node:vm';
import { N } from '../lib/dom-stub.mjs';
import { el } from '../../web/dom.mjs';
import { runMark, satMark } from '../../web/arc.mjs';

export const name = 'activity-strip';
export const title = '稼働表示は筋の末尾の節（弧・衛星）。入力欄の上の帯は作業とメーターだけで出し入れする';

// dom-stub の matches は 1 つの class だけ。wrap が使う「.m.activity」「.m:not(.sys):not(.cont):not(.activity)」を読めるようにする
const matches = (node, sel) => sel.split(',').some(one => {
  const not = [...one.matchAll(/:not\(\.([\w-]+)\)/g)].map(m => m[1]);
  const has = one.replace(/:not\([^)]*\)/g, '').split('.').filter(Boolean);
  const classes = node._classes?.() ?? [];
  return has.every(c => classes.includes(c)) && not.every(c => !classes.includes(c));
});

export default function(t) {
  const src = fs.readFileSync(new URL('../../web/client.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const cut = name => { const at = src.indexOf(`function ${name}(`); return src.slice(at, src.indexOf('\n}', at) + 2); };
  const actor = src.slice(src.indexOf('const activity = {'), src.indexOf('// ---------------------------------------------------------------- thinking'));
  const thread = new N('div'), strip = new N('div');
  const nodes = { contextStrip: strip, usageChip: new N('button'), workEntry: new N('div') };
  for (const n of Object.values(nodes)) strip.append(n);
  nodes.usageChip.hidden = nodes.workEntry.hidden = true;
  let narrow = true, context = false, live = 0, running = true, behind = null;
  const timers = new Set();
  const connected = node => { for (let x = node; x; x = x.parent) if (x === thread || x === strip) return true; return false; };
  const make = (...args) => {
    const node = el(...args);
    node.matches = sel => matches(node, sel);
    node.closest = sel => { for (let x = node; x; x = x.parent) if (x.matches?.(sel)) return x; return null; };
    Object.defineProperty(node, 'isConnected', { get: () => connected(node) });
    return node;
  };
  const ctx = vm.createContext({ el: make, $: id => nodes[id], runMark, satMark, t: key => key, thread, log: {},
    runningTools: { size: 0, clear() {}, el: new N("div") }, matchMedia: () => ({ matches: true }),
    paintingHistory: false, paintBefore: null, atBottom: () => false,
    Date, setTimeout, clearTimeout, setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    turnStartHere: () => 1, behindHere: () => behind, stoppingHere: () => false,
    isRunningHere: () => running, backgroundCounts: () => ({ live }), relayoutBranches() {},
    ACTIVITY_LABEL: { running: 'working' }, clock: String, state: { bundle: null, busy: true }, closeMeterPop() {},
    narrowView: { get matches() { return narrow; } }, get contextShown() { return context; },
    stripIsNarrow: () => narrow,
    syncWorkEntry() { ctx.syncStripVisible(); },
  });
  vm.runInContext(`${cut('syncStripVisible')}\n${cut('wrap')}\n${cut('place')}\n${cut('append')}\n${actor}\nthis.activity = activity;`, ctx);
  const a = ctx.activity;
  const say = text => { const m = make('div', 'm ai'); m.textContent = text; ctx.append(m); return m; };

  say('こんにちは');
  ctx.syncStripVisible();
  t.ok('スマホで表示対象がなければ帯を隠す', strip.hidden);
  a.show('working');
  const first = a.el, row = first.closest('.mw');
  t.ok('稼働表示は筋（#thread）の最後の子の節で、帯には入れない',
    row.parent === thread && thread.lastChild === row && row.classList.contains('activity') && !strip.contains(first));
  t.ok('待ちだけでは帯を出さない（帯は稼働表示に左右されない）', strip.hidden);
  t.ok('節の点は溝が描き、印・文言・経過は本文の列に並ぶ',
    row.children[0].className === 'mw-gutter' && row.children[0].children.length === 0 &&
    first.children.map(c => c.className).join(' ') === 'activity-tip txt el');
  t.ok('走っている間は弧（270° の道 1 本）', first.querySelector('.activity-tip').children[0]?.className === 'run' &&
    first.querySelectorAll('path').length === 1 && first.querySelectorAll('circle').length === 0);
  t.ok('点滅するドット・帯の印は使わない', !first.querySelector('.wait-dot') && !first.querySelector('.wait-mark') && !row.querySelector('.wait-band'));
  say('次の発言');
  t.ok('新しい発言は稼働表示の手前に入り、稼働表示は末尾のまま', thread.lastChild === row && thread.children.at(-2).querySelector('.m').textContent === '次の発言');

  behind = { n: 2, label: 'waiting for children' };
  a.sync();
  t.ok('裏の結果待ちは同じ行のまま衛星（点 2 個）に替わる', a.el === first && first.querySelector('.txt').textContent === behind.label &&
    first.querySelector('.activity-tip').children[0]?.className === 'run sat' && first.querySelectorAll('circle').length === 2);
  behind = { n: 5, label: 'waiting for children' };
  a.sync();
  t.ok('衛星の点は 3 個まで', first.querySelectorAll('circle').length === 3);

  nodes.workEntry.hidden = false;
  ctx.syncStripVisible();
  t.ok('作業があれば帯を出す', !strip.hidden);
  a.hide();
  t.ok('待ちが消えれば筋から節を外し、作業のある帯は残す', !thread.children.some(c => c.classList?.contains('activity')) && !strip.hidden && timers.size === 0);
  nodes.workEntry.hidden = true;
  ctx.syncStripVisible();
  t.ok('作業もなくなれば帯を隠す', strip.hidden);
  narrow = false; context = true;
  ctx.syncStripVisible();
  t.ok('PCでは文脈だけの帯を残す', !strip.hidden);
  context = false; nodes.usageChip.hidden = false;
  ctx.syncStripVisible();
  t.ok('PCでは使用量だけの帯も残す', !strip.hidden);
  nodes.usageChip.hidden = true;
  ctx.syncStripVisible();
  t.ok('PCでも何も無ければ帯を隠す', strip.hidden);

  behind = { n: 2, label: 'waiting for children' };
  ctx.runningTools.size = 1;
  a.show('writing');
  t.ok('親のツール行は子の待ちより優先し、汎用表示を重ねない', a.behind === null && a.el.classList.contains('tools-active') && a.el.children.includes(ctx.runningTools.el));
  a.show('thinking');
  t.ok('本文や思考が続いても同じ末尾とツールの入れ物を保つ', a.el.children.includes(ctx.runningTools.el) && a.text === 'thinking');
  ctx.runningTools.size = 0;
  a.show("activity.waitingApproval");
  t.ok("承認を待つ間は回る印を出さない", a.el.querySelectorAll(".run").length === 0);
  a.hide();
  behind = null; live = 1; running = false;
  a.show('background');
  t.ok('待てない端末だけなら動く印と時計を出さない', a.el.querySelectorAll('.run').length === 0 && a.el.querySelector('.el').hidden);
  a.suspend();
  t.ok('ツールが状態を伝える間は汎用の稼働表示を外す', a.el === null && !thread.children.some(c => c.classList?.contains('activity')));
  a.hide();
}
