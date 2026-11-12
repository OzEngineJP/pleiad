import { node, text, icon, api, pageUrl, fileActions, vizActions, request, date, sessionId } from './bridge.mjs';
import { folderIcon, fileIcon } from '../icons.mjs';
import { browserIcon } from '../tab-strip.mjs';
import { fileRow } from './dir.mjs';
import { recentSkeleton, foldersSkeleton, gridSkeleton, countSkeleton, afterDelay } from './skeleton.mjs';

const glyph = (svg, className) => { svg.classList.add(className); return svg; };
const VIZ_SHOWN = 5;

/**
 * [変更] の名札は、git のフォルダーなら「変更」、そうでなければ「git」。どちらかは問い合わせが返るまで分からないので、
 * 会話ごとに前の結果を覚えておき（sessionStorage。無ければ変数だけ）、同じ名札を最初から出す。初めて開くときだけ、名札の場所に
 * 固定幅の骨組みを置いて、届いたら名札を入れる（「変更」から「git」へ書き換わるのを見せない。ボタンは最初から押せる）
 */
const gitKey = `pleiad:new-git:${sessionId}`;
const gitKnown = new Map();
const recallGit = () => {
  if (gitKnown.has(gitKey)) return gitKnown.get(gitKey);
  try { const value = sessionStorage.getItem(gitKey); return value === 'repo' || value === 'none' ? value : null; } catch { return null; }
};
const rememberGit = value => { gitKnown.set(gitKey, value); try { sessionStorage.setItem(gitKey, value); } catch { /* 覚えられなくても動く */ } };
const gitLabel = (label, kind, count) => { label.textContent = kind === 'repo' ? text('new.changes', { count }) : text('new.git'); };

/** 見出しの付いた区画。もうあれば（読み直し）前の中身のまま残し、届いたところから差し替える */
function slot(root, name, key) {
  const old = root.querySelector(`:scope > [data-slot="${name}"]`);
  if (old) return { section:old, fresh:false };
  const section = node('section'); section.dataset.slot = name; section.append(node('h2', '', text(key)));
  root.append(section); return { section, fresh:true };
}
/** 区画の見出しより下を差し替える（骨組み・前の中身を捨てて、届いた行を入れる） */
const fill = (section, ...children) => { for (const child of [...section.children]) if (child.tagName !== 'H2') child.remove(); section.append(...children); };
const hasBody = section => section.querySelector(':scope > :not(h2)') !== null;

/**
 * 新しいタブ。見出しと [変更] [プラグイン] はすぐ出し、件数・最近のファイル・作業フォルダーは届いた順に入れる（ADR 0321）。
 * 待ちが 150ms を超えた区画だけ骨組みを出す。読み直し（root に前の中身がある）は骨組みも空白も出さない。
 */
