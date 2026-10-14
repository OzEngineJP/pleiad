// リモートの端末から PC の内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートから見る」、ADR 0041）。
//   - worker 側（core/browser-screencast.mjs）: フレームの配り方と間引き（端末の受け取り・最短の間隔）、止める条件、
//     コマンドの断り（ローカルの接続・見ていない接続・エージェントが操作中）
//   - main 側（desktop/browser-screencast.cjs）を偽のパネルで: タブを作る・窓の外に載せる・ビューポート・入力の変換・エージェント
//   - 画面（web/remote-browser.mjs・web/link-sheet.mjs）: 座標の変換とシートの出し分け
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createScreencastHub, screencastCommand, parentPortScreencast, QUALITY } from '../../core/browser-screencast.mjs';
import { COMMANDS, SCREENCAST } from '../../core/protocol.mjs';
import { containRect, toPageCoords, toPageDelta, framesPerSecond, panelStateOf } from '../../web/remote-browser.mjs';
import { linkChoices } from '../../web/link-sheet.mjs';
import { inputCommands } from '../../core/chrome/input.mjs';
import { watchHostOnlyLinks } from '../../web/host-only-links.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { createBrowserScreencast, screencastSettings } = require('../../desktop/browser-screencast.cjs');

export const name = 'remote-browser-view';
export const title = 'リモートから PC の内蔵ブラウザーを見る: 間引き・止める条件・断る条件・入力の変換・シートの出し分け';

/** 手で進める時計とタイマー */
function clock() {
  let time = 1000;
  const timers = new Set();
  return {
    now: () => time,
    setTimer: (fn, ms) => { const timer = { at: time + ms, fn }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer),
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due); time = due.at; due.fn();
      }
      time = end;
    },
  };
}
function fakeBridge() {
  const on = { frame: null, state: null, ended: null };
  const requests = [], acks = [];
  return {
    ready: true, requests, acks,
    request: async (action, sessionId, args) => { requests.push([action, sessionId, args]); return action === 'start' ? { tabId: 't1', state: { url: 'http://localhost:5173/' } } : {}; },
    ack: (sessionId, frameId) => acks.push([sessionId, frameId]),
    onFrame: fn => { on.frame = fn; }, onState: fn => { on.state = fn; }, onEnded: fn => { on.ended = fn; },
    frame: (sessionId, id, data = 'AAAA') => on.frame(sessionId, { id, data, metadata: { deviceWidth: 390, deviceHeight: 700 } }),
    state: (sessionId, state) => on.state(sessionId, state),
    ended: (sessionId, reason) => on.ended(sessionId, reason),
  };
}
const client = () => { const got = []; return { got, send: message => got.push(message) }; };

function fakePanel() {
  let serial = 0;
  const tabs = [], listeners = new Set(), log = { pinned: new Set(), commands: [] };
  function createFor(sessionId, url = '', source = null) {
    const id = `t${++serial}`;
    const dbg = new EventEmitter();
    let attached = false;
    dbg.isAttached = () => attached; dbg.attach = () => { attached = true; };
    dbg.sendCommand = async (method, params) => { log.commands.push([id, method, params]); return {}; };
    const contents = new EventEmitter();
    Object.assign(contents, { debugger: dbg, url, destroyed: false, isDestroyed: () => contents.destroyed, getURL: () => contents.url, getTitle: () => 'page',
      isLoading: () => false, navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: () => log.commands.push([id, 'goBack']), goForward() {} },
      reload: () => log.commands.push([id, 'reload']), stop() {}, loadURL: async next => { contents.url = next; log.commands.push([id, 'loadURL', next]); } });
    const tab = { id, sessionId, source, webContents: contents };
    tabs.push(tab);
    for (const listener of listeners) listener('created', tab);
    return tab;
  }
  const destroy = id => { const index = tabs.findIndex(tab => tab.id === id); const [tab] = tabs.splice(index, 1); tab.webContents.destroyed = true; for (const fn of listeners) fn('destroyed', tab); };
  const stateListeners = new Set();
  return {
    log, createFor, destroy,
    // 同じ会話に同じ file: のタブがあれば作らない（desktop/browser-panel.cjs の openFor）
    openFor: (sessionId, url, source = null) => tabs.find(tab => tab.sessionId === sessionId && tab.webContents.url === url) ?? createFor(sessionId, url, source),
    closeFor: destroy,
    tabsFor: sessionId => tabs.filter(tab => tab.sessionId === sessionId),
    onTabsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    // 止めた外部の読み込みの件数が変わったとき（desktop/browser-panel.cjs の onStateChanged）
    onStateChanged: fn => { stateListeners.add(fn); return () => stateListeners.delete(fn); },
    changed: () => { for (const fn of stateListeners) fn(); },
    // 「読み込む」: 写しのタブは書き直しの指示（source と許す出どころ）を返す。それ以外は null（main が読み直す）
    allowOnceFor: id => { log.commands.push([id, 'allowOnceFor']); const tab = tabs.find(item => item.id === id); return tab?.source?.kind === 'snapshot' ? { source: tab.source, origins: tab.guard?.origins ?? [] } : null; },
    pin: (id, on) => { if (on) log.pinned.add(id); else log.pinned.delete(id); },
  };
}

