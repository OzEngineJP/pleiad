// 設定 › バージョンと更新 › リリースノート（docs/design-system.md「アプリの更新」）。
// 1 つの節に、同じ形の行（版 · 日付 / 題・右の ›）を並べる。行を押すと本文が開く。
//   - 更新が見つかっている間: 「新しいバージョン」（入っている版より新しく、見つけた版まで）→「これまでのバージョン」
//   - 更新したあと（前に入っていた版が分かるとき）: 「今回の更新」（前の版より新しく、いまの版まで）→「以前のバージョン」。次の更新まで残す
//   - どちらでもない: 見出し無しで全版の一覧
// 6 版までは全部、それより多いときは 5 版 + 「ほか N バージョンを表示」。古い版は 10 版ずつ「さらに表示」。
// 見つけた版のノートは GitHub の本文（信頼できない Markdown なので renderMarkdown を通す）、いまの版以前は同梱の release-info.json
// （{version, date, title, sections:[{title, items}]}。textContent で入れる）。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { renderMarkdown } from './render.mjs';
import { compareVersions, versionsBetween } from './versions.mjs';

/** 範囲の版がこの数までは全部出す。超えたら FOLD_SHOWN 版だけ出して残りは畳む */
export const FOLD_LIMIT = 6;
export const FOLD_SHOWN = 5;
/** 古い版を一度に出す数 */
export const PAGE = 10;

const releasesOf = value => (Array.isArray(value) ? value : []).filter(r => r && typeof r.version === 'string');
const slash = date => String(date ?? '').replaceAll('-', '/');

/**
 * 何をどの順に出すか（描画に依らない部分）。
 * @returns {{ groups: { key: string, head: string, detail: string, rows: object[], past: boolean, open: boolean }[], current: string }}
 */
export function planNotes({ info, state }) {
  const all = releasesOf(info?.releases);
  const current = info?.version ?? state?.version ?? '';
  const group = (key, head, rows, detail = '', extra = {}) => ({ key, head, detail, rows, past: false, open: false, ...extra });
  const count = n => t('updates.notes.count', { count: n });
  if (state?.target) {
    // 更新が見つかっている。GitHub の一覧から作った途中の版を、入っている版の次から見つけた版まで
    let incoming = versionsBetween(releasesOf(state.releases), state.version, state.target);
    // 一覧が取れなかったとき（取れても空のとき）は最新の版のノートだけ
    if (!incoming.length && state.notes) incoming = [{ version: state.target, date: '', title: '', body: state.notes }];
    if (incoming.length) {
      return {
        current,
        groups: [
          group('skip', t('updates.notes.newVersions'), incoming, count(incoming.length), { open: incoming.length === 1 }),
          group('past', t('updates.notes.pastVersions'), all, '', { past: true }),
        ],
      };
    }
  }
  const previous = state?.previousVersion;
  if (!state?.target && previous) {
    const range = versionsBetween(all, previous, current);
    if (range.length) {
      const detail = range.length === 1 ? t('updates.notes.from', { from: previous }) : t('updates.notes.fromCount', { from: previous, count: range.length });
      return {
        current,
        groups: [
          group('skip', t('updates.notes.thisUpdate'), range, detail, { open: range.length === 1 }),
          group('past', t('updates.notes.earlierVersions'), all.filter(r => compareVersions(r.version, previous) <= 0), '', { past: true }),
        ],
      };
    }
  }
  return { current, groups: [group('past', '', all, '', { past: true })] };
}

