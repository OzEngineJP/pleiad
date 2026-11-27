// 画面のアカウントごとのモデル一覧・表示・選択（ADR 0329）:
//   - web/delegation-settings.mjs: modelsOf(backend, account) と候補追加メニューのアカウント絞り込み
//   - web/delegation-routing-view.mjs: routingLine / skippedPhrase / routingFailureParts / retryPanel が account を modelName へ渡す
//   - web/channels/bot-page.mjs: 候補のアカウントごとの語彙とモデルの保存、接続先の再取得。
//     作るのは 3 段（名前 → 色 → 人格）で bots.create を 1 回だけ呼び、DM へ移る（ADR 0362）
//     互換の接続先（ADR 0359）: 候補と見出しに接続先の名前、消えた・使えない接続先は一文で知らせる
//   - web/channels/thread-composer.mjs: 宛先・設定のチップを持たず、語彙を取りに行かない（ADR 0362）
//   - web/history-pane.mjs / web/client.mjs: 作業の詳細（読むだけの筋）の発言者のモデル名は、会話のアカウントの一覧で引く
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { lang, setLanguage, t as tr } from '../../web/i18n.mjs';
import { modelDisplayName } from '../../web/composer-labels.mjs';
import { cutFunction, readClientAndLiveTurn, readHistoryPane } from '../lib/cut-source.mjs';
import { setupDelegationSettings } from '../../web/delegation-settings.mjs';
import { routingLine, skippedPhrase, parseRoutingFailure, routingFailureParts, retryPanel } from '../../web/delegation-routing-view.mjs';
import { createBotPage } from '../../web/channels/bot-page.mjs';
import { createThreadComposer } from '../../web/channels/thread-composer.mjs';
import { COMPOSER_PARTS, rememberComposerTemplate } from '../../web/composer/composer.mjs';
import { el } from '../../web/dom.mjs';
import { N, stubPickerGeometry } from '../lib/dom-stub.mjs';
import { keepProps } from '../lib/keep-props.mjs';
import { botCandidates, botRoutingDefaults } from '../../core/bots/routing.mjs';
import { parseCandidate } from '../../core/delegation-routing.mjs';

export const name = 'web-account-models';
export const title = '画面: 委譲設定・委譲表示・bot ページ・スレッド入力欄のアカウント別モデル一覧';

const tick = () => new Promise((r) => setImmediate(r));

function botRoutingView(bot) {
  const defaults = botRoutingDefaults(bot);
  const settings = bot.settings ?? defaults;
  return {
    defaults, settings,
    candidates: botCandidates(settings).map(candidate => ({ candidate, ...parseCandidate(candidate, { allowDefault: true }), usable: true })),
    accounts: { claude: [{ account: '' }, { account: 'verified', name: 'verified' }, { account: 'plain', name: 'plain' }] },
    endpoints: { claude: [{ id: 'ep-good', name: '社内 gateway', kind: 'anthropic', state: 'ready', models: ['glm-5'], roles: { main: 'glm-5' } }] },
  };
}

function routingPrimary(settings) {
  const { backend, model, account, endpoint } = parseCandidate(botCandidates(settings)[0], { allowDefault: true });
  return { backend, model: model ?? '', account: account ?? '', endpoint: endpoint ?? '', settings };
}

const candidateChip = view => view.querySelector('.rt-picker-chip');
const candidateOption = (view, key) => view.querySelector('.rt-picker').querySelectorAll('button').find(b => b.dataset?.key === key);

