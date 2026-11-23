// ==================== 設定 › コンテキスト（docs/design-system.md「コンテキスト」） ====================
// エージェントへ何を渡すかを種類ごと（指示・Skills・外部 MCP・Hooks）に決める 1 画面。設定する範囲は上の帯で選ぶ（ADR 0348。ADR 0026 を改める）:
//   全体の設定（null）か、保存したフォルダー（scope。見つからないフォルダーは読むだけで、「設定を消す…」だけできる）。
//   フォルダーでは受け継ぐ値からの差分だけを保存し、変えた行に「● 変更」＋「戻す」、上のフォルダーから受け継いだ行に「website の設定」を出す。
//   全体の設定では、別の設定にしたフォルダーを行の下に「website で別の設定」と添える。会話の右パネルからは、そのフォルダーを選んで開く。
// 4 つのタブの節は同じ並び（印と節の頭は web/context-scope-marks.mjs）:
//   1. スキャン場所: 全体では「Git のルートから作業フォルダーまで」の規則の行、フォルダーではそこで見つかったもの。続けて追加したスキャン場所と「＋ スキャン場所を追加」
//   2. ユーザースコープ（~/.claude・~/.codex など）で見つかったもの
//   3. Pleiad の指示・Pleiad に登録（すべての場所に共通。足すのは全体の設定でだけ）
// 変更はその場で保存し（setContextSettings / setPlyInstructions）、「保存しました · 次のターンから反映」を出す。始まっている会話にも次のターンから効く。
// 設定の形と継承は core/context-settings.mjs、外部 MCP の一覧と追加シートは web/mcp-config.mjs。
import { el } from './dom.mjs';
import { runMark } from './arc.mjs';
import { renderMarkdown } from './render.mjs';
import { copyIcon } from './icons.mjs';
import { createMcpSection } from './mcp-config.mjs';
import { createMcpMatrix } from './mcp-matrix.mjs';
import { createPlyInstructions } from './ply-instructions-card.mjs';
import { createHooksMatrix } from './hooks-matrix.mjs';
import { elsewhereText, overrideBadge, parentLink, placeName, revertButton, rowMarks, sectionHead, textButton } from './context-scope-marks.mjs';
import { t, fmt } from './i18n.mjs';
import { DEFAULT_BUDGET, MIN_BUDGET, MAX_BUDGET, budgetOf } from './instruction-amount.mjs';
import { CONTEXT_TABS, chevronIcon, createFindBar, createTabBar, entryOrigins, groupEntries, originMarks, readTabStorage, writeTabStorage } from './context-tabs.mjs';
import { preserveLockTip } from './lock-tip.mjs';
import { agentName, rememberAgentNames } from './agent-brands.mjs';
import { freshAgents, MATRIX_ICON, agentChip, agentLegend, agentStrip, applyDocAgentLocal, applyDocBundleLocal, applyDocRowLocal, askBanner, docBundleMeta, docFreshChanged, docRowSwitch, matrixSvg, savedText } from './context-matrix.mjs';

const KINDS = ['instruction', 'skill', 'mcp'];
const TAB_KEY = 'ply-context-tab';
const KIND_TITLE = {
  instruction: () => t('context.instruction.title'),
  skill: () => t('context.skill.title'),
  mcp: () => t('context.mcp.title'),
};
export const pathKey = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export const within = (dir, file) => pathKey(file) === pathKey(dir) || pathKey(file).startsWith(pathKey(dir) + '/');
const parent = p => String(p ?? '').replace(/[\\/][^\\/]+$/, '');
const samePath = (a, b) => Boolean(a) && Boolean(b) && pathKey(a) === pathKey(b);
const SVG = {
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  folder: '<path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/>',
  gone: '<path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" stroke-dasharray="2 2"/><path d="M6 8l4 3M10 8l-4 3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  warn: '<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11v.01"/>',
};
/** 範囲の帯の小さな線の絵（16 × 16） */
function icon(name, cls = 'ic') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', cls); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', name === 'plus' || name === 'check' || name === 'warn' ? '2' : '1.5');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = SVG[name];
  return s;
}
/**
 * 指示・Skills の行のスイッチ（設定のカードと、会話の右パネルの「この場所だけ変える」）。value は種類の設定 K で、書き換える。
 * その行が見つかった範囲の除外（excludePaths）を出し入れする。入れるときは、その行を含むフォルダーごとの除外も外す（その行だけを戻す方法が無いので）
 */
export function toggleExclude(value, entry, include) {
  const scope = (entry.scope ?? entry.origins?.[0]?.scope) === 'user' ? 'user' : 'directory';
  value[scope] ??= { sources: [], excludePaths: [] };
  const list = value[scope].excludePaths;
  if (include) {
    value[scope].excludePaths = list.filter(p => !within(p, entry.path) && !within(p, entry.realPath ?? entry.path));
  } else if (!list.some(p => pathKey(p) === pathKey(entry.path))) {
    value[scope].excludePaths = [...list, entry.path];
  }
}
/** まとまりのスイッチで複数件を 1 回の保存で切り替える */
export function toggleExcludeMany(value, entries, include) {
  for (const entry of entries ?? []) toggleExclude(value, entry, include);
}
function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
const plus = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M12 5v14M5 12h14"/>';
  return s;
};

