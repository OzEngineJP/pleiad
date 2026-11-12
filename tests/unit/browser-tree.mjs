// 右の欄のファイルのツリー（web/browser-tree.mjs）が読めなかったとき（docs/design-system.md「ファイルのツリーと更新」）
//   - 同じパスは描き直しのたびに読み直さない。短い知らせ（notify）も出さない
//   - ツリーの欄の中に「読み込めませんでした」と「再試行」を出す。「再試行」で読み直す
//   - パス・会話が替わったら読み直す。前のパスの遅れて届いた失敗は、今のパスの表示を替えない
import { createBrowserTree } from '../../web/browser-tree.mjs';
import { N } from '../lib/dom-stub.mjs';
import { t as tr } from '../../web/i18n.mjs';

export const name = 'browser-tree';
export const title = '右の欄のファイルのツリーが読めなかったら、読み直しを繰り返さず欄の中に「再試行」を出す（DOM の代役）';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const fileTab = path => ({ page:{ kind:'file', path } });
const okBody = path => ({ tree:[{ id:'/w', name:'w', kind:'directory', children:[{ id:path, name:path.split('/').pop(), kind:'file' }] }] });

function rig({ open = true } = {}) {
  const calls = [], notices = [];
  // answer(path, n) が true なら読める・false なら 404・'throw' ならつながらない・Promise ならその結果を待つ
  let answer = () => false;
  globalThis.fetch = async url => {
    const path = new URL(url, 'http://x').searchParams.get('path');
    calls.push(path);
    const result = await answer(path, calls.length);
    if (result === 'throw') throw new TypeError('Failed to fetch');
    return result ? { ok:true, status:200, json:async () => okBody(path) } : { ok:false, status:404, json:async () => ({ error:{ code:'not-found' } }) };
  };
  if (open) globalThis.localStorage.setItem('pleiad.browser-tree.one', JSON.stringify({ open:true, width:208 }));
  const host = new N('div'); host.clientWidth = 900;
  const explorer = createBrowserTree({ host, open() {}, menu() {}, notify:text => notices.push(text) });
  const root = explorer.root;
  return {
    explorer, root, calls, notices,
    answer(fn) { answer = fn; },
    failed: () => root.querySelector('.bu-explorer-failed'),
    list: () => root.querySelector('.bu-explorer-list'),
    retry: () => root.querySelector('.bu-explorer-failed')?.querySelector('button'),
    rows: () => root.querySelectorAll('.tree-row').map(row => row.querySelector('.nm')?.textContent).filter(Boolean),
  };
}

