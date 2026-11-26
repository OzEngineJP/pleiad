// 委譲の候補に互換の接続先（ADR 0360）をサーバー越しに確かめる。codex の身代わり（tests/lib/fake-codex.mjs）と偽の互換 API（tests/lib/fake-compat-api.mjs）だけと話す。LLM は呼ばない。
//   ply_usage の endpoints（inTiers・held・キーを出さない）→ ply_delegate の endpoint（id・名前）で子が接続先で走り、routing.target に接続先の名前 →
//   断る（登録に無い・2 つに当たる・別のエージェント・account と一緒・host と一緒・確認に失敗）→ 段の候補 codex@ep-…:model を自動の選択が上から順に選ぶ
//   （使用量は読めないので後回しにしない）→ 確認に失敗・直近の 429 の候補だけ飛ばす → 同じエージェントの委譲は親の接続先を継ぐ →
//   人のやり直しで互換の候補を選べる → 接続先を消すと段から候補が外れる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';

export const name = 'server-delegation-compat';
export const title = '委譲の候補に互換の接続先: endpoint で名指し・断る理由・自動の選択・確認の失敗と 429 は飛ばす・継ぐ・やり直し・消したら段から外す';

const KEY = 'sk-delegcompat-' + 'd'.repeat(24);
const MODEL = 'vendor/fake-large';
const prompt = (tool, args) => 'ply:' + JSON.stringify({ name: tool, arguments: args });
const until = async (fn, { ms = 30_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 600)}`);
};

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-deleg-compat-'));
  const log = path.join(scratch, 'fake-codex.log');
  const api = await startFakeCompatApi({ keys: [KEY], auth: 'bearer', models: [MODEL, 'fake-small'] });
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake,codex',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, FAKE_CODEX_LOG: log } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const entries = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const turns = async () => (await entries()).filter((e) => e.method === 'turn/start' && !e.ephemeral);
  const shown = (e) => JSON.stringify({ ...e, developerInstructions: undefined, provider: { ...e?.provider, bearer: e?.provider?.bearer ? '(set)' : null } });
  const onEndpoint = (e) => e?.provider?.baseUrl === `${api.url}/v1` && e.provider.bearer === KEY && e.model === MODEL && /^ply_ep_/.test(e.provider.id);
  const task = async (taskId) => (await c.cmd('agentTasks')).find((r) => r.taskId === taskId);
  const row = async (sessionId) => (await c.cmd('listSessions')).find((s) => s.id === sessionId);
  let parent = null;
  // 依頼元（fake）の会話から ply_agents のツールを 1 回呼び、戻り（エラーなら { error }）を読む
  const call = async (tool, args, sessionId = parent, prefix = 'ply:') => {
    const from = c.mark();
    const text = prefix === 'ply:' ? prompt(tool, args) : `${prefix}${JSON.stringify({ name: tool, arguments: args })}`;
    for (let i = 0; ; i++) {
      try { await c.runTurn({ sessionId, prompt: text }); break; }
      catch (e) { if (i > 200 || !/切り替え中|実行中|running/.test(e.message)) throw e; await sleep(50); }
    }
    const ev = await c.waitFor((e) => e.type === 'tool.result' && e.sessionId === sessionId, { from, ms: 60_000 });
    if (ev.isError) return { error: ev.text };
    // codex の身代わりは MCP の戻り（{ content: [{ text }] }）をそのまま返す
    const got = JSON.parse(ev.text);
    return Array.isArray(got?.content) ? JSON.parse(got.content[0].text) : got;
  };
  // 子が終わり、依頼元への完了の知らせの回も終わるまで待つ
  const settle = async (taskId, owner = parent) => {
    const r = await until(async () => {
      const x = await task(taskId);
      return x && !['queued', 'running', 'cancelling'].includes(x.status) && !['none', 'pending', 'delivering'].includes(x.notification) ? x : null;
    }, { label: `委譲 ${taskId} の終わり`, ms: 60_000 });
    await until(async () => !(await c.cmd('running')).turns.some((x) => x.sessionId === owner), { label: '依頼元が空く' });
    return r;
  };
  const childTurn = async (sessionId, before) => {
    const thread = (await row(sessionId))?.threadId;
    const list = (await turns()).slice(before);
    return (thread ? list.filter((e) => e.threadId === thread) : list).at(-1);
  };
  const register = async (name) => {
    const input = { agent: 'codex', name, preset: 'custom', baseUrl: `${api.url}/v1`, authMode: 'bearer', key: KEY, roles: { main: MODEL } };
    const checked = await c.cmd('compatEndpointCheck', { input });
    return (await c.cmd('compatEndpointSave', { input, receipt: checked.receipt })).id;
  };
  try {
    const A = await register('偽の互換 A');
    const B = await register('重なる名前');
    await register('重なる名前');
    t.ok('接続先の id は ep- と 16 進（候補の id は codex@<id>:model）', /^ep-[0-9a-f]+$/.test(A), A);
    const candA = `codex@${A}:${MODEL}`;
    const saved = await c.cmd('setDelegationRouting', { settings: { tiers: { t1: [candA, 'fake:fast'] } } });
    t.ok('互換の接続先の候補を段に保存できる（明示のモデル ID）', saved.settings.tiers.t1[0] === candA, JSON.stringify(saved.settings.tiers.t1));

    // ---- 設定の画面の状態: 候補は使える・後回しにしない・使用量は空
    const state = await c.cmd('delegationRouting');
    const stA = state.candidates.find((x) => x.candidate === candA);
    t.ok('候補の状態: 互換の候補は使える（deferred にしない）・接続先の名前を持つ・使用量の窓は空', stA?.usable === true && stA.deferred === false && stA.endpoint === A
      && stA.endpointLabel === '偽の互換 A' && stA.windows.length === 0, JSON.stringify(stA));
    t.ok('互換の候補にも強さの段（接続先の段 low / medium / high）', stA?.effort?.levels?.join() === 'low,medium,high', JSON.stringify(stA?.effort));
    t.ok('委譲の設定の状態に接続先の一覧（キーを持たない・state 付き）', state.endpoints?.codex?.some((e) => e.id === A && e.state === 'ready' && !('keyRef' in e)) && !JSON.stringify(state).includes(KEY), JSON.stringify(state.endpoints?.codex?.map((e) => [e.id, e.state])));

    // ---- ply_usage の endpoints
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_usage', { backend: 'codex' }) });
    parent = first.sessionId;
    const usageText = first.events.find((e) => e.type === 'tool.result').text;
    const eps = JSON.parse(usageText).backends[0].endpoints ?? [];
    const uA = eps.find((e) => e.id === A);
    t.ok('ply_usage のエージェントの行に endpoints（id・name・models・ready・inTiers）', uA?.name === '偽の互換 A' && uA.models[0] === MODEL && uA.ready === true && uA.inTiers === true
      && eps.find((e) => e.id === B)?.inTiers === false, JSON.stringify(eps));
    t.ok('ply_usage にキーを出さない', !usageText.includes(KEY));

    // ---- 断る。断ったら何も作らない
    const count = (await c.cmd('agentTasks')).length;
    const unknown = await call('ply_delegate', { kind: 'mechanical', endpoint: 'nope', task: 'x' });
    t.ok('登録に無い接続先は endpoint_unknown', String(unknown.error ?? '').includes('endpoint_unknown'), unknown.error);
    const ambiguous = await call('ply_delegate', { kind: 'mechanical', endpoint: '重なる名前', task: 'x' });
    t.ok('名前が 2 つ以上に当たると endpoint_ambiguous（id を求める）', String(ambiguous.error ?? '').includes('endpoint_ambiguous') && ambiguous.error.includes('2'), ambiguous.error);
    const other = await call('ply_delegate', { kind: 'mechanical', backend: 'fake', endpoint: A, task: 'x' });
    t.ok('別のエージェントの接続先は endpoint_other_agent', String(other.error ?? '').includes('endpoint_other_agent') && other.error.includes('codex'), other.error);
    const withAccount = await call('ply_delegate', { kind: 'mechanical', backend: 'codex', endpoint: A, account: 'login', task: 'x' });
    t.ok('account と一緒に書くと断る', /endpoint と account/.test(withAccount.error ?? ''), withAccount.error);
    const remote = await call('ply_delegate', { kind: 'mechanical', endpoint: A, host: 'somewhere', task: 'x' });
    t.ok('host と一緒には使えない', /ホストに任せるとき/.test(remote.error ?? ''), remote.error);
    t.ok('断った委譲はタスクを作らない', (await c.cmd('agentTasks')).length === count);

    // ---- 名指し（名前で）: 子はその接続先で走り、routing.target に接続先の名前
    let before = (await turns()).length;
    const named = await call('ply_delegate', { kind: 'mechanical', endpoint: '偽の互換 a', task: 'hello-named' });
    t.ok('名前（大文字小文字は問わない）で名指しでき、backend は接続先のエージェント', !named.error && named.taskId, JSON.stringify(named).slice(0, 400));
    let done = await settle(named.taskId);
    let turn = await childTurn(named.sessionId, before);
    t.ok('名指しした子はその接続先（URL・鍵・メインのモデル）で走る', done.status === 'completed' && onEndpoint(turn), shown(turn));
    t.ok('子の会話の記録に接続先が残る', (await row(named.sessionId))?.compatEndpoint === A);
    t.ok('routing.target に接続先と名前（アカウントは null）', done.routing?.target?.endpoint === A && done.routing.target.endpointLabel === '偽の互換 A' && done.routing.target.account === null, JSON.stringify(done.routing?.target));

    // ---- 自動の選択: 段の先頭の互換の候補を選ぶ（使用量は読めないが後回しにしない）
    before = (await turns()).length;
    const auto = await call('ply_delegate', { kind: 'trivial', task: 'hello-auto' });
    t.ok('自動の選択は段の上から順に互換の候補を選ぶ', !auto.error && auto.routing?.tier === 't1' && auto.routing.target?.endpoint === A && auto.routing.target.endpointLabel === '偽の互換 A', JSON.stringify(auto.routing ?? auto).slice(0, 500));
    done = await settle(auto.taskId);
    turn = await childTurn(auto.sessionId, before);
    t.ok('自動で選んだ互換の候補の子も、その接続先で走る', done.status === 'completed' && onEndpoint(turn), shown(turn));

    // ---- 人のやり直しで互換の候補を選ぶ
    const plain = await call('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:PLAIN' });
    await settle(plain.taskId);
    before = (await turns()).length;
    const retried = await c.cmd('retryAgentTask', { taskId: plain.taskId, candidate: candA, approved: true });
    const retriedId = retried.task?.taskId ?? retried.taskId;
    done = await settle(retriedId);
    turn = await childTurn(done.sessionId, before);
    t.ok('人のやり直しでも互換の候補を選べ、その接続先で走る', done.backend === 'codex' && done.routing?.target?.endpoint === A && onEndpoint(turn), JSON.stringify({ target: done.routing?.target, turn: shown(turn) }).slice(0, 600));

    // ---- 継ぐ: 互換の会話から同じエージェントへ、endpoint も account も書かずに委譲
    const { sessionId: compatSession } = await c.cmd('newSession', { backend: 'codex', cwd: ROOT });
    await c.cmd('setTurnSettings', { sessionId: compatSession, endpoint: A });
    await c.runTurn({ sessionId: compatSession, prompt: 'hello compat parent' });
    before = (await turns()).length;
    const inherited = await call('ply_delegate', { kind: 'mechanical', backend: 'codex', task: 'hello-inherit' }, compatSession, 'agents:');
    t.ok('互換の会話（codex）から委譲できる', !inherited.error && inherited.taskId, JSON.stringify(inherited).slice(0, 400));
    done = await settle(inherited.taskId, compatSession);
    turn = await childTurn(inherited.sessionId, before);
    t.ok('同じエージェントへの委譲は親の互換の接続先を継ぐ', onEndpoint(turn) && (await row(inherited.sessionId))?.compatEndpoint === A, shown(turn));
    t.ok('継いだ子の routing.target にも接続先の名前', done.routing?.target?.endpoint === A && done.routing.target.endpointLabel === '偽の互換 A', JSON.stringify(done.routing?.target));

    // ---- 直近の 429 の候補は飛ばす（接続先の枠 endpoint:<id> に記録する）
    const limited = await c.runTurn({ sessionId: compatSession, prompt: 'hit usage limit' });
    t.ok('互換の会話が上限で止まる', limited.outcome === 'limited', limited.outcome);
    const held = (await c.cmd('delegationRouting')).candidates.find((x) => x.candidate === candA);
    t.ok('429 の後、互換の候補は使えない（recently_limited）', held?.usable === false && held.reason === 'recently_limited', JSON.stringify(held));
    const usage429 = JSON.parse((await c.runTurn({ sessionId: parent, prompt: prompt('ply_usage', { backend: 'codex' }) })).events.find((e) => e.type === 'tool.result').text);
    const heldA = usage429.backends[0].endpoints.find((e) => e.id === A);
    t.ok('ply_usage の接続先の行に held（公式の held には混ぜない）', heldA?.held?.length === 1 && heldA.held[0].reason === 'recently_limited'
      && !(usage429.backends[0].held ?? []).some((h) => String(h.account ?? '').startsWith('endpoint:')), JSON.stringify({ heldA, held: usage429.backends[0].held }));
    const skipped = await call('ply_delegate', { kind: 'trivial', task: 'echo:SKIP429' });
    t.ok('自動の選択は 429 の互換の候補を飛ばして次の候補へ', !skipped.error && !skipped.routing?.target?.endpoint && skipped.routing.skipped?.some((s) => s.candidate === candA && s.reason === 'recently_limited'),
      JSON.stringify(skipped.routing ?? skipped).slice(0, 500));
    await settle(skipped.taskId);
    await c.runTurn({ sessionId: compatSession, prompt: 'hello again' });
    const cleared = (await c.cmd('delegationRouting')).candidates.find((x) => x.candidate === candA);
    t.ok('同じ接続先のターンが通ると 429 の記録は外れる', cleared?.usable === true, JSON.stringify(cleared));

    // ---- 確認に失敗した接続先は、名指しも自動の選択も通さない
    api.set({ keys: ['another'] });
    const recheck = await c.cmd('compatEndpointRecheck', { id: A });
    t.ok('確認し直すと失敗を返す', recheck.ok === false);
    const failedState = (await c.cmd('delegationRouting')).candidates.find((x) => x.candidate === candA);
    t.ok('確認に失敗した候補は使えない（unavailable・check_failed）', failedState?.usable === false && failedState.detail === 'check_failed', JSON.stringify(failedState));
    const failedNamed = await call('ply_delegate', { kind: 'mechanical', endpoint: A, task: 'x' });
    t.ok('名指しは endpoint_check_failed で断る（公式に黙って替えない）', String(failedNamed.error ?? '').includes('endpoint_check_failed'), failedNamed.error);
    const failedAuto = await call('ply_delegate', { kind: 'trivial', task: 'echo:SKIPFAIL' });
    t.ok('自動の選択は確認に失敗した候補を飛ばす', !failedAuto.error && !failedAuto.routing?.target?.endpoint && failedAuto.routing.skipped?.some((s) => s.candidate === candA && s.detail === 'check_failed'), JSON.stringify(failedAuto.routing ?? failedAuto).slice(0, 500));
    await settle(failedAuto.taskId);
    api.set({ keys: [KEY] });
    await c.cmd('compatEndpointRecheck', { id: A });
    t.ok('確認し直して通れば、また使える', (await c.cmd('delegationRouting')).candidates.find((x) => x.candidate === candA)?.usable === true);

    // ---- 消したら段から外れる
    await c.cmd('compatEndpointDelete', { id: A });
    const after = await c.cmd('delegationRouting');
    t.ok('接続先を消すと、その候補は段から外れる（ほかの候補は残す）', !after.settings.tiers.t1.includes(candA) && after.settings.tiers.t1.includes('fake:fast'), JSON.stringify(after.settings.tiers.t1));
    t.ok('キーが画面へ出る流れ・ログに現れない', !JSON.stringify(c.events).includes(KEY) && !server.tail(400).includes(KEY));
  } finally {
    c.close();
    await server.stop();
    await api.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
