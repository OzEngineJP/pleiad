// ファイルのページの「最近のファイル」（core/pages-routes.mjs の recentFiles。web/pages/README.md）に出す、
// 会話が読んだ・編集した・添付したファイル。会話の記録（ツールの呼び出しと添付の行）から拾うだけで、
// 読めるかどうかは pages-routes がファイルの検査（ADR 0050）で決める。ここに出ても読める権利にはならない。

// Claude Code のツールの名前。ほかのバックエンドは toolHints の shape（read・write・edit）で見分ける（web/render.mjs と同じ）
import { vizMark } from './isolated-origins.mjs';
import { FILE_KEYS } from '../web/file-keys.mjs';

const NAMED = { Read: 'read', Write: 'edited', Edit: 'edited', MultiEdit: 'edited', NotebookEdit: 'edited' };
const SHAPED = { read: 'read', write: 'edited', edit: 'edited' };

function targetOf(input) {
  if (!input || typeof input !== 'object') return null;
  return FILE_KEYS.map(key => input[key]).find(value => typeof value === 'string' && value)
    ?? (Array.isArray(input.files) ? input.files.find(value => typeof value === 'string' && value) : null) ?? null;
}

/**
 * 新しい順の [{ path, source, at, actor? }]。同じパスは新しい 1 つだけ残す（大小文字は pages-routes が実体で畳む）
 * @param {{ messages?: object[], presents?: object[], toolHints?: object, actor?: string }} transcript
 */
export function recentFilesOf({ messages = [], presents = [], toolHints = {}, actor } = {}, limit = 100) {
  const found = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      const source = NAMED[call?.name] ?? SHAPED[toolHints?.[call?.name]?.shape];
      const target = source && !call.result?.isError ? targetOf(call.input) : null;
      if (target) found.push({ path: target, source, at: call.at ?? message.at ?? null, ...(actor ? { actor } : {}) });
    }
  }
  for (const row of Array.isArray(presents) ? presents : []) {
    if (row?.by === 'human' && row.kind !== 'visualization' && typeof row.path === 'string' && row.path) found.push({ path: row.path, source: 'attached', at: row.at ?? null });
  }
  found.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  const seen = new Set(), out = [];
  for (const entry of found) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path); out.push(entry);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * 会話の可視化（束のあるもの）の、隔離の origin の URL。新しい順
 * hash・entry・元のパス（記録にあれば）も載せる: 新しいタブの一覧が「元の HTML」と「保存した版」を開き分けるため
 * @param {object[]} presents withLegacyBundles を通した記録の行
 * @param {number} isolatedPort
 */
export function visualizationLinksOf(presents, isolatedPort, limit = 20) {
  if (!Number.isInteger(isolatedPort) || isolatedPort <= 0) return [];
  const out = [];
  for (const row of [...(Array.isArray(presents) ? presents : [])].reverse()) {
    const bundle = row?.kind === 'visualization' && !row.error ? row.bundle : null;
    if (!bundle || !/^[0-9a-f]{64}$/.test(bundle.hash ?? '') || typeof bundle.entry !== 'string' || !bundle.entry) continue;
    const entry = bundle.entry.split('/').map(encodeURIComponent).join('/');
    const title = String(row.caption ?? row.path ?? bundle.entry).slice(0, 200);
    // アプリの専用の出どころ（v<束の印>.localhost。core/isolated-origins.mjs）
    out.push({ title, hash: bundle.hash, entry: bundle.entry,
      url: `http://${vizMark(bundle.hash)}.localhost:${isolatedPort}/viz/${bundle.hash}/${entry}?${new URLSearchParams({ embed: 'tab', title })}`,
      ...(typeof row.path === 'string' && row.path ? { path: row.path } : {}),
      ...(typeof row.at === 'string' && row.at ? { at: row.at } : {}) });
    if (out.length === limit) break;
  }
  return out;
}
