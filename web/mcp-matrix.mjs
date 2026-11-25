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
// フォルダー別の設定（ADR 0348）: ctx.place（null = 全体の設定）へ保存する。行の印（「● 変更」＋「戻す」・受け継いだ場所・
// 全体の設定の「website で別の設定」）は ctx.rowMarks(row.key) が返す（web/context.mjs。4 つのタブで同じ印）。
// 節は「スキャン場所」（ctx.scanSection）→「ユーザースコープの外部 MCP」→「Pleiad に登録」の順。足すのは全体の設定でだけ。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { agentName } from './agent-brands.mjs';
import { brandMark as mark } from './context-tabs.mjs';
import { ensureLockTips, lockReasonText, joinLockReasons } from './lock-tip.mjs';
import { MATRIX_ICON as ICON, matrixSvg as svg, matrixButton as button, matrixLockGlyph, lockedAgentChip, agentLegend, wholeSwitch } from './context-matrix.mjs';

export { lockedAgentChip };

const label = agentName;
const names = ids => ids.map(label).join('・');

/** 雲の凡例「claude.ai のコネクター」を出すか。上の表にコネクターの行があるか、読み取り中のときだけ。
 *  アカウントの欄（claude.ai のコネクター・アカウントごと）だけでは出さない（欄の見出しと同じことになる） */