const chevron = () => {
  const svg = svgEl('svg', { class: 'rn-chev', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M6 3.5 10.5 8 6 12.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
};

/** 本文。GitHub の本文は Markdown、同梱のノートは見出し + 箇条書き */
function bodyOf(release) {
  const box = el('div', 'rn-content');
  if (typeof release.body === 'string') {
    box.innerHTML = renderMarkdown(release.body);
    return box;
  }
  for (const section of Array.isArray(release.sections) ? release.sections : []) {
    box.append(el('h4', null, section.title));
    const list = el('ul');
    for (const item of Array.isArray(section.items) ? section.items : []) list.append(el('li', null, item));
    box.append(list);
  }
  return box;
}

/**
 * root の中にリリースノートを作る。paint のたびに update を呼んでよい（中身が変わらなければ作り直さない。
 * 開いた行・「ほか N」「さらに表示」で出した分は、作り直しても保つ）。
 * reduceMotion() が true のときは、行を足すときの出現のアニメーションを付けない。
 */
export function createReleaseNotes(root, { reduceMotion = () => false } = {}) {
  let signature = '', lastShape = '', skipHead = null, plan = null;
  const opened = new Set();     // 開いている行（版）
  const revealed = new Set();   // 「ほか N バージョン」を出した節
  const shown = new Map();      // 節 → 古い版を出した数

  function row(release, current, { fresh = false } = {}) {
    const wrap = el('div', 'rn-row');
    const head = el('button', 'rn-head');
    head.type = 'button';
    const meta = [release.version, slash(release.date), current ? t('updates.notes.current') : ''].filter(Boolean).join(' · ');
    const text = el('span', 'rn-txt');
    text.append(el('span', 'rn-meta', meta), el('span', 'rn-title', release.title || `Pleiad ${release.version}`));
    head.append(text, chevron());
    const body = el('div', 'rn-body');
    const inner = el('div');
    body.append(inner);
    wrap.append(head, body);
    if (fresh && !reduceMotion()) wrap.classList.add('rn-in');
    const fill = () => { if (!inner.children.length) inner.append(bodyOf(release)); };
    const set = open => {
      if (open) fill();
      wrap.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
      if (open) opened.add(release.version); else opened.delete(release.version);
    };
    head.setAttribute('aria-expanded', 'false');
    head.onclick = () => set(!wrap.classList.contains('open'));
    if (opened.has(release.version)) set(true);
    return { wrap, head };
  }

  function build() {
    const out = [];
    skipHead = null;
    for (const g of plan.groups) {
      const box = el('div', 'rn-group');
      if (g.head) {
        const head = el('div', 'rn-gh');
        head.append(g.head);
        if (g.detail) head.append(el('span', null, g.detail));
        if (g.key === 'skip') skipHead = head;
        box.append(head);
      }
      const list = el('div', 'rn-list');
      box.append(list);
      const add = (rows, fresh) => {
        const made = rows.map(r => row(r, r.version === plan.current, { fresh }));
        list.append(...made.map(m => m.wrap));
        return made;
      };
      if (g.past) {
        // 古い版は 10 版ずつ
        let count = Math.min(g.rows.length, shown.get(g.key) ?? PAGE);
        add(g.rows.slice(0, count), false);
        const more = () => {
          if (count >= g.rows.length) return;
          const next = g.rows.slice(count, count + PAGE);
          count += next.length; shown.set(g.key, count);
          const [first] = add(next, true);
          if (count >= g.rows.length) button.remove();
          first?.head.focus();
        };
        const button = el('button', 'btn btn-quiet rn-more', t('updates.notes.more'));
        button.type = 'button';
        button.onclick = more;
        if (count < g.rows.length) box.append(button);
      } else {
        const folded = g.rows.length > FOLD_LIMIT && !revealed.has(g.key);
        add(folded ? g.rows.slice(0, FOLD_SHOWN) : g.rows, false);
        if (folded) {
          const rest = g.rows.slice(FOLD_SHOWN);
          const button = el('button', 'btn btn-quiet rn-more', t('updates.notes.showMore', { count: rest.length }));
          button.type = 'button';
          button.onclick = () => {
            revealed.add(g.key);
            const [first] = add(rest, true);
            button.remove();
            first?.head.focus();
          };
          box.append(button);
        }
      }
      out.push(box);
    }
    root.replaceChildren(...out);
  }

  function update({ info, state }) {
    plan = planNotes({ info, state });
    const next = JSON.stringify([plan.current, plan.groups.map(g => [g.key, g.head, g.detail, g.rows.map(r => r.version), g.rows[0]?.body?.length ?? 0])]);
    if (next === signature) return;
    // 節の組み立てが替わったら（更新が見つかった・更新した）、前の内容で出した分は忘れる。言語が替わっただけなら保つ
    const shape = JSON.stringify(plan.groups.map(g => [g.key, g.rows.map(r => r.version)]));
    if (shape !== lastShape) {
      revealed.clear(); shown.clear();
      // 1 版だけ飛ばしたときは、その版を開いておく
      for (const g of plan.groups) if (g.open) opened.add(g.rows[0].version);
    }
    lastShape = shape;
    signature = next;
    build();
  }

  /** 「今回の更新」「新しいバージョン」の見出しへ。動きを減らす設定のときは滑らせない */
  function scrollToUpdate() {
    skipHead?.scrollIntoView?.({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    return Boolean(skipHead);
  }

  return { update, scrollToUpdate };
}
