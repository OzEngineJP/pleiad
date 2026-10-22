import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { contextMetrics, conversationMenuItems, menuMeter, renderContextUsage } from '../../web/conversation-usage.mjs';
import { setupHeaderUsage } from '../../web/header-usage.mjs';

export const name = 'conversation-usage';
export const title = 'スマホの会話: メニューの入口・アイコン・バーと圧縮の情報';
export default async function(t) {
  const previous = globalThis.document, previousWindow = globalThis.window, previousMedia = globalThis.matchMedia;
  const pagehide = [];
  globalThis.document = { createElement: tag => new N(tag), createElementNS: (_ns, tag) => new N(tag) };
  try {
    const options = Object.fromEntries(['plugins', 'git', 'browser', 'usage', 'compact', 'copy'].map(label => [label, { label }]));
    const items = conversationMenuItems(options);
    assert.deepEqual(items.map(item => item.label), Object.keys(options));
    for (const item of items) {
      assert.equal(item.icon.tagName, 'SVG');
      assert.equal(item.icon.getAttribute('aria-hidden'), 'true');
      assert.ok(item.icon.children.length);
    }
    assert.deepEqual(conversationMenuItems({ ...options, plugins: false, git: false, browser: false }).map(item => item.label), ['usage', 'compact', 'copy']);
    t.ok('利用可能な入口だけを順に並べ、全行に線画のアイコンを付ける', true);

    assert.equal(menuMeter(null), null);
    assert.equal(menuMeter(NaN), null);
    assert.equal(menuMeter(73).querySelector('i').style.width, '73%');
    assert.equal(menuMeter(140).querySelector('i').style.width, '100%');
    assert.ok(menuMeter(99.6).textContent.includes('99%'), 'a quota below its limit must not read 100%');
    const info = { usage: { usedTokens: 60000, windowTokens: 200000 }, auto: { enabled: true, minTokens: 150000 }, compact: true, session: {} };
    assert.equal(contextMetrics(info).percent, 30);
    assert.equal(contextMetrics(info).remaining, 90000);
    assert.equal(contextMetrics({ ...info, session: { autoCompactionOff: true } }).remaining, null);
    assert.equal(contextMetrics({ ...info, compact: false }).remaining, null);
    assert.equal(contextMetrics({ ...info, usage: { usedTokens: 0, windowTokens: 0 } }).percent, null);
    assert.equal(contextMetrics({ ...info, usage: null }).percent, null);
    assert.equal(contextMetrics({ ...info, usage: { usedTokens: 170000, windowTokens: 200000 } }).remaining, 0);
    t.ok('文脈の率と自動圧縮までの残りを分け、値が不明な棒は出さない', true);
    const section = renderContextUsage(info);
    assert.equal(section.querySelectorAll('.usage-bar').length, 2);
    assert.equal(section.querySelectorAll('.usage-bar')[0].children[0].style.width, '30%');
    assert.equal(renderContextUsage({ ...info, usage: null }).querySelectorAll('.usage-bar').length, 0);
    assert.equal(renderContextUsage({ ...info, session: { autoCompactionOff: true } }).querySelectorAll('.usage-bar').length, 1);
    t.ok('シートに文脈・閾値の棒を出し、自動圧縮オフでは文脈だけを出す', true);
    for (const usedTokens of [150000, 164000, 220000]) {
      const full = renderContextUsage({ ...info, usage: { usedTokens, windowTokens: 200000 } });
      assert.equal(full.querySelectorAll('.conversation-graph')[1].querySelector('.value').textContent, '100%');
      assert.equal(full.querySelectorAll('.usage-bar')[1].children[0].style.width, '100%');
      assert.ok(!full.textContent.includes('残り') && !full.textContent.includes('0k'));
      assert.ok(!full.querySelectorAll('.usage-bar')[1].getAttribute('aria-label').includes('109%'));
    }
    const near = renderContextUsage({ ...info, usage: { usedTokens: 149999, windowTokens: 200000 } });
    assert.ok(near.textContent.includes('残り 1 トークン'));
    t.ok('基準以上は満杯の100%で残りを省き、基準未満は1トークンまで整数で表示する', true);
    const doc = globalThis.document;
    doc.body = new N('body'); doc.documentElement = { clientWidth: 390 }; doc.addEventListener = () => {};
    doc.createElement = tag => {
      const node = new N(tag);
      if (tag === 'dialog') {
        node.showModal = () => { node.open = true; };
        node.close = () => { node.open = false; node.dispatchEvent(new Event('close')); };
      }
      return node;
    };
    globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
    globalThis.window = { addEventListener: (name, fn) => { if (name === 'pagehide') pagehide.push(fn); } };
    const chip = new N('button'), pop = new N('div'); pop.hidden = true;
    const callbacks = [];
    const source = { onResult: fn => callbacks.push(fn), onState() {}, state: () => ({}),
      async load(backend) {
        const result = { label: backend, quota: { windows: [{ label: 'window', usedPercent: backend === 'current' ? 38 : 81 }] } };
        callbacks.forEach(fn => fn(backend, result)); return result;
      } };
    const ui = setupHeaderUsage({ $: id => id === 'usageChip' ? chip : pop, source,
      getBackends: () => [{ id: 'current' }, { id: 'other' }], context: () => info, openSettings() {} });
    ui.show({ backend: 'current' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.currentPercent(), 38, 'other agent usage must not replace current usage');
    ui.open();
    assert.ok(doc.body.querySelector('.conversation-sheet'));
    assert.ok(pop.querySelector('.conversation-context'));
    assert.equal(pop.querySelector('.usage-other-agents').hasAttribute('open'), false);
    assert.equal(pop.querySelector('.usage-other-agents').querySelectorAll('.usage-agent').length, 1);
    assert.equal(pop.querySelectorAll('.conversation-graph').length, 2);
    assert.ok(pop.querySelector('.usage-other-agents').textContent.includes('81%'));
    doc.body.querySelector('.conversation-sheet').close();
    assert.equal(pop.hidden, true);
    assert.equal(pop.getAttribute('role'), 'dialog');
    t.ok('スマホの使用量シートは文脈と現在の枠を先に出し、他のエージェントを畳む。PC用の役割に戻して閉じる', true);
  } finally {
    pagehide.forEach(stop => stop());
    globalThis.document = previous; globalThis.window = previousWindow; globalThis.matchMedia = previousMedia;
  }
}
