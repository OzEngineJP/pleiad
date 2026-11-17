// ==================== 設定 › プラグイン › 外部 MCP の一覧（名前 × エージェント。docs/design-system.md「外部 MCP」・ADR 0327） ====================
// 行ごとに「全体のスイッチ」と、エージェントごとのアイコンを並べる。担当の 2 択（エージェントに任せる／Pleiad がそろえる）は無い。
//   - アイコンを押す = その名前をそのエージェントで使う／使わない（core/ops/context.mjs の context.setMcpAgent）。外すときは確かめない
//   - 自分の設定に持っていないエージェントのアイコンを入れる（= 他のエージェントの設定の MCP を広げる）ときだけ、名前ごとに 1 回その場で確かめる
//   - Pleiad から止められないエージェント（鍵）は押せない
//   - 行のスイッチ（ToBe-A′）: 押すと鍵の無いオンをまとめてオフにする（鍵つきのオンは残り、「一部オン」＋小さな鍵）。もう一度押すとオフにする前の組へ戻す。
//     サーバーの 1 回の保存（context.setMcpRow）で行い、途中まで保存した状態を作らない。戻し先の記録は core/context-mcp-was.mjs
//   - claude.ai のコネクター・プラグインの MCP は Claude にだけつながるので、Claude のアイコンだけを押せる
// どのアイコンが on か・押せるかは、サーバーが決めた行（core/context-mcp-matrix.mjs の buildMcpMatrix）をそのまま描く。
// 行の詳細（編集・名前の変更・ログイン・削除・取り込み）は web/mcp-config.mjs の peek。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { agentName } from './agent-brands.mjs';
import { brandMark as mark } from './context-tabs.mjs';
import { ensureLockTips, lockReasonText, joinLockReasons } from './lock-tip.mjs';
import { MATRIX_ICON as ICON, matrixSvg as svg, matrixButton as button, lockedAgentChip, agentLegend, wholeSwitch } from './context-matrix.mjs';

export { lockedAgentChip };

const label = agentName;
const names = ids => ids.map(label).join('・');

/**
 * section は createMcpSection() の戻り（peek・authNote を使う）。
 * 戻り: { render(host, ctx) }。ctx は web/context.mjs の mcpContext() に matrix・reloadMatrix を足したもの
 */
