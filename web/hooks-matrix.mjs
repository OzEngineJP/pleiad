// ==================== 設定 › プラグイン › Hooks: Hook × エージェントの表（ADR 0338） ====================
// docs/design-system.md「Hooks」。指示・Skills・外部 MCP と同じ一覧の部品（web/context-matrix.mjs）で、アイコンの意味だけを
// 「そのエージェントのターンで実行する」と読み替える。表の中身はサーバーが組む（hooks.matrix。core/hooks-agents.mjs）。
//   - Pleiad に登録: <data>/hooks.json の登録。追加・編集・削除はシート（web/hooks-unify-ui.mjs）
//   - エージェントの設定 › ユーザー: 各エージェントの設定の Hook（管理者・Grok Build の設定は鍵つき）。詳細は行を開く（web/hooks-card.mjs の peekHook）
//   - エージェントの設定 › 作業場所: 1 行（.claude/settings.json と .codex/hooks.json）。場所ごとの中身と「この場所で使うか」は会話の右の欄
// 押せないセル・スイッチは鍵（web/lock-tip.mjs）で、文は理由の細目（detail）ごと（hooks.matrix.tip.*）。
// ほかのエージェントへ初めて広げるときは、その場で 1 回だけ確かめ、渡すときの注意（warnings）を並べる（それでも入れられる）。
// 押した瞬間に見た目を変え、保存できなければ元へ戻して、下の固定の位置に理由を出す（work → context.saveFailed）。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { agentShortLabel } from './agent-brands.mjs';
import { MATRIX_ICON, agentChip, agentLegend, agentStrip, askBanner, lockedAgentChip, matrixSvg, rowSwitch, savedText } from './context-matrix.mjs';
import { addButton, agentLabel, eventLabel, openHookSheet, peekHook, scopeLabel } from './hooks-card.mjs';
import { originMarks } from './context-tabs.mjs';
import { openPlyHookSheet, plyPeek, reasonText, warnText } from './hooks-unify-ui.mjs';

function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
// 列の短い名前。画面の短い名前（agent-brands）は有効なエージェントの分しか届かないので、無いものは一覧が載せる短い名前（hooks.matrix の labels）、
// それも無ければ正式名（Devin CLI など）
const listLabels = new Map();
/** 一覧（hooks.matrix）が載せる列の短い名前を覚える（設定の表・会話の右の欄の両方が呼ぶ） */
export function rememberAgentLabels(labels) {
  if (labels && typeof labels === 'object') for (const [id, s] of Object.entries(labels)) if (typeof s === 'string' && s) listLabels.set(id, s);
}
/** エージェントの短い名前（確認の帯・読み上げ名・鍵の文・右の欄で同じもの） */
export const hookAgentLabel = a => agentShortLabel(a, listLabels.get(a) ?? agentLabel(a));
const short3 = hookAgentLabel;

// i18n-dynamic: hooks.matrix.tip.
/**
 * 鍵の文（セル・行のスイッチ）。理由の細目に文があればそれ、渡せない（relay）なら「{エージェント} には渡せません。{理由}」、
 * どれでもなければ共通の鍵の文（context.lockReason.*）に任せる（null を返す）
 */
export function hookTip({ reason, detail, agent, reasons } = {}) {
  const name = agent ? short3(agent) : '';
  if (detail === 'grokOwn' && reason === 'relay') return t('hooks.matrix.tip.grokOwnOther', { agent: name });
  const key = `hooks.matrix.tip.${detail}`, s = detail ? t(key, { agent: name }) : key;
  if (s !== key) return s;
  if (reason === 'relay') {
    const first = (reasons ?? []).find(r => r?.code === detail) ?? { code: detail ?? 'unsupportedAgent' };
    return t('hooks.matrix.tip.relay', { agent: name, why: reasonText(first) });
  }
  return null;
}

