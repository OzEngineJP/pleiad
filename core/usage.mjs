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

/**
 * プロバイダーの使用枠の正本（単一のストア。設定の画面・ply_usage・委譲の監視・チャンネルの予算・
 * ヘッダーの札が同じスナップショットを読む）。成功した値だけをキャッシュし、同時の取得は相乗りする。
 *   get(key)                    … 前回のスナップショット（同期）。無ければ null
 *   refresh(key, fetcher, opt)  … 取得。ttl 内はキャッシュを返す。force は ttl を待たず取り直す
 *   subscribe(fn)               … 値が取れた（key）・無効化した（key が null）通知。画面への push に使う
 *   invalidate()                … 認可・キーが変わった。次の取得は必ず取り直す
 *   flush()                     … 残っている書き出しが済むまで待つ（テスト用）
 * スナップショット: { revision, fetchedAt, stale, ...quota（windows・accounts・checkedAt・message…） }。
 * dir を渡すと、取れた値を usage-quota.json に原子的に残し、起動時に stale: true で読み戻す
 * （再起動しても札が残る。stale の値は取り直しが届くまで先に返し、届いたら subscribe で知らせる）
 */
export function createQuotaStore({ now = Date.now, ttl = 60_000, dir = null, io = fs } = {}) {
  const cache = new Map(), pending = new Map(), listeners = new Set();
  let generation = 0, writes = Promise.resolve();
  const file = dir ? path.join(dir, QUOTA_SNAPSHOTS_FILE) : null;
  if (file) {
    try {
      const saved = JSON.parse(io.readFileSync(file, 'utf8'));
      for (const [key, quota] of Object.entries(saved?.backends ?? {}).slice(0, QUOTA_SNAPSHOTS_MAX))
        cache.set(key, { ...quota, revision: 0, fetchedAt: quota?.checkedAt ?? 0, stale: true });
    } catch { /* 無い・壊れているなら空で始める */ }
  }
  const persist = () => {
    if (!file) return;
    const backends = Object.fromEntries([...cache].map(([key, s]) => [key, (({ revision, fetchedAt, stale, ...q }) => q)(s)]));
    writes = writes.then(() => writeAtomic(file, JSON.stringify({ version: 1, backends }, null, 2) + '\n', { mode: 0o600 })).catch(() => {});
  };
  const notify = (key, snapshot) => { for (const fn of listeners) { try { fn(key, snapshot); } catch {} } };
  return {
    get: key => cache.get(key) ?? null,
    async refresh(key, fetcher, { force = false } = {}) {
      const hit = cache.get(key);
      if (hit && !hit.stale && !force && now() - hit.fetchedAt < ttl) return hit;
      if (!pending.has(key)) {
        const version = generation;
        const task = Promise.resolve().then(fetcher).then(value => {
          if (version !== generation) return { windows: [], checkedAt: null, message: t('usage.authChanged') };
          const snapshot = { ...value, checkedAt: now(), revision: (cache.get(key)?.revision ?? 0) + 1, fetchedAt: now(), stale: false };
          cache.set(key, snapshot); persist(); notify(key, snapshot);
          return snapshot;
        }).catch(() => ({ windows: [], checkedAt: null, message: t('usage.fetchFailed') }))
          .finally(() => pending.delete(key));
        pending.set(key, task);
      }
      // 前回の終了時の値（stale）があれば、取り直しが届くまで先にそれを返す
      if (hit?.stale) return hit;
      return pending.get(key);
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    invalidate() { generation++; cache.clear(); persist(); notify(null, null); },
    flush: () => writes,
  };
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
  return { plan: quota?.plan ?? null, windows: windows(quota?.windows),
    ...(Array.isArray(quota?.accounts) ? { accounts: quota.accounts.map(a => ({ ...account(a), label: maskEmail(a.label), plan: a.plan ?? null, windows: windows(a.windows), message: maskEmail(a.message) })) } : {}),
    checkedAt: iso(quota?.checkedAt), message: maskEmail(quota?.message) };
}

/**
 * ply_usage の本体。backend を省けば使用枠を読めるバックエンドすべて。
 * read は providerUsage と同じ取得（同じ quotaStore を通す）。1 つが失敗しても他は返す。
 * accounts(b) はそのエージェントに登録したアカウントの一覧（[{ id, ready }]。資格情報の無いアカウントに runnable: false を付ける）
 */
export async function agentUsage({ backend, list, get, read, locale, accounts }) {
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
    catch { quota = { windows: [], checkedAt: null, message: agentT(locale, 'usage.failed') }; }
    const rows = accounts && b.capabilities?.accounts ? await accounts(b).catch(() => []) : [];
    const tokens = rows.length ? new Map(rows.map(a => [a.id, Boolean(a.ready)])) : null;
    return { backend: b.id, label: b.label, ...compactQuota(quota, Date.now(), { tokens }) };
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
