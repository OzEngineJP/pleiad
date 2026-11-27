import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createInboxStore } from '../../core/bots/inbox.mjs';
import { dbPath, openRaw } from '../../core/db.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';

const { createServerLink, readLinkInfo } = createRequire(import.meta.url)('../../desktop/server-link.cjs');
const MIN = 60_000;

export const name = 'bot-update';
export const title = '更新の準備とサーバーの入れ替えをまたいで bot の予約・ルーティンを続ける';

async function until(check, label) {
  const deadline = Date.now() + 20_000;
  do {
    const result = await check();
    if (result) return result;
    await sleep(30);
  } while (Date.now() < deadline);
  throw new Error(`timeout: ${label}`);
}

export default async function (t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-bot-update-'));
  const dataDir = path.join(temp, 'data');
  const runtimeRoot = path.join(temp, 'runtime');
  const clockFile = path.join(temp, 'clock');
  const inboxFile = path.join(dataDir, 'channels', 'inbox.json');
  const time = Math.floor(Date.now() / MIN) * MIN;
  const setClock = value => fs.writeFile(clockFile, String(value));
  const inbox = async () => JSON.parse(await fs.readFile(inboxFile, 'utf8')).items;
  const env = {
    AGENT_HOST_BACKENDS: 'fake',
    AGENT_HOST_RUNTIME_ROOT: runtimeRoot,
    AGENT_HOST_HANDOVER: 'on',
    TEST_ROUTINES_CLOCK: clockFile,
    NODE_OPTIONS: `--loader="${pathToFileURL(path.join(ROOT, 'tests/lib/routines-clock-loader.mjs')).href}"`,
  };
  let server, client, main;
  async function boot(old) {
    server = await startServer({ dataDir, env: { ...env, ...old }, timeoutMs: 40_000 });
    const info = await until(() => {
      const link = readLinkInfo(dataDir);
      return link?.pid === server.child.pid ? link : null;
    }, 'main-link');
    main = createServerLink({ pipe: info.pipe, secret: info.secret, appVersion: '0.0.1' });
    main.on('message', message => {
      if (message.type === 'chrome-os-ready-request') main.postMessage({ type: 'chrome-os-ready', supported: false, reason: 'platform' });
    });
    await main.connect();
    client = await open({ port: server.port, token: server.token });
  }
  async function lock() {
    const id = randomUUID();
    let reply;
    main.on('message', message => { if (message.type === 'update-lock' && message.id === id) reply = message; });
    assert.ok(main.postMessage({ type: 'update-lock', id, leaseId: id, preserveTurns: true }));
    const result = await until(() => reply, 'update-lock');
    assert.ok(result.ok, result.reason);
    return id;
  }
  async function restart(afterStop) {
    const old = { AGENT_HOST_PORT: String(server.port), AGENT_HOST_TOKEN: server.token };
    client.close();
    assert.ok(main.postMessage({ type: 'shutdown' }));
    await until(() => server.child.exitCode !== null || server.child.signalCode !== null, '旧サーバーの終了');
    main.close?.();
    await afterStop();
    await boot(old);
  }
  const call = (op, args) => client.cmd('invoke', { op, args });
  try {
    await setClock(time + 30_000);
    await boot();
    await call('settings.set', { key: 'botEnabled', value: true });
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const channel = await call('channels.create', { name: 'updates', members: [owl.id] });
    const read = threadId => call('channels.read', { channelId: channel.id, ...(threadId ? { threadId } : {}) });
    const routine = async (name, prompt, extra = {}) => call('routines.create', {
      name, prompt, botId: owl.id, channelId: channel.id, trigger: { kind: 'cron', expr: '* * * * *' }, ...extra,
    });

    const reservation = { name: 'call_op', arguments: { op: 'brain.wakeAdd', args: { inMin: 1, note: 'echo:予約の返事' } } };
    const request = await call('channels.post', { channelId: channel.id, text: `@Owl control:${JSON.stringify(reservation)}` });
    await until(async () => (await read(request.id)).posts.find(post => post.author.kind === 'bot' && post.state === 'done'), '予約の登録');
    const [wake] = (await call('brain.wakeList', { botId: owl.id })).wakes;
    assert.ok(wake);
    const queued = await routine('echo:ルーティンの返事', '点検', { trigger: { kind: 'cron', expr: '*/5 * * * *' } });
    const lease = await lock();
    const due = Math.max(queued.nextAt, wake.at);
    await setClock(due);
    const requestItem = await until(async () => (await inbox()).find(item => item.threadId !== request.id), '準備中のルーティンの出来事');
    await sleep(500); // 配信の試行と inbox の書き戻しを待つ
    const savedItem = (await inbox()).find(item => item.id === requestItem.id);
    t.ok('更新準備中に定刻になったルーティンは出来事を未送のまま残す', savedItem?.status === 'pending', JSON.stringify(savedItem));
    const db = openRaw(dbPath(dataDir), { readOnly: true });
    try {
      const savedWake = db.prepare('SELECT status FROM brain_wakes WHERE id = ?').get(wake.id);
      t.ok('更新準備中に時刻を迎えた予約は発火済みにならない', savedWake?.status === 'pending', JSON.stringify(savedWake));
    } finally { db.close(); }
    await setClock(due + MIN + 1_000);
    await sleep(100);
    const markedFailed = client.events.some(event => event.type === 'routinesChanged' && event.routine?.id === queued.id && event.routine.last?.state === 'failed');
    t.ok('更新の準備が 60 秒を超えてもルーティンを失敗にしない', !markedFailed);
    assert.ok(main.postMessage({ type: 'update-unlock', leaseId: lease }));
    await until(() => client.cmd('running').catch(() => null), 'リースの解放');
    await call('routines.pause', { routineId: queued.id });
    const queuedPosts = (await read(requestItem.threadId)).posts;
    t.ok('更新準備中のスレッドに失敗の投稿が出ない', !queuedPosts.some(post => post.state === 'failed'), JSON.stringify(queuedPosts.map(post => [post.author.kind, post.state])));
    await setClock(due + MIN + 3_000);
    const reserveReply = await until(async () => (await read(request.id)).posts.find(post => post.text === '予約の返事' && post.state === 'done'), '保留した予約の配信').catch(() => null);
    t.ok('更新準備中に時刻を迎えた予約が失われず、一度だけ返事が出る', Boolean(reserveReply) && (await read(request.id)).posts.filter(post => post.text === '予約の返事').length === 1);
    await until(async () => (await call('routines.get', { routineId: queued.id })).last?.state === 'done', '更新の取り消し後のルーティンの終了');

    const script = JSON.stringify({ steps: [{ tool: 'Read', input: { path: 'check' }, result: 'read', ask: true }, { text: '引き継いだ返事' }] });
    const heldQueue = await routine('echo:入れ替え後の返事', '点検', { trigger: { kind: 'cron', expr: '*/5 * * * *' } });
    await setClock(heldQueue.nextAt - 30_000);
    async function startHeld(approvalTimeoutMin) {
      const definition = await routine('held:steps:', script, { paused: true, approvalTimeoutMin });
      const run = await call('routines.run', { routineId: definition.id });
      const thread = (await read(run.postId)).threads[0];
      const sessionId = thread.sessions[owl.id];
      const approval = await until(async () => (await client.cmd('running')).permissions.find(card => card.sessionId === sessionId), '保持役の承認');
      return { definition, run, approval };
    }
    const { definition: held, run: first, approval: before } = await startHeld(30);
    const expires = await startHeld(1);
    const delivered = await until(async () => (await inbox()).find(item => item.postId === first.postId && item.status === 'sent'), '承認待ちのターンの受領');
    await lock();
    await setClock(heldQueue.nextAt);
    const waitingItem = await until(async () => (await inbox()).find(item => item.status === 'pending' && item.threadId !== requestItem.threadId), '入れ替え前の未送の出来事');
    // 旧サーバーでの承認の残りは 30 秒。さらに 1 分を停止中に進める。
    await restart(async () => {
      await setClock(heldQueue.nextAt + MIN);
      // 保持役の札は受領済みで、inbox だけが書き込み前に止まった状態。
      await createInboxStore({ dir: path.dirname(inboxFile) }).mark([delivered.id], 'delivering');
    });
    const after = await until(async () => {
      const current = await call('routines.get', { routineId: held.id }).catch(error => {
        if (error.code === 'ROUTINE_NOT_FOUND') return null; // 起動直後は読み込み中
        throw error;
      });
      const work = await client.cmd('running');
      if (current && (current.last?.state === 'stopped' || work.permissions.some(card => card.id === before.id))) return { current, work };
    }, 'ルーティンの復元');
    t.ok('保持役が引き継いだルーティンは同じ根の投稿と承認で続く',
      after.current.last?.runId === first.runId && after.current.last.state === 'working' &&
      after.work.permissions.some(card => card.id === before.id) &&
      (await read()).posts.find(post => post.id === first.postId)?.state === 'working',
      after.current.last?.state === 'working' ? '' : `${JSON.stringify(after.current.last)}\n${server.tail(40)}`);
    t.ok('受領済みの札がある初回の出来事は配達中から送信済みに直す',
      (await inbox()).find(item => item.id === delivered.id)?.status === 'sent');
    if (after.work.permissions.some(card => card.id === before.id)) {
      await client.cmd('resolvePermission', { id: before.id, allow: true });
    }
    const final = await until(async () => {
      const current = await call('routines.get', { routineId: held.id });
      return current.last?.state !== 'working' && current.last;
    }, '引き継いだルーティンの終了');
    t.ok('引き継いだルーティンが終わると根の投稿と実行の状態が終了になる',
      final?.state === 'done' && (await read()).posts.find(post => post.id === first.postId)?.state === 'done' &&
      (await read(first.postId)).posts.some(post => post.text === '引き継いだ返事' && post.state === 'done'),
      JSON.stringify(final));
    const expired = await until(async () => {
      const current = await call('routines.get', { routineId: expires.definition.id });
      return current.last?.state !== 'working' && current.last;
    }, '元の承認期限での取り消し');
    t.ok('更新で承認の期限を延ばさず期限切れの実行を失敗で終える',
      expired.runId === expires.run.runId && expired.state === 'failed' &&
      (await read(expires.run.postId)).posts.some(post => post.author.kind === 'system' && post.text.includes('承認が無かった')),
      JSON.stringify(expired));
    const queuedAfter = await until(async () => {
      const current = await call('routines.get', { routineId: heldQueue.id });
      return current.last?.state !== 'working' && current.last;
    }, '入れ替え前に待っていたルーティンの終了');
    const replies = (await read(queuedAfter.postId)).posts;
    t.ok('入れ替え前に未送だったルーティンは同じ根の投稿で終わる',
      queuedAfter.postId === waitingItem.threadId && queuedAfter.state === 'done' &&
      replies.some(post => post.author.kind === 'bot' && post.text.startsWith('入れ替え後の返事') && post.state === 'done'),
      JSON.stringify({ queuedAfter, before: waitingItem.threadId, replies: replies.map(post => [post.state, post.text]) }));
  } finally {
    client?.close();
    main?.close?.();
    await server?.stop();
    await cleanupTestHolder(dataDir, runtimeRoot);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}
