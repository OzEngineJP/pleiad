// 外部 MCP の行のスイッチ: オフにする前に使っていたエージェントの組（<dataDir>/context-mcp-was.json）。ADR 0337 §決定 4。
// 行のスイッチでオンに戻すとき、この組へ戻す。無ければ既定（Pleiad の登録はどのエージェントにも、エージェントの設定は持っているエージェントに）。
//
// 設定そのもの（context-scans.json の kinds.mcp.agents）には書かない。そこは strict の形で、知らない項目があると
// 旧い版が設定ごと読めなくなる。この記録は別のファイルに置き、旧い版は存在を知らないので無視する（読み飛ばして困ることが無い、戻し先の覚えだけ）。
// 無い・JSON が壊れている・形が違う（知らない版）ファイルだけを空として読む（壊れても設定は無事で、戻し先が既定になるだけ）。
// 壊れた物は、次に書くとき context-mcp-was.broken-<時刻>.json へ退避してから作り直す（context-agents.json と同じ。消さない）。
// それ以外の読み込みの失敗（EBUSY・EPERM など）は空にせず投げる（1 件だけのファイルで上書きして、ほかの覚えを全部消さない。呼ぶ側が握るので操作は成功する）。
//
// 形: { version: 1, places: { <場所のキー。全体は '*'>: { <名前>: [<エージェント>] } } }
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './atomic-file.mjs';
import { pathKey } from './context-settings.mjs';

export const MCP_WAS_FILE = 'context-mcp-was.json';
export const MCP_WAS_MAX_PLACES = 200;
export const MCP_WAS_MAX_NAMES = 500;
export const MCP_WAS_MAX_AGENTS = 24;
// 退避した読めないファイルを残す数（超えたら古い物から消す。今退避した物は必ず残る）
export const MCP_WAS_MAX_BROKEN = 5;
const MAX_AGENTS = MCP_WAS_MAX_AGENTS;
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
  /**
   * ファイルを読む。空とみなすのは「無い（ENOENT）」「JSON が壊れている」「形が違う（知らない版など）」だけ。
   * ほかの失敗（Windows のウイルス対策の EBUSY・EPERM など）は投げる。空として読んで次の set で 1 件だけのファイルに上書きし、ほかの覚えを全部消さないため
   */
  const load = async () => {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (e) {
      if (e?.code === 'ENOENT') return { state: 'missing', data: emptyMcpWas() };
      throw e;
    }
    let raw;
    try { raw = JSON.parse(text); } catch { return { state: 'broken', data: emptyMcpWas() }; }
    if (!isObj(raw) || raw.version !== 1 || !isObj(raw.places)) return { state: 'broken', data: emptyMcpWas() };
    return { state: 'ok', data: normalizeMcpWas(raw) };
  };
  const read = async () => (await load()).data;
  /** 読めないファイルを context-mcp-was.broken-<時刻>.json へ移す（消さない。context-agents.json と同じ）。古い退避は MCP_WAS_MAX_BROKEN 個まで */
  const moveAside = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let name = null;
    for (let i = 0; !name; i++) {
      const candidate = `context-mcp-was.broken-${stamp}${i ? `-${i}` : ''}.json`;
      if (await fs.stat(path.join(dataDir, candidate)).then(() => true, () => false)) continue;
      await fs.rename(file, path.join(dataDir, candidate));
      name = candidate;
    }
    const backups = [];
    for (const f of await fs.readdir(dataDir).catch(() => [])) {
      if (f === name || !/^context-mcp-was\.broken-.+\.json$/.test(f)) continue;
      const st = await fs.stat(path.join(dataDir, f)).catch(() => null);
      if (st?.isFile()) backups.push({ f, at: st.mtimeMs });
    }
    backups.sort((a, b) => b.at - a.at || b.f.localeCompare(a.f));
    for (const { f } of backups.slice(MCP_WAS_MAX_BROKEN - 1)) await fs.rm(path.join(dataDir, f), { force: true }).catch(() => {});
    return name;
  };
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const get = async (place) => structuredClone((await read()).places[mcpWasKey(place)] ?? {});
  const set = (place, name, list) => serial(async () => {
    const { state, data: cur } = await load();
    if (state === 'broken') await moveAside();
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