/** 行の名前（Antigravity の名前つきの定義は名前、ほかはコマンド） */
// backend-allow: 名前つきの定義を持つのは Antigravity だけ（hooks-card と同じ）
export const hookRowName = r => r.kind === 'ws' ? t('hooks.matrix.wsRow') : (r.name && r.agent === 'antigravity' ? r.name : r.command || r.name || r.event || r.key);
/** 行の下の段: イベント · matcher */
export function hookRowSub(r) {
  if (r.kind === 'ws') return t('hooks.matrix.wsSub');
  const bits = [eventLabel(r.event)];
  if (r.matcher !== null && r.matcher !== undefined && r.matcher !== '') bits.push(t('hooks.row.matcher', { matcher: r.matcher }));
  return bits.join(' · ');
}

/**
 * セルの見え方（agentChip の state と、鍵の文を付けたセル）。行が入っていなければ（どのエージェントでも動かない）押せるセルは隠す（指示・Skills と同じ）。
 * 押せないエージェント（mode: none。管理者の Hook のほかのエージェント）は短い線
 */
export function hookCellView(row, agent) {
  const cell = row.cells?.[agent];
  if (!cell || cell.mode === 'none') return { state: 'na', cell: null };
  if (cell.mode === 'locked') {
    const on = cell.state === 'on';
    if (!on && !row.on) return { state: 'hide', cell: null };
    const tip = hookTip({ reason: cell.reason, detail: cell.detail, agent, reasons: cell.reasons });
    return { state: on ? 'lockon' : 'lockoff', cell: { ...cell, on, locked: true, ...(tip ? { tip } : {}) } };
  }
  if (!row.on) return { state: 'hide', cell: null };
  // この場所にこのエージェントの作業場所の Hook が無い（core の empty。場所を指定した一覧だけ）。押しても今の場所では何も変わらないが、ほかの場所では効くので押せるまま
  if (cell.empty) return { state: cell.state === 'on' ? 'on' : 'off', cell: { ...cell, note: t('hooks.matrix.emptyHere') } };
  return { state: cell.state === 'on' ? 'on' : 'off', cell };
}

/** 押したときの見た目だけを先に変える（保存できなければ元の表へ戻す） */
function applyCellLocal(row, agent, on) {
  const c = row.cells[agent];
  if (!c || c.mode !== 'toggle') return;
  c.state = on ? 'on' : 'off';
  delete c.needsConfirm;
  row.on = Object.values(row.cells).some(x => x.state === 'on');
}
function applyRowLocal(row, on) {
  for (const c of Object.values(row.cells)) if (c.mode === 'toggle' && !(on && c.needsConfirm)) c.state = on ? 'on' : 'off';
  if (on && !Object.values(row.cells).some(x => x.state === 'on')) {
    // 覚えている選択が無い: 元のエージェント（登録は形のエージェント）で動かす見込み。正しい形は読み直しで入る
    const own = row.cells[row.agent];
    if (own?.mode === 'toggle') own.state = 'on';
  }
  row.on = Object.values(row.cells).some(x => x.state === 'on');
}

