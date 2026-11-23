// コンテキストの設定（設定 › プラグイン）。エージェント側の設定ファイルは変えない。
//
// 形式 4（context-scans.json、version: 4。ADR 0348）は、既定（全体の設定）を丸ごと、場所（フォルダー）を**差分だけ**で持つ:
//   { version: 4,
//     defaults: { roots: { instruction: [..], skill: [..], mcp: [..], hooks: [..] }, kinds: { instruction: K, skill: K, mcp: K } },
//     places: { <pathKey>: { path, roots?: { <kind>?: [この場所で足した場所] }, rootsOff?: { <kind>?: [上から受け継ぐのに使わない場所] },
//                            kinds?: { <kind>?: D } } } }
//   D は K の差分。owner・user・directory・disabled は項目ごと、prefer は名前ごと（null は「選ばない」）、
//   agents（外部 MCP の名前 × エージェント）は名前（行）ごと。行は off と spread のどちらかに名前があれば「この場所で変えた行」で、
//   その行の値は off[名前] ?? [] と spread[名前] ?? []（空の並びも持つ）。agents: null は名前ごとのモデルをやめる。
// 効く値は、既定に、作業場所の祖先の場所の差分を浅い順に重ねたもの。受け継ぐ値と同じ差分は持たない（pruneInherited）ので、
// 全体を変えると、その行を変えていない場所にも届く。追加ルートは祖先の場所で足したものを合わせ、rootsOff の分を除く。
// hooks の追加ルートは Hooks の読み込み（core/hooks-agents.mjs）が読む。
//
// 形式 3（version: 3）は「種類ごとの設定」を既定と場所ごとの上書き（丸ごとの写し）で持っていた:
//   { version: 3,
//     defaults: { roots: { instruction: [..], skill: [..], mcp: [..] }, kinds: { instruction: K, skill: K, mcp: K } },
//     places: { <pathKey>: { path, roots?: { <kind>?: [..] }, kinds: { <kind>?: K } } } }
//   K = { owner: native|ply, user: S|null, directory: S|null, disabled?: [名前], prefer?: { 名前: 設定ファイル（Skills は SKILL.md） } }
//   S = { sources: [common|claude|codex], excludePaths: [..] }
// user は home（ユーザー共通）の探索、directory は Git ルート〜作業場所の探索。null はその範囲を探さない
// （形式 1 の「対象（kinds）」から外していた種類。移行で意味を保つためだけに残る）。
// 種類ごとに、作業場所に一番近い上書きを持つ場所が勝ち、無ければ既定。追加ルート（探す場所を足す）も種類ごとに同じ
// （defaults.roots[kind] はどの場所でも探すユーザーの範囲のルート、places[].roots[kind] はその場所から下で探すルート）。
// 足した場所は、その種類の、その範囲の探す形式（sources）で探す（core/context-scan.mjs）。
// disabled は外部 MCP だけで、名前で外すもの。prefer は外部 MCP と Skills で、同じ名前の定義が複数あるときに使う方。
//
// 形式 2（version: 2）は追加ルートを種類によらない 1 つの並び（roots: [..]）で持ち、足した場所をすべての種類で探していた。
// 形式 1（version: 1）は読み込み担当（owners / directoryOwners）と探索設定（user / directories）を別々に継承していた。
// どれも読み込んだときにバックアップを取り、コピーの上で形式 3 を経て形式 4 へ移し、同じ結果になることを確かめてから置き換える
// （docs/desktop-releases.md の「データ形式変更」）。形式 2 の追加ルートは 3 種すべてへ写す（今までどおりすべての種類で探す）。
// 確かめられなければ元のファイルはそのまま残して止まる。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import { realpath as realpathCallback } from 'node:fs';
// 表示用の実体パス。Windows では大文字小文字を実際の表記に戻す（キーは小文字に寄せて持つ）
const realpathNative = promisify(realpathCallback.native);
import { z } from 'zod';
import { t } from './i18n.mjs';

export const KINDS = ['instruction', 'skill', 'mcp'];
/** 追加ルート（スキャン場所）を持つ種類。Hooks は種類の設定（K）を持たず、追加ルートだけ */
export const ROOT_KINDS = [...KINDS, 'hooks'];
export const VERSION = 4;
// backend-allow: 読み込み元（ファイルの形式。core/context-settings.mjs の SOURCES）の名前で、エージェントの分岐ではない
export const SOURCES = ['common', 'claude', 'codex', 'opencode', 'devin', 'antigravity', 'grok'];
// 対応を終えたエージェントの探索元。前の版で保存した設定を読めるように受け付け、読んだところで落とす
const RETIRED_SOURCES = ['procway'];
const storedSource = z.enum([...SOURCES, ...RETIRED_SOURCES]);
const liveSources = sources => unique(sources.filter(s => SOURCES.includes(s)));
export const DEFAULT_SOURCES = ['common', 'claude', 'codex'];
/** 形式 1 の探索設定の既定。移行と、形式 1 のまま記録された会話の方針（contextSession.policy）を読むのに使う */
export const DEFAULT_SCAN = { sources: [...DEFAULT_SOURCES], kinds: [...KINDS], additionalRoots: [], excludePaths: [] };
export const DEFAULT_OWNERS = { instruction: 'native', skill: 'native', mcp: 'native' };
export const defaultKind = () => ({ owner: 'native', user: { sources: [...DEFAULT_SOURCES], excludePaths: [] }, directory: { sources: [...DEFAULT_SOURCES], excludePaths: [] } });

const paths = z.array(z.string().trim().min(1).max(4096)).max(64);
// 探索元の数の上限は一覧の長さ（探索元を足しても、全部を選んだ設定が検証で落ちない）
const MAX_SOURCES = SOURCES.length + RETIRED_SOURCES.length;
const scopeSchema = z.object({ sources: z.array(storedSource).max(MAX_SOURCES), excludePaths: paths }).strict();
const NAME = z.string().min(1).max(128);
const AGENT_ID = z.string().regex(/^[a-z0-9_-]{1,32}$/);
// 外部 MCP の「名前 × エージェント」の設定（ADR 0327）。off: そのエージェントでは使わない、
// spread: 他のエージェントの設定の定義を、そのエージェントへも広げた。持っていれば「名前ごとのモデル」で、
// 担当（owner）の 2 択ではなくなる（無ければ従来どおり担当で決める）
const agentsSchema = z.object({
  off: z.record(NAME, z.array(AGENT_ID).max(16)).optional(),
  spread: z.record(NAME, z.array(AGENT_ID).max(16)).optional(),
}).strict();
const kindSchema = z.object({
  owner: z.enum(['native', 'ply']),
  user: scopeSchema.nullable(),
  directory: scopeSchema.nullable(),
  disabled: z.array(NAME).max(500).optional(),
  prefer: z.record(NAME, z.string().min(1).max(4096)).optional(),
  agents: agentsSchema.optional(),
}).strict();
// 場所の差分（形式 4）。どの項目も省ける
const diffSchema = z.object({
  owner: z.enum(['native', 'ply']).optional(),
  user: scopeSchema.nullable().optional(),
  directory: scopeSchema.nullable().optional(),
  disabled: z.array(NAME).max(500).optional(),
  prefer: z.record(NAME, z.string().min(1).max(4096).nullable()).optional(),
  agents: agentsSchema.nullable().optional(),
}).strict();
const legacySpec = z.object({
  sources: z.array(storedSource).max(MAX_SOURCES),
  kinds: z.array(z.enum(KINDS)).max(3),
  additionalRoots: paths,
  excludePaths: paths,
}).strict();
const ownersSchema = z.object({ instruction: z.enum(['native', 'ply']), skill: z.enum(['native', 'ply']), mcp: z.enum(['native', 'ply']) }).strict();

