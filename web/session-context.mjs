// ==================== 会話の右パネル「この会話のコンテキスト」（docs/design-system.md「コンテキスト」） ====================
// 会話の頭の札（指示 2 · Skills 14 · MCP … · Pleiad の指示 3）を押すと、ファイルプレビューと同じ右パネルに開く（web/file-preview.mjs の openPanel）。
// 一番上は作業場所の面（ADR 0348）: 「<場所>」と「全体の設定どおり／このフォルダーで n 件変更／<親> の設定から n 件変更／<親> の設定どおり」、
//   「この場所の設定を開く」（設定 › プラグインを、範囲をこのフォルダーにして開く）。一言は保存したフォルダーの一覧（contextScopes）から決める。
// そのすぐ下が指示の量の面（ADR 0056）: 毎ターン最初に読み込まれる指示の合計と、ユーザー／この場所と親フォルダー／Pleiad が足す分の積み上げ、
//   自分で書いた分にだけ引く目安の線。エージェント任せの指示は、そのエージェントの規則で Pleiad が探した結果を数えて「推定」と添える。
//   同じ面の中に「気になる所」（違うファイルのほぼ同じ段落と、もう無いパス。contextFindings）を件数付きで畳む（0 件も完了を残す）。
//   面の最後が「見直しを頼む」: 同じ作業場所に未送信の新しい会話を作り、入力欄に依頼文の下書きを入れて開く（送らない。askReview）
// ふだんは sessionContext の記録（core/server.mjs）から作る。種類ごとに、渡したものを出どころ（ユーザー／この場所と親フォルダー／追加した場所）で分ける。
//   - 開始後に指示・Skills が変わった: 次の送信で自動的に読み込み直す。「新しい内容で会話を続ける」（refreshContext）は送信を待たずに今すぐ反映する操作と「差分を見る」
//   - MCP: 接続中（ツール数・呼び出し回数）／要ログイン（ブラウザでログイン・この会話では外す）／失敗（理由）
//   - エージェント任せの MCP は、そのエージェントの設定に登録されているものを読み取りのみで並べる（agentMcp）
//   - antigravity で Pleiad 担当を扱わなかった会話は、その理由
//   - Pleiad の指示（core/ply-instructions.mjs。担当によらない）: 項目ごとに入れたか・入れなかった理由と、渡した文
//   - Hooks（ADR 0045）: この場所で見つかった定義は「登録あり · 読み込み未確認」まで（有効・実行済みにしない）。
//     発火の記録は受け取った事実だけ（Claude の hook_started / hook_response）。受け取れない接続は「観測できません」
import { el } from './dom.mjs';
import { lineDiff, diffView } from './line-diff.mjs';
import { t, fmt } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { renderMarkdown } from './render.mjs';
import { estimateTokens } from './token-estimate.mjs';
import { DEFAULT_BUDGET, instructionAmount } from './instruction-amount.mjs';
import { findingCount, reviewDraft, reviewUrged } from './context-review.mjs';
import { freshAgents, savedText } from './context-matrix.mjs';
import { lockedAgentChip } from './mcp-matrix.mjs';
import { placeName } from './context-scope-marks.mjs';
import { openHookSheet, agentLabel, rowName, eventLabel, order, codexState, scopeLabel } from './hooks-card.mjs';
import { unifySessionBox, unsupportedAgentText } from './hooks-unify-ui.mjs';

const KEY = 'session-context';
const WORD = { instruction: t('sessionContext.word.instruction'), skill: 'Skills', mcp: 'MCP' };
// backend-allow: 読み込み元（core/context-settings.mjs の SOURCES）の名前。エージェントの id と同じ語だが、エージェントの分岐ではない
const SOURCE = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', devin: 'Devin', antigravity: 'Antigravity', grok: 'Grok', common: t('sessionContext.source.common'), ply: 'Pleiad' };
const GROUPS = ['user', 'dir', 'extra'];
const SKILLS_SHOWN = 6;
const HOOKS_SHOWN = 4;   // 右パネルに並べるユーザーの Hooks（残りは畳む）

