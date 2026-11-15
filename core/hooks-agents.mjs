// Hooks を「Hook × エージェント」の一覧にする（ADR 0338）。保存・行 ID・元の集合・セルの規則・移行の式・ターンで動く Hook。
//   - 保存は <data>/hooks-agents.json（在れば移行済み。無ければ hooks.json の担当の 2 択のまま動く）
//   - 一覧（matrix）と実行時（prepareHooksTurn の移行済みの枝の forTurn）は、同じ cellsFor で決める
//   - 止め方は「Pleiad がそろえる」と同じ（Claude はまとめて止めて渡し直す・Codex は key・Antigravity は名前・Grok は互換の環境変数・Devin は --config）
// エージェントの設定ファイルは書き換えない（読むだけ）。相手のファイルへ書く道は持たない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathKey, containsPath } from './context-settings.mjs';
import { writeAtomic } from './atomic-file.mjs';
import { t } from './i18n.mjs';
import { HOOK_AGENTS, HOOK_EMULATED, HOOK_VIA, UNIFY_TARGETS, maskText, rawOf } from './hooks-config.mjs';
import { deliverable, nativeFate, planHooks, suppliedSummary, unsupportedSummary, codexHooksTable, agyHooksFile, grokHooksFile } from './hooks-plan.mjs';
import { importCandidate, rowSummary, adapterSource, writeAdapterTo, grokNativeHooks, GROK_COMPAT_HOOK_ENV } from './hooks-unify.mjs';
import { parseAdapterCommand, safeAdapterPath } from './hooks-copy.mjs';
import { parseToml } from './toml.mjs';
import { resolveOwner } from './ply-hooks.mjs';

// backend-allow: 元の集合と止め方がエージェントごとに違う（ADR 0338「元の集合」「実行時」）
const CLAUDE = 'claude', CODEX = 'codex', AGY = 'antigravity', GROK = 'grok', DEVIN = 'devin';

export const FILE_NAME = 'hooks-agents.json';
export const WS_KEY = 'ws:hooks';
export const VERSION = 1;
export const LOCK_REASONS = Object.freeze(['own', 'workspace', 'relay', 'admin']);
const ORDER = [CLAUDE, CODEX, AGY, 'opencode', DEVIN, GROK]; // backend-allow: 一覧の列の並び（外部 MCP の一覧と同じ）
const KEY_RE = /^(?:h-[0-9a-f]{12}|hk-[0-9a-f]{16}|ws:hooks)$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const refuse = (key, params = {}) => Object.assign(new Error(t(key, params)), { code: 'HOOKS_REFUSED' });
// i18n-dynamic: hooksAgents.
const invalid = (key, params = {}) => Object.assign(new Error(t(key, params)), { code: 'INVALID' });

/**
 * エージェントの設定の定義の行 ID。並びの位置（group・handler の番号）は入れない（前に 1 つ足しても変わらない）。
 * コマンドは伏せ字にする前の、前後の空白を除いたもの（伏せ字は秘密を隠すために縮めるので、別の定義が同じ名前になりうる）
 */
export function nativeRowKey(row, command) {
  const file = row.scope === 'plugin' && row.plugin ? `plugin:${row.plugin}` : row.path ? pathKey(row.path) : '';
  return `hk-${sha(JSON.stringify([row.agent, row.scope, file, row.event, row.matcher ?? '', String(command ?? '').trim(), row.name ?? ''])).slice(0, 16)}`;
}

// ---------- 保存の形 ----------
const emptyAgents = () => ({ off: {}, spread: {}, unused: [], compat: { grok: 'native', devin: 'native' } });
const agentList = v => Array.isArray(v) ? [...new Set(v.filter(a => UNIFY_TARGETS.includes(a)))].sort() : [];
function agentMap(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, list] of Object.entries(v)) {
    if (!KEY_RE.test(k)) continue;
    const a = agentList(list);
    if (a.length) out[k] = a;
  }
  return out;
}
/** エージェントごとの選択（全体・場所の上書きが同じ形）を検査する。知らない値は落とす */
export function normAgents(v) {
  const src = v && typeof v === 'object' ? v : {};
  return { off: agentMap(src.off), spread: agentMap(src.spread),
    unused: Array.isArray(src.unused) ? [...new Set(src.unused.filter(k => typeof k === 'string' && KEY_RE.test(k)))].sort() : [],
    compat: { grok: src.compat?.grok === 'off' ? 'off' : 'native', devin: src.compat?.devin === 'off' ? 'off' : 'native' } };
}
/** ファイルの中身を検査する。版が違う・形が違えば null（読めない扱い） */
export function parseState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return null;
  const places = {};
  for (const [pk, p] of Object.entries(raw.places && typeof raw.places === 'object' ? raw.places : {})) {
    if (!p || typeof p !== 'object' || typeof p.path !== 'string' || !path.isAbsolute(p.path) || pathKey(p.path) !== pk) continue;
    const place = { path: p.path };
    if (Array.isArray(p.skip)) place.skip = [...new Set(p.skip.filter(k => typeof k === 'string' && KEY_RE.test(k)))].sort();
    if (p.agents && typeof p.agents === 'object') place.agents = normAgents(p.agents);
    if (place.skip || place.agents) places[pk] = place;
  }
  const from = raw.adoptedFrom && typeof raw.adoptedFrom === 'object' ? raw.adoptedFrom : null;
  return { version: VERSION, ...normAgents(raw), places,
    adoptedFrom: from ? { owner: from.owner === 'ply' ? 'ply' : 'native', at: typeof from.at === 'string' ? from.at : null } : null,
    seen: parseSeen(raw.seen) };
}
const plainState = s => ({ version: VERSION, off: s.off, spread: s.spread, unused: s.unused, compat: s.compat, places: s.places, adoptedFrom: s.adoptedFrom, seen: s.seen ?? [] });
// 移行の時刻は入れない（移行前の一覧は開くたびに写し直すので、時刻を入れると revision が毎回変わる）。seen（下）は選択ではないので入れない
export const stateRevision = s => sha(JSON.stringify({ version: VERSION, off: s.off, spread: s.spread, unused: s.unused, compat: s.compat, places: s.places,
  adoptedFrom: s.adoptedFrom ? { owner: s.adoptedFrom.owner } : null })).slice(0, 16);

