// 設定 › プラグイン › Hooks の表（web/hooks-matrix.mjs · ADR 0338）を DOM の代役で動かす。
// 実ブラウザーでは作れない形（管理者の Hook・Grok Build の設定の Hook）と、鍵の文・行が切れたときのセル・
// ほかのエージェントへ広げる前の確認（注意の一覧）・保存に失敗したときの戻しを確かめる。
// 段 8 は core の一覧（実際の移行結果）をそのまま渡し、Devin の取り込みが止まり始める操作の確認の帯を確かめる。
// 実ブラウザーの通しは tests/browser/hooks-matrix.mjs。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { N } from '../lib/dom-stub.mjs';
import { setLanguage, t as tr } from '../../web/i18n.mjs';
import { setAgentBrands } from '../../web/agent-brands.mjs';
import { AGENTS, agentPresentation } from '../../core/backends/agents.mjs';
import { savedText } from '../../web/context-matrix.mjs';
import { createHooksMatrix, hookAgentLabel, hookCellView, hookTip } from '../../web/hooks-matrix.mjs';
import { createPlyHooks } from '../../core/ply-hooks.mjs';
import { createHooksConfig } from '../../core/hooks-config.mjs';
import { createHooksAgents } from '../../core/hooks-agents.mjs';

export const name = 'hooks-matrix-ui';
export const title = '設定 › プラグイン › Hooks の表: 鍵の文・管理者の行・確認と注意・保存の失敗で戻す・使っていないエージェントの短い名前・空のマス・確かめ済みを捨てる・Devin の取り込みが止まり始める前の確認';