export const pathKey = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
export const containsPath = (root, file) => { const rel = path.relative(pathKey(root), pathKey(file)); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
/**
 * Claude の rules の `paths` に書く glob を正規表現にする。`**`・`*`・`?`・`{a,b}` だけを扱う（依存を増やさないための最小限）。
 * 区切りは / に寄せ、win32 では大文字小文字を区別しない（pathKey と同じ）。閉じない { は RegExp の構文エラーとして投げる
 */
export function globRegExp(glob) {
  const p = String(glob).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '', depth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*' && (i === 0 || p[i - 1] === '/') && (i + 2 === p.length || p[i + 2] === '/')) {
      // 階層をまたぐ **。`a/**/b` の間は 0 階層でもよく、末尾の `a/**` は a 自身にも当たる
      if (p[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
      else if (out.endsWith('/')) { out = `${out.slice(0, -1)}(?:/.*)?`; i++; }
      else { out += '.*'; i++; }
    } else if (c === '*') { out += '[^/]*'; while (p[i + 1] === '*') i++; }
    else if (c === '?') out += '[^/]';
    else if (c === '{') { depth++; out += '(?:'; }
    else if (c === '}' && depth) { depth--; out += ')'; }
    else if (c === ',' && depth) out += '|';
    else out += c.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}
/** file が base からの相対で globs のどれかに当たるか。base の外は当たらない */
export function matchesGlobs(globs, base, file) {
  if (!containsPath(base, file)) return false;
  const rel = path.relative(path.resolve(base), path.resolve(file)).split(path.sep).join('/');
  return (globs ?? []).some(g => { try { return globRegExp(g).test(rel); } catch { return false; } });
}
export function resolveScanPath(p, base, home = os.homedir()) {
  return path.resolve(base, p === '~' ? home : /^~[/\\]/.test(p) ? path.join(home, p.slice(2)) : p);
}
export async function scanDirectory(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error(t('context.settings.cwdRequired'));
  const dir = await fs.realpath(resolveScanPath(p.trim(), process.cwd()));
  if (!(await fs.stat(dir)).isDirectory()) throw new Error(t('context.settings.dirRequired'));
  return dir;
}
const unique = list => [...new Set(list)];
const resolveAll = (list, base, home) => unique(list.map(p => resolveScanPath(p, base, home)));

/** 形式 1 の探索設定 1 つ（検査して、相対パスを保存元の場所から解決する） */
export function normalizeScan(value, base, home = os.homedir()) {
  const parsed = legacySpec.safeParse(value);
  if (!parsed.success) throw new Error(t('context.settings.scanInvalid'));
  const v = parsed.data;
  return { sources: liveSources(v.sources), kinds: unique(v.kinds), additionalRoots: resolveAll(v.additionalRoots, base, home), excludePaths: resolveAll(v.excludePaths, base, home) };
}

/** 種類 1 つの設定を検査する。相対パスは保存先の場所（既定なら home）から解決する */
export function normalizeKind(kind, value, base, home = os.homedir()) {
  if (!KINDS.includes(kind)) throw new Error(t('context.settings.unknownKind'));
  const parsed = kindSchema.safeParse(value);
  if (!parsed.success) throw new Error(t('context.settings.kindInvalid'));
  const v = parsed.data;
  if (kind !== 'mcp' && v.disabled) throw new Error(t('context.settings.disabledMcpOnly'));
  if (kind === 'instruction' && v.prefer) throw new Error(t('context.settings.kindInvalid'));
  if (kind !== 'mcp' && v.agents) throw new Error(t('context.settings.disabledMcpOnly'));
  const scope = s => s && { sources: liveSources(s.sources), excludePaths: resolveAll(s.excludePaths, base, home) };
  const out = { owner: v.owner, user: scope(v.user), directory: scope(v.directory) };
  if (v.disabled?.length) out.disabled = unique(v.disabled).sort();
  if (v.prefer && Object.keys(v.prefer).length) out.prefer = Object.fromEntries(Object.entries(v.prefer).map(([n, p]) => [n, resolveScanPath(p, base, home)]));
  if (v.agents) out.agents = normalizeAgents(v.agents);
  return out;
}
/** 名前 × エージェントの設定を並べ直す（空の名前は消す。名前もエージェントも昇順） */
export function normalizeAgents(value) {
  const part = map => Object.fromEntries(Object.entries(map ?? {}).map(([n, ids]) => [n, unique(ids).sort()]).filter(([, ids]) => ids.length).sort(([a], [b]) => a < b ? -1 : 1));
  return { off: part(value.off), spread: part(value.spread) };
}
/**
 * 担当の 2 択（agents が無い設定）を、名前 × エージェントの明示の設定にする。今の接続が変わらないように写す（ADR 0327）。
 *   「Pleiad がそろえる」（owner: ply）: 探す対象だったエージェント（spreadFrom）の設定にある名前を、他のエージェントへ広げた形（spread）。
 *     探す対象でなかったエージェントの名前は、そのエージェントの列だけ on。Pleiad の登録はすべて on。
 *     Claude のプラグイン・claude.ai のコネクター（extras）は、そろえている間 Claude に出ていなかった（strict）ので off
 *   「エージェントに任せる」（owner: native）: Pleiad の登録はどのエージェントでも off のまま（任せる側は登録を渡していなかった）
 *   名前で外してあったもの（kind.disabled）は、全エージェントで off（広げない）
 *   エージェント自身の設定で無効にしてあるもの（disabled）は、広げる元にしない
 * info: { registered: [名前], native: { <agent>: [名前] }, disabled?: { <agent>: [名前] }, spreadFrom?: [agent]（既定は全部）, extras?: { <agent>: [名前] } }
 */
export function mcpAgentsFromLegacy(kind, info) {
  const ids = Object.keys(info.native ?? {});
  const dis = a => new Set(info.disabled?.[a] ?? []);
  const off = {}, spread = {};
  if (kind.owner === 'ply') {
    const all = unique((info.spreadFrom ?? ids).flatMap(a => (info.native[a] ?? []).filter(n => !dis(a).has(n))));
    for (const name of all) {
      // 自身の設定で無効の定義は「持っていない」扱い（画面・実行時と同じ規則）なので、そのエージェントへも広げる
      const to = ids.filter(a => !(info.native[a].includes(name) && !dis(a).has(name)));
      if (to.length) spread[name] = to;
    }
    for (const [a, keys] of Object.entries(info.extras ?? {})) for (const key of keys) off[key] = unique([...(off[key] ?? []), a]);
  } else for (const name of info.registered ?? []) {
    // 登録を渡さない。ただし同じ名前をそのエージェント自身が持つなら、それは今までどおり使う（off にすると自分の分まで止まる）
    const to = ids.filter(a => !(info.native[a].includes(name) && !dis(a).has(name)));
    if (to.length) off[name] = to;
  }
  for (const name of kind.disabled ?? []) { delete spread[name]; off[name] = [...ids]; }
  return normalizeAgents({ off, spread });
}
/**
 * 名前 name をエージェント agent で使うかを切り替える。
 *   Pleiad の登録・そのエージェント自身の設定にある名前: off に出し入れする
 *   他のエージェントの設定にしかない名前: そのエージェントへ広げる（spread）／広げるのをやめる
 */
export function toggleMcpAgent(agents, { name, agent, on }, info) {
  const off = structuredClone(agents.off ?? {}), spread = structuredClone(agents.spread ?? {});
  const set = (map, add) => {
    const list = new Set(map[name] ?? []);
    if (add) list.add(agent); else list.delete(agent);
    if (list.size) map[name] = [...list]; else delete map[name];
  };
  const own = (info.native?.[agent] ?? []).includes(name) && !(info.disabled?.[agent] ?? []).includes(name), registered = (info.registered ?? []).includes(name);
  if (registered || own) set(off, !on);
  if (!own && !registered) set(spread, on);
  else if (!on) set(spread, false);
  return normalizeAgents({ off, spread });
}
function normalizeRoots(value, base, home) {
  const parsed = paths.safeParse(value);
  if (!parsed.success) throw new Error(t('context.settings.rootsInvalid'));
  return resolveAll(parsed.data, base, home);
}
/** 種類ごとの追加ルート（形式 3）。形式 2 の並び 1 つは 3 種すべてに同じものを写す */
export const perKindRoots = roots => Array.isArray(roots) ? Object.fromEntries(KINDS.map(k => [k, [...roots]]))
  : Object.fromEntries(ROOT_KINDS.filter(k => Array.isArray(roots?.[k])).map(k => [k, [...roots[k]]]));
const emptyRoots = (kinds = ROOT_KINDS) => Object.fromEntries(kinds.map(k => [k, []]));
function normalizeKindRoots(value, base, home, { all = false, kinds = ROOT_KINDS } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !kinds.includes(k))) throw new Error(t('context.settings.rootsInvalid'));
  const out = all ? emptyRoots(kinds) : {};
  for (const k of kinds) if (value[k] !== undefined) out[k] = normalizeRoots(value[k], base, home);
  return out;
}

