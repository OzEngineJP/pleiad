// 会話の右パネルの一番上の「この場所」の 1 行（ADR 0348）。
//   - 一言は保存したフォルダーの一覧（contextScopes）から決める: 全体の設定どおり／このフォルダーで n 件変更／<親> の設定から n 件変更／<親> の設定どおり
//   - 「この場所の設定を開く」は、会話の作業場所を openSettings に渡す（設定 › プラグインを、範囲をそのフォルダーにして開く）
//   - 「この場所だけ変える」の編集モードと、末尾の「プラグインの設定を開く →」は無い
import { setupSessionContext, placeLine } from '../../web/session-context.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'session-context-place';
export const title = '会話の右パネルの「この場所」の 1 行: 変えた数・上のフォルダーの一言と「この場所の設定を開く」';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const nodes = (root) => [root, ...root.children.flatMap(nodes)];
const has = (n, cls) => String(n.className ?? '').split(/\s+/).includes(cls);

const DEV = 'D:\\dev';
const SITE = 'D:\\dev\\website';
const APP = 'D:\\dev\\website\\app';
const scope = (path, total, parent = null) => ({ id: path.toLowerCase(), path, missing: false, changes: { total }, parent: parent ? { id: parent.toLowerCase(), path: parent } : null });

export default async function (t) {
  const { lang: originalLanguage, setLanguage } = await import('../../web/i18n.mjs');
  const saved = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame };
  globalThis.document = {
    createElement: tag => new N(tag), createElementNS: (_ns, tag) => new N(tag),
    createTextNode: text => { const node = new N('span'); node.textContent = text; return node; }, querySelector: () => null,
  };
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = fn => fn();
  try {
    await setLanguage('ja');

    // ---------------- 一言（contextScopes の places から）
    const none = placeLine(SITE, []);
    t.ok('保存したフォルダーが無ければ「全体の設定どおり」', none.text === '全体の設定どおり' && !none.changed && placeLine(SITE, undefined).text === '全体の設定どおり', none);
    const own = placeLine(SITE, [scope(SITE, 3)]);
    t.ok('この場所を保存して上のフォルダーが無ければ「このフォルダーで n 件変更」（青い字）', own.text === 'このフォルダーで 3 件変更' && own.changed && own.count === 3, own);
    const from = placeLine(APP, [scope(SITE, 1), scope(APP, 2, SITE)]);
    t.ok('上のフォルダーがあれば「<親> の設定から n 件変更」（親はフォルダー名）', from.text === 'website の設定から 2 件変更' && from.changed && from.parent === SITE, from);
    const inherit = placeLine(APP, [scope(DEV, 1), scope(SITE, 4, DEV)]);
    t.ok('この場所を保存していなければ、保存した一番近い上のフォルダーの「<親> の設定どおり」', inherit.text === 'website の設定どおり' && !inherit.changed && inherit.parent === SITE, inherit);
    const zero = placeLine(APP, [scope(SITE, 1), scope(APP, 0, SITE)]);
    t.ok('保存していても変えた数が 0 なら「<親> の設定どおり」', zero.text === 'website の設定どおり' && !zero.changed, zero);
    t.ok('保存していて変えた数が 0、上のフォルダーも無ければ「全体の設定どおり」', placeLine(SITE, [scope(SITE, 0)]).text === '全体の設定どおり');
    t.ok('パスは区切り・大文字小文字・末尾の区切りの違いを同じ場所とみる',
      placeLine('d:/DEV/website/', [scope(SITE, 2)]).text === 'このフォルダーで 2 件変更'
      && placeLine('d:/dev/website/app', [scope(SITE, 2)]).text === 'website の設定どおり');
    t.ok('名前が前方一致するだけの隣のフォルダーは上のフォルダーとみない',
      placeLine('D:\\dev\\website2', [scope(SITE, 2)]).text === '全体の設定どおり');

    // ---------------- 右パネルの 1 行
    const opened = [];
    let body, open = false, scopesCalls = 0, failScopes = false;
    let places = [scope(SITE, 2)];
    const kinds = Object.fromEntries(['instruction', 'skill', 'mcp'].map(kind => [kind, { value: { owner: 'native', user: null, directory: null } }]));
    const view = { defaults: { kinds }, places: [{ current: true, saved: true, overrides: 2, kinds, roots: {} }] };
    const cmd = async (command) => {
      if (command === 'contextSettings') return view;
      if (command === 'contextScopes') { scopesCalls++; if (failScopes) throw new Error('offline'); return { places }; }
      if (command === 'backends') return [{ id: 'claude', capabilities: { plyContext: 'turn' } }];
      if (command === 'nativeInstructions' || command === 'scanContext') return { entries: [] };
      return {};
    };
    const panel = setupSessionContext({ cmd, preview: {
      panelOpen: () => open, openPanel: opts => { open = true; body = opts.body; }, updatePanel: (_key, opts) => { body = opts.body; },
    }, session: () => ({ id: 'session', backend: 'claude', cwd: SITE }), labelOf: () => 'Claude',
    info: () => ({ report: { status: 'native', cwd: SITE, entries: [] }, owners: { instruction: 'native', skill: 'native', mcp: 'native' } }),
    refreshInfo() {}, openSettings: (place) => opened.push(place ?? null) });

    panel.open();
    await settle();
    const row = () => nodes(body).find(n => has(n, 'scx-place'));
    const status = () => nodes(row()).find(n => has(n, 's'));
    const go = () => nodes(row()).find(n => n.tagName === 'BUTTON' && has(n, 'tbtn'));
    t.ok('1 行に作業場所のパス（code）と一言（.s）', nodes(row()).find(n => n.tagName === 'CODE')?.textContent === SITE
      && status()?.textContent === 'このフォルダーで 2 件変更' && has(status(), 'chg'), status()?.textContent);
    t.ok('「この場所の設定を開く」のボタンがある', go()?.textContent === 'この場所の設定を開く');
    go().onclick();
    t.ok('ボタンは作業場所を openSettings に渡す', opened.length === 1 && opened[0] === SITE, opened);
    t.ok('「この場所だけ変える」と末尾の「プラグインの設定を開く →」は無い',
      !nodes(body).some(n => n.dataset?.act === 'placeStart' || has(n, 'scx-foot'))
      && !body.textContent.includes('この場所だけ変える') && !body.textContent.includes('プラグインの設定を開く'));

    // 開き直すと読み直す（設定の画面で変わっていることがある）
    places = [scope(DEV, 1)];
    panel.open();
    await settle();
    t.ok('開き直すと contextScopes を読み直し、上のフォルダーに従う一言になる（青くしない）',
      scopesCalls === 2 && status()?.textContent === 'dev の設定どおり' && !has(status(), 'chg'), status()?.textContent);

    // 読めないときは理由と再試行。ボタンは押せる
    failScopes = true;
    panel.open();
    await settle();
    const retry = nodes(row()).find(n => n.tagName === 'BUTTON' && n.textContent === '再試行');
    t.ok('読めなければ「設定を読み取れませんでした」と再試行を出し、開くボタンは残す',
      row().textContent.includes('設定を読み取れませんでした') && retry && go()?.textContent === 'この場所の設定を開く');
    failScopes = false;
    retry.onclick();
    await settle();
    t.ok('再試行で読み直すと一言に戻る', scopesCalls === 4 && status()?.textContent === 'dev の設定どおり' && !row().textContent.includes('再試行'));

    await setLanguage('en');
    t.ok('英語は数で単数・複数を分ける',
      placeLine(SITE, [scope(SITE, 1)]).text === '1 change in this folder'
      && placeLine(APP, [scope(SITE, 1), scope(APP, 3, SITE)]).text === '3 changes from website settings'
      && placeLine(APP, [scope(SITE, 1)]).text === 'Same as website settings'
      && placeLine(SITE, []).text === 'Same as the global settings');
  } finally {
    await setLanguage(originalLanguage);
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.requestAnimationFrame = saved.raf;
  }
}
