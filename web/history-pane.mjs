// 会話の履歴の面（窓・最初の塗り・後からの足し・古いページの読み足し・静かな読み直しで残す行）を描く部品。
// web/client.mjs から動かしただけ（ADR 0319 段 6-4）。主の会話と、作業のダイアログの子の会話（段 6-6）が使う。
// 子の会話は hooks.child で、項目の足し引き（追加の指示・依頼の行）・行ごとの描き方・出さない提示を渡す:
//   child.items(items, { messages, base })  buildItems の結果に、追加の指示・依頼の項目（kind: 'instruction' / 'request'）を足し、親の記録の行を引いて返す
//   child.extraRow(item)                    足した項目の行（wrap 済みの .mw）
//   child.rowOptions(item)                  発言 1 件を historyRow で描く渡し物（readonly・user・backend など）
//   child.skipsPresent(p)                   出さない提示か
//   child.place(w)                          wrap 済みの行を筋に置く
import { el } from "./dom.mjs";
import { t } from "./i18n.mjs";
import { renderAssistantMarkdown, renderPresent, renderToolCall, applyToolResult } from "./render.mjs";
import { Bundle, splitToolCalls } from "./tool-bundle.mjs";
import { isComputerTool } from "./computer-use.mjs";
import { modelDisplayName } from "./composer-labels.mjs";
import { buildItems, inlineAttachments, showsAsCard } from "./timeline.mjs";
import { joinOlder, anchorSig, WINDOW_MESSAGES, WINDOW_BYTES } from "./history-sync.mjs";
import { createHeightSettler } from "./history-heights.mjs";

