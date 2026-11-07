import { page, query, api, loadContent, initializeEnv, errorView, openFile, node, button, text } from './bridge.mjs';
import { renderFile } from './file.mjs';
import { renderDirectory } from './dir.mjs';
import { renderGit } from './git.mjs';
import { renderPlugins } from './plugins.mjs';
import { renderNew } from './new.mjs';
import { renderAttachment } from './attachment.mjs';

const root = document.querySelector('#content');
let generation = 0;
let snapshot;
async function render() {
  const current = ++generation;
  root.setAttribute('aria-busy', 'true');
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
    else await renderNew(fragment);
    if (current === generation) { root.className = fragment.className; root.replaceChildren(...fragment.childNodes); }
  } catch (error) { if (current === generation) errorView(root, error); }
  finally { if (current === generation) root.setAttribute('aria-busy', 'false'); }
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
window.addEventListener('pleiad:refresh', render);

// 開いているファイル・フォルダーが変わった（page:changed → pleiad:page-command {type:'changed'}。ADR 0295 の 6）。
// 人が触っていなければそのまま読み直し、触っていれば「更新を表示」を出す（読んでいる所・入力を消さない）
let touched = false, pending = null;
const applyChange = () => { snapshot = undefined; pending?.remove(); pending = null; touched = false; return render(); };
for (const name of ['pointerdown', 'keydown', 'input', 'selectstart', 'copy']) {
  document.addEventListener(name, () => { touched = true; }, { capture:true, passive:true });
}
window.addEventListener('pleiad:page-command', event => {
  if (event.detail?.type !== 'changed' || !['file', 'dir', 'git', 'attachment'].includes(page)) return;
  if (!touched) { void applyChange().catch(error => errorView(root, error)); return; }
  if (pending?.isConnected) return;
  pending = node('div', 'page-changed');
  pending.append(node('span', '', text('updated.body')), button(text('updated.show'), () => { void applyChange().catch(error => errorView(root, error)); }));
  document.body.append(pending);
});

try { await initializeEnv(); await render(); } catch (error) { errorView(root, error); root.setAttribute('aria-busy', 'false'); }