// ---------- 書き換えた定義へ選択を引き継ぐ（seen。ADR 0338「書き換えた定義」） ----------
// 行 ID はコマンドと matcher を含むので、利用者が設定ファイルでそれを直すと ID が変わり、外した選択が付かなくなる（黙ってオンに戻る）。
// 選択の付いた定義があるファイル・イベントの組（エージェント・scope・ファイル・イベント）ごとに、そこにあった行 ID と数を覚えておき、
// 読むときに、消えた 1 つと現れた 1 つが対応すると言えるときだけ選択を移す。言えなければ移さず、行き先の無い選択（orphans）として返す
const REKEY_SCOPES = new Set(['user', 'project', 'local']);
const groupId = g => JSON.stringify([g.agent, g.scope, pathKey(g.path), g.event]);
const fileId = (agent, p) => JSON.stringify([agent, pathKey(p)]);
const isNativeKey = k => typeof k === 'string' && k.startsWith('hk-');
function parseSeen(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const g of v.slice(0, 1000)) {
    if (!g || typeof g !== 'object' || !HOOK_AGENTS.includes(g.agent) || !REKEY_SCOPES.has(g.scope) || typeof g.path !== 'string' || !path.isAbsolute(g.path)
      || typeof g.event !== 'string' || !g.event) continue;
    const keys = {}, lost = {};
    for (const [k, n] of Object.entries(g.keys && typeof g.keys === 'object' ? g.keys : {})) if (isNativeKey(k) && KEY_RE.test(k) && Number.isInteger(n) && n > 0 && n < 1000) keys[k] = n;
    for (const [k, r] of Object.entries(g.lost && typeof g.lost === 'object' ? g.lost : {})) if (isNativeKey(k) && KEY_RE.test(k) && !keys[k] && ['gone', 'ambiguous'].includes(r)) lost[k] = r;
    out.push({ agent: g.agent, scope: g.scope, path: g.path, event: g.event, keys, lost });
  }
  return out;
}
/** 選択（全体・場所の上書き・この場所で使わない）に出てくる、エージェントの設定の定義の行 ID */
function refKeys(s) {
  const out = new Set();
  const add = a => { if (!a) return; for (const k of [...Object.keys(a.off ?? {}), ...Object.keys(a.spread ?? {}), ...(a.unused ?? [])]) if (isNativeKey(k)) out.add(k); };
  add(s);
  for (const p of Object.values(s.places ?? {})) { add(p.agents); for (const k of p.skip ?? []) if (isNativeKey(k)) out.add(k); }
  return out;
}
/** 行 ID の選択を別の行 ID へ移す（keep なら元にも残す: 同じ定義が 2 つあって 1 つだけ書き換えたとき） */
function moveKey(s, from, to, keep) {
  const fix = a => {
    if (!a) return a;
    const off = { ...a.off }, spread = { ...a.spread };
    if (off[from]) { off[to] = [...off[from]]; if (!keep) delete off[from]; }
    if (spread[from]) { spread[to] = [...spread[from]]; if (!keep) delete spread[from]; }
    let unused = [...a.unused];
    if (unused.includes(from)) { unused.push(to); if (!keep) unused = unused.filter(k => k !== from); }
    return { ...a, off, spread, unused: [...new Set(unused)].sort() };
  };
  const places = {};
  for (const [pk, p] of Object.entries(s.places)) {
    const q = { ...p };
    if (p.agents) q.agents = fix(p.agents);
    if (p.skip?.includes(from)) q.skip = [...new Set([...p.skip.filter(k => keep || k !== from), to])].sort();
    places[pk] = q;
  }
  return { ...s, ...fix(s), places };
}
/** その一覧で、組の中身を確かに読めたファイル（無い・空も読めた内。壊れた・一部飛ばした・読めないファイルは組を動かさない） */
function readableFiles(inv) {
  const out = new Set();
  for (const f of inv.report?.files ?? []) if (['ok', 'none', 'missing'].includes(f.status) && !f.partial && f.path) out.add(fileId(f.agent, f.path));
  return out;
}
function presentGroups(inv, files) {
  const out = new Map();
  for (const row of inv.rows) {
    if (row.kind !== 'native' || !REKEY_SCOPES.has(row.scope) || !row.path || !isNativeKey(row.key) || !files.has(fileId(row.agent, row.path))) continue;
    const id = groupId(row);
    if (!out.has(id)) out.set(id, { meta: { agent: row.agent, scope: row.scope, path: row.path, event: row.event }, keys: new Map() });
    out.get(id).keys.set(row.key, (out.get(id).keys.get(row.key) ?? 0) + row.members.length);
  }
  return out;
}
/**
 * 覚えた組と今の一覧を突き合わせ、書き換えた定義へ選択を移した状態と、行き先の無い選択を返す（保存はしない）。
 * 組ごとに、消えた（数が減った）定義と現れた（数が増えた）定義を数え、ちょうど 1 対 1 で、現れた方が初めて見る ID で選択を持っていないときだけ移す。
 * それ以外（2 つ以上が同時に変わった・消えただけ・既にある定義と同じになった）は移さない。広げた状態も同じ（あいまいなら実行する側へ倒さない）
 */
export function resolveRekeys(state, inv) {
  const files = readableFiles(inv);
  const present = presentGroups(inv, files);
  let s = state;
  const orphans = [], moved = [];
  for (const g of state.seen ?? []) {
    if (!files.has(fileId(g.agent, g.path))) continue;
    const P = present.get(groupId(g))?.keys ?? new Map();
    const refs = refKeys(s);
    const vanished = [], appeared = [];
    for (const [k, n] of Object.entries(g.keys)) for (let i = P.get(k) ?? 0; i < n; i++) vanished.push(k);
    for (const [k, n] of P) for (let i = g.keys[k] ?? 0; i < n; i++) appeared.push(k);
    if (vanished.length === 1 && appeared.length === 1 && refs.has(vanished[0]) && !(appeared[0] in g.keys) && !refs.has(appeared[0])) {
      s = moveKey(s, vanished[0], appeared[0], P.has(vanished[0]));
      moved.push({ from: vanished[0], to: appeared[0], group: g });
      continue;
    }
    const lost = { ...g.lost };
    for (const k of Object.keys(g.keys)) if (!P.has(k)) lost[k] = appeared.length ? 'ambiguous' : 'gone';
    for (const [k, reason] of Object.entries(lost)) {
      if (P.has(k) || !refs.has(k)) continue;
      orphans.push({ key: k, agent: g.agent, scope: g.scope, path: g.path, event: g.event, reason, candidates: [...new Set(appeared)].filter(x => !refs.has(x)).sort() });
    }
  }
  // 行き先の無い選択の中身（画面が「何が付かなくなったか」を出す）
  for (const o of orphans) {
    o.off = s.off[o.key] ?? []; o.spread = s.spread[o.key] ?? []; o.unused = s.unused.includes(o.key);
    o.places = Object.values(s.places).filter(p => p.skip?.includes(o.key) || p.agents?.off?.[o.key] || p.agents?.spread?.[o.key] || p.agents?.unused?.includes(o.key)).map(p => p.path).sort();
  }
  return { state: s, orphans, moved };
}
/**
 * 保存する前に覚え直す: 今の一覧で読めた組は今の中身（と行き先の無い選択の理由）に、読めなかった組は前のまま。選択の付いた定義が無い組は覚えない
 */
