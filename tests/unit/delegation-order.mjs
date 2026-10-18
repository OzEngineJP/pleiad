import { setupDelegationSettings } from '../../web/delegation-settings.mjs';
import { moveCandidate } from '../../web/delegation-order.mjs';
import { normalizeSettings } from '../../core/delegation-routing.mjs';
import { el } from '../../web/dom.mjs';
import { N } from '../lib/dom-stub.mjs';
import { createContextMenu } from '../../web/context-menu.mjs';

export const name = 'delegation-order';
export const title = '委譲候補の並べ替え: キーボード・移動メニュー・保存の連続操作・失敗時の復帰';

export default async function (t) {
  const defaults = normalizeSettings({ tiers: { t1: ['fake:a', 'fake:b', 'fake:c'] } });
  let stored = structuredClone(defaults), fail = false, held = null, menu;
  const sent = [];
  const state = () => structuredClone({ settings: stored, defaults, tiers: ['t1'], kinds: [], judges: [],
    candidates: ['a', 'b', 'c'].map(model => ({ candidate: `fake:${model}`, backend: 'fake', model, usable: true, effort: { levels: [], fixed: null } })),
    keys: { openrouter: { hasKey: true } }, conversationEfforts: {}, storage: {} });
  const cmd = async (command, args) => {
    if (command === 'setDelegationRouting') {
      sent.push(args.settings);
      if (held) await held;
      if (fail) throw new Error('save unavailable');
      const patch = args.settings.tiers;
      stored.tiers = patch === null ? structuredClone(defaults.tiers) : { ...stored.tiers, ...patch };
    }
    return state();
  };
  const root = el('div'), tab = el('button');
  const saved = { get: document.getElementById, active: document.activeElement, focus: N.prototype.focus };
  document.getElementById = id => ({ delegationPanel: root, delegationTab: tab })[id];
  N.prototype.focus = function () { document.activeElement = this; };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const rows = () => root.querySelectorAll('.rt-cand-row');
  const handle = candidate => rows().find(row => row.dataset.candidate === candidate).querySelector('.rt-grip');
  const press = (candidate, key) => handle(candidate).onkeydown({ key, preventDefault() {}, stopPropagation() {} });
  try {
    const ui = setupDelegationSettings({ cmd, page() {}, showMenu: (_x, _y, items) => { menu = items; },
      labelOf: id => id, logo: () => el('span'), modelsOf: async () => ({}), modelName: (_b, m) => m });
    await ui.refresh();
    t.ok('取っ手の名前とメニューの意味が読み上げに出る', handle('fake:a').getAttribute('aria-label').includes('a') && handle('fake:a').getAttribute('aria-haspopup') === 'menu');
    press('fake:a', 'ArrowUp'); press('fake:a', 'Home');
    handle('fake:a').onkeydown({ key: 'ArrowDown', defaultPrevented: true });
    t.ok('境界と同じ位置への移動では保存しない', sent.length === 0);
    press('fake:c', 'Home'); await flush();
    t.ok('先頭への移動は選んだ候補だけを動かし、他の段を変えない', stored.tiers.t1.join() === 'fake:c,fake:a,fake:b' && stored.tiers.t2.join() === defaults.tiers.t2.join());
    t.ok('保存の送信は一度。変更した段だけを送る', sent.length === 1 && Object.keys(sent[0].tiers).join() === 't1');
    t.ok('描き直し後も移動した取っ手にフォーカスが残る', document.activeElement === handle('fake:c'));
    press('fake:c', 'End'); await flush();
    t.ok('既定の順序へ戻したときは既定値を凍らせず null を送る', sent.at(-1).tiers === null && stored.tiers.t1.join() === defaults.tiers.t1.join());
    const b = handle('fake:b'); b.getBoundingClientRect = () => ({ left: 0, bottom: 30 }); b.onclick();
    t.ok('移動メニューに先頭・上・下・最後の操作がある', menu.length === 4 && menu.every(item => typeof item.onClick === 'function'));
    menu[3].onClick(); await flush();
    t.ok('クリックだけで最後へ移動できる', stored.tiers.t1.join() === 'fake:a,fake:c,fake:b');
    fail = true;
    press('fake:b', 'Home'); await flush();
    t.ok('保存に失敗すると元の順序に戻り理由を表示する', rows().map(row => row.dataset.candidate).join() === stored.tiers.t1.join() && root.textContent.includes('save unavailable'));
    fail = false;
    let release; held = new Promise(resolve => { release = resolve; });
    press('fake:b', 'ArrowUp'); press('fake:b', 'Home');
    t.ok('保存中も次の順序をすぐ表示する', rows()[0].dataset.candidate === 'fake:b');
    release(); held = null; await flush(); await flush();
    t.ok('続けて変えた順序を保存の応答で失わない', stored.tiers.t1.join() === 'fake:b,fake:a,fake:c');
    const original = ['a', 'b', 'c'];
    t.ok('範囲外や消えた候補の順序は保存しない', moveCandidate(original, 'x', 0) === null && moveCandidate(original, 'a', -1) === null && moveCandidate(original, 'a', 3) === null && moveCandidate(original, 'a', NaN) === null && original.join() === 'a,b,c');
  } finally {
    document.getElementById = saved.get; document.activeElement = saved.active; N.prototype.focus = saved.focus;
  }
  // 実際の共通メニューを開き、無効な項目を飛ばしてフォーカスする。
  const menuSaved = { body: document.body, add: document.addEventListener, remove: document.removeEventListener,
    active: document.activeElement, query: N.prototype.querySelectorAll, rect: N.prototype.getBoundingClientRect, focus: N.prototype.focus,
    width: globalThis.innerWidth, height: globalThis.innerHeight };
  const listeners = new Map();
  document.body = el('div');
  document.addEventListener = (type, fn) => listeners.set(type, fn);
  document.removeEventListener = type => listeners.delete(type);
  N.prototype.focus = function () { if (!this.disabled) document.activeElement = this; };
  N.prototype.getBoundingClientRect = () => ({ width: 200, height: 180 });
  N.prototype.querySelectorAll = function (selector) {
    return selector === ':scope > button, :scope > input' ? this.children.filter(row => ['BUTTON', 'INPUT'].includes(row.tagName)) : menuSaved.query.call(this, selector);
  };
  globalThis.innerWidth = 800; globalThis.innerHeight = 600;
  const contextMenu = createContextMenu();
  try {
    let chosen = 0;
    const opener = el('button'); opener.isConnected = true; opener.focus();
    contextMenu.open(20, 30, [
      { label: 'first', disabled: true }, { label: 'up', disabled: true },
      { label: 'down', onClick: () => chosen++ }, { label: 'last', onClick: () => chosen++ },
    ]);
    const focused = () => document.activeElement.textContent;
    const key = key => listeners.get('keydown')({ key, target: document.activeElement, preventDefault() {} });
    t.ok('先頭が無効の移動メニューは、最初の有効な項目にフォーカスする', focused() === 'down');
    key('ArrowDown'); t.ok('矢印で無効な項目を飛ばし、有効な項目だけを移動する', focused() === 'last');
    key('Home'); t.ok('Home は無効な先頭項目を飛ばし、項目確定前は保存しない', focused() === 'down' && chosen === 0);
    key('End'); document.activeElement.onclick();
    t.ok('確定した項目だけを一度呼び、元の取っ手へ戻る', chosen === 1 && document.activeElement === opener);
  } finally {
    contextMenu.close();
    document.body = menuSaved.body; document.addEventListener = menuSaved.add; document.removeEventListener = menuSaved.remove;
    document.activeElement = menuSaved.active; N.prototype.querySelectorAll = menuSaved.query; N.prototype.getBoundingClientRect = menuSaved.rect; N.prototype.focus = menuSaved.focus;
    for (const [key, value] of [['innerWidth', menuSaved.width], ['innerHeight', menuSaved.height]]) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}
