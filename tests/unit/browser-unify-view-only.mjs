// 画面の「見るだけ」の関所（実の web/browser-unify.mjs。ADR 0321）: 引き継ぐ前の AI のタブには、アドレスバー・戻る・進む・再読み込み・閉じる・表示の切り替えを送らず、
// アドレスバーに打った URL は新しい人のタブで開く。サーバーが 'view-only' で断ったら AI の形に描き直して [引き継ぐ] を促し、[引き継ぐ] は映している AI のタブを添える。
// サーバーの側の関所は browser-unify-ws.mjs、映像の入力は browser-unify-input.mjs が確かめる
import { N } from '../lib/dom-stub.mjs';
import { createBrowserUnify } from '../../web/browser-unify.mjs';
import { createChromeControlStore, createTabHolderStore } from '../../web/chrome-control.mjs';

export const name = 'browser-unify-view-only';
export const title = '画面の「見るだけ」の関所: AI のタブへアドレスバーの移動・戻る・進む・再読み込み・閉じるを送らない・打った URL は新しいタブ・サーバーの断りで描き直す・[引き継ぐ] は映しているタブを添える（ADR 0321）';

/** web/browser-unify.mjs が触る面を dom-stub へ足す（server-browser-handback-row.mjs と同じ）。同じ worker のほかの suite へ残さないよう元に戻す */
function browserEnv() {
  const doc = globalThis.document ?? (globalThis.document = { createElement: tag => new N(tag) });
  const restore = [];
  const put = (obj, key, value) => { restore.push([obj, key, obj[key]]); obj[key] = value; };
  put(doc, 'createElement', tag => new N(tag));
  put(doc, 'head', new N('head'));
  put(doc, 'body', new N('body'));
  put(doc, 'getElementById', () => null);
  put(doc, 'querySelector', () => null);
  put(doc, 'querySelectorAll', () => []);
  put(doc, 'addEventListener', () => {});
  put(doc, 'removeEventListener', () => {});
  put(doc, 'dispatchEvent', () => true);
  put(doc, 'createTextNode', text => ({ textContent: String(text), outerHTML: String(text), shown: String(text), children: [], parent: null, dataset: {}, remove() {} }));
  put(globalThis, 'window', { addEventListener() {}, removeEventListener() {} });
  put(globalThis, 'ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  put(globalThis, 'CustomEvent', class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init?.detail ?? null; } });
  put(globalThis, 'matchMedia', query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  return () => { for (const [obj, key, value] of restore.reverse()) obj[key] = value; };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

export default async function (t) {
  const hadDocument = 'document' in globalThis, oldDocument = globalThis.document;
  const restoreEnv = browserEnv();
  try {
    const commands = []; let refuse = false;
    const cmd = async (name, args = {}) => {
      commands.push([name, args]);
      if (name === 'chromeNavigate' && refuse) throw Object.assign(new Error('view-only'), { code: 'view-only' });
      if (name === 'chromeNavigate' && args.action === 'new') return { targetId: 'N' };
      return {};
    };
    // 画面の枠（右の欄）の代わり。screencastState は chrome-panel が映像の便りから持つ形（agentTabId = サーバーの AI のタブ、tabId = 映しているタブ）
    const fixture = { sessionId: 's', tabId: 'A', screencastState: { tabId: 'A', agentTabId: 'A' }, mounted: null, input: null,
      isOpen: () => true, open() {}, close() {}, mountBrowserChrome(root) { this.mounted = root; }, onOpenChange() {}, onTargetChange() {}, onTabChange() {},
      useInput(options) { this.input = options; }, refreshInput() {}, focusScreen() {}, measure: async () => null };
    const holderStore = createTabHolderStore();
    const ui = createBrowserUnify({ state: { current: 's', cwd: '' }, chrome: () => fixture, controlStore: createChromeControlStore(), holderStore, notify: () => {}, showMenu: () => {}, cmd });
    ui.capsChanged({ browserUnify: true });
    ui.onEvent({ type: 'tab:info', sessionId: 's', reset: true, tabs: [{ sessionId: 's', targetId: 'A', url: 'https://ai.example/', title: 'AI のページ', canGoBack: true, canGoForward: true }] });
    await settle();
    const button = () => fixture.mounted?.querySelector('.b2-control')?.querySelector('.b2-action');
    const nudged = () => { const on = button()?.classList.contains('nudge') === true; button()?.classList.remove('nudge'); return on; };
    const sent = mark => commands.slice(mark).filter(([name]) => name === 'chromeNavigate');
    t.ok('前提: AI のタブを映している間は [引き継ぐ] の行が出る', button()?.textContent === '引き継ぐ', fixture.mounted?.outerHTML?.slice(0, 300));

    // 1. 戻る・進む・再読み込み・閉じる・表示の切り替えは送らず、[引き継ぐ] を促す
    for (const [action, args] of [['back', {}], ['forward', {}], ['reload', {}], ['close', { targetId: 'A' }], ['view', { view: 'source' }]]) {
      const mark = commands.length;
      const result = await ui.navigate(action, args);
      t.ok(`見るだけの AI のタブへ ${action} を送らず、[引き継ぐ] を促す`, result?.blocked === true && sent(mark).length === 0 && nudged(), JSON.stringify({ result, sent: sent(mark) }));
    }
    // アドレスバーに打った URL は AI のタブを動かさず、新しい人のタブで開く
    {
      const mark = commands.length;
      await ui.navigate('navigate', { input: 'https://typed.example/' });
      const calls = sent(mark);
      t.ok('見るだけの間にアドレスバーへ打った URL は、新しいタブで開く（AI のタブを動かさない）', calls.length === 1 && calls[0][1].action === 'new' && calls[0][1].input === 'https://typed.example/' && !calls.some(([, a]) => a.action === 'navigate'),
        JSON.stringify(calls));
    }
    // 新しいタブ（＋）はそのまま開く（AI のタブを映していても）
    {
      ui.onEvent({ type: 'tab:info', sessionId: 's', reset: true, tabs: [{ sessionId: 's', targetId: 'A', url: 'https://ai.example/', title: 'AI のページ' }] });
      await ui.focusTab({ targetId: 'A' }, 's');
      const mark = commands.length;
      await ui.navigate('new', { input: 'https://plus.example/' });
      t.ok('見るだけの間も新しいタブは開ける', sent(mark).length === 1 && sent(mark)[0][1].action === 'new', JSON.stringify(sent(mark)));
    }

    // 5. 画面の持ち手が古い（画面では人・サーバーでは AI）ときにサーバーが 'view-only' で断ったら、文を出さずに AI の形に描き直して促す
    ui.onEvent({ type: 'tab:info', sessionId: 's', reset: true, tabs: [{ sessionId: 's', targetId: 'A', url: 'https://ai.example/', title: 'AI のページ' }] });
    await ui.focusTab({ targetId: 'A' }, 's');
    ui.onEvent({ type: 'tab:holder', sessionId: 's', targetId: 'A', holder: 'human', by: 'device' });
    await settle();
    t.ok('前提: 画面で人のタブになると [AI に戻す] の形', button()?.textContent === 'AI に戻す', button()?.textContent);
    refuse = true;
    {
      const mark = commands.length;
      const result = await ui.navigate('reload');
      await settle();
      t.ok('サーバーが view-only で断ったら、失敗にせず AI の形へ描き直して [引き継ぐ] を促す', result?.blocked === true && sent(mark).length === 1 && holderStore.holderOf('s', 'A').holder === 'ai' && button()?.textContent === '引き継ぐ' && nudged(),
        JSON.stringify({ result, holder: holderStore.holderOf('s', 'A'), label: button()?.textContent }));
    }
    ui.onEvent({ type: 'tab:holder', sessionId: 's', targetId: 'A', holder: 'human', by: 'device' });
    await settle();
    fixture.input.onRefused('A');   // 映像の入力をサーバーが view-only で断った（web/chrome-panel.mjs）
    await settle();
    t.ok('映像の入力をサーバーが view-only で断ったときも、AI の形へ描き直して促す', holderStore.holderOf('s', 'A').holder === 'ai' && button()?.textContent === '引き継ぐ' && nudged());
    refuse = false;

    // 6. [引き継ぐ] は映している AI のタブを添える（サーバーの AI のタブと違えば、サーバーは引き継がない）
    {
      const mark = commands.length;
      await button().click();
      const taken = commands.slice(mark).filter(([name]) => name === 'chromeTakeOver');
      t.ok('[引き継ぐ] は映している AI のタブの id を添えて送る', taken.length === 1 && taken[0][1].by === 'screen' && taken[0][1].tabId === 'A', JSON.stringify(taken));
      fixture.screencastState = { tabId: 'B', agentTabId: 'B' };   // AI が別のタブへ移り、映像もそちらを映した
      ui.onEvent({ type: 'tab:info', sessionId: 's', reset: true, tabs: [{ sessionId: 's', targetId: 'A', url: 'https://ai.example/' }, { sessionId: 's', targetId: 'B', url: 'https://b.example/' }] });
      fixture.tabId = 'B'; await ui.focusTab({ targetId: 'B' }, 's'); await settle();
      const mark2 = commands.length;
      await button().click();
      const taken2 = commands.slice(mark2).filter(([name]) => name === 'chromeTakeOver');
      t.ok('AI のタブが替わった後の [引き継ぐ] は、今映しているタブを添える', taken2.length === 1 && taken2[0][1].tabId === 'B', JSON.stringify(taken2));
    }

    // 引き継いだ後は、今までどおり送る
    ui.onEvent({ type: 'tab:holder', sessionId: 's', targetId: 'B', holder: 'human', by: 'device' });
    await settle();
    for (const action of ['back', 'reload']) {
      const mark = commands.length;
      await ui.navigate(action);
      t.ok(`引き継いだ後は ${action} を AI のタブへ送る`, sent(mark).length === 1 && sent(mark)[0][1].action === action && sent(mark)[0][1].targetId === 'B', JSON.stringify(sent(mark)));
    }
    {
      const mark = commands.length;
      await ui.navigate('navigate', { input: 'https://moved.example/' });
      t.ok('引き継いだ後のアドレスバーは、そのタブを移す', sent(mark).length === 1 && sent(mark)[0][1].action === 'navigate' && sent(mark)[0][1].targetId === 'B', JSON.stringify(sent(mark)));
    }
  } finally {
    restoreEnv();
    if (!hadDocument) delete globalThis.document; else globalThis.document = oldDocument;
  }
}
