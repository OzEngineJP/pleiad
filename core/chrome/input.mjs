// 端末からの入力（押す・スクロール・文字・キー）を CDP の Input.* のコマンドの列にする。
// 端末から操作する PC の Chrome の窓（core/chrome/screencast.mjs）が使う。

export const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  a: { code: 'KeyA', keyCode: 65 },
};
const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
// 修飾キーのビット（CDP の modifiers）。accel は端末の ⌘/Ctrl を受け、Chrome のある OS 側へ合わせる
const MOD_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const ACCEL_BIT = process.platform === 'darwin' ? MOD_BITS.meta : MOD_BITS.ctrl;
const modifiersOf = list => (Array.isArray(list) ? list : []).reduce((bits, name) => bits | (name === 'accel' ? ACCEL_BIT : MOD_BITS[name] ?? 0), 0);

/** 端末からの入力を CDP のコマンドの列にする。座標はページの CSS px（端末が表示の倍率から変換済み）。知らない入力は空 */
export function inputCommands(input, { width = 1600, height = 2400 } = {}) {
  if (!input || typeof input !== 'object') return [];
  const x = clamp(input.x, 0, width, 0), y = clamp(input.y, 0, height, 0);
  switch (input.type) {
    case 'composition': {
      if (typeof input.text !== 'string' || input.text.length > 2000) return [];
      return [['Input.imeSetComposition', { text: input.text, selectionStart: input.text.length, selectionEnd: input.text.length }]];
    }
    case 'context': return [
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 }],
    ];
    case 'drag': {
      if (!['start', 'move', 'end'].includes(input.phase) || !Number.isFinite(input.x) || !Number.isFinite(input.y)) return [];
      return [['Input.dispatchMouseEvent', { type: input.phase === 'start' ? 'mousePressed' : input.phase === 'end' ? 'mouseReleased' : 'mouseMoved',
        x, y, button: 'left', buttons: input.phase === 'end' ? 0 : 1, ...(input.phase === 'move' ? {} : { clickCount: 1 }) }]];
    }
    case 'tap': {
      // clicks: 2 回・3 回押し（語・行の選択）。Chrome は clickCount を見て続けた押しとして扱う
      const clicks = Math.round(clamp(input.clicks, 1, 3, 1));
      return [
        ['Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }],
        ['Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: clicks }],
        ['Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: clicks }],
      ];
    }
    case 'scroll': {
      const deltaX = clamp(input.dx, -4000, 4000, 0), deltaY = clamp(input.dy, -4000, 4000, 0);
      if (!deltaX && !deltaY) return [];
      return [['Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }]];
    }
    case 'text': {
      if (typeof input.text !== 'string' || !input.text || input.text.length > 2000) return [];
      return [['Input.insertText', { text: input.text }]];
    }
    case 'key': {
      const key = KEYS[input.key];
      if (!key) return [];
      const modifiers = modifiersOf(input.modifiers);
      // 英字のキーは修飾キーと一緒の操作（Ctrl+A など）だけを受ける。文字は type:'text' で送る
      if (input.key.length === 1 && !modifiers) return [];
      const base = { key: input.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, ...(modifiers ? { modifiers } : {}) };
      return [
        ['Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) }],
        ['Input.dispatchKeyEvent', { type: 'keyUp', ...base }],
      ];
    }
    default: return [];
  }
}

/** 端末の映像の箱の大きさ（CSS px と倍率）を、ページの大きさに使ってよい範囲に丸める。数でなければ null */
export function deviceViewport({ width, height, scale } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    width: Math.round(clamp(width, 240, 1600, 390)),
    height: Math.round(clamp(height, 240, 2400, 700)),
    scale: clamp(scale, 1, 3, 1),
  };
}

// Isolated world only: no values (especially passwords), URLs, or page script objects leave this world.
function fieldProbe() {
  if (globalThis.__plyInput) { globalThis.__plyInput.refresh(); return; }
  const nodes = new Map(), ids = new WeakMap(); let next = 0, scheduled = false;
  const id = node => { if (!ids.has(node)) { ids.set(node, ++next); nodes.set(next, node); } return ids.get(node); };
  const publish = () => {
    scheduled = false;
    const fields = [];
    for (const node of document.querySelectorAll('input,textarea,select,[contenteditable="true"],[contenteditable=""]')) {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || node.disabled || node.readOnly) continue;
      fields.push({ id: id(node), type: node.type || (node.isContentEditable ? 'text' : node.tagName.toLowerCase()),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        inputMode: node.inputMode || '', enterKeyHint: node.enterKeyHint || '', autocomplete: node.autocomplete || '', multiline: node.tagName === 'TEXTAREA' || node.isContentEditable });
      if (fields.length === 500) break;
    }
    for (const [key, node] of nodes) if (!node.isConnected) nodes.delete(key);
    globalThis.plyInput(JSON.stringify({ type: 'fields', fields }));
  };
  let animation = null;
  const schedule = () => { if (!scheduled) { scheduled = true; animation = requestAnimationFrame(publish); } };
  const mutations = new MutationObserver(schedule), sizes = new ResizeObserver(schedule);
  // ページの選択。入力欄の選択は document の選択に入らないので、フォーカスのある欄から値を切り出す。
  // editable は「切り取りで消せるか」（読み取り専用・無効の欄は消せない）。値そのものは持ち出さない
  const selected = () => {
    const el = document.activeElement;
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && typeof el.selectionStart === 'number' && el.selectionStart != null) {
      // パスワードの欄（type=password・autocomplete が password のもの）は選んだ文字を出さない（Chrome の Ctrl+C と同じ守り。切り取りで消すのは許す）
      if (el instanceof HTMLInputElement && (el.type === 'password' || /password/i.test(el.autocomplete ?? '')))
        return { text: '', editable: !el.readOnly && !el.disabled };
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.selectionStart;
      return { text: String(el.value ?? '').slice(el.selectionStart, Math.min(end, el.selectionStart + 20000)), editable: !el.readOnly && !el.disabled };
    }
    return { text: String(window.getSelection?.() ?? '').slice(0, 20000), editable: !!el?.isContentEditable };
  };
  globalThis.__plyInput = {
    refresh: publish,
    dispose() {
      removeEventListener('scroll', schedule, true); removeEventListener('resize', schedule); removeEventListener('focusin', schedule, true);
      mutations.disconnect(); sizes.disconnect(); cancelAnimationFrame(animation); delete globalThis.__plyInput;
    },
    select(fieldId, selected) {
      const node = nodes.get(fieldId);
      if (!(node instanceof HTMLSelectElement)) return false;
      for (let i = 0; i < node.options.length; i++) node.options[i].selected = selected.includes(i) && !node.options[i].disabled && !node.options[i].parentElement.disabled;
      node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true;
    },
    open(fieldId) {
      const node = nodes.get(fieldId);
      if (node instanceof HTMLSelectElement) {
        globalThis.plyInput(JSON.stringify({ type: 'select', id: fieldId, multiple: node.multiple,
          options: Array.from(node.options, (option, index) => ({ index, label: option.label.slice(0, 1000), selected: option.selected, disabled: option.disabled || !!option.parentElement.disabled })).slice(0, 1000) }));
        return true;
      }
      if (node instanceof HTMLInputElement && node.type === 'file') { node.click(); return true; }
      return false;
    },
    // 今の選択（コピー・切り取り）。text と editable だけ
    selection() { return selected(); },
    // 点の下のもの（右クリックのメニュー）: 選択・編集できるか・リンク。ページの値・URL は持ち出さない
    inspect(x, y) {
      const at = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y) : null;
      const anchor = at?.closest?.('a[href]');
      const href = anchor && /^https?:$/i.test(anchor.protocol) ? anchor.href : null;
      return { ...selected(), link: typeof href === 'string' ? href.slice(0, 2000) : null };
    },
    // 点の下のもののカーソル（hover のたびに読む軽い口）。computed が auto のとき、Chrome がヒットテストで
    // 出す形を近似する: 欄・編集できる領域・選べる本文は I 形。ボタン・リンクの文字は矢印（リンクは UA の pointer）
    cursorAt(x, y) {
      const at = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y) : null;
      if (!at) return { cursor: 'auto' };
      const style = getComputedStyle(at);
      let name = style.cursor;
      if (name === 'auto') {
        const directText = [...(at.childNodes ?? [])].some(node => node.nodeType === 3 && node.textContent.trim());
        if (at.isContentEditable || /^(input|textarea)$/i.test(at.tagName ?? '')
          || (directText && style.userSelect !== 'none' && !at.closest('a,button,select,label,summary,[role="button"],[onclick]'))) name = 'text';
      }
      return { cursor: typeof name === 'string' && /^[a-z-]+$/i.test(name) ? name : 'auto' };
    },
  };
  addEventListener('scroll', schedule, true); addEventListener('resize', schedule);
  addEventListener('focusin', schedule, true);
  mutations.observe(document, { subtree: true, childList: true, attributes: true });
  sizes.observe(document.documentElement);
  publish();
}