export function createHistoryPane(hooks) {
  const {
    thread, log,
    atBottom, placeRow, resetLiveTurn, spine, relayoutBranches, placeJunctions, paintDelegateStates, paintCompactions, syncEdit,
    paintable, updateBranches, cmd, select, finalizing,
    systemHistoryNode, stripActions, userMsg, aiMsg, thinkFromText, noteEndpointFailure, linkDelegateCard,
    activeBackendId, subagentToolsOf, isBoundaryTool,
    currentSession, isBusy, isLoadingSession, backendVocab, toolCardMap,
    child = null,
  } = hooks;

  /** 筋に並べる項目。子の会話は追加の指示・依頼の項目を足し、出さない提示を除く */
  function itemsOf() {
    const items = buildItems(messages, presents, base, presentBase);
    return child ? child.items(items, { messages, base }) : items;
  }

  // 状態
  // 今のセッションの履歴（loadSession の messages）。長い会話は末尾の窓だけ（ADR 0182）。client の messages はここへつながる
  let messages = [];
  // messages[0] の通し番号。画面の行の印 m:<通し番号> とサーバーの添字はこの値で揃える
  let base = 0;
  let presents = [];
  // presents[0] の通し番号（p:<通し番号>）
  let presentBase = 0;
  // 窓の手前にあるサブエージェントの呼び出しの要約（サーバーが運ぶ。subagentCalls）。作業ダイアログの過去の一覧が使う
  let earlierCalls = [];
  // 履歴をまとめて描く間は、1 件ごとに筋を貼り直さない。筋の位置と末尾の判定はレイアウトを読むので、
  // 1 件ごとにやると件数の 2 乗でレイアウトが走り、大きな会話を開くのに数秒かかっていた。paintHistory が最後に 1 回貼る
  let paintingHistory = false;
  // 古い発言を読み足して描く間（paintOlder）、行は末尾ではなくこの行の手前に置く
  let paintBefore = null;
  // 前の発言の読み込み（ADR 0182）。読み込み中の約束・読めなかった会話と窓の位置・先頭に出している表示
  let olderBusy = null;
  let olderFail = null;
  let olderEl = null;
  // 会話を開いたとき、末尾の数行だけ先に描き、手前は idle に小分けで足している最中の仕事（ADR 0182: C1）。無ければ null
  let backfill = null;


  /**
   * 見ている位置の基準の発言（実寸の確定・再接続の読み直しで位置を保つのに使う）。#log の上端より少し下に下端がある最初の行を選ぶ。
   * 点で当てると、列（.thread の max-width）より #log が広い窓で列の外に落ちるので、行の並びから探す。
   * 行は上から順に並んでいるので二分探索にし、レイアウトを読むのは log2(件数) 回で済ませる。rows は上から並んだ全部の発言の行（省くと今の #thread から集める）
   */
  function historyAnchor(rows = thread.querySelectorAll(':scope > .mw')) {
    const box = log.getBoundingClientRect();
    const line = box.top + Math.min(80, box.height / 3);
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].getBoundingClientRect().bottom > line) hi = mid; else lo = mid + 1;
    }
    return rows[lo] ?? null;
  }

  /**
   * 履歴の発言の実寸を、見えている所の近くだけ確定する（web/history-heights.mjs）。
   * 開いた直後は末尾の近く、その後は見えている所に近づいた行から。遠くの行は仮の高さのまま
   */
  let heightSettler = null;
  function prepareHistoryHeights() {
    heightSettler ??= createHeightSettler({ log, thread, atBottom, anchorRow: historyAnchor, onBusy: (on) => finalizing(on) });
    heightSettler.prepare();
  }

  function clearThread() {
    cancelBackfill();
    heightSettler?.cancel();
    resetLiveTurn();
    thread.replaceChildren(spine());
    thread.classList.remove("branched");
    toolCardMap().clear();
  }

  /** 行の中の発言の役割（続きの見出しを省くかの判定に使う）。履歴の行は AI なら .m.ai、人なら .m.user */
  function rowRole(row) {
    const m = row.querySelector(".m");
    return m?.classList.contains("ai") ? "assistant" : m?.classList.contains("user") ? "user" : null;
  }

  /**
   * 静かな読み直し（つなぎ直したとき）で、履歴から描いた行を plan.keepItems 項目まで残し、その後ろを外す（web/history-sync.mjs の retainPlan）。
   * 残す境目は、残す項目のうち一番後ろの「履歴から描いた行」（data-h）。ライブで描いて履歴の添字を付けただけの行は、
   * 1 行が複数の発言にまたがることがあるので境目にしない（その分は履歴から描き直す）。
   * 境目より前でも、圧縮の区切りと分岐点の行は描き直すので外す。境目が無ければ null（呼び出し側が全部描き直す）。
   * 戻り値は { row: 境目の行, from: 描き直す最初の項目の添字, prevRole: その直前の発言の役割, rows: 履歴から描いた行（キー → 行） }
   */
  function retainThread({ keepItems, items }) {
    const rows = new Map();
    for (const row of thread.children) if (row.dataset.h && row.dataset.key) rows.set(row.dataset.key, row);
    const keyOf = it => it.kind === "present" ? `p:${it.pi}` : `m:${it.mi}`;
    let boundary = null, from = 0;
    for (let i = keepItems - 1; i >= 0 && !boundary; i--) {
      boundary = rows.get(keyOf(items[i])) ?? null;
      from = i + 1;
    }
    if (!boundary) return null;
    let prevRole = null;
    for (let i = from - 1; i >= 0 && prevRole === null; i--) {
      const row = items[i].kind === "msg" ? rows.get(keyOf(items[i])) : null;
      if (row) prevRole = rowRole(row);
    }
    resetLiveTurn();
    let after = false;
    for (const row of [...thread.children]) {
      if (row.classList.contains("spine")) continue;
      if (after || row.classList.contains("branch-row") || row.dataset.compactionId !== undefined) row.remove();
      if (row === boundary) after = true;
    }
    for (const [id, card] of toolCardMap()) if (!card.isConnected) toolCardMap().delete(id);
    return { row: boundary, from, prevRole, rows };
  }

  /**
   * 読み返している位置を、画面の基準の行（historyAnchor）で覚える。返す関数は、描き替えた後に同じ行が同じ高さに来るよう #log を動かす。
   * 基準の行が外れていたら同じ添字の行、それも無ければ元の scrollTop
   */
  function holdReading() {
    const anchor = historyAnchor();
    const top = anchor?.getBoundingClientRect().top;
    const key = anchor?.dataset.key;
    const scrollAt = log.scrollTop;
    return () => {
      const row = anchor?.isConnected ? anchor : key ? [...thread.children].find(x => x.dataset.key === key) : null;
      if (row) log.scrollTop += row.getBoundingClientRect().top - top;
      else log.scrollTop = scrollAt;
    };
  }

  /** 履歴を読み込む間の骨組みの行（開くとき全体に・上へ戻って前の発言を読むとき先頭に出す） */
  function historySkeletons() {
    return [[42, 62], [35, 78, 54]].map((widths) => {
      const lines = el('div', 'history-lines');
      for (const width of widths) { const line = el('span', 'history-line'); line.style.width = `${width}%`; lines.append(line); }
      const skeleton = el('div', 'm history-skeleton');
      skeleton.append(lines);
      return skeleton;
    });
  }


  /**
   * 履歴を描く。from 以降の添字（messages の mi）だけ。返すのは足した要素。
   * retained を渡すと（静かな読み直し。retainThread の戻り値）、描き並べる項目の retained.from 番目からだけ描く
   */
  function paintHistory(fromMi = 0, retained = null, older = null) {
    paintingHistory = true;
    try { return paintHistoryRows(fromMi, retained, older); }
    finally { paintingHistory = false; relayoutBranches(); paintDelegateStates(); }
  }

  function paintHistoryRows(fromMi, retained = null, older = null) {
    // older は一部だけ描くときの指定: wants（描く項目の判定）・range（描く項目の範囲 { from, to }）・items/refs/attachedTo（組み立て済み）・prevRole（範囲の直前の発言の役割）
    const items = older?.items ?? itemsOf();
    const refs = older?.refs ?? presents.map(p => p.reference);
    const added = [];
    // fromMi は通し番号。窓の中の添字は fromMi - base
    let prevRole = older && 'prevRole' in older ? older.prevRole : retained ? retained.prevRole : fromMi > base ? messages[fromMi - 1 - base]?.role : null;
    const startAt = !retained && fromMi > base ? new Date(messages[fromMi - 1 - base]?.at ?? 0) : null;
    // 発言に結び付いた human の present は、発言の本文の位置に取り込む（別のカードは出さない）。発言が描かれた添字だけ取り込み済みにする
    const attachedTo = older?.attachedTo ?? inlineAttachments(items);
    const inlined = new Set();
    for (const [index, it] of items.entries()) {
      if (older?.range && (index < older.range.from || index >= older.range.to)) continue;   // 先に描く末尾・手前に足す 1 まとまり
      if (older?.wants && !older.wants(it)) continue;   // 読み足した古い発言: 描いていない行だけ
      if (retained && index < retained.from) {
        // 残した行のうち、本文に添付を取り込んで描いた発言は取り込み済みにする（後ろの添付の行を二重にしない）
        if (it.kind === "msg" && it.m.role === "user" && retained.rows.get(`m:${it.mi}`)?.querySelector(".m.user:not(.cmd)")) inlined.add(it.mi);
        continue;
      }
      if (it.kind === "instruction" || it.kind === "request") {
        const w = child.extraRow(it);
        if (!w) continue;
        child.place(w);
        w.dataset.h = "1";
        added.push(w);
        prevRole = "user";
        continue;
      }
      if (it.kind === "present") {
        if (it.anchorMi >= 0 && it.anchorMi < fromMi) continue;
        if (!showsAsCard(it, inlined)) continue;
        if (it.anchorMi < 0 && startAt && new Date(it.p.at ?? 0) < startAt) continue;
        const wrapper = placeRow(renderPresent(paintable(it.p)), `p:${it.pi}`);
        wrapper.dataset.h = "1";
        if (it.p.by === "human") wrapper.dataset.humanAttachment = "true";
        added.push(wrapper);
        continue;
      }
      if (it.mi < fromMi) continue;
      const { node, role } = historyRow(it.m, { cont: prevRole === "assistant", refs, prev: added.at(-1) ?? retained?.row,
        presents: (attachedTo.get(it.mi) ?? []).map(paintable), ...(child?.rowOptions(it) ?? {}) });
      if (it.m.role === "user" && node?.matches('.m.user:not(.cmd)')) inlined.add(it.mi);
      if (node) {
        const row = placeRow(node, `m:${it.mi}`);
        row.dataset.h = "1";
        added.push(row);
      }
      prevRole = role;
    }
    return added;
  }

  /**
   * 発言の行の役割（historyRow が返す role と同じ。行を作らずに分かる。続きの見出しを省く判定の「直前の発言」に使う）。
   * コマンド・`!` は人の行、ほかのシステム側の行（systemHistoryNode）は役割なし
   */
  function historyRole(m) {
    if (m.kind === 'command' || m.kind === 'shell') return 'user';
    if (m.kind === 'compactSummary' || m.kind === 'interrupt' || m.kind === 'teammate' || m.kind === 'interruptionNote' || m.kind === 'modelSwitch' || m.kind === 'channelEvent' || m.kind === 'contextNote' || m.internalTaskNotice) return null;
    return m.role;
  }
  /** items の index の直前にある発言の役割（無ければ null） */
  function roleBefore(items, index) {
    for (let i = index - 1; i >= 0; i--) {
      if (items[i].kind === 'msg') return historyRole(items[i].m);
      if (items[i].kind === 'instruction' || items[i].kind === 'request') return 'user';   // 子の会話の依頼元の発言（人の発言と同じ扱い）
    }
    return null;
  }

  // 会話を開くとき（ADR 0182: C1）: 末尾の FIRST_PAINT_ROWS 件の発言を先に描いて見せ、手前は idle に BACKFILL_MS ほどずつ足す。
  // 全部を 1 回で描くと、スマホでは 1 つの長いタスクが数百 ms になり、開いた後の最初の操作が待たされる
  const FIRST_PAINT_ROWS = 16;
  const BACKFILL_MIN = 12;    // 手前がこれより少ない（項目の数）なら分けずに全部描く
  const BACKFILL_MS = 24;     // 手前を足す 1 回に使う時間の目安（長いタスクにしない）

  /**
   * 描いた一番上の発言の通し番号と時刻（これより手前は、読んでいない・まだ描いていない）。区切りと分岐点はこれより手前に置かない。全部描いてあれば null
   */
  function paintedFloor() {
    if (backfill) return { mi: backfill.floorMi, at: paintedAt(backfill.floorMi) };
    return base > 0 ? { mi: base, at: paintedAt(base) } : null;
  }
  /**
   * 通し番号 mi 以降で最初に時刻を持つ発言の時刻。記録に時刻を持たない発言が窓や仕事の頭になっても、区切りの置き場所の基準が決まる。
   * 以降に時刻を持つ発言が 1 つも無ければ NaN（区切りを手前に置く基準が無いので、全部描く。窓の無い会話と同じ）
   */
  function paintedAt(mi) {
    for (let i = Math.max(0, mi - base); i < messages.length; i++) {
      const at = Date.parse(messages[i]?.at ?? '');
      if (Number.isFinite(at)) return at;
    }
    return NaN;
  }

  /** 末尾を先に描く分け方。分けないときは null。tail は paintHistory(0, null, tail) に、job は手前を足す仕事（backfill）になる */
  function splitFirstPaint() {
    if (messages.length < FIRST_PAINT_ROWS + BACKFILL_MIN) return null;
    const items = itemsOf();
    let rows = 0, cut = -1;
    for (let i = items.length - 1; i >= 0 && cut < 0; i--) if (items[i].kind === 'msg' && ++rows >= FIRST_PAINT_ROWS) cut = i;
    if (cut < BACKFILL_MIN) return null;
    const refs = presents.map(p => p.reference);
    const attachedTo = inlineAttachments(items);
    const job = { id: currentSession(), items, refs, attachedTo, end: cut, size: 8, handle: null, floorMi: items[cut].mi };
    return { job, tail: { items, refs, attachedTo, range: { from: cut, to: items.length }, prevRole: roleBefore(items, cut) } };
  }

  /**
   * 手前を足す仕事の 1 まとまりを描く（job.end の手前から rows 件の発言）。見ている位置は動かさない（末尾を見ていれば末尾に合わせ、読み返していれば基準の行を保つ）。
   * 発言に結び付いた提示はその発言の直後に並ぶので、まとまりの切れ目は提示の手前にならない。描き終えたら true
   */
  function backfillChunk(job, rows) {
    const { items } = job;
    let from = job.end, seen = 0;
    while (from > 0 && seen < rows) { from--; if (items[from].kind === 'msg') seen++; }
    while (from > 0 && items[from].kind === 'present' && items[from].anchorMi >= 0) from--;
    const restore = atBottom() ? () => { log.scrollTop = log.scrollHeight; } : holdReading();
    paintBefore = thread.querySelector(':scope > .mw[data-h]');
    try { paintHistory(0, null, { items, refs: job.refs, attachedTo: job.attachedTo, range: { from, to: job.end }, prevRole: roleBefore(items, from) }); }
    finally { paintBefore = null; }
    job.end = from;
    const top = items.slice(from).find(it => it.kind === 'msg');
    job.floorMi = top ? top.mi : base;
    restore();
    return from <= 0;
  }

  function scheduleBackfill(job) {
    const run = () => { job.handle = null; stepBackfill(job); };
    job.handle = typeof requestIdleCallback === 'function' ? { idle: requestIdleCallback(run, { timeout: 250 }) } : { timer: setTimeout(run, 16) };
  }
  function stopBackfillTimer(job) {
    if (job.handle?.idle) cancelIdleCallback(job.handle.idle);
    if (job.handle?.timer) clearTimeout(job.handle.timer);
    job.handle = null;
  }
  /** idle の 1 回分。かかった時間に合わせて次の件数を決める */
  function stepBackfill(job) {
    if (backfill !== job) return;
    if (currentSession() !== job.id) { cancelBackfill(); return; }
    const started = performance.now();
    const done = backfillChunk(job, job.size);
    const spent = Math.max(1, performance.now() - started);
    job.size = Math.min(48, Math.max(2, Math.round(job.size * BACKFILL_MS / spent)));
    if (done) finishBackfill(job); else scheduleBackfill(job);
  }
  /** 手前を足し終えた: 手前に置けなかった区切りと分岐点を置き、実寸の確定と手前の読み足しを再開する */
  function finishBackfill(job) {
    if (backfill !== job) return;
    backfill = null;
    const restore = atBottom() ? () => { log.scrollTop = log.scrollHeight; } : holdReading();
    syncEdit();
    paintCompactions();
    placeJunctions();
    restore();
    prepareHistoryHeights();
    requestAnimationFrame(() => { log.style.overflowAnchor = ''; maybeLoadOlder(); });
  }
  /** 仕事をやめる（会話が替わった・描き直す）。描いた行は clearThread などが片付ける */
  function cancelBackfill() {
    if (!backfill) return;
    stopBackfillTimer(backfill);
    backfill = null;
    log.style.overflowAnchor = '';
  }
  /** 残りを今すぐ全部描く（手前の発言が要る操作: 手前の読み足し・会話の中の検索・目次・位置を保つ描き替え・枝の切り替え） */
  function flushBackfill() {
    const job = backfill;
    if (!job) return;
    stopBackfillTimer(job);
    backfillChunk(job, Infinity);
    finishBackfill(job);
  }

  /**
   * 履歴の発言 1 件の行。メインパネル（paintHistoryRows）と読むだけの筋（作業の詳細、readonlyThread）で共通。
   * node が null なら描かない。role は次の発言の cont（AI が続けて話したか）を決める。system はシステム側の行（systemHistoryNode）だったか。
   * prev は直前に置いた行。続けて残った中断（ツールの中断と、その直後の中断）は 1 行にする。
   * readonly は読むだけの筋: システム側の行の操作（コピー・⋯）を外し（人の発言と返答は本体と同じ操作を持つ）、発言者をモデル名で出し（どのモデルが答えたかを見分けるため。
   * 分からなければエージェント名のまま）、ツールカードを主の会話の toolCards に登録せず、委譲のカードに「開く」を付けない
   * （openFromCard はメインパネルの会話を親として子を探すので、別の会話の筋では違う子を開く）。
   * linkCards は、読むだけの筋でも、委譲のカードに「開く」を付け、ツールカードをこの実例の toolCards に登録する（子の会話の筋。ctx に子の会話を持たせて開く）。
   * backend は発言に backend が無いときの発言者。account はその会話のアカウント（発言者のモデル名は、そのアカウントの一覧で引く。Mythos など一覧がアカウントごとに違うモデルの名前が生の ID に戻らないように）。sessionId は Web 検索の失敗に接続先の一文を足すときに引く会話。
   * user を渡すと人の発言をそれで描く（詳細の最初の発言の「依頼」）
   */
  function historyRow(m, { cont = false, refs = [], prev = null, readonly = false, linkCards = false, backend, account = '', sessionId = currentSession(), user = null, presents = [] } = {}) {
    const system = systemHistoryNode(m);
    if (system !== undefined) {
      const repeated = system?.matches('.m.sys.interrupted') && prev?.querySelector(':scope .m.sys.interrupted');
      const role = system?.classList.contains('user') ? 'user' : null;
      if (!system || repeated) return { node: null, role, system: true };
      if (readonly) stripActions(system);
      return { node: system, role, system: true };
    }
    let node;
    if (m.role === "user") node = user ? user(m) : userMsg(m.text, { uuid: readonly ? undefined : m.uuid, at: m.at, presents, markdown: !readonly, scheduledFor: m.scheduledFor, sentBy: m.sentBy });
    else {
      node = aiMsg({ uuid: readonly ? undefined : m.uuid, at: m.at, backend: m.backend ?? backend, cont, model: m.switchedModel });
      if (readonly && m.model) node.querySelector('.who > span:not(.row-be)').textContent = modelDisplayName(backendVocab(backend, account)?.models ?? {}, m.model);
      if (m.thinking) node.append(thinkFromText(m.thinking));
      const cards = (m.toolCalls ?? []).map((c) => {
        const card = renderToolCall(c.name, c.input, { id: c.id, at: c.at, startedAt: c.startedAt, endAt: c.endAt });
        if (c.result) {
          // endAt（正規化が tool_result の時刻を持つとき）を結果に乗せて渡す。畳んだ仮の発言は result.at（サーバーの時計）が既にある
          const res = c.result && typeof c.result === 'object' ? { ...c.result, at: c.endAt ?? c.result.at } : c.result;
          applyToolResult(card, res); noteEndpointFailure(card, c.result, sessionId);
        }
        if (!readonly || linkCards) linkDelegateCard(card, c.input, c.result, { backend: m.backend ?? backend ?? activeBackendId() });
        if (c.id && (!readonly || linkCards)) toolCardMap().set(c.id, card);
        return card;
      });
      if (!m.toolCalls) for (const name of m.tools ?? []) cards.push(renderToolCall(name, null));
      node.append(...toolNodes(cards, subagentToolsOf(m.backend ?? backend ?? activeBackendId())));
      if (m.text) { const b = el("div", "body"); b.dataset.raw = m.text; b.innerHTML = renderAssistantMarkdown(m.text, refs); node.append(b); }
    }
    // 読むだけの筋は data-uuid を持たない（持つと ⋯ のメニューが分岐・編集を出す）。検索から開いたとき発言へ送る目印だけ別に付ける（revealMessage の inModal）
    if (readonly && m.uuid && node) node.dataset.hitUuid = m.uuid;
    return { node, role: m.role };
  }

  /**
   * 履歴の 1 つの発言のツールの行を、まとまり（閉じた見出し）と委譲に分けて並べる。委譲はまとまりの外に 1 件ずつ出し、そこでまとまりが切れる。
   * 1 件だけのまとまりは見出しを付けず、行のまま置く
   */
  function toolNodes(cards, tools) {
    const out = [];
    for (const seg of splitToolCalls(cards, (card) => isBoundaryTool(card.dataset.tool, tools), (card) => (isComputerTool(card.dataset.tool) ? "computer" : "tools"))) {
      if (seg.type === "delegate") { out.push(seg.call); continue; }
      // コンピューターの操作は 1 件でも塊（見出しが「コンピューターを操作しました」）
      if (seg.calls.length === 1 && seg.kind !== "computer") { out.push(seg.calls[0]); continue; }
      const bundle = new Bundle({ kind: seg.kind });
      bundle.addAll(seg.calls);
      out.push(bundle.el);
    }
    return out;
  }


  // ---------------------------------------------------------------- 前の発言（ADR 0182）

  // 長い会話は末尾の窓だけを読んで開く。上へ戻って先頭に近づいたら、窓の手前の発言を足す。読んでいる位置は動かさない。
  // 先頭には「前の発言を読み込んでいます…」と骨組みの線を出し、読めなかったら「もう一度」を出す（自動では読み直さない）
  const OLDER_REACH = 900;   // 先頭からこの高さ（px）まで近づいたら読み始める

  /** 先頭の表示を替える。kind: loading（読み込み中）/ failed（読めなかった）/ start（会話の最初まで読んだ） */
  function showOlder(kind) {
    const restore = olderEl?.isConnected || kind ? holdReading() : null;
    olderEl?.remove();
    const box = el('div', 'older-load');
    if (kind === 'loading') {
      box.setAttribute('aria-busy', 'true');
      box.append(el('div', 'older-note', t('pending.olderLoading')), ...historySkeletons());
    } else if (kind === 'failed') {
      const retry = el('button', 'older-retry', t('pending.retry'));
      retry.type = 'button';
      retry.onclick = () => { olderFail = null; loadOlder(); };
      box.append(el('div', 'older-note', t('pending.olderFailed')), retry);
    } else box.append(el('div', 'older-note', t('pending.olderStart')));
    olderEl = box;
    thread.querySelector(':scope > .spine')?.after(box);
    restore?.();
  }
  function hideOlder() {
    olderEl?.remove();
    olderEl = null;
  }

  function maybeLoadOlder() {
    if (disposed || olderBusy || backfill || base <= 0 || !currentSession() || isLoadingSession() || isBusy()) return;
    if (olderFail?.id === currentSession() && olderFail.base === base) return;
    if (log.scrollTop > OLDER_REACH) return;
    loadOlder();
  }
  // 子の会話の実例は閉じるたびに作り直す。log（作業のダイアログの本文）は残るので、閉じたら外す
  const scrollGuard = new AbortController();
  let disposed = false;
  log.addEventListener('scroll', maybeLoadOlder, { passive: true, signal: scrollGuard.signal });

  /** 実例を閉じる: スクロールの見張り・手前の足しの仕事・実寸の確定を止める（行は消さない） */
  function dispose() {
    disposed = true;
    scrollGuard.abort();
    cancelBackfill();
    heightSettler?.cancel();
  }

  /**
   * 窓の手前の発言を 1 まとまり読んで、先頭に足す。足せたら true。
   * reach = 届かせたい発言の uuid（検索の抜粋から飛ぶとき）。新しいサーバーはそこまでを 1 回で運ぶ。古いサーバーは無視して、いつもの件数だけ返す
   */
  function loadOlder({ reach = null } = {}) {
    if (olderBusy) return olderBusy;
    flushBackfill();   // 手前の行は、いま描いてある一番上の行の手前に足す。窓の中の手前を先に描き終える
    const id = currentSession(), before = base;
    if (!id || before <= 0 || !messages.length || isLoadingSession()) return Promise.resolve(false);
    const prev = { messages, presents, base: before, presentBase };
    const request = { before, presentBefore: presentBase };
    const same = () => currentSession() === id && base === before && messages === prev.messages;
    const run = (async () => {
      showOlder('loading');
      let joined = null;
      try {
        const data = await cmd('loadSession', { sessionId: id, lazy: true,
          older: { ...request, count: WINDOW_MESSAGES, bytes: WINDOW_BYTES, check: anchorSig(prev.messages[0]), ...(reach ? { reach } : {}) } }, { bulk: true });
        if (!same()) { if (currentSession() === id) hideOlder(); return false; }   // 会話が替わった・窓が替わった: 捨てる
        joined = joinOlder(prev, data, request);
      } catch {
        if (same()) { olderFail = { id, base: before }; showOlder('failed'); }
        return false;
      }
      if (!joined) {
        // 手前が書き換わった（圧縮・巻き戻しなど）・つながらない: 窓を読み直して描き替える
        hideOlder();
        await select(id, { reload: true });
        return false;
      }
      paintOlder(joined, before, request.presentBefore);
      return true;
    })();
    olderBusy = run.finally(() => { olderBusy = null; });
    return olderBusy;
  }

  /** 窓の手前を全部読む（会話の中の検索・目次を開くとき）。会話の最初まで読めたら true */
  async function loadAllOlder() {
    flushBackfill();
    while (base > 0) if (!await loadOlder()) return base === 0;
    return true;
  }

  /**
   * 読んだ手前の発言（joined は窓の前につないだ全量）を、いまある行の手前に描く。
   * いまある先頭の行が AI の発言なら描き直す（手前の発言が AI なら「続き」の形が変わる）。読んでいる位置は変えない
   */
  function paintOlder(joined, oldBase, oldPresentBase) {
    const restore = atBottom() ? () => { log.scrollTop = log.scrollHeight; } : holdReading();
    log.style.overflowAnchor = 'none';
    hideOlder();
    const firstRow = thread.querySelector(`:scope > .mw[data-key="m:${oldBase}"]`);
    const repaint = Boolean(firstRow?.querySelector('.m.ai'));
    if (repaint) firstRow.remove();
    messages = joined.messages;
    presents = joined.presents;
    base = joined.base;
    presentBase = joined.presentBase;
    // 読み足した分の行だけ描く。窓の外の発言に結び付いて、窓の中では単独の行になっていた提示は、描き直す。
    // 結び付かない提示は、時刻が窓の最初の発言より前なら、窓の中では先頭に載せていたので、時刻の位置へ描き直す
    const firstAt = Date.parse(messages[oldBase - base]?.at ?? '');
    const wants = (it) => {
      // 子の会話の追加の指示・依頼の行は、まだ描いていないものだけ（描いた行は位置が変わらない）
      if (it.kind === 'instruction') return !thread.querySelector(`:scope > .mw[data-key="instruction:${it.instruction.id}"]`);
      if (it.kind === 'request') return !thread.querySelector(':scope > .mw[data-key="request"]');
      if (it.kind === 'present') {
        const own = it.anchorMi >= 0 ? it.anchorMi < oldBase : it.pi < oldPresentBase || Boolean(it.p?.at) && it.sortAt < firstAt;
        const old = own ? thread.querySelector(`:scope > .mw[data-key="p:${it.pi}"]`) : null;
        if (old) {
          if (old === paintBefore) paintBefore = old.nextElementSibling;   // 差し込む基準の行を除くと、基準が外れて差し込めない
          old.remove();
        }
        return own;
      }
      return it.mi < oldBase || repaint && it.mi === oldBase;
    };
    paintBefore = thread.querySelector(':scope > .spine')?.nextElementSibling ?? null;
    try { paintHistory(0, null, { wants }); } finally { paintBefore = null; }
    updateBranches(currentSession(), messages, { base });
    syncEdit();
    paintCompactions();
    placeJunctions();
    if (base === 0) showOlder('start');
    restore();
    prepareHistoryHeights();
    requestAnimationFrame(() => { log.style.overflowAnchor = ''; maybeLoadOlder(); });
  }

  return {
    paintHistory, retainThread, clearThread, holdReading, historyRow, splitFirstPaint, dispose,
    paintedFloor, scheduleBackfill, cancelBackfill, flushBackfill,
    prepareHistoryHeights, maybeLoadOlder, loadOlder, loadAllOlder,
    // 状態の読み書き（client の place・append・paintSession・revealMessage が読む。client の state の同名の項目もここへつながる）
    get painting() { return paintingHistory; },
    get messages() { return messages; }, set messages(v) { messages = v; },
    get base() { return base; }, set base(v) { base = v; },
    get presents() { return presents; }, set presents(v) { presents = v; },
    get presentBase() { return presentBase; }, set presentBase(v) { presentBase = v; },
    get earlierCalls() { return earlierCalls; }, set earlierCalls(v) { earlierCalls = v; },
    get paintBefore() { return paintBefore; },
    get backfill() { return backfill; }, set backfill(v) { backfill = v; },
    get olderFail() { return olderFail; }, set olderFail(v) { olderFail = v; },
  };
}
