// The overlay is focused synchronously inside the tap, before any network round trip.
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { ensureBrowserControlStyles } from './chrome-control.mjs';

/** Composition updates never insert text; only compositionend commits it once. */
export function createCompositionInput(send) {
  let composing = false, committed = null;
  return {
    start() { composing = true; committed = null; },
    update(text) { if (composing) send({ type: 'composition', text }); },
    end(text, stamp = 0) { if (!composing) return; composing = false; committed = { text, stamp }; send({ type: 'composition', text: '' }); if (text) send({ type: 'text', text }); },
    input(text, { isComposing = false, inputType = '', stamp = 0 } = {}) {
      if (composing || isComposing) return;
      if (committed && text === committed.text && (inputType.includes('Composition') || Math.abs(stamp - committed.stamp) < 40)) { committed = null; return; }
      committed = null; if (text) send({ type: 'text', text });
    },
    reset() { if (composing) send({ type: 'composition', text: '' }); composing = false; committed = null; },
    get composing() { return composing; },
  };
}

export function fieldAt(fields, point) {
  return [...fields].reverse().find(field => point.x >= field.x && point.y >= field.y && point.x <= field.x + field.width && point.y <= field.y + field.height) ?? null;
}

/** Receive field/sheet events; reset on target changes, destroy on close. */
export function createPhoneInput({ surface, send = () => {}, getRect = () => surface?.getBoundingClientRect(), getKeyboardRect = getRect, getMetadata = () => ({}), onPan = () => {}, phone = true, onError = () => {} } = {}) {
  // The caller can construct the part before mounting its surface.
  if (!surface) return { focus() {}, blur() {}, beforeTap() { return true; }, receive() {}, reset() {}, destroy() {} };
  ensureBrowserControlStyles();
  const overlay = el('textarea', 'b2-phone-input'); overlay.setAttribute('aria-label', t('control:keyboardInput'));
  overlay.autocomplete = 'off'; overlay.autocapitalize = 'off'; overlay.spellcheck = false; overlay.tabIndex = -1;
  // A textarea cannot be type=password, so password fields get their own overlay (no prediction or keyboard learning).
  const secret = el('input', 'b2-phone-input'); secret.type = 'password'; secret.setAttribute('aria-label', t('control:keyboardInput'));
  secret.autocomplete = 'off'; secret.autocapitalize = 'off'; secret.spellcheck = false; secret.tabIndex = -1;
  const note = el('div', 'b2-phone-note', t('control:passwordNote')); note.hidden = true; note.setAttribute('role', 'status');
  const fallback = el('div', 'b2-fallback'), fallbackInput = el('input'), fallbackDone = el('button', 'b2-action', t('control:done'));
  fallbackInput.type = 'text'; fallbackInput.setAttribute('aria-label', t('control:keyboardInput')); fallbackDone.type = 'button'; fallback.append(fallbackInput, fallbackDone); fallback.hidden = true;
  const sheet = el('div', 'b2-sheet'), sheetBody = el('div', 'b2-sheet-body'); sheet.hidden = true; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.append(sheetBody);
  surface.append(overlay, secret); document.body.append(fallback, note, sheet);
  let fields = [], focused = null, active = overlay, previousFocus = null, sheetCleanup = () => {}, alive = true;
  const post = value => { try { Promise.resolve(send(value)).catch(onError); } catch (error) { onError(error); } };
  const composition = createCompositionInput(post);
  const sentinel = '\u200b';
  const prepare = input => { input.value = sentinel; input.setSelectionRange?.(1, 1); };
  const disposers = [];
  const listen = (node, type, handler, options) => { node.addEventListener(type, handler, options); disposers.push(() => node.removeEventListener(type, handler, options)); };
  for (const input of [overlay, secret, fallbackInput]) {
    listen(input, 'compositionstart', () => composition.start());
    listen(input, 'compositionupdate', event => composition.update(event.data ?? ''));
    prepare(input);
    listen(input, 'compositionend', event => { composition.end(event.data ?? '', event.timeStamp); prepare(input); });
    listen(input, 'beforeinput', event => {
      if (event.isComposing || composition.composing || !['deleteContentBackward', 'deleteContentForward'].includes(event.inputType)) return;
      if (event.cancelable) { event.preventDefault(); post({ type: 'key', key: event.inputType === 'deleteContentBackward' ? 'Backspace' : 'Delete' }); prepare(input); }
    });
    listen(input, 'input', event => {
      if (composition.composing || event.isComposing) return;
      if (event.inputType === 'deleteContentBackward') post({ type: 'key', key: 'Backspace' });
      else if (event.inputType === 'deleteContentForward') post({ type: 'key', key: 'Delete' });
      else composition.input(event.data ?? input.value.replace(sentinel, ''), { inputType: event.inputType, stamp: event.timeStamp });
      prepare(input);
    });
    listen(input, 'keydown', event => {
      event.stopPropagation(); if (event.isComposing || composition.composing || event.keyCode === 229) return;
      if (['Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete'].includes(event.key)) {
        event.preventDefault(); post({ type: 'key', key: event.key });
      }
    });
  }
  const closeSheet = (restore = true) => { const visible = !sheet.hidden; sheet.hidden = true; sheetCleanup(); sheetCleanup = () => {}; if (visible && restore) previousFocus?.focus?.({ preventScroll: true }); previousFocus = null; };
  async function act(value, button, error) {
    button.disabled = true; error.textContent = '';
    try { await send(value); closeSheet(); } catch { error.textContent = t('control:failed'); } finally { button.disabled = false; }
  }
  function showSheet(message) {
    sheetCleanup(); sheetBody.replaceChildren(); previousFocus = document.activeElement;
    const title = el('h2', 'b2-sheet-title'), error = el('p', 'b2-sheet-error'), actions = el('div', 'b2-actions');
    const cancel = el('button', 'b2-action', t('control:cancel')), done = el('button', 'b2-action primary', t('control:done'));
    cancel.type = done.type = 'button'; actions.append(cancel, done); sheetBody.append(title); sheet.hidden = false;
    sheet.setAttribute('aria-label', message.type === 'select' ? t('control:select') : message.type === 'file' ? t('control:file') : t('control:dialog'));
    cancel.addEventListener('click', () => message.type === 'dialog' ? act({ type: 'dialog', accept: false }, cancel, error) : message.type === 'file' ? act({ type: 'files', files: [] }, cancel, error) : closeSheet());
    if (message.type === 'dialog') {
      title.textContent = t('control:dialog'); sheetBody.append(el('p', 'b2-sheet-message', message.message));
      const prompt = el('input'); prompt.type = 'text'; prompt.value = message.defaultPrompt ?? ''; prompt.setAttribute('aria-label', t('control:keyboardInput'));
      if (message.dialogType === 'prompt') sheetBody.append(prompt);
      cancel.hidden = message.dialogType === 'alert'; done.addEventListener('click', () => act({ type: 'dialog', accept: true, text: prompt.value }, done, error));
    } else if (message.type === 'select') {
      title.textContent = t('control:select'); const choices = [];
      for (const option of message.options ?? []) {
        const row = el('label', 'b2-sheet-option'), input = el('input'); input.type = message.multiple ? 'checkbox' : 'radio'; input.name = 'browser-select'; input.checked = !!option.selected; input.disabled = !!option.disabled;
        row.append(input, el('span', '', option.label)); sheetBody.append(row); choices.push({ input, index: option.index });
      }
      done.addEventListener('click', () => act({ type: 'select', id: message.id, selected: choices.filter(choice => choice.input.checked).map(choice => choice.index) }, done, error));
    } else if (message.type === 'file') {
      title.textContent = t('control:file'); const input = el('input'); input.type = 'file'; input.multiple = !!message.multiple; input.setAttribute('aria-label', t('control:file')); sheetBody.append(input, el('p', 'b2-sheet-message', t('control:fileLimit')));
      done.addEventListener('click', async () => {
        const files = [...input.files];
        if (files.length > 10 || files.reduce((size, file) => size + file.size, 0) > 8 * 1024 * 1024) { error.textContent = t('control:fileLimit'); return; }
        done.disabled = true;
        try {
          const payload = [];
          for (const file of files) {
            const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
            payload.push({ name: file.name, data });
          }
          if (alive) await act({ type: 'files', files: payload }, done, error);
        } catch { error.textContent = t('control:failed'); } finally { done.disabled = false; }
      });
    }
    sheetBody.append(error, actions); done.focus();
  }
  listen(sheet, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); sheetBody.querySelector('.b2-actions button:not([hidden])')?.click(); }
    if (event.key === 'Tab') {
      const nodes = [...sheetBody.querySelectorAll('button:not([hidden]):not(:disabled),input:not(:disabled)')];
      const next = event.shiftKey ? nodes.at(-1) : nodes[0], end = event.shiftKey ? nodes[0] : nodes.at(-1);
      if (document.activeElement === end) { event.preventDefault(); next?.focus(); }
    }
  });
  function position(field) {
    const rect = getRect(), box = surface.getBoundingClientRect(), metadata = getMetadata();
    if (!rect?.width || !metadata?.deviceWidth) return;
    const scale = rect.width / metadata.deviceWidth;
    Object.assign(active.style, { left: `${rect.left - box.left + field.x * scale}px`, top: `${rect.top - box.top + field.y * scale}px`, width: `${field.width * scale}px`, height: `${Math.max(20, field.height * scale)}px` });
  }
  function focus(field) {
    focused = field;
    if (field && ['file', 'select-one', 'select-multiple'].includes(field.type)) { post({ type: 'field', id: field.id }); return false; }
    if (field && !['text', 'search', 'email', 'url', 'tel', 'number', 'textarea', 'password'].includes(field.type)) { active.blur(); return true; }
    if (field) {
      const next = field.type === 'password' ? secret : overlay; if (next !== active) active.blur(); active = next;
      fallback.hidden = true; position(field); active.inputMode = field.inputMode || (field.type === 'number' ? 'decimal' : 'text'); active.enterKeyHint = field.enterKeyHint || ''; active.focus({ preventScroll: true });
    } else { active.blur(); fallback.hidden = false; fallbackInput.focus({ preventScroll: true }); }
    note.hidden = !(phone && active === secret && document.activeElement === secret); keyboard();
    return true;
  }
  const viewport = globalThis.visualViewport;
  function keyboard() {
    if (!alive) return;
    const bottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
    fallback.style.bottom = note.style.bottom = `${Math.max(8, innerHeight - bottom + 8)}px`;
    if (!focused || ![overlay, secret, fallbackInput].includes(document.activeElement)) { onPan(0); return; }
    const rect = getKeyboardRect(), metadata = getMetadata();
    const fieldBottom = rect.top + (focused.y + focused.height) * rect.width / (metadata.deviceWidth || rect.width);
    onPan(Math.min(0, bottom - 24 - fieldBottom));
    position(focused);
  }
  if (viewport) { listen(viewport, 'resize', keyboard); listen(viewport, 'scroll', keyboard); }
  // The note sits above the keyboard only while a password field is being typed into.
  listen(secret, 'focus', () => { note.hidden = !phone; keyboard(); });
  listen(secret, 'blur', () => { note.hidden = true; });
  listen(fallbackDone, 'click', () => { fallbackInput.blur(); fallback.hidden = true; focused = null; onPan(0); });
  return { element: overlay, secret, note, fallback, sheet, focus,
    blur() { active.blur(); },
    beforeTap(point) { const field = fieldAt(fields, point); if (field) return focus(field); focused = null; active.blur(); fallbackInput.blur(); fallback.hidden = note.hidden = true; onPan(0); return true; },
    receive(message) {
      if (message?.type === 'fields') { fields = message.fields ?? []; if (focused) { focused = fields.find(field => field.id === focused.id) ?? null; if (focused) position(focused); } }
      else if (['dialog', 'select', 'file'].includes(message?.type)) showSheet(message);
      else if (message?.type === 'dismiss') closeSheet();
      else if (message?.type === 'keyboard' && !focused) { fallback.hidden = false; }
    },
    reset() { fields = []; focused = null; composition.reset(); closeSheet(false); active.blur(); fallbackInput.blur(); fallback.hidden = note.hidden = true; onPan(0); },
    destroy() { alive = false; composition.reset(); sheetCleanup(); for (const dispose of disposers) dispose(); overlay.remove(); secret.remove(); fallback.remove(); note.remove(); sheet.remove(); onPan(0); },
  };
}
