// 段 3（ADR 0270 の ②）: 委譲の子の実行の控え（taskExecutions・waitingSince・streamed）は、付け直したターンの記録から作り直し、
// 結果の確定を新しいサーバーが 1 回だけ行うことを、サーバーを普通に止めて起こし直して確かめる。
// 子のターンは保持役に載る（fake の held:）。親は完了通知を 1 回だけ受け取り、台帳の行は completed になる。
// 付け直さないタスクが interrupted になることは agent-tasks-adopt が見る（ここは本物のサーバーの通し）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readAgentTasks } from '../lib/data-store.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';
import { installRestartMode, uninstallRestartMode } from '../lib/restart.mjs';

export const name = 'restart-delegation';
export const title = '途中でサーバーを止めて起こし直す: 委譲の子（保持役のターン）の実行の控えが続き、結果の確定と完了通知は 1 回だけ';

const WAIT_MS = 40_000;
const steps = list => `held:steps:${JSON.stringify({ steps: list })}`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(check, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}
const tool = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-restart-delegation-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const env = { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_RUNTIME_ROOT: root };
  uninstallRestartMode();
  const controller = installRestartMode({ trigger: 'manual' });
  let holderPid = null, server = null, c = null;
  const childPids = new Set();
  try {
    const found = await ensureHolder({ dataDir, root, idleMs: 60_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    server = await startServer({ env, dataDir, timeoutMs: 30_000 });
    c = await open({ port: server.port, token: server.token });

    const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:parent' }, { ms: WAIT_MS })).sessionId;
    const childScript = steps([
      { tool: 'Read', input: { path: 'child-a.txt' }, result: 'child r1', ms: 6000 },
      { text: 'child done' },
    ]);
    const from = c.mark();
    const turn = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: tool('ply_delegate', { kind: 'mechanical', backend: 'fake', task: childScript }), sessionId: parent }, { ms: WAIT_MS });
    assert.equal(turn.outcome, 'ok');
    const task = await until(async () => (await c.cmd('agentTasks')).find(row => row.parentSessionId === parent) ?? null, WAIT_MS, '委譲のタスク');
    assert.ok(task.sessionId, '子の会話ができた');
    const held = await until(async () => (await c.cmd('running')).turns.find(row => row.sessionId === task.sessionId)?.held ? true : null, WAIT_MS, '子のターンが保持役に載る');
    assert.ok(held, '子のターンが保持役に載っている');

    server = await controller.restart();
    assert.equal(controller.restarts, 1);
    // 起こし直したサーバーが子のターンを拾い、結果の確定を agentTasks に引き継ぐ（adoptChild → adoptRun）
    const notice = await c.waitFor(event => event.type === 'taskNotice' && event.sessionId === parent && String(event.text).includes('child done'), { ms: WAIT_MS, from });
    const completed = await until(async () => {
      const row = (await c.cmd('agentTasks')).find(item => item.taskId === task.taskId);
      return row?.status === 'completed' ? row : null;
    }, WAIT_MS, '委譲のタスクが completed');
    t.ok('委譲の子（保持役のターン）は、サーバーを止めて起こし直しても最後まで走り、完了通知が依頼元へ 1 回届く',
      completed.result.includes('child done') && Boolean(notice), JSON.stringify({ status: completed.status, result: completed.result, notice: notice.text }));
    const childEnds = c.since(from).filter(event => event.type === 'turnEnd' && event.sessionId === task.sessionId);
    t.ok('子のターンの turnEnd は 1 回だけ（記録の再生と続きが重ならない）', childEnds.length === 1 && childEnds[0].outcome === 'ok', JSON.stringify(childEnds));
    const saved = await until(() => {
      const row = readAgentTasks(dataDir)[task.taskId];
      return row?.notification === 'sent' ? row : null;
    }, WAIT_MS, '完了通知の配送が済む');
    t.ok('台帳の行は completed で、結果は 1 回だけ書かれている', saved?.status === 'completed' && saved?.result?.includes('child done') && saved?.notification === 'sent',
      JSON.stringify({ status: saved?.status, notification: saved?.notification, result: saved?.result }));
    const childHistory = await c.cmd('loadSession', { sessionId: task.sessionId });
    t.ok('子の会話の履歴にも、最後の返答が 1 回だけ載る',
      childHistory.messages.filter(message => message.role === 'assistant' && String(message.text).includes('child done')).length === 1);

    assert.ok(!server.tail(300).includes('[unhandledRejection]'), server.tail(20));
    assert.deepEqual(controller.errors, [], '起こし直しの間に、仕掛けの中の失敗が無い');
  } finally {
    c?.close();
    await server?.stop().catch(() => {});
    if (holderPid && alive(holderPid)) {
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      for (const child of probe?.welcome.children ?? []) if (child.pid) childPids.add(child.pid);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
    }
    for (const pid of childPids) await until(() => !alive(pid), 10_000, `子（${pid}）が終わる`).catch(() => {});
    uninstallRestartMode();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
