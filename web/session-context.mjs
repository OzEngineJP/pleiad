// ==================== 会話の右パネル「この会話のコンテキスト」（docs/design-system.md「コンテキスト」） ====================
// 会話の頭の札（指示 2 · Skills 14 · MCP … · Pleiad の指示 3）を押すと、ファイルプレビューと同じ右パネルに開く（web/file-preview.mjs の openPanel）。
// 一番上は作業場所の面: 「<場所> · 全体の設定どおり／<親の場所> の設定どおり／このフォルダーだけの設定 · n 項目」と「この場所だけ変える」。
// そのすぐ下が指示の量の面（ADR 0056）: 毎ターン最初に読み込まれる指示の合計と、ユーザー／この場所と親フォルダー／Pleiad が足す分の積み上げ、
//   自分で書いた分にだけ引く目安の線。エージェント任せの指示は、そのエージェントの規則で Pleiad が探した結果を数えて「推定」と添える。
//   同じ面の中に「気になる所」（違うファイルのほぼ同じ段落と、もう無いパス。contextFindings）を件数付きで畳む（0 件も完了を残す）。
//   面の最後が「見直しを頼む」: 同じ作業場所に未送信の新しい会話を作り、入力欄に依頼文の下書きを入れて開く（送らない。askReview）
//   変えている間（edit）は、この場所の設定（places。core/context-settings.mjs）で探した結果を並べ、担当と行のスイッチでこのフォルダーだけ変える
//   （「全体の設定に戻す」「終わる」）。保存は次のターンから効く。
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
import { toggleExclude, toggleExcludeMany } from './context.mjs';
import {
  CONTEXT_TABS, readTabStorage, writeTabStorage,
  groupEntries, bundleSwitchState, entryOrigins, originMarks, chevronIcon, createTabBar, createFindBar,
} from './context-tabs.mjs';
import { toggleMcp, unifyConfirm } from './mcp-config.mjs';
import { lockedAgentChip } from './mcp-matrix.mjs';
import { openHookSheet, openCopySheet, copyBlocked, agentLabel, rowName, eventLabel, order, codexState, scopeLabel } from './hooks-card.mjs';
import { unifySessionBox, unifyConfirmPanel, resetPlan, unsupportedAgentText } from './hooks-unify-ui.mjs';

const KEY = 'session-context';
const KINDS = ['instruction', 'skill', 'mcp'];
const WORD = { instruction: t('sessionContext.word.instruction'), skill: 'Skills', mcp: 'MCP' };
// backend-allow: 読み込み元（core/context-settings.mjs の SOURCES）の名前。エージェントの id と同じ語だが、エージェントの分岐ではない
const SOURCE = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', devin: 'Devin', antigravity: 'Antigravity', grok: 'Grok', common: t('sessionContext.source.common'), ply: 'Pleiad' };
const GROUPS = ['user', 'dir', 'extra'];
// 「この場所だけ変える」の担当の 2 択（設定の画面と同じ文）
const OWNER = {
  native: [t('context.owner.agent'), { instruction: t('context.instruction.agent'), skill: t('context.skill.agent'), mcp: t('context.mcp.agent') }],
  ply: [t('context.owner.ply'), { instruction: t('context.instruction.ply'), skill: t('context.skill.ply'), mcp: t('context.mcp.ply') }],
};
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
const escCss = s => globalThis.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
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
/** Pleiad が担当した種類か（antigravity で扱わなかった会話は、担当が Pleiad でもエージェント任せ） */
const managed = (info, kind) => info?.report?.status !== 'native' && (info.owners ?? info.report?.owners ?? {})[kind] === 'ply';
/** Pleiad の指示の記録 1 件。前の版の記録（{ id: 'delegation', variant, text }）も読む */
const addedItem = a => ({ ...a, inserted: a.inserted ?? Boolean(a.variant), name: a.name ?? t('sessionContext.added.delegation') });

/**
 * 作業場所の面の一言。here は contextSettings の今の場所（places の current）。
 * このフォルダーだけの上書きがあれば「このフォルダーだけの設定 · n 項目」、上の場所の上書きに従っていれば「<場所> の設定どおり」
 */
export function placeStatus(here) {
  if (!here) return { over: false, text: t('sessionContext.place.default'), count: 0 };
  const own = here.saved ? here.overrides : 0;
  if (own) return { over: true, text: t('sessionContext.place.override', { count: own }), count: own };
  const from = [...KINDS.map(k => here.kinds?.[k]?.from), ...KINDS.map(k => here.roots?.[k]?.from)].find(Boolean);
  return { over: false, text: from ? t('sessionContext.place.from', { path: shortPath(from) }) : t('sessionContext.place.default'), count: 0 };
}

