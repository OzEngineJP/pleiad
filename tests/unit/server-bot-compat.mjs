// bot の互換の接続先（ADR 0359）をサーバー越しに確かめる。codex の身代わり（tests/lib/fake-codex.mjs）と偽の互換 API（tests/lib/fake-compat-api.mjs）だけと話す。LLM は呼ばない。
//   bots.setAccount { endpoint }（登録の無い id・選べない backend は断る・モデルと強さは接続先の既定へ戻る）→
//   bot の会話（DM）・ルーティン（本番・試し）・その会話からの委譲が、公式ではなく接続先の URL・鍵・モデルで走る →
//   接続先を消したら、どれも黙って公式へ戻さず止まる → 公式へ戻せば公式で走る → Pleiad を立て直しても bot の接続先が残る。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';

export const name = 'server-bot-compat';
export const title = 'bot の互換の接続先: 会話・ルーティン・委譲が接続先で走る・消したら止める・公式へ戻せる・再起動後も残る';

const KEY = 'sk-botcompat-' + 'b'.repeat(24);
const MODEL = 'vendor/fake-large';
const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 600)}`);
};
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-bot-compat-'));
  const log = path.join(scratch, 'fake-codex.log');
  const api = await startFakeCompatApi({ keys: [KEY], auth: 'bearer', models: [MODEL, 'fake-small'] });
  const env = { AGENT_HOST_BACKENDS: 'fake,codex', AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, FAKE_CODEX_LOG: log };
  let server = await startServer({ dataDir: scratch, env });
  let c = await open({ port: server.port, token: server.token, autoAllow: true });
  const call = (op, args) => c.cmd('invoke', { op, args });
  const entries = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const turns = async () => (await entries()).filter((e) => e.method === 'turn/start' && !e.ephemeral);
  const turnsAfter = async (n) => (await turns()).slice(n);
  const shown = (e) => JSON.stringify({ ...e, provider: { ...e?.provider, bearer: e?.provider?.bearer ? '(set)' : null } });
  const onEndpoint = (e) => e?.provider?.baseUrl === `${api.url}/v1` && e.provider.bearer === KEY && e.model === MODEL && /^ply_ep_/.test(e.provider.id);
  const readChannel = (channelId, threadId) => call('channels.read', { channelId, ...(threadId ? { threadId } : {}) });
  try {
    // ---- 接続先を登録して、codex の bot に付ける
    const input = { agent: 'codex', name: '偽の Responses', preset: 'custom', baseUrl: `${api.url}/v1`, authMode: 'bearer', key: KEY, roles: { main: MODEL } };
    const checked = await c.cmd('compatEndpointCheck', { input });
    const { id } = await c.cmd('compatEndpointSave', { input, receipt: checked.receipt });
    await call('settings.set', { key: 'botEnabled', value: true });
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'codex' });
    t.ok('作ったばかりの bot は公式（endpoint は空）', owl.endpoint === '' && owl.account === '', JSON.stringify(owl));
    const unknown = await rejects(call('bots.setAccount', { botId: owl.id, account: '', endpoint: 'ply_ep_unknown' }));
    t.ok('登録の無い接続先は断る', /not registered|登録/.test(unknown?.message ?? ''), unknown?.message);
    const fakeBot = await call('bots.create', { name: 'PlainFake', icon: '🧪', backend: 'fake' });
    const wrongBackend = await rejects(call('bots.setAccount', { botId: fakeBot.id, account: '', endpoint: id }));
    t.ok('接続先を選べない backend の bot では断る', wrongBackend !== null, wrongBackend?.message);
    const tuned = await call('bots.update', { botId: owl.id, model: 'fake-model-2', effort: 'high' });
    t.ok('公式のうちに選んだモデルと強さが入っている', tuned.model === 'fake-model-2' && tuned.effort === 'high', JSON.stringify([tuned.model, tuned.effort]));
    const attached = await call('bots.setAccount', { botId: owl.id, account: '', endpoint: id });
    t.ok('bots.setAccount { endpoint } で bot の接続先になり、モデルと強さは接続先の既定へ戻る', attached.endpoint === id && attached.account === '' && attached.model === '' && attached.effort === '', JSON.stringify(attached));
    t.ok('bots.get にも残る', (await call('bots.get', { botId: owl.id })).endpoint === id);

    // ---- bot の会話（DM）
    let before = (await turns()).length;
    await call('channels.post', { channelId: owl.dmChannelId, text: 'hello compat bot' });
    const dm = (await until(async () => { const b = await call('bots.get', { botId: owl.id }); return b.dmSessionId ? b : null; }, { label: 'DM の会話' })).dmSessionId;
    await until(async () => (await turnsAfter(before)).length > 0 && !(await c.cmd('running')).turns.some((x) => x.sessionId === dm), { label: 'DM のターン' });
    const dmTurn = (await turnsAfter(before)).at(-1);
    t.ok('bot の会話（DM）は公式ではなく接続先（URL・鍵・メインのモデル）で走る', onEndpoint(dmTurn), shown(dmTurn));
    const dmRow = (await c.cmd('listSessions')).find((s) => s.id === dm);
    t.ok('会話の記録は bot の接続先を compatEndpoint に写す', dmRow?.compatEndpoint === id, JSON.stringify(dmRow?.compatEndpoint));

    // ---- ルーティン（本番の実行と試しの実行）
    const ops = await call('channels.create', { name: 'ops' });
    const routine = await call('routines.create', { name: 'echo:互換', botId: owl.id, channelId: ops.id, prompt: '集計して', trigger: { kind: 'daily', at: '03:00', weekdaysOnly: false } });
    before = (await turns()).length;
    const ran = await call('routines.run', { routineId: routine.id });
    await until(async () => { const p = (await readChannel(ops.id)).posts.find((x) => x.id === ran.postId); return p?.state === 'done' ? p : null; }, { label: 'ルーティンの根の投稿が done' });
    const routineTurn = (await turnsAfter(before)).at(-1);
    t.ok('ルーティンの実行（bot の会話）も接続先で走る', onEndpoint(routineTurn), shown(routineTurn));
    const routineSid = (await readChannel(ops.id, ran.postId)).threads[0].sessions[owl.id];
    t.ok('ルーティンの会話の記録にも接続先が残る', (await c.cmd('listSessions')).find((s) => s.id === routineSid)?.compatEndpoint === id);
    before = (await turns()).length;
    const dry = await call('routines.run', { routineId: routine.id, dryRun: true });
    const dryTurn = (await turnsAfter(before)).at(-1);
    t.ok('試しの実行（投稿しない）も接続先で走る', dry.state === 'done' && onEndpoint(dryTurn), shown(dryTurn));

    // ---- 委譲: bot の会話から同じエージェントへ委譲すると、子も接続先を継ぐ
    before = (await turns()).length;
    await c.runTurn({ sessionId: dm, prompt: `agents:${JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'codex', task: 'hello-child' } })}` });
    const task = await until(async () => (await c.cmd('agentTasks')).find((x) => x.parentSessionId === dm || x.owner === dm || x.sessionId), { label: '委譲のタスク' });
    const childSid = task.sessionId;
    // 子が終わり、依頼元（bot の会話）への完了の知らせの回も終わるまで待つ（消した後の試験に、その回が混ざらないように）
    await until(async () => {
      const r = (await c.cmd('agentTasks')).find((x) => x.taskId === task.taskId);
      return r && !['queued', 'running', 'cancelling'].includes(r.status) && !['none', 'pending', 'delivering'].includes(r.notification) ? r : null;
    }, { label: '委譲の子の終わり', ms: 40_000 });
    await until(async () => !(await c.cmd('running')).turns.some((x) => x.sessionId === dm), { label: 'bot の会話が空く' });
    const childTurn = (await turnsAfter(before)).filter((e) => e.threadId !== dmTurn.threadId).at(-1);
    t.ok('委譲の子は親（bot の会話）の接続先を継いで、その接続先で走る', onEndpoint(childTurn) && (await c.cmd('listSessions')).find((s) => s.id === childSid)?.compatEndpoint === id, shown(childTurn));

    // ---- 接続先を消したら、どれも黙って公式へ戻さず止まる
    await c.cmd('compatEndpointDelete', { id });
    before = (await turns()).length;
    await call('channels.post', { channelId: owl.dmChannelId, text: 'after delete' });
    await sleep(1500);
    const afterDelete = await turnsAfter(before);
    const failedPost = (await readChannel(owl.dmChannelId)).posts.filter((p) => p.state === 'failed').at(-1);
    const refusal = failedPost?.failure ?? failedPost?.text ?? '';
    t.ok('接続先を消した bot の会話は、公式へ黙って戻さず送信を止め、選び直しを求める', afterDelete.length === 0 && failedPost?.author.kind === 'bot' && refusal.includes('削除されています'), `${afterDelete.length} turns / ${refusal}`);
    before = (await turns()).length;
    const failedRun = await call('routines.run', { routineId: routine.id }).catch((e) => ({ state: 'failed', error: e.message }));
    await sleep(1000);
    t.ok('ルーティンの実行も、公式へ戻さず止まる', (await turnsAfter(before)).length === 0, JSON.stringify(failedRun).slice(0, 300));

    // ---- 公式へ戻せば公式で走る
    const official = await call('bots.setAccount', { botId: owl.id, account: '', endpoint: '' });
    t.ok('bots.setAccount { endpoint: "" } で公式へ戻る', official.endpoint === '');
    before = (await turns()).length;
    await call('channels.post', { channelId: owl.dmChannelId, text: 'back on official' });
    await until(async () => (await turnsAfter(before)).length > 0 && !(await c.cmd('running')).turns.some((x) => x.sessionId === dm), { label: '公式のターン' });
    const officialTurn = (await turnsAfter(before)).at(-1);
    t.ok('公式へ戻した bot の会話は公式の provider で走る', officialTurn?.provider?.id === 'openai', shown(officialTurn));
    t.ok('会話の記録の接続先も外れる', ((await c.cmd('listSessions')).find((s) => s.id === dm)?.compatEndpoint ?? '') === '');

    // ---- 立て直しても bot の接続先は残る（bots.json）
    const again = await call('bots.create', { name: 'Hawk', icon: '🦅', backend: 'codex' });
    const checked2 = await c.cmd('compatEndpointCheck', { input });
    const saved2 = await c.cmd('compatEndpointSave', { input, receipt: checked2.receipt });
    await call('bots.setAccount', { botId: again.id, account: '', endpoint: saved2.id });
    c.close(); await server.stop();
    server = await startServer({ dataDir: scratch, env });
    c = await open({ port: server.port, token: server.token, autoAllow: true });
    t.ok('Pleiad を立て直しても bot の接続先は残る', (await c.cmd('invoke', { op: 'bots.get', args: { botId: again.id } })).endpoint === saved2.id);
    const secret = JSON.stringify({ events: c.events });
    t.ok('キーが画面へ出る流れに現れない', !secret.includes(KEY));
  } finally {
    c.close();
    await server.stop();
    await api.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
