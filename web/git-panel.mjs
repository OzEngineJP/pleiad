// 右パネル「git」（docs/design-system.md「git の動き」、ADR 0085・0135）。
// タブは「グラフ」と「Worktree」（線画 + 語。件数は読み上げ用の名前に持つ）。グラフは、範囲の切り替え（コミットしていない分 / この会話の間）→ コミットのグラフ →
// 選んだ範囲のファイルの一覧 → 差分。コミットの行を押すと、その行のすぐ下に変わったファイルの箱が開く（同時に 1 つ）。Worktree は、このリポジトリの
// git worktree を並べ、Pleiad の worktree の操作は行を開いた中に置く。
// 読むだけ（ステージ・コミット・ブランチの切り替えは作らない）。取るのは開いたとき・再読み込み・ターンの終わり・範囲やコミットを選んだときだけ。
// 右パネルの枠は web/file-preview.mjs の openPanel（頭の再読み込み・広げる・閉じる、道具の列にタブ）。ここは中身だけを作る。
// 文字列に埋めるモデル・利用者由来の値は esc を通す。
import { t, fmt } from './i18n.mjs';
import { branchIcon, jumpIcon, chevRightIcon, backIcon, openInBrowserIcon, folderIcon, moreIcon, archiveIcon } from './icons.mjs';
import { refreshIcon, chatIcon, listIcon, treeIcon, upIcon, downIcon, prevChangeIcon, nextChangeIcon, inlineIcon, sideIcon, wrapIcon, tagIcon, cloudIcon, flagIcon, diffIcon, graphTabIcon, worktreeTabIcon } from './git-icons.mjs';
import { branchLabel, changeText, filesText } from './git-view.mjs';
import { createLeftovers } from './worktree-ui.mjs';
import { layoutGraph, rangeNodes, rowSvg, tailSvg, lanesBelow, WT_KEY } from './git-graph.mjs';
import { diffHTML } from './git-diff.mjs';

const KEY = 'git';
const WIDE_PX = 740;      // 左右の差分を選べる幅
const HISTORY_PAGE = 50;
const WT_SKELETON_ROWS = 3;   // 作業場所の件数が分かる前に出す骨組みの行数

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 数（サーバーから来た値でも HTML に入れる前に数にする） */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** 状態の文字は M / A / D / U / R だけ（class と HTML に入れるので、それ以外は M にする） */
const stateOfFile = (v) => (typeof v === 'string' && v.length === 1 && 'MADUR'.includes(v) ? v : 'M');
/** http(s) の URL だけをリンクにする */
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? String(u) : '');
const frag = (html) => { const tpl = document.createElement('template'); tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; };
const splitPath = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)]; };
const FT = { js: 'JS', mjs: 'JS', cjs: 'JS', ts: 'TS', md: 'M↓', css: '#', json: '{}', html: '<>' };
const ftOf = (p) => { const ext = p.split('.').pop(); return Object.hasOwn(FT, ext) ? FT[ext] : '··'; };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// 選んだ形（ツリー / 一覧、インライン / 左右、折り返し）は覚える
const PREFS_KEY = 'ply.git.view';
const prefs = (() => { try { return { view: 'list', mode: 'inline', wrap: false, wrapNarrow: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { return { view: 'list', mode: 'inline', wrap: false, wrapNarrow: true }; } })();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 覚えられなくても動く */ } };

/** ファイルの行の「+a −d」 */
const countsHTML = (f) => (f.binary ? '' : `${num(f.add) ? `<span class="a">+${num(f.add)}</span>` : ''}${num(f.add) && num(f.del) ? ' ' : ''}${num(f.del) ? `<span class="d">−${num(f.del)}</span>` : ''}`);
// i18n-dynamic: git.state
const stateName = (s) => t(`git.state${s}`);

/** ref の札（ブランチ・タグ・リモート）。名前は span で包み、狭いと名前だけが省略される */
export function refHTML(r) {
  const name = (icon, label, title) => `<span class="ref${r.kind === 'head' ? ' head' : ''}" title="${esc(title)}">${icon}<span class="rn">${esc(label)}</span></span>`;
  if (r.kind === 'head') return name(branchIcon, r.name ?? 'HEAD', `${t('git.refHead')}: ${r.name ?? 'HEAD'}`);
  if (r.kind === 'tag') return name(tagIcon, r.name, `${t('git.refTag')}: ${r.name}`);
  if (r.kind === 'remote') return name(cloudIcon, r.name, `${t('git.refRemote')}: ${r.name}`);
  return name(branchIcon, r.name, r.pleiad ? `${t('git.refWorktree')}: ${r.name}` : r.name);
}

/** ファイルの行。key は DOM の data-key に入る行の識別子（パスを入れない。呼び出し側が添字などで作る） */
export function fileRowHTML(f, key, lv, showDir) {
  const [dir, nm] = splitPath(String(f.path));
  const state = stateOfFile(f.state);
  const label = `${f.path} ${stateName(state)} ${num(f.add) ? `+${num(f.add)}` : ''} ${num(f.del) ? `−${num(f.del)}` : ''}`;
  return `<div class="fr${state === 'D' ? ' del' : ''}" role="treeitem" aria-level="${num(lv) + 1}" tabindex="-1" style="--lv:${num(lv)}" data-key="${esc(key)}" aria-label="${esc(label)}">
      <span class="ft" aria-hidden="true">${esc(ftOf(String(f.path)))}</span><span class="nm">${esc(nm)}</span>${showDir ? `<span class="dir">${esc(f.orig ? `${f.orig} → ${dir}` : dir)}</span>` : '<span class="sp"></span>'}
      <span class="cn">${countsHTML(f)}</span>
      <span class="acts"><button class="btn btn-icon sm" type="button" tabindex="-1" data-act="diff" aria-label="${esc(t('git.openDiff'))}" title="${esc(t('git.openDiff'))}">${diffIcon}</button><button class="btn btn-icon sm" type="button" tabindex="-1" data-act="use" aria-label="${esc(t('git.use'))}" title="${esc(t('git.use'))}">${chatIcon}</button></span>
      <button class="btn btn-icon sm more" type="button" tabindex="-1" data-act="more" aria-label="${esc(t('git.more'))}" aria-expanded="false">${moreIcon}</button>
      <span class="st ${state}" title="${esc(stateName(state))}" aria-hidden="true">${state}</span></div>`;
}

