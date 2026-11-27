// 会話の ToDo（ADR 0342）。会話ごとの「やること」の並びと、項目の間の「先に終える」関係（after）、成果物のリンク。
// 画面（人）と AI（ply_control の todos.*）が同じ道具で読み書きする。保存は pleiad.db の todos・todo_scopes（core/db.mjs の todoTable）。
//   createTodos({ dataDir, now, onChange }) → { list, add, update, remove, checkLinks, close }
//   書く操作は持ち主（scope）の版（rev）を 1 つ上げ、onChange({ scope, rev, items, changed, by }) を呼ぶ（サーバーが画面へ配る）。
//   ifRev を渡すと、今の版と違えば CONFLICT で断る（画面の編集が、AI の書き込みを知らずに上書きしない）。
// 並び = 先に終える順（order の小さい順）。after に循環は作らせない。「待ち」は保存しない（未着手で、after のどれかが完了していない）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { openData } from './data-schema.mjs';
import { todoTable } from './db.mjs';

export const TODO_STATUSES = Object.freeze(['todo', 'doing', 'done']);
export const LINK_KINDS = Object.freeze(['file', 'dir', 'url']);
export const TODO_ITEMS_MAX = 200;
export const TODO_LINKS_MAX = 20;
export const TODO_PATH_MAX = 4096;
export const TODO_URL_MAX = 2048;
export const TODO_TITLE_MAX = 200;
export const TODO_TEXT_MAX = 200;

const RAND = 'abcdefghijklmnopqrstuvwxyz0123456789';
const rand = n => Array.from(crypto.randomBytes(n), b => RAND[b % RAND.length]).join('');
export const newTodoId = (now = Date.now()) => `todo_${Math.max(0, Math.floor(now)).toString(36).padStart(9, '0')}${rand(6)}`;
const newLinkId = () => `l_${rand(8)}`;

/** 操作の断り。code は core/ops の OpError に写す（INVALID・NOT_FOUND・CONFLICT） */
export class TodoError extends Error {
  constructor(code, message, detail = {}) { super(message); this.code = code; this.detail = detail; }
}
const invalid = message => new TodoError('INVALID', message);

/** 「待ち」: 未着手で、先に終える項目のどれかが完了していない */
export function waitingOf(item, byId) {
  return item.status === 'todo' && (item.after ?? []).some(id => byId.get(id) && byId.get(id).status !== 'done');
}

/** after に循環があれば、その輪の上の ID を 1 つ返す（無ければ null） */
export function cycleIn(items) {
  const byId = new Map(items.map(t => [t.id, t]));
  const state = new Map();
  const visit = id => {
    if (state.get(id) === 1) return id;
    if (state.get(id) === 2) return null;
    state.set(id, 1);
    for (const dep of byId.get(id)?.after ?? []) { if (byId.has(dep)) { const hit = visit(dep); if (hit) return hit; } }
    state.set(id, 2);
    return null;
  };
  for (const t of items) { const hit = visit(t.id); if (hit) return hit; }
  return null;
}

/** リンクを整える。path か url のどちらか。種類が無ければ形から決める（http(s) → url、末尾が / か \ → dir、ほかは file） */
export function normalizeLink(link) {
  if (!link || typeof link !== 'object') throw invalid('link must be an object');
  const url = typeof link.url === 'string' ? link.url.trim() : '';
  const filePath = typeof link.path === 'string' ? link.path.trim() : '';
  let kind = link.kind;
  if (!kind) kind = url ? 'url' : /^https?:\/\//i.test(filePath) ? 'url' : /[\\/]$/.test(filePath) ? 'dir' : 'file';
  if (!LINK_KINDS.includes(kind)) throw invalid(`link kind must be one of ${LINK_KINDS.join(', ')}`);
  const title = typeof link.title === 'string' ? link.title.trim().slice(0, TODO_TITLE_MAX) : '';
  const out = { id: typeof link.id === 'string' && /^l_[0-9a-z]{4,}$/.test(link.id) ? link.id : newLinkId(), kind };
  if (kind === 'url') {
    const value = url || filePath;
    if (!/^https?:\/\/\S+$/i.test(value) || value.length > TODO_URL_MAX) throw invalid('url must be an http(s) URL');
    out.url = value;
  } else {
    if (!filePath || filePath.length > TODO_PATH_MAX || filePath.includes('\0')) throw invalid('path is required for file and dir links');
    out.path = filePath;
  }
  if (title) out.title = title;
  return out;
}