// ---- 属性と子孫の選択子が使える最小の DOM（context-panel-tabs と同じ考え方） ----
function parse(sel) {
  const attrs = [], classes = [];
  let id = null;
  let rest = sel.trim().replace(/\[([^\]=]+)(?:="([^"]*)")?\]/g, (_, k, v) => { attrs.push([k.trim(), v ?? null]); return ''; });
  rest = rest.replace(/#([^\s.#]+)/g, (_, v) => { id = v; return ''; });
  rest = rest.replace(/\.([^\s.#]+)/g, (_, v) => { classes.push(v); return ''; });
  return { tag: rest.trim() ? rest.trim().toUpperCase() : null, id, classes, attrs };
}
function one(node, sel) {
  if (!(node instanceof N)) return false;
  const { tag, id, classes, attrs } = parse(sel);
  if (tag && node.tagName !== tag) return false;
  if (id && node.id !== id) return false;
  const cls = node._classes();
  if (classes.some(c => !cls.includes(c))) return false;
  return attrs.every(([k, v]) => node.hasAttribute(k) && (v === null || String(node.getAttribute(k)) === v));
}
class D extends N {
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  set type(v) { this.attrs.type = v; }
  focus() { globalThis.document.activeElement = this; }
  matches(sel) { return sel.split(',').some(p => one(this, p)); }
  closest(sel) { for (let x = this; x instanceof N; x = x.parent) if (x.matches(sel)) return x; return null; }
  querySelectorAll(sel) {
    const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
    const chain = (n, p) => {
      const toks = p.split(/\s+/);
      if (!one(n, toks.at(-1))) return false;
      let cur = n.parent;
      for (let i = toks.length - 2; i >= 0; i--) {
        while (cur && !one(cur, toks[i])) cur = cur.parent;
        if (!cur) return false;
        cur = cur.parent;
      }
      return true;
    };
    const out = [];
    const walk = n => { for (const c of n.children) if (c instanceof N) { if (parts.some(p => chain(c, p))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
function installDom() {
  const saved = { document: globalThis.document, CSS: globalThis.CSS };
  const body = new D('body');
  globalThis.document = {
    body, activeElement: body,
    createElement: tag => new D(tag),
    createElementNS: (_ns, tag) => new D(tag),
    createTextNode: text => { const n = new D('span'); n.textContent = text; return n; },
    addEventListener() {},
  };
  globalThis.CSS = { escape: s => String(s) };
  return { body, restore() { globalThis.document = saved.document; globalThis.CSS = saved.CSS; } };
}
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

const AG = ['claude', 'codex', 'antigravity', 'opencode', 'devin', 'grok'];
const none = () => ({ mode: 'none', state: 'off' });
/** 登録（オン・Claude で実行・Codex へは初めて広げる＝確認と注意 1 件）、管理者の Hook、Grok Build の設定の Hook、作業場所のまとめ */
function makeGrid() {
  const cells = (o) => Object.fromEntries(AG.map(a => [a, o[a] ?? none()]));
  return {
    agents: AG, adopted: true, revision: 'r1', orphans: [],
    rows: [
      { key: 'h-1', kind: 'reg', group: 'ply', agent: 'claude', name: '保存の後に整える', event: 'PostToolUse', matcher: 'Edit', command: 'node fmt.js', on: true, switchable: true,
        cells: cells({ claude: { mode: 'toggle', state: 'on' }, codex: { mode: 'toggle', state: 'off', needsConfirm: true, warnings: [{ code: 'toolMeaning' }, { code: 'postBlock' }] } }) },
      { key: 'hk-admin', kind: 'native', group: 'admin', agent: 'claude', event: 'Stop', matcher: null, command: 'audit.cmd', on: true, switchable: false,
        switchLock: { reason: 'managed', detail: 'managed', agent: 'claude' },
        cells: cells({ claude: { mode: 'locked', state: 'on', reason: 'managed', detail: 'managed' } }) },
      { key: 'hk-grok', kind: 'native', group: 'own', agent: 'grok', event: 'SessionStart', matcher: null, command: 'echo grok-own', on: true, switchable: false,
        switchLock: { reason: 'own', detail: 'grokOwn', agent: 'grok' },
        cells: cells({ grok: { mode: 'locked', state: 'on', reason: 'own', detail: 'grokOwn' }, claude: { mode: 'locked', state: 'off', reason: 'relay', detail: 'grokOwn' } }) },
      { key: 'ws:hooks', kind: 'ws', group: 'place', agent: null, on: true, switchable: false, switchLock: { reason: 'place', detail: 'followsWorkspace' },
        cells: cells({ claude: { mode: 'locked', state: 'on', reason: 'place', detail: 'followsWorkspace' } }) },
    ],
  };
}

export default async function (t) {
  const dom = installDom();
  try {
    await setLanguage('ja');
    setAgentBrands(Object.keys(AGENTS).map(id => ({ id, ...agentPresentation(id) })));

    // ---- 1. 鍵の文（細目ごと） ----
    assert.equal(hookTip({ reason: 'own', detail: 'devinImports', agent: 'devin' }), tr('hooks.matrix.tip.devinImports', { agent: 'Devin' }));
    assert.match(hookTip({ reason: 'own', detail: 'devinImports', agent: 'devin' }), /^Devin が Claude Code の設定から取り込む/);
    assert.equal(hookTip({ reason: 'relay', detail: 'grokOwn', agent: 'claude' }), tr('hooks.matrix.tip.grokOwnOther', { agent: 'Claude' }));
    assert.equal(hookTip({ reason: 'own', detail: 'grokOwn', agent: 'grok' }), tr('hooks.matrix.tip.grokOwn', { agent: 'Grok' }));
    assert.equal(hookTip({ reason: 'managed', detail: 'managed', agent: 'claude' }), tr('hooks.matrix.tip.managed', { agent: 'Claude' }));
    // 細目に文が無い relay は「{エージェント} には渡せません。{理由}」、どれでもなければ共通の文に任せる（null）
    const relay = hookTip({ reason: 'relay', detail: 'noSuchDetail', agent: 'opencode', reasons: [{ code: 'noSuchDetail' }] });
    assert.ok(relay.startsWith('OpenCode には渡せません。'), relay);
    assert.equal(hookTip({ reason: 'own', detail: 'noSuchDetail', agent: 'codex' }), null);
    assert.equal(hookTip({}), null);
    t.ok('鍵の文は細目（detail）ごと。Grok の設定の Hook はほかのエージェントでは別の文、文の無い relay は理由をつなぐ', true);

    // ---- 2. セルの見え方 ----
    const g0 = makeGrid();
    const [reg, admin, grokRow] = g0.rows;
    assert.deepEqual(AG.map(a => hookCellView(admin, a).state), ['lockon', 'na', 'na', 'na', 'na', 'na'], '管理者の Hook: 自分のセルは鍵つきのオン、ほかは短い線');
    assert.equal(hookCellView(admin, 'claude').cell.tip, tr('hooks.matrix.tip.managed', { agent: 'Claude' }));
    assert.equal(hookCellView(grokRow, 'claude').state, 'lockoff');
    assert.equal(hookCellView(grokRow, 'claude').cell.tip, tr('hooks.matrix.tip.grokOwnOther', { agent: 'Claude' }));
    assert.deepEqual(['claude', 'codex'].map(a => hookCellView(reg, a).state), ['on', 'off']);
    const offReg = { ...reg, on: false, cells: { ...reg.cells, claude: { mode: 'toggle', state: 'off' } } };
    assert.equal(hookCellView(offReg, 'claude').state, 'hide', '行が切れていれば押せるセルは隠す');
    assert.equal(hookCellView({ ...grokRow, on: false }, 'claude').state, 'hide', '行が切れていれば鍵つきのオフも隠す');
    assert.equal(hookCellView({ ...admin, on: false }, 'claude').state, 'lockon', '鍵つきのオン（止められない）は行が切れていても見せる');
    t.ok('セル: 管理者の行は自分だけ鍵つき・ほかは線、Grok の設定の Hook は鍵の文つき、行が切れたら押せるセルを隠す', true);

    // ---- 3. 表を描く（DOM） ----
    const calls = [], savedMsgs = [], failures = [], counts = [];
    let failNext = false;
    const cmd = async (op, args) => {
      calls.push([op, args]);
      if (op === 'hooksMatrix') return makeGrid();
      if (op === 'plyHooks' || op === 'scanHooks') return null;
      if (op === 'setHookAgent' || op === 'setHookRow') {
        if (failNext) { failNext = false; throw new Error('書き込めませんでした（試験）'); }
        return { ok: true };
      }
      return null;
    };
    const card = createHooksMatrix({
      cmd, work: fn => fn().catch(e => failures.push(e.message)),
      saved: s => savedMsgs.push(s), failed: s => failures.push(s), opened: new Set(), onCount: n => counts.push(n),
    });
    dom.body.append(card.root);
    await card.load();
    const row = key => card.root.querySelector(`.cx-row[data-key="${key}"]`);
    const chip = (key, a) => row(key)?.querySelector(`.cx-ag[data-agent="${a}"]`);
    const sw = key => row(key)?.querySelector('.cx-sw');

    assert.equal(counts.at(-1), 3, '件数は実行する行の数（作業場所のまとめの行は数えない）');
    assert.equal(card.root.querySelectorAll('.cx-row').length, 4);
    assert.equal(card.root.querySelectorAll('.cx-seg').length, 0, '担当の 2 択は無い');

    // 管理者の行: 行のスイッチは鍵、セルは自分だけ鍵つき、ほかは短い線
    assert.equal(sw('hk-admin').getAttribute('aria-disabled'), 'true');
    assert.equal(sw('hk-admin').dataset.tip, tr('hooks.matrix.tip.managed', { agent: 'Claude' }));
    assert.equal(sw('hk-admin').onclick, undefined, '鍵の行のスイッチは押しても何もしない');
    assert.equal(chip('hk-admin', 'claude').getAttribute('aria-disabled'), 'true');
    assert.equal(row('hk-admin').querySelectorAll('span.cx-ag.na').length, 5);
    assert.ok(row('hk-admin').querySelector('.cbadge'), '管理者の印');
    // Grok の設定の Hook: Grok は止められない、Claude には渡せない（どちらも文つき）
    assert.equal(sw('hk-grok').dataset.tip, tr('hooks.matrix.tip.grokOwn', { agent: 'Grok' }));
    assert.equal(chip('hk-grok', 'claude').dataset.tip, tr('hooks.matrix.tip.grokOwnOther', { agent: 'Claude' }));
    assert.match(chip('hk-grok', 'claude').getAttribute('aria-label'), /Claude で echo grok-own を実行する/);
    // 押せるセルの読み上げ名
    assert.equal(chip('h-1', 'codex').getAttribute('aria-label'), 'Codex で node fmt.js を実行する');
    t.ok('管理者の行は行のスイッチもセルも鍵（ほかは線）、Grok の設定の Hook の鍵の文、読み上げ名「{エージェント} で {名前} を実行する」', true);

    // ---- 4. ほかのエージェントへ初めて広げる: その場で確かめ、注意を並べる ----
    chip('h-1', 'codex').click();
    let ask = card.root.querySelector('.cx-ask');
    assert.ok(ask, '確認が出る');
    assert.equal(ask.querySelector('.q').textContent, 'Pleiad の設定の Hook を、Codex でも実行します');
    assert.deepEqual(ask.querySelectorAll('.hk-warns li').map(li => li.textContent), [tr('hooks.warn.toolMeaning'), tr('hooks.warn.postBlock')]);
    assert.ok(!ask.querySelectorAll('.hk-warns li').some(li => /hooks\.warn\./.test(li.textContent)), '注意の文は鍵のままにしない');
    assert.equal(ask.parent.children[ask.parent.children.indexOf(ask) - 1], row('h-1'), '押した行のすぐ下');
    assert.equal(document.activeElement, ask.querySelector('.btn-primary'), '「実行する」へ移る');
    assert.equal(calls.filter(c => c[0] === 'setHookAgent').length, 0, '確かめる前は保存しない');
    ask.querySelectorAll('button')[0].click();
    assert.equal(card.root.querySelector('.cx-ask'), null, 'やめると消える');
    assert.equal(calls.filter(c => c[0] === 'setHookAgent').length, 0, 'やめても保存しない');
    t.ok('初めて広げるときはその場で 1 回確かめ、渡すときの注意を並べる。やめれば何も保存しない', true);

    // ---- 5. 保存に失敗したら元に戻し、理由を出す ----
    chip('h-1', 'codex').click();
    failNext = true;
    card.root.querySelector('.cx-ask .btn-primary').click();
    assert.equal(chip('h-1', 'codex').getAttribute('aria-pressed'), 'true', '押した瞬間に見た目を変える');
    await settle();
    assert.deepEqual(calls.filter(c => c[0] === 'setHookAgent').map(c => [c[1].key, c[1].agent, c[1].on, c[1].revision]), [['h-1', 'codex', true, 'r1']]);
    assert.equal(chip('h-1', 'codex').getAttribute('aria-pressed'), 'false', '失敗したら元に戻す');
    assert.deepEqual(failures, ['書き込めませんでした（試験）'], '理由は work の失敗の道（下の固定の位置）へ');
    assert.equal(savedMsgs.length, 0, '失敗は「保存しました」にしない');
    t.ok('保存に失敗したら見た目を元に戻し、理由は固定の位置（work）へ渡す', true);

    // 一度確かめた組み合わせは聞き直さない（その場で 1 回だけ）。今度は保存できる
    chip('h-1', 'codex').click();
    assert.equal(card.root.querySelector('.cx-ask'), null, '確かめ済みは聞き直さない');
    await settle();
    assert.equal(calls.filter(c => c[0] === 'setHookAgent').length, 2);
    assert.deepEqual(savedMsgs, [savedText(false)], '保存の知らせは段 2 と同じ決まり');

    // 行のスイッチ: 1 回の書き込み（setHookRow）
    sw('h-1').click();
    await settle();
    assert.deepEqual(calls.filter(c => c[0] === 'setHookRow').map(c => [c[1].key, c[1].on]), [['h-1', false]]);
    assert.equal(calls.filter(c => c[0] === 'setHookAgent').length, 2, '行のスイッチはセルごとに書かない');
    t.ok('確かめ済みの組み合わせは聞き直さず、行のスイッチは 1 回の書き込み', true);

    // ---- 6. 読めない一覧: 0 件と取り違えず、理由と直す操作を出す ----
    const broken = createHooksMatrix({
      cmd: async op => (op === 'hooksMatrix' ? { agents: AG, unreadable: true, error: 'hooks-agents.json を読めません（試験）', rows: [] } : null),
      work: fn => fn(), saved: () => {}, failed: () => {}, opened: new Set(), onCount: n => counts.push(n),
    });
    await broken.load();
    const note = broken.root.querySelector('.hk-broken');
    assert.ok(note && note.getAttribute('role') === 'alert');
    assert.match(note.textContent, /hooks-agents\.json を読めません/);
    assert.equal(note.querySelector('button').textContent, tr('context.repairDocAgents'));
    assert.equal(counts.at(-1), null, '読めないときは件数を隠す');
    assert.equal(broken.root.querySelectorAll('.cx-row').length, 0);
    t.ok('読めない hooks-agents.json は理由と「直す」を出し、件数を隠す', true);

    // ---- 7. 使っていないエージェント（画面の短い名前が届かない）も短い名前・空のマス・消して作り直した行は聞き直す ----
    // 画面の短い名前は有効なエージェントの分だけ（describeBackends）。Devin・Grok を使っていない人の表
    setAgentBrands(['claude', 'codex'].map(id => ({ id, ...agentPresentation(id) })));
    const labels = Object.fromEntries(AG.map(a => [a, agentPresentation(a).shortLabel ?? a]));
    const cells7 = (o) => Object.fromEntries(AG.map(a => [a, o[a] ?? none()]));
    const devReg = () => ({ key: 'h-2', kind: 'reg', group: 'ply', agent: 'claude', name: 'dev', event: 'Stop', matcher: null, command: 'node dev.mjs', on: true, switchable: true,
      cells: cells7({ claude: { mode: 'toggle', state: 'on' }, codex: { mode: 'toggle', state: 'on' }, devin: { mode: 'toggle', state: 'off', needsConfirm: true, warnings: [{ code: 'devinImportsStop' }] },
        grok: { mode: 'locked', state: 'off', reason: 'relay', detail: 'noSuchDetail', reasons: [{ code: 'noSuchDetail' }] } }) });
    const wsRow = { key: 'ws:hooks', kind: 'ws', group: 'place', agent: null, on: true, switchable: false, switchLock: { reason: 'place', detail: 'followsWorkspace' },
      cells: cells7({ claude: { mode: 'toggle', state: 'on' }, antigravity: { mode: 'toggle', state: 'off', empty: true } }) };
    let withDev = true;
    const calls7 = [];
    const grid7 = () => ({ agents: AG, labels, adopted: true, revision: 'r7', orphans: [], rows: [...(withDev ? [devReg()] : []), wsRow] });
    const card7 = createHooksMatrix({
      cmd: async (op, args) => { calls7.push([op, args]); return op === 'hooksMatrix' ? grid7() : op === 'setHookAgent' ? { ok: true } : null; },
      work: fn => fn(), saved: () => {}, failed: () => {}, opened: new Set(['hook:h-2']),
    });
    dom.body.append(card7.root);
    await card7.load();
    const chip7 = (key, a) => card7.root.querySelector(`.cx-row[data-key="${key}"]`)?.querySelector(`.cx-ag[data-agent="${a}"]`);
    assert.equal(hookAgentLabel('devin'), 'Devin', '一覧の短い名前を使う（正式名の Devin CLI にしない）');
    assert.equal(hookAgentLabel('grok'), 'Grok');
    assert.equal(chip7('h-2', 'devin').getAttribute('aria-label'), 'Devin で node dev.mjs を実行する');
    assert.equal(chip7('h-2', 'devin').getAttribute('title'), 'Devin');
    assert.ok(chip7('h-2', 'grok').dataset.tip.startsWith('Grok には渡せません。'), chip7('h-2', 'grok').dataset.tip);
    chip7('h-2', 'devin').click();
    assert.equal(card7.root.querySelector('.cx-ask .q').textContent, 'Pleiad の設定の Hook を、Devin でも実行します');
    assert.match(card7.root.querySelector('.cx-ask').getAttribute('aria-label'), /Devin でも実行する確認$/);
    assert.ok(!/Devin CLI|Grok Build/.test(card7.root.textContent), '表のどこにも正式名の長い名前を出さない');
    assert.ok(card7.root.querySelector('.cx-row[data-key="h-2"] ~ .hk-details .hk-facts, .hk-details .hk-facts')?.textContent.includes(`Claude${tr('app.listSeparator')}Codex`),
      '行の詳細の「動いている」も辞書の区切りで並べる');
    t.ok('使っていないエージェント（Devin・Grok）も、確認の帯・読み上げ名・鍵の文で短い名前（一覧の labels）', true);

    // 空のマス（この場所に定義が無い）: 吹き出しと読み上げ名に「定義がありません」。押せるまま
    const empty = chip7('ws:hooks', 'antigravity');
    assert.ok(!empty.hasAttribute('aria-disabled'), '鍵にしない（ほかの場所では効く）');
    assert.equal(typeof empty.onclick, 'function', '押せる');
    assert.equal(empty.getAttribute('title'), `Antigravity: ${tr('hooks.matrix.emptyHere')}`);
    assert.match(empty.getAttribute('aria-label'), /（この場所には定義がありません）$/);
    assert.equal(chip7('ws:hooks', 'claude').getAttribute('title'), 'Claude', '定義のあるマスはふつうの名前だけ');
    t.ok('作業場所の行の空のマスは「この場所には定義がありません」の吹き出しと読み上げ名を出し、押せるまま', true);

    // 確かめ済みは、行を消して作り直したら捨てる
    card7.root.querySelector('.cx-ask .btn-primary').click();
    await settle();
    assert.equal(calls7.filter(c => c[0] === 'setHookAgent').length, 1, '確かめて保存した');
    chip7('h-2', 'devin').click();
    assert.equal(card7.root.querySelector('.cx-ask'), null, '同じ行の間は聞き直さない');
    await settle();
    withDev = false; await card7.reload();
    assert.ok(!chip7('h-2', 'devin'), '行が消えた');
    withDev = true; await card7.reload();
    chip7('h-2', 'devin').click();
    assert.ok(card7.root.querySelector('.cx-ask'), '消して作り直した行は、もう一度確かめる');
    t.ok('広げる前の確かめ済みは、行が一覧から消えたら捨てる（作り直した行で聞き直す）', true);
    setAgentBrands(Object.keys(AGENTS).map(id => ({ id, ...agentPresentation(id) })));
    // ---- 8. Devin の取り込みが止まり始める操作（3 回目のレビューの必須）: 実際の移行結果の一覧で、保存の前に確認の帯 ----
    // 試験のセルに印を書かず、旧「そろえる」で Devin へ向けた登録がある人の移行結果（core の一覧）をそのまま画面に渡す
    {
      const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-hooks-matrix-ui-')));
      try {
        const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), repo = path.join(tmp, 'repo');
        await fs.mkdir(path.join(repo, '.git'), { recursive: true });
        await fs.mkdir(path.join(home, '.claude'), { recursive: true });
        await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo native' }] }] } }));
        const hooksConfig = createHooksConfig({ home, claudeHome: path.join(home, '.claude'), codexHome: path.join(home, '.codex'), geminiHome: path.join(home, '.gemini'), claudeManaged: [] });
        const plyHooks = createPlyHooks(data);
        const both = (await plyHooks.save({ name: 'both', agent: 'claude', event: 'Stop', matcher: '', command: 'node both.mjs', targets: ['claude', 'devin'] })).id;
        const only = (await plyHooks.save({ name: 'only', agent: 'claude', event: 'Stop', matcher: '', command: 'node only.mjs', targets: ['devin'] })).id;
        await plyHooks.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
        const ha = createHooksAgents({ dataDir: data, hooksConfig, plyHooks, findNode: async () => process.execPath, grokHome: path.join(tmp, 'grok') });
        const calls8 = [], jobs = [];
        const card8 = createHooksMatrix({
          cmd: async (op, args) => {
            calls8.push([op, args]);
            if (op === 'hooksMatrix') return ha.matrix({ trust: false });
            if (op === 'setHookAgent') return ha.setAgent({ key: args.key, agent: args.agent, on: args.on, expect: args.revision ?? null });
            if (op === 'setHookRow') return ha.setRow({ key: args.key, on: args.on, expect: args.revision ?? null });
            return null;
          },
          work: fn => { jobs.push(fn()); }, saved: () => {}, failed: () => {}, opened: new Set(), onCount: () => {},
        });
        dom.body.append(card8.root);
        await card8.load();
        const done = async () => { while (jobs.length) await jobs.shift(); await settle(); };
        const chip8 = (key, a) => card8.root.querySelector(`.cx-row[data-key="${key}"]`)?.querySelector(`.cx-ag[data-agent="${a}"]`);
        const sw8 = key => card8.root.querySelector(`.cx-row[data-key="${key}"]`)?.querySelector('.cx-sw');
        const ask8 = () => card8.root.querySelector('.cx-ask');
        const writes = () => calls8.filter(c => c[0] === 'setHookAgent' || c[0] === 'setHookRow').length;
        const stopQ = tr('hooks.matrix.askStop');

        // (1) 元の対象に Devin を含む行の Devin のマス（入れると取り込みが止まり始める。広げる確認は要らない）
        // 行が切れていると押せるマスは隠れるので、移行前は「both」の行は Claude で入っている
        assert.equal(await ha.exists(), false, '試験の置き場: 移行前');
        chip8(both, 'devin').click();
        assert.ok(ask8(), '(1) 帯が出る');
        assert.equal(ask8().querySelector('.q').textContent, stopQ, '(1) 帯の文は「Devin の取り込みが止まります」');
        assert.equal(ask8().getAttribute('aria-label'), tr('hooks.matrix.askStopAria', { name: 'node both.mjs' }));
        assert.ok([...ask8().querySelectorAll('.hk-warns li')].some(li => li.textContent === tr('hooks.warn.devinImportsStop')), '(1) 帯の中に取り込みが止まる注意（core の warnings）');
        ask8().querySelectorAll('button')[0].click();
        await done();
        assert.equal(ask8(), null);
        assert.equal(writes(), 0, '(1)「やめる」は何も保存しない');
        assert.equal(await ha.exists(), false, '(1)「やめる」では移行もしない');
        assert.equal(await ha.devinImportsStopped(repo), false);
        chip8(both, 'devin').click();
        ask8().querySelector('.btn-primary').click();
        await done();
        assert.deepEqual(calls8.filter(c => c[0] === 'setHookAgent').map(c => [c[1].key, c[1].agent, c[1].on]), [[both, 'devin', true]], '(1)「実行する」で保存する');
        assert.equal(await ha.devinImportsStopped(repo), true, '(1) 保存の後は取り込みが止まる');
        t.ok('(1) 元の対象に Devin を含む行の Devin のマス: 帯が出て、「やめる」は何も保存せず、「実行する」で保存して取り込みが止まる', true);

        // 既に止まっている: 2 つ目の Devin（Devin だけの行の行スイッチ）はこの理由では聞かない
        sw8(only).click();
        assert.equal(ask8(), null, '既に止まっている場所の 2 つ目の Devin は聞かない');
        await done();
        assert.equal(calls8.filter(c => c[0] === 'setHookRow').length, 1);
        // 両方切って取り込みが戻った後、もう一度入れるときは聞き直す（覚えない）
        sw8(only).click(); await done();
        chip8(both, 'devin').click(); await done();
        assert.equal(await ha.devinImportsStopped(repo), false, '両方切ると取り込みが戻る');
        chip8(both, 'devin').click();
        assert.equal(ask8()?.querySelector('.q')?.textContent, stopQ, '取り込みが戻った後に入れ直すときは聞き直す');
        ask8().querySelectorAll('button')[0].click();
        t.ok('既に止まっている場所の 2 つ目の Devin は聞かず、Devin を切って取り込みが戻った後は聞き直す', true);

        // (2) Devin だけの行の行スイッチ
        const n0 = writes(), file0 = await fs.readFile(ha.file, 'utf8');
        sw8(only).click();
        assert.equal(ask8()?.querySelector('.q')?.textContent, stopQ, '(2) 行スイッチでも帯が出る');
        assert.equal(ask8().getAttribute('aria-label'), tr('hooks.matrix.askStopAria', { name: 'node only.mjs' }));
        ask8().querySelectorAll('button')[0].click();
        await done();
        assert.equal(writes(), n0, '(2)「やめる」は何も保存しない');
        assert.equal(await fs.readFile(ha.file, 'utf8'), file0, '(2) ファイルもそのまま');
        sw8(only).click();
        ask8().querySelector('.btn-primary').click();
        await done();
        const lastRow = calls8.filter(c => c[0] === 'setHookRow').at(-1)?.[1];
        assert.deepEqual([writes(), lastRow?.key, lastRow?.on], [n0 + 1, only, true], '(2)「実行する」で保存する');
        assert.equal(await ha.devinImportsStopped(repo), true, '(2) 保存の後は取り込みが止まる');
        t.ok('(2) Devin だけの行の行スイッチ: 帯が出て、「やめる」は何も保存せず、「実行する」で保存して取り込みが止まる', true);
        card8.root.remove?.();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
  } finally {
    dom.restore();
  }
}
