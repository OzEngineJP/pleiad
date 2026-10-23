// 委譲先の自動選択（docs/agent-delegation.md「委譲先の自動選択」。決定は docs/adr/0022-delegation-routing.md）。
//
// ここはプロセスも HTTP も起こさない純粋な関数だけを置く。難しさを自動で決めるモデル（HTTP）は core/delegation-judges.mjs、
// 使用量の取り置き（定期的な取得）は core/delegation-usage.mjs。「古い」の閾値（STALE_MS）はそちらの定数を使う。
//
//   種類（kind）   … 親のエージェントが ply_delegate で申告する
//   難しさ          … 自動選択のモデルの 6 つの手がかり（SIGNALS）から規則（difficultyOf）で数える
//   段（tier）      … 種類 × 難しさの表（table）
//   委譲先          … 段の候補を左から、使用量の枠で飛ばしながら選ぶ（route）。無ければ 1 つ上の段へ

import { STALE_MS } from './delegation-usage.mjs';
// 思考の強さの語彙と合わせ方は画面と同じもの（web/delegation-effort.mjs）
import { EFFORT_LEVELS, fitEffort } from '../web/delegation-effort.mjs';

export { EFFORT_LEVELS, fitEffort };

export const KINDS = Object.freeze(['trivial', 'mechanical', 'investigate', 'implement', 'review', 'design', 'ux_change', 'ux_new', 'visual']);
export const DIFFICULTIES = Object.freeze(['low', 'mid', 'high']);
export const TIERS = Object.freeze(['t1', 't2', 't3', 't4', 'tv']);
/** 上がっていく段の順。tv（クリエイティブ）はこの列に入らず、上がらない */
const LADDER = ['t1', 't2', 't3', 't4'];
export const JUDGES = Object.freeze(['jev', 'qwen', 'none']);

// 難しさの手がかり（v3）。英語の文面がそのまま自動選択のモデルへの問いになる。閾値は Jev の「はい」の確率を真偽に分ける線
export const SIGNALS = Object.freeze(['diagnose', 'choose', 'long_procedure', 'many_parts', 'writes_shared', 'security_gate']);
export const QUESTIONS = Object.freeze({
  diagnose: 'The task is to find the cause of a bug, failure, or unexpected behavior, and the cause is not already stated in the request. Reading documents, listing facts, or reviewing against given criteria is not this.',
  choose: 'The child must choose between approaches, designs, or recommendations, and the request does not already fix that choice. Small implementation details (names, test style, minor values) do not count.',
  long_procedure: 'The work needs many dependent steps (roughly six or more, such as starting servers or setting up environments), and a failure midway must be recovered by the child itself.',
  many_parts: 'The work reads or changes many separate parts: roughly ten or more files, or three or more separate screens, subsystems, or services. Bulk edits that apply one fixed rule to many files do not count.',
  writes_shared: 'The task writes to something shared, production, public, or external (shared documents or databases, deployed services, pushes, messages to people), or deletes data that cannot be restored. Local files and local commits do not count.',
  security_gate: 'The result is the final check on security, privacy, or safety, such as a security review before release or a change to safety requirements.',
});
export const JEV_THRESHOLDS = Object.freeze({ diagnose: 0.5, choose: 0.31, long_procedure: 0.685, many_parts: 0.68, writes_shared: 0.5, security_gate: 0.19 });
/** 「Jev が迷った」とみなす幅（閾値 ± これ） */
export const JEV_UNSURE_BAND = 0.15;

export const DEFAULTS = Object.freeze({
  enabled: true,
  judgeByKind: Object.freeze({ trivial: 'jev', mechanical: 'jev', investigate: 'jev', implement: 'jev', review: 'jev',
    design: 'jev', ux_change: 'none', ux_new: 'none', visual: 'none' }),
  escalateToQwen: false,
  avoidPercent: 80,
  paceLimit: 1.2,
  tiers: Object.freeze({
    t1: Object.freeze(['antigravity:gemini-3.8-flash-high', 'claude:haiku']),
    t2: Object.freeze(['antigravity:gemini-3.8-flash-high', 'codex:gpt-6-luna', 'antigravity:claude-opus-4-6-thinking', 'claude:sonnet']),
    t3: Object.freeze(['codex:gpt-6-sol', 'claude:sonnet']),
    t4: Object.freeze(['claude:opus', 'claude:fable']),
    tv: Object.freeze(['codex:gpt-6-astra']),
  }),
  table: Object.freeze({
    trivial: Object.freeze(['t1', 't1', 't2']), mechanical: Object.freeze(['t1', 't2', 't3']),
    investigate: Object.freeze(['t2', 't3', 't4']), implement: Object.freeze(['t2', 't3', 't4']), review: Object.freeze(['t2', 't3', 't4']),
    design: Object.freeze(['t3', 't4', 't4']), ux_change: Object.freeze(['t4', 't4', 't4']),
    ux_new: Object.freeze(['t4', 't4', 't4']), visual: Object.freeze(['tv', 'tv', 'tv']),
  }),
  // 段ごとの子の思考の強さ（ADR 0164）。'*' は段の既定、候補の id（backend:model）はその候補だけの上書き。'' は会話の既定に従う。
  // 創作（tv）は強さの当たりが未確認なので会話の既定に従う
  efforts: Object.freeze({
    t1: Object.freeze({ '*': 'low' }), t2: Object.freeze({ '*': 'medium' }), t3: Object.freeze({ '*': 'medium' }),
    t4: Object.freeze({ '*': 'high' }), tv: Object.freeze({ '*': '' }),
  }),
});
/** 週次の枠のペース（使用率 ÷ 経過率）を見始める経過率（%） */
export const PACE_MIN_ELAPSED = 20;
const WEEK_MINUTES = 10080;

