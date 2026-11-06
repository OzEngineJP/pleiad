// スマホで Pleiad のページを端末内で描いている間（chrome-panel の mountPage。web/browser-unify.mjs が置く）は、下の映像を止める（ADR 0292 の追記 2）
//   - 置いたら browserScreencastStop を 1 回送る。置き換えても送り直さない
//   - 置いている間は、箱の大きさが変わっても・つなぎ直しても映し直さない
//   - 外したら映し直す。閉じるときに止める依頼を重ねて送らない
//   - タブの列で選んだタブは、映していない間（閉じている・止めている）は固定せず、映し始めてから固定する
import { setupChromePanel, createWindowTable } from '../../web/chrome-panel.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'browser-unify-local-pause';
export const title = 'スマホで端末内のページを描いている間は Chrome の映像を止め、外したら映し直す（DOM の代役）';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function rig() {
  const commands = [];
  const windows = createWindowTable();
  let panelOpen = false, onClose = null;
  const preview = { openPanel: options => { panelOpen = true; onClose = options.onClose; }, panelOpen: () => panelOpen, close: () => { panelOpen = false; onClose?.(); } };
  const panel = setupChromePanel({ cmd: async (name, args) => { commands.push([name, args]); return name === 'browserScreencast' ? { state: { suspended: false } } : {}; },
    preview, session: () => 'conv', windows });
  const count = command => commands.filter(([name]) => name === command).length;
  return { panel, windows, commands, count };
}

export default async function (t) {
  const old = { raf: globalThis.requestAnimationFrame, rect: N.prototype.getBoundingClientRect, toggle: N.prototype.toggleAttribute, window: globalThis.window };
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
  } finally {
    globalThis.requestAnimationFrame = old.raf; N.prototype.getBoundingClientRect = old.rect; N.prototype.toggleAttribute = old.toggle;
    if (old.window === undefined) delete globalThis.window; else globalThis.window = old.window;
  }
}
