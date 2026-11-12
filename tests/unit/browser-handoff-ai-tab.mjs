// AI のタブを別に持ち、引き継ぐまで映像は見るだけ（ADR 0321。ADR 0296 の「映像に触れたら人の操作になる」「引き継ぐのボタンを置かない」の置き換え）:
//   - 中継: 人が開いたタブは AI のタブを替えない（attach・準備のコマンドでも）・AI が明示に操作したタブが AI のタブになる・閉じたら履歴の前の AI のタブへ戻る（popup は開いた元へ）
//   - サーバー: 引き継ぐ前の AI のタブの映像への入力は 'view-only' で断り、人の操作に数えない・引き継いだあとは通る・人が開いたタブは今までどおり触れる
//   - 画面の部品: 映像（見るだけの間は送らない）・行（<名前> が Chrome を操作中 [引き継ぐ]）・押したら強調
import { agent, rig } from '../lib/chrome-relay-rig.mjs';
import { createChromeScreencast } from '../../core/chrome/screencast.mjs';
import { createScreencastHub, screencastCommand } from '../../core/browser-screencast.mjs';
import { createTabHolder, HUMAN_TIMEOUT_MS } from '../../core/chrome/tab-holder.mjs';
import { createControlBadge } from '../../web/chrome-control.mjs';
import { createScreencastInput } from '../../web/screencast-frame.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'browser-handoff-ai-tab';
export const title = 'AI のタブを別に持つ・引き継ぐまで映像は見るだけ（ADR 0321）: 中継の今のタブ・サーバーの view-only・[引き継ぐ] の行・映像の封じ（偽の Chrome・DOM の代役）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) return false; await sleep(10); } return true; }