const cleanText = text => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) throw invalid('text is empty');
  return value;
};
const cleanItemText = text => {
  const value = cleanText(text);
  if ([...value].length > TODO_TEXT_MAX) throw invalid(`text must be at most ${TODO_TEXT_MAX} characters`);
  return value;
};
function setDetails(item, input) {
  const details = { ...item.external };
  if (input.followUp !== undefined) details.followUp = input.followUp;
  if (input.assignee !== undefined) details.assignee = input.assignee ? cleanText(input.assignee) : null;
  if (input.humanWaiting !== undefined) details.humanWaiting = input.humanWaiting === true;
  if (input.taskId !== undefined && input.taskId !== (details.taskId ?? null)) {
    if (input.taskId !== null && !/^ply-task-[0-9a-f-]{36}$/.test(input.taskId)) throw invalid('taskId must identify a delegated task');
    details.taskId = input.taskId;
    delete details.taskStatus;
    delete details.taskWaiting;
  }
  if (Object.keys(details).length) item.external = details;
}

const taskProblems = new Set(['failed', 'cancelled', 'interrupted']);
function applyTask(item, task) {
  const details = item.external;
  const { status, humanWaiting } = task;
  if (details.taskStatus === status && Boolean(details.taskWaiting) === humanWaiting) return false;
  item.external = { ...details, taskStatus: status, taskWaiting: humanWaiting };
  if (status === 'completed') item.status = 'done';
  else if (item.status !== 'done' && (status === 'running' || status === 'cancelling' || taskProblems.has(status) || humanWaiting)) item.status = 'doing';
  return true;
}

const cleanStatus = status => {
  if (!TODO_STATUSES.includes(status)) throw invalid(`status must be one of ${TODO_STATUSES.join(', ')}`);
  return status;
};
const cleanLinks = links => {
  if (!Array.isArray(links)) throw invalid('links must be an array');
  if (links.length > TODO_LINKS_MAX) throw invalid(`at most ${TODO_LINKS_MAX} links per item`);
  return links.map(normalizeLink);
};

/** 出す形（waiting を足し、内部の列を省く） */
function view(items) {
  const byId = new Map(items.map(t => [t.id, t]));
  return items.map(t => ({ id: t.id, text: t.text, status: t.status, waiting: waitingOf(t, byId), after: t.after.filter(id => byId.has(id)),
    assignee: t.external?.assignee ?? null, humanWaiting: Boolean(t.external?.humanWaiting || t.external?.taskWaiting),
    taskId: t.external?.taskId ?? null, taskIssue: taskProblems.has(t.external?.taskStatus) ? t.external.taskStatus : null,
    ...(t.external?.followUp ? { followUp: t.external.followUp } : {}),
    links: t.links, order: t.order, by: t.by ?? null, updatedBy: t.updatedBy ?? null, createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null }));
}

