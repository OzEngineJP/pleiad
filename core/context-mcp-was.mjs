// 外部 MCP の行のスイッチ: オフにする前に使っていたエージェントの組（<dataDir>/context-mcp-was.json）。ADR 0337 §決定 4。
// 行のスイッチでオンに戻すとき、この組へ戻す。無ければ既定（Pleiad の登録はどのエージェントにも、エージェントの設定は持っているエージェントに）。
//
// 設定そのもの（context-scans.json の kinds.mcp.agents）には書かない。そこは strict の形で、知らない項目があると
// 旧い版が設定ごと読めなくなる。この記録は別のファイルに置き、旧い版は存在を知らないので無視する（読み飛ばして困ることが無い、戻し先の覚えだけ）。
// 読めない・形が違うファイルは空として読む（壊れても設定は無事で、戻し先が既定になるだけ）。次に書くときに作り直す。
//
// 形: { version: 1, places: { <場所のキー。全体は '*'>: { <名前>: [<エージェント>] } } }
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './atomic-file.mjs';
import { pathKey } from './context-settings.mjs';

export const MCP_WAS_FILE = 'context-mcp-was.json';
export const MCP_WAS_MAX_PLACES = 200;
export const MCP_WAS_MAX_NAMES = 500;
const MAX_AGENTS = 24;
const GLOBAL = '*';

/** 場所（null・'' は全体）の記録のキー */
export const mcpWasKey = (place) => (place ? pathKey(place) : GLOBAL);

export const emptyMcpWas = () => ({ version: 1, places: {} });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 形が違う物は捨てる（読めた分だけ使う）。上限を超えたら先に入れた物から外す */
export function normalizeMcpWas(raw) {
  const out = emptyMcpWas();
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.places)) return out;
  for (const [place, names] of Object.entries(raw.places)) {
    if (!isObj(names) || !place || place.length > 4096) continue;
    const kept = {};
    for (const [name, list] of Object.entries(names)) {
      if (!name || name.length > 128 || !Array.isArray(list)) continue;
      const agents = [...new Set(list.filter((a) => typeof a === 'string' && a && a.length <= 40))].sort().slice(0, MAX_AGENTS);
      if (agents.length) kept[name] = agents;
    }
    const keys = Object.keys(kept);
    for (const k of keys.slice(0, Math.max(0, keys.length - MCP_WAS_MAX_NAMES))) delete kept[k];
    if (Object.keys(kept).length) out.places[place] = kept;
  }
  const places = Object.keys(out.places);
  for (const p of places.slice(0, Math.max(0, places.length - MCP_WAS_MAX_PLACES))) delete out.places[p];
  return out;
}

/**
 * <dataDir>/context-mcp-was.json の読み書き（直列・原子的）。
 *   get(place)              { <名前>: [エージェント] }（無ければ {}）
 *   set(place, name, list)  list が空・null なら、その名前の記録を消す
 */
export function createMcpWas(dataDir) {
  const file = path.join(dataDir, MCP_WAS_FILE);
  let queue = Promise.resolve();
  const read = async () => {
    try { return normalizeMcpWas(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch { return emptyMcpWas(); }
  };
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const get = async (place) => structuredClone((await read()).places[mcpWasKey(place)] ?? {});
  const set = (place, name, list) => serial(async () => {
    const cur = await read();
    const key = mcpWasKey(place);
    const at = { ...(cur.places[key] ?? {}) };
    delete at[name];
    if (list?.length) at[name] = list;
    const places = { ...cur.places };
    delete places[key];
    if (Object.keys(at).length) places[key] = at;
    const next = normalizeMcpWas({ version: 1, places });
    await fs.mkdir(dataDir, { recursive: true });
    await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
  return { file, read, get, set };
}
