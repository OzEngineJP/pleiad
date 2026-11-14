// 設定 › プラグイン（web/context.mjs）と会話の右パネル（web/session-context.mjs）の
// 4 タブ・フォルダーまとまり（>8 で閉じる・一部は checkbox mixed で一括切替）・Skills の絞り込み。
import { N } from '../lib/dom-stub.mjs';
import { setLanguage } from '../../web/i18n.mjs';
import { setupContext } from '../../web/context.mjs';
import { setupSessionContext } from '../../web/session-context.mjs';

export const name = 'context-panel-tabs';
export const title = '設定 › プラグインと会話の右パネル編集モードの 4 タブ・まとまり・絞り込み';

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

    // ---------------- 1. 設定 › プラグイン（web/context.mjs） ----------------
    const rules = Array.from({ length: 9 }, (_, i) => ({
      id: `r${i}`, kind: 'instruction', scope: 'user', rule: true, defaultStatus: 'candidate',
      name: `r${i}.md`, path: `/home/u/.claude/rules/sec/r${i}.md`,
      tokens: 10, origins: [{ source: 'claude', path: `/home/u/.claude/rules/sec/r${i}.md`, scope: 'user' }, { source: 'codex', path: `/home/u/.claude/rules/sec/r${i}.md`, scope: 'user' }],
    }));
    const skills = [
      { id: 's-dup-1', kind: 'skill', scope: 'user', defaultStatus: 'candidate', name: 'deploy', path: '/home/u/.claude/skills/deploy/SKILL.md', tokens: 20, origins: [{ source: 'claude', path: '/home/u/.claude/skills/deploy/SKILL.md', scope: 'user' }] },
      { id: 's-dup-2', kind: 'skill', scope: 'user', defaultStatus: 'shadowed', shadowedBy: 'choice', name: 'deploy', path: '/home/u/.agents/skills/deploy/SKILL.md', tokens: 20, origins: [{ source: 'codex', path: '/home/u/.agents/skills/deploy/SKILL.md', scope: 'user' }] },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `s-big-${i}`, kind: 'skill', scope: 'user', defaultStatus: 'candidate', name: `tool-${i}`,
        path: `/home/u/.codex/skills/tool-${i}/SKILL.md`, tokens: 12, origins: [{ source: 'codex', path: `/home/u/.codex/skills/tool-${i}/SKILL.md`, scope: 'user' }],
      })),
    ];
    const scanEntries = [
      { id: 'u-agents', kind: 'instruction', scope: 'user', defaultStatus: 'candidate', name: 'AGENTS.md', path: '/home/u/.claude/CLAUDE.md', tokens: 15, origins: [{ source: 'claude', path: '/home/u/.claude/CLAUDE.md', scope: 'user' }] },
      ...rules,
      ...skills,
    ];

    const kindsState = {
      instruction: { value: { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } },
      skill: { value: { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } },
      mcp: { value: { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } },
      hooks: { value: { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } },
    };
    const computeEntries = (entries, kindsMap) => entries.map(e => {
      const val = (kindsMap[e.kind]?.value ?? kindsMap[e.kind]) ?? {};
      const tier = e.scope === 'user' ? val.user : val.directory;
      const excluded = (tier?.excludePaths ?? []).some(p => p === e.path);
      return { ...e, status: excluded ? 'excluded' : (e.defaultStatus ?? 'candidate') };
    });
    const settingsWrites = [];
    let failSettings = false;
    const rootsState = { instruction: { value: [] }, skill: { value: [] }, mcp: { value: [] } };
    const cloneSettings = () => ({
      home: '/home/u',
      defaults: { kinds: structuredClone(kindsState), roots: structuredClone(rootsState) },
      places: [{ current: true, saved: false, cwd: '/repo', kinds: structuredClone(kindsState), roots: structuredClone(rootsState) }],
    });

    const settingsCmd = async (command, payload) => {
      if (command === 'contextSettings') return cloneSettings();
      if (command === 'setContextSettings') {
        if (failSettings) throw new Error('boom-settings');
        settingsWrites.push(payload);
        if (payload?.kind && payload?.value) {
          const v = kindsState[payload.kind].value;
          if (payload.value.user) v.user = { ...v.user, ...payload.value.user };
          if (payload.value.directory) v.directory = { ...v.directory, ...payload.value.directory };
        }
        return cloneSettings();
      }
      if (command === 'scanContext') return { entries: computeEntries(scanEntries, kindsState), budget: { total: 4000, used: 200 } };
      if (command === 'plyInstructions') return { items: [{ id: 'ply-1', name: 'ルール1', on: true, tokens: 8, text: 'x', target: 'all', tag: 'user', agents: ['claude'] }], agents: [{ id: 'claude', label: 'Claude' }], total: 8, routing: false };
      if (command === 'scanHooks') return { entries: [{ id: 'hk-1', name: '保存時チェック', event: 'PostToolUse', agent: 'antigravity', scope: 'user', enabled: true, command: 'echo ok', type: 'command' }], files: [], home: '/home/u', order: {} };
      if (command === 'plyHooks') return { owner: 'native', entries: [] };
      if (command === 'listPlyMcp') return { servers: [{ id: 'm1', name: 'local', transport: 'stdio', command: 'node', args: [] }] };
      if (command === 'agentMcp') return { agents: {} };
      if (command === 'mcpMatrix') return {
        agents: ['claude', 'codex'],
        rows: [{ key: 'srv-1', name: 'github', kind: 'config', group: 'agent', origins: ['claude'], cells: { claude: { mode: 'locked', reason: 'own', state: 'on' }, codex: { mode: 'toggle', state: 'on' } } }],
      };
      if (command === 'recentPlaces') return { places: ['/repo'] };
      if (command === 'backends') return [{ id: 'claude', name: 'Claude', capabilities: { plyContext: 'turn' } }];
      return {};
    };

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
      p.querySelector('#cx-tab-instruction .c')?.textContent === '11'
      && p.querySelector('#cx-tab-skill .c')?.textContent === '10'
      && p.querySelector('#cx-tab-mcp .c')?.textContent === '1'
      && p.querySelector('#cx-tab-hooks .c')?.textContent === '1',
      [
        p.querySelector('#cx-tab-instruction .c')?.textContent,
        p.querySelector('#cx-tab-skill .c')?.textContent,
        p.querySelector('#cx-tab-mcp .c')?.textContent,
        p.querySelector('#cx-tab-hooks .c')?.textContent,
      ].join(','));

    // スクロール先頭リセット + タブ記憶 + 担当 2 択の維持
    dom.scroller.scrollTop = 240;
    p.querySelector('#cx-tab-mcp').onclick();
    await settle();
    t.ok('タブ切替で親スクロール先頭へ戻り、最後のタブを記憶する',
      dom.scroller.scrollTop === 0 && dom.store.get('ply-context-tab') === 'mcp'
      && p.querySelector('#cx-panel-mcp').hidden === false);
    p.querySelector('#cx-tab-instruction').onclick();
    await settle();

    t.ok('段 2・3 までの担当 2 択と指示の量の目安を残している',
      p.querySelector('#cxInstructionBudget') != null && p.querySelectorAll('.cx-seg').length >= 1);

    // 9 件の rules まとまりは初期折りたたみ → 開く（親ロゴ・パス繰り返し無し）→ 子 1 つオフで mixed → まとめ切替で 1 回保存
    const ruleBundle = p.querySelector('#cx-panel-instruction .cx-row.grp');
    t.ok('8 件超の指示フォルダーまとまりは最初は折りたたまれている',
      ruleBundle != null && ruleBundle.querySelector('.cx-tw').getAttribute('aria-expanded') === 'false'
      && p.querySelectorAll('#cx-panel-instruction .cx-row.kid').length === 0);

    ruleBundle.querySelector('.cx-tw').onclick();
    await settle();
    const ruleKids = p.querySelectorAll('#cx-panel-instruction .cx-row.kid');
    t.ok('まとまりを開くと 9 件の .cx-row.kid が出て、子の行には出どころのロゴを繰り返さない',
      ruleKids.length === 9 && ruleKids.every(k => k.querySelector('.cx-src') == null));

    ruleKids[0].querySelector('.cx-sw').onclick();
    await settle();
    const grpSwAfterOne = p.querySelector('#cx-panel-instruction .cx-row.grp .cx-sw');
    t.ok('子 1 件を切るとまとまりスイッチが role="checkbox" の aria-checked="mixed" になる',
      grpSwAfterOne.getAttribute('role') === 'checkbox'
      && grpSwAfterOne.getAttribute('aria-checked') === 'mixed');

    const beforeWrites = settingsWrites.length;
    grpSwAfterOne.onclick();
    await settle();
    const grpSwAfterBatch = p.querySelector('#cx-panel-instruction .cx-row.grp .cx-sw');
    t.ok('mixed 状態のまとまりスイッチを押すと 1 回の保存ですべて有効に戻る',
      settingsWrites.length === beforeWrites + 1
      && grpSwAfterBatch?.getAttribute('aria-checked') === 'true'
      && kindsState.instruction.value.user.excludePaths.length === 0,
      `writes=${settingsWrites.length - beforeWrites} checked=${grpSwAfterBatch?.getAttribute('aria-checked')} excl=${kindsState.instruction.value.user.excludePaths.length}`);

    grpSwAfterBatch.onclick();
    await settle();
    t.ok('全有効のまとまりスイッチを押すと 1 回の保存ですべて無効になる',
      settingsWrites.length === beforeWrites + 2
      && p.querySelector('#cx-panel-instruction .cx-row.grp .cx-sw')?.getAttribute('aria-checked') === 'false'
      && kindsState.instruction.value.user.excludePaths.length === 9);

    // Skills タブ: 絞り込み欄を壊さず保ち、当たったまとまりが開き、0 件で「見つかりません」、Escape で戻る
    p.querySelector('#cx-tab-skill').onclick();
    await settle();
    const findInput = p.querySelector('#cx-panel-skill .cx-find input');
    t.ok('Skills タブに 9 件以上のまとまりがあり最初は閉じている',
      p.querySelectorAll('#cx-panel-skill .cx-row.kid').length === 1,
      `kids=${p.querySelectorAll('#cx-panel-skill .cx-row.kid').length}`); // deploy の 1 件まとまりだけ展開、9 件の user は閉じ
    findInput.focus();
    findInput.value = 'tool-7';
    findInput.setSelectionRange(6, 6);
    findInput.dispatchEvent({ type: 'input' });
    await settle();
    const findInputAfter = p.querySelector('#cx-panel-skill .cx-find input');
    t.ok('絞り込み中も input 要素を差し替えず、当たったまとまりが自動で開く',
      findInputAfter === findInput && findInputAfter.value === 'tool-7'
      && p.querySelectorAll('#cx-panel-skill .cx-row.kid').length === 1
      && p.querySelector('#cx-panel-skill .cx-row.kid .nm')?.textContent === 'tool-7');

    findInput.value = 'no-match-xyz';
    findInput.dispatchEvent({ type: 'input' });
    await settle();
    t.ok('一致 0 件で「見つかりません」を表示する',
      p.querySelector('#cx-panel-skill').textContent.includes('見つかりません'));

    findInput.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
    await settle();
    t.ok('Escape で絞り込みを解除して通常一覧に戻る',
      findInput.value === '' && !p.querySelector('#cx-panel-skill').textContent.includes('見つかりません'));

    // 絞り込み中のまとまりスイッチは、見えている行だけを切り替える（状態も見えている行だけから決める）
    const skillEx = () => kindsState.skill.value.user.excludePaths.length;
    t.ok('絞り込みの前は Skills の除外が 0 件', skillEx() === 0);
    findInput.value = 'tool-7';
    findInput.dispatchEvent({ type: 'input' });
    await settle();
    const fSw = () => p.querySelector('#cx-panel-skill .cx-row.grp .cx-sw');
    t.ok('絞り込み中のまとまりスイッチは見えている 1 行だけからオンと決まる', fSw().getAttribute('aria-checked') === 'true');
    fSw().onclick();
    await settle();
    t.ok('絞り込み中のまとまりスイッチで、当たった 1 件だけが除外に入る（9 件ではない）',
      skillEx() === 1 && fSw().getAttribute('aria-checked') === 'false', `excl=${skillEx()}`);
    findInput.value = '';
    findInput.dispatchEvent({ type: 'input' });
    await settle();
    const mixedSw = [...p.querySelectorAll('#cx-panel-skill .cx-row.grp .cx-sw')].find(x => x.getAttribute('aria-checked') === 'mixed');
    t.ok('絞り込みを消すとまとまり全体の状態（一部）に戻る', Boolean(mixedSw));
    mixedSw.onclick();
    await settle();
    t.ok('一部のまとまりスイッチを押すと除外が 0 件に戻る', skillEx() === 0);

    // 保存に失敗したときは、押した瞬間に変えた見た目を、保存されている状態から描き直す
    const oneSw = () => p.querySelector('#cx-panel-skill .cx-row:not(.grp) .cx-sw, #cx-panel-skill .cx-row.kid .cx-sw');
    const grpOf = () => [...p.querySelectorAll('#cx-panel-skill .cx-row.grp .cx-sw')][0];
    const beforeGrp = grpOf().getAttribute('aria-checked');
    failSettings = true;
    grpOf().onclick();
    await settle();
    t.ok('まとめて切り替える保存に失敗したら、スイッチは保存されている状態（元のまま）に描き直され、失敗が出る',
      grpOf().getAttribute('aria-checked') === beforeGrp && skillEx() === 0
      && p.querySelector('.cx-status')?.textContent.includes('boom-settings'),
      `checked=${grpOf().getAttribute('aria-checked')} before=${beforeGrp} status=${p.querySelector('.cx-status')?.textContent}`);
    const beforeOne = oneSw().getAttribute('aria-checked');
    oneSw().onclick();
    await settle();
    t.ok('1 件の切替に失敗したときも、同じく元の状態へ描き直される', oneSw().getAttribute('aria-checked') === beforeOne && skillEx() === 0);
    failSettings = false;

    // ---------------- 2. 会話の右パネル編集モード（web/session-context.mjs） ----------------
    const rightScroller = new PanelNode('div');
    rightScroller.className = 'file-preview-content';
    dom.body.append(rightScroller);
    let panelBody = null, panelOpened = false;
    const placeKinds = {
      instruction: { value: { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } },
      skill: { value: { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } },
      mcp: { value: { owner: 'ply', user: { sources: ['claude'], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } },
    };
    const rightWrites = [];
    let failRight = false;
    const rightEntries = [
      { id: 're-1', kind: 'instruction', scope: 'dir', rule: true, defaultStatus: 'candidate', name: 'a.md', path: '/repo/.claude/rules/a.md', tokens: 10, origins: [{ source: 'claude', path: '/repo/.claude/rules/a.md', scope: 'dir' }] },
      { id: 're-2', kind: 'instruction', scope: 'dir', rule: true, defaultStatus: 'candidate', name: 'b.md', path: '/repo/.claude/rules/b.md', tokens: 10, origins: [{ source: 'claude', path: '/repo/.claude/rules/b.md', scope: 'dir' }] },
      { id: 'rm-1', kind: 'mcp', scope: 'dir', defaultStatus: 'candidate', name: 'gh', path: '/repo/.mcp.json', tokens: 10, origins: [{ source: 'claude', path: '/repo/.mcp.json', scope: 'dir' }] },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `rs-${i}`, kind: 'skill', scope: 'dir', defaultStatus: 'candidate', name: `sk-${i}`, path: `/repo/.claude/skills/sk-${i}/SKILL.md`, tokens: 12, origins: [{ source: 'claude', path: `/repo/.claude/skills/sk-${i}/SKILL.md`, scope: 'dir' }],
      })),
    ];

    const scCmd = async (command, payload) => {
      if (command === 'backends') return [{ id: 'fake', capabilities: { plyContext: 'turn' } }];
      if (command === 'contextSettings') return {
        defaults: { kinds: structuredClone(placeKinds), roots: {} },
        places: [{ current: true, saved: false, cwd: '/repo', kinds: structuredClone(placeKinds), roots: { instruction: { sources: ['claude'] }, skill: { sources: ['claude'] }, mcp: { sources: ['claude'] } } }],
      };
      if (command === 'setContextSettings') {
        if (failRight) throw new Error('boom-right');
        rightWrites.push(payload);
        if (payload?.kind && payload?.value) {
          const v = placeKinds[payload.kind].value;
          if (payload.value.user) v.user = { ...v.user, ...payload.value.user };
          if (payload.value.directory) v.directory = { ...v.directory, ...payload.value.directory };
        }
        return {
          defaults: { kinds: structuredClone(placeKinds), roots: {} },
          places: [{ current: true, saved: true, cwd: '/repo', kinds: structuredClone(placeKinds), roots: { instruction: { sources: ['claude'] }, skill: { sources: ['claude'] }, mcp: { sources: ['claude'] } } }],
        };
      }
      if (command === 'scanContext' || command === 'nativeInstructions') return { entries: computeEntries(rightEntries, placeKinds) };
      if (command === 'plyInstructions') return { items: [{ id: 'p1', name: '基本', on: true, tokens: 5, text: 'x', target: 'all', tag: 'user', agents: ['claude'] }], agents: [{ id: 'claude', label: 'Claude' }], total: 5, routing: false };
      if (command === 'plyHooks') return { place: { value: { owner: 'ply' } }, defaults: { value: { owner: 'ply' } }, hooks: [{ id: 'h1', name: 'hook1', enabled: true, scope: 'project', event: 'PostToolUse', targets: ['claude'] }] };
      if (command === 'listPlyMcp') return { servers: [{ id: 'm1', name: 'reg-mcp', transport: 'stdio', command: 'x', args: [] }] };
      if (command === 'agentMcp') return { agents: {} };
      if (command === 'mcpMatrix') return { agents: ['claude'], rows: [{ key: 'r1', name: 'gh', kind: 'config', group: 'agent', origins: ['claude'], cells: { claude: { mode: 'toggle', state: 'on' } } }] };
      return {};
    };

    const mountBody = node => { rightScroller.replaceChildren(node); panelBody = node; };
    const rightPanel = setupSessionContext({
      cmd: scCmd,
      preview: {
        panelOpen: () => panelOpened,
        openPanel: opts => { panelOpened = true; mountBody(opts.body); },
        updatePanel: (_k, opts) => { mountBody(opts.body); },
      },
      session: () => ({ id: 's1', backend: 'fake', cwd: '/repo' }),
      labelOf: () => 'Fake',
      info: () => ({ report: { status: 'ply', cwd: '/repo', entries: computeEntries(rightEntries, placeKinds) }, owners: { instruction: 'ply', skill: 'ply', mcp: 'ply', hooks: 'ply' } }),
      refreshInfo() {},
      openSettings() {},
    });

    rightPanel.open();
    await settle();
    t.ok('右パネルの通常面（編集前）には 4 タブを出さない', panelBody.querySelectorAll('[role="tab"]').length === 0);

    await panelBody.querySelector('[data-act="placeStart"]').onclick();
    await settle();
    t.ok('「この場所だけ変える」に入ると右パネルにも 4 タブ・件数が出る',
      panelBody.querySelectorAll('[role="tab"]').length === 4
      && panelBody.querySelector('#scx-tab-instruction .c')?.textContent === '2'
      && panelBody.querySelector('#scx-tab-skill .c')?.textContent === '9'
      && panelBody.querySelector('#scx-tab-mcp .c')?.textContent === '1'
      && panelBody.querySelector('#scx-tab-hooks .c')?.textContent === '1',
      [
        panelBody.querySelector('#scx-tab-instruction .c')?.textContent,
        panelBody.querySelector('#scx-tab-skill .c')?.textContent,
        panelBody.querySelector('#scx-tab-mcp .c')?.textContent,
        panelBody.querySelector('#scx-tab-hooks .c')?.textContent,
      ].join(','));

    // まとまりと一括切替
    const scxInstGrp = panelBody.querySelector('#scx-panel-instruction .cx-row.grp');
    t.ok('右パネル編集モードの 2 件まとまりは開いて .cx-row.kid を出し、子に個別スイッチがある',
      scxInstGrp != null && panelBody.querySelectorAll('#scx-panel-instruction .cx-row.kid').length === 2);

    await panelBody.querySelectorAll('#scx-panel-instruction .cx-row.kid .cx-sw')[0].onclick();
    await settle();
    const scxMixSw = panelBody.querySelector('#scx-panel-instruction .cx-row.grp .cx-sw');
    t.ok('右パネルでも子 1 つオフでまとまりスイッチが checkbox mixed になる',
      scxMixSw.getAttribute('role') === 'checkbox' && scxMixSw.getAttribute('aria-checked') === 'mixed');

    const rwBefore = rightWrites.length;
    await scxMixSw.onclick();
    await settle();
    t.ok('右パネルの mixed スイッチ押下で残りも一括 1 回保存になり全有効に戻る',
      rightWrites.length === rwBefore + 1
      && panelBody.querySelector('#scx-panel-instruction .cx-row.grp .cx-sw').getAttribute('aria-checked') === 'true');

    // タブ切替 → スクロールリセット・記憶、Skills 絞り込み
    rightScroller.scrollTop = 180;
    panelBody.querySelector('#scx-tab-skill').onclick();
    await settle();
    t.ok('右パネルでもタブ切替で .file-preview-content の scrollTop が 0 に戻り、タブを記憶する',
      rightScroller.scrollTop === 0 && dom.store.get('ply-session-context-tab') === 'skill');

    const scxFind = panelBody.querySelector('#scx-panel-skill .cx-find input');
    t.ok('右パネル Skills の 9 件まとまりは最初は閉じており、絞り込み入力欄がある',
      scxFind != null && panelBody.querySelectorAll('#scx-panel-skill .cx-row.kid').length === 0);

    scxFind.focus();
    scxFind.value = 'sk-5';
    scxFind.setSelectionRange(4, 4);
    scxFind.dispatchEvent({ type: 'input' });
    await settle();
    t.ok('右パネル Skills の絞り込み中も input を作り直さず、当たったまとまりが開く',
      panelBody.querySelector('#scx-panel-skill .cx-find input') === scxFind
      && panelBody.querySelectorAll('#scx-panel-skill .cx-row.kid').some(k => k.textContent.includes('sk-5')));

    scxFind.value = 'none-at-all';
    scxFind.dispatchEvent({ type: 'input' });
    await settle();
    t.ok('右パネル Skills で 0 件なら「見つかりません」が出る',
      panelBody.querySelector('#scx-panel-skill').textContent.includes('見つかりません'));

    // 絞り込み中のまとまりスイッチは見えている行だけ。保存の失敗は保存されている状態から描き直す
    const placeEx = () => placeKinds.skill.value.directory.excludePaths.length;
    scxFind.value = 'sk-3';
    scxFind.dispatchEvent({ type: 'input' });
    await settle();
    const scxFSw = () => panelBody.querySelector('#scx-panel-skill .cx-row.grp .cx-sw');
    t.ok('右パネルの絞り込み中のスイッチは見えている 1 行だけからオンと決まる', scxFSw().getAttribute('aria-checked') === 'true');
    await scxFSw().onclick();
    await settle();
    t.ok('右パネルの絞り込み中のまとまりスイッチで、当たった 1 件だけが除外に入る',
      placeEx() === 1 && scxFSw().getAttribute('aria-checked') === 'false', `excl=${placeEx()}`);
    scxFind.value = '';
    scxFind.dispatchEvent({ type: 'input' });
    await settle();
    const scxMixed = [...panelBody.querySelectorAll('#scx-panel-skill .cx-row.grp .cx-sw')].find(x => x.getAttribute('aria-checked') === 'mixed');
    t.ok('右パネルでも、絞り込みを消すと「一部」に戻る', Boolean(scxMixed));
    await scxMixed.onclick();
    await settle();
    t.ok('右パネルの一部のスイッチを押すと除外が 0 件に戻る', placeEx() === 0);
    const scxGrp = () => panelBody.querySelector('#scx-panel-skill .cx-row.grp .cx-sw');
    const scxBefore = scxGrp().getAttribute('aria-checked');
    failRight = true;
    await scxGrp().onclick();
    await settle();
    t.ok('右パネルでも、まとめて切り替える保存に失敗したら保存されている状態へ描き直し、失敗が出る',
      scxGrp().getAttribute('aria-checked') === scxBefore && placeEx() === 0 && panelBody.textContent.includes('boom-right'),
      `checked=${scxGrp().getAttribute('aria-checked')} before=${scxBefore}`);
    failRight = false;

    await panelBody.querySelector('[data-act="placeDone"]').onclick();
    await settle();
    t.ok('編集終了で通常面へ戻る', panelBody.querySelectorAll('[role="tab"]').length === 0);
  } finally {
    dom.restore();
    await setLanguage('ja');
  }
}
