// 脇の置き場所の木（docs/design-system.md「脇」）。一時チャットは状態へドラッグ、チャンネルは行のメニュー。
// web/side.mjs を dom-stub で実際に描き、行の dragstart → 節の dragover → drop で onSetStatus が呼ばれるまで確かめる。
// onSetStatus からサーバーへの振り分け（スレッドの行 id → channels.setThreadStatus。会話は今までどおり setStatus）は、
// web/client.mjs の該当部分を vm で走らせて確かめる（tests/unit/sidebar-client-moves.mjs と同じやり方）。
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { N } from '../lib/dom-stub.mjs';
import { createSide } from '../../web/side.mjs';

export const name = 'side-thread-status';
export const title = '脇の木: 会話のドラッグ・スレッドのメニュー・畳み・待ち・フィルター';

// createSide が触る要素の id（web/index.html の脇）。無いと getElementById が null を返して落ちるので全部置く
const IDS = ['groups', 'q', 'fchips', 'filterBtn', 'filterOutside', 'keyHint', 'clearFilterOutside', 'newSession',
  'settings', 'sidebar', 'qClear', 'recentPop', 'filterPop', 'resHead', 'resArc', 'resCount', 'resLive', 'resSort',
  'searchHint', 'sideUndo'];

/** dom-stub（document.createElement だけ）に、createSide が要る面を足す。終わったら元に戻す（同じ worker の後の suite へ残さない） */
function installDom(prefs = {}) {
  const els = new Map(IDS.map((id) => [id, new N(id === 'q' ? 'input' : 'div')]));
  els.get('q').value = '';
  const saved = {
    getElementById: document.getElementById,
    documentElement: document.documentElement,
    activeElement: document.activeElement,
    createTextNode: document.createTextNode,
    addEventListener: document.addEventListener,
    localStorage: globalThis.localStorage,
  };
  const html = new N('html');
  html.lang = 'ja';
  document.getElementById = (id) => els.get(id) ?? null;
  document.documentElement = html;
  document.activeElement = null;
  document.createTextNode = (text) => { const node = new N('span'); node.textContent = text; return node; };
  document.addEventListener = () => {};
  const storage = new Map([['agent-host-side', JSON.stringify(prefs)]]);
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  return {
    els,
    restore() {
      for (const key of ['getElementById', 'documentElement', 'activeElement', 'createTextNode', 'addEventListener']) {
        if (saved[key] === undefined) delete document[key]; else document[key] = saved[key];
      }
      globalThis.localStorage = saved.localStorage;
    },
  };
}

const walk = (node, fn) => { fn(node); for (const c of node.children ?? []) if (c instanceof N) walk(c, fn); };
const find = (root, pred) => { let out = null; walk(root, (n) => { if (!out && pred(n)) out = n; }); return out; };
const sectionOf = (root, status) => find(root, (n) => n.dataset.sideKey === `group:${status}`);
const rowOf = (root, id) => find(root, (n) => n.dataset.session === id);

/** 最小のドラッグの出来事。preventDefault・stopPropagation・dataTransfer だけ持つ */
const dragEvent = (type, store = {}) => ({
  type, clientX: 0, clientY: 0,
  dataTransfer: { store, setData(k, v) { this.store[k] = v; }, getData(k) { return this.store[k]; }, effectAllowed: '', dropEffect: '' },
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() { this.stopped = true; },
});

