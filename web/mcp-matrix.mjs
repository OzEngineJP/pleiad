// ==================== 設定 › プラグイン › 外部 MCP の一覧（名前 × エージェント。docs/design-system.md「外部 MCP」・ADR 0327） ====================
// 行ごとに「全体のスイッチ」と、エージェントごとのアイコンを並べる。担当の 2 択（エージェントに任せる／Pleiad がそろえる）は無い。
//   - アイコンを押す = その名前をそのエージェントで使う／使わない（core/ops/context.mjs の context.setMcpAgent）。外すときは確かめない
//   - 自分の設定に持っていないエージェントのアイコンを入れる（= 他のエージェントの設定の MCP を広げる）ときだけ、名前ごとに 1 回その場で確かめる
//   - Pleiad から止められないエージェント（鍵）は押せない
//   - claude.ai のコネクター・プラグインの MCP は Claude にだけつながるので、Claude のアイコンだけを押せる
// どのアイコンが on か・押せるかは、サーバーが決めた行（core/context-mcp-matrix.mjs の buildMcpMatrix）をそのまま描く。
// 行の詳細（編集・名前の変更・ログイン・削除・取り込み）は web/mcp-config.mjs の peek。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { agentBrand, agentShortLabel } from './agent-brands.mjs';
import { ensureBrandMark } from './brand-marks.mjs';
import { ensureLockTips, lockReasonText, lockAriaLabel } from './lock-tip.mjs';

