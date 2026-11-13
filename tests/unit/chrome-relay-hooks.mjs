// Chrome の中継（core/chrome/relay.mjs）の、ブラウザーの一本化の 4 つの口（ADR 0294〜0297、計画の S0）。
//   - 既定の実装は今の動きのまま（safeUrl・PAUSED_MESSAGE は中継から同じ値で読める）
//   - 差し替えた口が、決めた場所で呼ばれる: 移動の検査（navigate・createTarget・人が開く）・コマンドの前後のふるい・止めた要求・操作の前の門・タブの出入り・出来事
// 中身（本体の port を断る・持ち手・タブの情報・頼み）は各段の試験が見る。
import { agent, rig } from '../lib/chrome-relay-rig.mjs';
import { safeUrl, PAUSED_MESSAGE, TAB_EVENTS } from '../../core/chrome/relay.mjs';
import { safeUrl as policySafeUrl, createPagePolicy } from '../../core/chrome/page-policy.mjs';
import { PAUSED_MESSAGE as holderPaused, createTabHolder, readsOnly } from '../../core/chrome/tab-holder.mjs';
import { createTabInfo } from '../../core/chrome/tab-info.mjs';
import { createPageBridge } from '../../core/chrome/page-bridge.mjs';

export const name = 'chrome-relay-hooks';
export const title = 'Chrome の中継のブラウザーの一本化の口: 既定は今のまま・移動の検査・前後のふるい・止めた要求・操作の前の門・タブの出入り・出来事（偽の Chrome）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

