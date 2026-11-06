import { markdownContent, parseTable } from '../file-preview-content.mjs';
import { node, text, button, query, api, metadata, pageUrl, request, errorView } from './bridge.mjs';
import { renderTree } from './dir.mjs';
import { htmlFrame } from './html-once.mjs';

let controller;
export function sourceContent(value, line = null) {
  const lines = String(value ?? '').split(/\r?\n/);
  const target = Math.max(1, Math.min(lines.length, Number(line) || 1));
  const start = Math.max(0, Math.min(target - 2501, lines.length - 5000));
  const end = Math.min(lines.length, start + 5000);
  const fragment = document.createDocumentFragment();
  if (lines.length > 5000) fragment.append(node('p', 'limit-note', text('sourceLimit', { from:start + 1, to:end, total:lines.length })));
  const source = node('div', 'source'); source.setAttribute('role', 'region'); source.setAttribute('aria-label', text('source'));
  for (let i = start; i < end; i++) {
    const row = node('div', `source-line${i + 1 === target && line ? ' selected' : ''}`); row.id = `line-${i + 1}`;
    row.append(node('span', 'line-number', i + 1), node('code', '', lines[i] || ' ')); source.append(row);
  }
  fragment.append(source); return fragment;
}

async function pdfView(root, file, signal) {
  const pdfjs = await import('/_pleiad/vendor/pdfjs/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/_pleiad/vendor/pdfjs/build/pdf.worker.mjs';
  const task = pdfjs.getDocument({ data:file.bytes?.slice() ?? Uint8Array.from(atob(file.data), c => c.charCodeAt(0)), isEvalSupported:false,
    cMapUrl:'/_pleiad/vendor/pdfjs/cmaps/', cMapPacked:true, standardFontDataUrl:'/_pleiad/vendor/pdfjs/standard_fonts/', wasmUrl:'/_pleiad/vendor/pdfjs/wasm/' });
  signal.addEventListener('abort', () => { void task.destroy().catch(() => {}); }, { once:true });
  const doc = await task.promise;
  if (signal.aborted) return;
  let number = 1, scale = 1, pending = 0;
  const bar = node('div', 'pdf-controls'), label = node('span'), canvas = node('canvas', 'pdf-canvas');
  const repaint = () => { void paint().catch(error => { if (!signal.aborted) errorView(root, error); }); };
  const previous = button('‹', () => { if (number > 1) { number--; repaint(); } }); previous.setAttribute('aria-label', text('previous'));
  const next = button('›', () => { if (number < doc.numPages) { number++; repaint(); } }); next.setAttribute('aria-label', text('next'));
  bar.append(previous, label, next, button('−', () => { scale = Math.max(.5, scale - .25); repaint(); }), button('+', () => { scale = Math.min(3, scale + .25); repaint(); }));
  const details = node('details', 'pdf-text'); details.append(node('summary', '', text('pdfText')));
  root.append(bar, canvas, details);
  let renderTask;
  async function paint() {
    const generation = ++pending;
    renderTask?.cancel();
    label.textContent = text('pdfPage', { page:number, total:doc.numPages }); previous.disabled = number === 1; next.disabled = number === doc.numPages;
    const page = await doc.getPage(number);
    if (signal.aborted || generation !== pending) return;
    const width = Math.max(240, document.documentElement.clientWidth - 48);
    const viewport = page.getViewport({ scale:Math.min(1.4, width / page.getViewport({ scale:1 }).width) * scale });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    renderTask = page.render({ canvasContext:canvas.getContext('2d'), viewport });
    try { await renderTask.promise; } catch (e) { if (e.name !== 'RenderingCancelledException') throw e; }
    const content = await page.getTextContent();
    if (signal.aborted || generation !== pending) return;
    details.querySelector('pre')?.remove(); details.append(node('pre', '', content.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('')));
  }
  await paint();
}

export async function renderFile(root, file) {
  controller?.abort();
  controller = new AbortController(); const { signal } = controller;
  root.append(metadata(file));
  const body = node('div', 'file-body'); root.append(body);
  const tree = document.querySelector('#tree'); tree.hidden = true;
  let source = query.get('view') === 'source', paintNumber = 0;
  async function paint() {
    const generation = ++paintNumber, content = node('div');
    if (source && typeof file.text === 'string') content.append(sourceContent(file.text, file.line));
    else if (file.kind === 'markdown') {
      let bytes = 0;
      const result = await markdownContent(file.text, async path => {
        const asset = await api('preview', { path, base:file.path, resource:'1' });
        bytes += asset.size;
        if (bytes > 8 * 1024 * 1024) throw new Error('resource-limit'); return asset;
      });
      // Local links stay on the authenticated page routes, including their base directory.
      for (const link of result.article.querySelectorAll('a[data-file-path]')) {
        const line = Number(link.dataset.fileLine);
        const ref = link.dataset.filePath + (Number.isSafeInteger(line) && line > 0 ? `:${line}` : '');
        link.href = pageUrl('file', ref, { base:file.path }); delete link.dataset.filePath;
      }
      for (const copy of result.article.querySelectorAll('.code-copy')) copy.addEventListener('click', () => { void navigator.clipboard.writeText(copy.closest('.code-block').querySelector('code').textContent).catch(() => {}); });
      // 画像の所在の一行: この文書と同じフォルダーなら、フォルダーは書かない（名前と ⋯ だけ）
      const folder = path => path.replace(/[\\/]+/g, '/').replace(/\/[^/]*$/, '').toLowerCase();
      for (const dir of result.article.querySelectorAll('.file-where-dir')) if (folder(`${dir.title}/x`) === folder(file.path)) dir.remove();
      for (const menu of result.article.querySelectorAll('[data-file-menu]')) menu.addEventListener('click', event => request('file-menu', { path:menu.dataset.fileMenu, base:file.path, kind:'file', x:event.clientX, y:event.clientY }));
      content.append(result.article); if (result.note) content.append(node('p', 'limit-note', result.note));
    } else if (file.kind === 'html') {
      await htmlFrame(content, file, signal);
    } else if (file.kind === 'image') {
      const image = node('img', 'image-preview'); image.alt = file.name;
      if (file.bytes) {
        const url = URL.createObjectURL(new Blob([file.bytes], { type:file.mime })); image.src = url;
        signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once:true });
      } else image.src = `data:${file.mime};base64,${file.data}`;
      image.addEventListener('click', () => image.classList.toggle('actual-size')); content.append(image);
    } else if (file.kind === 'table') {
      const { rows, truncated } = parseTable(file.text, file.delimiter), table = node('table', 'data-table');
      const head = node('thead'), body = node('tbody');
      rows.forEach((cells, i) => { const tr = node('tr'); for (const cell of cells) tr.append(node(i ? 'td' : 'th', '', cell)); (i ? body : head).append(tr); });
      table.append(head, body); const scroll = node('div', 'table-scroll'); scroll.append(table); content.append(scroll);
      if (truncated) content.append(node('p', 'limit-note', text('tableLimit')));
    } else if (file.kind === 'pdf') await pdfView(content, file, signal);
    else if (file.kind === 'text') content.append(sourceContent(file.text, file.line));
    else {
      content.append(node('p', 'empty', text(`errors.${file.reasonCode ?? 'unsupported'}`)));
      if (file.downloadable) { const a = node('a', 'download', text('download')); a.href = `${pageUrl('api/raw', file.path, { download:'1' })}`; a.download = file.name; content.append(a); }
    }
    if (generation === paintNumber && !signal.aborted) {
      body.replaceChildren(...content.childNodes);
      if (file.line) requestAnimationFrame(() => document.querySelector(`#line-${Number(file.line)}`)?.scrollIntoView({ block:'center' }));
    }
  }
  window.addEventListener('pleiad:page-command', async event => {
    const command = event.detail ?? {};
    if (command.type === 'view') { source = command.view === 'source'; try { await paint(); } catch (error) { errorView(body, error); } }
    if (command.type === 'tree') { tree.hidden = command.open == null ? !tree.hidden : !command.open; if (!tree.hidden) await renderTree(tree, file.tree, file.path); }
  }, { signal });
  await paint();
}