/** web/client.mjs の connChoices と同じ形の取得口（CLI のログイン + アカウント 2 つ + 互換の接続先 1 つ。失敗している接続先 failed-ep も 1 つ） */
function connChoicesFake() {
  const EPS = [
    { id: 'ep-good', name: '社内 gateway', kind: 'anthropic', baseUrl: 'https://gw.example', ready: true, models: ['glm-5'], modelInfo: {}, roles: { main: 'glm-5' } },
    { id: 'failed-ep', name: '壊れた接続先', kind: 'anthropic', baseUrl: 'https://bad.example', ready: false, models: [], modelInfo: {}, roles: {} },
  ];
  return {
    load: async () => {},
    accounts: (backend, value) => (backend !== 'claude' ? null : [
      { value: '', label: 'CLI のログイン', hint: '公式', isDefault: true },
      { value: 'verified', label: 'verified', hint: '公式' },
      { value: 'plain', label: 'plain', hint: '公式' },
      ...(value && !['verified', 'plain'].includes(value) ? [{ value, label: '削除された接続先', hint: '選び直してください', gone: true }] : []),
    ]),
    endpointView: (backend, selected) => {
      if (backend !== 'claude') return null;
      const row = EPS.find((e) => e.id === selected) ?? null;
      return {
        selected, row, lost: null, roleNames: [],
        options: [
          { value: '', label: 'CLI のログイン', sub: '公式', isDefault: true },
          ...EPS.map((e) => ({ value: e.id, label: e.name, sub: e.baseUrl, warn: e.ready === false, isDefault: e.id === 'ep-good' })),
          ...(selected && !row ? [{ value: selected, label: '削除された接続先', sub: '選び直してください', gone: true }] : []),
        ],
        manage: null,
      };
    },
    hasAccounts: (backend) => backend === 'claude',
  };
}