/** 登録したアカウントの id の形（Claude の acct-…・Codex / OpenCode の acct-…。core/claude-accounts.mjs と同じ） */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 候補の id。`backend:model` と `backend@<アカウント id>:model`（ADR 0264）。最初の `:` で分け、前半に `@` があればその後ろがアカウント。
 * model に `:`・`@` が入ってもそのまま。account は `@` が無ければ null（アカウントを持てるエージェントではログイン中のアカウント）
 */
export function parseCandidate(id) {
  const s = typeof id === 'string' ? id : '';
  const at = s.indexOf(':');
  if (at <= 0 || at === s.length - 1 || s.length > 240 || /[\x00-\x1f\x7f\s]/.test(s)) return null;
  const head = s.slice(0, at), model = s.slice(at + 1);
  const mark = head.indexOf('@');
  if (mark < 0) return { backend: head, model, account: null };
  const account = head.slice(mark + 1);
  if (mark === 0 || !ACCOUNT_ID.test(account)) return null;
  return { backend: head.slice(0, mark), model, account };
}

/** 候補の id を組む。account が ''・null（ログイン中・アカウントを持たない）なら `backend:model` */
export function candidateId(backend, model, account = null) {
  return account ? `${backend}@${account}:${model}` : `${backend}:${model}`;
}

/** 段に入っているアカウント（backend ごとの Set。ログイン中は ''）。アカウントを持てるエージェントの、自動の選択の対象 */
export function tierAccounts(settings, backend) {
  const out = new Set();
  for (const tier of TIERS) for (const c of settings?.tiers?.[tier] ?? []) {
    const parsed = parseCandidate(c);
    if (parsed?.backend === backend) out.add(parsed.account ?? '');
  }
  return out;
}

/** 設定の検証で断る理由。code は辞書のキー（server の routing.settings.<code>）、detail は差し込む値 */
export class RoutingSettingsError extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}

/** 設定から外した項目。前の版で保存した prefs に残っていても、保存（strict）で断らずに読み捨てる */
export const RETIRED_KEYS = Object.freeze(['staleMinutes']);

/**
 * 前の版の Cerebras の自動選択の設定を、OpenRouter の Qwen の名前へ直す（Cerebras の直の経路は 2026-10-09 に廃止。ADR 0177）。
 * judgeByKind の cerebras は qwen に、escalateToCerebras は escalateToQwen に（両方あれば今の名前を残す）。changed は直したか
 */
export function migrateLegacySettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { raw, changed: false };
  const out = { ...raw };
  let changed = false;
  if (Object.hasOwn(out, 'escalateToCerebras')) {
    if (out.escalateToQwen === undefined) out.escalateToQwen = out.escalateToCerebras;
    delete out.escalateToCerebras;
    changed = true;
  }
  const byKind = out.judgeByKind;
  if (byKind && typeof byKind === 'object' && !Array.isArray(byKind) && Object.values(byKind).includes('cerebras')) {
    out.judgeByKind = Object.fromEntries(Object.entries(byKind).map(([kind, judge]) => [kind, judge === 'cerebras' ? 'qwen' : judge]));
    changed = true;
  }
  return { raw: out, changed };
}

/**
 * prefs.json の delegationRouting を、既定値で補った完全な形にする。
 * strict なら不正な値を RoutingSettingsError で断る（画面からの保存）。そうでなければ不正な項目だけ既定に戻す（読むとき）
 */
