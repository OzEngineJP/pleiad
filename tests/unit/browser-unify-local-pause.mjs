// スマホで Pleiad のページを端末内で描いている間（chrome-panel の mountPage。web/browser-unify.mjs が置く）は、下の映像を止める（ADR 0295 の追記 2）
//   - 置いたら browserScreencastStop を 1 回送る。置き換えても送り直さない
//   - 置いている間は、箱の大きさが変わっても・つなぎ直しても映し直さない
//   - 外したら映し直す。閉じるときに止める依頼を重ねて送らない
//   - タブの列で選んだタブは、映していない間（閉じている・止めている）は固定せず、映し始めてから固定する
import { setupChromePanel, createWindowTable } from '../../web/chrome-panel.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'browser-unify-local-pause';
export const title = 'スマホで端末内のページを描いている間は Chrome の映像を止め、外したら映し直す（DOM の代役）';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function rig({ rejectPin = false, holdStart = false, holdPin = false } = {}) {
  const commands = [], starts = [], pins = [];
  const windows = createWindowTable();
  let panelOpen = false, onClose = null;
  const preview = { openPanel: options => { panelOpen = true; onClose = options.onClose; }, panelOpen: () => panelOpen, close: () => { panelOpen = false; onClose?.(); } };
  const panel = setupChromePanel({ cmd: async (name, args) => {
    commands.push([name, args]);
    if (name === 'browserScreencast' && holdStart) return new Promise((resolve, reject) => starts.push({ resolve, reject }));
    if (name === 'chromePinWindow' && holdPin) return new Promise((resolve, reject) => pins.push({ resolve, reject }));
    if (name === 'chromePinWindow' && rejectPin) throw new Error('operating');
    return name === 'browserScreencast' ? { state: { tabId:'T1', suspended: false } } : {};
  },
    preview, session: () => 'conv', windows });
  const count = command => commands.filter(([name]) => name === command).length;
  return { panel, windows, commands, count, starts, pins };
}