export function createHooksMatrix({ cmd, work, saved, failed, status, opened = new Set(), onCount }) {
  const root = el('section', 'cx-card hk-card');
  root.dataset.kind = 'hooks';
  let grid = null, ply = null, scan = null, loading = false, loadError = null, home = '';
  let ask = null, focus = null, ticket = 0;
  const confirmed = new Set();
  const short = p => (home && String(p ?? '').toLowerCase().replace(/\\/g, '/').startsWith(home.toLowerCase().replace(/\\/g, '/')) ? `~${String(p).slice(home.length)}` : String(p ?? ''));

  /** 一覧（hooks.matrix）・登録（hooks.list）・定義の詳細（hooks.scan）を読む。Codex の信頼状態（app-server を待つ）は後から重ねる */
  async function load() {
    const mine = ++ticket;
    loading = true; render();
    try {
      const [m, view, sc] = await Promise.all([cmd('hooksMatrix', { trust: false }), cmd('plyHooks', {}).catch(() => null), cmd('scanHooks', { scope: 'user' }).catch(() => null)]);
      if (mine !== ticket) return;
      grid = m; ply = view; scan = sc; home = sc?.home ?? home; loadError = null;
      rememberAgentLabels(m?.labels);
      forgetGone();
    } catch (e) {
      if (mine !== ticket) return;
      grid = null; loadError = e;
    } finally { if (mine === ticket) loading = false; }
    render();
    if (!grid?.trustPending && !scan?.trustPending) return;
    const [m2, sc2] = await Promise.all([grid?.trustPending ? cmd('hooksMatrix', { trust: true }).catch(() => null) : null,
      scan?.trustPending ? cmd('scanHooks', { scope: 'user', trust: true }).catch(() => null) : null]);
    if (mine !== ticket) return;
    if (m2) { grid = m2; rememberAgentLabels(m2.labels); forgetGone(); }
    if (sc2) scan = sc2;
    render();
  }
  const reload = () => load();
  /** 広げる前の確かめ済み（confirmed）は、読み直した一覧に無い行の分を捨てる。行を消して作り直したら、もう一度聞く */
  function forgetGone() {
    if (!Array.isArray(grid?.rows) || grid.unreadable) return;
    const keys = new Set(grid.rows.map(r => r.key));
    for (const c of [...confirmed]) if (!keys.has(c.slice(0, c.lastIndexOf(':')))) confirmed.delete(c);
  }

  /** タブの件数: どれかのエージェントで実行する Hook の数（作業場所のまとめの行は Hook ではないので数えない）。読めないときは隠す */
  function count() {
    onCount?.(Array.isArray(grid?.rows) && !grid.unreadable ? grid.rows.filter(r => r.on && r.kind !== 'ws').length : null);
  }

  /** 押した操作を送る。押す前の表を取っておき、失敗したら戻して描き直し、理由は work が下の固定の位置に出す */
  function mutate(local, remote) {
    if (!grid) return;
    const prev = structuredClone(grid);
    local(grid);
    render();
    work(async () => {
      try { await remote(grid.revision ?? prev.revision); }
      catch (e) { grid = prev; render(); reload(); throw e; }
      await load();
      saved(savedText(false));
    });
  }
  const findRow = key => grid?.rows?.find(r => r.key === key) ?? null;

  function toggleCell(row, agent, fk) {
    const cell = row.cells[agent];
    if (!cell || cell.mode !== 'toggle') return;
    const on = cell.state !== 'on';
    if (on && cell.needsConfirm && !confirmed.has(`${row.key}:${agent}`)) {
      ask = { key: row.key, agent, fk };
      focus = '.cx-ask .btn-primary';
      render();
      return;
    }
    if (ask?.key === row.key) ask = null;
    const staysOn = on || Object.entries(row.cells).some(([a, c]) => a !== agent && c.state === 'on');
    focus = `[data-cx-fk="${CSS.escape(staysOn ? fk : `sw:${row.key}`)}"]`;
    mutate(g => { const r = g.rows.find(x => x.key === row.key); if (r) applyCellLocal(r, agent, on); },
      revision => cmd('setHookAgent', { key: row.key, agent, on, revision }));
  }
  function toggleRow(row) {
    const on = !row.on;
    if (ask?.key === row.key) ask = null;
    focus = `[data-cx-fk="${CSS.escape(`sw:${row.key}`)}"]`;
    mutate(g => { const r = g.rows.find(x => x.key === row.key); if (r) applyRowLocal(r, on); },
      revision => cmd('setHookRow', { key: row.key, on, revision }));
  }

  function askEl(row) {
    const a = ask;
    const to = short3(a.agent);
    const from = row.kind === 'reg' ? 'Pleiad' : short3(row.agent);
    const name = hookRowName(row);
    const warnings = row.cells[a.agent]?.warnings ?? [];
    const box = askBanner({
      ariaLabel: t('hooks.matrix.askAria', { name, to }),
      text: t('hooks.matrix.ask', { from, to }),
      cancelLabel: t('context.matrix.cancel'),
      confirmLabel: t('hooks.matrix.confirm'),
      onCancel: () => { focus = `[data-cx-fk="${CSS.escape(a.fk)}"]`; ask = null; render(); },
      onConfirm: () => {
        confirmed.add(`${a.key}:${a.agent}`);
        ask = null;
        const r = findRow(a.key);
        if (r) toggleCell(r, a.agent, a.fk);
      },
    });
    if (warnings.length) {
      // 渡すときの注意（動きが少し違う所）。入れるのは止めない
      const list = el('ul', 'hk-warns');
      for (const w of warnings) list.append(el('li', null, warnText(w)));
      box.querySelector('.q')?.after(list);
      box.classList.add('has-warns');
    }
    return box;
  }

  function strip(row, name) {
    const solo = row.group === 'admin' || Object.values(row.cells).filter(c => c.mode !== 'none').length === 1;
    return agentStrip({
      agents: grid.agents,
      solo,
      labelText: t('hooks.matrix.stripAria', { name }),
      renderCell: a => {
        const v = hookCellView(row, a);
        if (v.state === 'na' || v.state === 'hide') return agentChip({ agent: a, state: v.state, name });
        const fk = `ag:${row.key}:${a}`;
        const label = short3(a);
        const ariaLabel = t('hooks.matrix.runAria', { agent: label, name });
        if (v.state === 'lockon' || v.state === 'lockoff') return lockedAgentChip(a, v.cell, name, { ariaLabel, key: fk, keyAttr: 'cxFk', agentLabel: label });
        const note = v.cell?.note;
        return agentChip({ agent: a, state: v.state, cell: v.cell, name, agentLabel: label, key: fk, keyAttr: 'cxFk', onToggle: () => toggleCell(row, a, fk),
          ariaLabel: note ? t('hooks.matrix.noteAria', { label: ariaLabel, note }) : ariaLabel, title: note ? `${label}: ${note}` : label });
      },
    });
  }

  /** 行の詳細の「事実」: 書いてある場所・動いているエージェント・変えられない理由（行ごとの事実から作る） */
  function facts(row) {
    const box = el('div', 'fm facts hk-facts');
    const put = (k, v) => { if (v) box.append(el('span', 'k', k), el('span', 'v', v)); };
    put(t('hooks.matrix.fact.where'), row.kind === 'reg' ? 'Pleiad（hooks.json）' : row.path ? short(row.path) : '');
    const runs = grid.agents.filter(a => row.cells[a]?.state === 'on').map(short3);
    put(t('hooks.matrix.fact.runs'), runs.length ? runs.join('、') : t('hooks.matrix.fact.none'));
    const locks = [];
    if (row.switchLock) { const s = hookTip(row.switchLock); if (s) locks.push(s); }
    for (const a of grid.agents) {
      const v = hookCellView({ ...row, on: true }, a);
      if (v.cell?.tip && !locks.includes(v.cell.tip)) locks.push(v.cell.tip);
    }
    put(t('hooks.matrix.fact.locked'), locks.join(' / '));
    return box;
  }
  const sheetCtx = () => ({ cmd, scan, short, onSaved: async () => { saved(t('hooks.saved')); await reload(); } });
  /** Antigravity の enabled（定義の名前ごと）を元のファイルへ書く */
  function agyToggle(e, enabled) {
    const file = scan?.files?.find(f => f.path === e.path);
    return work(async () => {
      const r = await cmd('saveHooks', { items: [{ op: 'enable', agent: e.agent, scope: e.scope, base: e.base, file: e.path, revision: file?.revision, loc: { name: e.name }, enabled }] });
      if (!r.results[0].ok) { await reload(); throw new Error(r.results[0].error); }
      saved(t('hooks.saved')); await reload();
    });
  }
  function details(row) {
    const box = el('div', 'hk-details');
    box.append(facts(row));
    if (row.kind === 'reg') {
      const h = ply?.entries?.find(x => x.id === row.key);
      if (h) box.append(plyPeek(h, { cmd, work, onChanged: async (_view, didSave) => { if (didSave) saved(t('hooks.saved')); await reload(); } }));
      return box;
    }
    const entries = (row.scanIds ?? []).map(id => scan?.entries?.find(e => e.id === id)).filter(Boolean);
    for (const e of entries) {
      box.append(peekHook(e, { short,
        onEdit: x => openHookSheet(sheetCtx(), { entry: x }),
        onDelete: x => openHookSheet(sheetCtx(), { entry: x, remove: true }),
        onToggle: e.agent === 'antigravity' && !e.readOnly ? agyToggle : null })); // backend-allow: 有効のスイッチを持つのは Antigravity の定義だけ（hooks-card と同じ）
    }
    if (!entries.length && row.command) box.append(el('p', 'cx-sub hk-cmd', row.command));
    return box;
  }

  function hookRow(list, row) {
    const name = hookRowName(row);
    const r = el('div', 'cx-row ag' + (row.on ? '' : ' off'));
    r.dataset.key = row.key;
    let lead;
    if (row.kind === 'ws') { lead = el('span', 'cx-ic'); lead.setAttribute('aria-hidden', 'true'); lead.append(matrixSvg(MATRIX_ICON.folder)); }
    else lead = el('span', 'cx-lead0');
    r.append(lead);
    const body = el('span', 't');
    const nl = el('span', 'nl');
    nl.append(el('span', 'nm' + (row.kind === 'ws' ? '' : ' mono'), name));
    if (row.group === 'admin') nl.append(el('span', 'cbadge', t('hooks.scope.managed')));
    else if (['plugin', 'skill'].includes(row.scope)) nl.append(el('span', 'cbadge', row.scope === 'plugin' && row.plugin ? row.plugin : scopeLabel(row)));
    if (row.copyOf) { const from = grid.rows.find(x => x.key === row.copyOf)?.agent; if (from) nl.append(el('span', 'cbadge', t('hooks.row.copied', { agent: short3(from) }))); }
    if (row.kind !== 'reg' && row.kind !== 'ws' && row.agent) { const from = originMarks([row.agent]); if (from) nl.append(from); }
    body.append(nl, el('span', 'p', hookRowSub(row)));
    if (row.kind === 'ws') r.append(body);
    else {
      const open = button('', 'cx-open');
      open.dataset.cxFk = `open:${row.key}`;
      open.setAttribute('aria-expanded', String(opened.has(`hook:${row.key}`)));
      open.append(body);
      open.onclick = () => { const k = `hook:${row.key}`; if (opened.has(k)) opened.delete(k); else opened.add(k); focus = `[data-cx-fk="${CSS.escape(`open:${row.key}`)}"]`; render(); };
      r.append(open);
    }
    const sw = rowSwitch({
      role: 'switch',
      checked: row.on,
      labelText: t('hooks.matrix.rowAria', { name }),
      disabledReason: row.switchable ? null : (hookTip(row.switchLock ?? {}) ?? t('context.lockReason.own', { agent: short3(row.switchLock?.agent ?? row.agent) })),
      key: `sw:${row.key}`,
      keyAttr: 'cxFk',
      onToggle: () => toggleRow(row),
    });
    r.append(sw, strip(row, name));
    list.append(r);
    if (ask?.key === row.key) list.append(askEl(row));
    if (row.kind !== 'ws' && opened.has(`hook:${row.key}`)) list.append(details(row));
  }

  const tierHead = (name, sub) => { const h = el('div', 'cx-tierh'); h.append(el('span', 'n', name)); if (sub) h.append(el('span', null, sub)); return h; };
  const listOf = label => { const l = el('div', 'cx-list'); l.setAttribute('role', 'group'); l.setAttribute('aria-label', label); return l; };

  /** 読めなかったファイル・全体の停止。0 件と取り違えないよう一覧の上に出す */
  function fileNotes(host) {
    for (const f of (scan?.files ?? []).filter(f => f.status === 'error' || f.partial)) {
      const n = el('p', 'cx-note');
      n.append(el('span', 'cx-strong', f.status === 'error' ? t('hooks.file.error', { agent: agentLabel(f.agent) }) : t('hooks.file.partial', { agent: agentLabel(f.agent) })), ` ${short(f.path)} · ${f.error ?? ''}`);
      host.append(n);
    }
    // backend-allow: 全部オフの注記の文はファイルの種類ごと（Claude の disableAllHooks と Codex の hooks の止め方）
    for (const f of (scan?.files ?? []).filter(f => f.allOff)) host.append(el('p', 'cx-note', t(f.agent === 'claude' ? 'hooks.file.allOffClaude' : 'hooks.file.allOffCodex', { path: short(f.path) })));
  }

  /** 読めない hooks-agents.json・壊れた hooks.json: 理由と、ここから退避して直す操作（指示・Skills の表と同じ置き方と文） */
  function repairNotice(message) {
    const n = el('p', 'cx-note hk-broken');
    n.setAttribute('role', 'alert');
    n.append(el('span', null, message), ' ');
    const fix = button(t('context.repairDocAgents'), 'btn', async () => {
      fix.disabled = true;
      try {
        const r = await cmd('repairPlyHooks', {});
        await load();
        const file = r?.agentsBackup ?? r?.backup;
        saved(file ? t('context.repairedDocAgents', { file: short(file) }) : t('hooks.matrix.repaired'));
      } catch (e) {
        fix.disabled = false;
        failed(t('context.saveFailed', { error: e.message }));
      }
    });
    n.append(fix);
    return n;
  }

  function render() {
    const active = document.activeElement;
    const fk = active && root.contains(active) ? active.dataset?.cxFk : '';
    root.replaceChildren();
    count();
    const head = el('div', 'cx-khead');
    const title = el('h4', null, 'Hooks'); title.id = 'cxKind-hooks';
    root.setAttribute('aria-labelledby', title.id);
    head.append(title, el('span', 'cx-sub hk-lead', t('hooks.lead')));
    if (loading && grid) { const label = el('span', 'pending-label'); label.append(runMark(t('pending.searching')), t('pending.searching')); head.append(label); }
    root.append(head);
    if (!grid) {
      if (loadError) {
        const repairable = ['UNREADABLE', 'HOOKS_BROKEN'].includes(loadError.code);
        root.append(repairable ? repairNotice(loadError.message) : el('p', 'cx-note', t('hooks.matrix.loadFailed', { error: loadError.message })));
      } else if (loading) {
        const p = el('p', 'cx-empty'); p.append(runMark(t('context.searching')), document.createTextNode(' ' + t('context.searchingDots')));
        root.append(p);
      }
      return;
    }
    if (grid.unreadable) { root.append(repairNotice(grid.error)); return; }
    if (!grid.adopted) {
      root.append(el('p', 'cx-note hk-adopt', t('hooks.matrix.adopted')));
      if (grid.rows.some(r => r.kind === 'reg' && !r.on && r.enabled !== false)) root.append(el('p', 'cx-note hk-adopt-off', t('hooks.matrix.adoptedOff')));
    }
    if (grid.orphans?.length) root.append(el('p', 'cx-note', t('hooks.matrix.orphans', { n: grid.orphans.length })));

    // Pleiad に登録
    const reg = el('div', 'cx-block');
    const sec1 = el('div', 'cx-sec'); sec1.append(el('span', 'n', t('hooks.matrix.section')));
    reg.append(sec1);
    const regList = listOf(t('hooks.matrix.regAria'));
    const regRows = grid.rows.filter(r => r.group === 'ply');
    for (const row of regRows) hookRow(regList, row);
    if (!regRows.length) regList.append(el('p', 'cx-empty', t('hooks.matrix.regEmpty')));
    regList.append(addButton(t('hooks.add'), () => openPlyHookSheet({ cmd, onSaved: async () => { saved(t('hooks.saved')); await reload(); } })));
    reg.append(regList);
    root.append(reg);

    // エージェントの設定
    const own = el('div', 'cx-block');
    const sec2 = el('div', 'cx-sec'); sec2.append(el('span', 'n', t('context.matrix.agentSettings')));
    own.append(sec2);
    const user = el('div', 'cx-tier');
    user.append(tierHead(t('context.tier.user')));
    fileNotes(user);
    const userList = listOf(t('hooks.matrix.userAria'));
    for (const row of grid.rows.filter(r => r.group === 'own' || r.group === 'admin')) hookRow(userList, row);
    if (scan) userList.append(addButton(t('hooks.matrix.addNative'), () => openHookSheet(sheetCtx(), {})));
    user.append(userList);
    own.append(user);
    const ws = grid.rows.find(r => r.kind === 'ws');
    if (ws) {
      const place = el('div', 'cx-tier');
      place.append(tierHead(t('context.tier.place'), t('context.tier.placeSub')));
      const placeList = listOf(t('hooks.matrix.placeAria'));
      hookRow(placeList, ws);
      place.append(placeList);
      own.append(place);
    }
    root.append(own);
    root.append(agentLegend(grid.agents));

    const pending = focus;
    focus = null;
    if (pending) root.querySelector(pending)?.focus({ preventScroll: true });
    else if (fk) root.querySelector(`[data-cx-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
  }
  render();
  return { root, load, reload, get grid() { return grid; } };
}
