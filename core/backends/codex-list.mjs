// thread/list includes previews that can approach 1 MB per row. Keep each
// response below the holder's line limit, and retry the same cursor with fewer
// rows if it still overflows. Never wait indefinitely for a discarded response.
import { LINE_OVERFLOW, HISTORY_TIMEOUT_MS } from './codex-history.mjs';

// Remember an observed safe count per connection. The first request uses the
// caller's count; no assumed preview size or transport limit is baked in here.
const pageSizes = new WeakMap();

export async function listThreads(rpc, { limit = 100, ...params } = {}) {
  const rows = [];
  const seen = new Set();
  const cursors = new Set();
  let cursor = null;
  let size = Math.min(pageSizes.get(rpc) ?? limit, limit);
  while (rows.length < limit) {
    let result;
    try {
      result = await rpc.request('thread/list', { ...params, cursor, limit: Math.min(size, limit - rows.length) }, HISTORY_TIMEOUT_MS);
    } catch (error) {
      if (error?.code !== LINE_OVERFLOW || size <= 1) throw error;
      size = Math.max(1, Math.floor(size / 2));
      pageSizes.set(rpc, size);
      continue;
    }
    const before = rows.length;
    for (const row of result?.data ?? []) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      if (rows.length === limit) break;
    }
    cursor = result?.nextCursor ?? null;
    if (!cursor || cursors.has(cursor) || rows.length === before) break;
    cursors.add(cursor);
  }
  return rows;
}
