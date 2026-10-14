import { renderMarkdown } from './render.mjs';
import { fileReference } from './file-reference.mjs';
import { t } from './i18n.mjs';

/** 読み込めなかった画像の代わりの文字（alt）。「名前（表示できません）」 */
const unavailableAlt = alt => t('filePreview.unavailableAlt', { alt });

/** CSV/TSV with escaped quotes, delimiters and newlines inside quoted cells. */
export function parseTable(text, delimiter = ',', maxRows = 501, maxColumns = 100) {
  const rows = []; let row = [], cell = '', quoted = false, truncated = false;
  const pushCell = () => { if (row.length < maxColumns) row.push(cell); else truncated = true; cell = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (quoted || !cell)) {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && c === delimiter) pushCell();
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushCell(); rows.push(row); row = [];
      if (rows.length >= maxRows && i < text.length - 1) { truncated = true; break; }
    } else cell += c;
  }
  if (rows.length < maxRows && (cell || row.length)) { pushCell(); rows.push(row); }
  return { rows, truncated };
}

const dataUrl = file => `data:${file.mime};base64,${file.data}`;

export async function markdownContent(text, loadAsset) {
  const article = document.createElement('article'); article.className = 'body file-preview-document';
  article.innerHTML = renderMarkdown(text);
  const notes = [];
  let count = 0;
  for (const img of article.querySelectorAll('img')) {
    const raw = img.getAttribute('src'); img.removeAttribute('src');
    if (/^data:image\//i.test(raw)) { img.src = raw; continue; }
    try {
      if (++count > 24) throw new Error('resource');
      const file = await loadAsset(fileReference(raw)?.path || raw);
      if (file.kind !== 'image' || file.size > 4 * 1024 * 1024) throw new Error('image');
      img.src = dataUrl(file);
    } catch { img.alt = unavailableAlt(img.alt); notes.push(t('filePreview.someImages')); }
  }
  return { article, note:notes[0] || '' };
}