// i18n-dynamic: sessionContext.state.
// i18n-dynamic: sessionContext.amount.reading
// i18n-dynamic: sessionContext.group.
// i18n-dynamic: sessionContext.added.reason.
// i18n-dynamic: sessionContext.amount.part.
// i18n-dynamic: sessionContext.findings.scope.
export function setupSessionContext({ cmd, preview, session, info, refreshInfo, openSettings, labelOf, isRunning = () => false, budget = () => DEFAULT_BUDGET, askReview = null }) {
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
  // 作業場所の設定（contextSettings）と、「この場所だけ変える」の間の探索結果
  let place = { cwd: null, view: null, loading: false }, edit = false, editScan = null, editBusy = false, toastTimer = null, toastOn = false;
  // この場所の外部 MCP を「Pleiad がそろえる」へ切り替える前の確認を開いているか（ADR 0031）
  let unifying = false;
  // Hooks（sessionHooks の戻り）。会話・場所・実行中かが変わったら取り直す
  let hooks = { key: null, data: null };
  // 「この場所だけ変える」の間の Hooks の担当（plyHooks { cwd }）と、開いている切り替えの確認（'ply' | 'native' | null。ADR 0049）
  let hooksPlace = { cwd: null, view: null }, hooksConfirm = null;
  // 同じ名前の Skill の定義の選択肢を［変更］で開いている名前（ADR 0290）
  const choiceOpen = new Set();
  // 「この場所だけ変える」の 4 タブ・フォルダーのまとまり・Skills 絞り込み（段 1）
  const EDIT_TAB_KEY = 'ply-session-context-tab';
  let editTab = readTabStorage(EDIT_TAB_KEY, CONTEXT_TABS, 'instruction');
  const editBundleOpen = new Map();
  let editSkillQuery = '', editSkillHost = null, skillPaintArgs = null;
  let lastTabBar = null, lastTabPanels = null;
  const editSkillFind = createFindBar({
    placeholder: t('context.find.placeholder'),
    ariaLabel: t('context.find.aria'),
    onInput: q => {
      editSkillQuery = q;
      if (editSkillHost && editSkillHost.isConnected !== false && skillPaintArgs) {
        paintEditEntries(editSkillHost, 'skill', skillPaintArgs.entries, skillPaintArgs.offText);
      }
    },
  });
  const resetEditState = () => { editBundleOpen.clear(); editSkillQuery = ''; editSkillFind.clear(); editSkillHost = null; skillPaintArgs = null; };

  const title = t('sessionContext.title');
  function subtitle(data) {
    const started = data.startedAt ?? data.report?.at;
    const text = started ? t('sessionContext.subtitle.startedAt', { time: stamp(started) }) : t('sessionContext.subtitle.started');
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
    // 別の会話へ移った。前の会話の差分・ログインの途中経過・変えている途中は持ち越さない
    if (session()?.id !== shownFor) { shownFor = session()?.id ?? null; diff = null; diffOpen = false; notice = ''; reviewError = ''; logins.clear(); removedPending.clear(); edit = false; editScan = null; unifying = false; hooksConfirm = null; choiceOpen.clear(); resetEditState(); }
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
    if (!edit) box.append(amountFace(data));
    if (data.changed?.differs && !edit) box.append(changedNotice(data));
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
    if (edit) {
      const tabBar = createTabBar({
        tabs: [
          { id: 'instruction', label: t('context.tabs.instruction') },
          { id: 'skill', label: t('context.tabs.skill') },
          { id: 'mcp', label: t('context.tabs.mcp') },
          { id: 'hooks', label: t('context.tabs.hooks') },
        ],
        active: editTab,
        idPrefix: 'scx',
        ariaLabel: t('context.tabs.aria'),
        onSelect: (id, opts) => selectEditTab(id, opts),
      });
      tabBar.setCounts(editCounts());
      const panels = Object.fromEntries(CONTEXT_TABS.map(id => {
        const p = el('div', 'cx-tabpanel');
        p.id = `scx-panel-${id}`;
        p.setAttribute('role', 'tabpanel');
        p.setAttribute('aria-labelledby', `scx-tab-${id}`);
        p.hidden = id !== editTab;
        return [id, p];
      }));
      panels.instruction.append(editFace('instruction'), ...(data.added?.length ? [addedEditFace()] : []));
      panels.skill.append(editFace('skill'));
      panels.mcp.append(editFace('mcp'));
      panels.hooks.append(hooksEditFace());
      lastTabBar = tabBar;
      lastTabPanels = panels;
      // 保存に失敗したときの知らせ（編集中は種類ごとの面に出る場所が無いので、タブ帯の上に出す）
      if (notice) { const f = el('p', 'cx-status', notice); f.setAttribute('role', 'alert'); box.append(f); }
      box.append(tabBar.root, ...CONTEXT_TABS.map(id => panels[id]));
    } else {
      lastTabBar = null;
      lastTabPanels = null;
      box.append(instructions(data));
      if (data.added?.length) box.append(addedBox(data));
      box.append(skills(data), mcp(data), ...hookBoxes(data));
    }
    const foot = el('p', 'scx-foot');
    foot.append(t('sessionContext.foot.lead'), button(t('sessionContext.foot.link'), 'cx-link', () => openSettings()));
    box.append(foot);
    const toast = el('div', 'cx-toast scx-toast' + (toastOn ? ' on' : ''), t('context.saved')); toast.setAttribute('role', 'status');
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
    const rows = managedHere ? data.report.entries.filter(e => e.kind === 'instruction' && e.status === 'supplied') : native?.value?.entries ?? [];
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
    if (!cwd) { place = { cwd, view: null, loading: false }; return; }
    if (place.cwd === cwd && !place.stale) return;
    const current = { cwd, view: place.cwd === cwd ? place.view : null, loading: true, error: false };
    place = current;
    cmd('contextSettings', { cwd }).then(view => {
      if (place !== current) return;
      Object.assign(place, { view, loading: false }); refresh();
    }).catch(() => {
      if (place !== current) return;
      Object.assign(place, { error: true, loading: false }); refresh();
    });
  }
  function placeFace(data) {
    const face = el('section', 'scx-place');
    face.setAttribute('aria-label', t('sessionContext.place.aria'));
    const text = el('div', 't');
    text.append(el('span', 'cx-path', cwdOf(data) ?? ''));
    const st = placeStatus(here());
    const line = el('div', 'p' + (st.over ? ' over' : ''), st.text + (edit && !st.over ? t('sessionContext.place.willOverride') : ''));
    if (here()) text.append(line);
    if (place.loading || place.error || !here()) text.append(stateLine(t(place.error ? 'sessionContext.state.settingsError'
      : place.loading ? (here() ? 'sessionContext.state.settingsRefreshing' : 'sessionContext.state.settingsLoading') : 'sessionContext.state.settingsUnknown'),
      { pending: place.loading, error: place.error, retry: place.error ? () => { place.stale = true; refresh(); } : null }));
    const acts = el('div', 'acts');
    if (edit) {
      if (st.over) acts.append(button(t('sessionContext.place.reset'), 'btn', () => placeWork(async () => {
        place.view = await cmd('setContextSettings', { cwd: place.cwd, place: place.cwd, remove: true });
        await loadEditScan();
      }, '[data-act=placeDone]')));
      const done = button(t('sessionContext.place.done'), 'btn btn-quiet', () => { edit = false; editScan = null; resetEditState(); refresh(); focusIn('[data-act=placeStart]'); });
      done.dataset.act = 'placeDone';
      acts.append(done);
    } else {
      const start = button(t('sessionContext.place.start'), 'btn btn-quiet', () => startEdit());
      start.dataset.act = 'placeStart';
      start.disabled = place.loading || place.error || !here();
      acts.append(start);
    }
    face.append(text, acts);
    return face;
  }
  async function startEdit() {
    edit = true; editScan = null; unifying = false; hooksConfirm = null; resetEditState();
    hooksPlace = { cwd: place.cwd, view: null };
    cmd('plyHooks', { cwd: place.cwd }).then(v => { if (hooksPlace.cwd === place.cwd) { hooksPlace.view = v; refresh(); } }).catch(() => {});
    refresh();
    focusIn('[data-act=placeDone]');
    await loadEditScan();
  }
  async function loadEditScan() {
    const cwd = place.cwd;
    for (let i = 0; i < 20; i++) {
      try { editScan = await cmd('scanContext', { cwd }); break; }
      catch (e) {
        if (e.code !== 'SCAN_BUSY') { notice = t('sessionContext.place.scanFailed', { error: e.message }); editScan = { entries: [] }; break; }
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if (place.cwd === cwd) refresh();
  }
  /** この場所の設定を 1 つ変えて保存し、探し直す。focus は描き直した後に戻す先 */
  async function placeWork(fn, focus) {
    if (editBusy) return;
    editBusy = true; notice = '';
    try { await fn(); showToast(); }
    catch (e) { notice = t('context.saveFailed', { error: e.message }); }
    finally { editBusy = false; refresh(); if (focus) focusIn(focus); }
  }
  /** この場所で効いている種類の設定を写して変え、この場所の上書きとして保存する（全体と同じになれば上書きは消える） */
  function savePlaceKind(kind, mutate, focus) {
    return placeWork(async () => {
      const value = structuredClone(here()?.kinds[kind].value ?? place.view.defaults.kinds[kind].value);
      mutate(value);
      place.view = await cmd('setContextSettings', { cwd: place.cwd, place: place.cwd, kind, value });
      await loadEditScan();
    }, focus);
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

  // ---------------------------------------------------------------- 「この場所だけ変える」の間の種類の面
  function contextSupport() {
    const part = backendCache.get('backends');
    const backend = Array.isArray(part?.value) ? part.value.find(b => b.id === session()?.backend) : null;
    const pending = !part || part.pending;
    const confirmed = !pending && !part.error;
    return { part, pending, supported: confirmed && ['turn', 'conversation'].includes(backend?.capabilities?.plyContext),
      unsupported: confirmed && backend?.capabilities?.plyContext === false };
  }
  function ownerSeg(kind, owner) {
    const box = el('div', 'cx-seg'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', t('sessionContext.place.ownerAria', { kind: WORD[kind] }));
    for (const id of ['native', 'ply']) {
      const b = button('', 'cx-opt');
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(owner === id)); b.dataset.owner = `${kind}:${id}`;
      b.append(el('b', null, OWNER[id][0]), el('span', null, OWNER[id][1][kind]));
      const support = contextSupport();
      b.disabled = id === 'ply' && !support.supported;
      if (id === 'ply' && support.unsupported) b.title = t('sessionContext.guarded.unavailable', { backend: backendLabel() });
      else if (id === 'ply' && !support.pending && !support.supported) b.title = t('sessionContext.guarded.supportUnknown');
      b.onclick = () => {
        if (b.disabled) return;
        // 外部 MCP を Pleiad にそろえる前に、この場所でつながるものをその場で確かめる（設定 › コンテキストと同じ。ADR 0031）
        if (kind === 'mcp' && unifying) {
          if (id !== 'ply') { unifying = false; refresh(); focusIn(`[data-owner="mcp:${id}"]`); }
          else focusIn('.cx-confirm .btn-primary:not(:disabled)');
          return;
        }
        if (kind === 'mcp' && id === 'ply' && owner !== 'ply' && (!editScan || (editScan.entries ?? []).some(e => e.kind === 'mcp'))) {
          unifying = true; refresh(); focusIn('.cx-confirm .btn-primary:not(:disabled)');
          return;
        }
        if (owner !== id) savePlaceKind(kind, v => { v.owner = id; }, `[data-owner="${kind}:${id}"]`);
      };
      box.append(b);
    }
    return box;
  }
  function editFace(kind) {
    const value = here()?.kinds[kind].value ?? place.view?.defaults.kinds[kind].value;
    // 外部 MCP が名前 × エージェントの設定（agents）のときは、この場所だけの 2 択は効かない。設定 › プラグインで変える
    if (kind === 'mcp' && value?.agents) {
      const k = kindBox(WORD[kind], t('sessionContext.place.mcpByAgentWho'), true);
      k.append(el('p', 'cx-sub', t('sessionContext.place.mcpByAgent')));
      return k;
    }
    const ply = value?.owner === 'ply';
    const k = kindBox(WORD[kind], ply ? t('sessionContext.place.plyWho') : t('sessionContext.native'), ply);
    if (!value) { k.append(el('p', 'cx-sub', t('sessionContext.place.loading'))); return k; }
    k.append(ownerSeg(kind, value.owner));
    const support = contextSupport();
    if (!support.supported) {
      if (support.pending) k.append(stateLine(t('sessionContext.state.loading'), { pending: true }));
      else if (support.unsupported) k.append(el('p', 'cx-sub', t('sessionContext.guarded.unavailable', { backend: backendLabel() })));
      else k.append(stateLine(t('sessionContext.guarded.supportUnknown'), { error: true, retry: () => retryPart(support.part) }));
      return k;
    }
    if (!ply && kind === 'mcp' && unifying && !editScan) { const p = el('p', 'cx-sub'); p.append(runMark(t('context.searching')), document.createTextNode(' ' + t('context.searchingDots'))); k.append(p); return k; }
    if (!ply && kind === 'mcp' && unifying) {
      const all = editScan.entries ?? [];
      const of = name => all.filter(e => e.kind === 'mcp' && e.name === name);
      k.append(unifyConfirm({ entries: all,
        onCancel: () => { unifying = false; refresh(); focusIn('[data-owner="mcp:ply"]'); },
        // 担当と除外をまとめて 1 回で保存する
        onConfirm: ({ on, off }) => { unifying = false; savePlaceKind('mcp', v => {
          v.owner = 'ply';
          for (const name of off) toggleMcp(v, name, of(name), false, all);
          for (const name of on) toggleMcp(v, name, of(name), true, all);
        }, '[data-owner="mcp:ply"]'); } }));
      return k;
    }
    if (!ply) { k.append(el('p', 'cx-sub', t('sessionContext.place.nativeNote', { agent: backendLabel() }))); return k; }
    if (!editScan) { const p = el('p', 'cx-sub'); p.append(runMark(t('context.searching')), document.createTextNode(' ' + t('context.searchingDots'))); k.append(p); return k; }
    const own = Boolean(here()?.saved && here().kinds[kind].override);
    const offText = own ? t('sessionContext.place.offHere') : t('sessionContext.place.offGlobal');
    const entries = uniqueRows((editScan.entries ?? []).filter(e => e.kind === kind && e.status !== 'duplicate'));
    if (!entries.length) { k.append(el('p', 'cx-sub', t('sessionContext.place.none'))); return k; }
    if (kind === 'mcp') {
      // 名前ごとに 1 行（同じ名前の定義が複数あっても、つなぐのは 1 つ）
      const byName = new Map();
      for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
      const rows = [...byName.values()].map(list => ({ ...(list.find(e => e.status === 'candidate') ?? list[0]), list }));
      grouped(k, rows, e => {
        const on = e.list.some(x => x.status === 'candidate');
        return switchRow(e, on, [shortPath(e.path), on ? '' : offText].filter(Boolean).join(' · '), true,
          () => savePlaceKind('mcp', v => toggleMcp(v, e.name, e.list, !on, editScan.entries), `[data-row="${e.id}"] .cx-sw`));
      });
      return k;
    }
    if (kind === 'skill') {
      const host = el('div', 'scx-edit-list');
      editSkillHost = host;
      skillPaintArgs = { entries, offText };
      paintEditEntries(host, 'skill', entries, offText);
      k.append(editSkillFind.root, host);
    } else {
      const host = el('div', 'scx-edit-list');
      paintEditEntries(host, kind, entries, offText);
      k.append(host);
    }
    return k;
  }
  function editCounts() {
    const support = contextSupport();
    const hView = hooksPlace.view;
    const hVal = hView?.place?.value ?? hView?.defaults?.value;
    const kindVal = k => here()?.kinds[k].value ?? place.view?.defaults.kinds[k].value;
    const scanCount = k => {
      const val = kindVal(k);
      if (k === 'mcp' && val?.agents) return null;
      if (!val || !support.supported) return null;
      if (val.owner !== 'ply') return null;
      if (!editScan) return null;
      const rows = uniqueRows((editScan.entries ?? []).filter(e => e.kind === k && e.status !== 'duplicate'));
      return k === 'mcp' ? new Set(rows.map(e => e.name)).size : rows.length;
    };
    const hooksCount = !hView || hView.unreadable || !hVal
      ? null
      : hVal.owner !== 'ply' ? null : (hView.hooks ?? []).filter(h => h.enabled).length;
    return {
      instruction: scanCount('instruction'),
      skill: scanCount('skill'),
      mcp: scanCount('mcp'),
      hooks: hooksCount,
    };
  }
  function selectEditTab(id, { focus = false } = {}) {
    if (!CONTEXT_TABS.includes(id)) return;
    const changed = editTab !== id;
    editTab = id;
    writeTabStorage(EDIT_TAB_KEY, id);
    if (changed && editSkillQuery) {
      editSkillQuery = '';
      editSkillFind.clear();
      if (editSkillHost && editSkillHost.isConnected !== false && skillPaintArgs) {
        paintEditEntries(editSkillHost, 'skill', skillPaintArgs.entries, skillPaintArgs.offText);
      }
    }
    lastTabBar?.setActive(id, { focus });
    if (lastTabPanels) for (const [k, p] of Object.entries(lastTabPanels)) p.hidden = k !== id;
    if (changed) {
      const box = lastTabBar?.root?.parentElement;
      const scroller = box?.closest?.('.file-preview-content') ?? box?.parentElement;
      if (scroller && 'scrollTop' in scroller) scroller.scrollTop = 0;
    }
  }
  function editDocRow(kind, e, { child = false, displayName = null, offText }) {
    const on = e.status !== 'excluded';
    const row = el('div', 'cx-row' + (on ? '' : ' off') + (child ? ' kid' : ''));
    row.dataset.row = e.id;
    row.append(el('span', 'cx-lead0'));
    const body = el('span', 't');
    const nl = el('span', 'nl');
    nl.append(el('span', 'nm', displayName ?? e.name));
    if (!child) {
      const marks = originMarks(entryOrigins(e));
      if (marks) nl.append(marks);
    }
    body.append(nl);
    const where = kind === 'skill' ? dir(dir(e.path)) : dir(e.path);
    const note = e.status === 'conditional' ? t('context.row.conditional', { paths: (e.paths ?? []).join(', ') }) : '';
    const subText = [child ? '' : shortPath(where), note, on ? '' : offText].filter(Boolean).join(' · ');
    if (subText) body.append(el('span', 'p', subText));
    const sw = button('', 'cx-sw', () => savePlaceKind(kind, v => toggleExclude(v, e, !on), `[data-row="${escCss(e.id)}"] .cx-sw`));
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', t('sessionContext.place.switchAria', { path: shortPath(e.path), name: e.name }));
    sw.disabled = editBusy;
    row.append(body, sw);
    return row;
  }
  function paintEditEntries(host, kind, entries, offText) {
    host.replaceChildren();
    const query = kind === 'skill' ? editSkillQuery.toLowerCase() : '';
    const hit = entry => !query || String(entry.name ?? '').toLowerCase().includes(query);
    let shown = 0;
    for (const g of GROUPS) {
      const tierEntries = entries.filter(e => groupOf(e) === g);
      if (!tierEntries.length) continue;
      const blocks = groupEntries(kind, tierEntries);
      const visibleBlocks = blocks.filter(block => block.type === 'row'
        ? hit(block.entry)
        : block.items.some(({ entry }) => hit(entry)));
      if (!visibleBlocks.length) continue;
      host.append(el('p', 'scx-grp', t(`sessionContext.group.${g}`)));
      for (const block of visibleBlocks) {
        if (block.type === 'row') {
          shown++;
          host.append(editDocRow(kind, block.entry, { child: false, displayName: block.childLabel, offText }));
          continue;
        }
        const kids = block.items.filter(({ entry }) => hit(entry));
        shown += kids.length;
        const bKey = `${kind}|${g}|${block.key}`;
        const open = Boolean(query) || (editBundleOpen.has(bKey) ? editBundleOpen.get(bKey) : block.defaultOpen);
        // 絞り込み中は、スイッチも見えている（当たった）行だけが対象（状態も切替も）
        const items = (query ? kids : block.items).map(i => i.entry);
        const actionLabel = kind === 'skill' ? t('context.bundle.offerAria', { name: block.label }) : t('context.bundle.provideAria', { name: block.label });
        const swState = bundleSwitchState(items, e => e.status !== 'excluded', actionLabel);
        const row = el('div', 'cx-row grp' + (swState.checked === 'false' ? ' off' : ''));
        row.dataset.bundle = bKey;
        const tw = button('', 'cx-ic cx-tw');
        const fk = `scx-bundle:${bKey}`;
        tw.dataset.cxFk = fk;
        tw.setAttribute('aria-expanded', String(open));
        tw.setAttribute('aria-label', block.label);
        tw.append(chevronIcon());
        const flip = () => {
          if (query) return;
          editBundleOpen.set(bKey, !open);
          paintEditEntries(host, kind, entries, offText);
          focusIn(`[data-cx-fk="${escCss(fk)}"]`);
        };
        tw.onclick = flip;
        const body = el('span', 't' + (query ? '' : ' tap'));
        if (!query) body.onclick = flip;
        const nl = el('span', 'nl');
        nl.append(el('span', 'nm', block.label), el('span', 'cnt', String(block.items.length)));
        const marks = originMarks(block.origins);
        if (marks) nl.append(marks);
        body.append(nl, el('span', 'p', shortPath(block.folder)));
        const sw = button('', 'cx-sw', () => {
          const include = swState.checked !== 'true';
          sw.setAttribute('aria-checked', String(include));
          savePlaceKind(kind, v => toggleExcludeMany(v, items, include), `[data-bundle="${escCss(bKey)}"] .cx-sw`);
        });
        sw.setAttribute('role', 'checkbox'); sw.setAttribute('aria-checked', swState.checked);
        sw.setAttribute('aria-label', swState.ariaLabel);
        sw.disabled = editBusy;
        row.append(tw, body, sw);
        host.append(row);
        if (open) for (const { entry, childLabel } of kids) host.append(editDocRow(kind, entry, { child: true, displayName: childLabel, offText }));
      }
    }
    if (query && !shown) {
      const none = el('div', 'cx-row');
      none.append(el('span', 'cx-lead0'), el('span', 'p', t('context.find.none')));
      host.append(none);
    }
  }
  function switchRow(e, on, sub, dot, onToggle) {
    const row = el('div', 'scx-item' + (on ? '' : ' off'));
    row.dataset.row = e.id;
    const mark = dot ? el('span', 'cx-dot' + (on ? ' on' : ' off')) : el('span', 'mark' + (on ? ' on' : ''), on ? '✓' : '–');
    mark.setAttribute('aria-hidden', 'true');
    const body = el('div', 't');
    body.append(el('div', 'nm', e.name), el('div', 'p', sub));
    const sw = button('', 'cx-sw', onToggle);
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', t('sessionContext.place.switchAria', { path: shortPath(e.path), name: e.name }));
    sw.disabled = editBusy;
    row.append(mark, body, sw);
    return row;
  }
  function addedEditFace() {
    const k = kindBox(t('sessionContext.added.title'), t('sessionContext.added.scope'), false);
    const p = el('p', 'cx-sub');
    p.append(button(t('sessionContext.added.settings'), 'cx-link', () => openSettings()));
    k.append(p);
    return k;
  }

  // ---------------------------------------------------------------- ふだんの種類の面（記録から）
  function instructions(data) {
    const ply = managed(data, 'instruction');
    const rows = data.report.entries.filter(e => e.kind === 'instruction');
    const given = rows.filter(e => e.status === 'supplied' || e.status === 'loaded');
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
    grouped(k, given, e => item('✓', e.name, e.status === 'loaded' ? t('sessionContext.instruction.loaded', { path: shortPath(dir(e.path)) }) : shortPath(dir(e.path)), { on: true, tokens: e.tokens }).row);
    if (!given.length) k.append(el('p', 'cx-sub', t('sessionContext.instruction.none')));
    const left = rows.filter(e => !['supplied', 'loaded'].includes(e.status));
    if (left.length) k.append(fold(t('sessionContext.instruction.notGiven', { count: left.length }), left.map(e => item('–', e.name, `${shortPath(dir(e.path))} · ${reasonOf(e)}`).row)));
    return k;
  }
  function skills(data) {
    const ply = managed(data, 'skill');
    const rows = data.report.entries.filter(e => e.kind === 'skill');
    const offered = rows.filter(e => ['available', 'manual-only', 'loaded'].includes(e.status));
    const k = kindBox('Skills', ply ? t('sessionContext.skill.who', { count: offered.length }) : t('sessionContext.native'), ply);
    if (!ply) { k.append(el('p', 'cx-sub', t('sessionContext.skill.native', { agent: backendLabel() }))); return k; }
    // 使ったものを先に。多いので最初の数件だけ並べ、残りは畳む
    const sorted = [...offered.filter(e => e.status === 'loaded'), ...offered.filter(e => e.status !== 'loaded')];
    // 同じ名前の定義が複数あったとき、使わなかった方（core/context-runtime.mjs の markChoices）
    const unused = rows.filter(e => e.shadowedBy === 'choice');
    const make = e => {
      const { row, body } = item('✓', e.name, [shortPath(dir(dir(e.path))), e.status === 'loaded' ? t('sessionContext.skill.usedMark') : e.status === 'manual-only' ? t('sessionContext.skill.manualOnly') : ''].filter(Boolean).join(' · '), { on: true });
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
  const samePath = (a, b) => { const k = p => { const s = String(p ?? '').replace(/\\/g, '/'); return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s; }; return k(a) === k(b); };
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
      input.type = 'radio'; input.name = `${id}-pick`; input.checked = x === pick; input.disabled = editBusy || !place.view;
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
      if (edit) await loadEditScan();
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
    if (!ply) { nativeMcp(k, data); return k; }
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
    if (notice) k.append(el('p', 'cx-strong', notice));
    return k;
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
    return list.filter(b => b.capabilities?.hooks).map(b => labelOf(b.id)).join('・');
  }
  function hookBoxes(data) {
    loadHooks(data);
    const h = hooks.data;
    // Hooks を Pleiad がそろえた会話: そのターンの記録（渡した・止めた・渡せなかった・漏れ）と発火の記録
    if (h?.unify?.owner === 'ply') {
      const box = unifySessionBox(h.unify, { kindBox, short: shortPath, agents: hookAgentNames() });
      if (h.owner !== 'ply') box.append(el('p', 'cx-strong', t('hooks.unify.session.nextNative')));
      return [box, hookRuns(h)];
    }
    const k = kindBox('Hooks', t('sessionContext.native'), false);
    if (!h) { k.append(el('p', 'cx-sub', t('sessionContext.hooks.reading'))); return [k]; }
    if (h.failed) { k.append(el('p', 'cx-sub', t('sessionContext.hooks.failed', { error: h.failed }))); return [k]; }
    if (h.unify?.unsupportedAgent || (h.owner === 'ply' && !h.agent)) { k.append(el('p', 'cx-sub', unsupportedAgentText(hookAgentNames()))); return [k]; }
    if (!h.agent || !h.report) { k.append(el('p', 'cx-sub', t('sessionContext.hooks.unknownAgent', { agent: backendLabel() }))); return [k]; }
    if (h.owner === 'ply') k.append(el('p', 'cx-strong', t('hooks.unify.session.nextPly')));
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
        // 他のエージェントへ写す（作業場所の定義は右パネルにしか並ばない）。写した定義（アダプター越し）からは写さない
        if (!copyBlocked(e)) {
          const copy = button(t('hooks.copy.open'), 'btn', () => openCopySheet(ctx, e));
          copy.setAttribute('aria-label', t('sessionContext.hooks.copyAria', { name: rowName(e) }));
          acts.append(copy);
        }
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

  /** 「この場所だけ変える」の間の Hooks の面: 担当の 2 択（変える前にその場で確認）と、この場所で渡す登録のスイッチ */
  function hooksEditFace() {
    const view = hooksPlace.view;
    const value = view?.place?.value ?? view?.defaults?.value;
    const ply = value?.owner === 'ply';
    const k = kindBox('Hooks', ply ? t('sessionContext.place.plyWho') : t('sessionContext.native'), ply);
    if (view?.unreadable) { k.append(el('p', 'cx-strong', t('hooks.unify.unreadable'))); return k; }
    if (!value) { k.append(el('p', 'cx-sub', t('sessionContext.place.loading'))); return k; }
    const seg = el('div', 'cx-seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', t('sessionContext.place.ownerAria', { kind: 'Hooks' }));
    for (const id of ['native', 'ply']) {
      const b = button('', 'cx-opt');
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(value.owner === id)); b.dataset.owner = `hooks:${id}`;
      b.append(el('b', null, OWNER[id][0]), el('span', null, t(id === 'ply' ? 'hooks.owner.ply' : 'hooks.owner.agent')));
      b.onclick = () => { hooksConfirm = value.owner === id ? null : { direction: id, reset: false }; refresh(); focusIn(hooksConfirm ? '.hk-unify' : `[data-owner="hooks:${id}"]`); };
      seg.append(b);
    }
    k.append(seg);
    const saved = v => { hooksPlace.view = v; hooksConfirm = null; showToast(); loadHooks(info(), true); refresh(); };
    if (hooksConfirm) {
      k.append(unifyConfirmPanel({ cmd, cwd: place.cwd, direction: hooksConfirm.direction, reset: hooksConfirm.reset, short: shortPath, onDone: saved,
        onCancel: () => { hooksConfirm = null; refresh(); focusIn(`[data-owner="hooks:${value.owner}"]`); } }));
      return k;
    }
    if (view.place?.override) {
      // 上の設定に戻すと担当が変わるなら、切り替えと同じ確認を通す（止めていたネイティブが再開する・動いていたものが止まるため）
      const reset = button(t('hooks.unify.placeReset'), 'btn', () => {
        const plan = resetPlan(view);
        if (plan.confirm) { hooksConfirm = { direction: plan.confirm, reset: true }; refresh(); focusIn('.hk-unify'); return; }
        placeWork(async () => saved(await cmd('setHooksOwner', { place: place.cwd, cwd: place.cwd, value: null, revision: view.revision })));
      });
      k.append(reset);
    }
    if (!ply) { k.append(el('p', 'cx-sub', t('sessionContext.place.nativeNote', { agent: backendLabel() }))); return k; }
    // この場所で渡す登録（オフ = この場所では渡さない。登録そのものは消さない）
    const off = new Set(value.disabled ?? []);
    const hooksList = (view.hooks ?? []).filter(h => h.enabled);
    if (!hooksList.length) k.append(el('p', 'cx-sub', t('hooks.unify.registryEmpty')));
    for (const h of hooksList) {
      const on = !off.has(h.id);
      const row = switchRow({ id: h.id, name: h.name, path: '' }, on, [h.event, h.targets.map(agentLabel).join(', '), on ? '' : t('hooks.unify.offHere')].filter(Boolean).join(' · '), true,
        () => placeWork(async () => saved(await cmd('setHooksOwner', { place: place.cwd, cwd: place.cwd, revision: view.revision,
          value: { owner: 'ply', disabled: on ? [...off, h.id] : [...off].filter(x => x !== h.id) } }))));
      row.querySelector('.cx-sw')?.setAttribute('aria-label', t('hooks.unify.placeSwitchAria', { name: h.name }));
      k.append(row);
    }
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
      onClose: () => { chip?.setAttribute('aria-expanded', 'false'); edit = false; editScan = null; unifying = false; resetEditState(); } });
  }
  /** 記録が変わったとき（ターンの開始・読み込み直し・外す）。開いていれば描き直す */
  function refresh() {
    // 閉じているときは描かない（描くと作業場所の設定やエージェント任せの指示の見積もりを読みに行く）
    if (preview.panelOpen(KEY)) {
      const activeEl = document.activeElement;
      const wasFind = activeEl === editSkillFind.input;
      const sel = wasFind ? [activeEl.selectionStart, activeEl.selectionEnd] : null;
      const tabId = activeEl?.getAttribute?.('role') === 'tab' && activeEl?.id?.startsWith('scx-tab-')
        ? activeEl.dataset?.tab : null;
      const data = info() ?? {};
      preview.updatePanel(KEY, { subtitle: data.report ? subtitle(data) : '', body: render() });
      if (wasFind) {
        editSkillFind.input.focus();
        if (sel?.[0] != null) editSkillFind.input.setSelectionRange?.(sel[0], sel[1]);
      } else if (tabId) {
        document.getElementById?.(`scx-tab-${tabId}`)?.focus();
      }
    }
  }
  return { open, refresh, isOpen: () => preview.panelOpen(KEY) };
}