export function connectorLegendShown(m, rows) {
  return rows.some(r => r.kind === 'connector') || m.connectors === 'reading';
}

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
      for (const { agent, on } of changes) await ctx.cmd('setMcpAgent', { name: row.key, agent, on, place: ctx.place ?? null, cwd: ctx.cwd });
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
      const res = await ctx.cmd('setMcpRow', { name: row.key, on, place: ctx.place ?? null, cwd: ctx.cwd });
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
    const marks = ctx.rowMarks?.(row.key, row.name) ?? null;
    if (marks?.marks?.length) line.append(...marks.marks);
    body.append(line);
    if (marks?.sub) body.append(el('span', 'p ovs', marks.sub));
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
    n.append(head);
    if (marks?.revert) n.append(marks.revert);
    n.append(sw, ags);
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
    const sec = ctx.sectionHead ? ctx.sectionHead(title) : (() => { const x = el('div', 'cx-sec'); x.append(el('span', 'n', title)); return x; })();
    const list = el('div', 'cx-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', title);
    if (ctx.readOnly) list.classList.add('ro');
    for (const r of rows) rowEl(ctx, r, list);
    if (!rows.length && !wait && !add) list.append(el('p', 'cx-empty', t('context.scope.sec.nothing')));
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

  // ---- 登録した Claude アカウントごとの claude.ai のコネクター（ADR 0340 段 3。docs/design-system.md「登録した Claude アカウントごとの claude.ai のコネクター」）
  // コネクターの切り替えに確認の画面は置かない。機械で確かめられる検査に合わなければ、
  // オンにする向きだけを鍵で止めて理由を出す（オンのまま止まっているときは、オフにする向きは押せる。会話を止めたままにしない）。
  // コネクターの一覧は上の「エージェントの設定」に並べず、行の下の畳みにだけ出す（名前と状態だけ。個別のオフは置かない）
  const acctBusy = new Set();   // スイッチ・読み直しの最中のアカウント
  // i18n-dynamic: mcp.accounts.status.
  // i18n-dynamic: mcp.accounts.tip.
  const blockKey = r => r.blockKind === 'env' && r.blockScope === 'settings' ? 'settings' : (r.blockKind ?? 'login');
  /** 行の状態: off（使える・オフ）/ on（使える・オン）/ nologin / blocked（止める条件。オンのままのこともある） */
  function acctState(r) {
    if (!r.usageLogin) return 'nologin';
    return r.status === 'ok' ? (r.enabled ? 'on' : 'off') : 'blocked';
  }
  function acctStatusText(r) {
    const st = acctState(r);
    if (st === 'nologin') return t('mcp.accounts.status.nologin');
    if (st === 'off') return t('mcp.accounts.status.off');
    if (st === 'blocked') {
      const why = t(`mcp.accounts.status.${blockKey(r)}`);
      return r.enabled ? t('mcp.accounts.status.stopped', { why }) : t('mcp.accounts.status.unusable', { why });
    }
    if (!Array.isArray(r.connectors)) return r.readFailed && !r.reading && !acctBusy.has(r.id) ? t('mcp.accounts.status.readFailed') : t('mcp.accounts.status.reading');
    const n = r.connectors.length, auth = (r.needsAuth ?? []).length;
    if (!n) return t('mcp.accounts.status.none');
    return auth ? t('mcp.accounts.status.onAuth', { n: n - auth, auth }) : t('mcp.accounts.status.on', { n });
  }
  /** オンにする向きを止める理由（鍵の上の文）。止めていなければ null */
  function acctLockReason(r) {
    const st = acctState(r);
    if (st === 'nologin') return t('mcp.accounts.tip.nologin', { name: r.name });
    if (st !== 'blocked' || r.enabled) return null;
    const k = blockKey(r);
    // 版・履歴の置き場は、サーバーの文（版の番号・指定の名前を含む）をそのまま出す
    return ['version', 'history', 'profile'].includes(k) && r.blockMessage ? r.blockMessage : t(`mcp.accounts.tip.${k}`, { name: r.name });
  }
  const acctSel = (r, part) => `.cx-row[data-acct="${CSS.escape(r.id)}"] ${part}`;
  async function acctRun(ctx, r, part, run) {
    if (acctBusy.has(r.id)) return;
    acctBusy.add(r.id);
    focus = acctSel(r, part);
    ctx.rerender();
    try {
      await ctx.work(async () => {
        try { await run(); }
        finally { acctBusy.delete(r.id); focus = acctSel(r, part); await ctx.reloadMatrix().catch(() => {}); }
      });
    } catch { /* work が誤りを出す */ }
  }
  function acctToggle(ctx, r) {
    const on = !r.enabled;
    if (!acctBusy.has(r.id)) r.enabled = on;   // 先に見た目を変える（失敗したら読み直しで戻る）
    return acctRun(ctx, r, '.cx-acct-toggle', () => ctx.cmd('invoke', { op: 'accounts.setConnectors', args: { id: r.id, enabled: on, cwd: ctx.cwd } }));
  }
  function acctRefresh(ctx, r) {
    return acctRun(ctx, r, '.cx-act', () => ctx.cmd('invoke', { op: 'accounts.refreshConnectors', args: { id: r.id, cwd: ctx.cwd } }));
  }
  function acctAction(ctx, r) {
    const st = acctState(r), k = st === 'blocked' ? blockKey(r) : null;
    const open = o => ctx.openAccount?.(o);
    let b = null;
    if (st === 'nologin') { b = button('btn lnk cx-act', t('mcp.accounts.login')); b.onclick = () => open({ usageLogin: r.id }); }
    else if (['login', 'ownDirLogin', 'keychainAuth'].includes(k)) { b = button('btn lnk cx-act', t('mcp.accounts.relogin')); b.onclick = () => open({ usageLogin: r.id }); }
    else if (st === 'on') {
      b = button('btn cx-act', t('mcp.accounts.reload'));
      b.setAttribute('aria-label', t('mcp.accounts.reloadAria', { name: r.name }));
      if (acctBusy.has(r.id) || r.reading) b.setAttribute('aria-disabled', 'true');
      b.onclick = () => { if (b.getAttribute('aria-disabled') !== 'true') acctRefresh(ctx, r); };
      return b;
    }
    if (b && !ctx.openAccount) return null;   // アカウントの面を開けない呼び手
    if (b) b.setAttribute('aria-label', `${b.textContent}（${r.name}）`);
    return b;
  }
  function acctSwitch(ctx, r) {
    const sw = button('cx-sw cx-acct-toggle');
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(Boolean(r.enabled)));
    const name = t('mcp.accounts.switchAria', { name: r.name });
    const reason = acctLockReason(r);
    if (reason) {
      ensureLockTips();
      sw.setAttribute('aria-disabled', 'true');
      sw.dataset.tip = reason;
      sw.setAttribute('aria-label', `${name}（${reason}）`);
      const lk = matrixLockGlyph(); lk.setAttribute('aria-hidden', 'true'); sw.append(lk);
      return sw;
    }
    sw.setAttribute('aria-label', name);
    if (acctBusy.has(r.id)) sw.setAttribute('aria-busy', 'true');
    sw.onclick = () => acctToggle(ctx, r);
    return sw;
  }
  function acctPeek(r) {
    const box = el('div', 'cx-peek cx-acct-peek');
    box.setAttribute('role', 'list');
    box.setAttribute('aria-label', t('mcp.accounts.peekAria', { name: r.name }));
    const auth = new Set(r.needsAuth ?? []);
    for (const nm of r.connectors) {
      const off = auth.has(nm);
      const it = el('div', `cx-peek-item${off ? ' off' : ''}`); it.setAttribute('role', 'listitem');
      it.append(el('span', `cx-dot ${off ? 'off' : 'on'}`), el('span', 'nm', nm), el('span', 'st', off ? t('mcp.accounts.item.needsAuth') : t('mcp.accounts.item.connected')));
      box.append(it);
    }
    return box;
  }
  function acctRow(ctx, r, list) {
    const st = acctState(r);
    const n = el('div', `cx-row acct${st === 'on' ? '' : ' off'}`);
    n.dataset.acct = r.id;
    const ic = el('span', 'cx-ic'); ic.dataset.kind = 'connector'; ic.title = t('mcp.matrix.connector'); ic.append(svg(ICON.connector));
    const body = el('span', 't');
    const line = el('span', 'nl'); line.append(el('span', 'nm', r.name));
    body.append(line, el('span', 'p', acctStatusText(r)));
    // 更新のあとの準備で、専用フォルダーから共有へ移した・名前が重なって退避した項目（ADR 0350。退避は 30 日後に消える）
    if (r.moved?.shared?.length) body.append(el('span', 'p', t('mcp.accounts.movedShared', { entries: r.moved.shared.join(', ') })));
    if (r.moved?.archived?.length) body.append(el('span', 'p', t('mcp.accounts.movedArchived', { entries: r.moved.archived.join(', ') })));
    const key = `acct:${r.id}`;
    const foldable = st === 'on' && Array.isArray(r.connectors) && r.connectors.length > 0;
    let head;
    if (foldable) {
      head = button('cx-open');
      head.setAttribute('aria-expanded', String(ctx.opened.has(key)));
      head.append(ic, body);
      head.onclick = () => { if (ctx.opened.has(key)) ctx.opened.delete(key); else ctx.opened.add(key); focus = acctSel(r, '.cx-open'); ctx.rerender(); };
    } else { head = el('span', 'cx-open'); head.append(ic, body); }
    const act = acctAction(ctx, r);
    n.append(head);
    if (act) n.append(act);
    n.append(acctSwitch(ctx, r));
    list.append(n);
    if (foldable && ctx.opened.has(key)) list.append(acctPeek(r));
  }
  function accountGroup(ctx, rows) {
    const title = t('mcp.accounts.group');
    const block = el('div', 'cx-block cx-acct-block');
    const sec = el('div', 'cx-sec'); sec.append(el('span', 'n', title));
    const list = el('div', 'cx-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', title);
    for (const r of rows) acctRow(ctx, r, list);
    block.append(sec, list);
    return block;
  }

  /** host（種類のカード）へ、ロゴと名前の対応・2 つの組・凡例を描く。ログインの詳細設定は呼び出し側が続ける */
  function render(host, ctx) {
    const m = ctx.matrix;
    if (!m || !ctx.scan) { onCount?.(null); host.append(ctx.loading()); return; }
    const legendNames = agentLegend(m.agents);
    host.append(legendNames);
    if (ctx.scanSection) host.append(ctx.scanSection());
    // 同じサービスのコネクターが使われている間は、プラグインの MCP は一覧に出ない（コネクターを止めると現れる。Claude Code の動き）
    const lower = s => String(s ?? '').toLowerCase();
    const connectorOn = row => m.rows.some(c => c.kind === 'connector' && c.cells.claude?.state === 'on' && [lower(row.name), lower(row.plugin)].includes(lower(c.name)));
    const rows = m.rows.filter(r => r.kind !== 'plugin' || !connectorOn(r));
    onCount?.(rows.length);
    // ユーザースコープ（エージェントの設定）→ Pleiad に登録。登録（足す）は全体の設定でだけ（Pleiad の登録はすべての場所に共通）
    host.append(group(ctx, t('context.scope.sec.userMcp'), rows.filter(r => r.group === 'agent'), { wait: m.connectors === 'reading' }));
    host.append(group(ctx, t('context.scope.sec.plyRegistered'), rows.filter(r => r.group === 'ply'), { add: !ctx.place }));
    const accts = Array.isArray(m.connectorAccounts) ? m.connectorAccounts : [];
    if (accts.length) host.append(accountGroup(ctx, accts));
    ensureLockTips();
    const legend = el('div', 'cx-legend');
    const li = (glyph, text) => { const i = el('span', 'li'); i.append(glyph, document.createTextNode(text)); return i; };
    if (connectorLegendShown(m, rows)) legend.append(li(svg(ICON.connector), t('mcp.matrix.connector')));
    if (legend.children.length) host.append(legend);
    if (focus) { const sel = focus; focus = null; host.querySelector(sel)?.focus(); }
  }
  return { render, reset: () => { ask = null; focus = null; } };
}
