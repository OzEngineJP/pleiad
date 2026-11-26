// 欄が別の会話を映しているときのタブの開き方（実の web/browser-unify.mjs と右の欄の代役）。
// チャンネルのスレッドの可視化は bot の会話にページタブを作る。欄は Chats で最後に開いた会話を映しているので、
// openTab・focusTab が「欄の会話と同じときだけ選んで開く」だと、bot の会話にタブが黙って増えるだけで欄が開かなかった（「ページで開く」が反応しない）。
// 別の会話なら、欄をその会話に向けて開いて（chrome-panel の open の { target }。openEntry と同じ）からタブを選ぶ。同じ会話なら今までどおり target を付けない
import { N } from '../lib/dom-stub.mjs';
import { createBrowserUnify } from '../../web/browser-unify.mjs';

export const name = 'browser-unify-other-session';
export const title = '別の会話のタブ: openTab・focusTab は欄をその会話に向けて開いてからタブを選ぶ（スレッドの可視化の「ページで開く」）・同じ会話は今までどおり';

const ISOLATED = 'http://f0123456789abcdef.localhost:23456';
const HASH = 'a'.repeat(64);

/** browser-unify が触る面を代役へ足す。同じ worker のほかの suite へ残さないよう元に戻す */
function browserEnv() {
  const doc = globalThis.document;
  const restore = [];
  const put = (obj, key, value) => { restore.push([obj, key, Object.getOwnPropertyDescriptor(obj, key)]); obj[key] = value; };
  put(doc, 'head', new N('head'));
  put(doc, 'body', new N('body'));
  put(doc, 'getElementById', () => null);
  put(doc, 'querySelector', () => null);
  put(doc, 'querySelectorAll', () => []);
  put(doc, 'addEventListener', () => {});
  put(doc, 'removeEventListener', () => {});
  put(doc, 'dispatchEvent', () => true);
  put(doc, 'createTextNode', text => ({ textContent: String(text), outerHTML: String(text), shown: String(text), children: [], parent: null, dataset: {}, matches: () => false, remove() {} }));
  const make = doc.createElement;
  put(doc, 'createElement', tag => {
    const node = make(tag);
    if (String(tag).toLowerCase() === 'iframe') node.contentWindow = { postMessage() {}, location: { get href() { return node.src; } }, document: new N('document') };
    return node;
  });
  put(globalThis, 'window', { addEventListener() {}, removeEventListener() {} });
  put(globalThis, 'ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  put(globalThis, 'CustomEvent', class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init?.detail ?? null; } });
  put(globalThis, 'matchMedia', query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  return () => { for (const [obj, key, descriptor] of restore.reverse()) { if (descriptor) Object.defineProperty(obj, key, descriptor); else delete obj[key]; } };
}

/**
 * 右の欄の代役（web/chrome-panel.mjs の open と同じ向き方）: target を付けて開くと、閉じていれば開き、開いていれば映す会話だけ替える。
 * どちらも sessionId をその場で替える。開いた呼び出しを opens に残す
 */
function pane(sessionId) {
  return { sessionId, tabId: null, host: null, opened: false, opens: [],
    isOpen() { return this.opened; },
    open(element = null, { target = null } = {}) { this.opens.push({ target }); this.opened = true; if (target) this.sessionId = target; },
    close() { this.opened = false; },
    mountBrowserChrome() {}, mountPage(host) { this.host = host; }, cancelTabPin() {},
    onOpenChange() {}, onTargetChange() {}, onTabChange() {} };
}

export default async function (t) {
  const undo = browserEnv();
  const uis = [];
  try {
    const rig = () => {
      const box = pane('chat');   // 欄は Chats で最後に開いた会話を映している
      const ui = createBrowserUnify({
        state: { current: 'chat', cwd: '/w' }, chrome: () => box, notify: () => {}, showMenu: () => {},
        pageOpen: async request => ({ kind: 'viz', hash: request.hash, entry: request.entry, title: request.title, url: `${ISOLATED}/viz/${request.hash}/${request.entry}` }),
        cmd: async () => ({}) });
      uis.push(ui);
      ui.capsChanged({ browserUnify: true });
      // 選ばれているタブ（タブの列の aria-selected）の id
      const selected = () => ui.root.querySelectorAll('.bu-tab-pick').find(node => node.getAttribute('aria-selected') === 'true')?.parent?.dataset?.target ?? null;
      return { ui, box, selected };
    };
    const viz = sessionId => ({ sessionId, kind: 'viz', vizHash: HASH, entry: 'index.html', title: '集計' });

    // 1. スレッドの可視化の「ページで開く」: bot の会話のタブを、欄を bot の会話に向けて開いてから選ぶ
    {
      const r = rig();
      const tab = await r.ui.openTab(viz('bot'));
      t.ok('別の会話のタブを開くと、欄をその会話に向けて開く（{ target }）',
        r.box.opened && r.box.opens.length > 0 && r.box.opens.every(o => o.target === 'bot') && r.box.sessionId === 'bot', JSON.stringify(r.box.opens));
      t.ok('向けた後に、開いたタブを選んで映す', tab?.sessionId === 'bot' && r.selected() === tab.targetId && r.box.host != null,
        JSON.stringify({ selected: r.selected(), tab: tab?.targetId, host: r.box.host != null }));

      // 2. 同じ可視化をもう一度（focusTab。file-preview.mjs が同じタブを使い回す）: 欄が別の会話（Chats）へ戻っていても、bot の会話へ向け直して選ぶ
      const other = await r.ui.openTab(viz('chat'));
      r.box.opens.length = 0;
      t.ok('前提: 欄が Chats の会話を映し直し、そのタブを選んでいる', r.box.sessionId === 'chat' && r.selected() === other?.targetId, JSON.stringify({ sessionId: r.box.sessionId, selected: r.selected() }));
      await r.ui.focusTab(tab, 'bot');
      t.ok('focusTab も別の会話なら欄をその会話に向けて開き、そのタブを選ぶ',
        r.box.opens.length > 0 && r.box.opens.every(o => o.target === 'bot') && r.box.sessionId === 'bot' && r.selected() === tab.targetId && r.selected() !== other?.targetId,
        JSON.stringify({ opens: r.box.opens, sessionId: r.box.sessionId, selected: r.selected() }));
    }

    // 3. 欄と同じ会話のタブは今までどおり（target を付けずに開く。映す会話を替えない）
    {
      const r = rig();
      const tab = await r.ui.openTab(viz('chat'));
      t.ok('同じ会話のタブは target を付けずに開いて選ぶ',
        r.box.opens.length === 1 && r.box.opens[0].target === null && r.box.sessionId === 'chat' && r.selected() === tab.targetId, JSON.stringify(r.box.opens));
      r.box.opens.length = 0;
      await r.ui.focusTab(tab, 'chat');
      t.ok('同じ会話の focusTab も target を付けない', r.box.opens.length === 1 && r.box.opens[0].target === null && r.box.sessionId === 'chat', JSON.stringify(r.box.opens));
    }
  } finally {
    for (const ui of uis) ui.dispose?.();
    undo();
  }
}
