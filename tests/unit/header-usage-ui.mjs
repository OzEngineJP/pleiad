import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { setupHeaderUsage, usagePopBounds } from '../../web/header-usage.mjs';
import { createUsageSource } from '../../web/usage.mjs';
import { t as tr } from '../../web/i18n.mjs';

export const name = 'header-usage-ui';
export const title = '使用量の入口: 取得中・枠なし・失敗・互換の接続先からも一覧を開く';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

export default async function(t) {
  const globals = { document: globalThis.document, window: globalThis.window };
  const documentEvents = {}, pagehide = [];
  const chip = new N('button'), pop = new N('div');
  chip.hidden = true; pop.hidden = true;
  chip.getBoundingClientRect = () => ({ left: 12, top: 600 });
  chip.focus = () => { document.activeElement = chip; };
  globalThis.document = {
    hidden: false, documentElement: { clientWidth: 1280 },
    createElement: tag => { const node = new N(tag); node.focus = () => { document.activeElement = node; }; return node; },
    createElementNS: (_ns, tag) => new N(tag),
    addEventListener: (type, fn) => { documentEvents[type] = fn; },
  };
  globalThis.window = { innerHeight: 900, addEventListener: (type, fn) => { if (type === 'pagehide') pagehide.push(fn); } };
  const initial = { current: deferred(), other: deferred() };
  const replies = new Map(Object.entries(initial).map(([id, task]) => [id, () => task.promise]));
  const source = createUsageSource((_command, args) => replies.get(args.backend ?? args.args.backend)());
  const backends = [{ id: 'current', label: 'Current' }, { id: 'other', label: 'Other' }];
  const quota = used => ({ windows: [{ label: '5h', usedPercent: used,
    resetsAt: new Date(Date.now() + 3600_000).toISOString() }], checkedAt: Date.now() });
  const logins = [];
  const ui = setupHeaderUsage({ $: id => id === 'usageChip' ? chip : pop, source,
    getBackends: () => backends, onUsageLogin: id => logins.push(id), openSettings() {} });
  const open = () => chip.onclick({ stopPropagation() {} });
  const sections = () => pop.querySelectorAll('.usage-agent');
  const unknownChip = () => {
    assert.equal(chip.hidden, false);
    assert.equal(chip.querySelector('.lb').textContent, tr('usage.header.title'));
    assert.equal(chip.querySelector('.pc').textContent, '—');
    assert.equal(chip.querySelector('.usage-mini').children[0].style.width, '0%');
    assert.ok(chip.querySelector('.caret'));
  };
  try {
    ui.show({}); unknownChip();
    ui.show({ backend: 'current' }); unknownChip(); open();
    assert.equal(sections().length, 2);
    assert.equal(pop.querySelector('.usage-other-agents').hasAttribute('open'), false);
    assert.equal(pop.getAttribute('aria-label'), tr('usage.header.title'));
    assert.match(sections()[0].textContent, /Current/);
    assert.ok(sections()[0].textContent.includes(tr('usage.loading')));
    initial.current.reject(new Error('offline')); await tick();
    unknownChip();
    assert.ok(sections()[0].textContent.includes(tr('usage.header.unavailable')));
    const summary = pop.querySelector('.usage-other-agents').querySelector('summary');
    summary.focus();
    assert.ok(!sections()[0].textContent.includes(tr('usage.loading')));
    assert.ok(sections()[1].textContent.includes(tr('usage.loading')));
    initial.other.resolve({ label: 'Other', quota: quota(38) }); await tick();
    assert.equal(document.activeElement, pop.querySelector('.usage-other-agents').querySelector('summary'));
    unknownChip();
    assert.equal(pop.hidden, false);
    assert.match(sections()[1].textContent, /38%/);
    assert.doesNotMatch(chip.textContent, /38%/);
    assert.equal(pop.hidden, false);
    assert.ok(sections()[0].textContent.includes(tr('usage.header.unavailable')));
    assert.ok(!sections()[0].textContent.includes(tr('usage.loading')));
    t.ok('初回取得の失敗でも入口と一覧を保ち、取得済みの別エージェントを確認できる', true);

    replies.set('current', () => Promise.resolve({ label: 'Current', quota: { windows: [] } }));
    ui.turnEnded('current'); await tick(); unknownChip();
    assert.equal(sections().length, 2);
    assert.ok(sections()[0].textContent.includes(tr('usage.header.unavailable')));
    replies.set('current', () => Promise.resolve({ label: 'Current', quota: quota(91) }));
    ui.turnEnded('current'); await tick();
    assert.match(chip.textContent, /91%/);
    replies.set('current', () => Promise.reject(new Error('offline')));
    ui.turnEnded('current'); await tick();
    assert.match(chip.textContent, /91%/);
    assert.ok(chip.classList.contains('dim'));
    t.ok('枠の無い応答後も一覧に残し、取得済みの率は失敗時に保つ', true);

    ui.show({ backend: 'current', endpoint: 'gateway' }); unknownChip();
    assert.ok(sections()[0].textContent.includes(tr('usage.header.endpointUnavailable')));
    assert.doesNotMatch(sections()[0].textContent, /91%/);
    assert.deepEqual(sections()[0].querySelectorAll('.usage-note').map(node => node.textContent), [tr('usage.header.endpointUnavailable')]);
    assert.equal(chip.getAttribute('title'), tr('usage.header.endpointUnavailable'));
    assert.match(sections()[1].textContent, /38%/);
    documentEvents.keydown({ key: 'Escape', isComposing: false });
    assert.equal(pop.hidden, true);
    assert.equal(document.activeElement, chip);
    open(); assert.equal(pop.hidden, false);
    documentEvents.click({ composedPath: () => [] }); assert.equal(pop.hidden, true); await tick();
    t.ok('互換の接続先にはサブスクの率を出さず、一覧を開いて Esc・外側で閉じられる', true);

    open(); await tick(); pop.querySelector('.usage-other-agents').querySelector('summary').focus();
    replies.set('current', () => Promise.resolve({ quota: { windows: [], accounts: [
      { label: 'Default', ...quota(63) },
      { label: 'Work', windows: [], needsUsageLogin: true, accountId: 'work' },
    ] } }));
    ui.turnEnded('current'); await tick(); ui.show({ backend: 'current', account: 'work' });
    unknownChip();
    const authorize = sections()[0].querySelector('button');
    assert.ok(authorize);
    assert.equal(document.activeElement, pop.querySelector('.usage-other-agents').querySelector('summary'));
    authorize.focus();
    ui.show({ backend: 'current' });
    assert.equal(document.activeElement, pop.querySelector('.usage-pop-body'));
    ui.show({ backend: 'current', account: 'work' });
    sections()[0].querySelector('button').onclick();
    assert.deepEqual(logins, ['work']); assert.equal(pop.hidden, true);
    await tick();
    ui.show({ backend: 'current' });
    assert.match(chip.textContent, /63%/);
    t.ok('未認可は同じ形の札からアカウントの認可へ進める', true);

    // 短い間隔の上限で止まっている枠（Issue #111）。日次・週次が 0% でも、札と一覧に止まっていることと解除の見込みを出す
    const heldUntil = new Date(Date.now() + 3 * 60_000).toISOString();
    replies.set('current', () => Promise.resolve({ label: 'Current', quota: quota(0),
      held: [{ model: 'swe-2-high', account: '', reason: 'recently_limited', until: heldUntil }] }));
    ui.turnEnded('current'); await tick();
    ui.show({ backend: 'current', model: 'swe-2-high' });
    assert.equal(chip.querySelector('.lb').textContent, tr('usage.header.heldLabel'));
    assert.ok(chip.classList.contains('high') && !chip.classList.contains('dim'));
    assert.doesNotMatch(chip.textContent, /0%/);
    assert.match(chip.getAttribute('title'), /swe-2-high/);
    open();
    const heldBox = sections()[0].querySelector('.usage-held');
    assert.ok(heldBox && heldBox.textContent.startsWith('swe-2-high'), sections()[0].textContent);
    documentEvents.keydown({ key: 'Escape', isComposing: false });
    ui.show({ backend: 'current', model: 'swe-1-6' });
    assert.notEqual(chip.querySelector('.lb').textContent, tr('usage.header.heldLabel'));
    assert.match(chip.textContent, /0%/);
    t.ok('会話の枠が短い上限で止まっていれば、0% の率の代わりに止まっていることを札に出し、一覧に解除の見込みを出す（別のモデルの会話には出さない）', true);

    // 5 時間の枠の上限（モデルを問わないアカウントの枠）。札は枠の名前で出し、「この会話」の一覧は会話のアカウントの枠だけ（2026-10-21、
    // 別のアカウントの枠や「opus」「既定のモデル」が 3 行並んだ）
    const fiveUntil = new Date(Date.now() + 2 * 3600_000).toISOString();
    await tick(); // 前の一覧を開いたときの取り直しが済んでから、返す値を替える
    replies.set('current', () => Promise.resolve({ label: 'Current', quota: quota(0),
      held: [{ model: null, account: '', reason: 'recently_limited', until: fiveUntil, resetsAt: fiveUntil, window: 'five_hour' },
        { model: null, account: 'work', reason: 'recently_limited', until: fiveUntil, resetsAt: null }] }));
    ui.turnEnded('current'); await tick();
    ui.show({ backend: 'current', model: 'opus' });
    assert.equal(chip.querySelector('.lb').textContent, tr('usage.held.windows.five_hour'));
    assert.ok(chip.classList.contains('high'));
    assert.match(chip.getAttribute('title'), new RegExp(tr('usage.held.windows.five_hour')));
    open();
    const fiveBox = sections()[0].querySelector('.usage-held');
    assert.equal(fiveBox.querySelectorAll('p').length, 1, fiveBox.textContent);
    assert.ok(fiveBox.textContent.startsWith(tr('usage.held.allModels')), fiveBox.textContent);
    documentEvents.keydown({ key: 'Escape', isComposing: false });
    t.ok('5 時間・週の枠の上限は札に枠の名前で出し、「この会話」の一覧には会話のアカウントの枠だけを 1 行で出す', true);
    await tick();
    const expired = { label: '5h', usedPercent: 96, resetsAt: new Date(Date.now() - 1000).toISOString() };
    const weekly = { label: 'week', usedPercent: 27, resetsAt: new Date(Date.now() + 7 * 86400_000).toISOString() };
    const staleResult = { label: 'Current', quota: { windows: [expired, weekly] }, held: [] };
    replies.set('current', () => Promise.resolve(staleResult));
    ui.turnEnded('current'); await tick();
    const updating = deferred(); replies.set('current', () => updating.promise);
    open(); await tick();
    assert.match(chip.textContent, /27%/); assert.doesNotMatch(chip.textContent, /96%/);
    assert.ok(sections()[0].textContent.includes(tr('usage.refreshing')));
    assert.equal(sections()[0].querySelector('.v').textContent, '—');
    assert.equal(pop.getAttribute('aria-busy'), 'true');
    assert.ok(pop.querySelector('.usage-refresh-icon'));
    assert.ok(chip.getAttribute('aria-label').includes(tr('usage.header.windowRefreshing', { window: '5h' })));
    updating.reject(new Error('offline')); await tick();
    assert.equal(pop.getAttribute('aria-busy'), 'false');
    assert.equal(pop.querySelector('.rf').getAttribute('aria-disabled'), 'false');
    assert.equal(pop.querySelector('.usage-refresh-icon'), null);
    assert.ok(sections()[0].textContent.includes(tr('usage.refreshFailed')));
    assert.equal(sections()[0].querySelectorAll('.usage-note').length, 0, '失敗理由を重ねて出さない');
    assert.match(chip.textContent, /27%/);
    const fresh = deferred(); replies.set('current', () => fresh.promise);
    const refreshButton = pop.querySelector('.rf');
    document.activeElement = refreshButton;
    pop.querySelector('.usage-other-agents').open = true;
    pop.querySelector('.usage-pop-body').scrollTop = 45;
    pop.querySelector('.rf').onclick(); await tick();
    assert.ok(sections()[0].textContent.includes(tr('usage.refreshing')));
    fresh.resolve({ label: 'Current', quota: { windows: [quota(4).windows[0], weekly] }, held: [] }); await tick();
    assert.equal(sections()[0].querySelector('.v').textContent, '4%');
    assert.equal(pop.getAttribute('aria-busy'), 'false'); assert.match(chip.textContent, /27%/);
    assert.equal(pop.querySelector('.rf'), refreshButton);
    assert.equal(document.activeElement, refreshButton);
    assert.equal(pop.querySelector('.usage-other-agents').hasAttribute('open'), true);
    assert.equal(pop.querySelector('.usage-pop-body').scrollTop, 45);
    const meter = sections()[0].querySelector('.usage-bar');
    assert.equal(meter.getAttribute('role'), 'meter');
    assert.equal(meter.getAttribute('aria-valuenow'), '4');
    assert.ok(meter.getAttribute('aria-description'));
    assert.equal(sections()[0].querySelector('.v').getAttribute('aria-hidden'), 'true');
    t.ok('更新中も更新ボタンとフォーカス・展開・本文のスクロールを保ち、枠の率を一度だけ読み上げる', true);
    replies.set('current', () => Promise.resolve(staleResult));
    ui.turnEnded('current'); await tick();
    assert.ok(sections()[0].textContent.includes(tr('usage.retryWait')));
    assert.equal(pop.querySelector('.usage-refresh-icon'), null);
    assert.doesNotMatch(sections()[0].textContent, /96%/);
    t.ok('リセット後は —・更新中・失敗を区別し、↻ で実測値へ戻す。同じ過去時刻でも回転は止まる', true);
    replies.set('current', () => Promise.resolve({ label: 'Current', quota: { ...quota(64), generation: 1, revision: 9 }, held: [] }));
    ui.turnEnded('current'); await tick(); assert.match(chip.textContent, /64%/);
    replies.set('current', () => Promise.resolve({ label: 'Current', quota: { generation: 2, revision: 1, windows: [], reason: 'no-login' }, held: [] }));
    ui.turnEnded('current'); await tick(); unknownChip();
    assert.equal(sections()[0].querySelector('.v'), null);
    assert.doesNotMatch(sections()[0].textContent, /64%/);
    t.ok('認可や世代が変わった後の空応答へ、前の対象の値を持ち越さない', true);
    const goWindows = [3, 6, 3].map((used, i) => ({ ...quota(used).windows[0], provider: 'opencode-go',
      label: ['Go 5h', 'Go week', 'Go month'][i], minutes: [300, 10080, null][i] }));
    const go = { provider: 'opencode-go', identity: 'go', state: 'ready', windows: goWindows, checkedAt: Date.now() };
    const chat = { provider: 'openai', identity: 'chat', state: 'ready', windows: [{ ...quota(24).windows[0], provider: 'openai', label: 'ChatGPT 5h' }] };
    const sendConnections = async connections => {
      replies.set('current', () => Promise.resolve({ label: 'Current', quota: { connections, windows: connections.flatMap(c => c.windows), generation: 3 }, held: [] }));
      ui.turnEnded('current'); await tick();
    };
    await sendConnections([go, chat]);
    ui.show({ backend: 'current', model: '', models: { '': { resolvesTo: 'opencode-go/kimi-k2.5' } } });
    assert.match(chip.textContent, /6%/); assert.doesNotMatch(chip.textContent, /24%/);
    assert.equal(sections()[0].querySelectorAll('.usage-provider')[0].textContent, 'Go');
    assert.match(sections()[0].querySelector('summary').textContent, /1/);
    ui.show({ backend: 'current', model: 'openai/gpt-6-sol' });
    assert.match(chip.textContent, /24%/);
    assert.equal(sections()[0].querySelectorAll('.usage-provider')[0].textContent, 'ChatGPT');
    ui.show({ backend: 'current', model: 'openrouter/model' }); unknownChip();
    assert.ok(sections()[0].textContent.includes(tr('usage.connection.unavailable')));
    ui.show({ backend: 'current', model: 'opencode-go/kimi-k2.5' });
    for (const [state, key] of [['expired', 'expired'], ['no-login', 'noLogin'], ['not-subscribed', 'notSubscribed'], ['failed', 'failed']]) {
      await sendConnections([{ ...go, state, windows: [], identity: state }]); unknownChip();
      assert.ok(sections()[0].textContent.includes(tr(`usage.connection.${key}`)));
    }
    await sendConnections([{ ...go, state: 'failed', staleSince: Date.now() - 600000 }]);
    assert.match(chip.textContent, /6%/); assert.ok(chip.classList.contains('dim'));
    assert.ok(chip.getAttribute('aria-label').includes(tr('usage.connection.failed')));
    t.ok('Go default resolves provider; current connection leads, others fold, states and stale chip stay distinct', true);

    const view = { left: 0, top: 0, right: 1280, bottom: 900 };
    assert.deepEqual(usagePopBounds({ left: 648, top: 780 }, { left: 292, right: 806, top: 0 }, view),
      { left: 458, width: 340, bottom: 774, maxHeight: 560 });
    assert.deepEqual(usagePopBounds({ left: 648, top: 235 }, { left: 292, right: 652, top: 0 }, { ...view, bottom: 360 }, 32),
      { left: 304, width: 340, bottom: 229, maxHeight: 189 });
    assert.deepEqual(usagePopBounds({ left: 400, top: 200 }, { left: 292, right: 580, top: 40 }, view),
      { left: 300, width: 272, bottom: 194, maxHeight: 146 });
    assert.equal(usagePopBounds({ left: 400, top: 300 }, { left: 292, right: 806, top: 0 }, { ...view, top: 100, bottom: 450 }).maxHeight, 186);
    t.ok('会話列・上端の帯・表示ビューポートの内側に幅と高さを収める', true);
  } finally {
    for (const stop of pagehide) stop();
    globalThis.document = globals.document;
    globalThis.window = globals.window;
  }
}
