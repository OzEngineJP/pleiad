// ==================== 設定 › プラグイン › Hooks: Hook × エージェントの表（ADR 0338・フォルダー別の設定は ADR 0348） ====================
// docs/design-system.md「Hooks」。指示・Skills・外部 MCP と同じ一覧の部品（web/context-matrix.mjs）で、アイコンの意味だけを
// 「そのエージェントのターンで実行する」と読み替える。表の中身はサーバーが組む（hooks.matrix。core/hooks-agents.mjs）。
// 並びはほかのタブとそろえる（節の頭と印は web/context-scope-marks.mjs）:
//   - スキャン場所: 作業場所の 1 行（Git のルートから作業フォルダーまで。.claude/settings.json と .codex/hooks.json）と、
//     追加したスキャン場所ごとの Hook（row.kind: 'root'）。追加の操作は呼ぶ側（scan.addControl）
//   - ユーザースコープの Hooks: 各エージェントの設定の Hook（管理者・Grok Build の設定は鍵つき）。詳細は行を開く（web/hooks-card.mjs の peekHook）
//   - Pleiad に登録: <data>/hooks.json の登録。追加・編集・削除はシート（web/hooks-unify-ui.mjs）。追加は全体の設定のときだけ
// フォルダーの設定（scope().place）では、一覧と保存に cwd を付け、この場所で変えた行に「● 変更」と「戻す」、上の場所から受け継いだ行に
// 「website の設定」を添える。全体の設定では、別の設定にした場所を下の段に添える。フォルダーが見つからないときは読むだけ。
// 押せないセル・スイッチは鍵（web/lock-tip.mjs）で、文は理由の細目（detail）ごと（hooks.matrix.tip.*）。
// ほかのエージェントへ初めて広げるときは、その場で 1 回だけ確かめ、渡すときの注意（warnings）を並べる（それでも入れられる）。
// 押した瞬間に見た目を変え、保存できなければ元へ戻して、下の固定の位置に理由を出す（work → context.saveFailed）。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { agentName, rememberAgentNames } from './agent-brands.mjs';
import { MATRIX_ICON, agentChip, agentLegend, agentStrip, askBanner, freshAgents, lockedAgentChip, matrixSvg, savedText, wholeSwitch } from './context-matrix.mjs';
import { addButton, agentLabel, eventLabel, openHookSheet, peekHook, scopeLabel } from './hooks-card.mjs';
import { originMarks } from './context-tabs.mjs';
import { openPlyHookSheet, plyPeek, reasonText, warnText } from './hooks-unify-ui.mjs';
import { joinLockReasons } from './lock-tip.mjs';
import { elsewhereText, overrideBadge, parentLink, placeName, revertButton, sectionHead, textButton } from './context-scope-marks.mjs';

function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
// 列の短い名前は、画面の短い名前（agent-brands。有効なエージェントの分）と、表が載せる短い名前（hooks.matrix の labels。agent-brands が控える）から引く。内部の id は出さない
/** 一覧（hooks.matrix）が載せる列の短い名前を覚える（設定の表・会話の右の欄の両方が呼ぶ。doc・MCP の表と同じ控え） */
export function rememberAgentLabels(labels) { rememberAgentNames(labels); }
/** エージェントの短い名前（確認の帯・読み上げ名・鍵の文・右の欄で同じもの） */
export const hookAgentLabel = agentName;
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

/**
 * 行のスイッチの見え方を、セルの今の状態から数え直す（core/hooks-agents.mjs の matrix と同じ数え方。ADR 0337 §決定 4・2026-11-17 の改訂）。
 * 集計は、押せるマス + 鍵つきでオンのマス（鍵つきでオフ・対象外は数えない）。保存の後に読み直すので、ここは押した直後の見た目だけ
 */
