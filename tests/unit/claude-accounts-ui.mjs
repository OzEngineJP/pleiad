// 設定 › Claude のアカウント（web/claude-accounts.mjs）が送るコマンドの並びを、ブラウザー無しで確かめる。
// 期待値は origin/main（カードがその場で開く形にする前）の web/claude-accounts.mjs を読んで書いた（今の実装から写さない）。
// 違いはコメントに理由を書く。会話用のトークン（setup-token）の発行・手で貼るは ADR 0353 で無くなり、流れは claude.ai のログイン（usage-login）だけ。
// 描画は本物の web/dom-patch.mjs に通すので、下に HTML を読む小さな DOM を置く（依存を足さない）。
import assert from 'node:assert/strict';

export const name = 'claude-accounts-ui';
export const title = 'Claude のアカウントの面: 送るコマンドの並び・流れを閉じない決まり・遅れて届く応答';

// ---------------------------------------------------------------- 小さな DOM（この面が使う分だけ）
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const dec = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ENT[k]);
const VOID = new Set(['input', 'br', 'img', 'hr']);
let doc;
class Text {
  constructor(data) { this.nodeType = 3; this.nodeName = '#text'; this.data = data; this.parentNode = null; }
  get textContent() { return this.data; }
  get nextSibling() { return sib(this); }
  remove() { detach(this); }
  clone() { return new Text(this.data); }
}
const sib = n => { const p = n.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(n) + 1] ?? null; };
const detach = n => { const p = n.parentNode; if (p) { p.childNodes.splice(p.childNodes.indexOf(n), 1); n.parentNode = null; } };
class El {
  constructor(tag) {
    this.nodeType = 1; this.nodeName = tag.toUpperCase(); this.tagName = this.nodeName;
    this.attrs = new Map(); this.childNodes = []; this.parentNode = null; this.style = {}; this.on = {};
    this.dataset = new Proxy({}, { get: (_, k) => typeof k === 'string' ? (this.attrs.get('data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())) ?? undefined) : undefined });
  }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() { const c = this.className.split(/\s+/).filter(Boolean); return { contains: x => c.includes(x) }; }
  get disabled() { return this.hasAttribute('disabled'); }
  get value() { return this._value ?? this.getAttribute('value') ?? ''; }
  set value(v) { this._value = String(v); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { return sib(this); }
  get parentElement() { return this.parentNode; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  get content() { return this; }
  set innerHTML(html) { this.childNodes = []; parse(this, html); }
  append(...ns) { for (const n of ns) this.insertBefore(n, null); }
  insertBefore(n, ref) { detach(n); const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n); n.parentNode = this; return n; }
  replaceChildren(...ns) { for (const c of [...this.childNodes]) detach(c); this.append(...ns); }
  remove() { detach(this); }
  clone() { const e = new El(this.nodeName.toLowerCase()); e.attrs = new Map(this.attrs); for (const c of this.childNodes) e.append(c.clone()); return e; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  matches(s) { return match(this, s); }
  closest(s) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (match(x, s)) return x; return null; }
  querySelectorAll(s) { const out = []; const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1) { if (match(c, s)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(s) { return this.querySelectorAll(s)[0] ?? null; }
  addEventListener(type, fn) { (this.on[type] ??= []).push(fn); }
  focus() { doc.activeElement = this; }
  select() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { height: 0 }; }
  animate() { return { cancel() {} }; }
}
function parse(root, html) {
  let cur = root, i = 0;
  const re = /<(\/?)([a-z][a-z0-9]*)((?:[^>"]|"[^"]*")*)>/gi;
  for (let m; (m = re.exec(html));) {
    if (m.index > i) cur.append(new Text(dec(html.slice(i, m.index))));
    i = re.lastIndex;
    const tag = m[2].toLowerCase();
    if (m[1]) { cur = cur.parentNode ?? root; continue; }
    const e = new El(tag);
    for (const a of m[3].matchAll(/([^\s="]+)(?:="([^"]*)")?/g)) e.setAttribute(a[1], dec(a[2] ?? ''));
    cur.append(e);
    if (!VOID.has(tag)) cur = e;
  }
  if (i < html.length) cur.append(new Text(dec(html.slice(i))));
}
// 子孫の結合（空白）と、タグ・.class・#id・[attr]・[attr="v"] の組だけ
function compound(s) {
  const r = { tag: null, cls: [], attrs: [] };
  for (const m of s.matchAll(/^([a-z]+)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gi)) {
    if (m[1]) r.tag = m[1].toUpperCase(); else if (m[2]) r.cls.push(m[2]); else if (m[3]) r.attrs.push(['id', m[3]]); else r.attrs.push([m[4], m[5]]);
  }
  return r;
}
const one = (e, c) => (!c.tag || e.nodeName === c.tag) && c.cls.every(x => e.classList.contains(x)) && c.attrs.every(([k, v]) => e.hasAttribute(k) && (v === undefined || e.getAttribute(k) === v));
function match(e, s) {
  const parts = s.trim().match(/(?:[^\s[\]"]+|\[[^\]]*\])+/g).map(compound);
  if (!one(e, parts.at(-1))) return false;
  let k = parts.length - 2;
  for (let x = e.parentNode; x && k >= 0; x = x.parentNode) if (x.nodeType === 1 && one(x, parts[k])) k--;
  return k < 0;
}

// ---------------------------------------------------------------- 偽のサーバー
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const later = () => new Promise(r => setTimeout(r, 5));
const A = 'acct-aaaaaaaaaaaa', B = 'acct-bbbbbbbbbbbb';

async function setup(setupClaudeAccounts) {
  const controls = new El('div');
  doc.getElementById = id => id === 'agentControls' ? controls : null;
  doc.activeElement = doc.body;
  const s = {
    rows: [{ id: A, name: 'A', usageLogin: true }, { id: B, name: 'B', usageLogin: false }],
    calls: [], hold: new Set(), held: [], loginSeq: 0, fail: {},
  };
  s.cmd = (name, args) => {
    s.calls.push(args === undefined ? { name } : { name, args });
    const d = deferred();
    if (s.fail[name]) { const e = s.fail[name]; delete s.fail[name]; d.reject(e); }
    else if (s.hold.has(name)) s.held.push({ name, ...d });
    else if (name === 'claudeAccounts') d.resolve({ accounts: structuredClone(s.rows), storage: null });
    else if (name === 'claudeLoginStart') d.resolve({ loginId: 'L' + (++s.loginSeq) });
    else if (name === 'saveClaudeAccount') d.resolve({ id: args.id ?? 'acct-added000000', accounts: structuredClone(s.rows), storage: null });
    else d.resolve({});
    return d.promise;
  };
  s.take = name => { const i = s.held.findIndex(h => h.name === name); assert.ok(i >= 0, `待たせた ${name} が無い`); return s.held.splice(i, 1)[0]; };
  s.api = setupClaudeAccounts({ cmd: s.cmd, openSettings() {}, onChange() {} });
  s.panel = s.api.panel;
  s.q = sel => s.panel.querySelector(sel);
  const fire = async (type, target, extra = {}) => {
    const ev = { type, target, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of s.panel.on[type] ?? []) fn(ev);
    await settle();
  };
  s.click = async sel => { const b = s.q(sel); assert.ok(b, `押す物が無い: ${sel}`); await fire('click', b); };
  s.type = async (sel, v) => { const i = s.q(sel); assert.ok(i, `欄が無い: ${sel}`); i.value = v; await fire('input', i); };
  s.key = async (sel, key) => { const i = s.q(sel); assert.ok(i, `欄が無い: ${sel}`); await fire('keydown', i, { key }); };
  s.submit = async sel => { const f = s.q(sel); assert.ok(f, `欄が無い: ${sel}`); await fire('submit', f); };
  s.event = async ev => { s.api.loginEvent(ev); await settle(); };
  s.card = id => {
    const c = s.q(`[data-account="${id}"]`);
    if (!c) return null;
    return { open: c.classList.contains('is-open'), edit: c.classList.contains('is-edit'), flow: Boolean(c.querySelector('[data-flowform]')), body: c.querySelector('[data-k="body"]').classList.contains('open'), el: c };
  };
  s.sent = () => s.calls.map(c => c.name === 'claudeAccounts' ? c.name : [c.name, c.args]);
  s.cancels = () => s.calls.filter(c => c.name === 'claudeLoginCancel');
  s.reset = () => { s.calls.length = 0; };
  await s.api.open();
  await settle();
  return s;
}

export default async function test(t) {
  const saved = Object.fromEntries(['document', 'window', 'CSS', 'matchMedia', 'getComputedStyle'].map(k => [k, globalThis[k]]));
  doc = { createElement: tag => new El(tag), importNode: n => n.clone(), body: new El('body'), documentElement: new El('html'), activeElement: null };
  Object.assign(globalThis, {
    document: doc,
    window: { plyDesktop: {} },   // デスクトップ版（サーバーがブラウザーを開く。open: true）
    CSS: { escape: s => String(s) },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => '0ms', paddingTop: '0', paddingBottom: '0', opacity: '1' }),   // 動きなし（差し替えはすぐ済む）
  });
  try {
    const { setupClaudeAccounts } = await import('../../web/claude-accounts.mjs');
    const { t: tr } = await import('../../web/i18n.mjs');
    const mk = () => setup(setupClaudeAccounts);
    const check = async (label, fn) => {
      try { await fn(); t.ok(label, true); }
      catch (e) { t.ok(label, false, String(e?.message ?? e).split(/\r?\n/).slice(0, 6).join(' / ')); }
    };
    // claude.ai にログインし直す流れを A で始め、コードを待つ所まで進める
    const reissueA = async s => {
      await s.click(`[data-account="${A}"] .mp-body [data-fix="${A}:lg"]`);
      await s.event({ loginId: 'L1', phase: 'url', url: 'https://claude.ai/oauth/x' });
    };

    // ============================================================ 流れごとの並び（origin/main と同じ）
    await check('追加（claude.ai にログイン）: claudeLoginStart { kind: usage-login, name, open } → claudeLoginCode → 済んだら claudeAccounts', async () => {
      const s = await mk(); s.reset();
      await s.api.add(); await settle();   // 一覧の［＋ 接続先を追加］→ 公式（web/client.mjs。ADR 0359）
      await s.type('[data-name="new1"]', '新しいアカウント');
      await s.click('[data-account="new1"] [data-fix="new1:lg"]');
      await s.event({ loginId: 'L1', phase: 'url', url: 'https://claude.ai/oauth/x' });
      s.q('[data-account="new1"] [data-code]').value = 'code-123';
      await s.submit('[data-account="new1"] [data-flowform]');
      s.rows.push({ id: 'acct-cccccccccccc', name: '新しいアカウント', usageLogin: false });
      await s.event({ loginId: 'L1', phase: 'done', accountId: 'acct-cccccccccccc' });
      // origin: startLogin({ kind, name }) → cmd('claudeLoginStart', { kind, name, open: desktop() })、submitCode → cmd('claudeLoginCode', { loginId, code })、done → load(true)
      assert.deepEqual(s.sent(), [
        ['claudeLoginStart', { kind: 'usage-login', name: '新しいアカウント', open: true }],
        ['claudeLoginCode', { loginId: 'L1', code: 'code-123' }],
        'claudeAccounts',
      ]);
    });

    await check('claude.ai にログインし直す: claudeLoginStart { kind: usage-login, accountId, open }', async () => {
      const s = await mk(); s.reset();
      await s.click(`[data-account="${A}"] .mp-body [data-fix="${A}:lg"]`);
      assert.deepEqual(s.sent(), [['claudeLoginStart', { kind: 'usage-login', accountId: A, open: true }]]);
    });

    await check('名前の変更: saveClaudeAccount { id, name } → claudeAccounts', async () => {
      const s = await mk(); s.reset();
      await s.click(`[data-toggle="${A}"]`);
      await s.type(`[data-name="${A}"]`, 'A2');
      await s.click(`[data-toggle="${A}"]`);
      // origin: フォームの submit → cmd('saveClaudeAccount', { id, name }) → load(true)
      assert.deepEqual(s.sent(), [['saveClaudeAccount', { id: A, name: 'A2' }], 'claudeAccounts']);
    });

    await check('削除: deleteClaudeAccount { id } → claudeAccounts', async () => {
      const s = await mk(); s.reset();
      await s.click(`[data-del="${A}"]`);
      s.rows.shift();
      await s.click('[data-confirm="yes"]'); await later(); await settle();
      assert.deepEqual(s.sent(), [['deleteClaudeAccount', { id: A }], 'claudeAccounts']);
    });

    await check('［やめる］: claudeLoginCancel { loginId }', async () => {
      const s = await mk(); await reissueA(s); s.reset();
      await s.click(`[data-account="${A}"] [data-flow="cancel"]`);
      assert.deepEqual(s.sent(), [['claudeLoginCancel', { loginId: 'L1' }]]);
      assert.equal(s.card(A).flow, false);
    });

    // ============================================================ 流れを閉じない決まり
    await check('流れの途中の［完了］・Esc・ほかのカードを開く・面を閉じて開き直す では取り消しを送らず、流れが見えたまま', async () => {
      const s = await mk(); await reissueA(s);
      await s.type(`[data-account="${A}"] [data-code]`, '打ちかけ');
      s.reset();
      await s.click(`[data-toggle="${A}"]`);   // ［完了］
      assert.deepEqual(s.cancels(), [], '［完了］');
      assert.equal(s.card(A).flow, true, '［完了］のあとも流れが見える');
      assert.equal(s.card(A).edit, false);
      assert.equal(s.q(`[data-account="${A}"] [data-code]`).value, '打ちかけ', '打ちかけのコードが残る');
      await s.click(`[data-toggle="${A}"]`);   // ［編集］
      await s.key(`[data-name="${A}"]`, 'Escape');
      assert.deepEqual(s.cancels(), [], 'Esc');
      assert.equal(s.card(A).flow, true, 'Esc のあとも流れが見える');
      await s.key(`[data-account="${A}"] [data-code]`, 'Escape');   // 何も開いていなくても流れは止めない
      assert.equal(s.card(A).flow, true);
      await s.click(`[data-toggle="${B}"]`);
      assert.deepEqual(s.cancels(), [], 'ほかのカードを開く');
      assert.equal(s.card(A).flow, true, '流れのカードも開いたまま');
      assert.equal(s.card(A).body, true);
      assert.equal(s.card(B).edit, true, 'B も開く（流れの間だけの例外）');
      s.api.close(); await settle();   // カードの［接続先］で畳む（面の［閉じる］は ADR 0359 で無くなった）
      await s.api.open(); await settle();
      assert.deepEqual(s.cancels(), [], '面を閉じる');
      assert.equal(s.card(A).flow, true, '開き直すと流れの続きが見える（origin: close は flow に触らず、open で drawFlow）');
      assert.ok(!s.calls.some(c => c.name === 'saveClaudeAccount'), '名前は変えていないので保存もしない');
    });

    await check('［やめる］で流れが閉じると、開いているのは書き換え中の 1 枚に戻る', async () => {
      const s = await mk(); await reissueA(s);
      await s.click(`[data-toggle="${B}"]`);
      s.reset();
      await s.click(`[data-account="${A}"] [data-flow="cancel"]`);
      assert.deepEqual(s.sent(), [['claudeLoginCancel', { loginId: 'L1' }]]);
      assert.equal(s.card(A).open, false);
      assert.equal(s.card(B).edit, true);
    });

    await check('別の流れを始めると、前の流れに取り消しを送ってから始める', async () => {
      const s = await mk(); await reissueA(s); s.reset();
      await s.click(`[data-account="${B}"] [data-fix="${B}:lg"]`);
      // origin: startLogin は flow.loginId があり done/error でなければ claudeLoginCancel を待ってから claudeLoginStart
      assert.deepEqual(s.sent(), [['claudeLoginCancel', { loginId: 'L1' }], ['claudeLoginStart', { kind: 'usage-login', accountId: B, open: true }]]);
      assert.equal(s.card(A).open, false, '止めた流れのカードは閉じる');
    });

    await check('流れのあるアカウントを削除すると、その流れに取り消しを送る', async () => {
      const s = await mk(); await reissueA(s); s.reset();
      await s.click(`[data-del="${A}"]`);
      s.rows.shift();
      await s.click('[data-confirm="yes"]'); await later(); await settle();
      assert.deepEqual(s.sent(), [['deleteClaudeAccount', { id: A }], ['claudeLoginCancel', { loginId: 'L1' }], 'claudeAccounts']);
      assert.equal(s.card(A), null);
    });

    await check('失敗した流れを閉じても取り消しは送らない（origin のエラーの［閉じる］と同じ）', async () => {
      const s = await mk(); await reissueA(s);
      await s.event({ loginId: 'L1', phase: 'error', message: '失敗しました' });
      s.reset();
      await s.click(`[data-account="${A}"] [data-flow="cancel"]`);
      assert.deepEqual(s.sent(), []);
    });

    // ============================================================ 途中の状態
    await check('応答より先に届いたイベントを、応答が来てから当てる', async () => {
      const s = await mk(); s.hold.add('claudeLoginStart');
      await s.click(`[data-account="${A}"] .mp-body [data-fix="${A}:lg"]`);
      await s.event({ loginId: 'L9', phase: 'url', url: 'https://claude.ai/oauth/early' });
      s.take('claudeLoginStart').resolve({ loginId: 'L9' }); await settle();
      assert.equal(s.card(A).flow, true);
      assert.equal(s.q(`[data-account="${A}"] a`).getAttribute('href'), 'https://claude.ai/oauth/early');
    });

    await check('古い試みの応答・イベントを、新しい試みに当てない', async () => {
      const s = await mk(); s.hold.add('claudeLoginStart');
      await s.click(`[data-account="${A}"] .mp-body [data-fix="${A}:lg"]`);
      await s.click(`[data-account="${A}"] .mp-body [data-fix="${A}:lg"]`);   // 応答の前に別の流れ
      await s.click(`[data-account="${A}"] .mp-body [data-fix="${A}:lg"]`);   // もう一度
      const [first, second, third] = [s.take('claudeLoginStart'), s.take('claudeLoginStart'), s.take('claudeLoginStart')];
      first.reject(new Error('古い失敗')); await settle();
      assert.ok(!s.card(A).el.textContent.includes('古い失敗'), '古い失敗を出さない');
      second.resolve({ loginId: 'L2' }); await settle();
      await s.event({ loginId: 'L2', phase: 'url', url: 'https://claude.ai/oauth/old' });
      third.resolve({ loginId: 'L3' }); await settle();
      assert.equal(s.card(A).flow, false, '古い応答・イベントで進まない');
      assert.ok(s.q(`[data-slot="flow:${A}:lg"] [data-k="step:starting"]`), '新しい試みは始まったところ');
      await s.event({ loginId: 'L3', phase: 'url', url: 'https://claude.ai/oauth/new' });
      assert.equal(s.q(`[data-slot="flow:${A}:lg"] a`)?.getAttribute('href'), 'https://claude.ai/oauth/new');
    });

    await check('失敗のあとの［やり直す］: origin と同じ引数で始め直し、前の試みのイベントは当てない', async () => {
      const s = await mk(); await reissueA(s);
      await s.event({ loginId: 'L1', phase: 'error', message: '失敗しました' });
      s.reset(); s.hold.add('claudeLoginStart');
      await s.click(`[data-account="${A}"] [data-flow="retry"]`);
      // origin: startLogin({ kind: flow.kind, accountId: flow.accountId, name: flow.name })。失敗の流れには取り消しを送らない
      assert.deepEqual(s.sent(), [['claudeLoginStart', { kind: 'usage-login', accountId: A, open: true }]]);
      await s.event({ loginId: 'L1', phase: 'code', message: '' });
      s.take('claudeLoginStart').resolve({ loginId: 'L2' }); await settle();
      assert.ok(s.q(`[data-slot="flow:${A}:lg"] [data-k="step:starting"]`), '前の試みのイベントで進まない');
    });

    await check('流れの途中の claudeAccountsChanged: 流れと打ちかけのコードが残り、名前は新しくなる', async () => {
      const s = await mk(); await reissueA(s);
      await s.type(`[data-account="${A}"] [data-code]`, '打ちかけ');
      s.rows[0] = { ...s.rows[0], name: 'A（別の窓で変更）' };
      s.api.invalidate(); await settle();
      assert.equal(s.card(A).flow, true);
      assert.equal(s.q(`[data-account="${A}"] [data-code]`).value, '打ちかけ');
      assert.equal(s.q(`[data-account="${A}"] strong`).textContent, 'A（別の窓で変更）');
    });

    await check('流れの途中で別の窓から削除: 消えたカードに書かず、遅れたイベントで止まらない', async () => {
      const s = await mk(); await reissueA(s);
      s.rows.shift();
      s.api.invalidate(); await settle();
      assert.equal(s.card(A), null);
      await s.event({ loginId: 'L1', phase: 'error', message: '失敗しました' });
      await s.event({ loginId: 'L1', phase: 'done' });
      assert.equal(s.card(A), null, '消えたカードを作り直さない');
      assert.ok(s.card(B));
    });

    await check('済んだ直後（一覧の取り直しの間）もコードの欄は入力できない', async () => {
      const s = await mk(); await reissueA(s);
      s.hold.add('claudeAccounts');
      await s.event({ loginId: 'L1', phase: 'done' });
      const input = s.q(`[data-account="${A}"] [data-code]`);
      assert.ok(input, '取り直しの間はまだ流れの欄がある');
      assert.equal(input.disabled, true);
      s.take('claudeAccounts').resolve({ accounts: structuredClone(s.rows), storage: null }); await settle();
      assert.equal(s.card(A).flow, false);
    });

    // ============================================================ 名前の保存
    await check('名前を打ちかけてほかのカードを開くと、保存を 1 回だけ送る', async () => {
      const s = await mk(); s.reset();
      await s.click(`[data-toggle="${A}"]`);
      await s.type(`[data-name="${A}"]`, 'A2');
      await s.click(`[data-toggle="${B}"]`);
      await s.click(`[data-toggle="${B}"]`);   // B を［完了］（変えていない）
      assert.deepEqual(s.calls.filter(c => c.name === 'saveClaudeAccount').map(c => c.args), [{ id: A, name: 'A2' }]);
      assert.equal(s.card(B).edit, false);
    });

    await check('切り替えの保存がサーバーで失敗したら、切り替えず誤りを出す（空の名前は戻して切り替える）', async () => {
      const s = await mk(); s.reset();
      s.fail.saveClaudeAccount = new Error('通信できませんでした');
      await s.click(`[data-toggle="${A}"]`);
      await s.type(`[data-name="${A}"]`, 'A2');
      await s.click(`[data-toggle="${B}"]`);
      assert.equal(s.calls.filter(c => c.name === 'saveClaudeAccount').length, 1);
      assert.equal(s.card(A).edit, true, '元のカードを開いたまま');
      assert.equal(s.card(B).edit, false, '切り替えない');
      assert.match(s.card(A).el.textContent, /通信できませんでした/);
      await s.type(`[data-name="${A}"]`, '');
      await s.click(`[data-toggle="${B}"]`);
      assert.equal(s.calls.filter(c => c.name === 'saveClaudeAccount').length, 1, '空の名前は送らない');
      assert.equal(s.card(B).edit, true);
      assert.equal(s.q(`[data-account="${A}"] strong`).textContent, 'A');
    });

    await check('新しいカードの発行の失敗: 名前の誤り（code: bad-name）だけ名前の欄、ほかは流れの所に［やり直す］', async () => {
      const s = await mk();
      await s.api.add(); await settle();   // 一覧の［＋ 接続先を追加］→ 公式（web/client.mjs。ADR 0359）
      await s.type('[data-name="new1"]', 'Z');
      s.fail.claudeLoginStart = Object.assign(new Error(tr('claude.accounts.nameDuplicate')), { code: 'bad-name' });
      await s.click('[data-account="new1"] [data-fix="new1:lg"]');
      assert.ok(s.q('[data-account="new1"] [data-name][aria-invalid="true"]'), '名前の欄に出す');
      assert.equal(s.q('[data-slot="flow:new1:lg"] [data-flow="retry"]'), null);
      s.fail.claudeLoginStart = new Error('起動できませんでした');
      await s.click('[data-account="new1"] [data-fix="new1:lg"]');
      assert.ok(s.q('[data-slot="flow:new1:lg"] [data-flow="retry"]'), '流れの所に［やり直す］');
      assert.equal(s.q('[data-account="new1"] [data-name][aria-invalid="true"]'), null);
    });

    await check('追加のカードが登録されたあとの流れも、その行へフォーカスが行く（札の引き継ぎ）', async () => {
      const s = await mk();
      await s.api.add(); await settle();   // 一覧の［＋ 接続先を追加］→ 公式（web/client.mjs。ADR 0359）
      await s.type('[data-name="new1"]', 'N');
      await s.click('[data-account="new1"] [data-fix="new1:lg"]');
      s.rows.push({ id: 'acct-nnnnnnnnnnnn', name: 'N', usageLogin: false });
      await s.event({ loginId: 'L1', phase: 'done', accountId: 'acct-nnnnnnnnnnnn' });
      await s.click('[data-account="acct-nnnnnnnnnnnn"] .mp-body [data-fix="acct-nnnnnnnnnnnn:lg"]');
      assert.equal(doc.activeElement?.getAttribute?.('data-slot'), 'flow:new1:lg');
    });
  } finally {
    Object.assign(globalThis, saved);
  }
}
