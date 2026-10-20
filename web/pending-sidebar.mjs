/** Preserve an in-flight local change when an older listSessions reply arrives. */
export function overlaySessions(sessions, patches, deleted = new Map()) {
  const rows = sessions.map(s => patches.has(s.id) ? { ...s, ...patches.get(s.id) } : s);
  for (const row of deleted.values()) if (!rows.some(s => s.id === row.id)) rows.push(row);
  return rows;
}

export function currentRows(rows, sessions) {
  const byId = new Map(sessions.map(s => [s.id, s]));
  return rows.map(row => byId.get(row.id) ?? row);
}

const normal = (key, value) => key === 'ungrouped' ? Boolean(value) : (value ?? '');

/**
 * 失敗した操作の表示を外す。戻す値は「画面が今この値か」を比べずに決める（値の一致では A→B→A の入れ替わりを見分けられない）:
 * 列に残っている移動（patchFor）→ 最後に受け取ったサーバーの値（server）→ 操作前の値、の順。
 * 戻した後は一覧を取り直し、サーバーの正本で確かめる。
 *
 * @param {Array} sessions 画面の行
 * @param {Array<{sessionId: string, status: string, ungrouped: boolean}>} before 操作前の値
 * @param {Map<string, object>} patches 失敗した操作が出した値
 * @param {Map<string, object>} server 最後に受け取ったサーバーの一覧の status / ungrouped
 * @param {(id: string) => object | undefined} patchFor 列に残っている移動の値
 */
export function revertFailed(sessions, before, patches, server = new Map(), patchFor = () => undefined) {
  const old = new Map(before.map(s => [s.sessionId, s]));
  return sessions.map(s => {
    const was = old.get(s.id), patch = patches.get(s.id);
    if (!was || !patch) return s;
    let next = s;
    for (const key of Object.keys(patch)) {
      if (!(key in was)) continue;
      const value = patchFor(s.id)?.[key] ?? server.get(s.id)?.[key] ?? was[key];
      if (normal(key, s[key]) === normal(key, value)) continue;
      next = next === s ? { ...s } : next;
      next[key] = value;
    }
    return next;
  });
}