function recalcRowLocal(row) {
  const cells = Object.values(row.cells);
  const toggles = cells.filter(c => c.mode === 'toggle');
  const lockedOn = cells.filter(c => c.mode !== 'toggle' && c.state === 'on');
  const onCells = cells.filter(c => c.state === 'on').length;
  row.on = onCells > 0;
  row.rowMixed = onCells > 0 && onCells < toggles.length + lockedOn.length;
  row.rowFixed = lockedOn.length > 0;
  row.rowChangeableOn = toggles.some(c => c.state === 'on');
  row.rowNextOn = !row.rowChangeableOn;
}
/** 押したときの見た目だけを先に変える（保存できなければ元の表へ戻す） */
function applyCellLocal(row, agent, on) {
  const c = row.cells[agent];
  if (!c || c.mode !== 'toggle') return;
  c.state = on ? 'on' : 'off';
  delete c.needsConfirm;
  recalcRowLocal(row);
}
/** 行のスイッチ: 切る向きは切れるオン（押せるマス）だけをまとめて切る（鍵つきでオンのマスは残す）。入れる向きは覚えた選択に戻す */
function applyRowLocal(row, on) {
  for (const c of Object.values(row.cells)) if (c.mode === 'toggle' && !(on && c.needsConfirm)) c.state = on ? 'on' : 'off';
  if (on && !Object.values(row.cells).some(x => x.state === 'on')) {
    // 覚えている選択が無い: 元のエージェント（登録は形のエージェント）で動かす見込み。正しい形は読み直しで入る
    const own = row.cells[row.agent];
    if (own?.mode === 'toggle') own.state = 'on';
  }
  row.unused = !on;
  recalcRowLocal(row);
}
/** 保存の前後で、新しい会話からだけ設定を読むエージェント（Antigravity・Grok。エージェントの記述の contextAt）のマスのオン・オフが変わったか。前後の両方にある行だけ比べる */
function hooksFreshChanged(before, after) {
  const prev = new Map((before?.rows ?? []).map(r => [r.key, r]));
  for (const row of after?.rows ?? []) {
    const p = prev.get(row.key);
    if (!p) continue;
    if (freshAgents().some(a => (p.cells?.[a]?.state === 'on') !== (row.cells?.[a]?.state === 'on'))) return true;
  }
  return false;
}

/** パスの比べ方（区切り・末尾の区切り・大文字小文字をそろえる） */
const samePath = (a, b) => {
  const n = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
};

/**
 * scope(): 設定する範囲 { place, parent, missing }（place: null は全体の設定）。onGo(path): その場所の設定へ移る（「website の設定」）。
 * scanPlaces: 追加したスキャン場所 { added() → [{ path, from, here }], addControl() → 要素, remove(path) → Promise }。
 * onCount(n, { changes }): タブの件数と、この場所の差分の数（全体なら全部の場所の合計。hooks.matrix の changes）
 */
