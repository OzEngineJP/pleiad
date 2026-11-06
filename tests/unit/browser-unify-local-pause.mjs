// スマホで Pleiad のページを端末内で描いている間（chrome-panel の mountPage。web/browser-unify.mjs が置く）は、下の映像を止める（ADR 0292 の追記 2）
//   - 置いたら browserScreencastStop を 1 回送る。置き換えても送り直さない
//   - 置いている間は、箱の大きさが変わっても・つなぎ直しても映し直さない
//   - 外したら映し直す。閉じるときに止める依頼を重ねて送らない
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
  } finally {
    globalThis.requestAnimationFrame = old.raf; N.prototype.getBoundingClientRect = old.rect; N.prototype.toggleAttribute = old.toggle;
    if (old.window === undefined) delete globalThis.window; else globalThis.window = old.window;
  }
}
