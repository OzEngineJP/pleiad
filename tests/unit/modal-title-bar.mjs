import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blendTitleBarColor, watchModalTitleBar } from '../../web/modal-title-bar.mjs';

export const name = 'modal-title-bar';
export const title = 'タイトルバーに幕の色を合成する';

export default function(t) {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../../web/client.mjs', import.meta.url), 'utf8');
  const header = html.match(/<dialog id="workDialog"[^>]*>[\s\S]*?<header>[\s\S]*?<\/header>/)?.[0];
  t.ok('委譲のヘッダーは共通の閉じるアイコンを使い、SVG 内のクリックも拾う',
    /<button [^>]*class="btn btn-icon"[^>]*data-close[^>]*data-i18n-aria-label="dialog.close"[^>]*data-i18n-title="dialog.closeWithEscape"/.test(header ?? '') &&
    client.includes(".innerHTML = closeIcon") && client.includes("e.target.closest('button[data-close]')"));
  const light = [21, 22, 28, .32];
  const dark = [0, 0, 0, .55];
  t.ok('ライトの幕を背景と記号へ同じ割合で合成する',
    blendTitleBarColor('#eceef4', [light]) === '#a7a9af' &&
    blendTitleBarColor('#1c2247', [light]) === '#1a1e39');
  t.ok('ダークの幕は色を不透明な16進表記で返す',
    blendTitleBarColor('rgb(18, 19, 24)', [dark]) === '#08090b' &&
    blendTitleBarColor('#dfe3f2', [dark]) === '#64666d');
  t.ok('幕が重なると奥から順に合成し、手前が消えると奥の幕の色に戻る',
    blendTitleBarColor('#eceef4', [light, dark]) === '#4b4c4f' &&
    blendTitleBarColor('#eceef4', [light, [0, 0, 0, 0]]) === blendTitleBarColor('#eceef4', [light]));
  assert.equal(blendTitleBarColor('rgb(18, 19, 24)', []), '#121318');

  const events = new Map();
  const next = new Map();
  const timers = new Map();
  const sent = [];
  let id = 0;
  let duration = '240ms';
  const root = { setAttribute() {} };
  const colors = { setAttribute() {}, classList: { toggle() {} } };
  const document = {
    documentElement: root,
    body: {},
    createElement: () => colors,
    addEventListener: (name, handler) => events.set(name, handler),
  };
  const window = {
    matchMedia: () => new EventTarget(),
    addEventListener() {},
    MutationObserver: class { observe() {} disconnect() {} },
    performance: { now: () => 0 },
    getComputedStyle: (node, pseudo) => {
      if (node === root) return { getPropertyValue: () => duration };
      if (pseudo) return { backgroundColor: node.backdrop };
      return { backgroundColor: '#eceef4', color: '#1c2247' };
    },
    requestAnimationFrame: fn => { next.set(++id, fn); return id; },
    setTimeout: fn => { timers.set(++id, fn); return id; },
    clearTimeout: key => timers.delete(key),
  };
  const paint = () => {
    const callbacks = [...next.values()];
    next.clear();
    for (const callback of callbacks) callback(300);
  };
  const createDialog = () => Object.assign(new EventTarget(), {
    localName: 'dialog', isConnected: true, open: false, closing: false,
    backdrop: 'rgba(21, 22, 28, 0.32)',
    matches() { return this.open; },
    toggleAttribute() { this.closing = true; },
    removeAttribute() { this.closing = false; },
    showModal() {
      if (!this.open) events.get('beforetoggle')({ target: this, newState: 'open' });
      this.open = true;
    },
    close() {
      events.get('beforetoggle')({ target: this, newState: 'closed' });
      this.open = false;
    },
  });
  const escape = dialog => {
    const event = new Event('cancel', { cancelable: true });
    events.get('cancel')({ target: dialog });
    dialog.dispatchEvent(event);
  };
  watchModalTitleBar({ document, window, bar: { append() {} }, send: value => sent.push(value) });
  const first = createDialog(), second = createDialog();
  first.showModal();
  paint();
  const underneath = sent.at(-1).color;
  second.showModal();
  paint();
  t.ok('2 枚目の幕を開くと 1 枚目の上に重ねる', sent.at(-1).color === blendTitleBarColor('#eceef4', [light, light]));
  const transition = { target: second, pseudoElement: '::backdrop', propertyName: 'background-color' };
  events.get('transitionrun')({ ...transition, type: 'transitionrun' });
  paint();
  const sampling = next.size === 1;
  events.get('transitionend')({ ...transition, type: 'transitionend' });
  paint();
  t.ok('幕の描画が設定時間を超えても、トランジションが終わるまで色を読む', sampling && next.size === 0);
  let panel = true;
  second.addEventListener('cancel', event => {
    if (panel) { panel = false; event.preventDefault(); }
  });
  escape(second);
  t.ok('最初の Esc で内側のパネルを閉じ、ダイアログは維持する', !panel && second.open && !second.closing);
  escape(second);
  t.ok('次の Esc でダイアログの幕が消え始め、実際に閉じるのは後', second.open && second.closing);
  second.backdrop = 'rgba(21, 22, 28, 0.16)';
  paint();
  const midpoint = sent.at(-1).color, count = sent.length;
  second.showModal();
  paint();
  t.ok('開閉を反転すると閉じる予約を取り消し、現在の色から再開する',
    second.open && !second.closing && !timers.size && sent.at(-1).color === midpoint && sent.length === count);
  second.close();
  for (const callback of timers.values()) callback();
  paint();
  t.ok('上の幕を閉じ終えると残った幕の色へ戻る', !second.open && first.open && sent.at(-1).color === underneath);
  duration = '0ms';
  first.close();
  paint();
  t.ok('視覚効果を減らす設定では即座に閉じる', !first.open && !timers.size && sent.at(-1).color === '#eceef4');
}
