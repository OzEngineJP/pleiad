// mark 型ロゴの文書内シンボル化（web/brand-marks.mjs・web/side.mjs の backendLogo）。
// 一覧の行を作り直すたびに ./brand/x.svg を取り直してロゴがちかちかするのを防ぐ仕組みで、
// ここでは「<use> が文書内参照になる」「ロゴのファイルは 1 度だけ読む」「シンボルが文書へ登録される」を見る。
import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { setAgentBrands } from '../../web/agent-brands.mjs';
import { ensureBrandMark, preloadBrandMarks } from '../../web/brand-marks.mjs';
import { backendLogo } from '../../web/side.mjs';

export const name = 'brand-marks';
export const title = 'mark 型ロゴ: 文書内シンボルへの参照・1 回だけの取得・シンボルの登録';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path id="mark" d="M0 0h1v1H0z"/></svg>';

// brand-marks.mjs が使うブラウザの口（fetch・DOMParser・document.body）を埋める。
// DOMParser の身代わりは「viewBox と #mark の要素を返せる形」だけを持つ
function installBrowserBits(fetches) {
  const markNode = () => { const n = new N('path'); n.setAttribute('d', 'M0 0h1v1H0z'); return n; };
  globalThis.DOMParser = class {
    parseFromString(text) {
      assert.match(text, /id="mark"/);
      return { documentElement: { getAttribute: (k) => (k === 'viewBox' ? '0 0 24 24' : null) }, getElementById: () => markNode() };
    }
  };
  globalThis.fetch = async (url) => { fetches.push(url); return { ok: true, text: async () => SVG }; };
  document.body = new N('body');
}

export default async function (t) {
  const fetches = [];
  const orig = { fetch: globalThis.fetch, parser: globalThis.DOMParser, body: globalThis.document.body };
  installBrowserBits(fetches);
  try {
    setAgentBrands([
      { id: 'antigravity', label: 'Antigravity', brand: { logo: 'antigravity.svg', mark: true } },
      { id: 'claude', label: 'Claude', brand: { logo: 'claude.svg', mark: false } },
      { id: 'fake', label: 'Fake', brand: null },
    ]);
    preloadBrandMarks([{ id: 'antigravity', brand: { logo: 'antigravity.svg', mark: true } }, { id: 'claude', brand: { logo: 'claude.svg', mark: false } }]);

    // mark 型は文書内参照。外部参照（ファイル名つき）は出さない
    const logo = backendLogo('antigravity', 'Antigravity');
    const use = logo.querySelector('use');
    assert.ok(use, 'mark 型は <use> を持つ');
    assert.equal(use.getAttribute('href'), '#brand-mark-antigravity');
    t.ok('mark 型の <use> は文書内シンボルを指す', true);

    // 作り直しても同じ取得を使い回す（取り直さない）
    backendLogo('antigravity', 'Antigravity');
    backendLogo('antigravity', 'Antigravity');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetches.filter((u) => u.endsWith('antigravity.svg')).length, 1);
    t.ok('同じロゴは 1 度だけ読む（preload 分を含めて）', true);

    // 読み終わると文書に <symbol> として登録される（id は <use> の参照先と一致）
    await new Promise((r) => setTimeout(r, 0));
    const symbol = document.body.querySelector('#brand-mark-antigravity');
    assert.ok(symbol, 'シンボルが文書に登録される');
    assert.equal(symbol.tagName, 'SYMBOL');
    assert.equal(symbol.getAttribute('viewBox'), '0 0 24 24');
    t.ok('シンボルは文書へ live に足される（<use> が後から解決する）', true);

    // mark:false（画像）は今までどおり <img>。ロゴ無しは ◇
    const img = backendLogo('claude', 'Claude').querySelector('img');
    assert.ok(img, '画像のロゴは <img> のまま');
    assert.equal(backendLogo('fake', 'Fake').textContent, '◇');
    assert.equal(fetches.length, 1, '画像・無しはロゴの取得を増やさない');
    t.ok('画像型とロゴ無しは変わらない', true);

    // 読み込みに失敗したロゴは、次の呼び出しで取り直せる（1 回の失敗で空白のままにしない）
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(ensureBrandMark('devin.svg'), 'brand-mark-devin');
    await new Promise((r) => setTimeout(r, 0));
    let retried = 0;
    globalThis.fetch = async () => { retried++; return { ok: true, text: async () => SVG }; };
    ensureBrandMark('devin.svg');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(retried, 1);
    t.ok('失敗したロゴは次に取り直す', true);
  } finally {
    globalThis.fetch = orig.fetch;
    globalThis.DOMParser = orig.parser;
    if (orig.body === undefined) delete document.body; else document.body = orig.body;
  }
}
