// ==================== 設定 › コンテキスト（docs/design-system.md「コンテキスト」） ====================
// エージェントへ何を渡すかを種類ごと（指示・Skills・外部 MCP）に決める 1 画面。**全体の設定だけ**を扱う（ADR 0026）。
// フォルダーごとの設定（places）は会話の右パネルの「この場所だけ変える」から（web/session-context.mjs）。
// 各カードは担当（エージェントに任せる／Pleiad がそろえる。ユーザーと作業場所で共通。ADR 0014）の下に 2 段:
//   - ユーザー（~/.claude・~/.codex と足した場所）: 探す形式と、見つかったもの（スイッチ）と「＋ 探す場所を足す」（その種類にだけ効く）
//   - 作業場所（Git のルートから作業フォルダーまで）: 探す形式だけ。何が見つかるかは場所ごとなので、会話の右パネルで見る
// 「指示」のカードの上には「Pleiad の指示」（web/ply-instructions-card.mjs。担当によらず毎ターン入る）。
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
  let skillQuery = '', skillListHost = null, placeTierEl = null, instTotalEl = null;
  /** 「エージェントの設定」の見出しの右: どれかのエージェントに渡っているファイルの指示の量の合計（モックの「約 2,960 トークン」） */
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
      if (skillListHost?.isConnected) paintTierList(skillListHost, 'skill');
      if (placeTierEl?.isConnected) placeTierEl.hidden = Boolean(skillQuery);
    },
  });

  function updateCounts() {
    const dmInst = docMatrices.instruction;
    const dmSkill = docMatrices.skill;
    const instUser = Array.isArray(dmInst?.rows) ? dmInst.rows.filter(r => r.anyOn).length : null;
    const instruction = instUser == null && plyCount == null ? null : (plyCount ?? 0) + (instUser ?? 0);
    const skill = Array.isArray(dmSkill?.rows) ? dmSkill.rows.filter(r => r.anyOn).length : null;
    tabBar.setCounts({ instruction, skill, mcp: mcpCount, hooks: hooksCount });
  }

  function selectTab(id, { focus = false } = {}) {
    if (!CONTEXT_TABS.includes(id)) return;
    const changed = activeTab !== id;
    activeTab = id;
    writeTabStorage(TAB_KEY, id);
    if (changed && skillQuery) {
      skillQuery = '';
      skillFind.clear();
      if (skillListHost?.isConnected) paintTierList(skillListHost, 'skill');
      if (placeTierEl?.isConnected) placeTierEl.hidden = false;
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
  root.append(lead, status, tabBar.root, tabPanels.instruction, tabPanels.skill, tabPanels.mcp, tabPanels.hooks, toast);
  panel.append(root);

  const home = () => view?.home ?? '';
  const short = p => {
    const h = home();
    if (h && within(h, p)) return `~${String(p).slice(h.length)}`;
    return String(p ?? '');
  };
  const info = () => view.defaults;

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
  const plyInstructions = createPlyInstructions({ cmd, work, saved: (fresh) => saved(savedText(fresh)), openDelegation, opened, showMenu, onCount: n => { plyCount = n; updateCounts(); } });
  // 4 つ目の種類。Hook × エージェントの表（<data>/hooks-agents.json。ADR 0338）。各エージェントの元の設定を読み、書くのは利用者が明示した編集だけ（ADR 0045）
  const hooks = createHooksMatrix({ cmd, work, saved, failed, status, opened, onCount: n => { hooksCount = n; updateCounts(); } });
  tabPanels.hooks.append(hooks.root);

  // ---------------------------------------------------------------- 保存（その場で。全体の設定）
  async function saveKind(kind, mutate, { rescan = true } = {}) {
    const value = structuredClone(info().kinds[kind].value);
    mutate(value);
    view = await cmd('setContextSettings', { place: null, kind, value });
    saved();
    renderAll();
    if (rescan) await loadScan();
  }
  async function saveRoots(kind, roots) {
    view = await cmd('setContextSettings', { place: null, kind, roots });
    saved();
    renderAll();
    await loadScan();
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
      () => cmd('setDocAgent', { kind, key: row.key, agent, on: nextOn, place: 'default', cwd: home() }),
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
      () => cmd('setDocRow', { kind, key: row.key, on, place: 'default', cwd: home() }),
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
      () => cmd('setDocAgent', { kind, key: targetKeys[0], keys: targetKeys, agent, on: nextOn, place: 'default', cwd: home() }),
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
      () => cmd('setDocRow', { kind, keys: meta.keys, on, place: 'default', cwd: home() }),
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
            () => cmd('setDocAgent', { kind, key: keys[0], keys, agent: a.agent, on: true, place: 'default', cwd: home() }),
          );
        } else {
          runDocMutation(
            kind,
            d => { const r = findDocRow(d, a.key); if (r) applyDocAgentLocal(r, d.agents, a.agent, true); },
            () => cmd('setDocAgent', { kind, key: a.key, agent: a.agent, on: true, place: 'default', cwd: home() }),
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
  function paintTierList(list, kind) {
    list.replaceChildren();
    const doc = docMatrices[kind];
    if (kind === 'instruction') paintInstTotal();
    if (!doc) list.append(scanning ? loading() : el('p', 'cx-empty', kind === 'skill' ? t('context.skill.none') : t('context.instruction.none')));
    else documentRows(list, kind, doc);
    if (kind !== 'skill' || !skillQuery) {
      emptyRoots(list, kind);
      list.append(addPlace(kind));
    }
  }
  /**
   * 指示・Skills の行（ユーザーの範囲で見つかったもの）。フォルダー・置き場ごとに 1 行のまとまりにし、開くと 1 件ずつ並ぶ。
   * 名前 × エージェントごとのスイッチ（core/context-doc-matrix.mjs）で、渡す・止めるを切り替える。
   */
  function documentRows(list, kind, doc) {
    const entries = doc.rows ?? [];
    if (!entries.length) { list.append(el('p', 'cx-empty', kind === 'skill' ? t('context.skill.none') : t('context.instruction.none'))); return; }
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
      body.append(nl);
      const where = kind === 'skill' ? parent(parent(entry.path)) : parent(entry.path);
      const note = entry.status === 'shadowed' ? t('context.row.shadowed') : entry.conditional && Array.isArray(entry.paths) ? t('context.row.conditional', { paths: entry.paths.join(', ') }) : '';
      const want = doc.prefer?.[entry.name] ?? view?.defaults?.kinds?.skill?.value?.prefer?.[entry.name];
      const subText = usable
        ? t('sessionContext.skill.choice', { n: usable.length, place: short(where), by: want && pathKey(want) === pathKey(entry.path) ? t('sessionContext.mcp.byPrefer') : t('sessionContext.mcp.byFirst') })
        : [child ? '' : short(where), entry.root ? t('context.roots.extra') : '', note].filter(Boolean).join(' · ');
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
      row.append(open, ...(tokens ? [tokens] : []), sw, rowAgentStrip(kind, doc, entry, entry.name));
      list.append(row);
      if (docAsk?.kind === kind && docAsk.key === entry.key) list.append(docAskEl(kind));
      if (usable) list.append(skillChoice(entry, usable));
      if (opened.has(entry.id)) {
        const peek = peekDocument(entry, { short });
        if (child) peek.classList.add('kid');
        if (entry.root) peek.append(rootActs(kind, entry.root));
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
      body.append(nl, el('span', 'p', short(block.folder)));
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
    if (query && !shown) {
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

  // ---------------------------------------------------------------- 探す場所を足す（種類ごと。ユーザーの段）
  const rootsOf = kind => info().roots[kind]?.value ?? [];
  function rootActs(kind, root) {
    const acts = el('div', 'acts');
    const remove = button(t('context.roots.remove'), 'btn', () => work(() => saveRoots(kind, rootsOf(kind).filter(r => pathKey(r) !== pathKey(root)))));
    remove.setAttribute('aria-label', t('context.roots.removeAria', { path: root }));
    acts.append(remove);
    return acts;
  }
  /** 足したのに何も見つからない場所。行が無いと外せないので、場所そのものを 1 行で出す */
  function emptyRoots(list, kind) {
    if (!scan) return;
    for (const r of rootsOf(kind)) {
      if ((scan.entries ?? []).some(e => e.kind === kind && e.root && pathKey(e.root) === pathKey(r))) continue;
      const row = el('div', 'cx-row cx-root');
      const body = el('span', 't');
      body.append(el('span', 'nm', short(r)), el('span', 'p', t('context.roots.nothing')));
      const remove = button(t('context.roots.remove'), 'btn', () => work(() => saveRoots(kind, rootsOf(kind).filter(x => pathKey(x) !== pathKey(r)))));
      remove.setAttribute('aria-label', t('context.roots.removeAria', { path: r }));
      row.append(body, remove);
      list.append(row);
    }
  }
  function addPlace(kind) {
    if (adding !== kind) {
      const add = button('', 'cx-add', () => { adding = kind; renderCard(kind); cards[kind].querySelector('.cx-addbox input')?.focus(); });
      add.dataset.addPlace = kind;
      add.append(plus(), document.createTextNode(t('context.roots.add')));
      return add;
    }
    const box = el('div', 'cx-addbox');
    const input = el('input'); input.placeholder = t('context.folderPath'); input.setAttribute('aria-label', t('context.roots.addAria')); input.autocomplete = 'off'; input.spellcheck = false;
    const cands = el('div', 'cands');
    const error = el('p', 'err'); error.setAttribute('role', 'alert');
    const close = () => { adding = null; renderCard(kind); cards[kind].querySelector(`[data-add-place="${kind}"]`)?.focus(); };
    const go = async () => {
      const value = input.value.trim();
      if (!value) { error.textContent = t('context.place.pathRequired'); return; }
      try { adding = null; await saveRoots(kind, [...rootsOf(kind), value]); }
      catch (e) { adding = kind; renderCard(kind); const again = cards[kind].querySelector('.cx-addbox'); again.querySelector('input').value = value; again.querySelector('.err').textContent = e.message; again.querySelector('input').focus(); }
    };
    function paintCands() {
      cands.replaceChildren();
      const q = input.value.trim().toLowerCase();
      const listed = new Set(rootsOf(kind).map(pathKey));
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
    if (window.plyDesktop?.chooseFolder) acts.append(button(t('context.chooseFolder'), 'btn', async () => {
      const picked = await window.plyDesktop.chooseFolder().catch(() => null);
      const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
      if (chosen) { input.value = chosen; paintCands(); input.focus(); }
    }));
    acts.append(button(t('context.cancel'), 'btn', close), button(t('context.add'), 'btn btn-quiet', go));
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

  // ---------------------------------------------------------------- 段（ユーザー／作業場所）
  function tierHead(name, sub) {
    const h = el('div', 'cx-tierh');
    h.append(el('span', 'n', name));
    if (sub) h.append(el('span', null, sub));
    return h;
  }
  function userTier(kind) {
    const tier = el('div', 'cx-tier');
    tier.append(tierHead(t('context.tier.user')));
    if (kind === 'skill') tier.append(skillFind.root);
    const list = el('div', 'cx-list');
    list.setAttribute('role', 'group'); list.setAttribute('aria-label', t('context.tier.listAria', { kind: KIND_TITLE[kind]() }));
    if (kind === 'skill') skillListHost = list;
    paintTierList(list, kind);
    tier.append(list);
    return tier;
  }
  function placeTier(kind, doc) {
    const tier = el('div', 'cx-tier');
    tier.append(tierHead(t('context.tier.place'), t('context.tier.placeSub')));
    if (kind === 'skill') {
      placeTierEl = tier;
      tier.hidden = Boolean(skillQuery);
    }
    if (doc?.summaryRow) {
      const summary = doc.summaryRow;
      const label = kind === 'skill' ? t('context.workspaceRow.skill') : t('context.workspaceRow.instruction');
      const sub = kind === 'skill' ? t('context.workspaceRow.skillSub') : t('context.workspaceRow.instructionSub');
      const list = el('div', 'cx-list');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', t('context.tier.place'));
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
      tier.append(list);
    }
    return tier;
  }
  function renderCard(kind) {
    const card = cards[kind];
    if (!card || !view) return;
    const active = document.activeElement;
    const wasFind = kind === 'skill' && active === skillFind.input;
    const findSel = wasFind ? [skillFind.input.selectionStart, skillFind.input.selectionEnd] : null;
    const fk = !wasFind && active && card.contains(active) ? active.dataset?.cxFk : '';
    if (kind === 'skill') { skillListHost = null; placeTierEl = null; }
    card.replaceChildren();
    card.dataset.kind = kind;
    const head = el('div', 'cx-khead');
    const title = el('h4', null, KIND_TITLE[kind]());
    title.id = `cxKind-${kind}`;
    card.setAttribute('aria-labelledby', title.id);
    head.append(title);
    if (scanning && scanVisible) { const label = el('span', 'pending-label'); label.append(runMark(t('pending.searching')), t('pending.searching')); head.append(label); }
    card.append(head);
    if (kind === 'mcp') {   // 外部 MCP は担当の 2 択を持たず、名前 × エージェントの一覧（web/mcp-matrix.mjs。ADR 0327）
      mcpMatrix.render(card, mcpContext());
      mcp.renderExtras(card, mcpContext());
      return;
    }
    const doc = docMatrices[kind];
    let host = card;
    if (kind === 'instruction') {
      // 上に Pleiad の指示（項目ごとのエージェント選択つき）、下にファイルの指示（「エージェントの設定」2 段）＋畳んだ目安
      card.append(plyInstructions.root);
      host = el('div', 'cx-block');
      const sec = el('div', 'cx-sec');
      instTotalEl = el('span', 'r cx-doc-total');
      sec.append(el('span', 'n', t('context.matrix.agentSettings')), instTotalEl);
      host.append(sec);
      card.append(host);
    } else if (kind === 'skill') {
      const sec = el('div', 'cx-sec');
      sec.append(el('span', 'n', t('context.matrix.agentSettings')));
      host.append(sec);
    }
    host.append(userTier(kind), placeTier(kind, doc));
    if (doc?.agents?.length) card.append(agentLegend(doc.agents));
    if (kind === 'instruction') {
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
  function mcpContext() {
    return { cmd, cwd: home(), scanCwd: home(), scan, ply, agents, matrix, reloadMatrix, short, backends: backends(), info: info(),
      saveKind: (mutate, options) => work(() => saveKind('mcp', mutate, options)),
      reload: () => loadScan(), refreshSettings: async () => { view = await cmd('contextSettings', {}); renderAll(); },
      toast: ({ agents = [] } = {}) => saved(savedText(agents.some(a => freshAgents().includes(a)))), status: text => { status.textContent = text; }, rerender: () => renderCard('mcp'),
      opened, loading, work, openAccount: openClaudeAccount };
  }
  const mcp = createMcpSection();
  const mcpMatrix = createMcpMatrix({ section: mcp, onCount: n => { mcpCount = n; updateCounts(); } });

  function renderAll() {
    if (!view) return;
    for (const kind of KINDS) renderCard(kind);
    updateCounts();
  }

  /** 一覧が遅れて届いたときは保持済みの表だけを描き直す。保存・探索・タブの選び直しはしない。 */
  function refreshBrands() {
    if (!view) return;
    const restoreTip = preserveLockTip(panel);
    // 未保存のフォーム（追加場所・指示の量・MCP の詳細設定と名前変更）は、値・エラー・操作を同じ要素のまま戻す。
    const drafts = KINDS.flatMap(kind => [...cards[kind].querySelectorAll('.cx-addbox, .cx-fold, .cx-peek .cx-inline')].map(box => {
      const route = [];
      for (let node = box.parentElement; node !== cards[kind]; node = node.parentElement) route.unshift(Array.from(node.parentElement.children).indexOf(node));
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
      const parent = route.reduce((node, i) => node?.children[i], cards[kind]);
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
      const grid = await cmd('mcpMatrix', { cwd: home() });
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
    const target = home();
    if (!target) { docMatrices[kind] = null; renderCard(kind); updateCounts(); return; }
    const ticket = ++docTickets[kind];
    try {
      const grid = await callDocRetry(() => cmd('docMatrix', { kind, cwd: target, place: 'default' }));
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
  /** ユーザーの範囲（home と足した場所）だけを探す。作業場所のファイルは場所ごとなので、ここには出さない */
  async function loadScan({ refresh = false } = {}) {
    const ticket = ++scanTicket, target = home();
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
        const found = await cmd('scanContext', { cwd: target, place: 'default', scope: 'user' });
        if (ticket !== scanTicket) return { found, instGrid: null, skillGrid: null };
        const instGrid = await callDocRetry(() => cmd('docMatrix', { kind: 'instruction', cwd: target, place: 'default' })).catch(() => null);
        if (ticket !== scanTicket) return { found, instGrid, skillGrid: null };
        const skillGrid = await callDocRetry(() => cmd('docMatrix', { kind: 'skill', cwd: target, place: 'default' })).catch(() => null);
        return { found, instGrid, skillGrid };
      })();
      const [{ found, instGrid, skillGrid }, list, native, grid] = await Promise.all([
        scanAndDocs,
        cmd('listPlyMcp', {}).catch(() => null),
        cmd('agentMcp', { cwd: target }).catch(() => null),
        cmd('mcpMatrix', { cwd: target, refresh }).catch(() => null),
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
  async function open() {
    status.textContent = '';
    try {
      view = await cmd('contextSettings', {});
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
    adding = null; opened.clear(); bundleOpen.clear(); skillQuery = ''; skillFind.clear(); plyCount = null; mcpCount = null; hooksCount = null; mcpMatrix.reset();
    renderAll();
    await Promise.all([plyInstructions.load(), loadScan({ refresh: true }), hooks.load()]);
  }
  // どの口（画面・AI・CLI）から変えても、開いている設定のページを取り直す（web/client.mjs が settingsChanged を ply:settings-changed として渡す）
  window.addEventListener('ply:settings-changed', e => {
    const keys = e.detail?.keys ?? [];
    if (!document.body.classList.contains('settings') || panel.hidden) return;
    if (keys.includes('context.default')) cmd('contextSettings', {}).then(v => {
      view = v;
      renderAll();
      reloadMatrix();
      reloadDocMatrix('instruction');
      reloadDocMatrix('skill');
    }).catch(() => {});
    if (keys.includes('plyInstructions')) plyInstructions.load();
    // Hooks の表と、Hooks で変わる指示・Skills の表の Devin の取り込むマス（ADR 0338）
    if (keys.includes('hooks')) { hooks.reload(); reloadDocMatrix('instruction'); reloadDocMatrix('skill'); }
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
  /** 設定のコンテキストのページを開く（いつも全体の設定） */
  function openPage() { show(); return open(); }
  openButton.onclick = () => openPage();
  return { openPage, refreshBrands, get scanning() { return scanning; } };
}