export default async function (t) {
  const old = { raf: globalThis.requestAnimationFrame, rect: N.prototype.getBoundingClientRect, toggle: N.prototype.toggleAttribute, window: globalThis.window, query:document.querySelector, body:document.body };
  document.body = new N('body');
  document.querySelector = selector => document.body.querySelector(selector);
  globalThis.requestAnimationFrame = fn => { queueMicrotask(fn); return 1; };
  N.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 });
  N.prototype.toggleAttribute = function (name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); };
  globalThis.window = { innerHeight: 800, devicePixelRatio: 1 };
  try {
    {
      const r = rig();
      r.windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      r.panel.open();
      await flush();
      t.ok('開くと映像を受け始める', r.count('browserScreencast') === 1);

      r.panel.mountPage(new N('iframe'));
      await flush();
      const stop = r.commands.filter(([name]) => name === 'browserScreencastStop');
      t.ok('端末内のページを置くと、映像を止める依頼を送る', stop.length === 1 && stop[0][1].sessionId === 'conv' && stop[0][1].source === 'chrome', JSON.stringify(stop));

      r.panel.mountPage(new N('iframe'));
      await flush();
      t.ok('別の端末内のページに置き換えても、止める依頼を重ねない', r.count('browserScreencastStop') === 1);

      r.panel.reconnected();
      await flush();
      t.ok('置いている間につなぎ直しても、映し直さない', r.count('browserScreencast') === 1);

      r.panel.mountPage(null);
      await flush();
      t.ok('外すと映し直す', r.count('browserScreencast') === 2);

      r.panel.mountPage(null);
      await flush();
      t.ok('もう一度外しても、映し直しを重ねない', r.count('browserScreencast') === 2);
    }
    {
      const r = rig();
      r.windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      r.panel.open();
      await flush();
      r.panel.mountPage(new N('iframe'));
      await flush();
      r.panel.close();
      await flush();
      t.ok('止めている間に閉じても、止める依頼を重ねない', r.count('browserScreencastStop') === 1, JSON.stringify(r.commands.map(([name]) => name)));
      r.panel.open();
      await flush();
      t.ok('閉じた後にまた開くと、映像を受ける（止めていた印は残らない）', r.count('browserScreencast') === 2);
    }
    {
      const r = rig();
      r.panel.mountPage(new N('iframe'));
      await flush();
      t.ok('パネルが開いていない間に置いても、何も送らない', r.commands.length === 0);
    }
    // タブの列で選んだタブの固定（pinTab）。映像を見ていない会話は固定できない（サーバーが not-watching で断る）ので、映し始めてから送る
    {
      const r = rig();
      const pins = () => r.commands.filter(([name]) => name === 'chromePinWindow').map(([, args]) => args.tabId);
      r.windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      await r.panel.pinTab('conv', { windowId: 7, tabId: 'T2' });
      t.ok('パネルが閉じている間に選んだタブは、まだ固定しない', pins().length === 0);
      r.panel.open();
      await flush();
      const names = r.commands.map(([name]) => name);
      t.ok('パネルを開いて映し始めてから、選んだタブを固定する', pins().join() === 'T2' && names.indexOf('browserScreencast') < names.indexOf('chromePinWindow'), JSON.stringify(names));
      await r.panel.pinTab('conv', { windowId: 7, tabId: 'T3' });
      t.ok('映している間に選んだタブは、すぐ固定する', pins().join() === 'T2,T3');
      r.panel.mountPage(new N('iframe'));
      await flush();
      await r.panel.pinTab('conv', { windowId: 7, tabId: 'T4' });
      t.ok('端末内のページで映像を止めている間は、固定しない', pins().join() === 'T2,T3');
      r.panel.mountPage(null);
      await flush();
      t.ok('端末内のページを外して映し直してから、選んだタブを固定する', pins().join() === 'T2,T3,T4' && r.count('browserScreencast') === 2);
      await r.panel.pinTab('other', { windowId: 9, tabId: 'X' });
      r.panel.close(); r.panel.open();
      await flush();
      t.ok('ほかの会話のタブは、この会話を映し始めても固定しない', !pins().includes('X'));
    }
    {
      const r = rig({ rejectPin:true }), events = [];
      r.panel.onTabChange(event => { if (event) events.push(event); });
      r.windows.apply({ sessionId:'conv', windows:1, windowIds:[7], currentWindowId:7 });
      await r.panel.pinTab('conv', { tabId:'T2' });
      r.panel.open(); await flush();
      t.ok('切り替え待ちの映像開始では、開始前のタブを確定通知しない', !events.some(e => e.type === 'state'));
      t.ok('開始後に送った切り替えが失敗したら、待っているタブを知らせる', events.some(e => e.type === 'pin-failed' && e.tabId === 'T2'));
      events.length = 0;
      await r.panel.pinTab('conv', { tabId:'T3' });
      t.ok('映像表示中の切り替え失敗も、待っているタブを知らせる', events.some(e => e.type === 'pin-failed' && e.tabId === 'T3'));
      r.panel.onMessage({ source:'chrome', sessionId:'conv', type:'state', state:{ tabId:'EXTERNAL' } });
      t.ok('切り替え要求によらないサーバーの表示中タブも、確定通知する', events.some(e => e.type === 'state') && r.panel.tabId === 'EXTERNAL');
      r.panel.mountPage(new N('iframe'));
      r.panel.onTabChange(event => { if (event?.type === 'reconnected') r.panel.mountPage(null); });
      const before = r.count('browserScreencast');
      r.panel.reconnected(); await flush();
      t.ok('再接続で選択を解いて端末内のページを外すと、映像を 1 回だけ再開する', r.count('browserScreencast') === before + 1);
      r.panel.mountPage(new N('iframe'));
      await r.panel.pinTab('conv', { tabId:'STALE' });
      r.panel.close(); r.panel.open(); await flush();
      t.ok('閉じたときに待っていた切り替えは、開き直しても送らない', !r.commands.some(([name, args]) => name === 'chromePinWindow' && args.tabId === 'STALE'));
      r.panel.close();
    }
    for (const change of ['reopen', 'retarget', 'reconnect']) {
      const r = rig({ holdStart:true }), events = [];
      r.panel.onTabChange(event => { if (event?.type === 'state') events.push(event); });
      for (const sessionId of ['conv', 'other']) r.windows.apply({ sessionId, windows:1, windowIds:[7], currentWindowId:7 });
      r.panel.open(); await flush();
      if (change === 'reopen') { r.panel.close(); r.panel.open(); }
      if (change === 'retarget') r.panel.open(null, { target:'other' });
      if (change === 'reconnect') r.panel.reconnected();
      await flush();
      r.starts[1].resolve({ state:{ tabId:'NEW' } }); await flush();
      const before = events.length;
      r.starts[0].resolve({ state:{ tabId:'OLD' } }); await flush();
      t.ok(`${change}: 前の映像開始の応答は、新しいタブも確定通知も上書きしない`, r.panel.tabId === 'NEW' && events.length === before);
      r.panel.close();
    }
    {
      const r = rig({ holdStart:true });
      r.windows.apply({ sessionId:'conv', windows:1, windowIds:[7], currentWindowId:7 });
      r.panel.open(); await flush();
      r.panel.onMessage({ source:'chrome', sessionId:'conv', type:'state', state:{ tabId:'PUSHED' } });
      r.starts[0].resolve({ state:{ tabId:'OLD' } }); await flush();
      t.ok('開始の応答を待つ間に届いた表示中タブは、開始時の古い状態で戻さない', r.panel.tabId === 'PUSHED');
      r.panel.close(); r.panel.open(); await flush();
      r.panel.close(); r.panel.open(); await flush();
      r.starts[2].resolve({ state:{ tabId:'NEW' } }); await flush();
      r.starts[1].reject(new Error('disconnected')); await flush();
      t.ok('閉じる前の映像開始の失敗で、開き直したパネルを閉じない', r.panel.isOpen() && r.panel.tabId === 'NEW');
      r.panel.close();
    }
    {
      const r = rig({ holdPin:true }), events = [];
      r.panel.onTabChange(event => { if (event?.type === 'pin-failed') events.push(event); });
      r.windows.apply({ sessionId:'conv', windows:1, windowIds:[7], currentWindowId:7 });
      r.panel.open(); await flush();
      const first = r.panel.pinTab('conv', { tabId:'T2' });
      const second = r.panel.pinTab('conv', { tabId:'T2' });
      r.pins[0].reject(new Error('superseded')); await first;
      t.ok('同じタブを選び直した後で前の要求が失敗しても、今の選択を解除しない', events.length === 0);
      r.pins[1].reject(new Error('operating')); await second;
      t.ok('今の切り替え要求が失敗したら、対象の会話とタブを知らせる', events.length === 1 && events[0].sessionId === 'conv' && events[0].tabId === 'T2');
      r.panel.close();
    }
  } finally {
    document.querySelector = old.query; document.body = old.body;
    globalThis.requestAnimationFrame = old.raf; N.prototype.getBoundingClientRect = old.rect; N.prototype.toggleAttribute = old.toggle;
    if (old.window === undefined) delete globalThis.window; else globalThis.window = old.window;
  }
}
