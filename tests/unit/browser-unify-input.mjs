import { createChromeScreencast } from '../../core/chrome/screencast.mjs';
import { createScreencastHub, screencastCommand } from '../../core/browser-screencast.mjs';
import { createTabHolder, HUMAN_TIMEOUT_MS } from '../../core/chrome/tab-holder.mjs';
export const name = 'browser-unify-input';
export const title = '映像の入力の配線: PC とスマホ・接続ごとの届け先・タブの照合・60 秒で戻る・ページの大きさ';
export default async function (t) {
  let clock = 1, tabListener, blockTap = false, unblock; const calls = [], events = [];
  const holder = createTabHolder({ now: () => clock, emit: (type, payload) => tabListener?.(type, payload) });
  const relay = { unify: { tabHolder: holder }, onTabEvent(fn) { tabListener = fn; return () => { tabListener = null; }; } };
  const host = { onChange() { return () => {}; }, summary: () => ({ tabs: 1, operating: true }), tabs: () => [{ targetId: 'T', windowId: 1 }], current: () => 'T', focus: async () => {},
    async attach(sid, tid, event) {
      events.push(event);
      return { async send(method, params) { calls.push({ method, params });
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && blockTap) { events.at(-1)('Page.javascriptDialogOpening', { type: 'confirm', message: 'confirm' }); return new Promise(resolve => { unblock = resolve; }); }
        if (method === 'Page.handleJavaScriptDialog') { unblock?.({}); unblock = null; }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
        return { result: { value: true } };
      }, detach: async () => {} };
    } };
  const bridge = createChromeScreencast({ host, relay }), hub = createScreencastHub({ bridge, source: 'chrome' });
  const messages = [], phoneMessages = [], pc = { send: message => messages.push(message) }, phone = { send: message => phoneMessages.push(message) };
  const cmd = (client, input, tabId = 'T') => screencastCommand({ command: 'browserScreencastInput', args: { source: 'chrome', sessionId: 's', tabId, input }, chrome: { hub, bridge }, client });
  const metrics = () => calls.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').at(-1)?.params;
  try {
    await hub.watch(pc, 's', { width: 560, height: 700 });
    t.ok('PC の欄を開くと欄の幅で描く', metrics().width === 560 && !metrics().mobile);
    const result = await cmd(pc, { type: 'tap', x: 30, y: 40 });
    t.ok('PC の映像からクリックし、人の操作になる', result.ok && holder.holder('s', 'T').holder === 'human' && calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseReleased'));
    t.ok('見ていない接続の入力を断る', (await cmd({ send() {} }, { type: 'text', text: 'bad' })).code === 'not-watching');
    const before = calls.length;
    t.ok('違うタブから遅れて来た入力を断る', (await cmd(pc, { type: 'text', text: 'bad' }, 'old')).code === 'no-tab' && calls.length === before);
    await hub.watch(phone, 's', { device: 'phone', width: 360, height: 640, scale: 2 });
    await cmd(phone, { type: 'text', text: '日本語' }, 'T');
    t.ok('スマホで触った後はスマホの幅を優先', metrics().width === 360 && metrics().mobile && metrics().deviceScaleFactor === 2);
    await hub.watch(phone, 's', { device: 'phone', width: 360, height: 300, scale: 2 });
    await cmd(phone, { type: 'tap', x: 10, y: 20 }, 'T');
    await hub.watch(phone, 's', { device: 'phone', width: 360, height: 640, scale: 2 });
    t.ok('キーボードを開いて触った後に閉じたら、触らなくてもスマホの今の高さへ戻す', metrics().width === 360 && metrics().height === 640);
    events.at(-1)('Page.javascriptDialogOpening', { type: 'confirm', message: '続ける？' });
    t.ok('シートは最後に入力した接続だけへ送る', phoneMessages.some(message => message.interaction?.type === 'dialog') && !messages.some(message => message.interaction?.type === 'dialog'));
    blockTap = true;
    const opening = cmd(phone, { type: 'tap', x: 10, y: 20 });
    while (!unblock) await new Promise(resolve => setImmediate(resolve));
    let timer;
    const answered = await Promise.race([cmd(phone, { type: 'dialog', accept: true }), new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false }), 500); })]);
    clearTimeout(timer); unblock?.({}); blockTap = false; await opening;
    t.ok('ダイアログを開いたクリックの応答待ち中にもシートで返答できる', answered.ok);
    events.at(-1)('Page.javascriptDialogClosed', {});
    events.at(-1)('Page.javascriptDialogOpening', { type: 'confirm', message: 'handover' });
    await hub.unwatch(phone, 's');
    t.ok('返答する端末が切れたら残る端末へダイアログを渡す', messages.some(message => message.interaction?.message === 'handover'));
    await cmd(pc, { type: 'dialog', accept: false });
    events.at(-1)('Page.javascriptDialogClosed', {});
    await hub.watch(phone, 's', { device: 'phone', width: 360, height: 640, scale: 2 });
    clock += HUMAN_TIMEOUT_MS + 1; holder.gate({ sessionId: 's', targetId: 'T', method: 'Runtime.evaluate' });
    await bridge.setViewers('s', [{ device: 'pc', box: { width: 560, height: 700 } }]);
    t.ok('60 秒で戻り PC の欄の幅へ戻す', holder.holder('s', 'T').holder === 'ai' && metrics().width === 560 && !metrics().mobile);
    await hub.unwatch(pc, 's'); await bridge.setViewers('s', [{ device: 'phone', box: { width: 360, height: 640 } }]);
    t.ok('スマホで見ているだけなら幅 800 で高さを伸ばす', metrics().width === 800 && metrics().height === Math.round(800 * 640 / 360));
    await bridge.setViewers('s', []);
    t.ok('見る側が無ければ 800 × 800', metrics().width === 800 && metrics().height === 800);
    blockTap = true;
    const interrupted = cmd(phone, { type: 'tap', x: 10, y: 20 });
    while (!unblock) await new Promise(resolve => setImmediate(resolve));
    const stopped = await Promise.race([hub.unwatch(phone, 's').then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
    clearTimeout(timer); unblock?.({}); blockTap = false; await interrupted;
    t.ok('ダイアログ中に最後の端末を閉じても撮影の停止が詰まらない', stopped);
  } finally { await hub.unwatch(pc, 's'); await hub.unwatch(phone, 's'); bridge.close(); holder.forget({ sessionId: 's' }); }
}