export function createMcpMatrix({ section, onCount }) {
  const confirmed = new Set();    // 広げる確認を済ませた名前（名前ごとに 1 回）
  let ask = null;                 // { key, agent }
  let focus = null;               // 描き直した後に focus を戻す先

  const calledOf = row => row.kind === 'plugin' ? t('mcp.matrix.pluginCalled', { plugin: row.plugin, name: row.name })
    : row.kind === 'connector' ? t('mcp.matrix.connectorCalled', { name: row.name }) : row.name;
  const toggles = (m, row) => m.agents.filter(a => row.cells[a].mode === 'toggle');
  // 行のスイッチは指示・Skills・Hooks の表と同じ規則（ADR 0337 §決定 4 の 2026-11-17 改訂・ToBe-A′）。
  // 数えるのは鍵の無いマスと鍵つきでオンのマス。押すと、鍵の無いオンをまとめてオフにする（鍵つきのオンは残る）。
  // 残っていなければ、オフにする前の組（無ければ既定）へ戻す。戻す先も無い行（鍵つきのオンだけなど）は押せない
  // 行の集計はサーバーの行（core/context-mcp-matrix.mjs の mcpRowMeta）が持つ。押した直後の見た目だけ、ここでセルから数え直す（保存の後に読み直す）
  const lockedOn = (m, row) => m.agents.filter(a => row.cells[a].mode === 'locked' && row.cells[a].state === 'on');
  function viewOf(m, row) {
    const unl = toggles(m, row);
    const unlOn = unl.filter(a => row.cells[a].state === 'on');
    const lkOn = lockedOn(m, row);
    const n = unlOn.length + lkOn.length;
    const changeableOn = unlOn.length > 0;
    const restore = changeableOn ? null : (row.rowRestore ?? null);
    return { on: n > 0, mixed: n > 0 && n < unl.length + lkOn.length, fixed: lkOn.length > 0, lkOn, changeableOn, restore, locked: !changeableOn && restore === null };
  }
  /** 変更を画面へ先に反映する。was: 最後の鍵の無いオンを外したときの、外す前の組（戻し先） */
  function applyLocal(m, row, changes, was = null) {
    for (const { agent, on } of changes) row.cells[agent].state = on ? 'on' : 'off';
    row.on = m.agents.some(a => row.cells[a].state === 'on');
    const v = viewOf(m, row);
    row.rowSwitchOn = v.on; row.rowMixed = v.mixed; row.rowFixed = v.fixed; row.rowChangeableOn = v.changeableOn; row.rowNextOn = !v.changeableOn;
    if (v.changeableOn) { row.rowRestore = null; row.restoreAgents = []; }
    else if (was?.length) { row.rowRestore = 'was'; row.restoreAgents = was; }
    row.rowLocked = !v.changeableOn && !row.rowRestore;
  }

  /** 保存して、サーバーの行を取り直す。run は保存の呼び出し（変えたエージェントの配列を返す）。保存に失敗したら元の表へ戻る */
  function save(ctx, row, run, keep = null) {
    const back = keep ? `.cx-row[data-key="${CSS.escape(row.key)}"] ${keep}` : null;
    if (back) focus = back;
    ctx.rerender();
    return ctx.work(async () => {
      let agents;
      try {
        agents = await run();
      } catch (e) {
        if (back) focus = back;
        await ctx.reloadMatrix().catch(() => {});
        throw e;
      }
      // 保存はできた。読み直しだけ失敗したときに「保存できませんでした」と言わない（レビュー S9）
      let reloadError = null;
      try { await ctx.refreshSettings(); } catch (e) { reloadError = e; }
      ctx.toast({ agents });
      if (back) focus = back;
      try { await ctx.reloadMatrix(); } catch (e) { reloadError ??= e; }
      if (reloadError) ctx.status(t('context.savedReloadFailed', { error: reloadError.message }));
    });
  }
  /** 1 つのマスを変える（保存は 1 つ） */
  function apply(ctx, row, changes, keep = null, was = null) {
    applyLocal(ctx.matrix, row, changes, was);
    return save(ctx, row, async () => {
      for (const { agent, on } of changes) await ctx.cmd('setMcpAgent', { name: row.key, agent, on, cwd: ctx.cwd });
      return changes.map(c => c.agent);
    }, keep);
  }

  function toggleCell(ctx, row, agent) {
    const on = row.cells[agent].state !== 'on';
    const spreading = on && row.group === 'agent' && row.kind === 'config' && !row.origins.includes(agent);
    if (spreading && !confirmed.has(row.key)) { ask = { key: row.key, agent }; focus = '.cx-ask .btn-primary'; ctx.rerender(); return; }
    const m = ctx.matrix;
    let keep = `.cx-ag[data-agent="${agent}"]`, was = null;
    if (!on) {
      const rest = toggles(m, row).filter(a => a !== agent && row.cells[a].state === 'on');
      if (!rest.length) {
        keep = '.cx-sw';   // 最後の 1 つを外すとアイコンが消える。focus はスイッチへ
        was = toggles(m, row).filter(a => row.cells[a].state === 'on');   // サーバーも同じく、外す前の組を覚える（行のスイッチで戻せる）
      }
    }
    return apply(ctx, row, [{ agent, on }], keep, was);
  }
  /** 行のスイッチ。サーバーの 1 回の保存（context.setMcpRow）で、鍵の無いオンをまとめてオフにする／オフにする前の組へ戻す（途中まで保存した状態を作らない） */
  function toggleAll(ctx, row) {
    const m = ctx.matrix;
    if (ask?.key === row.key) ask = null;
    const v = viewOf(m, row);
    if (v.locked) return;
    const on = !v.changeableOn;
    const changes = on
      ? (row.restoreAgents ?? []).filter(a => toggles(m, row).includes(a)).map(agent => ({ agent, on: true }))
      : toggles(m, row).filter(a => row.cells[a].state === 'on').map(agent => ({ agent, on: false }));
    applyLocal(m, row, changes, on ? null : changes.map(c => c.agent));
    return save(ctx, row, async () => {
      const res = await ctx.cmd('setMcpRow', { name: row.key, on, cwd: ctx.cwd });
      return Array.isArray(res?.changed) ? res.changed : changes.map(c => c.agent);
    }, '.cx-sw');
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
    const m = ctx.matrix, cell = row.cells[agent], on = viewOf(m, row).on;
    if (cell.mode === 'none') { const x = el('span', `cx-ag ${on ? 'na' : 'none'}`); x.setAttribute('aria-hidden', 'true'); return x; }
    if (cell.mode === 'toggle' && cell.state === 'off' && !on) { const x = el('span', 'cx-ag none'); x.setAttribute('aria-hidden', 'true'); return x; }
    if (cell.mode !== 'toggle') return lockedAgentChip(agent, cell, calledOf(row));
    const b = button(`cx-ag be-${agent}`);
    b.dataset.agent = agent;
    b.setAttribute('aria-pressed', String(cell.state === 'on'));
    b.append(mark(agent));
    b.setAttribute('aria-label', t('mcp.matrix.agentAria', { agent: label(agent), name: calledOf(row) }));
    b.title = label(agent);
    b.onclick = () => toggleCell(ctx, row, agent);
    return b;
  }

  function rowEl(ctx, row, list) {
    const m = ctx.matrix, v = viewOf(m, row), on = v.on;
    const locks =m.agents.some(a => row.cells[a].mode === 'locked' || row.cells[a].mode === 'blocked');
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

    // 鍵つきでオンのマスの理由。まとめてオフにしても残るので、鍵の上に出す（常時の文字にはしない）
    const lockedReasons = v.lkOn.map(a => lockReasonText(label(a), row.cells[a]));
    const fixedReason = joinLockReasons(lockedReasons);
    let disabledReason = null;
    if (v.locked) {
      const lockAgent = v.lkOn[0] ?? m.agents.find(a => row.cells[a].mode === 'locked' || row.cells[a].mode === 'blocked');
      disabledReason = lockAgent ? lockReasonText(label(lockAgent), row.cells[lockAgent]) : t('mcp.matrix.locked');
    }
    const sw = wholeSwitch({
      state: v.mixed ? 'mixed' : v.on ? 'true' : 'false',
      fixed: v.fixed && !v.changeableOn,
      fixedReason,
      name: calledOf(row),
      next: v.changeableOn ? 'off' : v.restore === 'was' ? 'restore' : 'on',
      disabledReason,
      onToggle: () => toggleAll(ctx, row),
    });

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
    const legendNames = agentLegend(m.agents);
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
