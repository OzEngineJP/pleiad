// 設定 › プラグイン・会話の右パネルの 4 タブ・フォルダーまとまり・絞り込み（web/context-tabs.mjs）と、
// 鍵の吹き出し（web/lock-tip.mjs）の単位テスト。
import { N } from '../lib/dom-stub.mjs';
import { setLanguage } from '../../web/i18n.mjs';
import {
  LOCK_REASONS, lockReasonKey, lockReasonText, lockAriaLabel, joinLockReasons, spokenLockReason,
  hideLockTip, ensureLockTips, _resetLockTipForTest,
} from '../../web/lock-tip.mjs';
import { agentName, agentShortLabel, forgetAgentNames, rememberAgentNames, setAgentBrands } from '../../web/agent-brands.mjs';
import {
  CONTEXT_TABS, BUNDLE_COLLAPSE_AFTER,
  readTabStorage, writeTabStorage,
  bundleFolder, bundleLabel, groupEntries,
  createTabBar, createFindBar, originMarks,
} from '../../web/context-tabs.mjs';
import {
  docBundleMeta, wholeState, wholeNext, recalcDocRow, applyDocBundleLocal,
  docFixedReasons, docLockReason, docRowLockSummary, docReasonKey, lockedAgentChip, agentLegend, wholeSwitch,
} from '../../web/context-matrix.mjs';

export const name = 'context-tabs-and-lock-tip';
export const title = 'プラグインの 4 タブ・フォルダーまとまり・絞り込みと、鍵の吹き出し';

