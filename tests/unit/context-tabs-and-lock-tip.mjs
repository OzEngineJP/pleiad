// 設定 › プラグイン・会話の右パネルの 4 タブ・フォルダーまとまり・絞り込み（web/context-tabs.mjs）と、
// 鍵の吹き出し（web/lock-tip.mjs）の単位テスト。
import { N } from '../lib/dom-stub.mjs';
import { setLanguage } from '../../web/i18n.mjs';
import {
  LOCK_REASONS, lockReasonKey, lockReasonText, lockAriaLabel,
  hideLockTip, ensureLockTips, _resetLockTipForTest,
} from '../../web/lock-tip.mjs';
import {
  CONTEXT_TABS, BUNDLE_COLLAPSE_AFTER,
  readTabStorage, writeTabStorage,
  bundleFolder, bundleLabel, groupEntries, bundleSwitchState,
  createTabBar, createFindBar,
} from '../../web/context-tabs.mjs';

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
    t.ok('LOCK_REASONS は 6 種類の理由コードを持つ（nolinks は ADR 0336）',
      ['own', 'workspace', 'relay', 'admin', 'linked', 'nolinks'].every(k => LOCK_REASONS.has(k)) && LOCK_REASONS.size === 6);

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

    await setLanguage('en');
    const enOwn = lockReasonText('Claude', { mode: 'locked' });
    const enAria = lockAriaLabel('Claude setting', enOwn);
    t.ok('英語ロケールでも理由文と読み上げ名が組み立てられる',
      enOwn.includes('Claude') && enAria === `Claude setting (${enOwn})`, enOwn);
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

    // 3. web/context-tabs.mjs: CONTEXT_TABS・storage・bundleFolder/bundleLabel・groupEntries・bundleSwitchState
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

    const enabledIds = new Set(['a', 'b']);
    const stAll = bundleSwitchState([{ id: 'a' }, { id: 'b' }], x => enabledIds.has(x.id), 'rules');
    const stMix = bundleSwitchState([{ id: 'a' }, { id: 'c' }, { id: 'd' }], x => enabledIds.has(x.id), 'rules');
    const stNone = bundleSwitchState([{ id: 'c' }, { id: 'd' }], x => enabledIds.has(x.id), 'rules');
    t.ok('bundleSwitchState は true / mixed / false と一部の件数入りラベルを返す',
      stAll.checked === 'true' && stAll.on === 2 && stAll.total === 2
      && stNone.checked === 'false' && stNone.on === 0
      && stMix.checked === 'mixed' && stMix.on === 1 && stMix.total === 3 && stMix.ariaLabel.includes('1') && stMix.ariaLabel.includes('3'));

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
  } finally {
    env.restore();
    await setLanguage('ja');
  }
}
