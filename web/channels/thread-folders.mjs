export const ROOT_FOLDER = 'root';
export const ARCHIVE_FOLDER = 'archive';

/** Place legacy and newly arrived threads directly under their channel. */
export function threadGroups(layout, rows, idOf = row => row.threadId) {
  const remaining = new Map(rows.map(row => [idOf(row), row]));
  const groups = new Map();
  for (const id of [ROOT_FOLDER, ...(layout?.folders ?? []).map(folder => folder.id), ARCHIVE_FOLDER]) {
    const group = [];
    for (const threadId of layout?.groups?.[id] ?? []) {
      if (remaining.has(threadId)) group.push(remaining.get(threadId));
      remaining.delete(threadId);
    }
    groups.set(id, group);
  }
  groups.get(ROOT_FOLDER).push(...remaining.values());
  return groups;
}
