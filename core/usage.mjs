// Provider quota snapshots and local usage are deliberately separate: tokens cannot
// be converted into subscription percentages. Never persist account credentials.
import fs from 'node:fs';
import path from 'node:path';
import { t, agentT } from './i18n.mjs';
import { openData } from './data-schema.mjs';
import { usageTable } from './db.mjs';
import { writeAtomic } from './atomic-file.mjs';
import { CLAUDE_COST_DELTA } from './usage-migrations.mjs';

export const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
// 記録の入力は「キャッシュ読みを含む」で、cachedTokens はその内訳（Claude・Codex・Antigravity とも。Antigravity は 2026-10-04 まで分けて入れていた）。
// cachedTokens が入力より大きい記録は古い Antigravity の形なので、足して読む。割合は 1 を超えないようにする
export const inputWithCache = r => { const input = number(r?.inputTokens) ?? 0, cached = number(r?.cachedTokens) ?? 0; return cached > input ? input + cached : input; };
// Thread totals include previous turns; last describes the latest model request.
export function createCodexMeter() {
  const previous = {}, totals = {};
  return usage => {
    for (const [key, native] of [['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['cachedTokens', 'cachedInputTokens']]) {
      const total = number(usage?.total?.[native]), last = number(usage?.last?.[native]);
      if (total == null || last == null) continue;
      const delta = previous[key] == null || total < previous[key] ? last : total - previous[key];
      totals[key] = (totals[key] ?? 0) + delta; previous[key] = total;
    }
    return { ...totals };
  };
}
const iso = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
export function usageWindow(label, used, resetsAt, minutes) {
  const percent = number(used);
  return { label, usedPercent: percent, remainingPercent: percent == null ? null : Math.max(0, 100 - percent),
    resetsAt: iso(resetsAt), minutes: number(minutes) };
}
const duration = minutes => minutes === 300 ? t('usage.window.fiveHour') : minutes === 10080 ? t('usage.window.weekly') : minutes ? t('usage.window.hours', { hours: minutes / 60 }) : t('usage.window.unknown');

export function codexQuota(data) {
  const buckets = Object.values(data?.rateLimitsByLimitId ?? {});
  if (!buckets.length && data?.rateLimits) buckets.push(data.rateLimits);
  const windows = buckets.flatMap(bucket => ['primary', 'secondary'].flatMap(key => {
    const w = bucket?.[key];
    if (!w) return [];
    const label = `${bucket.limitName || (bucket.limitId !== 'codex' && bucket.limitId) || ''} ${duration(w.windowDurationMins)}`.trim();
    // limitId / limitName は委譲の振り分けがどのモデルに効く枠かを見分けるため（core/delegation-routing.mjs の windowsFor）
    return [{ ...usageWindow(label, w.usedPercent, number(w.resetsAt) == null ? null : w.resetsAt * 1000, w.windowDurationMins),
      ...(bucket.limitId ? { limitId: String(bucket.limitId) } : {}), ...(bucket.limitName ? { limitName: String(bucket.limitName) } : {}) }];
  }));
  return { plan: buckets[0]?.planType ?? null, windows,
    message: windows.length ? null : t('usage.codexUnavailable') };
}
export function whamQuota(data) {
  const convert = (limit, id, name) => ({ limitId: id, limitName: name, planType: data?.plan_type,
    ...Object.fromEntries(['primary', 'secondary'].map(key => {
      const w = limit?.[key + '_window'];
      return [key, w ? { usedPercent: w.used_percent, windowDurationMins: number(w.limit_window_seconds) == null ? null : w.limit_window_seconds / 60, resetsAt: w.reset_at } : null];
    })) });
  return codexQuota({ rateLimitsByLimitId: Object.fromEntries([
    ['codex', convert(data?.rate_limit, 'codex')],
    ...(data?.additional_rate_limits ?? []).map((b, i) => [String(i), convert(b.rate_limit, b.metered_feature, b.limit_name)]),
  ]) });
}
export function claudeQuota(data) {
  const limits = data?.rate_limits;
  // model は、そのモデルの系統にだけ効く枠（委譲の振り分けが候補ごとに枠を選ぶ。core/delegation-routing.mjs の windowsFor）
  const labels = { five_hour: [t('usage.window.fiveHour'), 300], seven_day: [t('usage.window.weekly'), 10080],
    seven_day_oauth_apps: [t('usage.window.oauthAppsWeekly'), 10080], seven_day_opus: [t('usage.window.modelWeekly', { model: 'Opus' }), 10080, 'opus'], seven_day_sonnet: [t('usage.window.modelWeekly', { model: 'Sonnet' }), 10080, 'sonnet'] };
  const windows = Object.entries(labels).flatMap(([key, [label, minutes, model]]) => limits?.[key]
    ? [{ ...usageWindow(label, limits[key].utilization, limits[key].resets_at, minutes), ...(model ? { model } : {}) }] : []);
  for (const w of limits?.model_scoped ?? []) windows.push({ ...usageWindow(t('usage.window.modelWeekly', { model: w.display_name }), w.utilization, w.resets_at, 10080), model: String(w.display_name ?? '') });
  return { plan: data?.subscription_type ?? null, windows,
    message: windows.length ? null : t('usage.claudeUnavailable') };
}

const QUOTA_SNAPSHOTS_FILE = 'usage-quota.json';
// 写しに残すエージェントの上限（使うエージェントの種類は限られる。溢れないための上限。tests/data-writes-allowlist.mjs）
const QUOTA_SNAPSHOTS_MAX = 20;
/** 読めなかった理由（行の reason。ply_usage にもそのまま出す）。no-login はログイン情報のトークンが無い（再ログインが要る） */
export const QUOTA_FAILURES = Object.freeze(['no-login', 'rate-limited', 'timeout', 'error']);
/** 読めない行が続く間に延ばす、読む間隔の上限 */
export const QUOTA_BACKOFF_MAX_MS = 15 * 60_000;
const failureOf = reason => QUOTA_FAILURES.includes(reason) ? reason : 'error';
/** 取得の例外から読めなかった理由を引く。印（error.reason）があればそれ、無ければ文言の 429・時間切れ */
export function quotaFailure(error) {
  if (QUOTA_FAILURES.includes(error?.reason)) return error.reason;
  const text = String(error?.message ?? error);
  if (/\b429\b|rate[ _-]?limit/i.test(text)) return 'rate-limited';
  return /\btime[ds]?[ _-]?out\b/i.test(text) ? 'timeout' : 'error';
}

/** 使用枠の行。[行の名前, 行]。アカウントごとの行（accounts）があればその行（ログイン中は 'login'）、無ければ全体の 1 行（''） */
const quotaRows = quota => Array.isArray(quota?.accounts)
  ? quota.accounts.map(a => [a?.accountId ?? LOGIN_ACCOUNT, a]) : [['', quota]];
/**
 * 読めなかった行（reason があり、枠が空）には前回の枠とプランを残し、いつの値か（staleSince）を添える。
 * 前回も読めていなかった（枠が空）なら、理由の文言だけの行のまま。since は前回の値を読んだ時刻
 */
function carryRow(row, old, since) {
  if (!row?.reason || row.windows?.length || !old?.windows?.length) return row;
  const at = old.staleSince ?? since ?? null;
  return { ...row, windows: old.windows, plan: row.plan ?? old.plan ?? null, ...(at != null ? { staleSince: at } : {}) };
}
/**
 * 今回の値に前回の値を重ねる。読まなかった行（skipped。読む間隔を延ばしている間）は前回の行のまま、
 * 読めなかった行は carryRow。checkedAt は全体の値を読んだ時刻（前回の値を残したなら、その値の時刻）
 */
function mergeQuota(value, prev, at) {
  const since = prev?.checkedAt ?? null;
  if (Array.isArray(value?.accounts)) {
    const old = new Map(prev ? quotaRows(prev) : []);
    const accounts = value.accounts.map(a => {
      const was = old.get(a.accountId ?? LOGIN_ACCOUNT);
      if (a.skipped) return was ? { ...was, label: a.label ?? was.label } : (({ skipped, ...rest }) => rest)(a);
      const row = carryRow(a, was, since);
      // 前回の値を残した行は、その値の時刻を行に持たせる（委譲の振り分けが古い値を新しい値と取り違えない。core/delegation-routing.mjs）
      return row.staleSince != null ? { ...row, checkedAt: row.staleSince } : row;
    });
    return { ...value, accounts, checkedAt: at };
  }
  const row = carryRow(value, prev && !Array.isArray(prev.accounts) ? prev : null, since);
  return { ...row, checkedAt: row.staleSince ?? (row.reason ? null : at) };
}

/**
 * プロバイダーの使用枠の正本（単一のストア。設定の画面・ply_usage・委譲の監視・チャンネルの予算・
 * ヘッダーの札が同じスナップショットを読む）。同時の取得は相乗りする。
 *   get(key)                    … 前回のスナップショット（同期）。無ければ null
 *   refresh(key, fetcher, opt)  … 取得。ttl 内はキャッシュを返す。force は ttl と読む間隔の延長を待たず、全部の行を取り直す（人の読み直し）
 *   subscribe(fn)               … 値が届いた（key）・無効化した（key が null）通知。画面への push に使う
 *   invalidate()                … 認可・キーが変わった。次の取得は必ず取り直す
 *   flush()                     … 残っている書き出しが済むまで待つ（テスト用）
 * スナップショット: { revision, fetchedAt, stale, ...quota（windows・accounts・checkedAt・message…） }。
 * dir を渡すと、取れた値を usage-quota.json に原子的に残し、起動時に stale: true で読み戻す
 * （再起動しても札が残る。stale の値は取り直しが届くまで先に返し、届いたら subscribe で知らせる）
 *
 * 読めなかった行（reason。ログインなし・429・時間切れ・例外）は、前回の値を空の結果で上書きせず残し、staleSince（その値の時刻）を添える。
 * 行ごとに、読めない間は読む間隔を ttl の倍々に延ばし（上限 backoffMax）、読めたら戻す。延ばしている行は fetcher に
 * skip（行の名前の一覧）で渡し、読まない（行を { skipped: true } で返せば前回の行のまま）。全部の行が延ばしている間は取りに行かない。
 * 読めなくなったとき・理由が変わったとき・読めるようになったときだけ log に 1 行書く（続く間は書かない。秘密は渡さない）
 */
export function createQuotaStore({ now = Date.now, ttl = 60_000, backoffMax = QUOTA_BACKOFF_MAX_MS, dir = null, io = fs, log = () => {} } = {}) {
  const cache = new Map(), pending = new Map(), listeners = new Set();
  const serverGeneration = performance.timeOrigin;
  // key → Map(行の名前 → { reason, failures, retryAt })。読めない行だけを持つ
  const health = new Map();
  let generation = 0, writes = Promise.resolve();
  const file = dir ? path.join(dir, QUOTA_SNAPSHOTS_FILE) : null;
  if (file) {
    try {
      const saved = JSON.parse(io.readFileSync(file, 'utf8'));
      for (const [key, quota] of Object.entries(saved?.backends ?? {}).slice(0, QUOTA_SNAPSHOTS_MAX))
        cache.set(key, { ...quota, generation: serverGeneration, revision: 0, fetchedAt: quota?.checkedAt ?? 0, stale: true });
    } catch { /* 無い・壊れているなら空で始める */ }
  }
  const persist = () => {
    if (!file) return;
    const backends = Object.fromEntries([...cache].map(([key, s]) => [key, (({ generation, revision, fetchedAt, expiresAt, stale, ...q }) => q)(s)]));
    writes = writes.then(() => writeAtomic(file, JSON.stringify({ version: 1, backends }, null, 2) + '\n', { mode: 0o600 })).catch(() => {});
  };
  const notify = (key, snapshot) => { for (const fn of listeners) { try { fn(key, snapshot); } catch {} } };
  const write = line => { try { log(line); } catch {} };
  const where = (key, row) => row ? `${key} account=${row}` : key;
  /** 今回の行の結果で、読む間隔とログを進める。読まなかった行（skipped）は変えない */
  function track(key, value) {
    const rows = health.get(key) ?? new Map();
    const at = now(), seen = new Set();
    for (const [name, row] of quotaRows(value)) {
      seen.add(name);
      if (row?.skipped) continue;
      const was = rows.get(name);
      if (row?.reason) {
        const reason = failureOf(row.reason), failures = (was?.failures ?? 0) + 1;
        rows.set(name, { reason, failures, retryAt: at + Math.min(ttl * 2 ** failures, backoffMax) });
        if (was?.reason !== reason) write(`${where(key, name)} read failed reason=${reason} at=${new Date(at).toISOString()}`);
      } else if (was) {
        rows.delete(name);
        write(`${where(key, name)} read again after reason=${was.reason} at=${new Date(at).toISOString()}`);
      }
    }
    for (const name of [...rows.keys()]) if (!seen.has(name)) rows.delete(name);
    if (rows.size) health.set(key, rows); else health.delete(key);
  }
  /** 例外で何も返らなかった。前回の行を、同じ理由で読めなかった行として扱う */
  function thrown(error, prev) {
    const reason = quotaFailure(error), message = t('usage.fetchFailed');
    return Array.isArray(prev?.accounts)
      ? { windows: [], message: null, accounts: prev.accounts.map(a => ({ label: a.label, accountId: a.accountId ?? null, windows: [], reason, message })) }
      : { windows: [], reason, message };
  }
  function snapshotOf(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    const running = pending.get(key), at = now();
    const state = (row, name) => {
      const healthRow = health.get(key)?.get(name);
      const waiting = healthRow?.retryAt > at;
      const fetchState = running && (running.force || !waiting) ? 'pending'
        : waiting ? 'retry-wait' : row.reason ? 'failed' : null;
      return { ...row, ...(fetchState ? { fetchState } : {}),
      ...(healthRow ? { retryAt: healthRow.retryAt } : {}) };
    };
    return Array.isArray(hit.accounts)
      ? { ...hit, accounts: hit.accounts.map(a => state(a, a.accountId ?? LOGIN_ACCOUNT)) }
      : state(hit, '');
  }
  return {
    get: snapshotOf,
    async refresh(key, fetcher, { force = false } = {}) {
      const hit = cache.get(key);
      if (hit && !hit.stale && !force) {
        const rows = health.get(key), at = now();
        if (at < (hit.expiresAt ?? hit.fetchedAt + ttl)) return snapshotOf(key);
        // 全部の行が読む間隔を延ばしている間は、取りに行かない（前回の値と理由を返す）
        if (rows?.size && quotaRows(hit).every(([name]) => (rows.get(name)?.retryAt ?? 0) > at)) return snapshotOf(key);
      }
      const running = pending.get(key);
      // 人の読み直し（force）は、間隔を延ばした行を飛ばしている取得に相乗りせず、それが済んでから全部を読み直す
      if (!running || (force && !running.force)) {
        const version = generation;
        const before = running?.task ?? Promise.resolve();
        const task = before.catch(() => {}).then(() => {
          const rows = health.get(key), at = now();
          const skip = force || !rows ? [] : [...rows].filter(([name, s]) => name && s.retryAt > at).map(([name]) => name);
          return Promise.resolve().then(() => fetcher({ skip })).catch(error => thrown(error, cache.get(key)));
        }).then(value => {
          if (version !== generation) return { generation: serverGeneration + version / 1000, revision: 0, windows: [], checkedAt: null, message: t('usage.authChanged') };
          const prev = cache.get(key);
          track(key, value);
          const at = now(), merged = mergeQuota(value, prev, at);
          // 過去の境界を繰り返し返す提供元でも、次は通常の TTL まで待つ。
          const boundaries = quotaRows(merged).flatMap(([, row]) => (row.windows ?? []).map(w => new Date(w.resetsAt).getTime())).filter(time => time > at);
          const snapshot = { ...merged, generation: serverGeneration + generation / 1000, revision: (prev?.revision ?? 0) + 1, fetchedAt: at,
            expiresAt: Math.min(at + ttl, ...boundaries), stale: false };
          cache.set(key, snapshot);
          if (pending.get(key)?.task === task) pending.delete(key);
          persist(); notify(key, snapshotOf(key));
          return snapshotOf(key);
        }).finally(() => { if (pending.get(key)?.task === task) pending.delete(key); });
        pending.set(key, { task, force });
        notify(key, snapshotOf(key));
      }
      // 前回の終了時の値（stale）があれば、取り直しが届くまで先にそれを返す
      if (hit?.stale && !force) return snapshotOf(key);
      return pending.get(key).task;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    invalidate() { generation++; cache.clear(); health.clear(); persist(); notify(null, null); },
    flush: () => writes,
  };
}

/** ローカル集計を待っている間に更新された使用枠も、同じ応答へ反映する。 */
export async function readProviderUsage(backend, { read, latest, summary, held }) {
  const quota = await read();
  let local;
  try { local = await summary(); }
  catch { local = { error: t('quota.localFailed') }; }
  return { backend: backend.id, label: backend.label, quota: latest() ?? quota, local, held: held() };
}

// エージェント（ply_usage）へ渡す使用枠。委譲先を選ぶ判断に要る分だけに絞る（残率・期間の分・ローカル実績は落とす）。
// Claude のアカウントの見出しは人が付けた表示名なので、メールアドレスを書いていることがある。
// 会話へそのまま流さないよう、ローカル部を1文字だけ残して伏せる（見出しとして見分けは付く）
export const maskEmail = text => typeof text === 'string' ? text.replace(/([^\s@<>()"'「」（）]?)[^\s@<>()"'「」（）]*@([^\s@<>()"'「」（）]+\.[A-Za-z]{2,})/g, '$1***@$2') : null;
// 使用率は小数第 1 位まで（残率から逆算した 9.999999999999998 のような端数を渡さない）
const percent = value => number(value) == null ? null : Math.round(value * 10) / 10;
// リセット時刻を過ぎた枠の使用率は今の値ではない。画面（web/usage.mjs）と同じく不明（null）として渡す
const expired = (w, now) => w.resetsAt != null && new Date(w.resetsAt).getTime() <= now;
// アカウントの行には、ply_delegate・ply_task_send の account に書ける名前（account）を付ける。登録したアカウントは内部の id
// （acct-… の無作為な名前で、秘密ではない。資格情報は別の暗号化した保存先にある）、ログイン中のアカウントは 'login'（ADR 0205・0222）。
// runnable: false は、登録してあるが資格情報（Claude はトークン）が無く、子を走らせられないアカウント（tokens に渡したときだけ分かる）
export const LOGIN_ACCOUNT = 'login';
export function compactQuota(quota, now = Date.now(), { tokens } = {}) {
  const windows = list => (Array.isArray(list) ? list : []).map(w => ({ label: maskEmail(w.label),
    usedPercent: expired(w, now) ? null : percent(w.usedPercent), resetsAt: w.resetsAt ?? null }));
  const account = a => {
    const name = a.accountId ?? LOGIN_ACCOUNT;
    return { account: name, ...(a.ready === false || (a.accountId && tokens?.get(a.accountId) === false) ? { runnable: false } : {}) };
  };
  // 読めなかった行の理由（QUOTA_FAILURES）と、前回の値を出しているならその時刻・何分前か（読めていれば付けない）
  const failure = q => {
    const at = q?.staleSince != null ? new Date(q.staleSince).getTime() : NaN;
    return { ...(q?.reason ? { reason: failureOf(q.reason) } : {}),
      ...(Number.isFinite(at) ? { staleSince: iso(at), staleMinutes: Math.max(0, Math.floor((now - at) / 60_000)) } : {}) };
  };
  return { plan: quota?.plan ?? null, windows: windows(quota?.windows),
    ...(Array.isArray(quota?.accounts) ? { accounts: quota.accounts.map(a => ({ ...account(a), label: maskEmail(a.label), plan: a.plan ?? null, windows: windows(a.windows), ...failure(a), message: maskEmail(a.message) })) } : {}),
    ...failure(quota), checkedAt: iso(quota?.checkedAt), message: maskEmail(quota?.message) };
}

/**
 * ply_usage の本体。backend を省けば使用枠を読めるバックエンドすべて。
 * read は providerUsage と同じ取得（同じ quotaStore を通す）。1 つが失敗しても他は返す。
 * accounts(b) はそのエージェントに登録したアカウントの一覧（[{ id, ready }]。資格情報の無いアカウントに runnable: false を付ける）
 * held(b) は上限で今止まっている枠（[{ model, account, reason, until, resetsAt, window }]。Issue #111）。短い間隔の上限は日次・週次の枠には出ないので別に渡す。
 * until は振り分けが外す時刻、resetsAt は告げられた解除の見込み（分からなければ null）。
 * window はアカウント全体の枠（five_hour など）で止まったときの枠の名前（model は null）
 */
export async function agentUsage({ backend, list, get, read, locale, accounts, held }) {
  let targets;
  if (backend === undefined) targets = list().filter(b => b.usage);
  else {
    const found = typeof backend === 'string' ? get(backend) : null;
    // エージェントへ返す文は会話の言語（locale）で（agent 名前空間）
    if (!found) throw new Error(agentT(locale, 'usage.unknownBackend', { backend: String(backend), available: list().map(b => b.id).join(', ') }));
    targets = [found];
  }
  const backends = await Promise.all(targets.map(async b => {
    let quota;
    try { quota = await read(b); }
    catch (e) { quota = { windows: [], checkedAt: null, reason: quotaFailure(e), message: agentT(locale, 'usage.failed') }; }
    const rows = accounts && b.capabilities?.accounts ? await accounts(b).catch(() => []) : [];
    const tokens = rows.length ? new Map(rows.map(a => [a.id, Boolean(a.ready)])) : null;
    const stopped = (held ? held(b) : []).map(s => ({ model: s.model ?? null,
      ...(b.capabilities?.accounts ? { account: s.account || LOGIN_ACCOUNT } : {}), reason: s.reason, until: s.until ?? null,
      resetsAt: s.resetsAt ?? null, ...(s.window ? { window: s.window } : {}) }));
    return { backend: b.id, label: b.label, ...compactQuota(quota, Date.now(), { tokens }), ...(stopped.length ? { held: stopped } : {}) };
  }));
  return { backends };
}

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cachedTokens', 'costUsd'];
const totals = value => value && typeof value === 'object' ? Object.fromEntries(USAGE_KEYS.map(key => [key, number(value[key])])) : null;
/**
 * 記録の 1 行。4 つの数値はそのターンの分。Claude は後から直せるように、会話のネイティブ id と
 * そのときの累計（開始時点・終了時点。core/backends/claude-cost-state.mjs）も残す
 */
export function usageRecord(record, at) {
  const safe = { id: record.id, backend: record.backend, at, ...Object.fromEntries(USAGE_KEYS.map(key => [key, number(record[key])])) };
  if (typeof record.nativeSessionId === 'string' && /^[\w-]{1,200}$/.test(record.nativeSessionId)) safe.nativeSessionId = record.nativeSessionId;
  // どの会話のターンか（bot ごと・スレッドごとの合計を引くため。ADR 0109）。この欄が付く前の記録には無い
  if (typeof record.sessionId === 'string' && /^[\w-]{1,200}$/.test(record.sessionId)) safe.sessionId = record.sessionId;
  if ('cumulativeStart' in record || 'cumulativeEnd' in record) {
    safe.cumulativeStart = totals(record.cumulativeStart); safe.cumulativeEnd = totals(record.cumulativeEnd);
  }
  return safe;
}
// 済んだ移行の名前（core/usage-migrations.mjs）。新しく作る記録は直す必要が無いので、最初から済みにする
export const USAGE_MIGRATIONS = Object.freeze([CLAUDE_COST_DELTA]);

/**
 * 使用量の記録（SQLite の usage_meta・usage_records。core/db.mjs）。1 ターン 1 行で、足すのは新しい 1 行だけ。
 * 以前の usage.json（全体を毎回書き直す）は形式 2 への移行で取り込む（ADR 0115）。dir は データ置き場
 */
export function createUsageStore(dir, { now = Date.now } = {}) {
  let handle = null, table = null;
  const open = () => {
    if (!handle) { handle = openData(dir); table = usageTable(handle.db); }
    return table;
  };
  let writes = Promise.resolve();
  // 書き込みは直列にする（記録と移行が同じ記録を読み書きする）
  const serial = fn => { const task = writes.catch(() => {}).then(fn); writes = task; return task; };
  return {
    dir,
    record(record) {
      return serial(async () => {
        const rows = open();
        const safe = usageRecord(record, now());
        if (!rows.has(safe.id)) rows.add(safe, { since: now(), migrations: [...USAGE_MIGRATIONS] });
      });
    },
    /** 記録の全体（{ version, since, migrations, records }）。まだ 1 件も書いていなければ null。移行（core/usage-migrations.mjs）が読む */
    async snapshot() { await writes; return open().snapshot(); },
    /** 移行（core/usage-migrations.mjs）。fn が新しい中身を返したときだけ書く。記録が無ければ何もしない */
    update(fn) {
      return serial(async () => {
        const data = open().snapshot();
        if (!data) return null;
        const next = await fn(data);
        if (next?.data) open().replace(next.data);
        return next?.result ?? null;
      });
    },
    /** DB の接続を離す（データ置き場を消す前。サーバーは閉じない） */
    async close() { await writes.catch(() => {}); handle?.release(); handle = null; table = null; },
    /** 会話ごとの記録（bot ごと・スレッドごとの合計を引く。ADR 0109）。sessionIds に含まれる会話の、since（ms）以降の記録。sessionId を持たない古い記録は載らない */
    async records({ sessionIds, since = 0 } = {}) {
      await writes;
      return open().forSessions([...new Set(sessionIds ?? [])], since);
    },
    /** backend の、since（ms）以後の記録のトークンの合計（入力・出力・キャッシュ）。チャンネルの予算が週の枠 1% あたりを割り出すのに使う（core/bots/budget.mjs。ADR 0119） */
    async tokensSince(backend, since = 0) {
      await writes;
      return open().tokensSince(backend, since);
    },
    async summary(backend) {
      await writes;
      const rows = open();
      // 7 日分（5 時間分はその一部）だけを DB から取る
      const recent = rows.recent(backend, now() - 168 * 3600_000);
      const summarize = hours => {
        const rows = recent.filter(r => r.backend === backend && r.at >= now() - hours * 3600_000);
        return { turns: rows.length, ...Object.fromEntries(['inputTokens', 'outputTokens', 'cachedTokens', 'costUsd'].map(key => {
          const known = rows.filter(r => number(r[key]) != null);
          return [key, { value: known.length ? known.reduce((sum, r) => sum + r[key], 0) : null, measured: known.length }];
        })) };
      };
      return { since: rows.count() ? rows.since() : null, fiveHour: summarize(5), sevenDay: summarize(168) };
    },
  };
}
