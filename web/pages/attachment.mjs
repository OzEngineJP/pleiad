import { renderFile } from './file.mjs';
import { button, text, request } from './bridge.mjs';

export async function renderAttachment(root, file) {
  await renderFile(root, file);
  const actions = document.createElement('div'); actions.className = 'attachment-actions';
  actions.append(button(text('useFile'), () => request('use-file', { path:file.path }), 'primary'));
  root.append(actions);
}
