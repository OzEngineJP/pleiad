// 設定 › プラグイン（web/context.mjs）の
// 4 タブ・フォルダーまとまり（>8 で閉じる・一部は checkbox mixed で一括切替）・Skills の絞り込み。
import { N } from '../lib/dom-stub.mjs';
import { setLanguage, t as tr } from '../../web/i18n.mjs';
import { setAgentBrands } from '../../web/agent-brands.mjs';
import { AGENTS, agentPresentation } from '../../core/backends/agents.mjs';
import { setupContext } from '../../web/context.mjs';
import { applyDocTouch, buildDocMatrix } from '../../core/context-doc-matrix.mjs';
import { WORKSPACE_SUMMARY_KEY, docItemKey, emptyDocAgentsConfig } from '../../core/context-agents.mjs';

export const name = 'context-panel-tabs';
export const title = '設定 › プラグインの 4 タブ・まとまり・絞り込み';

function parseCompound(sel) {
  let tag = null, id = null;
  const classes = [], attrs = [];
  let rest = sel.trim().replace(/:not\(\[hidden\]\)/g, '');
  rest = rest.replace(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_, k, d, s, u) => {
    attrs.push([k.trim(), d !== undefined || s !== undefined || u !== undefined ? (d ?? s ?? u ?? '') : null]);
    return '';
  });
  rest = rest.replace(/#([^\s.#]+)/g, (_, v) => { id = v; return ''; });
  rest = rest.replace(/\.([^\s.#]+)/g, (_, v) => { classes.push(v); return ''; });
  if (rest.trim()) tag = rest.trim().toUpperCase();
  return { tag, id, classes, attrs };
}

function matchesSimple(node, sel) {
  if (!(node instanceof N)) return false;
  const { tag, id, classes, attrs } = parseCompound(sel);
  if (tag && node.tagName !== tag) return false;
  if (id && node.id !== id) return false;
  const cls = node._classes();
  for (const c of classes) if (!cls.includes(c)) return false;
  for (const [k, v] of attrs) {
    if (!node.hasAttribute(k)) return false;
    if (v !== null && String(node.getAttribute(k)) !== v) return false;
  }
  return true;
}

class PanelNode extends N {
  constructor(tag) {
    super(tag);
    this.scrollTop = 0;
  }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get value() { return this.attrs.value ?? ''; }
  set value(v) { this.attrs.value = String(v ?? ''); }
  get checked() { return this.hasAttribute('checked'); }
  set checked(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }
  get open() { return this.hasAttribute('open'); }
  set open(v) { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  set innerHTML(v) {
    super.innerHTML = v;
    const m = /^<([a-z]+)/i.exec(String(v).trim());
    if (m) {
      const child = new PanelNode(m[1]);
      child.parent = this;
      this.children = [child];
    }
  }
  get parentElement() { return this.parent instanceof N ? this.parent : null; }
  get isConnected() {
    for (let x = this; x; x = x.parent) if (x === globalThis.document?.body) return true;
    return false;
  }
  scrollTo(_x, y) { this.scrollTop = y; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  dispatchEvent(ev) {
    const h = this[`on${ev.type}`];
    if (typeof h === 'function') h(ev);
    return super.dispatchEvent(ev);
  }
  matches(sel) { return sel.split(',').some(p => matchesSimple(this, p)); }
  closest(sel) {
    for (let x = this; x instanceof N; x = x.parent) if (x.matches(sel)) return x;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
    const matchChain = (node, chain) => {
      const toks = chain.split(/\s+/);
      if (!matchesSimple(node, toks[toks.length - 1])) return false;
      let cur = node.parent;
      for (let i = toks.length - 2; i >= 0; i--) {
        if (toks[i] === '>') {
          i--;
          if (!cur || !matchesSimple(cur, toks[i])) return false;
          cur = cur.parent;
        } else {
          while (cur && !matchesSimple(cur, toks[i])) cur = cur.parent;
          if (!cur) return false;
          cur = cur.parent;
        }
      }
      return true;
    };
    const walk = n => {
      for (const c of n.children) {
        if (c instanceof N) {
          if (parts.some(p => matchChain(c, p))) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function installDom() {
  const store = new Map();
  const winListeners = new Map();
  const body = new PanelNode('body');
  const scroller = new PanelNode('div'); scroller.className = 'settings-content';
  const contextPanel = new PanelNode('div'); contextPanel.id = 'contextPanel';
  const cliSetup = new PanelNode('div'); cliSetup.id = 'cliSetup';
  contextPanel.append(cliSetup);
  const openBtn = new PanelNode('button'); openBtn.id = 'openContext';
  scroller.append(contextPanel);
  body.append(scroller, openBtn);

  const timers = new Set();
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    CSS: globalThis.CSS,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = saved.setTimeout((...a) => { timers.delete(id); return fn(...a); }, ms, ...args);
    timers.add(id);
    return id;
  };
  globalThis.clearTimeout = id => { timers.delete(id); return saved.clearTimeout(id); };
  globalThis.document = {
    body,
    activeElement: body,
    createElement: tag => new PanelNode(tag),
    createElementNS: (_ns, tag) => new PanelNode(tag),
    createTextNode: text => { const n = new PanelNode('span'); n.textContent = text; return n; },
    addEventListener() {},
    getElementById: id => body.querySelector(`#${id}`),
    querySelector: sel => body.querySelector(sel),
  };
  globalThis.window = {
    addEventListener(type, fn) { winListeners.set(type, [...(winListeners.get(type) ?? []), fn]); },
    dispatchEvent() {},
  };
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  globalThis.CSS = { escape: s => String(s) };
  globalThis.requestAnimationFrame = fn => fn();

  return {
    body, scroller, contextPanel, openBtn, store,
    restore() {
      for (const id of timers) saved.clearTimeout(id);
      timers.clear();
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.localStorage = saved.localStorage;
      globalThis.CSS = saved.CSS;
      globalThis.requestAnimationFrame = saved.requestAnimationFrame;
      globalThis.setTimeout = saved.setTimeout;
      globalThis.clearTimeout = saved.clearTimeout;
    },
  };
}

export default async function (t) {
  const dom = installDom();
  try {
    await setLanguage('ja');
    // 画面は「会話を始めるときだけ設定を読むエージェント」をエージェントの記述（contextAt）から引く（client.mjs の loadBackends と同じ）
    setAgentBrands(Object.keys(AGENTS).map((id) => ({ id, ...agentPresentation(id) })));

    // ---------------- 1. 設定 › プラグイン（web/context.mjs · Stage 2） ----------------
    // ユーザーの段で source が codex の指示は ~/.codex/AGENTS.md だけで、Codex が必ず読む（Codex の列は鍵）。ここでは押せる行にするため OpenCode の物だけにする。
    // ~/.opencode/ の下は Devin も取り込み（read_config_from の opencode）、止めると Hooks・MCP も止まるので鍵つきでオンになる（ADR 0337 §8）。
    // 鍵の無い行にするため、Devin が読まない OpenCode の設定の置き場（~/.config/opencode）に置く
    const rules = Array.from({ length: 9 }, (_, i) => ({
      id: `r${i}`, kind: 'instruction', scope: 'user', rule: true, defaultStatus: 'candidate',
      name: `r${i}.md`, path: `/home/u/.config/opencode/rules/sec/r${i}.md`, realPath: `/home/u/.config/opencode/rules/sec/r${i}.md`,
      tokens: 10, origins: [{ source: 'opencode', path: `/home/u/.config/opencode/rules/sec/r${i}.md`, scope: 'user' }],
    }));
    const skills = [
      { id: 's-dup-1', kind: 'skill', scope: 'user', defaultStatus: 'candidate', name: 'deploy', path: '/home/u/.claude/skills/deploy/SKILL.md', realPath: '/home/u/.claude/skills/deploy/SKILL.md', tokens: 20, origins: [{ source: 'claude', path: '/home/u/.claude/skills/deploy/SKILL.md', scope: 'user' }] },
      { id: 's-dup-2', kind: 'skill', scope: 'user', defaultStatus: 'shadowed', shadowedBy: 'choice', name: 'deploy', path: '/home/u/.agents/skills/deploy/SKILL.md', realPath: '/home/u/.agents/skills/deploy/SKILL.md', tokens: 20, origins: [{ source: 'codex', path: '/home/u/.agents/skills/deploy/SKILL.md', scope: 'user' }] },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `s-big-${i}`, kind: 'skill', scope: 'user', defaultStatus: 'candidate', name: `tool-${i}`,
        path: `/home/u/.codex/skills/tool-${i}/SKILL.md`, realPath: `/home/u/.codex/skills/tool-${i}/SKILL.md`, tokens: 12, origins: [{ source: 'codex', path: `/home/u/.codex/skills/tool-${i}/SKILL.md`, scope: 'user' }],
      })),
    ];
    const scanEntries = [
      { id: 'u-agy', kind: 'instruction', scope: 'user', defaultStatus: 'candidate', name: 'GEMINI.md', path: '/home/u/.gemini/GEMINI.md', realPath: '/home/u/.gemini/GEMINI.md', tokens: 15, origins: [{ source: 'antigravity', path: '/home/u/.gemini/GEMINI.md', scope: 'user' }] },
      ...rules,
      ...skills,
    ];

    const kindsState = {
      instruction: { value: { owner: 'native', user: { sources: ['claude', 'codex', 'antigravity', 'opencode'], excludePaths: [] }, directory: { sources: ['claude', 'codex', 'antigravity', 'opencode'], excludePaths: [] } } },
      skill: { value: { owner: 'native', user: { sources: ['claude', 'codex'], excludePaths: [] }, directory: { sources: ['claude', 'codex'], excludePaths: [] }, prefer: {} } },
      mcp: { value: { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } },
      hooks: { value: { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } },
    };
    let docAgentsCfg = emptyDocAgentsConfig();
    const docWrites = [];
    const plyWrites = [];
    let plyItemsState = [
      { id: 'ply-1', name: 'ルール1', on: true, tokens: 8, text: 'x', target: 'all', tag: 'user', agents: ['claude'] },
      { id: 'ply-link', name: '委譲ルール', on: true, tokens: 4, text: 'y', target: 'parent', tag: 'linked', agents: ['claude', 'grok'] },
    ];
    let failDoc = false, failPly = false;
    let mcpCodexOn = true, failMcpRow = false;
    const mcpRowCalls = [], mcpAgentCalls = [];
    const rootsState = { instruction: { value: [] }, skill: { value: [] }, mcp: { value: [] } };
    const toRawLegacy = (kinds) => ({
      version: 1,
      defaults: {
        roots: { instruction: [], skill: [], mcp: [] },
        kinds: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, structuredClone(v.value)])),
      },
      places: {},
    });
    const serializeRow = (r) => ({
      ...r,
      id: r.chosen.id,
      name: r.chosen.name,
      path: r.chosen.path,
      realPath: r.chosen.realPath ?? r.chosen.path,
      scope: r.chosen.scope,
      tokens: r.chosen.tokens ?? null,
      isRule: Boolean(r.chosen.rule),
      conditional: Boolean(r.chosen.conditional),
      status: r.chosen.status,
      content: '',
      duplicates: r.duplicates.map(d => ({ ...d })),
    });
    const scanDocsFor = (kind, entries, kinds) => entries.filter(e => e.kind === kind).map(e => ({
      ...e,
      status: e.defaultStatus ?? 'candidate',
    }));
    const makeDocMatrix = (kind, entries, kinds, cfg, cwd) => {
      const m = buildDocMatrix({ kind, entries: scanDocsFor(kind, entries, kinds), legacyConfig: toRawLegacy(kinds), docAgentsConfig: cfg, cwd, home: '/home/u' });
      return {
        kind,
        cwd: cwd ?? '/home/u',
        home: '/home/u',
        root: cwd ?? '/home/u',
        touched: m.touched,
        agentsPlace: m.agentsPlace,
        legacyPlace: m.legacyPlace,
        legacyOwner: m.legacyOwner,
        prefer: kinds.skill?.value?.prefer ?? {},
        agents: m.agents,
        summaryRow: m.summaryRow,
        rows: m.rows.map(serializeRow),
      };
    };
    const cloneSettings = () => ({
      home: '/home/u',
      defaults: { kinds: structuredClone(kindsState), roots: structuredClone(rootsState) },
      places: [{ current: true, saved: false, cwd: '/repo', kinds: structuredClone(kindsState), roots: structuredClone(rootsState) }],
    });

    const settingsCmd = async (command, payload) => {
      if (command === 'contextSettings') return cloneSettings();
      if (command === 'setContextSettings') {
        settingsWrites.push(payload);
        if (payload?.kind && payload?.value) {
          const v = kindsState[payload.kind].value;
          Object.assign(v, structuredClone(payload.value));
        }
        return cloneSettings();
      }
      if (command === 'scanContext') return { entries: scanEntries.map(e => ({ ...e, status: e.defaultStatus ?? 'candidate' })), budget: { total: 4000, used: 200 } };
      if (command === 'docMatrix') return makeDocMatrix(payload.kind, scanEntries, kindsState, docAgentsCfg, null);
      if (command === 'setDocRow') {
        if (failDoc) throw new Error('boom-settings');
        docWrites.push({ command, ...payload });
        // 本物の保存（core/server.mjs の docTouch）と同じ関数。行のスイッチの規則（外す前の組を was に覚える・戻す）はここで決まる
        applyDocTouch(docAgentsCfg, {
          kind: payload.kind, entries: scanDocsFor(payload.kind, scanEntries, kindsState), legacyConfig: toRawLegacy(kindsState),
          matrixCwd: null, home: '/home/u', place: null, placeKey: null, keys: payload.keys ?? [payload.key], on: payload.on,
        });
        return { ok: true, defaults: docAgentsCfg.defaults };
      }
      if (command === 'setDocAgent') {
        if (failDoc) throw new Error('boom-settings');
        docWrites.push({ command, ...payload });
        applyDocTouch(docAgentsCfg, {
          kind: payload.kind, entries: scanDocsFor(payload.kind, scanEntries, kindsState), legacyConfig: toRawLegacy(kindsState),
          matrixCwd: null, home: '/home/u', place: null, placeKey: null, agent: payload.agent, keys: payload.keys ?? [payload.key], on: payload.on,
        });
        return { ok: true, defaults: docAgentsCfg.defaults };
      }
      if (command === 'plyInstructions') return {
        items: structuredClone(plyItemsState),
        agents: [
          { id: 'claude', label: 'Claude' },
          { id: 'codex', label: 'Codex' },
          { id: 'antigravity', label: 'Antigravity' },
          { id: 'opencode', label: 'OpenCode' },
          { id: 'devin', label: 'Devin' },
          { id: 'grok', label: 'Grok' },
        ],
        total: plyItemsState.filter(x => x.on).reduce((s, x) => s + x.tokens, 0),
        routing: true,
      };
      if (command === 'setPlyInstructions') {
        if (failPly) throw new Error('boom-ply');
        plyWrites.push(payload);
        if (payload?.action === 'toggleAgent') {
          const item = plyItemsState.find(x => x.id === payload.id);
          if (item) {
            const set = new Set(item.agents);
            if (payload.on) set.add(payload.agent);
            else set.delete(payload.agent);
            item.agents = [...set];
          }
        }
        return settingsCmd('plyInstructions');
      }
      if (command === 'scanHooks') return { entries: [{ id: 'hk-1', name: '保存時チェック', event: 'PostToolUse', agent: 'antigravity', scope: 'user', enabled: true, command: 'echo ok', type: 'command' }], files: [], home: '/home/u', order: {} };
      if (command === 'plyHooks') return { defaults: { value: { owner: kindsState.hooks.value.owner } }, entries: [{ id: 'hk-1', name: '保存時チェック', event: 'PostToolUse', agent: 'claude', enabled: true, command: 'echo ok', type: 'command' }] };
      if (command === 'hooksMatrix') return hooksUnreadable
        ? { unreadable: true, error: 'hooks-agents.json が読めません', repair: [], rows: [] }
        : {
          agents: ['claude', 'codex'], adopted: true, revision: 'r1', groups: [], orphans: [],
          rows: [
            { key: 'ply:hk-1', kind: 'reg', group: 'ply', agent: null, scope: 'user', event: 'PostToolUse', command: 'echo ok', name: '保存時チェック', on: true, switchable: true, enabled: true, targets: ['claude'],
              cells: { claude: { state: 'on', mode: 'toggle' }, codex: { state: 'off', mode: 'toggle' } } },
            { key: 'native:hk-2', kind: 'native', group: 'own', agent: 'claude', scope: 'user', event: 'Stop', command: 'echo bye', on: false, switchable: true, status: 'off', scanIds: ['hk-2'],
              cells: { claude: { state: 'off', mode: 'toggle' }, codex: { state: 'off', mode: 'toggle' } } },
          ],
        };
      if (command === 'listPlyMcp') return { servers: [{ id: 'm1', name: 'local', transport: 'stdio', command: 'node', args: [] }] };
      if (command === 'agentMcp') return { agents: {} };
      if (command === 'mcpMatrix') return {
        agents: ['claude', 'codex'],
        rows: [{ key: 'srv-1', name: 'github', kind: 'config', group: 'agent', origins: ['claude'], cells: { claude: { mode: 'locked', reason: 'own', state: 'on' }, codex: { mode: 'toggle', state: mcpCodexOn ? 'on' : 'off' } },
          // サーバーの集計（core の mcpRowMeta）。codex を外した後は、外す前の組（codex）が戻し先
          ...(mcpCodexOn ? { rowSwitchOn: true, rowMixed: false, rowFixed: true, rowChangeableOn: true, rowNextOn: false, rowRestore: null, restoreAgents: [], rowLocked: false }
            : { rowSwitchOn: true, rowMixed: true, rowFixed: true, rowChangeableOn: false, rowNextOn: true, rowRestore: 'was', restoreAgents: ['codex'], rowLocked: false }) }],
      };
      if (command === 'setMcpRow') {
        mcpRowCalls.push(payload);
        if (failMcpRow) throw new Error('boom-mcp-row');
        mcpCodexOn = payload.on === true;
        return { ok: true, changed: ['codex'] };
      }
      if (command === 'setMcpAgent') { mcpAgentCalls.push(payload); return { ok: true }; }
      if (command === 'recentPlaces') return { places: ['/repo'] };
      if (command === 'backends') return [{ id: 'claude', name: 'Claude', capabilities: { plyContext: 'turn' } }];
      return {};
    };
    const settingsWrites = [];
    let hooksUnreadable = false;

    const ctxPage = setupContext({
      button: dom.openBtn,
      cmd: settingsCmd,
      show: () => {},
      showMenu: () => {},
      recentPlaces: () => [{ value: '/repo', label: 'repo' }],
      backends: () => [{ id: 'claude', name: 'Claude' }],
      openDelegation: () => {},
      getPrefs: () => ({}),
    });

    await ctxPage.openPage();
    await settle();

    const p = dom.contextPanel;
    const tabs = p.querySelectorAll('[role="tab"]');
    const panels = ['instruction', 'skill', 'mcp', 'hooks'].map(k => p.querySelector(`#cx-panel-${k}`));
    t.ok('設定 › プラグインは 4 つのタブと 4 つの tabpanel を出し、#cliSetup は外部 MCP タブの中に置く',
      tabs.length === 4 && panels.every(Boolean)
      && p.querySelector('#cx-panel-instruction').hidden === false
      && p.querySelector('#cx-panel-skill').hidden === true
      && panels[2].querySelector('#cliSetup') != null);

    t.ok('タブ件数に重複を除いた Skills 数と Pleiad 指示＋スキャン指示、MCP、Hooks が反映される',
      p.querySelector('#cx-tab-instruction .c')?.textContent === '12'
      && p.querySelector('#cx-tab-skill .c')?.textContent === '10'
      && p.querySelector('#cx-tab-mcp .c')?.textContent === '1'
      && p.querySelector('#cx-tab-hooks .c')?.textContent === '1',
      [
        p.querySelector('#cx-tab-instruction .c')?.textContent,
        p.querySelector('#cx-tab-skill .c')?.textContent,
        p.querySelector('#cx-tab-mcp .c')?.textContent,
        p.querySelector('#cx-tab-hooks .c')?.textContent,
      ].join(','));

    // 段 2: 指示・Skills には担当 2 択と「探す形式」の札が無く、目安は <details class="cx-fold"> に畳まれ、作業場所 summaryRow と凡例がある
    const instPanel = p.querySelector('#cx-panel-instruction');
    const skillPanel = p.querySelector('#cx-panel-skill');
    const fold = instPanel.querySelector('details.cx-fold');
    t.ok('指示・Skills・Hooks のどのタブにも担当 2 択（.cx-seg）が無く、Hooks は登録とエージェントの設定の行を出し、指示の量の目安は畳まれて作業場所 summaryRow がある',
      instPanel.querySelectorAll('.cx-seg').length === 0
      && skillPanel.querySelectorAll('.cx-seg').length === 0
      && p.querySelectorAll('#cx-panel-hooks .cx-seg').length === 0
      && p.querySelector('#cx-panel-hooks [data-key="ply:hk-1"]') != null
      && p.querySelector('#cx-panel-hooks [data-key="native:hk-2"]') != null
      && fold != null && fold.open === false
      && fold.querySelector('#cxInstructionBudget') != null
      && instPanel.querySelector(`[data-key="${WORKSPACE_SUMMARY_KEY}"] .cx-sw`) != null
      && skillPanel.querySelector(`[data-key="${WORKSPACE_SUMMARY_KEY}"] .cx-sw`) != null
      && instPanel.querySelectorAll('.cx-legend.names').length >= 1);

    // Pleiad の指示: Grok を含む 6 エージェントが押せて、「委譲と連動」は鍵（linked）・全体スイッチ無し
    const plyRows = instPanel.querySelectorAll('.cx-ply .cx-row.ag');
    const plyGrokBtn = plyRows[0]?.querySelectorAll('.cx-ag')[5];
    const plyLinkedRow = plyRows[1];
    t.ok('Pleiad の指示: 通常行に 6 エージェント（Grok 押下可）、連動行に行スイッチ無し＋linked 鍵がある',
      plyRows.length === 2
      && plyGrokBtn?.dataset.agent === 'grok' && plyGrokBtn?.getAttribute('aria-disabled') == null
      && plyLinkedRow?.querySelector('.cx-sw') == null
      && plyLinkedRow?.querySelector('.cx-ag[aria-disabled="true"]') != null);
    plyGrokBtn.onclick();
    await settle();
    t.ok('Pleiad の指示で Grok アイコンを押すと setPlyInstructions toggleAgent が保存される',
      plyWrites.some(w => w.action === 'toggleAgent' && w.id === 'ply-1' && w.agent === 'grok' && w.on === true)
      && plyItemsState[0].agents.includes('grok'));
    // Pleiad の指示は Grok にも毎ターン入れ直すので、始まっている会話にも次のターンから届く。「新しい会話から反映」は出さない
    t.ok('Pleiad の指示で Grok を変えた保存の知らせは「保存しました」だけ（新しい会話から、と言わない）',
      p.querySelector('.cx-toast')?.textContent === '保存しました', p.querySelector('.cx-toast')?.textContent);

    failPly = true;
    instPanel.querySelectorAll('.cx-ply .cx-row.ag')[0].querySelectorAll('.cx-ag')[5].onclick();
    await settle();
    t.ok('Pleiad の指示の保存失敗時は表示を元の保存状態に戻す',
      plyItemsState[0].agents.includes('grok')
      && instPanel.querySelectorAll('.cx-ply .cx-row.ag')[0].querySelectorAll('.cx-ag')[5].getAttribute('aria-pressed') === 'true');
    failPly = false;

    // スクロール先頭リセット + タブ記憶
    dom.scroller.scrollTop = 240;
    p.querySelector('#cx-tab-mcp').onclick();
    await settle();
    t.ok('タブ切替で親スクロール先頭へ戻り、最後のタブを記憶する',
      dom.scroller.scrollTop === 0 && dom.store.get('ply-context-tab') === 'mcp'
      && p.querySelector('#cx-panel-mcp').hidden === false);

    // 外部 MCP の行のスイッチ（ToBe-A′）: 鍵つきでオンの Claude が残る行も押せる。1 回の setMcpRow で、変えられるオン（Codex）だけをまとめてオフにする
    const mcpSw = () => p.querySelector('#cx-panel-mcp .cx-row[data-key="srv-1"] .cx-sw');
    t.ok('外部 MCP の行（鍵つきの Claude がオン・Codex がオン）のスイッチは role="checkbox"・aria-checked="true" で、押せる（aria-disabled が無い）',
      mcpSw()?.getAttribute('role') === 'checkbox' && mcpSw().getAttribute('aria-checked') === 'true' && mcpSw().getAttribute('aria-disabled') == null,
      mcpSw()?.getAttribute('aria-label'));
    mcpSw().onclick();
    await settle();
    t.ok('押すと setMcpRow が 1 回だけ（on: false）。アイコンごとの setMcpAgent は呼ばない（途中まで保存した状態を作らない）',
      mcpRowCalls.length === 1 && mcpRowCalls[0].name === 'srv-1' && mcpRowCalls[0].on === false && mcpAgentCalls.length === 0,
      JSON.stringify([mcpRowCalls, mcpAgentCalls]));
    t.ok('保存の後、行は「一部オン」（aria-checked="mixed"）で小さな鍵が重なり、押し直すと外す前の選択に戻す動きを読み上げる',
      mcpSw().getAttribute('aria-checked') === 'mixed' && mcpSw().querySelectorAll('.lk').length === 1
      && mcpSw().getAttribute('aria-label').includes(tr('context.rowSwitch.next.restore')),
      mcpSw()?.getAttribute('aria-label'));
    t.ok('保存の知らせは「保存しました」だけ（Codex は始まっている会話にも次のターンから届くので、新しい会話から、と言わない）',
      p.querySelector('.cx-toast')?.textContent === '保存しました', p.querySelector('.cx-toast')?.textContent);
    mcpSw().onclick();
    await settle();
    t.ok('もう一度押すと setMcpRow（on: true）で外す前の組へ戻り、行はオンに戻る',
      mcpRowCalls.length === 2 && mcpRowCalls[1].on === true && mcpSw().getAttribute('aria-checked') === 'true' && mcpSw().querySelectorAll('.lk').length === 0,
      JSON.stringify(mcpRowCalls));
    failMcpRow = true;
    mcpSw().onclick();
    await settle();
    t.ok('保存に失敗したら押す前の状態（オン）へ戻り、半分だけ保存した成功は出さない',
      mcpSw().getAttribute('aria-checked') === 'true' && mcpCodexOn === true && p.querySelector('.cx-toast')?.textContent !== '保存しました');
    failMcpRow = false;
    p.querySelector('#cx-tab-instruction').onclick();
    await settle();

    // 9 件の rules まとまりは初期折りたたみ → 開く（親ロゴ・パス繰り返し無し）→ 子 1 つオフで mixed → まとめ切替で 1 回 setDocRow
    const ruleBundle = instPanel.querySelector('.cx-row.grp');
    t.ok('8 件超の指示フォルダーまとまりは最初は折りたたまれている',
      ruleBundle != null && ruleBundle.querySelector('.cx-tw').getAttribute('aria-expanded') === 'false'
      && instPanel.querySelectorAll('.cx-row.kid').length === 0);

    ruleBundle.querySelector('.cx-tw').onclick();
    await settle();
    const ruleKids = instPanel.querySelectorAll('.cx-row.kid');
    t.ok('まとまりを開くと 9 件の .cx-row.kid が出て、子の行には出どころのロゴを繰り返さない',
      ruleKids.length === 9 && ruleKids.every(k => k.querySelector('.cx-src') == null));

    // 行単位で子 1 つオフ → mixed → 一括 setDocRow
    // 子の行のスイッチの状態（集計の分母は、鍵の無いマス全部。OpenCode だけが自分で読む行は、初めから「一部オン」）
    const kidSws = () => instPanel.querySelectorAll('.cx-row.kid').map(k => k.querySelector('.cx-sw').getAttribute('aria-checked'));
    const kidBaseline = kidSws();
    const grpBaseline = instPanel.querySelector('.cx-row.grp .cx-sw').getAttribute('aria-checked');
    ruleKids[0].querySelector('.cx-sw').onclick();
    await settle();
    const grpSwAfterOne = instPanel.querySelector('.cx-row.grp .cx-sw');
    t.ok('子 1 件を切るとまとまりスイッチが role="checkbox" の aria-checked="mixed" になる',
      grpSwAfterOne.getAttribute('role') === 'checkbox'
      && grpSwAfterOne.getAttribute('aria-checked') === 'mixed');

    // 読み上げ: 一部オンの状態と、押したときの動き（変えられる分をまとめてオフ）が名前に入る
    const grpLabelMixed = grpSwAfterOne.getAttribute('aria-label') ?? '';
    t.ok('一部オンのまとまりスイッチの読み上げ名は、状態「一部オン」と押したときの動き「変更できる分をまとめてオフにする」を含む',
      grpLabelMixed.includes('一部オン') && grpLabelMixed.includes('変更できる分をまとめてオフにする'), grpLabelMixed);

    // 一部だけオンのまとまりを押すと、変えられるオンのある子だけがまとめてオフになる（全部をオンへ広げない）。1 回の setDocRow に、押せる子の 9 件を渡す
    // （先に自分の行のスイッチで外した 1 件は、外す前の記録だけを持つ子。core が今回は外していないその子の古い戻し先を消すために渡す）
    const beforeDocWrites = docWrites.length;
    grpSwAfterOne.onclick();
    await settle();
    const grpSwAfterBatch = instPanel.querySelector('.cx-row.grp .cx-sw');
    t.ok('一部オンのまとまりスイッチを押すと 1 回の setDocRow 保存（on: false）で、変えられる分がすべてオフになる',
      docWrites.length === beforeDocWrites + 1 && docWrites.at(-1).command === 'setDocRow' && docWrites.at(-1).keys?.length === 9
      && docWrites.at(-1).on === false
      && grpSwAfterBatch?.getAttribute('aria-checked') === 'false'
      && instPanel.querySelectorAll('.cx-row.grp .cx-ag.none').length === 6);

    // もう一度押すと、今回オフにした子だけが外す前の選択へ戻る。先に外してあった子（1 件目）はオンにしない
    const grpLabelOff = grpSwAfterBatch.getAttribute('aria-label') ?? '';
    t.ok('オフのまとまりスイッチの読み上げ名は、状態「オフ」と「外す前の選択に戻す」を含む',
      grpLabelOff.includes('オフ') && grpLabelOff.includes('外す前の選択に戻す'), grpLabelOff);
    grpSwAfterBatch.onclick();
    await settle();
    t.ok('もう一度押すと 1 回の setDocRow（on: true）で外す前の選択へ戻り、先に外してあった 1 件目はオフのまま（まとまりは一部オン）',
      docWrites.length === beforeDocWrites + 2 && docWrites.at(-1).on === true
      && kidSws().join(',') === ['false', ...kidBaseline.slice(1)].join(',')
      && instPanel.querySelector('.cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'mixed',
      `${kidSws().join(',')} / baseline ${kidBaseline.join(',')}`);

    // 1 件目を自分の行のスイッチで戻し、最初と同じ状態にする。鍵つきセル・広げる確認・最後の 1 つをオフでスイッチへフォーカス移動を確かめる
    instPanel.querySelectorAll('.cx-row.kid')[0].querySelector('.cx-sw').onclick();
    await settle();
    t.ok('1 件目を自分のスイッチで戻すと、全部が最初の状態に戻る',
      kidSws().join(',') === kidBaseline.join(',') && instPanel.querySelector('.cx-row.grp .cx-sw')?.getAttribute('aria-checked') === grpBaseline,
      `${kidSws().join(',')} / baseline ${kidBaseline.join(',')}`);
    const agyKey = docItemKey({ kind: 'instruction', path: '/home/u/.gemini/GEMINI.md', realPath: '/home/u/.gemini/GEMINI.md' });
    const agyRow = instPanel.querySelector(`[data-key="${agyKey}"]`);
    const agyOwnChip = agyRow.querySelector('.cx-ag[data-agent="antigravity"]');
    const agyGrokChip = agyRow.querySelector('.cx-ag[data-agent="grok"]');
    const dwBeforeLock = docWrites.length;
    t.ok('GEMINI.md の Antigravity セルは鍵付きで、Grok セルは切り替えられる',
      agyOwnChip?.getAttribute('aria-disabled') === 'true' && agyOwnChip?.dataset.tip?.includes('止められません')
      && agyGrokChip?.getAttribute('aria-disabled') !== 'true' && agyGrokChip?.getAttribute('aria-pressed') === 'false');
    agyOwnChip?.onclick?.();
    await settle();
    t.ok('鍵つきセルを押しても保存しない', docWrites.length === dwBeforeLock);

    // 非ネイティブセル（GEMINI.md を Claude に広げる）を押すと確認バナー（.cx-ask）が出る → やめる → もう一度押して 渡す
    const agyClaudeChip = agyRow.querySelector('.cx-ag[data-agent="claude"]');
    agyClaudeChip.onclick();
    await settle();
    t.ok('初めて他エージェントへ広げるとき確認バナーが出て未保存のまま待つ',
      instPanel.querySelector('.cx-ask') != null && docWrites.length === dwBeforeLock);
    instPanel.querySelectorAll('.cx-ask button')[0].onclick();
    await settle();
    t.ok('「やめる」でバナーが閉じ未保存のまま元のセルにフォーカスを戻す',
      instPanel.querySelector('.cx-ask') == null && docWrites.length === dwBeforeLock
      && globalThis.document.activeElement?.dataset?.cxFk === `ag:${agyKey}:claude`);

    instPanel.querySelector(`[data-key="${agyKey}"] .cx-ag[data-agent="claude"]`).onclick();
    await settle();
    instPanel.querySelector('.cx-ask .btn-primary').onclick();
    await settle();
    t.ok('「渡す」で setDocAgent が保存され、該当セルがオンになる',
      docWrites.length === dwBeforeLock + 1 && docWrites.at(-1).command === 'setDocAgent'
      && docWrites.at(-1).agent === 'claude' && docWrites.at(-1).on === true
      && instPanel.querySelector(`[data-key="${agyKey}"] .cx-ag[data-agent="claude"]`)?.getAttribute('aria-pressed') === 'true');

    // 保存の知らせ（レビューの決定 (b)）: Antigravity・Grok のマスが変わったときだけ「新しい会話から反映します」、ほかは「保存しました」
    const toastEl = p.querySelector('.cx-toast');
    t.ok('Claude のマスだけ変えた保存は「保存しました」だけを出す',
      toastEl?.textContent === '保存しました' && !toastEl.classList.contains('err'), toastEl?.textContent);
    const r0Key = docItemKey({ kind: 'instruction', path: '/home/u/.config/opencode/rules/sec/r0.md', realPath: '/home/u/.config/opencode/rules/sec/r0.md' });
    const dwBeforeAg = docWrites.length;
    instPanel.querySelector(`[data-key="${r0Key}"] .cx-ag[data-agent="antigravity"]`).onclick();
    await settle();
    instPanel.querySelector('.cx-ask .btn-primary')?.onclick();
    await settle();
    t.ok('Antigravity のマスを変えた保存は「Antigravity と Grok は、新しい会話から反映します」を出す',
      docWrites.length === dwBeforeAg + 1 && docWrites.at(-1).agent === 'antigravity'
      && /Antigravity と Grok は、新しい会話から反映します/.test(toastEl?.textContent ?? ''), toastEl?.textContent);

    // 作業場所の summaryRow スイッチ。作業場所の CLAUDE.md・AGENTS.md は Devin（取り込み）と Grok が自分で読み、止められない（鍵つきでオン）。
    // 鍵つきのオンが残っても、鍵の無いオン（Claude など）があれば押せる。押すと変えられる分だけがまとめてオフになり、鍵つきは残る（ToBe-A′）。
    // 鍵の理由は、鍵つきのオンだけが残る間の鍵（スイッチの上の小さな錠）に出る
    const wsSw = () => instPanel.querySelector(`[data-key="${WORKSPACE_SUMMARY_KEY}"] .cx-sw`);
    const wsLock = () => wsSw().querySelectorAll('.lk');
    const dwBeforeWs = docWrites.length;
    t.ok('作業場所 summaryRow: 鍵つきのオンが残っていても、変えられるオンがあれば押せる（全部オン・鍵は出さない・押すと「変更できる分をまとめてオフ」）',
      wsSw().getAttribute('aria-checked') === 'true' && wsSw().getAttribute('role') === 'checkbox' && wsSw().getAttribute('aria-disabled') !== 'true'
      && typeof wsSw().onclick === 'function' && wsLock().length === 0
      && (wsSw().getAttribute('aria-label') ?? '').includes('変更できる分をまとめてオフにする'),
      wsSw().getAttribute('aria-label'));
    wsSw().onclick();
    await settle();
    const wsAfterOff = docWrites.slice(dwBeforeWs);
    t.ok('作業場所 summaryRow を押すと 1 回の setDocRow（on: false）で、変えられる分だけがオフ。鍵つきのオンは残り、横棒と小さな鍵になる',
      wsAfterOff.length === 1 && wsAfterOff[0].command === 'setDocRow' && wsAfterOff[0].on === false
      && wsSw().getAttribute('aria-checked') === 'mixed' && wsLock().length === 1
      && Boolean(wsLock()[0].dataset.tip) && wsLock()[0].dataset.tipPass !== undefined
      && wsSw().getAttribute('aria-disabled') !== 'true' && (wsSw().getAttribute('aria-label') ?? '').includes('外す前の選択に戻す'),
      JSON.stringify({ writes: wsAfterOff, checked: wsSw().getAttribute('aria-checked'), lk: wsLock().length, label: wsSw().getAttribute('aria-label') }));
    // 変えたマスに「新しい会話から反映する」エージェント（Antigravity）が含まれるので、知らせにも出す。鍵つきの Grok は変わらないので、それだけでは出さない
    t.ok('作業場所 summaryRow をオフにした保存の知らせに「新しい会話から反映します」が付く（変えたマスに Antigravity がある）',
      /Antigravity と Grok は、新しい会話から反映します/.test(toastEl?.textContent ?? ''), toastEl?.textContent);
    wsSw().onclick();
    await settle();
    const wsAfterOn = docWrites.slice(dwBeforeWs + 1);
    t.ok('作業場所 summaryRow をもう一度押すと、外す前の選択に戻る（setDocRow on: true・全部オン・鍵は消える）',
      wsAfterOn.length === 1 && wsAfterOn[0].on === true && wsSw().getAttribute('aria-checked') === 'true' && wsLock().length === 0,
      JSON.stringify({ writes: wsAfterOn, checked: wsSw().getAttribute('aria-checked'), lk: wsLock().length }));

    // ユーザー行 r0.md の最後のオンエージェントをオフにするとフォーカスが行スイッチ sw: へ移る
    const firstKid = instPanel.querySelectorAll('.cx-row.kid')[0];
    const firstKey = firstKid.dataset.key;
    for (let guard = 0; guard < 6; guard++) {
      const row = instPanel.querySelector(`[data-key="${CSS.escape(firstKey)}"]`);
      const onBtn = row?.querySelectorAll('.cx-ag[aria-pressed="true"]').find(b => b.getAttribute('aria-disabled') !== 'true');
      if (!onBtn) break;
      onBtn.onclick();
      await settle();
    }
    t.ok('最後のエージェントをオフにしたらフォーカスが行のスイッチへ移る',
      globalThis.document.activeElement?.dataset?.cxFk === `sw:${firstKey}`);
    // 戻しておく
    instPanel.querySelector(`[data-key="${CSS.escape(firstKey)}"] .cx-sw`).onclick();
    await settle();

    // Skills タブ: 絞り込み・まとまりスイッチ・エラーロールバック
    p.querySelector('#cx-tab-skill').onclick();
    await settle();
    const findInput = skillPanel.querySelector('.cx-find input');
    t.ok('Skills タブに 9 件以上のまとまりがあり最初は閉じている',
      skillPanel.querySelectorAll('.cx-row.kid').length === 1
      && skillPanel.querySelectorAll('.cx-row.grp').length === 2
      && skillPanel.querySelectorAll('.cx-row.grp .cx-tw').some(tw => tw.getAttribute('aria-expanded') === 'false')
      && skillPanel.querySelector('[data-key="skill:deploy"]') != null);
    findInput.focus();
    findInput.value = 'tool-7';
    findInput.setSelectionRange(6, 6);
    findInput.dispatchEvent({ type: 'input' });
    await settle();
    const findInputAfter = skillPanel.querySelector('.cx-find input');
    t.ok('絞り込み中も input 要素を差し替えず、当たったまとまりが自動で開く',
      findInputAfter === findInput && findInputAfter.value === 'tool-7'
      && skillPanel.querySelectorAll('.cx-row.kid').length === 1
      && skillPanel.querySelector('.cx-row.kid .nm')?.textContent === 'tool-7');

    findInput.value = 'no-match-xyz';
    findInput.dispatchEvent({ type: 'input' });
    await settle();
    t.ok('一致 0 件で「見つかりません」を表示する',
      skillPanel.textContent.includes('見つかりません'));

    findInput.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
    await settle();
    t.ok('Escape で絞り込みを解除して通常一覧に戻る',
      findInput.value === '' && !skillPanel.textContent.includes('見つかりません'));

    findInput.value = 'tool-7';
    findInput.dispatchEvent({ type: 'input' });
    await settle();
    const fSw = () => skillPanel.querySelector('.cx-row.grp .cx-sw');
    const fKidSw = () => skillPanel.querySelector('.cx-row.kid .cx-sw');
    t.ok('絞り込み中のまとまりスイッチは見えている 1 行だけから決まる（その行のスイッチと同じ状態で、オフではない）',
      fSw().getAttribute('aria-checked') === fKidSw().getAttribute('aria-checked') && fSw().getAttribute('aria-checked') !== 'false',
      `${fSw().getAttribute('aria-checked')} / ${fKidSw().getAttribute('aria-checked')}`);
    fSw().onclick();
    await settle();
    t.ok('絞り込み中のまとまりスイッチで、当たった 1 件だけが setDocRow オフになる（9 件ではない）',
      docWrites.at(-1).command === 'setDocRow' && docWrites.at(-1).keys?.length === 1 && docWrites.at(-1).on === false
      && fSw().getAttribute('aria-checked') === 'false');
    findInput.value = '';
    findInput.dispatchEvent({ type: 'input' });
    await settle();
    // OpenCode の物ではなく Codex が自分で読む 9 件のまとまり。1 件（tool-7）は今、自分の行のスイッチで外した扱い（外す前の記録だけを持つ）
    const codexGrp = () => skillPanel.querySelectorAll('.cx-row.grp').find(g => String(g.dataset.key).includes('.codex'));
    const codexSw = () => codexGrp().querySelector('.cx-sw');
    t.ok('絞り込みを消すとまとまり全体の状態（一部オン）に戻る', codexSw().getAttribute('aria-checked') === 'mixed', codexSw().getAttribute('aria-checked'));
    if (codexGrp().querySelector('.cx-tw').getAttribute('aria-expanded') === 'false') { codexGrp().querySelector('.cx-tw').onclick(); await settle(); }
    // 開いている子の行のうち、この 9 件（tool-0〜tool-8）だけ。deploy は別のまとまり
    const codexKids = () => skillPanel.querySelectorAll('.cx-row.kid').filter(k => String(k.querySelector('.nm')?.textContent).startsWith('tool-')).map(k => k.querySelector('.cx-sw').getAttribute('aria-checked'));
    const codexBefore = codexKids();
    const dwCodex = docWrites.length;
    codexSw().onclick();
    await settle();
    t.ok('一部オンのまとまりスイッチを押すと、変えられる分がまとめてオフになる（1 回の setDocRow on: false・押せる子の 9 件）',
      docWrites.length === dwCodex + 1 && docWrites.at(-1).on === false && docWrites.at(-1).keys?.length === 9
      && codexSw().getAttribute('aria-checked') === 'false' && codexKids().every(x => x === 'false'),
      `${docWrites.at(-1).keys?.length} ${codexSw().getAttribute('aria-checked')} ${codexKids().join(',')}`);
    codexSw().onclick();
    await settle();
    t.ok('もう一度押すと外す前の選択へ戻り、先に外してあった tool-7 だけはオフのまま（まとまりは一部オン）',
      docWrites.length === dwCodex + 2 && docWrites.at(-1).on === true
      && codexKids().join(',') === codexBefore.join(',') && codexBefore.filter(x => x === 'false').length === 1
      && codexSw().getAttribute('aria-checked') === 'mixed',
      `${codexKids().join(',')} / before ${codexBefore.join(',')}`);

    // 保存失敗時のロールバック
    const oneSw = () => skillPanel.querySelectorAll('.cx-row:not(.grp) .cx-sw, .cx-row.kid .cx-sw').find(x => x.getAttribute('aria-disabled') !== 'true');
    // ~/.claude/skills の物は Devin が取り込み、止められない（鍵つきでオン）ので、そのまとまりのスイッチは押せない（決定 (a)）。押せるまとまりで試す
    const grpOf = () => [...skillPanel.querySelectorAll('.cx-row.grp .cx-sw')].find(x => x.getAttribute('aria-disabled') !== 'true');
    const beforeGrp = grpOf().getAttribute('aria-checked');
    failDoc = true;
    grpOf().onclick();
    await settle();
    t.ok('まとめて切り替える保存に失敗したら、スイッチは元の状態に描き直され、失敗が出る',
      grpOf().getAttribute('aria-checked') === beforeGrp && p.querySelector('.cx-status')?.textContent.includes('boom-settings')
      // 長い表の下の行で失敗しても見えるよう、固定の位置のトーストにも失敗を出す（レビュー S4）
      && p.querySelector('.cx-toast.on.err')?.textContent.includes('boom-settings'));
    // 押せる 1 件（Devin が取り込まない ~/.codex/skills の物）は閉じたまとまりの中にあるので、開いてから試す
    if (!oneSw()) {
      const openGrp = skillPanel.querySelectorAll('.cx-row.grp').find(g => g.querySelector('.cx-sw')?.getAttribute('aria-disabled') !== 'true');
      if (openGrp?.querySelector('.cx-tw')?.getAttribute('aria-expanded') === 'false') { openGrp.querySelector('.cx-tw').onclick(); await settle(); }
    }
    const beforeOne = oneSw().getAttribute('aria-checked');
    oneSw().onclick();
    await settle();
    t.ok('1 件の切替に失敗したときも元の状態へ描き直される', oneSw().getAttribute('aria-checked') === beforeOne);
    failDoc = false;

    // Hooks の担当 2 択は無くなった（段 3）。件数を隠すのは hooks-agents.json が読めず数えられないときだけ
    const cnt = (root, pre, k) => root.querySelector(`#${pre}-tab-${k} .c`);
    const noCount = (root, pre, k) => { const c = cnt(root, pre, k); return !c || c.hidden === true || !c.textContent; };
    kindsState.hooks.value.owner = 'native';
    await ctxPage.openPage();
    await settle();
    t.ok('旧来の担当が「エージェントに任せる」でも Hooks タブは件数（実行する行の数）を出す',
      cnt(p, 'cx', 'hooks')?.textContent === '1' && !noCount(p, 'cx', 'instruction'));
    hooksUnreadable = true;
    await ctxPage.openPage();
    await settle();
    t.ok('hooks-agents.json が読めないときは Hooks タブだけ件数を隠し、直し方の面を出す',
      noCount(p, 'cx', 'hooks') && !noCount(p, 'cx', 'instruction') && !noCount(p, 'cx', 'skill')
      && p.querySelector('#cx-panel-hooks').textContent.includes('hooks-agents.json'));
    hooksUnreadable = false;
    kindsState.hooks.value.owner = 'ply';
    await ctxPage.openPage();
    await settle();
  } finally {
    dom.restore();
    await setLanguage('ja');
  }
}