// ------------------------------------------------------------------ 場所の差分（形式 4）

const sortKeys = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a < b ? -1 : 1));
/** 名前 × エージェントの設定にある行（名前） */
const rowNames = agents => unique([...Object.keys(agents?.off ?? {}), ...Object.keys(agents?.spread ?? {})]).sort();
const rowOf = (agents, name) => ({ off: agents?.off?.[name] ?? [], spread: agents?.spread?.[name] ?? [] });
/** 差分の行。どの行も off と spread の両方に（空でも）並びを持つ */
const rowDiff = agents => {
  const names = rowNames(agents);
  return { off: Object.fromEntries(names.map(n => [n, unique(agents.off?.[n] ?? []).sort()])), spread: Object.fromEntries(names.map(n => [n, unique(agents.spread?.[n] ?? []).sort()])) };
};
const canonKind = k => {
  if (k.disabled && !k.disabled.length) delete k.disabled;
  if (k.prefer && !Object.keys(k.prefer).length) delete k.prefer;
  return k;
};
/** 種類の設定 base に場所の差分 diff を重ねる。元の値は変えない */
export function applyKindDiff(base, diff) {
  const out = structuredClone(base);
  if (!diff) return out;
  for (const f of ['owner', 'user', 'directory', 'disabled']) if (Object.hasOwn(diff, f)) out[f] = structuredClone(diff[f]);
  if (diff.prefer) {
    const prefer = { ...(out.prefer ?? {}) };
    for (const [n, p] of Object.entries(diff.prefer)) { if (p === null) delete prefer[n]; else prefer[n] = p; }
    out.prefer = prefer;
  }
  if (diff.agents === null) delete out.agents;
  else if (diff.agents) {
    const off = { ...(out.agents?.off ?? {}) }, spread = { ...(out.agents?.spread ?? {}) };
    for (const n of rowNames(diff.agents)) { off[n] = diff.agents.off?.[n] ?? []; spread[n] = diff.agents.spread?.[n] ?? []; }
    out.agents = normalizeAgents({ off, spread });
  }
  return canonKind(out);
}
/** 効かせたい値 full を、受け継ぐ値 inherited からの差分にする。違いが無ければ null */
export function diffKind(full, inherited) {
  const a = canonKind(structuredClone(full)), b = inherited, d = {};
  for (const f of ['owner', 'user', 'directory']) if (!isDeepStrictEqual(a[f], b[f])) d[f] = structuredClone(a[f]);
  if (!isDeepStrictEqual(a.disabled ?? [], b.disabled ?? [])) d.disabled = [...(a.disabled ?? [])];
  const prefer = {};
  for (const n of unique([...Object.keys(a.prefer ?? {}), ...Object.keys(b.prefer ?? {})]).sort()) {
    if ((a.prefer?.[n] ?? null) !== (b.prefer?.[n] ?? null)) prefer[n] = a.prefer?.[n] ?? null;
  }
  if (Object.keys(prefer).length) d.prefer = prefer;
  if (!a.agents && b.agents) d.agents = null;
  else if (a.agents) {
    const off = {}, spread = {};
    const names = b.agents ? unique([...rowNames(a.agents), ...rowNames(b.agents)]).sort() : rowNames(a.agents);
    for (const n of names) {
      const x = rowOf(a.agents, n);
      if (!b.agents || !isDeepStrictEqual(x, rowOf(b.agents, n))) { off[n] = [...x.off]; spread[n] = [...x.spread]; }
    }
    // 受け継ぐ値が担当の 2 択なら、行が無くても「名前ごとのモデルにした」ことが違い
    if (!b.agents || Object.keys(off).length) d.agents = { off: sortKeys(off), spread: sortKeys(spread) };
  }
  return Object.keys(d).length ? d : null;
}
/** 差分を検査する。相対パスは保存先の場所から解決する */
export function normalizeDiff(kind, value, base, home = os.homedir()) {
  if (!KINDS.includes(kind)) throw new Error(t('context.settings.unknownKind'));
  const parsed = diffSchema.safeParse(value);
  if (!parsed.success) throw new Error(t('context.settings.kindInvalid'));
  const v = parsed.data;
  if (kind !== 'mcp' && (v.disabled || v.agents !== undefined)) throw new Error(t('context.settings.disabledMcpOnly'));
  if (kind === 'instruction' && v.prefer) throw new Error(t('context.settings.kindInvalid'));
  const scope = s => s && { sources: liveSources(s.sources), excludePaths: resolveAll(s.excludePaths, base, home) };
  const out = {};
  if (v.owner !== undefined) out.owner = v.owner;
  if (v.user !== undefined) out.user = scope(v.user);
  if (v.directory !== undefined) out.directory = scope(v.directory);
  if (v.disabled) out.disabled = unique(v.disabled).sort();
  if (v.prefer && Object.keys(v.prefer).length) out.prefer = sortKeys(Object.fromEntries(Object.entries(v.prefer).map(([n, p]) => [n, p === null ? null : resolveScanPath(p, base, home)])));
  if (v.agents === null) out.agents = null;
  else if (v.agents) out.agents = rowDiff(v.agents);
  return out;
}
/** 差分で変えた項目の数（画面の「変更 n」）。行（名前）は使う方（prefer）と合わせて 1 つ */
export function countDiff(diff) {
  if (!diff) return 0;
  const fields = ['owner', 'user', 'directory', 'disabled'].filter(f => Object.hasOwn(diff, f)).length + (diff.agents === null ? 1 : 0);
  return fields + unique([...rowNames(diff.agents), ...Object.keys(diff.prefer ?? {})]).length;
}