// 「9/23 09:05」か「09:05」
function stamp(at, withDay = true) {
  if (!at) return '';
  return withDay ? fmt.dateTime(at, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : fmt.time(at);
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const base = p => String(p ?? '').split(/[\\/]/).pop();
/** ホーム（C:\Users\名前・/home/名前・/Users/名前）の下は ~ で短くする */
const shortPath = p => { const m = /^([A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/]+/.exec(String(p ?? '')); return m ? `~${String(p).slice(m[0].length)}` : String(p ?? ''); };
const dir = p => String(p ?? '').replace(/[\\/][^\\/]*$/, '');
/** 同じ行（id）を 1 つに。外したファイルは探索が出典ごとに別の行で返す（core/context-scan.mjs の add） */
export const uniqueRows = rows => { const seen = new Set(); return rows.filter(e => !seen.has(e.id) && seen.add(e.id)); };
/** 行の出どころ。足した場所（root）で見つかったもの／ユーザーの範囲（home）／この場所と親フォルダー（Git のルートから作業場所まで） */
const groupOf = e => e.root ? 'extra' : (e.scope ?? e.origins?.[0]?.scope) === 'user' ? 'user' : 'dir';
function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
/** 渡さなかった理由（記録に理由の文が無いとき） */
const REASON = {
  excluded: () => t('sessionContext.reason.excluded'),
  shadowed: () => t('sessionContext.reason.shadowed'),
  duplicate: () => t('sessionContext.reason.duplicate'),
  disabled: () => t('sessionContext.reason.disabled'),
  unsupported: () => t('sessionContext.reason.unsupported'),
};
/** Pleiad が担当した種類、または Stage 2 で解決結果が出ている種類か（antigravity で扱わなかった会話は、エージェント任せ） */
const managed = (info, kind) => info?.report?.status !== 'native' && (
  (info.owners ?? info.report?.owners ?? {})[kind] === 'ply'
  || (kind !== 'mcp' && (info?.report?.entries ?? []).some(e => e.kind === kind))
);
/** Pleiad の指示の記録 1 件。前の版の記録（{ id: 'delegation', variant, text }）も読む */
const addedItem = a => ({ ...a, inserted: a.inserted ?? Boolean(a.variant), name: a.name ?? t('sessionContext.added.delegation') });

/** パスを比べる形（区切りを / に、末尾の / を落とし、ドライブのあるパスは大文字小文字を区別しない） */
const pathKeyOf = p => { const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, ''); return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s; };
const samePath = (a, b) => pathKeyOf(a) === pathKeyOf(b);
const inside = (child, parent) => pathKeyOf(child).startsWith(`${pathKeyOf(parent)}/`);

/**
 * 作業場所の面の一言（ADR 0348）。places は contextScopes の places（保存したフォルダー: { path, changes: { total }, parent: { path } | null }）。
 * この場所を保存していれば、その変えた数と上のフォルダー。保存していなければ、保存した一番近い上のフォルダーに従う
 */
export function placeLine(cwd, places) {
  const list = Array.isArray(places) ? places : [];
  const own = cwd ? list.find(p => samePath(p.path, cwd)) : null;
  const parent = own ? own.parent?.path ?? null
    : (cwd ? list.filter(p => inside(cwd, p.path)).sort((a, b) => pathKeyOf(b.path).length - pathKeyOf(a.path).length)[0]?.path : null) ?? null;
  const count = own?.changes?.total ?? 0;
  if (count) return { changed: true, count, parent, text: parent
    ? t('sessionContext.place.changedFrom', { count, parent: placeName(parent) })
    : t('sessionContext.place.changed', { count }) };
  return { changed: false, count: 0, parent, text: parent ? t('sessionContext.place.sameAs', { parent: placeName(parent) }) : t('sessionContext.place.global') };
}

// i18n-dynamic: sessionContext.state.
// i18n-dynamic: sessionContext.amount.reading
// i18n-dynamic: sessionContext.group.
// i18n-dynamic: sessionContext.added.reason.
// i18n-dynamic: sessionContext.amount.part.
// i18n-dynamic: sessionContext.findings.scope.
export function setupSessionContext({ cmd, preview, session, info, refreshInfo, openSettings, labelOf, isRunning = () => false, budget = () => DEFAULT_BUDGET, askReview = null, openAccount = null }) {
  const logins = new Map();     // MCP 名 -> ログインの進み具合（ブラウザで続けてください… / ログインしました）
  const agentCache = new Map(); // cwd -> agentMcp の結果
  const backendCache = new Map(); // backends の能力。会話の担当の選択に使う
  const nativeCache = new Map(); // cwd|エージェント -> nativeInstructions の結果（結果と取得状態）。パネルを開くたびに読み直す
  let plyOpen = false;          // 指示の量の面の「Pleiad が足す分」を開いているか
  const findingsCache = new Map(); // 会話|場所|エージェント -> contextFindings の結果（結果と取得状態）。パネルを開くたびに計算し直す
  let issuesOpen = true;        // 「気になる所」を開いているか（最初は開く）
  let reviewing = false, reviewError = ''; // 「見直しを頼む」で会話を作っている途中か（二度押しで 2 つ作らない）・作れなかった理由
  let diff = null, diffOpen = false, busy = false, notice = '';
  let refreshLoadingVisible = false;
  const removedPending = new Map();
  let chip = null;
  // 作業場所の設定（contextSettings。Skills の定義の選択に使う）と、保存したフォルダーの一覧（contextScopes。面の一言に使う）。placeBusy は保存の途中か
  let place = { cwd: null, view: null, scopes: null, loading: false }, placeBusy = false, toastTimer = null, toastOn = false, toastFresh = false, toastPruned = null;
  // Hooks（sessionHooks の戻り）。会話・場所・実行中かが変わったら取り直す
  let hooks = { key: null, data: null };
  // 同じ名前の Skill の定義の選択肢を［変更］で開いている名前（ADR 0290）
  const choiceOpen = new Set();

  const title = t('sessionContext.title');
  function subtitle(data) {
    const started = data.startedAt ?? data.report?.at;
    // Antigravity・Grok は会話を始めるときだけ設定を読む。その会話では「次のターンから」と言わない（レビュー S8）
    const fresh = freshAgents().includes(session()?.backend);
    const text = started
      ? (fresh ? t('sessionContext.subtitle.startedAtFresh', { time: stamp(started) }) : t('sessionContext.subtitle.startedAt', { time: stamp(started) }))
      : (fresh ? t('sessionContext.subtitle.startedFresh') : t('sessionContext.subtitle.started'));
    return data.refreshedAt ? t('sessionContext.subtitle.refreshed', { text, time: stamp(data.refreshedAt) }) : text;
  }
  const backendLabel = () => labelOf(session()?.backend) || t('sessionContext.agent');
  const cwdOf = data => data?.report?.cwd ?? session()?.cwd ?? null;
  const here = () => place.view?.places?.find(p => p.current) ?? null;

  // 結果と取得状態を別々に保つ。再取得や失敗でも、前回届いた部分を空にしない。
  function readPart(cache, key, command, args) {
    let part = cache.get(key);
    if (!part) cache.clear(); // 開いている対象の前回結果だけを保つ。
    if (!part || (part.stale && !part.pending)) {
      part = { value: part?.value ?? null, pending: true, error: false };
      cache.set(key, part);
      const current = part;
      cmd(command, args).then(value => {
        if (cache.get(key) !== current) return;
        Object.assign(current, { value, pending: false }); refresh();
      }).catch(() => {
        if (cache.get(key) !== current) return;
        Object.assign(current, { error: true, pending: false }); refresh();
      });
    }
    return part;
  }
  function stateLine(text, { pending = false, error = false, retry = null } = {}) {
    const row = el('div', 'scx-state');
    row.setAttribute('role', 'status');
    if (pending || error) {
      const mark = pending ? runMark() : el('span', 'scx-state-mark', '!');
      mark.setAttribute('aria-hidden', 'true'); row.append(mark);
    }
    row.append(el('span', null, text));
    if (retry) row.append(button(t('sessionContext.state.retry'), 'btn btn-quiet', retry));
    return row;
  }
  function retryPart(part) { part.stale = true; refresh(); }

  // ---------------------------------------------------------------- 描画
  let shownFor = null;
  function render() {
    // 別の会話へ移った。前の会話の差分・ログインの途中経過は持ち越さない
    if (session()?.id !== shownFor) { shownFor = session()?.id ?? null; diff = null; diffOpen = false; notice = ''; reviewError = ''; logins.clear(); removedPending.clear(); choiceOpen.clear(); }
    const data = info();
    const box = el('div', 'scx');
    if (data?.pending || data?.error) box.append(stateLine(t(data.pending
      ? (data.report ? 'sessionContext.state.refreshing' : 'sessionContext.state.loading') : 'sessionContext.state.error'),
      { pending: data.pending, error: data.error, retry: data.error ? () => refreshInfo(true) : null }));
    if (!data?.report) {
      if (!data?.pending && !data?.error) box.append(data == null
        ? stateLine(t('sessionContext.state.loading'), { pending: true })
        : el('p', 'cx-sub', t('sessionContext.notStarted')));
      return box;
    }
    const report = data.report;
    loadPlace(cwdOf(data));
    readPart(backendCache, 'backends', 'backends', {});
    box.append(placeFace(data));
    box.append(amountFace(data));
    if (data.changed?.differs) box.append(changedNotice(data));
    if (report.guardedBackend) {
      const n = el('div', 'scx-notice');
      n.append(el('p', 'cx-strong', t('sessionContext.guarded.title')), el('p', 'cx-sub', report.reason ?? t('sessionContext.guarded.reason', { backend: report.guardedBackend })));
      box.append(n);
    }
    if (report.status === 'failed') {
      const n = el('div', 'scx-notice');
      n.append(el('p', 'cx-strong', t('sessionContext.failed.title')), el('p', 'cx-sub', t('sessionContext.failed.hint')));
      box.append(n);
    }
    box.append(instructions(data));
    if (data.added?.length) box.append(addedBox(data));
    box.append(skills(data), mcp(data), ...hookBoxes(data));
    const toast = el('div', 'cx-toast scx-toast' + (toastOn ? ' on' : ''), savedText(toastFresh, toastPruned)); toast.setAttribute('role', 'status');
    box.append(toast);
    return box;
  }
  function kindBox(label, who, ply) {
    const k = el('section', 'scx-kind');
    const head = el('div', 'cx-khead');
    head.append(el('h4', null, label), el('span', 'scx-who' + (ply ? ' ply' : ''), who));
    k.append(head);
    return k;
  }
  function item(mark, name, sub, { on = false, tokens = null } = {}) {
    const row = el('div', 'scx-item');
    const m = el('span', 'mark' + (on ? ' on' : ''), mark);
    m.setAttribute('aria-hidden', 'true');
    const body = el('div', 't');
    body.append(el('div', 'nm', name));
    if (sub) body.append(el('div', 'p', sub));
    row.append(m, body);
    // 指示の行の右端の量（ADR 0056）
    if (Number.isFinite(tokens)) row.append(el('span', 'scx-tok', about(tokens)));
    return { row, body };
  }
  const about = n => t('sessionContext.amount.about', { n: fmt.number(n) });
  /** 行を出どころ（ユーザー／この場所と親フォルダー／追加した場所）で分けて並べる */
  function grouped(k, rows, make) {
    for (const g of GROUPS) {
      const list = rows.filter(e => groupOf(e) === g);
      if (!list.length) continue;
      k.append(el('p', 'scx-grp', t(`sessionContext.group.${g}`)));
      for (const e of list) k.append(make(e));
    }
  }

  // ---------------------------------------------------------------- 指示の量の面（ADR 0056「① 量を見せる」）
  // 数えるのは毎ターン最初に読み込まれる指示だけ（条件付きの rules・Skills の本文・MCP のツール定義・履歴は数えない）。
  // 自分で書いた分は、Pleiad が渡した会話では記録の行（tokens）、エージェント任せの会話では nativeInstructions の見積もり。
  // Pleiad が足す分は、直前のターンで実際に渡した文（plyParts。core/instruction-amount.mjs）。この面はファイルを変えない
  /** エージェント任せの指示を、そのエージェントの規則で探した結果と取得状態 */
  function nativeFound(data) {
    const where = cwdOf(data), agent = session()?.backend ?? '';
    const key = `${where}|${agent}`;
    return readPart(nativeCache, key, 'nativeInstructions', { cwd: where, backend: agent });
  }
  function nativeStatus(part) {
    if (part.error) return stateLine(t('sessionContext.state.nativeError'), { error: true, retry: () => retryPart(part) });
    if (part.pending) return stateLine(t(part.value ? 'sessionContext.state.nativeRefreshing' : 'sessionContext.amount.reading', { agent: backendLabel() }), { pending: true });
    if (!Array.isArray(part.value?.entries)) return stateLine(t('sessionContext.amount.unknown', { agent: backendLabel() }));
    if (!part.value.entries.length) return stateLine(t('sessionContext.amount.nativeNone', { agent: backendLabel() }));
    return null;
  }

  function amountFace(data) {
    const managedHere = managed(data, 'instruction');
    const native = managedHere ? null : nativeFound(data);
    const unknown = !managedHere && !Array.isArray(native.value?.entries);
    const estimated = !managedHere && !unknown;
    const rows = managedHere ? data.report.entries.filter(e => e.kind === 'instruction' && (e.status === 'supplied' || e.status === 'native')) : native?.value?.entries ?? [];
    const parts = data.plyParts ?? null;
    const a = instructionAmount({ rows, parts: parts ?? [], budget: budget() });
    const n = v => fmt.number(v);
    const k = el('section', 'scx-kind scx-amount');
    const h = el('h4', null, t('sessionContext.amount.title'));
    h.id = 'scxAmountTitle';
    k.setAttribute('aria-labelledby', h.id);
    const head = el('div', 'cx-khead');
    head.append(h);
    if (estimated) { const est = el('span', 'scx-est', t('sessionContext.amount.estimated')); est.title = t('sessionContext.amount.estimatedNote'); head.append(est); }
    head.append(el('span', 'scx-total', about(a.total)));
    k.append(head);
    if (!managedHere) {
      const status = nativeStatus(native);
      if (status) k.append(status);
      else if (estimated) k.append(el('p', 'cx-sub', t('sessionContext.amount.estimatedNote')));
    }

    // 積み上げの棒。全長は合計か目安の大きい方。目安の線は自分で書いた分にだけ当てる（左端から測る）
    const pct = v => `${(a.scale ? v / a.scale * 100 : 0).toFixed(2)}%`;
    const meter = el('div', 'scx-meter');
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label', t('sessionContext.amount.aria', { total: n(a.total), user: n(a.user), dir: n(a.dir), ply: n(a.ply), own: n(a.own), budget: n(a.budget) }));
    if (a.own) {
      const own = el('div', 'scx-own');
      own.style.width = `calc(${pct(a.own)} - 1px)`;
      own.append(el('span', null, t('sessionContext.amount.own', { n: n(a.own) })));
      meter.append(own);
    }
    const bar = el('div', 'scx-bar');
    for (const [side, v] of [['user', a.user], ['dir', a.dir], ['ply', a.ply]]) {
      if (!v) continue;
      const seg = el('span', `scx-seg sw-${side}`);
      seg.style.flexBasis = pct(v);
      bar.append(seg);
    }
    const at = a.scale ? a.budget / a.scale * 100 : 100;
    const limit = el('span', 'scx-limit' + (at > 80 ? ' end' : ''));
    limit.style.left = `${at.toFixed(2)}%`;
    limit.append(el('b', null, t('sessionContext.amount.budget', { n: n(a.budget) })));
    bar.append(limit);
    meter.append(bar);
    k.append(meter);

    // 凡例。色だけに頼らず、印と数字を並べる。Pleiad が足す分は開くと内訳（見せるだけ）
    const legend = el('ul', 'scx-legend');
    const li = (tag, side, label, value) => {
      const row = el(tag, 'scx-li');
      const sw = el('span', `sw sw-${side}`); sw.setAttribute('aria-hidden', 'true');
      row.append(sw, el('span', 'n', label), el('span', 'v', value));
      return row;
    };
    const ownValue = v => unknown ? '—' : about(v);
    for (const [side, v] of [['user', a.user], ['dir', a.dir]]) { const r = el('li'); r.append(li('span', side, t(`sessionContext.group.${side}`), ownValue(v))); legend.append(r); }
    const plyRow = el('li');
    if (!parts) plyRow.append(li('span', 'ply', t('sessionContext.amount.ply'), t('sessionContext.amount.plyPending')));
    else {
      const d = el('details', 'scx-ply');
      d.open = plyOpen;
      d.addEventListener('toggle', () => { plyOpen = d.open; });
      const list = el('ul', 'scx-plylist');
      list.setAttribute('aria-label', t('sessionContext.amount.plyAria'));
      for (const p of parts) { const r = el('li'); r.append(el('span', null, t(`sessionContext.amount.part.${p.id}`)), el('span', null, about(p.tokens))); list.append(r); }
      list.append(el('li', 'cx-sub', t('sessionContext.amount.plyNote')));
      d.append(li('summary', 'ply', t('sessionContext.amount.ply'), about(a.ply)), list);
      plyRow.append(d);
    }
    legend.append(plyRow);
    k.append(legend);

    // 目安を超えた。何倍かを 1 行で知らせるだけで、会話は止めない
    if (a.ratio) {
      const over = el('p', 'scx-over');
      const g = el('span', 'g', '▲'); g.setAttribute('aria-hidden', 'true');
      const text = el('span', null, t('sessionContext.amount.over', { ratio: fmt.number(a.ratio, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }));
      text.append(el('span', 'w', t('sessionContext.amount.overDetail', { own: n(a.own), budget: n(a.budget) })));
      over.append(g, text);
      k.append(over);
    }
    const found = findingsOf(data);
    k.append(issuesFace(found));
    if (askReview && rows.length) k.append(reviewActs({ rows, amount: a, found, cwd: cwdOf(data) }));
    return k;
  }

  // ---------------------------------------------------------------- 見直しを頼む（ADR 0056「③ 見直しを頼む」）
  // 目安を超えたか気になる所があれば主要操作、どちらも無ければ控えめ。押すと同じ作業場所に未送信の新しい会話を作り、
  // 入力欄に依頼文の下書き（web/context-review.mjs）を入れて開く。自動では送らない
  function reviewActs({ rows, amount, found, cwd }) {
    const acts = el('div', 'scx-acts');
    const ask = button(t('sessionContext.review.ask'), reviewUrged(amount, found.value) ? 'btn btn-primary' : 'btn', async () => {
      if (reviewing) return;
      reviewing = true; reviewError = ''; ask.disabled = true;
      try { await askReview({ cwd, text: reviewDraft({ rows, amount, findings: found.value }) }); }
      catch (e) { reviewError = t('sessionContext.review.failed', { error: e?.message ?? String(e) }); }
      finally { reviewing = false; refresh(); }
    });
    // 気になる所を計算している間は押せない（下書きに見つかった所が入らないため）
    ask.disabled = reviewing || found.pending || found.error || !found.value;
    acts.append(ask, el('span', 'cx-sub', t('sessionContext.review.note')));
    if (reviewError) { const err = el('p', 'cx-sub scx-err', reviewError); err.setAttribute('role', 'alert'); acts.append(err); }
    return acts;
  }

  // ---------------------------------------------------------------- 気になる所（ADR 0056「② 気になる所を知らせる」）
  // 数えている指示ファイルのうち、違うファイルのほぼ同じ段落（重複）と、この場所の指示に書かれたもう無いパスだけ。
  // 文の意味は読まない（core/context-findings.mjs）。パネルを開いたときにサーバーが計算し、保存しない
  function findingsOf(data) {
    const id = session()?.id ?? '', where = cwdOf(data), agent = session()?.backend ?? '';
    const key = `${id}|${where}|${agent}`;
    return readPart(findingsCache, key, 'contextFindings', { sessionId: id, cwd: where, backend: agent });
  }
  /** 件数付きで開閉する区画。重複は 2 か所を上下に並べて共通の部分を太字に、無いパスはどのファイルのどのパスか。各側に「開く」（その行へ） */
  function issuesFace(part) {
    const found = part.value;
    const count = findingCount(found);
    const box = el('div', 'scx-issues');
    if (part.pending || part.error || !found || !count) {
      if (!found || !count) box.append(el('span', 'scx-issues-title', t('sessionContext.findings.title')));
      if (part.error) box.append(stateLine(t('sessionContext.state.findingsError'), { error: true, retry: () => retryPart(part) }));
      else if (part.pending) box.append(stateLine(t(found ? 'sessionContext.state.findingsRefreshing' : 'sessionContext.state.checking'), { pending: true }));
      else if (!found) box.append(stateLine(t('sessionContext.state.unknown')));
      else {
        box.replaceChildren();
        const check = el('span', 'scx-state-mark', '✓'); check.setAttribute('aria-hidden', 'true');
        box.append(check, el('span', null, t('sessionContext.state.noFindings')));
      }
      if (!count) {
        if (found && (part.pending || part.error)) {
          const result = el('p', 'scx-empty-result');
          const check = el('span', 'scx-state-mark', '✓'); check.setAttribute('aria-hidden', 'true');
          result.append(check, el('span', null, t('sessionContext.state.noFindings'))); box.append(result);
        }
        return box;
      }
    }
    const d = el('details', 'scx-issues');
    d.open = issuesOpen;
    d.addEventListener('toggle', () => { issuesOpen = d.open; });
    const summary = el('summary', null, t('sessionContext.findings.title'));
    summary.append(el('span', 'scx-n', fmt.number(count)));
    d.append(summary);
    const where = side => {
      const row = el('div', 'scx-where');
      const scope = side.root ? 'extra' : side.scope === 'user' ? 'user' : 'dir';
      const go = button(t('sessionContext.findings.open'), 'btn', () => preview.open({ path: side.path, line: side.line ?? null }, go));
      go.setAttribute('aria-label', t('sessionContext.findings.openAria', { name: base(side.path), line: side.line }));
      const p = el('span', 'cx-path', shortPath(side.path));
      p.title = side.path;
      row.append(el('span', 'sc', t(`sessionContext.findings.scope.${scope}`)), p, go);
      return row;
    };
    const head = (label, rest) => {
      const h = el('p', 'scx-ih');
      h.append(el('span', 'scx-ik', label), rest);
      return h;
    };
    for (const item of found.duplicates) {
      const box = el('div', 'scx-issue');
      box.append(head(t('sessionContext.findings.duplicate'), el('span', null, t('sessionContext.findings.duplicateNote'))));
      item.sides.forEach((side, i) => {
        if (i) { const vs = el('span', 'scx-vs', '＝'); vs.setAttribute('aria-hidden', 'true'); box.append(vs); }
        const quote = el('p', 'scx-quote');
        for (const seg of side.segments) quote.append(seg.common ? el('b', null, seg.text) : document.createTextNode(seg.text));
        const s = el('div', 'scx-side');
        s.append(where(side), quote);
        box.append(s);
      });
      d.append(box);
    }
    for (const item of found.missing) {
      const box = el('div', 'scx-issue');
      box.append(head(t('sessionContext.findings.missing'), el('code', null, item.target)));
      const s = el('div', 'scx-side');
      s.append(where(item), el('p', 'scx-quote', item.from === 'folder' ? t('sessionContext.findings.missingFolder') : t('sessionContext.findings.missingRepo')));
      box.append(s);
      d.append(box);
    }
    const more = (found.more?.duplicates ?? 0) + (found.more?.missing ?? 0);
    if (more) d.append(el('p', 'cx-sub scx-more', t('sessionContext.findings.more', { count: more })));
    if (part.pending || part.error) { box.append(d); return box; }
    return d;
  }

  // ---------------------------------------------------------------- 作業場所の面
  function loadPlace(cwd) {
    if (!cwd) { place = { cwd, view: null, scopes: null, loading: false }; return; }
    if (place.cwd === cwd && !place.stale) return;
    const same = place.cwd === cwd;
    const current = { cwd, view: same ? place.view : null, scopes: same ? place.scopes : null, loading: true, error: false };
    place = current;
    Promise.all([cmd('contextSettings', { cwd }), cmd('contextScopes', {})]).then(([view, scopes]) => {
      if (place !== current) return;
      Object.assign(place, { view, scopes: Array.isArray(scopes?.places) ? scopes.places : [], loading: false }); refresh();
    }).catch(() => {
      if (place !== current) return;
      Object.assign(place, { error: true, loading: false }); refresh();
    });
  }
  /** 「<場所>  <一言>  [この場所の設定を開く]」。押すと設定 › プラグインを、範囲をこのフォルダーにして開く */
  function placeFace(data) {
    const face = el('section', 'scx-place');
    face.setAttribute('aria-label', t('sessionContext.place.aria'));
    const cwd = cwdOf(data) ?? '';
    const text = el('div', 't');
    text.append(el('code', null, cwd));
    const known = Boolean(place.view && place.scopes);
    if (known) {
      const st = placeLine(cwd, place.scopes);
      text.append(el('span', 's' + (st.changed ? ' chg' : ''), st.text));
    }
    if (place.loading || place.error || !known) text.append(stateLine(t(place.error ? 'sessionContext.state.settingsError'
      : place.loading ? (known ? 'sessionContext.state.settingsRefreshing' : 'sessionContext.state.settingsLoading') : 'sessionContext.state.settingsUnknown'),
      { pending: place.loading, error: place.error, retry: place.error ? () => { place.stale = true; refresh(); } : null }));
    const go = button(t('sessionContext.place.open'), 'tbtn', () => openSettings(cwd || null));
    go.dataset.act = 'placeOpen';
    face.append(text, go);
    return face;
  }
  /** この場所の設定を 1 つ変えて保存する。focus は描き直した後に戻す先 */
  async function placeWork(fn, focus) {
    if (placeBusy) return;
    placeBusy = true; notice = '';
    // fn は true（Antigravity・Grok に渡る物が変わった）か、{ fresh, pruned }（上限に届いて外した数も言う）を返す
    try {
      const r = await fn();
      toastFresh = r === true || r?.fresh === true;
      toastPruned = r?.pruned ?? null;
      showToast();
    }
    catch (e) { notice = t('context.saveFailed', { error: e.message }); }
    finally { placeBusy = false; refresh(); if (focus) focusIn(focus); }
  }
  function showToast() {
    toastOn = true;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastOn = false;
      if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        document.querySelector('.scx-toast')?.classList.remove('on');
      }
    }, 1800);
    toastTimer?.unref?.();
  }
  function focusIn(selector) {
    requestAnimationFrame(() => {
      if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        document.querySelector(`.scx ${selector}`)?.focus();
      }
    });
  }

  // ---------------------------------------------------------------- ふだんの種類の面（記録から）
  function instructions(data) {
    const ply = managed(data, 'instruction');
    const rows = data.report.entries.filter(e => e.kind === 'instruction');
    const given = rows.filter(e => e.status === 'supplied' || e.status === 'loaded' || e.status === 'native');
    const k = kindBox(WORD.instruction, ply ? t('sessionContext.instruction.who', { count: given.length }) : t('sessionContext.native'), ply);
    if (!ply) {
      k.append(el('p', 'cx-sub', t('sessionContext.instruction.native', { agent: backendLabel() })));
      // Pleiad が同じ規則で探したもの（指示の量の「推定」の中身）。畳んで出す
      const part = nativeFound(data), found = part.value?.entries;
      const status = nativeStatus(part);
      if (status) k.append(status);
      if (found?.length) {
        const list = el('div');
        grouped(list, found, e => item('·', e.name, shortPath(dir(e.path)), { tokens: e.tokens }).row);
        k.append(fold(t('sessionContext.amount.nativeFound', { count: found.length }), [...list.childNodes]));
      }
      return k;
    }
    grouped(k, given, e => item('✓', e.name, e.status === 'loaded'
      ? t('sessionContext.instruction.loaded', { path: shortPath(dir(e.path)) })
      : e.status === 'native'
        ? `${shortPath(dir(e.path))} · ${t('sessionContext.native')}`
        : shortPath(dir(e.path)), { on: true, tokens: e.tokens }).row);
    if (!given.length) k.append(el('p', 'cx-sub', t('sessionContext.instruction.none')));
    const left = rows.filter(e => !['supplied', 'loaded', 'native'].includes(e.status));
    if (left.length) k.append(fold(t('sessionContext.instruction.notGiven', { count: left.length }), left.map(e => item('–', e.name, `${shortPath(dir(e.path))} · ${reasonOf(e)}`).row)));
    return k;
  }
  function skills(data) {
    const ply = managed(data, 'skill');
    const rows = data.report.entries.filter(e => e.kind === 'skill');
    const offered = rows.filter(e => ['available', 'manual-only', 'loaded', 'native'].includes(e.status));
    const k = kindBox('Skills', ply ? t('sessionContext.skill.who', { count: offered.length }) : t('sessionContext.native'), ply);
    if (!ply) { k.append(el('p', 'cx-sub', t('sessionContext.skill.native', { agent: backendLabel() }))); return k; }
    // 使ったものを先に。多いので最初の数件だけ並べ、残りは畳む
    const sorted = [...offered.filter(e => e.status === 'loaded'), ...offered.filter(e => e.status !== 'loaded')];
    // 同じ名前の定義が複数あったとき、使わなかった方（core/context-runtime.mjs の markChoices）
    const unused = rows.filter(e => e.shadowedBy === 'choice');
    const make = e => {
      const note = e.status === 'loaded' ? t('sessionContext.skill.usedMark') : e.status === 'manual-only' ? t('sessionContext.skill.manualOnly') : e.status === 'native' ? t('sessionContext.native') : '';
      const { row, body } = item('✓', e.name, [shortPath(dir(dir(e.path))), note].filter(Boolean).join(' · '), { on: true });
      if (e.choice) body.append(...skillChoice(e, [e, ...unused.filter(x => x.name === e.name)]));
      return row;
    };
    grouped(k, sorted.slice(0, SKILLS_SHOWN), make);
    if (!offered.length) k.append(el('p', 'cx-sub', t('sessionContext.skill.noneOffered')));
    if (sorted.length > SKILLS_SHOWN) {
      const rest = el('div');
      grouped(rest, sorted.slice(SKILLS_SHOWN), make);
      k.append(fold(t('sessionContext.more', { count: sorted.length - SKILLS_SHOWN }), [...rest.childNodes]));
    }
    if (unused.length) k.append(fold(t('sessionContext.mcp.unusedDefs', { count: unused.length }), unused.map(e => item('–', e.name, `${shortPath(dir(dir(e.path)))} · ${reasonOf(e)}`).row)));
    const other = rows.filter(e => !offered.includes(e) && !unused.includes(e));
    if (other.length) k.append(fold(t('sessionContext.skill.notOffered', { count: other.length }), other.map(e => item('–', e.name, reasonOf(e)).row)));
    return k;
  }
  /** 定義の置き場所の呼び方。出どころ（ユーザー・この場所）がほかの定義と違えばその呼び方、同じ出どころの定義があれば Skills のフォルダー */
  const skillPlace = (x, group) => group.some(g => g !== x && groupOf(g) === groupOf(x)) ? shortPath(dir(dir(x.path))) : t(`sessionContext.findings.scope.${groupOf(x)}`);
  /**
   * 同じ名前の Skill の定義が複数あったとき: どれを使ったかの 1 行と［変更］、開くと定義の選択肢（ADR 0290）。
   * 1 行は記録どおり（このターンに使った方）。選び直したものは次のターンから使うので、違えばその旨を添える
   */
  function skillChoice(used, group) {
    const name = used.name, id = `scx-skill-choice-${String(used.id).replace(/[^\w-]/g, '_')}`;
    const line = el('div', 'ln');
    line.append(el('span', null, t('sessionContext.skill.choice', { n: used.choice.others + 1, place: skillPlace(used, group),
      by: used.choice.by === 'prefer' ? t('sessionContext.mcp.byPrefer') : t('sessionContext.mcp.byFirst') })));
    const open = choiceOpen.has(name);
    const change = button(t('mcp.change'), 'btn', () => { if (open) choiceOpen.delete(name); else choiceOpen.add(name); refresh(); focusIn(`#${CSS.escape(id)}-change`); });
    change.id = `${id}-change`;
    change.setAttribute('aria-expanded', String(open)); change.setAttribute('aria-controls', id);
    line.append(change);
    const saved = here()?.kinds?.skill?.value?.prefer?.[name];
    const pick = group.find(x => saved && samePath(x.path, saved)) ?? used;
    const box = el('div', 'cx-choice'); box.id = id; box.hidden = !open;
    box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', t('mcp.choice.aria', { name }));
    for (const x of group) {
      const label = el('label'), input = el('input');
      input.type = 'radio'; input.name = `${id}-pick`; input.checked = x === pick; input.disabled = placeBusy || !place.view;
      input.onchange = () => saveSkillPrefer(name, x.path, group, `#${CSS.escape(id)} input:checked`);
      label.append(input, el('span', null, t(`sessionContext.findings.scope.${groupOf(x)}`)), el('span', 'cx-mono', shortPath(dir(dir(x.path)))));
      box.append(label);
    }
    return [line, ...(pick !== used ? [el('div', 'p', t('sessionContext.skill.nextTurn', { place: skillPlace(pick, group) }))] : []), box];
  }
  /**
   * 選んだ定義を保存する。この場所の定義が絡むなら この場所に、ユーザーの定義どうしなら今効いている設定（上の場所か全体）に。
   * 設定の画面（設定 › プラグイン › Skills）はユーザーの定義どうしを全体の設定で選ぶので、同じところへ書く
   */
  function saveSkillPrefer(name, file, group, focus) {
    const view = here();
    const target = group.some(x => groupOf(x) !== 'user') ? place.cwd : view?.kinds.skill.from ?? null;
    return placeWork(async () => {
      const value = structuredClone(view?.kinds.skill.value ?? place.view.defaults.kinds.skill.value);
      value.prefer = { ...(value.prefer ?? {}), [name]: file };
      place.view = await cmd('setContextSettings', { cwd: place.cwd, place: target, kind: 'skill', value });
      place.stale = true;   // 変えた数（contextScopes）も読み直す
    }, focus);
  }
  function reasonOf(e) {
    // paths 付きの Claude rules。当たるファイルを扱うまでは渡さない
    if (!e.reason && e.status === 'conditional') return t('sessionContext.reason.conditional', { paths: (e.paths ?? []).join(', ') });
    if (e.reason) return e.reason;
    return REASON[e.status]?.() ?? e.status;
  }
  function fold(summary, rows) {
    const d = el('details', 'cx-fold');
    d.append(el('summary', null, summary), ...rows);
    return d;
  }
  function mcp(data) {
    const ply = managed(data, 'mcp');
    // off にしたのにエージェント自身の側を止められなかった行（nativeLock。作業場所の定義・リンクを作れない PC。ADR 0336）も出す。
    // エージェントが自分でつなぐので「使う」側に置き、一覧と同じ鍵のアイコンと吹き出しで理由を出す
    const rows = data.report.entries.filter(e => e.kind === 'mcp' && (['connected', 'standby', 'starting', 'pending', 'needs-auth', 'failed', 'removed'].includes(e.status)
      || (e.status === 'excluded' && e.nativeLock)));
    const k = kindBox('MCP', ply ? t('sessionContext.mcp.who', { count: rows.filter(e => e.status !== 'removed' && e.status !== 'excluded').length }) : t('sessionContext.native'), ply);
    if (!ply) { nativeMcp(k, data); accountConnectors(k, data); return k; }
    if (!rows.length) k.append(el('p', 'cx-sub', t('sessionContext.mcp.none')));
    const primaryFree = !data.changed?.differs;
    let waiting = false;
    grouped(k, rows, raw => {
      const pending = removedPending.get(raw.name);
      const e = pending ? { ...raw, status: pending.removed ? 'removed' : (raw.status === 'removed' ? 'connected' : raw.status) } : raw;
      const row = el('div', 'scx-item');
      const unstopped = e.status === 'excluded' && Boolean(e.nativeLock);
      const dot = el('span', 'cx-dot' + (e.status === 'connected' || unstopped ? ' on' : e.status === 'starting' ? ' up' : e.status === 'failed' ? '' : ' off'));
      const body = el('div', 't');
      body.append(el('div', 'nm', e.name));
      const p = el('div', 'p');
      const login = logins.get(e.name);
      const where = e.origins?.[0]?.source === 'ply' ? '' : `${shortPath(e.path)} · `;
      if (e.status === 'connected') p.textContent = where + t('sessionContext.mcp.connected', { tools: e.tools ?? 0, usage: e.calls ? t('sessionContext.mcp.calls', { count: e.calls }) : t('sessionContext.mcp.unused') });
      else if (e.status === 'standby') p.textContent = where + t('sessionContext.mcp.standby', { tools: e.tools ?? 0 });
      else if (e.status === 'starting') p.textContent = where + t('sessionContext.mcp.starting');
      else if (e.status === 'pending') p.textContent = where + (e.reason ?? t('sessionContext.mcp.pending'));
      else if (e.status === 'removed') p.textContent = t('sessionContext.mcp.removed');
      else if (unstopped) p.textContent = where + (e.reason ?? '');
      else if (e.status === 'failed') p.append(el('span', 'cx-fail', t('sessionContext.mcp.failed')), ` · ${e.reason ?? t('sessionContext.mcp.unknownReason')}`);
      else {
        waiting = true;
        const oauth = e.auth === 'oauth';
        if (login) p.append(login);
        else p.append(el('span', 'cx-strong', oauth ? t('sessionContext.mcp.needsLogin') : t('sessionContext.mcp.authFailed')),
          t('sessionContext.mcp.authRest', { reason: e.reason && e.reasonCode !== 'MCP_AUTH_REQUIRED' ? t('sessionContext.mcp.reasonParen', { reason: e.reason }) : '' }));
      }
      body.append(p);
      // 同じ名前の定義が複数あったとき、どれを使ったか（core/context-runtime.mjs の markChoices）
      if (e.choice) body.append(el('div', 'p', t('sessionContext.mcp.choice', { n: e.choice.others + 1, source: SOURCE[e.choice.source] ?? e.choice.source ?? '',
        by: e.choice.by === 'prefer' ? t('sessionContext.mcp.byPrefer') : t('sessionContext.mcp.byFirst') })));
      const acts = el('div', 'acts');
      const fromPly = e.origins?.[0]?.source === 'ply';
      if (e.status === 'needs-auth' && fromPly && e.auth === 'oauth' && !login?.dataset?.done) acts.append(button(t('sessionContext.mcp.login'), primaryFree ? 'btn btn-primary' : 'btn btn-quiet', () => startLogin(e.name)));
      if (e.status === 'needs-auth' && e.auth !== 'oauth') acts.append(button(t('sessionContext.mcp.openSettings'), 'btn', () => openSettings()));
      if (unstopped && session()?.backend) acts.append(lockedAgentChip(session().backend, { mode: 'locked', reason: e.nativeLock, state: 'on' }, e.name));
      if (['needs-auth', 'failed', 'removed'].includes(raw.status) || pending) {
        const sw = button('', 'cx-sw', () => setRemoved(e.name, e.status !== 'removed'));
        sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(e.status !== 'removed'));
        sw.setAttribute('aria-label', e.status === 'removed' ? t('sessionContext.mcp.restore') : t('sessionContext.mcp.remove'));
        sw.disabled = Boolean(pending);
        acts.append(sw);
        if (pending?.visible) { const label = el('span', 'pending-label'); label.append(runMark(t('pending.saving')), t('pending.saving')); acts.append(label); }
      }
      if (acts.childNodes.length) body.append(acts);
      row.append(dot, body);
      return row;
    });
    const unused = data.report.entries.filter(e => e.kind === 'mcp' && e.shadowedBy === 'choice');
    if (unused.length) k.append(fold(t('sessionContext.mcp.unusedDefs', { count: unused.length }), unused.map(e => item('–', e.name, `${shortPath(e.path)} · ${reasonOf(e)}`).row)));
    if (waiting) k.append(el('p', 'cx-sub', t('sessionContext.mcp.waiting')));
    accountConnectors(k, data);
    if (notice) k.append(el('p', 'cx-strong', notice));
    return k;
  }
  /**
   * 会話の Claude のアカウント（登録したもの）の claude.ai のコネクター（ADR 0340 段 3。サーバーの sessionConnectorsInfo）。
   * オンで使えるなら名前と状態、オフなら外部 MCP へ、止まっていれば理由と直す先。ログイン中のアカウント・互換の接続先では何も出さない
   */
  // i18n-dynamic: mcp.accounts.status.
  function accountConnectors(k, data) {
    const c = data.claudeConnectors;
    if (!c?.accountId) return;
    k.append(el('p', 'scx-grp', t('sessionContext.connectors.group', { name: c.accountName })));
    const toSettings = (label, cls = 'btn lnk') => button(label, cls, () => openSettings());
    if (c.status === 'off') {
      const row = stateLine(t('sessionContext.connectors.off', { name: c.accountName }));
      row.append(toSettings(t('sessionContext.connectors.turnOn')));
      k.append(row);
      return;
    }
    if (c.status === 'stopped') {
      const key = c.blockKind === 'env' && c.blockScope === 'settings' ? 'settings' : (c.blockKind ?? 'login');
      const text = key === 'expired' ? t('sessionContext.connectors.expired') : t('sessionContext.connectors.stopped', { why: t(`mcp.accounts.status.${key}`) });
      const row = stateLine(text);
      if (['expired', 'login', 'format', 'ownDirLogin', 'keychainAuth'].includes(key) && openAccount) row.append(button(t('sessionContext.connectors.relogin'), 'btn btn-quiet', () => openAccount({ usageLogin: c.accountId })));
      else if (key === 'owner' && openAccount) row.append(button(t('sessionContext.connectors.openAccount'), 'btn btn-quiet', () => openAccount({ focus: c.accountId })));
      else row.append(toSettings(t('sessionContext.connectors.change')));
      k.append(row);
      return;
    }
    if (!Array.isArray(c.connectors)) k.append(el('p', 'cx-sub', t('sessionContext.connectors.unread')));
    else if (!c.connectors.length) k.append(el('p', 'cx-sub', t('sessionContext.connectors.none')));
    else {
      const auth = new Set(c.needsAuth ?? []);
      for (const name of c.connectors) {
        const off = auth.has(name);
        const row = el('div', 'scx-item' + (off ? ' off' : ''));
        const body = el('div', 't');
        body.append(el('div', 'nm', name));
        if (off) body.append(el('div', 'p', t('sessionContext.connectors.needsAuth')));
        row.append(el('span', 'cx-dot ' + (off ? 'off' : 'on')), body);
        k.append(row);
      }
    }
    const foot = el('p', 'scx-cx-foot');
    foot.append(t('sessionContext.connectors.footLead'), toSettings(t('sessionContext.connectors.footLink'), 'cx-link'));
    k.append(foot);
  }
  /** Pleiad の指示（core/ply-instructions.mjs）。直前のターンの記録。項目ごとに入れたか・入れなかった理由、入れた文は畳んで出す */
  function addedBox(data) {
    const items = data.added.map(addedItem), given = items.filter(a => a.inserted);
    const k = kindBox(t('sessionContext.added.title'), given.length ? t('sessionContext.added.who', { count: given.length }) : t('sessionContext.added.none'), given.length > 0);
    for (const a of items) {
      // エージェントで絞った項目は、どのエージェント向けかを添える（効いていない理由が分かるように。2026-10-24）
      const only = a.reason === 'agent' && Array.isArray(a.agents) && a.agents.length
        ? t('sessionContext.added.reason.agentOnly', { agents: a.agents.map(id => labelOf(id)).join(t('sessionContext.chip.join')) }) : '';
      const why = a.inserted ? t('sessionContext.added.inserted') + (a.id === 'route' ? t('sessionContext.added.linked') : '')
        : a.reason === 'target' ? (a.target === 'child' ? t('sessionContext.added.reason.forChild') : t('sessionContext.added.reason.forParent'))
        : only || t(`sessionContext.added.reason.${a.reason}`);
      k.append(item(a.inserted ? '✓' : '–', a.name, why, { on: a.inserted }).row);
    }
    if (given.length) {
      const text = el('div', 'scx-added');
      text.innerHTML = renderMarkdown(given.map(a => a.text).join('\n\n'));
      k.append(fold(t('sessionContext.added.show', { tokens: fmt.number(given.reduce((n, a) => n + estimateTokens(a.text), 0)) }), [text]));
    }
    const p = el('p', 'cx-sub');
    p.append(button(t('sessionContext.added.settings'), 'cx-link', () => openSettings()));
    k.append(p);
    return k;
  }
  /** エージェント任せの MCP。そのエージェントの設定に登録されているもの（読むだけ） */
  function nativeMcp(k, data) {
    const s = session(), label = backendLabel();
    const where = data.report.cwd ?? s?.cwd;
    const cached = agentCache.get(where);
    if (!cached) {
      k.append(el('p', 'cx-sub', t('sessionContext.nativeMcp.reading', { agent: label })));
      cmd('agentMcp', { cwd: where }).then(r => { agentCache.set(where, r); refresh(); }).catch(() => { agentCache.set(where, { agents: {} }); refresh(); });
      return;
    }
    // 読み方を知っているエージェント（エージェントの記述の contextSources）だけが返りに載る
    if (!Object.hasOwn(cached.agents ?? {}, s?.backend)) { k.append(el('p', 'cx-sub', t('sessionContext.nativeMcp.unreadable', { agent: label }))); return; }
    const list = cached.agents[s.backend] ?? [];
    if (!list.length) { k.append(el('p', 'cx-sub', t('sessionContext.nativeMcp.none', { agent: label }))); return; }
    k.append(el('p', 'cx-sub', t('sessionContext.nativeMcp.list', { agent: label, count: list.length })));
    // off にしたのに止められなかった名前（記録の unstopped。ADR 0336）は、右端に設定の一覧と同じ鍵つきのアイコン
    const locks = new Map((data.report.unstopped ?? []).map(u => [u.name, u.nativeLock]));
    const rowOf = x => {
      const r = el('div', 'scx-item'); const body = el('div', 't');
      body.append(el('div', null, x.name), el('div', 'p', x.disabled ? t('sessionContext.nativeMcp.disabled', { path: shortPath(x.path) }) : shortPath(x.path)));
      r.append(el('span', 'cx-dot off'), body);
      if (locks.has(x.name) && !x.disabled) { const acts = el('div', 'acts'); acts.append(lockedAgentChip(s.backend, { mode: 'locked', reason: locks.get(x.name), state: 'on' }, x.name)); r.append(acts); }
      return r;
    };
    list.slice(0, 5).forEach(x => k.append(rowOf(x)));
    if (list.length > 5) k.append(fold(t('sessionContext.more', { count: list.length - 5 }), list.slice(5).map(rowOf)));
  }

  // ---------------------------------------------------------------- Hooks（エージェントの設定で見つかった定義と、受け取った発火の記録）
  // 取り直すのは会話・場所・エージェントが変わったとき。Claude の会話は、ターンが終わったときも取り直す（発火の記録がターンの終わりに残る）。
  // Codex の信頼状態はターンでは変わらないので、ターンの開始・終わりでは hooks/list を呼ばない
  function loadHooks(data, force = false) {
    const s = session(), cwd = cwdOf(data), running = isRunning();
    const key = [s?.id, cwd, s?.backend, data.report?.at ?? ''].join('|');
    const turnEnded = s?.backend === 'claude' && hooks.running && !running;
    hooks.running = running;
    if (!force && !turnEnded && hooks.key === key) return;
    const keep = hooks.key?.split('|')[0] === s?.id ? hooks.data : null;
    hooks = { key, data: keep, running };
    const args = { sessionId: s?.id, cwd, backend: s?.backend };
    cmd('sessionHooks', args)
      .then(r => {
        if (hooks.key !== key) return;
        hooks.data = r; refresh();
        // Codex の信頼状態は一覧を出した後に重ねる（app-server の起動を待たせない）
        if (r?.report?.trustPending) cmd('sessionHooks', { ...args, trust: true }).then(t2 => { if (hooks.key === key) { hooks.data = t2; refresh(); } }).catch(() => {});
      })
      .catch(e => { if (hooks.key === key) { hooks.data = { failed: e.message }; refresh(); } });
  }
  /** Hooks を渡せるエージェントの名前（能力の印 hooks の宣言から。固定の一覧は持たない。渡せない会話の説明に出す） */
  function hookAgentNames() {
    const part = backendCache.get('backends');
    const list = Array.isArray(part?.value) ? part.value : [];
    return list.filter(b => b.capabilities?.hooks).map(b => labelOf(b.id)).join(t('app.listSeparator'));
  }
  function hookBoxes(data) {
    loadHooks(data);
    const h = hooks.data;
    // Hooks を Pleiad がそろえた会話: そのターンの記録（渡した・止めた・渡せなかった・漏れ）と発火の記録
    if (h?.unify?.owner === 'ply') {
      return [unifySessionBox(h.unify, { kindBox, short: shortPath, agents: hookAgentNames() }), hookRuns(h)];
    }
    const k = kindBox('Hooks', t('sessionContext.native'), false);
    if (!h) { k.append(el('p', 'cx-sub', t('sessionContext.hooks.reading'))); return [k]; }
    if (h.failed) { k.append(el('p', 'cx-sub', t('sessionContext.hooks.failed', { error: h.failed }))); return [k]; }
    if (h.unify?.unsupportedAgent || (h.owner === 'ply' && !h.agent)) { k.append(el('p', 'cx-sub', unsupportedAgentText(hookAgentNames()))); return [k]; }
    if (!h.agent || !h.report) { k.append(el('p', 'cx-sub', t('sessionContext.hooks.unknownAgent', { agent: backendLabel() }))); return [k]; }
    k.append(el('p', 'cx-sub', h.observable ? t('sessionContext.hooks.lead') : t('sessionContext.hooks.leadUnobserved')));
    const ctx = { cmd, scan: h.report, short: shortPath, onSaved: async () => { showToast(); loadHooks(info() ?? data, true); } };
    for (const f of h.report.files.filter(f => f.status === 'error')) k.append(el('p', 'cx-strong', t('sessionContext.hooks.fileError', { path: shortPath(f.path), error: f.error ?? '' })));
    const entries = h.report.entries.slice().sort((a, b) => order(h.report, a.event) - order(h.report, b.event));
    // 出どころの区切りは他の種類と同じ（ユーザー／この場所と親フォルダー）。Skill の hooks は Skill の置き場で分ける
    const mine = e => ['user', 'plugin', 'managed'].includes(e.scope) || e.skillScope === 'user' ? 'user' : 'directory';
    // ユーザーの定義は設定の画面で見る・直すもの。ここでは数件だけ並べて残りは畳み、パスと編集は作業場所の定義にだけ付ける
    const makeRow = ({ hook: e }) => {
      const bits = [e.event, e.matcher !== null && e.matcher !== undefined ? e.matcher || '*' : null,
        e.agent === 'codex' ? codexState(e) : null, e.agent === 'antigravity' && !e.enabled ? t('hooks.state.agyOff') : null,
        e.stoppedBySameName ? t('hooks.state.agySame') : null, ['plugin', 'managed'].includes(e.scope) ? scopeLabel(e) : null,
        e.scope === 'skill' ? t('sessionContext.hooks.skill', { name: e.skill ?? '' }) : null, t('sessionContext.hooks.registered')].filter(Boolean);
      const row = el('div', 'scx-item');
      const dot = el('span', 'cx-dot off'); dot.setAttribute('aria-hidden', 'true');
      const body = el('div', 't');
      body.append(el('div', 'nm', rowName(e)), el('div', 'p', bits.join(' · ')));
      if (mine(e) !== 'user') body.append(el('div', 'p cx-mono', shortPath(e.path)));
      if (e.editable && mine(e) !== 'user') {
        const acts = el('div', 'acts');
        const edit = button(t('hooks.edit'), 'btn', () => openHookSheet(ctx, { entry: e }));
        edit.setAttribute('aria-label', t('sessionContext.hooks.editAria', { name: rowName(e) }));
        acts.append(edit);
        body.append(acts);
      }
      row.append(dot, body);
      return row;
    };
    const rows = entries.map(e => ({ root: null, scope: mine(e), hook: e }));
    const users = rows.filter(r => r.scope === 'user'), places = rows.filter(r => r.scope !== 'user');
    grouped(k, users.slice(0, HOOKS_SHOWN), makeRow);
    if (users.length > HOOKS_SHOWN) k.append(fold(t('sessionContext.more', { count: users.length - HOOKS_SHOWN }), users.slice(HOOKS_SHOWN).map(makeRow)));
    grouped(k, places, makeRow);
    if (!entries.length) k.append(el('p', 'cx-sub', t('sessionContext.hooks.none', { agent: agentLabel(h.agent) })));
    const add = el('p', 'cx-sub');
    add.append(button(t('sessionContext.hooks.add'), 'cx-link', () => openHookSheet(ctx, { agents: [h.agent], scope: 'project', base: h.cwd })));
    k.append(add);
    return [k, hookRuns(h)];
  }
  /** 発火の記録。開始と応答を hook_id で組にする。応答が無いものは「開始を受信 · 完了は未確認」のまま（推定で完了にしない） */
  function hookRuns(h) {
    const k = kindBox(t('sessionContext.hooks.runsTitle'), h.observable ? t('sessionContext.hooks.runsWho') : t('sessionContext.hooks.unobservable'), false);
    if (!h.observable) { k.append(el('p', 'cx-sub', t('sessionContext.hooks.unobservedNote', { agent: agentLabel(h.agent) }))); return k; }
    // Antigravity は Pleiad が渡した分だけ（アダプターの記録）。止めたネイティブの定義が走ったかは分からない
    if (h.observed === 'pleiad') k.append(el('p', 'cx-sub', t('hooks.unify.session.observedPleiad')));
    const runs = [], byId = new Map();
    for (const r of h.runs ?? []) {
      const known = r.hookId && byId.get(r.hookId);
      if (r.phase === 'response' && known && !known.response) { known.response = r; continue; }
      const run = r.phase === 'started' ? { started: r } : { response: r };
      runs.push(run);
      if (r.hookId) byId.set(r.hookId, run);
    }
    if (!runs.length) { k.append(el('p', 'cx-sub', t('sessionContext.hooks.noRuns'))); return k; }
    // 通知の名前は「イベント:matcher」。同じイベント・matcher の定義が 1 つだけなら、その定義の名前で出す。結べなければイベントだけ
    const defs = (h.report?.entries ?? []).filter(e => e.agent === 'claude');
    const titleOf = r => {
      // Pleiad が渡した定義（コールバック・sessionFlags・アダプターの記録）は登録の名前
      if (r.pleiad) return t('hooks.unify.session.runPleiad', { name: r.name || eventLabel(r.event) });
      const at = String(r.name ?? '').indexOf(':'), matcher = at < 0 ? null : r.name.slice(at + 1);
      const hits = defs.filter(e => e.event === r.event && (matcher === null ? !e.matcher || e.matcher === '*' : e.matcher === matcher));
      return hits.length === 1 ? rowName(hits[0]) : eventLabel(r.event);
    };
    const make = run => {
      const r = run.response ?? run.started, done = run.response;
      const mark = !done ? '○' : done.outcome === 'success' || done.outcome === 'blocked' ? '✓' : done.outcome === 'cancelled' ? '–' : '×';
      // blocked は Codex の「hook がツールを止めた」（hook 自身は動いて答えた）
      const what = !done ? t('sessionContext.hooks.startedOnly') : done.outcome === 'success' ? t('sessionContext.hooks.done')
        : done.outcome === 'blocked' ? t('hooks.unify.session.blocked')
        : done.outcome === 'cancelled' ? t('sessionContext.hooks.cancelled') : t('sessionContext.hooks.failedRun');
      const bits = [stamp(run.started?.at ?? r.at, false), r.event, what, r.leak ? t('hooks.unify.session.leakRun') : null, r.unknownNative ? t('hooks.unify.session.unknownNativeRun') : null,
        !r.pleiad && r.source && r.source !== 'unknown' ? t(`hooks.scope.${r.source === 'user' || r.source === 'project' || r.source === 'plugin' ? r.source : 'managed'}`) : null];
      if (Number.isInteger(done?.exitCode)) bits.push(t('sessionContext.hooks.exit', { code: done.exitCode }));
      if (done && run.started) bits.push(t('sessionContext.hooks.ms', { ms: Number.isInteger(done.ms) ? done.ms : Math.max(0, done.at - run.started.at) }));
      return item(mark, titleOf(r), bits.filter(Boolean).join(' · '), { on: done?.outcome === 'success' }).row;
    };
    const recent = runs.slice(-8);
    for (const run of recent) k.append(make(run));
    if (runs.length > recent.length) k.append(fold(t('sessionContext.more', { count: runs.length - recent.length }), runs.slice(0, -8).map(make)));
    k.append(el('p', 'cx-sub', t('sessionContext.hooks.runsNote')));
    return k;
  }

  function changedNotice(data) {
    const files = data.changed.files ?? (data.changed.paths ?? []).map(path => ({ path, name: base(path) }));
    const box = el('div', 'scx-notice'); box.setAttribute('role', 'status');
    const head = el('p');
    head.append(el('span', 'cx-strong', t('sessionContext.changed.title', { count: files.length || 1 })));
    for (const f of files.slice(0, 3)) {
      const name = f.name ?? base(f.path);
      const what = f.after === null && f.before ? t('sessionContext.changed.removed', { name }) : !f.before ? t('sessionContext.changed.added', { name })
        : f.modifiedAt ? t('sessionContext.changed.updatedAt', { name, time: stamp(f.modifiedAt, !sameDay(f.modifiedAt, Date.now())) }) : t('sessionContext.changed.updated', { name });
      head.append(el('br'), el('span', 'cx-sub', what));
    }
    if (files.length > 3) head.append(el('br'), el('span', 'cx-sub', t('sessionContext.more', { count: files.length - 3 })));
    const acts = el('div', 'acts');
    const go = button(t('sessionContext.changed.continue'), 'btn btn-primary', () => refreshNow(go));
    if (busy && refreshLoadingVisible) go.replaceChildren(runMark(t('pending.reloading')), t('pending.reloading'));
    go.disabled = busy || isRunning();
    if (isRunning()) go.title = t('sessionContext.changed.afterReply');
    acts.append(go, button(diffOpen ? t('sessionContext.changed.hideDiff') : t('sessionContext.changed.showDiff'), 'btn', toggleDiff));
    box.append(head, acts, el('p', 'cx-sub', t('sessionContext.changed.note')));
    if (diffOpen) box.append(diffBody());
    return box;
  }
  function diffBody() {
    const box = el('div', 'scx-diff');
    if (!diff) { box.append(el('p', 'cx-sub', t('sessionContext.diff.loading'))); return box; }
    if (diff.error) { box.append(el('p', 'cx-strong', diff.error)); return box; }
    if (!diff.files.length) { box.append(el('p', 'cx-sub', t('sessionContext.diff.noChange'))); return box; }
    for (const f of diff.files) {
      box.append(el('h5', null, f.path));
      if (f.beforeMissing) box.append(el('p', 'cx-sub', t('sessionContext.diff.beforeMissing')));
      if (f.removed) { box.append(el('p', 'cx-sub', t('sessionContext.diff.removed'))); continue; }
      if (f.after === null) { box.append(el('p', 'cx-sub', t('sessionContext.diff.tooLarge'))); continue; }
      box.append(diffView(lineDiff(f.beforeMissing ? '' : f.before ?? '', f.after)));
    }
    return box;
  }
  async function toggleDiff() {
    diffOpen = !diffOpen;
    if (diffOpen && !diff) {
      refresh();
      const id = session()?.id;
      diff = await cmd('contextDiff', { sessionId: id }).catch(e => ({ error: t('sessionContext.diff.failed', { error: e.message }) }));
      if (session()?.id !== id) return;
    }
    refresh();
  }
  async function refreshNow(go) {
    if (busy) return;
    busy = true; go.disabled = true; notice = '';
    refreshLoadingVisible = false;
    const timer = setTimeout(() => { refreshLoadingVisible = true; refresh(); }, 150);
    const id = session()?.id;
    try {
      await cmd('refreshContext', { sessionId: id });
      diff = null; diffOpen = false;
      await refreshInfo(true);
    } catch (e) { notice = t('sessionContext.refreshFailed', { error: e.message }); }
    finally { clearTimeout(timer); busy = false; refreshLoadingVisible = false; refresh(); }
  }
  async function setRemoved(name, removed) {
    if (removedPending.has(name)) return;
    notice = '';
    const pending = { removed, visible: false };
    removedPending.set(name, pending);
    refresh();
    const timer = setTimeout(() => { pending.visible = true; refresh(); }, 150);
    try {
      await cmd('setSessionMcp', { sessionId: session()?.id, name, removed });
      await refreshInfo(true);
    } catch (e) { notice = e.message; }
    finally { clearTimeout(timer); removedPending.delete(name); }
    refresh();
  }
  async function startLogin(name) {
    try {
      const started = await cmd('mcpAuthStart', { name });
      const span = el('span');
      span.append(t('sessionContext.login.continue'));
      if (/^https?:\/\//i.test(started.url ?? '')) {
        const a = el('a', 'cx-link', t('sessionContext.login.link'));
        a.href = started.url; a.target = '_blank'; a.rel = 'noreferrer';
        span.append(a);
      }
      logins.set(name, span);
    } catch (e) { logins.set(name, document.createTextNode(t('sessionContext.login.startFailed', { error: e.message }))); }
    refresh();
  }
  window.addEventListener('ply:mcp-auth', e => {
    const ev = e.detail ?? {};
    if (!logins.has(ev.name) && !info()?.report?.entries?.some(x => x.kind === 'mcp' && x.name === ev.name)) return;
    if (ev.phase === 'done') { const done = el('span', null, t('sessionContext.login.done')); done.dataset.done = '1'; logins.set(ev.name, done); }
    else if (ev.phase === 'error') logins.set(ev.name, document.createTextNode(ev.message ? t('sessionContext.login.failedWith', { error: ev.message }) : t('sessionContext.login.failed')));
    else return;
    refresh();
  });

  // ---------------------------------------------------------------- 開閉
  function open(element) {
    chip = element ?? chip;
    const data = info() ?? {};
    // 開くたびに作業場所の設定を読み直す（設定の画面や別の窓で変わっていることがある）。エージェント任せの指示の見積もりも同じ
    place.stale = true;
    for (const part of backendCache.values()) if (!part.pending) part.stale = true;
    for (const cache of [nativeCache, findingsCache]) for (const part of cache.values()) if (!part.pending) part.stale = true;
    preview.openPanel({ key: KEY, title, subtitle: data.report ? subtitle(data) : '', body: render(), label: title, element: chip,
      onClose: () => { chip?.setAttribute('aria-expanded', 'false'); } });
  }
  /** 記録が変わったとき（ターンの開始・読み込み直し・外す）。開いていれば描き直す */
  function refresh() {
    // 閉じているときは描かない（描くと作業場所の設定やエージェント任せの指示の見積もりを読みに行く）
    if (preview.panelOpen(KEY)) {
      const data = info() ?? {};
      preview.updatePanel(KEY, { subtitle: data.report ? subtitle(data) : '', body: render() });
    }
  }
  return { open, refresh, isOpen: () => preview.panelOpen(KEY) };
}