export function createTodos({ dataDir, now = Date.now, onChange = () => {}, taskOf = () => null, exists = p => fs.existsSync(p) } = {}) {
  let table = null, handle = null;
  const open = () => { if (!table) { handle = openData(dataDir); table = todoTable(handle.db); } return table; };
  const scopeOf = ({ kind = 'session', id }) => {
    if (typeof id !== 'string' || !id) throw invalid('scope id is required');
    return { kind, id };
  };
  const read = scope => { const t = open(); return { rev: t.rev(scope.kind, scope.id), items: t.list(scope.kind, scope.id) }; };
  const guard = (scope, ifRev) => {
    const current = read(scope);
    if (ifRev !== undefined && ifRev !== null && ifRev !== current.rev) throw new TodoError('CONFLICT', `the list changed (rev ${current.rev}, expected ${ifRev})`, { rev: current.rev });
    return current;
  };
  /** 並びを 1, 2, 3 … に振り直す（並べ替え・追加の後） */
  const renumber = items => items.forEach((t, i) => { t.order = i + 1; });
  const commit = (scope, items, removed, changed, by) => {
    const cycle = cycleIn(items);
    if (cycle) throw new TodoError('CYCLE', `"after" would make a loop (at ${cycle})`, { id: cycle });
    const rev = open().replace(scope.kind, scope.id, items, removed);
    const out = { rev, items: view(items) };
    try { onChange({ scope, rev, items: out.items, changed, by }); } catch { /* 配るのに失敗しても保存は済んでいる */ }
    return out;
  };
  const afterIds = (list, known, self) => {
    if (!Array.isArray(list)) throw invalid('after must be an array of ids');
    const out = [];
    for (const raw of list) {
      const resolved = typeof raw === 'string' ? known.get(raw) : undefined;
      if (!resolved) throw new TodoError('NOT_FOUND', `no item ${raw}`, { id: raw });
      if (resolved === self) throw invalid('an item cannot come after itself');
      if (!out.includes(resolved)) out.push(resolved);
    }
    return out;
  };

  function syncItem(scope, item) {
    if (scope.kind !== 'session' || !item.external?.taskId) return false;
    const task = taskOf(item.external.taskId);
    return task?.parentSessionId === scope.id && applyTask(item, task);
  }

  /** changes を並び（写し）に順に当てて、新しい並びと changed を返す（update と、remove のつなぎ直しが共用） */
  function applyChanges(scope, list, changes, by) {
    let next = list;
    const at = now();
    const changed = [];
    for (const c of changes) {
      const item = next.find(t => t.id === c.id);
      if (!item) throw new TodoError('NOT_FOUND', `no item ${c.id}`, { id: c.id });
      const before = { ...item };
      const previousIndex = next.indexOf(item);
      if (c.text !== undefined && c.text !== item.text) item.text = cleanItemText(c.text);
      if (c.status !== undefined) item.status = cleanStatus(c.status);
      setDetails(item, c);
      syncItem(scope, item);
      if (c.after !== undefined) item.after = afterIds(c.after, new Map(next.map(t => [t.id, t.id])), item.id);
      if (c.links !== undefined) item.links = cleanLinks(c.links);
      if (c.removeLinks?.length) item.links = item.links.filter(l => !c.removeLinks.includes(l.id) && !c.removeLinks.includes(l.path) && !c.removeLinks.includes(l.url));
      if (c.addLinks?.length) item.links = cleanLinks([...item.links, ...c.addLinks]);
      if (c.before !== undefined) {
        next = next.filter(t => t !== item);
        const index = c.before === null ? -1 : next.findIndex(t => t.id === c.before);
        if (c.before !== null && index < 0) throw new TodoError('NOT_FOUND', `no item ${c.before}`, { id: c.before });
        next.splice(index < 0 ? next.length : index, 0, item);
      }
      if (previousIndex === next.indexOf(item) && isDeepStrictEqual(before, item)) continue;
      item.updatedAt = at;
      item.updatedBy = by;
      const action = before.status !== item.status ? (item.status === 'done' ? 'done' : item.status === 'doing' ? 'started' : 'reopened')
        : c.before !== undefined && c.text === undefined && c.after === undefined && c.links === undefined && !c.addLinks && !c.removeLinks ? 'moved' : 'updated';
      changed.push({ id: item.id, action });
    }
    return { next, changed };
  }

  return {
    syncTasks() {
      for (const id of open().linkedSessions()) {
        const scope = { kind: 'session', id };
        const { items } = read(scope);
        const changed = [];
        const at = now();
        for (const item of items) {
          const before = item.status;
          if (!syncItem(scope, item)) continue;
          item.updatedAt = at;
          changed.push({ id: item.id, action: before === item.status ? 'updated' : item.status === 'done' ? 'done' : 'started' });
        }
        if (changed.length) commit(scope, items, [], changed, null);
      }
    },

    list(scope) { const s = scopeOf(scope); const { rev, items } = read(s); return { rev, items: view(items) }; },

    /**
     * 足す。entries: [{ text, status?, after?, links?, ref? }]。ref は同じ呼び出しの中で after から指す仮の名前。
     * before: この ID の前に入れる（無ければ末尾）
     */
    add(scope, { entries, before = null, ifRev, by }) {
      const s = scopeOf(scope);
      if (!Array.isArray(entries) || !entries.length) throw invalid('items is empty');
      const { items } = guard(s, ifRev);
      if (items.length + entries.length > TODO_ITEMS_MAX) throw invalid(`at most ${TODO_ITEMS_MAX} items per conversation`);
      const at = now();
      const known = new Map(items.map(t => [t.id, t.id]));
      const fresh = entries.map((e, i) => {
        const id = newTodoId(at + i);
        if (typeof e.ref === 'string' && e.ref) { if (known.has(e.ref)) throw invalid(`ref ${e.ref} is used twice`); known.set(e.ref, id); }
        known.set(id, id);
        return { id, entry: e };
      });
      const added = fresh.map(({ id, entry }) => ({ id, text: cleanItemText(entry.text), status: cleanStatus(entry.status ?? 'todo'),
        after: afterIds(entry.after ?? [], known, id), links: cleanLinks(entry.links ?? []), order: 0, by, updatedBy: by, createdAt: at, updatedAt: at }));
      for (let i = 0; i < added.length; i++) {
        setDetails(added[i], fresh[i].entry);
        syncItem(s, added[i]);
      }
      const next = [...items];
      const index = before ? next.findIndex(t => t.id === before) : -1;
      if (before && index < 0) throw new TodoError('NOT_FOUND', `no item ${before}`, { id: before });
      next.splice(index < 0 ? next.length : index, 0, ...added);
      renumber(next);
      return commit(s, next, [], added.map(t => ({ id: t.id, action: 'added' })), by);
    },

    /**
     * 変える。changes: [{ id, text?, status?, after?, links?, addLinks?, removeLinks?, before? }]。
     * before は並べ替え（この ID の前へ。null なら末尾）。項目ごとに順に当てる
     */
    update(scope, { changes, ifRev, by }) {
      const s = scopeOf(scope);
      if (!Array.isArray(changes) || !changes.length) throw invalid('items is empty');
      const { rev, items } = guard(s, ifRev);
      const { next, changed } = applyChanges(s, items.map(t => ({ ...t })), changes, by);
      if (!changed.length) return { rev, items: view(items) };
      renumber(next);
      return commit(s, next, [], changed, by);
    },

    /**
     * 消す。ほかの項目の after からも外す。
     * changes（update と同じ形）を渡すと、消した後の残りに同じ版の 1 回の書き込みで当てる
     * （画面の「消す項目を待っていた項目を、消す項目が待っていた項目につなぎ直す」。つなぎ直しだけ済んで消せない、を作らない）
     */
    remove(scope, { ids, changes = [], ifRev, by }) {
      const s = scopeOf(scope);
      if (!Array.isArray(ids) || !ids.length) throw invalid('ids is empty');
      if (!Array.isArray(changes)) throw invalid('items must be an array');
      const { items } = guard(s, ifRev);
      for (const id of ids) if (!items.some(t => t.id === id)) throw new TodoError('NOT_FOUND', `no item ${id}`, { id });
      const gone = new Set(ids);
      const at = now();
      const rest = items.filter(t => !gone.has(t.id)).map(t => (t.after.some(id => gone.has(id)) ? { ...t, after: t.after.filter(id => !gone.has(id)), updatedAt: at } : { ...t }));
      const { next, changed } = applyChanges(s, rest, changes, by);
      renumber(next);
      return commit(s, next, [...gone], [...[...gone].map(id => ({ id, action: 'removed' })), ...changed], by);
    },

    /** 成果物のリンクのうち、ファイル・フォルダーが今あるか（url は見ない） */
    checkLinks(scope, { id }) {
      const s = scopeOf(scope);
      const item = read(s).items.find(t => t.id === id);
      if (!item) throw new TodoError('NOT_FOUND', `no item ${id}`, { id });
      return { links: item.links.map(l => {
        if (l.kind === 'url') return { id: l.id, exists: true };
        let ok = false;
        try { ok = exists(l.path); if (ok && l.kind === 'dir') ok = fs.statSync(l.path).isDirectory(); } catch { ok = false; }
        return { id: l.id, exists: ok };
      }) };
    },

    /** DB の接続を離す（テストの後片付け） */
    close() { handle?.release(); handle = null; table = null; },
  };
}