export default async function (t) {
  // ===== 1. 中継: AI のタブは AI が操作したタブだけ =====
  {
    const r = await rig();
    let a;
    try {
      a = await agent(await r.relay.endpoint('one'));
      t.ok('AI が何も操作していない間は AI のタブは無い', r.relay.view.current('one') === null);
      const human = (await r.relay.openForConversation('one', 'https://human.test/')).targetId;
      t.ok('人がパネルから開いたタブは AI のタブにならない（最初のタブへも戻さない）', !!human && r.relay.view.current('one') === null, String(r.relay.view.current('one')));
      t.ok('shown: AI のタブが無い間は窓の最初のタブ（撮影・窓の特定など、引き継ぎの対象でない所が使う）', r.relay.view.shown('one') === human, String(r.relay.view.shown('one')));
      const made = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      t.ok('AI が開いたタブが AI のタブになる', r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      const human2 = (await r.relay.openForConversation('one', 'https://human2.test/')).targetId;
      t.ok('そのあとに人が開いたタブも、AI のタブを替えない', !!human2 && r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      t.ok('shown: AI のタブがあれば、最初のタブ（人のタブ）ではなく AI のタブ', r.relay.view.shown('one') === made && r.relay.state('one').lastWindowId === r.fake.targets().find(x => x.targetId === made)?.windowId,
        JSON.stringify([r.relay.view.shown('one'), r.relay.state('one').lastWindowId]));
      // agent-browser は、人が開いたタブにも自分から attach し、準備のコマンドを送る（実測 2026-11-12、agent-browser 0.38.1 の順）。それでは AI のタブは移らない
      const sid = (await a.cmd('Target.attachToTarget', { targetId: human, flatten: true })).result.sessionId;
      for (const method of ['Runtime.runIfWaitingForDebugger', 'Page.enable', 'Runtime.enable', 'Network.enable', 'Target.setAutoAttach', 'Page.getFrameTree'])
        await a.cmd(method, method === 'Target.setAutoAttach' ? { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } : {}, sid);
      t.ok('人が開いたタブに AI がつないで準備しただけでは、AI のタブは移らない', r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      // 自動 attach の接続（relay が真似て attach する）でも同じ
      const b = await agent(await r.relay.endpoint('one'));
      try {
        await b.cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
        const human3 = (await r.relay.openForConversation('one', 'https://human3.test/')).targetId;
        const attached = await until(() => b.events.some(e => e.method === 'Target.attachedToTarget' && e.params.targetInfo.targetId === human3));
        const bsid = b.events.find(e => e.method === 'Target.attachedToTarget' && e.params.targetInfo.targetId === human3)?.params.sessionId;
        for (const method of ['Runtime.runIfWaitingForDebugger', 'Page.enable', 'Runtime.enable', 'Page.getFrameTree']) await b.cmd(method, {}, bsid);
        t.ok('自動 attach の接続が人のタブにつながり準備しても、AI のタブは移らない', attached && r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      } finally { b.close(); }
      await a.cmd('Runtime.evaluate', { expression: '1' }, sid);
      t.ok('AI が人のタブを明示に操作したら（Runtime.evaluate）、そのタブが AI のタブになる', r.relay.view.current('one') === human, String(r.relay.view.current('one')));
      const sid2 = (await a.cmd('Target.attachToTarget', { targetId: human2, flatten: true })).result.sessionId;
      await a.cmd('Page.bringToFront', {}, sid2);
      t.ok('タブの明示の切り替え（Page.bringToFront）でも、そのタブが AI のタブになる', r.relay.view.current('one') === human2, String(r.relay.view.current('one')));
      await a.cmd('Target.closeTarget', { targetId: human2 });
      t.ok('AI のタブが閉じたら、履歴の 1 つ前の AI のタブへ戻る（人のタブの最初へではない）', await until(() => r.relay.view.current('one') === human), String(r.relay.view.current('one')));
      await a.cmd('Target.closeTarget', { targetId: human });
      t.ok('それも閉じたら、さらに前の AI のタブへ戻る', await until(() => r.relay.view.current('one') === made), String(r.relay.view.current('one')));

      // popup: AI のタブが開いた popup を AI が操作 → 閉じたら開いた元へ戻る
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      const madeSid = (await a.cmd('Target.attachToTarget', { targetId: made, flatten: true })).result.sessionId;
      await a.cmd('Runtime.evaluate', { expression: '1' }, madeSid);
      r.fake.windowOpen(made, 'https://pop.test/', { popup: true });
      const popupSeen = await until(() => a.events.some(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === made));
      const popup = a.events.find(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === made)?.params.targetInfo.targetId;
      t.ok('AI のタブが開いた popup は、開いただけでは AI のタブにならない', popupSeen && r.relay.view.current('one') === made, String(r.relay.view.current('one')));
      const popSid = (await a.cmd('Target.attachToTarget', { targetId: popup, flatten: true })).result.sessionId;
      await a.cmd('Runtime.evaluate', { expression: '1' }, popSid);
      t.ok('popup を AI が操作したら popup が AI のタブ', r.relay.view.current('one') === popup, String(r.relay.view.current('one')));
      await a.cmd('Target.closeTarget', { targetId: popup });
      t.ok('popup が閉じたら、開いた元の AI のタブへ戻る', await until(() => r.relay.view.current('one') === made), String(r.relay.view.current('one')));

      // 人が開いたタブの popup も人のタブ（準備では AI のタブにならない）
      const human4 = (await r.relay.openForConversation('one', 'https://human4.test/')).targetId;
      r.fake.windowOpen(human4, 'https://pop2.test/');
      const hp = await until(() => a.events.some(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === human4));
      const humanPopup = a.events.find(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === human4)?.params.targetInfo.targetId;
      const hpSid = (await a.cmd('Target.attachToTarget', { targetId: humanPopup, flatten: true })).result.sessionId;
      await a.cmd('Page.getFrameTree', {}, hpSid);
      t.ok('人のタブが開いた popup に AI がつないで準備しても、AI のタブは移らない', hp && r.relay.view.current('one') === made, String(r.relay.view.current('one')));

      // エージェントがつなぎ直す（agent-browser の再起動）: 範囲のタブ全部に attach して準備しても、AI のタブは替わらない
      a.close(); await a.closed;
      a = await agent(await r.relay.endpoint('one'));
      const { targetInfos } = (await a.cmd('Target.getTargets')).result;
      for (const info of [...targetInfos].reverse()) {
        const s = (await a.cmd('Target.attachToTarget', { targetId: info.targetId, flatten: true })).result.sessionId;
        await a.cmd('Page.enable', {}, s); await a.cmd('Page.getFrameTree', {}, s);
      }
      t.ok('エージェントがつなぎ直して全部のタブにつないでも、AI のタブは前のまま', targetInfos.length >= 3 && r.relay.view.current('one') === made, JSON.stringify([targetInfos.length, r.relay.view.current('one')]));

      // AI のタブを全部閉じた: 人のタブだけ → AI のタブは無し（最初のタブの例外は shown だけ）
      await a.cmd('Target.closeTarget', { targetId: made });
      t.ok('AI のタブが全部閉じたら無し（人のタブを AI のタブにしない）', await until(() => r.relay.view.current('one') === null), String(r.relay.view.current('one')));
      const firstTab = r.relay.view.tabs('one')[0]?.targetId;
      t.ok('shown は AI のタブが無いときだけ窓の最初のタブ', !!firstTab && r.relay.view.shown('one') === firstTab, JSON.stringify([r.relay.view.shown('one'), firstTab]));
      // Chrome との接続が切れた: タブは無くなり、AI のタブも無し（古い id を指さない）
      r.chrome.dropConnections();
      t.ok('Chrome との接続が切れたら、AI のタブは無し', await until(() => r.relay.view.current('one') === null && r.relay.view.shown('one') === null), String(r.relay.view.shown('one')));
    } finally { a?.close(); await r.stop(); }
  }

  // ===== 2. サーバー: AI のタブの映像への入力は引き継ぐまで断る =====
  {
    let clock = 1, tabListener, aiTab = 'T'; const calls = [];
    const holder = createTabHolder({ now: () => clock, emit: (type, payload) => tabListener?.(type, payload) });
    const relay = { unify: { tabHolder: holder }, onTabEvent(fn) { tabListener = fn; return () => { tabListener = null; }; } };
    const host = { onChange() { return () => {}; }, summary: () => ({ tabs: 1, operating: true }), tabs: () => [{ targetId: 'T', windowId: 1 }], current: () => aiTab, focus: async () => {},
      async attach() {
        return { async send(method, params) { calls.push({ method, params }); if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }; if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } }; return { result: { value: true } }; }, detach: async () => {} };
      } };
    const bridge = createChromeScreencast({ host, relay }), hub = createScreencastHub({ bridge, source: 'chrome' });
    const pc = { send() {} };
    const cmd = input => screencastCommand({ command: 'browserScreencastInput', args: { source: 'chrome', sessionId: 's', tabId: 'T', input }, chrome: { hub, bridge }, client: pc });
    const mouse = () => calls.filter(call => call.method === 'Input.dispatchMouseEvent');
    try {
      await hub.watch(pc, 's', { width: 560, height: 700 });
      const tap = await cmd({ type: 'tap', x: 30, y: 40 });
      t.ok('引き継ぐ前の AI のタブへの入力は view-only で断る', tap.ok === false && tap.code === 'view-only', JSON.stringify(tap));
      t.ok('断った入力はページへ送らず、人の操作にも数えない', mouse().length === 0 && holder.holder('s', 'T').holder === 'ai', JSON.stringify(holder.holder('s', 'T')));
      const key = await cmd({ type: 'text', text: 'x' });
      t.ok('文字・キーも同じく断る', key.ok === false && key.code === 'view-only' && !calls.some(call => /^Input\./.test(call.method)));
      const cursor = await cmd({ type: 'cursor', x: 3, y: 4 });
      t.ok('カーソルの問い合わせ（読むだけ）は断らない', cursor.code !== 'view-only', JSON.stringify(cursor));
      holder.touch({ sessionId: 's', targetId: 'T', by: 'pc' });   // [引き継ぐ]（chromeTakeOver by: screen）が行うのと同じ持ち手の触り
      const after = await cmd({ type: 'tap', x: 30, y: 40 });
      t.ok('引き継いだあとは入力が通り、ページへ届く', after.ok === true && mouse().some(call => call.params.type === 'mouseReleased'), JSON.stringify(after));
      clock += HUMAN_TIMEOUT_MS + 1;
      holder.gate({ sessionId: 's', targetId: 'T', method: 'Input.dispatchMouseEvent', paused: null });   // 60 秒で AI へ戻す（門が戻す）
      const before = mouse().length;
      const back = await cmd({ type: 'tap', x: 1, y: 1 });
      t.ok('60 秒で AI に戻ったあとは、また見るだけ', back.ok === false && back.code === 'view-only' && mouse().length === before, JSON.stringify(back));
      aiTab = null;   // 人が開いたタブ（AI のタブではない）
      holder.release('s', 'T');
      const human = await cmd({ type: 'tap', x: 30, y: 40 });
      t.ok('人が開いたタブ（AI のタブでない）は、今までどおり引き継がずに触れて人の操作になる', human.ok === true && holder.holder('s', 'T').holder === 'human', JSON.stringify(human));
    } finally { hub.closeAll?.(); bridge.close?.(); }
  }

  // ===== 3. 画面の部品: 行 =====
  const oldDoc = globalThis.document, oldWindow = globalThis.window;
  const doc = new N('document'); Object.assign(doc, { createElement: tag => new N(tag), createElementNS: (_ns, tag) => new N(tag), getElementById: () => null, head: new N('head'), body: new N('body') });
  globalThis.document = doc; globalThis.window = new N('window');
  try {
    const taken = [], resumed = [];
    const badge = createControlBadge({ mount: new N('div'), onTakeOver: () => taken.push(1), onResume: () => resumed.push(1) });
    badge.update({ visible: true, mode: 'ai', name: 'Claude' });
    t.ok('AI のタブを見ている間の行: 「Claude が Chrome を操作中」と [引き継ぐ]', badge.element.hidden === false && badge.button.textContent === '引き継ぐ' && /Claude/.test(badge.element.textContent) && badge.element.getAttribute('role') === 'status' && badge.element.dataset.mode === 'ai', badge.element.outerHTML);
    badge.button.onclick();
    t.ok('[引き継ぐ] は onTakeOver を呼ぶ（AI に戻すは呼ばない）', taken.length === 1 && resumed.length === 0);
    await sleep(0);
    badge.update({ visible: true, mode: 'human' });
    t.ok('引き継ぐと行は「あなたが操作中 [AI に戻す]」になる（同じ行・名前の字は変わる）', badge.button.textContent === 'AI に戻す' && badge.element.dataset.mode === 'human' && /あなたが操作中/.test(badge.element.textContent), badge.element.outerHTML);
    badge.update({ visible: true, mode: 'ai', name: 'Claude' });
    badge.nudge();
    t.ok('見るだけの映像に触れると [引き継ぐ] を強調する（nudge）', badge.button.classList.contains('nudge'));
    badge.update({ visible: true, mode: 'human' });
    badge.nudge();
    t.ok('人が操作中の行は強調しない', !badge.button.classList.contains('nudge'));
    badge.destroy();

    // ===== 4. 画面の部品: 映像の封じ =====
    const listeners = new Map();
    const surface = new N('div'); surface.addEventListener = (type, fn) => { listeners.set(type, fn); };
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 });
    const img = new N('img');
    const sent = []; let view = true, blocked = 0;
    const input = createScreencastInput({ surface, img, getFrame: () => ({ width: 400, height: 300 }), send: value => { sent.push(value); return Promise.resolve({}); }, viewOnly: () => view, onBlocked: () => { blocked++; } });
    const keydown = listeners.get('keydown');
    if (keydown) {
      const ev = { key: 'a', target: surface, preventDefault() { this.prevented = true; }, altKey: false, ctrlKey: false, metaKey: false, isComposing: false };
      keydown(ev);
      t.ok('見るだけの間のキーはページへ送らず、触れたことだけ知らせる', sent.length === 0 && blocked === 1 && ev.prevented === true, JSON.stringify({ sent, blocked }));
      const tab = { key: 'Tab', target: surface, preventDefault() { this.prevented = true; }, altKey: false, ctrlKey: false, metaKey: false, isComposing: false };
      keydown(tab);
      t.ok('Tab は奪わない（[引き継ぐ] へ移れる）', !tab.prevented && blocked === 1);
      view = false;
      const ev2 = { key: 'a', target: surface, preventDefault() { this.prevented = true; }, altKey: false, ctrlKey: false, metaKey: false, isComposing: false };
      keydown(ev2);
      await sleep(0);
      t.ok('引き継いだあと（見るだけでない）のキーはページへ送る', sent.some(value => value.type === 'text' || value.type === 'key'), JSON.stringify(sent));
    } else t.ok('keydown の窓口がある', false, [...listeners.keys()].join());
    input.destroy?.();
  } finally { globalThis.document = oldDoc; globalThis.window = oldWindow; }
}
