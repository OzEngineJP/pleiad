// git パネルの頭の PR の行（この会話の PR と、委譲した子の会話の PR を 1 つの一覧に。docs/git-panel-pr.md、ADR 0206）。
// 状態は色を使わず、形（アイコン）と語で分ける。順は オープン → ドラフト → マージ済み → クローズ、同じ状態の中は新しい順（core が新しい順で返す）。
// 3 件まで出し、残りは「ほか N 件」で広げる。番号は覚え書きからすぐ出し、題・状態・チェックは gh が返るまで .history-line の骨組みにする。
// gh が無い・ログインしていないときは、番号・repo・リンクだけにして、理由を 1 行添える。
// 文字列に埋める値は esc を通す。パネルの中身を作る web/git-panel.mjs とは独立で、PR の行だけをこの部品が持つ。
import { t } from './i18n.mjs';
import { openInBrowserIcon } from './icons.mjs';
import { prIcon, prOpenIcon, prDraftIcon, prMergedIcon, prClosedIcon, checkPassIcon, checkFailIcon, checkPendingIcon } from './git-icons.mjs';

export const PR_SHOWN = 3;
const ORDER = ['open', 'draft', 'merged', 'closed'];
const STATE_ICON = { open: prOpenIcon, draft: prDraftIcon, merged: prMergedIcon, closed: prClosedIcon };
const CHECK_ICON = { pass: checkPassIcon, fail: checkFailIcon, pending: checkPendingIcon };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** http(s) の URL だけをリンクにする */
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? String(u) : '');
const repoOf = (url) => /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(String(url ?? ''))?.[1] ?? '';
const frag = (html) => { const tpl = document.createElement('template'); tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; };

/** 状態の順に並べる（同じ状態の中は渡された順。状態がまだ無いものは、読めた順の最後） */
export function sortPrs(prs) {
  const rank = (p) => { const i = ORDER.indexOf(p.state); return i < 0 ? ORDER.length : i; };
  return (prs ?? []).map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(({ p }) => p);
}

// i18n-dynamic: git.prs.state
const stateWord = (s) => (ORDER.includes(s) ? t(`git.prs.state.${s}`) : '');
// i18n-dynamic: git.prs.check
const checkWord = (c) => (CHECK_ICON[c] ? t(`git.prs.check.${c}`) : '');

/** 行のリンクの名前（読み上げ・ツールチップ）。状態・チェック・子の会話で作成を含める */
export function prLabel(p) {
  const sep = t('git.prs.sep');
  const parts = [p.title || p.repo || repoOf(p.url), stateWord(p.state), checkWord(p.checks), p.child ? t('git.prs.child') : ''].filter(Boolean);
  return [t('git.prTitle', { number: p.number }), ...parts].join(sep);
}

function rowHTML(p, loading) {
  const href = safeUrl(p.url);
  const n = `<span class="n">#${esc(p.number)}</span>`;
  // 状態がまだ読めていない間は、題・状態の所を骨組みにする（リンクにはしない。読めたら置き換わる）
  if (loading && !p.state) {
    return `<div class="gp-pr sk" data-n="${esc(p.number)}">${prIcon}${n}<span class="t"><span class="history-line" style="width:62%"></span></span><span class="s"><span class="history-line" style="width:84px"></span></span><span class="go-ph"></span></div>`;
  }
  const known = Boolean(p.state);
  const words = known ? `${esc(stateWord(p.state))}${p.checks ? `<span class="ci${p.checks === 'fail' ? ' bad' : ''}">${CHECK_ICON[p.checks]}<span class="cw">${esc(checkWord(p.checks))}</span></span>` : ''}` : '';
  const text = p.title || p.repo || repoOf(p.url);
  const tip = p.child ? t('git.prs.titleChild', { number: p.number }) : t('git.prTitle', { number: p.number });
  const body = `${STATE_ICON[p.state] ?? prIcon}${n}<span class="t"${text ? ` title="${esc(text)}"` : ''}>${esc(text)}</span>${known ? `<span class="s">${words}</span>` : ''}${openInBrowserIcon.replace('class="i"', 'class="i go"')}`;
  const cls = `gp-pr${p.state === 'merged' || p.state === 'closed' ? ' done' : ''}`;
  return href
    ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(tip)}" aria-label="${esc(prLabel(p))}" data-n="${esc(p.number)}">${body}</a>`
    : `<div class="${cls}" data-n="${esc(p.number)}">${body}</div>`;
}

/** 行の全体の HTML。model: { prs, reason, loading, expanded }。PR が無ければ空文字（何も出さない） */
export function prsHTML({ prs = [], reason = null, loading = false, expanded = false } = {}) {
  if (!prs.length) return '';
  const sorted = sortPrs(prs);
  const shown = expanded ? sorted : sorted.slice(0, PR_SHOWN);
  const rest = sorted.length - shown.length;
  const quiet = !loading && reason ? `<p class="gp-quiet">${esc(reason === 'no-gh' ? t('git.prs.noGh') : t('git.prs.noAuth'))}</p>` : '';
  return `${shown.map((p) => rowHTML(p, loading)).join('')}${rest > 0 ? `<button class="gp-more" type="button" aria-expanded="false" aria-label="${esc(t('git.prs.moreLabel', { count: rest }))}">${esc(t('git.prs.more', { count: rest }))}</button>` : ''}${quiet}`;
}

/**
 * 頭に置く PR の行。el を道具の列に渡し、パネルを読むたびに load(会話の id, 覚え書きの PR) を呼ぶ。
 * ask は WS コマンドを呼ぶ関数（command, args）→ Promise。
 */
export function createPrsRow({ ask }) {
  const el = frag(`<div class="gp-prs" role="group" aria-label="${esc(t('git.prs.group'))}" hidden></div>`);
  let model = { prs: [], reason: null, loading: false, expanded: false };
  let ticket = 0;
  const paint = () => {
    el.innerHTML = prsHTML(model);
    el.hidden = !model.prs.length;
    el.setAttribute('aria-busy', String(model.loading));
  };
  el.addEventListener('click', (e) => {
    if (!e.target.closest('.gp-more')) return;
    model = { ...model, expanded: true };
    paint();
    el.querySelectorAll('a.gp-pr')[PR_SHOWN]?.focus();
  });
  /** 読み直すとき、前に読めていた状態は新しいものが届くまで残す（骨組みに戻して点滅させない） */
  const keepKnown = (next) => next.map((p) => { const old = model.prs.find((o) => o.url === p.url); return old ? { ...old, ...p } : p; });
  return {
    el,
    model: () => model,
    /** 会話が替わった・閉じた */
    reset() { ticket++; model = { prs: [], reason: null, loading: false, expanded: false }; paint(); },
    /** seed: タイムラインにある PR（{ number, url }）。番号をすぐ出すために使う */
    async load(id, seed = []) {
      const mine = ++ticket;
      model = { ...model, loading: true, prs: model.prs.length ? model.prs : seed.map((p) => ({ number: p.number, url: p.url })) };
      paint();
      let first = null;
      try { first = await ask('gitPrs', { sessionId: id, states: false }); } catch { /* 番号だけで続ける */ }
      if (mine !== ticket) return;
      if (first?.prs) { model = { ...model, prs: keepKnown(first.prs) }; paint(); }
      let full = null;
      try { full = await ask('gitPrs', { sessionId: id }); } catch { /* 状態は読めなかった */ }
      if (mine !== ticket) return;
      model = { ...model, prs: full?.prs ? keepKnown(full.prs) : model.prs, reason: full?.reason ?? null, loading: false };
      paint();
    },
  };
}