// ------------------------------------------------------------------ 探索の計画（context-scan が読む形）
//
// plan = { user: { roots: { <kind>: [..] }, kinds: { <kind>: S|null } }, directory: { roots, kinds }, mcp: { disabled, prefer }, skill: { prefer } }
// roots は ROOT_KINDS（hooks を含む）。hooks は Hooks の読み込みが読む（context-scan は KINDS だけを読む）。
// 形式 2 の設定で記録された会話の計画は roots が並び 1 つ（すべての種類で探す）。読むときに種類ごとへ直す（normalizePlan）

/** 形式 1 の探索設定（user / directory の 2 つ）を計画にする。形式 1 のまま記録された会話と、移行の検証に使う */
export function legacyPlan(user, directory) {
  const scope = spec => ({ roots: perKindRoots(spec.additionalRoots ?? []),
    kinds: Object.fromEntries(KINDS.map(k => [k, spec.kinds.includes(k) ? { sources: [...spec.sources], excludePaths: [...spec.excludePaths] } : null])) });
  return { user: scope(user), directory: scope(directory), mcp: { disabled: [], prefer: {} }, skill: { prefer: {} } };
}
/** 計画の追加ルートを種類ごとの形にそろえる（形式 2 のまま記録された計画も読む）。元の値は変えない */
export function normalizePlan(plan) {
  const out = { ...plan };
  for (const scope of ['user', 'directory']) {
    if (!plan[scope]) continue;
    out[scope] = { ...plan[scope], roots: { ...emptyRoots(), ...perKindRoots(plan[scope].roots ?? []) } };
  }
  return out;
}
/** scanContext に渡された設定から計画を取り出す。形式 1 の { user, directory } も受け付ける */
export const scanPlan = settings => normalizePlan(settings.plan ?? legacyPlan(settings.user, settings.directory));

/** 一番近い（深い）上書きを持つ場所 */
function nearest(places, key, has) {
  return Object.keys(places).filter(p => has(places[p]) && containsPath(p, key)).sort((a, b) => b.length - a.length)[0] ?? null;
}
/** 作業場所 key の祖先（自身を含む）の保存済みの場所。浅い順 */
export const chainOf = (places, key) => key ? Object.keys(places).filter(p => containsPath(p, key)).sort((a, b) => a.length - b.length) : [];
const samePath = (a, b) => pathKey(a) === pathKey(b);
/**
 * 場所（pathKey。null なら既定だけ）で効く設定を解く（形式 4）。without の場所は無いものとして解く（受け継ぐ値を出すのに使う）。
 * 戻り: { owners, plan, kinds: { <kind>: { value, from, rows } }, roots: { <kind>: { value, from, added } } }
 *   kinds[].from は差分を持つ一番深い場所（無ければ null）、rows は行（名前）ごとに、その行を変えた一番深い場所
 *   roots[].value は作業場所の範囲の追加ルート（祖先の場所で足したもの）、added は [{ path, place }]（どの場所で足したか）
 */
export function resolveConfig(config, key, { without = null } = {}) {
  const chain = chainOf(config.places, key).filter(p => p !== without);
  const kinds = {};
  for (const k of KINDS) {
    let value = structuredClone(config.defaults.kinds[k]), from = null;
    const rows = {};
    for (const p of chain) {
      const d = config.places[p].kinds?.[k];
      if (!d) continue;
      value = applyKindDiff(value, d);
      from = p;
      for (const n of [...rowNames(d.agents), ...Object.keys(d.prefer ?? {})]) rows[n] = p;
    }
    kinds[k] = { value, from, rows };
  }
  const roots = {};
  for (const k of ROOT_KINDS) {
    let added = [], from = null;
    for (const p of chain) {
      const off = config.places[p].rootsOff?.[k], add = config.places[p].roots?.[k];
      if (!off && !add) continue;
      from = p;
      if (off) added = added.filter(r => !off.some(o => samePath(o, r.path)));
      for (const r of add ?? []) if (!added.some(x => samePath(x.path, r))) added.push({ path: r, place: p });
    }
    roots[k] = { value: added.map(r => r.path), from, added };
  }
  const plan = {
    user: { roots: Object.fromEntries(ROOT_KINDS.map(k => [k, [...(config.defaults.roots[k] ?? [])]])), kinds: Object.fromEntries(KINDS.map(k => [k, kinds[k].value.user])) },
    directory: { roots: Object.fromEntries(ROOT_KINDS.map(k => [k, [...roots[k].value]])), kinds: Object.fromEntries(KINDS.map(k => [k, kinds[k].value.directory])) },
    mcp: { disabled: kinds.mcp.value.agents ? [] : kinds.mcp.value.disabled ?? [], prefer: kinds.mcp.value.prefer ?? {}, ...(kinds.mcp.value.agents ? { agents: structuredClone(kinds.mcp.value.agents) } : {}) },
    skill: { prefer: kinds.skill.value.prefer ?? {} },
  };
  const owners = Object.fromEntries(KINDS.map(k => [k, kinds[k].value.owner]));
  // 名前ごとのモデル（agents あり）では Pleiad の中継を常に開く。止める・広げるは名前ごとで、担当の 2 択は無い
  if (kinds.mcp.value.agents) owners.mcp = 'ply';
  return { owners, plan, kinds, roots };
}
/** 形式 2・3 の設定を解く（移行の検証だけに使う）。種類ごとに一番近い上書きの丸ごとが勝ち、追加ルートも一番近いものが勝つ */
export function resolveV3(config, key) {
  const kinds = {};
  for (const k of KINDS) {
    const from = key ? nearest(config.places, key, p => p.kinds?.[k]) : null;
    kinds[k] = { value: structuredClone(from ? config.places[from].kinds[k] : config.defaults.kinds[k]), from };
  }
  const roots = {};
  for (const k of KINDS) {
    const from = key ? nearest(config.places, key, p => Array.isArray(perKindRoots(p.roots)[k])) : null;
    roots[k] = { value: from ? perKindRoots(config.places[from].roots)[k] : [], from };
  }
  const defaultRoots = perKindRoots(config.defaults.roots);
  const plan = {
    user: { roots: Object.fromEntries(KINDS.map(k => [k, [...(defaultRoots[k] ?? [])]])), kinds: Object.fromEntries(KINDS.map(k => [k, kinds[k].value.user])) },
    directory: { roots: Object.fromEntries(KINDS.map(k => [k, [...roots[k].value]])), kinds: Object.fromEntries(KINDS.map(k => [k, kinds[k].value.directory])) },
    mcp: { disabled: kinds.mcp.value.agents ? [] : kinds.mcp.value.disabled ?? [], prefer: kinds.mcp.value.prefer ?? {}, ...(kinds.mcp.value.agents ? { agents: structuredClone(kinds.mcp.value.agents) } : {}) },
    skill: { prefer: kinds.skill.value.prefer ?? {} },
  };
  const owners = Object.fromEntries(KINDS.map(k => [k, kinds[k].value.owner]));
  if (kinds.mcp.value.agents) owners.mcp = 'ply';
  return { owners, plan, kinds, roots };
}
/**
 * 場所 key（null なら既定）の種類 kind を、効かせたい値 value（検査済みの K）にする。場所では受け継ぐ値からの差分だけを持つ。
 * 保存の set と、保存する前に結果を比べる側（core/server.mjs）が使う。config を書き換える
 */
