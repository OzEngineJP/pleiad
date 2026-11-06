// タブごとの持ち手（core/chrome/tab-holder.mjs、ADR 0296 の 1）と、中継の門への効き方（偽の Chrome）。
//   - 人がタブを触るとそのタブは人の操作: 読むだけのコマンド（HUMAN_TAB_READS）のほかは HUMAN_MESSAGE で断る。ほかのタブは通る
//   - 最後に触ってから 60 秒で AI に戻す。hand_to_user の間と「PC で操作する」（pinned）の間は戻さない
//   - 戻した直後の最初の操作のコマンドは 1 回だけ RESNAPSHOT_MESSAGE で断る（snapshot の撮り直し）
//   - 「任せる」（releaseAll）・「止める」（entry.paused）との重なり
import { agent, rig } from '../lib/chrome-relay-rig.mjs';
import { createTabHolder, PAUSED_MESSAGE, HUMAN_MESSAGE, RESNAPSHOT_MESSAGE } from '../../core/chrome/tab-holder.mjs';

export const name = 'chrome-tab-holder';
export const title = 'タブごとの持ち手（ADR 0296 の 1）: 人の操作・60 秒・戻した後の 1 回の断り・hand_to_user の間は戻さない・止めるとの重なり（偽の時計・偽の Chrome）';

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
  // ===== 1. 持ち手の記録・門・60 秒・戻した後の 1 回の断り（偽の時計） =====
  {
    let clock = 1_000_000;
    const events = [];
    const holder = createTabHolder({ now: () => clock, emit: (type, payload) => events.push([type, payload]) });
    const gate = (targetId, paused = null) => holder.gate({ sessionId: 'one', targetId, method: 'Input.dispatchMouseEvent', paused });

    t.ok('触る前は AI の操作が通る', gate('t1') === null);
    holder.touch({ sessionId: 'one', targetId: 't1', by: 'device' });
    t.ok('触ったタブは人の操作。操作のコマンドは「人がこのタブを操作しています」で断る', gate('t1') === HUMAN_MESSAGE && /人がこのタブを操作しています/.test(HUMAN_MESSAGE) && /person is operating this tab/i.test(HUMAN_MESSAGE));
    t.ok('ほかのタブの操作は通る（同じウィンドウでエージェントは続けられる）', gate('t2') === null);
    t.ok('持ち手が human になったことを tab:holder で知らせる（by・since・last）', events.at(-1)?.[0] === 'tab:holder' && events.at(-1)?.[1].holder === 'human' && events.at(-1)?.[1].by === 'device' && events.at(-1)?.[1].since === clock, JSON.stringify(events));
    t.ok('held・holder で今の持ち手を読める', holder.held('one').length === 1 && holder.holder('one', 't1').holder === 'human' && holder.holder('one', 't2').holder === 'ai');

    clock += 30_000;
    holder.touch({ sessionId: 'one', targetId: 't1' });   // 触り続けると期限が延びる
    clock += 45_000;
    t.ok('最後に触ってから 60 秒未満は人の操作のまま', gate('t1') === HUMAN_MESSAGE);
    clock += 15_001;
    t.ok('最後に触ってから 60 秒で AI に戻す（最初の操作のコマンドは撮り直しを求めて 1 回だけ断る）', gate('t1') === RESNAPSHOT_MESSAGE && /snapshot を撮り直してから/.test(RESNAPSHOT_MESSAGE));
    t.ok('2 回目以降は通る・戻したことを tab:holder で知らせる', gate('t1') === null && events.at(-1)?.[1].holder === 'ai', JSON.stringify(events.slice(-3)));

    holder.touch({ sessionId: 'one', targetId: 't2' });
    t.ok('会話の一時停止（止める）は持ち手に関係なく全部断る', gate('t2', { at: 1 }) === PAUSED_MESSAGE && gate('t1', { at: 1 }) === PAUSED_MESSAGE);

    // 「任せる」
    holder.touch({ sessionId: 'one', targetId: 't2' });
    holder.releaseAll('one');
    t.ok('「任せる」は人の操作のタブを全部 AI に戻し、戻した後の最初の操作を 1 回だけ断る', gate('t2') === RESNAPSHOT_MESSAGE && gate('t2') === null && holder.held('one').length === 0);

    // 「PC で操作する」は時間で戻さない
    holder.holdByPc({ sessionId: 'one', targetId: 't3' });
    clock += 120_000;
    t.ok('「PC で操作する」（pinned）は 60 秒を過ぎても戻さない', gate('t3') === HUMAN_MESSAGE && holder.holder('one', 't3').pinned === true);
    holder.release('one', 't3');
    t.ok('窓を画面の外へ戻したら AI に戻る（戻した後の 1 回の断り）', gate('t3') === RESNAPSHOT_MESSAGE && gate('t3') === null);

    // hand_to_user の間は戻さない
    let askingNow = true;
    const h2 = createTabHolder({ now: () => clock });
    h2.attach({ handoffs: { current: id => (id === 'one' && askingNow ? { reason: 'login' } : null) } });
    h2.touch({ sessionId: 'one', targetId: 't1' });
    clock += 120_000;
    t.ok('hand_to_user の頼みの最中は 60 秒を過ぎても戻さない', h2.gate({ sessionId: 'one', targetId: 't1', method: 'Input.', paused: null }) === HUMAN_MESSAGE);
    askingNow = false;
    t.ok('頼みが終わると期限どおりに戻す（戻した後の 1 回の断り）', h2.gate({ sessionId: 'one', targetId: 't1', method: 'Input.', paused: null }) === RESNAPSHOT_MESSAGE && h2.gate({ sessionId: 'one', targetId: 't1', method: 'x', paused: null }) === null);

    // forget・rebind
    h2.touch({ sessionId: 'one', targetId: 't9' });
    h2.forget({ sessionId: 'one', targetId: 't9' });
    t.ok('タブが無くなったら持ち手を捨てる', h2.holder('one', 't9').holder === 'ai' && h2.gate({ sessionId: 'one', targetId: 't9', method: 'x', paused: null }) === null);
    h2.touch({ sessionId: 'one', targetId: 't8' });
    h2.rebind('one', 'two');
    t.ok('会話の id が替わっても持ち手が付いて回る', h2.holder('two', 't8').holder === 'human' && h2.gate({ sessionId: 'two', targetId: 't8', method: 'x', paused: null }) === HUMAN_MESSAGE);
  }

  // ===== 2. 期限の見張り（実時間。短い timeoutMs） =====
  {
    const events = [];
    const holder = createTabHolder({ timeoutMs: 60, emit: (type, payload) => events.push([type, payload]) });
    holder.touch({ sessionId: 'one', targetId: 't1' });
    t.ok('実時間の見張りでも期限で AI に戻す（tab:holder が届く）', await until(() => events.some(e => e[1].holder === 'ai'), 1500));
  }

  // ===== 3. 偽の中継: 人の操作のタブへのエージェントの操作が断られ、文が届く =====
  {
    const r = await rig();
    let a;
    try {
      const events = [];
      r.relay.onTabEvent((type, payload) => events.push([type, payload]));
      a = await agent(await r.relay.endpoint('one'));
      const t1 = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const t2 = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const s1 = (await a.cmd('Target.attachToTarget', { targetId: t1, flatten: true })).result.sessionId;
      const s2 = (await a.cmd('Target.attachToTarget', { targetId: t2, flatten: true })).result.sessionId;

      r.relay.unify.tabHolder.touch({ sessionId: 'one', targetId: t1, by: 'device' });
      const held = await a.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }, s1);
      t.ok('人の操作のタブへの Input.dispatchMouseEvent は上りへ送らず「人がこのタブを操作しています」が返る', held.error?.message === HUMAN_MESSAGE && !r.chrome.calls.some(c => c.method === 'Input.dispatchMouseEvent'), JSON.stringify(held));
      t.ok('読むコマンドは通る（snapshot など）', !(await a.cmd('Accessibility.getFullAXTree', {}, s1)).error);
      const reads = await Promise.all(['Page.captureScreenshot', 'DOM.getDocument', 'Page.enable', 'Runtime.enable', 'Fetch.disable', 'Runtime.runIfWaitingForDebugger'].map(m => a.cmd(m, {}, s1)));
      t.ok('通してよい一覧（screenshot・DOM を読む・購読・自動 attach の続き）は通る', reads.every(m => !m.error), JSON.stringify(reads.filter(m => m.error)));
      // 一覧の外は全部断る（2026-11-06 に本物の Chrome で、断る一覧の門をすり抜けてページにコードを動かさせた道を含む）
      const writes = [
        ['Runtime.evaluate', { expression: '1' }], ['Runtime.callFunctionOn', { functionDeclaration: 'function(){}' }],
        ['Runtime.compileScript', { expression: '1', sourceURL: '', persistScript: true }], ['Runtime.runScript', { scriptId: '1' }],
        ['DOM.setOuterHTML', { nodeId: 1, outerHTML: '<img src=x onerror=1>' }], ['DOM.setAttributeValue', { nodeId: 1, name: 'onclick', value: '1' }],
        ['Page.addScriptToEvaluateOnNewDocument', { source: '1', runImmediately: true }], ['Page.navigate', { url: 'about:blank' }],
        ['Fetch.enable', {}], ['Debugger.enable', {}], ['Emulation.setDeviceMetricsOverride', { width: 1, height: 1, deviceScaleFactor: 1, mobile: false }],
        ['Network.getCookies', {}], ['Runtime.addBinding', { name: 'other' }],
      ];
      const before = r.chrome.calls.length;
      const refused = await Promise.all(writes.map(([m, p]) => a.cmd(m, p, s1)));
      t.ok('一覧の外（evaluate・callFunctionOn・compileScript・runScript・setOuterHTML・addScriptToEvaluateOnNewDocument など）は上りへ送らず断る',
        refused.every(m => m.error?.message === HUMAN_MESSAGE) && !r.chrome.calls.slice(before).some(c => writes.some(([m]) => m === c.method)),
        JSON.stringify(refused.map((m, i) => [writes[i][0], m.error?.message?.slice(0, 20) ?? 'passed']).filter(([, m]) => m !== HUMAN_MESSAGE.slice(0, 20))));
      t.ok('人の操作のタブは閉じさせない', (await a.cmd('Target.closeTarget', { targetId: t1 })).error?.message === HUMAN_MESSAGE);
      t.ok('ほかのタブへの操作は通る', !(await a.cmd('Runtime.evaluate', { expression: '1' }, s2)).error);
      const binding = await Promise.all([a.cmd('Runtime.addBinding', { name: 'plyPage' }, s2), a.cmd('Runtime.addBinding', { name: 'plyInput', executionContextName: 'ply-input' }, s2), a.cmd('Runtime.removeBinding', { name: 'plyPage' }, s2)]);
      t.ok('中継の口の binding（plyPage・plyInput）は、AI の操作のタブでもエージェントに足させない・外させない', binding.every(m => /binding denied/.test(m.error?.message ?? '')), JSON.stringify(binding));
      t.ok('ほかの名前の binding は AI の操作のタブで足せる', !(await a.cmd('Runtime.addBinding', { name: 'mine' }, s2)).error);
      t.ok('tab:holder の出来事が届く', events.some(e => e[0] === 'tab:holder' && e[1].targetId === t1 && e[1].holder === 'human'));

      r.relay.unify.tabHolder.releaseAll('one');
      const first = await a.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 }, s1);
      t.ok('戻した直後の最初の操作は撮り直しを求めて 1 回だけ断る', first.error?.message === RESNAPSHOT_MESSAGE);
      t.ok('次からは通る', !(await a.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 }, s1)).error);
      r.relay.unify.tabHolder.touch({ sessionId: 'one', targetId: t1 });
      r.relay.unify.tabHolder.release('one', t1);
      t.ok('戻した直後でも、撮り直しの読むコマンドは断らない（1 回の断りは操作のときだけ）', !(await a.cmd('Accessibility.getFullAXTree', {}, s1)).error
        && (await a.cmd('Runtime.evaluate', { expression: '1' }, s1)).error?.message === RESNAPSHOT_MESSAGE);
    } finally {
      a?.close();
      await r.stop();
    }
  }

  // ===== 4. 「止める」（entry.paused）は持ち手に関係なく全部断る（偽の中継） =====
  {
    const r = await rig();
    let a;
    try {
      a = await agent(await r.relay.endpoint('one'));
      const t1 = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const s1 = (await a.cmd('Target.attachToTarget', { targetId: t1, flatten: true })).result.sessionId;
      r.relay.unify.tabHolder.touch({ sessionId: 'one', targetId: t1 });
      r.relay.pause('one', 1);
      await a.closed;
      t.ok('止めている間はエージェントの接続を切る（一時停止が持ち手に優先）', true);
      const b = await agent(await r.relay.endpoint('one'));
      const every = await Promise.all([b.cmd('Browser.getVersion'), b.cmd('Target.getTargets'), b.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }, s1)]);
      t.ok('つなぎ直した接続のコマンドは全部 PAUSED_MESSAGE で断る', every.every(m => m.error?.message === PAUSED_MESSAGE));
      b.close();
    } finally {
      a?.close();
      await r.stop();
    }
  }
}
