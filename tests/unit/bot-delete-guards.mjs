import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { z } from 'zod';
import { createBotService } from '../../core/bots/service.mjs';
import { createDispatcher } from '../../core/bots/dispatch.mjs';
import { createMemoryStore } from '../../core/memory/store.mjs';
import { createBrainStore } from '../../core/brain/store.mjs';
import { createPulse } from '../../core/brain/pulse.mjs';
import { createWakes } from '../../core/brain/wakes.mjs';
import { createEpisodes } from '../../core/memory/episodes.mjs';
import { createRegistry, defineOp, OpError } from '../../core/ops/registry.mjs';
import { createShellBridge } from '../../core/shell-bridge.mjs';
import { createRunner } from '../../core/routines/runner.mjs';

export const name = 'bot-delete-guards';
export const title = 'bot 削除の競合: 心拍・予約・専用要約・永続受信待ち・発行済み操作接続';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fails = async fn => { try { await fn(); return false; } catch (e) { return e.code === 'CANNOT_DELETE'; } };
const human = { kind: 'human' };
const flush = () => new Promise(r => setImmediate(r));

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-delete-guards-'));
  const closers = [];
  try {
    const backend = { id: 'fake', modes: () => ({ default: { scope: 'workspace', autonomy: 'ask' } }) };
    const host = { dataDir: dir, currentLocale: () => 'ja', store: { getAll: async () => ({}) }, getBackend: () => backend, listBackends: () => [backend], resolveModel: async () => '', resolveEffort: async () => '' };
    const bots = createBotService({ dataDir: dir, channels: { createDm: async ({ bot }) => ({ id: `dm_${bot.id}`, kind: 'dm' }), archive: async () => {} }, host });
    await bots.start();
    const make = name => bots.create({ name, backend: 'fake' }, human);
    const pulseBot = await make('Pulse');
    const brain = createBrainStore({ dataDir: dir });
    closers.push(() => brain.close());
    host.cleanupBot = async id => { brain.purgeBot(id); };
    // homeOf の await 中を止める。取得前から最後の setState まで活動を保持する。
    let entered = deferred(), unblock = deferred();
    const pulse = createPulse({ dataDir: dir, brain, bots, host, clock: { now: Date.now },
      channels: { list: async () => { entered.resolve(); await unblock.promise; return []; } } });
    const beat = pulse.beat(pulseBot.id, { force: true });
    await entered.promise;
    t.ok('心拍の家の取得中は削除を拒否', await fails(() => bots.remove({ botId: pulseBot.id })));
    unblock.resolve(); await beat;
    await bots.remove({ botId: pulseBot.id });
    await pulse.beat(pulseBot.id, { force: true });
    t.ok('削除後の心拍で活動メモ・状態を復活させない', brain.list(pulseBot.id).length === 0 && brain.state(pulseBot.id).lastBeatAt == null);

    const wakeBot = await make('Wake');
    let at = Date.now(); entered = deferred(); unblock = deferred();
    const wakes = createWakes({ dataDir: dir, bots, now: () => at,
      clock: { now: () => at, setTimer: () => null, clearTimer: () => {} },
      channels: { get: async () => ({ id: 'c', kind: 'channel' }) },
      budget: { allowsBrain: async () => { entered.resolve(); await unblock.promise; return false; } }, dispatch: {} });
    closers.push(() => wakes.close());
    wakes.add({ botId: wakeBot.id, sessionId: 's', channelId: 'c', at: at + 120000, note: 'wake' });
    await wakes.start(); at += 180000;
    const tick = wakes.tick(); await entered.promise;
    t.ok('予約の予算取得中から待機状態保存まで削除を拒否', await fails(() => bots.remove({ botId: wakeBot.id })));
    unblock.resolve(); await tick;
    host.cleanupBot = async id => { brain.purgeBot(id); wakes.clear(id); };
    await bots.remove({ botId: wakeBot.id }); await wakes.tick();
    t.ok('削除後の tick が予約を復活させない', wakes.list(wakeBot.id).length === 0);

    const episodeBot = await make('Episode'); entered = deferred(); unblock = deferred();
    let runTimer, saved = 0;
    const thread = { sessions: { [episodeBot.id]: 's' }, digest: {} };
    const episodes = createEpisodes({ bots,
      channels: { threads: { list: async () => [], get: async () => thread, update: async (_c, _t, patch) => { Object.assign(thread, typeof patch === 'function' ? patch(thread) : patch); saved++; } },
        get: async () => ({ id: 'c' }), read: async () => ({ posts: [{ id: 'p', author: human, text: 'keep body' }] }) },
      summarize: async () => { entered.resolve(); await unblock.promise; return { text: 'private digest', commit: async () => {} }; },
      setTimer: fn => { runTimer = fn; return 1; }, clearTimer: () => {} });
    closers.push(() => episodes.stop());
    await episodes.start(); episodes.onTurnEnd('c', 'p'); runTimer(); await entered.promise;
    t.ok('専用要約のモデル応答待ちでも削除を拒否', await fails(() => bots.remove({ botId: episodeBot.id })));
    unblock.resolve(); for (let i = 0; i < 20 && !saved; i++) await flush();
    await bots.remove({ botId: episodeBot.id });
    const was = saved; episodes.onTurnEnd('c', 'p'); runTimer(); await flush(); await flush();
    t.ok('削除後の古い予約から専用要約を再保存しない', saved === was);

    // 保存済みの inbox を新しい dispatcher から読み、復元直後も拒否する。
    const queuedBot = await make('Queue');
    const channels = { dir: path.join(dir, 'channels') };
    let dispatch = createDispatcher({ channels, bots, host });
    await dispatch.inbox.add({ botId: queuedBot.id, sessionId: 's', channelId: 'c', postId: 'p' });
    dispatch = createDispatcher({ channels, bots, host });
    t.ok('復元直後の未配送投稿は削除拒否対象', await dispatch.deletionBlocked(queuedBot.id));
    const [item] = await dispatch.inbox.list(); await dispatch.inbox.mark([item.id], 'delivering');
    t.ok('配送開始中の投稿も削除拒否対象', await dispatch.deletionBlocked(queuedBot.id));
    await dispatch.inbox.remove([item.id]);
    await dispatch.inbox.add({ botId: queuedBot.id, sessionId: 's', channelId: 'c', postId: 'p', reaction: { quiet: true } });
    host.refuseBotRemoval = async id => { if (await dispatch.deletionBlocked(id)) throw new OpError('CANNOT_DELETE', 'queued'); };
    host.cleanupBot = id => dispatch.cleanupBot(id);
    await bots.remove({ botId: queuedBot.id });
    t.ok('静かな通知だけなら削除でき、内部通知も片付く', (await dispatch.inbox.list()).length === 0);

    const routineBot = await make('Routine'); entered = deferred(); unblock = deferred();
    let created = 0;
    const runner = createRunner({ bots: { withActivity: bots.withActivity, get: bots.get,
      createSession: async () => { created++; return { sessionId: 'routine-session', mode: 'default' }; } }, host,
      channels: { get: async () => { entered.resolve(); await unblock.promise; return { id: 'c' }; },
        post: async () => ({ id: 'root' }), threads: { update: async () => {} } },
      dispatch: { wake: async () => {} }, clock: { now: Date.now, setTimer: () => null, clearTimer: () => {} }, record: async () => {} });
    closers.push(() => runner.stop());
    const routine = { id: 'r', name: 'Routine', prompt: 'hello', botId: routineBot.id, channelId: 'c', mode: 'default' };
    const launch = runner.run(routine); await entered.promise;
    t.ok('ルーティンのチャンネル取得前から会話作成・配送まで削除を拒否', await fails(() => bots.remove({ botId: routineBot.id })));
    unblock.resolve(); await launch;
    await bots.remove({ botId: routineBot.id });
    let rejected = false; try { await runner.run(routine); } catch (e) { rejected = e.code === 'BOT_NOT_FOUND'; }
    t.ok('削除後のルーティン発火で新しい会話を取り残さない', rejected && created === 1);

    // 生きた記憶・忘れた記憶の両方を取り消し履歴から除き、他 bot と共通層を保持。
    let memories = createMemoryStore({ dir: path.join(dir, 'memory') });
    await memories.init();
    const add = (layer, text) => memories.add({ layer, text, by: human });
    await add('b_deleted', 'private live');
    const forgotten = await add('b_deleted', 'private forgotten');
    await memories.forget({ id: forgotten.entry.id, by: human });
    await add('user', 'common'); await add('b_other', 'other');
    await memories.purgeLayer('b_deleted'); memories.close();
    memories = createMemoryStore({ dir: path.join(dir, 'memory') });
    closers.push(() => memories.close()); await memories.init();
    t.ok('再起動しても専用記憶・復元用履歴は消え、共通と他 bot は残る', memories.entries('b_deleted').length === 0 && !memories.forgottenEntry(forgotten.entry.id)
      && memories.entries('user')[0]?.text === 'common' && memories.entries('b_other')[0]?.text === 'other'
      && !JSON.stringify(memories.recordsSince(0)).includes('private'));
    await add('user', 'after migration');
    t.ok('移行後も共通記憶を追記できる', memories.entries('user').length === 2);

    // 呼び元の保護は、別の生存会話への操作にも掛け、承認後にも取り直す。
    const origin = await make('Origin');
    let retired = false, proceed, handled = 0;
    const withSessionWrite = async (_id, fn) => { if (retired) throw new OpError('READ_ONLY', 'read only'); return bots.withActivity(origin.id, fn); };
    const registry = createRegistry({ ops: [defineOp({ id: 'probe.send', summary: 'agent:ops.probe.send.summary', risk: 'guarded',
      input: z.object({}), surfaces: { ui: true, mcp: 'catalog', cli: true }, confirm: () => ({ before: null }),
      handler: async () => { handled++; return {}; } })] });
    const deps = { withSessionWrite, modeOf: () => ({ scope: 'workspace', autonomy: 'ask' }), approve: ({ proceed: run }) => { proceed = run; return { pending: true, requestId: 'req' }; } };
    const principal = { by: 'agent', via: 'mcp', sessionId: 'origin' };
    await registry.invoke(principal, 'probe.send', {}, deps);
    retired = true;
    t.ok('削除前の承認カードを後で許可しても実行しない', (await proceed()).code === 'READ_ONLY' && handled === 0);
    for (const via of ['mcp', 'cli']) t.ok(`発行済み ${via} の呼び元を受付前に拒否`, (await registry.invoke({ ...principal, via }, 'probe.send', {}, deps)).code === 'READ_ONLY' && handled === 0);
    t.ok('人の履歴整理には呼び元の実行制限を掛けない', (await registry.invoke({ by: 'human' }, 'probe.send', {}, deps)).ok && handled === 1);
    retired = false; entered = deferred(); unblock = deferred();
    const pending = registry.invoke(principal, 'probe.send', {}, { ...deps, modeOf: () => ({ scope: 'full', autonomy: 'never' }),
      audit: async () => { entered.resolve(); await unblock.promise; } });
    await entered.promise;
    t.ok('操作の受付から実行完了まで呼び元 bot の削除を拒否', await fails(() => bots.remove({ botId: origin.id })));
    unblock.resolve(); await pending;

    let shellGate = null;
    const bridge = createShellBridge({ withSessionWrite, askPermission: async () => shellGate ? shellGate() : ({ allow: true }) });
    const server = http.createServer((req, res) => bridge.handle(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    closers.push(async () => { await bridge.closeAll(); await new Promise(r => server.close(r)); });
    const port = bridge.open({ origin: `http://127.0.0.1:${server.address().port}`, locale: 'ja', owner: () => ({ sessionId: 'origin', cwd: dir, mode: { scope: 'workspace', autonomy: 'ask' } }) });
    retired = true;
    for (const tool of ['run', 'start']) {
      const res = await fetch(port.url, { method: 'POST', headers: { ...port.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { command: 'echo forbidden' } } }) });
      const body = await res.json();
      t.ok(`既存 ply_shell 接続の ${tool} を拒否`, body.result?.isError === true);
    }
    retired = false; entered = deferred(); unblock = deferred();
    shellGate = async () => { entered.resolve(); await unblock.promise; return { allow: false }; };
    const shellRequest = fetch(port.url, { method: 'POST', headers: { ...port.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run', arguments: { command: 'echo guarded' } } }) });
    await entered.promise;
    t.ok('シェルの受付・承認待ちの間も削除を拒否', await fails(() => bots.remove({ botId: origin.id })));
    unblock.resolve(); await (await shellRequest).json();
  } finally {
    for (const close of closers.reverse()) await close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