export function nextSeen(state, inv, orphans = []) {
  const files = readableFiles(inv);
  const present = presentGroups(inv, files);
  const refs = refKeys(state);
  const lostOf = new Map();
  for (const o of orphans) { const id = groupId(o); if (!lostOf.has(id)) lostOf.set(id, {}); lostOf.get(id)[o.key] = o.reason; }
  const out = new Map();
  for (const g of state.seen ?? []) {
    const id = groupId(g);
    if (files.has(fileId(g.agent, g.path))) continue;
    if ([...Object.keys(g.keys), ...Object.keys(g.lost)].some(k => refs.has(k))) out.set(id, g);
  }
  const ids = new Set([...present.keys(), ...lostOf.keys()]);
  for (const id of ids) {
    if (out.has(id)) continue;
    const p = present.get(id);
    const meta = p?.meta ?? (state.seen ?? []).find(g => groupId(g) === id) ?? orphans.find(o => groupId(o) === id);
    const keys = Object.fromEntries([...(p?.keys ?? new Map())].sort(([a], [b]) => a.localeCompare(b)));
    const lost = Object.fromEntries(Object.entries(lostOf.get(id) ?? {}).filter(([k]) => refs.has(k) && !keys[k]).sort(([a], [b]) => a.localeCompare(b)));
    if (!Object.keys(keys).some(k => refs.has(k)) && !Object.keys(lost).length) continue;
    out.set(id, { agent: meta.agent, scope: meta.scope, path: meta.path, event: meta.event, keys, lost });
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
}

/** cwd で効く選択（深い場所の上書きが勝つ）と「この場所では使わない」 */
export function effectiveAt(state, cwd) {
  let agents = { off: state.off, spread: state.spread, unused: state.unused, compat: state.compat }, agentsFrom = null, skip = [], skipFrom = null;
  if (cwd) {
    const keys = Object.keys(state.places).filter(k => containsPath(state.places[k].path, cwd)).sort((a, b) => b.length - a.length);
    agentsFrom = keys.find(k => state.places[k].agents) ?? null;
    if (agentsFrom) agents = state.places[agentsFrom].agents;
    skipFrom = keys.find(k => Array.isArray(state.places[k].skip)) ?? null;
    if (skipFrom) skip = state.places[skipFrom].skip;
  }
  return { agents, agentsFrom, skip: new Set(skip), skipFrom };
}

// ---------- 元の集合とセル ----------
/** Grok の互換の読み込み（~/.grok/config.toml の [compat.claude] hooks）と、フォルダーの信頼（trusted_folders.toml。無ければ信頼なし、在れば分からない） */
export async function readGrokEnv(grokHome) {
  let claudeHooks = true, trust = 'no';
  try { const c = parseToml(await fs.readFile(path.join(grokHome, 'config.toml'), 'utf8')); if (c?.compat?.claude?.hooks === false) claudeHooks = false; } catch {}
  try { await fs.stat(path.join(grokHome, 'trusted_folders.toml')); trust = 'unknown'; } catch {}
  return { claudeHooks, trust };
}

const rowIsOff = (row, s) => s.unused.includes(row.key) || (row.kind === 'reg' && !row.hook.enabled && !(s.enable ?? []).includes(row.key));
const has = (map, key, a) => (map[key] ?? []).includes(a);

/** その行を、エージェント A が自分で動かすか（true | 'unknown' | false）。Pleiad の登録は渡すもの（false） */
export function nativeOf(row, A, inv, s) {
  if (row.kind === 'reg' || row.kind === 'ws') return false;
  if (row.kind === 'grokOwn') return A === GROK;
  if (row.fate === 'inactive') return false;
  if (row.agent === CLAUDE) {
    if (A === CLAUDE) return row.scope === 'managed' || !inv.claudeAllOff;
    if (['managed', 'plugin', 'skill'].includes(row.scope)) return false;
    if (A === GROK) {
      if (s.compat.grok !== 'native' || !inv.grokEnv.claudeHooks) return false;
      return row.scope === 'user' ? true : inv.grokEnv.trust === 'unknown' ? 'unknown' : false;
    }
    if (A === DEVIN) return s.compat.devin === 'native';
    return false;
  }
  return A === row.agent;
}
/** 元の集合（エージェントの並び）。確かなものだけ */
const baseOf = (row, inv, s) => row.kind === 'reg' ? row.hook.targets.filter(a => UNIFY_TARGETS.includes(a)) : UNIFY_TARGETS.filter(a => nativeOf(row, a, inv, s) === true);

/** 1 つずつは止められず、保存に関わらず元の集合のとおりのセル。{ reason, detail } か null */
function fixedOf(row, A) {
  if (row.scope === 'managed') return { reason: 'admin', detail: 'managed' };
  if (row.kind === 'grokOwn') return { reason: 'own', detail: 'grokOwn' };
  if (row.agent === CLAUDE && A === DEVIN) return { reason: 'own', detail: 'devinImports' };
  if (row.scope === 'plugin' && row.agent !== CLAUDE) return { reason: 'own', detail: 'plugin' };
  return null;
}
/** 止める単位（その単位のどれかを止めると、単位ごと止めて残りを渡し直す） */
function unitOf(row, A) {
  if (A === CLAUDE) return CLAUDE;
  if (A === GROK) return 'grokCompat';
  if (A === AGY) return row.kind === 'ws' ? 'ws' : `name:${row.name ?? row.key}`;
  return `row:${row.key}`;
}

/** 定義を A へ Pleiad が渡す形にする。{ hook, d } か { blocked: [{ code, params? }] }。inv にためる */
function asDelivery(row, A, inv) {
  const memo = inv.memo ??= new Map();
  const id = `${row.key}\0${A}`;
  if (memo.has(id)) return memo.get(id);
  let out;
  if (row.kind === 'reg') {
    const d = deliverable({ ...row.hook, targets: [A] }, A, { platform: inv.platform });
    out = d?.status === 'ok' ? { hook: row.hook, d } : { blocked: d?.reasons ?? [{ code: 'unsupportedAgent' }] };
  } else if (!row.raw) out = { blocked: [{ code: row.scope === 'managed' || row.kind === 'grokOwn' ? 'readOnly' : 'unreadable' }] };
  else {
    const c = importCandidate(row.raw);
    const bad = c.reasons.filter(r => !(r === 'claudeCallback' && A !== CLAUDE));
    if (bad.length) out = { blocked: bad.map(code => ({ code })) };
    else {
      const hook = { ...c.value, id: row.key, targets: [A], enabled: true };
      const d = deliverable(hook, A, { platform: inv.platform });
      out = d?.status === 'ok' ? { hook, d } : { blocked: d?.reasons ?? [{ code: 'unsupportedAgent' }] };
    }
  }
  memo.set(id, out);
  return out;
}

// 根拠（セルの警告に付ける。文は辞書の hooksAgents.evidence.<code>）
// i18n-dynamic: hooksAgents.evidence.
const warn = code => ({ code, evidence: t(`hooksAgents.evidence.${code}`) });

/**
 * エージェント A の全部の行のセル（一覧と実行時が同じ規則を使う）。s は効く選択（effectiveAt().agents。s.enable は試算用）、skip はこの場所で使わない行。
 * セル: { state: on|off, mode: toggle|locked|none, reason?, detail?, unknown?, warnings?, needsConfirm? } と内部の _role・_deliver・_unit・_mismatch・_desired
 */
export function cellsFor(inv, s, skip, A) {
  // Devin の取り込みの止め（compat.devin: 'off'。旧「そろえる」から）は、Devin へ渡すものがあるターンだけ効く（旧と同じ）。
  // 渡すものが無ければ取り込みが動くので、Claude の定義の Devin の列は取り込みのとおり（devinImports）に見せる
  if (A === DEVIN && s.compat?.devin === 'off') {
    const cells = cellsOnce(inv, s, skip, A);
    if ([...cells.values()].some(c => c._deliver && c.state === 'on')) return cells;
    return cellsOnce(inv, { ...s, compat: { ...s.compat, devin: 'native' } }, skip, A);
  }
  return cellsOnce(inv, s, skip, A);
}
function cellsOnce(inv, s, skip, A) {
  const cells = new Map();
  const wsOn = !s.unused.includes(WS_KEY) && !has(s.off, WS_KEY, A);
  const units = new Map();
  const ws = inv.rows.find(r => r.kind === 'ws');
  const addUnit = (id, m) => { if (!units.has(id)) units.set(id, []); units.get(id).push(m); };
  for (const row of inv.rows) {
    if (row.kind === 'ws') continue;
    const nat = nativeOf(row, A, inv, s);
    if (row.scope === 'managed') { cells.set(row.key, row.agent === A && nat ? { state: 'on', mode: 'locked', reason: 'admin', detail: 'managed', _role: 'fixed' } : { state: 'off', mode: 'none', _role: 'none' }); continue; }
    if (row.kind === 'grokOwn') { cells.set(row.key, A === GROK ? { state: 'on', mode: 'locked', reason: 'own', detail: 'grokOwn', _role: 'fixed' } : { state: 'off', mode: 'locked', reason: 'relay', detail: 'grokOwn', _role: 'locked' }); continue; }
    if (nat === 'unknown') { cells.set(row.key, { state: 'off', unknown: true, mode: 'locked', reason: 'workspace', detail: 'grokTrustUnknown', warnings: [warn('grokTrustUnknown')], _role: 'unknown' }); continue; }
    if (nat === true) {
      const fixed = fixedOf(row, A);
      if (fixed) { cells.set(row.key, { state: 'on', mode: 'locked', ...fixed, _role: 'fixed' }); continue; }
      const desired = row.group === 'place' ? wsOn && !skip.has(row.key) : !rowIsOff(row, s) && !skip.has(row.key) && !has(s.off, row.key, A);
      const m = { row, desired, re: !('blocked' in asDelivery(row, A, inv)) };
      cells.set(row.key, { _role: row.group === 'place' ? 'wsMember' : 'member', _desired: desired });
      addUnit(unitOf(row, A), m);
      continue;
    }
    // 自分では動かさない（元の集合に無い）: Pleiad が渡せるか
    if (row.kind === 'native') {
      const lock = (reason, detail, extra = {}) => cells.set(row.key, { state: 'off', mode: 'locked', reason, detail, _role: 'locked', ...extra });
      if (row.agent === A && row.fate === 'inactive') { lock('own', 'nativeInactive'); continue; }
      if (row.agent === A && A === CLAUDE && inv.claudeAllOff) { lock('own', 'claudeAllOff'); continue; }
      const copy = row.copies?.[A];
      if (copy) {
        const on = copy.fate !== 'inactive' && nativeOf(copy, A, inv, s) === true;
        cells.set(row.key, { state: on ? 'on' : 'off', mode: 'locked', reason: 'own', detail: 'copyExists', copy: copy.key, _role: 'copy' });
        continue;
      }
      if (row.group === 'place') { lock('workspace', 'placeNoSpread'); continue; }
      if (row.scope === 'plugin' || row.scope === 'skill') { lock('own', 'pluginOrSkill'); continue; }
      if (row.agent === CLAUDE && A === DEVIN) { lock('workspace', 'devinCompatOff'); continue; }
    }
    const del = asDelivery(row, A, inv);
    if ('blocked' in del) {
      cells.set(row.key, { state: 'off', mode: 'locked', reason: 'relay', detail: del.blocked[0]?.code ?? 'relay', reasons: del.blocked, _role: 'locked',
        _blocked: (row.kind === 'reg' ? !rowIsOff(row, s) && !skip.has(row.key) && ((baseOf(row, inv, s).includes(A) && !has(s.off, row.key, A)) || has(s.spread, row.key, A)) : false) ? del.blocked : null });
      continue;
    }
    const base = baseOf(row, inv, s).includes(A);
    const desired = !rowIsOff(row, s) && !skip.has(row.key) && ((base && !has(s.off, row.key, A)) || has(s.spread, row.key, A));
    const warnings = [...(del.d.warnings ?? []).map(w => ({ code: w.code ?? String(w), params: w.params, evidence: null }))];
    if (A === DEVIN) warnings.push(warn('devinConfig'));
    if (row.agent === CODEX) warnings.push(warn('codexTrustAtTurn'));
    cells.set(row.key, { state: desired ? 'on' : 'off', _role: 'spread', _deliver: desired ? del : null, _desired: desired, needsConfirm: !base,
      ...(warnings.length ? { warnings } : {}) });
  }
  // 作業場所の行（全体の一覧では中身が分からないので、渡し直せる 1 つの定義とみなす）
  if (ws) {
    const members = inv.rows.filter(r => r.kind === 'native' && r.group === 'place' && nativeOf(r, A, inv, s) === true && !fixedOf(r, A));
    const anyNative = inv.cwd ? inv.rows.some(r => r.kind === 'native' && r.group === 'place' && nativeOf(r, A, inv, s)) : null;
    let cell;
    if (A === DEVIN) cell = s.compat.devin === 'native' ? { state: 'on', mode: 'locked', reason: 'own', detail: 'devinImports', _role: 'fixed' } : { state: 'off', mode: 'locked', reason: 'workspace', detail: 'devinCompatOff', _role: 'locked' };
    else if (!HOOK_AGENTS.includes(A)) {
      const unknown = A === GROK && s.compat.grok === 'native' && inv.grokEnv.claudeHooks && inv.grokEnv.trust === 'unknown';
      cell = { state: 'off', mode: 'locked', reason: 'workspace', detail: A === GROK ? (unknown ? 'grokTrustUnknown' : 'grokWorkspace') : 'noWorkspaceHooks', ...(unknown ? { unknown: true, warnings: [warn('grokTrustUnknown')] } : {}), _role: 'locked' };
    } else if (A === CLAUDE && inv.claudeAllOff) cell = { state: 'off', mode: 'locked', reason: 'own', detail: 'claudeAllOff', _role: 'locked' };
    else {
      cell = { state: wsOn ? 'on' : 'off', _role: 'ws', _desired: wsOn };
      if (!inv.cwd) addUnit(unitOf(ws, A), { row: ws, desired: wsOn, re: true, virtual: true });
    }
    if (anyNative === false && cell._role === 'ws') cell.empty = true;
    cell._members = members.map(r => r.key);
    cells.set(WS_KEY, cell);
  }
  // 単位: どれかが止まるなら単位ごと止め、オンのものを渡し直す。渡し直せないオンのものは一緒に止まる（_mismatch）
  for (const [id, ms] of units) {
    const stopped = ms.some(m => !m.desired);
    for (const m of ms) {
      if (m.virtual) continue;
      const cell = cells.get(m.row.key);
      cell._unit = id;
      cell._stopped = stopped;
      if (!m.desired) cell.state = 'off';
      else if (!stopped) cell.state = 'on';
      else if (m.re) { cell.state = 'on'; cell._deliver = asDelivery(m.row, A, inv); }
      else { cell.state = 'off'; cell._mismatch = true; cell.warnings = [warn('stoppedWithOthers')]; }
    }
    if (stopped && units.size) for (const m of ms) if (m.virtual) cells.get(WS_KEY)._stopped = true;
  }
  if (ws && cells.get(WS_KEY)._role === 'ws') {
    const c = cells.get(WS_KEY);
    if (c._members.some(k => cells.get(k)?._mismatch)) c.warnings = [warn('stoppedWithOthers')];
  }
  return cells;
}

/**
 * 1 つのセルを押したときの選択（純粋）。on: 入れる | 外す。行が切れているときに入れると、その行をそのエージェントだけで入れる。
 * 戻り: 新しい選択（s.enable は Pleiad の登録のオフを入れる印。保存の前に hooks.json の enabled を入れる）
 */
export function flipAgents(s, row, A, on, inv) {
  const next = structuredClone({ off: s.off, spread: s.spread, unused: s.unused, compat: s.compat, enable: s.enable ?? [] });
  const set = (map, key, list) => { const v = agentList(list); if (v.length) map[key] = v; else delete map[key]; };
  const off = rowIsOff(row, s);
  if (row.kind === 'ws') {
    if (on && off) { next.unused = next.unused.filter(k => k !== WS_KEY); set(next.off, WS_KEY, UNIFY_TARGETS.filter(a => a !== A)); }
    else set(next.off, WS_KEY, on ? (next.off[WS_KEY] ?? []).filter(a => a !== A) : [...(next.off[WS_KEY] ?? []), A]);
    return next;
  }
  const base = baseOf(row, inv, s);
  if (on && off) {
    next.unused = next.unused.filter(k => k !== row.key);
    if (row.kind === 'reg' && !row.hook.enabled) next.enable = [...new Set([...next.enable, row.key])];
    set(next.off, row.key, base.filter(a => a !== A));
    set(next.spread, row.key, base.includes(A) ? [] : [A]);
    return next;
  }
  if (base.includes(A)) set(next.off, row.key, on ? (next.off[row.key] ?? []).filter(a => a !== A) : [...(next.off[row.key] ?? []), A]);
  else set(next.spread, row.key, on ? [...(next.spread[row.key] ?? []), A] : (next.spread[row.key] ?? []).filter(a => a !== A));
  return next;
}

/**
 * セルの押せる・押せないを決める（押すと状態が変わり、ほかのセルが黙って止まらないものだけ押せる）。
 * 押せない候補には鍵の理由を付ける（Claude はまとめて止めるので claudeAllOrNothing、Antigravity は同じ名前の定義 agySameName、Grok の互換 grokAllOrNothing）
 */
export function decideModes(inv, s, skip, A, cells = cellsFor(inv, s, skip, A)) {
  const mismatched = new Set([...cells].filter(([, c]) => c._mismatch).map(([k]) => k));
  for (const row of inv.rows) {
    const c = cells.get(row.key);
    // 作業場所の定義は作業場所の 1 行（ws:hooks）に従う。この場所の行で押せるのは「この場所で使う」だけ
    if (c?._role === 'wsMember') { c.mode = 'locked'; c.reason = 'workspace'; c.detail = c._mismatch ? 'stoppedWithOthers' : 'followsWorkspace'; continue; }
    if (!c || !['member', 'spread', 'ws'].includes(c._role)) continue;
    if (c._mismatch) { lockUnit(c, A); continue; }
    const on = c.state === 'on';
    const s2 = flipAgents(s, row, A, !on, inv);
    const c2 = cellsFor(inv, s2, skip, A);
    const after = c2.get(row.key);
    const fresh = [...c2].some(([k, x]) => x._mismatch && !mismatched.has(k));
    if (after && after.state !== c.state && !fresh) c.mode = 'toggle';
    else if (c._role === 'spread' && !c.mode) { c.mode = 'locked'; c.reason = 'own'; c.detail = 'stoppedWithOthers'; }
    else lockUnit(c, A);
    if (c.mode === 'toggle' && !on && c.needsConfirm !== true) delete c.needsConfirm;
    if (c.mode !== 'toggle' || on) delete c.needsConfirm;
  }
  return cells;
}
function lockUnit(c, A) {
  c.mode = 'locked'; c.reason = 'own';
  c.detail = A === CLAUDE ? 'claudeAllOrNothing' : A === GROK ? 'grokAllOrNothing' : A === AGY ? 'agySameName' : 'stoppedWithOthers';
}
/**
 * 行のスイッチを押したときの選択（純粋。指示・Skills の行のスイッチと同じ決まり。ADR 0337・0338）。
 *   切る: 行を unused にする（エージェントごとの選択は off・spread に覚えたまま）。
 *   入れる: unused から外して覚えた選択に戻す。どのエージェントでも動かないなら、覚えた選択を消して元の集合（登録は targets、
 *           定義はそれを自分で動かすエージェント）に戻す。ほかのエージェントへは広げない（広げるのはマスの確認だけ）。
 *   すでにオン（どれかのマスがオン）の行を入れても変えない。
 * 押せないとき: { lock: { reason, detail, agent } }。鍵つきでオンのマスが残る（切っても動き続ける）、ほかの行が黙って止まる
 * （渡し直せずに一緒に止まる。セルの押せる・押せないの decideModes と同じ物差し）、入れても動くエージェントが無い。押せるとき: { next }（s.enable つき）。
 * Devin の取り込みの止め（compat.devin: 'off'）は、Devin へ渡すものが無くなると取り込みが戻る。そのときほかの行の Devin の列が変わるのは、
 * セルを押したときと同じく事実のとおり（鍵の理由 devinImports・devinCompatOff で見せる）
 */
export function rowSwitchPlan(inv, s, skip, row, on, before = null) {
  if (row.scope === 'managed') return { lock: { reason: 'admin', detail: 'managed', agent: row.agent } };
  if (row.kind === 'grokOwn') return { lock: { reason: 'own', detail: 'grokOwn', agent: GROK } };
  const cellsAt = st => Object.fromEntries(UNIFY_TARGETS.map(A => [A, cellsFor(inv, st, skip, A)]));
  const was = before ?? cellsAt(s);
  const onAt = cs => UNIFY_TARGETS.some(A => cs[A].get(row.key)?.state === 'on');
  if (on && onAt(was) && !rowIsOff(row, s)) return { next: { ...s, enable: s.enable ?? [] } };
  const next = structuredClone({ off: s.off, spread: s.spread, unused: s.unused, compat: s.compat, enable: s.enable ?? [] });
  if (on) {
    next.unused = next.unused.filter(k => k !== row.key);
    if (row.kind === 'reg' && !row.hook.enabled) next.enable = [...new Set([...next.enable, row.key])];
  } else next.unused = [...new Set([...next.unused, row.key])].sort();
  let after = cellsAt(next);
  if (on && !onAt(after)) {
    delete next.off[row.key];
    delete next.spread[row.key];
    after = cellsAt(next);
  }
  for (const A of UNIFY_TARGETS) {
    const c = after[A].get(row.key);
    if (!on && c?.state === 'on') return { lock: { reason: c.reason ?? 'own', detail: c.detail ?? 'stoppedWithOthers', agent: A } };
    for (const [k, x] of after[A]) {
      if (k === row.key || !x._mismatch || was[A].get(k)?._mismatch) continue;
      const l = {}; lockUnit(l, A); return { lock: { reason: l.reason, detail: l.detail, agent: A } };
    }
  }
  if (on && !onAt(after)) {
    const c = UNIFY_TARGETS.map(A => [A, after[A].get(row.key)]).find(([, x]) => x?.mode === 'locked' && x.reason);
    return { lock: c ? { reason: c[1].reason, detail: c[1].detail, agent: c[0] } : { reason: 'relay', detail: 'nothingToRun', agent: row.agent ?? null } };
  }
  return { next };
}

/** 外へ出すセル（内部の印を落とす） */
export const publicCell = c => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_')));

// ---------- 移行の式 ----------
/**
 * 旧の担当（hooks.json の defaults・places）から、そのときの実効の状態を写した選択を作る（純粋。ADR 0338「移行」）。
 *   任せる: 定義は元の集合のまま。登録は off = targets（動いていなかった）。互換は native
 *   そろえる: Pleiad が止めていた定義（nativeFate が stopped）は元のエージェントを off、作業場所も off、登録は targets のまま（defaults の disabled は unused）、
 *            Grok の互換は off、Devin は渡すものがあれば off（無ければ取り込みが動いていたので native）
 *   場所ごとの担当: その場所の担当で同じ計算をして places[].agents、disabled は places[].skip
 */
export function agentsFromLegacy({ config, rows, platform = process.platform, now = new Date() }) {
  const calc = (owner, disabled, unused) => {
    const a = emptyAgents();
    if (owner === 'ply') {
      for (const r of rows) if (r.kind === 'native' && r.group === 'own' && r.fate === 'stopped') a.off[r.key] = [r.agent];
      a.off[WS_KEY] = [...HOOK_AGENTS].sort();
      if (unused) a.unused = [...new Set(disabled)].sort();
      a.compat.grok = 'off';
      a.compat.devin = planHooks({ hooks: config.hooks, owner: { disabled }, agent: DEVIN, platform }).supplied.length ? 'off' : 'native';
    } else {
      for (const h of config.hooks) { const tg = agentList(h.targets); if (tg.length) a.off[h.id] = tg; }
    }
    return a;
  };
  const def = resolveOwner(config, null).value;
  const state = { version: VERSION, ...calc(def.owner, def.disabled ?? [], true), places: {}, adoptedFrom: { owner: def.owner, at: now.toISOString() } };
  for (const [pk, p] of Object.entries(config.places ?? {})) {
    state.places[pk] = { path: p.path, skip: [...new Set(p.disabled ?? [])].sort(), agents: calc(p.owner, p.disabled ?? [], false) };
  }
  return state;
}

// ---------- 置き場と操作 ----------
/**
 * deps: { dataDir, hooksConfig, plyHooks, platform, findNode, grokHome, codexTrust(report, cwd)（一覧のときだけ。ターンでは呼ばない）, now }
 */
export function createHooksAgents({ dataDir, hooksConfig, plyHooks, platform = process.platform, findNode = async () => null,
  grokHome = process.env.GROK_HOME || path.join(os.homedir(), '.grok'), codexTrust = null, now = () => new Date() }) {
  const file = path.join(dataDir, FILE_NAME);
  let queue = Promise.resolve();
  const run = fn => { const next = queue.catch(() => {}).then(fn); queue = next; return next; };
  const unreadable = () => Object.assign(new Error(t('hooksAgents.unreadable')), { code: 'UNREADABLE' });

  // このプロセスで最後に読めた選択。ファイルが読めなくなったターンで、止めるもの・渡すものが無かったと確かに言えるかに使う（hooks.json の lastGood と同じ）
  let lastGood = null;
  async function exists() { try { await fs.stat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; return true; } }
  /** null = 移行していない。読めなければ投げる（今までの担当で動かすと、止めたはずの定義が動くため）。知らない version も読めない扱い */
  async function read() {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw unreadable(); }
    let raw;
    try { raw = JSON.parse(text); } catch { throw unreadable(); }
    const s = parseState(raw);
    if (!s) throw unreadable();
    lastGood = s;
    return s;
  }
  /**
   * 読めないファイルを、消さずに隣へ退避する（hooks-agents.broken-<時刻>.json）。中身を読まずに名前だけ変える（読めない理由が権限でも残る）。
   * 退避したら、ファイルが無い = 移行前（旧の担当の動き）に戻る。読めるファイル・無いファイルなら何もしない。戻り: 退避先のパスか null
   */
  async function moveAsideIfBroken() {
    if (!await exists()) return null;
    try { await read(); return null; } catch (e) { if (e.code !== 'UNREADABLE') throw e; }
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    let backup = path.join(dataDir, `hooks-agents.broken-${stamp}.json`);
    for (let i = 1; await fs.stat(backup).then(() => true, () => false); i++) backup = path.join(dataDir, `hooks-agents.broken-${stamp}-${i}.json`);
    await fs.rename(file, backup);
    lastGood = null;
    return backup;
  }
  async function write(state) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeAtomic(file, JSON.stringify(plainState(state), null, 2), { mode: 0o600 });
    try { await fs.chmod(file, 0o600); } catch (e) { if (process.platform !== 'win32') throw e; }
  }

  /** その場所（cwd が無ければユーザーの範囲だけ）の行。turn: true ならターンの準備（Codex の信頼は確かめない） */
  async function inventory({ cwd = null, turn = false, trust = true } = {}) {
    const config = await plyHooks.read();
    const report = await hooksConfig.scan({ cwd, scopes: cwd ? ['user', 'directory'] : ['user'], agents: HOOK_AGENTS, managed: true });
    if (!turn && codexTrust) { try { await codexTrust(report, cwd, trust); } catch {} }
    const grokEnv = await readGrokEnv(grokHome);
    const claudeAllOff = (report.files ?? []).some(f => f.agent === CLAUDE && f.allOff);
    const rows = [], byKey = new Map();
    for (const h of config.hooks) {
      const row = { key: h.id, kind: 'reg', group: 'ply', agent: h.agent, scope: 'ply', event: h.event, matcher: h.matcher ?? '', command: maskText(h.command), name: h.name, hook: h, members: [] };
      rows.push(row); byKey.set(row.key, row);
    }
    for (const e of report.entries) {
      const raw = rawOf(e);
      const command = typeof raw?.handler?.command === 'string' ? raw.handler.command : (e.command ?? '');
      const key = nativeRowKey(e, command);
      const have = byKey.get(key);
      if (have) { have.members.push({ entry: e, raw }); continue; }
      const place = ['project', 'local'].includes(e.scope) || (e.scope === 'skill' && e.skillScope === 'project');
      const row = { key, kind: 'native', group: e.scope === 'managed' ? 'admin' : place ? 'place' : 'own', agent: e.agent, scope: e.scope, event: e.event,
        matcher: e.matcher ?? null, command: e.command ?? '', path: e.path, ...(e.name ? { name: e.name } : {}), ...(e.plugin ? { plugin: e.plugin } : {}),
        ...(e.scope === 'skill' ? { skill: e.skill ?? null } : {}), entry: e, raw, rawCommand: command, members: [{ entry: e, raw }], fate: nativeFate(e) };
      rows.push(row); byKey.set(key, row);
    }
    // 写し（相手のファイルの、アダプター越しのコマンド）: 元の行の、その相手の列は写しの状態のまま（鍵）
    for (const r of rows) {
      if (r.kind !== 'native') continue;
      const p = parseAdapterCommand(r.rawCommand);
      if (!p || p.to !== r.agent) continue;
      const o = rows.find(x => x.kind === 'native' && x.agent === p.from && x.key !== r.key && x.rawCommand.trim() === p.command.trim());
      if (o) { (o.copies ??= {})[r.agent] = r; r.copyOf = o.key; }
    }
    for (const g of await grokNativeHooks(GROK, cwd, grokHome)) {
      const key = nativeRowKey(g, g.command);
      if (byKey.has(key)) continue;
      const row = { key, kind: 'grokOwn', group: 'own', agent: GROK, scope: g.scope, event: g.event, matcher: g.matcher ?? null, command: g.command, path: g.path, name: g.name, members: [] };
      rows.push(row); byKey.set(key, row);
    }
    rows.push({ key: WS_KEY, kind: 'ws', group: 'place', agent: null, scope: 'project', event: null, matcher: null, command: '', members: [] });
    byKey.set(WS_KEY, rows.at(-1));
    const agyBad = (report.files ?? []).filter(f => f.agent === AGY && (f.status === 'error' || f.partial));
    return { cwd, rows, byKey, report, config, grokEnv, claudeAllOff, agyBad, platform };
  }

  function checkLegacy(config) {
    if (config.problems?.some(p => ['hook', 'duplicate', 'tooMany'].includes(p.kind)) || config.brokenDefaults || Object.keys(config.brokenPlaces ?? {}).length) throw invalid('hooksAgents.legacyBroken');
  }
  /** 移行済みの選択。まだなら、そのときの実効の状態を写して作る（保存はしない） */
  async function current() {
    const s = await read();
    if (s) return { state: s, adopted: true };
    const inv = await inventory({ cwd: null, turn: true });
    checkLegacy(inv.config);
    return { state: agentsFromLegacy({ config: inv.config, rows: inv.rows, platform, now: now() }), adopted: false };
  }

  /** 一覧の材料。移行していなくても、移行したらこうなる形を返す（押した時点で写す） */
  async function view({ cwd = null, trust = true } = {}) {
    const { state: stored, adopted } = await current();
    const inv = await inventory({ cwd, trust });
    const { state, orphans, moved } = resolveRekeys(stored, inv);
    const eff = effectiveAt(state, cwd);
    const cells = Object.fromEntries(UNIFY_TARGETS.map(A => [A, decideModes(inv, eff.agents, eff.skip, A)]));
    return { state, stored, adopted, inv, eff, cells, orphans, moved, revision: stateRevision(state) };
  }
  /** 一覧の版（expect）の照合。書き換えた定義へ移す前と後のどちらの版でもよい（一覧を開いた場所と押した場所で、読めた組が違うことがあるため） */
  const checkExpect = (expect, stored, state) => {
    if (expect && expect !== stateRevision(stored) && expect !== stateRevision(state)) throw Object.assign(new Error(t('hooksAgents.stale')), { code: 'CONFLICT' });
  };

  /** 選択を変えて保存する。edit(agents, inv, eff) は新しい agents を返す。place があればその場所の上書きを、無ければ全体を変える */
  function change({ cwd = null, expect = null }, edit) {
    return run(async () => {
      const { state: stored } = await current();
      const inv = await inventory({ cwd });
      const { state, orphans } = resolveRekeys(stored, inv);
      checkExpect(expect, stored, state);
      const eff = effectiveAt(state, cwd);
      const target = eff.agentsFrom ? state.places[eff.agentsFrom].agents : state;
      const next = await edit({ off: target.off, spread: target.spread, unused: target.unused, compat: target.compat }, inv, eff);
      const enable = next.enable ?? [];
      delete next.enable;
      const clean = normAgents(next);
      if (eff.agentsFrom) state.places[eff.agentsFrom].agents = clean;
      else Object.assign(state, clean);
      for (const id of enable) await plyHooks.toggle(id, true);
      state.seen = nextSeen(state, inv, orphans);
      await write(state);
      return { state, place: eff.agentsFrom ? state.places[eff.agentsFrom].path : null, revision: stateRevision(state) };
    });
  }
  const pressCell = (inv, eff, key, A) => {
    const row = inv.byKey.get(key);
    if (!row) throw invalid('hooksAgents.noRow', { key });
    if (!UNIFY_TARGETS.includes(A)) throw invalid('hooksAgents.notPressable', { key, agent: A });
    const cell = decideModes(inv, eff.agents, eff.skip, A).get(key);
    if (!cell || cell.mode !== 'toggle') throw invalid('hooksAgents.notPressable', { key, agent: A });
    return { row, cell };
  };

  /** セル 1 つ（hooks.setAgent） */
  const setAgent = ({ key, agent, on, cwd = null, expect = null }) => change({ cwd, expect }, (s, inv, eff) => {
    const { row, cell } = pressCell(inv, eff, key, agent);
    if ((cell.state === 'on') === on) return s;
    return flipAgents({ ...s, enable: [] }, row, agent, on, inv);
  });
  /** 行の全体のスイッチ（hooks.setRow）。rowSwitchPlan の決まり。押せない（鍵つきでオンのマスが残るなど）なら断る */
  const setRow = ({ key, on, cwd = null, expect = null }) => change({ cwd, expect }, (s, inv, eff) => {
    const row = inv.byKey.get(key);
    if (!row) throw invalid('hooksAgents.noRow', { key });
    const plan = rowSwitchPlan(inv, { ...s, enable: [] }, eff.skip, row, on);
    if (plan.lock) throw invalid('hooksAgents.rowLocked', { key, agent: plan.lock.agent ?? '*', detail: plan.lock.detail });
    return plan.next;
  });
  /**
   * 組の 1 つのエージェントの列（押せるセルだけ。広げる確認が要るセルは入れない）か、組の全部の行のスイッチ（hooks.setGroup）。1 回の書き込み。
   * 行のスイッチは rowSwitchPlan を 1 行ずつ重ねる。押せない行が 1 つでもあれば、どれも変えずに断る（半分だけ入った状態を作らない）
   */
  const setGroup = ({ group, agent = null, on, cwd = null, expect = null }) => change({ cwd, expect }, (s, inv, eff) => {
    let cur = { ...s, enable: [] };
    const rows = inv.rows.filter(r => r.group === group && r.kind !== 'grokOwn' && r.scope !== 'managed');
    for (const row of rows) {
      if (!agent) {
        const plan = rowSwitchPlan(inv, cur, eff.skip, row, on);
        if (plan.lock) throw invalid('hooksAgents.rowLocked', { key: row.key, agent: plan.lock.agent ?? '*', detail: plan.lock.detail });
        cur = plan.next;
        continue;
      }
      const cell = decideModes(inv, cur, eff.skip, agent).get(row.key);
      if (cell?.mode === 'toggle' && (cell.state === 'on') !== on && !(on && cell.needsConfirm)) cur = flipAgents(cur, row, agent, on, inv);
    }
    return cur;
  });
  /** この場所で使う（hooks.setPlace）。reset: true は移行で書いた場所の上書き（agents）を消す */
  const setPlace = ({ place, key = null, use = true, reset = false, expect = null }) => run(async () => {
    if (typeof place !== 'string' || !path.isAbsolute(place)) throw invalid('hooksAgents.badPlace');
    const { state: stored } = await current();
    const inv = await inventory({ cwd: place, turn: true });
    const { state, orphans } = resolveRekeys(stored, inv);
    checkExpect(expect, stored, state);
    const pk = pathKey(place);
    const entry = state.places[pk] ?? { path: path.resolve(place) };
    if (reset) delete entry.agents;
    else {
      if (typeof key !== 'string' || !KEY_RE.test(key)) throw invalid('hooksAgents.noRow', { key });
      const inherited = effectiveAt(state, place).skip;
      const list = new Set(entry.skip ?? inherited);
      if (use) list.delete(key); else list.add(key);
      entry.skip = [...list].sort();
    }
    if (entry.skip || entry.agents) state.places[pk] = entry; else delete state.places[pk];
    state.seen = nextSeen(state, inv, orphans);
    await write(state);
    return { state, revision: stateRevision(state) };
  });
  /** 移行前へ戻す（ファイルを消す。旧の担当の動きへ戻る）。読めないファイルは消さずに退避する（backup に退避先） */
  const reset = () => run(async () => {
    const backup = await moveAsideIfBroken();
    if (!backup) await fs.rm(file, { force: true });
    lastGood = null;
    return { ok: true, ...(backup ? { backup } : {}) };
  });
  /** 修復（hooks.repair から）: 読めないファイルだけ退避し、移行前の動きへ戻す。読めれば何もしない。戻り: { backup } か null */
  const repair = () => run(async () => { const backup = await moveAsideIfBroken(); return backup ? { backup } : null; });

  /**
   * エージェント A・場所 cwd のターンに、何を止め・何を渡すか（実行時の材料）。移行していなければ null。
   * 戻り: { inv, cells, stop: { units, rows }, deliver: [{ hook, d, row }], unsupported, skipped, kept, s }
   */
  async function turnPlan(agent, cwd, given = null) {
    const stored = given ?? await read();
    if (!stored) return null;
    const inv = await inventory({ cwd, turn: true });
    const { state } = resolveRekeys(stored, inv);
    const eff = effectiveAt(state, cwd);
    const s = eff.agents;
    const cells = cellsFor(inv, s, eff.skip, agent);
    const stopped = [], kept = [], deliver = [], unsupported = [], skipped = [];
    const stopUnits = new Set();
    for (const row of inv.rows) {
      const c = cells.get(row.key);
      if (!c) continue;
      if ((c._role === 'member' || c._role === 'wsMember') && c._stopped) stopUnits.add(c._unit);
    }
    for (const row of inv.rows) {
      const c = cells.get(row.key);
      if (!c || row.kind === 'ws') continue;
      const native = ['member', 'wsMember', 'fixed'].includes(c._role);
      if (native) {
        const stoppedHere = c._role !== 'fixed' && stopUnits.has(c._unit);
        if (stoppedHere || c.state === 'off') stopped.push(row);
        else kept.push(row);
        if (stoppedHere && c.state === 'on' && c._deliver) deliver.push({ ...c._deliver, row });
        continue;
      }
      if (c._role === 'spread' && c.state === 'on' && c._deliver) deliver.push({ ...c._deliver, row });
      if (c._blocked) unsupported.push({ hook: row.hook, reasons: c._blocked });
      if (row.kind === 'reg' && (rowIsOff(row, s) || eff.skip.has(row.key)) && row.hook.targets.includes(agent)) skipped.push({ hook: row.hook, reason: rowIsOff(row, s) ? 'off' : 'disabledHere' });
    }
    // 二重に動かさない: 動き続ける定義と同じもの・同じ形が 2 つ渡るものは 1 つにする
    const sig = (event, matcher, command) => `${event}\0${matcher ?? ''}\0${String(command).trim()}`;
    const running = new Set();
    for (const row of kept) {
      if (!row.raw) continue;
      const c = importCandidate(row.raw);
      running.add(sig(c.value.event, c.value.matcher, c.value.command));
      const p = parseAdapterCommand(row.rawCommand);
      if (p) running.add(`from\0${p.from}\0${p.command.trim()}`);
    }
    const seen = new Set(), out = [];
    for (const x of deliver) {
      const same = x.hook.agent === agent || HOOK_EMULATED[agent] === x.hook.agent;
      const keys = [sig(x.d.event, x.d.matcher, x.hook.command), ...(same ? [sig(x.hook.event, x.hook.matcher, x.hook.command)] : [`from\0${x.hook.agent}\0${x.hook.command.trim()}`])];
      if (keys.some(k => running.has(k) || seen.has(k))) { skipped.push({ hook: x.hook, reason: 'duplicate' }); continue; }
      keys.forEach(k => seen.add(k));
      out.push(x);
    }
    return { inv, s, eff, cells, stopUnits, stopped, kept, deliver: out, unsupported, skipped, state };
  }

  /**
   * 移行済みのターンの準備（prepareHooksTurn から）。止めるものも渡すものも互換の止めも無ければ null（今までと同じ起動）。
   * 戻り: { record, runtime } か null。投げる: agy の一覧を読めない・名前がぶつかる・Skills の担当とぶつかる（HOOKS_REFUSED）
   */
  async function forTurn({ agent, cwd, ctx = {} }) {
    let plan;
    try { plan = await turnPlan(agent, cwd, ctx.given ?? null); }
    catch (e) {
      // 読めなくなった: hooks.json と同じく、最後に読めた選択でこのターンに止めるもの・渡すもの・互換の止めが何も無かったときだけ続ける。ほかは断る（UNREADABLE）
      if (e.code !== 'UNREADABLE' || !lastGood) throw e;
      const prev = await forTurn({ agent, cwd, ctx: { ...ctx, given: lastGood } });
      if (prev) throw e;
      return null;
    }
    if (!plan) return null;
    if (!UNIFY_TARGETS.includes(agent)) return null;
    const { s, stopUnits, stopped, kept, unsupported, skipped, inv } = plan;
    let supplied = plan.deliver.map(({ hook, d }) => ({ hook, d }));
    const at = (ctx.now ?? now()).toISOString?.() ?? new Date().toISOString();
    const record = { owner: 'ply', mode: 'agents', at, agent, from: plan.eff.agentsFrom ? plan.state.places[plan.eff.agentsFrom].path : null, revision: stateRevision(plan.state),
      supplied: [], unsupported: unsupported.map(unsupportedSummary), skipped: skipped.map(({ hook, reason }) => ({ id: hook.id, name: hook.name, reason })),
      stopped: stopped.map(rowSummary), kept: kept.map(rowSummary), leaks: [], unknownNative: [] };
    const adapterFor = async (to) => {
      if (!supplied.some(x => x.d.adapter)) return null;
      const found = await findNode();
      const adapterPath = await writeAdapterTo(path.join(dataDir, 'hooks-runtime'), await adapterSource());
      if (!found || !safeAdapterPath(adapterPath)) {
        const drop = supplied.filter(x => x.d.adapter);
        record.unsupported.push(...drop.map(x => unsupportedSummary({ hook: x.hook, reasons: [{ code: found ? 'adapterPath' : 'noNode' }] })));
        supplied = supplied.filter(x => !x.d.adapter);
      }
      return adapterPath;
    };
    const via = HOOK_EMULATED[agent] ? HOOK_VIA[agent] : agent === CODEX ? 'threadConfig' : agent === AGY ? 'agyFile' : 'callback';
    const summarize = () => supplied.map(x => ({ ...suppliedSummary(x), via, ...(agent === AGY ? { name: `pleiad-${x.hook.id}` } : {}) }));

    if (agent === DEVIN) {
      // 旧「そろえる」と同じく、渡すものがあるターンだけ取り込みを止める（渡すものが無ければ今までと同じ起動）
      const stopImports = s.compat.devin === 'off' && supplied.length > 0;
      if (!stopImports && !supplied.length) return null;
      if (stopImports) record.stopped.push({ agent, scope: 'compat', name: 'Devin imports', event: null, matcher: null, command: '', path: null });
      record.supplied = summarize();
      return { record, runtime: { agent, emulates: HOOK_EMULATED[agent], cwd, supplied, stopImports, record } };
    }
    if (agent === GROK) {
      const env = s.compat.grok === 'off' ? { ...GROK_COMPAT_HOOK_ENV } : stopUnits.has('grokCompat') ? { GROK_CLAUDE_HOOKS_ENABLED: GROK_COMPAT_HOOK_ENV.GROK_CLAUDE_HOOKS_ENABLED } : null;
      if (!env && !supplied.length) return null;
      const adapterPath = await adapterFor(agent);
      record.supplied = summarize();
      if (env) record.stopped.push({ agent, scope: 'compat', name: s.compat.grok === 'off' ? 'Claude Code · Cursor · Codex' : 'Claude Code', event: null, matcher: null, command: '', path: null });
      return { record, runtime: { agent, emulates: HOOK_EMULATED[agent], cwd, supplied, pluginHooks: grokHooksFile(supplied, { adapterPath }), ...(env ? { compatHookEnv: env } : {}), record } };
    }
    if (HOOK_EMULATED[agent]) {
      if (!supplied.length) return null;
      record.supplied = summarize();
      return { record, runtime: { agent, emulates: HOOK_EMULATED[agent], cwd, supplied, record } };
    }
    const stopping = stopped.filter(r => r.kind !== 'grokOwn' && fixedOf(r, agent) === null && plan.cells.get(r.key)?._role !== 'fixed');
    if (agent === CLAUDE) {
      const stopAll = stopUnits.has(CLAUDE);
      if (!stopAll && !supplied.length) return null;
      record.supplied = summarize();
      record.stopAll = stopAll;
      if (!stopAll) record.stopped = [];
      return { record, runtime: { agent, cwd, supplied, stopAll, record } };
    }
    if (agent === CODEX) {
      const stopRows = [];
      for (const r of stopping) for (const m of r.members) if (m.entry && Number.isInteger(m.entry.group)) stopRows.push({ path: m.entry.path, event: m.entry.event, group: m.entry.group, handler: m.entry.handler });
      // 作業場所をまとめて止めたときは、Pleiad が読めなかった定義も止める（出どころごと）
      if (!plan.s.unused.includes(WS_KEY) && has(plan.s.off, WS_KEY, agent) || plan.s.unused.includes(WS_KEY)) stopRows.push({ source: 'project' });
      if (!stopRows.length && !supplied.length) return null;
      const adapterPath = await adapterFor(agent);
      const { table, index } = codexHooksTable(supplied, { adapterPath, node: 'node' });
      record.supplied = summarize();
      return { record, runtime: { agent, cwd, supplied, table, index, stopRows, record } };
    }
    // Antigravity: 止める名前（単位ごと）と、渡すもの（pleiad-<行>）
    const names = [...new Set(stopping.filter(r => typeof r.name === 'string').map(r => r.name))];
    if (!names.length && !supplied.length) return null;
    if (names.length && inv.agyBad.length) throw refuse('hooksUnify.agyStopListIncomplete', { path: inv.agyBad[0].path, error: inv.agyBad[0].error ?? '' });
    if (ctx.context?.delivered && ctx.context.owners?.skill === 'ply') throw refuse('hooksUnify.agySkillsConflict');
    const adapter = await adapterSource();
    let fileOut;
    try { fileOut = agyHooksFile({ supplied, nativeNames: names, adapterName: adapter.name }); }
    catch (e) { if (e.code === 'AGY_NAME_COLLISION') throw refuse('hooksUnify.agyNameCollision', { name: e.name }); throw e; }
    record.supplied = summarize();
    return { record, runtime: { agent, cwd, supplied, file: fileOut, adapter, names, shape: sha(JSON.stringify(fileOut)).slice(0, 16), record } };
  }

  /**
   * このエージェントのターンで動く Hook（第 2 段の agy の inheritCustomizations が使う入口）。移行していなければ null。
   * 戻り: [{ key, via: 'native'|'pleiad', agent（定義の出どころ）, scope, event, matcher, command（伏せ字） }]
   */
  async function hooksForTurn(agent, cwd) {
    const plan = await turnPlan(agent, cwd);
    if (!plan) return null;
    return [
      ...plan.kept.map(r => ({ key: r.key, via: 'native', agent: r.agent, scope: r.scope, event: r.event, matcher: r.matcher ?? null, command: r.command })),
      ...plan.deliver.map(x => ({ key: x.row.key, via: 'pleiad', agent: x.hook.agent, scope: x.row.scope, event: x.d.event, matcher: x.d.matcher ?? null, command: maskText(x.hook.command) })),
    ];
  }

  /**
   * その場所の Devin のターンで、Pleiad が Hook を渡すため Devin の取り込み（read_config_from）が全部止まるか。
   * 移行済みは forTurn の stopImports（compat.devin: 'off' で渡すものがある）、移行前は旧「そろえる」（担当が ply で渡すものがある。devinTurnConfig の既定）と同じ規則。
   * 指示・Skills の表（core/context-doc-matrix.mjs の devinImportsStopped）が、取り込む物の Devin のマスを鍵つきのオフに見せるのに使う。
   * 読めない・分からないときは false（表は今までどおり。ターンは別に断る）
   */
  async function devinImportsStopped(cwd) {
    try {
      const stored = await read();
      if (!stored) {
        const owner = await plyHooks.resolve(cwd);
        return owner?.owner === 'ply' && planHooks({ hooks: owner.hooks, owner, agent: DEVIN, platform }).supplied.length > 0;
      }
      if (effectiveAt(stored, cwd).agents.compat?.devin !== 'off') return false;
      const plan = await turnPlan(DEVIN, cwd, stored);
      return Boolean(plan && plan.s.compat?.devin === 'off' && plan.deliver.length > 0);
    } catch { return false; }
  }

  /**
   * 設定 › プラグイン › Hooks の一覧（hooks.matrix）。外部 MCP の一覧（context.mcpMatrix）と同じ形: 行 × エージェントのセル。
   * cwd があればその場所で効く選択（場所の上書き・この場所で使わない）と、その場所の作業場所の定義の行を並べる
   */
  async function matrix({ cwd = null, trust = true } = {}) {
    let v;
    try { v = await view({ cwd, trust }); }
    catch (e) {
      // 読めない: 投げずに、画面が直す操作（hooks.repair・hooks.resetAgents）を出せる形で返す。止めたはずの Hook が動かないよう、会話は断ったまま
      if (e.code !== 'UNREADABLE') throw e;
      return { unreadable: true, error: e.message, repair: ['hooks.repair', 'hooks.resetAgents'], agents: [...UNIFY_TARGETS].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)),
        adopted: true, revision: '', cwd, place: null, skipFrom: null, compat: null, grok: null, claudeAllOff: false, trustPending: false, groups: [], rows: [], orphans: [] };
    }
    await keepSeen(v);
    const { inv, eff, cells } = v;
    const s = eff.agents;
    const before = Object.fromEntries(UNIFY_TARGETS.map(A => [A, cellsFor(inv, s, eff.skip, A)]));
    const rows = inv.rows.map(row => {
      const byAgent = Object.fromEntries(UNIFY_TARGETS.map(A => [A, publicCell(cells[A].get(row.key) ?? { state: 'off', mode: 'none' })]));
      const pressable = !(row.scope === 'managed' || row.kind === 'grokOwn');
      const rowOn = Object.values(byAgent).some(c => c.state === 'on');
      const lock = rowSwitchPlan(inv, s, eff.skip, row, !rowOn, before).lock ?? null;
      const out = { key: row.key, kind: row.kind, group: row.group, agent: row.agent, scope: row.scope, event: row.event, matcher: row.matcher ?? null,
        command: row.command ? maskText(row.command) : '', ...(row.name ? { name: row.name } : {}), ...(row.path ? { path: row.path } : {}),
        ...(row.plugin ? { plugin: row.plugin } : {}), ...(row.copyOf ? { copyOf: row.copyOf } : {}),
        // 行の全体のスイッチ（MCP と同じく、どれかのセルが入っていれば入り）。切ってもエージェントごとの選択は覚えたまま
        on: rowOn, unused: s.unused.includes(row.key) || (row.kind === 'reg' && !row.hook.enabled),
        // switchable: 行のスイッチを押せるか（rowSwitchPlan。押しても変わらない・ほかが黙って変わるなら false）。switchLock: そのときの鍵の理由
        switchable: !lock, ...(lock ? { switchLock: lock } : {}),
        // 場所ごと: この場所で使う（cwd があるときだけ）
        ...(cwd && pressable ? { here: { use: !eff.skip.has(row.key) } } : {}),
        // scanIds: hooks.scan の行の id（同じ定義が 2 つあれば 2 つ）。画面はこれで編集のシート・行の詳細と結ぶ（中身で突き合わせない）
        ...(row.kind === 'native' ? { status: row.fate, scanIds: row.members.map(m => m.entry?.id).filter(x => typeof x === 'string') } : {}),
        ...(row.kind === 'reg' ? { targets: row.hook.targets, enabled: row.hook.enabled } : {}),
        cells: byAgent };
      return out;
    });
    return { agents: [...UNIFY_TARGETS].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)), adopted: v.adopted, revision: v.revision, cwd,
      place: eff.agentsFrom ? v.state.places[eff.agentsFrom].path : null, skipFrom: eff.skipFrom ? v.state.places[eff.skipFrom].path : null,
      compat: s.compat, grok: inv.grokEnv, claudeAllOff: inv.claudeAllOff, trustPending: inv.report.trustPending === true,
      groups: ['ply', 'own', 'place', 'admin'].filter(g => rows.some(r => r.group === g)), rows,
      // 行き先の無くなった選択（外した・広げた定義を書き換えて、どれに当たるか決められない・消えた）。黙って捨てず、画面が出す
      orphans: v.orphans.map(o => ({ key: o.key, agent: o.agent, scope: o.scope, path: o.path, event: o.event, reason: o.reason, candidates: o.candidates,
        off: o.off, spread: o.spread, unused: o.unused, places: o.places })) };
  }
  /** 一覧を開いたときに、書き換えた定義へ移した選択と、覚えた組を保存する（選択の意味は変えない。版も変えない）。保存する間にファイルが変わっていれば何もしない */
  async function keepSeen(v) {
    if (!v.adopted) return;
    const seen = nextSeen(v.state, v.inv, v.orphans);
    if (!v.moved.length && JSON.stringify(seen) === JSON.stringify(v.stored.seen ?? [])) return;
    await run(async () => {
      const cur = await read().catch(() => null);
      if (cur && JSON.stringify(plainState(cur)) === JSON.stringify(plainState(v.stored))) await write({ ...v.state, seen });
    });
  }

  return { file, exists, read, current, inventory, view, matrix, setAgent, setRow, setGroup, setPlace, reset, repair, turnPlan, forTurn, hooksForTurn, devinImportsStopped };
}