export function createHooksMatrix({ cmd, work, saved, failed, status, opened = new Set(), onCount, scope = null, onGo = null, scan: scanPlaces = null }) {
  const root = el('section', 'cx-card hk-card');
  root.dataset.kind = 'hooks';
  let grid = null, ply = null, scan = null, loading = false, loadError = null, home = '';
  let ask = null, focus = null, ticket = 0;
  const confirmed = new Set();
  const short = p => (home && String(p ?? '').toLowerCase().replace(/\\/g, '/').startsWith(home.toLowerCase().replace(/\\/g, '/')) ? `~${String(p).slice(home.length)}` : String(p ?? ''));
  const where = () => ({ place: null, parent: null, missing: false, ...(scope?.() ?? {}) });
  const at = () => where().place ?? null;
  /** フォルダーが見つからない: 読むだけ（押しても保存しない。追加・戻す・外すも出さない） */
  const readOnly = () => Boolean(at() && where().missing);
  /** フォルダーの設定なら、一覧と保存に cwd を付ける */
  const withCwd = args => (at() ? { ...args, cwd: at() } : args);

  /** 一覧（hooks.matrix）・登録（hooks.list）・定義の詳細（hooks.scan）を読む。Codex の信頼状態（app-server を待つ）は後から重ねる */
  async function load() {
    const mine = ++ticket;
    loading = true; render();
    try {
      const [m, view, sc] = await Promise.all([cmd('hooksMatrix', withCwd({ trust: false })), cmd('plyHooks', {}).catch(() => null), cmd('scanHooks', { scope: 'user' }).catch(() => null)]);
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
    const [m2, sc2] = await Promise.all([grid?.trustPending ? cmd('hooksMatrix', withCwd({ trust: true })).catch(() => null) : null,
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

  /** タブの件数: どれかのエージェントで実行する Hook の数（作業場所のまとめの行は Hook ではないので数えない）。読めないときは隠す。2 つ目は差分の数 */
  function count() {
    const ok = Array.isArray(grid?.rows) && !grid.unreadable;
    onCount?.(ok ? grid.rows.filter(r => r.on && r.kind !== 'ws').length : null, { changes: ok ? (grid.changes ?? 0) : 0 });
  }

  /** 押した操作を送る。押す前の表を取っておき、失敗したら戻して描き直し、理由は work が下の固定の位置に出す */
  function mutate(local, remote, { rowSwitch = false } = {}) {
    if (!grid) return;
    const prev = structuredClone(grid);
    local(grid);
    render();
    work(async () => {
      try { await remote(grid.revision ?? prev.revision); }
      catch (e) { grid = prev; render(); reload(); throw e; }
      await load();
      // 行のスイッチは、新しい会話からだけ読むエージェントのマスが変わったときだけ「新しい会話から反映します」を添える
      saved(savedText(rowSwitch && hooksFreshChanged(prev, grid)));
    });
  }
  const findRow = key => grid?.rows?.find(r => r.key === key) ?? null;

  /**
   * now: 確認の帯で「実行する」を押した後。広げる確認は行とエージェントの組で覚えるが、Devin の取り込みが止まり始める確認（stopsDevinImports）は
   * 覚えない（Devin のマスを切って取り込みが戻った後に、もう一度入れるときも聞く）。どちらも core の一覧の印だけで決める
   */
  function toggleCell(row, agent, fk, now = false) {
    const cell = row.cells[agent];
    if (!cell || cell.mode !== 'toggle' || readOnly()) return;
    const on = cell.state !== 'on';
    if (!now && cell.needsConfirm && (cell.stopsDevinImports || (on && !confirmed.has(`${row.key}:${agent}`)))) {
      ask = { key: row.key, agent, fk };
      focus = '.cx-ask .btn-primary';
      render();
      return;
    }
    if (ask?.key === row.key) ask = null;
    const staysOn = on || Object.entries(row.cells).some(([a, c]) => a !== agent && c.state === 'on');
    focus = `[data-cx-fk="${CSS.escape(staysOn ? fk : `sw:${row.key}`)}"]`;
    mutate(g => { const r = g.rows.find(x => x.key === row.key); if (r) applyCellLocal(r, agent, on); },
      revision => cmd('setHookAgent', withCwd({ key: row.key, agent, on, revision })));
  }
  /** 行のスイッチ。押すと Devin の取り込みが止まり始める行（core の switchConfirm）は、保存の前に確認の帯を出す（覚えない）。now: 帯で押した後 */
  function toggleRow(row, now = false) {
    // 押すと、切れるオンがあればそれだけをまとめてオフにする（rowNextOn: false）。残っていなければ外す前の選択に戻す（rowNextOn: true）
    const on = Boolean(row.rowNextOn);
    if (readOnly()) return;
    if (!now && row.switchConfirm) {
      ask = { key: row.key, agent: null, fk: `sw:${row.key}`, row: true };
      focus = '.cx-ask .btn-primary';
      render();
      return;
    }
    if (ask?.key === row.key) ask = null;
    focus = `[data-cx-fk="${CSS.escape(`sw:${row.key}`)}"]`;
    // この場所で使わない（skipHere）にした行は、この場所で使うに戻す（hooks.setPlace）。表は保存の後に読み直す
    if (row.skipHere && at()) {
      mutate(() => {}, revision => cmd('setHookPlace', { place: at(), key: row.key, use: true, revision }), { rowSwitch: true });
      return;
    }
    mutate(g => { const r = g.rows.find(x => x.key === row.key); if (r) applyRowLocal(r, on); },
      revision => cmd('setHookRow', withCwd({ key: row.key, on, revision })), { rowSwitch: true });
  }
  /** 行の「戻す」: このフォルダーの差分を消して、上の場所（無ければ全体の設定）の選択に戻す。戻すと取り込みが止まり始めるなら先に確認の帯 */
  function revertRow(row, now = false) {
    const place = at();
    if (!place || readOnly()) return;
    if (!now && row.skipHere && row.switchConfirm) {
      ask = { key: row.key, agent: null, fk: `rv:${row.key}`, row: true, revert: true };
      focus = '.cx-ask .btn-primary';
      render();
      return;
    }
    const { parent } = where();
    const from = parent ? t('context.scope.fromParent', { name: placeName(parent) }) : t('context.scope.fromGlobal');
    if (ask?.key === row.key) ask = null;
    focus = `[data-cx-fk="${CSS.escape(`sw:${row.key}`)}"]`;
    work(async () => {
      await cmd('revertHookRow', { cwd: place, key: row.key, revision: grid?.revision });
      await load();
      saved(t('context.scope.reverted', { from }));
    });
  }
  /** 追加したスキャン場所を外す（保存は呼ぶ側の scan.remove） */
  function removePlace(p) {
    if (readOnly() || !scanPlaces?.remove) return;
    work(async () => { await scanPlaces.remove(p); await load(); });
  }
  /** 全体のスイッチの鍵（切ってもオンのまま残るマス）の理由。理由ごとに 1 回 */
  function fixedReasons(row) {
    const out = [];
    for (const a of grid.agents) {
      const v = hookCellView({ ...row, on: true }, a);
      if (v.state === 'lockon' && v.cell?.tip && !out.includes(v.cell.tip)) out.push(v.cell.tip);
    }
    return joinLockReasons(out);
  }

  function askEl(row) {
    const a = ask;
    const name = hookRowName(row);
    const cell = a.row ? null : row.cells[a.agent];
    // 行のスイッチ・取り込みが止まり始めるマスは「Devin の取り込みが止まる」、ほかは「でも実行する」（広げる確認）
    const stops = a.row || cell?.stopsDevinImports === true;
    const warnings = (a.row ? row.switchConfirm?.warnings : cell?.warnings) ?? [];
    const to = a.row ? null : short3(a.agent);
    const box = askBanner({
      ariaLabel: stops ? t('hooks.matrix.askStopAria', { name }) : t('hooks.matrix.askAria', { name, to }),
      text: stops ? t('hooks.matrix.askStop') : t('hooks.matrix.ask', { from: row.kind === 'reg' ? 'Pleiad' : short3(row.agent), to }),
      cancelLabel: t('context.matrix.cancel'),
      confirmLabel: t('hooks.matrix.confirm'),
      onCancel: () => { focus = `[data-cx-fk="${CSS.escape(a.fk)}"]`; ask = null; render(); },
      onConfirm: () => {
        if (!a.row && cell?.needsConfirm) confirmed.add(`${a.key}:${a.agent}`);
        ask = null;
        const r = findRow(a.key);
        if (r && a.revert) revertRow(r, true);
        else if (r && a.row) toggleRow(r, true);
        else if (r) toggleCell(r, a.agent, a.fk, true);
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
        // フォルダーが見つからない: 押せるマスも鍵にする（今の選択は見せる）
        if (readOnly()) return lockedAgentChip(a, { ...v.cell, on: v.state === 'on', locked: true, tip: t('context.scope.readOnly') }, name, { ariaLabel, key: fk, keyAttr: 'cxFk', agentLabel: label });
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
    put(t('hooks.matrix.fact.runs'), runs.length ? runs.join(t('app.listSeparator')) : t('hooks.matrix.fact.none'));
    const locks = [];
    if (row.switchLock) { const s = hookTip(row.switchLock); if (s) locks.push(s); }
    for (const a of grid.agents) {
      const v = hookCellView({ ...row, on: true }, a);
      if (v.cell?.tip && !locks.includes(v.cell.tip)) locks.push(v.cell.tip);
    }
    put(t('hooks.matrix.fact.locked'), joinLockReasons(locks));
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
      const h = ply?.hooks?.find(x => x.id === row.key);
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

  /**
   * 行の下の段。作業場所の 1 行はスキャンの決まり（見つからないフォルダーではそのことを出す）。
   * 全体の設定では、別の設定にした場所（overriddenAt）を添える
   */
  function rowSub(row) {
    if (row.kind === 'ws') return readOnly() ? t('context.scope.sec.missingFolder') : t('context.scope.sec.rule');
    const bits = [hookRowSub(row)];
    if (!at()) { const s = elsewhereText(row.overriddenAt); if (s) bits.push(s); }
    return bits.join(' · ');
  }
  /** 行の印（名前の右）: この場所で変えた「● 変更」＋「戻す」、上の場所から受け継いだ「website の設定」。全体の設定では付けない */
  function rowMarks(row, name) {
    const place = at();
    if (!place) return [];
    if (row.overridden) {
      const out = [overrideBadge('changed')];
      if (!readOnly()) out.push(revertButton({ parent: where().parent, name, key: `rv:${row.key}`, onRevert: () => revertRow(row) }));
      return out;
    }
    if (row.from && !samePath(row.from, place)) return [parentLink(row.from, onGo)];
    return [];
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
    body.append(nl, el('span', 'p', rowSub(row)));
    if (row.kind === 'ws') r.append(body);
    else {
      const open = button('', 'cx-open');
      open.dataset.cxFk = `open:${row.key}`;
      open.setAttribute('aria-expanded', String(opened.has(`hook:${row.key}`)));
      open.append(body);
      open.onclick = () => { const k = `hook:${row.key}`; if (opened.has(k)) opened.delete(k); else opened.add(k); focus = `[data-cx-fk="${CSS.escape(`open:${row.key}`)}"]`; render(); };
      r.append(open);
    }
    r.append(...rowMarks(row, name));
    const sw = wholeSwitch({
      state: row.rowMixed ? 'mixed' : row.on ? 'true' : 'false',
      fixed: Boolean(row.rowFixed) && !row.rowChangeableOn,
      fixedReason: fixedReasons(row),
      name,
      next: row.rowChangeableOn ? 'off' : row.rowRestore === 'was' ? 'restore' : 'on',
      disabledReason: readOnly() ? t('context.scope.readOnly')
        : row.switchable ? null : (hookTip(row.switchLock ?? {}) ?? t('context.lockReason.own', { agent: short3(row.switchLock?.agent ?? row.agent) })),
      key: `sw:${row.key}`,
      keyAttr: 'cxFk',
      onToggle: () => toggleRow(row),
    });
    r.append(sw, strip(row, name));
    list.append(r);
    if (ask?.key === row.key) list.append(askEl(row));
    if (row.kind !== 'ws' && opened.has(`hook:${row.key}`)) list.append(details(row));
  }

  const listOf = label => { const l = el('div', 'cx-list'); l.setAttribute('role', 'group'); l.setAttribute('aria-label', label); return l; };

  /** 追加したスキャン場所の頭の行: フォルダー名（下の段にパス）と、この場所で足したなら「● 追加」＋「外す」、上の場所で足したなら「website の設定」 */
  function placeHead(list, p, info) {
    const r = el('div', 'cx-row hk-root');
    r.dataset.root = p;
    const ic = el('span', 'cx-ic'); ic.setAttribute('aria-hidden', 'true'); ic.append(matrixSvg(MATRIX_ICON.folder));
    const body = el('span', 't');
    const nl = el('span', 'nl');
    const nm = el('span', 'nm mono', placeName(p)); nm.title = p;
    nl.append(nm);
    body.append(nl, el('span', 'p', short(p)));
    r.append(ic, body);
    if (info?.here) {
      if (at()) r.append(overrideBadge('added'));
      if (!readOnly() && scanPlaces?.remove) {
        const b = textButton(t('context.scope.sec.removeScan'), 'weak', () => removePlace(p));
        b.setAttribute('aria-label', t('context.scope.sec.removeScanAria', { path: p }));
        b.dataset.cxFk = `rm:${p}`;
        r.append(b);
      }
    } else if (info?.from && at()) r.append(parentLink(info.from, onGo));
    list.append(r);
  }

  /** スキャン場所: 作業場所の 1 行と、追加した場所ごとの Hook（足した場所の一覧は scanPlaces.added、Hook は一覧の root の行）。最後に追加の操作 */
  function scanSection() {
    const box = el('div', 'cx-block');
    box.append(sectionHead(t('context.scope.sec.scan'), { tip: t('context.scope.sec.scanTip') }));
    const ws = grid.rows.find(r => r.kind === 'ws');
    const placeRows = grid.rows.filter(r => r.group === 'place' && r.kind !== 'ws');
    if (ws || placeRows.length) {
      const list = listOf(t('context.scope.sec.rule'));
      if (ws) hookRow(list, ws);
      for (const row of placeRows) hookRow(list, row);
      box.append(list);
    }
    const rootRows = grid.rows.filter(r => r.group === 'root');
    const added = Array.isArray(scanPlaces?.added?.()) ? scanPlaces.added() : [];
    const used = new Set();
    const roots = [...added.map(a => ({ path: a.path, info: a })),
      ...[...new Set(rootRows.map(r => r.root).filter(Boolean))].filter(p => !added.some(a => samePath(a.path, p))).map(p => ({ path: p, info: null }))];
    for (const { path: p, info } of roots) {
      const list = listOf(placeName(p));
      placeHead(list, p, info);
      const rs = rootRows.filter(r => samePath(r.root, p));
      for (const row of rs) { used.add(row.key); hookRow(list, row); }
      if (!rs.length) list.append(el('p', 'cx-empty', t('context.scope.sec.nothing')));
      box.append(list);
    }
    // 場所の分からない root の行（古い一覧）も落とさない
    const rest = rootRows.filter(r => !used.has(r.key));
    if (rest.length) { const list = listOf(t('context.scope.sec.scan')); for (const row of rest) hookRow(list, row); box.append(list); }
    if (!readOnly()) { const add = scanPlaces?.addControl?.(); if (add) box.append(add); }
    return box;
  }

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
    // 見出し（「Hooks」）は呼ぶ側のタブが持つ。読み直しの間だけ、上に「探しています」を置く
    root.setAttribute('aria-label', 'Hooks');
    if (loading && grid) { const label = el('p', 'pending-label hk-pending'); label.append(runMark(t('pending.searching')), t('pending.searching')); root.append(label); }
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

    const global = !at();

    // 1. スキャン場所
    root.append(scanSection());

    // 2. ユーザースコープの Hooks（各エージェントの設定。管理者の Hook も）
    const own = el('div', 'cx-block');
    own.append(sectionHead(t('context.scope.sec.userHooks')));
    fileNotes(own);
    const userList = listOf(t('hooks.matrix.userAria'));
    const userRows = grid.rows.filter(r => r.group === 'own' || r.group === 'admin');
    for (const row of userRows) hookRow(userList, row);
    if (!userRows.length) userList.append(el('p', 'cx-empty', t('context.scope.sec.nothing')));
    if (scan && !readOnly()) userList.append(addButton(t('hooks.scope.addUser'), () => openHookSheet(sheetCtx(), {})));
    own.append(userList);
    root.append(own);

    // 3. Pleiad に登録（追加は全体の設定のときだけ。フォルダーでは、どのエージェントで実行するかだけを変える）
    const reg = el('div', 'cx-block');
    reg.append(sectionHead(t('context.scope.sec.plyRegistered'), { right: global ? [el('span', null, t('context.ply.scopePlain'))] : [] }));
    const regList = listOf(t('hooks.matrix.regAria'));
    const regRows = grid.rows.filter(r => r.group === 'ply');
    for (const row of regRows) hookRow(regList, row);
    if (!regRows.length) regList.append(el('p', 'cx-empty', t('hooks.matrix.regEmpty')));
    if (global) regList.append(addButton(t('hooks.add'), () => openPlyHookSheet({ cmd, onSaved: async () => { saved(t('hooks.saved')); await reload(); } })));
    reg.append(regList);
    root.append(reg);
    root.append(agentLegend(grid.agents));

    const pending = focus;
    focus = null;
    if (pending) root.querySelector(pending)?.focus({ preventScroll: true });
    else if (fk) root.querySelector(`[data-cx-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
  }
  render();
  return { root, load, reload, render, get grid() { return grid; } };
}
