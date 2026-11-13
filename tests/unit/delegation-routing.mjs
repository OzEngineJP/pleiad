// 委譲先の自動選択（core/delegation-routing.mjs・delegation-judges.mjs・delegation-usage.mjs）。
// 自動選択のモデルは偽の fetch とだけ話す（本物の OpenRouter へは送らない）。LLM は呼ばない
import { buildAgyModels } from '../../core/backends/antigravity-models.mjs';
import { effortCapability } from '../../core/effort.mjs';
import { KINDS, SIGNALS, DEFAULTS, DEFAULT_JUDGE, DECISION_THRESHOLD, levelOrder, kindOrder, EFFORT_LEVELS, normalizeSettings, migrateLegacySettings, pruneEfforts, fitEffort, decideEffort, effortTierFor, RoutingSettingsError, difficultyOf, judgeWindows, windowsFor, checkCandidate, pickAccount, sameIdentity, tierAccounts, candidateId,
  route, pinnedRouting, manualRouting, candidateStates, settingsWarnings, parseCandidate, elapsedPercent, formatSkippedCandidates } from '../../core/delegation-routing.mjs';
import { askJudge, judgeDifficulty, normalizeKey, TASK_LIMIT, JUDGE_USE, JUDGE_SERVICE } from '../../core/delegation-judges.mjs';
import { createUsageMonitor, createUsageWarm, REFRESH_MS, STALE_MS, WARM_MS } from '../../core/delegation-usage.mjs';
import { claudeQuota, codexQuota } from '../../core/usage.mjs';
import { antigravityQuota } from '../../core/backends/antigravity-usage.mjs';

export const name = 'delegation-routing';
export const title = '委譲先の自動選択: 規則・段・使用量の後回し・Claude のアカウント・自動選択のモデル（偽の HTTP）・使用量の取り置き';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const HOUR = 3600_000, DAY = 24 * HOUR;
const zero = Object.fromEntries(SIGNALS.map(k => [k, false]));
// 週次の枠。used% で、経過率 elapsed%（リセットまでの残りから逆算）
const week = (used, elapsed, extra = {}) => ({ label: 'week', usedPercent: used, minutes: 10080, resetsAt: new Date(NOW + (100 - elapsed) / 100 * 7 * DAY).toISOString(), ...extra });
const h5 = (used, extra = {}) => ({ label: '5h', usedPercent: used, minutes: 300, resetsAt: new Date(NOW + HOUR).toISOString(), ...extra });
const models = ids => Object.fromEntries(ids.map(id => [id, true]));
const ALL_MODELS = { claude: models(['haiku', 'sonnet', 'opus', 'fable']), codex: models(['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']),
  antigravity: models(['gemini-3.8-flash-high', 'claude-opus-4-6-thinking']) };
/** 検証（policy.mjs）の場面を振り分けの snapshot にする。claude は main（ログイン中）と oz（登録）の 2 アカウント */
function scenario({ main, oz, codex, agGemini, agClaude }) {
  const acct = (id, u) => ({ account: id, label: id || 'login', runnable: true, identity: { org: `org-${id || 'main'}`, email: `${id || 'main'}@example.com` },
    windows: [h5(u.h5), week(u.week[0], u.week[1])] });
  return {
    claude: { available: true, checkedAt: NOW - 60_000, windows: [], accounts: [acct('', main), acct('acct-oz', oz)], models: ALL_MODELS.claude },
    codex: { available: true, checkedAt: NOW - 60_000, windows: codex.week ? [week(codex.week[0], codex.week[1], { limitId: 'codex' })] : [], models: ALL_MODELS.codex },
    antigravity: { available: true, checkedAt: NOW - 60_000, models: ALL_MODELS.antigravity, windows: [
      h5(agGemini.h5, { group: 'Gemini Models' }), week(agGemini.week, 50, { group: 'Gemini Models' }),
      h5(agClaude.h5, { group: 'Claude and GPT models' }), week(agClaude.week, 50, { group: 'Claude and GPT models' })] },
  };
}
const S1 = scenario({ main: { h5: 30, week: [50, 60] }, oz: { h5: 10, week: [20, 60] }, codex: { week: [11, 40] }, agGemini: { h5: 0, week: 0 }, agClaude: { h5: 1, week: 1 } });
const S2 = scenario({ main: { h5: 40, week: [85, 70] }, oz: { h5: 96, week: [42, 70] }, codex: { week: [20, 50] }, agGemini: { h5: 0, week: 0 }, agClaude: { h5: 5, week: 2 } });
const S3 = scenario({ main: { h5: 20, week: [40, 50] }, oz: { h5: 0, week: [10, 50] }, codex: { week: [92, 80] }, agGemini: { h5: 0, week: 0 }, agClaude: { h5: 1, week: 1 } });
const S4 = scenario({ main: { h5: 96, week: [60, 60] }, oz: { h5: 20, week: [30, 40] }, codex: { week: [30, 50] }, agGemini: { h5: 10, week: 3 }, agClaude: { h5: 1, week: 1 } });
const settings = normalizeSettings({});
// 既定の段の Claude の候補ごとに、oz のアカウントの候補を後ろに足した設定（ADR 0264: 候補はアカウント 1 つの単位）
const withOz = normalizeSettings({ tiers: Object.fromEntries(Object.entries(DEFAULTS.tiers).map(([tier, list]) =>
  [tier, list.flatMap(c => c.startsWith('claude:') ? [c, c.replace('claude:', 'claude@acct-oz:')] : [c])])) });
const target = r => r.ok ? `${r.routing.target.backend}:${r.routing.target.model}${r.routing.target.account !== null ? '@' + (r.routing.target.account || 'main') : ''}` : 'none';
const byDifficulty = { low: zero, mid: { ...zero, diagnose: true }, high: { ...zero, security_gate: true } };
const routeAt = (kind, difficulty, usage, s = settings) => route({ kind, judged: { judge: DEFAULT_JUDGE, signals: byDifficulty[difficulty], probabilities: null, fallback: null }, settings: s, usage, now: NOW });

// 偽の fetch。呼ばれた要求を残し、reply(url, body) の値を応答にする
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const out = await reply(url, body, init);
    if (out instanceof Error) throw out;
    const { status = 200, json } = out;
    const text = typeof json === 'string' ? json : JSON.stringify(json);
    return { ok: status >= 200 && status < 300, status, text: async () => text, body: { cancel: async () => {} } };
  };
  fn.calls = calls;
  return fn;
}
const judgeAnswer = p => ({ answers: Object.fromEntries(SIGNALS.map(k => [k, { type: 'noul', noul: p[k] ?? 0 }])) });

