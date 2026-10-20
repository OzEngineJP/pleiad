// 脇の「状態」の並べ方で、bot のスレッドの行をドラッグで別の状態へ移せる（channels.setThreadStatus）。
// 起きていた不具合: スレッドの行は s.bot で早く return するので draggable にすらならず、状態の節の
// dragover/drop は last.sessions だけを引くので "thread:<チャンネル>:<根>" の id を解けず、落とせなかった。
// web/side.mjs を dom-stub で実際に描き、行の dragstart → 節の dragover → drop で onSetStatus が呼ばれるまで確かめる。
// onSetStatus からサーバーへの振り分け（スレッドの行 id → channels.setThreadStatus。会話は今までどおり setStatus）は、
// web/client.mjs の該当部分を vm で走らせて確かめる（tests/unit/sidebar-client-moves.mjs と同じやり方）。
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { N } from '../lib/dom-stub.mjs';
import { createSide } from '../../web/side.mjs';

export const name = 'side-thread-status';
export const title = '脇の状態の並べ方: スレッドの行をドラッグで別の状態へ移せる';

// createSide が触る要素の id（web/index.html の脇）。無いと getElementById が null を返して落ちるので全部置く
const IDS = ['groups', 'q', 'fchips', 'filterBtn', 'filterOutside', 'keyHint', 'clearFilterOutside', 'newSession',
  'settings', 'sidebar', 'qClear', 'recentPop', 'filterPop', 'resHead', 'resArc', 'resCount', 'resLive', 'resSort',
  'searchHint', 'sideUndo'];

/** dom-stub（document.createElement だけ）に、createSide が要る面を足す。終わったら元に戻す（同じ worker の後の suite へ残さない） */
function installDom() {
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
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
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
      onSetStatus: (id, status) => calls.push(['setStatus', id, status]),
      onSetGrouped: (s, ungrouped) => calls.push(['setGrouped', s.id, ungrouped]),
    });
    const threadRow = {
      id: 'thread:c1:t1',
      thread: { channelId: 'c1', threadId: 't1' },
      bot: { botId: 'b1', channelId: 'c1', threadId: 't1', kind: 'thread' },
      title: 'スレッドの行', status: 'A', lastModified: 2000,
    };
    side.render([{ id: 's1', title: '会話の行', status: 'A', cwd: '/work', lastModified: 1000 }], {
      statuses: [{ status: 'A' }, { status: 'B', kept: true }],
      threads: [threadRow],
      order: 'status',
    });
    const root = dom.els.get('groups');
    const secA = sectionOf(root, 'A'), secB = sectionOf(root, 'B');
    t.ok('状態ごとの節（A と B）が描かれる', Boolean(secA && secB));
    const threadEl = rowOf(root, 'thread:c1:t1'), sessEl = rowOf(root, 's1');
    t.ok('スレッドと会話の行が状態 A の下に出る', Boolean(threadEl && sessEl));

    // スレッドの行を状態 B へ落とす
    t.ok('スレッドの行は掴める（draggable）', threadEl.draggable === true, String(threadEl.draggable));
    threadEl.dispatchEvent(dragEvent('dragstart'));
    const overB = dragEvent('dragover');
    secB.dispatchEvent(overB);
    t.ok('別の状態の節はドロップを受ける（dragover で preventDefault）', overB.defaultPrevented === true);
    secB.dispatchEvent(dragEvent('drop'));
    t.ok('落とすと onSetStatus へスレッドの行 id と新しい状態が届く',
      calls.length === 1 && calls[0][0] === 'setStatus' && calls[0][1] === 'thread:c1:t1' && calls[0][2] === 'B', JSON.stringify(calls));

    // 同じ状態へは落とせない（節が受けないので drop も来ない）
    threadEl.dispatchEvent(dragEvent('dragstart'));
    const overA = dragEvent('dragover');
    secA.dispatchEvent(overA);
    t.ok('同じ状態の節は受けない', overA.defaultPrevented !== true);
    threadEl.dispatchEvent(dragEvent('dragend'));
    t.ok('同じ状態へ落としても状態の変更は呼ばれない', calls.length === 1, JSON.stringify(calls));

    // 会話の行は今までどおり
    sessEl.dispatchEvent(dragEvent('dragstart'));
    const overB2 = dragEvent('dragover');
    secB.dispatchEvent(overB2);
    secB.dispatchEvent(dragEvent('drop'));
    t.ok('会話の行も今までどおり別の状態へ移せる',
      calls.some((c) => c[0] === 'setStatus' && c[1] === 's1' && c[2] === 'B'), JSON.stringify(calls));

    // bot の会話（スレッドではない s.bot の行）は、今までどおり掴めない
    side.render([{ id: 's2', title: 'bot の会話', status: 'A', cwd: '/work', lastModified: 900, bot: { botId: 'b1', kind: 'dm' } }], {
      statuses: [{ status: 'A' }, { status: 'B', kept: true }],
      threads: [threadRow],
      order: 'status',
    });
    // bot の会話は先頭の「あなたを待っている」の節には入らず（waiting でない）、状態のグループにも入らない
    t.ok('bot の会話の行は掴めないまま（状態を持たない）', !rowOf(root, 's2') || rowOf(root, 's2').draggable !== true);
  } finally {
    dom.restore();
  }

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
