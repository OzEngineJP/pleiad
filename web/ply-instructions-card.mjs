// ==================== 設定 › コンテキスト「指示」のカードの「Pleiad の指示」（docs/design-system.md「コンテキスト」） ====================
// Pleiad が会話に毎ターン入れる指示の一覧（core/ply-instructions.mjs）。すべての場所に共通で、ファイルの担当によらない。
//   行: 並べ替えの取っ手（入る順。web/reorder.mjs。設定 › 委譲の候補と同じ部品）・名前・札（既定／既定から変更／委譲と連動）・入れる会話（弱い字）・スイッチ。
//   押すと下に中身（Markdown）と「編集」「削除」（既定は「既定に戻す」。委譲と連動は「設定 › 委譲で変える →」だけ）。
//   「＋ 指示を追加」と「編集」は同じシート（<dialog>。外部 MCP の追加シートと同じ形）。
// 変更はその場で保存し（setPlyInstructions）、カードの知らせ「保存しました · 次のターンから反映」を出す。
// 描き直しても、フォーカスは同じ行の同じ操作（data-fk）に残す。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { renderMarkdown } from './render.mjs';
import { estimateTokens } from './token-estimate.mjs';
import { createReorder, moveItem, slideFrom } from './reorder.mjs';

const TARGETS = ['all', 'parent', 'child'];
const NAME_SLOT = '\u0001';   // core/ply-instructions.mjs の見出しの型の、名前の位置
const HEAVY = 4000;           // これを超えたら弱い警告の一行（毎ターン入るので）

function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
const plus = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M12 5v14M5 12h14"/>';
  return s;
};