export default async function (t) {
  const prevLang = lang;
  await setLanguage('ja');

  // 差し替える項目は、元の記述を控えて finally で戻す。元から無かった項目は delete する
  // （値 undefined で残すと、同じ worker で後に流れる suite の `in` の判定が「ある」と読む）
  const restores = [
    keepProps(document, ['getElementById', 'createElement', 'createTextNode', 'createRange', 'createTreeWalker', 'body', 'dispatchEvent', 'addEventListener', 'removeEventListener', 'visibilityState', 'documentElement', 'activeElement']),
    keepProps(N.prototype, ['click', 'focus', 'getBoundingClientRect', 'closest', 'matches', 'cloneNode', 'nodeType', 'parentElement']),
    keepProps(globalThis, ['NodeFilter', 'getComputedStyle', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'window', 'innerHeight', 'matchMedia', 'addEventListener', 'removeEventListener', 'CSS', 'localStorage']),
  ];
  // 差し替えた関数の中から呼ぶ元の実装
  const saved = {
    createElement: document.createElement,
    matches: N.prototype.matches,
    parentElementDesc: Object.getOwnPropertyDescriptor(N.prototype, 'parentElement'),
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
      const root = el('div'), tab = el('button');
      document.getElementById = (id) => ({ delegationPanel: root, delegationTab: tab })[id] ?? null;

      const ui = setupDelegationSettings({
        cmd: async (n) => (n === 'invoke' ? { keys: [] } : state()),
        page() {},
        showMenu() {},
        labelOf: (id) => ({ claude: 'Claude' })[id] ?? id,
        modelsOf: async (b, acct = '') => { modelsOfCalls.push([b, acct]); return modelsByAcct[acct] ?? {}; },
        modelName: (b, m, acct = '') => { modelNameCalls.push([b, m, acct]); return modelsByAcct[acct]?.[m]?.label ?? ''; },
        agents: () => ['claude'],
      });
      await ui.refresh();

      assert.ok(modelsOfCalls.some(([b, a]) => b === 'claude' && a === 'verified'), JSON.stringify(modelsOfCalls));
      assert.ok(modelsOfCalls.some(([b, a]) => b === 'claude' && a === 'plain'), JSON.stringify(modelsOfCalls));
      const rows = root.querySelectorAll('.rt-cand-row');
      assert.equal(rows[0].querySelector('.mn').textContent, 'Mythos 5.2 · verified');
      assert.ok(modelNameCalls.some(([b, m, a]) => b === 'claude' && m === 'claude-mythos-5-2' && a === 'verified'), JSON.stringify(modelNameCalls));

      const restoreGeometry = stubPickerGeometry();
      const chip = rows[0].querySelector('.rt-picker-chip');
      try {
        chip.dispatchEvent({ type: 'click' });
        await tick();
        const pop = root.querySelector('.rt-picker');
        pop.querySelectorAll('.prow').find(b => b.dataset.key === 'nav:conn').onclick();
        const accounts = pop.querySelectorAll('.prow').map(b => b.dataset.key);
        assert.ok(accounts.includes('account:verified') && accounts.includes('account:dead'), accounts.join(','));
        assert.ok(!accounts.includes('account:plain') && !accounts.includes('account:'), accounts.join(','));
      } finally {
        chip.dispatchEvent({ type: 'click' });
        restoreGeometry();
      }

      const countBeforeEvent = modelsOfCalls.length;
      await ui.event({ type: 'claudeAccountsChanged' });
      assert.ok(modelsOfCalls.length > countBeforeEvent);
      t.ok('delegation-settings: アカウント別のモデル一覧で表示と選択肢を決める', true);
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

    // ---- 3. bot-page.mjs: bot のページで account を替えると語彙を引き直し、モデルは bots.update で保存する。作るのは 3 段（ADR 0362）
    {
      const body = el('div');
      body.id = 'channelsBody';
      const titleEl = el('div');
      titleEl.id = 'channelsPageTitle';
      document.getElementById = (id) => ({ channelsBody: body, channelsPageTitle: titleEl })[id] ?? null;

      const vocabCalls = [];
      const invokeOrder = [];
      let row = { id: 'b_1', name: 'MythosBot', color: 2, backend: 'claude', account: '', model: '', effort: '', mode: 'default', folders: [], sendToOthers: true, sendTargets: [] };
      const pageHost = {
        state: {
          backend: 'claude', backendId: 'claude', cwd: '/w', account: '', sessions: [],
          backends: [{ id: 'claude', label: 'Claude', capabilities: { accounts: 'token', compatEndpoints: true } }],
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
          if (op === 'models') return (await pageHost.vocab(args.backend, args.cwd, { account: args.account })).models;
          return {};
        },
        efforts: async () => ({ '': { label: '既定' }, high: { label: '高' } }),
        backends: () => [{ id: 'claude', label: 'Claude', capabilities: { accounts: 'token', compatEndpoints: true } }],
        // 接続先の候補の取得口（web/client.mjs の connChoices と同じ形。入力欄と同じ部品が読む）
        conn: connChoicesFake(),
        backendLabel: (id) => ({ claude: 'Claude' })[id] ?? id,
        accountsEnabled: (id) => id === 'claude',
        accountList: () => [{ id: 'verified', name: 'verified', ready: true }, { id: 'plain', name: 'plain', ready: true }],
        accountName: (id) => ({ verified: 'verified', plain: 'plain' })[id] ?? id,
        quotaOf: () => null,
        askQuota: async () => null,
        invoke: async (op, args) => {
          invokeOrder.push([op, args]);
          if (op === 'bots.list') return { bots: [row] };
          if (op === 'channels.list') return { channels: [] };
          if (op === 'bots.get') return { ...row };
          if (op === 'bots.create') return { id: 'b_new_1', name: args.name, color: args.color, backend: args.backend, persona: args.persona ?? '', dmChannelId: 'c_dm_new', account: '', model: '', effort: '', mode: 'default', folders: [], sendToOthers: true, sendTargets: [] };
          if (op === 'bots.routing') return botRoutingView(row);
          if (op === 'bots.setRouting') { row = { ...row, ...routingPrimary(args.settings) }; return { ...row }; }
          if (op === 'bots.update') { row = { ...row, ...args }; delete row.botId; return { ...row }; }
          return {};
        },
      };

      const page = createBotPage(pageHost);
      page.show({ kind: 'bot', id: 'b_1' });
      for (let i = 0; i < 5; i++) await tick();

      const botView = body.querySelector('#botView');
      // モデル面を開いて承認のあるアカウントを選ぶ → そのアカウント向けの vocab を引き直す。
      // 面は 2 段（上の段の行 → 選ぶ一覧。docs/design-system.md「モデル選択の面」）なので、接続先の行から一覧へ進む
      const popButton = key => candidateOption(botView, key);
      candidateChip(botView).click();
      await tick();
      await tick();
      assert.ok(Boolean(popButton('nav:conn')), 'bot ページのモデル面の上の段に接続先の行が出る');
      popButton('nav:conn').click();
      await tick();
      await tick();
      const acctBtn = popButton('account:verified');
      assert.ok(Boolean(acctBtn), 'bot ページのモデル面にアカウント選択行が出る');
      acctBtn.click();
      for (let i = 0; i < 5; i++) await tick();
      assert.ok(invokeOrder.some(([op, a]) => op === 'bots.setRouting' && routingPrimary(a.settings).account === 'verified'), JSON.stringify(invokeOrder));
      assert.ok(vocabCalls.some((c) => c.backend === 'claude' && c.account === 'verified'), JSON.stringify(vocabCalls));

      // アカウントを選ぶと上の段へ戻る。モデルの行から一覧へ進む
      if (!popButton('model:claude-mythos-5-2')) { popButton('nav:model')?.click(); await tick(); await tick(); }
      const mythosBtn = popButton('model:claude-mythos-5-2');
      assert.ok(Boolean(mythosBtn), '承認のあるアカウントを選ぶと Mythos 5.2 が選択肢に出る');
      mythosBtn.click();
      for (let i = 0; i < 5; i++) await tick();
      assert.ok(invokeOrder.some(([op, a]) => op === 'bots.setRouting' && routingPrimary(a.settings).model === 'claude-mythos-5-2'), JSON.stringify(invokeOrder));

      // 接続先の登録が変わったら S.vocab を捨て、再取得する（web/client.mjs が一覧を取り直せる状態にしてから connChanged を呼ぶ）
      const vBefore = vocabCalls.length;
      page.connChanged();
      for (let i = 0; i < 5; i++) await tick();
      assert.ok(vocabCalls.length > vBefore, 'connChanged で語彙を引き直す');
      t.ok('bot-page: アカウントごとに語彙を引き、接続先とモデルを候補として保存する', true);

      // 作る 3 段: 名前 → 色 → 人格。エージェントは今の入力欄のもの、モデル・承認モードは既定。作ったら DM へ移る。
      // bots.create で落ちたときは 3 段目に留まり、理由を出す
      const createWith = async (fail) => {
        const body2 = el('div');
        body2.id = 'channelsBody';
        const title2 = el('div');
        title2.id = 'channelsPageTitle';
        document.getElementById = (id) => ({ channelsBody: body2, channelsPageTitle: title2 })[id] ?? null;
        const calls = [];
        const shown = [];
        const host2 = {
          ...pageHost,
          invoke: async (op, args) => {
            calls.push([op, args]);
            if (fail && op === 'bots.create') throw new Error('bots.create failed');
            return pageHost.invoke(op, args);
          },
        };
        const page2 = createBotPage(host2);
        // 実際は web/channels/index.mjs が channels:show を聞いて、各部品の show を同期で呼ぶ。同じ順で聞く
        const onShow = (ev) => { shown.push(ev.detail); page2.show(ev.detail); };
        document.addEventListener('channels:show', onShow);
        try {
          page2.show({ kind: 'bot', id: 'new' });
          for (let i = 0; i < 5; i++) await tick();
          const view = body2.querySelector('#botView');
          const btn = (label) => view.querySelector('.bp-ob-actions').querySelectorAll('button').find((b) => b.textContent === label);
          const nameIn = view.querySelector('#botObName');
          assert.ok(Boolean(nameIn), '作る画面は 1 段目（名前）から');
          assert.equal(btn(tr('channels:bot.onboard.next')).disabled, true, '名前が空のうちは次へ進めない');
          nameIn.value = 'Kite';
          nameIn.dispatchEvent({ type: 'input' });
          assert.equal(btn(tr('channels:bot.onboard.next')).disabled, false);
          btn(tr('channels:bot.onboard.next')).click();
          // 2 段目: 8 色。今の bot（橙）の次の色（緑）が選ばれている。桃を選ぶ
          const sw = view.querySelector('.bp-ob-step').querySelectorAll('.bp-swatch');
          assert.equal(sw.length, 8);
          assert.equal(sw.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.color, '3', '作った順の次の色が選ばれている');
          sw.find((b) => b.dataset.color === '4').click();
          btn(tr('channels:bot.onboard.next')).click();
          // 3 段目: 人格（空でもよい）
          const area = view.querySelector('#botObPersona');
          area.value = '短く答える';
          area.dispatchEvent({ type: 'input' });
          view.querySelector('.bp-create').click();
          for (let i = 0; i < 8; i++) await tick();
          return { shown, view, calls };
        } finally {
          document.removeEventListener('channels:show', onShow);
        }
      };
      const ok = await createWith(false);
      const made = ok.calls.filter(([op]) => /^bots\.(create|setMode|setAccount|update)$/.test(op));
      assert.equal(made.length, 1, JSON.stringify(made));
      assert.deepEqual(made[0], ['bots.create', { name: 'Kite', color: 4, backend: 'claude', persona: '短く答える' }]);
      assert.deepEqual(ok.shown, [{ kind: 'channel', id: 'c_dm_new' }], '作ったら DM へ移る');
      const bad = await createWith(true);
      assert.deepEqual(bad.shown, [], '作れなかったときは移らない');
      const obErr = bad.view.querySelector('.bp-ob').querySelector('.bp-err');
      assert.equal(obErr.textContent, tr('channels:bot.createFailed', { error: 'bots.create failed' }));
      assert.equal(obErr.hidden, false);
      assert.ok(Boolean(bad.view.querySelector('.bp-create')), '3 段目に留まり、やり直せる');
      t.ok('bot-page: 作る 3 段（名前 → 色 → 人格）で bots.create を 1 回呼び、DM へ移る。落ちたら 3 段目に留まる', true);
    }

    // ---- 3b. bot-page.mjs: 互換の接続先（ADR 0359）
    {
      const mount = () => {
        const body = el('div'); body.id = 'channelsBody';
        const title = el('div'); title.id = 'channelsPageTitle';
        document.getElementById = (id) => ({ channelsBody: body, channelsPageTitle: title })[id] ?? null;
        return body;
      };
      const botRow = (over = {}) => ({ id: 'b_ep', name: 'EpBot', icon: '', backend: 'claude', account: '', endpoint: '', model: '', effort: '', mode: 'default', folders: [], sendToOthers: true, sendTargets: [], ...over });
      const makeHost = (initial) => {
        let stored = initial;
        const calls = [];
        const cmds = [];
        const backendRows = [{ id: 'claude', label: 'Claude', capabilities: { accounts: 'token', compatEndpoints: true } }];
        const host = {
          state: { backend: 'claude', cwd: '/w', account: '', sessions: [], backends: backendRows },
          backends: () => backendRows,
          backendLabel: (id) => ({ claude: 'Claude' })[id] ?? id,
          conn: connChoicesFake(),
          cmd: async (op, args = {}) => {
            cmds.push([op, args]);
            if (op === 'modes') return { default: { label: '標準', scope: 'workspace', autonomy: 'ask' } };
            if (op === 'efforts') return { '': { label: '既定' }, high: { label: '高' } };
            if (op === 'models') return { '': { label: '既定', resolvesTo: 'sonnet' }, sonnet: { label: 'Sonnet', note: '' } };
            return {};
          },
          invoke: async (op, args) => {
            calls.push([op, args]);
            if (op === 'bots.list') return { bots: [stored] };
            if (op === 'channels.list') return { channels: [] };
            if (op === 'bots.get') return stored;
            if (op === 'bots.create') { stored = botRow({ id: 'b_new_2', name: args.name }); return stored; }
            if (op === 'bots.routing') return botRoutingView(stored);
            if (op === 'bots.setRouting') { stored = botRow({ ...stored, ...routingPrimary(args.settings) }); return stored; }
            return {};
          },
        };
        return { host, calls, cmds };
      };
      const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
      // 互換で動く bot: 見出しと候補に接続先の名前。公式と互換の接続先を切り替えて保存できる
      {
        const body = mount();
        const { host, calls } = makeHost(botRow({ endpoint: 'ep-good', model: 'glm-5' }));
        const page = createBotPage(host);
        page.show({ kind: 'bot', id: 'b_ep' });
        await settle(8);
        const view = body.querySelector('#botView');
        assert.match(candidateChip(view).textContent, /社内 gateway/, '互換の bot の候補に接続先の名前');
        assert.match(view.textContent, /社内 gateway/, '見出しの行にも接続先の名前');
        assert.equal(view.querySelector('.bp-conn-warn').hidden, true, '使える接続先なら一文を出さない');
        const write = async (key) => {
          calls.length = 0;
          if (!view.querySelector('.rt-picker') || view.querySelector('.rt-picker').hidden) candidateChip(view).click();
          await settle(3);
          candidateOption(view, 'nav:conn').click();
          await settle(3);
          candidateOption(view, key).click();
          await settle(6);
          return calls.filter(([op]) => op === 'bots.setRouting').flatMap(([, a]) => botCandidates(a.settings));
        };
        assert.deepEqual(await write('account:'), ['claude:sonnet'], 'CLI のログインに戻す');
        assert.deepEqual(await write('account:verified'), ['claude@verified:sonnet'], '登録したアカウントを選ぶ');
        assert.deepEqual(await write('endpoint:ep-good'), ['claude@ep-good:glm-5'], '互換の接続先を選ぶ');
      }

      // (c) 接続先が消えている／確認に失敗している: 入力欄と同じ一文を出す（読み終えるまでは出さない）
      for (const [row, key] of [[{ endpoint: 'ep-gone' }, 'chat.endpoint.deletedWarning'], [{ endpoint: 'failed-ep' }, 'chat.endpoint.failedWarning']]) {
        const body = mount();
        const { host } = makeHost(botRow(row));
        const page = createBotPage(host);
        page.show({ kind: 'bot', id: 'b_ep' });
        await settle(8);
        const warn = body.querySelector('#botView').querySelector('.bp-conn-warn');
        assert.equal(warn.hidden, false, `${row.endpoint}: 一文を出す`);
        assert.equal(warn.textContent, tr(key, { name: '壊れた接続先' }), `${row.endpoint}: ${warn.textContent}`);
      }
      t.ok('bot-page: 互換の接続先 — 見出しとチップに名前・CLI/アカウント/互換の行き来・消えた/使えない接続先の一文', true);
    }

    // ---- 4. thread-composer.mjs: vocab / efforts に account を渡し、invalidateVocab で引き直す
    // ---- 4. thread-composer.mjs: 宛先と設定のチップを出さず、語彙もエフォートも取りに行かない（設定は bot のページだけ。ADR 0362）
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

      const asked = [];
      const compHost = {
        state: { backend: 'claude', cwd: '/w', sessions: [] },
        vocab: async (...args) => { asked.push(['vocab', args]); return {}; },
        efforts: async (args) => { asked.push(['efforts', args]); return {}; },
        backends: () => [{ id: 'claude', label: 'Claude' }],
        backendLabel: (id) => id,
        cmd: async (name, args) => { asked.push([name, args]); return {}; },
        showMenu() {},
      };
      const bot = { id: 'b1', name: 'B1', backend: 'claude', color: 'blue' };
      const tc = createThreadComposer({
        host: compHost,
        candidates: () => [],
        backendLabel: (b) => b,
        onSend: async () => {},
        receiver: () => bot,
        session: () => ({ sessionId: 's1', cwd: '/w' }),
      });
      try {
        tc.refresh();
        await tick();
        assert.equal(tc.el.querySelector('.dest'), null, '宛先のチップは無い');
        const shown = [...tc.el.querySelectorAll('.crow > *')].filter((n) => !n.hidden).map((n) => n.id);
        assert.ok(!shown.some((id) => /cwdChip|modelChip|modeChip/.test(id)), JSON.stringify(shown));
        assert.ok(!asked.some(([name]) => ['vocab', 'efforts', 'agentModes', 'agentModels'].includes(name)), JSON.stringify(asked));
        t.ok('thread-composer: 宛先・設定のチップを出さず、語彙もエフォートも取りに行かない（ADR 0362）', true);
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
    for (const restore of restores) restore();
    await setLanguage(prevLang);
  }
}
