// Chrome の中継（core/chrome/relay.mjs）の、ブラウザーの一本化の 4 つの口（ADR 0291〜0294、計画の S0）。
//   - 既定の実装は今の動きのまま（safeUrl・PAUSED_MESSAGE は中継から同じ値で読める）
//   - 差し替えた口が、決めた場所で呼ばれる: 移動の検査（navigate・createTarget・人が開く）・コマンドの前後のふるい・止めた要求・操作の前の門・タブの出入り・出来事
// 中身（本体の port を断る・持ち手・タブの情報・頼み）は各段の試験が見る。
import { agent, rig } from '../lib/chrome-relay-rig.mjs';
import { safeUrl, PAUSED_MESSAGE, TAB_EVENTS } from '../../core/chrome/relay.mjs';
import { safeUrl as policySafeUrl, createPagePolicy } from '../../core/chrome/page-policy.mjs';
import { PAUSED_MESSAGE as holderPaused, createTabHolder } from '../../core/chrome/tab-holder.mjs';
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
    const holder = createTabHolder();
    t.ok('門の既定は一時停止の間だけ断る', holder.gate({ paused: { at: 1 } }) === PAUSED_MESSAGE && holder.gate({ paused: null }) === null);
    const info = createTabInfo(), bridge = createPageBridge();
    t.ok('タブの情報・頼みの既定は何もしない', ['added', 'changed', 'removed'].every(k => typeof info[k] === 'function' && typeof bridge[k] === 'function' && info[k]({}) === undefined && bridge[k]({}) === undefined));
    t.ok('出来事の名前は 4 つ', JSON.stringify(TAB_EVENTS) === JSON.stringify(['tab:info', 'tab:holder', 'tab:page-request', 'tab:viewport']));
  }

  // ---- 差し替えた口が呼ばれる
  {
    const seen = { allow: [], before: [], after: [], request: [], gate: [], added: [], changed: [], removed: [], forget: [], ports: [] };
    let emitInfo = null, blockGate = false, intercepts = false;
    const hooks = {
      pagePolicy: ({ ports }) => ({
        allowUrl(url, context) { seen.allow.push({ url, ...context }); seen.ports.push(ports()); return safeUrl(url) && !url.includes('deny.example'); },
        before({ method, params }) { seen.before.push(method); return method === 'Runtime.evaluate' && params.expression === 'swap-me' ? { ...params, expression: 'document.title' } : params; },
        after({ method, result }) { seen.after.push(method); return method === 'Runtime.evaluate' ? { ...result, filtered: true } : result; },
        get intercepts() { return intercepts; },
        fetchPatterns: patterns => patterns,
        request({ url }) { seen.request.push(url); return url.includes('blocked.example') ? 'block' : null; },
      }),
      tabHolder: () => ({
        gate({ method, paused }) { seen.gate.push(method); return paused ? PAUSED_MESSAGE : blockGate ? 'HELD-BY-HUMAN' : null; },
        forget(gone) { seen.forget.push(gone.targetId); },
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
      a = await agent(await r.relay.endpoint('one'));
      await a.cmd('Target.setDiscoverTargets', { discover: true });

      const deniedCreate = await a.cmd('Target.createTarget', { url: 'https://deny.example/' });
      t.ok('createTarget は移動の検査の口を通る（via: create）', deniedCreate.error?.message === 'navigation denied' && seen.allow.some(x => x.via === 'create' && x.sessionId === 'one'));
      t.ok('口はサーバーの port を読める', JSON.stringify(seen.ports.at(-1)) === '{"main":7420,"pages":7421,"isolated":7422}');

      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result?.targetId;
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
      t.ok('操作（OPERATES）は門を通る。読むだけのコマンドは門を通らない', seen.gate.includes('Runtime.evaluate') && !(await a.cmd('Accessibility.getFullAXTree', {}, sid)).error && !seen.gate.includes('Accessibility.getFullAXTree'));
      blockGate = true;
      const held = await a.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }, sid);
      t.ok('門が断った操作は上りへ送らず、門の文が返る', held.error?.message === 'HELD-BY-HUMAN' && !r.chrome.calls.some(c => c.method === 'Input.dispatchMouseEvent'));
      t.ok('門が断っても読むコマンドは通る', !(await a.cmd('Accessibility.getFullAXTree', {}, sid)).error);
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
      await r.relay.openForConversation('one', 'https://deny.example/').then(() => t.ok('人が開く移動も検査の口を通る（via: open）', false), error => t.ok('人が開く移動も検査の口を通る（via: open）', /denied/.test(error.message) && seen.allow.some(x => x.via === 'open')));

      emitInfo('tab:info', { sessionId: 'one', targetId: tabId });
      emitInfo('tab:unknown', { sessionId: 'one' });
      t.ok('出来事は onTabEvent に (type, payload) で届き、決めた名前のほかは出さない', events.length === 1 && events[0][0] === 'tab:info' && events[0][1].targetId === tabId);
      off();

      await a.cmd('Target.closeTarget', { targetId: tabId });
      t.ok('タブが無くなると tabInfo.removed と tabHolder.forget', await until(() => seen.removed.includes(tabId) && seen.forget.includes(tabId)));
    } finally {
      a?.close();
      await r.stop();
    }
  }
}
