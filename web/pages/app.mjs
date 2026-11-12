import { page, query, api, loadContent, initializeEnv, errorView, openFile, node, button, text } from './bridge.mjs';
import { renderFile } from './file.mjs';
import { renderDirectory } from './dir.mjs';
import { renderGit } from './git.mjs';
import { renderPlugins } from './plugins.mjs';
import { renderNew } from './new.mjs';
import { renderAttachment } from './attachment.mjs';
import { skeleton, kindFor, afterDelay } from './skeleton.mjs';

const root = document.querySelector('#content');
let generation = 0;
let snapshot;
let rendering = false;
// 親（右の欄）へ描き始め・描き終え・失敗を知らせる（読み込み線とタブの印の出し入れ。ADR 0320）
const report = state => { if (parent !== window) parent.postMessage({ type:'pleiad:page-state', state }, location.origin); };
async function render() {
  const current = ++generation, alive = () => current === generation;
  rendering = true; root.setAttribute('aria-busy', 'true'); report('loading');
  // 見せる中身がまだ無い最初の読み込みだけ、150ms を超えたら種類に合わせた骨組みを出す（読み直しは前の中身を残す）。変更・新しいタブは自前の出し方
  const stop = !root.hasChildNodes() && !['git', 'new'].includes(page)
    ? afterDelay(() => { if (alive() && !root.hasChildNodes()) root.replaceChildren(skeleton(kindFor(page, query.get('path') ?? ''))); })
    : () => {};
  let failed = false;
  const fragment = document.createElement('div');
  try {
    if (['file', 'dir', 'attachment'].includes(page)) {
      const params = Object.fromEntries(['path', 'at', 'base'].filter(k => query.has(k)).map(k => [k, query.get(k)]));
      const file = snapshot ??= await loadContent(await api('preview', { ...params, content:'raw' }));
      document.title = `${file.name} · Pleiad`;
      if (file.kind === 'directory') await renderDirectory(fragment, file);
      else await (page === 'attachment' ? renderAttachment : renderFile)(fragment, file);
    } else if (page === 'git') await renderGit(fragment);
    else if (page === 'plugins') await renderPlugins(fragment);
    // 新しいタブは見出しとボタンを先に出し、届いた区画から差し替える。前の中身が無いとき（エラー表示の後）は空にしてから
    else {
      if (!root.querySelector(':scope > [data-slot]')) root.replaceChildren();
      await renderNew(root, { alive });
    }
    if (alive() && page !== 'new') { root.className = fragment.className; root.replaceChildren(...fragment.childNodes); }
  } catch (error) { if (alive()) { failed = true; errorView(root, error); } }
  finally {
    stop();
    if (alive()) { rendering = false; root.setAttribute('aria-busy', 'false'); report(failed ? 'failed' : 'ready'); }
  }
}
function followLink(event) {
  const link = event.target.closest('a');
  if (!link || parent === window || (event.type === 'auxclick' && event.button !== 1)) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || !/^\/_pleiad\/s\//.test(url.pathname)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  parent.postMessage({ type:'pleiad:page-open', sessionId:decodeURIComponent(location.pathname.split('/')[3]), url:url.href,
    newTab:event.ctrlKey || event.metaKey || event.button === 1 }, location.origin);
}
document.addEventListener('click', followLink, true);
document.addEventListener('auxclick', followLink, true);
document.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link || link.closest('iframe')) return;
  if (link.dataset.filePath) { event.preventDefault(); openFile(link.dataset.filePath); }
  // Sanitized Markdown uses file: links for local references; do not navigate to file:.
  else if (link.protocol === 'file:') { event.preventDefault(); openFile(decodeURIComponent(link.pathname)); }
});
// 配色・環境の知らせ（読み込みのたびに親が送る）。変更・プラグイン・新しいタブは配色が CSS の変数だけで変わるので、問い合わせ直さない。
// 描いている途中の知らせも読み直さない（二重に取りに行かない）
window.addEventListener('pleiad:refresh', () => { if (rendering || ['git', 'plugins', 'new'].includes(page)) return; void render(); });

// 開いているファイル・フォルダーが変わった（page:changed → pleiad:page-command {type:'changed'}。ADR 0295 の 6）。
// 人が触っていなければそのまま読み直し、触っていれば「更新を表示」を出す（読んでいる所・入力を消さない）
let touched = false, pending = null;
const applyChange = () => { snapshot = undefined; pending?.remove(); pending = null; touched = false; return render(); };
for (const name of ['pointerdown', 'keydown', 'scroll', 'input', 'selectstart', 'copy']) {
  document.addEventListener(name, () => { touched = true; }, { capture:true, passive:true });
}
window.addEventListener('pleiad:page-command', event => {
  // 右の欄からの読み直し（もう一度開いた・戻って見た）。触ったかどうかは親が決めて送ってくるので、そのまま読み直す。前の中身は描き直しまで残す（ADR 0320）
  if (event.detail?.type === 'reread') { void applyChange().catch(error => errorView(root, error)); return; }
  if (event.detail?.type !== 'changed' || !['file', 'dir', 'git', 'attachment', 'new'].includes(page)) return;
  if (!touched) { void applyChange().catch(error => errorView(root, error)); return; }
  if (pending?.isConnected) return;
  pending = node('div', 'page-changed');
  pending.append(node('span', '', text('updated.body')), button(text('updated.show'), () => { void applyChange().catch(error => errorView(root, error)); }));
  document.body.append(pending);
});

try { await initializeEnv(); await render(); } catch (error) { errorView(root, error); root.setAttribute('aria-busy', 'false'); report('failed'); }