export default async function (t) {
  // ---- 描画とドラッグ（web/side.mjs を実際に走らせる）
  const dom = installDom();
  try {
    const calls = [];
    const side = createSide({
      onOpen: () => {},
      onContext: (s) => calls.push(['context', s.id]),
      onSetStatus: (id, status) => calls.push(['setStatus', id, status]),
      onSetGrouped: (s, ungrouped) => calls.push(['setGrouped', s.id, ungrouped]),
    });
    side.setDirectory({ channels: [{ id: 'c1', kind: 'channel', name: 'dev' }] });
    const threadRow = {
      id: 'thread:c1:t1',
      thread: { channelId: 'c1', threadId: 't1' },
      bot: { botId: 'b1', channelId: 'c1', threadId: 't1', kind: 'thread' },
      title: 'スレッドの行', status: 'A', lastModified: 2000,
    };
    side.render([{ id: 's1', title: '会話の行', status: 'A', cwd: '/work', lastModified: 1000 }], {
      statuses: [{ status: 'A' }, { status: 'B', kept: true }],
      threads: [threadRow],
    });
    const root = dom.els.get('groups');
    const secA = sectionOf(root, 'A'), secB = sectionOf(root, 'B');
    t.ok('状態ごとの節（A と B）が描かれる', Boolean(secA && secB));
    const threadEl = rowOf(root, 'thread:c1:t1'), sessEl = rowOf(root, 's1');
    t.ok('会話は一時チャットの状態の中、スレッドはチャンネルの中', Boolean(threadEl && sessEl) && rowOf(secA, 's1') === sessEl && !rowOf(secA, threadRow.id));
    t.ok('チャンネルのスレッドはドラッグしない', threadEl.draggable !== true);
    threadEl.treeMenu(0, 0);
    t.ok('スレッドのメニューはスレッドの行を受け取る', calls[0]?.[0] === 'context' && calls[0]?.[1] === threadRow.id);
    calls.length = 0;
    t.ok('一時チャットの会話は掴める', sessEl.draggable === true);
    sessEl.dispatchEvent(dragEvent('dragstart'));
    const overB = dragEvent('dragover');
    secB.dispatchEvent(overB);
    t.ok('別の状態の節はドロップを受ける', overB.defaultPrevented === true);
    secB.dispatchEvent(dragEvent('drop'));
    t.ok('落とすと会話の状態が変わる', calls.length === 1 && calls[0][1] === 's1' && calls[0][2] === 'B', JSON.stringify(calls));

    // 同じ状態へは落とせない（節が受けないので drop も来ない）
    sessEl.dispatchEvent(dragEvent('dragstart'));
    const overA = dragEvent('dragover');
    secA.dispatchEvent(overA);
    t.ok('同じ状態の節は受けない', overA.defaultPrevented !== true);
    sessEl.dispatchEvent(dragEvent('dragend'));
    t.ok('同じ状態へ落としても状態の変更は呼ばれない', calls.length === 1, JSON.stringify(calls));

    // bot の会話（スレッドではない s.bot の行）は、今までどおり掴めない
    side.render([{ id: 's2', title: 'bot の会話', status: 'A', cwd: '/work', lastModified: 900, bot: { botId: 'b1', kind: 'dm' } }], {
      statuses: [{ status: 'A' }, { status: 'B', kept: true }],
      threads: [threadRow],
    });
    // bot の DM は Bots の行で示し、一時チャットには入れない
    t.ok('bot の会話の行は掴めないまま（状態を持たない）', !rowOf(root, 's2') || rowOf(root, 's2').draggable !== true);
  } finally {
    dom.restore();
  }

  // ---- 件数で絞らずに全部（ADR 0260）・手動の畳みの印。最後の好みは前の版の「ほか n 件」を開いた区画（chMore・statusMore）が残っているもの
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, title: `chat ${i}`, status: 'A', backend: 'fake', cwd: '/work', lastModified: 10000 - i }));
  for (const prefs of [{}, { filter: { status: 'A' } }, { filter: { backends: ['fake'] } }, { filter: { dir: '/work' } }, { chMore: ['a'], statusMore: ['A'] }]) {
    const d = installDom(prefs);
    try {
      const extra = new N('section'); extra.dataset.sec = 'bots';
      const side = createSide({ channelExtras: () => [extra] });
      side.setDirectory({ channels: [{ id: 'z', name: 'Zulu', kind: 'channel' }, { id: 'a', name: 'Alpha', kind: 'channel' }] });
      const threads = Array.from({ length: 7 }, (_, i) => ({ id: `thread:a:t${i}`, title: `thread ${i}`, thread: { channelId: 'a', threadId: `t${i}` }, status: i === 0 ? 'B' : 'A', lastModified: 10000 - i }));
      side.render(rows, { statuses: [{ status: 'A', icon: '◐' }, { status: 'B' }], threads, currentId: 's7', waitingIds: new Set(['s8', 'thread:a:t6']) });
      const root = d.els.get('groups');
      const a = sectionOf(root, 'A');
      t.ok('状態の会話を 9 件すべて出し、「ほか n 件」の行は無い', rows.every(r => !!rowOf(a, r.id)) && !find(root, n => String(n.dataset.key ?? '').startsWith('m:')) && !root.textContent.includes('ほか'));
      find(sectionOf(root, 'A'), n => n.dataset.key === 'g:A').treeExpand(false);
      if ('chMore' in prefs) {
        const saved = JSON.parse(localStorage.getItem('agent-host-side'));
        t.ok('前の版の chMore・statusMore は読まず、次の保存で消える', !('chMore' in saved) && !('statusMore' in saved) && saved.collapsed.includes('A'), JSON.stringify(saved));
      }
      t.ok('畳んだ状態の見出しに待ちの印', sectionOf(root, 'A').classList.contains('collapsed') && !!find(sectionOf(root, 'A').children[0], n => n.classList.contains('wait')));
      const home = find(root, n => n.dataset.sideKey === 'chsec:home');
      home.children[0].treeExpand(false);
      t.ok('一時チャットも畳むと待ちの印', !!find(find(root, n => n.dataset.sideKey === 'chsec:home').children[0], n => n.classList.contains('wait')));
      t.ok('あなたを待っている区画は無い', !find(root, n => n.classList.contains('bot-waits')));
      const channel = find(root, n => n.dataset.sideKey === 'chsec:a');
      if (prefs.filter?.dir || prefs.filter?.backends) {
        t.ok('スレッドの持たない値で絞る間はチャンネルを見せない', !channel && !find(root, n => n.dataset.sideKey === 'chsec:z'));
      } else {
        t.ok('チャンネルは同じ状態フィルターを守り、スレッドを件数で絞らずに全部出す', !!channel && [1, 2, 3, 4, 5, 6].every(i => !!rowOf(channel, `thread:a:t${i}`)) && (prefs.filter ? !rowOf(channel, 'thread:a:t0') : !!rowOf(channel, 'thread:a:t0')));
        t.ok('スレッドの行の状態アイコンに名前がある', !!find(channel, n => n.classList.contains('row-status') && n.getAttribute('aria-label') === 'A'));
      }
      t.ok('フィルター中は Bots を隠す', prefs.filter ? !root.children.includes(extra) : root.children.includes(extra));
      t.ok('状態の絞り込みでは空のチャンネルを出さない', !prefs.filter || !find(root, n => n.dataset.sideKey === 'chsec:z'));
    } finally { d.restore(); }
  }

  const familyDom = installDom();
  try {
    const side = createSide({});
    const root = familyDom.els.get('groups');
    const parent = { id: 'parent', title: 'parent', status: 'A', lastModified: 9990 };
    const child = { id: 'child', title: 'child', status: 'A', lastModified: 9989, parent: { sessionId: 'parent' } };
    side.render([...rows, parent, child], { statuses: [{ status: 'A' }], currentId: 'child' });
    t.ok('多くの会話の後ろの開いている枝も、fork の器ごと出る', !!find(root, n => n.dataset.sideKey === 'family:parent') && !!rowOf(root, 'parent') && !!rowOf(root, 'child'));
    t.ok('fork の器の中の行は level 4', rowOf(root, 'child')?.getAttribute('aria-level') === '4');
  } finally { familyDom.restore(); }

  // ---- onSetStatus → サーバーへの振り分け（web/client.mjs を vm で切り出して走らせる）
  {
    const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const cut = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
    const calls = [];
    const context = vm.createContext({
      state: { draft: { status: null } },
      side: { keep: (s) => calls.push(['keep', s]) },
      renderSessions: () => calls.push(['renderSessions']),
      cmd: (command, args) => { calls.push(['cmd', command, args]); return Promise.resolve({}); },
      loadThreadIndex: () => calls.push(['loadThreadIndex']),
      sideNote: (text) => calls.push(['note', text]),
      t: (key) => key,
      setStatusOf: (id, status) => calls.push(['setStatusOf', id, status]),
      Promise, setTimeout,
    });
    vm.runInContext(cut('const threadOfRow =', '\n\nconst side = createSide'), context);
    vm.runInContext(cut('function setThreadStatusOf', '\n\n/** スレッドの行のメニュー'), context);
    let code = cut('onSetStatus: (id, status)', 'onSetIcon:');
    code = code.slice(code.indexOf(':') + 1).trim().replace(/,\s*$/, '');
    const onSetStatus = vm.runInContext(`(${code})`, context);

    onSetStatus('thread:c1:t1', 'B');
    await new Promise((resolve) => setTimeout(resolve, 0));   // .then(() => loadThreadIndex()) を待つ
    const invoke = calls.find((c) => c[0] === 'cmd' && c[1] === 'invoke');
    t.ok('スレッドの行は channels.setThreadStatus へ（会話の setStatus へは行かない）',
      invoke?.[2]?.op === 'channels.setThreadStatus' && invoke?.[2]?.args?.channelId === 'c1' && invoke?.[2]?.args?.threadId === 't1' && invoke?.[2]?.args?.status === 'B'
      && calls.some((c) => c[0] === 'loadThreadIndex') && !calls.some((c) => c[0] === 'setStatusOf'), JSON.stringify(calls));

    calls.length = 0;
    onSetStatus('s1', 'B');
    t.ok('会話の行は今までどおり setStatusOf へ',
      calls.some((c) => c[0] === 'setStatusOf' && c[1] === 's1' && c[2] === 'B') && !calls.some((c) => c[0] === 'cmd'), JSON.stringify(calls));

    calls.length = 0;
    onSetStatus(null, 'B');
    t.ok('まだ id の無い新しいセッションは、今までどおり下書きの状態へ',
      context.state.draft.status === 'B' && calls.some((c) => c[0] === 'renderSessions'), JSON.stringify(calls));
  }
}
