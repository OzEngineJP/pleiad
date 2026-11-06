import { page, query, api, loadContent, initializeEnv, errorView, openFile } from './bridge.mjs';
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
document.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link || link.closest('iframe')) return;
  if (link.dataset.filePath) { event.preventDefault(); openFile(link.dataset.filePath); }
  // Sanitized Markdown uses file: links for local references; do not navigate to file:.
  else if (link.protocol === 'file:') { event.preventDefault(); openFile(decodeURIComponent(link.pathname)); }
});
window.addEventListener('pleiad:refresh', render);
try { await initializeEnv(); await render(); } catch (error) { errorView(root, error); root.setAttribute('aria-busy', 'false'); }