/** SKILL.md の frontmatter を単純な key: value だけ切り出す。入れ子・配列は値の文字列のまま出す */
export function frontmatter(text) {
  const src = String(text ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
  if (!match) return { meta: [], body: src };
  const meta = [];
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta.push([kv[1], kv[2].trim().replace(/^["'](.*)["']$/, '$1')]);
    else if (meta.length && line.trim()) meta[meta.length - 1][1] += ` ${line.trim()}`;
  }
  return { meta, body: src.slice(match[0].length) };
}

/** 中身の確認（行を押すと下に開く）。指示は Markdown、Skill は frontmatter の表と本文 */
export function peekDocument(entry, { short = p => p } = {}) {
  const box = el('div', 'cx-peek');
  const line = el('div', 'row-line');
  line.append(el('span', 'cx-path', short(entry.path)));
  const copy = button('', 'btn btn-icon');
  copy.innerHTML = copyIcon; copy.title = t('context.copyPath'); copy.setAttribute('aria-label', t('context.copyPath'));
  copy.onclick = () => navigator.clipboard?.writeText(entry.path).then(() => { copy.title = t('context.copied'); }).catch(() => {});
  line.append(copy);
  box.append(line);
  const { meta, body } = entry.kind === 'skill' ? frontmatter(entry.content) : { meta: [], body: entry.content ?? '' };
  if (meta.length) {
    const table = el('div', 'fm');
    for (const [k, v] of meta) table.append(el('span', 'k', k), el('span', 'v', v));
    box.append(table);
  }
  const text = el('div', 'body');
  text.innerHTML = renderMarkdown(body || t('context.emptyFile'));
  box.append(text);
  return box;
}

export function setupContext({ button: openButton, cmd, show, showMenu, recentPlaces = () => [], backends = () => [], openDelegation = null, getPrefs = () => ({}), openClaudeAccount = null }) {
  const panel = document.getElementById('contextPanel');
  panel.classList.add('context');
  // 外の AI から Pleiad を使う設定（web/cli-setup.mjs）の置き場。作り直しで消えないよう取っておき、外部 MCP のカードの次へ置く
  const cliSetup = panel.querySelector('#cliSetup');
  panel.replaceChildren();
  const root = el('div', 'cx');
  // 見出しの文（反映の時点）は指示・Skills・外部 MCP の話。Hooks のタブでは出さない（Hooks はカードの中の説明に任せる）
  const lead = el('p', 'cx-lead', t('context.lead'));
  const status = el('p', 'cx-status'); status.setAttribute('role', 'alert');
  const cards = Object.fromEntries(KINDS.map(k => [k, el('section', 'cx-card')]));
  const toast = el('div', 'cx-toast', t('context.saved')); toast.setAttribute('role', 'status');

  let view = null, scan = null, scanning = false, scanVisible = false, ply = null, agents = null, adding = null;
  // 設定する範囲（ADR 0348）。null = 全体の設定、{ id, path, missing, parent } = フォルダー。level はそのフォルダーの段（contextSettings の places の 1 つ）。
  // scopes は保存したフォルダーの一覧（contextScopes。見つかるか・上のフォルダー・変えた数）
  let scope = null, scopes = [], level = null, hooksChanges = 0;
  const menu = { open: false, idx: 0, picking: false };
  // 外部 MCP の一覧（サーバーが組んだ名前 × エージェントの行。core/context-mcp-matrix.mjs）と、コネクターを読み直す回数
  let matrix = null, matrixTicket = 0, matrixPolls = 0, matrixTimer = null;
  // 指示・Skills の名前 × エージェントの一覧（core/context-doc-matrix.mjs）
  const docMatrices = { instruction: null, skill: null };
  const docTickets = { instruction: 0, skill: 0 };
  let docAsk = null;
  const docConfirmed = new Set();
  let docFocus = null;
  let budgetFoldOpen = false;
  const opened = new Set();          // 中身を開いている行（id）
  const bundleOpen = new Map();      // まとまりごとの明示的な開閉状態（キー -> boolean）
  let skillQuery = '', instTotalEl = null;
  /** 「ユーザースコープの指示」の見出しの右: どれかのエージェントに渡っているファイルの指示の量の合計 */
  function paintInstTotal() {
    if (!instTotalEl) return;
    const n = (docMatrices.instruction?.rows ?? []).reduce((a, e) => a + (e.anyOn && Number.isFinite(e.tokens) ? e.tokens : 0), 0);
    instTotalEl.textContent = n > 0 ? t('context.matrix.tokensTotal', { n: fmt.number(n) }) : '';
  }
  let plyCount = null, mcpCount = null, hooksCount = null;
  let toastTimer, scanTicket = 0;

  let activeTab = readTabStorage(TAB_KEY, CONTEXT_TABS, 'instruction');
  const tabPanels = Object.fromEntries(CONTEXT_TABS.map(id => {
    const p = el('div', 'cx-tabpanel');
    p.id = `cx-panel-${id}`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', `cx-tab-${id}`);
    p.hidden = id !== activeTab;
    return [id, p];
  }));
  tabPanels.instruction.append(cards.instruction);
  tabPanels.skill.append(cards.skill);
  tabPanels.mcp.append(cards.mcp, ...(cliSetup ? [cliSetup] : []));

  const skillFind = createFindBar({
    placeholder: t('context.find.placeholder'),
    ariaLabel: t('context.find.aria'),
    onInput: q => {
      skillQuery = q;
      renderCard('skill');
    },
  });

  function updateCounts() {
    const dmInst = docMatrices.instruction;
    const dmSkill = docMatrices.skill;
    const instUser = Array.isArray(dmInst?.rows) ? dmInst.rows.filter(r => r.anyOn).length : null;
    const instruction = instUser == null && plyCount == null ? null : (plyCount ?? 0) + (instUser ?? 0);
    const skill = Array.isArray(dmSkill?.rows) ? dmSkill.rows.filter(r => r.anyOn).length : null;
    tabBar.setCounts({ instruction, skill, mcp: mcpCount, hooks: hooksCount });
    tabBar.setChanges(scope ? tabChanges() : {});
  }
  /** タブごとの「変更 n」。指示・Skills は表の差分と種類の設定と足したスキャン場所、外部 MCP は種類の設定とスキャン場所、Hooks は表の差分とスキャン場所 */
  function tabChanges() {
    const lv = level;
    const k = kind => (lv?.kinds?.[kind]?.changes ?? 0) + (lv?.roots?.[kind]?.changes ?? 0);
    return {
      instruction: (docMatrices.instruction?.changes ?? 0) + k('instruction'),
      skill: (docMatrices.skill?.changes ?? 0) + k('skill'),
      mcp: k('mcp'),
      hooks: hooksChanges + (lv?.roots?.hooks?.changes ?? 0),
    };
  }

  function selectTab(id, { focus = false } = {}) {
    if (!CONTEXT_TABS.includes(id)) return;
    const changed = activeTab !== id;
    activeTab = id;
    writeTabStorage(TAB_KEY, id);
    if (changed && skillQuery) {
      skillQuery = '';
      skillFind.clear();
      renderCard('skill');
    }
    for (const k of CONTEXT_TABS) tabPanels[k].hidden = k !== id;
    lead.hidden = id === 'hooks';
    tabBar.setActive(id, { focus });
    if (changed) {
      const sc = panel.closest('.settings-content');
      if (sc) { sc.scrollTo?.(0, 0); sc.scrollTop = 0; }
    }
  }

  const tabBar = createTabBar({
    tabs: [
      { id: 'instruction', label: t('context.tabs.instruction') },
      { id: 'skill', label: t('context.tabs.skill') },
      { id: 'mcp', label: t('context.tabs.mcp') },
      { id: 'hooks', label: t('context.tabs.hooks') },
    ],
    active: activeTab,
    idPrefix: 'cx',
    ariaLabel: t('context.tabs.aria'),
    onSelect: selectTab,
  });
  lead.hidden = activeTab === 'hooks';
  // 範囲の帯（上に貼りつく）: 範囲のボタンと状態の行、その下にタブ
  const band = el('div', 'band');
  const scopeBox = el('div', 'scope');
  band.append(scopeBox, tabBar.root);
  // 貼りついた帯の高さ（範囲の 1 行＋タブ。360px ではタブが折り返す）を、スクロールの上の余白（scroll-padding-top）へ渡す。
  // 行へのフォーカスや scrollIntoView で、行が帯の下に隠れないようにする
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      const h = Math.ceil(band.getBoundingClientRect().height);
      if (h) panel.closest?.('.settings-content')?.style.setProperty('--cx-band-h', `${h}px`);
    }).observe(band);
  }
  const dialog = el('dialog', 'dlg');
  root.append(lead, status, band, tabPanels.instruction, tabPanels.skill, tabPanels.mcp, tabPanels.hooks, toast, dialog);
  panel.append(root);
  // 見つからないフォルダーは読むだけ。スイッチ・追加・戻すを押しても何もしない（Hooks と Pleiad の指示は自分で止める）
  root.addEventListener('click', e => {
    if (!readOnly()) return;
    const hit = e.target.closest?.('.cx-sw, .cx-ag, .cx-add, .cx-choice, .tbtn.rv, .cx-addbox');
    if (!hit || tabPanels.hooks.contains(hit)) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);

  const home = () => view?.home ?? '';
  const short = p => {
    const h = home();
    if (h && within(h, p)) return `~${String(p).slice(h.length)}`;
    return String(p ?? '');
  };
  const info = () => (scope && level ? level : view.defaults);
  const readOnly = () => Boolean(scope?.missing);
  /** 指示・Skills・外部 MCP の表を読む・書く場所。全体の設定は home と 'default' */
  const docCwd = () => (scope ? scope.path : home());
  const docPlace = () => (scope ? scope.path : 'default');
  /** 受け継ぐ元の名前（「website の設定」「全体の設定」） */
  const fromName = () => (scope?.parent ? t('context.scope.fromParent', { name: placeName(scope.parent.path) }) : t('context.scope.fromGlobal'));
  /** contextSettings の形を取り込み、選んでいるフォルダーの段を探す（保存していない新しいフォルダーは current の段） */
  function applyView(v) {
    view = v;
    if (!scope) { level = null; return; }
    const places = v?.places ?? [];
    level = places.find(p => p.id === scope.id) ?? places.find(p => p.current && samePath(p.path, scope.path)) ?? null;
    if (level && !scope.parent && level.parent) scope.parent = level.parent;
  }

  function saved(text = t('context.saved')) {
    status.textContent = '';
    toast.textContent = text;
    toast.classList.remove('err');
    toast.removeAttribute('aria-hidden');
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 1800);
  }
  /**
   * 保存の失敗。先頭の文（role=alert で読み上げる）に加えて、成功の知らせと同じ下の固定の位置にも出す（レビュー S4）。
   * 長い表の下の行で失敗しても、見ている位置で理由が読める。下の札は読み上げを重ねない（aria-hidden）
   */
  function failed(message) {
    status.textContent = message;
    toast.textContent = message;
    toast.setAttribute('aria-hidden', 'true');
    toast.classList.add('on', 'err');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on', 'err'), 8000);
  }
  async function work(fn, { redraw } = {}) {
    try { await fn(); }
    catch (e) {
      failed(t('context.saveFailed', { error: e.message }));
      // スイッチは押した瞬間に見た目だけ先に変えている。保存できなかったときは、その種類のカードを保存されている状態から描き直す。
      // 入力欄のある操作（追加・編集）では描き直さない（打った文字を消さないため）
      if (redraw) { try { renderCard(redraw); } catch { /* 描き直せなくても失敗の表示は残す */ } }
    }
  }
  const plyInstructions = createPlyInstructions({ cmd, work, saved: (fresh) => saved(savedText(fresh)), openDelegation, opened, showMenu, onCount: n => { plyCount = n; updateCounts(); }, scope: () => scope });
  // 4 つ目の種類。Hook × エージェントの表（<data>/hooks-agents.json。ADR 0338）。各エージェントの元の設定を読み、書くのは利用者が明示した編集だけ（ADR 0045）
  const hooks = createHooksMatrix({ cmd, work, saved, failed, status, opened,
    onCount: (n, { changes = 0 } = {}) => { hooksCount = n; hooksChanges = changes; updateCounts(); },
    scope: () => ({ place: scope?.path ?? null, parent: scope?.parent?.path ?? null, missing: readOnly() }),
    onGo: p => setScope(p),
    scan: { added: () => rootsAdded('hooks'), addControl: () => addPlace('hooks'), remove: p => changeRoot('hooks', 'removeRoot', p) } });
  tabPanels.hooks.append(hooks.root);

  // ---------------------------------------------------------------- 保存（その場で。選んでいる範囲へ）
  const placeArgs = () => (scope ? { place: scope.path, cwd: scope.path } : { place: null });
  async function saveKind(kind, mutate, { rescan = true } = {}) {
    const value = structuredClone(info().kinds[kind].value);
    mutate(value);
    applyView(await cmd('setContextSettings', { ...placeArgs(), kind, value }));
    saved();
    renderAll();
    loadScopes();
    if (rescan) await loadScan();
  }
  /** スキャン場所を 1 つ足す・外す（op: addRoot / removeRoot）。足すのはその種類にだけ効く */
  async function changeRoot(kind, op, p) {
    applyView(await cmd('setContextSettings', { ...placeArgs(), kind, [op]: p }));
    saved();
    renderAll();
    loadScopes();
    if (kind === 'hooks') await hooks.reload();
    else await loadScan();
  }
  /** この範囲で効くスキャン場所 [{ path, from, here }]（全体の設定ではどれも here） */
  function rootsAdded(kind) {
    if (!view) return [];
    const r = info()?.roots?.[kind];
    const own = Array.isArray(r?.added) ? r.added : (r?.value ?? []).map(p => ({ path: p, from: null, here: !scope }));
    if (!scope) return own;
    // フォルダー: すべてのフォルダーに共通で追加したスキャン場所（全体の設定から受け継ぐ。ここでは外せない）を先に、続けてこのフォルダーと親フォルダーで足した場所
    const shared = (view.defaults?.roots?.[kind]?.value ?? []).filter(g => !own.some(o => samePath(o.path, g)))
      .map(g => ({ path: g, from: null, here: false, shared: true }));
    return [...shared, ...own];
  }

  // ---------------------------------------------------------------- 種類のカード
  const originText = row => entryOrigins(row);

  function findDocRow(doc, key) {
    if (!doc) return null;
    if (doc.summaryRow?.key === key) return doc.summaryRow;
    return doc.rows.find(r => r.key === key) ?? null;
  }

  function needsExpandAsk(kind, row, agent) {
    const cell = row.cells?.[agent];
    if (!cell || cell.on || cell.locked || cell.native) return null;
    if (row.scope === 'workspace' || row.key === '__workspace__') return null;
    if (Array.isArray(row.rule?.spread) && row.rule.spread.length > 0) return null;
    // 共通の置き場（.agents の下）の物は、そこを読むエージェント（Codex）の名前でなく「共通」と言う（モックの originCommon。レビュー S9）
    if (row.origins?.length && row.origins.every(o => o.source === 'common')) return 'common';
    const origins = originText(row);
    if (origins.length) return origins[0];
    return row.origins?.some(o => o.source === 'common') ? 'common' : null;
  }

  function runDocMutation(kind, mutateLocal, runRemote) {
    const doc = docMatrices[kind];
    if (!doc) return;
    const prev = structuredClone(doc);
    mutateLocal(doc);
    renderCard(kind);
    updateCounts();
    work(async () => {
      let res = null;
      try { res = await runRemote(); }
      catch (e) {
        docMatrices[kind] = prev;
        throw e;
      }
      // 保存はできた。読み直し（失敗しても投げず、誤りを返す）の後の表と押す前の表を比べて、知らせの文を選ぶ
      const reloadError = await reloadDocMatrix(kind);
      saved(savedText(docFreshChanged(prev, docMatrices[kind]), res?.pruned));
      if (reloadError) status.textContent = t('context.savedReloadFailed', { error: reloadError.message });
    }, { redraw: kind });
  }

  function toggleDocCell(kind, row, agent, fkKey) {
    const doc = docMatrices[kind];
    const cell = row.cells[agent];
    if (!doc || !cell || cell.locked) return;
    const nextOn = !cell.on;
    if (nextOn) {
      const from = needsExpandAsk(kind, row, agent);
      if (from && !docConfirmed.has(`${kind}:${row.key}`)) {
        docAsk = { kind, key: row.key, agent, from, name: row.name, fk: fkKey };
        docFocus = '.cx-ask .btn-primary';
        renderCard(kind);
        return;
      }
    }
    if (docAsk?.kind === kind && docAsk.key === row.key) docAsk = null;
    const staysOn = nextOn || doc.agents.some(a => a !== agent && row.cells[a]?.on);
    docFocus = `[data-cx-fk="${CSS.escape(staysOn ? fkKey : `sw:${row.key}`)}"]`;
    runDocMutation(
      kind,
      d => { const r = findDocRow(d, row.key); if (r) applyDocAgentLocal(r, d.agents, agent, nextOn); },
      () => cmd('setDocAgent', { kind, key: row.key, agent, on: nextOn, place: docPlace(), cwd: docCwd() }),
    );
  }

  // 行の全体のスイッチ。変えられるオンがあればそれだけまとめてオフ（on: false）、無ければ外す前の選択に戻す（on: true）。向きは集計の rowNextOn
  function toggleDocRow(kind, row) {
    if (row.rowLocked) return;
    const on = Boolean(row.rowNextOn);
    if (docAsk?.kind === kind && docAsk.key === row.key) docAsk = null;
    docFocus = `[data-cx-fk="${CSS.escape(`sw:${row.key}`)}"]`;
    runDocMutation(
      kind,
      d => { const r = findDocRow(d, row.key); if (r) applyDocRowLocal(r, d.agents, on); },
      () => cmd('setDocRow', { kind, key: row.key, on, place: docPlace(), cwd: docCwd() }),
    );
  }

  function bundleAgentState(doc, items, agent) {
    const anyRowOn = items.some(r => r.anyOn);
    if (!anyRowOn) return { state: 'hide', cell: null };
    const pressable = items.filter(r => !r.cells[agent]?.locked);
    if (!pressable.length) {
      const onItems = items.filter(r => r.cells[agent]?.on);
      const cell = onItems[0]?.cells[agent] ?? items[0]?.cells[agent] ?? { on: false, locked: true };
      return { state: onItems.length > 0 ? 'lockon' : 'lockoff', cell: { ...cell, on: onItems.length > 0, locked: true } };
    }
    const active = items.filter(r => r.anyOn);
    const vals = active.map(r => Boolean(r.cells[agent]?.on));
    const state = vals.every(Boolean) ? 'on' : vals.some(Boolean) ? 'mixed' : 'off';
    return { state, cell: null, pressable };
  }

  function toggleDocBundleCell(kind, block, items, agent, state, fkKey) {
    const doc = docMatrices[kind];
    if (!doc) return;
    const pressable = items.filter(r => !r.cells[agent]?.locked);
    if (!pressable.length) return;
    const nextOn = state !== 'on';
    const activePressable = pressable.filter(r => r.anyOn);
    const targets = nextOn ? (activePressable.length ? activePressable : pressable) : pressable;
    if (nextOn) {
      let from = null;
      for (const r of targets) {
        const hit = needsExpandAsk(kind, r, agent);
        if (hit) { from = hit; break; }
      }
      const askKey = `bundle:${block.key}`;
      if (from && !docConfirmed.has(`${kind}:${askKey}`)) {
        docAsk = { kind, key: askKey, agent, from, name: block.label, count: targets.length, keys: targets.map(r => r.key), fk: fkKey };
        docFocus = '.cx-ask .btn-primary';
        renderCard(kind);
        return;
      }
    }
    if (docAsk?.kind === kind && docAsk.key === `bundle:${block.key}`) docAsk = null;
    const targetKeys = targets.map(r => r.key);
    const anyStaysOn = nextOn || items.some(r => doc.agents.some(a => {
      if (a === agent && targetKeys.includes(r.key)) return false;
      return Boolean(r.cells[a]?.on);
    }));
    docFocus = `[data-cx-fk="${CSS.escape(anyStaysOn ? fkKey : `bundle-sw:${block.key}`)}"]`;
    runDocMutation(
      kind,
      d => { for (const k of targetKeys) { const r = findDocRow(d, k); if (r) applyDocAgentLocal(r, d.agents, agent, nextOn); } },
      // 複数の名前を 1 回の操作で書く（途中で止まって半端に残らない。レビュー S3）
      () => cmd('setDocAgent', { kind, key: targetKeys[0], keys: targetKeys, agent, on: nextOn, place: docPlace(), cwd: docCwd() }),
    );
  }

  // まとまりの全体のスイッチ。子の全部のマスを集計し、変えられるオンのある子だけをまとめてオフ／外す前の記録のある子から戻す（もともとオフだった子はオンにしない）
  function toggleDocBundleRow(kind, block, items) {
    const doc = docMatrices[kind];
    if (!doc) return;
    const meta = docBundleMeta(doc.agents, items);
    if (meta.rowLocked) return;
    const on = meta.rowNextOn;
    if (docAsk?.kind === kind && docAsk.key === `bundle:${block.key}`) docAsk = null;
    docFocus = `[data-cx-fk="${CSS.escape(`bundle-sw:${block.key}`)}"]`;
    runDocMutation(
      kind,
      d => { applyDocBundleLocal(meta.keys.map(k => findDocRow(d, k)).filter(Boolean), d.agents, on); },
      () => cmd('setDocRow', { kind, keys: meta.keys, on, place: docPlace(), cwd: docCwd() }),
    );
  }

  function docAskEl(kind) {
    const a = docAsk;
    const to = agentName(a.agent);
    const from = a.from === 'common' ? t('context.matrix.originCommon') : agentName(a.from);
    const text = a.count
      ? t('context.matrix.askBundle', { from, name: a.name, count: a.count, to })
      : t('context.matrix.ask', { from, name: a.name, to });
    return askBanner({
      ariaLabel: t('context.matrix.askAria', { name: a.name, to }),
      text,
      cancelLabel: t('context.matrix.cancel'),
      confirmLabel: t('context.matrix.confirm'),
      onCancel: () => {
        docFocus = `[data-cx-fk="${CSS.escape(a.fk)}"]`;
        docAsk = null;
        renderCard(kind);
      },
      onConfirm: () => {
        docConfirmed.add(`${kind}:${a.key}`);
        docFocus = `[data-cx-fk="${CSS.escape(a.fk)}"]`;
        docAsk = null;
        if (a.keys) {
          const keys = [...a.keys];
          runDocMutation(
            kind,
            d => { for (const k of keys) { const r = findDocRow(d, k); if (r) applyDocAgentLocal(r, d.agents, a.agent, true); } },
            () => cmd('setDocAgent', { kind, key: keys[0], keys, agent: a.agent, on: true, place: docPlace(), cwd: docCwd() }),
          );
        } else {
          runDocMutation(
            kind,
            d => { const r = findDocRow(d, a.key); if (r) applyDocAgentLocal(r, d.agents, a.agent, true); },
            () => cmd('setDocAgent', { kind, key: a.key, agent: a.agent, on: true, place: docPlace(), cwd: docCwd() }),
          );
        }
      },
    });
  }

  function rowAgentStrip(kind, doc, row, displayName) {
    return agentStrip({
      agents: doc.agents,
      labelText: t('context.matrix.agentsAria', { name: displayName }),
      renderCell: a => {
        const cell = row.cells[a];
        if (!row.anyOn) return agentChip({ agent: a, state: 'hide', name: displayName });
        const fk = `ag:${row.key}:${a}`;
        if (cell.locked) {
          return agentChip({
            agent: a,
            state: cell.on ? 'lockon' : 'lockoff',
            cell,
            name: displayName,
            ariaLabel: t('context.matrix.agentAria', { agent: agentName(a), name: displayName }),
            key: fk,
            keyAttr: 'cxFk',
          });
        }
        return agentChip({
          agent: a,
          state: cell.on ? 'on' : 'off',
          cell,
          name: displayName,
          ariaLabel: t('context.matrix.agentAria', { agent: agentName(a), name: displayName }),
          key: fk,
          keyAttr: 'cxFk',
          onToggle: () => toggleDocCell(kind, row, a, fk),
        });
      },
    });
  }
  function loading() {
    const p = el('p', 'cx-empty');
    p.append(runMark(t('context.searching')), document.createTextNode(' ' + t('context.searchingDots')));
    return p;
  }
  /** 行の分け方: スキャン場所（作業場所で見つかったもの・追加したスキャン場所で見つかったもの）とユーザースコープ */
  const isUserRow = r => r.scope === 'user' && !r.root;
  /** 行の印（ADR 0348）。フォルダー: 「● 変更」＋「戻す」・受け継いだ場所。全体: 「website で別の設定」 */
  function docMarks(kind, row) {
    if (!scope) return { marks: [], sub: elsewhereText(row.elsewhere), revert: null };
    const marks = rowMarks(row, { place: scope.path, onGo: p => setScope(p) });
    const revert = row.changedHere && !readOnly()
      ? revertButton({ parent: scope.parent?.path ?? null, name: row.name ?? '', key: `rv:${row.key}`, onRevert: () => revertDoc(kind, [row.key]) })
      : null;
    return { marks, sub: '', revert };
  }
  function revertDoc(kind, keys) {
    if (!scope || readOnly()) return;
    const from = fromName();
    work(async () => {
      await cmd('revertDocRows', { kind, keys, place: scope.path });
      saved(t('context.scope.reverted', { from }));
      await reloadDocMatrix(kind);
      loadScopes();
    }, { redraw: kind });
  }
  /**
   * 指示・Skills の行。フォルダー・置き場ごとに 1 行のまとまりにし、開くと 1 件ずつ並ぶ（まとまりのスイッチで中の行をまとめて切り替える）。
   * 名前 × エージェントごとのスイッチ（core/context-doc-matrix.mjs）で、渡す・止めるを切り替える。
   * entries: 並べる行、empty: 1 件も無いときの文（null なら何も出さない）、findNone: 絞り込みで何も無いときに知らせるか
   */
  function documentRows(list, kind, doc, entries, { empty = null, findNone = true } = {}) {
    if (!entries.length) { if (empty) list.append(el('p', 'cx-empty', empty)); return; }
    const query = kind === 'skill' ? skillQuery.toLowerCase() : '';
    const hit = entry => !query || String(entry.name ?? '').toLowerCase().includes(query);
    const blocks = groupEntries(kind, entries);
    let shown = 0;

    function fileRow(entry, child, displayName) {
      const off = !entry.anyOn;
      const usable = skillChoices(entry);
      const row = el('div', 'cx-row ag' + (off ? ' off' : '') + (child ? ' kid' : ''));
      row.dataset.key = entry.key;
      row.append(el('span', 'cx-lead0'));
      const open = button('', 'cx-open');
      open.dataset.cxFk = `open:${entry.id}`;
      open.setAttribute('aria-expanded', String(opened.has(entry.id)));
      const body = el('span', 't');
      const nl = el('span', 'nl');
      const nameText = displayName ?? entry.name;
      nl.append(el('span', 'nm', nameText));
      if (!child) {
        const marks = originMarks(entryOrigins(entry));
        if (marks) nl.append(marks);
      }
      const mk = docMarks(kind, entry);
      if (mk.marks.length) nl.append(...mk.marks);
      body.append(nl);
      const where = kind === 'skill' ? parent(parent(entry.path)) : parent(entry.path);
      const note = entry.status === 'shadowed' ? t('context.row.shadowed') : entry.conditional && Array.isArray(entry.paths) ? t('context.row.conditional', { paths: entry.paths.join(', ') }) : '';
      const want = doc.prefer?.[entry.name] ?? view?.defaults?.kinds?.skill?.value?.prefer?.[entry.name];
      const subText = usable
        ? t('sessionContext.skill.choice', { n: usable.length, place: short(where), by: want && pathKey(want) === pathKey(entry.path) ? t('sessionContext.mcp.byPrefer') : t('sessionContext.mcp.byFirst') })
        : [child || entry.root ? '' : short(where), note, mk.sub].filter(Boolean).join(' · ');
      if (subText) body.append(el('span', 'p', subText));
      open.append(body);
      open.onclick = () => { if (opened.has(entry.id)) opened.delete(entry.id); else opened.add(entry.id); renderCard(kind); };
      const tokens = kind === 'instruction' && Number.isFinite(entry.tokens) ? el('span', 'cx-tok', t('sessionContext.amount.about', { n: fmt.number(entry.tokens) })) : null;
      const sw = docRowSwitch({
        doc,
        meta: entry,
        rows: entry,
        name: entry.name,
        key: `sw:${entry.key}`,
        onToggle: () => toggleDocRow(kind, entry),
      });
      row.append(open, ...(mk.revert ? [mk.revert] : []), ...(tokens ? [tokens] : []), sw, rowAgentStrip(kind, doc, entry, entry.name));
      list.append(row);
      if (docAsk?.kind === kind && docAsk.key === entry.key) list.append(docAskEl(kind));
      if (usable) list.append(skillChoice(entry, usable));
      if (opened.has(entry.id)) {
        const peek = peekDocument(entry, { short });
        if (child) peek.classList.add('kid');
        list.append(peek);
      }
    }

    for (const block of blocks) {
      if (block.type === 'row') {
        if (!hit(block.entry)) continue;
        shown++;
        fileRow(block.entry, false, block.childLabel);
        continue;
      }
      const kids = block.items.filter(({ entry }) => hit(entry));
      if (query && !kids.length) continue;
      shown += kids.length;
      const open = Boolean(query) || (bundleOpen.has(block.key) ? bundleOpen.get(block.key) : block.defaultOpen);
      const items = (query ? kids : block.items).map(i => i.entry);
      const anyBundleOn = items.some(e => e.anyOn);
      const bundleMeta = docBundleMeta(doc.agents, items);
      const row = el('div', 'cx-row ag grp' + (anyBundleOn ? '' : ' off'));
      row.dataset.key = `bundle:${block.key}`;
      const tw = button('', 'cx-ic cx-tw');
      tw.dataset.cxFk = `bundle:${block.key}`;
      tw.setAttribute('aria-expanded', String(open));
      tw.setAttribute('aria-label', block.label);
      tw.append(chevronIcon());
      const flip = () => { if (query) return; bundleOpen.set(block.key, !open); renderCard(kind); };
      tw.onclick = flip;
      const body = el('span', 't' + (query ? '' : ' tap'));
      if (!query) body.onclick = flip;
      const nl = el('span', 'nl');
      nl.append(el('span', 'nm', block.label), el('span', 'cnt', String(block.items.length)));
      const marks = originMarks(block.origins);
      if (marks) nl.append(marks);
      // まとまりの印: 中の行をこのフォルダーで変えていれば「● 変更」、全体の設定では別の設定にしたフォルダー
      if (scope && items.some(e => e.changedHere)) nl.append(overrideBadge('changed'));
      const away = scope ? '' : elsewhereText([...new Set(items.flatMap(e => e.elsewhere ?? []))]);
      body.append(nl, el('span', 'p', [short(block.folder), away].filter(Boolean).join(' · ')));
      let tokOn = 0, tokTotal = 0;
      if (kind === 'instruction') {
        for (const e of items) {
          if (!Number.isFinite(e.tokens)) continue;
          tokTotal += e.tokens;
          if (e.anyOn) tokOn += e.tokens;
        }
      }
      const tokens = kind === 'instruction' && tokTotal > 0 ? el('span', 'cx-tok', t('sessionContext.amount.about', { n: fmt.number(tokOn || tokTotal) })) : null;
      const sw = docRowSwitch({
        doc,
        meta: bundleMeta,
        rows: items,
        name: block.label,
        key: `bundle-sw:${block.key}`,
        onToggle: () => toggleDocBundleRow(kind, block, items),
      });
      const ags = agentStrip({
        agents: doc.agents,
        labelText: t('context.matrix.agentsAria', { name: block.label }),
        renderCell: a => {
          const st = bundleAgentState(doc, items, a);
          if (st.state === 'hide') return agentChip({ agent: a, state: 'hide', name: block.label });
          const fk = `bundle-ag:${block.key}:${a}`;
          if (st.state === 'lockon' || st.state === 'lockoff') {
            return agentChip({
              agent: a,
              state: st.state,
              cell: st.cell,
              name: block.label,
              ariaLabel: t('context.matrix.agentAria', { agent: agentName(a), name: block.label }),
              key: fk,
              keyAttr: 'cxFk',
            });
          }
          return agentChip({
            agent: a,
            state: st.state,
            name: block.label,
            ariaLabel: t('context.matrix.agentAria', { agent: agentName(a), name: block.label }),
            key: fk,
            keyAttr: 'cxFk',
            onToggle: () => toggleDocBundleCell(kind, block, items, a, st.state, fk),
          });
        },
      });
      row.append(tw, body, ...(tokens ? [tokens] : []), sw, ags);
      list.append(row);
      if (docAsk?.kind === kind && docAsk.key === `bundle:${block.key}`) list.append(docAskEl(kind));
      if (open) for (const { entry, childLabel } of kids) fileRow(entry, true, childLabel);
    }
    if (query && !shown && findNone) {
      const none = el('div', 'cx-row');
      none.append(el('span', 'cx-lead0'), el('span', 'p', t('context.find.none')));
      list.append(none);
    }
  }
  /** 同じ名前の Skill の、選べる定義（中身の実体が 2 つ以上あるとき）。無ければ null */
  function skillChoices(entry) {
    if (entry.kind !== 'skill' || !Array.isArray(entry.duplicates) || entry.duplicates.length < 2) return null;
    const real = new Map();
    for (const e of entry.duplicates) {
      const k = pathKey(e.realPath ?? e.path);
      if (!real.has(k)) real.set(k, e);
    }
    return real.size > 1 ? [...real.values()] : null;
  }
  /** どちらの定義を使うかの選択肢（外部 MCP のカードの choices と同じ形）。全体の設定の prefer に保存する */
  function skillChoice(entry, usable) {
    const box = el('div', 'cx-choice'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', t('mcp.choice.aria', { name: entry.name }));
    box.append(el('span', null, t('mcp.choice.lead')));
    for (const e of usable) {
      const label = el('label'), input = el('input');
      input.type = 'radio'; input.name = `skill-choice-${entry.name}`; input.checked = pathKey(e.path) === pathKey(entry.path);
      input.onchange = () => work(() => saveKind('skill', v => { v.prefer = { ...(v.prefer ?? {}), [entry.name]: e.path }; }));
      label.append(input, document.createTextNode(short(parent(parent(e.path)))), el('span', 'cx-mono', entry.name));
      box.append(label);
    }
    return box;
  }

  // ---------------------------------------------------------------- スキャン場所（種類ごと）
  const cardOf = kind => (kind === 'hooks' ? hooks.root : cards[kind]);
  const redraw = kind => (kind === 'hooks' ? hooks.render() : renderCard(kind));
  /** 追加したスキャン場所の頭の行: フォルダー名（下にパス）と、この範囲で足したなら「● 追加」＋「外す」、上のフォルダーで足したなら「website の設定」 */
  function rootHead(kind, a) {
    const r = el('div', 'cx-row hk-root');
    r.dataset.root = a.path;
    const ic = el('span', 'cx-ic'); ic.setAttribute('aria-hidden', 'true'); ic.append(matrixSvg(MATRIX_ICON.folder));
    const body = el('span', 't');
    const nl = el('span', 'nl');
    const nm = el('span', 'nm mono', placeName(a.path)); nm.title = a.path;
    nl.append(nm);
    body.append(nl, el('span', 'p', short(a.path)));
    r.append(ic, body);
    if (!scope || a.here) {
      if (scope) nl.append(overrideBadge('added'));
      if (!readOnly()) {
        const b = textButton(t('context.scope.sec.removeScan'), 'weak', () => work(() => changeRoot(kind, 'removeRoot', a.path)));
        b.setAttribute('aria-label', t('context.scope.sec.removeScanAria', { path: a.path }));
        b.dataset.cxFk = `rm:${a.path}`;
        r.append(b);
      }
    } else if (a.from) nl.append(parentLink(a.from, p => setScope(p)));
    return r;
  }
  function addPlace(kind) {
    if (readOnly()) return null;
    if (adding !== kind) {
      const add = button('', 'cx-add', () => { adding = kind; redraw(kind); cardOf(kind).querySelector('.cx-addbox input')?.focus(); });
      add.dataset.addPlace = kind;
      add.append(plus(), document.createTextNode(t('context.scope.sec.addScan')));
      return add;
    }
    const box = el('div', 'cx-addbox');
    const input = el('input'); input.placeholder = t('context.folderPath'); input.setAttribute('aria-label', t('context.scope.sec.addScanAria')); input.autocomplete = 'off'; input.spellcheck = false;
    const cands = el('div', 'cands');
    const error = el('p', 'err'); error.setAttribute('role', 'alert');
    const close = () => { adding = null; redraw(kind); cardOf(kind).querySelector(`[data-add-place="${kind}"]`)?.focus(); };
    const go = async () => {
      const value = input.value.trim();
      if (!value) { error.textContent = t('context.place.pathRequired'); return; }
      try { adding = null; await changeRoot(kind, 'addRoot', value); }
      catch (e) { adding = kind; redraw(kind); const again = cardOf(kind).querySelector('.cx-addbox'); if (!again) { failed(e.message); return; } again.querySelector('input').value = value; again.querySelector('.err').textContent = e.message; again.querySelector('input').focus(); }
    };
    function paintCands() {
      cands.replaceChildren();
      const q = input.value.trim().toLowerCase();
      const listed = new Set(rootsAdded(kind).map(a => pathKey(a.path)));
      const found = recentPlaces().filter(c => !listed.has(pathKey(c.value)) && (!q || c.value.toLowerCase().includes(q))).slice(0, 6);
      for (const c of found) {
        const b = button('', 'cx-opt2', () => { input.value = c.value; paintCands(); input.focus(); });
        b.append(el('span', 'v', c.value), el('span', 's', c.hint ?? ''));
        cands.append(b);
      }
      if (!found.length) cands.append(el('p', 'cx-sub', q ? t('context.place.noMatch') : t('context.place.noCandidates')));
    }
    input.oninput = () => { error.textContent = ''; paintCands(); };
    input.onkeydown = e => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    };
    const acts = el('div', 'acts');
    if (window.plyDesktop?.chooseFolder) acts.append(textButton(t('context.chooseFolder'), '', async () => {
      const picked = await window.plyDesktop.chooseFolder().catch(() => null);
      const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
      if (chosen) { input.value = chosen; paintCands(); input.focus(); }
    }));
    acts.append(textButton(t('context.cancel'), 'weak', close), textButton(t('context.add'), 'fill', go));
    box.append(input, el('p', 'cx-sub', t('context.place.recent')), cands, error, acts);
    paintCands();
    return box;
  }

  /**
   * 自分で書いた指示の目安（ADR 0056）。担当によらず、会話の右パネルの「指示の量」が自分で書いた分（ユーザー＋この場所）にだけ当てる。
   * prefs.json の instructionBudget に保存し、既定と同じ値なら消す（既定が変わったときに追う）
   */
  function budgetRow({ withLabel = true } = {}) {
    const row = el('div', 'cx-budget');
    const input = el('input');
    input.type = 'number'; input.min = String(MIN_BUDGET); input.max = String(MAX_BUDGET); input.step = '100';
    input.id = 'cxInstructionBudget';
    input.value = String(budgetOf(getPrefs()));
    if (withLabel) {
      const label = el('label', 'n', t('context.budget.label'));
      label.htmlFor = input.id;
      row.append(label);
    } else {
      input.setAttribute('aria-label', t('context.budget.label'));
    }
    const box = el('span', 'rt-number-row');
    box.append(input, el('span', 'rt-unit', t('context.budget.unit')));
    const error = el('p', 'cx-sub err'); error.setAttribute('role', 'alert');
    input.onchange = () => {
      const value = Number(input.value);
      if (!Number.isInteger(value) || value < MIN_BUDGET || value > MAX_BUDGET) {
        error.textContent = t('context.budget.invalid', { min: fmt.number(MIN_BUDGET), max: fmt.number(MAX_BUDGET) });
        return;
      }
      error.textContent = '';
      work(async () => { await cmd('setPref', { key: 'instructionBudget', value: value === DEFAULT_BUDGET ? null : value }); saved(); });
    };
    row.append(box, el('p', 'cx-sub', t('context.budget.note')), error);
    return row;
  }

  // ---------------------------------------------------------------- 節（スキャン場所／ユーザースコープ）
  const listOf = label => { const l = el('div', 'cx-list'); l.setAttribute('role', 'group'); l.setAttribute('aria-label', label); if (readOnly()) l.classList.add('ro'); return l; };
  /** 1. スキャン場所。全体: 規則の行と追加したスキャン場所。フォルダー: そこで見つかったものと、効いている追加したスキャン場所 */
  function docScanSection(kind, doc) {
    const box = el('div', 'cx-block');
    box.append(sectionHead(t('context.scope.sec.scan'), { tip: t('context.scope.sec.scanTip') }));
    const rows = doc?.rows ?? [];
    const list = listOf(t('context.scope.sec.rule'));
    if (!scope) {
      if (doc?.summaryRow) summaryRowEl(list, kind, doc);
      else if (scanning) list.append(loading());
    } else if (readOnly()) list.append(el('p', 'cx-empty', t('context.scope.sec.missingFolder')));
    else if (!doc) list.append(scanning ? loading() : el('p', 'cx-empty', t('context.scope.sec.nothing')));
    else documentRows(list, kind, doc, rows.filter(r => !isUserRow(r) && !r.root), { empty: t('context.scope.sec.nothing'), findNone: false });
    box.append(list);
    for (const a of rootsAdded(kind)) {
      const rl = listOf(placeName(a.path));
      rl.append(rootHead(kind, a));
      const found = rows.filter(r => r.root && samePath(r.root, a.path));
      if (found.length) documentRows(rl, kind, doc, found, { findNone: false });
      else rl.append(el('p', 'cx-empty', doc || !scanning ? t('context.roots.nothing') : t('context.searching')));
      box.append(rl);
    }
    const add = !skillQuery || kind !== 'skill' ? addPlace(kind) : null;
    if (add) box.append(add);
    return box;
  }
  /** 2. ユーザースコープ */
  function docUserSection(kind, doc) {
    const box = el('div', 'cx-block');
    const right = [];
    if (kind === 'instruction') { instTotalEl = el('span', 'cx-doc-total'); right.push(instTotalEl); }
    box.append(sectionHead(kind === 'skill' ? t('context.scope.sec.userSkill') : t('context.scope.sec.userInstruction'), { right }));
    const list = listOf(t('context.tier.listAria', { kind: KIND_TITLE[kind]() }));
    if (!doc) list.append(scanning ? loading() : el('p', 'cx-empty', kind === 'skill' ? t('context.skill.none') : t('context.instruction.none')));
    else documentRows(list, kind, doc, doc.rows.filter(isUserRow), { empty: kind === 'skill' ? t('context.skill.none') : t('context.instruction.none') });
    box.append(list);
    if (kind === 'instruction') paintInstTotal();
    return box;
  }
  /** 全体の設定の規則の行「Git のルートから作業フォルダーまで」（作業場所で見つかるものを、どのエージェントへ渡すか） */
  function summaryRowEl(list, kind, doc) {
    {
      const summary = doc.summaryRow;
      const label = t('context.scope.sec.rule');
      const sub = [kind === 'skill' ? t('context.workspaceRow.skill') : t('context.workspaceRow.instruction'), elsewhereText(summary.elsewhere)].filter(Boolean).join(' · ');
      const row = el('div', 'cx-row ag' + (!summary.anyOn ? ' off' : ''));
      row.dataset.key = summary.key;
      const ic = el('span', 'cx-ic');
      ic.setAttribute('aria-hidden', 'true');
      ic.append(matrixSvg(MATRIX_ICON.folder));
      row.append(ic);
      const body = el('span', 't');
      const nl = el('span', 'nl');
      nl.append(el('span', 'nm', label));
      body.append(nl, el('span', 'p', sub));
      const sw = docRowSwitch({
        doc,
        meta: summary,
        rows: summary,
        name: label,
        key: `sw:${summary.key}`,
        onToggle: () => toggleDocRow(kind, summary),
      });
      row.append(body, sw, rowAgentStrip(kind, doc, summary, label));
      list.append(row);
    }
  }
  function renderCard(kind) {
    const card = cards[kind];
    if (!card || !view) return;
    const active = document.activeElement;
    const wasFind = kind === 'skill' && active === skillFind.input;
    const findSel = wasFind ? [skillFind.input.selectionStart, skillFind.input.selectionEnd] : null;
    const fk = !wasFind && active && card.contains(active) ? active.dataset?.cxFk : '';
    card.replaceChildren();
    card.dataset.kind = kind;
    card.setAttribute('aria-label', KIND_TITLE[kind]());
    if (scanning && scanVisible) { const label = el('p', 'pending-label'); label.append(runMark(t('pending.searching')), t('pending.searching')); card.append(label); }
    if (kind === 'mcp') {   // 外部 MCP は名前 × エージェントの一覧（web/mcp-matrix.mjs。ADR 0327）。節の並びは mcpContext の scanSection・sectionHead
      mcpMatrix.render(card, mcpContext());
      mcp.renderExtras(card, mcpContext());
      markReadOnly(card);
      return;
    }
    const doc = docMatrices[kind];
    if (kind === 'skill') card.append(skillFind.root);
    if (doc?.agents?.length) card.append(agentLegend(doc.agents));
    // 1. スキャン場所 → 2. ユーザースコープ → 3. Pleiad の指示（指示のタブだけ）
    card.append(docScanSection(kind, doc), docUserSection(kind, doc));
    if (kind === 'instruction') card.append(plyInstructions.root);
    markReadOnly(card);
    if (kind === 'instruction' && !scope) {
      const fold = el('details', 'cx-fold');
      fold.open = budgetFoldOpen;
      fold.ontoggle = () => { budgetFoldOpen = fold.open; };
      fold.append(el('summary', null, t('context.budget.label')), budgetRow({ withLabel: false }));
      card.append(fold);
    }
    const pendingFocus = docFocus;
    docFocus = null;
    if (wasFind && skillFind.input.isConnected) {
      skillFind.input.focus({ preventScroll: true });
      if (findSel?.[0] != null) try { skillFind.input.setSelectionRange(findSel[0], findSel[1]); } catch {}
    } else if (pendingFocus) {
      card.querySelector(pendingFocus)?.focus({ preventScroll: true });
    } else if (fk) {
      card.querySelector(`[data-cx-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
    }
  }
  /** 見つからないフォルダー: 押せる物に aria-disabled を付けて読むだけにする（押しても何もしないのは root の capture の click） */
  function markReadOnly(card) {
    if (!readOnly()) return;
    for (const b of card.querySelectorAll('.cx-sw, .cx-ag, .cx-choice input')) b.setAttribute('aria-disabled', 'true');
    for (const l of card.querySelectorAll('.cx-list')) l.classList.add('ro');
  }
  /** 外部 MCP の行の印。フォルダー: kinds.mcp.rows（行 → 変えた場所）から。全体: 別の設定にした保存済みのフォルダー */
  function mcpMarks(key, name) {
    const lv = info();
    if (!scope) {
      const away = (view?.places ?? []).filter(p => p.saved && samePath(p.kinds?.mcp?.rows?.[key], p.path)).map(p => p.path);
      return { marks: [], sub: elsewhereText(away), revert: null };
    }
    const at = lv?.kinds?.mcp?.rows?.[key] ?? null;
    const here = samePath(at, scope.path);
    const marks = rowMarks({ changedHere: here, ruleFrom: !here && at ? at : null }, { place: scope.path, onGo: p => setScope(p) });
    const revert = here && !readOnly()
      ? revertButton({ parent: scope.parent?.path ?? null, name, key: `rv:${key}`, onRevert: () => revertMcp(key) })
      : null;
    return { marks, sub: '', revert };
  }
  function revertMcp(key) {
    if (!scope || readOnly()) return;
    const from = fromName();
    work(async () => {
      applyView(await cmd('setContextSettings', { ...placeArgs(), kind: 'mcp', revertRows: [key] }));
      saved(t('context.scope.reverted', { from }));
      loadScopes();
      await reloadMatrix();
    }, { redraw: 'mcp' });
  }
  /** 外部 MCP のスキャン場所: 作業場所の規則の 1 行と、追加したスキャン場所（MCP の行は名前ごとにユーザースコープ・Pleiad に登録の節へまとめる） */
  function mcpScanSection() {
    const box = el('div', 'cx-block');
    box.append(sectionHead(t('context.scope.sec.scan'), { tip: t('context.scope.sec.scanTip') }));
    const list = listOf(t('context.scope.sec.rule'));
    const row = el('div', 'cx-row');
    const ic = el('span', 'cx-ic'); ic.setAttribute('aria-hidden', 'true'); ic.append(matrixSvg(MATRIX_ICON.folder));
    const body = el('span', 't');
    body.append(el('span', 'nm', t('context.scope.sec.rule')), el('span', 'p', readOnly() ? t('context.scope.sec.missingFolder') : t('context.workspaceRow.mcp')));
    row.append(ic, body);
    list.append(row);
    box.append(list);
    for (const a of rootsAdded('mcp')) {
      const rl = listOf(placeName(a.path));
      rl.append(rootHead('mcp', a));
      box.append(rl);
    }
    const add = addPlace('mcp');
    if (add) box.append(add);
    return box;
  }
  function mcpContext() {
    return { cmd, cwd: docCwd(), scanCwd: docCwd(), place: scope?.path ?? null, readOnly: readOnly(), scan, ply, agents, matrix, reloadMatrix, short, backends: backends(), info: info(),
      rowMarks: mcpMarks, scanSection: mcpScanSection, sectionHead: title => sectionHead(title),
      saveKind: (mutate, options) => work(() => saveKind('mcp', mutate, options)),
      reload: () => loadScan(), refreshSettings: async () => { applyView(await cmd('contextSettings', scope ? { cwd: scope.path } : {})); renderAll(); },
      toast: ({ agents = [] } = {}) => saved(savedText(agents.some(a => freshAgents().includes(a)))), status: text => { status.textContent = text; }, rerender: () => renderCard('mcp'),
      opened, loading, work, openAccount: openClaudeAccount };
  }
  const mcp = createMcpSection();
  const mcpMatrix = createMcpMatrix({ section: mcp, onCount: n => { mcpCount = n; updateCounts(); } });

  function renderAll() {
    paintScope();
    if (!view) return;
    for (const kind of KINDS) renderCard(kind);
    updateCounts();
  }

  // ---------------------------------------------------------------- 範囲の帯（全体の設定・フォルダー）
  const scopeEntry = () => (scope ? scopes.find(p => p.id === scope.id) ?? null : null);
  /** 範囲の一覧の並び: 全体の設定、保存したフォルダー（見つからないものは最後）、別のフォルダーを選ぶ */
  const menuItems = () => [{ type: 'global' }, ...scopes.map(p => ({ type: 'place', p })), { type: 'pick' }];
  const usedOf = p => recentPlaces().find(c => samePath(c.value, p))?.hint ?? '';
  function paintScope() {
    const hadFocus = scopeBox.contains(document.activeElement) ? document.activeElement.dataset?.cxFk ?? '' : '';
    scopeBox.replaceChildren();
    const name = scope ? placeName(scope.path) : t('context.scope.global');
    const btn = el('button', 'scope-btn');
    btn.type = 'button'; btn.id = 'cxScopeBtn'; btn.dataset.cxFk = 'scope';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', String(menu.open));
    btn.setAttribute('aria-controls', 'cxScopeList');
    btn.setAttribute('aria-label', t('context.scope.buttonAria', { name }));
    btn.append(icon(scope ? (scope.missing ? 'gone' : 'folder') : 'globe'), el('span', 'nm', name));
    if (scope) { const sp = el('span', 'p', short(scope.path)); sp.title = scope.path; btn.append(sp); }
    btn.append(chevronIcon());
    btn.onclick = () => (menu.open ? closeMenu() : openMenu());
    btn.onkeydown = e => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !menu.open) { e.preventDefault(); openMenu(); } };
    scopeBox.append(btn);
    if (scope) scopeBox.append(scopeStatus());
    if (menu.open) scopeBox.append(menu.picking ? pickerEl() : listEl());
    if (hadFocus) scopeBox.querySelector(`[data-cx-fk="${CSS.escape(hadFocus)}"]`)?.focus({ preventScroll: true });
  }
  /** 帯の 2 行目: 「全体の設定どおり」・「website の設定から 3 件変更」＋「…に戻す…」・見つからないときは「設定を消す…」 */
  function scopeStatus() {
    const st = el('div', 'scope-st');
    const n = scopeEntry()?.changes?.total ?? 0;
    const from = fromName();
    if (scope.missing) {
      const gone = el('span', 'gone');
      gone.append(icon('warn', 'wi'), document.createTextNode(t('context.scope.missingChanges', { count: n })));
      const b = textButton(t('context.scope.removeAll'), 'danger', () => confirmRemove());
      b.dataset.cxFk = 'del';
      st.append(gone, b);
    } else if (!n) {
      st.append(el('span', null, t('context.scope.same', { from })));
    } else {
      st.append(el('span', 'chg', scope.parent ? t('context.scope.changesFrom', { from, count: n }) : t('context.scope.changes', { count: n })));
      const b = textButton(t('context.scope.revertAll', { from }), '', () => confirmRemove());
      b.dataset.cxFk = 'del';
      st.append(b);
    }
    return st;
  }
  function listEl() {
    const ul = el('ul', 'clist');
    ul.id = 'cxScopeList';
    ul.setAttribute('role', 'listbox');
    ul.setAttribute('aria-label', t('context.scope.listAria'));
    ul.tabIndex = -1;
    const items = menuItems();
    items.forEach((it, i) => {
      const li = el('li', i === menu.idx ? 'on' : '');
      li.id = `cxScopeOpt${i}`;
      li.setAttribute('role', 'option');
      const body = el('span', 'body');
      let selected = false;
      if (it.type === 'global') {
        selected = !scope;
        li.append(icon('globe'));
        body.append(el('span', 'lbl', t('context.scope.global')));
        li.append(body);
      } else if (it.type === 'pick') {
        li.classList.add('add');
        li.append(icon('plus'));
        body.append(el('span', 'lbl', t('context.scope.pickOther')));
        li.append(body);
      } else {
        const p = it.p;
        selected = Boolean(scope) && scope.id === p.id;
        li.classList.add('two');
        li.append(icon(p.missing ? 'gone' : 'folder'));
        const used = usedOf(p.path);
        const sub = el('span', 'sub');
        // パスはホームを ~ に縮める（行の後ろの「最後に使った日」が切れないように。全体のパスは title）
        if (p.missing) sub.append(el('span', 'g', t('context.scope.missing')), document.createTextNode(` · ${short(p.path)}`));
        else sub.textContent = used ? t('context.scope.used', { path: short(p.path), date: used }) : short(p.path);
        sub.title = p.path;
        body.append(el('span', 'lbl', placeName(p.path)), sub);
        li.append(body, el('span', 'hint', p.changes?.total ? t('context.scope.hint', { n: p.changes.total }) : ''));
      }
      li.setAttribute('aria-selected', String(selected));
      if (selected) li.append(icon('check', 'ck'));
      li.onpointerdown = e => e.preventDefault();
      li.onclick = () => chooseItem(it);
      ul.append(li);
      if (it.type === 'global') { const h = el('li', 'head', t('context.scope.folders')); h.setAttribute('role', 'presentation'); ul.append(h); }
    });
    ul.setAttribute('aria-activedescendant', `cxScopeOpt${menu.idx}`);
    ul.onkeydown = e => {
      const last = items.length - 1;
      if (e.key === 'ArrowDown') menu.idx = Math.min(last, menu.idx + 1);
      else if (e.key === 'ArrowUp') menu.idx = Math.max(0, menu.idx - 1);
      else if (e.key === 'Home') menu.idx = 0;
      else if (e.key === 'End') menu.idx = last;
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseItem(items[menu.idx]); return; }
      else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } closeMenu({ focus: e.key === 'Escape' }); return; }
      else return;
      e.preventDefault();
      for (const li of ul.querySelectorAll('[role="option"]')) li.classList.toggle('on', li.id === `cxScopeOpt${menu.idx}`);
      ul.setAttribute('aria-activedescendant', `cxScopeOpt${menu.idx}`);
      ul.querySelector(`#cxScopeOpt${menu.idx}`)?.scrollIntoView?.({ block: 'nearest' });
    };
    ul.onfocusout = e => { if (!scopeBox.contains(e.relatedTarget)) closeMenu({ focus: false }); };
    return ul;
  }
  /** 別のフォルダーを選ぶ: パスの欄と、最近の会話のフォルダー（保存していないもの） */
  function pickerEl() {
    const box = el('div', 'clist');
    box.id = 'cxScopeList';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', t('context.scope.pickAria'));
    const pick = el('div', 'pick');
    const input = el('input');
    input.type = 'text'; input.placeholder = t('context.scope.pickPath'); input.setAttribute('aria-label', t('context.scope.pickPath'));
    input.autocomplete = 'off'; input.spellcheck = false; input.dataset.cxFk = 'pickin';
    const cands = el('div', 'cands');
    const paint = () => {
      cands.replaceChildren();
      const q = input.value.trim().toLowerCase();
      const found = recentPlaces().filter(c => !scopes.some(p => samePath(p.path, c.value)) && (!q || c.value.toLowerCase().includes(q))).slice(0, 6);
      for (const c of found) {
        const b = button('', 'cand', () => goPick(c.value));
        b.title = c.value;
        b.append(el('span', null, short(c.value)), el('span', 's', c.hint ? t('context.scope.pickUsed', { date: c.hint }) : ''));
        cands.append(b);
      }
      if (!found.length) cands.append(el('p', 'cx-sub', t('context.scope.pickNone')));
    };
    const error = el('p', 'err'); error.setAttribute('role', 'alert');
    const goPick = async v => {
      const value = String(v ?? '').trim();
      if (!value) { error.textContent = t('context.place.pathRequired'); return; }
      try { await setScope(value, { fresh: true }); }
      catch (e) { error.textContent = e.message; }
    };
    input.oninput = () => { error.textContent = ''; paint(); };
    input.onkeydown = e => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); goPick(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    };
    const acts = el('div', 'acts');
    if (window.plyDesktop?.chooseFolder) acts.append(textButton(t('context.chooseFolder'), '', async () => {
      const picked = await window.plyDesktop.chooseFolder().catch(() => null);
      const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
      if (chosen) goPick(chosen);
    }));
    acts.append(textButton(t('context.scope.confirmCancel'), 'weak', () => closeMenu()), textButton(t('context.scope.pickOpen'), 'fill', () => goPick(input.value)));
    pick.append(input, cands, el('p', 'cx-sub', t('context.scope.pickSaveNote')), error, acts);
    box.append(pick);
    paint();
    queueMicrotask(() => input.focus());
    return box;
  }
  function openMenu() {
    const items = menuItems();
    const at = items.findIndex(it => (it.type === 'global' && !scope) || (it.type === 'place' && scope && it.p.id === scope.id));
    menu.open = true; menu.picking = false; menu.idx = Math.max(0, at);
    paintScope();
    scopeBox.querySelector('.clist')?.focus();
  }
  function closeMenu({ focus = true } = {}) {
    if (!menu.open) return;
    menu.open = false; menu.picking = false;
    paintScope();
    if (focus) scopeBox.querySelector('.scope-btn')?.focus();
  }
  function chooseItem(it) {
    if (!it) return;
    if (it.type === 'pick') { menu.picking = true; paintScope(); return; }
    menu.open = false; menu.picking = false;
    setScope(it.type === 'global' ? null : it.p.path).catch(e => failed(e.message));
    scopeBox.querySelector('.scope-btn')?.focus();
  }
  // 外を押したら一覧を閉じる
  document.addEventListener('pointerdown', e => { if (menu.open && !scopeBox.contains(e.target)) closeMenu({ focus: false }); }, true);
  /** 範囲を変える。path: null = 全体の設定。保存していないフォルダー（fresh）は、最初に変えたときに保存される */
  async function setScope(path, { fresh = false } = {}) {
    menu.open = false; menu.picking = false;
    adding = null; docAsk = null; opened.clear(); bundleOpen.clear();
    if (!path) {
      scope = null; level = null;
    } else {
      const known = scopes.find(p => samePath(p.path, path));
      scope = known ? { id: known.id, path: known.path, missing: Boolean(known.missing), parent: known.parent ?? null }
        : { id: pathKey(path), path, missing: false, parent: null };
    }
    let v;
    try { v = await cmd('contextSettings', scope ? { cwd: scope.path } : {}); }
    catch (e) { if (fresh) { scope = null; level = null; paintScope(); throw e; } throw e; }
    if (scope && !scopes.some(p => p.id === scope.id)) {
      const cur = (v?.places ?? []).find(p => p.current);
      if (cur) { scope.id = cur.id; scope.path = cur.path ?? scope.path; scope.parent = cur.parent ?? null; }
    }
    applyView(v);
    scan = null; matrix = null; matrixPolls = 0;
    docMatrices.instruction = null; docMatrices.skill = null; hooksChanges = 0;
    renderAll();
    plyInstructions.render?.();
    await Promise.all([loadScan(), hooks.reload()]);
  }
  /** 保存したフォルダーの一覧を取り直す（変えた数・見つかるか）。帯とタブの「変更 n」を描き直す */
  async function loadScopes() {
    try {
      const r = await cmd('contextScopes', {});
      scopes = Array.isArray(r?.places) ? r.places : [];
    } catch { return; }
    if (scope) {
      const e = scopes.find(p => p.id === scope.id);
      if (e) { scope.missing = Boolean(e.missing); scope.parent = e.parent ?? null; scope.path = e.path; }
    }
    paintScope();
    updateCounts();
  }
  /** 「…に戻す…」「設定を消す…」の確かめ。そのフォルダーの設定（種類・スキャン場所・表・Hooks）を全部消し、上の範囲へ移る */
  function confirmRemove() {
    if (!scope) return;
    const entry = scopeEntry();
    const name = placeName(scope.path), from = fromName(), missing = scope.missing;
    const total = entry?.changes?.total ?? 0, roots = entry?.changes?.roots ?? 0;
    const parts = [];
    if (total - roots > 0) parts.push(t('context.scope.confirmChanged', { count: total - roots }));
    if (roots > 0) parts.push(t('context.scope.confirmRoots', { count: roots }));
    dialog.replaceChildren();
    const title = el('h4', null, missing ? t('context.scope.confirmRemoveTitle', { name }) : t('context.scope.confirmRevertTitle', { from }));
    title.id = 'cxScopeDlgTitle';
    dialog.setAttribute('aria-labelledby', title.id);
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-describedby', 'cxScopeDlgBody');
    const acts = el('div', 'acts');
    const cancel = textButton(t('context.scope.confirmCancel'), 'weak', () => dialog.close());
    const ok = textButton(missing ? t('context.scope.confirmRemove') : t('context.scope.confirmRevert'), 'danger', async () => {
      ok.disabled = true;
      const target = scope.path, to = scope.parent?.path ?? null;
      try {
        await cmd('removeContextPlace', { place: target });
        dialog.close();
        await loadScopes();
        await setScope(to);
        saved(missing ? t('context.scope.removed', { name }) : t('context.scope.reverted', { from }));
      } catch (e) { ok.disabled = false; failed(t('context.saveFailed', { error: e.message })); }
    });
    acts.append(cancel, ok);
    const body = el('p', null, t('context.scope.confirmBody', { name, what: parts.join(t('context.scope.confirmJoin')) || t('context.scope.confirmChanged', { count: 0 }) }));
    body.id = 'cxScopeDlgBody';
    dialog.append(title, body, acts);
    dialog.onclose = () => scopeBox.querySelector('[data-cx-fk="del"]')?.focus();
    dialog.showModal?.();
    cancel.focus();
  }

  /** 一覧が遅れて届いたときは保持済みの表だけを描き直す。保存・探索・タブの選び直しはしない。 */
  function refreshBrands() {
    if (!view) return;
    const restoreTip = preserveLockTip(panel);
    // 未保存のフォーム（追加場所・指示の量・MCP の詳細設定と名前変更）は、値・エラー・操作を同じ要素のまま戻す。
    // Hooks のタブもスキャン場所の追加の欄を持つ（4 タブ共通。ADR 0348）
    const drafts = [...KINDS, 'hooks'].flatMap(kind => [...cardOf(kind).querySelectorAll('.cx-addbox, .cx-fold, .cx-peek .cx-inline')].map(box => {
      const route = [];
      for (let node = box.parentElement; node !== cardOf(kind); node = node.parentElement) route.unshift(Array.from(node.parentElement.children).indexOf(node));
      return { kind, box, route, index: Array.from(box.parentElement.children).indexOf(box) };
    }));
    const active = document.activeElement;
    const route = [];
    if (active && panel.contains(active)) {
      for (let node = active; node !== panel; node = node.parentElement) route.unshift(Array.from(node.parentElement.children).indexOf(node));
    }
    const sc = panel.closest('.settings-content');
    const scroll = sc ? [sc.scrollLeft, sc.scrollTop] : null;
    const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    plyInstructions.render();
    renderAll();
    hooks.render();
    for (const { kind, box, route, index } of drafts) {
      const parent = route.reduce((node, i) => node?.children[i], cardOf(kind));
      if (box.classList.contains('cx-inline')) parent?.append(box);
      else parent?.children[index]?.replaceWith(box);
    }
    // 確認のボタンや MCP の詳細の操作は、フォーカス用のキーを持たないものもある。
    // データも開閉も同じなので、同じ位置の要素へ戻す（ロゴの中は操作対象ではない）。
    if (route.length) {
      const target = route.reduce((node, index) => node?.children[index], panel);
      target?.focus?.({ preventScroll: true });
      if (selection) target?.setSelectionRange?.(...selection);
    }
    if (scroll) { sc.scrollLeft = scroll[0]; sc.scrollTop = scroll[1]; }
    restoreTip();
  }

  // ---------------------------------------------------------------- 読み込み
  /** 外部 MCP の一覧だけを取り直す（アイコンの保存のあと・コネクターを読んでいる間） */
  async function reloadMatrix() {
    const ticket = ++matrixTicket;
    try {
      const grid = await cmd('mcpMatrix', { cwd: readOnly() ? home() : docCwd(), place: scope?.path ?? null });
      if (ticket !== matrixTicket) return;
      rememberAgentNames(grid?.labels);
      matrix = grid;
    } catch { return; }
    renderCard('mcp');
    pollConnectors();
  }
  async function callDocRetry(fn) {
    for (let i = 0; i < 15; i++) {
      try { return await fn(); }
      catch (e) {
        if (e.code !== 'SCAN_BUSY') throw e;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    throw Object.assign(new Error('SCAN_BUSY'), { code: 'SCAN_BUSY' });
  }
  /** 指示・Skills の名前 × エージェントの一覧だけを取り直す */
  async function reloadDocMatrix(kind) {
    if (kind !== 'instruction' && kind !== 'skill') return;
    const target = docCwd();
    if (!target) { docMatrices[kind] = null; renderCard(kind); updateCounts(); return; }
    const ticket = ++docTickets[kind];
    try {
      const grid = await callDocRetry(() => cmd('docMatrix', { kind, cwd: target, place: docPlace() }));
      if (ticket !== docTickets[kind]) return;
      rememberAgentNames(grid?.labels);
      if (Array.isArray(grid?.rows)) docMatrices[kind] = grid;
    } catch (e) { return e; }
    renderCard(kind);
    updateCounts();
  }
  /** claude.ai のコネクターは Claude を裏で起こして読むので、読み終わるまで少し間をおいて取り直す（上限あり） */
  function pollConnectors() {
    clearTimeout(matrixTimer);
    const reading = matrix?.connectors === 'reading' || (matrix?.connectorAccounts ?? []).some(a => a.reading);
    if (!reading || matrixPolls >= 10 || panel.hidden || !panel.isConnected) return;
    matrixPolls++;
    matrixTimer = setTimeout(() => reloadMatrix(), 2500);
  }
  /** 全体の設定はユーザーの範囲（home と足した場所）だけ、フォルダーはそのフォルダーの範囲も探す */
  async function loadScan({ refresh = false } = {}) {
    const ticket = ++scanTicket, target = docCwd(), place = docPlace();
    if (!target) {
      scan = { entries: [], configs: [] };
      docMatrices.instruction = null;
      docMatrices.skill = null;
      renderAll();
      return;
    }
    const docInstTicket = ++docTickets.instruction;
    const docSkillTicket = ++docTickets.skill;
    scanning = true;
    scanVisible = false;
    renderAll();
    const timer = setTimeout(() => { if (ticket === scanTicket) { scanVisible = true; renderAll(); } }, 150);
    try {
      // scanContext と docMatrix はサーバー側で scanLock を共有するため、この 3 本は直列に流して SCAN_BUSY 衝突を避ける
      const scanAndDocs = (async () => {
        const found = await cmd('scanContext', scope ? (readOnly() ? { cwd: home(), place: 'default', scope: 'user' } : { cwd: target, place }) : { cwd: target, place: 'default', scope: 'user' })
          .catch(e => { if (e.code === 'SCAN_BUSY' || !scope) throw e; return { entries: [], configs: [] }; });
        if (ticket !== scanTicket) return { found, instGrid: null, skillGrid: null };
        const instGrid = await callDocRetry(() => cmd('docMatrix', { kind: 'instruction', cwd: target, place })).catch(() => null);
        if (ticket !== scanTicket) return { found, instGrid, skillGrid: null };
        const skillGrid = await callDocRetry(() => cmd('docMatrix', { kind: 'skill', cwd: target, place })).catch(() => null);
        return { found, instGrid, skillGrid };
      })();
      const [{ found, instGrid, skillGrid }, list, native, grid] = await Promise.all([
        scanAndDocs,
        cmd('listPlyMcp', {}).catch(() => null),
        cmd('agentMcp', { cwd: readOnly() ? home() : target }).catch(() => null),
        // 見つからないフォルダーは作業場所として読めないので、ホームで一覧を組み、その場所の設定（place）だけを当てる
        cmd('mcpMatrix', { cwd: readOnly() ? home() : target, place: scope?.path ?? null, refresh }).catch(() => null),
      ]);
      if (ticket !== scanTicket) return;
      scan = found; ply = list; agents = native;
      rememberAgentNames(grid?.labels); rememberAgentNames(instGrid?.labels); rememberAgentNames(skillGrid?.labels);
      if (grid) { matrix = grid; pollConnectors(); }
      if (Array.isArray(instGrid?.rows) && docInstTicket === docTickets.instruction) docMatrices.instruction = instGrid;
      if (Array.isArray(skillGrid?.rows) && docSkillTicket === docTickets.skill) docMatrices.skill = skillGrid;
    } catch (e) {
      if (ticket !== scanTicket) return;
      status.textContent = e.code === 'SCAN_BUSY' ? '' : t('context.scanFailed', { error: e.message });
      if (e.code === 'SCAN_BUSY') { setTimeout(() => { if (ticket === scanTicket) loadScan(); }, 400); return; }
      scan = { entries: [], configs: [] };
    } finally { clearTimeout(timer); if (ticket === scanTicket) { scanning = false; scanVisible = false; } }
    renderAll();
  }
  async function open({ place } = {}) {
    status.textContent = '';
    menu.open = false; menu.picking = false;
    try {
      const r = await cmd('contextScopes', {}).catch(() => null);
      scopes = Array.isArray(r?.places) ? r.places : [];
      if (place) {
        const known = scopes.find(p => samePath(p.path, place));
        scope = known ? { id: known.id, path: known.path, missing: Boolean(known.missing), parent: known.parent ?? null } : { id: pathKey(place), path: place, missing: false, parent: null };
      } else if (place === null) scope = null;
      else if (scope) {
        const known = scopes.find(p => p.id === scope.id);
        if (known) Object.assign(scope, { path: known.path, missing: Boolean(known.missing), parent: known.parent ?? null });
      }
      const v = await cmd('contextSettings', scope ? { cwd: scope.path } : {});
      if (scope && !scopes.some(p => p.id === scope.id)) {
        const cur = (v?.places ?? []).find(p => p.current);
        if (cur) Object.assign(scope, { id: cur.id, path: cur.path ?? scope.path, parent: cur.parent ?? null });
      }
      applyView(v);
    } catch (e) {
      view = null;
      status.textContent = t('context.loadFailed', { error: e.message });
      // 指示・Skills の表の設定ファイルが読めない（会話を断っている）ときは、ここから退避して直せる（レビュー M6。操作 context.repairDocAgents）
      if (e.code === 'DOC_AGENTS_UNREADABLE') {
        const fix = button(t('context.repairDocAgents'), 'btn', async () => {
          fix.disabled = true;
          try {
            const r = await cmd('repairDocAgents', {});
            await open();
            if (r?.backup) status.textContent = t('context.repairedDocAgents', { file: r.backup });
          } catch (err) {
            fix.disabled = false;
            status.textContent = t('context.loadFailed', { error: err.message });
            status.append(' ', fix);
          }
        });
        status.append(' ', fix);
      }
      return;
    }
    scan = null; matrix = null; matrixPolls = 0;
    docMatrices.instruction = null; docMatrices.skill = null; docAsk = null; docConfirmed.clear(); docFocus = null;
    adding = null; opened.clear(); bundleOpen.clear(); skillQuery = ''; skillFind.clear(); plyCount = null; mcpCount = null; hooksCount = null; hooksChanges = 0; mcpMatrix.reset();
    renderAll();
    await Promise.all([plyInstructions.load(), loadScan({ refresh: true }), hooks.load()]);
  }
  // どの口（画面・AI・CLI）から変えても、開いている設定のページを取り直す（web/client.mjs が settingsChanged を ply:settings-changed として渡す）
  window.addEventListener('ply:settings-changed', e => {
    const keys = e.detail?.keys ?? [];
    if (!document.body.classList.contains('settings') || panel.hidden) return;
    if (keys.includes('context.default')) cmd('contextSettings', scope && !scope.missing ? { cwd: scope.path } : {}).then(v => {
      applyView(v);
      loadScopes();
      renderAll();
      reloadMatrix();
      reloadDocMatrix('instruction');
      reloadDocMatrix('skill');
    }).catch(() => {});
    if (keys.includes('plyInstructions')) plyInstructions.load();
    // Hooks の表と、Hooks で変わる指示・Skills の表の Devin の取り込むマス（ADR 0338）
    if (keys.includes('hooks')) { hooks.reload(); reloadDocMatrix('instruction'); reloadDocMatrix('skill'); loadScopes(); }
  });
  // 登録した Claude アカウントが変わったら（claude.ai のログイン・コネクターのスイッチ）、外部 MCP のアカウントの行を取り直す
  // （web/client.mjs が claudeAccountsChanged を ply:claude-accounts-changed として渡す）
  window.addEventListener('ply:claude-accounts-changed', () => {
    if (!document.body.classList.contains('settings') || panel.hidden || !view) return;
    matrixPolls = 0;
    reloadMatrix();
  });
  // ログインが済んだら一覧の状態を取り直す（web/client.mjs が mcpAuth を ply:mcp-auth として渡す）
  window.addEventListener('ply:mcp-auth', e => {
    const ev = e.detail ?? {};
    if (ev.phase !== 'done' && ev.phase !== 'error') return;
    if (!document.body.classList.contains('settings') || panel.hidden) return;
    mcp.authEvent(ev);
    cmd('listPlyMcp', {}).then(list => { ply = list; renderCard('mcp'); }).catch(() => {});
  });
  /**
   * 設定のプラグインのページを開く。place: フォルダーのパス（会話の右パネルの「このフォルダーの設定を開く」）、null = 全体の設定、
   * 省くと前に選んでいた範囲のまま
   */
  function openPage({ place } = {}) { show(); return open({ place }); }
  openButton.onclick = () => openPage();
  return { openPage, refreshBrands, setScope, get scope() { return scope; }, get scanning() { return scanning; } };
}
