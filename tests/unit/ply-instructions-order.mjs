import { createPlyInstructions } from '../../web/ply-instructions-card.mjs';
import { t as tr } from '../../web/i18n.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'ply-instructions-order';
export const title = '設定 › コンテキスト「Pleiad の指示」の並べ替え: 取っ手のキーとメニュー・続けて動かす・フォーカス・読み上げ・委譲と連動の行';

// docs/design-system.md「コンテキスト」の「Pleiad の指示の行」。タッチで引く操作は tests/browser/ply-instructions-reorder.mjs
export default async function (t) {
  const item = (id, extra = {}) => ({ id, tag: 'custom', modified: false, name: `指示 ${id.toUpperCase()}`, body: `本文 ${id}`, target: 'all', agents: ['fake'], on: true, tokens: 10, ...extra });
  let stored = [item('a'), item('b'), item('c'), item('d'), item('linked', { tag: 'linked', name: '委譲と連動', target: 'parent' })];
  let fail = false, held = null, menu;
  const sent = [], errors = [];
  const state = () => structuredClone({ items: stored, total: 40, routing: true, heading: '\u0001', agents: [{ id: 'fake', label: 'Fake' }] });
  const cmd = async (command, args) => {
    if (command === 'setPlyInstructions' && args.action === 'order') {
      sent.push(args.ids);
      if (held) await held;
      if (fail) throw new Error('save unavailable');
      const byId = new Map(stored.map(i => [i.id, i]));
      stored = [...args.ids.map(id => byId.get(id)), ...stored.filter(i => i.tag === 'linked')];
    }
    return state();
  };
  const work = async fn => { try { await fn(); } catch (e) { errors.push(e.message); } };
  const saved = { active: document.activeElement, focus: N.prototype.focus, textNode: document.createTextNode };
  document.createTextNode = text => { const node = new N('span'); node.textContent = text; return node; };
  N.prototype.focus = function () { document.activeElement = this; };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const opened = new Set();
  try {
    const card = createPlyInstructions({ cmd, work, saved() {}, opened, showMenu: (_x, _y, items, heading) => { menu = { items, heading }; } });
    const root = card.root;
    const boxes = () => root.querySelectorAll('.cx-item');
    const order = () => boxes().map(box => box.querySelector('.cx-row').dataset.id).join();
    const handle = id => boxes().find(box => box.dataset.order === id).querySelector('.rt-grip');
    const press = (id, key) => handle(id).onkeydown({ key, preventDefault() {}, stopPropagation() {} });
    const status = () => root.querySelectorAll('.visually-hidden')[0];
    await card.load();

    t.ok('動かせる行には委譲の候補と同じ取っ手が付き、名前とメニューの意味を持つ',
      root.querySelectorAll('.rt-grip').length === 4 && handle('a').getAttribute('aria-label') === tr('common.reorder.label', { name: '指示 A' }) && handle('a').getAttribute('aria-haspopup') === 'menu');
    const linkedBox = boxes().at(-1);
    t.ok('「委譲と連動」の行は取っ手を持たず、動かせる行に数えない',
      linkedBox.querySelector('.cx-row').dataset.id === 'linked' && !linkedBox.querySelector('.rt-grip') && Boolean(linkedBox.querySelector('.cx-grip-gap')) && linkedBox.dataset.order === undefined);
    t.ok('読み上げの置き場は polite の status', status().getAttribute('role') === 'status' && status().getAttribute('aria-live') === 'polite');

    press('a', 'ArrowUp'); press('a', 'Home'); press('d', 'ArrowDown'); press('d', 'End');
    handle('a').onkeydown({ key: 'ArrowDown', defaultPrevented: true });
    t.ok('端からさらに外へ・同じ位置へは動かさず、保存もしない', sent.length === 0 && order() === 'a,b,c,d,linked');

    // 保存の応答を待たずに続けて押す
    let release; held = new Promise(resolve => { release = resolve; });
    press('a', 'ArrowDown');
    t.ok('保存を待たずに画面の順番を変え、フォーカスは動かした行の取っ手に残る', order() === 'b,a,c,d,linked' && document.activeElement === handle('a'));
    t.ok('動かした結果を読み上げる（動かせる行の中での位置）', status().textContent === tr('common.reorder.moved', { name: '指示 A', position: 2 }) && status().textContent.includes('指示 A'));
    press('a', 'ArrowDown');
    t.ok('続けて ↓ を押すと、もう 1 つ下へ動く', order() === 'b,c,a,d,linked' && document.activeElement === handle('a'));
    release(); held = null; await flush(); await flush();
    t.ok('続けて動かした順番を、先の保存の応答で失わない', stored.map(i => i.id).join() === 'b,c,a,d,linked' && order() === 'b,c,a,d,linked' && sent.length === 2);
    t.ok('保存する順番に「委譲と連動」を入れない', sent.every(ids => !ids.includes('linked') && ids.length === 4));

    // 保存の後に届く「設定が変わった」の知らせ（web/context.mjs が load を呼ぶ）
    const before = handle('a');
    await card.load();
    t.ok('同じ中身の取り直しでは行を作り直さず、フォーカスが残る', handle('a') === before && document.activeElement === before);
    press('a', 'ArrowUp'); await flush();
    t.ok('取り直しの後も、同じ取っ手から続けて動かせる', order() === 'b,a,c,d,linked' && document.activeElement === handle('a'));

    press('d', 'Home'); await flush();
    t.ok('Home で先頭へ', order() === 'd,b,a,c,linked' && document.activeElement === handle('d'));
    press('d', 'End'); await flush();
    t.ok('End は動かせる行の最後へ。「委譲と連動」は最後のまま', order() === 'b,a,c,d,linked' && stored.at(-1).id === 'linked');

    // 取っ手を押すとメニュー
    const b = handle('b'); b.getBoundingClientRect = () => ({ left: 10, bottom: 30 }); b.onclick();
    t.ok('取っ手を押すと、行き先 4 つのメニューが項目の名前の題で開く',
      menu.items.length === 4 && menu.heading === '指示 B' && menu.items.map(i => i.label).join() === ['first', 'up', 'down', 'last'].map(k => tr(`common.reorder.${k}`)).join());
    t.ok('先頭の行では「先頭へ」「上へ」が無効', menu.items[0].disabled && menu.items[1].disabled && !menu.items[2].disabled && !menu.items[3].disabled);
    menu.items[3].onClick(); await flush();
    t.ok('メニューの「最後へ」', order() === 'a,c,d,b,linked' && document.activeElement === handle('b'));
    handle('b').getBoundingClientRect = () => ({ left: 10, bottom: 30 }); handle('b').onclick();
    t.ok('最後の行では「下へ」「最後へ」が無効', !menu.items[0].disabled && !menu.items[1].disabled && menu.items[2].disabled && menu.items[3].disabled);
    menu.items[1].onClick(); await flush();
    t.ok('メニューの「上へ」', order() === 'a,c,b,d,linked');
    handle('b').getBoundingClientRect = () => ({ left: 10, bottom: 30 }); handle('b').onclick();
    menu.items[2].onClick(); await flush();
    t.ok('メニューの「下へ」', order() === 'a,c,d,b,linked');
    handle('b').getBoundingClientRect = () => ({ left: 10, bottom: 30 }); handle('b').onclick();
    menu.items[0].onClick(); await flush();
    t.ok('メニューの「先頭へ」', order() === 'b,a,c,d,linked' && status().textContent === tr('common.reorder.moved', { name: '指示 B', position: 1 }));

    // 開いた中身は行と一緒に動く
    boxes().find(box => box.dataset.order === 'c').querySelector('.cx-open').onclick();
    t.ok('行を開くと、同じまとまりの中に中身が出る', Boolean(boxes().find(box => box.dataset.order === 'c').querySelector('.cx-peek')) && document.activeElement?.dataset.fk === 'open|c');
    press('c', 'Home'); await flush();
    t.ok('開いた行を動かすと、開いたまま移る', order() === 'c,b,a,d,linked' && Boolean(boxes()[0].querySelector('.cx-peek')) && boxes().filter(box => box.querySelector('.cx-peek')).length === 1);

    fail = true;
    press('c', 'End'); await flush(); await flush();
    t.ok('保存に失敗すると、保存されている順番に戻り、理由を知らせる', order() === 'c,b,a,d,linked' && errors.join() === 'save unavailable');
    fail = false;
  } finally {
    document.activeElement = saved.active; N.prototype.focus = saved.focus; document.createTextNode = saved.textNode;
  }
}
