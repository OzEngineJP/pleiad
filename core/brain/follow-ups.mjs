import { createHash } from 'node:crypto';
import { brainTable, memoryStateTable, todoTable, transaction, wakeTable } from '../db.mjs';

/** Compatibility views for the heartbeat and reservation scheduler over the ToDo rows. */
export function followUpTable(db, now) {
  const todos = todoTable(db);
  const states = memoryStateTable(db);
  const scopeOf = value => {
    const source = value.sources?.find(source => source.sessionId || source.channelId);
    const sessionId = value.sessionId ?? source?.sessionId ?? (source?.channelId ? todos.concernSession(value.botId, source) : null);
    return sessionId ? { kind: 'session', id: sessionId } : { kind: 'bot', id: value.botId };
  };
  const read = (type, botId) => todos.followUps(type, botId).map(item => {
    const { type: _type, id, status, ...data } = item.external.followUp;
    const active = type === 'concern' ? 'open' : 'pending';
    return { item, value: { ...data, id, todoId: item.id, status: item.status === 'done' ? (status === active ? (type === 'concern' ? 'resolved' : 'cancelled') : status) : active,
      [type === 'concern' ? 'text' : 'note']: item.text, createdAt: item.createdAt, updatedAt: item.updatedAt } };
  });
  const put = (type, value, updatedAt, existing) => {
    const scope = existing?.scope ?? scopeOf(value);
    const { text, note, createdAt = updatedAt, updatedAt: _oldTime, todoId: _todoId, ...data } = value;
    const id = existing?.id ?? 'todo_' + createHash('sha256').update(JSON.stringify([type, value.botId, value.id])).digest('hex').slice(0, 24);
    const order = existing?.order ?? (todos.list(scope.kind, scope.id).at(-1)?.order ?? 0) + 1;
    todos.replace(scope.kind, scope.id, [{
      ...existing, id, order, text: text ?? note ?? '', createdAt, updatedAt,
      status: ['open', 'pending'].includes(value.status) ? existing?.status === 'doing' ? 'doing' : 'todo' : 'done',
      external: { ...existing?.external, followUp: { type, ...data } },
      by: existing?.by ?? value.author ?? { kind: 'agent', botId: value.botId },
      updatedBy: { kind: 'agent', botId: value.botId },
    }]);
  };
  if (!states.get('todo.followUpMigration', 'v1')) transaction(db, () => {
    if (states.get('todo.followUpMigration', 'v1')) return;
    for (const loop of brainTable(db).legacyLoops()) put('concern', loop, loop.updatedAt);
    for (const wake of wakeTable(db).legacyWakes()) put('wake', wake, wake.updatedAt ?? wake.closedAt ?? wake.firedAt ?? wake.createdAt ?? wake.at);
    states.save([['todo.followUpMigration', 'v1', now()]]);
  });

  const list = (type, botId, status) => read(type, botId).map(row => row.value).filter(value => !status || value.status === status);
  const find = (type, botId, id) => read(type, botId).find(row => row.value.id === id);
  const remove = (type, botId, matches = () => true) => transaction(db, () => {
    const rows = read(type, botId).filter(({ value }) => matches(value));
    for (const { item } of rows) todos.replace(item.scope.kind, item.scope.id, [], [item.id]);
    return rows.length;
  });
  return {
    loops: (botId, status) => list('concern', botId, status).sort((a, b) => a.updatedAt - b.updatedAt),
    loop: (botId, id) => find('concern', botId, id)?.value ?? null,
    putLoop(botId, id, status, updatedAt, data) {
      put('concern', { ...data, botId, id, status }, updatedAt, find('concern', botId, id)?.item);
    },
    clearLoops: botId => remove('concern', botId),
    get: id => find('wake', null, id)?.value ?? null,
    put(id, botId, status, at, data) {
      put('wake', { ...data, id, botId, status, at }, now(), find('wake', botId, id)?.item);
    },
    list: (botId, status) => list('wake', botId, status).sort((a, b) => a.at - b.at),
    due: until => list('wake', null, 'pending').filter(wake => wake.at <= until).sort((a, b) => a.at - b.at),
    countPending: botId => list('wake', botId, 'pending').length,
    prune: olderThan => remove('wake', null, wake => wake.status !== 'pending' && wake.at < olderThan),
    clear: botId => remove('wake', botId),
    transaction: fn => transaction(db, fn),
  };
}