export default async function (t) {
  // ---- 設定
  t.ok('未設定なら既定値（既定で有効・判定は既定のモデル・レベルと種類は既定）', settings.enabled === true && settings.judge === DEFAULT_JUDGE
    && levelOrder(settings).join() === 't1,t2,t3,t4' && kindOrder(settings).join() === KINDS.join()
    && JSON.stringify(settings.tiers) === JSON.stringify(DEFAULTS.tiers) && settings.avoidPercent === 80 && settings.paceLimit === 1.2 && !Object.hasOwn(settings, 'staleMinutes'));
  const partial = normalizeSettings({ judge: 'someone/other-model', tiers: { t4: ['claude:fable'] }, avoidPercent: 70 });
  t.ok('一部だけの設定は既定で補う', partial.judge === 'someone/other-model' && partial.tiers.t4.join() === 'claude:fable' && partial.tiers.t1.length === 2 && partial.avoidPercent === 70);
  const rejects = [{ nope: 1 }, { enabled: 'yes' }, { avoidPercent: 0 }, { paceLimit: 'x' }, { judge: 'has space' }, { judge: 42 },
    { levels: [] }, { levels: [{ id: 'x y', name: '' }] }, { levels: [{ id: 'a', name: '' }, { id: 'a', name: '' }] },
    { kinds: [] }, { kinds: [{ id: 'Bad', name: '', desc: '' }] }, { kinds: [{ id: 'a', name: '', desc: '' }, { id: 'a', name: '', desc: '' }] },
    { tiers: { t9: [] } }, { tiers: { t1: ['no-colon'] } }, { tiers: { t1: ['claude:haiku', 'claude:haiku'] } }, { table: { design: ['t1', 't2'] } }, { table: { design: ['t1', 't2', 't7'] } }, { table: { cooking: ['t1', 't1', 't1'] } }];
  t.ok('画面からの保存（strict）は不正な値を断る', rejects.every(raw => { try { normalizeSettings(raw, { strict: true }); return false; } catch (e) { return e instanceof RoutingSettingsError && typeof e.code === 'string'; } }));
  t.ok('読むとき（strict でない）は不正な項目だけ既定に戻す', normalizeSettings({ avoidPercent: 500, paceLimit: 2 }).avoidPercent === 80 && normalizeSettings({ avoidPercent: 500, paceLimit: 2 }).paceLimit === 2);
  t.ok('保存済みの prefs に古い staleMinutes が残っていても、読むときはエラーにせず読み捨てる', !Object.hasOwn(normalizeSettings({ staleMinutes: 30 }), 'staleMinutes'));
  t.ok('外した項目（staleMinutes）が prefs に残っていても、画面からの保存（strict）は断らない', !Object.hasOwn(normalizeSettings({ staleMinutes: 30, avoidPercent: 70 }, { strict: true }), 'staleMinutes'));
  // 利用者が作るレベルと種類: 順は配列の順、表の無い種類は 中1つ上・高2つ上 で補う
  const custom = normalizeSettings({ levels: [{ id: 'lite', name: '軽い' }, { id: 'strong', name: '強い' }], kinds: [{ id: 'my_kind', name: '自分の種類', desc: '説明' }] }, { strict: true });
  t.ok('レベルと種類は利用者の並びで持ち、表の無い種類は 中1つ上・高2つ上', levelOrder(custom).join() === 'lite,strong' && custom.kinds[0].name === '自分の種類'
    && custom.table.my_kind.join() === 'strong,strong,strong' && custom.tiers.lite.join() === '' && custom.efforts.strong['*'] === undefined);
  t.ok('レベルを増やすと種類の表の行はそのレベルで読める', normalizeSettings({ levels: [{ id: 'a', name: '' }, { id: 'b', name: '' }, { id: 'c', name: '' }] }).table.review.join() === 'b,c,c');
  // 前の版（種類ごとの判定・迷ったら Qwen・創作の段 tv）の保存済みの設定は、判定 1 つと最後のレベルへ畳む（ADR。元の値は変えない）
  const legacy = { judgeByKind: { design: 'cerebras', review: 'none' }, escalateToCerebras: true, tiers: { tv: ['codex:gpt-6-astra'] }, table: { visual: ['tv', 'tv', 'tv'] }, efforts: { tv: { '*': '' } } };
  const migrated = migrateLegacySettings(legacy);
  t.ok('判定を使う種類があれば judge は既定のモデル、古い項目と tv は畳む', migrated.changed && migrated.raw.judge === DEFAULT_JUDGE
    && !Object.hasOwn(migrated.raw, 'judgeByKind') && !Object.hasOwn(migrated.raw, 'escalateToCerebras')
    && migrated.raw.tiers.t4.join() === 'codex:gpt-6-astra' && !Object.hasOwn(migrated.raw.tiers, 'tv')
    && migrated.raw.table.visual.join() === 't4,t4,t4' && !Object.hasOwn(migrated.raw.efforts, 'tv') && legacy.escalateToCerebras === true);
  t.ok('全部「しない」なら judge は none。今の judge があればそちらを残し、直すものが無ければ changed は false',
    migrateLegacySettings({ judgeByKind: { a: 'none', b: 'none' } }).raw.judge === 'none'
    && migrateLegacySettings({ judge: 'x/y', judgeByKind: { design: 'jev' } }).raw.judge === 'x/y'
    && migrateLegacySettings({ judge: 'none' }).changed === false && migrateLegacySettings(null).changed === false);
  const legacyRead = normalizeSettings(legacy, { strict: true });
  t.ok('前の版の設定は読むときも strict の保存でも今の形に畳む（unknownKey にしない）', legacyRead.judge === DEFAULT_JUDGE
    && !Object.hasOwn(legacyRead, 'judgeByKind') && !Object.hasOwn(legacyRead, 'escalateToCerebras') && !Object.hasOwn(legacyRead.tiers, 'tv'));
  t.ok('候補の id は backend:model（model の中の : はそのまま）', parseCandidate('codex:gpt-6-sol').model === 'gpt-6-sol' && parseCandidate('x:a:b').model === 'a:b' && !parseCandidate('claude') && !parseCandidate(':m') && !parseCandidate('claude: x'));
  t.ok('アカウントは backend@<id>:model。書かなければ account は null（ログイン中）', parseCandidate('claude:sonnet').account === null
    && (c => c.backend === 'claude' && c.model === 'sonnet' && c.account === 'acct-p')(parseCandidate('claude@acct-p:sonnet'))
    && parseCandidate('x@a:m@b:c').model === 'm@b:c' && !parseCandidate('@a:m') && !parseCandidate('claude@:m') && !parseCandidate('claude@a/b:m'));
  t.ok('候補の id を組む（ログイン中・アカウントを持たないなら @ を付けない）', candidateId('claude', 'opus', 'acct-p') === 'claude@acct-p:opus'
    && candidateId('claude', 'opus', '') === 'claude:opus' && candidateId('codex', 'gpt-6-sol') === 'codex:gpt-6-sol');
  const scoped = normalizeSettings({ tiers: { t1: ['claude:haiku', 'claude@acct-p:sonnet', 'codex:gpt-6-luna'], t4: ['claude@acct-s:opus'] } });
  t.ok('段に入っているアカウント（ログイン中は \'\'）。段に無いエージェントは空', [...tierAccounts(scoped, 'claude')].sort().join() === ',acct-p,acct-s'
    && [...tierAccounts(scoped, 'codex')].join() === '' && tierAccounts(scoped, 'codex').size === 1 && tierAccounts(scoped, 'devin').size === 0);

  // ---- 難しさの規則（v3・規則 A）
  t.ok('手がかり 0 → low、1〜2 → mid、3〜4 → high', difficultyOf(zero) === 'low' && ['diagnose', 'choose', 'long_procedure', 'many_parts'].every(k => difficultyOf({ ...zero, [k]: true }) === 'mid')
    && difficultyOf({ ...zero, diagnose: true, choose: true }) === 'mid' && difficultyOf({ ...zero, diagnose: true, choose: true, many_parts: true }) === 'high');
  t.ok('writes_shared は low を mid に上げる。security_gate はそれだけで high', difficultyOf({ ...zero, writes_shared: true }) === 'mid' && difficultyOf({ ...zero, writes_shared: true, diagnose: true }) === 'mid' && difficultyOf({ ...zero, security_gate: true }) === 'high');
  t.ok('手がかりが 6 つの真偽でなければ断る', [null, { ...zero, extra: false }, { ...zero, diagnose: 1 }, { diagnose: true }].every(v => { try { difficultyOf(v); return false; } catch { return true; } }));

  // ---- 使用量の判定
  const policy = { now: NOW, avoidPercent: 80, paceLimit: 1.2 };
  t.ok('5 時間は線を超えても後回しにせず、100% なら使えない', judgeWindows([h5(87), week(64, 70)], policy).ok
    && judgeWindows([h5(100), week(10, 50)], policy).reason === 'quota_full');
  t.ok('週次・モデル系統の週次・追加枠は線以上で後回し', judgeWindows([h5(10), week(80, 80)], policy).reason === 'quota_high'
    && judgeWindows([h5(10), week(80, 80, { model: 'opus' })], policy).reason === 'quota_high'
    && judgeWindows([h5(10), week(80, 80, { limitId: 'codex-extra' })], policy).reason === 'quota_high');
  t.ok('週次のペースが 1.2 を超えれば pace_high（経過率 20% 未満は見ない）', judgeWindows([week(25, 20)], policy).reason === 'pace_high' && judgeWindows([week(23, 20)], policy).ok
    && judgeWindows([week(50, 10)], policy).ok && judgeWindows([week(79, 70)], policy).ok);
  t.ok('pace_high には使用率・ペース・経過率を残す', (w => w.usedPercent === 25 && w.pace === 1.25 && w.elapsedPercent === 20)(judgeWindows([week(25, 20)], policy).window));
  const noReset = { label: 'week', usedPercent: 24, minutes: 10080, resetsAt: null };
  t.ok('経過率が出せない週次の枠は、使用率が 20% × 上限以下なら通し、超えれば pace_unknown', judgeWindows([noReset], policy).ok && judgeWindows([{ ...noReset, usedPercent: 25 }], policy).reason === 'pace_unknown');
  t.ok('リセット時刻を過ぎた枠は使い直しが始まっているので 0 とみなす', judgeWindows([{ ...h5(95), resetsAt: new Date(NOW - 1000).toISOString() }], policy).ok);
  t.ok('5 時間だけ不明でも後回しにしない。ほかの枠が不明・枠なしなら usage_unknown', judgeWindows([h5(null), week(10, 50)], policy).ok
    && judgeWindows([week(null, 50)], policy).reason === 'usage_unknown' && judgeWindows([], policy).reason === 'usage_unknown');
  t.ok('経過率はリセット時刻と期間から出す（範囲外は不明）', Math.round(elapsedPercent(week(0, 40), NOW)) === 40 && elapsedPercent({ minutes: 10080, resetsAt: '2030-01-01T00:00:00Z' }, NOW) === null);

  // ---- 候補に効く枠
  const cq = claudeQuota({ rate_limits: { five_hour: { utilization: 10 }, seven_day: { utilization: 20 }, seven_day_opus: { utilization: 90 }, model_scoped: [{ display_name: 'Fable', utilization: 85 }] } });
  t.ok('Claude: 全体の枠と、そのモデルの系統の週次だけが効く（Mythos は Fable の週次）', windowsFor('claude', 'opus', cq.windows).length === 3 && windowsFor('claude', 'sonnet', cq.windows).length === 2
    && windowsFor('claude', 'fable', cq.windows).length === 3
    && windowsFor('claude', 'claude-mythos-5-2', cq.windows).length === 3 && windowsFor('claude', 'claude-mythos-5-2', cq.windows).some(w => String(w.model ?? '').toLowerCase() === 'fable')
    && windowsFor('claude', 'claude-mythos-5-1', cq.windows).length === 3 && windowsFor('claude', 'claude-mythos-5-1', cq.windows).some(w => String(w.model ?? '').toLowerCase() === 'fable'));
  const xq = codexQuota({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 10080 } }, astra: { limitId: 'x1', limitName: 'GPT-6-Astra', primary: { usedPercent: 95, windowDurationMins: 10080 } } } });
  t.ok('Codex: 主の枠はどのモデルにも効き、追加の枠は名前が当たるモデルだけ', windowsFor('codex', 'gpt-6-sol', xq.windows).length === 1 && windowsFor('codex', 'gpt-6-astra', xq.windows).length === 2);
  const aq = antigravityQuota({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Flash', buckets: [{ window: '5h', remaining_fraction: .9 }] }, { name: 'Gemini Pro', buckets: [{ window: '5h', remaining_fraction: .1 }] },
    { name: 'Claude and GPT models', buckets: [{ window: '5h', remaining_fraction: .5 }] }] } } });
  t.ok('Antigravity: モデル名の語をいちばん多く含むグループの枠', windowsFor('antigravity', 'gemini-3.8-flash-high', aq.windows).map(w => w.group).join() === 'Gemini Flash'
    && windowsFor('antigravity', 'claude-opus-4-6-thinking', aq.windows).map(w => w.group).join() === 'Claude and GPT models' && windowsFor('antigravity', 'gpt-oss-120b', aq.windows).length === 1
    && windowsFor('antigravity', 'fake-model', aq.windows).length === 0);
  // 専用の枠（'Gemini 4 Argon'）は、系統・汎用の語を除いた名前の語が全部モデルの id に入るものだけ。
  // 汎用の枠と同点の語数でも混ぜない（gemini-3.8-flash に Gemini 4 Argon の満杯の枠が効いてしまった誤当たりの再発防止）
  const aq2 = antigravityQuota({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction: .999 }, { window: '5h', remaining_fraction: 1 }] },
    { name: 'Claude and GPT models', buckets: [{ window: 'weekly', remaining_fraction: 0 }] },
    { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remaining_fraction: 0 }] }] } } });
  t.ok('Antigravity: 専用の枠は識別語が全部入るモデルだけ', windowsFor('antigravity', 'gemini-3.8-flash-high', aq2.windows).map(w => w.group).join() === 'Gemini Models,Gemini Models'
    && windowsFor('antigravity', 'gemini-4-argon-high', aq2.windows).map(w => w.group).join() === 'Gemini 4 Argon'
    && windowsFor('antigravity', 'claude-sonnet-5-5-high', aq2.windows).map(w => w.group).join() === 'Claude and GPT models');
  t.ok('Antigravity: gemini-4-hydrogen-* は Argon の専用の枠でなく Gemini Models の枠',
    ['gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-low'].every(id => windowsFor('antigravity', id, aq2.windows).map(w => w.group).join() === 'Gemini Models,Gemini Models'));
  // 1.5.2 の形（'All Models' の 1 グループにモデルと段ごとのバケット）は系統ごとの行になり、モデルの系統の行だけが効く
  const aq3 = antigravityQuota({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [{ name: 'All Models', buckets: [
    'Gemini 4 Argon', 'Gemini 3.8 Flash', 'Gemini 3.7 Flash', 'Claude Opus 5.5', 'Claude Sonnet 5.5',
  ].flatMap(name => ['Low', 'High'].map(tier => ({ name: `${name} (${tier})`, remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' }))) }] } } });
  t.ok('Antigravity: モデルごとの枠はモデルの系統の行', windowsFor('antigravity', 'gemini-3.8-flash-high', aq3.windows).map(w => w.group).join() === 'Gemini 3.8 Flash'
    && windowsFor('antigravity', 'gemini-4-argon-low', aq3.windows).map(w => w.group).join() === 'Gemini 4 Argon'
    && windowsFor('antigravity', 'claude-opus-5-5-high', aq3.windows).map(w => w.group).join() === 'Claude Opus 5.5'
    && windowsFor('antigravity', 'gemini-3.1-pro-high', aq3.windows).length === 0);

  // ---- 振り分け（検証の場面 S1〜S4 と同じ答え。temporary の policy.mjs の自己テスト）
  t.ok('S1: 種類 trivial・低 → Antigravity Gemini Flash', target(routeAt('trivial', 'low', S1)) === 'antigravity:gemini-3.8-flash-high');
  t.ok('S1: design・高 → 書かない候補はログイン中のアカウントの Opus', target(routeAt('design', 'high', S1)) === 'claude:opus@main');
  const inOrder = routeAt('design', 'high', S1, withOz).routing;
  t.ok('ログイン中に余裕があれば、段の後ろの oz の候補は見ない（自動で釣り合わせない）', target({ ok: true, routing: inOrder }) === 'claude:opus@main'
    && inOrder.skipped.length === 0, JSON.stringify(inOrder));
  const s2 = routeAt('design', 'high', S2, withOz);
  t.ok('S2: ログイン中が週次 85% なら、同じ段の次の候補（oz の Opus。5 時間 96% でも週次に余裕）', target(s2) === 'claude:opus@acct-oz'
    && !s2.routing.selectedWithLowHeadroom && s2.routing.skipped.length === 1 && s2.routing.skipped[0].candidate === 'claude:opus'
    && s2.routing.skipped[0].account === '' && s2.routing.skipped[0].reason === 'quota_high', JSON.stringify(s2.routing));
  const s2plain = routeAt('design', 'high', S2);
  t.ok('S2: 段に oz が無ければ、ほかのアカウントへ落とさず、同じ段の次の候補（旧 tv から畳んだ gpt-6-astra）へ', target(s2plain) === 'codex:gpt-6-astra'
    && s2plain.routing.skipped.length === 2 && s2plain.routing.skipped.every(s => s.reason === 'quota_high'), JSON.stringify(s2plain.routing));
  t.ok('S3: investigate・中 → Codex が週次 92% なので Sonnet（ログイン中）', target(routeAt('investigate', 'mid', S3)) === 'claude:sonnet@main');
  t.ok('S3: visual は t4（創作の段は廃止）。ログイン中の Opus に余裕があればそこへ', DEFAULTS.table.visual.join() === 't4,t4,t4'
    && target(routeAt('visual', 'mid', S3)) === 'claude:opus@main');
  const newUx = routeAt('ux_new', 'mid', S1);
  t.ok('ux_new は既定で t4（Opus が先頭）へ行く', DEFAULTS.table.ux_new.join() === 't4,t4,t4' && newUx.routing.tier === 't4'
    && target(newUx).startsWith('claude:opus'), JSON.stringify(newUx.routing));
  t.ok('S4: investigate・中 → Codex gpt-6-sol', target(routeAt('investigate', 'mid', S4)) === 'codex:gpt-6-sol');
  t.ok('S4: design・高 → oz の方が空いていても、段の順のとおりログイン中の Opus（5 時間 96% は後回しにしない）', target(routeAt('design', 'high', S4, withOz)) === 'claude:opus@main');
  const s3m = routeAt('mechanical', 'mid', S3);
  t.ok('記録: 種類・難しさ・段・自動選択のモデル・取得時刻', s3m.routing.mode === 'auto' && s3m.routing.kind === 'mechanical' && s3m.routing.difficulty === 'mid' && s3m.routing.tier === 't2'
    && s3m.routing.baseTier === 't2' && s3m.routing.judge === DEFAULT_JUDGE && s3m.routing.usageAt === new Date(NOW - 60_000).toISOString() && s3m.routing.fallback === null);
  const stale = { ...S1, antigravity: { ...S1.antigravity, checkedAt: NOW - STALE_MS - 60_000 } };
  const st = routeAt('trivial', 'low', stale);
  t.ok('取得間隔の 3 倍（STALE_MS）を超えた使用量は usage_stale で飛ばし、次の候補（Haiku）へ', target(st) === 'claude:haiku@main' && st.routing.skipped[0].reason === 'usage_stale');
  t.ok('usageAt は選んだ候補の取得時刻（飛ばした古い候補の時刻ではない）。飛ばした候補には各自の取得時刻', st.routing.usageAt === new Date(NOW - 60_000).toISOString()
    && st.routing.skipped[0].checkedAt === new Date(NOW - STALE_MS - 60_000).toISOString());
  const again = route({ kind: 'trivial', judged: { judge: DEFAULT_JUDGE, signals: zero }, settings, usage: S1, now: NOW, rejected: { 'antigravity:gemini-3.8-flash-high': 'model_unknown' } });
  t.ok('選んだ後の確かめで落ちた候補（rejected）は理由を付けて飛ばし、次の候補へ', target(again) === 'claude:haiku@main' && again.routing.skipped[0].reason === 'model_unknown');
  const rejectedClaude = route({ kind: 'design', judged: { judge: DEFAULT_JUDGE, signals: byDifficulty.high }, settings: withOz, usage: S1, now: NOW,
    rejected: { 'claude:opus': 'model_unknown' } });
  t.ok('モデルの再確認で落ちたのはその候補（そのアカウント）の行だけで、同じ段の次の候補（oz の Opus）へ進む', target(rejectedClaude) === 'claude:opus@acct-oz'
    && rejectedClaude.routing.skipped.length === 1 && rejectedClaude.routing.skipped[0].account === '' && rejectedClaude.routing.skipped[0].reason === 'model_unknown',
    JSON.stringify(rejectedClaude.routing.skipped));
  const unknownModel = { ...S1, antigravity: { ...S1.antigravity, models: { 'gemini-3.8-flash-high': false } } };
  const unlisted = routeAt('trivial', 'low', unknownModel);
  t.ok('一覧に無いモデルでも飛ばさず選ぶ（使えるかは CLI が決める。ADR 0311）', target(unlisted) === 'antigravity:gemini-3.8-flash-high' && unlisted.routing.skipped.length === 0, JSON.stringify(unlisted.routing));
  t.ok('一覧に無い候補は、選べるまま「一覧に無い」知らせを付ける（modelNotListed）', (s => s?.usable === true && s.modelNotListed === true)(candidateStates({ settings, usage: unknownModel, now: NOW }).find(s => s.candidate === 'antigravity:gemini-3.8-flash-high')));
  const refused = route({ kind: 'trivial', judged: { judge: DEFAULT_JUDGE, signals: zero }, settings, usage: S1, now: NOW, rejected: { 'antigravity:gemini-3.8-flash-high': 'model_rejected' } });
  t.ok('CLI に断られた候補（model_rejected）は理由を付けて飛ばし、次の候補へ', target(refused) === 'claude:haiku@main' && refused.routing.skipped[0].reason === 'model_rejected');
  const gone = { ...S1, antigravity: { available: false, checkedAt: null, windows: [], models: {} } };
  t.ok('未接続のバックエンドは unavailable で飛ばす', routeAt('trivial', 'low', gone).routing.skipped[0].reason === 'unavailable');
  const climb = { ...S1, antigravity: { ...S1.antigravity, windows: [week(90, 80, { group: 'Gemini Models' }), week(90, 80, { group: 'Claude and GPT models' })] },
    claude: { ...S1.claude, accounts: S1.claude.accounts.map(a => ({ ...a, windows: [h5(95), week(90, 80)] })) } };
  const up = routeAt('trivial', 'low', climb);
  t.ok('段の候補が全部だめなら 1 つ上の段へ（t1 → t2 の Codex luna）', target(up) === 'codex:gpt-6-luna' && up.routing.tier === 't2' && up.routing.baseTier === 't1' && up.routing.skipped.length === 3, JSON.stringify(up.routing.skipped.map(s => s.candidate + ':' + s.reason)));
  const softSettings = normalizeSettings({ avoidPercent: 70, tiers: { t4: ['claude:opus', 'claude:fable'], t3: ['codex:gpt-6-sol'] } });
  const softUsage = { ...S1, claude: { ...S1.claude, accounts: [
    { account: '', label: 'main', runnable: true, windows: [h5(20), week(83, 70)] },
    { account: 'second', label: 'second', runnable: true, windows: [h5(30), week(83, 70)] },
    { account: 'oz', label: 'oz', runnable: true, windows: [h5(87), week(64, 70)] },
  ] } };
  const pickFrom = (usage, list = usage.claude.accounts.map(a => a.account)) => pickAccount({ backend: 'claude', model: 'opus', accounts: list, usage, settings: softSettings, now: NOW });
  t.ok('段の候補のアカウントを選ぶとき: 週次 83% の 2 アカウントより、週次 64%・5 時間 87% の OZ を余裕ありとして選ぶ', pickFrom(softUsage) === 'oz');
  const ozFull = { ...softUsage, claude: { ...softUsage.claude, accounts: softUsage.claude.accounts.map(a =>
    a.account === 'oz' ? { ...a, windows: [h5(100), week(64, 70)] } : a) } };
  t.ok('OZ だけ 5 時間枠が満杯なら、余裕の少ない 2 つのうち 5 時間の低いログイン中', pickFrom(ozFull) === '');
  const knownFirst = { claude: { ...softUsage.claude, accounts: [
    { account: 'unknown', label: 'unknown', runnable: true, windows: [] },
    { account: 'known', label: 'known', runnable: true, windows: [h5(92), week(83, 70)] },
  ] } };
  t.ok('使用量が分かる余裕の少ないアカウントを、不明なアカウントより先に選ぶ', pickFrom(knownFirst) === 'known');
  const sameMaximum = { claude: { ...S1.claude, accounts: [
    { account: 'fast', label: 'fast', runnable: true, windows: [h5(83), week(60, 40)] },
    { account: 'slow', label: 'slow', runnable: true, windows: [h5(83), week(60, 80)] },
  ] } };
  t.ok('5 時間を除く最大使用率が同じなら週次ペースが低いアカウントを選ぶ', pickFrom(sameMaximum) === 'slow');
  const samePace = { claude: { ...S1.claude, accounts: [
    { account: 'five-high', label: 'five-high', runnable: true, windows: [h5(95), week(83, 80)] },
    { account: 'five-low', label: 'five-low', runnable: true, windows: [h5(10), week(83, 80)] },
  ] } };
  t.ok('週次の使用率とペースも同じときだけ 5 時間の低いアカウントを選ぶ', pickFrom(samePace) === 'five-low');
  const readyPressure = { claude: { ...S1.claude, accounts: [
    { account: 'slower-pace', label: 'slower-pace', runnable: true, windows: [h5(10), week(40, 80)] },
    { account: 'lower-week', label: 'lower-week', runnable: true, windows: [h5(90), week(30, 40)] },
  ] } };
  t.ok('余裕ありのアカウントも 5 時間以外の最大使用率をペースより先に比べる', pickFrom(readyPressure) === 'lower-week');
  t.ok('段に入っていないアカウントは、空いていても選ばない', pickFrom(softUsage, ['', 'second']) === '' && pickFrom(softUsage, ['second']) === 'second');
  t.ok('どれも使えなければ並びの先頭。段にアカウントが無ければ null', pickFrom(ozFull, ['oz']) === 'oz' && pickFrom(softUsage, []) === null);
  const candidatePressure = routeAt('investigate', 'mid', { ...S1,
    codex: { ...S1.codex, windows: [week(83, 80, { limitId: 'codex' }), h5(10, { limitId: 'codex' })] },
    claude: { ...S1.claude, accounts: [{ account: '', label: 'login', runnable: true, windows: [h5(95), week(75, 80)] }] },
  }, normalizeSettings({ avoidPercent: 70, tiers: { t3: ['codex:gpt-6-sol', 'claude:sonnet'], t4: [] } }));
  t.ok('余裕が少ない候補同士でも 5 時間を除く最大使用率を優先する', target(candidatePressure) === 'claude:sonnet@main');
  const ozOnly = routeAt('design', 'mid', ozFull, normalizeSettings({ avoidPercent: 70, tiers: { t4: ['claude@oz:opus', 'codex:gpt-6-sol'], t3: [] } }));
  t.ok('アカウントを書いた候補が満杯なら、ほかのアカウントへは落とさず、同じ段の次の候補へ', target(ozOnly) === 'codex:gpt-6-sol'
    && ozOnly.routing.skipped.length === 1 && ozOnly.routing.skipped[0].candidate === 'claude@oz:opus' && ozOnly.routing.skipped[0].account === 'oz'
    && ozOnly.routing.skipped[0].accountLabel === 'oz' && ozOnly.routing.skipped[0].reason === 'quota_full' && ozOnly.routing.skipped[0].window.minutes === 300,
    JSON.stringify(ozOnly.routing.skipped));
  const fullUsage = { ...S1, claude: { ...S1.claude, accounts: S1.claude.accounts.map(a => ({ ...a, windows: [h5(100), week(83, 70)] })) } };
  const lower = routeAt('design', 'mid', fullUsage, softSettings);
  t.ok('基準から上が全員 100% なら下の段の余裕ありを選ぶ', target(lower) === 'codex:gpt-6-sol'
    && lower.routing.baseTier === 't4' && lower.routing.tier === 't3' && lower.routing.skipped.every(s => s.reason === 'quota_full'));
  const lowerSoft = routeAt('design', 'mid', { ...fullUsage, codex: { ...S1.codex, windows: [week(92, 80, { limitId: 'codex' })] } }, softSettings);
  t.ok('下の段ではその段の余裕が少ない候補を、さらに下の余裕ありより先に選ぶ', target(lowerSoft) === 'codex:gpt-6-sol'
    && lowerSoft.routing.tier === 't3' && lowerSoft.routing.selectedWithLowHeadroom.reason === 'quota_high');
  const exhausted = routeAt('design', 'mid', { ...fullUsage, codex: { ...S1.codex, windows: [week(100, 50, { limitId: 'codex' })] },
    antigravity: { ...S1.antigravity, windows: [h5(100, { group: 'Gemini Models' }), h5(100, { group: 'Claude and GPT models' })] } }, softSettings);
  t.ok('見た全部の段が使えないときだけ失敗し、アカウントを持つ候補の行にはアカウントを添える', !exhausted.ok
    && exhausted.routing.skipped.filter(s => s.candidate === 'claude:opus').length === 1
    && exhausted.routing.skipped.find(s => s.candidate === 'claude:opus').account === ''
    && !Object.hasOwn(exhausted.routing.skipped.find(s => s.candidate === 'codex:gpt-6-sol'), 'account')
    && exhausted.routing.skipped.some(s => s.tier === 't1'));
  const mixedUsage = { claude: { ...S1.claude, accounts: [
    { account: 'week', label: 'week', runnable: true, windows: [h5(20), week(100, 70)] },
    { account: 'five', label: 'five', runnable: true, windows: [h5(100), week(20, 70)] },
  ] } };
  const mixed = ['claude@week:opus', 'claude@five:opus'].map(c => ({ candidate: c, check: checkCandidate(c, { usage: mixedUsage, settings: softSettings, now: NOW }) }));
  t.ok('アカウントの候補は、そのアカウントの枠の 100% を記録する', mixed.every(m => !m.check.ok && m.check.reason === 'quota_full')
    && mixed[0].check.window.label === 'week' && mixed[1].check.window.label === '5h' && mixed[0].check.accountLabel === 'week');
  const reasonLines = formatSkippedCandidates(mixed.map(({ candidate, check }) => ({ candidate, tier: 't4', account: check.account, accountLabel: check.accountLabel,
    reason: check.reason, window: check.window })));
  t.ok('エラー用の候補行はアカウントごとに異なる理由と枠を全部出す', reasonLines.includes('- claude@week:opus [week] (t4): quota_full week 100%')
    && reasonLines.includes('- claude@five:opus [five] (t4): quota_full 5h 100%'), reasonLines);
  const heldLine = formatSkippedCandidates([{ candidate: 'devin:swe-2-high', tier: 't3', reason: 'recently_limited', until: '2026-10-21T07:36:12.346Z' }]);
  t.ok('上限で止まった枠の候補行には、戻す時刻（until）を添える（Issue #111）', heldLine.includes('- devin:swe-2-high (t3): recently_limited until 2026-10-21T07:36:12.346Z'), heldLine);
  const perAccountStates = candidateStates({ settings: softSettings, usage: fullUsage, now: NOW }).find(s => s.candidate === 'claude:opus');
  t.ok('設定の状態: アカウントを登録したエージェントの書かない候補は、ログイン中のアカウントの使えるか・理由と枠だけ', perAccountStates.scoped === true
    && perAccountStates.account === '' && perAccountStates.accountLabel === 'login' && !perAccountStates.usable && perAccountStates.reason === 'quota_full'
    && perAccountStates.window.usedPercent === 100 && !Object.hasOwn(perAccountStates, 'accounts'), JSON.stringify(perAccountStates));
  const retryOz = checkCandidate('claude@acct-oz:opus', { usage: S1, settings: softSettings, now: NOW });
  t.ok('やり直しは候補の id でアカウントを選び、そのアカウントの判定で記録する', retryOz.ok && retryOz.account === 'acct-oz'
    && (r => r.target.backend === 'claude' && r.target.model === 'opus' && r.target.account === 'acct-oz' && r.target.accountLabel === 'acct-oz')(
      manualRouting({ kind: 'design', candidate: 'claude@acct-oz:opus', check: retryOz, of: 'old', from: null })));
  t.ok('使えないアカウントや登録に無いアカウントの候補は選べない', !checkCandidate('claude:opus', { usage: fullUsage, settings: softSettings, now: NOW }).ok
    && checkCandidate('claude@missing:opus', { usage: S1, settings: softSettings, now: NOW }).detail === 'no_account');
  const loginOnly = { claude: { ...S1.claude, accountable: true, accounts: undefined, windows: [h5(10), week(10, 70)] } };
  t.ok('アカウントの登録が無いエージェントは、書かない候補をログイン中で使い、アカウントを書いた候補は no_account', checkCandidate('claude:opus', { usage: loginOnly, settings: softSettings, now: NOW }).account === ''
    && checkCandidate('claude@acct-oz:opus', { usage: loginOnly, settings: softSettings, now: NOW }).detail === 'no_account');
  t.ok('判定が無い（signals が null）なら難しさは mid', route({ kind: 'implement', judged: { judge: 'none', signals: null, fallback: 'no_key' }, settings, usage: S1, now: NOW }).routing.difficulty === 'mid');
  t.ok('ux_change は判定に関係なく t4', routeAt('ux_change', 'low', S1).routing.tier === 't4');

  // ---- Claude のアカウント
  const acc = (account, windows, identity = null, runnable = true) => ({ account, label: account || 'login', windows, identity, runnable });
  const claudeOnly = accounts => ({ claude: { available: true, checkedAt: NOW, windows: [], accounts, models: ALL_MODELS.claude } });
  const pick = (accounts, list = accounts.map(a => a.account)) => pickAccount({ backend: 'claude', model: 'opus', accounts: list, usage: claudeOnly(accounts), settings, now: NOW });
  const check = (candidate, accounts) => checkCandidate(candidate, { usage: claudeOnly(accounts), settings, now: NOW });
  t.ok('週次ペースの低いアカウントを選ぶ', pick([acc('', [h5(10), week(40, 50)]), acc('a', [h5(50), week(20, 50)])]) === 'a');
  t.ok('週次ペースが同じなら 5 時間の低い方', pick([acc('', [h5(30), week(20, 50)]), acc('a', [h5(10), week(20, 50)])]) === 'a' && pick([acc('', [h5(5), week(20, 50)]), acc('a', [h5(10), week(20, 50)])]) === '');
  t.ok('トークンの無いアカウントは除き、5 時間 95% のログイン中を選ぶ。候補としても余裕あり',
    pick([acc('a', [h5(0), week(0, 50)], null, false), acc('', [h5(95)])]) === ''
    && check('claude:opus', [acc('', [h5(95)])]).ok && !check('claude:opus', [acc('', [h5(95)])]).deferred);
  // 「使えない」の中身（画面が「使えない（未インストール）」と添える）
  t.ok('使えない理由の中身: 有効でない・入っていない・トークンが無い・登録に無いアカウント',
    checkCandidate('codex:gpt-6-sol', { usage: { claude: { available: true, checkedAt: NOW, windows: [], models: {} } }, settings, now: NOW }).detail === 'disabled'
    && checkCandidate('codex:gpt-6-sol', { usage: {}, settings, now: NOW }).detail === undefined
    && checkCandidate('codex:gpt-6-sol', { usage: { codex: { available: false, checkedAt: null, windows: [], models: {} } }, settings, now: NOW }).detail === 'not_installed'
    && check('claude@a:opus', [acc('a', [h5(0), week(0, 50)], null, false)]).detail === 'no_token'
    && check('claude:opus', [acc('a', [h5(0), week(0, 50)])]).detail === 'no_account'
    && check('claude:opus', [acc('', [h5(95)])]).detail === undefined);
  const same = { org: 'org-1', email: 'Me@example.com' };
  t.ok('同じ人: 組織とメール（大小を区別しない）の両方が分かって一致する', sameIdentity(same, { org: 'org-1', email: 'me@example.com' })
    && !sameIdentity(same, { org: 'org-2', email: 'me@example.com' }) && !sameIdentity(same, { org: 'org-1', email: 'x@example.com' }));
  t.ok('メールか組織が分からなければ同じ人とみなさない', !sameIdentity({ org: 'org-1', email: null }, { org: 'org-1', email: null })
    && !sameIdentity(null, same) && !sameIdentity({ org: null, email: 'me@example.com' }, same));
  t.ok('同じ人でも別の候補として別々に判定する（まとめない）', check('claude@a:opus', [acc('', [h5(100)], same), acc('a', [h5(10), week(10, 50)], same)]).ok
    && !check('claude:opus', [acc('', [h5(100)], same), acc('a', [h5(10), week(10, 50)], same)]).ok);
  t.ok('登録が無い（accounts が無い）ときはログイン中のアカウント（\'\'）', checkCandidate('claude:haiku', { usage: { claude: { available: true, accountable: true, checkedAt: NOW, windows: [h5(1), week(1, 50)], models: ALL_MODELS.claude } }, settings, now: NOW }).account === '');

  // ---- 固定・画面用の一覧
  const codexAccounts = { codex: { available: true, accountable: true, checkedAt: NOW,
    models: ALL_MODELS.codex, accounts: [
      { account: 'failed', runnable: true, checkedAt: null, windows: [week(100, 60)] },
      { account: 'known', runnable: true, checkedAt: NOW, windows: [week(20, 60)] },
    ] } };
  const codexCheck = c => checkCandidate(c, { usage: codexAccounts, settings, now: NOW });
  t.ok('Codex も登録アカウントの行ごとに判定し、他の行の取得時刻で成功扱いにしない', codexCheck('codex@known:gpt-6-sol').ok && codexCheck('codex@known:gpt-6-sol').account === 'known'
    && codexCheck('codex@failed:gpt-6-sol').reason === 'usage_unknown');

  const pinned = pinnedRouting({ kind: 'review', backend: 'codex', model: 'gpt-6-sol' });
  t.ok('固定のときも kind を記録する', pinned.mode === 'pinned' && pinned.kind === 'review' && pinned.target.backend === 'codex' && pinned.target.model === 'gpt-6-sol' && pinned.difficulty === null);
  const retryCheck = checkCandidate('codex:gpt-6-sol', { usage: S3, settings, now: NOW });
  const retried = manualRouting({ kind: 'review', candidate: 'codex:gpt-6-sol', check: retryCheck, of: 'ply-task-old', from: null });
  t.ok('人がやり直すときも線を超えた候補を選べ、理由と線を残す', retryCheck.ok && retryCheck.deferred
    && retried.selectedWithLowHeadroom.reason === 'quota_high' && retried.selectedWithLowHeadroom.avoidPercent === 80);
  const states = candidateStates({ settings, usage: S3, now: NOW });
  t.ok('候補ごとの今の使用量と選べるかどうか（段・理由・アカウントごと）', states.length === 9 && states.find(s => s.candidate === 'codex:gpt-6-sol').reason === 'quota_high'
    && states.find(s => s.candidate === 'codex:gpt-6-sol').usable && states.find(s => s.candidate === 'codex:gpt-6-sol').deferred
    && states.find(s => s.candidate === 'claude:sonnet').scoped && states.find(s => s.candidate === 'claude:sonnet').account === ''
    && states.find(s => s.candidate === 'claude:sonnet').tiers.join() === 't2,t3' && !states.find(s => s.candidate === 'codex:gpt-6-sol').scoped);
  const ozStates = candidateStates({ settings: withOz, usage: S3, now: NOW });
  t.ok('同じモデルのアカウントごとの候補は、別々の行でそれぞれのアカウントの使用量', ozStates.length === 13
    && (o => o.account === 'acct-oz' && o.accountLabel === 'acct-oz' && o.windows.find(w => w.label === 'week').usedPercent === 10)(ozStates.find(s => s.candidate === 'claude@acct-oz:sonnet'))
    && ozStates.find(s => s.candidate === 'claude:sonnet').windows.find(w => w.label === 'week').usedPercent === 40);
  const warn = settingsWarnings({ settings: normalizeSettings({ tiers: { t1: ['antigravity:gemini-9', 'fake:x'] } }), usage: S1 });
  t.ok('今の一覧に無い候補・使えないバックエンドを知らせる（消さない）', warn.some(w => w.candidate === 'antigravity:gemini-9' && w.reason === 'model_unknown') && warn.some(w => w.candidate === 'fake:x' && w.reason === 'unavailable'));
  const warnAccounts = settingsWarnings({ settings: normalizeSettings({ tiers: { t1: ['claude@acct-gone:haiku', 'claude@acct-oz:haiku', 'codex@acct-x:gpt-6-luna'] } }), usage: S1 });
  t.ok('登録に無いアカウント（消したアカウント・登録の無いエージェント）の候補を知らせる', warnAccounts.some(w => w.candidate === 'claude@acct-gone:haiku' && w.reason === 'no_account')
    && warnAccounts.some(w => w.candidate === 'codex@acct-x:gpt-6-luna' && w.reason === 'no_account') && !warnAccounts.some(w => w.candidate === 'claude@acct-oz:haiku'), JSON.stringify(warnAccounts));

  // ---- 自動選択のモデル（偽の HTTP）。判定は 1 つのモデルだけ（前の版の「もう一方を試す」「迷ったら聞き直す」は廃止）
  const KEY = 'sk-or-test-SECRET-123';
  t.ok('判定のモデルの置き場は uses の judge:routing・サービスは openrouter', JUDGE_USE === 'judge:routing' && JUDGE_SERVICE === 'openrouter');
  const http = fakeFetch(() => ({ json: judgeAnswer({ diagnose: 0.49, choose: 0.31, long_procedure: 0.9, many_parts: 0.1, writes_shared: 0.02, security_gate: 0.18 }) }));
  const long = 'x'.repeat(TASK_LIMIT + 500);
  const a = await askJudge({ kind: '実装', task: long, model: DEFAULT_JUDGE, key: KEY, fetch: http });
  const sent = http.calls[0];
  t.ok('判定: decisions へ Noul 6 つ（v3 の文面と false 側）を送る', sent.url.endsWith('/alpha/decisions') && sent.body.model === DEFAULT_JUDGE
    && Object.keys(sent.body.questions).join() === SIGNALS.join() && sent.body.questions.diagnose.type === 'noul' && sent.body.questions.choose.criteria.false === 'The statement for choose is false for this task.', sent.url);
  t.ok('判定: 送るのは種類の名前・長さで切った依頼文と固定の判定指示だけ', sent.body.state.kind === '実装'
    && sent.body.state.task.length === TASK_LIMIT && Object.keys(sent.body.state).sort().join() === 'instructions,kind,task'
    && sent.init.headers.Authorization === `Bearer ${KEY}` && sent.init.redirect === 'manual');
  t.ok(`判定: はいの確率を ${DECISION_THRESHOLD} で真偽にする（どの手がかりも同じ線）`, a.signals.diagnose === false && a.signals.choose === false
    && a.signals.long_procedure === true && a.signals.security_gate === false && a.probabilities.diagnose === 0.49
    && (await askJudge({ kind: 'x', task: 'x', model: DEFAULT_JUDGE, key: KEY, fetch: fakeFetch(() => ({ json: judgeAnswer({ diagnose: 0.5 }) })) })).signals.diagnose === true);
  const code = async (fn, reply) => { try { await fn({ kind: 'review', task: 'x', model: DEFAULT_JUDGE, key: KEY, fetch: fakeFetch(reply) }); return 'ok'; } catch (e) { return e.message; } };
  t.ok('応答の形が違えば bad_response', await code(askJudge, () => ({ json: { answers: {} } })) === 'bad_response'
    && await code(askJudge, () => ({ json: judgeAnswer({ diagnose: 'yes' }) })) === 'bad_response'
    && await code(askJudge, () => ({ json: judgeAnswer({ diagnose: 1.5 }) })) === 'bad_response'
    && await code(askJudge, () => ({ json: 'not json' })) === 'bad_response');
  t.ok('HTTP の失敗は http_<status>、時間切れは timeout、つながらなければ network', await code(askJudge, () => ({ status: 429, json: { error: KEY } })) === 'http_429'
    && await code(askJudge, () => Object.assign(new Error('t'), { name: 'TimeoutError' })) === 'timeout' && await code(askJudge, () => new Error('ECONNREFUSED')) === 'network');
  const keys = values => async service => values[service];
  const judgeOk = fakeFetch(() => ({ json: judgeAnswer({ diagnose: 1 }) }));
  const none = await judgeDifficulty({ kind: 'visual', task: 'x', judge: 'none', keyOf: keys({ openrouter: KEY }), fetch: judgeOk });
  t.ok('判定しない（judge: none）なら送らず judge_none', none.judge === 'none' && none.signals === null && none.fallback === 'judge_none' && judgeOk.calls.length === 0);
  const noKeys = await judgeDifficulty({ kind: 'review', task: 'x', judge: DEFAULT_JUDGE, keyOf: keys({}), fetch: judgeOk });
  t.ok('キーが無ければ外へは何も送らず no_key（難しさは mid）', noKeys.judge === 'none' && noKeys.fallback === 'no_key' && judgeOk.calls.length === 0);
  const ok = await judgeDifficulty({ kind: 'review', task: 'x', judge: DEFAULT_JUDGE, keyOf: keys({ openrouter: KEY }), fetch: judgeOk });
  t.ok('答えが返れば judge はモデルの id・確率も残す', ok.judge === DEFAULT_JUDGE && ok.signals.diagnose === true && ok.probabilities.diagnose === 1 && ok.fallback === null && judgeOk.calls.length === 1);
  const failing = fakeFetch(() => ({ status: 503, json: {} }));
  const fb = await judgeDifficulty({ kind: 'review', task: 'x', judge: DEFAULT_JUDGE, keyOf: keys({ openrouter: KEY }), fetch: failing });
  t.ok('モデルが使えなければ判定なし（mid）で理由を残す。ほかのモデルには聞き直さない（1 回だけ送る）', fb.judge === 'none' && fb.signals === null && fb.fallback === 'http_503' && failing.calls.length === 1);
  const locked = await judgeDifficulty({ kind: 'review', task: 'x', judge: DEFAULT_JUDGE, keyOf: async () => { throw new Error(KEY); }, fetch: judgeOk });
  t.ok('キーを読めなければ key_unreadable（キーの中身をどこにも出さない）', locked.fallback === 'key_unreadable' && !JSON.stringify([none, noKeys, ok, fb, locked]).includes(KEY));
  t.ok('キーの形の検査', normalizeKey('  abc  ') === 'abc' && normalizeKey('') === null && normalizeKey('a b') === null && normalizeKey('x'.repeat(501)) === null);

  // ---- 使用量の取り置き
  let reads = 0, warmed = 0;
  const claudeB = { id: 'claude', usage: true, capabilities: { accounts: 'token' } }, agyB = { id: 'antigravity', usage: true }, codexB = { id: 'codex', usage: true }, fakeB = { id: 'fake' };
  let agyKnows = false;
  const monitor = createUsageMonitor({
    backends: () => [claudeB, agyB, codexB, fakeB], installed: id => id !== 'codex',
    read: async b => { reads++; if (b.id === 'claude') return { windows: [], checkedAt: NOW, accounts: [
      { label: 'ログイン中のアカウント', accountId: null, windows: [h5(10)] }, { label: 'work alice@example.com', accountId: 'acct-1', windows: [h5(20)] }, { label: 'b', accountId: 'acct-2', windows: [], message: 'x' }] };
      return { windows: [h5(5, { group: 'Gemini Models' })], checkedAt: null, message: 'failed' }; },
    candidates: () => ['claude:opus', 'antigravity:gemini-3.8-flash-high', 'codex:gpt-6-sol'],
    modelKnown: async (b, m) => b.id === 'antigravity' ? agyKnows : m === 'opus',
    warm: async b => { warmed++; if (b.id === 'antigravity') agyKnows = true; },
    claudeIdentities: async () => ({ login: { org: 'o', email: 'e@example.com' }, accounts: [{ id: 'acct-1', hasToken: true, identity: { org: 'o', email: 'E@example.com' } }, { id: 'acct-2', hasToken: false, identity: null }] }),
  });
  t.ok('取る前は空（振り分けは待たずに「不明」で飛ばす）', Object.keys(monitor.snapshot()).length === 0);
  await monitor.refresh();
  const snap = monitor.snapshot();
  t.ok('Claude: アカウントごとの枠・識別子・会話を回せるか（トークンの有無）', snap.claude.checkedAt === NOW && snap.claude.accounts.length === 3 && snap.claude.accounts[0].account === ''
    && snap.claude.accounts[1].identity.org === 'o' && snap.claude.accounts[1].runnable === true && snap.claude.accounts[2].runnable === false);
  t.ok('見出しのメールアドレスは伏せる（振り分けの記録はエージェントにも返る）', snap.claude.accounts[1].label === 'work a***@example.com');
  t.ok('取得に失敗した値は「不明」（checkedAt が null）', snap.antigravity.checkedAt === null && snap.antigravity.windows.length === 0);
  t.ok('一覧に無いモデルは、一覧を確かめ直して（warm）から見直す', snap.antigravity.models['gemini-3.8-flash-high'] === true && warmed === 1 && snap.claude.models.opus === true);
  t.ok('CLI が入っていないバックエンドは使えない（使用量も取らない）', snap.codex.available === false && reads === 2);
  t.ok('登録したアカウントは行ごとに判定し（トークンの無い行は no_token）、同じ人かは識別子で分かる', checkCandidate('claude@acct-2:opus', { usage: snap, settings, now: NOW }).detail === 'no_token'
    && sameIdentity(snap.claude.accounts[0].identity, snap.claude.accounts[1].identity) && !sameIdentity(snap.claude.accounts[0].identity, snap.claude.accounts[2].identity));

  const mythosUsage = {
    claude: {
      available: true, checkedAt: NOW, windows: [],
      models: { opus: true },
      accountModels: { '': { opus: true }, verified: { 'claude-mythos-5-2': true, opus: true }, plain: { opus: true } },
      accounts: [
        { account: '', label: 'login', runnable: true, windows: [h5(10), week(10, 50)] },
        { account: 'verified', label: 'verified', runnable: true, windows: [h5(10), week(85, 50, { model: 'fable' })] },
        { account: 'plain', label: 'plain', runnable: true, windows: [h5(10), week(10, 50)] },
      ],
    },
  };
  const mythosCheck = checkCandidate('claude@verified:claude-mythos-5-2', { usage: mythosUsage, settings: softSettings, now: NOW });
  t.ok('Mythos の候補の判定は Fable の週次の枠で判定する', mythosCheck.ok === true && mythosCheck.deferred === true && mythosCheck.reason === 'quota_high'
    && mythosCheck.window?.usedPercent === 85, JSON.stringify(mythosCheck));
  const mythosWarns = settingsWarnings({
    settings: normalizeSettings({ tiers: { t4: ['claude@verified:claude-mythos-5-2', 'claude@plain:claude-mythos-5-2', 'claude:claude-mythos-5-2'] } }),
    usage: mythosUsage,
  });
  t.ok('accountModels: アカウントごとにあるモデルだけを一覧ありとみなし、無いアカウントだけ警告する',
    !mythosWarns.some(w => w.candidate === 'claude@verified:claude-mythos-5-2')
    && mythosWarns.some(w => w.candidate === 'claude@plain:claude-mythos-5-2' && w.reason === 'model_unknown')
    && mythosWarns.some(w => w.candidate === 'claude:claude-mythos-5-2' && w.reason === 'model_unknown'), JSON.stringify(mythosWarns));

  t.ok('固定の自動委譲の段（t1〜t4）に Mythos は入れない（持たないアカウントがあるので、利用者が候補に書いたときだけ使う）',
    Object.values(DEFAULTS.tiers).flat().every(c => !/mythos/i.test(c)), JSON.stringify(DEFAULTS.tiers));

  const acctCatalogs = { '': { opus: {} }, 'acct-1': { opus: {}, 'claude-mythos-5-2': {} }, 'acct-2': { opus: {} } };
  const scopedMonitor = createUsageMonitor({
    backends: () => [{ id: 'claude', usage: true, capabilities: { accounts: 'token' }, models: async () => acctCatalogs[''] }],
    installed: () => true,
    read: async () => ({
      windows: [], checkedAt: NOW,
      accounts: [
        { label: 'login', accountId: null, windows: [h5(10)] },
        { label: 'verified', accountId: 'acct-1', windows: [h5(10)] },
        { label: 'plain', accountId: 'acct-2', windows: [h5(10)] },
      ],
    }),
    candidates: () => ['claude:opus', 'claude:claude-mythos-5-2', 'claude@acct-1:claude-mythos-5-2', 'claude@acct-2:claude-mythos-5-2'],
    scopeForAccount: async (b, acct) => ({ ...b, models: async () => acctCatalogs[acct] ?? {} }),
    modelKnown: async (b, m) => Object.hasOwn(await b.models(), m),
    claudeIdentities: async () => ({ login: null, accounts: [{ id: 'acct-1', hasToken: true }, { id: 'acct-2', hasToken: true }] }),
  });
  await scopedMonitor.refresh();
  const scopedSnap = scopedMonitor.snapshot();
  t.ok('使用量の取り置き: 候補ごとのモデル確認を scopeForAccount 経由でアカウントごとの accountModels に保持する',
    scopedSnap.claude.accountModels['']?.['claude-mythos-5-2'] === false
    && scopedSnap.claude.accountModels['acct-1']?.['claude-mythos-5-2'] === true
    && scopedSnap.claude.accountModels['acct-2']?.['claude-mythos-5-2'] === false
    && scopedSnap.claude.accountModels['']?.opus === true, JSON.stringify(scopedSnap.claude.accountModels));
  await scopedMonitor.settle();

  // ---- 使用量の取り置き: アカウントごとに一覧を持つエージェント（capabilities.accounts が 'token'）は、一覧の確かめ直し（warm）を使用量の公開の後に回す（ADR 0329）。
  // 公開はアカウントの数に比例して遅れない・確かめ直しはバックエンドごとに 1 本ずつ順に走る・一覧が変わったときだけもう 1 回知らせる
  {
    let warmRunning = 0, warmPeak = 0, warmStarts = 0, lateKnown = false, changes = 0;
    let releaseWarm;
    const warmGate = new Promise(r => { releaseWarm = r; });
    const tokenBackends = ['claude', 'claude2'].map(id => ({ id, usage: true, capabilities: { accounts: 'token' } }));
    const lateMonitor = createUsageMonitor({
      backends: () => tokenBackends, installed: () => true,
      read: async () => ({ windows: [], checkedAt: Date.now(), accounts: [] }),
      candidates: () => ['claude:late-model', 'claude@a1:late-model', 'claude@a2:late-model', 'claude@a3:late-model', 'claude2:late-model'],
      scopeForAccount: async (b, acct) => ({ ...b, scoped: acct }),
      modelKnown: async () => lateKnown,
      warm: async () => { warmStarts++; warmRunning++; warmPeak = Math.max(warmPeak, warmRunning); await warmGate; lateKnown = true; warmRunning--; },
      onChange: () => { changes++; },
    });
    const outcome = await Promise.race([lateMonitor.refresh().then(() => 'published'), new Promise(r => setTimeout(() => r('blocked'), 1500))]);
    const published = lateMonitor.snapshot();
    t.ok('アカウントごとに一覧を持つエージェントの確かめ直し（warm）が終わらなくても、使用量は公開される（公開は確かめ直しを待たない）',
      outcome === 'published' && changes === 1 && published.claude?.models['late-model'] === false && published.claude?.accountModels.a1?.['late-model'] === false
      && published.claude2?.models['late-model'] === false, `${outcome} ${changes} ${JSON.stringify(published)}`);
    t.ok('確かめ直しは公開の後に、バックエンドごとに 1 本ずつ始まる（先のバックエンドが終わるまで次は始まらない）', warmStarts === 1 && warmPeak === 1, `${warmStarts} ${warmPeak}`);
    releaseWarm();
    await lateMonitor.settle();
    const after = lateMonitor.snapshot();
    t.ok('確かめ直しは順に 1 本ずつ走り、一覧が変わったバックエンドだけ現在の値へ差し替えてもう 1 回知らせる',
      warmStarts === 2 && warmPeak === 1 && changes === 3 && after.claude.models['late-model'] === true && after.claude.accountModels.a2['late-model'] === true
      && after.claude2.models['late-model'] === true, `${warmStarts} ${warmPeak} ${changes} ${JSON.stringify(after)}`);
    await lateMonitor.refresh();
    await lateMonitor.settle();
    t.ok('一覧が揃っていれば確かめ直さない（取り直しの公開だけ）', warmStarts === 2 && changes === 4, `${warmStarts} ${changes}`);

    // 一覧に出ないままの候補（別の承認が要るモデルを書いたアカウントなど）。確かめ直しは取り直し 1 回につき 1 回で、アカウントの数に比例させない
    let missWarms = 0;
    const missMonitor = createUsageMonitor({
      backends: () => [tokenBackends[0]], installed: () => true,
      read: async () => ({ windows: [], checkedAt: Date.now(), accounts: [] }),
      candidates: () => ['claude@a1:gone', 'claude@a2:gone', 'claude@a3:gone', 'claude@a4:gone', 'claude@a5:gone'],
      scopeForAccount: async (b, acct) => ({ ...b, scoped: acct }),
      modelKnown: async () => false,
      warm: async () => { missWarms++; },
    });
    for (let i = 0; i < 3; i++) { await missMonitor.refresh(); await missMonitor.settle(); }
    t.ok('一覧に出ないままの候補があっても、確かめ直しは取り直し 1 回につき 1 回（アカウントの数だけ起こさない）',
      missWarms === 3 && Object.values(missMonitor.snapshot().claude.accountModels).every(map => map.gone === false), String(missWarms));

    // アカウントを登録するエージェント（capabilities.accounts が 'agent'）は、これまでどおり一覧の確かめ直しを待ってから公開し、アカウントの範囲には絞らない（ベースの一覧で判定する）
    let agentWarms = 0, agentScopes = 0, agentKnown = false;
    const agentMonitor = createUsageMonitor({
      backends: () => [{ id: 'codex', usage: true, capabilities: { accounts: 'agent' } }], installed: () => true,
      read: async () => ({ windows: [], checkedAt: Date.now(), accounts: [] }),
      candidates: () => ['codex@acct-1:gpt-6-sol', 'codex:gpt-6-sol'],
      scopeForAccount: async () => { agentScopes++; return null; },
      modelKnown: async () => agentKnown,
      warm: async () => { agentWarms++; agentKnown = true; },
    });
    await agentMonitor.refresh();
    t.ok('accounts が agent のエージェントは、確かめ直しを待ってから公開し（公開の後に回さない）、アカウントの範囲には絞らない',
      agentWarms === 1 && agentScopes === 0 && agentMonitor.snapshot().codex.models['gpt-6-sol'] === true && agentMonitor.snapshot().codex.accountModels['acct-1']['gpt-6-sol'] === true,
      `${agentWarms} ${agentScopes} ${JSON.stringify(agentMonitor.snapshot())}`);
    await agentMonitor.settle();

    // 監視は、アカウントごとに一覧を持つエージェント（'token'）の一覧を「手元の一覧だけで答えて」と頼む（passive。取り直しの確かめで一覧の CLI を並べて起こさない）。
    // ほかのエージェントにはこれまでどおり頼む（passive にしない）
    const asked = [];
    const passiveMonitor = createUsageMonitor({
      backends: () => [tokenBackends[0], { id: 'codex', usage: true, capabilities: { accounts: 'agent' } }, { id: 'fake', capabilities: {} }], installed: () => true,
      read: async () => ({ windows: [], checkedAt: Date.now(), accounts: [] }),
      candidates: () => ['claude:m', 'claude@a1:m', 'codex:m', 'codex@a2:m', 'fake:m'],
      scopeForAccount: async (b, acct) => ({ ...b, scoped: acct }),
      modelKnown: async (b, model, account, opts) => { asked.push(`${b.id}|${account}|${Boolean(opts?.passive)}`); return true; },
    });
    await passiveMonitor.refresh();
    await passiveMonitor.settle();
    t.ok('監視は、アカウントごとに一覧を持つエージェントだけ passive（手元の一覧だけ）で確かめるよう頼む',
      JSON.stringify([...asked].sort()) === JSON.stringify(['claude|a1|true', 'claude||true', 'codex|a2|false', 'codex||false', 'fake||false'].sort()), JSON.stringify(asked));
  }

  // ---- 使用量の取り置き: 一覧の確かめ直し（warm）の方針（createUsageWarm。ADR 0329）。
  // アカウントごとに一覧を持つエージェント（'token'）だけ一覧を引き直し（warmModels）、成否・ログイン中の状態によらず 30 分に 1 回まで。
  // ほかのエージェントは一覧を引かず、これまでどおりログインの確認（auth.status）だけ。時計は差し替えて、30 分の境目を見る
  {
    t.ok('確かめ直しを繰り返さない間隔は 30 分', WARM_MS === 30 * 60_000);
    let clock = 5_000_000;
    const now = () => clock;
    const MIN = 60_000;

    // ログイン中のアカウントが未ログインで、登録したアカウントのトークンだけで使うとき。一覧に出ない候補が残り続けても、取り直しのたびに確かめ直さない
    let tokenWarms = 0, tokenStatus = 0;
    const loggedOutToken = { id: 'claude', usage: true, capabilities: { accounts: 'token' }, auth: { status: async () => { tokenStatus++; return { loggedIn: false }; } } };
    const tokenMonitor = createUsageMonitor({
      backends: () => [loggedOutToken], installed: () => true,
      read: async () => ({ windows: [], checkedAt: Date.now(), accounts: [] }),
      candidates: () => ['claude@a1:gone'],
      scopeForAccount: async (b, acct) => ({ ...b, scoped: acct }),
      modelKnown: async () => false,
      warm: createUsageWarm({ warmModels: async b => { if (b.id === 'claude') tokenWarms++; }, now }),
    });
    const tokenStart = clock;
    for (let i = 0; i < 4; i++) { await tokenMonitor.refresh(); await tokenMonitor.settle(); clock += 5 * MIN; }
    t.ok('アカウントごとに一覧を持つエージェントは、ログイン中が未ログインでも、一覧の確かめ直しは 30 分に 1 回（取り直しを 5 分ごとに重ねても 1 回）',
      tokenWarms === 1 && tokenStatus === 0 && tokenMonitor.snapshot().claude.accountModels.a1.gone === false, `${tokenWarms} ${tokenStatus}`);
    clock = tokenStart + WARM_MS - 1;
    await tokenMonitor.refresh(); await tokenMonitor.settle();
    t.ok('30 分に 1 ミリ秒足りないあいだは、まだ確かめ直さない', tokenWarms === 1, String(tokenWarms));
    clock = tokenStart + WARM_MS;
    await tokenMonitor.refresh(); await tokenMonitor.settle();
    t.ok('30 分たったら、もう 1 回だけ確かめ直す', tokenWarms === 2, String(tokenWarms));
    await tokenMonitor.refresh(); await tokenMonitor.settle();
    t.ok('確かめ直したら、また 30 分は繰り返さない', tokenWarms === 2, String(tokenWarms));

    // 一覧を引くのが失敗し続けても（オフラインなど）同じ。失敗した確かめ直しを、取り直しのたびに（一覧の CLI を起こして）繰り返さない。バックエンドごとに数える
    const failedIds = [];
    const failWarm = createUsageWarm({ warmModels: async b => { failedIds.push(b.id); throw new Error('offline'); }, now });
    const failTokens = [{ id: 'claude', capabilities: { accounts: 'token' } }, { id: 'claude2', capabilities: { accounts: 'token' } }];
    let rejected = false;
    for (let i = 0; i < 4; i++) { for (const b of failTokens) await failWarm(b).catch(() => { rejected = true; }); clock += 5 * MIN; }
    t.ok('一覧を引くのが失敗し続けても 30 分は繰り返さず（バックエンドごとに 1 回）、失敗を呼び出し元へ投げない',
      JSON.stringify(failedIds) === JSON.stringify(['claude', 'claude2']) && !rejected, JSON.stringify(failedIds));
    clock += WARM_MS;
    for (const b of failTokens) await failWarm(b);
    t.ok('失敗しても、30 分たてばまた確かめ直す', failedIds.length === 4, String(failedIds.length));

    // ほかのエージェント（accounts が 'agent'・アカウントを持たない・何も無い）は、一覧を引く口があっても回さない。ログインの確認だけ（agy はこれで一覧を覚える）。これまでどおり
    let otherWarms = 0, statusCalls = 0, loggedIn = true;
    const status = async () => { statusCalls++; return { loggedIn }; };
    const other = createUsageWarm({ warmModels: async () => { otherWarms++; }, now });
    const otherBackends = [
      { id: 'devin', capabilities: {}, warmModels: async () => { otherWarms++; }, auth: { status } },
      { id: 'grok', capabilities: { accounts: 'agent' }, warmModels: async () => { otherWarms++; }, auth: { status } },
      { id: 'antigravity', auth: { status } },
    ];
    for (let i = 0; i < 3; i++) for (const b of otherBackends) await other(b);
    t.ok('ほかのエージェントは一覧を引き直さず、ログインを確かめたら 30 分は繰り返さない', otherWarms === 0 && statusCalls === 3, `${otherWarms} ${statusCalls}`);
    clock += WARM_MS;
    for (const b of otherBackends) await other(b);
    t.ok('ほかのエージェントも、30 分たてばまたログインを確かめる（一覧は引かない）', otherWarms === 0 && statusCalls === 6, `${otherWarms} ${statusCalls}`);
    loggedIn = false; statusCalls = 0;
    clock += WARM_MS;
    for (let i = 0; i < 3; i++) for (const b of otherBackends) await other(b);
    t.ok('未ログインのままなら、ほかのエージェントは取り直しのたびにまた確かめる（これまでどおり）', otherWarms === 0 && statusCalls === 9, `${otherWarms} ${statusCalls}`);
    statusCalls = 0;
    await other({ id: 'plain', capabilities: {}, warmModels: async () => { otherWarms++; } });
    let flaky = 0;
    const flakyBackend = { id: 'flaky', auth: { status: async () => { flaky++; throw new Error('failed'); } } };
    await other(flakyBackend); await other(flakyBackend);
    t.ok('ログインを確かめる口が無ければ何もせず、確かめに失敗したら未ログインと同じに次の取り直しでまた確かめる', otherWarms === 0 && statusCalls === 0 && flaky === 2, `${otherWarms} ${statusCalls} ${flaky}`);

    // 監視を通しても同じ: 一覧に出ない候補があるアカウント付きのエージェント（'agent'）は、公開の前に 1 回だけログインを確かめ、一覧は引き直さない
    let agentWarmModels = 0, agentStatus = 0;
    const agentBackend = { id: 'grok', usage: true, capabilities: { accounts: 'agent' }, auth: { status: async () => { agentStatus++; return { loggedIn: true }; } } };
    const agentMonitor = createUsageMonitor({
      backends: () => [agentBackend], installed: () => true,
      read: async () => ({ windows: [], checkedAt: Date.now(), accounts: [] }),
      candidates: () => ['grok:gone'],
      modelKnown: async () => false,
      warm: createUsageWarm({ warmModels: async () => { agentWarmModels++; }, now }),
    });
    for (let i = 0; i < 3; i++) { await agentMonitor.refresh(); await agentMonitor.settle(); clock += 5 * MIN; }
    t.ok('監視を通しても、ほかのエージェントの確かめ直しは一覧を引かず、ログインの確認が 30 分に 1 回', agentWarmModels === 0 && agentStatus === 1 && agentMonitor.snapshot().grok.models.gone === false, `${agentWarmModels} ${agentStatus}`);
  }

  // ---- 使用量の取り置き: 古ければ判定と並行して取り直す（ensureFresh）。
  // 待ちの上限は unref のタイマーなので、遅らせる側は必ず実タイマー（setTimeout）にする。
  // 手動で解決する Promise だけを止めると、イベントループを保つものが無くなり上限のタイマーごと発火せずに固まる
  t.ok('古さの閾値は取得間隔の 3 倍', STALE_MS === REFRESH_MS * 3);
  let efReads = 0, efDelayMs = 0;
  const efBackend = { id: 'codex', usage: true };
  const efMonitor = createUsageMonitor({
    backends: () => [efBackend], installed: () => true,
    read: async () => { efReads++; if (efDelayMs) await new Promise(r => setTimeout(r, efDelayMs)); return { windows: [], checkedAt: Date.now() }; },
    candidates: () => ['codex:gpt-6-sol'], modelKnown: async () => true,
  });
  await efMonitor.ensureFresh(1000);
  t.ok('一度も取れていなければ取り直して待つ', efReads === 1 && Object.keys(efMonitor.snapshot()).length === 1);
  await efMonitor.ensureFresh(1000);
  t.ok('新しい値が揃っていれば取り直さずすぐ戻る', efReads === 1);
  efMonitor.snapshot().codex.checkedAt = Date.now() - STALE_MS - 1000;
  await efMonitor.ensureFresh(1000);
  t.ok('STALE_MS（取得間隔の 3 倍）を超えて古ければ取り直して待つ', efReads === 2);
  efMonitor.snapshot().codex.checkedAt = Date.now() - STALE_MS - 1000;
  efDelayMs = 100;
  const p1 = efMonitor.ensureFresh(1000);
  await new Promise(r => setTimeout(r, 10));
  const p2 = efMonitor.ensureFresh(1000);
  await Promise.all([p1, p2]);
  t.ok('取得中に呼ばれたら相乗りし、2 重に取り直さない', efReads === 3);
  efMonitor.snapshot().codex.checkedAt = Date.now() - STALE_MS - 1000;
  efDelayMs = 200;
  const start = Date.now();
  await efMonitor.ensureFresh(30);
  t.ok('取り直しが終わらなくても最長 ms で戻る（取り直しは裏で続く）', efReads === 4 && Date.now() - start < 150);
  await new Promise(r => setTimeout(r, 250));
  efDelayMs = 0;

  // ---- 使用量の取り置き: 1 回の確認ではモデルの一覧を候補ごとに取り直さない（一覧の取りかけを分け合う）。
  // warm の後の再確認は新しい取りかけを許す（一覧が裏で更新されているかもしれない）
  let listCalls = 0;
  const listBackend = { id: 'devin', usage: true, models: async () => { listCalls++; return { 'swe-2-high': {}, 'glm-5-2': {} }; } };
  const listMonitor = createUsageMonitor({
    backends: () => [listBackend], installed: () => true,
    read: async () => ({ windows: [], checkedAt: Date.now() }),
    candidates: () => ['devin:swe-2-high', 'devin:glm-5-2'],
    modelKnown: async (b, m) => Object.hasOwn(await b.models(), m),
  });
  await listMonitor.refresh();
  t.ok('1 回の取り置きでモデルの一覧は 1 回だけ引く（候補ごとではない）', listCalls === 1 && listMonitor.snapshot().devin.models['glm-5-2'] === true);
  let warmCalls = 0, warmListCalls = 0;
  const warmBackend = { id: 'devin', usage: true, models: async () => { warmListCalls++; return warmListCalls === 1 ? {} : { 'swe-2-high': {} }; } };
  const warmMonitor = createUsageMonitor({
    backends: () => [warmBackend], installed: () => true,
    read: async () => ({ windows: [], checkedAt: Date.now() }),
    candidates: () => ['devin:swe-2-high'],
    modelKnown: async (b, m) => Object.hasOwn(await b.models(), m),
    warm: async () => { warmCalls++; },
  });
  await warmMonitor.refresh();
  t.ok('一覧に無ければ warm の後にもう 1 回だけ引き直す', warmListCalls === 2 && warmCalls === 1 && warmMonitor.snapshot().devin.models['swe-2-high'] === true);

  // ---- 子の思考の強さ（ADR 0164）
  const strictFails = (raw, code) => { try { normalizeSettings(raw, { strict: true }); return false; } catch (e) { return e instanceof RoutingSettingsError && e.code === code; } };
  t.ok('強さの既定: 段 1 low・段 2 medium・段 3 medium・段 4 high', JSON.stringify(settings.efforts)
    === '{"t1":{"*":"low"},"t2":{"*":"medium"},"t3":{"*":"medium"},"t4":{"*":"high"}}' && JSON.stringify(DEFAULTS.efforts) === JSON.stringify(settings.efforts));
  t.ok('強さの語彙は弱い順に low・medium・high・xhigh・max', EFFORT_LEVELS.join() === 'low,medium,high,xhigh,max');
  const withTiers = normalizeSettings({ tiers: { t3: ['claude:sonnet', 'codex:gpt-6-sol'] }, efforts: { t3: { '*': 'high', 'claude:sonnet': 'low', 'codex:gpt-6-sol': '' } } }, { strict: true });
  t.ok('段の既定と候補の id ごとの上書きを読む（空は会話の既定に従う）。書かなかった段は既定のまま', withTiers.efforts.t3['*'] === 'high' && withTiers.efforts.t3['claude:sonnet'] === 'low'
    && withTiers.efforts.t3['codex:gpt-6-sol'] === '' && withTiers.efforts.t4['*'] === 'high');
  t.ok('段に無い候補の上書きは持ち越さない（外した候補・段にまだ無い候補）', normalizeSettings({ efforts: { t3: { 'claude:opus': 'high' } } }, { strict: true }).efforts.t3['claude:opus'] === undefined);
  t.ok('段の既定を書かない行は組み込みの段の既定で補う', normalizeSettings({ tiers: { t3: ['claude:sonnet'] }, efforts: { t3: { 'claude:sonnet': 'max' } } }, { strict: true }).efforts.t3['*'] === 'medium');
  t.ok('保存（strict）は形だけを見て断る: 語彙の外の強さ・候補でない対象・知らない段・形の違う値・多すぎる対象',
    strictFails({ efforts: { t3: { '*': 'extreme' } } }, 'badEffort') && strictFails({ efforts: { t3: { '*': 1 } } }, 'badEffort') && strictFails({ efforts: { t3: { nope: 'low' } } }, 'badEffortKey')
    && strictFails({ efforts: { t9: { '*': 'low' } } }, 'unknownLevel') && strictFails({ efforts: [] }, 'notObject') && strictFails({ efforts: { t3: 'low' } }, 'badEfforts')
    && strictFails({ efforts: { t3: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`claude:m${i}`, 'low'])) } }, 'badEfforts'));
  t.ok('モデルが持つかどうかは保存では見ない（xhigh を持たないモデルの候補にも書ける）', normalizeSettings({ tiers: { t2: ['claude:haiku'] }, efforts: { t2: { 'claude:haiku': 'xhigh' } } }, { strict: true }).efforts.t2['claude:haiku'] === 'xhigh');
  const lenient = normalizeSettings({ efforts: { t3: { '*': 'extreme' }, t9: { '*': 'low' }, t4: { '*': 'low' } } });
  t.ok('読むとき（strict でない）は不正な項目だけ既定に戻し、動く', lenient.efforts.t3['*'] === 'medium' && lenient.efforts.t4['*'] === 'low' && !('t9' in lenient.efforts)
    && normalizeSettings({ efforts: 'x' }).efforts.t1['*'] === 'low');
  t.ok('efforts を持たない前の版の設定も読める（unknownKey にしない）', normalizeSettings({ avoidPercent: 70 }, { strict: true }).efforts.t4['*'] === 'high');

  const tiersFor = normalizeSettings({ tiers: { t3: ['claude:sonnet', 'codex:gpt-6-sol'] } });
  t.ok('保存する efforts から、段に無い候補の上書きと既定と同じ行を落とす（空なら undefined）', JSON.stringify(pruneEfforts({ t3: { '*': 'medium', 'claude:haiku': 'low' }, t4: { '*': 'max' } }, tiersFor)) === '{"t4":{"*":"max"}}'
    && pruneEfforts({ t3: { '*': 'medium' } }, tiersFor) === undefined && pruneEfforts(undefined, tiersFor) === undefined
    && JSON.stringify(pruneEfforts({ t3: { 'claude:sonnet': 'low' } }, tiersFor)) === '{"t3":{"claude:sonnet":"low"}}');

  t.ok('合わせ: 持たない強さは近い下の強さへ（xhigh → high、max → high）。下が無ければ持つ中でいちばん弱いもの。持たないモデルは null',
    fitEffort(['low', 'medium', 'high'], 'xhigh') === 'high' && fitEffort(['low', 'medium', 'high'], 'max') === 'high' && fitEffort(['low', 'high'], 'medium') === 'low'
    && fitEffort(['medium', 'high'], 'low') === 'medium' && fitEffort(['low', 'medium'], 'medium') === 'medium' && fitEffort([], 'high') === null && fitEffort(['minimal'], 'low') === null);
  const lv = { levels: ['low', 'medium', 'high', 'xhigh'], fixed: null };
  const decide = (over, candidate, tier, capability = lv) => decideEffort({ settings: normalizeSettings({ tiers: { t3: ['claude:sonnet', 'codex:gpt-6-sol'] }, efforts: over }), tier, candidate, capability });
  const d1 = decide(undefined, 'codex:gpt-6-sol', 't3');
  t.ok('決まり方 1: 上書きが無ければ段の既定（medium・source tier）', d1.send === 'medium' && d1.effort === 'medium' && d1.source === 'tier' && d1.tier === 't3' && !('asked' in d1));
  const d2 = decide({ t3: { 'codex:gpt-6-sol': 'low' } }, 'codex:gpt-6-sol', 't3');
  t.ok('決まり方 2: 候補の上書きは段の既定に優先する（source override）', d2.send === 'low' && d2.source === 'override');
  const d3 = decide({ t3: { 'codex:gpt-6-sol': '' } }, 'codex:gpt-6-sol', 't3');
  t.ok('決まり方 3: 上書きの空は会話の既定（send は undefined = 会話の既定のまま。記録の強さは走らせてから決める）', d3.send === undefined && d3.effort === null && d3.source === 'conversation');
  const d4 = decide({ t3: { '*': '' } }, 'claude:sonnet', 't3');
  t.ok('決まり方 4: 段の既定が空でも会話の既定', d4.send === undefined && d4.source === 'conversation');
  const d5 = decide({ t3: { '*': 'max' } }, 'codex:gpt-6-sol', 't3');
  t.ok('決まり方 5: 持たない強さは合わせて断らず、元の強さを asked に残す', d5.send === 'xhigh' && d5.effort === 'xhigh' && d5.asked === 'max' && d5.source === 'tier');
  const d6 = decide({ t3: { 'claude:sonnet': 'xhigh' } }, 'claude:sonnet', 't3', { levels: ['low', 'medium', 'high'], fixed: null });
  t.ok('決まり方 6: 上書きでも合わせる（xhigh → high。source は override のまま）', d6.send === 'high' && d6.asked === 'xhigh' && d6.source === 'override');
  const d7 = decide(undefined, 'claude:haiku', 't1', { levels: [], fixed: null });
  t.ok('決まり方 7: 強さを持たないモデルには送らない（send は空・source none）', d7.send === '' && d7.effort === null && d7.source === 'none' && !('asked' in d7));
  const d8 = decide(undefined, 'antigravity:gemini-3.8-flash-high', 't1', { levels: [], fixed: 'high' });
  t.ok('決まり方 8: 強さがモデル名に入るモデルは送らず、名前の強さを記録する（source model）', d8.send === '' && d8.effort === 'high' && d8.source === 'model');
  // 実際の agy の一覧から引いた能力で（Hydrogen は xhigh も固定の段として記録する）
  const hyd = ['low', 'medium', 'high', 'xhigh'].map(l => ({ id: `gemini-4-hydrogen-${l}`, label: `Gemini 4 Hydrogen (${l === 'xhigh' ? 'XHigh' : l[0].toUpperCase() + l.slice(1)})` }));
  const hydBackend = { id: 'antigravity', traits: { effortInModelId: true }, models: async () => buildAgyModels(hyd, null) };
  const dx = decide(undefined, 'antigravity:gemini-4-hydrogen-xhigh', 't1', await effortCapability(hydBackend, 'gemini-4-hydrogen-xhigh'));
  const dh = decide(undefined, 'antigravity:gemini-4-hydrogen-high', 't1', await effortCapability(hydBackend, 'gemini-4-hydrogen-high'));
  t.ok('決まり方 8b: Hydrogen は id の段を記録する（xhigh → source model・effort xhigh、high → effort high。送らない）',
    dx.send === '' && dx.effort === 'xhigh' && dx.source === 'model' && dh.send === '' && dh.effort === 'high' && dh.source === 'model');
  const d9 = decide({ t3: { '*': 'low' } }, 'codex:gpt-6-sol', null);
  t.ok('決まり方 9: 段が決まらなければ会話の既定', d9.send === undefined && d9.source === 'conversation');
  t.ok('決まり方 10: 語彙の外の強さしか持たないモデルは送らない', decide(undefined, 'x:y', 't3', { levels: ['minimal'], fixed: null }).source === 'none');

  t.ok('やり直しの段: 元の段にその候補があればそれ、無ければ入っている最初の段、どこにも無ければ null',
    effortTierFor({ settings: tiersFor, candidate: 'claude:sonnet', preferred: 't3' }) === 't3' && effortTierFor({ settings: settings, candidate: 'claude:sonnet', preferred: 't3' }) === 't3' && effortTierFor({ settings: settings, candidate: 'claude:sonnet', preferred: 't4' }) === 't2'
    && effortTierFor({ settings: settings, candidate: 'claude:sonnet', preferred: null }) === 't2' && effortTierFor({ settings: settings, candidate: 'claude:sonnet', preferred: 't2' }) === 't2'
    && effortTierFor({ settings: settings, candidate: 'claude:nope' }) === null);
  const manual = manualRouting({ kind: 'implement', candidate: 'claude:sonnet', check: { ok: true, account: '', checkedAt: NOW }, of: 'ply-task-x', from: null, effortTier: 't3' });
  t.ok('人が選び直した記録は強さを引く段を持つ（段が無ければ付けない）', manual.effortTier === 't3'
    && !('effortTier' in manualRouting({ kind: 'implement', candidate: 'claude:sonnet', check: { ok: true, account: '', checkedAt: NOW }, of: 'ply-task-x', from: null })));

  t.ok('9 種類の kind', KINDS.length === 9);
}