const ICON = {
  url: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"/>',
  stdio: '<path d="m5 8 4 4-4 4M12 16h7"/>',
  // 製品の資材: 雲は web/git-icons.mjs の cloudIcon、プラグは web/conversation-usage.mjs の plugins
  connector: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  plugin: '<path d="M9 3v4m6-4v4M6 7h12v3.5a6 6 0 0 1-12 0zM12 16.5V21"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
};
const svg = d => { const s = el('span'); s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`; return s.firstChild; };
const label = id => agentShortLabel(id, id);
const names = ids => ids.map(label).join('・');

/** エージェントのロゴ。ロゴの無いエージェントは ◇（web/side.mjs の backendLogo と同じ決め） */
function mark(id) {
  const brand = agentBrand(id);
  if (brand?.mark) {
    const s = el('span'); s.innerHTML = `<svg class="mk" viewBox="0 0 24 24" aria-hidden="true"><use href="#${ensureBrandMark(brand.logo)}"/></svg>`;
    return s.firstChild;
  }
  if (brand) { const i = el('img', 'mk'); i.src = `./brand/${brand.logo}`; i.alt = ''; i.draggable = false; return i; }
  return el('span', 'mk', '◇');
}
const button = (cls, text) => { const b = el('button', cls, text); b.type = 'button'; return b; };
const lockGlyph = () => { const k = el('span', 'lk'); k.append(svg(ICON.lock)); return k; };

/**
 * section は createMcpSection() の戻り（peek・authNote を使う）。
 * 戻り: { render(host, ctx) }。ctx は web/context.mjs の mcpContext() に matrix・reloadMatrix を足したもの
 */
export function createMcpMatrix({ section, onCount }) {
  const memory = new Map();       // 全体をオフにする前に使っていたエージェント（この画面を開いている間だけ。戻すときの並び）
  const confirmed = new Set();    // 広げる確認を済ませた名前（名前ごとに 1 回）
  let ask = null;                 // { key, agent }
  let focus = null;               // 描き直した後に focus を戻す先

  const calledOf = row => row.kind === 'plugin' ? t('mcp.matrix.pluginCalled', { plugin: row.plugin, name: row.name })
    : row.kind === 'connector' ? t('mcp.matrix.connectorCalled', { name: row.name }) : row.name;
  const toggles = (m, row) => m.agents.filter(a => row.cells[a].mode === 'toggle');
  /** 全体をオンにしたときの既定。Pleiad の登録はどのエージェントにも、エージェントの設定は持っているエージェントに */
  const defaults = (m, row) => toggles(m, row).filter(a => row.group === 'ply' || row.origins.includes(a));
  const stuck = (m, row) => !defaults(m, row).length && !toggles(m, row).some(a => row.cells[a].state === 'on');
  const switchOn = (m, row) => stuck(m, row) || toggles(m, row).some(a => row.cells[a].state === 'on');

  /** 変更を先に画面へ反映し、1 つずつ保存して、サーバーの行を取り直す（保存に失敗したら元に戻る） */
  function apply(ctx, row, changes, keep = null) {
    const back = keep ? `.cx-row[data-key="${CSS.escape(row.key)}"] ${keep}` : null;
    if (back) focus = back;
    for (const { agent, on } of changes) row.cells[agent].state = on ? 'on' : 'off';
    row.on = ctx.matrix.agents.some(a => row.cells[a].state === 'on');
    ctx.rerender();
    return ctx.work(async () => {
      try {
        for (const { agent, on } of changes) await ctx.cmd('setMcpAgent', { name: row.key, agent, on, cwd: ctx.cwd });
        await ctx.refreshSettings();
        ctx.toast();
      } finally { if (back) focus = back; await ctx.reloadMatrix(); }
    });
  }

  function toggleCell(ctx, row, agent) {
    const on = row.cells[agent].state !== 'on';
    const spreading = on && row.group === 'agent' && row.kind === 'config' && !row.origins.includes(agent);
    if (spreading && !confirmed.has(row.key)) { ask = { key: row.key, agent }; focus = '.cx-ask .btn-primary'; ctx.rerender(); return; }
    const m = ctx.matrix;
    let keep = `.cx-ag[data-agent="${agent}"]`;
    if (!on) {
      const rest = toggles(m, row).filter(a => a !== agent && row.cells[a].state === 'on');
      if (!rest.length) keep = '.cx-sw';   // 最後の 1 つを外すとアイコンが消える。focus はスイッチへ
      if (!rest.length && defaults(m, row).length) memory.set(row.key, toggles(m, row).filter(a => row.cells[a].state === 'on'));
    }
    return apply(ctx, row, [{ agent, on }], keep);
  }
  function toggleAll(ctx, row) {
    const m = ctx.matrix;
    if (ask?.key === row.key) ask = null;
    if (switchOn(m, row)) {
      const ons = toggles(m, row).filter(a => row.cells[a].state === 'on');
      memory.set(row.key, ons);
      return apply(ctx, row, ons.map(agent => ({ agent, on: false })), '.cx-sw');
    }
    const back = (memory.get(row.key) ?? []).filter(a => toggles(m, row).includes(a));
    const targets = back.length ? back : defaults(m, row);
    return apply(ctx, row, targets.map(agent => ({ agent, on: true })), '.cx-sw');
  }

  // i18n-dynamic: ui:mcp.matrix.origin
  function originMarks(row) {
    if (!row.origins.length) return null;
    const text = t(row.kind === 'plugin' ? 'mcp.matrix.originPlugin' : row.kind === 'connector' ? 'mcp.matrix.originConnector' : row.group === 'ply' ? 'mcp.matrix.originPly' : 'mcp.matrix.originAgent', { agents: names(row.origins) });
    const box = el('span', 'cx-src'); box.setAttribute('role', 'img'); box.setAttribute('aria-label', text); box.title = text;
    for (const id of row.origins) { const m = el('span', `sm be-${id}`); m.append(mark(id)); box.append(m); }
    return box;
  }
  function chip(ctx, row, agent) {
    const m = ctx.matrix, cell = row.cells[agent], on = switchOn(m, row);
    if (cell.mode === 'none') { const x = el('span', `cx-ag ${on ? 'na' : 'none'}`); x.setAttribute('aria-hidden', 'true'); return x; }
    if (cell.mode === 'toggle' && cell.state === 'off' && !on) { const x = el('span', 'cx-ag none'); x.setAttribute('aria-hidden', 'true'); return x; }
    const b = button(`cx-ag be-${agent}`);
    b.dataset.agent = agent;
    b.setAttribute('aria-pressed', String(cell.state === 'on'));
    b.append(mark(agent));
    if (cell.mode === 'toggle') {
      b.setAttribute('aria-label', t('mcp.matrix.agentAria', { agent: label(agent), name: calledOf(row) }));
      b.title = label(agent);
      b.onclick = () => toggleCell(ctx, row, agent);
    } else {
      const reason = lockReasonText(label(agent), cell);
      b.setAttribute('aria-disabled', 'true');
      b.dataset.tip = reason;
      b.setAttribute('aria-label', lockAriaLabel(t('mcp.matrix.agentAria', { agent: label(agent), name: calledOf(row) }), reason));
      b.append(lockGlyph());
    }
    return b;
  }

  function rowEl(ctx, row, list) {
    const m = ctx.matrix, on = switchOn(m, row), isStuck = stuck(m, row);
    const locks = m.agents.some(a => row.cells[a].mode === 'locked' || row.cells[a].mode === 'blocked');
    const n = el('div', `cx-row ag${on || locks ? '' : ' off'}`);
    n.dataset.key = row.key;
    const ic = el('span', 'cx-ic'); ic.dataset.kind = row.kind === 'config' ? (row.transport === 'stdio' ? 'stdio' : 'url') : row.kind;
    ic.title = row.kind === 'plugin' ? t('mcp.matrix.kindPlugin') : row.kind === 'connector' ? t('mcp.matrix.connector') : row.transport === 'stdio' ? t('mcp.transport.stdio') : t('mcp.transport.url');
    ic.append(svg(ICON[row.kind === 'config' ? (row.transport === 'stdio' ? 'stdio' : 'url') : row.kind]));

    const body = el('span', 't');
    const line = el('span', 'nl'); line.append(el('span', 'nm', row.name));
    const from = originMarks(row); if (from) line.append(from);
    body.append(line);
    const reg = row.registered ? (ctx.ply?.servers ?? []).find(s => s.name === row.name) : null;
    const note = row.kind === 'plugin' ? el('span', 'p', t('mcp.matrix.pluginNote', { plugin: row.plugin }))
      : row.kind === 'connector' ? (row.needsAuth ? section.connectorNote() : null) : section.authNote(reg, row.name);
    if (note) body.append(note);

    const key = `mcp:${row.name}`;
    const entries = row.kind === 'config' ? (ctx.scan?.entries ?? []).filter(e => e.kind === 'mcp' && e.name === row.name) : [];
    const peekable = entries.length > 0 || Boolean(reg);
    let head;
    if (peekable) {
      head = button('cx-open');
      head.setAttribute('aria-expanded', String(ctx.opened.has(key)));
      head.append(ic, body);
      head.onclick = () => { if (ctx.opened.has(key)) ctx.opened.delete(key); else ctx.opened.add(key); ctx.rerender(); };
    } else { head = el('span', 'cx-open'); head.append(ic, body); }

    const sw = button('cx-sw');
    const swLabel = t('mcp.switchAria', { name: calledOf(row) });
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(on)); sw.setAttribute('aria-label', swLabel);
    if (isStuck) {
      const lockAgent = m.agents.find(a => row.cells[a].mode === 'locked' || row.cells[a].mode === 'blocked')
        ?? m.agents.find(a => row.cells[a].state === 'on');
      const reason = lockAgent ? lockReasonText(label(lockAgent), row.cells[lockAgent]) : t('mcp.matrix.locked');
      sw.setAttribute('aria-disabled', 'true');
      sw.dataset.tip = reason;
      sw.setAttribute('aria-label', lockAriaLabel(swLabel, reason));
    } else {
      sw.onclick = () => toggleAll(ctx, row);
    }

    const ags = el('div', 'cx-ags'); ags.setAttribute('role', 'group'); ags.setAttribute('aria-label', t('mcp.matrix.agentsAria', { name: calledOf(row) }));
    for (const a of m.agents) ags.append(chip(ctx, row, a));
    if (!ags.querySelector('button')) ags.classList.add('empty');
    if (row.kind !== 'config') ags.classList.add('solo');   // 相手が Claude だけの行。狭い幅ではスイッチだけにする
    n.append(head, sw, ags);
    list.append(n);
    if (ask?.key === row.key) list.append(askEl(ctx, row));
    if (peekable && ctx.opened.has(key)) {
      const fromPly = entries.find(e => e.origins?.[0]?.source === 'ply') ?? (reg ? {} : null);
      // 同じ名前の定義の選び（prefer）は、持っていないエージェントへ広げている行にだけ出す（そこでしか効かない）
      const spreading = row.group === 'agent' && m.agents.some(a => row.cells[a].state === 'on' && !row.origins.includes(a));
      list.append(section.peek(ctx, row.name, entries, Boolean(fromPly && reg), reg, { choice: spreading }));
    }
  }

  function askEl(ctx, row) {
    const from = row.origins[0], to = ask.agent;
    const box = el('div', 'cx-ask'); box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('mcp.matrix.askAria', { name: row.name, to: label(to) }));
    box.append(el('span', 'q', t('mcp.matrix.ask', { from: label(from), name: row.name, to: label(to) })));
    const cancel = button('btn', t('mcp.matrix.cancel'));
    cancel.onclick = () => { ask = null; focus = `.cx-row[data-key="${CSS.escape(row.key)}"] .cx-ag[data-agent="${to}"]`; ctx.rerender(); };
    const ok = button('btn btn-primary', t('mcp.matrix.confirm'));
    ok.onclick = () => { confirmed.add(row.key); ask = null; focus = `.cx-row[data-key="${CSS.escape(row.key)}"] .cx-ag[data-agent="${to}"]`; apply(ctx, row, [{ agent: to, on: true }], `.cx-ag[data-agent="${to}"]`); };   // 確かめるのは名前ごとに 1 回
    box.append(cancel, ok);
    return box;
  }

  function group(ctx, title, rows, { add = false, wait = false } = {}) {
    const block = el('div', 'cx-block');
    const sec = el('div', 'cx-sec'); sec.append(el('span', 'n', title));
    const list = el('div', 'cx-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', title);
    for (const r of rows) rowEl(ctx, r, list);
    if (wait) {   // コネクターの一覧を読んでいる間。読めたら、この行の所にコネクターの行が入る
      const n = el('div', 'cx-row wait');
      const ic = el('span', 'cx-ic'); ic.dataset.kind = 'connector'; ic.append(svg(ICON.connector));
      const body = el('span', 't'); body.append(el('span', 'p', t('mcp.matrix.searching')));
      n.append(ic, body); list.append(n);
    }
    if (add) list.append(section.addButton(ctx));
    block.append(sec, list);
    return block;
  }

  /** host（種類のカード）へ、ロゴと名前の対応・2 つの組・凡例を描く。ログインの詳細設定は呼び出し側が続ける */
  function render(host, ctx) {
    const m = ctx.matrix;
    if (!m || !ctx.scan) { onCount?.(null); host.append(ctx.loading()); return; }
    const legendNames = el('div', 'cx-legend names'); legendNames.setAttribute('aria-hidden', 'true');
    for (const a of m.agents) { const i = el('span', `li be-${a}`); i.append(mark(a), document.createTextNode(label(a))); legendNames.append(i); }
    host.append(legendNames);
    // 同じサービスのコネクターが使われている間は、プラグインの MCP は一覧に出ない（コネクターを止めると現れる。Claude Code の動き）
    const lower = s => String(s ?? '').toLowerCase();
    const connectorOn = row => m.rows.some(c => c.kind === 'connector' && c.cells.claude?.state === 'on' && [lower(row.name), lower(row.plugin)].includes(lower(c.name)));
    const rows = m.rows.filter(r => r.kind !== 'plugin' || !connectorOn(r));
    onCount?.(rows.length);
    host.append(group(ctx, t('mcp.matrix.groupPly'), rows.filter(r => r.group === 'ply'), { add: true }));
    host.append(group(ctx, t('mcp.matrix.groupAgent'), rows.filter(r => r.group === 'agent'), { wait: m.connectors === 'reading' }));
    ensureLockTips();
    const legend = el('div', 'cx-legend');
    const li = (glyph, text) => { const i = el('span', 'li'); i.append(glyph, document.createTextNode(text)); return i; };
    if (rows.some(r => r.kind === 'connector') || m.connectors === 'reading') legend.append(li(svg(ICON.connector), t('mcp.matrix.connector')));
    if (legend.children.length) host.append(legend);
    if (focus) { const sel = focus; focus = null; host.querySelector(sel)?.focus(); }
  }
  return { render, reset: () => { ask = null; focus = null; } };
}
