import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { createUpdateGate } from '../../core/update-gate.mjs';

const { claimQueuedResume } = createRequire(import.meta.url)('../../desktop/lifecycle.cjs');
export const name = 'agent-tasks-retry';
export const title = '子の再試行の待ち（ADR 0229）: 長い・上限の待ちは waiting と回ごとに 1 回の知らせ・ply_task_wait はすぐ戻る・上限で止まった子は limit を残し、次の指示は解除時刻の前でもふつうに走らせる（ADR 0352）';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error('timeout'); }

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-retry-'));
  const NOW = Date.parse('2026-10-18T11:00:00Z');
  let clock = NOW, retry = null, release, runs = 0;
  let outcome = { outcome: 'ok', text: 'done' };
  const notices = [];
  const gate = createUpdateGate(), prompts = [];
  const receiptDir = path.join(dir, 'desktop-lifecycle'), requestId = randomUUID(), version = '1.0.0';
  const receipt = path.join(receiptDir, requestId + '.json');
  const claim = id => claimQueuedResume({ dir: receiptDir, action: 'restart', version, requestId: id, isAlive: () => false });
  const open = (resumeQueued = false) => createAgentTasks({
    dataDir: dir, now: () => clock, silenceMinutes: 0, log: () => {},
    prepare: async (_owner, _args, taskId) => ({ sessionId: taskId, backend: 'opencode' }),
    execute: async (_task, prompt, signal) => {
      runs++;
      prompts.push(prompt);
      if (prompt !== 'work') { const leave = gate.enter({ turn: true }); leave(); }
      await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      release = null;
      return outcome;
    },
    deliver: async () => 'ok',
    retrying: () => retry, deliverRetry: async (task, rt) => { notices.push({ taskId: task.taskId, since: rt.since, limit: rt.limit }); return 'ok'; },
    canStart: () => !gate.locked, resumeQueued,
  });
  let manager = await open();
  const status = async taskId => manager.call('parent', 'ply_task_status', { taskId });
  const tick = async () => { manager.wake(); manager.checkSilence(); await sleep(30); };
  try {
    const task = await manager.call('parent', 'ply_delegate', { backend: 'opencode', task: 'work', title: 'Retry work' });
    await until(() => release);
    t.ok('保持役のターンをまだ持たない準備中の子がいると更新ロックを取れない',
      !gate.acquire(manager.blocksRestart(new Set())) && !gate.locked);

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

    // 解除時刻の前でも、積まれた指示はふつうに次の回を始める（先回りして待たせない。ADR 0352）。まだ上限なら、その回がまた止まるだけ
    outcome = { outcome: 'ok', text: 'done again' };
    const sent = await manager.call('parent', 'ply_task_send', { taskId: task.taskId, message: 'continue' });
    await until(() => release);
    t.ok('上限で止まった子への ply_task_send は、解除時刻の前でも待たせず次の回を走らせる（警告・limitHeld は付けない）',
      runs === 2 && prompts.at(-1) === 'continue' && sent.status !== 'failed' && !('warning' in sent) && !('limitHeld' in sent)
      && (await status(task.taskId)).status === 'running', JSON.stringify({ runs, prompts, sent }));
    release();
    await until(() => manager.get(task.taskId).status === 'completed');
    t.ok('通った回の結果では limit を消す', !('limit' in manager.get(task.taskId)));

    // 更新ロック中は積んだ子が待機のまま残り、再起動後も待機中の子と追加指示が残る
    t.ok('止まった子や完了した子は更新を妨げない', gate.acquire(manager.blocksRestart(new Set())));
    const queued = await manager.call('parent', 'ply_delegate', { backend: 'opencode', task: 'new work', title: 'Queued work' });
    await manager.call('parent', 'ply_task_send', { taskId: queued.taskId, message: 'additional instruction' });
    await sleep(550);
    t.ok('更新ロック中は、今積んだ子は待機のまま',
      runs === 2 && manager.get(queued.taskId).status === 'queued' && manager.get(queued.taskId).pendingMessages === 1);
    await manager.close();
    await fs.mkdir(receiptDir);
    await fs.writeFile(receipt, JSON.stringify({ requestId, action: 'restart', targetVersion: version, state: 'accepted',
      previous: { main: 'old main', server: { pid: 11 } } }));
    manager = await open(await claim(requestId));
    t.ok('再起動後も待機中の子と追加指示が残る',
      manager.get(queued.taskId).status === 'queued' && manager.get(queued.taskId).pendingMessages === 1 && manager.restored.length === 0);
    gate.release();
    await until(() => release);
    t.ok('更新ロックが外れたら待機中の子から走る', prompts.join(',') === 'work,continue,new work');
    release();
    await until(() => prompts.includes('additional instruction') && release);
    release();
    await until(() => manager.get(queued.taskId).status === 'completed');
    t.ok('積まれた追加指示で次の回が走る', runs === 4 && prompts.at(-1) === 'additional instruction');

    await fs.writeFile(receipt, '{');
    for (const [id, label] of [[undefined, '受付記録のない停止'], [requestId, '受付記録が壊れている停止']]) {
      await until(() => !manager.blocksRestart(new Set()));
      if (!gate.acquire(manager.blocksRestart(new Set()))) throw new Error('could not suspend queue for test shutdown');
      const interrupted = await manager.call('parent', 'ply_delegate', { backend: 'opencode', task: 'stop here', title: 'Interrupted work' });
      await manager.call('parent', 'ply_task_send', { taskId: interrupted.taskId, message: 'undelivered instruction' });
      await manager.close();
      manager = await open(await claim(id));
      gate.release();
      await tick();
      t.ok(`${label}の後は待機中の子を中断し、依頼元に知らせる対象にする`,
        manager.get(interrupted.taskId).status === 'interrupted' && manager.get(interrupted.taskId).pendingMessages === 0 &&
        manager.restored.some(row => row.taskId === interrupted.taskId && row.parentSessionId === 'parent') && runs === 4);
    }
  } finally { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); }
}