/** Own CDP session for field geometry and native sheets; dispose with the watched target. */
export function createPageInput({ send, emit = () => {} }) {
  let contextId = null, scriptId = null, disposed = false, chooser = null, dialog = false, closing = false;
  const uploads = new Set();
  const source = `(${fieldProbe.toString()})()`;
  async function cancelDialogs() {
    closing = true;
    if (dialog) await send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
  }
  async function install() {
    const tree = await send('Page.getFrameTree');
    if (!tree?.frameTree?.frame?.id || disposed) return;
    const world = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'ply-input' });
    if (disposed) return;
    contextId = world.executionContextId;
    await send('Runtime.evaluate', { expression: source, contextId });
  }
  return {
    async start() {
      await send('Page.enable'); await send('Runtime.enable');
      await send('Runtime.addBinding', { name: 'plyInput', executionContextName: 'ply-input' });
      const script = await send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: 'ply-input' });
      scriptId = script.identifier;
      await send('Page.setInterceptFileChooserDialog', { enabled: true });
      await install();
    },
    event(method, params) {
      if (disposed) return;
      if (method === 'Runtime.bindingCalled' && params.name === 'plyInput' && params.executionContextId === contextId) {
        try { const message = JSON.parse(params.payload); if (['fields', 'select'].includes(message.type)) emit(message); } catch {}
      } else if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
        contextId = null; chooser = null; emit({ type: 'fields', fields: [] }); install().catch(() => {});
      } else if (method === 'Page.javascriptDialogOpening') {
        if (closing) { send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); return; }
        dialog = true; emit({ type: 'dialog', dialogType: params.type, message: String(params.message ?? '').slice(0, 4000), defaultPrompt: String(params.defaultPrompt ?? '').slice(0, 2000) });
      } else if (method === 'Page.javascriptDialogClosed') { dialog = false; emit({ type: 'dismiss' }); }
      else if (method === 'Page.fileChooserOpened') {
        chooser = params.backendNodeId; emit({ type: 'file', multiple: params.mode === 'selectMultiple' });
      }
    },
    async input(value) {
      if (disposed) throw new Error('not-watching');
      if (value?.type === 'dialog' && dialog && typeof value.accept === 'boolean') {
        await send('Page.handleJavaScriptDialog', { accept: value.accept, promptText: typeof value.text === 'string' ? value.text.slice(0, 2000) : '' }); return true;
      }
      if (value?.type === 'field' && Number.isSafeInteger(value.id) && contextId != null) {
        const result = await send('Runtime.evaluate', { expression: `globalThis.__plyInput.open(${value.id})`, contextId, returnByValue: true, userGesture: true });
        return result?.result?.value === true;
      }
      if (value?.type === 'select' && Number.isSafeInteger(value.id) && Array.isArray(value.selected) && value.selected.length <= 1000 && value.selected.every(n => Number.isInteger(n) && n >= 0 && n < 1000) && contextId != null) {
        const result = await send('Runtime.evaluate', { expression: `globalThis.__plyInput.select(${value.id},${JSON.stringify(value.selected)})`, contextId, returnByValue: true });
        return result?.result?.value === true;
      }
      if (value?.type === 'files' && chooser != null && Array.isArray(value.files) && value.files.length <= 10) {
        let total = 0;
        const files = value.files.map(file => {
          if (typeof file?.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length > 12 * 1024 * 1024) throw new Error('invalid-input');
          const data = Buffer.from(file.data, 'base64'); total += data.length;
          if (total > 8 * 1024 * 1024 || typeof file.name !== 'string' || !file.name || /[\\/:\x00-\x1f]/.test(file.name) || file.name === '.' || file.name === '..') throw new Error('invalid-input');
          return { name: file.name, data };
        });
        const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-browser-input-')); uploads.add(dir);
        try {
          const paths = [];
          for (const file of files) { const target = path.join(dir, file.name); await fs.writeFile(target, file.data, { flag: 'wx' }); paths.push(target); }
          await send('DOM.setFileInputFiles', { backendNodeId: chooser, files: paths }); chooser = null;
        } catch (error) { await fs.rm(dir, { recursive: true, force: true }); uploads.delete(dir); throw error; }
        return true;
      }
      // 読むための問い合わせ（コピーの選択・右クリックのメニュー・カーソル）。式はここで決めた 3 つだけで、端末の文字は式に入らない
      if (['selection', 'inspect', 'cursor'].includes(value?.type) && contextId != null) {
        const point = Number.isFinite(value.x) && Number.isFinite(value.y) ? `${Math.round(value.x)},${Math.round(value.y)}` : null;
        const expression = value.type === 'selection' ? 'globalThis.__plyInput.selection()'
          : point && (value.type === 'cursor' ? `globalThis.__plyInput.cursorAt(${point})` : `globalThis.__plyInput.inspect(${point})`);
        if (!expression) return null;
        const result = await send('Runtime.evaluate', { expression, contextId, returnByValue: true });
        return result?.result?.value ?? null;
      }
      return false;
    },
    async afterTap() {
      if (contextId == null || disposed) { emit({ type: 'keyboard' }); return; }
      const result = await send('Runtime.evaluate', { expression: 'Boolean(document.activeElement?.isContentEditable || document.activeElement?.tagName === "TEXTAREA" || (document.activeElement?.tagName === "INPUT" && /^(text|search|email|url|tel|number)$/.test(document.activeElement.type)) || document.activeElement?.tagName === "IFRAME")', contextId, returnByValue: true });
      if (result?.result?.value) emit({ type: 'keyboard' });
    },
    cancelDialogs,
    async dispose() {
      await cancelDialogs();
      disposed = true;
      if (contextId != null) await send('Runtime.evaluate', { expression: 'globalThis.__plyInput?.dispose()', contextId }).catch(() => {});
      if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => {});
      await send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      const fs = await import('node:fs/promises');
      for (const dir of uploads) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      uploads.clear();
    },
  };
}