export default async function (t) {
  // ---- 既定の実装
  {
    t.ok('safeUrl・PAUSED_MESSAGE は中継から同じものが読める', safeUrl === policySafeUrl && PAUSED_MESSAGE === holderPaused);
    t.ok('safeUrl は http(s)（認証情報なし）と about:blank だけ', safeUrl('https://a.example/') && safeUrl('about:blank') && !safeUrl('https://u:p@a.example/') && !safeUrl('file:///C:/x') && !safeUrl('javascript:1') && !safeUrl('nope'));
    const policy = createPagePolicy();
    const params = { url: 'https://a.example/' }, result = { ok: 1 };
    t.ok('移動の検査の既定は safeUrl', policy.allowUrl('https://a.example/', {}) === true && policy.allowUrl('chrome://settings', {}) === false);
    t.ok('前後のふるいの既定は素通し・要求は止めない・確認の Fetch のまま', policy.before({ params }) === params && policy.after({ result }) === result && policy.request({}) === null
      && policy.intercepts === false && JSON.stringify(policy.fetchPatterns([{ urlPattern: '*' }])) === '[{"urlPattern":"*"}]');
    t.ok('つながった・開く前の口の既定は何もしない', policy.connected({ send: () => { throw new Error('x'); } }) === undefined && policy.beforeOpen({ send: () => { throw new Error('x'); } }) === undefined);
    const holder = createTabHolder();
    t.ok('門の既定は一時停止の間だけ断る', holder.gate({ paused: { at: 1 } }) === PAUSED_MESSAGE && holder.gate({ paused: null }) === null);
    t.ok('門の attach の既定は何もしない（hand_to_user の台帳を受けるだけ）', holder.attach({ handoffs: { current: () => { throw new Error('x'); } } }) === undefined);
    const info = createTabInfo(), bridge = createPageBridge();
    t.ok('タブの情報・頼みの既定は何もしない', ['added', 'changed', 'removed'].every(k => typeof info[k] === 'function' && typeof bridge[k] === 'function' && info[k]({}) === undefined && bridge[k]({}) === undefined));
    t.ok('出来事の名前は 5 つ', JSON.stringify(TAB_EVENTS) === JSON.stringify(['tab:info', 'tab:holder', 'tab:page-request', 'tab:viewport', 'tab:downloads']));
  }

  // ---- 差し替えた口が呼ばれる
  {
    const seen = { allow: [], before: [], after: [], request: [], gate: [], operates: [], added: [], changed: [], removed: [], forget: [], rebind: [], ports: [], connected: [], beforeOpen: [], cookies: [] };
    let emitInfo = null, blockGate = false, intercepts = false;
    const hooks = {
      pagePolicy: ({ ports, cookie }) => ({
        allowUrl(url, context) { seen.allow.push({ url, ...context }); seen.ports.push(ports()); return safeUrl(url) && !url.includes('deny.example'); },
        async connected({ send }) { seen.connected.push((await send('Browser.getVersion', {})).product ?? null); },
        async beforeOpen({ sessionId, url, send }) {
          seen.cookies.push(cookie());
          seen.beforeOpen.push({ sessionId, url, targets: (await send('Target.getTargets', {})).targetInfos?.length ?? null });
          if (url.includes('throw.example')) throw new Error('boom');
        },
        async before({ method, params }) { seen.before.push(method); return method === 'Runtime.evaluate' && params.expression === 'swap-me' ? { ...params, expression: 'document.title' } : params; },
        after({ method, result }) { seen.after.push(method); return method === 'Runtime.evaluate' ? { ...result, filtered: true } : result; },
        get intercepts() { return intercepts; },
        fetchPatterns: patterns => patterns,
        request({ url }) { seen.request.push(url); return url.includes('blocked.example') ? 'block' : null; },
      }),
      tabHolder: () => ({
        gate({ method, paused, operates }) { seen.gate.push(method); if (operates) seen.operates.push(method); return paused ? PAUSED_MESSAGE : blockGate && !readsOnly(method) ? 'HELD-BY-HUMAN' : null; },
        forget(gone) { seen.forget.push(gone.targetId); },
        rebind(from, to) { seen.rebind.push([from, to]); },
      }),
      tabInfo: ({ emit }) => {
        emitInfo = emit;
        return { added(tab) { seen.added.push(tab); }, changed(tab) { seen.changed.push(tab.targetId); }, removed(gone) { seen.removed.push(gone.targetId); } };
      },
    };
    const r = await rig({ hooks });
    let a;
    try {
      const events = [];
      const off = r.relay.onTabEvent((type, payload) => events.push([type, payload]));
      r.relay.setPagePorts({ main: 7420, pages: 7421, isolated: 7422 });
      r.relay.setPageCookie({ name: 'pleiad_pages', value: 'v', path: '/_pleiad/' });
      t.ok('4 つの口の実体を relay.unify で外から読める', ['pagePolicy', 'tabHolder', 'tabInfo', 'pageBridge'].every(k => r.relay.unify[k] && typeof r.relay.unify[k] === 'object'));
      a = await agent(await r.relay.endpoint('one'));
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      t.ok('上りにつながると connected が呼ばれ、中継自身の接続でブラウザーの単位のコマンドを送れる', await until(() => seen.connected.length === 1 && typeof seen.connected[0] === 'string'), JSON.stringify(seen.connected));

      const deniedCreate = await a.cmd('Target.createTarget', { url: 'https://deny.example/' });
      t.ok('createTarget は移動の検査の口を通る（via: create）', deniedCreate.error?.message === 'navigation denied' && seen.allow.some(x => x.via === 'create' && x.sessionId === 'one'));
      t.ok('口はサーバーの port を読める', JSON.stringify(seen.ports.at(-1)) === '{"main":7420,"pages":7421,"isolated":7422}');

      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result?.targetId;
      t.ok('about:blank を開くときは開く前の口を呼ばない', seen.beforeOpen.length === 0);
      const withUrl = await a.cmd('Target.createTarget', { url: 'https://open.example/' });
      t.ok('URL を開く createTarget は、開く前の口を待ってから開く（会話の id・URL・中継の接続・Cookie が読める）', !withUrl.error && seen.beforeOpen.some(x => x.sessionId === 'one' && x.url === 'https://open.example/' && typeof x.targets === 'number')
        && seen.cookies.at(-1)?.value === 'v', JSON.stringify(seen.beforeOpen));
      if (withUrl.result?.targetId) await a.cmd('Target.closeTarget', { targetId: withUrl.result.targetId });
      t.ok('タブが範囲に入ると tabInfo.added（会話の id・targetId・targetInfo・attach）', await until(() => seen.added.some(tab => tab.targetId === tabId))
        && (() => { const tab = seen.added.find(x => x.targetId === tabId); return tab.sessionId === 'one' && tab.info?.targetId === tabId && typeof tab.attach === 'function'; })());
      const handle = seen.added.find(x => x.targetId === tabId);
      const own = await handle.attach(() => {});
      t.ok('口の attach で中継自身のセッションを付けられる（send・detach）', typeof own.sessionId === 'string' && (await own.send('Runtime.evaluate', { expression: '1' })).result?.value === 1);
      await own.detach();

      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result?.sessionId;
      const deniedNav = await a.cmd('Page.navigate', { url: 'https://deny.example/x' }, sid);
      t.ok('Page.navigate は移動の検査の口を通る（via: navigate）', deniedNav.error?.message === 'navigation denied' && seen.allow.some(x => x.via === 'navigate'));
      const swapped = await a.cmd('Runtime.evaluate', { expression: 'swap-me' }, sid);
      t.ok('前のふるいで変えた引数が上りへ届き、後のふるいで変えた結果が返る', swapped.result?.result?.type === 'string' && swapped.result?.filtered === true
        && r.chrome.calls.some(c => c.method === 'Runtime.evaluate' && c.params.expression === 'document.title'), JSON.stringify(swapped));
      t.ok('コマンドは全部門を通り、操作（OPERATES）には operates の印が付く', seen.operates.includes('Runtime.evaluate') && !(await a.cmd('Accessibility.getFullAXTree', {}, sid)).error && seen.gate.includes('Accessibility.getFullAXTree') && !seen.operates.includes('Accessibility.getFullAXTree'));
      blockGate = true;
      const held = await a.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }, sid);
      t.ok('門が断った操作は上りへ送らず、門の文が返る', held.error?.message === 'HELD-BY-HUMAN' && !r.chrome.calls.some(c => c.method === 'Input.dispatchMouseEvent'));
      t.ok('門が読むだけのコマンドを通せば通る', !(await a.cmd('Accessibility.getFullAXTree', {}, sid)).error);
      blockGate = false;

      // 確認が OFF でも、口が要求を止めたいなら中継のセッションを付けて聞く
      intercepts = true;
      const created2 = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tab2 = created2.result?.targetId;
      const sid2 = (await a.cmd('Target.attachToTarget', { targetId: tab2, flatten: true })).result?.sessionId;
      await until(() => r.fake.sessions().filter(s => s.targetId === tab2).length >= 2);
      const blocked = await a.cmd('Page.navigate', { url: 'https://blocked.example/' }, sid2);
      t.ok('口が止めたい（intercepts）なら、確認が OFF でも止めた要求を request に聞き、block なら失敗させる', blocked.result?.errorText === 'net::ERR_BLOCKED_BY_CLIENT' && seen.request.includes('https://blocked.example/'), JSON.stringify(blocked));
      const passed = await a.cmd('Page.navigate', { url: 'https://ok.example/' }, sid2);
      t.ok('request が null なら今の扱い（確認が OFF なので通す）', !passed.result?.errorText && seen.request.includes('https://ok.example/'));
      t.ok('タブの URL が替わると tabInfo.changed', seen.changed.includes(tab2));
      intercepts = false;

      // 人がビューアから開く
      const opened = await r.relay.openForConversation('one', 'https://throw.example/').then(() => true, () => false);
      t.ok('人が開くときも開く前の口を通り、口が投げても開く', opened && seen.beforeOpen.some(x => x.url === 'https://throw.example/'));
      await r.relay.openForConversation('one', 'https://deny.example/').then(() => t.ok('人が開く移動も検査の口を通る（via: open）', false), error => t.ok('人が開く移動も検査の口を通る（via: open）', /denied/.test(error.message) && seen.allow.some(x => x.via === 'open')));

      emitInfo('tab:info', { sessionId: 'one', targetId: tabId });
      emitInfo('tab:unknown', { sessionId: 'one' });
      t.ok('出来事は onTabEvent に (type, payload) で届き、決めた名前のほかは出さない', events.length === 1 && events[0][0] === 'tab:info' && events[0][1].targetId === tabId);
      off();

      await a.cmd('Target.closeTarget', { targetId: tabId });
      t.ok('タブが無くなると tabInfo.removed と tabHolder.forget', await until(() => seen.removed.includes(tabId) && seen.forget.includes(tabId)));
      r.relay.rebind('one', 'one-native');
      t.ok('会話の id が決まると tabHolder.rebind（前の id・後の id）', JSON.stringify(seen.rebind) === '[["one","one-native"]]');
    } finally {
      a?.close();
      await r.stop();
    }
  }
}
