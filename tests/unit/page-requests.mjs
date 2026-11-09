// Pleiad のページから Pleiad への頼み（ADR 0295 の 2 の 5・6）: 中継の口（core/chrome/page-bridge.mjs）と検査（core/page-requests.mjs）。
//   - 形の検査: 知っている種類と欄だけを写す・会話の違う頼み・形の外を捨てる
//   - パスの検査し直し（ADR 0050）: 検査した実体のパスに置き換える・検査で断られたら捨てる・use-file はファイルだけ
//   - 中継の口: ファイルのページのタブにだけ binding を足す・主フレームの既定の world のファイルのページからの呼び出しだけ・
//     人の操作のタブだけ（AI の操作のタブの頼みは捨てる）・最後に触った画面（by）を載せる・数と大きさの上限・検査が無ければ捨てる
//   - 本物の中継と偽の Chrome: 人の操作のタブでは AI の Runtime.evaluate が断られ、AI の操作のタブでは頼みが捨てられる
//   - 結果（pleiad:page-result）とテーマ・言語（pleiad:env）は隔離した world から知らせる。頼んでいない requestId には返さない
import { agent, rig } from '../lib/chrome-relay-rig.mjs';
import { HUMAN_MESSAGE } from '../../core/chrome/tab-holder.mjs';
import { createPageBridge, BINDING, WORLD, RATE_LIMIT, PAYLOAD_LIMIT } from '../../core/chrome/page-bridge.mjs';
import { checkShape, createPageRequests, TEXT_LIMIT } from '../../core/page-requests.mjs';

export const name = 'page-requests';
export const title = 'ページから Pleiad への頼み（ADR 0295 の 2 の 6）: 形とパスの検査・人の操作のタブだけ・主フレームのページだけ・結果と env の知らせ（偽の Chrome）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

const PAGES = 7421;
const pageUrl = (session = 'one', rest = 'file?path=a.txt') => `http://localhost:${PAGES}/_pleiad/s/${encodeURIComponent(session)}/${rest}`;
const fail = code => Object.assign(new Error(code), { code });
/** ファイルのページの API と同じ道具の偽物。'secret' を含むパスは ADR 0050 の検査で断る。'/dir' で終わればフォルダー */
function fileDeps(extra = {}) {
  const inspected = [];
  return {
    inspected,
    store: { getAll: async () => ({ one: { cwd: '/work' }, two: { cwd: '/other' } }) },
    fileAccessFor: sessionId => ({ sessionId }),
    fileRoots: () => ['/work'],
    resolveSessionFile: async ({ path, base }) => ({ path: path.startsWith('/') ? path : `${base ? '/base' : '/work'}/${path}` }),
    inspect: async (file, access) => {
      inspected.push([file, access.sessionId]);
      if (file.includes('secret')) throw fail('protected-data');
      return { file: `/real${file}`, stat: { isDirectory: () => file.endsWith('/dir') } };
    },
    ...extra,
  };
}

/** 中継の口に渡すタブの偽物（attach は送ったコマンドを残し、onEvent を外から呼べる） */
function stubTab({ sessionId = 'one', targetId = 'T1', url = pageUrl(sessionId) } = {}) {
  const sent = [];
  let onEvent = null, detached = 0;
  const tab = {
    sessionId, targetId, windowId: 1, info: { targetId, url, type: 'page' },
    attach: async handler => {
      onEvent = handler;
      return {
        sessionId: `own-${targetId}`,
        send: async (method, params = {}) => {
          sent.push({ method, params });
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `F-${targetId}` } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 900 };
          return {};
        },
        detach: async () => { detached += 1; },
      };
    },
  };
  return {
    tab, sent,
    fire: (method, params) => onEvent?.(method, params),
    context: (id, { frameId = `F-${targetId}`, isDefault = true, origin = `http://localhost:${PAGES}`, name = '' } = {}) =>
      onEvent?.('Runtime.executionContextCreated', { context: { id, origin, name, auxData: { frameId, isDefault } } }),
    call: (payload, executionContextId = 1) => onEvent?.('Runtime.bindingCalled', { name: BINDING, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), executionContextId }),
    get detached() { return detached; },
  };
}