// i18n-dynamic: context.ply.target.
// i18n-dynamic: context.ply.targetOpt.
export function createPlyInstructions({ cmd, work, saved, openDelegation, opened, showMenu, onCount }) {
  const root = el('div', 'cx-block cx-ply');
  // 並べ替えの結果の読み上げ。描き直しても外さない
  const status = el('div', 'visually-hidden');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  root.append(status);
  const announce = text => { status.textContent = text; };
  // wantFocus: 次の描き直しでフォーカスを置く操作（data-fk）。dirty: ドラッグ中に来た描き直しを終わるまで待たせている。
  // painted: 最後に描いた中身。ordering: 保存の応答を待っている並べ替えの数
  let state = null, wantFocus = '', dirty = false, painted = '', ordering = 0;
  const key = id => `ply:${id}`;
  const movable = () => (state?.items ?? []).filter(i => i.tag !== 'linked');
  const signature = () => `${JSON.stringify(state)}\n${[...opened].filter(k => k.startsWith('ply:')).join('\n')}`;
  const reorder = createReorder({ root, rowSelector: '.cx-item[data-order]', idOf: item => item.dataset.order, face: item => item.querySelector('.cx-row'),
    current: () => movable().map(i => i.id), showMenu, announce,
    // メニューとキーで動かしたときは、行が移る動きを見せる。落としたときは、もうその位置に空きがある
    move: (_group, id, to, by) => moveTo(id, to, by !== 'drag'),
    settled: focus => {
      if (focus) wantFocus = focus;
      if (focus || dirty) render();
    } });

  // 同じ中身なら描き直さない（保存の後に届く「設定が変わった」の知らせで、動いている途中の行を作り直さない）
  function apply(next) {
    state = next;
    onCount?.(state ? state.items.length : 0);
    if (signature() !== painted) render();
  }
  async function load() {
    const next = await cmd('plyInstructions', {}).catch(() => null);
    if (ordering) return;   // 並べ替えの保存中。最後の応答が今の状態を運ぶ
    apply(next);
  }
  async function change(args, focus) {
    state = await cmd('setPlyInstructions', args);
    saved();
    if (focus) wantFocus = focus;
    render();
  }
  /** 動かせる行の中で id を to 番目へ。先に画面を変えてから保存する（続けて動かせる）。 */
  function moveTo(id, to, slide) {
    const next = moveItem(movable().map(i => i.id), id, to);
    if (!next) return;
    const tops = slide ? rowTops() : null;
    const byId = new Map(state.items.map(i => [i.id, i]));
    let at = 0;
    state = { ...state, items: state.items.map(i => i.tag === 'linked' ? i : byId.get(next[at++])) };
    wantFocus = `order|ply|${id}`;
    render();
    if (tops) for (const [rowId, top] of rowTops()) slideFrom(rows().find(r => r.dataset.order === rowId), tops.get(rowId) - top);
    announce(t('common.reorder.moved', { name: byId.get(id).name, position: to + 1 }));
    ordering++;
    work(async () => {
      let saving = null, failed = null;
      try { saving = await cmd('setPlyInstructions', { action: 'order', ids: next }); } catch (e) { failed = e; }
      ordering--;
      if (failed) { if (!ordering) await load(); throw failed; }
      saved();
      if (!ordering) apply(saving);
    });
  }
  const rows = () => [...root.querySelectorAll('.cx-item')].filter(r => r.dataset.order);
  const rowTops = () => new Map(rows().map(r => [r.dataset.order, r.getBoundingClientRect?.().top]));
  const heading = name => String(state?.heading ?? NAME_SLOT).replace(NAME_SLOT, name);

  function render() {
    if (reorder.busy) { dirty = true; return; }
    dirty = false; painted = signature();
    const active = document.activeElement;
    const focus = wantFocus || (active && root.contains(active) ? active.dataset?.fk ?? '' : '');
    wantFocus = '';
    for (const child of [...root.children]) if (child !== status) child.remove();
    const sec = el('div', 'cx-sec');
    const title = el('span', 'n', t('context.ply.title'));
    title.id = 'cxPlyTitle';
    sec.append(title, el('span', 'r', state ? t('context.ply.scope', { tokens: fmt.number(state.total) }) : t('context.ply.scopePlain')));
    root.append(sec);
    if (!state) { root.append(el('p', 'cx-empty', t('context.ply.unavailable'))); return; }
    const list = el('div', 'cx-list');
    list.setAttribute('role', 'group'); list.setAttribute('aria-labelledby', title.id);
    for (const item of state.items) {
      // 行と開いた中身を 1 つにまとめる（並べ替えで一緒に動く）。動かせる行だけに data-order を付ける
      const box = el('div', 'cx-item');
      if (item.tag !== 'linked') box.dataset.order = item.id;
      box.append(row(item));
      if (opened.has(key(item.id))) box.append(peek(item));
      list.append(box);
    }
    const add = button('', 'cx-add', () => openSheet(null, add));
    add.dataset.fk = 'add';
    add.append(plus(), document.createTextNode(t('context.ply.add')));
    list.append(add);
    root.append(list);
    if (state.total > HEAVY) root.append(el('p', 'cx-sub', t('context.ply.heavy')));
    if (focus) [...root.querySelectorAll('button')].find(b => b.dataset?.fk === focus)?.focus({ preventScroll: true });
  }

  function row(item) {
    const linked = item.tag === 'linked', off = !item.on || (linked && !state.routing);
    const r = el('div', 'cx-row' + (off ? ' off' : ''));
    r.dataset.id = item.id;
    if (linked) { const gap = el('span', 'cx-grip-gap'); gap.setAttribute('aria-hidden', 'true'); r.append(gap); }
    else r.append(reorder.handle('ply', item.id, item.name));
    const open = button('', 'cx-open');
    open.dataset.fk = `open|${item.id}`;
    open.setAttribute('aria-expanded', String(opened.has(key(item.id))));
    const body = el('span', 't');
    const nm = el('span', 'nm', item.name);
    const badge = item.tag === 'default' ? (item.modified ? t('context.ply.badge.modified') : t('context.ply.badge.default')) : linked ? t('context.ply.badge.linked') : '';
    if (badge) nm.append(el('span', 'cbadge', badge));
    const only = item.agents.length === (state?.agents?.length ?? item.agents.length) ? '' : t('context.ply.onlyAgent', { agent: item.agents.map(a => state?.agents?.find(x => x.id === a)?.label ?? a).join(t('context.ply.agentJoin')) });
    const sub = [t(`context.ply.target.${item.target}`), only, linked && !state.routing ? t('context.ply.routingOff') : ''].filter(Boolean).join(' · ');
    body.append(nm, el('span', 'p', sub));
    open.append(body);
    open.onclick = () => {
      if (opened.has(key(item.id))) opened.delete(key(item.id)); else opened.add(key(item.id));
      wantFocus = open.dataset.fk;
      render();
    };
    r.append(open);
    if (!linked) {
      const sw = button('', 'cx-sw');
      sw.dataset.fk = `sw|${item.id}`;
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(item.on)); sw.setAttribute('aria-label', t('context.ply.switchAria', { name: item.name }));
      sw.onclick = () => { sw.setAttribute('aria-checked', String(!item.on)); work(() => change({ action: 'toggle', id: item.id, on: !item.on }, sw.dataset.fk)); };
      r.append(sw);
    }
    return r;
  }

  function peek(item) {
    const box = el('div', 'cx-peek');
    const text = el('div', 'body');
    text.innerHTML = renderMarkdown(item.body);
    const acts = el('div', 'acts');
    if (item.tag === 'linked') acts.append(button(t('context.ply.gotoDelegation'), 'cx-link', () => openDelegation?.()));
    else {
      const edit = button(t('context.ply.edit'), 'btn btn-quiet', () => openSheet(item, edit));
      acts.append(edit);
      if (item.tag === 'default') { if (item.modified) acts.append(button(t('context.ply.reset'), 'btn', () => work(() => change({ action: 'reset', id: item.id })))); }
      else {
        // 取り消せないので 2 回押して消す（外部 MCP の削除と同じ）
        const del = button(t('context.ply.delete'), 'btn');
        let armed = null;
        del.onclick = () => {
          if (!armed) { del.textContent = t('context.ply.deleteConfirm'); armed = setTimeout(() => { armed = null; del.textContent = t('context.ply.delete'); }, 3000); return; }
          clearTimeout(armed);
          opened.delete(key(item.id));
          work(() => change({ action: 'delete', id: item.id }, 'add'));
        };
        acts.append(del);
      }
    }
    box.append(text, acts);
    return box;
  }

  // ---- 追加・編集のシート
  function openSheet(item, returnTo) {
    document.querySelector('dialog.ply-sheet')?.remove();
    const dialog = el('dialog', 'mcp-sheet ply-sheet');
    const form = el('form');
    const titleText = item ? t('context.ply.sheet.editTitle') : t('context.ply.sheet.addTitle');
    const head = el('h3', null, titleText);
    head.id = 'plySheetTitle'; head.tabIndex = -1;
    dialog.setAttribute('aria-labelledby', head.id);
    const nameField = el('label', 'mcp-field');
    const name = el('input'); name.value = item?.name ?? ''; name.placeholder = t('context.ply.sheet.namePlaceholder'); name.autocomplete = 'off';
    nameField.append(t('context.ply.sheet.name'), name);
    const bodyField = el('label', 'mcp-field');
    const body = el('textarea'); body.rows = 7; body.spellcheck = false; body.value = item?.body ?? '';
    const count = el('span', 'cnt');
    bodyField.append(t('context.ply.sheet.body'), body, count);
    const paintCount = () => { count.textContent = t('context.ply.sheet.tokens', { tokens: fmt.number(estimateTokens(`${heading(name.value.trim())}\n${body.value.trim()}`)) }); };
    // 入れる会話（1 つ選ぶ）
    let target = item?.target ?? 'all';
    const targetField = el('div', 'mcp-field');
    const targetLabel = el('span', null, t('context.ply.sheet.target')); targetLabel.id = 'plySheetTarget';
    const targetChips = el('div', 'cx-chips'); targetChips.setAttribute('role', 'radiogroup'); targetChips.setAttribute('aria-labelledby', targetLabel.id);
    const targetButtons = TARGETS.map(id => {
      const b = button(t(`context.ply.targetOpt.${id}`), 'cx-chip', () => { target = id; paint(); });
      b.setAttribute('role', 'radio'); b.dataset.v = id;
      targetChips.append(b);
      return b;
    });
    targetField.append(targetLabel, targetChips);
    // エージェント（1 つ以上）。一覧はサーバーが返す（state.agents。本番のエージェント全部）
    const selectable = state?.agents ?? [];
    let agents = item ? [...item.agents] : selectable.map(a => a.id);
    const agentField = el('div', 'mcp-field');
    const agentLabel = el('span', null, t('context.ply.sheet.agents')); agentLabel.id = 'plySheetAgents';
    const agentChips = el('div', 'cx-chips'); agentChips.setAttribute('role', 'group'); agentChips.setAttribute('aria-labelledby', agentLabel.id);
    const agentButtons = selectable.map(({ id, label }) => {
      const b = button(label, 'cx-chip', () => {
        agents = agents.includes(id) ? (agents.length > 1 ? agents.filter(a => a !== id) : agents) : [...agents, id];
        paint();
      });
      b.dataset.v = id;
      agentChips.append(b);
      return b;
    });
    agentField.append(agentLabel, agentChips);
    const error = el('p', 'mcp-error'); error.setAttribute('role', 'alert');
    const acts = el('div', 'mcp-acts');
    const go = button(t('context.ply.sheet.save'), 'btn btn-primary'); go.type = 'submit';
    acts.append(button(t('context.cancel'), 'btn', () => dialog.close()), go);
    form.append(head, nameField, bodyField, targetField, agentField, error, acts);
    dialog.append(form);
    function paint() {
      for (const b of targetButtons) b.setAttribute('aria-checked', String(b.dataset.v === target));
      for (const b of agentButtons) b.setAttribute('aria-pressed', String(agents.includes(b.dataset.v)));
    }
    name.oninput = paintCount;
    body.oninput = paintCount;
    form.onsubmit = async e => {
      e.preventDefault();
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = t('context.ply.sheet.nameRequired'); name.focus(); return; }
      if (!body.value.trim()) { error.textContent = t('context.ply.sheet.bodyRequired'); body.focus(); return; }
      go.disabled = true;
      try {
        await change({ action: 'save', ...(item ? { id: item.id } : {}), name: name.value.trim(), body: body.value.trim(), target, agents });
        if (item) opened.add(key(item.id));
        dialog.close();
        render();
      } catch (err) { error.textContent = err.message; }
      finally { go.disabled = false; }
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      (returnTo?.isConnected ? returnTo : item ? root.querySelector(`.cx-row[data-id="${item.id}"] .cx-open`) : root.querySelector('.cx-add'))?.focus();
    });
    document.body.append(dialog);
    paint(); paintCount();
    dialog.showModal();
    (item ? head : name).focus();
  }

  return { root, load, render };
}
