// 画面のアカウントごとのモデル一覧・表示・選択（ADR 0326）:
//   - web/delegation-settings.mjs: modelsOf(backend, account) と候補追加メニューのアカウント絞り込み
//   - web/delegation-routing-view.mjs: routingLine / skippedPhrase / routingFailureParts / retryPanel が account を modelName へ渡す
//   - web/channels/bot-page.mjs: 作成下書きの account 選択で語彙引き直し、作成時は setAccount → update(model/effort)、アカウント更新イベントで S.vocab 破棄
//   - web/channels/thread-composer.mjs: host.vocab / host.efforts へ account を渡し、invalidateVocab() で取り直す
//   - web/history-pane.mjs / web/client.mjs: 作業の詳細（読むだけの筋）の発言者のモデル名は、会話のアカウントの一覧で引く
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { lang, setLanguage } from '../../web/i18n.mjs';
import { modelDisplayName } from '../../web/composer-labels.mjs';
import { cutFunction, readClientAndLiveTurn, readHistoryPane } from '../lib/cut-source.mjs';
import { setupDelegationSettings } from '../../web/delegation-settings.mjs';
import { routingLine, skippedPhrase, parseRoutingFailure, routingFailureParts, retryPanel } from '../../web/delegation-routing-view.mjs';
import { createBotPage } from '../../web/channels/bot-page.mjs';
import { createThreadComposer } from '../../web/channels/thread-composer.mjs';
import { COMPOSER_PARTS, rememberComposerTemplate } from '../../web/composer/composer.mjs';
import { el } from '../../web/dom.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'web-account-models';
export const title = '画面: 委譲設定・委譲表示・bot ページ・スレッド入力欄のアカウント別モデル一覧';

const tick = () => new Promise((r) => setImmediate(r));

