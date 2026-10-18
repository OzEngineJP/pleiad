// 委譲の子の再試行の待ちと上限（ADR 0229）を、fake バックエンドでサーバー全体を通して確かめる（LLM は呼ばない）。
//   - "retry-wait limit <秒> gate:<名前>": OpenCode が上限のあと再試行を待っている形（activity retrying）。タスクは waiting、依頼元へ 1 回知らせ、明ければ完了
//   - "retry-wait error <秒> gate:<名前>": 一時的な失敗の短い待ち。running のままで、依頼元を起こさない
//   - "limit <resetsAt>": 上限で止まった子。failed に limit を残し、完了通知に解除の見込み、ply_task_send は解除まで走らせない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';

export const name = 'server-delegation-retry';
export const title = '委譲の子の再試行の待ちと上限: 長い待ちは waiting と依頼元への 1 回の知らせ・短い待ちは起こさない・上限で止まった子は解除の見込みを知らせ、指示は解除まで走らせない';

const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const HOUR = 3_600_000;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-delegation-retry-'));
  const gates = await createFakeGates(scratch);
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_TASK_SILENCE_MINUTES: '0', ...gates.env } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const taskOf = async (taskId) => (await c.cmd('agentTasks')).find((r) => r.taskId === taskId);
  const until = async (fn, ms = 20000) => {
    const deadline = Date.now() + ms;
    for (;;) { const v = await fn(); if (v || Date.now() > deadline) return v; await sleep(50); }
  };
  const delegate = async (task, sessionId) => {
    const from = c.mark();
    await c.cmd('runTurn', { ...(sessionId ? { sessionId } : { backend: 'fake', cwd: ROOT }), prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task }) });
    const ev = await c.waitFor((e) => e.type === 'tool.result' && String(e.text).includes('"taskId"'), { from, ms: 30000 });
    return { parent: ev.sessionId, task: JSON.parse(ev.text), from };
  };
  const idle = async (id) => { for (let i = 0; i < 200; i++) { if (!(await c.cmd('running')).turns.some((r) => r.sessionId === id)) return; await sleep(50); } };
  // 依頼元の会話では、子からの知らせの回が裏で始まる。終わるのを待ってから道具を呼ぶ（始まりかけの間に重なったら少し待ってやり直す）
  const callTool = async (sessionId, name, args) => {
    let from;
    for (let i = 0; ; i++) {
      await idle(sessionId);
      from = c.mark();
      try { await c.runTurn({ sessionId, prompt: prompt(name, args) }); break; } catch (e) {
        if (i >= 20 || !/切り替え中|実行中/.test(e.message)) throw e;
        await sleep(100);
      }
    }
    const ev = await c.waitFor((e) => e.type === 'tool.result' && e.sessionId === sessionId, { from, ms: 30000 });
    return JSON.parse(ev.text);
  };
  const notices = async (sessionId) => (await c.cmd('loadSession', { sessionId })).messages.filter((m) => m.internalTaskNotice);
  const retryNotices = async (sessionId) => (await notices(sessionId)).filter((m) => m.text.includes('Pleiad タスク再試行待ち通知'));
  try {
    // ---- 1. 上限による待ち: waiting と、依頼元への 1 回の知らせ。画面の稼働表示は retrying。明ければ完了
    const { parent, task, from } = await delegate('retry-wait limit 600 gate:limit-wait 子の結果: 待ちの後に通った');
    const activity = await c.waitFor((e) => e.type === 'activity' && e.sessionId === task.sessionId && e.state === 'retrying', { from, ms: 20000 });
    t.ok('子の会話に稼働の状態 retrying（回数・次の時刻・上限か）が流れる', activity.retry?.attempt === 1 && activity.retry.limit === true
      && activity.retry.next > Date.now() + 500_000, JSON.stringify(activity));
    // 画面の一覧（agentTasks）は生の状態 running のまま retryWaiting を添える。waiting に数えるのは依頼元の会話へ見せる ply_task_* の側
    const waiting = await until(async () => { const r = await taskOf(task.taskId); return r?.retryWaiting ? r : null; });
    t.ok('上限による待ちの子は、画面の一覧で retryWaiting（上限・理由）を持つ', waiting?.retryWaiting?.limit === true && waiting.retryWaiting.message === 'Rate limit exceeded',
      JSON.stringify(waiting ?? await taskOf(task.taskId)));
    const first = await until(async () => (await retryNotices(parent))[0]);
    t.ok('依頼元へ再試行待ちの通知が届く（題・次の時刻・理由・待つか任せ直すか）', first?.text.includes(task.taskId) && first.text.includes('使用量の上限に当たり')
      && first.text.includes('1 回目の再試行') && first.text.includes('Rate limit exceeded') && first.text.includes('ply_task_cancel') && first.text.includes('ply_delegate'), first?.text);
    const status = await callTool(parent, 'ply_task_status', { taskId: task.taskId });
    t.ok('ply_task_status にも waiting と retryWaiting（nextAt は ISO）', status.status === 'waiting' && /^\d{4}-\d\d-\d\dT/.test(status.retryWaiting?.nextAt ?? ''), JSON.stringify(status));
    await sleep(1500);
    t.ok('同じ待ちの間は知らせ直さない', (await retryNotices(parent)).length === 1);
    await gates.open('limit-wait');
    const done = await until(async () => { const r = await taskOf(task.taskId); return r?.status === 'completed' ? r : null; });
    t.ok('待ちが明けると子は続けて完了し、結果が届く', done?.result?.includes('待ちの後に通った') && !('retryWaiting' in done), JSON.stringify(done ?? await taskOf(task.taskId)));
    t.ok('明けた後に再試行待ちの通知を重ねない', (await retryNotices(parent)).length === 1);

    // ---- 2. 一時的な失敗の短い待ち（次まで 5 秒）: running のまま、依頼元を起こさない
    // 依頼元の会話は、前の子の完了通知の回が始まりうるので使い回さず、新しい会話から任せる
    const short = await delegate('retry-wait error 5 gate:short-wait 短い待ちの結果');
    await c.waitFor((e) => e.type === 'activity' && e.sessionId === short.task.sessionId && e.state === 'retrying', { from: short.from, ms: 20000 });
    await sleep(1200);
    const shortRow = await taskOf(short.task.taskId);
    t.ok('短い待ちの子は running のまま（retryWaiting は見せる）で、知らせない', shortRow?.status === 'running' && shortRow.retryWaiting?.limit === false
      && (await retryNotices(short.parent)).length === 0, JSON.stringify(shortRow));
    await gates.open('short-wait');
    await until(async () => (await taskOf(short.task.taskId))?.status === 'completed');

    // ---- 3. 上限で止まった子: failed に limit、完了通知に解除の見込み、ply_task_send は解除まで走らせない
    const resetsAt = Date.now() + 3 * HOUR;
    const limited = await delegate(`limit ${resetsAt}`);
    const failed = await until(async () => { const r = await taskOf(limited.task.taskId); return r?.status === 'failed' ? r : null; });
    t.ok('上限で止まった子は failed で、limit（解除時刻・枠）を残す', failed?.limit?.resetsAt === resetsAt && failed.limit.window === 'five_hour', JSON.stringify(failed ?? await taskOf(limited.task.taskId)));
    const notice = await until(async () => (await notices(limited.parent)).find((m) => m.text.includes(limited.task.taskId) && m.text.includes('使用量の上限で止まりました')));
    t.ok('完了通知に、解除の見込みと続け方の一行が入る', notice?.text.includes('に解除される見込みです') && notice.text.includes('ply_task_send'), notice?.text);
    const sent = await callTool(limited.parent, 'ply_task_send', { taskId: limited.task.taskId, message: 'echo:続き' });
    t.ok('解除の前の ply_task_send は積むだけで、警告（解除の時刻・任せ直し）と limitHeld を返す', sent.status === 'queued' && /解除まで走らせません/.test(sent.warning ?? '')
      && sent.limitHeld?.resetsAt === new Date(resetsAt).toISOString(), JSON.stringify(sent));
    await sleep(1500);
    t.ok('解除の前は子の次の回が走らない', (await taskOf(limited.task.taskId))?.status === 'queued');
  } finally {
    c.close(); await server.stop();
    if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch, { recursive: true, force: true });
  }
}
