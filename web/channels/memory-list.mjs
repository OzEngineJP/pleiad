import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { sourceView } from './bot-model.mjs';
import { botIcon } from './bot-icon.mjs';
// i18n-dynamic: channels:memory.tier.
// i18n-dynamic: channels:memory.folder.
const FOLDERS = ['open', 'decision', 'pref', 'share', 'note', 'done', 'stop'];
const PAGE_SIZE = 4;
const folderOf = (entry) => {
  if (entry.kind === 'stop' || entry.status === 'dropped') return 'stop';
  if (entry.status === 'done') return 'done';
  if (entry.status === 'open') return 'open';
  return FOLDERS.includes(entry.kind) ? entry.kind : 'note';
};
const searchText = (text) => text.normalize('NFKC').toLocaleLowerCase();
let nextListId = 0;

export const UNDO_MS = 12000;
const FADE_MS = 240;
const TEXT_MAX = 300;
const WORKSPACE_MAX = 500;
const TIERS = ['standard', 'always', 'workspace', 'archive'];

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const message = (e) => (e && typeof e === 'object' && 'message' in e ? e.message : String(e));

export function createMemoryList(host, { lookup, openSource, userOnly = false }) {
  const root = el('div', 'mem-wrap');
  const S = {
    bot: null,
    // 層ごとの写し。entries: null = まだ読んでいない
    user: { entries: null, error: '' },
    own: { entries: null, error: '' },
    editing: null,   // 直している行の id
    draft: '',       // 直している途中の字（別の端末の変更で描き直しても消さない）
    draftTier: '',   // 直している途中の段（'' = 変えない）と作業場所
    draftWs: '',
    focusEdit: false,
    seq: {},         // 層ごとの読み込みの番号
  };
  let scope = userOnly ? 'user' : 'own';
  let detail = null;
  let query = '';
  let opened = new Set(['open']);
  const limits = new Map();
  const listId = ++nextListId;
  const core = el('div', 'memcore');
  const controls = el('div', 'mem-controls');
  const select = el('select', 'mem-control');
  select.setAttribute('aria-label', t('channels:memory.scopeLabel'));
  for (const key of ['own', 'user']) {
    const option = el('option', null, key === 'own' ? t('channels:memory.scopeOwn') : t('channels:memory.scopeUser'));
    option.value = key;
    select.append(option);
  }
  select.onchange = () => {
    scope = select.value;
    detail = null;
    opened = new Set(['open']);
    limits.clear();
    stopEditing();
  };
  const search = el('input', 'mem-control');
  search.type = 'search';
  search.placeholder = t('channels:memory.search');
  search.setAttribute('aria-label', search.placeholder);
  search.oninput = () => {
    query = searchText(search.value.trim());
    for (const key of FOLDERS) opened.delete(`search:${key}`);
    detail = null;
    limits.clear();
    stopEditing();
  };
  const results = el('p', 'mem-results');
  results.setAttribute('role', 'status');
  if (!userOnly) controls.append(select);
  controls.append(search);
  const undo = el('div', 'mem-undo');
  undo.hidden = true;
  undo.setAttribute('role', 'status');
  let undoTimer = null;
  const note = el('p', 'mem-err');
  note.setAttribute('role', 'alert');
  note.hidden = true;
  root.append(controls, results, core, note, undo);

  const layerId = (key) => (key === 'user' ? 'user' : S.bot?.id);
  const keyOf = (layer) => (layer === 'user' ? 'user' : layer === S.bot?.id ? 'own' : null);

  const showError = (text) => { note.textContent = text; note.hidden = !text; };

  // ---------------------------------------------------------------- 描画
  function sourceLabel(source, view) {
    const where = view.where.name;
    return [...new Set([where, source.threadTitle].filter(Boolean))].join(' › ') || t('channels:memory.source.none');
  }

  function sourceNode(entry) {
    const box = el('span', 'src');
    const sources = Array.isArray(entry.sources) ? entry.sources : [];
    const first = sources.find((s) => s?.kind === 'post' || s?.kind === 'message');
    if (!first) {
      box.classList.add('untrusted');
      box.textContent = entry.by?.kind === 'human' ? t('channels:memory.source.written') : t('channels:memory.source.none');
    } else {
      const v = sourceView(first, lookup());
      const text = sourceLabel(first, v);
      const image = v.where.type === 'dm' ? botIcon(v.where, 'src-bot-icon') : null;
      if (v.target) {
        const link = el('button', 'src-link', text);
        if (image) link.prepend(image);
        link.type = 'button';
        link.title = t('channels:memory.source.open');
        link.onclick = () => openSource(v.target);
        box.append(link);
      } else {
        box.classList.add('untrusted');
        box.textContent = text;
        if (image) box.prepend(image);
      }
      if (sources.length > 1) box.append(el('span', 'src-more', t('channels:memory.source.more', { n: sources.length - 1 })));
    }
    if ((entry.updatedAt ?? 0) - (entry.at ?? 0) > 60000) {
      const v = sourceView({ kind: 'post', at: entry.updatedAt }, lookup());
      box.append(el('span', 'src-more', t('channels:memory.source.edited', { when: v.date ?? t('channels:memory.source.today') })));
    }
    return box;
  }

  /** 行の段の札（作業場所の段は場所の最後の名前を添え、全体は title に） */
  function tierNode(entry) {
    const tier = TIERS.includes(entry.tier) ? entry.tier : 'none';
    const place = tier === 'workspace' && entry.workspace ? entry.workspace : '';
    const name = place.split('/').filter(Boolean).pop() ?? '';
    const node = el('span', 'mem-kind mem-tier', name ? `${t(`channels:memory.tier.${tier}`)} · ${name}` : t(`channels:memory.tier.${tier}`));
    node.dataset.tier = tier;
    if (place) node.title = place;
    return node;
  }

  /** 直すときの段と作業場所の欄。段は 'none'（未振り分け）を選べず、選ばなければ変えない */
  function placeControls(entry, onKey) {
    const box = el('span', 'mem-place');
    const select = el('select', 'fin memtier');
    select.setAttribute('aria-label', t('channels:memory.tierLabel'));
    for (const value of [...(entry.tier ? [] : ['']), ...TIERS]) {
      const option = el('option', '', t(`channels:memory.tier.${value || 'none'}`));
      option.value = value;
      select.append(option);
    }
    select.value = S.draftTier;
    const ws = el('input', 'fin memws');
    ws.type = 'text';
    ws.maxLength = WORKSPACE_MAX;
    ws.autocomplete = 'off';
    ws.placeholder = t('channels:memory.workspacePlaceholder');
    ws.setAttribute('aria-label', t('channels:memory.workspaceLabel'));
    ws.value = S.draftWs;
    const show = () => { ws.hidden = select.value !== 'workspace'; };
    select.addEventListener('change', () => { S.draftTier = select.value; show(); });
    ws.addEventListener('input', () => { S.draftWs = ws.value; });
    ws.addEventListener('keydown', onKey);
    show();
    box.append(select, ws);
    return box;
  }

  function rowNode(key, entry) {
    const row = el('div', 'mem');
    row.dataset.id = entry.id;
    const tx = el('span', 'tx');
    const acts = el('span', 'acts2');
    if (S.editing === entry.id) {
      row.classList.add('editing');
      const input = el('input', 'fin memedit');
      input.type = 'text';
      input.value = S.draft || entry.text;
      input.addEventListener('input', () => { S.draft = input.value; });
      input.maxLength = TEXT_MAX;
      input.setAttribute('aria-label', t('channels:memory.editLabel'));
      input.autocomplete = 'off';
      const cancel = el('button', 'btn', t('channels:memory.cancel'));
      cancel.type = 'button';
      const save = el('button', 'btn link', t('channels:memory.save'));
      save.type = 'button';
      cancel.onclick = () => stopEditing();
      save.onclick = () => saveEdit(key, entry, input.value);
      const onKey = (e) => {
        if (isComposingKey(e)) return;
        if (e.key === 'Enter') { e.preventDefault(); saveEdit(key, entry, input.value); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopEditing(); }
      };
      input.addEventListener('keydown', onKey);
      tx.append(input, placeControls(entry, onKey), sourceNode(entry));
      acts.append(cancel, save);
      if (S.focusEdit) {
        S.focusEdit = false;
        queueMicrotask(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
      }
    } else {
      const toggle = el('button', 'mem-record');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(detail === entry.id));
      toggle.append(el('span', 'tx-text', entry.text));
      const source = entry.sources?.find((s) => s.kind === 'post' || s.kind === 'message');
      toggle.append(el('span', 'mem-origin', source ? sourceLabel(source, sourceView(source, lookup()))
        : t(entry.by?.kind === 'human' ? 'channels:memory.source.written' : 'channels:memory.source.none')));
      toggle.onclick = () => {
        detail = detail === entry.id ? null : entry.id;
        paint({ row: entry.id });
      };
      tx.append(toggle);
      if (detail !== entry.id) {
        row.append(tx);
        return row;
      }
      tx.append(sourceNode(entry));
      if (entry.concern) {
        const { id, due, wakeOn } = entry.concern;
        const date = (at) => new Date(at).toLocaleString();
        const wake = [wakeOn?.thread, wakeOn?.word, wakeOn?.at ? date(wakeOn.at) : null].filter(Boolean).join(' · ');
        if (wake) tx.append(el('span', 'mem-origin', t('channels:bot.brain.loops.wake', { wake })));
        if (due) tx.append(el('span', 'mem-origin', t('channels:bot.brain.loops.due', { due: date(due) })));
        if (entry.status === 'open') {
          const stop = el('button', 'btn', t('channels:memory.stopTracking'));
          stop.type = 'button';
          stop.onclick = async () => {
            stop.disabled = true;
            try {
              await host.invoke('brain.loopResolve', { botId: entry.layer, id, status: 'dropped' });
              if (S.bot?.id === entry.layer) {
                opened.add('stop');
                await load(key);
                paint({ row: entry.id });
              }
            } catch (error) {
              stop.disabled = false;
              showError(message(error));
            }
          };
          tx.append(stop);
        }
        row.append(tx);
        return row;
      }
      tx.append(tierNode(entry));
      const fix = el('button', 'btn forget', t('channels:memory.edit'));
      fix.type = 'button';
      fix.dataset.act = 'edit';
      fix.setAttribute('aria-label', t('channels:memory.editAria', { text: entry.text }));
      fix.onclick = () => { S.editing = entry.id; S.draft = ''; S.draftTier = entry.tier ?? ''; S.draftWs = entry.workspace ?? ''; S.focusEdit = true; showError(''); paint(); };
      const gone = el('button', 'btn forget', t('channels:memory.forget'));
      gone.type = 'button';
      gone.dataset.act = 'forget';
      gone.setAttribute('aria-label', t('channels:memory.forgetAria', { text: entry.text }));
      gone.onclick = () => forget(key, entry, row);
      if (entry.kind === 'promise' && entry.status === 'open') {
        const stop = el('button', 'btn', t('channels:memory.stopTracking'));
        stop.type = 'button';
        stop.onclick = async () => {
          stop.disabled = true;
          try {
            await host.invoke('memory.edit', { id: entry.id, status: 'dropped' });
            opened.add('stop');
            await load(key);
            paint({ row: entry.id });
          } catch (error) {
            stop.disabled = false;
            showError(message(error));
          }
        };
        tx.append(stop);
      }
      acts.append(fix, gone);
    }
    row.append(tx, acts);
    return row;
  }

  function paint({ folder, row } = {}) {
    const focused = document.activeElement;
    if (core.contains(focused)) {
      folder ??= focused.closest('.mem-folder-toggle')?.dataset.folder;
      row ??= focused.closest('.mem-record')?.closest('.mem')?.dataset.id;
    }
    const state = S[scope];
    results.hidden = !query;
    if (state.entries == null || state.error) {
      results.hidden = true;
      core.replaceChildren(el('div', 'mem-empty', state.error || t('channels:memory.loading')));
      return;
    }
    const buckets = new Map(FOLDERS.map((key) => [key, []]));
    const sorted = [...state.entries].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    let count = 0;
    for (const entry of sorted) {
      const key = folderOf(entry);
      const sourceNames = (entry.sources ?? []).map((source) => sourceLabel(source, sourceView(source, lookup())));
      if (query && !searchText([entry.text, ...sourceNames, t(`channels:memory.folder.${key}`)].join(' ')).includes(query)) continue;
      buckets.get(key).push(entry);
      count++;
    }
    results.textContent = t('channels:memory.count', { n: count });
    const nodes = [];
    for (const [key, entries] of buckets) {
      if (query && !entries.length) continue;
      const section = el('section', 'mem-folder');
      const button = el('button', 'mem-folder-toggle');
      button.type = 'button';
      button.dataset.folder = key;
      const expanded = query ? !opened.has(`search:${key}`) : opened.has(key);
      const records = el('div', 'mem-records');
      records.id = `mem-folder-${listId}-${key}`;
      records.hidden = !expanded;
      button.setAttribute('aria-controls', records.id);
      button.setAttribute('aria-expanded', String(expanded));
      const pocket = el('span', 'mem-pocket');
      pocket.setAttribute('aria-hidden', 'true');
      pocket.append(el('span', 'mem-sheet'));
      button.append(pocket, el('span', null, t(`channels:memory.folder.${key}`)),
        el('span', 'mem-count', t('channels:memory.count', { n: entries.length })));
      button.onclick = () => {
        const expandedKey = query ? `search:${key}` : key;
        if (opened.has(expandedKey)) opened.delete(expandedKey);
        else opened.add(expandedKey);
        paint({ folder: key });
      };
      if (expanded) {
        const limit = limits.get(key) ?? PAGE_SIZE;
        records.append(...entries.slice(0, limit).map((entry) => rowNode(scope, entry)));
        if (!entries.length) records.append(el('p', 'mem-empty', t('channels:memory.empty')));
        if (entries.length > limit) {
          const more = el('button', 'btn link mem-more', t('channels:memory.more', { n: entries.length - limit }));
          more.type = 'button';
          more.onclick = () => {
            limits.set(key, limit + PAGE_SIZE);
            paint({ row: entries[limit].id });
          };
          records.append(more);
        }
      }
      section.append(button, records);
      nodes.push(section);
    }
    core.replaceChildren(...nodes);
    if (folder) core.querySelector(`[data-folder="${folder}"]`)?.focus();
    if (row) core.querySelector(`[data-id="${CSS.escape(row)}"] .mem-record`)?.focus();
  }

  // ---------------------------------------------------------------- 読み込み
  async function load(key) {
    const layer = layerId(key);
    if (!layer) return;
    const seq = (S.seq[key] = (S.seq[key] ?? 0) + 1);
    const mine = S.bot?.id;
    // 続けて呼ばれたときは最後の 1 回だけを当てる。別の bot に替わっていたら捨てる
    const stale = () => S.bot?.id !== mine || S.seq[key] !== seq;
    try {
      const entries = await host.invoke('memory.list', { layer });
      if (stale()) return;
      S[key] = { entries: Array.isArray(entries) ? entries : [], error: '' };
    } catch (e) {
      if (stale()) return;
      S[key] = { entries: S[key].entries, error: t('channels:memory.loadFailed', { error: message(e) }) };
    }
    if (scope === key) paint();
  }

  // ---------------------------------------------------------------- 直す・忘れる
  function stopEditing() { const row = S.editing; S.editing = null; S.draft = ''; S.draftTier = ''; S.draftWs = ''; paint({ row }); }

  /** 本文・段・作業場所のうち、今の行から変わるものだけを memory.edit へ送る（無ければ何も送らず閉じる） */
  async function saveEdit(key, entry, raw) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    const args = {};
    if (text && text !== entry.text) args.text = text;
    const tier = S.draftTier || entry.tier || '';
    if (tier && tier !== entry.tier) args.tier = tier;
    const ws = S.draftWs.trim();
    if (tier === 'workspace' && ws && ws !== entry.workspace) args.workspace = ws;
    if (!Object.keys(args).length) { stopEditing(); return; }
    try {
      const done = await host.invoke('memory.edit', { id: entry.id, ...args });
      if (S.editing === entry.id) S.editing = null;
      S.draft = '';
      S.draftTier = '';
      S.draftWs = '';
      const s = S[key];
      if (s.entries) s.entries = s.entries.map((e) => (e.id === entry.id ? { ...e, ...done } : e));
      showError('');
      paint();
    } catch (e) {
      showError(t('channels:memory.editFailed', { error: message(e) }));
    }
  }

  function clearUndo() {
    clearTimeout(undoTimer);
    undoTimer = null;
    undo.hidden = true;
    undo.replaceChildren();
  }

  async function forget(key, entry, row) {
    showError('');
    row.classList.add('gone');
    row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await host.invoke('memory.forget', { id: entry.id });
    } catch (e) {
      row.classList.remove('gone');
      row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      showError(t('channels:memory.forgetFailed', { error: message(e) }));
      return;
    }
    await new Promise((r) => setTimeout(r, reduced() ? 0 : FADE_MS));
    const s = S[key];
    if (s.entries) s.entries = s.entries.filter((e) => e.id !== entry.id);
    paint();
    const clip = [...entry.text].length > 30 ? `${[...entry.text].slice(0, 29).join('')}…` : entry.text;
    const back = el('button', 'btn link', t('channels:memory.undo'));
    back.type = 'button';
    back.onclick = async () => {
      back.disabled = true;
      try {
        const restored = await host.invoke('memory.unforget', { id: entry.id });
        clearUndo();
        const t2 = S[key];
        if (t2.entries && !t2.entries.some((e) => e.id === restored.id)) t2.entries = [...t2.entries, restored];
        paint();
      } catch (e) {
        back.disabled = false;
        showError(t('channels:memory.undoFailed', { error: message(e) }));
      }
    };
    undo.replaceChildren(el('span', 'undo-text', t('channels:memory.forgotten', { text: clip })), back);
    undo.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(clearUndo, UNDO_MS);
  }

  if (userOnly) void load('user');
  return {
    el: root,
    /** 見せる bot を替える（null で空に）。層の写しは読み直す */
    setBot(bot) {
      if (S.bot?.id === bot?.id) {
        if (bot) { S.bot = bot; paint(); }
        return;
      }
      S.bot = bot ?? null;
      scope = select.value = 'own';
      detail = null;
      search.value = query = '';
      opened = new Set(['open']);
      limits.clear();
      S.user = { entries: null, error: '' };
      S.own = { entries: null, error: '' };
      S.editing = null;
      S.draft = '';
      S.draftTier = '';
      S.draftWs = '';
      clearUndo();
      showError('');
      paint();
      if (bot) { load('user'); load('own'); }
    },
    /** 層を読み直す（memoryChanged）。layer を省けば両方。直している間は本文を上書きしないよう、描き直しは直し終えてから */
    refresh(layer) {
      if (userOnly) { if (layer == null || layer === 'user') load('user'); return; }
      if (!S.bot) return;
      const key = layer == null ? null : keyOf(layer);
      if (layer != null && !key) return;
      for (const k of key ? [key] : ['user', 'own']) load(k);
    },
    /** 出どころの字に使う外の写し（チャンネル・bot・会話）が変わった */
    repaint: paint,
    layers: () => ({ user: S.user.entries, own: S.own.entries }),
  };
}