export function normalizeSettings(raw, { strict = false } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? migrateLegacySettings(raw).raw : {};
  const fail = (code, detail) => { if (strict) throw new RoutingSettingsError(code, detail); };
  const out = { enabled: DEFAULTS.enabled, judgeByKind: { ...DEFAULTS.judgeByKind }, escalateToQwen: DEFAULTS.escalateToQwen,
    avoidPercent: DEFAULTS.avoidPercent, paceLimit: DEFAULTS.paceLimit,
    tiers: Object.fromEntries(Object.entries(DEFAULTS.tiers).map(([k, v]) => [k, [...v]])),
    table: Object.fromEntries(Object.entries(DEFAULTS.table).map(([k, v]) => [k, [...v]])),
    efforts: Object.fromEntries(Object.entries(DEFAULTS.efforts).map(([k, v]) => [k, { ...v }])) };
  for (const key of Object.keys(src)) if (!Object.hasOwn(out, key) && !RETIRED_KEYS.includes(key)) fail('unknownKey', { key });
  for (const key of ['enabled', 'escalateToQwen']) {
    if (src[key] === undefined) continue;
    if (typeof src[key] === 'boolean') out[key] = src[key]; else fail('notBoolean', { key });
  }
  const numbers = { avoidPercent: [1, 100], paceLimit: [0.1, 10] };
  for (const [key, [min, max]] of Object.entries(numbers)) {
    if (src[key] === undefined) continue;
    const v = src[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) out[key] = v; else fail('outOfRange', { key, min, max });
  }
  if (src.judgeByKind !== undefined) {
    if (!src.judgeByKind || typeof src.judgeByKind !== 'object' || Array.isArray(src.judgeByKind)) fail('notObject', { key: 'judgeByKind' });
    else for (const [kind, judge] of Object.entries(src.judgeByKind)) {
      if (!KINDS.includes(kind)) fail('unknownKind', { key: 'judgeByKind', kind });
      else if (!JUDGES.includes(judge)) fail('unknownJudge', { kind, judge: String(judge) });
      else out.judgeByKind[kind] = judge;
    }
  }
  if (src.tiers !== undefined) {
    if (!src.tiers || typeof src.tiers !== 'object' || Array.isArray(src.tiers)) fail('notObject', { key: 'tiers' });
    else for (const [tier, list] of Object.entries(src.tiers)) {
      if (!TIERS.includes(tier)) { fail('unknownTier', { tier }); continue; }
      if (!Array.isArray(list) || list.length > 20 || list.some(c => !parseCandidate(c)) || new Set(list).size !== list.length) { fail('badCandidates', { tier }); continue; }
      out.tiers[tier] = [...list];
    }
  }
  if (src.table !== undefined) {
    if (!src.table || typeof src.table !== 'object' || Array.isArray(src.table)) fail('notObject', { key: 'table' });
    else for (const [kind, row] of Object.entries(src.table)) {
      if (!KINDS.includes(kind)) { fail('unknownKind', { key: 'table', kind }); continue; }
      if (!Array.isArray(row) || row.length !== 3 || row.some(tier => !TIERS.includes(tier))) { fail('badRow', { kind }); continue; }
      out.table[kind] = [...row];
    }
  }
  if (src.efforts !== undefined) {
    if (!isPlain(src.efforts)) fail('notObject', { key: 'efforts' });
    else for (const [tier, row] of Object.entries(src.efforts)) {
      if (!TIERS.includes(tier)) { fail('unknownTier', { tier }); continue; }
      if (!isPlain(row) || Object.keys(row).length > 40) { fail('badEfforts', { tier }); continue; }
      const next = { ...out.efforts[tier] };
      for (const [key, value] of Object.entries(row)) {
        // 保存では形だけを見る。そのモデルが持つ強さかは、子を作るときに合わせる（モデルの一覧は場所・ログインで変わる）
        if (key !== '*' && !parseCandidate(key)) { fail('badEffortKey', { tier, key: key.slice(0, 80) }); continue; }
        if (value !== '' && !EFFORT_LEVELS.includes(value)) { fail('badEffort', { tier, value: String(value).slice(0, 40) }); continue; }
        next[key] = value;
      }
      out.efforts[tier] = next;
    }
  }
  // 段から外した候補の上書きは持ち越さない（外して入れ直した候補に前の上書きが付かない）
  for (const tier of TIERS) for (const key of Object.keys(out.efforts[tier])) if (key !== '*' && !out.tiers[tier].includes(key)) delete out.efforts[tier][key];
  return out;
}
const isPlain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * 保存する delegationRouting の efforts から、段に無い候補の上書きと、既定と同じ段の行を落とす。
 * 保存の形（raw）は利用者が変えた項目だけなので、外した候補の上書きを残さない。空になれば undefined
 */