export function setKindValue(config, key, kind, value, display = key) {
  if (!key) { config.defaults.kinds[kind] = canonKind(structuredClone(value)); return; }
  const place = config.places[key] ??= { path: display };
  const d = diffKind(value, resolveConfig(config, key, { without: key }).kinds[kind].value);
  place.kinds ??= {};
  if (d) place.kinds[kind] = d; else delete place.kinds[kind];
  if (!Object.keys(place.kinds).length) delete place.kinds;
}

// ------------------------------------------------------------------ 形式 1・2・3 → 4

/** 形式 1（読み込み・検査済み）を形式 3 にする。純粋な計算で、ファイルには触れない */
export function migrateV1(old, display = p => p) {
  const legacyKind = (owner, user, directory, k) => ({ owner,
    user: user.kinds.includes(k) ? { sources: [...user.sources], excludePaths: [...user.excludePaths] } : null,
    directory: directory.kinds.includes(k) ? { sources: [...directory.sources], excludePaths: [...directory.excludePaths] } : null });
  const config = { version: 3, defaults: { roots: perKindRoots(old.user.additionalRoots),
    kinds: Object.fromEntries(KINDS.map(k => [k, legacyKind(old.owners[k], old.user, DEFAULT_SCAN, k)])) }, places: {} };
  // 形式 1 では担当と探索設定が別々の場所から継承される。どちらかを上書きしていた場所はすべて、
  // その場所で効いていた担当と探索設定を持つ場所にする（その下の場所も、一番近い上書きが同じものを指す）
  const keys = unique([...Object.keys(old.directoryOwners), ...Object.keys(old.directories)]).sort((a, b) => a.length - b.length);
  for (const key of keys) {
    const ownerFrom = nearest(old.directoryOwners, key, () => true), specFrom = nearest(old.directories, key, () => true);
    const owners = ownerFrom ? old.directoryOwners[ownerFrom] : old.owners, spec = specFrom ? old.directories[specFrom] : DEFAULT_SCAN;
    config.places[key] = { path: display(key), roots: perKindRoots(spec.additionalRoots), kinds: Object.fromEntries(KINDS.map(k => [k, legacyKind(owners[k], old.user, spec, k)])) };
  }
  // 上の場所（または既定）から受け継ぐ値と同じ上書きは消す（形式 3 の考え方。このあと形式 4 で差分にする）
  for (const key of keys) {
    const place = config.places[key];
    delete config.places[key];
    const inherited = resolveV3(config, key);
    config.places[key] = place;
    for (const k of KINDS) if (isDeepStrictEqual(place.kinds[k], inherited.kinds[k].value)) delete place.kinds[k];
    for (const k of KINDS) if (isDeepStrictEqual(place.roots[k], inherited.roots[k].value)) delete place.roots[k];
    if (!Object.keys(place.roots).length) delete place.roots;
    if (!Object.keys(place.kinds).length && !place.roots) delete config.places[key];
  }
  return config;
}
/** 形式 2（読み込み・検査済み）を形式 3 にする。追加ルートの並びは 3 種すべてへ写す（形式 2 はすべての種類で探していた） */
export function migrateV2(old) {
  const config = { version: 3, defaults: { roots: perKindRoots(old.defaults.roots ?? []), kinds: structuredClone(old.defaults.kinds) }, places: {} };
  for (const [key, place] of Object.entries(old.places)) {
    config.places[key] = { path: place.path, kinds: structuredClone(place.kinds ?? {}) };
    if (Array.isArray(place.roots)) config.places[key].roots = perKindRoots(place.roots);
  }
  return config;
}
/**
 * 形式 3（読み込み・検査済み）を形式 4 にする。浅い場所から順に、形式 3 でその場所に効いていた値を、
 * 形式 4 で受け継ぐ値からの差分にする（同じなら持たない）。追加ルートは、受け継ぐ並びに無いものを足し、使わないものを rootsOff に書く。
 * 一覧に足しただけの場所（上書きの無い場所）も残す
 */
export function migrateV3(old) {
  const config = { version: VERSION, defaults: { roots: { ...emptyRoots(), ...structuredClone(perKindRoots(old.defaults.roots)) },
    kinds: structuredClone(old.defaults.kinds) }, places: {} };
  for (const key of Object.keys(old.places).sort((a, b) => a.length - b.length)) {
    const before = resolveV3(old, key);
    const place = config.places[key] = { path: old.places[key].path };
    const inherited = resolveConfig(config, key, { without: key });
    const kinds = {};
    for (const k of KINDS) { const d = diffKind(before.kinds[k].value, inherited.kinds[k].value); if (d) kinds[k] = d; }
    if (Object.keys(kinds).length) place.kinds = kinds;
    const roots = {}, rootsOff = {};
    for (const k of KINDS) {
      const want = before.plan.directory.roots[k], have = inherited.roots[k].value;
      const add = want.filter(r => !have.some(h => samePath(h, r))), off = have.filter(h => !want.some(r => samePath(h, r)));
      if (add.length) roots[k] = add;
      if (off.length) rootsOff[k] = off;
    }
    if (Object.keys(roots).length) place.roots = roots;
    if (Object.keys(rootsOff).length) place.rootsOff = rootsOff;
  }
  return config;
}
/** 計画を比べる形。追加ルートは順によらず比べ、形式 3 までに無い hooks は空であること */
const planShape = plan => {
  const roots = r => Object.fromEntries(KINDS.map(k => [k, [...(r?.[k] ?? [])].map(pathKey).sort()]));
  return { ...plan, user: { ...plan.user, roots: roots(plan.user.roots) }, directory: { ...plan.directory, roots: roots(plan.directory.roots) } };
};
const hooksRootsEmpty = plan => !(plan.user.roots.hooks?.length) && !(plan.directory.roots.hooks?.length);
const samePlan = (before, after) => isDeepStrictEqual(before.owners, after.owners) && isDeepStrictEqual(planShape(before.plan), planShape(after.plan)) && hooksRootsEmpty(after.plan);
/** 形式 2・3 → 4 の検証。既定と、保存されていたすべての場所で、担当と探索の計画（種類ごとの追加ルートを含む）が同じか */
export function sameMeaningV3(old, config) {
  if (Object.keys(old.places).length !== Object.keys(config.places).length) return t('context.settings.defaultPlace');
  for (const key of [null, ...Object.keys(old.places)]) {
    if (!samePlan(resolveV3(old, key), resolveConfig(config, key))) return key ?? t('context.settings.defaultPlace');
  }
  return null;
}
/** 形式 1 → 4 の検証。既定と、形式 1 で上書きを持っていたすべての場所で、担当と探索の計画が同じか */
export function sameMeaning(old, config) {
  const keys = [null, ...Object.keys(old.directoryOwners), ...Object.keys(old.directories)];
  for (const key of keys) {
    if (!samePlan(legacyEffective(old, key), resolveConfig(config, key))) return key ?? t('context.settings.defaultPlace');
  }
  return null;
}
/**
 * 場所 key の上書きのうち、上の場所（または既定）から受け継ぐ値と同じものを消す。効く設定は変わらない。
 * 違いの無い上書きが残ると、その場所は「変更」扱いになり、あとで全体を変えてもその行には届かなくなる。
 * 戻り値は上書きが残っているか（kinds・roots・rootsOff のどれか）
 */