export default async function (t) {
  const old = { fetch:globalThis.fetch, observer:globalThis.ResizeObserver, media:globalThis.matchMedia, storage:globalThis.localStorage, create:document.createElement, active:document.activeElement };
  const store = new Map();
  globalThis.localStorage = { getItem:key => store.get(key) ?? null, setItem:(key, value) => { store.set(key, String(value)); }, removeItem:key => { store.delete(key); } };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.matchMedia = () => ({ matches:false, addEventListener() {}, removeEventListener() {} });
  // 代役の style は removeProperty を持たない（ツリーの開け閉めの描画が使う）
  document.createElement = tag => { const node = old.create(tag); node.style.removeProperty = key => { delete node.style[key]; }; return node; };
  try {
    {
      const r = rig();
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      t.ok('読めなかったら 1 回だけ読んでいる', r.calls.length === 1, JSON.stringify(r.calls));
      for (let i = 0; i < 5; i++) await r.explorer.show(fileTab('/w/a.md'), 'one');
      await flush();
      t.ok('同じパスの描き直しを繰り返しても、読み直さない', r.calls.length === 1, `読んだ回数 ${r.calls.length}`);
      t.ok('短い知らせ（notify）を出さない', r.notices.length === 0, `知らせ ${r.notices.length} 回: ${JSON.stringify(r.notices.slice(0, 2))}`);
      t.ok('ツリーの欄は開いている', r.root.hidden === false);
      t.ok('欄の中に「読み込めませんでした」を出す', r.failed()?.hidden === false && r.failed().shown.includes(tr('filePreview.treeLoadFailed')), r.failed()?.outerHTML);
      t.ok('「再試行」のボタンを出す', r.retry()?.textContent === tr('filePreview.treeRetry') && r.retry().type === 'button', r.retry()?.outerHTML);
      t.ok('読めなかった間は、ツリーの一覧を隠す', r.list()?.hidden === true);

      // 再試行: もう一度読めなければ、そのまま。読めたら一覧に戻す
      r.retry().click(); await flush();
      t.ok('「再試行」で読み直す', r.calls.length === 2, `読んだ回数 ${r.calls.length}`);
      t.ok('また読めなければ「読み込めませんでした」のまま、知らせも出さない', r.failed().hidden === false && r.notices.length === 0);
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      t.ok('再試行が失敗した後も、描き直しでは読み直さない', r.calls.length === 2, `読んだ回数 ${r.calls.length}`);
      r.answer(() => true);
      r.retry().click(); await flush();
      t.ok('読めたら「読み込めませんでした」を消して、一覧を出す', r.calls.length === 3 && r.failed().hidden === true && r.list().hidden === false && r.rows().includes('a.md'), `${r.calls.length} ${JSON.stringify(r.rows())}`);
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      t.ok('読めた後の描き直しでも読み直さない', r.calls.length === 3);
    }
    {
      // パスが替わったら読み直す。同じパスへ戻ったときも読み直す（パスが替わったので）
      const r = rig();
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      r.answer(path => path === '/w/b.md');
      await r.explorer.show(fileTab('/w/b.md'), 'one');
      t.ok('パスが替わったら読み直し、読めたら一覧を出す', r.calls.join() === '/w/a.md,/w/b.md' && r.failed().hidden === true && r.rows().includes('b.md'), JSON.stringify(r.calls));
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      t.ok('読めなかったパスへ戻ったら、もう一度読んで「読み込めませんでした」を出す', r.calls.length === 3 && r.failed().hidden === false && r.list().hidden === true, JSON.stringify(r.calls));
      t.ok('読めなかったときは、前のパスのツリーを残さない', r.rows().length === 0, JSON.stringify(r.rows()));
      // ツリーの無いタブ（Web のページ）へ移って戻っても、同じパスなら読み直さない
      await r.explorer.show({ url:'https://example.com/' }, 'one');
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      t.ok('ツリーの無いタブから同じパスへ戻っても読み直さない', r.calls.length === 3 && r.failed().hidden === false, JSON.stringify(r.calls));
      // 会話が替わったら読み直す
      await r.explorer.show(fileTab('/w/a.md'), 'two');
      t.ok('会話が替わったら読み直す', r.calls.length === 4, JSON.stringify(r.calls));
      t.ok('どの場合も短い知らせは出さない', r.notices.length === 0, JSON.stringify(r.notices));
    }
    {
      // つながらない（fetch が投げる）ときも同じ
      const r = rig();
      r.answer(() => 'throw');
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      t.ok('つながらないときも欄の中に出し、読み直しも知らせもしない', r.calls.length === 1 && r.failed().hidden === false && r.notices.length === 0, `${r.calls.length} ${JSON.stringify(r.notices)}`);
    }
    {
      // 前のパスの失敗が遅れて届いても、今のパスの表示を替えない
      const r = rig();
      let failA;
      r.answer(path => (path === '/w/a.md' ? new Promise(resolve => { failA = () => resolve(false); }) : true));
      const first = r.explorer.show(fileTab('/w/a.md'), 'one');
      await r.explorer.show(fileTab('/w/b.md'), 'one');
      failA(); await first; await flush();
      t.ok('前のパスの遅れた失敗では「読み込めませんでした」を出さない', r.failed().hidden === true && r.list().hidden === false && r.rows().includes('b.md'), JSON.stringify(r.rows()));
      await r.explorer.show(fileTab('/w/b.md'), 'one');
      t.ok('その後の描き直しでも読み直さない', r.calls.length === 2, JSON.stringify(r.calls));
    }
    {
      // ツリーを閉じている間（既定）: 何も知らせない。開いたときに欄の中で分かる
      const r = rig({ open:false });
      store.delete('pleiad.browser-tree.one');
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      await r.explorer.show(fileTab('/w/a.md'), 'one');
      t.ok('閉じている間は、読み直しも知らせもしない', r.root.hidden === true && r.calls.length === 1 && r.notices.length === 0, `${r.root.hidden} ${r.calls.length} ${r.notices.length}`);
      r.explorer.toggle(true);
      t.ok('開くと欄の中に「読み込めませんでした」と「再試行」がある（開いただけでは読み直さない）', r.root.hidden === false && r.failed().hidden === false && Boolean(r.retry()) && r.calls.length === 1, `${r.root.hidden} ${r.calls.length}`);
    }
  } finally {
    globalThis.fetch = old.fetch; globalThis.ResizeObserver = old.observer; globalThis.matchMedia = old.media; globalThis.localStorage = old.storage;
    document.createElement = old.create;
  }
}