export default async function (t) {
  const prevLang = lang;
  await setLanguage('ja');

  const saved = {
    getElementById: document.getElementById,
    createElement: document.createElement,
    createTextNode: document.createTextNode,
    createRange: document.createRange,
    createTreeWalker: document.createTreeWalker,
    body: document.body,
    NodeFilter: globalThis.NodeFilter,
    dispatchEvent: document.dispatchEvent,
    addEventListener: document.addEventListener,
    removeEventListener: document.removeEventListener,
    visibilityState: document.visibilityState,
    documentElement: document.documentElement,
    activeElement: document.activeElement,
    click: N.prototype.click,
    focus: N.prototype.focus,
    getBoundingClientRect: N.prototype.getBoundingClientRect,
    closest: N.prototype.closest,
    matches: N.prototype.matches,
    cloneNode: N.prototype.cloneNode,
    nodeType: N.prototype.nodeType,
    parentElementDesc: Object.getOwnPropertyDescriptor(N.prototype, 'parentElement'),
    getComputedStyle: globalThis.getComputedStyle,
    MutationObserver: globalThis.MutationObserver,
    getSelection: globalThis.getSelection,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
    innerHeight: globalThis.innerHeight,
    matchMedia: globalThis.matchMedia,
    addEvGlobal: globalThis.addEventListener,
    removeEvGlobal: globalThis.removeEventListener,
    CSS: globalThis.CSS,
    localStorage: globalThis.localStorage,
  };

  try {
    N.prototype.click = function () { this.onclick?.({ target: this }); this.dispatchEvent({ type: 'click', target: this }); };
    N.prototype.focus = function () { if (!this.disabled) document.activeElement = this; };
    N.prototype.getBoundingClientRect = function () { return { left: 10, top: 100, bottom: 130, right: 120, width: 110, height: 30 }; };
    N.prototype.closest = function (sel) {
      let x = this;
      while (x) { if (typeof x.matches === 'function' && x.matches(sel)) return x; x = x.parent; }
      return null;
    };
    N.prototype.matches = function (sel) {
      const m = /^\[([a-z0-9_-]+)\]$/.exec(String(sel).trim());
      if (m) return m[1] === 'id' ? Boolean(this.attrs.id) : m[1] in this.attrs;
      return saved.matches.call(this, sel);
    };
    N.prototype.cloneNode = function cloneNode(deep = false) {
      const copy = new N(this.tagName.toLowerCase());
      copy.attrs = { ...this.attrs };
      copy.style.removeProperty = (k) => { delete copy.style[k]; };
      copy._text = this._text;
      copy._html = this._html;
      if ('hidden' in this) copy.hidden = this.hidden;
      if ('value' in this) copy.value = this.value;
      if ('selectionStart' in this) copy.selectionStart = this.selectionStart;
      if ('selectionEnd' in this) copy.selectionEnd = this.selectionEnd;
      if (typeof this.setSelectionRange === 'function') copy.setSelectionRange = this.setSelectionRange;
      if (typeof this.setRangeText === 'function') copy.setRangeText = this.setRangeText;
      if (deep) for (const c of this.children) copy.append(typeof c.cloneNode === 'function' ? c.cloneNode(true) : { ...c, parent: null });
      return copy;
    };
    if (!saved.parentElementDesc) Object.defineProperty(N.prototype, 'parentElement', { configurable: true, get() { return this.parent; } });
    N.prototype.nodeType = 1;
    globalThis.getComputedStyle = () => ({ lineHeight: '22px', paddingTop: '4px', paddingBottom: '4px' });
    globalThis.MutationObserver = class {
      constructor() { this.q = []; }
      observe(target) {
        for (const m of ['append', 'prepend', 'replaceChildren', 'insertBefore']) {
          const orig = target[m];
          target[m] = (...a) => { this.q.push({ type: 'childList', target }); return orig.apply(target, a); };
        }
      }
      disconnect() {}
      takeRecords() { return this.q.splice(0); }
    };
    globalThis.getSelection = () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} });
    globalThis.requestAnimationFrame = () => 0;
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    document.body = el('body');
    document.createRange = () => {
      let node = null;
      return { selectNodeContents(n) { node = n; }, setStart() {}, setEnd() {}, toString() { return node?.textContent ?? ''; } };
    };
    document.createTreeWalker = (rootNode) => {
      const nodes = [];
      const walk = (n) => { for (const c of n.children ?? []) { if (c.nodeType === 3) nodes.push(c); walk(c); } };
      walk(rootNode);
      let i = 0;
      return { nextNode: () => nodes[i++] ?? null };
    };
    document.createElement = (t) => {
      const n = saved.createElement(t);
      n.style.removeProperty = (k) => { delete n.style[k]; };
      return n;
    };
    document.createTextNode = (s) => ({ nodeValue: String(s), textContent: String(s), outerHTML: String(s), nodeType: 3, parent: null, children: [], dataset: {}, matches: () => false, contains: () => false });
    const docListeners = new Map();
    document.addEventListener = (type, fn) => { const list = docListeners.get(type) ?? []; list.push(fn); docListeners.set(type, list); };
    document.removeEventListener = (type, fn) => { if (docListeners.has(type)) docListeners.set(type, docListeners.get(type).filter((f) => f !== fn)); };
    document.dispatchEvent = (ev) => { for (const fn of docListeners.get(ev.type) ?? []) fn(ev); return true; };
    document.visibilityState = 'visible';
    document.documentElement = { clientWidth: 1024 };
    globalThis.window = { innerHeight: 800, innerWidth: 1024 };
    globalThis.innerHeight = 800;
    globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
    globalThis.CSS = { escape: (s) => String(s) };
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

    // ---- 1. delegation-settings.mjs: modelsOf(backend, account) と候補追加メニューのアカウント絞り込み
    {
      const modelsByAcct = {
        '': { '': { label: '既定', resolvesTo: 'sonnet' }, sonnet: { label: 'Sonnet' }, opus: { label: 'Opus' } },
        verified: { '': { label: '既定', resolvesTo: 'sonnet' }, sonnet: { label: 'Sonnet' }, opus: { label: 'Opus' }, 'claude-mythos-5-2': { label: 'Mythos 5.2' } },
        plain: { '': { label: '既定', resolvesTo: 'sonnet' }, sonnet: { label: 'Sonnet' }, opus: { label: 'Opus' } },
      };
      const modelsOfCalls = [];
      const modelNameCalls = [];
      const defaults = { enabled: true, judge: 'perplexity/pplx-decider-v1.2', levels: [{ id: 't4', name: '' }], kinds: [{ id: 'design', name: '', desc: '' }],
        tiers: { t4: ['claude@verified:claude-mythos-5-2', 'claude@plain:sonnet'] }, table: { design: ['t4', 't4', 't4'] },
        efforts: { t4: { '*': 'high' } }, avoidPercent: 80, paceLimit: 1.5 };
      const settings = structuredClone(defaults);
      const state = () => structuredClone({
        settings, defaults, key: { hasKey: true, via: 'key' },
        candidates: [
          { candidate: 'claude@verified:claude-mythos-5-2', backend: 'claude', model: 'claude-mythos-5-2', scoped: true, account: 'verified', accountLabel: 'verified', usable: true, windows: [] },
          { candidate: 'claude@plain:sonnet', backend: 'claude', model: 'sonnet', scoped: true, account: 'plain', accountLabel: 'plain', usable: true, windows: [] },
        ],
        warnings: [],
        accounts: {
          claude: [
            { account: '', name: null, ready: true },
            { account: 'verified', name: 'verified', ready: true },
            { account: 'plain', name: 'plain', ready: true },
            { account: 'dead', name: 'broken', ready: false, reason: 'no_token' },
          ],
        },
        storage: { encrypted: true },
      });
      const menus = [];
      const root = el('div'), tab = el('button');
      document.getElementById = (id) => ({ delegationPanel: root, delegationTab: tab })[id] ?? null;

      const ui = setupDelegationSettings({
        cmd: async (n) => (n === 'invoke' ? { keys: [] } : state()),
        page() {},
        showMenu: (_x, _y, items, title) => menus.push({ items, title }),
        labelOf: (id) => ({ claude: 'Claude' })[id] ?? id,
        logo: () => el('span'),
        modelsOf: async (b, acct = '') => { modelsOfCalls.push([b, acct]); return modelsByAcct[acct] ?? {}; },
        modelName: (b, m, acct = '') => { modelNameCalls.push([b, m, acct]); return modelsByAcct[acct]?.[m]?.label ?? ''; },
        agents: () => ['claude'],
      });
      await ui.refresh();

      assert.ok(modelsOfCalls.some(([b, a]) => b === 'claude' && a === 'verified'), JSON.stringify(modelsOfCalls));
      assert.ok(modelsOfCalls.some(([b, a]) => b === 'claude' && a === 'plain'), JSON.stringify(modelsOfCalls));
      const rows = root.querySelectorAll('.rt-cand-row');
      assert.equal(rows[0].querySelector('.rt-label').textContent.replace(/\u00a0/g, ' '), 'Mythos 5.2 · verified');
      assert.ok(modelNameCalls.some(([b, m, a]) => b === 'claude' && m === 'claude-mythos-5-2' && a === 'verified'), JSON.stringify(modelNameCalls));

      // 追加メニュー: 候補に入っている組み合わせは出ないので、tier から一旦外してから開く
      settings.tiers.t4 = ['claude@plain:sonnet'];
      await ui.refresh();
      root.querySelector('.rt-add').onclick({ currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } });
      await tick();
      const claudeSub = menus.at(-1).items.find((i) => i.label === 'Claude').sub();
      const mythosItem = claudeSub.find((i) => i.label === 'Mythos 5.2');
      assert.ok(Boolean(mythosItem), claudeSub.map((i) => i.label).join(','));
      const mythosAccts = mythosItem.sub().map((i) => i.label);
      // 承認のあるアカウントと未取得(dead) だけが出て、Mythos を持たない ready なアカウントとログイン中のアカウントは絞られる
      assert.equal(mythosAccts.includes('verified'), true, mythosAccts.join(','));
      assert.equal(mythosAccts.includes('broken'), true, mythosAccts.join(','));
      assert.equal(mythosAccts.includes('plain'), false, mythosAccts.join(','));
      assert.equal(mythosAccts.includes('ログイン中のアカウント'), false, mythosAccts.join(','));
      const sonnetAccts = claudeSub.find((i) => i.label === 'Sonnet').sub().map((i) => i.label);
      assert.equal(sonnetAccts.includes('verified') && sonnetAccts.includes('broken'), true);

      const countBeforeEvent = modelsOfCalls.length;
      await ui.event({ type: 'claudeAccountsChanged' });
      assert.ok(modelsOfCalls.length > countBeforeEvent);
      t.ok('delegation-settings: アカウント別に modelsOf を引き、追加メニューも各アカウントの一覧で絞る', true);
    }

    // ---- 2. delegation-routing-view.mjs: names.model に account が渡る
    {
      const seen = [];
      const names = {
        backend: (id) => ({ claude: 'Claude' })[id] ?? id,
        model: (b, m, account = '') => {
          seen.push([b, m, account]);
          if (b === 'claude' && m === 'claude-mythos-5-2' && account === 'verified') return 'Mythos 5.2';
          if (b === 'claude' && m === 'sonnet') return 'Sonnet';
          return m;
        },
      };
      const rLine = routingLine({
        mode: 'auto', kind: 'design', judge: 'none', fallback: 'same_level', signals: {}, difficulty: 'high',
        baseTier: 't4', tier: 't4',
        target: { backend: 'claude', model: 'claude-mythos-5-2', account: 'verified' },
        skipped: [{ candidate: 'claude@plain:sonnet', reason: 'quota_high', account: 'plain', window: { label: '週次', usedPercent: 84 } }],
      }, names);
      assert.ok(rLine.includes('Mythos 5.2') && rLine.includes('Sonnet'));
      assert.ok(seen.some(([b, m, a]) => b === 'claude' && m === 'claude-mythos-5-2' && a === 'verified'), JSON.stringify(seen));
      assert.ok(seen.some(([b, m, a]) => b === 'claude' && m === 'sonnet' && a === 'plain'), JSON.stringify(seen));

      seen.length = 0;
      const failText = '使える委譲先がありません（種類 design、難しさ mid）。飛ばした候補:\n- claude@verified:claude-mythos-5-2 [verified] (t4): quota_full 週次 100%';
      const parsed = parseRoutingFailure(failText);
      const [, fold] = routingFailureParts(parsed, { names });
      assert.ok(fold.textContent.includes('Mythos 5.2'), fold.textContent);
      assert.ok(seen.some(([b, m, a]) => b === 'claude' && m === 'claude-mythos-5-2' && a === 'verified'), JSON.stringify(seen));

      seen.length = 0;
      const panelEl = retryPanel({
        candidates: [{ candidate: 'claude@verified:claude-mythos-5-2', backend: 'claude', model: 'claude-mythos-5-2', account: 'verified', accountLabel: 'verified', usable: true, windows: [] }],
        running: false, names, run: async () => ({}), close() {},
      });
      assert.ok(panelEl.textContent.includes('Mythos 5.2'));
      assert.ok(seen.some(([b, m, a]) => b === 'claude' && m === 'claude-mythos-5-2' && a === 'verified'), JSON.stringify(seen));
      t.ok('delegation-routing-view: 結果行・省略理由・失敗内訳・やり直し候補で model(b, m, account) へ account を渡す', true);
    }

    // ---- 3. bot-page.mjs: 作成下書きの account 切替で語彙を引き直し、保存時は setAccount → update の順
    {
      const body = el('div');
      body.id = 'channelsBody';
      const titleEl = el('div');
      titleEl.id = 'channelsPageTitle';
      document.getElementById = (id) => ({ channelsBody: body, channelsPageTitle: titleEl })[id] ?? null;

      const vocabCalls = [];
      const invokeOrder = [];
      const pageHost = {
        state: {
          backend: 'claude', cwd: '/w', account: '', sessions: [],
          backends: [{ id: 'claude', label: 'Claude', capabilities: { accounts: 'token' } }],
        },
        vocab: async (backend, cwd, opts = {}) => {
          const account = opts?.account ?? '';
          vocabCalls.push({ backend, cwd, account });
          const models = {
            '': { label: '既定', resolvesTo: 'sonnet' },
            sonnet: { label: 'Sonnet', note: '' },
            ...(account === 'verified' ? { 'claude-mythos-5-2': { label: 'Mythos 5.2', note: 'share' } } : {}),
          };
          return { modes: { default: { label: '標準', scope: 'workspace', autonomy: 'ask' } }, models, efforts: { '': { label: '既定' }, high: { label: '高' } } };
        },
        cmd: async (op, args = {}) => {
          if (op === 'modes') return { default: { label: '標準', scope: 'workspace', autonomy: 'ask' } };
          if (op === 'efforts') return { '': { label: '既定' }, high: { label: '高' } };
          if (op === 'claudeAccounts') return { accounts: [{ id: 'verified', name: 'verified', hasToken: true }, { id: 'plain', name: 'plain', hasToken: true }] };
          if (op === 'models') return (await pageHost.vocab(args.backend, args.cwd, { account: args.account })).models;
          return {};
        },
        efforts: async () => ({ '': { label: '既定' }, high: { label: '高' } }),
        backends: () => [{ id: 'claude', label: 'Claude', capabilities: { accounts: 'token' } }],
        backendLabel: (id) => ({ claude: 'Claude' })[id] ?? id,
        accountsEnabled: (id) => id === 'claude',
        accountList: () => [{ id: 'verified', name: 'verified', ready: true }, { id: 'plain', name: 'plain', ready: true }],
        accountName: (id) => ({ verified: 'verified', plain: 'plain' })[id] ?? id,
        quotaOf: () => null,
        askQuota: async () => null,
        invoke: async (op, args) => {
          invokeOrder.push([op, args]);
          if (op === 'bots.list') return { bots: [] };
          if (op === 'channels.list') return { channels: [] };
          if (op === 'bots.get') return { id: 'b_new_1', name: 'MythosBot', icon: '', backend: 'claude', account: 'verified', model: 'claude-mythos-5-2', effort: '', mode: 'default', folders: [], sendToOthers: true, sendTargets: [] };
          if (op === 'bots.create') return { id: 'b_new_1', name: args.name, icon: '', backend: 'claude', account: '', model: '', effort: '', mode: 'default', folders: [], sendToOthers: true, sendTargets: [] };
          if (op === 'bots.setAccount') return { id: 'b_new_1', name: 'MythosBot', icon: '', backend: 'claude', account: args.account, model: '', effort: '', mode: 'default', folders: [], sendToOthers: true, sendTargets: [] };
          if (op === 'bots.update') return { id: 'b_new_1', name: 'MythosBot', icon: '', backend: 'claude', account: 'verified', model: args.model ?? '', effort: args.effort ?? '', mode: 'default', folders: [], sendToOthers: true, sendTargets: [] };
          return {};
        },
      };

      const page = createBotPage(pageHost);
      page.show({ kind: 'bot', id: 'new' });
      await tick();
      await tick();

      const botView = body.querySelector('#botView');
      const nameIn = botView.querySelector('#botName');
      nameIn.value = 'MythosBot';
      nameIn.dispatchEvent({ type: 'input' });

      // モデル面を開いて承認のあるアカウントを選ぶ → そのアカウント向けの vocab を引き直す
      botView.querySelector('#botModelChip').click();
      await tick();
      await tick();
      const acctBtn = botView.querySelector('#botModelPop').querySelectorAll('button').find((b) => b.dataset?.key === 'account:verified');
      assert.ok(Boolean(acctBtn), 'bot ページのモデル面にアカウント選択行が出る');
      acctBtn.click();
      for (let i = 0; i < 5; i++) await tick();
      assert.ok(vocabCalls.some((c) => c.backend === 'claude' && c.account === 'verified'), JSON.stringify(vocabCalls));

      const mythosBtn = botView.querySelector('#botModelPop').querySelectorAll('button').find((b) => b.dataset?.key === 'model:claude-mythos-5-2');
      assert.ok(Boolean(mythosBtn), '承認のあるアカウントを選ぶと Mythos 5.2 が選択肢に出る');
      mythosBtn.click();
      for (let i = 0; i < 5; i++) await tick();

      // 作成を押すと create(model なし) → setAccount('verified') → update(model: 'claude-mythos-5-2') の順
      botView.querySelector('.bp-create').click();
      for (let i = 0; i < 8; i++) await tick();
      const seq = invokeOrder.filter(([op]) => op === 'bots.create' || op === 'bots.setAccount' || op === 'bots.update');
      assert.equal(seq.length, 3, JSON.stringify(seq));
      assert.equal(seq[0][0], 'bots.create');
      assert.equal(seq[0][1].model, undefined);
      assert.equal(seq[1][0], 'bots.setAccount');
      assert.equal(seq[1][1].account, 'verified');
      assert.equal(seq[2][0], 'bots.update');
      assert.equal(seq[2][1].model, 'claude-mythos-5-2');

      // アカウント更新イベントで S.vocab を捨て、再取得する
      const vBefore = vocabCalls.length;
      page.onEvent({ type: 'claudeAccountsChanged' });
      for (let i = 0; i < 5; i++) await tick();
      assert.ok(vocabCalls.length > vBefore, 'claudeAccountsChanged で語彙を引き直す');
      t.ok('bot-page: 下書きの account ごとに語彙を引き直し、作成は setAccount の後に update で model を保存する', true);
    }

    // ---- 4. thread-composer.mjs: vocab / efforts に account を渡し、invalidateVocab で引き直す
    {
      const templateForm = el('form', 'composer');
      templateForm.id = 'composer';
      const cbox = el('div', 'cbox');
      cbox.id = 'cbox';
      const rowDiv = el('div', 'crow');
      for (const id of COMPOSER_PARTS) {
        if (id === 'composer' || id === 'cbox') continue;
        const tag = id === 'prompt' ? 'textarea' : id === 'fileIn' ? 'input'
          : ['send', 'sendMore', 'attach', 'cwdChip', 'modelChip', 'armedChip', 'abort', 'resume', 'workEntryButton', 'draftFailRetry'].includes(id) ? 'button' : 'div';
        const n = el(tag);
        n.id = id;
        if (['cwdPop', 'modelPop', 'sendPop', 'sendVeil'].includes(id)) n.hidden = true;
        if (id === 'prompt') { n.value = ''; n.selectionStart = 0; n.selectionEnd = 0; n.setSelectionRange = () => {}; n.setRangeText = () => {}; }
        if (['attach', 'cwdChip', 'modelChip', 'send'].includes(id)) rowDiv.append(n);
        else if (id === 'prompt') cbox.append(n);
        else templateForm.append(n);
      }
      cbox.append(rowDiv);
      templateForm.append(cbox);
      rememberComposerTemplate(templateForm);

      const vocabSeen = [];
      const effortsSeen = [];
      let currentAccount = 'verified';
      const compHost = {
        state: { backend: 'claude', cwd: '/w', sessions: [] },
        vocab: async (backend, cwd = '', account = '') => {
          vocabSeen.push({ backend, cwd, account });
          return { modes: { default: { label: '標準', scope: 'workspace', autonomy: 'ask' } }, models: { sonnet: { label: 'Sonnet' }, ...(account === 'verified' ? { 'claude-mythos-5-2': { label: 'Mythos 5.2' } } : {}) }, efforts: {} };
        },
        efforts: async (args) => {
          effortsSeen.push(args);
          return { '': { label: '既定' }, high: { label: '高' } };
        },
        backends: () => [{ id: 'claude', label: 'Claude', capabilities: { accounts: 'token' } }],
        backendLabel: (id) => ({ claude: 'Claude' })[id] ?? id,
        accountsEnabled: (id) => id === 'claude',
        accountList: () => [{ id: 'verified', name: 'verified', ready: true }, { id: 'plain', name: 'plain', ready: true }],
        accountName: (id) => ({ verified: 'verified', plain: 'plain' })[id] ?? id,
        quotaOf: () => null,
        cmd: async () => ({}),
        showMenu() {},
      };
      const tc = createThreadComposer({
        host: compHost,
        candidates: () => [],
        backendLabel: (b) => b,
        onSend: async () => {},
        dest: () => ({ inThread: [{ id: 'b1', name: 'B1', icon: '🤖', state: 'idle', account: currentAccount }], others: [], fallback: 'b1' }),
        settings: () => ({
          backend: 'claude', account: currentAccount,
          values: { model: currentAccount === 'verified' ? 'claude-mythos-5-2' : 'sonnet', effort: 'high', mode: 'default', cwd: '/w' },
          defaults: { model: '', effort: '', mode: 'default' },
          folders: ['/w'],
        }),
      });
      try {
        tc.refresh();
        await tick();
        const destChipEl = tc.el.querySelector('.dest');
        assert.ok(Boolean(destChipEl), 'スレッド入力欄の宛先チップが存在する');
        destChipEl.click();
        await tick();
        assert.ok(vocabSeen.some((v) => v.backend === 'claude' && v.account === 'verified'), JSON.stringify(vocabSeen));
        assert.ok(effortsSeen.some((e) => e.backend === 'claude' && e.model === 'claude-mythos-5-2' && e.account === 'verified'), JSON.stringify(effortsSeen));

        // invalidateVocab + アカウント切り替えで新しい account 向けに再取得される
        const beforePlain = vocabSeen.length;
        currentAccount = 'plain';
        tc.invalidateVocab();
        await tick();
        assert.ok(vocabSeen.length > beforePlain && vocabSeen.at(-1).account === 'plain', JSON.stringify(vocabSeen));
        assert.ok(effortsSeen.some((e) => e.backend === 'claude' && e.model === 'sonnet' && e.account === 'plain'), JSON.stringify(effortsSeen));
        t.ok('thread-composer: host.vocab / host.efforts に account を渡し、invalidateVocab で引き直す', true);
      } finally {
        tc.destroy();
      }
    }

    // ---- 作業の詳細（読むだけの筋）の発言者のモデル名は、会話のアカウントの一覧で引く（最後に読んだ別アカウントの一覧で引かない）
    {
      const source = readClientAndLiveTurn();
      const whoSpan = { textContent: '' };
      const asked = [];
      // 一覧の行の名前が、id の形から読んだ名前（Mythos 5.2）と違う形にして、どの一覧で引いたかを見分ける
      const vocabs = {
        verified: { models: { 'claude-mythos-5-2': { label: 'Mythos 5.2（一覧の名前）' } } },
        plain: { models: { sonnet: { label: 'Sonnet 5.5' } } },
      };
      const context = vm.createContext({
        systemHistoryNode: () => undefined,
        aiMsg: () => ({ querySelector: () => whoSpan, append() {} }),
        modelDisplayName,
        backendVocab: (backend, account) => { asked.push([backend, account]); return vocabs[account] ?? null; },
        toolNodes: () => [], subagentToolsOf: () => new Set(), activeBackendId: () => 'claude', currentSession: () => 's1',
      });
      vm.runInContext(`${cutFunction(readHistoryPane(), 'historyRow')}\nthis.historyRow = historyRow;`, context);
      const speak = (account, extra = {}) => {
        whoSpan.textContent = '';
        context.historyRow({ role: 'assistant', model: 'claude-mythos-5-2', toolCalls: [] }, { readonly: true, backend: 'claude', account, ...extra });
        return whoSpan.textContent;
      };
      t.ok('読むだけの筋: 発言者のモデル名は、会話のアカウントの一覧の名前で出す', speak('verified') === 'Mythos 5.2（一覧の名前）' && asked.at(-1)?.join('|') === 'claude|verified', JSON.stringify(asked));
      t.ok('読むだけの筋: 一覧に無いモデルは、そのアカウントの一覧でも別のアカウントの一覧の名前を借りず、id の形から読む', speak('plain') === 'Mythos 5.2' && asked.at(-1)?.join('|') === 'claude|plain', JSON.stringify(asked));
      whoSpan.textContent = '';
      asked.length = 0;
      context.historyRow({ role: 'assistant', model: 'claude-mythos-5-2', toolCalls: [] }, { backend: 'claude', account: 'verified' });
      t.ok('読むだけの筋でない行（メインパネル）は発言者の名前を替えず、一覧も引かない', whoSpan.textContent === '' && asked.length === 0);

      // 配線: 詳細の筋・子の会話の面・主の面が、会話のアカウントの一覧（cachedVocabFor）を引く。最後に読んだ一覧（state.vocab）を引かない
      const body = (name) => cutFunction(source, name);
      t.ok('詳細の筋は historyRow へ項目のアカウントを渡す', body('readonlyThread').includes('account: itemAccount(item)'));
      t.ok('子の会話の面の backendVocab は、その会話のアカウントの一覧を引く', body('createModalChildView').includes('backendVocab: (backend, acct = \'\') => cachedVocabFor(backend, acct || account)'));
      t.ok('主の面の backendVocab も、渡されたアカウントの一覧を引く', source.includes('backendVocab: (backend, account = \'\') => cachedVocabFor(backend, account)')
        && !source.includes('backendVocab: (backend) => state.vocab.get(backend)'));
      t.ok('固定の委譲の内訳の承認モードの見出しも、委譲先のアカウントの一覧を引く', body('pinnedFacts').includes('cachedVocabFor(routing.target.backend, routing.target.account ?? task.account ?? \'\')'));
    }
  } finally {
    document.getElementById = saved.getElementById;
    document.createElement = saved.createElement;
    document.createTextNode = saved.createTextNode;
    document.createRange = saved.createRange;
    document.createTreeWalker = saved.createTreeWalker;
    document.body = saved.body;
    globalThis.NodeFilter = saved.NodeFilter;
    document.dispatchEvent = saved.dispatchEvent;
    document.addEventListener = saved.addEventListener;
    document.removeEventListener = saved.removeEventListener;
    document.visibilityState = saved.visibilityState;
    document.documentElement = saved.documentElement;
    document.activeElement = saved.activeElement;
    N.prototype.click = saved.click;
    N.prototype.focus = saved.focus;
    N.prototype.getBoundingClientRect = saved.getBoundingClientRect;
    N.prototype.closest = saved.closest;
    N.prototype.matches = saved.matches;
    N.prototype.cloneNode = saved.cloneNode;
    N.prototype.nodeType = saved.nodeType;
    if (saved.parentElementDesc) Object.defineProperty(N.prototype, 'parentElement', saved.parentElementDesc);
    else delete N.prototype.parentElement;
    globalThis.getComputedStyle = saved.getComputedStyle;
    globalThis.MutationObserver = saved.MutationObserver;
    globalThis.getSelection = saved.getSelection;
    globalThis.requestAnimationFrame = saved.requestAnimationFrame;
    globalThis.window = saved.window;
    globalThis.innerHeight = saved.innerHeight;
    globalThis.matchMedia = saved.matchMedia;
    globalThis.addEventListener = saved.addEvGlobal;
    globalThis.removeEventListener = saved.removeEvGlobal;
    globalThis.CSS = saved.CSS;
    globalThis.localStorage = saved.localStorage;
    await setLanguage(prevLang);
  }
}