export function pruneInherited(config, key) {
  const place = config.places[key];
  if (!place) return false;
  const inherited = resolveConfig(config, key, { without: key });
  if (place.kinds) {
    for (const k of KINDS) {
      if (!place.kinds[k]) continue;
      const d = diffKind(applyKindDiff(inherited.kinds[k].value, place.kinds[k]), inherited.kinds[k].value);
      if (d) place.kinds[k] = d; else delete place.kinds[k];
    }
    if (!Object.keys(place.kinds).length) delete place.kinds;
  }
  for (const k of ROOT_KINDS) {
    const have = inherited.roots[k].value;
    const off = (place.rootsOff?.[k] ?? []).filter(o => have.some(h => samePath(h, o)));
    // 外して足し直したものは、受け継いだまま（順だけが変わる）
    const add = (place.roots?.[k] ?? []).filter((r, i, all) => all.findIndex(x => samePath(x, r)) === i)
      .filter(r => !have.some(h => samePath(h, r)) || off.some(o => samePath(o, r)));
    const both = add.filter(r => off.some(o => samePath(o, r)));
    const keepOff = off.filter(o => !both.some(b => samePath(b, o))), keepAdd = add.filter(r => !both.some(b => samePath(b, r)));
    for (const [field, list] of [['roots', keepAdd], ['rootsOff', keepOff]]) {
      if (list.length) (place[field] ??= {})[k] = list;
      else if (place[field]) delete place[field][k];
    }
  }
  for (const field of ['roots', 'rootsOff']) if (place[field] && !Object.keys(place[field]).length) delete place[field];
  return hasOverrides(place);
}
const hasOverrides = place => ['kinds', 'roots', 'rootsOff'].some(f => Object.keys(place[f] ?? {}).length > 0);
/**
 * 保存済みの場所すべてで、受け継ぐ値と同じ上書きを消す（浅い場所から。消しても効く設定は変わらないので順に解ける）。
 * removeEmpty なら、上書きが無くなった場所は一覧からも外す。はじめから上書きの無い場所（一覧に足しただけ）は残す。変えたら true
 */
export function pruneAll(config, { removeEmpty = true, under = null } = {}) {
  let changed = false;
  for (const key of Object.keys(config.places).sort((a, b) => a.length - b.length)) {
    if (under && !containsPath(under, key)) continue;
    const before = structuredClone(config.places[key]);
    const had = hasOverrides(before);
    const left = pruneInherited(config, key);
    if (removeEmpty && had && !left) delete config.places[key];
    if (!isDeepStrictEqual(before, config.places[key])) changed = true;
  }
  return changed;
}
/** 形式 1 の場所で効いていた担当と探索の計画 */
export function legacyEffective(old, key) {
  const ownerFrom = key ? nearest(old.directoryOwners, key, () => true) : null, specFrom = key ? nearest(old.directories, key, () => true) : null;
  return { owners: structuredClone(ownerFrom ? old.directoryOwners[ownerFrom] : old.owners), plan: legacyPlan(old.user, specFrom ? old.directories[specFrom] : DEFAULT_SCAN) };
}

// ------------------------------------------------------------------ 保存

/** ファイルの場所 → そのファイルへの読み書きの列の最後 */
const fileQueues = new Map();

