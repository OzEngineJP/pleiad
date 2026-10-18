import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { agentT } from '../../core/i18n.mjs';
import { clockText } from '../../core/limit-resume.mjs';

export const name = 'agent-tasks-retry';
export const title = '子の再試行の待ち（ADR 0229）: 長い・上限の待ちは waiting と回ごとに 1 回の知らせ・ply_task_wait はすぐ戻る・上限で止まった子は limit を残し、指示は解除まで走らせない';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error('timeout'); }

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-retry-'));
  const NOW = Date.parse('2026-10-18T11:00:00Z');
  let clock = NOW, retry = null, hold = null, release, runs = 0;
  let outcome = { outcome: 'ok', text: 'done' };
  const notices = [];
  const manager = await createAgentTasks({
    dataDir: dir, now: () => clock, silenceMinutes: 0, log: () => {},
    prepare: async () => ({ sessionId: 'child', backend: 'opencode' }),
    execute: async (_task, _prompt, signal) => {
      runs++;
      await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      release = null;
      return outcome;
    },
    deliver: async () => 'ok',
    retrying: () => retry, deliverRetry: async (task, rt) => { notices.push({ taskId: task.taskId, since: rt.since, limit: rt.limit }); return 'ok'; },
    held: () => hold,
  });
  const status = async taskId => manager.call('parent', 'ply_task_status', { taskId });
  const tick = async () => { manager.wake(); manager.checkSilence(); await sleep(30); };
  try {
    const task = await manager.call('parent', 'ply_delegate', { backend: 'opencode', task: 'work', title: 'Retry work' });
    await until(() => release);

    // 短い待ち（混雑の再試行。次まで 5 秒）: 走っているまま。待ちの中身は見せるが、依頼元は起こさない
    retry = { attempt: 1, next: clock + 5_000, message: 'Provider is overloaded', reason: null, limit: false, since: clock, seenAt: clock };
    await tick();
    let s = await status(task.taskId);
    t.ok('短い待ちは running のまま。retryWaiting は見せる', s.status === 'running' && s.retryWaiting?.attempt === 1 && s.retryWaiting.limit === false
      && s.retryWaiting.nextAt === new Date(clock + 5_000).toISOString() && notices.length === 0, JSON.stringify(s));

    // 上限による待ち: waiting に数え、待ちの回ごとに 1 回だけ知らせる
    retry = { attempt: 2, next: clock + 420_000, message: 'Rate limit exceeded', reason: null, limit: true, since: clock, seenAt: clock };
    await tick();
    await until(() => notices.length === 1);
    s = await status(task.taskId);
    t.ok('上限の待ちは status: waiting で、依頼元へ 1 回知らせる', s.status === 'waiting' && s.retryWaiting.limit === true && notices[0].limit === true
      && notices[0].taskId === task.taskId, JSON.stringify({ s, notices }));
    clock += 60_000;
    retry = { ...retry, attempt: 3, next: clock + 420_000, seenAt: clock };
    await tick(); await tick();
    t.ok('同じ待ちの回（再試行の回数が進んでも）では知らせ直さない', notices.length === 1);

    // 待ちが明けたら running に戻る
    retry = null;
    await tick();
    t.ok('待ちが明けると running に戻る', (await status(task.taskId)).status === 'running' && !('retryWaiting' in await status(task.taskId)));

    // 長い待ち（上限ではないが、次まで 60 秒以上）は数える。ply_task_wait はすぐ戻り、その戻り値が知らせを兼ねる
    const waiting = manager.call('parent', 'ply_task_wait', { taskId: task.taskId, seconds: 30 });
    await sleep(30);
    const since = clock;
    retry = { attempt: 1, next: clock + 90_000, message: 'Rate limit exceeded', reason: null, limit: false, since, seenAt: clock };
    const t0 = Date.now();
    manager.wake();
    const waited = await waiting;
    t.ok('長い待ちで ply_task_wait はすぐ戻る（status: waiting・retryWaiting）', waited.status === 'waiting' && waited.retryWaiting?.attempt === 1
      && Date.now() - t0 < 5_000, JSON.stringify(waited));
    await tick(); await tick();
    t.ok('ply_task_wait が渡した待ちは、別に知らせない', notices.length === 1, JSON.stringify(notices));

    // 次の時刻が分からない待ちも数える（新しい回なので知らせる）
    clock += 120_000;
    retry = { attempt: 1, next: null, message: 'Provider is overloaded', reason: null, limit: false, since: clock, seenAt: clock };
    await tick();
    await until(() => notices.length === 2);
    t.ok('次の時刻が分からない待ちも waiting で、新しい回として知らせる', (await status(task.taskId)).status === 'waiting' && notices[1].since === clock);

    // 上限で止まった: failed のまま limit を残す
    retry = null;
    const resetsAt = clock + 3 * 3_600_000;
    outcome = { outcome: 'limited', text: '', error: 'Weekly usage limit reached', limit: { resetsAt, window: null } };
    release();
    await until(() => manager.get(task.taskId).status === 'failed');
    s = await status(task.taskId);
    t.ok('上限で止まった子は failed で、limit（解除時刻）を残す', s.status === 'failed' && s.limit?.resetsAt === resetsAt && s.limit.window === null, JSON.stringify(s));

    // 解除時刻までは、積まれた指示で次の回を始めない
    hold = { resetsAt };
    const sent = await manager.call('parent', 'ply_task_send', { taskId: task.taskId, message: 'continue' });
    await tick();
    t.ok('解除の前の ply_task_send は積むだけで走らせず、警告と limitHeld を返す', runs === 1 && sent.status === 'queued'
      && sent.warning === agentT(undefined, 'tasks.limitHeld', { time: clockText(resetsAt) }) && sent.limitHeld?.resetsAt === new Date(resetsAt).toISOString(),
      JSON.stringify({ runs, sent }));
    hold = null;
    outcome = { outcome: 'ok', text: 'done again' };
    await tick();
    await until(() => release);
    t.ok('解除の後は積まれた指示で次の回が走る', runs === 2);
    release();
    await until(() => manager.get(task.taskId).status === 'completed');
    t.ok('通った回の結果では limit を消す', !('limit' in manager.get(task.taskId)));
  } finally { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); }
}