export default async function (t) {
  // ===== 1. 形の検査 =====
  {
    const ok = raw => checkShape(raw, { sessionId: 'one' });
    t.ok('知っている種類だけ（commit・open などは捨てる）', !ok({ type: 'commit', sessionId: 'one' }).ok && !ok({ type: 'open-external', sessionId: 'one', path: '/a' }).ok && ok({ type: 'use-text', sessionId: 'one', text: 'x' }).ok);
    t.ok('会話の違う頼み・会話の無い頼みは捨てる', !ok({ type: 'use-text', sessionId: 'two', text: 'x' }).ok && !ok({ type: 'use-text', text: 'x' }).ok);
    t.ok('オブジェクトでないものは捨てる', !ok(null).ok && !ok([]).ok && !ok('use-text').ok);
    const menu = ok({ type: 'file-menu', sessionId: 'one', path: 'a.txt', kind: 'directory', x: 10.4, y: -3, action: 'open-external', url: 'https://evil.example/' });
    t.ok('file-menu は path・base・座標だけを写す（ページの言う kind・知らない欄は落とす。座標は丸めて 0 以上）', menu.ok && JSON.stringify(menu.request) === JSON.stringify({ type: 'file-menu', sessionId: 'one', path: 'a.txt', x: 10, y: 0 }), JSON.stringify(menu));
    t.ok('file-menu の座標が片方だけなら座標を持たない', ok({ type: 'file-menu', sessionId: 'one', path: 'a', x: 1 }).request.x === undefined);
    t.ok('パスが空・長すぎ・NUL を含むなら捨てる', !ok({ type: 'use-file', sessionId: 'one', path: '' }).ok && !ok({ type: 'use-file', sessionId: 'one', path: 'a'.repeat(40000) }).ok && !ok({ type: 'use-file', sessionId: 'one', path: 'a\0b' }).ok);
    t.ok('use-text は上限まで', ok({ type: 'use-text', sessionId: 'one', text: 'a'.repeat(TEXT_LIMIT) }).ok && !ok({ type: 'use-text', sessionId: 'one', text: 'a'.repeat(TEXT_LIMIT + 1) }).ok && !ok({ type: 'use-text', sessionId: 'one', text: 5 }).ok);
    const jump = ok({ type: 'jump', sessionId: 'one', event: { kind: 'commit', hash: 'abc1234', uuid: 'u-1', toolId: 'tool-1', at: '2026-11-06T00:00:00Z', url: 'https://x.example/', command: 'rm -rf /' } });
    t.ok('jump は発言を指す欄だけを写す', jump.ok && JSON.stringify(jump.request.event) === JSON.stringify({ kind: 'commit', uuid: 'u-1', toolId: 'tool-1', at: '2026-11-06T00:00:00Z', hash: 'abc1234' }), JSON.stringify(jump));
    t.ok('jump は uuid か toolId が要る・hash は 16 進だけ', !ok({ type: 'jump', sessionId: 'one', event: { kind: 'commit' } }).ok && !ok({ type: 'jump', sessionId: 'one', event: { uuid: 'u', hash: 'zz' } }).ok);
    const rid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    t.ok('worktree の keep は id と真偽だけ', JSON.stringify(ok({ type: 'worktree', sessionId: 'one', action: 'keep', requestId: rid, id: 'w1', kept: true, row: { a: 1 } }).request) === JSON.stringify({ type: 'worktree', sessionId: 'one', action: 'keep', requestId: rid, id: 'w1', kept: true }));
    t.ok('worktree は知らない action・requestId の無いものを捨てる', !ok({ type: 'worktree', sessionId: 'one', action: 'delete', requestId: rid, row: {} }).ok && !ok({ type: 'worktree', sessionId: 'one', action: 'ask', row: {} }).ok && !ok({ type: 'worktree', sessionId: 'one', action: 'ask', requestId: 'x y', row: {} }).ok);
    const hash64 = 'a'.repeat(64);
    const openViz = ok({ type: 'open-viz', sessionId: 'one', viz: { hash: hash64, entry: 'index.html', title: '図' }, path: '/w/chart.html', missing: true, junk: 1 });
    t.ok('open-viz は viz・path・missing だけを写す（知らない欄は落とす）',
      openViz.ok && JSON.stringify(openViz.request) === JSON.stringify({ type: 'open-viz', sessionId: 'one', viz: { hash: hash64, entry: 'index.html', title: '図' }, path: '/w/chart.html', missing: true }), JSON.stringify(openViz));
    t.ok('open-viz は形の合う束の印（64 hex）だけを受ける',
      !ok({ type: 'open-viz', sessionId: 'one' }).ok && !ok({ type: 'open-viz', sessionId: 'one', viz: { hash: 'zz' } }).ok
      && !ok({ type: 'open-viz', sessionId: 'one', viz: { hash: hash64.toUpperCase() } }).ok && !ok({ type: 'open-viz', sessionId: 'one', viz: 'x' }).ok);
    t.ok('viz の入口・題は上限まで・NUL は捨てる',
      !ok({ type: 'open-viz', sessionId: 'one', viz: { hash: hash64, entry: 'a'.repeat(2001) } }).ok
      && ok({ type: 'open-viz', sessionId: 'one', viz: { hash: hash64, entry: 'a'.repeat(2000), title: 'a'.repeat(2000) } }).ok
      && !ok({ type: 'open-viz', sessionId: 'one', viz: { hash: hash64, title: 'a'.repeat(2001) } }).ok
      && !ok({ type: 'open-viz', sessionId: 'one', viz: { hash: hash64, entry: 'a\0b' } }).ok);
    const vizMenu = ok({ type: 'file-menu', sessionId: 'one', viz: { hash: hash64 }, x: 1, y: 2, missing: true });
    t.ok('file-menu は元パスの記録の無い可視化の行も viz だけで開ける',
      vizMenu.ok && vizMenu.request.viz.hash === hash64 && !('path' in vizMenu.request) && vizMenu.request.missing === true && vizMenu.request.x === 1, JSON.stringify(vizMenu));
    t.ok('file-menu はパスと viz の両方を写す・形の違う viz は落としてパスがあれば通す',
      ok({ type: 'file-menu', sessionId: 'one', path: 'a.txt', viz: { hash: hash64 }, x: 1, y: 2 }).request.viz.hash === hash64
      && !ok({ type: 'file-menu', sessionId: 'one', viz: { hash: 'bad' }, x: 1, y: 2 }).ok
      && ok({ type: 'file-menu', sessionId: 'one', path: 'a.txt', viz: { hash: 'bad' }, x: 1, y: 2 }).request.viz === undefined);
    t.ok('worktree の行は JSON の写し（上限と深さの外は捨てる）', ok({ type: 'worktree', sessionId: 'one', action: 'archive', requestId: rid, row: { path: '/w', leftover: { id: 'l' } } }).ok
      && !ok({ type: 'worktree', sessionId: 'one', action: 'archive', requestId: rid, row: { big: 'a'.repeat(20000) } }).ok
      && !ok({ type: 'worktree', sessionId: 'one', action: 'archive', requestId: rid, row: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }).ok
      && !ok({ type: 'worktree', sessionId: 'one', action: 'restore', requestId: rid, row: {}, ref: 5 }).ok
      && ok({ type: 'worktree', sessionId: 'one', action: 'restore', requestId: rid, row: {}, ref: 'main' }).request.ref === 'main');
  }

  // ===== 2. パスの検査し直し（ADR 0050） =====
  {
    const deps = fileDeps();
    const requests = createPageRequests(deps);
    const ctx = { sessionId: 'one', targetId: 'T1', by: 'device' };
    const menu = await requests.accept({ type: 'file-menu', sessionId: 'one', path: 'a.txt', kind: 'directory', x: 1, y: 2 }, ctx);
    t.ok('file-menu のパスは会話の作業フォルダーで解き、検査した実体のパスと種類に置き換える', menu?.path === '/real/work/a.txt' && menu.kind === 'file' && menu.x === 1, JSON.stringify(menu));
    t.ok('検査はその会話の access で 2 回目の解決の後にもかかる', deps.inspected.some(([file, sid]) => file === '/work/a.txt' && sid === 'one'));
    const linked = await requests.accept({ type: 'file-menu', sessionId: 'one', path: 'b.md', base: '/work/doc.md' }, ctx);
    t.ok('base（Markdown のリンク）も検査してから解き、頼みには base を残さない', linked?.path === '/real/base/b.md' && !('base' in linked) && deps.inspected.some(([file]) => file === '/work/doc.md'), JSON.stringify(linked));
    t.ok('base が検査で断られたら捨てる', await requests.accept({ type: 'file-menu', sessionId: 'one', path: 'b.md', base: '/secret/doc.md' }, ctx) === null);
    t.ok('検査で断られたパス（データの置き場など）は捨てる', await requests.accept({ type: 'file-menu', sessionId: 'one', path: '/secret/key' }, ctx) === null);
    t.ok('use-file はファイルだけ（フォルダーは捨てる）', await requests.accept({ type: 'use-file', sessionId: 'one', path: '/work/dir' }, ctx) === null
      && (await requests.accept({ type: 'use-file', sessionId: 'one', path: '/work/x.png' }, ctx))?.path === '/real/work/x.png');
    t.ok('置き場に無い会話の頼みは捨てる', await requests.accept({ type: 'use-file', sessionId: 'gone', path: '/work/x' }, { ...ctx, sessionId: 'gone' }) === null);
    t.ok('届ける画面（by）が無ければ捨てる', await requests.accept({ type: 'use-text', sessionId: 'one', text: 'x' }, { sessionId: 'one', by: null }) === null);
    t.ok('パスを持たない頼みは形の検査だけ', (await requests.accept({ type: 'use-text', sessionId: 'one', text: 'hello' }, ctx))?.text === 'hello');
    const hash64 = 'a'.repeat(64);
    const openViz = await requests.accept({ type: 'open-viz', sessionId: 'one', viz: { hash: hash64 }, path: 'chart.html' }, ctx);
    t.ok('open-viz のパスも作業フォルダーで解き、検査した実体のパスに置き換える', openViz?.path === '/real/work/chart.html' && openViz.viz.hash === hash64, JSON.stringify(openViz));
    const vizOnly = await requests.accept({ type: 'file-menu', sessionId: 'one', viz: { hash: hash64 }, x: 1, y: 2 }, ctx);
    t.ok('元パスの記録の無い可視化のメニューはパスの検査なしで通す', vizOnly?.viz?.hash === hash64 && !('path' in vizOnly));
    const gone = createPageRequests({ ...deps, inspect: async () => { throw fail('ENOENT'); } });
    const goneMenu = await gone.accept({ type: 'file-menu', sessionId: 'one', path: '/work/gone.html', viz: { hash: hash64 }, x: 1, y: 2 }, ctx);
    t.ok('可視化の元のファイルが消えていても missing を付けてパスを残す（画面が保存版へ切り替えて知らせる）',
      goneMenu?.missing === true && goneMenu.path === '/work/gone.html' && goneMenu.viz.hash === hash64, JSON.stringify(goneMenu));
    const denied = await requests.accept({ type: 'file-menu', sessionId: 'one', path: '/secret/x', viz: { hash: hash64 }, x: 1, y: 2 }, ctx);
    t.ok('権限など消失以外の断られはパスだけ落とす（元パス不明と同じ正常系・可視化は通す）', denied?.viz?.hash === hash64 && !('path' in denied) && denied.missing !== true, JSON.stringify(denied));
    const deniedOpen = await requests.accept({ type: 'open-viz', sessionId: 'one', path: '/secret/x', viz: { hash: hash64 } }, ctx);
    t.ok('open-viz も同じ扱い（消失なら missing・権限ならパスを落とす）',
      deniedOpen?.viz?.hash === hash64 && !('path' in deniedOpen)
      && (await gone.accept({ type: 'open-viz', sessionId: 'one', path: '/work/gone.html', viz: { hash: hash64 } }, ctx))?.missing === true);
    t.ok('viz の無い file-menu は従来どおりパスの検査で捨てる', await requests.accept({ type: 'file-menu', sessionId: 'one', path: '/secret/x' }, ctx) === null);
  }

  // ===== 3. 中継の口（偽のタブ）: 付ける先・呼び元の world・人の操作・上限 =====
  {
    const events = [], logs = [];
    let held = { holder: 'human', by: 'pc', since: 1, last: 1, pinned: false };
    let pages = PAGES;
    const bridge = createPageBridge({ emit: (type, payload) => events.push([type, payload]), ports: () => ({ main: 7420, pages, isolated: 7422 }), log: line => logs.push(line) });
    // 検査がつながる前は全部捨てる（持ち手だけつながっていても）
    bridge.attach({ holder: () => held });
    const early = stubTab({ targetId: 'T0' });
    bridge.added(early.tab);
    await until(() => early.sent.some(c => c.method === 'Runtime.enable'));
    early.context(1);
    await early.call({ type: 'use-text', sessionId: 'one', text: 'x' });
    await sleep(5);
    t.ok('検査（accept）がつながる前の頼みは捨てる（つなぎ忘れは断る側）', events.length === 0 && logs.some(l => /no checker/.test(l)), JSON.stringify(logs));
    bridge.removed({ sessionId: 'one', targetId: 'T0' });

    const deps = fileDeps();
    const requests = createPageRequests({ ...deps, relay: { unify: { pageBridge: bridge, tabHolder: { holder: () => held } } } });

    const other = stubTab({ targetId: 'T9', url: 'https://example.com/' });
    bridge.added(other.tab);
    const otherSession = stubTab({ targetId: 'T8', url: pageUrl('two') });
    bridge.added({ ...otherSession.tab, sessionId: 'one' });
    await sleep(5);
    t.ok('ファイルのページでないタブ・ほかの会話のファイルのページのタブには binding を足さない', other.sent.length === 0 && otherSession.sent.length === 0);

    const s = stubTab();
    bridge.added(s.tab);
    t.ok('ファイルのページのタブには中継のセッションで binding（plyPage）を足し、Runtime を有効にする', await until(() => s.sent.some(c => c.method === 'Runtime.addBinding' && c.params.name === 'plyPage') && s.sent.some(c => c.method === 'Runtime.enable')), JSON.stringify(s.sent));
    t.ok('binding は executionContextName・executionContextId を付けずに足す（ページの読み直し後も残る）', s.sent.find(c => c.method === 'Runtime.addBinding').params.executionContextId === undefined);
    t.ok('tabs() に載る', bridge.tabs().some(x => x.targetId === 'T1' && x.sessionId === 'one'));

    s.context(1);                                          // 主フレームの既定の world（ページ自身）
    s.context(2, { frameId: 'F-child' });                  // iframe（隔離の origin の HTML の枠が同じプロセスに入ったとき）
    s.context(3, { isDefault: false, name: 'ext' });       // 隔離した world
    s.context(4, { origin: 'http://localhost:5173' });     // 同じ site の別の port（利用者の dev サーバー）
    const request = { type: 'use-text', sessionId: 'one', text: 'from-page-secret-text' };
    const count = () => events.filter(([type]) => type === 'tab:page-request').length;
    for (const id of [2, 3, 4, 77]) await s.call(request, id);
    await sleep(5);
    t.ok('iframe・隔離した world・ほかの origin・知らない world からの呼び出しは捨てる', count() === 0 && logs.filter(l => /not the page/.test(l)).length === 4, JSON.stringify(logs));

    await s.call(request, 1);
    t.ok('人の操作のタブのページ自身からの頼みは tab:page-request で出し、最後に触った画面（by）を載せる', await until(() => count() === 1)
      && (() => { const [, p] = events.at(-1); return p.sessionId === 'one' && p.targetId === 'T1' && p.by === 'pc' && p.request.text === 'from-page-secret-text'; })(), JSON.stringify(events));

    held = { holder: 'ai' };
    await s.call(request, 1);
    await sleep(5);
    t.ok('AI の操作のタブから届いた頼みは捨てる（AI の evaluate の頼みかもしれない）', count() === 1 && logs.some(l => /not held by a person/.test(l)));
    held = { holder: 'human', by: null };
    await s.call(request, 1);
    await sleep(5);
    t.ok('人の操作でも、触った画面が分からなければ捨てる', count() === 1);
    held = { holder: 'human', by: 'device' };

    await s.call('{not json', 1);
    await s.call(JSON.stringify({ type: 'use-text', sessionId: 'one', text: 'a'.repeat(PAYLOAD_LIMIT) }), 1);
    await s.call({ type: 'file-menu', sessionId: 'one', path: '/secret/x' }, 1);
    await sleep(5);
    t.ok('JSON でない・大きすぎる・パスの検査で断られた頼みは捨てる', count() === 1);
    t.ok('ログにパス・文・URL を書かない', !logs.some(l => /secret|from-page|localhost/.test(l)), JSON.stringify(logs));

    // 検査の間に人の操作が終わったら出さない
    let release;
    const slow = createPageBridge({ emit: (type, payload) => events.push([type, payload]), ports: () => ({ pages: PAGES }) });
    slow.attach({ holder: () => held, accept: request => new Promise(resolve => { release = () => resolve(request); }) });
    const s2 = stubTab({ targetId: 'T2' });
    slow.added(s2.tab);
    await until(() => s2.sent.some(c => c.method === 'Runtime.enable'));
    s2.context(1);
    const pending = s2.call(request, 1);
    await until(() => typeof release === 'function');
    held = { holder: 'ai' };
    release();
    await pending; await sleep(5);
    t.ok('検査の間に AI の操作へ戻ったら出さない', count() === 1);
    held = { holder: 'human', by: 'device' };

    // 数の上限
    const burst = createPageBridge({ emit: (type, payload) => events.push([type, payload]), ports: () => ({ pages: PAGES }), now: () => 5_000 });
    burst.attach({ holder: () => held, accept: r => r });
    const s3 = stubTab({ targetId: 'T3' });
    burst.added(s3.tab);
    await until(() => s3.sent.some(c => c.method === 'Runtime.enable'));
    s3.context(1);
    const before = count();
    for (let i = 0; i < RATE_LIMIT + 5; i += 1) await s3.call(request, 1);
    await sleep(5);
    t.ok(`1 つのタブの頼みは 10 秒に ${RATE_LIMIT} 件まで`, count() - before === RATE_LIMIT, String(count() - before));

    // 結果と env（隔離した world）
    const rid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    await s.call({ type: 'worktree', sessionId: 'one', action: 'keep', requestId: rid, id: 'w1', kept: true }, 1);
    await until(() => events.at(-1)?.[1]?.request?.requestId === rid);
    t.ok('頼んでいない requestId・ほかの会話には結果を返さない', await requests.result({ sessionId: 'one', targetId: 'T1', requestId: 'aaaaaaaa-0000', ok: true }) === false
      && await requests.result({ sessionId: 'two', targetId: 'T1', requestId: rid, ok: true }) === false);
    t.ok('結果の形の外（ok が真偽でない・大きすぎる）は返さない', await requests.result({ sessionId: 'one', requestId: rid, ok: 'yes' }) === false
      && await requests.result({ sessionId: 'one', requestId: rid, ok: true, result: { big: 'a'.repeat(20000) } }) === false);
    const sentBefore = s.sent.length;
    t.ok('頼んだタブへ結果を返す（targetId を省いても requestId で見つける）', await requests.result({ sessionId: 'one', requestId: rid, ok: true, result: { action: 'keep' } }) === true);
    const world = s.sent.slice(sentBefore).find(c => c.method === 'Page.createIsolatedWorld');
    const evaluated = s.sent.slice(sentBefore).find(c => c.method === 'Runtime.evaluate');
    t.ok('結果は主フレームに作った隔離した world から pleiad:page-result の CustomEvent で出す', world?.params.frameId === 'F-T1' && world.params.worldName === WORLD && evaluated?.params.contextId === 900
      && evaluated.params.expression.includes('"pleiad:page-result"') && evaluated.params.expression.includes(rid), JSON.stringify(s.sent.slice(sentBefore)));
    t.ok('同じ requestId には 2 度返さない', await requests.result({ sessionId: 'one', requestId: rid, ok: true }) === false);

    const envBefore = s.sent.length;
    t.ok('env は変わった分だけ知らせる（知らない値は無視）', await requests.env({ theme: 'dark', lang: 'xx' }) === 1
      && s.sent.slice(envBefore).some(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('"pleiad:env"') && c.params.expression.includes('dark') && !c.params.expression.includes('xx')));
    t.ok('同じ値なら知らせない・envOf はページが開くときの値', await requests.env({ theme: 'dark' }) === 0 && JSON.stringify(requests.envOf('one')) === '{"theme":"dark"}');
    t.ok('知らせた world は作り直さずに使い回す', s.sent.filter(c => c.method === 'Page.createIsolatedWorld').length === 1);
    s.fire('Runtime.executionContextsCleared', {});
    s.context(11);
    await requests.env({ lang: 'en' });
    t.ok('読み直し（world が消えた）の後は隔離した world を作り直す', s.sent.filter(c => c.method === 'Page.createIsolatedWorld').length === 2);

    // 別のサイトへ移ったら外す
    bridge.changed({ ...s.tab, info: { ...s.tab.info, url: 'https://example.com/' } });
    t.ok('ファイルのページから外へ移ったら binding を外してセッションを外す', await until(() => s.sent.some(c => c.method === 'Runtime.removeBinding' && c.params.name === 'plyPage') && s.detached === 1) && !bridge.tabs().some(x => x.targetId === 'T1'));
    const afterMove = count();
    await s.call(request, 11);
    await sleep(5);
    t.ok('外した後の呼び出しは捨てる', count() === afterMove);
    t.ok('ファイルのページの port が無いなら何も付けない', (() => { pages = null; const s4 = stubTab({ targetId: 'T4' }); bridge.added(s4.tab); return s4.sent.length === 0 && !bridge.tabs().some(x => x.targetId === 'T4'); })());
    pages = PAGES;
  }

  // ===== 4. 本物の中継と偽の Chrome =====
  {
    const r = await rig();
    let a;
    try {
      const events = [];
      r.relay.onTabEvent((type, payload) => { if (type === 'tab:page-request') events.push(payload); });
      r.relay.setPagePorts({ main: 7420, pages: PAGES, isolated: 7422 });
      createPageRequests({ ...fileDeps(), relay: r.relay });
      a = await agent(await r.relay.endpoint('one'));
      const created = await a.cmd('Target.createTarget', { url: pageUrl() });
      const tabId = created.result?.targetId;
      t.ok('AI が開いたファイルのページのタブにも、中継自身のセッションで binding を足す', Boolean(tabId) && await until(() => r.chrome.calls.some(c => c.method === 'Runtime.addBinding' && c.params.name === 'plyPage')), JSON.stringify(created));
      const own = r.chrome.calls.find(c => c.method === 'Runtime.addBinding')?.sessionId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result?.sessionId;
      t.ok('binding はエージェントのセッションではなく中継のセッションに付く', own && own !== sid);
      r.fake.emitToTab(tabId, 'Runtime.executionContextCreated', { context: { id: 4242, origin: `http://localhost:${PAGES}`, name: '', auxData: { frameId: tabId, isDefault: true } } });
      const call = text => r.fake.emitToTab(tabId, 'Runtime.bindingCalled', { name: 'plyPage', payload: JSON.stringify({ type: 'use-text', sessionId: 'one', text }), executionContextId: 4242 });

      // AI の操作のタブ: エージェントの evaluate は通るが、そこから呼んだ頼みは捨てる
      const evaluated = await a.cmd('Runtime.evaluate', { expression: `plyPage(JSON.stringify({type:'use-text',sessionId:'one',text:'forged'}))` }, sid);
      t.ok('AI の操作のタブでは、エージェントの evaluate は通る', !evaluated.error, JSON.stringify(evaluated));
      call('forged');
      await sleep(30);
      t.ok('AI の操作のタブで呼ばれた plyPage の頼みは捨てる', events.length === 0 && r.logs.some(l => /not held by a person/.test(l)), JSON.stringify(r.logs.slice(-5)));

      // 人の操作のタブ: エージェントの evaluate は門が断り、ページ自身の頼みは届く
      r.relay.unify.tabHolder.touch({ sessionId: 'one', targetId: tabId, by: 'device' });
      const refused = await a.cmd('Runtime.evaluate', { expression: `plyPage('{}')` }, sid);
      const fn = await a.cmd('Runtime.callFunctionOn', { functionDeclaration: 'function(){ plyPage("{}") }', objectId: 'x' }, sid);
      t.ok('人の操作のタブでは、エージェントの Runtime.evaluate・callFunctionOn を門が断る（plyPage を呼べない）', refused.error?.message === HUMAN_MESSAGE && fn.error?.message === HUMAN_MESSAGE);
      call('genuine');
      t.ok('人の操作のタブのページ自身の頼みは tab:page-request で出る（by は触った画面）', await until(() => events.length === 1) && events[0].by === 'device' && events[0].request.text === 'genuine' && events[0].targetId === tabId, JSON.stringify(events));
      t.ok('出来事の頼みは検査した形だけ（外で開くなどの欄は無い）', Object.keys(events[0].request).sort().join() === 'sessionId,text,type');
    } finally { a?.close(); await r.stop(); }
  }
}