export function createContextSettings(dataDir, home = os.homedir()) {
  const file = path.join(dataDir, 'context-scans.json');
  const real = async p => { try { return await fs.realpath(p); } catch { return p; } };
  // 実体パスへ寄せたキーで持つ。get/set は realpath した場所で引くので、短縮名（8.3）や junction 越しの表記で
  // 残ったキーはそのままだと二度と一致せず、継承が黙って外れる
  const keyed = async (map, fn) => Object.fromEntries(await Promise.all(Object.entries(map ?? {}).map(async ([p, v]) => { const r = await real(p); return [pathKey(r), await fn(v, r)]; })));
  const empty = () => ({ version: VERSION, defaults: { roots: emptyRoots(), kinds: Object.fromEntries(KINDS.map(k => [k, defaultKind()])) }, places: {} });

  async function readV1(raw) {
    if (!raw.directories || typeof raw.directories !== 'object' || Array.isArray(raw.directories)) throw new Error('invalid');
    // 旧版の探索元 ply は共通配置のこと
    const fix = v => ({ ...v, sources: Array.isArray(v?.sources) ? unique(v.sources.map(s => s === 'ply' ? 'common' : s)) : v?.sources });
    return { owners: ownersSchema.parse(raw.owners ?? DEFAULT_OWNERS), directoryOwners: await keyed(raw.directoryOwners, v => ownersSchema.parse(v ?? DEFAULT_OWNERS)),
      user: normalizeScan(fix(raw.user), home, home), directories: await keyed(raw.directories, (v, p) => normalizeScan(fix(v), p, home)) };
  }
  const readDefaults = (raw, kinds) => ({ roots: kinds === 'v2' ? normalizeRoots(raw.defaults.roots ?? [], home, home) : normalizeKindRoots(raw.defaults.roots ?? {}, home, home, { all: true, kinds }),
    kinds: Object.fromEntries(KINDS.map(k => [k, raw.defaults.kinds?.[k] ? normalizeKind(k, raw.defaults.kinds[k], home, home) : defaultKind()])) });
  const checkShape = raw => { if (!raw.defaults || !raw.places || typeof raw.places !== 'object' || Array.isArray(raw.places)) throw new Error('invalid'); };
  /** 形式 2 と 3（追加ルートの形だけが違う）。形式 2 の roots は並び 1 つのまま返す（移行で種類ごとにする） */
  async function readV2(raw, version = raw.version) {
    checkShape(raw);
    const roots = (value, base) => version === 2 ? normalizeRoots(value ?? [], base, home) : normalizeKindRoots(value ?? {}, base, home, { kinds: KINDS });
    const places = await keyed(raw.places, async (v, p) => {
      const out = { path: typeof v?.path === 'string' ? v.path : p, kinds: {} };
      for (const k of KINDS) if (v?.kinds?.[k]) out.kinds[k] = normalizeKind(k, v.kinds[k], p, home);
      if (version === 2 ? Array.isArray(v?.roots) : v?.roots !== undefined) out.roots = roots(v.roots, p);
      return out;
    });
    return { version, defaults: readDefaults(raw, version === 2 ? 'v2' : KINDS), places };
  }
  /** 形式 4。場所は差分（kinds の D、追加ルート roots、使わない追加ルート rootsOff）だけを持つ */
  async function readV4(raw) {
    checkShape(raw);
    const places = await keyed(raw.places, async (v, p) => {
      const out = { path: typeof v?.path === 'string' ? v.path : p };
      const kinds = {};
      for (const k of KINDS) if (v?.kinds?.[k]) kinds[k] = normalizeDiff(k, v.kinds[k], p, home);
      if (Object.keys(kinds).length) out.kinds = kinds;
      for (const field of ['roots', 'rootsOff']) {
        if (v?.[field] === undefined) continue;
        const r = Object.fromEntries(Object.entries(normalizeKindRoots(v[field], p, home)).filter(([, list]) => list.length));
        if (Object.keys(r).length) out[field] = r;
      }
      return out;
    });
    return { version: VERSION, defaults: readDefaults(raw, ROOT_KINDS), places };
  }
  async function write(config, target = file) {
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, target);
    } finally { await fs.rm(tmp, { force: true }); }
  }
  /**
   * 形式 1・2・3 → 4。バックアップ（context-scans.v1-backup.json / v2- / v3-backup.json。既にあれば残す）→ 移行 → 同じ結果かを確かめる →
   * 一時ファイルに書いて読み直し、もう一度確かめる → 置き換える。どこかで失敗したら元のファイルは変えない
   */
  async function migrate(text, raw) {
    const from = raw.version;
    const old = from === 1 ? await readV1(raw) : await readV2(raw);
    const backup = path.join(dataDir, `context-scans.v${from}-backup.json`);
    await fs.writeFile(backup, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    let v3;
    if (from === 1) {
      const display = async key => (await realpathNative(key).catch(() => key));
      const names = Object.fromEntries(await Promise.all(unique([...Object.keys(old.directoryOwners), ...Object.keys(old.directories)]).map(async k => [k, await display(k)])));
      v3 = migrateV1(old, k => names[k] ?? k);
    } else v3 = from === 2 ? migrateV2(old) : old;
    const config = migrateV3(v3);
    const verify = c => from === 1 ? sameMeaning(old, c) : sameMeaningV3(old, c);
    const differs = verify(config);
    if (differs) throw Object.assign(new Error(t('context.settings.migrateDiffers', { place: differs })), { migration: true });
    const tmp = `${file}.migrate.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
      const check = await readV4(JSON.parse(await fs.readFile(tmp, 'utf8')));
      if (verify(check)) throw Object.assign(new Error(t('context.settings.migrateUnverified')), { migration: true });
      // 読んでから置き換えるまでの間に別の Pleiad が書き換えていないか（同じ内容のときだけ置き換える）
      if ((await fs.readFile(file, 'utf8')) !== text) throw Object.assign(new Error('changed'), { retry: true });
      await fs.rename(tmp, file);
      return check;
    } catch (e) {
      // 同じ時に別の読み手（同じプロセスの別の設定の口も）が先に移し終えていれば、移した後の物を読み直す
      if (!e.migration && !e.retry && (await fs.readFile(file, 'utf8').catch(() => text)) !== text) throw Object.assign(new Error('changed'), { retry: true });
      throw e;
    } finally { await fs.rm(tmp, { force: true }); }
  }
  async function read() {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return empty(); throw new Error(t('context.settings.unreadable')); }
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error(t('context.settings.unreadable')); }
    let config;
    try {
      if (raw?.version === VERSION) config = await readV4(raw);
      else if (![1, 2, 3].includes(raw?.version)) throw new Error('invalid');
    } catch { throw new Error(t('context.settings.unreadable')); }
    // 「受け継ぐ値と同じ上書き」が残っていれば掃除する。一度書けば次からは変わらない（保存の set も同じ上書きを残さない）
    if (config) { if (pruneAll(config)) await write(config).catch(() => {}); return config; }
    try { return await migrate(text, raw); }
    catch (e) {
      if (e.retry) return read();
      if (e.migration) throw e;
      throw new Error(t('context.settings.unreadable'), { cause: e });
    }
  }
  // 読むのも書き込みの列に並べる。移行（書き込み）と保存が重ならないように
  // 列は同じファイルを開く口（同じプロセスの別の createContextSettings も）で 1 本。並べないと、同じ時の移行の置き換えが
  // Windows で EPERM になり、読めない扱いになる
  const queue = fn => {
    const run = (fileQueues.get(file) ?? Promise.resolve()).catch(() => {}).then(fn);
    fileQueues.set(file, run);
    run.finally(() => { if (fileQueues.get(file) === run) fileQueues.delete(file); }).catch(() => {});
    return run;
  };

  /**
   * 作業場所 cwd で効く設定。level: 'default' なら場所の上書きを無視して既定だけで解く（設定の「全体の設定」の一覧用）
   * 戻り: { cwd, owners, plan, kinds, roots }
   */
  async function get(cwd, { level = null } = {}) {
    const dir = await scanDirectory(cwd);
    const config = await queue(read);
    return { cwd: dir, ...resolveConfig(config, level === 'default' ? null : pathKey(dir)) };
  }
  /**
   * 画面の形。既定・保存された場所・今の場所（cwd）それぞれで効く設定と、どこから来ているか。
   *   kinds[].override はこの場所が差分を持つか、diff はその差分、rows は行（名前）ごとに変えた場所のパス、changes は変えた項目の数
   *   roots[].added は [{ path, from（足した場所のパス。全体なら null）, here（この場所で足したか） }]
   *   changes はこの場所で変えた数（項目と、足した・使わない追加ルート）、parent は一番近い保存済みの上の場所
   */
  async function view(cwd = null) {
    const dir = cwd ? await scanDirectory(cwd).catch(() => null) : null;
    const config = await queue(read);
    const pathOf = p => config.places[p]?.path ?? p;
    const level = (key, place) => {
      const r = resolveConfig(config, key);
      const own = key ? config.places[key] ?? {} : null;
      const kinds = Object.fromEntries(KINDS.map(k => [k, { value: r.kinds[k].value, override: key ? Boolean(own.kinds?.[k]) : true, from: r.kinds[k].from ? pathOf(r.kinds[k].from) : null,
        diff: key ? structuredClone(own.kinds?.[k] ?? null) : null, rows: Object.fromEntries(Object.entries(r.kinds[k].rows).map(([n, p]) => [n, pathOf(p)])),
        changes: key ? countDiff(own.kinds?.[k]) : 0 }]));
      const roots = Object.fromEntries(ROOT_KINDS.map(k => [k, key
        ? { value: r.roots[k].value, override: Boolean(own.roots?.[k] || own.rootsOff?.[k]), from: r.roots[k].from ? pathOf(r.roots[k].from) : null,
          added: r.roots[k].added.map(a => ({ path: a.path, from: pathOf(a.place), here: a.place === key })), off: [...(own.rootsOff?.[k] ?? [])],
          changes: (own.roots?.[k]?.length ?? 0) + (own.rootsOff?.[k]?.length ?? 0) }
        : { value: [...config.defaults.roots[k]], override: true, from: null, added: config.defaults.roots[k].map(p => ({ path: p, from: null, here: true })), off: [], changes: 0 }]));
      const parent = key ? chainOf(config.places, key).filter(p => p !== key).at(-1) ?? null : null;
      return { id: key ?? 'default', path: place?.path ?? null, kinds, roots,
        overrides: key ? KINDS.filter(k => kinds[k].override).length + ROOT_KINDS.filter(k => roots[k].override).length : 0,
        changes: key ? KINDS.reduce((n, k) => n + kinds[k].changes, 0) + ROOT_KINDS.reduce((n, k) => n + roots[k].changes, 0) : 0,
        parent: parent ? { id: parent, path: pathOf(parent) } : null };
    };
    const keys = Object.keys(config.places);
    if (dir && !keys.includes(pathKey(dir))) keys.push(pathKey(dir));
    const places = keys.map(k => ({ ...level(k, config.places[k] ?? { path: dir }), saved: Object.hasOwn(config.places, k), current: Boolean(dir) && k === pathKey(dir) }))
      .sort((a, b) => (b.current - a.current) || a.path.localeCompare(b.path));
    return { version: VERSION, cwd: dir, home, defaults: level(null), places };
  }
  /**
   * 1 か所だけ変えて即時保存する。
   *   { place: null | パス, kind, value: K | null }   種類の設定（効かせたい値。場所では受け継ぐ値からの差分だけを持つ。場所で null = 上の設定に戻す）
   *   { place, kind: 'mcp' | 'skill', revertRows: [名前] }  外部 MCP の行（名前 × エージェントと使う方）・Skills の選んだ写しを上の設定に戻す
   *   { place, kind?, roots: [..] | null }              追加で探すフォルダーの並び（kind を省くと 3 種すべて。場所で null = 上の設定に戻す）
   *   { place, kind, addRoot: パス } / { place, kind, removeRoot: パス }   追加で探すフォルダーを 1 つ足す / 外す（kind は hooks も可）
   *   { place, add: true } / { place, remove: true }    場所を一覧に足す / 一覧から外す（上書きも消える）
   */
  function set(args = {}) {
    let placed = null;
    return queue(async () => {
      const config = await read();
      const { place = null, kind } = args;
      let target, base = home, key = null, existed = false;
      if (place === null) target = config.defaults;
      else {
        // 一覧から外すのは、フォルダーが消えた・移った場所でもできるようにする（保存した場所の名前で探す）
        if (args.remove) {
          const dir = await scanDirectory(place).catch(() => null);
          const key = [dir && pathKey(dir), pathKey(place)].find(k => k && Object.hasOwn(config.places, k));
          if (key) { delete config.places[key]; await write(config); }
          return;
        }
        const dir = await scanDirectory(place);
        base = dir; placed = dir;
        key = pathKey(dir);
        existed = Object.hasOwn(config.places, key);
        target = config.places[key] ??= { path: dir };
      }
      const setsKind = kind !== undefined && Object.hasOwn(args, 'value'), setsRoots = Object.hasOwn(args, 'roots');
      const reverts = Array.isArray(args.revertRows), addsRoot = Object.hasOwn(args, 'addRoot'), removesRoot = Object.hasOwn(args, 'removeRoot');
      if (kind !== undefined && !((setsKind || reverts) ? KINDS : ROOT_KINDS).includes(kind)) throw new Error(t('context.settings.unknownKind'));
      if ((addsRoot || removesRoot) && kind === undefined) throw new Error(t('context.settings.unknownKind'));
      if (setsKind) {
        if (args.value === null) {
          if (place === null) target.kinds[kind] = defaultKind();
          else if (target.kinds) delete target.kinds[kind];
        } else setKindValue(config, key, kind, normalizeKind(kind, args.value, base, home), target.path);
      }
      if (reverts) {
        if (!['mcp', 'skill'].includes(kind) || place === null) throw new Error(t('context.settings.kindInvalid'));
        const d = target.kinds?.mcp;
        for (const n of args.revertRows) {
          if (d?.agents) { delete d.agents.off[n]; delete d.agents.spread[n]; }
          if (d?.prefer) delete d.prefer[n];
        }
      }
      const inheritedRoots = k => key ? resolveConfig(config, key, { without: key }).roots[k].value : [];
      if (setsRoots) {
        const roots = args.roots === null ? null : normalizeRoots(args.roots, base, home);
        for (const k of kind === undefined ? KINDS : [kind]) {
          if (place === null) { target.roots[k] = roots ? [...roots] : []; continue; }
          const have = inheritedRoots(k);
          const add = roots ? roots.filter(r => !have.some(h => samePath(h, r))) : [], off = roots ? have.filter(h => !roots.some(r => samePath(h, r))) : [];
          for (const [field, list] of [['roots', add], ['rootsOff', off]]) {
            if (list.length) (target[field] ??= {})[k] = list;
            else if (target[field]) delete target[field][k];
          }
        }
      }
      if (addsRoot || removesRoot) {
        const [p] = normalizeRoots([addsRoot ? args.addRoot : args.removeRoot], base, home);
        const mine = place === null ? (target.roots[kind] ??= []) : (target.roots?.[kind] ?? []);
        if (addsRoot) {
          const off = target.rootsOff?.[kind] ?? [];
          if (off.some(o => samePath(o, p))) target.rootsOff[kind] = off.filter(o => !samePath(o, p));
          else if (!mine.some(r => samePath(r, p)) && !inheritedRoots(kind).some(h => samePath(h, p))) {
            if (place === null) mine.push(p); else (target.roots ??= {})[kind] = [...mine, p];
          }
        } else {
          // 上の場所・全体で足した場所は、ここでは外さない（足した場所の設定で外す）
          if (!mine.some(r => samePath(r, p))) throw new Error(t('context.settings.rootInherited'));
          if (place === null) target.roots[kind] = mine.filter(r => !samePath(r, p));
          else target.roots[kind] = mine.filter(r => !samePath(r, p));
        }
      }
      if (!setsKind && !setsRoots && !reverts && !addsRoot && !removesRoot && !args.add) throw new Error(t('context.settings.nothingToChange'));
      // 受け継ぐ値と同じ上書きは書かない。この変更で場所を作ったのに上書きが残らなければ、場所も作らない。
      // 上の値が変わると、下の場所の差分が受け継ぐ値と同じになることがある。それも消す（場所は一覧に残す）
      if (key && !pruneInherited(config, key) && !existed && !args.add) delete config.places[key];
      pruneAll(config, { removeEmpty: false, under: key });
      await write(config);
    // 外した場所を「今の場所」として一覧に戻さないよう、外したときは cwd だけで画面の形を作る
    }).then(async () => ({ ...(await view(args.cwd ?? (args.remove ? null : args.place || null))), place: placed }));
  }
  /**
   * Pleiad の登録の名前を変えたとき、既定と各場所の外部 MCP の設定で、名前で指したもの（disabled・prefer・行）を新しい名前へ追随させる。
   *   disabled: 新しい名前も外す。古い名前は残す（同じ名前でエージェント側に登録があれば、それも前と同じく外れたまま）
   *   prefer:   古い名前で Pleiad の登録（plyFile）を選んでいたら、新しい名前へ移す。エージェント側の定義を選んでいたものは古い名前のまま
   * 戻り値は書き換えた箇所の数
   */
  function renameMcp(from, to, { plyFile = null } = {}) {
    return queue(async () => {
      const config = await read();
      let changed = 0;
      const same = (a, b) => a && b && pathKey(a) === pathKey(b);
      for (const [holder, isPlace] of [[config.defaults, false], ...Object.values(config.places).map(p => [p, true])]) {
        const k = holder.kinds?.mcp;
        if (!k) continue;
        if (k.disabled?.includes(from) && !k.disabled.includes(to)) { k.disabled = unique([...k.disabled, to]).sort(); changed++; }
        // 名前ごとの設定: 古い名前で止めていたエージェントは、新しい名前でも止めたままにする
        if (k.agents?.off?.[from] && !k.agents.off[to] && (isPlace ? !k.agents.spread?.[to] : true)) {
          if (isPlace) { k.agents.off[to] = [...k.agents.off[from]]; k.agents.spread[to] = []; k.agents = { off: sortKeys(k.agents.off), spread: sortKeys(k.agents.spread) }; }
          else { k.agents.off[to] = [...k.agents.off[from]]; k.agents.off = normalizeAgents({ off: k.agents.off }).off; }
          changed++;
        }
        if (k.prefer && Object.hasOwn(k.prefer, from) && (!plyFile || same(k.prefer[from], plyFile))) {
          if (!Object.hasOwn(k.prefer, to)) k.prefer[to] = k.prefer[from];
          delete k.prefer[from];
          changed++;
        }
      }
      if (changed) { pruneAll(config, { removeEmpty: false }); await write(config); }
      return changed;
    });
  }
  return { get, view, set, renameMcp, file, read: () => queue(read) };
}