export async function renderNew(root, { alive = () => true } = {}) {
  document.title = `${text('newTab')} · Pleiad`;
  root.classList.add('new-page');
  const { section:conversation, fresh } = slot(root, 'conv', 'new.conversation');
  const recent = slot(root, 'recent', 'new.recent').section, folders = slot(root, 'folders', 'new.folders').section;
  const cancel = [];
  if (fresh) {
    const shortcuts = node('div', 'shortcuts');
    for (const kind of ['git', 'plugins']) {
      const link = node('a', 'shortcut'); link.href = pageUrl(kind); link.dataset.kind = kind;
      // i18n-dynamic: new.
      const known = kind === 'git' ? recallGit() : null;
      const label = node('span', '', kind === 'git' ? (known === 'none' ? text('new.git') : known === 'repo' ? text('new.changesLead') : '') : text(`new.${kind}`));
      link.append(glyph(browserIcon(kind), 'shortcut-icon'), label);
      if (kind === 'git') {
        link.append(countSkeleton());
        // まだ分からない間は名札の代わりに骨組み（読み上げには「変更」を当てておく）
        if (!known) { label.classList.add('shortcut-pending'); link.setAttribute('aria-label', text('new.changesLead')); }
      }
      shortcuts.append(link);
    }
    conversation.append(shortcuts);
    cancel.push(afterDelay(() => { if (alive() && !hasBody(recent)) recent.append(recentSkeleton()); }));
    cancel.push(afterDelay(() => { if (alive() && !hasBody(folders)) folders.append(foldersSkeleton()); }));
  }
  // 件数は軽い数え方で後から入る（変更の一覧とは別の問い合わせ。ボタンの幅・高さは件数の有る無しで変わらない）
  const gitLink = conversation.querySelector('a.shortcut[data-kind="git"]');
  void (async () => {
    const label = gitLink?.querySelector('span');
    if (!label) return;
    try {
      const result = await api('git', { kind:'changes', only:'count' });
      if (alive()) {
        const repo = Boolean(result.changes);
        rememberGit(repo ? 'repo' : 'none');
        gitLabel(label, repo ? 'repo' : 'none', result.changes?.total?.files ?? result.changes?.files.length);
      }
    } catch { if (alive()) { gitLabel(label, 'none'); /* Keep the entry available when git cannot be read. */ } }
    if (!alive()) return;
    label.classList.remove('shortcut-pending'); gitLink.removeAttribute('aria-label');
    gitLink.querySelector('.cnt')?.remove();
  })();
  const data = await api('recent').finally(() => { for (const stop of cancel) stop(); });
  if (!alive()) return;
  const visualizations = data.visualizations ?? [];
  const staleViz = root.querySelector(':scope > [data-slot="viz"]');
  if (visualizations.length) {
    const section = node('section', 'viz-section'); section.dataset.slot = 'viz'; section.append(node('h2', '', text('new.visualizations')));
    const list = node('div', 'viz-list');
    // 行を押すと元の HTML を開く（消えた・記録の無いものは保存した版）。iframe の外にいる単独の画面は隔離の URL へ行く
    const hosted = parent !== window || typeof globalThis.plyPage === 'function';
    const rows = visualizations.map(item => {
      const row = node('div', 'viz-row');
      const missing = item.missing === true || !item.path;
      // 主操作はリンク（行の ⋯ と兄弟。開く先は元の HTML、消えた・記録の無いものは保存した版）。iframe の外にいる単独の画面は隔離の URL へ行く
      const link = node('a', 'viz-link'); link.title = item.title;
      link.href = missing ? item.url : pageUrl('file', item.path);
      link.append(glyph(browserIcon('viz'), 'viz-icon'), node('span', 'viz-title', item.title));
      row.append(link);
      const when = node('span', 'viz-time', item.at ? date(item.at) : '');
      row.append(when);
      if (missing) { const badge = node('span', 'viz-saved', text('new.savedVersion')); row.append(badge); row.classList.add('viz-missing'); }
      vizActions(row, { hash:item.hash, entry:item.entry, title:item.title, path:item.path ?? '', missing:item.missing === true });
      if (hosted) link.addEventListener('click', event => { event.preventDefault();
        request('open-viz', { viz:{ hash:item.hash, entry:item.entry, title:item.title },
          ...(item.path ? { path:item.path } : {}), missing:item.missing === true }); });
      return row;
    });
    list.replaceChildren(...rows.slice(0, VIZ_SHOWN)); section.append(list);
    if (rows.length > VIZ_SHOWN) {
      const toggle = node('button', 'viz-toggle', text('new.showAll', { count:rows.length })); toggle.type = 'button';
      let all = false;
      toggle.addEventListener('click', () => { all = !all; list.replaceChildren(...(all ? rows : rows.slice(0, VIZ_SHOWN))); toggle.textContent = text(all ? 'new.showLess' : 'new.showAll', { count:rows.length }); });
      section.append(toggle);
    }
    if (staleViz) staleViz.replaceWith(section); else conversation.after(section);
  } else staleViz?.remove();
  const recentRows = [];
  if (!data.files.length) recentRows.push(node('p', 'empty', text('new.emptyRecent')));
  for (const file of data.files) {
    const row = node('div', 'recent-row'), link = node('a', 'recent-link'); link.href = pageUrl('file', file.path);
    link.append(glyph(icon(fileIcon), 'file-icon'), node('span', 'recent-name', file.name));
    const parts = [file.actor, text(`new.sources.${file.source}`)];
    const elapsed = Date.now() - new Date(file.at).getTime();
    if (Number.isFinite(elapsed)) { const minutes = Math.max(0, Math.floor(elapsed / 60000)); parts.push(new Intl.RelativeTimeFormat(document.documentElement.lang, { numeric:'auto' }).format(-minutes, 'minute')); }
    row.append(link, node('span', 'recent-source', parts.filter(Boolean).join(' · '))); fileActions(row, file.path); recentRows.push(row);
  }
  fill(recent, ...recentRows);
  const folderRows = [];
  if (!data.folders.length) folderRows.push(node('p', 'empty', text('new.emptyFolders')));
  for (const folder of data.folders) {
    const row = node('div', 'folder-row'), link = node('a'); link.href = pageUrl('dir', folder.path); link.title = folder.path; link.append(glyph(glyph(icon(folderIcon), 'file-icon'), 'folder'), node('span', '', folder.name)); row.append(link); fileActions(row, folder.path, 'directory'); folderRows.push(row);
  }
  // フォルダーの行はすぐ入れ、先頭のフォルダーの中身（格子）は届いたら入れる（読み直しは前の格子を残して差し替える）
  const lead = data.folders[0], previousGrid = folders.querySelector(':scope > .folder-grid');
  fill(folders, ...folderRows, ...(previousGrid && lead ? [previousGrid] : []));
  if (!lead) return;
  const stop = previousGrid ? () => {} : afterDelay(() => { if (alive() && !folders.querySelector(':scope > .folder-grid')) folders.append(gridSkeleton()); });
  try {
    const tree = await api('tree', { path:lead.path }), grid = node('div', 'folder-grid');
    for (const item of tree.children.slice(0, 6)) grid.append(fileRow({ ...item, path:item.id, size:0 }));
    if (alive()) { folders.querySelector(':scope > .sk')?.remove(); previousGrid?.remove(); folders.append(grid); }
  } catch { if (alive()) folders.querySelector(':scope > .sk')?.remove(); /* The folder entry remains usable if its contents changed. */ }
  finally { stop(); }
}