export function pruneEfforts(rawEfforts, settings) {
  if (!isPlain(rawEfforts)) return undefined;
  const out = {};
  for (const [tier, row] of Object.entries(rawEfforts)) {
    if (!TIERS.includes(tier) || !isPlain(row)) continue;
    const kept = Object.fromEntries(Object.entries(row).filter(([key]) => key === '*' || (settings.tiers[tier] ?? []).includes(key)));
    const merged = { ...DEFAULTS.efforts[tier], ...kept };
    const sameAsDefault = Object.keys(merged).length === Object.keys(DEFAULTS.efforts[tier]).length && Object.entries(DEFAULTS.efforts[tier]).every(([k, v]) => merged[k] === v);
    if (!sameAsDefault) out[tier] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 難しさの規則（v3・規則 A）。security_gate → high。それ以外は diagnose / choose / long_procedure / many_parts の
 * はいの数で 0 → low、1〜2 → mid、3〜4 → high。writes_shared がはいで low なら mid
 */
export function difficultyOf(signals) {
  if (!validSignals(signals)) throw new Error('invalid signals');
  if (signals.security_gate) return 'high';
  const count = ['diagnose', 'choose', 'long_procedure', 'many_parts'].filter(k => signals[k]).length;
  if (count >= 3) return 'high';
  return count >= 1 || signals.writes_shared ? 'mid' : 'low';
}
export function validSignals(signals) {
  return Boolean(signals) && typeof signals === 'object' && !Array.isArray(signals)
    && Object.keys(signals).length === SIGNALS.length && SIGNALS.every(k => typeof signals[k] === 'boolean');
}

// ---- 使用量 ------------------------------------------------------------------

/** 枠の今の使用率。リセット時刻を過ぎた枠は使い直しが始まっているので 0 とみなす。分からなければ null */
function usedNow(w, now) {
  if (w.resetsAt != null && Number.isFinite(new Date(w.resetsAt).getTime()) && new Date(w.resetsAt).getTime() <= now) return w.resetRequiresRefresh ? null : 0;
  return typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? w.usedPercent : null;
}
/** 枠の経過率（%）。期間とリセット時刻から出す。出せない・範囲外なら null */
export function elapsedPercent(w, now) {
  const reset = w.resetsAt == null ? NaN : new Date(w.resetsAt).getTime();
  if (!Number.isFinite(reset) || !(w.minutes > 0)) return null;
  const span = w.minutes * 60_000;
  const elapsed = (now - (reset - span)) / span * 100;
  return elapsed >= 0 && elapsed <= 100 ? elapsed : null;
}

const words = s => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const squash = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const claudeFamily = s => /(fable|opus|sonnet|haiku)/i.exec(String(s ?? ''))?.[1].toLowerCase() ?? null;
/** agy の使用枠のグループ名で、モデルの系統を指す語 */
const AGY_FAMILIES = ['gemini', 'claude', 'gpt'];
/** agy のグループ名にある、モデルを指さない汎用の語（'Claude and GPT models' の 'and'・'models' など） */
const AGY_GROUP_GENERIC = new Set(['model', 'models', 'and', 'the']);

/**
 * その候補に効く枠。
 *   claude      … 全体の枠（5 時間・週次）と、そのモデルの系統の週次（seven_day_opus / model_scoped）
 *   codex       … 主の枠（limitId が codex か無し）と、名前がそのモデルに当たる追加の枠
 *   antigravity … モデル名の語をいちばん多く含むグループの枠（gemini-* → Gemini …、claude-* / gpt-* → Claude and GPT …）。
 *     専用の枠（'Gemini 4 Argon' など）は、系統・汎用の語を除いた名前の語が全部モデルの id に入るときだけ当たる
 *   接続先ごとの枠（provider を持つ枠。OpenCode のつないだ接続先）… モデルの id の接続先（「接続先/モデル」の前半）の枠だけ
 */
export function windowsFor(backend, model, windows = []) {
  const list = Array.isArray(windows) ? windows : [];
  if (list.some(w => w.provider)) {
    const provider = String(model ?? '').split('/')[0];
    return list.filter(w => !w.provider || w.provider === provider);
  }
  if (backend === 'claude') {
    const family = claudeFamily(model);
    return list.filter(w => !w.model || (family && claudeFamily(w.model) === family));
  }
  if (backend === 'codex') {
    const matches = name => Boolean(name) && (squash(model).includes(name) || name.includes(squash(model)));
    return list.filter(w => !w.limitId || w.limitId === 'codex' || matches(squash(w.limitName || w.limitId)));
  }
  if (backend === 'antigravity') {
    const modelWords = new Set(words(model));
    const family = AGY_FAMILIES.find(f => modelWords.has(f));
    if (!family) return [];
    // 一部の語しか当たらない専用の枠（'Gemini 4 Argon'）を汎用の枠（'Gemini Models'）と同点で並べて混ぜないよう、
    // 系統・汎用の語を除いた名前の語（'4'・'argon'）が全部モデルの id に入るグループだけを候補にする
    const scored = [...new Set(list.map(w => w.group).filter(Boolean))]
      .map(g => [g, words(g)])
      .filter(([, gwords]) => gwords.includes(family)
        && gwords.every(x => AGY_FAMILIES.includes(x) || AGY_GROUP_GENERIC.has(x) || modelWords.has(x)))
      .map(([g, gwords]) => [g, gwords.filter(x => modelWords.has(x)).length]);
    if (!scored.length) return [];
    const best = Math.max(...scored.map(([, s]) => s));
    const groups = new Set(scored.filter(([, s]) => s === best).map(([g]) => g));
    return list.filter(w => groups.has(w.group));
  }
  return list;
}

/**
 * 枠の集まりで使えるか。{ ok, reason?, window? }。
 *   どれかの枠が 100% 以上 → quota_full（使えない）。5 時間以外が後回しの線以上 → quota_high
 *   週次の枠のペースが上限を超える（経過率 20% 未満は見ない）→ pace_high
 *   経過率が出せない週次の枠は、使用率が 20% × 上限以下ならペースで後回しにならず、超えれば pace_unknown
 *   5 時間以外の使用率が分からない・枠が 1 つも無い → usage_unknown
 */
export function judgeWindows(windows, { now, avoidPercent, paceLimit }) {
  if (!windows.length) return { ok: false, reason: 'usage_unknown' };
  const rows = windows.map(w => ({ w, used: usedNow(w, now) }));
  const full = rows.filter(r => r.used >= 100).sort((a, b) => b.used - a.used)[0];
  if (full) return { ok: false, reason: 'quota_full', window: brief(full.w, full.used) };
  const priorityRows = rows.filter(r => r.w.minutes !== 300);
  const unknown = priorityRows.find(r => r.used == null);
  if (unknown) return { ok: false, reason: 'usage_unknown', window: brief(unknown.w, null) };
  const high = priorityRows.filter(r => r.used >= avoidPercent).sort((a, b) => b.used - a.used)[0];
  if (high) return { ok: false, reason: 'quota_high', window: brief(high.w, high.used) };
  for (const { w, used } of rows) {
    if (w.minutes !== WEEK_MINUTES) continue;
    const elapsed = elapsedPercent(w, now);
    if (elapsed == null) {
      if (used > PACE_MIN_ELAPSED * paceLimit) return { ok: false, reason: 'pace_unknown', window: brief(w, used) };
      continue;
    }
    if (elapsed < PACE_MIN_ELAPSED) continue;
    const pace = used / elapsed;
    if (pace > paceLimit) return { ok: false, reason: 'pace_high', window: { ...brief(w, used), pace: round(pace, 2), elapsedPercent: round(elapsed, 1) } };
  }
  return { ok: true };
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const brief = (w, used) => ({ label: w.label ?? null, minutes: w.minutes ?? null, usedPercent: used == null ? null : round(used, 1) });

/** 週次のペース（アカウントの選び分け用）。分からなければ Infinity（後ろに回す） */
function weeklyPace(windows, now) {
  const weekly = windows.filter(w => w.minutes === WEEK_MINUTES && !w.model && !w.limitName);
  const paces = weekly.map(w => { const used = usedNow(w, now), elapsed = elapsedPercent(w, now); return used == null ? Infinity : elapsed ? used / elapsed : used / 100; });
  return paces.length ? Math.max(...paces) : Infinity;
}
function fiveHour(windows, now) {
  const used = windows.filter(w => w.minutes === 300).map(w => usedNow(w, now)).filter(v => v != null);
  return used.length ? Math.max(...used) : Infinity;
}

const SOFT_REASONS = new Set(['quota_high', 'pace_high', 'pace_unknown', 'usage_unknown', 'usage_stale']);
const selectable = verdict => SOFT_REASONS.has(verdict.reason)
  ? { ...verdict, ok: true, deferred: true } : verdict;
const maxUsage = (windows, now) => Math.max(...(windows ?? []).filter(w => w.minutes !== 300).map(w => usedNow(w, now)).filter(v => v != null), 0);
const pressure = (a, b, now) =>
  Number(['usage_unknown', 'usage_stale'].includes(a.reason)) - Number(['usage_unknown', 'usage_stale'].includes(b.reason))
  || (a.maxUsed ?? maxUsage(a.windows, now)) - (b.maxUsed ?? maxUsage(b.windows, now))
  || (a.weeklyRate ?? weeklyPace(a.windows ?? [], now)) - (b.weeklyRate ?? weeklyPace(b.windows ?? [], now))
  || fiveHour(a.windows ?? [], now) - fiveHour(b.windows ?? [], now);

/**
 * 2 つのアカウントが同じ人か（組織 organizationUuid とメールの両方が分かって一致する）。ログイン中のアカウントの中身が
 * 登録したアカウントと同じ人なら、設定画面は「ログイン中のアカウント（personal）」と添える（ADR 0264）。
 * どちらかが分からなければ同じとみなさない（docs/agent-delegation.md）
 */
export function sameIdentity(a, b) {
  return Boolean(a?.org && b?.org && a?.email && b?.email && a.org === b.org && a.email.toLowerCase() === b.email.toLowerCase());
}

/**
 * 1 つの候補を見る。{ ok, reason?, detail?, account?, accountLabel?, window?, windows?, checkedAt }
 * detail は unavailable の中身（画面が「使えない（入っていない）」と添える）: disabled（エージェントが有効でない）・
 * not_installed（CLI が入っていない）・no_token（登録したアカウントにトークンが無い）・no_account（候補のアカウントが登録に無い）
 * usage は core/delegation-usage.mjs の snapshot()：
 *   { [backend]: { available, checkedAt, windows, accounts?: [{ account, label, windows, identity, runnable }], models: { [model]: bool } } }
 * 候補はアカウント 1 つの単位（ADR 0264）。アカウントを登録したエージェントでは、候補のアカウント（`@` が無ければログイン中）の行だけを見て、
 * 使えなくてもほかのアカウントへは落とさない（route が次の候補へ進む）
 * blocked(backend, model, account) は、上限で再試行を待っている・上限で止まったばかりの枠（ADR 0229）。
 *   { reason: 'retry_waiting' | 'recently_limited', until? }（until は戻る見込みの時刻 ms）を返せば、その枠は使えない
 */
export function checkCandidate(candidate, { usage, settings, now, blocked = () => null }) {
  const parsed = parseCandidate(candidate);
  const entry = parsed ? usage?.[parsed.backend] : null;
  // 使用量をまだ一度も取っていない（取り置きが空）ときは、有効かどうかも分からないので中身を付けない
  if (!parsed || !entry?.available) return { ok: false, reason: 'unavailable', ...(!parsed ? {} : entry ? { detail: 'not_installed' } : Object.keys(usage ?? {}).length ? { detail: 'disabled' } : {}),
    ...(parsed?.account ? { account: parsed.account } : {}) };
  const checkedAt = entry.checkedAt ?? null;
  const policy = { now, avoidPercent: settings.avoidPercent, paceLimit: settings.paceLimit };
  // アカウントを登録したエージェント（ADR 0222）: 候補のアカウントの行だけ
  if (Array.isArray(entry.accounts)) {
    const row = entry.accounts.find(a => a.account === (parsed.account ?? ''));
    if (!row) return { ok: false, reason: 'unavailable', detail: 'no_account', account: parsed.account ?? '', accountLabel: null, checkedAt };
    const labelled = { account: row.account, accountLabel: row.label ?? null };
    if (entry.models?.[parsed.model] !== true) return { ok: false, reason: 'model_unknown', ...labelled, checkedAt };
    return { ...labelled, ...assessRow(parsed.backend, parsed.model, row, { checkedAt, policy, settings, now, blocked }) };
  }
  // 登録が無い（または持てない）エージェントに、アカウントを書いた候補
  if (parsed.account) return { ok: false, reason: 'unavailable', detail: 'no_account', account: parsed.account, accountLabel: null, checkedAt };
  if (entry.models?.[parsed.model] !== true) return { ok: false, reason: 'model_unknown' };
  const staleReason = checkedAt == null ? 'usage_unknown' : now - checkedAt > STALE_MS ? 'usage_stale' : null;
  const held = blocked(parsed.backend, parsed.model, entry.accountable ? '' : null);
  if (held) return { ok: false, reason: held.reason, ...(held.until ? { until: held.until } : {}), account: entry.accountable ? '' : null, checkedAt };
  const windows = windowsFor(parsed.backend, parsed.model, entry.windows);
  const verdict = judgeWindows(windows, policy);
  const check = selectable(verdict.reason === 'quota_full' ? verdict : staleReason ? { ok: false, reason: staleReason } : verdict);
  // アカウントを持てるエージェントは、登録が無ければログイン中のアカウント（''）。持てないエージェントは null
  return { ...check, account: entry.accountable ? '' : null, checkedAt,
    ...(check.deferred ? { avoidPercent: settings.avoidPercent, maxUsed: maxUsage(windows, now), weeklyRate: weeklyPace(windows, now) } : {}),
    ...(check.ok ? { windows: windows.map(w => brief(w, usedNow(w, now))) } : {}) };
}

/** 登録したアカウントの 1 行を見る（checkCandidate・pickAccount）。行ごとの取得時刻が古ければ、枠より先にそれで後回しにする */
function assessRow(backend, model, row, { checkedAt, policy, settings, now, blocked }) {
  if (!row.runnable) return { ok: false, reason: 'unavailable', detail: 'no_token', checkedAt };
  const held = blocked(backend, model, row.account);
  if (held) return { ok: false, reason: held.reason, ...(held.until ? { until: held.until } : {}), checkedAt };
  const windows = windowsFor(backend, model, row.windows);
  const verdict = judgeWindows(windows, policy);
  const rowAt = Object.hasOwn(row, 'checkedAt') ? row.checkedAt : checkedAt;
  const rowStale = rowAt == null ? 'usage_unknown' : now - rowAt > STALE_MS ? 'usage_stale' : null;
  const check = selectable(rowStale ? { ok: false, reason: rowStale } : verdict);
  // 比べる値（pressure）は元の枠から出しておく（返す windows はリセット時刻を落とした短い形）
  return { ...check, checkedAt: rowAt, maxUsed: maxUsage(windows, now), weeklyRate: weeklyPace(windows, now),
    ...(check.deferred ? { avoidPercent: settings.avoidPercent } : {}),
    windows: windows.map(w => brief(w, usedNow(w, now))) };
}

/**
 * アカウントを書かない固定の委譲で使うアカウント（ADR 0264）。accounts（段に入っているアカウント。ログイン中は ''）の中から、
 * 余裕のあるもの → 余裕の少ないもの の順に、使用量の少ないものを選ぶ。モデルの一覧は見ない（固定の委譲はモデルを書かないことがある）。
 * 使えるものが無ければ accounts の先頭。accounts が空なら null
 */
export function pickAccount({ backend, model = null, accounts, usage, settings, now, blocked = () => null }) {
  const list = [...accounts];
  if (!list.length) return null;
  const entry = usage?.[backend];
  if (!entry?.available || !Array.isArray(entry.accounts)) return list[0];
  const policy = { now, avoidPercent: settings.avoidPercent, paceLimit: settings.paceLimit };
  const rows = list.map((account, i) => {
    const row = entry.accounts.find(a => a.account === account);
    return { account, i, check: row ? assessRow(backend, model ?? '', row, { checkedAt: entry.checkedAt ?? null, policy, settings, now, blocked }) : { ok: false } };
  }).filter(r => r.check.ok);
  rows.sort((a, b) => Number(Boolean(a.check.deferred)) - Number(Boolean(b.check.deferred)) || pressure(a.check, b.check, now) || a.i - b.i);
  return rows[0]?.account ?? list[0];
}

/** 振り分けの記録（ply_delegate の返り値の routing。タスクと子会話のメタデータにも同じ形で残す） */
export function pinnedRouting({ kind, backend, model = null, account = null, accountLabel = null }) {
  return { mode: 'pinned', kind, judge: null, signals: null, probabilities: null, difficulty: null, tier: null,
    target: { backend, model: model ?? null, account: account ?? null, ...(accountLabel ? { accountLabel } : {}) }, skipped: [], usageAt: null, fallback: null };
}

// ---- 子の思考の強さ（ADR 0164） -----------------------------------------------------

/**
 * 子の思考の強さの決め方。上書き（efforts[段][候補]）→ 段の既定（efforts[段]['*']）→ そのモデルに合わせる。
 * capability は、そのモデルが持つ強さ { levels, fixed }。levels が空で fixed も無ければ持たない（Haiku など）。
 * fixed は強さがモデル名に入るもの（Antigravity の -high）で、選べず、送らない。
 * 振り分けでは断らない（持たない強さは合わせ、合わせたことを asked に残す）。
 * 返り値: { send, effort, source, tier?, asked? }
 *   send    … 子へ渡す値。'' は渡さない、undefined は会話の既定（prefs の強さ）にそのまま従う
 *   effort  … 記録する強さ（会話の既定に従うときは null。走らせてから実際の値を書く）
 *   source  … override（この候補の上書き）・tier（段の既定）・conversation（会話の既定）・model（モデル名で決まる）・none（持たない）
 */
export function decideEffort({ settings, tier, candidate, capability }) {
  const fixed = capability?.fixed ?? null;
  const levels = capability?.levels ?? [];
  if (fixed) return { send: '', effort: fixed, source: 'model' };
  if (!levels.length) return { send: '', effort: null, source: 'none' };
  const row = tier ? settings?.efforts?.[tier] : null;
  const own = row && Object.hasOwn(row, candidate) ? row[candidate] : undefined;
  const wanted = own !== undefined ? own : row ? row['*'] ?? DEFAULTS.efforts[tier]?.['*'] ?? '' : '';
  if (wanted === '') return { send: undefined, effort: null, source: 'conversation' };
  const effort = fitEffort(levels, wanted);
  if (!effort) return { send: '', effort: null, source: 'none' };   // 語彙の外の強さしか持たないモデルは、何も送らない
  return { send: effort, effort, source: own !== undefined ? 'override' : 'tier', tier, ...(effort !== wanted ? { asked: wanted } : {}) };
}

/** 強さを引く段。やり直し（人が選んだ候補）は元の段にその候補があればそれ、無ければ候補が入っている最初の段、どこにも無ければ null */
export function effortTierFor({ settings, candidate, preferred = null }) {
  if (preferred && (settings.tiers[preferred] ?? []).includes(candidate)) return preferred;
  return TIERS.find(tier => (settings.tiers[tier] ?? []).includes(candidate)) ?? null;
}

/**
 * 人が委譲カードの「別の候補でやり直す」で選んだ委譲先の記録。元のタスク（retry.of）と、元の委譲先（retry.from）に結び付ける。
 * 判定はしていないので judge などは null。check は checkCandidate の結果（使える候補だけを渡す）
 */
export function manualRouting({ kind, candidate, check, of, from, effortTier = null }) {
  const { backend, model } = parseCandidate(candidate);
  return { mode: 'manual', kind, judge: null, signals: null, probabilities: null, difficulty: null, tier: null,
    target: { backend, model, account: check.account ?? null, ...(check.accountLabel ? { accountLabel: check.accountLabel } : {}) }, skipped: [],
    usageAt: check.checkedAt == null ? null : new Date(check.checkedAt).toISOString(), fallback: null,
    ...(check.windows ? { targetWindows: check.windows } : {}),
    ...(effortTier ? { effortTier } : {}),
    ...(check.deferred ? { selectedWithLowHeadroom: { reason: check.reason, ...(check.window ? { window: check.window } : {}), avoidPercent: check.avoidPercent } } : {}),
    retry: { of, from: from ? { backend: from.backend ?? null, model: from.model ?? null, account: from.account ?? null } : null, by: 'user' } };
}

/**
 * 段・候補を選ぶ。judged は判定の結果 { judge, signals, probabilities, fallback }（signals が null なら難しさは mid）。
 * rejected は、選んだ後の確かめで落ちた候補と理由（{ 'codex:gpt-6-sol': 'model_unknown' }。server が委譲先の cwd で
 * モデルを確かめ直し、だめなら足して選び直す）。
 * 選べれば { ok: true, routing }、全部だめなら { ok: false, routing }（target は null）。
 * usageAt は選んだ候補の使用量の取得時刻（選べなければ見た中で最も古いもの）
 */
export function route({ kind, judged = {}, settings, usage, now = Date.now(), rejected = {}, blocked }) {
  const difficulty = judged.signals ? difficultyOf(judged.signals) : 'mid';
  const base = settings.table[kind][DIFFICULTIES.indexOf(difficulty)];
  const index = LADDER.indexOf(base);
  const sequence = base === 'tv' ? ['tv'] : LADDER.slice(index);
  const skipped = [];
  const seen = [];
  const iso = v => v == null ? null : new Date(v).toISOString();
  const routing = target => {
    const times = seen.filter(v => v != null);
    return { mode: 'auto', kind, judge: judged.judge ?? 'none', signals: judged.signals ?? null, probabilities: judged.probabilities ?? null,
      difficulty, baseTier: base, tier: target?.tier ?? null, target: target ? { backend: target.backend, model: target.model, account: target.account,
        ...(target.accountLabel ? { accountLabel: target.accountLabel } : {}) } : null,
      // 選んだ候補に効いた枠の今の使用率（委譲カードの内訳に出す。飛ばした候補は skipped[].window）
      ...(target?.windows ? { targetWindows: target.windows } : {}),
      ...(target?.deferred ? { selectedWithLowHeadroom: { reason: target.reason,
        ...(target.window ? { window: target.window } : {}), avoidPercent: settings.avoidPercent } } : {}),
      skipped, usageAt: target ? iso(target.checkedAt) : times.length ? iso(Math.min(...times)) : null, fallback: judged.fallback ?? null,
      ...(judged.escalated ? { escalated: true } : {}) };
  };
  const soft = [];
  // アカウントを持つ候補（アカウントを書いた候補・登録のあるエージェントの候補）は、飛ばした行にアカウントを添える
  const scopedOf = parsed => Boolean(parsed) && (parsed.account != null || Array.isArray(usage?.[parsed.backend]?.accounts));
  const inspect = (tier, chooseSoft) => {
    const localSoft = [];
    for (const candidate of settings.tiers[tier] ?? []) {
      const parsed = parseCandidate(candidate);
      const assessed = checkCandidate(candidate, { usage, settings, now, blocked });
      const check = Object.hasOwn(rejected, candidate) ? { ok: false, reason: rejected[candidate], checkedAt: assessed.checkedAt,
        account: assessed.account, accountLabel: assessed.accountLabel ?? null } : assessed;
      if (check.checkedAt != null) seen.push(check.checkedAt);
      if (check.ok && !check.deferred) return { tier, backend: parsed.backend, model: parsed.model, ...check };
      if (check.deferred) localSoft.push({ tier, candidate, check });
      const scoped = scopedOf(parsed);
      skipped.push({ candidate, tier, ...(scoped ? { account: check.account ?? parsed.account ?? '', accountLabel: check.accountLabel ?? null } : {}),
        reason: check.reason, ...(check.detail ? { detail: check.detail } : {}), ...(check.until ? { until: iso(check.until) } : {}), ...(check.window ? { window: check.window } : {}),
        ...(scoped && check.windows?.length ? { windows: check.windows } : {}),
        ...(check.checkedAt != null ? { checkedAt: iso(check.checkedAt) } : {}) });
    }
    if (chooseSoft && localSoft.length) return pickSoft(localSoft);
    soft.push(...localSoft);
    return null;
  };
  const pickSoft = rows => {
    rows.sort((a, b) => pressure(a.check, b.check, now));
    const { tier, candidate, check } = rows[0];
    const at = skipped.findIndex(s => s.tier === tier && s.candidate === candidate);
    if (at >= 0) skipped.splice(at, 1);
    const { backend, model } = parseCandidate(candidate);
    return { tier, backend, model, ...check };
  };
  for (const tier of sequence) {
    const target = inspect(tier, false);
    if (target) return { ok: true, routing: routing(target) };
  }
  if (soft.length) return { ok: true, routing: routing(pickSoft(soft.filter(s => s.tier === soft[0].tier))) };
  for (const tier of (base === 'tv' ? [] : LADDER.slice(0, index).reverse())) {
    const target = inspect(tier, true);
    if (target) return { ok: true, routing: routing(target) };
  }
  return { ok: false, routing: routing(null) };
}

/**
 * 候補ごとの今の状態（設定画面の段ごとの候補と、各候補の使用量）。settings の全段の候補を重複なく。
 * アカウントを持つ候補（scoped: アカウントを書いた候補・アカウントを登録したエージェントの候補）は、そのアカウントの行の使用量だけ
 * （account・accountLabel。ログイン中は ''）
 */
export function candidateStates({ settings, usage, now = Date.now(), blocked }) {
  const ids = [...new Set(TIERS.flatMap(tier => settings.tiers[tier] ?? []))];
  return ids.map(candidate => {
    const parsed = parseCandidate(candidate);
    const check = checkCandidate(candidate, { usage, settings, now, blocked });
    const entry = parsed ? usage?.[parsed.backend] : null;
    const scoped = Boolean(parsed) && (parsed.account != null || Array.isArray(entry?.accounts));
    const row = scoped ? entry?.accounts?.find(a => a.account === (parsed.account ?? '')) ?? null : null;
    const at = row && Object.hasOwn(row, 'checkedAt') ? row.checkedAt : entry?.checkedAt;
    return { candidate, backend: parsed?.backend ?? null, model: parsed?.model ?? null,
      ...(scoped ? { scoped: true, account: parsed.account ?? '', accountLabel: row?.label ?? null } : { account: check.ok ? check.account ?? null : null }),
      tiers: TIERS.filter(tier => (settings.tiers[tier] ?? []).includes(candidate)),
      usable: check.ok, deferred: Boolean(check.deferred), reason: check.reason ?? null, ...(check.detail ? { detail: check.detail } : {}),
      ...(check.until ? { until: new Date(check.until).toISOString() } : {}),
      ...(check.window ? { window: check.window } : {}),
      checkedAt: at ? new Date(at).toISOString() : null,
      windows: parsed && (!scoped || row) ? windowsFor(parsed.backend, parsed.model, row ? row.windows : entry?.windows).map(w => brief(w, usedNow(w, now))) : [] };
  });
}

/** エージェント向けエラーの言語によらない行。画面もこの形を読む。 */
export function formatSkippedCandidates(skipped) {
  // until は上限で止まった枠の戻る見込み（ISO。Issue #111）。依頼元が「いつ頼み直せるか」を読めるように残す
  const reasonLine = s => `${s.reason}${s.detail ? ` (${s.detail})` : ''}${s.window?.usedPercent != null ? ` ${s.window.label ?? ''} ${s.window.usedPercent}%` : ''}${s.window?.pace != null ? ` pace ${s.window.pace}` : ''}${s.until ? ` until ${s.until}` : ''}`;
  return skipped.map(s => {
    const label = s.account === undefined ? '' : ` [${String(s.accountLabel || (s.account === '' ? 'login' : 'account')).replace(/[\]\r\n]/g, ' ')}]`;
    return `- ${s.candidate}${label} (${s.tier}): ${reasonLine(s)}`;
  }).join('\n');
}

/** 設定の検証で知らせること（今のモデル一覧に無い候補・使えないバックエンド・登録に無いアカウント）。黙って消さない */
export function settingsWarnings({ settings, usage }) {
  const out = [];
  for (const candidate of [...new Set(TIERS.flatMap(tier => settings.tiers[tier] ?? []))]) {
    const parsed = parseCandidate(candidate);
    const entry = usage?.[parsed.backend];
    const missingAccount = Array.isArray(entry?.accounts) ? !entry.accounts.some(a => a.account === (parsed.account ?? '')) : Boolean(parsed.account);
    if (!entry?.available) out.push({ candidate, reason: 'unavailable' });
    else if (missingAccount) out.push({ candidate, reason: 'no_account' });
    else if (entry.models?.[parsed.model] !== true) out.push({ candidate, reason: 'model_unknown' });
  }
  return out;
}