function parseCompound(sel) {
  let tag = null, id = null;
  const classes = [], attrs = [], pseudo = [];
  let rest = sel.trim().replace(/:(focus-visible)\b/g, (_, p) => { pseudo.push(p); return ''; });
  rest = rest.replace(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_, k, d, s, u) => {
    attrs.push([k.trim(), d !== undefined || s !== undefined || u !== undefined ? (d ?? s ?? u ?? '') : null]);
    return '';
  });
  rest = rest.replace(/#([^\s.#]+)/g, (_, v) => { id = v; return ''; });
  rest = rest.replace(/\.([^\s.#]+)/g, (_, v) => { classes.push(v); return ''; });
  if (rest.trim()) tag = rest.trim().toUpperCase();
  return { tag, id, classes, attrs, pseudo };
}

function matchesSimple(node, sel) {
  if (!(node instanceof N)) return false;
  const { tag, id, classes, attrs, pseudo } = parseCompound(sel);
  if (tag && node.tagName !== tag) return false;
  if (id && node.id !== id) return false;
  const cls = node._classes();
  for (const c of classes) if (!cls.includes(c)) return false;
  for (const [k, v] of attrs) {
    if (!node.hasAttribute(k)) return false;
    if (v !== null && String(node.getAttribute(k)) !== v) return false;
  }
  for (const p of pseudo) if (p === 'focus-visible' && !node._focusVisible) return false;
  return true;
}

class TestNode extends N {
  constructor(tag) {
    super(tag);
    this._rect = { left: 100, right: 140, top: 200, bottom: 240, width: 40, height: 40 };
    this._focusVisible = false;
  }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get value() { return this.attrs.value ?? ''; }
  set value(v) { this.attrs.value = String(v ?? ''); }
  get parentElement() { return this.parent instanceof N ? this.parent : null; }
  get isConnected() {
    for (let x = this; x; x = x.parent) if (x === globalThis.document?.body || x === globalThis.document?.documentElement) return true;
    return false;
  }
  getBoundingClientRect() { return { ...this._rect }; }
  matches(sel) {
    return sel.split(',').some(part => {
      const tokens = part.trim().split(/\s+/);
      return tokens.length === 1 && matchesSimple(this, tokens[0]);
    });
  }
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
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  dispatchEvent(ev) {
    const h = this[`on${ev.type}`];
    if (typeof h === 'function') h(ev);
    return super.dispatchEvent(ev);
  }
}

function makeEnv() {
  const docListeners = new Map();
  const winListeners = new Map();
  const store = new Map();
  const timers = [];
  let now = 0, nextId = 1;
  const html = new TestNode('html');
  const body = new TestNode('body');
  html.append(body);

  const dispatchDoc = (type, ev) => {
    for (const entry of docListeners.get(type) ?? []) entry.fn(ev);
  };
  const dispatchWin = (type, ev) => {
    for (const entry of winListeners.get(type) ?? []) entry.fn(ev);
  };
  const makeEvent = (type, target, extra = {}) => ({
    type, target, currentTarget: globalThis.document,
    defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...extra,
  });

  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    getComputedStyle: globalThis.getComputedStyle,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  globalThis.document = {
    documentElement: html,
    body,
    activeElement: body,
    createElement: tag => new TestNode(tag),
    createElementNS: (_ns, tag) => new TestNode(tag),
    createTextNode: text => { const n = new TestNode('#text'); n.textContent = text; return n; },
    addEventListener(type, fn, opts) {
      const list = docListeners.get(type) ?? [];
      list.push({ fn, capture: Boolean(opts === true || opts?.capture) });
      docListeners.set(type, list);
    },
    getElementById(id) { return html.querySelector(`#${id}`); },
    querySelector: sel => html.querySelector(sel),
  };
  globalThis.window = {
    addEventListener(type, fn, opts) {
      const list = winListeners.get(type) ?? [];
      list.push({ fn, capture: Boolean(opts === true || opts?.capture) });
      winListeners.set(type, list);
    },
  };
  globalThis.getComputedStyle = el => ({
    position: el?.classList?.contains('cx-tabs') ? 'sticky' : 'static',
    overflowY: el?.classList?.contains('settings-content') ? 'auto' : 'visible',
    overflowX: 'visible',
  });
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = nextId++;
    timers.push({ id, at: now + ms, fn, cleared: false });
    return id;
  };
  globalThis.clearTimeout = id => {
    for (const x of timers) if (x.id === id) x.cleared = true;
  };

  const advance = ms => {
    now += ms;
    while (true) {
      const next = timers.filter(x => !x.cleared && x.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.cleared = true;
      next.fn();
    }
  };

  return {
    body,
    store,
    advance,
    dispatchDoc,
    dispatchWin,
    makeEvent,
    restore() {
      _resetLockTipForTest();
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.localStorage = saved.localStorage;
      globalThis.getComputedStyle = saved.getComputedStyle;
      globalThis.innerWidth = saved.innerWidth;
      globalThis.innerHeight = saved.innerHeight;
      globalThis.setTimeout = saved.setTimeout;
      globalThis.clearTimeout = saved.clearTimeout;
    },
  };
}

export default async function (t) {
  const env = makeEnv();
  try {
    await setLanguage('ja');

    // 1. 鍵の理由コードと文言（5 種類 + cell.reason 優先 + mode フォールバック）
    t.ok('LOCK_REASONS は 8 種類の理由コードを持つ（nolinks は ADR 0336、bundled は ADR 0337 の Antigravity の Skill、devinHooks は ADR 0338 の Hook を渡す場所の Devin）',
      ['own', 'workspace', 'relay', 'admin', 'linked', 'nolinks', 'bundled', 'devinHooks'].every(k => LOCK_REASONS.has(k)) && LOCK_REASONS.size === 8
      && !lockReasonText('Antigravity', { reason: 'bundled' }).includes('context.lockReason')
      && lockReasonText('Devin', { reason: 'devinHooks' }).includes('Devin') && !lockReasonText('Devin', { reason: 'devinHooks' }).includes('context.lockReason'));

    t.ok('lockReasonKey は cell.reason を優先し、無ければ mode から決める',
      lockReasonKey({ mode: 'locked', reason: 'admin' }) === 'admin'
      && lockReasonKey({ mode: 'blocked', reason: 'workspace' }) === 'workspace'
      && lockReasonKey({ mode: 'locked', reason: 'linked' }) === 'linked'
      && lockReasonKey({ mode: 'blocked' }) === 'relay'
      && lockReasonKey({ mode: 'locked' }) === 'own'
      && lockReasonKey({ mode: 'locked', reason: 'bogus' }) === 'own');

    const reasonsJa = {
      own: lockReasonText('Claude', { mode: 'locked' }),
      workspace: lockReasonText('Codex', { reason: 'workspace' }),
      relay: lockReasonText('Grok', { mode: 'blocked' }),
      admin: lockReasonText('Devin', { reason: 'admin' }),
      linked: lockReasonText('Codex', { reason: 'linked' }),
      nolinks: lockReasonText('Devin', { mode: 'locked', reason: 'nolinks' }),
    };
    t.ok('日本語の 5 種類の理由文がモック追補 1 の文言と一致する',
      reasonsJa.own === 'Claude の設定にあるため、Pleiad からは止められません'
      && reasonsJa.workspace === 'Codex が作業場所から直接読むため、Pleiad からは止められません'
      && reasonsJa.relay === 'Grok には Pleiad から渡せません'
      && reasonsJa.admin === '管理者が Devin に設定しています'
      && reasonsJa.linked === 'Codex には委譲の設定に合わせて渡します');
    t.ok('nolinks の理由文（Windows の開発者モードが off）', reasonsJa.nolinks === 'Windows の開発者モードがオフのため、Pleiad からは止められません', reasonsJa.nolinks);

    t.ok('lockAriaLabel は元の名前に括弧で理由を添える',
      lockAriaLabel('Claude の 設定', reasonsJa.own) === 'Claude の 設定（Claude の設定にあるため、Pleiad からは止められません）');

    // 理由が 2 つ以上のときは「／」で 1 文につながず、理由ごとに行を分ける。読み上げでは 1 つずつ文として区切る
    const twoJa = joinLockReasons([reasonsJa.workspace, reasonsJa.relay, reasonsJa.workspace, '', null]);
    t.ok('joinLockReasons は理由ごとに改行で分け、重複と空を落とし、無ければ null',
      twoJa === `${reasonsJa.workspace}\n${reasonsJa.relay}` && !twoJa.includes('／')
      && joinLockReasons([]) === null && joinLockReasons(undefined) === null && joinLockReasons(['', ' ']) === null
      && joinLockReasons(reasonsJa.own) === reasonsJa.own, twoJa);
    const spokenJa = spokenLockReason(twoJa);
    t.ok('spokenLockReason は 1 つなら元のまま、複数なら 1 つずつ文末の「。」で区切る',
      spokenLockReason(reasonsJa.own) === reasonsJa.own && spokenLockReason('') === ''
      && spokenJa === `${reasonsJa.workspace}。 ${reasonsJa.relay}。`
      && spokenLockReason('A。\nB') === 'A。 B。', spokenJa);
    t.ok('lockAriaLabel は複数の理由を、文として区切れる形で括弧の中に添える（改行は読み上げに残さない）',
      lockAriaLabel('指示', twoJa) === `指示（${spokenJa}）` && !lockAriaLabel('指示', twoJa).includes('\n'));

    // 吹き出し・知らせ・読み上げの {{agent}} は、表の個々のマスの吹き出しと同じ表示名。一覧に無い id でも内部のキーを出さない
    forgetAgentNames();   // 前の試験が控えた表示名を持ち込まない
    t.ok('agentShortLabel は一覧にも表の labels にも無い id なら null、agentName は「いずれかのエージェント」（内部の id を返さない）',
      agentShortLabel('unlisted-agent') === null && agentName('unlisted-agent') === 'いずれかのエージェント' && agentName(undefined) === 'いずれかのエージェント');
    rememberAgentNames({ devin: 'Devin', grok: 'Grok', claude: 'Claude', bad: 7, '': 'x' });
    rememberAgentNames(null); rememberAgentNames('x');
    t.ok('rememberAgentNames の後は devin・grok・claude が表示名になり、数値や空の id は控えない',
      agentName('devin') === 'Devin' && agentName('grok') === 'Grok' && agentName('claude') === 'Claude'
      && agentShortLabel('bad') === null && agentName('bad') === 'いずれかのエージェント');
    setAgentBrands([{ id: 'devin', label: 'Devin Pro', shortLabel: 'Dv' }]);
    t.ok('エージェントの一覧にある id は、一覧の短い名前を優先する',
      agentName('devin') === 'Dv' && agentName('grok') === 'Grok');
    setAgentBrands([]);
    const devinLock = lockReasonText(agentName('devin'), { reason: 'devinHooks' });
    const grokLock = lockReasonText(agentName('grok'), { reason: 'workspace' });
    t.ok('行の鍵の吹き出し（lockReasonText に渡す名前）に、内部のキー devin・grok が入らない',
      devinLock.includes('Devin') && !/\bdevin\b/.test(devinLock) && grokLock.includes('Grok') && !/\bgrok\b/.test(grokLock), `${devinLock} / ${grokLock}`);

    await setLanguage('en');
    const enOwn = lockReasonText('Claude', { mode: 'locked' });
    const enAria = lockAriaLabel('Claude setting', enOwn);
    t.ok('英語ロケールでも理由文と読み上げ名が組み立てられる',
      enOwn.includes('Claude') && enAria === `Claude setting (${enOwn})`, enOwn);
    const enTwo = joinLockReasons([lockReasonText('Codex', { reason: 'workspace' }), lockReasonText('Grok', { mode: 'blocked' })]);
    const enSpoken = spokenLockReason(enTwo);
    t.ok('英語でも改行で分けた理由は、1 つずつ文末のピリオドで区切って読み上げる',
      enTwo.split('\n').length === 2 && enSpoken.split('. ').length === 2 && enSpoken.endsWith('.') && !enSpoken.includes('\n'), enSpoken);
    await setLanguage('ja');

    // 2. 鍵の吹き出しの対話（ホバー 150ms・フォーカス・タッチ・click 抑止・Escape 保持・スクロール・リサイズ）
    _resetLockTipForTest();
    ensureLockTips();
    const wrap = new TestNode('div'); wrap.className = 'cx';
    const tabs = new TestNode('div'); tabs.className = 'cx-tabs';
    tabs._rect = { left: 0, right: 1200, top: 0, bottom: 80, width: 1200, height: 80 };
    const anchor = new TestNode('button');
    anchor.className = 'cx-ag locked';
    anchor.dataset.tip = reasonsJa.own;
    anchor._rect = { left: 300, right: 340, top: 180, bottom: 220, width: 40, height: 40 };
    const other = new TestNode('button');
    other.textContent = '外';
    wrap.append(tabs, anchor, other);
    env.body.append(wrap);

    const tipEl = () => env.body.querySelector('.cx-tip');
    // ホバー: 149ms では出ず、150ms で出る
    env.dispatchDoc('pointerover', env.makeEvent('pointerover', anchor, { pointerType: 'mouse' }));
    env.advance(140);
    t.ok('ホバー開始 140ms ではまだ吹き出しを出さない', !tipEl()?.classList.contains('on'));
    env.advance(20);
    t.ok('ホバー 150ms 経過後に吹き出しが出、文言と aria-hidden="true" を持つ',
      tipEl()?.classList.contains('on') && tipEl()?.getAttribute('aria-hidden') === 'true' && tipEl()?.textContent === reasonsJa.own);
    // 同じ相手からの pointerout で閉じ、途中の pointerout ならタイマーも止める
    env.dispatchDoc('pointerout', env.makeEvent('pointerout', anchor, { relatedTarget: other }));
    t.ok('ホバーが外れると吹き出しが閉じる', !tipEl()?.classList.contains('on'));
    env.dispatchDoc('pointerover', env.makeEvent('pointerover', anchor, { pointerType: 'mouse' }));
    env.advance(50);
    env.dispatchDoc('pointerout', env.makeEvent('pointerout', anchor, { relatedTarget: other }));
    env.advance(200);
    t.ok('150ms 未満でホバーが外れたら吹き出しは出ない', !tipEl()?.classList.contains('on'));

    // キーボードフォーカス（:focus-visible）で即時に出て、Escape で閉じてもフォーカスを保持
    anchor._focusVisible = true;
    anchor.focus();
    env.dispatchDoc('focusin', env.makeEvent('focusin', anchor));
    t.ok(':focus-visible でフォーカスすると即時に吹き出しが出る', tipEl()?.classList.contains('on'));
    const escEv = env.makeEvent('keydown', anchor, { key: 'Escape' });
    env.dispatchDoc('keydown', escEv);
    t.ok('Escape で吹き出しが閉じ、フォーカスは同じボタンに残る',
      !tipEl()?.classList.contains('on') && escEv.defaultPrevented && escEv.propagationStopped
      && globalThis.document.activeElement === anchor);

    // focusout でも閉じる
    env.dispatchDoc('focusin', env.makeEvent('focusin', anchor));
    env.dispatchDoc('focusout', env.makeEvent('focusout', anchor));
    t.ok('focusout で吹き出しが閉じる', !tipEl()?.classList.contains('on'));
    anchor._focusVisible = false;

    // タッチタップ: click の規定動作・伝播を止めて開閉する
    env.dispatchDoc('pointerdown', env.makeEvent('pointerdown', anchor, { pointerType: 'touch' }));
    const clickEv1 = env.makeEvent('click', anchor);
    env.dispatchDoc('click', clickEv1);
    t.ok('鍵ボタンの click は preventDefault / stopPropagation され、タップで吹き出しが開く',
      clickEv1.defaultPrevented && clickEv1.propagationStopped && tipEl()?.classList.contains('on'));
    env.dispatchDoc('pointerdown', env.makeEvent('pointerdown', anchor, { pointerType: 'touch' }));
    env.dispatchDoc('click', env.makeEvent('click', anchor));
    t.ok('同じ相手をもう一度タップすると吹き出しが閉じる', !tipEl()?.classList.contains('on'));

    // スクロールで sticky タブ帯の裏へ隠れると閉じる + 外押し + リサイズで閉じる
    env.dispatchDoc('pointerdown', env.makeEvent('pointerdown', anchor, { pointerType: 'touch' }));
    env.dispatchDoc('click', env.makeEvent('click', anchor));
    t.ok('再表示できる', tipEl()?.classList.contains('on'));
    anchor._rect = { left: 300, right: 340, top: 60, bottom: 75, width: 40, height: 15 };
    env.dispatchWin('scroll', { type: 'scroll' });
    t.ok('スクロールで上のタブ帯（bottom: 80）に隠れると吹き出しを閉じる', !tipEl()?.classList.contains('on'));

    anchor._rect = { left: 300, right: 340, top: 180, bottom: 220, width: 40, height: 40 };
    env.dispatchDoc('pointerdown', env.makeEvent('pointerdown', anchor, { pointerType: 'touch' }));
    env.dispatchDoc('click', env.makeEvent('click', anchor));
    env.dispatchDoc('pointerdown', env.makeEvent('pointerdown', other, { pointerType: 'mouse' }));
    t.ok('外側を押すと吹き出しを閉じる', !tipEl()?.classList.contains('on'));

    env.dispatchDoc('pointerdown', env.makeEvent('pointerdown', anchor, { pointerType: 'touch' }));
    env.dispatchDoc('click', env.makeEvent('click', anchor));
    env.dispatchWin('resize', { type: 'resize' });
    t.ok('ウィンドウのリサイズで吹き出しを閉じる', !tipEl()?.classList.contains('on'));
    hideLockTip();

    // 3. web/context-tabs.mjs: CONTEXT_TABS・storage・bundleFolder/bundleLabel・groupEntries と、まとまりのスイッチの集計（web/context-matrix.mjs）
    t.ok('CONTEXT_TABS は 4 タブの順で、BUNDLE_COLLAPSE_AFTER は 8',
      CONTEXT_TABS.join(',') === 'instruction,skill,mcp,hooks' && BUNDLE_COLLAPSE_AFTER === 8);

    writeTabStorage('ply-test-tab', 'mcp');
    env.store.set('ply-bad-tab', 'unknown');
    t.ok('writeTabStorage / readTabStorage で有効なタブを復元し、未保存や不正値はフォールバックする',
      readTabStorage('ply-test-tab') === 'mcp'
      && readTabStorage('ply-bad-tab') === 'instruction'
      && readTabStorage('ply-missing-tab') === 'instruction');

    // localStorage が例外を投げてもメモリ退避で動く
    const prevLS = globalThis.localStorage;
    globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    writeTabStorage('ply-mem-tab', 'hooks');
    t.ok('localStorage が使えない環境でもメモリへ保存・読込できる', readTabStorage('ply-mem-tab') === 'hooks');
    globalThis.localStorage = prevLS;

    const skFolder = bundleFolder('skill', { path: 'C:\\Users\\alice\\.claude\\skills\\deploy\\SKILL.md', name: 'deploy' });
    const ruleFolder = bundleFolder('instruction', { path: '/repo/.claude/rules/web/style.md', name: 'style.md', rule: true });
    const docFolder = bundleFolder('instruction', { path: '/repo/AGENTS.md', name: 'AGENTS.md' });
    t.ok('bundleFolder は Skills を親 skills フォルダー、rules を /rules まで、一般指示を親フォルダーへまとめる',
      skFolder.folder === 'C:\\Users\\alice\\.claude\\skills' && skFolder.childLabel === 'deploy'
      && ruleFolder.folder === '/repo/.claude/rules' && ruleFolder.childLabel === 'web/style.md'
      && docFolder.folder === '/repo' && docFolder.childLabel === 'AGENTS.md');

    t.ok('bundleLabel は Skills に .claude/skills、それ以外にフォルダー名を返す',
      bundleLabel('/home/u/.claude/skills', 'skill') === '.claude/skills'
      && bundleLabel('/repo/.claude/rules', 'instruction') === 'rules');

    const instEntries = [
      { id: 'u1', path: '/home/u/AGENTS.md', name: 'AGENTS.md', origins: [{ source: 'claude' }] },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `r${i}`, path: `/repo/.claude/rules/g/${i}.md`, name: `${i}.md`, rule: true, origins: [{ source: i % 2 ? 'claude' : 'codex' }],
      })),
      { id: 'c1', path: '/repo/.claude/a.md', name: 'a.md', origins: [{ source: 'claude' }] },
      { id: 'c2', path: '/repo/.claude/b.md', name: 'b.md', origins: [{ source: 'claude' }] },
    ];
    const groupedInst = groupEntries('instruction', instEntries);
    const bigRuleBundle = groupedInst.find(x => x.type === 'bundle' && x.folder === '/repo/.claude/rules');
    const smallBundle = groupedInst.find(x => x.type === 'bundle' && x.folder === '/repo/.claude');
    const singletonRow = groupedInst.find(x => x.type === 'row');
    t.ok('groupEntries(instruction) は 1 件だけなら通常行、2 件は開き、9 件（>8）は初期折りたたみで origins を集約する',
      singletonRow?.entry.id === 'u1'
      && smallBundle?.defaultOpen === true && smallBundle.items.length === 2
      && bigRuleBundle?.defaultOpen === false && bigRuleBundle.items.length === 9
      && bigRuleBundle.origins.join(',') === 'codex,claude');

    const groupedSkill1 = groupEntries('skill', [{ id: 's1', path: '/home/u/.claude/skills/only/SKILL.md', name: 'only', origins: [{ source: 'claude' }] }]);
    const groupedSkill9 = groupEntries('skill', Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, path: `/repo/.claude/skills/k${i}/SKILL.md`, name: `k${i}` })));
    t.ok('groupEntries(skill) は 1 件でもまとまりになり、9 件（>8）は初期折りたたみ',
      groupedSkill1.length === 1 && groupedSkill1[0].type === 'bundle' && groupedSkill1[0].defaultOpen === true
      && groupedSkill9[0].type === 'bundle' && groupedSkill9[0].defaultOpen === false);

    // まとまりのスイッチは、子の全マスを行と同じ規則で数える（ADR 0337 §決定 4・2026-11-17 改訂・ToBe-A′）。
    // 分母は「鍵の無いマス + 鍵つきでオンのマス」。押すと、変えられるオンのある子だけをオフにし、無ければ外す前の記録のある子から戻す
    const AG = ['claude', 'codex', 'devin', 'grok'];
    // 行は web/context-matrix.mjs が受け取る形（cells・rule）。rule は今の配り（off = 自分で読むのに外した物・spread = 渡した物）を持つ
    const mkRow = (key, on, { locked = [], native = [], restore = null } = {}) => {
      const cells = {};
      for (const a of AG) cells[a] = { on: on.includes(a), locked: locked.includes(a), native: native.includes(a), mode: on.includes(a) ? (native.includes(a) ? 'native' : 'spread') : 'off' };
      const row = { key, cells, rule: { off: native.filter(a => !on.includes(a) && !locked.includes(a)), spread: on.filter(a => !native.includes(a) && !locked.includes(a)) } };
      recalcDocRow(row, AG, restore);
      return row;
    };
    const allOn = [mkRow('a', ['claude', 'codex']), mkRow('b', ['claude', 'codex'])];
    const partial = [mkRow('a', ['claude', 'codex']), mkRow('c', [])];
    const none = [mkRow('c', []), mkRow('d', [], { restore: 'default' })];
    const mAll = docBundleMeta(['claude', 'codex'], allOn);
    const mMix = docBundleMeta(AG, partial);
    const mNone = docBundleMeta(AG, none);
    t.ok('docBundleMeta: 全部オン → true（押すとオフ）・一部だけオン → mixed（押してもオフ）・全部オフ → false（初期値から戻す）',
      wholeState(mAll) === 'true' && mAll.rowNextOn === false && wholeNext(mAll) === 'off'
      && wholeState(mMix) === 'mixed' && mMix.rowNextOn === false && wholeNext(mMix) === 'off' && mMix.keys.join(',') === 'a'
      && wholeState(mNone) === 'false' && mNone.rowNextOn === true && wholeNext(mNone) === 'on' && mNone.rowLocked === false,
      JSON.stringify({ mAll, mMix, mNone }));

    // 鍵つきのオン（Devin・Grok が自分で読む）が残るまとまり: 鍵の無いオンが無ければ「一部オン + 鍵」。外す前の記録がある子があれば戻せる。無ければ押せない
    const lockedOnly = [mkRow('x', ['devin', 'grok'], { locked: ['devin', 'grok'] }), mkRow('y', ['devin'], { locked: ['devin', 'grok'] })];
    const mLock = docBundleMeta(AG, lockedOnly);
    t.ok('docBundleMeta: 初めから鍵つきのオンだけで、外す前の記録もないまとまりは、鍵つきの一部オンで押せない',
      mLock.rowFixed === true && mLock.rowChangeableOn === false && wholeState(mLock) === 'mixed' && mLock.rowLocked === true && mLock.keys.length === 0,
      JSON.stringify(mLock));

    const wasRows = [mkRow('p', ['claude', 'codex', 'devin'], { locked: ['devin'] }), mkRow('q', ['claude', 'devin'], { locked: ['devin'] }), mkRow('r', ['devin'], { locked: ['devin'] })];
    applyDocBundleLocal(wasRows, AG, false);
    const mAfterOff = docBundleMeta(AG, wasRows);
    t.ok('applyDocBundleLocal(オフ): 鍵の無いマスだけ全部オフ・鍵つきのオンは残る・オンだった子だけ戻し先ができる（もともとオフの子は作らない）',
      wasRows.every(r => AG.filter(a => !r.cells[a].locked).every(a => !r.cells[a].on))
      && wasRows.every(r => r.cells.devin.on)
      && wasRows[0].rowRestore === 'was' && wasRows[1].rowRestore === 'was' && wasRows[2].rowRestore === null && !wasRows[2].rule.was
      && mAfterOff.rowFixed && !mAfterOff.rowChangeableOn && wholeNext(mAfterOff) === 'restore' && mAfterOff.keys.join(',') === 'p,q',
      JSON.stringify(mAfterOff));
    // 先に自分の行のスイッチで外してあった子（外す前の記録だけを持つ）は、まとまりの keys に入り、今回は外さず、古い戻し先を消す
    const stale = mkRow('s', [], { restore: 'was' });
    stale.rule.was = { off: [], spread: ['claude', 'codex'] };
    const staleRows = [mkRow('t', ['claude']), stale];
    const mStale = docBundleMeta(AG, staleRows);
    t.ok('docBundleMeta: 外す前の記録だけを持つ子も keys に含める（core が今回は外していない子の古い戻し先を消せる）',
      mStale.keys.join(',') === 't,s' && mStale.rowChangeableOn && wholeNext(mStale) === 'off', JSON.stringify(mStale));
    applyDocBundleLocal(staleRows, AG, false);
    applyDocBundleLocal(staleRows, AG, true);
    t.ok('applyDocBundleLocal: まとまりをオフ → 戻すと、先に外してあった子はオンにならない（古い戻し先を消す）',
      !stale.rule.was && AG.every(a => !stale.cells[a].on) && staleRows[0].cells.claude.on,
      JSON.stringify(staleRows.map(r => AG.filter(a => r.cells[a].on))));
    applyDocBundleLocal(wasRows, AG, true);
    t.ok('applyDocBundleLocal(オン): 外す前の記録のある子だけ子ごとに戻す（もともとオフだった子はオンにしない・鍵つきは触らない）',
      wasRows[0].cells.claude.on && wasRows[0].cells.codex.on && wasRows[1].cells.claude.on && !wasRows[1].cells.codex.on
      && AG.filter(a => !wasRows[2].cells[a].locked).every(a => !wasRows[2].cells[a].on) && wasRows.every(r => r.cells.devin.on),
      JSON.stringify(wasRows.map(r => AG.filter(a => r.cells[a].on))));

    // 4. createTabBar（ロール・件数・キーボード移動）と createFindBar（入力・Escape）
    const selected = [];
    const bar = createTabBar({
      tabs: CONTEXT_TABS.map(id => ({ id, label: id.toUpperCase() })),
      active: 'instruction',
      ariaLabel: '種類',
      onSelect: (id, opts) => { selected.push({ id, focus: Boolean(opts?.focus) }); bar.setActive(id, opts); },
    });
    bar.setCounts({ instruction: 3, skill: 0, mcp: 2, hooks: null });
    const tabBtns = bar.root.querySelectorAll('[role="tab"]');
    t.ok('createTabBar は tablist と 4 つの tab、選択・件数を正しく出す',
      bar.root.getAttribute('role') === 'tablist' && tabBtns.length === 4
      && tabBtns[0].getAttribute('aria-selected') === 'true' && tabBtns[0].getAttribute('tabindex') === '0'
      && tabBtns[1].getAttribute('aria-selected') === 'false' && tabBtns[1].getAttribute('tabindex') === '-1'
      && tabBtns[0].querySelector('.c')?.textContent === '3'
      && tabBtns[3].querySelector('.c')?.hidden === true);

    tabBtns[0].focus();
    const keyEv = key => ({ type: 'keydown', key, target: globalThis.document.activeElement, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    const fireTabKey = key => {
      const el = globalThis.document.activeElement;
      const ev = keyEv(key);
      el.dispatchEvent(ev);
      return ev;
    };
    const eRight = fireTabKey('ArrowRight');
    const eEnd = fireTabKey('End');
    const eWrapR = fireTabKey('ArrowRight');
    const eWrapL = fireTabKey('ArrowLeft');
    const eHome = fireTabKey('Home');
    const seq = selected.map(s => `${s.id}:${s.focus}`).join(',');
    t.ok('createTabBar の ArrowRight / End / ArrowLeft / Home で循環移動し focus を引き継ぐ',
      seq === 'skill:true,hooks:true,instruction:true,hooks:true,instruction:true'
      && eRight.defaultPrevented && eEnd.defaultPrevented, seq);

    const typed = [];
    const find = createFindBar({ placeholder: '絞る', ariaLabel: '絞る', onInput: v => typed.push(v) });
    find.input.value = 'deploy'; find.input.dispatchEvent({ type: 'input' });
    const escFind = { type: 'keydown', key: 'Escape', defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
    find.input.dispatchEvent(escFind);
    t.ok('createFindBar は入力で通知し、Escape で空にして再描画を呼ぶ',
      typed.join(',') === 'deploy,' && find.input.value === '' && escFind.defaultPrevented && escFind.propagationStopped);
    // （鍵の吹き出しの対話の試験が終わった後に置く: ensureLockTips が文書へ聞き取りを足すため）
    forgetAgentNames();
    setAgentBrands([]);
    // 5. ブランド表（setAgentBrands）が空で、表の labels も届いていない列（antigravity・opencode）でも、どの経路も内部の id を出さない
    const INTERNAL = /antigravity|opencode/;
    const noBrandDoc = {
      agents: ['antigravity', 'opencode', 'grok'],
      labels: {},
    };
    const lockedOn = (reason) => ({ locked: true, on: true, mode: 'locked', reason });
    const fixedRow = { key: 'fixed', cells: { antigravity: lockedOn('workspace'), opencode: lockedOn('own'), grok: { locked: false, on: false, mode: 'toggle' } } };
    const lockedRow = { key: 'locked', cells: { antigravity: { locked: true, on: false, mode: 'locked', reason: 'bundled' }, opencode: { locked: false, on: false, mode: 'toggle' } } };
    const spots = {
      docFixedReasons: docFixedReasons(noBrandDoc, fixedRow),
      docFixedReasonsGroup: docFixedReasons(noBrandDoc, [fixedRow, fixedRow]),
      docLockReason: docLockReason(noBrandDoc, fixedRow),
      docLockReasonOff: docLockReason(noBrandDoc, lockedRow),
      docRowLockSummary: docRowLockSummary(noBrandDoc, [lockedRow]),
      reasonKeyTip: docReasonKey(noBrandDoc, fixedRow)[0]?.dataset.tip,
      reasonKeyAria: docReasonKey(noBrandDoc, fixedRow)[0]?.getAttribute('aria-label'),
      lockedChipTip: lockedAgentChip('antigravity', lockedOn('workspace'), 'AGENTS.md').dataset.tip,
      lockedChipAria: lockedAgentChip('opencode', lockedOn('own'), 'AGENTS.md').getAttribute('aria-label'),
      legend: agentLegend(['antigravity', 'opencode']).textContent,
      origin: originMarks(['antigravity', 'opencode'])?.getAttribute('aria-label'),
    };
    const leaked = Object.entries(spots).filter(([, v]) => typeof v !== 'string' || !v || INTERNAL.test(v));
    t.ok('ブランド表も labels も無いとき、鍵の吹き出し・読み上げ・右の欄の理由・凡例・出どころに内部の id（antigravity・opencode）が出ない',
      leaked.length === 0 && spots.docFixedReasons.includes('いずれかのエージェント'), JSON.stringify(leaked));
    // 表の labels が届けば、その表示名になる
    rememberAgentNames({ antigravity: 'Antigravity', opencode: 'OpenCode' });
    t.ok('表の labels が届いた後は、同じ経路が表示名（Antigravity・OpenCode）を使う',
      docFixedReasons(noBrandDoc, fixedRow).includes('Antigravity') && docFixedReasons(noBrandDoc, fixedRow).includes('OpenCode')
      && agentLegend(['antigravity']).textContent.endsWith('Antigravity'));

    // 6. 行のスイッチの鍵: キーボードで届き、理由を読み上げで読める（押せない行・押せるが鍵つきでオンが残る行）
    const reasonText = lockReasonText('Devin', { reason: 'devinHooks' });
    const blocked = wholeSwitch({ state: 'true', fixed: true, name: 'blocked-row', disabledReason: reasonText, next: 'off' });
    t.ok('押せない行（aria-disabled）: ボタンのままキーボードのフォーカスを受ける（disabled・tabindex=-1 にしない）',
      blocked.tagName === 'BUTTON' && blocked.getAttribute('aria-disabled') === 'true' && !blocked.hasAttribute('disabled') && blocked.getAttribute('tabindex') !== '-1'
      && blocked.getAttribute('role') === 'checkbox' && blocked.getAttribute('aria-checked') === 'true', blocked.outerHTML ?? '');
    t.ok('押せない行: 理由は吹き出し（data-tip）と読み上げ名（aria-label）の両方にあり、読み上げ名では文として区切れる',
      blocked.dataset.tip === reasonText && blocked.getAttribute('aria-label').includes(spokenLockReason(reasonText)) && blocked.getAttribute('aria-label').includes('blocked-row'),
      blocked.getAttribute('aria-label'));
    const pressable = wholeSwitch({ state: 'mixed', fixed: true, fixedReason: reasonText, name: 'mixed-row', next: 'off', onToggle: () => {} });
    const pressLk = pressable.querySelector('.lk');
    const pressDesc = pressable.querySelector('span[hidden]');
    t.ok('押せる行（鍵つきでオンが残る）: スイッチ自身がフォーカスを受け、理由は aria-describedby の説明で読める（名前には混ぜない）',
      pressable.tagName === 'BUTTON' && !pressable.hasAttribute('disabled') && pressable.getAttribute('tabindex') !== '-1' && pressable.getAttribute('aria-disabled') == null
      && pressable.getAttribute('aria-checked') === 'mixed' && Boolean(pressDesc?.id) && pressable.getAttribute('aria-describedby') === pressDesc.id
      && pressDesc.textContent === spokenLockReason(reasonText) && !pressable.getAttribute('aria-label').includes(reasonText), pressable.getAttribute('aria-describedby') ?? '');
    t.ok('押せる行の鍵: 読み上げからは外し（aria-hidden）、フォーカスは持たず、鍵の上だけに理由を出す（data-tip-pass）。押す動きは止めない',
      pressLk?.getAttribute('aria-hidden') === 'true' && pressLk.hasAttribute('data-tip-pass') && pressLk.dataset.tip === reasonText
      && !pressLk.hasAttribute('tabindex') && pressable.dataset.tip == null && typeof pressable.onclick === 'function');
    const plain = wholeSwitch({ state: 'true', name: 'plain-row', next: 'off', onToggle: () => {} });
    t.ok('鍵つきでオンが残らない行: 鍵も説明も持たない', plain.querySelector('.lk') == null && plain.getAttribute('aria-describedby') == null);

  } finally {
    env.restore();
    await setLanguage('ja');
  }
}
