import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';

export const name = 'agent-tasks-command-settle';
export const title = '止まった子に残ったコマンドを片付け、長時間の通知を出さない（失敗・例外・取り消し・返答の後の裏の作業）';
const minute = 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(5); } throw new Error('timeout'); }

// execute は f.finish(result) / f.fail(error) で終わる。commandAlive は f.alive（バックエンドが挙げている裏の作業の id）で答える
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-settle-'));
  const f = { dir, clock: 0, notices: [], alive: new Set(), asked: [] };
  const manager = await createAgentTasks({ dataDir: dir, now: () => f.clock, log: () => {}, silenceMinutes: 0,
    prepare: async () => ({ sessionId: 'child', backend: 'fake', cwd: 'D:/work' }),
    execute: async (_r, _p, signal) => new Promise((resolve, reject) => {
      f.finish = resolve; f.fail = reject;
      signal.addEventListener('abort', () => resolve({ outcome: 'aborted' }), { once: true });
    }),
    deliver: async () => 'ok',
    deliverCommand: async (task, command) => { f.notices.push({ task, command }); return 'ok'; },
    commandAlive: (sessionId, command) => { f.asked.push({ sessionId, ...command }); return f.alive.has(command.nativeTaskId ?? command.toolCallId); } });
  f.manager = manager;
  f.task = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'work', title: 'Build' });
  await until(() => f.finish);
  f.emit = event => manager.observe('child', event);
  f.sdk = message => normalizeSdkMessage(message).forEach(f.emit);
  f.start = (id, input = { command: 'grep -rn foo .' }) => f.emit({ type: 'tool.start', id, name: 'Bash', input });
  f.view = () => manager.get(f.task.taskId);
  f.tick = async n => { f.clock = n * minute; manager.checkSilence(); await sleep(25); };
  f.ended = status => until(() => f.view().status === status && !manager.busy);
  f.close = async () => { manager.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); };
  return f;
}

export default async function(t) {
  // 上限で failed になった子（devin の要求回数の上限）。最後の grep の終わりの合図は来ない
  const limited = await fixture();
  try {
    await limited.tick(1);
    limited.start('grep');
    t.ok('走っている間はコマンドを記録する', limited.view().activeCommands.length === 1);
    limited.finish({ outcome: 'limited', text: '', error: 'request limit' });
    await limited.ended('failed');
    const status = await limited.manager.call('parent', 'ply_task_status', { taskId: limited.task.taskId });
    t.ok('failed で終わったら activeCommands は空（状態と一覧の両方）', limited.view().activeCommands.length === 0 && status.activeCommands.length === 0
      && limited.manager.list('parent')[0].activeCommands.length === 0, JSON.stringify(limited.view().activeCommands));
    await limited.tick(6); await limited.tick(40);
    t.ok('failed の後は 5 分たっても長時間の通知を出さない', limited.notices.length === 0, JSON.stringify(limited.notices.map(n => n.command.toolCallId)));
  } finally { await limited.close(); }

  // バックエンドが例外で落ちた（run.error）
  const thrown = await fixture();
  try {
    thrown.start('build', { command: 'npm run build' });
    thrown.fail(new Error('backend exited'));
    await thrown.ended('failed');
    await thrown.tick(10);
    t.ok('例外で failed になってもコマンドを片付け、知らせない', thrown.view().activeCommands.length === 0 && thrown.notices.length === 0);
  } finally { await thrown.close(); }

  // 走っている子を取り消した
  const cancelled = await fixture();
  try {
    cancelled.start('test', { command: 'npm test' });
    await cancelled.manager.call('parent', 'ply_task_cancel', { taskId: cancelled.task.taskId });
    await cancelled.ended('cancelled');
    await cancelled.tick(10);
    t.ok('取り消したら（cancelled）コマンドを片付け、知らせない', cancelled.view().activeCommands.length === 0 && cancelled.notices.length === 0);
  } finally { await cancelled.close(); }

  // 子が返答した後も裏の作業が残った（Claude の run_in_background）。バックエンドが挙げている間は残し、挙げなくなったら片付ける
  const bg = await fixture();
  try {
    bg.sdk({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'open', name: 'Bash', input: { command: 'agent-browser open https://example.com', run_in_background: true } }] } });
    bg.sdk({ type: 'user', tool_use_result: { backgroundTaskId: 'native-open' }, message: { content: [{ type: 'tool_result', tool_use_id: 'open', content: 'launched' }] } });
    bg.alive.add('native-open');
    bg.start('fg', { command: 'npm test' });
    bg.finish({ outcome: 'ok', text: 'done' });
    await bg.ended('completed');
    t.ok('返答で回が終わったら前景のコマンドは外し、裏のコマンドは残す', bg.view().activeCommands.map(c => c.toolCallId).join() === 'open'
      && bg.view().activeCommands[0].state === 'background');
    await bg.tick(6); await bg.tick(12);
    t.ok('バックエンドが挙げている間は残すが、止まった子の長時間の通知は出さない', bg.view().activeCommands.length === 1 && bg.notices.length === 0);
    t.ok('生存は子の会話とバックエンドの id で引く', bg.asked.some(a => a.sessionId === 'child' && a.nativeTaskId === 'native-open' && a.toolCallId === 'open'));
    bg.alive.delete('native-open');
    await bg.tick(13);
    t.ok('バックエンドが挙げなくなった（終わった）裏の作業は片付ける', bg.view().activeCommands.length === 0);
    await bg.tick(30);
    t.ok('片付けた後も知らせない', bg.notices.length === 0);
  } finally { await bg.close(); }

  // 返答の後に終わりの合図（task_notification）が届いた
  const late = await fixture();
  try {
    late.sdk({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'emu', name: 'Bash', input: { command: 'emulator -avd Pixel', run_in_background: true } }] } });
    late.sdk({ type: 'user', tool_use_result: { backgroundTaskId: 'native-emu' }, message: { content: [{ type: 'tool_result', tool_use_id: 'emu', content: 'launched' }] } });
    late.alive.add('native-emu');
    late.finish({ outcome: 'ok', text: 'done' });
    await late.ended('completed');
    late.sdk({ type: 'system', subtype: 'task_notification', task_id: 'native-emu', status: 'completed' });
    t.ok('子が止まった後に届いた終わりの合図でも片付ける', late.view().activeCommands.length === 0);
  } finally { await late.close(); }
}
