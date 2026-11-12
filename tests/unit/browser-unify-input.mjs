import { createChromeScreencast } from '../../core/chrome/screencast.mjs';
import { createScreencastHub, screencastCommand } from '../../core/browser-screencast.mjs';
import { createTabHolder, HUMAN_TIMEOUT_MS } from '../../core/chrome/tab-holder.mjs';
export const name = 'browser-unify-input';
export const title = '映像の入力の配線: PC とスマホ・接続ごとの届け先・タブの照合・60 秒で戻る・ページの大きさは見る・操作するのどれでも変えない・座標はフレームの metadata で止める';
export default async function (t) {
  let clock = 1, tabListener, blockTap = false, unblock, inputEvent, frameEvent; const calls = [];
  const holder = createTabHolder({ now: () => clock, emit: (type, payload) => tabListener?.(type, payload) });
  const relay = { unify: { tabHolder: holder }, onTabEvent(fn) { tabListener = fn; return () => { tabListener = null; }; } };
  const host = { onChange() { return () => {}; }, summary: () => ({ tabs: 1, operating: true }), tabs: () => [{ targetId: 'T', windowId: 1 }], current: () => null, focus: async () => {},
    async attach(sid, tid, event) {
      return { async send(method, params) { calls.push({ method, params });
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && blockTap) { event('Page.javascriptDialogOpening', { type: 'confirm', message: 'confirm' }); return new Promise(resolve => { unblock = resolve; }); }
        if (method === 'Page.handleJavaScriptDialog') { unblock?.({}); unblock = null; }
        if (method === 'Page.getFrameTree') { inputEvent = event; return { frameTree: { frame: { id: 'F' } } }; }
        if (method === 'Page.startScreencast') { frameEvent = event; return {}; }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
        return { result: { value: true } };
      }, detach: async () => { calls.push({ method: '__detach' }); } };
    } };
  const bridge = createChromeScreencast({ host, relay }), hub = createScreencastHub({ bridge, source: 'chrome' });
  const messages = [], phoneMessages = [], pc = { send: message => messages.push(message) }, phone = { send: message => phoneMessages.push(message) };
  const cmd = (client, input, tabId = 'T') => screencastCommand({ command: 'browserScreencastInput', args: { source: 'chrome', sessionId: 's', tabId, input }, chrome: { hub, bridge }, client });
  // ページの大きさを触る呼び出し（override・戻す口・窓の大きさ）
  const sizeCalls = mark => calls.slice(mark ?? 0).filter(call => /^(Emulation\.(set|clear)DeviceMetricsOverride|Browser\.setContentsSize)$/.test(call.method));
  const mouse = name => calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === name).at(-1)?.params;
  try {
    await hub.watch(pc, 's', { width: 560, height: 700 });
    t.ok('PC の欄を開いてもページの大きさを変えない', sizeCalls().length === 0, JSON.stringify(sizeCalls()));
    const result = await cmd(pc, { type: 'tap', x: 30, y: 40 });
    t.ok('PC の映像からクリックし、人の操作になる', result.ok && holder.holder('s', 'T').holder === 'human' && calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseReleased'));
    t.ok('PC の映像からの操作でもページの大きさを変えない', sizeCalls().length === 0, JSON.stringify(sizeCalls()));
    t.ok('見ていない接続の入力を断る', (await cmd({ send() {} }, { type: 'text', text: 'bad' })).code === 'not-watching');
    const before = calls.length;
    t.ok('違うタブから遅れて来た入力を断る', (await cmd(pc, { type: 'text', text: 'bad' }, 'old')).code === 'no-tab' && calls.length === before);

    // 届いたフレームの metadata が座標の元: ページの大きさが 390×700 のフレームなら、タップのはみ出しはその大きさで止める
    frameEvent('Page.screencastFrame', { sessionId: 1, data: 'AAAA', metadata: { deviceWidth: 390, deviceHeight: 700, pageScaleFactor: 1 } });
    await cmd(pc, { type: 'tap', x: 5000, y: 5000 });
    t.ok('はみ出した点は届いたフレームのページの大きさで止める', mouse('mousePressed').x === 390 && mouse('mousePressed').y === 700, JSON.stringify(mouse('mousePressed')));

    await hub.watch(phone, 's', { device: 'phone', width: 360, height: 640, scale: 2 });
    t.ok('スマホが見るだけでもページの大きさを変えない', sizeCalls().length === 0, JSON.stringify(sizeCalls()));
    await cmd(phone, { type: 'text', text: '日本語' }, 'T');
    t.ok('スマホで操作してもページの大きさを変えない（実ページをそのまま操作する）', holder.holder('s', 'T').by === 'device' && sizeCalls().length === 0, JSON.stringify(sizeCalls()));
    const typingMark = calls.length;
    await hub.watch(phone, 's', { device: 'phone', width: 360, height: 300, scale: 2 });
    await hub.watch(phone, 's', { device: 'phone', width: 360, height: 640, scale: 2 });
    t.ok('スマホの箱が替わっても（キーボードの開閉）ページの大きさを変えない', sizeCalls(typingMark).length === 0, JSON.stringify(sizeCalls(typingMark)));
    inputEvent('Page.javascriptDialogOpening', { type: 'confirm', message: '続ける？' });
    t.ok('シートは最後に入力した接続だけへ送る', phoneMessages.some(message => message.interaction?.type === 'dialog') && !messages.some(message => message.interaction?.type === 'dialog'));
    blockTap = true;
    const opening = cmd(phone, { type: 'tap', x: 10, y: 20 });
    while (!unblock) await new Promise(resolve => setImmediate(resolve));
    let timer;
    const answered = await Promise.race([cmd(phone, { type: 'dialog', accept: true }), new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false }), 500); })]);
    clearTimeout(timer); unblock?.({}); blockTap = false; await opening;
    t.ok('ダイアログを開いたクリックの応答待ち中にもシートで返答できる', answered.ok);
    inputEvent('Page.javascriptDialogClosed', {});
    inputEvent('Page.javascriptDialogOpening', { type: 'confirm', message: 'handover' });
    await hub.unwatch(phone, 's');
    t.ok('返答する端末が切れたら残る端末へダイアログを渡す', messages.some(message => message.interaction?.message === 'handover'));
    await cmd(pc, { type: 'dialog', accept: false });
    inputEvent('Page.javascriptDialogClosed', {});

    // AI へ戻す（60 秒）。返却で大きさを触る呼び出しは無い（既定に押し戻さない・override も戻す口も窓の大きさも触らない）
    await hub.watch(phone, 's', { device: 'phone', width: 360, height: 640, scale: 2 });
    clock += HUMAN_TIMEOUT_MS + 1;
    const mark = calls.length;
    holder.gate({ sessionId: 's', targetId: 'T', method: 'Runtime.evaluate' });
    await hub.watch(pc, 's', { width: 560, height: 700 });   // PC の欄のリサイズ
    t.ok('60 秒で AI に戻る。返却・PC の欄のリサイズでページの大きさを触らない', holder.holder('s', 'T').holder === 'ai' && sizeCalls(mark).length === 0, JSON.stringify(sizeCalls(mark)));
    await hub.unwatch(pc, 's'); await hub.watch(phone, 's', { device: 'phone', width: 360, height: 640, scale: 2 });
    t.ok('見る側が PC からスマホに替わってもページの大きさを変えない', sizeCalls(mark).length === 0, JSON.stringify(sizeCalls(mark)));
    blockTap = true;
    const interrupted = cmd(phone, { type: 'tap', x: 10, y: 20 });
    while (!unblock) await new Promise(resolve => setImmediate(resolve));
    const mark3 = calls.length;
    const stopped = await Promise.race([hub.unwatch(phone, 's').then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
    clearTimeout(timer); unblock?.({}); blockTap = false; await interrupted;
    t.ok('ダイアログ中に最後の端末を閉じても撮影の停止が詰まらない', stopped);
    t.ok('最後の端末を閉じてもページの大きさを触らない（セッションを外すだけ）', sizeCalls(mark3).length === 0, JSON.stringify(sizeCalls(mark3)));
  } finally { await hub.unwatch(pc, 's'); await hub.unwatch(phone, 's'); bridge.close(); holder.forget({ sessionId: 's' }); }

  // ---- AI のタブ（host.current）は引き継ぐまで見るだけ（ADR 0321）: 画面の封じが抜けても、サーバーが入力を断る
  {
    const calls = []; let dialogEvent, hold = null, release = null;
    const holder = createTabHolder();
    const relay = { unify: { tabHolder: holder }, onTabEvent() { return () => {}; } };
    const host = { onChange() { return () => {}; }, summary: () => ({ tabs: 1, operating: true }), tabs: () => [{ targetId: 'A', windowId: 1 }], current: () => 'A', focus: async () => {},
      async attach(sid, tid, event) {
        return { async send(method, params) { calls.push({ method, params });
          if (method === 'Page.getFrameTree') { dialogEvent = event; return { frameTree: { frame: { id: 'F' } } }; }
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
          if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && hold) { const wait = hold; hold = null; await wait; }
          return { result: { value: { text: '選択', editable: true, link: 'https://a/b', cursor: 'pointer' } } };
        }, detach: async () => {} };
      } };
    const bridge = createChromeScreencast({ host, relay }), hub = createScreencastHub({ bridge, source: 'chrome' });
    const pc = { send() {} }, phone = { send() {} };
    const ask = (client, input) => screencastCommand({ command: 'browserScreencastInput', args: { source: 'chrome', sessionId: 's', tabId: 'A', input }, chrome: { hub, bridge }, client });
    const sentInput = mark => calls.slice(mark).filter(call => /^Input\./.test(call.method) || call.method === 'Page.handleJavaScriptDialog' || /selection\(\)|inspect\(/.test(call.params?.expression ?? ''));
    const holderOf = () => holder.holder('s', 'A')?.holder ?? 'ai';
    try {
      await hub.watch(pc, 's', { width: 560, height: 700 });
      await hub.watch(phone, 's', { device: 'phone', width: 360, height: 640, scale: 2 });
      for (const [client, input] of [[pc, { type: 'tap', x: 30, y: 40 }], [phone, { type: 'tap', x: 30, y: 40 }], [pc, { type: 'text', text: 'あ' }], [pc, { type: 'key', key: 'Enter' }],
        [pc, { type: 'scroll', x: 1, y: 1, dy: 100 }], [pc, { type: 'drag', phase: 'start', x: 1, y: 1 }], [pc, { type: 'menu', x: 5, y: 6 }], [pc, { type: 'copy' }]]) {
        const mark = calls.length;
        const result = await ask(client, input);
        t.ok(`引き継ぐ前の AI のタブへの ${client === phone ? 'スマホの ' : ''}${input.type} は view-only で断り、ページへ何も送らず、人の操作にもしない`, result.ok === false && result.code === 'view-only' && sentInput(mark).length === 0 && holderOf() === 'ai',
          JSON.stringify({ result, sent: sentInput(mark), holder: holderOf() }));
      }
      const hovered = await ask(pc, { type: 'cursor', x: 30, y: 40 });
      t.ok('引き継ぐ前でも、読むだけのカーソルの問い合わせは通る（人の操作にしない）', hovered.ok && hovered.result?.info?.cursor === 'pointer' && holderOf() === 'ai', JSON.stringify(hovered));
      dialogEvent('Page.javascriptDialogOpening', { type: 'confirm', message: '続ける？' });
      const mark = calls.length;
      const answer = await ask(pc, { type: 'dialog', accept: true });
      t.ok('引き継ぐ前は確認の窓への返答も断る（AI の確認の窓を人が閉じない）', answer.code === 'view-only' && sentInput(mark).length === 0 && holderOf() === 'ai', JSON.stringify({ answer, sent: sentInput(mark) }));

      holder.touch({ sessionId: 's', targetId: 'A', by: 'device' });   // [引き継ぐ]（chromeTakeOver の takeOverTab と同じ印）
      const accepted = await ask(pc, { type: 'dialog', accept: true });
      t.ok('引き継いだ後は確認の窓へ返答できる', accepted.ok && calls.some(call => call.method === 'Page.handleJavaScriptDialog' && call.params.accept === true));
      dialogEvent('Page.javascriptDialogClosed', {});
      const before = calls.length;
      const tapped = await ask(phone, { type: 'tap', x: 30, y: 40 });
      t.ok('引き継いだ後はタップがページへ届く', tapped.ok && calls.slice(before).some(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseReleased'), JSON.stringify(tapped));

      // 順番待ちの間に AI へ戻った（60 秒・[AI に戻す]）入力は、届けずに断る
      hold = new Promise(resolve => { release = resolve; });
      const first = ask(pc, { type: 'tap', x: 1, y: 1 });
      while (hold) await new Promise(resolve => setImmediate(resolve));
      const second = ask(pc, { type: 'tap', x: 2, y: 2 });
      holder.release('s', 'A');
      const queuedMark = calls.length;
      release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      t.ok('順番待ちの間に AI へ戻った入力は view-only で断り、ページへ送らない', firstResult.ok && secondResult.code === 'view-only' && sentInput(queuedMark).every(call => call.params.x !== 2),
        JSON.stringify({ firstResult, secondResult, sent: sentInput(queuedMark) }));
      const after = await ask(pc, { type: 'text', text: 'い' });
      t.ok('AI へ戻した後は、また見るだけ', after.code === 'view-only' && holderOf() === 'ai');
    } finally { release?.(); await hub.unwatch(pc, 's'); await hub.unwatch(phone, 's'); bridge.close(); holder.forget({ sessionId: 's' }); }
  }
}