export default async function (t) {
  // ---- 間引き: 端末が描き終えるまで・最短の間隔までは ack を返さない
  {
    const c = clock(), bridge = fakeBridge();
    const hub = createScreencastHub({ bridge, ...c });
    const phone = client();
    const started = await hub.watch(phone, 's1', { width: 390, height: 700, scale: 3, quality: 'auto' });
    t.ok('見始めると main に start を頼む（端末の倍率は画質の上限で丸める）',
      bridge.requests[0][0] === 'start' && bridge.requests[0][2].options.scale === QUALITY.auto.maxScale && started.tabId === 't1');
    bridge.frame('s1', 7, 'A'.repeat(4000));
    const sent = phone.got.at(-1);
    t.ok('フレームは見ている端末へ WS の screencast で届く', sent.kind === SCREENCAST && sent.type === 'frame' && sent.seq === 1 && sent.metadata.deviceWidth === 390);
    c.advance(1000);
    t.ok('端末が描き終えるまでは次のフレームを許さない', bridge.acks.length === 0);
    hub.received(phone, 's1', 1);
    t.ok('描き終えて最短の間隔（auto は 200ms）が過ぎていれば ack を返す', bridge.acks.length === 1 && bridge.acks[0][1] === 7);
    bridge.frame('s1', 8);
    hub.received(phone, 's1', 2);
    t.ok('すぐに描き終えても最短の間隔までは待つ', bridge.acks.length === 1);
    c.advance(QUALITY.auto.minInterval);
    t.ok('間隔が過ぎたら ack', bridge.acks.length === 2 && bridge.acks[1][1] === 8);
    bridge.frame('s1', 9);
    c.advance(2999);
    t.ok('端末から返事が無くても 3 秒までは待つ', bridge.acks.length === 2);
    c.advance(1);
    t.ok('3 秒で次を許す（返事の落ちた端末で止まらない）', bridge.acks.length === 3);
    const stats = hub.stats('s1');
    t.ok('送った枚数と大きさを数える', stats.frames === 3 && stats.maxBytes === 3000, JSON.stringify(stats));

    // 画質「低」は 500ms
    await hub.watch(phone, 's1', { width: 390, height: 700, quality: 'low' });
    bridge.frame('s1', 10); hub.received(phone, 's1', 4);
    c.advance(QUALITY.low.minInterval - 1);
    const before = bridge.acks.length;
    c.advance(1);
    t.ok('画質「低」は最短 500ms 間隔', bridge.acks.length === before + 1);

    // 2 台目: 片方が描き終えても、もう片方を待つ
    const tablet = client();
    await hub.watch(tablet, 's1', { width: 800, height: 1000 });
    bridge.frame('s1', 11);
    hub.received(phone, 's1', 5); c.advance(600);
    t.ok('見ている端末みなが描き終えるまで待つ', bridge.acks.length === before + 1);
    hub.received(tablet, 's1', 5); c.advance(1);
    t.ok('みなが描き終えたら ack', bridge.acks.length === before + 2);

    // 止める条件
    bridge.requests.length = 0;
    await hub.unwatch(tablet, 's1');
    t.ok('ほかに見ている端末がいれば止めない', !bridge.requests.some(([action]) => action === 'stop'));
    hub.forget(phone);
    await new Promise(resolve => setImmediate(resolve));
    t.ok('見ている端末がいなくなったら止める（接続が切れたときも）', bridge.requests.some(([action, id]) => action === 'stop' && id === 's1') && !hub.watching(phone, 's1'));

    const another = client();
    await hub.watch(another, 's2', {});
    bridge.state('s2', { url: 'https://example.com/', loading: true });
    bridge.ended('s2', 'closed');
    t.ok('状態と終わり（タブが閉じた）を端末へ知らせ、見るのをやめる',
      another.got.some(m => m.type === 'state' && m.state.loading) && another.got.at(-1).type === 'ended' && !hub.watching(another, 's2'));
  }

  // ---- コマンドの断り
  {
    const bridge = fakeBridge();
    const hub = createScreencastHub({ bridge });
    const phone = client();
    const run = (command, args, extra = {}) => screencastCommand({ command, args, local: false, hub, bridge, client: phone, ...extra });
    t.ok('ローカルの接続（ホストの画面）からは断る', (await run('browserScreencast', { sessionId: 's1' }, { local: true })).code === 'remote-only');
    t.ok('内蔵ブラウザーの無いホスト（npm start）では使えない', (await run('browserScreencast', { sessionId: 's1' }, { hub: null, bridge: null })).code === 'unavailable');
    t.ok('会話の無い依頼は断る', (await run('browserScreencast', {})).code === 'invalid-session');
    t.ok('http(s) でない URL は断る', (await run('browserScreencast', { sessionId: 's1', url: 'file:///C:/x.html' })).code === 'invalid-url');
    t.ok('見ていない接続からの入力は断る', (await run('browserScreencastInput', { sessionId: 's1', input: { type: 'tap', x: 1, y: 1 } })).code === 'not-watching');
    const opened = await run('browserScreencast', { sessionId: 's1', url: 'http://localhost:5173/' });
    t.ok('見始められる', opened.ok && bridge.requests.at(-1)[2].options.url === 'http://localhost:5173/');
    t.ok('見ている接続の入力は main へ渡す', (await run('browserScreencastInput', { sessionId: 's1', input: { type: 'tap', x: 1, y: 1 } })).ok);
    t.ok('エージェント向けの操作（browserScreencastAgent）は無い', (await run('browserScreencastAgent', { sessionId: 's1', action: 'takeOver' })).ok !== true);
    let asked = null;
    const shown = await run('browserScreencast', { sessionId: 's1', visualization: { sessionId: 's0', id: 'v1' } }, { snapshotFile: async q => { asked = q; return 'file:///C:/data/visualization-snapshots/v1.html'; } });
    t.ok('可視化の写しはサーバーが書き出した file: の URL で開く（端末から file: は受けない）', shown.ok && asked.sessionId === 's0' && asked.id === 'v1'
      && bridge.requests.at(-1)[2].options.fileUrl.startsWith('file:') && !bridge.requests.at(-1)[2].options.url);
    const startSource = bridge.requests.at(-1)[2].options.source;
    t.ok('可視化の写しは、記録の印（source）をタブに付けて開く（「読み込む」で書き直せるように）', startSource.kind === 'snapshot' && startSource.sessionId === 's0' && startSource.id === 'v1');
    t.ok('写しが無ければ断る', (await run('browserScreencast', { sessionId: 's1', visualization: { id: 'x' } }, { snapshotFile: async () => null })).code === 'not-found');

    // 「読み込む」（allowOnce）: main が rewrite を返したら、許す出どころつきで写しを書き直し、同じタブへ開き直す
    const asks = [];
    bridge.request = async (action, sessionId, args) => { bridge.requests.push([action, sessionId, args]);
      return action === 'navigate' && args.nav === 'allowOnce' ? { tabId: 't1', rewrite: { source: { kind: 'snapshot', sessionId: 's0', id: 'v1' }, origins: ['https://cdn.example'] } } : {}; };
    const allowed = await run('browserScreencastNav', { sessionId: 's1', action: 'allowOnce', tabId: 't1' }, { snapshotFile: async q => { asks.push(q); return 'file:///C:/data/visualization-snapshots/v1-once.html'; } });
    const reopen = bridge.requests.at(-1);
    t.ok('allowOnce の写しは、許す出どころつきで書き直して openTab で開き直す（rewrite は端末へ返さない）',
      allowed.ok && asks[0].sessionId === 's0' && asks[0].id === 'v1' && asks[0].allow[0] === 'https://cdn.example'
      && reopen[0] === 'openTab' && reopen[2].fileUrl.endsWith('v1-once.html') && reopen[2].source.kind === 'snapshot' && allowed.result.rewrite === undefined);
    bridge.requests.length = 0;
    bridge.request = async (action, sessionId, args) => { bridge.requests.push([action, sessionId, args]); return {}; };
    const plain = await run('browserScreencastNav', { sessionId: 's1', action: 'allowOnce', tabId: 't1' }, { snapshotFile: async () => { throw new Error('書き直さない'); } });
    t.ok('rewrite の無い allowOnce（file: のタブ・https のタブ）は main の読み直しだけ', plain.ok && bridge.requests.length === 1 && bridge.requests[0][2].nav === 'allowOnce');
    bridge.request = async () => ({ rewrite: { source: { kind: 'snapshot', sessionId: 's0', id: 'v1' }, origins: [] } });
    t.ok('書き直す写しが無くなっていたら not-found', (await run('browserScreencastNav', { sessionId: 's1', action: 'allowOnce' }, { snapshotFile: async () => null })).code === 'not-found');
  }

  // ---- parentPort の口
  {
    const port = new EventEmitter();
    const posted = [];
    port.postMessage = message => posted.push(message);
    const bridge = parentPortScreencast(port);
    t.ok('main から ready が届くまでは使えない', bridge.ready === false);
    port.emit('message', { data: { type: 'browser-screencast-ready' } });
    const pending = bridge.request('start', 's1', { options: { width: 390 } });
    port.emit('message', { data: { type: 'browser-screencast', id: posted[0].id, ok: false, error: 'no-tab' } });
    let error = null;
    try { await pending; } catch (e) { error = e.message; }
    t.ok('ready の後は依頼を送り、失敗の理由をそのまま返す', bridge.ready && posted[0].action === 'start' && error === 'no-tab');
    t.ok('parentPort が無い（npm start）なら口を作らない', parentPortScreencast(null) === null);
  }

  // ---- main（desktop/browser-screencast.cjs）
  {
    const panel = fakePanel(), posted = [];
    const sc = createBrowserScreencast(panel, { post: message => posted.push(message) });
    const result = await sc.start('s1', { width: 390, height: 700, scale: 2, quality: 55 });
    const tab = panel.tabsFor('s1')[0];
    const commands = panel.log.commands.filter(([id]) => id === tab.id).map(([, method, params]) => [method, params]);
    t.ok('タブが無ければ作り、窓の外に載せる（pin）', result.tabId === tab.id && panel.log.pinned.has(tab.id));
    t.ok('ビューポートを端末の表示の大きさにしてから画面を送り始める',
      commands[0][0] === 'Emulation.setDeviceMetricsOverride' && commands[0][1].width === 390 && commands[0][1].height === 700
      && commands[1][0] === 'Page.startScreencast' && commands[1][1].maxWidth === 780 && commands[1][1].format === 'jpeg');
    tab.webContents.debugger.emit('message', {}, 'Page.screencastFrame', { data: 'QUJD', sessionId: 3, metadata: { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 } });
    t.ok('フレームを worker へ渡す（ack は worker が決める）', posted.some(m => m.type === 'browser-screencast-frame' && m.frame.id === 3 && m.frame.data === 'QUJD')
      && !panel.log.commands.some(([, method]) => method === 'Page.screencastFrameAck'));
    sc.ack('s1', 3);
    t.ok('worker の ack で Chromium に次を許す', panel.log.commands.some(([, method, params]) => method === 'Page.screencastFrameAck' && params.sessionId === 3));
    await sc.input('s1', { type: 'tap', x: 100, y: 200 });
    t.ok('タップはマウスの押す・離す',
      panel.log.commands.filter(([, method]) => method === 'Input.dispatchMouseEvent').length === 3);
    await sc.navigate('s1', 'open', 'http://localhost:5173/next');
    let badUrl = null;
    try { await sc.navigate('s1', 'open', 'file:///C:/secret.txt'); } catch (e) { badUrl = e.message; }
    t.ok('URL を開くのは http(s) だけ', panel.log.commands.some(([, m, u]) => m === 'loadURL' && u === 'http://localhost:5173/next') && badUrl === 'invalid-url');
    let badStart = null;
    try { await sc.start('s1', { url: 'javascript:alert(1)' }); } catch (e) { badStart = e.message; }
    t.ok('端末からの url は http(s) だけ（file: はサーバーが確かめた fileUrl でだけ）', badStart === 'invalid-url');
    tab.webContents.url = 'file:///C:/Users/x/.agent-host/visualization-snapshots/a.html';
    t.ok('PC のファイルの在り処は端末へ出さない', sc.state('s1').url === 'file:///');
    panel.destroy(tab.id);
    t.ok('タブが閉じたら終わりを知らせ、窓の外から外す', posted.at(-1).type === 'browser-screencast-ended' && posted.at(-1).reason === 'closed' && !panel.log.pinned.has(tab.id));

    const second = await sc.start('s2', {});
    await sc.stop('s2');
    const stopCommands = panel.log.commands.filter(([id]) => id === second.tabId).map(([, method]) => method);
    t.ok('止めると画面の送信とビューポートを戻す', stopCommands.includes('Page.stopScreencast') && stopCommands.includes('Emulation.clearDeviceMetricsOverride') && !panel.log.pinned.has(second.tabId));
  }

  // ---- main: タブ列（右パネルのタブ。ホストの画面の右パネルと同じ並びを端末へ。選ぶ・閉じる・足す・ファイルを足す）
  {
    const panel = fakePanel(), posted = [];
    const sc = createBrowserScreencast(panel, { post: message => posted.push(message) });
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const first = await sc.start('s1', { width: 390, height: 700 });
    const other = panel.createFor('s2', 'https://other.example/');
    const second = panel.createFor('s1', 'https://example.com/');   // ホストの画面で足したタブ
    t.ok('状態にこの会話のタブ列を載せる（ほかの会話のタブは載せない）', sc.state('s1').tabs.map(tab => tab.id).join() === `${first.tabId},${second.id}`);
    posted.length = 0;
    await sleep(80);
    const pushed = posted.filter(m => m.type === 'browser-screencast-state');
    t.ok('タブが増えたら（ホストの画面からでも）状態を端末へ押し出す', pushed.length === 1 && pushed[0].state.tabs.length === 2);

    const moved = await sc.navigate('s1', 'select', undefined, second.id);
    t.ok('select で見るタブを替える（映す先と窓の外の載せ先が移る）', moved.tabId === second.id && panel.log.pinned.has(second.id) && !panel.log.pinned.has(first.tabId)
      && panel.log.commands.some(([id, method]) => id === second.id && method === 'Page.startScreencast'));
    posted.length = 0;
    panel.tabsFor('s1')[0].webContents.debugger.emit('message', {}, 'Page.screencastFrame', { data: 'QQ==', sessionId: 1, metadata: {} });
    panel.tabsFor('s1')[1].webContents.debugger.emit('message', {}, 'Page.screencastFrame', { data: 'Qg==', sessionId: 2, metadata: {} });
    t.ok('替えたあとは、前のタブのフレームを渡さない', posted.filter(m => m.type === 'browser-screencast-frame').map(m => m.frame.data).join() === 'Qg==');
    let noTab = [];
    for (const id of ['t999', other.id]) { try { await sc.navigate('s1', 'select', undefined, id); } catch (e) { noTab.push(e.message); } }
    t.ok('ない・ほかの会話のタブは選べない（no-tab）', noTab.join() === 'no-tab,no-tab');
    const again = await sc.start('s1', { width: 400, height: 800, tabId: first.tabId });
    t.ok('start に tabId を渡すと、そのタブへ見る先を移す', again.tabId === first.tabId && panel.log.pinned.has(first.tabId) && !panel.log.pinned.has(second.id));
    t.ok('tabId の無い start は今のタブのまま大きさだけ変える', (await sc.start('s1', { width: 360, height: 700 })).tabId === first.tabId);

    const made = await sc.navigate('s1', 'newTab');
    t.ok('newTab は空のタブを足してそこへ移る', made.tabId !== first.tabId && sc.state('s1').tabs.length === 3 && panel.log.pinned.has(made.tabId)
      && panel.tabsFor('s1').find(tab => tab.id === made.tabId).webContents.url === 'about:blank');

    posted.length = 0;
    await sc.navigate('s1', 'close', undefined, second.id);
    t.ok('見ていないタブを閉じても、見るのは続ける', sc.state('s1').tabs.length === 2 && sc.state('s1').tabId === made.tabId && !posted.some(m => m.type === 'browser-screencast-ended'));
    await sc.navigate('s1', 'close', undefined, made.tabId);
    await sleep(10);
    t.ok('見ているタブを閉じたら、残りの先頭へ移る（終わらせない）', sc.state('s1').tabId === first.tabId && panel.log.pinned.has(first.tabId) && !posted.some(m => m.type === 'browser-screencast-ended'));
    let closeOther = null;
    try { await sc.navigate('s1', 'close', undefined, other.id); } catch (e) { closeOther = e.message; }
    t.ok('ほかの会話のタブは閉じられない', closeOther === 'no-tab' && panel.tabsFor('s2').length === 1);
    await sc.navigate('s1', 'close');
    await sleep(10);
    t.ok('最後のタブを閉じたら終わり（closed）', posted.at(-1).type === 'browser-screencast-ended' && posted.at(-1).reason === 'closed' && sc.state('s1') === null && panel.log.pinned.size === 0);

    // PC のファイル（HTML）を足す: 見ずに、会話のタブへ。同じファイルは同じタブ
    const opened = sc.openTab('s1', 'file:///C:/work/index.html');
    t.ok('openTab は見ずにタブを足し（見に行くのは tabId で start）、在り処は state に出ない', opened.tabId && !panel.log.pinned.has(opened.tabId) && sc.state('s1') === null);
    t.ok('同じファイルをもう一度開くと同じタブ', sc.openTab('s1', 'file:///C:/work/index.html').tabId === opened.tabId && panel.tabsFor('s1').length === 1);
    const watched = await sc.start('s1', { width: 390, height: 700, tabId: opened.tabId });
    t.ok('端末は返った tabId で見に行く', watched.tabId === opened.tabId && watched.state.url === 'file:///' && watched.state.tabs[0].url === 'file:///');
    const bad = [];
    for (const url of ['https://example.com/', 'javascript:alert(1)', 'C:\\x.html', undefined]) { try { sc.openTab('s1', url); } catch (e) { bad.push(e.message); } }
    t.ok('openTab は file: だけ受ける', bad.join() === 'invalid-url,invalid-url,invalid-url,invalid-url');
    sc.close();
  }

  // ---- main: source・止めた外部の読み込み（guard）・「読み込む」
  {
    const panel = fakePanel(), posted = [];
    const sc = createBrowserScreencast(panel, { post: message => posted.push(message) });
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const source = { kind: 'file', label: 'docs/index.html' };
    const opened = sc.openTab('s1', 'file:///C:/work/index.html', source);
    t.ok('openTab の source はタブに付く（ホストの画面の ⋯ とバッジ）', panel.tabsFor('s1')[0].id === opened.tabId && panel.tabsFor('s1')[0].source === source);
    const snap = sc.openTab('s1', 'file:///C:/data/visualization-snapshots/v1.html', { kind: 'snapshot', sessionId: 's0', id: 'v1' });
    const snapTab = panel.tabsFor('s1').find(tab => tab.id === snap.tabId);
    snapTab.guard = { blocked: 3, origins: ['https://cdn.example'] };
    await sc.start('s1', { width: 390, height: 700, tabId: snap.tabId });
    const tabs = sc.state('s1').tabs;
    t.ok('state のタブに止めた件数と出どころ（https）が載る。ないタブは null', tabs.find(tab => tab.id === snap.tabId).guard.blocked === 3
      && tabs.find(tab => tab.id === snap.tabId).guard.origins[0] === 'https://cdn.example' && tabs.find(tab => tab.id === opened.tabId).guard === null);
    posted.length = 0;
    panel.changed();
    await sleep(80);
    t.ok('件数が変わったら（パネルの push）状態を端末へ押し出す', posted.some(m => m.type === 'browser-screencast-state'));
    const rewrite = await sc.navigate('s1', 'allowOnce', undefined, snap.tabId);
    t.ok('写しのタブの allowOnce は rewrite（source と許す出どころ）を返す', rewrite.rewrite.source.id === 'v1' && rewrite.rewrite.origins[0] === 'https://cdn.example');
    const plain = await sc.navigate('s1', 'allowOnce', undefined, opened.tabId);
    t.ok('file: のタブの allowOnce は rewrite なし（main が読み直す）', !plain?.rewrite && panel.log.commands.some(([id, method]) => id === opened.tabId && method === 'allowOnceFor'));
    let noTab = null;
    try { await sc.navigate('s1', 'allowOnce', undefined, 't999'); } catch (e) { noTab = e.message; }
    t.ok('ない・ほかの会話のタブの allowOnce は no-tab', noTab === 'no-tab');
    sc.close();
  }

  // ---- worker: タブ列の操作を main へ渡す
  {
    const bridge = fakeBridge();
    const hub = createScreencastHub({ bridge });
    const phone = client();
    const run = (command, args) => screencastCommand({ command, args, local: false, hub, bridge, client: phone });
    await run('browserScreencast', { sessionId: 's1', tabId: 't7' });
    t.ok('tabId は見始めの依頼に載せる', bridge.requests.at(-1)[2].options.tabId === 't7');
    await run('browserScreencast', { sessionId: 's1', tabId: 5 });
    t.ok('文字でない tabId は載せない', bridge.requests.at(-1)[2].options.tabId === undefined);
    bridge.request = async (action, sessionId, args) => { bridge.requests.push([action, sessionId, args]); return action === 'navigate' && args.nav === 'select' ? { tabId: args.tabId, state: { tabs: [] } } : action === 'start' ? { tabId: 't1' } : {}; };
    const selected = await run('browserScreencastNav', { sessionId: 's1', action: 'select', tabId: 't7' });
    t.ok('select・close・newTab は tabId つきで main へ渡し、返った tabId を端末へ返す', selected.ok && selected.result.tabId === 't7' && bridge.requests.at(-1)[2].tabId === 't7' && bridge.requests.at(-1)[2].nav === 'select');
    bridge.request = async () => { throw new Error('no-tab'); };
    t.ok('閉じられたタブの指定は no-tab', (await run('browserScreencastNav', { sessionId: 's1', action: 'select', tabId: 't8' })).code === 'no-tab');
  }

  // ---- 入力の変換（CDP）
  {
    const tap =inputCommands({ type: 'tap', x: 50, y: 5000 }, { width: 390, height: 700 });
    t.ok('タップの座標はページの大きさに収める', tap.length === 3 && tap[1][1].type === 'mousePressed' && tap[1][1].y === 700 && tap[2][1].type === 'mouseReleased');
    const enter = inputCommands({ type: 'key', key: 'Enter' });
    t.ok('Enter は文字（\\r）付きの keyDown と keyUp', enter[0][1].type === 'keyDown' && enter[0][1].text === '\r' && enter[1][1].type === 'keyUp');
    t.ok('Backspace は rawKeyDown', inputCommands({ type: 'key', key: 'Backspace' })[0][1].type === 'rawKeyDown');
    t.ok('決めたキーのほかは送らない', inputCommands({ type: 'key', key: 'F12' }).length === 0 && inputCommands({ type: 'key', key: 'Control' }).length === 0);
    t.ok('文字は insertText（長すぎれば送らない）', inputCommands({ type: 'text', text: 'こんにちは' })[0][0] === 'Input.insertText' && inputCommands({ type: 'text', text: 'x'.repeat(2001) }).length === 0);
    const wheel = inputCommands({ type: 'scroll', x: 10, y: 10, dx: 0, dy: 99999 });
    t.ok('スクロールはホイール（量は上限で丸める）', wheel[0][1].type === 'mouseWheel' && wheel[0][1].deltaY === 4000);
    t.ok('知らない入力は送らない', inputCommands({ type: 'drag' }).length === 0 && inputCommands(null).length === 0);
    const s = screencastSettings({ width: 5000, height: 10, scale: 9, quality: 100 });
    t.ok('大きさと画質は範囲に丸める', s.width === 1600 && s.height === 240 && s.scale === 2 && s.quality === 80 && s.maxWidth === 3200);
  }

  // ---- 画面: 座標の変換
  {
    const rect = containRect({ left: 0, top: 100, width: 400, height: 1000 }, { width: 780, height: 1400 });
    t.ok('contain で収めた画像の範囲', Math.abs(rect.width - 400) < 0.01 && Math.abs(rect.height - 717.95) < 0.1 && Math.abs(rect.top - (100 + (1000 - rect.height) / 2)) < 0.01);
    const meta = { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 };
    const p = toPageCoords({ x: 200, y: rect.top + rect.height / 2 }, rect, meta);
    t.ok('表示の点をページの CSS px へ（画像の倍率によらない）', p.x === 195 && p.y === 350, JSON.stringify(p));
    t.ok('画像の外（余白）は null', toPageCoords({ x: 10, y: rect.top - 5 }, rect, meta) === null);
    t.ok('移動量も同じ倍率', Math.abs(toPageDelta(100, rect, meta) - 97.5) < 0.01);
    t.ok('fps は直近 3 秒の枚数', framesPerSecond([0, 1000, 2000, 2500, 2900, 3000], 3000) === 2 && framesPerSecond([0], 5000) === 0);
  }

  // ---- ホストの状態 → 右パネルのタブの列（ホストの画面と同じ部品が読む形）
  {
    const state = { tabId: 'b', url: 'https://b.example/', title: 'B', loading: true, canGoBack: true, canGoForward: false,
      tabs: [{ id: 'a', url: 'https://a.example/', title: 'A' }, { id: 'b', url: 'https://old/', title: 'old' }] };
    const panel = panelStateOf(state, 's1');
    t.ok('見ているタブは戻る・進む・読み込み中と最新の URL、ほかのタブは一覧のまま', panel.current === 'b' && panel.sessionId === 's1'
      && panel.tabs[1].url === 'https://b.example/' && panel.tabs[1].canGoBack === true && panel.tabs[1].loading === true
      && panel.tabs[0].canGoBack === false && panel.tabs[0].url === 'https://a.example/');
    t.ok('既定のブラウザーで開く（external）はリモートでは出さない', panel.tabs.every(tab => tab.external === false));
    t.ok('状態が無ければ空の列（最後のタブが閉じた）', panelStateOf(null, 's1').tabs.length === 0 && panelStateOf(null, 's1').current === null);
  }

  // ---- シートの出し分け
  {
    const page = 'http://127.0.0.1:51234';
    t.ok('ホストの画面ではシートを出さない', linkChoices({ url: 'https://example.com/', pageOrigin: page, hostScreen: true, pcBrowser: true }) === null);
    t.ok('内蔵ブラウザーの無いホストでは出さない（今までどおり）', linkChoices({ url: 'https://example.com/', pageOrigin: page, pcBrowser: false }) === null);
    const web = linkChoices({ url: 'https://example.com/', pageOrigin: page, pcBrowser: true });
    t.ok('Web のページはシートで選ぶ（内蔵ブラウザー / 既定のブラウザー / コピー）', web && web.pcOnly === false);
    const local = linkChoices({ url: 'http://localhost:5173/projects', pageOrigin: page, pcBrowser: true });
    t.ok('localhost は端末では開けない（シートを挟まず、ホストの内蔵ブラウザーのタブで開く）', local.pcOnly === true);

    const listeners = {}, told = [], chosen = [];
    const root = { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener() {} };
    watchHostOnlyLinks({ root, onHostScreen: () => false, notify: text => told.push(text), choose: url => { chosen.push(url); return true; }, origin: () => page });
    let prevented = false;
    listeners.click({ target: { closest: () => ({ getAttribute: () => 'http://localhost:5173/a' }) }, preventDefault: () => { prevented = true; }, defaultPrevented: false, type: 'click' });
    t.ok('localhost のリンクはシートへ回し、知らせは出さない', prevented && chosen[0] === 'http://localhost:5173/a' && told.length === 0);
  }

  // ---- 配線
  {
    const all = ['browserScreencast', 'browserScreencastStop', 'browserScreencastAck', 'browserScreencastInput', 'browserScreencastNav'];
    t.ok('WS のコマンドを protocol に登録してある', all.every(command => COMMANDS.has(command)));
    const server = read('core/server.mjs');
    t.ok('サーバーは isLocalRequest の結果を渡し、hostCapabilities で pcBrowser を答える',
      /screencastCommand\(\{ command: msg\.command, args: msg\.args \?\? \{\}, local,/.test(server) && /pcBrowser: !local && !!screencastBridge\?\.ready/.test(server));
    t.ok('接続が切れたら見ていた画面を外す', /screencastHub\?\.forget\(viewer\)/.test(server));
    t.ok('リモートの HTML の openTab には、作業ディレクトリからの相対の label を持つ source を付ける', /request\('openTab', sessionId, \{ fileUrl: pathToFileURL\(file\)\.href, source: \{ kind: 'file', label \} \}\)/.test(server)
      && /path\.relative\(resolved\.cwd, resolved\.path\)/.test(server));
    t.ok('端末の「読み込む」は allowOnce として main へ渡る（写しは一時の許可つきで書き直す）', /case 'allowOnce': return nav\('allowOnce', \{ tabId: args\.id \}\)/.test(read('web/remote-browser.mjs'))
      && /snapshotFile: async \(\{ sessionId, id, at, allow \}\)/.test(server) && /once, report: true/.test(server));
    const main = read('desktop/main.cjs');
    t.ok('デスクトップ版の main が橋をつなぐ', /attachBrowserScreencastBridge\(messages, browserPanel/.test(main));
    const client = read('web/client.mjs');
    t.ok('リモートの端末は右パネルのブラウザーへ映像を渡す部品を 1 つ作る（ホストの画面は作らない）。見られるのはホストの画面ではなく pcBrowser のときだけ',
      /const remoteBrowser = browserPanelAvailable\(\) \? null : createRemoteBrowser\(/.test(client)
      && /bridge: remoteBrowser\.bridge, viewport: remoteBrowser\.viewport,\s*available: \(\) => state\.osActions !== true && state\.hostCaps\?\.pcBrowser === true/.test(client));
    t.ok('hostCapabilities が届いたら入口を出し直す（ply-browser-availability）', /announceBrowserAvailability\(\); browserPanel\.refreshTabs\(\)/.test(client)
      && /dispatchEvent\(new CustomEvent\('ply-browser-availability'\)\)/.test(client));
    t.ok('全面の表示（.rb）は無い', !/rb-open|\.rb\{|'rb'/.test(read('web/remote-browser.css') + read('web/remote-browser.mjs')));
    t.ok('画面は screencast の知らせを表示へ渡す（Chrome の窓の映像は Chrome の窓のパネルへ、内蔵ブラウザーは右パネルのブラウザーへ）', /m\.kind === "screencast"\) return m\.source === 'chrome' \? chromePanel\?\.onMessage\(m\) : remoteBrowser\?\.onMessage\(m\)/.test(client));
  }
}