export function setupGitPanel({ cmd, preview, session, jump, use, onState = () => {}, worktrees, canOpen = () => true }) {
  // 返事が来ない問い合わせで「読み込み中…」のまま止まらないよう、30 秒で諦めて「取れませんでした」にする
  const ask = (command, args) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timeout')), 30_000); cmd(command, args).then(resolve, reject).finally(() => clearTimeout(timer)); });
  const leftovers = createLeftovers({ ...worktrees, changed: () => { if (st.tab === 'worktrees') paint(); } });
  const fresh = (key) => ({ key, tab: 'changes', sel: { k: 'uncommitted' }, open: null, auto: false, touched: false, initial: 'uncommitted', shut: new Set(), older: false, base: null, changes: {}, commitData: {}, hist: null, histLoading: false,
    start: null, wt: null, wtFull: false, wtOpen: new Set(), wtDetail: new Map(), diff: null, loading: false, failed: false, at: null, note: '' });
  let st = fresh(null);
  let opener = null, ticket = 0, noteTimer = 0, target = null, wide = false;
  const sid = () => target ?? session().id;
  const isOpen = () => preview.panelOpen(KEY);
  const foreign = () => Boolean(target && target !== session().id);

  // ---------------------------------------------------------------- 枠に渡す部品（頭・タブ）
  const root = document.createElement('div');
  root.className = 'gp';
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button'; reloadBtn.className = 'btn btn-icon'; reloadBtn.innerHTML = refreshIcon;
  reloadBtn.onclick = () => load({ force: true });
  root.setAttribute('role', 'tabpanel');
  const tabs = frag(`<div class="gp-tabs" role="tablist" aria-label="${esc(t('git.tabs'))}"></div>`);
  tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) selectTab(b.dataset.t); });
  tabs.addEventListener('keydown', (e) => {
    const keys = ['changes', 'worktrees'];
    const k = keys.indexOf(document.activeElement?.dataset?.t);
    if (k < 0) return;
    const to = e.key === 'ArrowRight' ? keys[(k + 1) % keys.length] : e.key === 'ArrowLeft' ? keys[(k + keys.length - 1) % keys.length] : e.key === 'Home' ? keys[0] : e.key === 'End' ? keys.at(-1) : null;
    if (to) { e.preventDefault(); selectTab(to, true); }
  });
  new ResizeObserver(() => { const w = root.clientWidth >= WIDE_PX; if (w !== wide) { wide = w; if (st.diff) paint(); } }).observe(root);

  function selectTab(tab, focus = false) {
    if (st.tab === tab && !st.diff) { if (focus) tabs.querySelector(`[data-t="${tab}"]`).focus(); return; }
    st.diff = null; st.tab = tab;
    if (tab === 'worktrees' && (!st.wt || st.wt.partial)) loadWorktrees();
    paint();
    if (focus) tabs.querySelector(`[data-t="${tab}"]`).focus();
  }

  // ---------------------------------------------------------------- 今の範囲の一覧（モデル）
  const mineHash = (hash) => (st.base?.timeline ?? []).some((e) => e.kind === 'commit' && e.hash && hash.startsWith(e.hash));
  const eventOf = (hash) => (st.base?.timeline ?? []).find((e) => e.kind === 'commit' && e.hash && hash.startsWith(e.hash));

  /** { title, meta, groups: [{ id, title, files }], total }。sel は範囲 { k: 'uncommitted' | 'session' } か、開いた箱のコミット { k: 'commit', hash } */
  function modelFor(sel) {
    const tag = (files, src) => files.map((f) => ({ ...f, src }));
    if (sel.k === 'uncommitted') {
      const ch = st.changes.uncommitted;
      if (!ch || ch.failed) return { title: t('git.rangeUncommitted'), groups: [], total: { files: 0, add: 0, del: 0 }, failed: true };
      const g = ch.groups;
      const groups = g ? [...(g.staged.length ? [{ id: 'staged', title: t('git.staged'), files: tag(g.staged, { range: 'uncommitted', stage: 'staged' }) }] : []),
        { id: 'work', title: t('git.changes'), files: tag(g.work, { range: 'uncommitted', stage: 'work' }) }].filter((x) => x.files.length || x.id === 'work')
        : [{ id: 'work', title: t('git.changes'), files: tag(ch.files, { range: 'uncommitted' }) }];
      return { title: t('git.rangeUncommitted'), groups, total: ch.total };
    }
    if (sel.k === 'session') {
      const ch = st.changes.session;
      if (!ch) return { title: t('git.rangeSession'), groups: [], total: { files: 0, add: 0, del: 0 }, loading: true };
      const start = st.hist?.session;
      return { title: t('git.rangeSession'), titleNote: start ? t('git.fromSnapshot', { time: fmt.time(start.at) }) : '', groups: [{ id: 'session', title: null, files: tag(ch.files, { range: 'session' }) }], total: ch.total, failed: ch.failed };
    }
    const data = st.commitData[sel.hash];
    if (!data) return { title: sel.hash.slice(0, 7), groups: [], total: { files: 0, add: 0, del: 0 }, loading: true };
    const c = data.commit;
    return { title: `<code>${esc(c.short)}</code> ${esc(c.subject)}`, html: true, commit: c, failed: data.failed === true, groups: [{ id: `c${c.short}`, title: null, files: tag(data.files, { commit: c.hash }) }], total: data.total };
  }
  const listModel = () => modelFor(st.sel);

  // 読み込み中・取れなかったときは数を出さない（0 と読めてしまうため）
  const countOf = () => { if (!st.base || st.failed) return null; const m = listModel(); return m.loading || m.failed ? null : m.total.files; };

  // ---------------------------------------------------------------- 頭・タブ
  function paintHead() {
    const g = st.base?.git;
    const title = frag('<div class="gp-br"></div>');
    if (g) {
      const pr = [...(st.base.timeline ?? [])].reverse().find((e) => e.kind === 'pr');
      const meta = [];
      if (g.branch && g.upstream) { if (g.ahead > 0) meta.push(`<span title="${esc(t('git.aheadTitle', { upstream: g.upstream, count: g.ahead }))}">↑${g.ahead}</span>`); if (g.behind > 0) meta.push(`<span title="${esc(t('git.behindTitle', { upstream: g.upstream, count: g.behind }))}">↓${g.behind}</span>`); }
      else if (g.branch && g.head) meta.push(`<span>${esc(t('git.unpushed'))}</span>`);
      if (pr && safeUrl(pr.url)) meta.push(`<a href="${esc(safeUrl(pr.url))}" target="_blank" rel="noopener noreferrer" title="${esc(t('git.prTitle', { number: pr.number }))}">${esc(t('git.pr', { number: pr.number }))}${openInBrowserIcon}</a>`);
      title.innerHTML = `<span class="bn">${branchIcon}<span>${esc(branchLabel(g))}</span></span>${g.linked ? `<span class="git-tag">${esc(t('git.worktree'))}</span>` : ''}${meta.length ? `<span class="meta">${meta.join('<span aria-hidden="true">·</span>')}</span>` : ''}`;
    } else title.textContent = t('git.panel');
    preview.updatePanel(KEY, { title, subtitle: g?.root ?? '' });
    const when = st.at ? t('git.reloadAt', { time: fmt.time(st.at) }) : t('git.reload');
    reloadBtn.title = when; reloadBtn.setAttribute('aria-label', t('git.reload'));
  }

  function paintTabs() {
    const n = countOf();
    const wtN = st.wt?.total ?? null;
    // 件数は画面に出さず、読み上げとツールチップの名前に持つ（「Worktree、30 件」）
    tabs.innerHTML = [['changes', t('git.tabChanges'), graphTabIcon, n], ['worktrees', t('git.tabWorktrees'), worktreeTabIcon, wtN]].map(([k, label, icon, count]) => {
      const name = count != null ? t('git.tabLabel', { label, count }) : label;
      return `<button class="gp-tab" role="tab" type="button" id="gp-tab-${k}" aria-controls="gp-panel" data-t="${k}" aria-label="${esc(name)}" title="${esc(name)}" aria-selected="${st.tab === k}" tabindex="${st.tab === k ? 0 : -1}">${icon}<span class="tl">${esc(label)}</span></button>`;
    }).join('');
    root.id = 'gp-panel'; root.setAttribute('aria-labelledby', `gp-tab-${st.tab}`);
    tabs.hidden = Boolean(st.diff) && matchMedia('(max-width:760px)').matches;
  }

  // ---------------------------------------------------------------- 変更タブ

  let layout = null, commits = [], startRow = -1;
  function buildLayout() {
    commits = st.hist?.commits ?? [];
    const dirty = (st.changes.uncommitted?.total?.files ?? 0) > 0;
    if (!dirty && st.open === WT_KEY) st.open = null;
    layout = layoutGraph(commits, { withWorktree: dirty, headHash: st.hist?.head ?? null });
    const start = st.hist?.session?.head;
    startRow = start ? layout.rows.findIndex((r) => r.key === start) : -1;
  }

  function rbarHTML() {
    const narrow = matchMedia('(max-width:760px)').matches;
    const hasSession = Boolean(st.base?.changes?.hasSession);
    if (!hasSession) return '';   // 範囲が 1 つだけなら切り替えは要らない（コミットしていない分は「未コミットの変更」の行の箱で見る）
    let h = `<span class="seg rseg" role="group" aria-label="${esc(t('git.range'))}"><button type="button" data-rg="uncommitted" aria-pressed="${st.sel.k === 'uncommitted'}">${esc(narrow ? t('git.rangeUncommittedShort') : t('git.rangeUncommitted'))}</button>`;
    h += `<button type="button" data-rg="session" aria-pressed="${st.sel.k === 'session'}">${esc(narrow ? t('git.rangeSessionShort') : t('git.rangeSession'))}</button>`;
    return `${h}</span>`;
  }

  /** 行のすぐ下に開く箱。縦の線を左に引き継ぎ、中身は開いている間だけ作る（閉じると .fold.shut で畳む） */
  function boxShell(r, key, name) {
    const lines = lanesBelow(layout, r).map((l) => `<line class="e${l.lane === 0 ? ' l0' : ''}" data-e="${l.edge}" x1="${l.x}" x2="${l.x}" y1="0" y2="100%"${l.dash ? ' stroke-dasharray="3 3"' : ''}/>`).join('');
    return `<div class="fold${st.open === key ? '' : ' shut'}" id="ins-${r}" role="group" aria-label="${esc(t('git.boxLabel', { name }))}"><div><div class="ins"><div class="ins-l" aria-hidden="true"><svg class="g">${lines}</svg></div><div class="ins-b">${st.open === key ? boxInner(key) : ''}</div></div></div></div>`;
  }
  const chevHTML = `<span class="chev">${chevRightIcon}</span>`;

  function rowHTML(r) {
    const row = layout.rows[r];
    if (row.wt) {
      const n = st.changes.uncommitted?.total?.files ?? 0;
      const label = t('git.wtRowLabel', { count: n });
      return `<button type="button" class="cg-row wt" data-r="${r}" data-k="${WT_KEY}" aria-expanded="${st.open === WT_KEY}" aria-controls="ins-${r}" aria-label="${esc(label)}">${rowSvg(layout, r)}<span class="cg-t"><span class="subj">${esc(t('git.wtRow'))}</span><span class="cnt">${n}</span></span><span class="cg-tm"></span>${chevHTML}</button>${boxShell(r, WT_KEY, t('git.wtRow'))}`;
    }
    const c = commits[r - (layout.rows[0].wt ? 1 : 0)];
    const start = st.hist?.session;
    const isStart = start && start.head === c.hash;
    const mark = isStart ? `<span class="startmk" title="${esc(t('git.startTitle', { time: startTime(start.at) }))}">${flagIcon}${esc(t('git.sessionStart', { time: startTime(start.at) }))}</span>` : '';
    const tip = `${c.short} · ${c.author} · ${new Date(c.at).toLocaleString()}`;
    return `<button type="button" class="cg-row${row.head ? ' headc' : ''}" data-r="${r}" data-k="${esc(c.hash)}" aria-expanded="${st.open === c.hash}" aria-controls="ins-${r}" title="${esc(tip)}" aria-label="${esc(`${c.subject} · ${c.refs.map((x) => x.name).filter(Boolean).join(' ')} · ${fmt.relative(c.at)} · ${c.short}${isStart ? ` · ${t('git.sessionStartLabel')}` : ''}`)}">${rowSvg(layout, r)}<span class="cg-t">${c.refs.map(refHTML).join('')}<span class="subj">${esc(c.subject)}</span>${mark}</span><span class="cg-tm">${esc(fmt.relative(c.at))}</span>${chevHTML}</button>${boxShell(r, c.hash, c.subject)}`;
  }

  /** 会話の始まりの日時。範囲より前の始まりは前の日のことが多いので、月日も付ける */
  const startTime = (ms) => fmt.dateTime(ms, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // ---------------------------------------------------------------- 読み込み中の骨組み（既存の .history-line。履歴・作業場所・範囲の一覧は、頭と変更の一覧より後に届く）
  const skLine = (w, h) => `<span class="history-line" style="width:${w}${h ? `;height:${h}` : ''}"></span>`;
  const HIST_SK_WIDTHS = ['58%', '44%', '62%', '38%', '52%', '46%'];
  /** 履歴が届くまでの行（グラフの行と同じ高さ・同じ線。押せない） */
  function histSkeletonHTML() {
    const rows = HIST_SK_WIDTHS.map((w, i) => `<div class="cg-row sk" aria-hidden="true"><svg class="g" viewBox="0 0 44 30" aria-hidden="true"><path class="e l0" d="M10 ${i === 0 ? '15' : '0'}V30"/><circle class="n l0" cx="10" cy="15" r="4.3"/></svg><span class="cg-t">${skLine(w)}</span><span class="cg-tm">${skLine('34px')}</span><span></span></div>`).join('');
    return `<div class="hist-sk">${rows}</div>`;
  }
  /** 「この会話の間」の一覧が届くまで（題の位置に 1 本、ファイルの行 2 本） */
  const listSkeletonHTML = () => `<div class="cl-h"><div class="cl-tt">${skLine('46%', '12px')}</div></div><div class="tree" aria-busy="true"><div class="fr sk" aria-hidden="true">${skLine('38%', '11px')}</div><div class="fr sk" aria-hidden="true">${skLine('30%', '11px')}</div></div>`;
  const WT_SK_WIDTHS = ['46%', '38%', '52%'];
  /** 作業場所の一覧が届くまでの行（件数が分かる前は WT_SKELETON_ROWS 行） */
  const wtSkeletonHTML = (i) => `<div class="wrow sk" aria-hidden="true">${branchIcon}<span style="min-width:0;display:block"><span class="b">${skLine(WT_SK_WIDTHS[i % WT_SK_WIDTHS.length])}</span><span class="p">${skLine('62%')}</span><span class="m">${skLine('52%')}</span></span><span class="tm"></span></div>`;

  /**
   * 会話の始まりの札（グラフの上の 1 行）。始まりのコミットが読み込んだ範囲の中なら ⚑ はその行に付くので、札は出さない。
   * 範囲より前なら「始まりまで読む」、押した後は読み込み中、2,000 件まで探して無ければ「見つかりませんでした」
   */
  function startNoteHTML() {
    const s = st.hist?.session;
    if (!s?.head || startRow >= 0) return '';
    const mark = `<span class="startmk" title="${esc(t('git.startTitle', { time: startTime(s.at) }))}">${flagIcon}${esc(t('git.sessionStart', { time: startTime(s.at) }))}</span>`;
    const note = (inner) => `<div class="startnote" role="status" tabindex="-1">${mark}${inner}</div>`;
    if (s.lost || st.start === 'lost') return note(`<span class="sn-t">${esc(t('git.startLost'))}</span>`);
    if (s.pos == null) return '';
    if (st.start === 'loading') return note(`<span class="sn-t pending-glint">${esc(t('git.loading'))}</span>`);
    return note(`<span class="sn-t">${esc(t('git.startBeyond'))}</span><button class="btn btn-quiet" type="button" data-startfind>${esc(t('git.startFind'))}</button>`);
  }
  /** 札の入れ物（.fold。消すときは 240ms で畳む） */
  const startSlotHTML = () => { const h = startNoteHTML(); return h ? `<div class="fold" data-start><div>${h}</div></div>` : ''; };

  function graphHTML() {
    const total = layout.rows.length;
    const foldFrom = startRow >= 0 ? startRow + 1 : total;
    const filling = st.histLoading && !st.hist;
    let h = `<div class="cg" role="list" aria-label="${esc(t('git.graph'))}"${filling ? ' aria-busy="true"' : ''}>`;
    for (let r = 0; r < Math.min(foldFrom, total); r++) h += `<div role="listitem">${rowHTML(r)}</div>`;
    const hidden = total - foldFrom;
    if (hidden > 0) {
      h += `<div class="fold${st.older ? '' : ' shut'}"><div>${Array.from({ length: hidden }, (_, k) => `<div role="listitem">${rowHTML(foldFrom + k)}</div>`).join('')}</div></div>`;
      h += `<button type="button" class="cg-more" aria-expanded="${st.older}" data-older>${tailSvg()}<span>${esc(st.older ? t('git.olderHide') : t('git.older', { count: hidden }))}</span></button>`;
    }
    if (st.hist?.next != null) h += `<div class="cg-more-row"><button class="btn btn-quiet" type="button" data-more>${esc(t('git.loadMore', { count: HISTORY_PAGE }))}</button></div>`;
    if (filling) h += histSkeletonHTML();
    return `${h}</div>`;
  }


  /** ツリー（フォルダーで束ねる。子が 1 つのフォルダーは「src/utils」に詰める） */
  function treeHTML(files, prefix, keyOf) {
    const rootNode = { dirs: new Map(), files: [] };   // フォルダー名は constructor・__proto__ でもよいので Map
    files.forEach((f, idx) => { const parts = f.path.split('/'); let node = rootNode; for (const d of parts.slice(0, -1)) { let child = node.dirs.get(d); if (!child) node.dirs.set(d, child = { dirs: new Map(), files: [] }); node = child; } node.files.push({ f, idx }); });
    let html = '';
    const walk = (node, lv, base) => {
      for (const [name, sub] of [...node.dirs.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
        let label = name, n = sub, p = `${base}${name}/`;
        while (n.dirs.size === 1 && !n.files.length) { const [k, v] = [...n.dirs.entries()][0]; label += `/${k}`; n = v; p += `${k}/`; }
        const id = `${prefix}:${p}`; const open = !st.shut.has(id);
        html += `<div class="fr folder" role="treeitem" aria-level="${lv + 1}" aria-expanded="${open}" tabindex="-1" style="--lv:${lv}" data-fold="${esc(id)}"><span class="chev">${chevRightIcon}</span><span class="fd">${folderIcon}</span><span class="nm">${esc(label)}</span><span class="sp"></span></div><div class="fold${open ? '' : ' shut'}" role="group"><div>`;
        walk(n, lv + 1, p); html += '</div></div>';
      }
      for (const { f, idx } of node.files) html += fileRowHTML(f, keyOf(idx), lv, false);
    };
    walk(rootNode, 0, '');
    return html;
  }

  let diffList = [];     // 範囲の一覧を開き順に並べたもの（差分の前後のファイル）
  let fileKeys = {};     // data-key → 差分の並びの添字
  let boxList = [];      // 開いている箱のファイル（範囲の一覧とは別に持つ）
  let boxKeys = {};
  /** ファイルの群・行の HTML。scope は一覧と箱で行の鍵・畳みの識別子がぶつからないための頭。list / keys に開き順の並びを足す */
  function filesHTML(m, scope, list, keys) {
    return m.groups.map((g) => {
      const gid = `${scope}${g.id}`;
      g.files.forEach((f, idx) => { keys[`${gid}:${idx}`] = list.length; list.push(f); });
      const keyOf = (idx) => `${gid}:${idx}`;
      const inner = prefs.view === 'tree' ? treeHTML(g.files, gid, keyOf) : g.files.map((f, idx) => fileRowHTML(f, keyOf(idx), 0, true)).join('');
      if (!g.title) return inner;
      const open = !st.shut.has(gid);
      return `<div class="grp" role="treeitem" aria-level="1" aria-expanded="${open}" tabindex="-1" data-fold="${esc(gid)}"><span class="chev">${chevRightIcon}</span>${esc(g.title)}<span class="n">${g.files.length}</span></div><div class="fold${open ? '' : ' shut'}" role="group"><div>${inner}</div></div>`;
    }).join('');
  }
  const countsText = (total) => `${total.add ? `<span class="a">+${total.add}</span>` : ''}${total.add && total.del ? ' ' : ''}${total.del ? `<span class="d">−${total.del}</span>` : ''}`;
  function messageOf(m, empty) {
    return m.loading ? `<div class="git-empty">${esc(t('git.loading'))}</div>` : m.failed ? `<div class="git-empty">${esc(t('git.failedChanges'))}</div>`
      : m.groups.every((g) => !g.files.length) ? `<div class="git-empty">${esc(empty)}</div>` : '';
  }
  function listHTML() {
    const m = listModel();
    diffList = []; fileKeys = {};
    if (m.loading && st.sel.k === 'session') return listSkeletonHTML();
    const body = messageOf(m, st.sel.k === 'session' ? t('git.emptySession') : t('git.emptyUncommitted'));
    const groupsHTML = filesHTML(m, '', diffList, fileKeys);
    const tot = `${t('git.files', { count: m.total.files })}${m.total.add || m.total.del ? ` ${countsText(m.total)}` : ''}`;
    return `<div class="cl-h"><div class="cl-tt"><b>${m.html ? m.title : esc(m.title)}${m.titleNote ? ` <span class="w">${esc(m.titleNote)}</span>` : ''}</b>${m.loading ? '' : `<span class="cn">${tot}</span>`}</div>
      <button class="btn btn-icon sm" type="button" data-v aria-pressed="${prefs.view === 'tree'}" aria-label="${esc(prefs.view === 'tree' ? t('git.listView') : t('git.treeView'))}" title="${esc(prefs.view === 'tree' ? t('git.listView') : t('git.treeView'))}">${prefs.view === 'tree' ? listIcon : treeIcon}</button>
      <button class="btn btn-icon sm" type="button" data-use aria-label="${esc(t('git.useRange'))}" title="${esc(t('git.useRange'))}">${chatIcon}</button></div>${body}
      <div class="tree" role="tree" aria-label="${esc(t('git.changedFiles'))}">${groupsHTML}</div>`;
  }
  const selOfBox = (key) => (key === WT_KEY ? { k: 'uncommitted' } : { k: 'commit', hash: key });
  /** 開いた箱の中身: 件数と「会話で使う」→ 作者・日時・親 → ファイルの一覧（ファイルの行は範囲の一覧と同じ部品） */
  function boxInner(key) {
    const m = modelFor(selOfBox(key));
    boxList = []; boxKeys = {};
    const meta = m.commit && !m.loading ? (() => {
      const c = m.commit; const mine = mineHash(c.hash);
      return `<div class="cl-meta"><span>${esc(c.author)} · <time datetime="${esc(new Date(c.at).toISOString())}" title="${esc(new Date(c.at).toLocaleString())}">${esc(fmt.relative(c.at))}</time> · <code>${esc(c.short)}</code> · ${esc(t('git.parent'))} <code>${esc(c.parents.map((p) => p.slice(0, 7)).join(' ') || t('git.noParent'))}</code>${mine ? ` · ${esc(t('git.madeHere'))}` : ''}</span>${mine && !foreign() ? `<button class="btn btn-quiet" type="button" data-jump="${esc(c.hash)}">${jumpIcon}${esc(t('git.jump'))}</button>` : ''}</div>`;
    })() : '';
    const body = messageOf(m, key === WT_KEY ? t('git.emptyUncommitted') : t('git.emptyCommit'));
    const files = filesHTML(m, 'b:', boxList, boxKeys);
    const head = m.loading ? '' : `<b>${esc(t('git.files', { count: m.total.files }))}</b>${m.total.add || m.total.del ? `<span class="cn">${countsText(m.total)}</span>` : ''}`;
    return `<div class="cl-h"><div class="cl-tt">${head}</div><button class="btn btn-quiet" type="button" data-cuse>${chatIcon}${esc(t('git.use'))}</button></div>${meta}${body}
      <div class="tree" role="tree" aria-label="${esc(t('git.changedFiles'))}">${files}</div>`;
  }

  /** コミットしていない変更が無いときの 1 行（「未コミットの変更」の行が出る場所の代わり） */
  const cleanHTML = () => (st.sel.k === 'uncommitted' && st.changes.uncommitted && !st.changes.uncommitted.failed && !layout.rows[0]?.wt ? `<div class="git-empty" data-clean>${esc(t('git.emptyUncommitted'))}</div>` : '');

  function renderChanges() {
    if (st.loading && !st.base) return frag(`<div class="gp-view cgv" aria-busy="true"><div class="rbar"><span class="sk-seg" aria-hidden="true">${skLine('100%', '22px')}</span></div><div class="cg" role="list" aria-label="${esc(t('git.graph'))}" aria-busy="true">${histSkeletonHTML()}</div></div>`);
    if (st.failed || !st.base) return frag(`<div class="gp-view"><div class="git-empty">${esc(t('git.failed'))}</div></div>`);
    buildLayout();
    const bar = rbarHTML();
    const view = frag(`<div class="gp-view cgv">${bar ? `<div class="rbar">${bar}</div>` : ''}${cleanHTML()}${startSlotHTML()}${graphHTML()}<div class="cl">${st.sel.k === 'session' ? listHTML() : ''}</div></div>`);
    queueMicrotask(() => { applySelection(); wireTree(); });
    return view;
  }

  /**
   * 選んだ範囲を線に沿った帯・太い線・塗った点で見せる。範囲の外を薄くするのは、複数のコミットにまたがる「この会話の間」だけ
   * （コミットを 1 つ開いたときも、既定の「コミットしていない分」のときも、ほかの行は薄くしない）
   */
  function applySelection() {
    if (!layout) return;
    const R = rangeNodes(layout, commits, { kind: st.sel.k, head: st.hist?.head ?? null, start: st.hist?.session?.head ?? null });
    const dimOut = st.sel.k === 'session';
    const edgeOn = (i) => { const e = layout.edges[i]; return R.nodes.has(e.a) && (e.b == null ? false : R.nodes.has(e.b) || e.b === R.base); };
    for (const x of root.querySelectorAll('.cg [data-e]')) { const on = edgeOn(Number(x.dataset.e)); x.classList.toggle('on', on); x.classList.toggle('dim', dimOut && !on); }
    for (const x of root.querySelectorAll('.cg [data-n]')) { const r = Number(x.dataset.n); const on = R.nodes.has(r), base = r === R.base; x.classList.toggle('on', on); x.classList.toggle('base', base && !on); x.classList.toggle('dim', dimOut && !on && !base); }
    for (const x of root.querySelectorAll('.cg-row:not(.sk)')) {
      const r = Number(x.dataset.r); const on = R.nodes.has(r);
      x.classList.toggle('dim', dimOut && !on && r !== R.base); x.classList.toggle('sel', x.dataset.k === st.open);
    }
    for (const x of root.querySelectorAll('.startmk')) x.classList.toggle('on', st.sel.k === 'session');
    // グラフの行は Tab の止まりを 1 つにする（↑↓ で移る）。開いている行、無ければ最初の行
    const rowsAll = [...root.querySelectorAll('.cg-row:not(.sk)')];
    const stop = rowsAll.find((x) => x.dataset.k === st.open) ?? rowsAll[0];
    for (const x of rowsAll) x.tabIndex = x === stop ? 0 : -1;
  }

  /**
   * 範囲を選び直す。グラフは動かさず、帯・一覧・タブの数だけ替える。
   * 「コミットしていない分」は一覧を出さず、「未コミットの変更」の行の箱を開く。複数のコミットにまたがる「この会話の間」だけがグラフの下の一覧（箱と二重にならないよう、その箱は閉じる）
   */
  async function choose(next) {
    st.sel = next;
    const bar = root.querySelector('.rbar'), cl = root.querySelector('.cl');
    if (!cl) { paint(); return; }
    if (bar) bar.innerHTML = rbarHTML();
    root.querySelector('[data-clean]')?.remove(); (root.querySelector('[data-start]') ?? root.querySelector('.cg'))?.insertAdjacentHTML('beforebegin', cleanHTML());
    if (next.k === 'session') { if (st.open === WT_KEY) toggleBox(WT_KEY); cl.innerHTML = listHTML(); }
    else { cl.innerHTML = ''; if (layout.rows[0]?.wt && st.open !== WT_KEY) toggleBox(WT_KEY); }
    wireTree(); applySelection(); paintTabs();
    if (next.k === 'session' && !st.changes.session) await loadRange('session');
  }

  // ---------------------------------------------------------------- コミットの行の箱（同時に 1 つ。240ms · ease-out の開閉は .fold と同じ）
  const rowOfKey = (key) => [...root.querySelectorAll('.cg-row:not(.sk)')].find((x) => x.dataset.k === key);
  const foldOfRow = (row) => row?.nextElementSibling;
  function closeBox(key) {
    const row = rowOfKey(key), fold = foldOfRow(row); if (!row || !fold) return;
    row.setAttribute('aria-expanded', 'false'); row.classList.remove('sel');
    fold.classList.add('shut'); fold.inert = true;
    // 畳み終わってから中身を捨てる（開き直したときに作り直す）
    setTimeout(() => { if (fold.classList.contains('shut')) fold.querySelector('.ins-b').replaceChildren(); }, reduced() ? 0 : 320);
  }
  function openBox(key) {
    const row = rowOfKey(key), fold = foldOfRow(row); if (!row || !fold) return;
    fold.querySelector('.ins-b').innerHTML = boxInner(key);
    row.setAttribute('aria-expanded', 'true'); row.classList.add('sel');
    fold.classList.remove('shut'); fold.inert = false;
    if (key !== WT_KEY && !st.commitData[key]) loadCommit(key);
    // 箱の下が切れていたら、足りない分だけ送る（畳みが開き終わる頃）
    setTimeout(() => { if (st.open === key && fold.isConnected) fold.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); }, reduced() ? 0 : 250);
  }
  /** key の箱を開く / 閉じる。ほかの箱が開いていれば先に閉じる */
  function toggleBox(key) {
    st.touched = true; st.auto = false;
    const prev = st.open;
    if (prev) closeBox(prev);
    st.open = prev === key ? null : key;
    if (st.open) openBox(st.open);
    applySelection();
  }
  /** グラフの行を押した・→ を押した。「この会話の間」の一覧を見ている間に「未コミットの変更」の行を開くなら、範囲も「コミットしていない分」へ移す（箱と一覧が二重に並ばない） */
  function toggleRow(key) {
    if (key === WT_KEY && st.sel.k === 'session' && st.open !== WT_KEY) { choose({ k: 'uncommitted' }); return; }
    toggleBox(key);
  }
  function refillBox() {
    if (!st.open || st.tab !== 'changes' || st.diff) return;
    const fold = foldOfRow(rowOfKey(st.open)); if (!fold) return;
    fold.querySelector('.ins-b').innerHTML = boxInner(st.open);
  }

  // ---------------------------------------------------------------- 一覧のキーボード（role=tree の行を上下で移る）
  function treeRows() { return [...root.querySelectorAll('.cl .grp, .cl .fr:not(.sk)')].filter((r) => !r.closest('.fold.shut')); }
  function focusRow(r) {
    for (const x of root.querySelectorAll('.cl .grp, .cl .fr')) { x.tabIndex = -1; x.querySelectorAll('button').forEach((b) => (b.tabIndex = -1)); }
    r.tabIndex = 0; r.querySelectorAll('button').forEach((b) => (b.tabIndex = 0)); r.focus();
  }
  function wireTree() { const first = root.querySelector('.cl .grp, .cl .fr:not(.sk)'); if (first) first.tabIndex = 0; }
  function toggleFold(r) {
    const id = r.dataset.fold; if (!id) return;
    if (st.shut.has(id)) st.shut.delete(id); else st.shut.add(id);
    const open = !st.shut.has(id);
    r.setAttribute('aria-expanded', String(open)); r.nextElementSibling?.classList.toggle('shut', !open);
  }
  /** ファイルの行 → その行がある並び（箱の中か範囲の一覧か）と添字 */
  const listOf = (row) => (row.closest('.ins') ? [boxList, boxKeys] : [diffList, fileKeys]);
  const fileOf = (row) => { const [list, keys] = listOf(row); return list[keys[row.dataset.key]]; };

  // ---------------------------------------------------------------- 作業場所タブ
  const badge = (w) => (w.kind === 'here' ? ['here', t('git.wtHere')] : w.kind === 'left' ? ['wait', t('git.wtUnmerged')] : w.kind === 'busy' ? ['', t('git.wtBusy')] : w.kind === 'plain' ? ['', t('git.wtPlain')] : ['', '']);
  function wtDetailHTML(w) {
    const d = st.wtDetail.get(w.path);
    let h = '';
    if (!w.exists) h += `<div class="git-empty">${esc(t('git.wtMissing'))}</div>`;
    else if (!d) h += `<div class="git-empty">${esc(t('git.loading'))}</div>`;
    else if (d.failed) h += `<div class="git-empty">${esc(t('git.failedChanges'))}</div>`;
    else {
      // 行の識別子は作業場所の添字・c / u・ファイルの添字だけ（パスを DOM の属性に入れない）
      const wi = st.wt.rows.indexOf(w);
      const group = (title, files, kind) => (files.length ? `<div class="gh">${esc(title)} ${files.length}</div><div class="tree" role="tree" aria-label="${esc(title)}">${files.map((f, i) => fileRowHTML(f, `w${wi}:${kind}:${i}`, 0, true)).join('')}</div>` : '');
      h += group(t('git.committed'), d.committed.files, 'c') + group(t('git.uncommitted'), d.uncommitted.files, 'u');
      if (!d.committed.files.length && !d.uncommitted.files.length) h += `<div class="gh plain">${esc(t('git.wtNone'))}</div>`;
    }
    if (w.kind === 'busy') h += `<div class="safe">${esc(w.who ? t('git.wtBusyBy', { who: w.who }) : t('git.wtBusyAnon'))}</div>`;
    else if (w.kind === 'plain') h += `<div class="safe">${esc(t('git.wtReadOnly'))}</div>`;
    return h;
  }
  function renderWorktrees() {
    if (!st.wt && st.wtFailed) return frag(`<div class="gp-view"><div class="git-empty">${esc(t('git.failed'))}</div></div>`);
    if (!st.wt) return frag(`<div class="gp-view wtv" aria-busy="true">${Array.from({ length: WT_SKELETON_ROWS }, (_, i) => wtSkeletonHTML(i)).join('')}</div>`);
    const partial = st.wt.partial === true;   // 一覧だけ届いている間は、状態の所を骨組みにする
    const base = st.wt.base?.branch ?? 'main';
    const view = frag('<div class="gp-view wtv"></div>');
    st.wt.rows.forEach((w, i) => {
      const open = st.wtOpen.has(w.path);
      const [cls, label] = badge(w);
      const tail = w.path.split('/').slice(-2).join('/');
      const meta = !w.exists ? t('git.wtMissing') : [w.main ? null : (w.ahead ? t('git.wtAhead', { base, count: w.ahead }) : t('git.wtSame', { base })), w.dirty ? t('git.wtDirty', { count: w.dirty }) : (w.main ? null : t('git.wtNoChange'))].filter(Boolean).join(' · ');
      const row = frag(`<div><button type="button" class="wrow" aria-expanded="${open}" data-wi="${i}">${branchIcon}<span style="min-width:0"><span class="b"><code>${esc(w.branch ?? (w.detached ? `HEAD ${w.head}` : ''))}</code>${label ? `<span class="wbadge ${cls}">${esc(label)}</span>` : ''}</span><span class="p" title="${esc(w.path)}">…/${esc(tail)}</span>${partial ? `<span class="m ph" aria-hidden="true">${skLine('52%')}</span>` : `<span class="m">${esc(meta)}</span>`}</span><span class="tm">${w.at ? esc(fmt.relative(w.at)) : ''}<span class="chev">${chevRightIcon}</span></span></button><div class="fold${open ? '' : ' shut'}"><div><div class="wdet" data-wd="${i}">${open ? wtDetailHTML(w) : ''}</div></div></div></div>`);
      view.append(row);
      if (open && w.kind === 'left' && w.leftover) row.querySelector('.wdet').append(leftovers.actions(w.leftover));
    });
    queueMicrotask(() => { for (const f of view.querySelectorAll('.fold.shut')) f.inert = true; });
    return view;
  }

  // ---------------------------------------------------------------- 差分
  const stateTitle = (f) => stateName(f.state);
  /** 差分が全部追加（新規のファイル）か全部削除（削除したファイル）なら 'add' / 'del'、そうでなければ null */
  function singleSided(f, data) {
    const lines = data.hunks.flatMap((h) => h.lines.map((l) => l.t));
    if (!lines.length) return null;
    if (lines.every((x) => x === '+') && (f.state === 'A' || f.state === 'U' || data.hunks.every((h) => h.oldCount === 0 && h.oldStart === 0))) return 'add';
    if (lines.every((x) => x === '-') && (f.state === 'D' || data.hunks.every((h) => h.newCount === 0 && h.newStart === 0))) return 'del';
    return null;
  }
  function renderDiff() {
    const d = st.diff, f = d.list[d.index];
    const [dir, nm] = splitPath(f.path);
    const narrow = matchMedia('(max-width:760px)').matches;
    const data = d.cache.get(d.index);
    // 新規・削除のファイルは片側が空なので、左右ではなく 1 列で見せる（理由を 1 行添える。ほかのファイルへ移れば左右に戻る）
    const whole = data?.hunks?.length ? singleSided(f, data) : null;
    let mode = wide ? prefs.mode : 'inline';
    const note = mode === 'side' && whole ? (whole === 'add' ? t('git.noteNew') : t('git.noteDeleted')) : '';
    if (note) mode = 'inline';
    // 左右は常に折り返す（折り返さないと各列が最長の行の幅になり、横にはみ出して見比べられない）
    const wrap = mode === 'side' ? true : narrow ? prefs.wrapNarrow : prefs.wrap;
    let body, changes = 0;
    if (d.failed.has(d.index)) body = `<div class="git-empty">${esc(t('git.failedDiff'))}</div>`;
    else if (!data) body = `<div class="git-empty">${esc(t('git.loading'))}</div>`;
    else if (data.binary) body = `<div class="git-empty">${esc(t('git.binary'))}</div>`;
    else if (!data.hunks.length) body = `<div class="git-empty">${esc(data.truncated ? t('git.truncated') : t('git.noDiff'))}</div>`;
    else { const out = diffHTML(data, { mode, open: d.open }); changes = out.changes; body = `${note ? `<div class="dnote" role="note">${esc(note)}</div>` : ''}<div class="dx${wrap ? ' wrap' : ''}${mode === 'side' ? ' side' : ''}">${out.html}</div>${data.truncated ? `<div class="git-empty">${esc(t('git.truncated'))}</div>` : ''}`; }
    d.nChanges = changes;
    const btn = (a, icon, label, extra = '') => `<button class="btn btn-icon sm${extra}" type="button" data-da="${a}" aria-label="${esc(label)}" title="${esc(label)}">${icon}</button>`;
    const dis = (cond) => (cond ? ' aria-disabled="true"' : '');
    const view = frag(`<div class="gp-view dv" tabindex="-1"><div class="dv-top"><div class="dvh">
        ${btn('back', backIcon, t('git.diffBackTo'))}
        <span class="ft" aria-hidden="true">${esc(ftOf(f.path))}</span><span class="nm">${esc(nm)}</span><span class="dir">${esc(f.orig ? `${f.orig} → ${dir}` : dir)}</span>
        <span class="cn">${countsHTML(f)}</span><span class="st ${f.state}" title="${esc(stateTitle(f))}">${f.state}</span>${btn('use', chatIcon, t('git.useDiff'))}</div>
      <div class="dvt" role="toolbar" aria-label="${esc(t('git.diffTools'))}">
        <span class="grp2"><button class="btn btn-icon sm" type="button" data-da="pf" aria-label="${esc(t('git.prevFile'))}" title="${esc(t('git.prevFile'))} (Alt+↑)"${dis(d.index === 0)}>${upIcon}</button><button class="btn btn-icon sm" type="button" data-da="nf" aria-label="${esc(t('git.nextFile'))}" title="${esc(t('git.nextFile'))} (Alt+↓)"${dis(d.index === d.list.length - 1)}>${downIcon}</button><span class="pos">${esc(t('git.filePos', { n: d.index + 1, total: d.list.length }))}</span></span>
        <span class="grp2"><button class="btn btn-icon sm" type="button" data-da="pc" aria-label="${esc(t('git.prevChange'))}" title="${esc(t('git.prevChange'))} (Shift+Alt+F5)">${prevChangeIcon}</button><button class="btn btn-icon sm" type="button" data-da="nc" aria-label="${esc(t('git.nextChange'))}" title="${esc(t('git.nextChange'))} (Alt+F5)">${nextChangeIcon}</button><span class="pos" data-pos>${esc(t('git.changePos', { n: changes ? Math.max(d.cur, 0) + 1 : 0, total: changes }))}</span></span>
        <span class="grow"></span>
        ${narrow ? '' : `<span class="seg" role="group" aria-label="${esc(t('git.diffForm'))}"><button type="button" data-da="inline" aria-pressed="${mode === 'inline'}">${esc(t('git.inline'))}</button><button type="button" data-da="side" aria-pressed="${mode === 'side'}"${wide ? '' : ' aria-disabled="true"'} title="${esc(wide ? t('git.sideTitle') : t('git.sideNeedsWide'))}">${esc(t('git.side'))}</button></span>`}
        <button class="btn btn-icon sm" type="button" data-da="wrap" aria-pressed="${wrap}"${mode === 'side' ? ' aria-disabled="true"' : ''} aria-label="${esc(t('git.wrap'))}" title="${esc(mode === 'side' ? t('git.wrapFixed') : t('git.wrap'))}">${wrapIcon}</button></div></div>${body}</div>`);
    return view;
  }
  function diffRequest(f) {
    const s = f.src ?? {};
    return { sessionId: sid(), range: s.range === 'session' ? 'session' : 'uncommitted', path: f.path, stage: s.stage, commit: s.commit, from: s.from, to: s.to, worktree: s.wt, orig: f.orig, context: 3, after: true };
  }
  async function loadDiffAt(index) {
    const d = st.diff; if (!d || d.cache.has(index)) return;
    const f = d.list[index]; let res = null;
    try { res = await ask('gitDiff', diffRequest(f)); } catch { /* 取れなかった */ }
    if (st.diff !== d) return;
    if (res?.diff) d.cache.set(index, res.diff); else d.failed.add(index);
    if (d.index === index) paint({ keepScroll: true });
  }
  function openDiff(list, index, from) {
    // 戻ったときに、開いていた箱と押したファイルの行・スクロールの位置へ帰れるよう、行の鍵と位置を持つ
    st.diff = { list, index, cache: new Map(), failed: new Set(), open: new Set(), cur: -1, nChanges: 0, opener: from?.dataset?.key ?? null, scroll: root.parentElement?.scrollTop ?? 0 };
    paint(); loadDiffAt(index);
    root.querySelector('.dv')?.focus({ preventScroll: true });
  }
  function closeDiff() {
    const key = st.diff?.opener, scroll = st.diff?.scroll ?? 0; st.diff = null; paint();
    const scrollEl = root.parentElement; if (scrollEl) scrollEl.scrollTop = scroll;
    const row = key == null ? null : [...root.querySelectorAll('.fr')].find((x) => x.dataset.key === key);
    if (row) row.focus({ preventScroll: true });
  }
  function goFile(step) {
    const d = st.diff; const j = d.index + step; if (j < 0 || j >= d.list.length) return;
    d.index = j; d.open = new Set(); d.cur = -1; paint(); loadDiffAt(j); root.querySelector('.dv')?.focus({ preventScroll: true });
  }
  function goChange(step) {
    const d = st.diff; if (!d.nChanges) return;
    d.cur = d.cur < 0 ? (step > 0 ? 0 : d.nChanges - 1) : (d.cur + step + d.nChanges) % d.nChanges;
    const row = root.querySelector(`[data-ch="${d.cur}"]`);
    const pos = root.querySelector('[data-pos]'); if (pos) pos.textContent = t('git.changePos', { n: d.cur + 1, total: d.nChanges });
    row?.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  }

  // ---------------------------------------------------------------- 入力
  function onClick(e) {
    const da = e.target.closest('[data-da]');
    if (da && st.diff) {
      if (da.getAttribute('aria-disabled') === 'true') return;
      const a = da.dataset.da;
      if (a === 'back') closeDiff();
      else if (a === 'use') { use(t('git.useFile', { path: st.diff.list[st.diff.index].path })); setNote(t('git.used')); }
      else if (a === 'pf') goFile(-1); else if (a === 'nf') goFile(1);
      else if (a === 'pc') goChange(-1); else if (a === 'nc') goChange(1);
      else if (a === 'inline' || a === 'side') { prefs.mode = a; savePrefs(); paint({ keepScroll: true }); root.querySelector(`[data-da="${a}"]`)?.focus(); }
      else if (a === 'wrap') { if (root.querySelector('.dx.side')) return; if (matchMedia('(max-width:760px)').matches) prefs.wrapNarrow = !prefs.wrapNarrow; else prefs.wrap = !prefs.wrap; savePrefs(); paint({ keepScroll: true }); root.querySelector('[data-da="wrap"]')?.focus(); }
      return;
    }
    const gap = e.target.closest('.dgap');
    if (gap && st.diff) { if (!gap.disabled) { st.diff.open.add(Number(gap.dataset.gap)); paint({ keepScroll: true }); } return; }
    const rg = e.target.closest('[data-rg]');
    if (rg) { choose({ k: rg.dataset.rg }); root.querySelector(`[data-rg="${st.sel.k}"]`)?.focus(); return; }
    const crow = e.target.closest('.cg-row');
    if (crow) { toggleRow(crow.dataset.k); crow.focus({ preventScroll: true }); return; }
    if (e.target.closest('[data-startfind]')) { findStart(); return; }
    if (e.target.closest('[data-older]')) { st.older = !st.older; paint({ keepScroll: true }); return; }
    if (e.target.closest('[data-more]')) { loadMoreHistory(); return; }
    if (e.target.closest('[data-v]')) { prefs.view = prefs.view === 'tree' ? 'list' : 'tree'; savePrefs(); const cl = root.querySelector('.cl'); cl.innerHTML = listHTML(); wireTree(); refillBox(); root.querySelector('[data-v]')?.focus(); return; }
    if (e.target.closest('[data-use]')) { useSel(st.sel); return; }
    if (e.target.closest('[data-cuse]')) { if (st.open) useSel(selOfBox(st.open)); return; }
    const jumpBtn = e.target.closest('[data-jump]');
    if (jumpBtn) { const ev = eventOf(jumpBtn.dataset.jump); if (!ev || !jump(ev)) setNote(t('git.jumpFailed')); return; }
    const wrow = e.target.closest('.wrow');
    if (wrow) {
      const w = st.wt.rows[Number(wrow.dataset.wi)];
      if (st.wtOpen.has(w.path)) st.wtOpen.delete(w.path); else { st.wtOpen.add(w.path); if (!st.wtDetail.has(w.path)) loadWtDetail(w); }
      paint({ keepScroll: true }); return;
    }
    // ファイルの行・群・フォルダー
    const r = e.target.closest('.grp, .fr');
    if (!r) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (r.classList.contains('grp') || r.classList.contains('folder')) { toggleFold(r); return; }
    if (act === 'more') { const on = !r.classList.contains('show-acts'); r.classList.toggle('show-acts', on); e.target.closest('[data-act]').setAttribute('aria-expanded', String(on)); return; }
    if (st.tab === 'worktrees') { const [list, index] = wtList(r); if (act === 'use') { use(t('git.useFile', { path: list[index].path })); setNote(t('git.used')); } else openDiff(list, index, r); return; }
    const f = fileOf(r);
    if (act === 'use') { use(t('git.useFile', { path: f.path })); setNote(t('git.used')); return; }
    const [list, keys] = listOf(r);
    openDiff(list, keys[r.dataset.key], r);
  }
  /** 作業場所タブのファイルの行 → その作業場所の並びと添字 */
  function wtList(row) {
    const m = /^w(\d+):([cu]):(\d+)$/.exec(row.dataset.key);
    const w = st.wt.rows[Number(m[1])]; const d = st.wtDetail.get(w.path);
    const files = (m[2] === 'c' ? d.committed.files : d.uncommitted.files).map((f) => ({ ...f, src: m[2] === 'c' ? { wt: w.path, from: d.base, to: d.head } : { wt: w.path, range: 'uncommitted' } }));
    return [files, Number(m[3])];
  }
  function onKeydown(e) {
    if (st.diff) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDiff(); }
      else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); goFile(e.key === 'ArrowUp' ? -1 : 1); }
      else if (e.altKey && e.key === 'F5') { e.preventDefault(); goChange(e.shiftKey ? -1 : 1); }
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // グラフの行と、開いた箱の中のファイルの行は、見えている順に ↑↓ で移る
    const visible = () => [...root.querySelectorAll('.cg-row:not(.sk), .ins .grp, .ins .fr')].filter((x) => !x.closest('.fold.shut'));
    const go = (x) => { if (!x) return; if (x.classList.contains('cg-row')) { for (const y of root.querySelectorAll('.cg-row:not(.sk)')) y.tabIndex = -1; x.tabIndex = 0; } x.focus(); };
    const crow = e.target.closest?.('.cg-row');
    if (crow && e.target === crow) {
      const open = crow.getAttribute('aria-expanded') === 'true';
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const all = visible(); go(all[all.indexOf(crow) + (e.key === 'ArrowDown' ? 1 : -1)]); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (!open) toggleRow(crow.dataset.k); else go(foldOfRow(crow).querySelector('.fr, .grp')); }
      else if (e.key === 'ArrowLeft' && open) { e.preventDefault(); toggleBox(crow.dataset.k); }
      else if (e.key === 'Escape' && st.open) { e.preventDefault(); e.stopPropagation(); const was = st.open; toggleBox(was); rowOfKey(was)?.focus({ preventScroll: true }); }
      return;
    }
    const r = e.target.closest?.('.grp, .fr');
    if (!r || e.target !== r) return;
    if (r.closest('.ins')) {
      const all = visible(); const k = all.indexOf(r);
      const parent = r.closest('.ins').closest('.fold').previousElementSibling;
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); go(all[k + 1]); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); go(all[k - 1]); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); go(parent); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (r.getAttribute('aria-expanded') === 'true') toggleFold(r); else go(parent); }
      else if (e.key === 'ArrowRight' && r.getAttribute('aria-expanded') === 'false') { e.preventDefault(); toggleFold(r); }
      return;
    }
    const all = treeRows(); const k = all.indexOf(r);
    if (e.key === 'ArrowDown') { e.preventDefault(); if (all[k + 1]) focusRow(all[k + 1]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (all[k - 1]) focusRow(all[k - 1]); }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(all[0]); }
    else if (e.key === 'End') { e.preventDefault(); focusRow(all.at(-1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.click(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && r.hasAttribute('aria-expanded')) { e.preventDefault(); if ((r.getAttribute('aria-expanded') === 'true') !== (e.key === 'ArrowRight')) toggleFold(r); }
  }

  /** 範囲（コミットしていない分・この会話の間）か、開いたコミットを、会話の入力欄へ渡す */
  function useSel(sel) {
    const g = st.base?.git; const m = modelFor(sel);
    let text;
    if (sel.k === 'commit') text = t('git.useCommit', { hash: sel.hash.slice(0, 7), subject: m.commit?.subject ?? '' });
    else text = t('git.useStatus', { branch: branchLabel(g), summary: m.total.files ? (sel.k === 'session' ? `${t('git.rangeSession')} ` : '') + filesText(m.total) : t('git.emptyUncommitted') });
    use(text); setNote(t('git.used'));
  }

  // ---------------------------------------------------------------- 描画
  function paint({ keepScroll = false } = {}) {
    if (!isOpen()) return;
    paintHead(); paintTabs();
    const scrollEl = root.parentElement; const top = keepScroll ? scrollEl?.scrollTop ?? 0 : 0;
    const view = st.diff ? renderDiff() : st.tab === 'worktrees' ? renderWorktrees() : renderChanges();
    if (!reduced() && !keepScroll) view.classList.add('enter');
    root.replaceChildren(view);
    if (st.note) root.append(frag(`<div class="gp-toast on" role="status">${esc(st.note)}</div>`));
    if (keepScroll && scrollEl) scrollEl.scrollTop = top;
    for (const f of root.querySelectorAll('.fold.shut')) f.inert = true;
  }
  function setNote(text) {
    st.note = text; clearTimeout(noteTimer);
    const toast = root.querySelector('.gp-toast');
    if (toast) toast.textContent = text; else if (text) root.append(frag(`<div class="gp-toast on" role="status">${esc(text)}</div>`));
    noteTimer = setTimeout(() => { st.note = ''; root.querySelector('.gp-toast')?.remove(); }, 1800);
  }

  // ---------------------------------------------------------------- 段ごとの描き足し
  // 頭・タブ・変更の一覧が先に出て、履歴・作業場所は届いた順に埋まる。描いてある所は作り直さず（動かさず）、新しく入る行だけ 240ms で出す。
  /** 新しく入った要素を 4px 上がりながら出す（gp-appear）。動きを減らす設定では動かさない */
  function appear(el) {
    if (!el || reduced()) return;
    el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
    const done = (e) => { if (e.target !== el) return; el.classList.remove('in'); el.removeEventListener('animationend', done); };
    el.addEventListener('animationend', done);
  }

  /** 会話の始まりの札を今の状態に合わせる。collapse は始まりまで読み終えたとき（札を 240ms で畳んでから消す） */
  function syncStart({ collapse = false } = {}) {
    const slot = root.querySelector('[data-start]');
    const html = startNoteHTML();
    if (html) {
      if (!slot) root.querySelector('.cg')?.insertAdjacentHTML('beforebegin', `<div class="fold" data-start><div>${html}</div></div>`);
      else if (!slot.classList.contains('shut')) slot.firstElementChild.innerHTML = html;
      return;
    }
    if (!slot) return;
    if (collapse && !reduced()) { slot.classList.add('shut'); slot.inert = true; setTimeout(() => { if (slot.classList.contains('shut')) slot.remove(); }, 320); }
    else slot.remove();
  }

  /**
   * 履歴が届いた・読み足したとき、グラフだけを差し替える（頭・タブ・変更の一覧・開いている箱の外は触らない）。
   * 前から出ていた行は動かさず、新しく入った行だけ出す。スクロールの位置と、行にあったフォーカスは保つ
   */
  function paintGraph() {
    const cg = root.querySelector('.cg');
    if (st.tab !== 'changes' || st.diff) return;
    if (!cg || !st.base) { paint({ keepScroll: true }); return; }
    const scrollEl = root.parentElement, top = scrollEl?.scrollTop ?? 0;
    const clY = root.querySelector('.cl')?.offsetTop ?? 0;
    const had = new Set([...cg.querySelectorAll('.cg-row:not(.sk)')].map((x) => x.dataset.k));
    const active = document.activeElement?.closest?.('.cg-row')?.dataset.k;
    buildLayout();
    const next = frag(graphHTML());
    cg.replaceWith(next);
    for (const row of next.querySelectorAll('.cg-row')) if (!had.has(row.dataset.k)) appear(row.parentElement);
    syncStart({ collapse: true });
    // 「この会話の間」の題の「HH:MM の撮影から」は、履歴（会話の始まりの時刻）が届いてから付く。一覧は作り直さず、その 1 語だけ足す
    const tt = root.querySelector('.cl .cl-tt > b');
    const note = st.sel.k === 'session' ? listModel().titleNote : '';
    if (tt && note) {
      let w = tt.querySelector('.w');
      if (!w) { tt.append(' '); w = document.createElement('span'); w.className = 'w'; tt.append(w); }
      w.textContent = note;
    }
    applySelection();
    // 一覧より下を見ていたときは、グラフが伸びた分だけ送って、見ていた所を動かさない
    if (scrollEl) scrollEl.scrollTop = top > 0 && top >= clY ? top + ((root.querySelector('.cl')?.offsetTop ?? 0) - clY) : top;
    if (active) rowOfKey(active)?.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- 取得
  async function loadRange(range) {
    const id = sid(); let data = null;
    try { data = await ask('gitPanel', { sessionId: id, range, only: 'changes' }); } catch { /* */ }
    if (sid() !== id) return;
    const first = !st.changes[range];
    st.changes[range] = data?.changes ?? { failed: true, files: [], total: { files: 0, add: 0, del: 0 } };
    if (st.sel.k === range && st.tab === 'changes' && !st.diff) {
      const cl = root.querySelector('.cl');
      if (cl) { cl.innerHTML = listHTML(); wireTree(); applySelection(); paintTabs(); if (first) appear(cl); }
    }
  }
  async function loadCommit(hash) {
    const id = sid(); let res = null;
    try { res = await ask('gitCommit', { sessionId: id, hash }); } catch { /* */ }
    if (sid() !== id) return;
    st.commitData[hash] = res?.commit ?? { failed: true, commit: { hash, short: hash.slice(0, 7), subject: '', author: '', at: 0, parents: [] }, files: [], total: { files: 0, add: 0, del: 0 } };
    if (st.open === hash) refillBox();
  }
  /** 履歴の最初の 1 ページ。会話の始まりの位置（session.pos）は core が 1 回で数えて返す（探して続けて読むことはしない）。届いたら true */
  async function loadHistory() {
    const id = sid(), cur = st; cur.histLoading = true;
    let res = null;
    try { res = await ask('gitHistory', { sessionId: id, limit: HISTORY_PAGE }); } catch { /* */ }
    if (st !== cur || sid() !== id) return false;
    st.histLoading = false; st.start = null;
    st.hist = res?.history ?? null;
    return true;
  }
  async function loadMoreHistory() {
    const id = sid(), cur = st; let more = null;
    try { more = await ask('gitHistory', { sessionId: id, limit: HISTORY_PAGE, cursor: st.hist.next }); } catch { /* */ }
    if (st !== cur || sid() !== id || !more?.history) return;
    // 続きを読む間に HEAD が動いたら、--skip がずれるので最初から読み直す
    if (more.history.head !== st.hist.head) { if (await loadHistory()) paintGraph(); return; }
    const seen = new Set(st.hist.commits.map((c) => c.hash));
    st.hist = { ...st.hist, commits: [...st.hist.commits, ...more.history.commits.filter((c) => !seen.has(c.hash))], next: more.history.next };
    paintGraph();
  }
  /** 「始まりまで読む」: 会話の始まりのコミットまでを 1 回で読み足し、札を畳み、⚑ を本当の位置に出す */
  async function findStart() {
    const id = sid(), cur = st, hist = st.hist, s = hist?.session;
    if (!s?.head || st.start === 'loading' || hist.next == null) return;
    const fromBtn = Boolean(document.activeElement?.closest?.('[data-startfind]'));
    st.start = 'loading'; syncStart();
    if (fromBtn) root.querySelector('.startnote')?.focus({ preventScroll: true });
    let res = null;
    try { res = await ask('gitHistory', { sessionId: id, cursor: hist.next, through: true }); } catch { /* */ }
    if (st !== cur || sid() !== id || st.hist !== hist) return;
    const got = res?.history;
    if (!got) { st.start = null; syncStart(); return; }   // 読めなかった: ボタンに戻す（もう一度押せる）
    if (got.session?.lost) { st.start = 'lost'; syncStart(); return; }
    if (got.head !== hist.head) { if (await loadHistory()) paintGraph(); return; }
    const seen = new Set(hist.commits.map((c) => c.hash));
    st.hist = { ...hist, commits: [...hist.commits, ...got.commits.filter((c) => !seen.has(c.hash))], next: got.next };
    st.start = null;
    paintGraph();
    if (fromBtn) { const row = rowOfKey(s.head); if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } }
  }

  /** 作業場所タブを開いたとき: 各 worktree の状態まで読む（一覧は先に届いていれば、名前とパスはそのまま、状態の所だけ埋める） */
  async function loadWorktrees() {
    const id = sid(), cur = st;
    if (cur.wtFull) return;
    cur.wtFull = true; cur.wtFailed = false;
    let res = null;
    try { res = await ask('gitWorktrees', { sessionId: id }); } catch { /* */ }
    cur.wtFull = false;
    if (st !== cur || sid() !== id) return;
    st.wt = res?.worktrees ?? null; st.wtFailed = !st.wt;
    if (st.tab === 'worktrees' && !st.diff) paint({ keepScroll: true }); else paintTabs();
  }
  /**
   * パネルを開いたとき: 一覧（名前・パス・件数）だけ。git は worktree list の 1 回で、各 worktree の中は読まない。
   * 件数はタブの名前（読み上げ・ツールチップ）に出す。replace は再読み込みで、読んである状態つきの一覧を捨てて取り直す
   */
  async function loadWtList({ replace = false } = {}) {
    const id = sid(), cur = st;
    let res = null;
    try { res = await ask('gitWorktrees', { sessionId: id, only: 'list' }); } catch { /* */ }
    if (st !== cur || sid() !== id || !res?.worktrees) return;
    if (st.wt && !st.wt.partial && !replace) return;   // 状態つきが先に届いていたら、そちらを使う
    st.wt = res.worktrees;
    if (st.tab === 'worktrees' && !st.diff) paint({ keepScroll: true }); else paintTabs();
  }
  async function loadWtDetail(w) {
    const id = sid(); let res = null;
    try { res = await ask('gitWorktree', { sessionId: id, worktree: w.path }); } catch { /* */ }
    if (sid() !== id) return;
    st.wtDetail.set(w.path, res?.worktree ?? { failed: true, committed: { files: [] }, uncommitted: { files: [] }, head: null, base: null });
    paint({ keepScroll: true });
  }

  /**
   * 開いたとき・再読み込み・ターンの終わり。段に分けて出す:
   *   1 gitPanel の軽い答えが来たら、頭・タブ・変更の一覧を描く（履歴・範囲の一覧は骨組み）
   *   2 履歴・「この会話の間」の一覧・開いた箱・作業場所の件数を並べて読み、届いた順に描き足す
   */
  async function load({ force = false } = {}) {
    const id = sid();
    if (!id) return;
    const mine = ++ticket;
    st.loading = true; st.failed = false;
    if (!st.base) paint();
    let data = null;
    try { data = await ask('gitPanel', { sessionId: id, range: 'uncommitted', only: 'light' }); } catch { /* 取れなかった */ }
    if (mine !== ticket || sid() !== id) return;
    st.loading = false; st.at = Date.now();
    if (!data?.git) { st.base = null; st.failed = true; onState(null, { foreign: foreign() }); paint(); return; }
    const had = Boolean(st.base);
    // 読み直す間は前の「この会話の間」の一覧を残す（骨組みに戻さない）。コミットの中身は変わらないので、取れたものは残す
    const keep = had && st.sel.k === 'session' && data.changes?.hasSession ? st.changes.session : null;
    st.base = data; st.changes = { uncommitted: data.changes, ...(keep ? { session: keep } : {}) };
    if (!data.changes?.hasSession && st.sel.k === 'session') st.sel = { k: 'uncommitted' };
    if (st.initial === 'session' && data.changes?.hasSession) st.sel = { k: 'session' };
    st.initial = 'uncommitted';
    // 触っていないうちは、コミットしていない変更があれば「未コミットの変更」の行を開いておく（Esc はこの箱でなくパネルを閉じる）
    if (!st.touched && !st.open && st.sel.k === 'uncommitted' && (data.changes?.total?.files ?? 0) > 0) { st.open = WT_KEY; st.auto = true; }
    onState(data.git, { foreign: foreign() });
    st.commitData = Object.fromEntries(Object.entries(st.commitData).filter(([, v]) => !v.failed));
    const sameHead = !force && st.hist && data.git.head && st.hist.head?.startsWith(data.git.head);
    if (!sameHead) st.histLoading = true;
    // 差分を開いている間に取り直しが終わったら、差分は開いたまま中身だけ読み直す
    if (st.diff) { st.diff.cache.clear(); st.diff.failed.clear(); loadDiffAt(st.diff.index); }
    // 段 1。ここに PR の行など、gitPanel の軽い答えだけで描ける頭の部品を足す（履歴・作業場所を待たせない）
    paint({ keepScroll: had });
    // 段 2
    const jobs = [];
    if (!sameHead) jobs.push(loadHistory().then((ok) => { if (ok && mine === ticket) paintGraph(); }));
    if (st.sel.k === 'session') jobs.push(loadRange('session'));
    if (st.open && st.open !== WT_KEY && !st.commitData[st.open]) jobs.push(loadCommit(st.open));
    if (st.tab === 'worktrees') jobs.push(loadWorktrees());
    else if (!st.wt || force) jobs.push(loadWtList({ replace: force }));
    await Promise.all(jobs);
  }

  // ---------------------------------------------------------------- 開閉
  function resetFor(id) {
    if (st.key === id) return;
    ticket++; leftovers.reset();
    st = fresh(id);
  }

  function open(element, { sessionId = null, range = null } = {}) {
    target = sessionId && sessionId !== session().id ? sessionId : null;
    const id = sid();
    if (!id) return;
    resetFor(id);
    if (range === 'session') st.initial = 'session';
    opener = element ?? null;
    preview.openPanel({
      key: KEY, title: t('git.panel'), subtitle: '', label: t('git.panel'), element: opener, body: root,
      head: [{ node: reloadBtn }], toolbar: [tabs],
      onClose: () => { opener?.setAttribute?.('aria-expanded', 'false'); onOpenChange(false); },
    });
    onOpenChange(true);
    paint();
    load();
  }
  let onOpenChange = () => {};

  function toggle(element, options) {
    if (isOpen()) preview.close(true); else open(element, options);
  }

  // Esc: 差分を開いている間は、パネルを閉じずに一覧へ戻る。差分が無く箱が開いていれば、箱を閉じる（どちらもパネルの外にフォーカスがあっても）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || !isOpen() || e.defaultPrevented) return;
    const boxOpen = !st.diff && st.tab === 'changes' && st.open && !st.auto;
    if (!st.diff && !boxOpen) return;
    // ダイアログ・メニューが開いている間と、フォーカスがパネルの外（入力欄など）にあるときは奪わない
    if (document.querySelector('dialog[open], .pop.menu:not([hidden])')) return;
    const active = document.activeElement;
    if (active && active !== document.body && !document.getElementById('filePreview')?.contains(active)) return;
    // 箱の中のファイルの行・グラフの行にフォーカスがあるときは、行ごとの移り方（ファイル → 親の行 → 閉じる）に任せる
    if (boxOpen && active?.closest?.('.cg-row, .ins .fr, .ins .grp')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (st.diff) closeDiff(); else { const row = rowOfKey(st.open); const inside = Boolean(active?.closest?.('.ins')); toggleBox(st.open); if (inside) row?.focus({ preventScroll: true }); }
  }, true);

  // Ctrl+Shift+G（macOS は ⌘⇧G）で開閉。IME の変換中・ダイアログ・設定の画面では奪わない
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || !e.shiftKey || e.altKey || e.code !== 'KeyG') return;
    if (!(/Mac/.test(navigator.platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
    if (document.body.classList.contains('settings') || document.querySelector('dialog[open]') || !canOpen()) return;
    e.preventDefault();
    toggle(document.getElementById('gitEntry'));
  });

  return {
    open, toggle, isOpen, reload: () => { if (isOpen()) load({ force: true }); },
    /** 別の会話へ移った・会話を閉じた。開いているパネルは閉じる */
    reset() { target = null; resetFor(null); if (isOpen()) preview.close(false); },
    /** 会話の今の状態が変わった（ターンの終わり）。開いていれば取り直す */
    changed() { if (isOpen()) load(); },
    onOpenChange(fn) { onOpenChange = fn; },
  };
}
