import fs from 'node:fs';
import vm from 'node:vm';
import { N } from '../lib/dom-stub.mjs';
import { el } from '../../web/dom.mjs';
import { runMark, satMark } from '../../web/arc.mjs';

export const name = 'activity-strip';
export const title = '入力欄の上の待ち行: 表示・終了・作業とメーターだけの段';

export default function(t) {
  const src = fs.readFileSync(new URL('../../web/client.mjs', import.meta.url), 'utf8');
  const actor = src.slice(src.indexOf('const activity = {'), src.indexOf('// ---------------------------------------------------------------- thinking'));
  const visibility = src.slice(src.indexOf('function syncStripVisible()'), src.indexOf('/** 狭い画面（480px'));
  const nodes = Object.fromEntries(['contextStrip', 'usageChip', 'workEntry'].map(id => [id, new N('div')]));
  nodes.usageChip.hidden = nodes.workEntry.hidden = true;
  let narrow = true, context = false, live = 0, running = true, behind = null;
  const timers = new Set();
  const make = (...args) => {
    const node = el(...args);
    Object.defineProperty(node, 'isConnected', { get: () => !!node.parent?.children.includes(node) });
    return node;
  };
  const ctx = vm.createContext({ el: make, $: id => nodes[id], runMark, satMark, t: key => key,
    Date, setTimeout, clearTimeout, setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    turnStartHere: () => 1, behindHere: () => behind, stoppingHere: () => false,
    isRunningHere: () => running, backgroundCounts: () => ({ live }), relayoutBranches() {},
    ACTIVITY_LABEL: { running: 'working' }, clock: String, state: { bundle: null }, closeMeterPop() {},
    narrowView: { get matches() { return narrow; } }, get contextShown() { return context; },
    syncWorkEntry() { ctx.syncStripVisible(); },
  });
  vm.runInContext(`${visibility}\n${actor}\nthis.activity = activity;`, ctx);
  const a = ctx.activity;
  ctx.syncStripVisible();
  t.ok('スマホで表示対象がなければ段を隠す', nodes.contextStrip.hidden);
  a.show('working');
  const first = a.el;
  t.ok('待ちだけでも段を出し、履歴の外に置く', !nodes.contextStrip.hidden && first.parent === nodes.contextStrip);
  t.ok('文言だけを状態として読み上げる', first.querySelector('.txt').getAttribute('role') === 'status' && !first.getAttribute('role'));
  behind = { n: 2, label: 'waiting for children' };
  a.sync();
  t.ok('裏の結果待ちでも同じ行とドットを使う', a.el === first && first.querySelector('.txt').textContent === behind.label && first.querySelectorAll('.wait-dot').length === 1);
  nodes.workEntry.hidden = false;
  a.hide();
  t.ok('待ちが消えても作業のある段を残す', !nodes.contextStrip.hidden && nodes.contextStrip.children.length === 0 && timers.size === 0);
  nodes.workEntry.hidden = true;
  ctx.syncStripVisible();
  t.ok('作業もなくなれば段を隠す', nodes.contextStrip.hidden);
  narrow = false; context = true;
  ctx.syncStripVisible();
  t.ok('PCでは待ちがなくても文脈だけの段を残す', !nodes.contextStrip.hidden);
  context = false; nodes.usageChip.hidden = false;
  ctx.syncStripVisible();
  t.ok('PCでは使用量だけの段も残す', !nodes.contextStrip.hidden);
  nodes.usageChip.hidden = true;
  behind = null; live = 1; running = false;
  a.show('background');
  t.ok('待てない端末だけなら動く印と時計を出さない', a.el.querySelectorAll('.wait-dot').length === 0 && a.el.querySelector('.el').hidden);
  a.suspend();
  t.ok('ツールが状態を伝える間は汎用の待ち行を外す', a.el === null && nodes.contextStrip.hidden);
  a.hide();
}
