import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBotService } from '../../core/bots/service.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'bot-delete';
export const title = 'bot 削除: 受付との排他・片付け失敗の再試行・会話の永続的な閲覧専用保護';
const human = { kind: 'human' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fails = async (fn, code) => { try { await fn(); return false; } catch (e) { return !code || e.code === code; } };

export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-delete-'));
  let server, client, second;
  try {
    // 保存の途中を止めて競合順序を決定する。時間待ちの競争に依存しない。
    const sessions = {};
    let holdCreate = null, failCleanup = true, failHidden = true;
    const entered = deferred();
    const backend = { id: 'fake', modes: () => ({ default: { scope: 'workspace', autonomy: 'ask' } }) };
    const host = {
      listBackends: () => [backend], getBackend: () => backend, currentLocale: () => 'ja',
      resolveModel: async () => '', resolveEffort: async () => '',
      createConversation: async () => { entered.resolve(); if (holdCreate) await holdCreate.promise; return `s${Object.keys(sessions).length}`; },
      store: {
        getAll: async () => sessions, get: async id => sessions[id] ?? {},
        setMeta: async (id, patch) => { sessions[id] = { ...sessions[id], ...patch }; },
        setMode: async () => {}, setModel: async () => {},
        setSessionData: async (id, key, value) => { sessions[id] = { ...sessions[id], [key]: value }; },
      },
      refuseBotDelete: async id => { if (sessions[id]?.busy) throw Object.assign(new Error('busy'), { code: 'CANNOT_DELETE' }); },
      cleanupBot: async () => { if (failCleanup) throw new Error('disk unavailable'); },
      deleteHidden: async id => { if (failHidden) return false; delete sessions[id]; return true; },
    };
    const channels = { createDm: async ({ bot }) => ({ id: `dm_${bot.id}`, kind: 'dm' }), archive: async () => {} };
    const dataDir = path.join(scratch, 'unit');
    await fs.mkdir(dataDir);
    const bots = createBotService({ dataDir, channels, host });
    await bots.start();
    const bot = await bots.create({ name: 'Owl', backend: 'fake' }, human);
    holdCreate = deferred();
    const creation = bots.createSession({ botId: bot.id, kind: 'thread' });
    await entered.promise;
    t.ok('作成受付から会話保存まで削除を拒否', await fails(() => bots.remove({ botId: bot.id }), 'CANNOT_DELETE'));
    t.ok('確認用の拒否理由を日本語で返す', (await bots.deletionInfo({ botId: bot.id })).blockedReason.includes('この bot は'));
    host.currentLocale = () => 'en';
    t.ok('確認用の拒否理由を英語辞書で返す', (await bots.deletionInfo({ botId: bot.id })).blockedReason.startsWith('This bot is working'));
    host.currentLocale = () => 'ja';
    holdCreate.resolve();
    const made = await creation;
    sessions[made.sessionId].busy = true;
    t.ok('既存会話の削除拒否理由を再利用', await fails(() => bots.remove({ botId: bot.id }), 'CANNOT_DELETE'));
    sessions[made.sessionId].busy = false;
    sessions.hidden = { bot: { botId: bot.id, kind: 'pulse' } };
    t.ok('隠れた会話を消せなければ完了扱いにしない', await fails(() => bots.remove({ botId: bot.id })));
    t.ok('失敗後も本体と削除開始の印が永続化されている', (await bots.get({ botId: bot.id }))?.deletionPending === true);
    t.ok('削除失敗後の新規作成・設定変更を拒否', await fails(() => bots.createSession({ botId: bot.id }), 'CANNOT_DELETE') && await fails(() => bots.update({ botId: bot.id, persona: 'new' }), 'CANNOT_DELETE'));
    t.ok('先に保護した会話の本文と由来を保持', sessions[made.sessionId].deletedBot?.name === 'Owl' && sessions[made.sessionId].bot === null);
    failHidden = false;
    t.ok('専用情報の片付け失敗でも再試行対象を残す', await fails(() => bots.remove({ botId: bot.id })) && Boolean(await bots.get({ botId: bot.id })));
    failCleanup = false;
    await bots.remove({ botId: bot.id });
    t.ok('再試行で隠れた会話と本体を片付ける', !sessions.hidden && !await bots.get({ botId: bot.id }));

    server = await startServer({ dataDir: path.join(scratch, 'server'), env: { AGENT_HOST_BACKENDS: 'fake' } });
    client = await open({ port: server.port, token: server.token });
    second = await open({ port: server.port, token: server.token });
    const op = (id, args = {}, c = client) => c.cmd('invoke', { op: id, args });
    const until = async fn => { for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await sleep(100); } throw new Error('condition timed out'); };
    const live = await op('bots.create', { name: 'Archive', backend: 'fake' });
    const dm = live.dmChannelId;
    await op('channels.post', { channelId: dm, text: 'echo:preserved' });
    const sessionId = await until(async () => (await op('bots.get', { botId: live.id })).dmSessionId);
    await until(async () => !(await client.cmd('running')).turns.some(x => x.sessionId === sessionId));
    const channel = await op('channels.create', { name: 'Archive-tests', members: [live.id] });
    const root = await op('channels.post', { channelId: channel.id, text: 'echo:thread', to: live.id });
    await until(async () => (await op('channels.read', { channelId: channel.id, threadId: root.id })).threads.some(th => th.sessions?.[live.id]));
    await until(async () => !(await client.cmd('running')).turns.length);
    // 会話が作成されてから実行が始まるまでの間は running が空になる。返事の保存完了を待って比較する。
    const postsBefore = await until(async () => {
      const posts = (await op('channels.read', { channelId: channel.id, threadId: root.id })).posts;
      return posts.some(p => p.author?.botId === live.id && p.state === 'done') && posts;
    });
    const routine = await op('routines.create', { name: 'Later', botId: live.id, channelId: channel.id, prompt: 'echo:later', trigger: { kind: 'daily', at: '23:59' } });
    await client.runTurn({ sessionId, prompt: 'control-info' });
    const control = JSON.parse((await client.cmd('loadSession', { sessionId })).messages.at(-1).text);
    const survivor = await op('bots.create', { name: 'Survivor', backend: 'fake' });
    const shared = await op('channels.post', { channelId: channel.id, text: 'echo:shared', to: live.id });
    await until(async () => !(await client.cmd('running')).turns.length);
    await op('channels.post', { channelId: channel.id, threadId: shared.id, text: 'echo:other', to: survivor.id });
    await until(async () => !(await client.cmd('running')).turns.length);
    const before = await client.cmd('loadSession', { sessionId });
    const summary = await op('bots.get', { botId: live.id });
    t.ok('確認用に保持会話数と停止ルーティン数を返す', summary.deletion.conversations === 3 && summary.deletion.routines === 1, JSON.stringify(summary.deletion));
    const scheduled = await op('channels.schedulePost', { channelId: channel.id, threadId: root.id, text: 'echo:later reply', at: Date.now() + 3600000, clientId: 'bot-delete-scheduled-0001' });
    t.ok('スレッドへの送信予定があれば削除を拒否し本体を残す', await fails(() => op('bots.delete', { botId: live.id }), 'CANNOT_DELETE') && Boolean(await op('bots.get', { botId: live.id })));
    t.ok('送信予定の拒否理由を確認画面へ返す', Boolean((await op('bots.get', { botId: live.id })).deletion.blockedReason));
    const unsent = await client.cmd('newSession', { backend: 'fake', cwd: ROOT });
    t.ok('別スレッドの送信予定は未送信会話の削除を妨げない', await client.cmd('deleteUnsentSession', { sessionId: unsent.sessionId }) === 'deleted');
    await op('sessions.cancelSchedule', { id: scheduled.id });
    // running can still be empty while the preceding posts prepare their turns.
    // Delete only after the public deletion check says all preparation is done.
    await until(async () => !(await op('bots.get', { botId: live.id })).deletion.blockedReason);
    await op('bots.delete', { botId: live.id });
    t.ok('既存スレッドの投稿は保存前に拒否', await fails(() => op('channels.post', { channelId: channel.id, threadId: root.id, text: 'forbidden' })));
    t.ok('閲覧用スレッドの本文編集もサーバーが拒否', await fails(() => op('channels.edit', { channelId: channel.id, postId: root.id, text: 'forbidden edit' }), 'READ_ONLY'));
    const threadAfter = await op('channels.read', { channelId: channel.id, threadId: root.id });
    t.ok('スレッドに閲覧用状態を保存し、投稿本文を変えない', threadAfter.threads.some(th => th.deletedBot?.id === live.id) && JSON.stringify(threadAfter.posts) === JSON.stringify(postsBefore));
    t.ok('チャンネルの members から参照を除去', !(await op('channels.get', { channelId: channel.id })).members.includes(live.id));
    t.ok('ルーティンを削除せず一時停止', (await op('routines.get', { routineId: routine.id })).paused === true);
    t.ok('不在の bot のルーティン再開・手動実行を拒否', await fails(() => op('routines.resume', { routineId: routine.id })) && await fails(() => op('routines.run', { routineId: routine.id })));
    await op('routines.update', { routineId: routine.id, name: 'Kept routine' });
    await op('routines.update', { routineId: routine.id, botId: survivor.id });
    await op('routines.resume', { routineId: routine.id });
    t.ok('残したルーティンの改名と生存 bot への付け替え・再開は可能', !(await op('routines.get', { routineId: routine.id })).paused);
    await op('channels.post', { channelId: channel.id, threadId: shared.id, text: 'echo:still live', to: survivor.id });
    await until(async () => !(await client.cmd('running')).turns.length);
    const sharedAfter = (await op('channels.read', { channelId: channel.id, threadId: shared.id })).threads.find(th => th.threadId === shared.id);
    t.ok('共有スレッドの生存 bot は会話を継続できる', Boolean(sharedAfter?.sessions?.[survivor.id]) && !sharedAfter.sessions[live.id]);
    const controlRes = await fetch(control.url, { method: 'POST', headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_op', arguments: { op: 'sessions.send', args: { sessionId: sharedAfter.sessions[survivor.id], prompt: 'echo:forbidden token' } } } }) });
    const controlBody = await controlRes.json();
    const controlResult = JSON.parse(controlBody.result.content[0].text);
    t.ok('削除前に発行した本物の操作接続でも別の生存会話へ送れない', controlResult.code === 'READ_ONLY');
    const after = await second.cmd('loadSession', { sessionId });
    t.ok('別端末にも閲覧用の由来を返し、本文を変えない', after.deletedBot?.name === 'Archive' && JSON.stringify(after.messages) === JSON.stringify(before.messages));
    const attempts = [
      ['runTurn', { sessionId, prompt: 'echo:forbidden' }], ['resume', { sessionId }],
      ['compactConversation', { sessionId }], ['suggestTitle', { sessionId }],
      ['runShell', { sessionId, command: 'echo forbidden', runId: 'forbidden', cwd: ROOT }],
      ['invoke', { op: 'shell.run', args: { sessionId, command: 'echo forbidden', cwd: ROOT } }],
      ['invoke', { op: 'sessions.scheduleSend', args: { sessionId, prompt: 'echo:forbidden', at: Date.now() + 3600000 } }],
      ['invoke', { op: 'sessions.switchBackend', args: { sessionId, backend: 'fake' } }],
    ];
    for (const [command, args] of attempts) t.ok(`閲覧用会話は ${args.op ?? command} を拒否`, await fails(() => second.cmd(command, args)));
    const unchanged = await second.cmd('loadSession', { sessionId });
    t.ok('拒否した実行で履歴を変えない', JSON.stringify(unchanged.messages) === JSON.stringify(after.messages));
    await op('sessions.setTitle', { sessionId, title: 'Archived history' });
    t.ok('人による題の整理は許可', (await op('sessions.get', { sessionId })).title === 'Archived history');
    client.close(); second.close(); client = second = null;
    await server.stop();
    server = await startServer({ dataDir: path.join(scratch, 'server'), env: { AGENT_HOST_BACKENDS: 'fake' } });
    client = await open({ port: server.port, token: server.token });
    t.ok('サーバー再起動後も閲覧用状態と送信拒否を保持', (await client.cmd('loadSession', { sessionId })).deletedBot?.id === live.id && await fails(() => client.cmd('runTurn', { sessionId, prompt: 'echo:restart' })));
  } finally {
    client?.close(); second?.close();
    await server?.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
