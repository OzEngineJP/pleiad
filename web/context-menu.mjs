import { isComposingKey } from "./keyboard.mjs";
import { el } from "./dom.mjs";
import { t } from "./i18n.mjs";
import { runMark } from './arc.mjs';

/** One menu chain, shared by pointer, touch, and keyboard. */
export function createContextMenu() {
  let panels = [], opener, openTimer, closeTimer, closeHook, generation = 0;
  // Pointer hover must not destroy the field that owns keyboard focus.
  const editing = () => panels.some(p => p.contains(document.activeElement) && document.activeElement?.matches('input, textarea, [contenteditable]'));
  const cancelTimers = () => { clearTimeout(openTimer); clearTimeout(closeTimer); };
  function scheduleTrim(depth) {
    cancelTimers();
    closeTimer = setTimeout(() => { if (!editing()) trim(depth); }, 250);
  }
  const buttons = panel => [...panel.querySelectorAll(':scope > button, :scope > input, :scope > .menu-row > .li')].filter(row => !row.disabled);
  function trim(depth) {
    for (const p of panels.splice(depth)) { p.trigger?.setAttribute('aria-expanded', 'false'); p.remove(); }
  }
  function close(restore = false) {
    generation++;
    clearTimeout(openTimer); clearTimeout(closeTimer); trim(0);
    const hook = closeHook; closeHook = null;
    hook?.();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    const target = typeof opener === 'function' ? opener() : opener;
    if (restore && target?.isConnected) target.focus({ preventScroll: true });
  }
  function outside(e) { if (!panels.some(p => p.contains(e.target))) close(); }
  function key(e) {
    if (isComposingKey(e)) return;
    const panel = panels.find(p => p.contains(e.target)) ?? panels.at(-1);
    if (!panel) return;
    const depth = panels.indexOf(panel), rows = buttons(panel), at = rows.indexOf(document.activeElement?.closest('.menu-row')?.querySelector('.li') ?? document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (depth > 0) { const trigger = panel.trigger; trim(depth); trigger.focus(); } else close(true); }
    else if (e.key === 'ArrowRight' && document.activeElement?.nextElementSibling?.classList.contains('menu-action')) { e.preventDefault(); document.activeElement.nextElementSibling.focus(); }
    else if (e.key === 'ArrowLeft' && document.activeElement?.classList.contains('menu-action')) { e.preventDefault(); document.activeElement.previousElementSibling.focus(); }
    else if (e.key === 'ArrowLeft' && depth > 0 && e.target.tagName !== 'INPUT') { e.preventDefault(); const trigger = panel.trigger; trim(depth); trigger.focus(); }
    else if (e.key === 'ArrowRight' && document.activeElement?.openSub) { e.preventDefault(); document.activeElement.openSub(true); }
    else if (['ArrowDown','ArrowUp','Home','End'].includes(e.key) && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    }
  }
  function panelAt(items, title, depth, x, y, trigger) {
    trim(depth);
    const panel = el('div', 'pop menu');
    panel.setAttribute('role', 'menu'); panel.trigger = trigger;
    // 見出しは 1 行で省略する。確認文のように全文を読ませたいものは { text, wrap: true } で渡す
    if (title) panel.append(typeof title === 'object' ? el('div', 'head' + (title.wrap ? ' wrap' : ''), title.text) : el('div', 'head', title));
    panel.onpointerenter = () => { clearTimeout(closeTimer); };
    panel.onfocusin = cancelTimers;
    panel.onpointerleave = e => {
      clearTimeout(openTimer);
      if (panels.some(p => p.contains(e.relatedTarget))) return;
      scheduleTrim(1);
    };
    for (const item of items) {
      if (item.sep) { panel.append(el('div', 'sep')); continue; }
      // 途中の見出し（項目の群の名前）。wrap は全文を折り返す
      if (item.head) { panel.append(el('div', 'head' + (item.wrap ? ' wrap' : ''), item.head)); continue; }
      if (item.input) {
        const input = el('input', 'field');
        input.placeholder = item.input.placeholder ?? ''; input.value = item.input.value ?? '';
        input.setAttribute('aria-label', input.placeholder || (typeof title === 'object' ? title?.text : title) || t('common.input'));
        input.onkeydown = e => { if (isComposingKey(e)) return; if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); if (v) { close(true); item.input.onCommit(v); } } };
        panel.append(input); continue;
      }
      const row = el('button', 'li' + (item.checked ? ' on' : '') + (item.danger ? ' danger' : '') + (item.note ? ' has-note' : ''));
      if (item.key) row.dataset.menuKey = item.key;
      row.type = 'button'; row.setAttribute('role', item.radio ? 'menuitemradio' : 'menuitem');
      if (item.radio) row.setAttribute('aria-checked', String(!!item.checked));
      // 今は押せない項目（タイトル行の「…」のタイトルを生成: 生成中・未送信など）
      if (item.disabled) { row.disabled = true; row.setAttribute('aria-disabled', 'true'); }
      // 名前の前の印（要素。小さなアイコンなど）
      if (item.icon) row.append(item.icon);
      row.append(el('span', 'lbl', item.label));
      if (item.pending) { const label = el('span', 'hint pending-label'); label.append(runMark(t('pending.loading')), t('pending.loading')); row.append(label); }
      else if (item.hint) row.append(typeof item.hint === 'function' ? item.hint() : el('span', 'hint', item.hint));
      // 項目の下の補足（押せない理由など）。右の値（.hint）とは別に、弱い小さな本文の字で全文を折り返す
      if (item.note) row.append(el('span', 'note', item.note));
      let subTrigger = row;
      if (item.action) {
        const group = el('div', 'menu-row'); group.setAttribute('role', 'none');
        const action = el('button', 'menu-action', '⋯'); action.type = 'button';
        if (item.key) action.dataset.menuKey = item.key;
        action.setAttribute('role', 'menuitem'); action.setAttribute('aria-label', item.action.label);
        group.append(row, action); panel.append(group); subTrigger = action;
        row.onclick = () => { if (!item.keepOpen) close(true); item.onClick?.(); };
        row.onpointerenter = () => scheduleTrim(depth + 1);
      }
      const subItems = item.action?.sub ?? item.sub;
      if (subItems) {
        if (!item.action) row.append(el('span', 'more', '▸'));
        subTrigger.setAttribute('aria-haspopup', 'menu'); subTrigger.setAttribute('aria-expanded', 'false');
        subTrigger.openSub = focus => {
          clearTimeout(openTimer); clearTimeout(closeTimer);
          if (panels[depth + 1]?.trigger !== subTrigger) {
            const r = subTrigger.getBoundingClientRect();
            const sub = panelAt(item.pending ? [{ label: '', pending: true }] : subItems(), item.action ? null : item.label, depth + 1, r.right + 6, r.top, subTrigger);
            subTrigger.setAttribute('aria-expanded', 'true');
            if (focus) buttons(sub)[0]?.focus();
          } else if (focus) buttons(panels[depth + 1])[0]?.focus();
        };
        subTrigger.onpointerenter = e => { if (e.pointerType === 'touch') return; cancelTimers(); openTimer = setTimeout(() => { if (!editing()) subTrigger.openSub(false); }, 150); };
        subTrigger.onfocus = () => { clearTimeout(closeTimer); };
        // 指で開いたときは中へフォーカスを移さない（先頭が入力欄だとキーボードが勝手に出る）
        subTrigger.onclick = e => subTrigger.openSub(e?.pointerType !== 'touch');
      } else {
        row.onpointerenter = () => { scheduleTrim(depth + 1); };
        row.onclick = () => { if (!item.keepOpen) close(true); item.onClick?.(); };
      }
      if (!item.action) panel.append(row);
    }
    document.body.append(panel); panels.push(panel);
    const r = panel.getBoundingClientRect();
    if (trigger && x + r.width > innerWidth - 8) {
      // 右に入らなければ左へ返す。左にも入らない狭い画面（スマホ）では、押した行の下へ少しずらして重ねる
      const tr = trigger.getBoundingClientRect();
      if (tr.left - r.width - 6 >= 8) x = tr.left - r.width - 6;
      else { x = tr.left + 12; y = tr.bottom + 2; }
    }
    panel.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
    return panel;
  }
  // opts.opener は描き直される開き元の取得関数。opts.onClose は閉じたときに 1 度呼ぶ。opts.alignRight は x を面の右端に合わせる
  return { close, open(x, y, items, title, opts = {}) {
    close(); opener = opts.opener ?? document.activeElement;
    closeHook = opts.onClose ?? null;
    const own = generation;
    const panel = panelAt(items, title, 0, x, y);
    if (opts.alignRight) panel.style.left = `${Math.max(8, Math.min(x - panel.getBoundingClientRect().width, innerWidth - panel.getBoundingClientRect().width - 8))}px`;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    buttons(panel)[0]?.focus({ preventScroll: true });
    return (nextItems, nextTitle = title) => {
      if (generation !== own || !panels.length) return;
      if (editing()) return;
      const focused = document.activeElement?.closest('button')?.querySelector('.lbl')?.textContent;
      const trigger = panels[1]?.trigger;
      const actionLabel = trigger?.classList.contains('menu-action') ? trigger.getAttribute('aria-label') : null;
      const actionKey = actionLabel ? trigger.dataset.menuKey : null;
      const openLabel = trigger?.querySelector('.lbl')?.textContent;
      const focusedAction = document.activeElement?.classList.contains('menu-action') ? document.activeElement.getAttribute('aria-label') : null;
      const focusedActionKey = focusedAction ? document.activeElement.dataset.menuKey : null;
      const next = panelAt(nextItems, nextTitle, 0, x, y);
      const rootRows = buttons(next);
      const openRow = actionLabel ? [...next.querySelectorAll('.menu-action')].find(b => actionKey ? b.dataset.menuKey === actionKey : b.getAttribute('aria-label') === actionLabel)
        : rootRows.find(b => b.querySelector('.lbl')?.textContent === openLabel);
      openRow?.openSub(false);
      const targetPanel = panels.at(-1);
      ((focusedAction ? [...next.querySelectorAll('.menu-action')].find(b => focusedActionKey ? b.dataset.menuKey === focusedActionKey : b.getAttribute('aria-label') === focusedAction) : null)
        ?? buttons(targetPanel).find(b => b.querySelector('.lbl')?.textContent === focused)
        ?? openRow ?? buttons(targetPanel)[0])?.focus({ preventScroll: true });
    };
  } };
}
