import assert from 'node:assert/strict';
import { lang, setLanguage } from '../../web/i18n.mjs';
import { currentLocale, setLocale } from '../../core/i18n.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { codexQuota, whamQuota, claudeQuota, usageWindow, createQuotaStore, createUsageStore, createCodexMeter, agentUsage, compactQuota } from '../../core/usage.mjs';
import { normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';
import { quotaText, heldTexts } from '../../web/usage.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
export const name = 'usage';
export const title = '使用枠・残量・欠損・重複通知・記録の永続化';
export default async function(t) {
  // These assertions require Japanese, regardless of the host or preceding suite.
  const previousLanguage = lang;
  const previousLocale = currentLocale();
  try {
    setLocale("ja");
    await setLanguage("ja");
    await japaneseCases(t);
  } finally {
    setLocale(previousLocale);
    await setLanguage(previousLanguage);
  }
}

async function japaneseCases(t) {
  // 画面の起動: 入力欄の controls は作る時点で get() を呼び（承認モードのチップの when）、get() は usageSource を読む。
  // usageSource をそれより後で作ると、起動で ReferenceError になり画面が会話の一覧を出さずに止まる（0.27.0〜0.28.1）
  const clientSource = await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8');
  const sourceAt = clientSource.indexOf('const usageSource = createUsageSource(');
  const controlsAt = clientSource.indexOf('chatComposer.useControls(');
  assert.ok(sourceAt >= 0 && controlsAt >= 0 && sourceAt < controlsAt, 'usageSource は入力欄の controls より前に作る');
  t.ok('usageSource を入力欄の controls より前に作る', true);
  assert.equal(usageWindow('5h', null, null, 300).remainingPercent, null);
  assert.equal(usageWindow('5h', 0, null, 300).remainingPercent, 100);
  assert.equal(usageWindow('5h', 110, null, 300).remainingPercent, 0);
  assert.equal(usageWindow('5h', '20', 'bad', 300).usedPercent, null);
  const quota = codexQuota({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 60, windowDurationMins: 10080 } },
    spark: { limitName: 'Spark', primary: { usedPercent: 0, windowDurationMins: 15 } },
  } });
  assert.equal(quota.windows.length, 3);
  assert.equal(quota.windows[0].remainingPercent, 80);
  assert.equal(quota.windows[0].resetsAt, new Date(1800000000000).toISOString());
  assert.equal(quota.windows[2].minutes, 15);
  assert.equal(codexQuota({}).windows.length, 0);
  assert.equal(whamQuota({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1800000000 } } }).windows[0].remainingPercent, 60);
  assert.equal(claudeQuota({ subscription_type: 'max', rate_limits: { five_hour: { utilization: null }, seven_day: { utilization: 30 }, model_scoped: [{ display_name: 'Fable', utilization: 97 }] } }).windows[2].remainingPercent, 3);
  assert.match(quotaText(usageWindow('5h', 20, '2020-01-01', 300)), /更新待ち/);
  t.ok('欠損を0とせず、複数枠・秒の時刻・モデル別枠を表示する', true);

  const meter = createCodexMeter();
  const usage = (total, last) => ({ total: { inputTokens: total, outputTokens: total, cachedInputTokens: 0 }, last: { inputTokens: last, outputTokens: last, cachedInputTokens: 0 } });
  assert.equal(meter(usage(110, 10)).inputTokens, 10);
  assert.equal(meter(usage(110, 10)).inputTokens, 10);
  assert.equal(meter(usage(150, 40)).inputTokens, 50);
  assert.equal(meter(usage(20, 20)).inputTokens, 70);
  const events = normalizeSdkMessage({ type: 'result', subtype: 'success', total_cost_usd: .25,
    modelUsage: { main: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 30, cacheCreationInputTokens: 20 }, subagent: { inputTokens: 2, outputTokens: 3 } } });
  assert.equal(events.find(e => e.type === 'usage').inputTokens, 62);
  assert.equal(events.find(e => e.type === 'usage').outputTokens, 8);
  t.ok('Codex累積値の過去分・重複を除外し、Claudeはモデル集計を使う', true);

  let now = 100000, calls = 0;
  const qstore = createQuotaStore({ now: () => now });
  const fetcher = async () => { calls++; return { windows: [] }; };
  await Promise.all([qstore.refresh('codex', fetcher), qstore.refresh('codex', fetcher)]);
  await qstore.refresh('codex', fetcher); assert.equal(calls, 1);
  now += 61000; await qstore.refresh('codex', fetcher); assert.equal(calls, 2);
  qstore.invalidate(); await qstore.refresh('codex', fetcher); assert.equal(calls, 3);
  const failed = await qstore.refresh('bad', () => { throw new Error('Bearer secret'); });
  assert.equal(failed.checkedAt, null); assert.ok(!JSON.stringify(failed).includes('secret'));
  t.ok('同時取得を共有し、キャッシュ期限と認証変更を反映する', true);

  // ストア: get・revision・subscribe・invalidate の通知
  const notices = [];
  qstore.subscribe((key, snapshot) => notices.push([key, snapshot?.revision ?? null]));
  const first = await qstore.refresh('codex', fetcher);
  assert.equal(first.revision, 1); assert.equal(first.stale, false); assert.equal(qstore.get('codex').revision, 1);
  assert.equal(first.fetchedAt, now);
  now += 61000; await qstore.refresh('codex', fetcher);
  qstore.invalidate();
  assert.deepEqual(notices, [['codex', 2], [null, null]]);
  t.ok('ストアはスナップショットに revision・fetchedAt・stale を持ち、取得と無効化を購読へ届ける', true);

  // 永続化: 取れた値を usage-quota.json に残し、次の起動は stale 付きの前回値を先に返す
  const quotaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-quota-'));
  const saved = createQuotaStore({ now: () => now, dir: quotaDir });
  await saved.refresh('claude', async () => ({ plan: 'max', windows: [usageWindow('5h', 40, null, 300)], accounts: [{ label: 'acct' }] }));
  await saved.flush();
  const reopened = createQuotaStore({ now: () => now, dir: quotaDir });
  const staleEntry = reopened.get('claude');
  assert.equal(staleEntry.stale, true); assert.equal(staleEntry.plan, 'max'); assert.deepEqual(staleEntry.accounts, [{ label: 'acct' }]);
  let freshCalls = 0;
  const quick = await reopened.refresh('claude', async () => { freshCalls++; await new Promise(r => setTimeout(r, 20)); return { windows: [] }; });
  assert.equal(quick.stale, true);   // 取り直しを待たずに前回値を返す
  await new Promise(r => setTimeout(r, 60));
  assert.equal(freshCalls, 1); assert.equal(reopened.get('claude').stale, false);
  t.ok('終了時の値を usage-quota.json に残し、次の起動は stale 付きで先に返し、取り直したら新しい値に替わる', true);

  // ply_usage: 画面と同じ quotaStore を通すので、何度呼んでも各サービスへの問い合わせは増えない
  const fetched = {};
  const shared = createQuotaStore({ now: () => now });
  const agents = [
    { id: 'claude', label: 'Claude', capabilities: { accounts: 'token' }, usage: async () => ({ plan: 'max', windows: [], accounts: [
      { label: 'ログイン中のアカウント', plan: 'max', windows: [usageWindow('5時間', 40, 1800000000000, 300)], message: null },
      { label: 'tekalu@example.com', accountId: 'acct-0123456789ab', windows: [], needsUsageLogin: true, message: '認可してください' }] }) },
    { id: 'codex', label: 'Codex', usage: async () => { throw new Error('Bearer secret'); } },
    { id: 'fake', label: 'Fake' },
  ];
  const quotaOf = b => b.usage ? shared.refresh(b.id, () => { fetched[b.id] = (fetched[b.id] ?? 0) + 1; return b.usage(); }) : { windows: [], message: '未対応' };
  const deps = { list: () => agents, get: id => agents.find(b => b.id === id) ?? null, read: quotaOf };
  const all = await agentUsage(deps);
  assert.deepEqual(all.backends.map(b => b.backend), ['claude', 'codex']);
  const claude = all.backends[0];
  assert.deepEqual(Object.keys(claude.accounts[0].windows[0]).sort(), ['label', 'resetsAt', 'usedPercent']);
  assert.equal(claude.accounts[0].windows[0].usedPercent, 40);
  assert.equal(claude.accounts[1].label, 't***@example.com');
  assert.ok(!JSON.stringify(all).includes('accountId') && !JSON.stringify(all).includes('tekalu@'));
  // account は ply_delegate・ply_task_send の account に書ける名前（ログイン中は login、登録したものは内部の id。ADR 0205）
  assert.deepEqual(claude.accounts.map(a => a.account), ['login', 'acct-0123456789ab']);
  assert.ok(claude.accounts.every(a => a.runnable === undefined));
  assert.equal(typeof claude.checkedAt, 'string');
  const codex = all.backends[1];
  assert.equal(codex.checkedAt, null); assert.ok(codex.message && !JSON.stringify(codex).includes('secret'));
  t.ok('ply_usage は使用枠を持つ全バックエンドを返し、失敗は message に入れて他を返す', true);
  // 登録の一覧を渡すと、トークンの無いアカウントに runnable: false を付ける。一覧のトークン以外の欄も返さない
  const withTokens = await agentUsage({ ...deps, backend: 'claude', accounts: async () => [{ id: 'acct-0123456789ab', name: 'tekalu@example.com', ready: false, token: 'sk-ant-secret' }] });
  assert.deepEqual(withTokens.backends[0].accounts.map(a => [a.account, a.runnable]), [['login', undefined], ['acct-0123456789ab', false]]);
  assert.ok(!/sk-ant|tekalu@|hasToken/.test(JSON.stringify(withTokens)));
  t.ok('ply_usage の Claude の各アカウントに account の名前を付け、資格情報とメールアドレスは出さない', true);
  const one = await agentUsage({ ...deps, backend: 'claude' });
  assert.deepEqual(one.backends.map(b => b.backend), ['claude']);
  assert.equal(one.backends[0].checkedAt, claude.checkedAt);
  await quotaOf(agents[0]);
  assert.equal(fetched.claude, 1);
  assert.equal((await agentUsage({ ...deps, backend: 'fake' })).backends[0].message, '未対応');
  await assert.rejects(agentUsage({ ...deps, backend: 'nope' }), /nope/);
  await assert.rejects(agentUsage({ ...deps, backend: 3 }));
  assert.deepEqual(compactQuota(null), { plan: null, windows: [], checkedAt: null, message: null });
  assert.equal(compactQuota({ windows: [usageWindow('5時間', 90, 1000, 300)] }, 2000).windows[0].usedPercent, null);
  assert.equal(compactQuota({ windows: [usageWindow('5時間', 90, 3000, 300)] }, 2000).windows[0].usedPercent, 90);
  t.ok('ply_usage は backend 指定・不明名を扱い、画面と同じキャッシュを共有する', true);

  // 短い間隔の上限で止まっている枠（Issue #111）。日次・週次の率とは別に held で返し、画面は 0% の枠の上に一行出す
  const heldUntil = new Date(Date.now() + 3 * 60_000).toISOString();
  const guessUntil = new Date(Date.now() + 30 * 60_000).toISOString(), fiveUntil = new Date(Date.now() + 2 * 3600_000).toISOString();
  const heldSlots = { claude: [{ model: 'opus', account: null, reason: 'recently_limited', until: heldUntil, resetsAt: heldUntil, window: null },
    { model: null, account: 'acct-0123456789ab', reason: 'recently_limited', until: guessUntil, resetsAt: null, window: null },
    { model: null, account: null, reason: 'recently_limited', until: fiveUntil, resetsAt: fiveUntil, window: 'five_hour' }] };
  const withHeld = await agentUsage({ ...deps, held: b => heldSlots[b.id] ?? [] });
  assert.deepEqual(withHeld.backends[0].held, [
    { model: 'opus', account: 'login', reason: 'recently_limited', until: heldUntil, resetsAt: heldUntil },
    { model: null, account: 'acct-0123456789ab', reason: 'recently_limited', until: guessUntil, resetsAt: null },
    { model: null, account: 'login', reason: 'recently_limited', until: fiveUntil, resetsAt: fiveUntil, window: 'five_hour' }]);
  assert.equal(withHeld.backends[1].held, undefined, '止まっている枠の無いエージェントには held を付けない');
  const zero = { windows: [usageWindow('日次', 0, Date.now() + 86400_000, 1440), usageWindow('週次', 0, Date.now() + 7 * 86400_000, 10080)],
    accounts: [{ accountId: 'acct-0123456789ab', label: 'Work', windows: [] }] };
  const lines = heldTexts(withHeld.backends[0].held.map(s => ({ ...s, account: s.account === 'login' ? '' : s.account })), zero);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('opus: 短い間隔の上限で止まっています。') && lines[0].includes('解除の見込み'), lines[0]);
  // 解除の時刻が分からない上限は、振り分けが外す時刻までと言う（「ターンが通るまで」とは言わない。2026-10-21）
  assert.ok(lines[1].startsWith('既定のモデル · Work: ') && lines[1].includes('解除の時刻は分からないため') && !lines[1].includes('ターンが通るまで'), lines[1]);
  // 5 時間の枠で止まったものは、その枠の上限と言う（短い間隔の上限とは言わない。モデルを問わない 1 行）
  assert.ok(lines[2].startsWith('すべてのモデル: 5時間の枠の上限で止まっています。') && lines[2].includes('解除の見込み'), lines[2]);
  assert.ok(heldTexts([{ model: null, reason: 'retry_waiting', until: null }], zero)[0].includes('解除の時刻は分かりません'));
  assert.deepEqual(heldTexts([{ model: 'opus', until: new Date(Date.now() - 1000).toISOString() }], zero), [], '見込みを過ぎた枠は出さない');
  t.ok('ply_usage・使用量の画面は、日次・週次が 0% でも上限で止まっている枠と解除の見込みを出し、5 時間・週の枠の上限はその枠の名前で出す', true);


  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-usage-'));
  let server, client;
  const stores = [];
  try {
    let at = Date.now(); const store = createUsageStore(dir, { now: () => at });
    await Promise.all([store.record({ id: 'a', backend: 'codex', inputTokens: 12 }), store.record({ id: 'b', backend: 'claude', costUsd: .5 })]);
    await store.record({ id: 'a', backend: 'codex', inputTokens: 99 });
    const restored = createUsageStore(dir, { now: () => at });
    stores.push(store, restored);
    assert.equal((await restored.summary('codex')).fiveHour.inputTokens.value, 12);
    assert.equal((await restored.summary('codex')).fiveHour.costUsd.value, null);
    at += 6 * 3600000;
    assert.equal((await restored.summary('codex')).fiveHour.turns, 0);
    assert.equal((await restored.summary('codex')).sevenDay.turns, 1);
    server = await startServer({ dataDir: path.join(dir, 'server'), env: { AGENT_HOST_BACKENDS: 'codex', AGENT_HOST_CODEX_BIN: `node "${path.resolve('tests/lib/fake-codex.mjs')}"` } });
    client = await open({ port: server.port, token: server.token, autoAllow: true });
    await assert.rejects(client.cmd('providerUsage', { backend: 'invalid' }));
    await client.runTurn({ backend: 'codex', prompt: 'hello', cwd: dir }, { ms: 15000 });
    const result = await client.cmd('providerUsage', { backend: 'codex' });
    assert.equal(result.local.fiveHour.inputTokens.value, 10);
    assert.equal(result.local.fiveHour.outputTokens.value, 5);
    assert.equal(result.local.fiveHour.costUsd.value, null);
    t.ok('再起動・期間境界・エージェント別集計とWebSocket経路を検証', true);
  } finally { client?.close(); await server?.stop(); for (const s of stores) await s.close(); await fs.rm(dir, { recursive: true, force: true }); }
}
