// 普通の会話の長いコマンド（ADR 0224 §2）をサーバーで: 途中送信を受けないターンで戻らないシェルのツールは、会話が読めないので
// 通知の一覧のあなた待ちに載せ、コマンドが終わったら決着させる。ターンが終わったら、そのコマンドで新しいターンを起こさない（fake）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-session-commands';
export const title = '普通の会話の長いコマンド: 会話が読めなければあなた待ちに載せ、終わったら決着させる（fake）';

const tools = (steps) => 'steps:' + JSON.stringify({ steps });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-session-commands-'));
  // 上限 0.01 分（0.6 秒）・人へ知らせるまで 0.8 秒
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_SESSION_COMMAND_MINUTES: '0.01', AGENT_HOST_SESSION_COMMAND_FALLBACK_MS: '800' },
    dataDir: path.join(scratch, 'data'), timeoutMs: 60_000 });
  const c = await open({ ...server, autoAllow: true });
  const waits = async (sessionId) => (await c.cmd('invoke', { op: 'notifications.list', args: { filter: 'wait' } })).items.filter((x) => x.target.sessionId === sessionId);
  const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(50); } return v; };
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    const from = c.mark();
    await c.cmd('sendMessage', { sessionId, messageId: 'cmd-long-0001', prompt: tools([
      { tool: 'Bash', input: { command: 'npm run dev' }, ms: 4000, result: 'listening' },
      { text: 'done' },
    ]) });
    const raised = await until(async () => (await waits(sessionId)).find((x) => x.ask === 'command' && x.resolvedAt == null));
    t.ok('途中送信を受けないターンで戻らないコマンドは、あなた待ちに載せる（コマンドの戻らない会話）', Boolean(raised), JSON.stringify(await waits(sessionId)));
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 20_000 });
    const settled = await until(async () => (await waits(sessionId)).find((x) => x.ask === 'command' && x.resolvedAt != null));
    t.ok('コマンドが終わったら決着させる', Boolean(settled), JSON.stringify(await waits(sessionId)));
    const after = c.mark();
    await sleep(1500);
    t.ok('ターンが終わった後、そのコマンドで新しいターンを起こさない', !c.since(after).some((e) => e.type === 'turnStart' && e.sessionId === sessionId)
      && !c.since(from).some((e) => e.type === 'taskNotice' && e.sessionId === sessionId), JSON.stringify(c.since(from).map((e) => e.type)));

    // 待つためのコマンドと、短いコマンドは載せない
    const quick = c.mark();
    await c.cmd('sendMessage', { sessionId, messageId: 'cmd-quick-0001', prompt: tools([
      { tool: 'Bash', input: { command: 'sleep 3' }, ms: 2500, result: '' },
      { tool: 'Bash', input: { command: 'git status' }, ms: 100, result: 'clean' },
      { text: 'ok' },
    ]) });
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from: quick, ms: 20_000 });
    t.ok('待つためのコマンド・短いコマンドは載せない', (await waits(sessionId)).filter((x) => x.ask === 'command').length === 1);
  } finally {
    await c.close?.();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}
