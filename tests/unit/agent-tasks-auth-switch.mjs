// 委譲の子がログイン切れ（turnResult の kind: 'auth'。server の execute が authFailed を返す）で止まったら、
// 上限のとき（beta.8 の切り替え）と同じく、自動で選んだ子は別の委譲先に切り替えて同じ会話で続ける（Issue #232）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';

export const name = 'agent-tasks-auth-switch';
export const title = '委譲の子のログイン切れ（#232）: 自動で選んだ子は別の委譲先へ切り替えて同じ会話で続け、切り替えを知らせる。固定の子・候補が無いときは失敗のまま';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(10); } throw new Error('timeout'); }

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-auth-switch-'));
  const runs = [], reroutes = [], notices = [];
  let nextTarget = { backend: 'codex', model: 'gpt-5.5', account: null };
  const authFailed = { backend: 'claude', model: 'opus', account: 'acct-1', name: 'work' };
  const manager = await createAgentTasks({
    dataDir: dir, silenceMinutes: 0, log: () => {},
    prepare: async (_owner, args, taskId) => ({ sessionId: `child-${taskId}`, backend: 'claude', model: 'opus',
      routing: args.task === 'pinned' ? { mode: 'pinned', kind: 'trivial', target: { backend: 'claude', model: 'opus', account: 'acct-1' } }
        : { mode: 'auto', kind: 'trivial', target: { backend: 'claude', model: 'opus', account: 'acct-1' } } }),
    execute: async (task, prompt, _signal, meta) => {
      runs.push({ backend: task.backend, sessionId: task.sessionId, prompt, continuing: meta?.continuing ?? false });
      // 1 回目（claude）はログイン切れ。仕事の痕跡があっても（touched）切り替える
      if (task.backend === 'claude') return { outcome: 'error', text: '', error: 'Failed to authenticate', touched: true, authFailed };
      return { outcome: 'ok', text: `done on ${task.backend}` };
    },
    reroute: async (task, failed) => {
      reroutes.push(structuredClone(failed));
      if (!nextTarget) return null;
      return { sessionId: task.sessionId, backend: nextTarget.backend, model: nextTarget.model, effort: null, mode: task.mode,
        routing: { ...task.routing, target: nextTarget, attempts: [...(task.routing.attempts ?? []), { target: task.routing.target, reason: 'login_expired', continued: true }] } };
    },
    deliver: async () => 'ok',
    deliverLimitSwitch: async (_task, target) => { notices.push(target); return 'ok'; },
  });
  try {
    // ---- 自動で選んだ子: 別の委譲先に切り替えて、同じ会話で続ける
    const auto = await manager.call('parent', 'ply_delegate', { backend: 'claude', task: 'work', title: 'Auth work' });
    await until(() => manager.get(auto.taskId)?.status === 'completed');
    const row = manager.get(auto.taskId);
    t.ok('ログイン切れの子は別の委譲先（codex）で同じ会話を続けて完了する', row.status === 'completed' && row.backend === 'codex'
      && row.sessionId === auto.sessionId && runs.length === 2 && runs[1].sessionId === runs[0].sessionId, JSON.stringify({ row: { s: row.status, b: row.backend }, runs }));
    t.ok('続きのターンは continuing: auth（ログイン切れの続きの依頼文）で走る', runs[1].continuing === 'auth', JSON.stringify(runs[1]));
    t.ok('振り分けし直しには、切れた委譲先（エージェント・アカウント）を auth の印付きで渡す', reroutes.length === 1 && reroutes[0].authFailed === true
      && reroutes[0].triedLimits.some(x => x.auth && x.backend === 'claude' && x.account === 'acct-1'), JSON.stringify(reroutes[0]));
    await until(() => notices.length === 1);
    t.ok('依頼元へ、ログイン切れで切り替えたこと（reason: auth）を一度だけ知らせる', notices.length === 1 && notices[0].reason === 'auth'
      && notices[0].backend === 'codex', JSON.stringify(notices));

    // ---- 次の候補が無い: 失敗のまま（同じ会話）
    nextTarget = null;
    runs.length = 0; reroutes.length = 0;
    const none = await manager.call('parent', 'ply_delegate', { backend: 'claude', task: 'work 2', title: 'No candidate' });
    await until(() => manager.get(none.taskId)?.status === 'failed');
    t.ok('切り替え先が無ければ失敗のまま止まる', manager.get(none.taskId).backend === 'claude' && runs.length === 1 && reroutes.length === 1);

    // ---- 固定（依頼元が委譲先を書いた。routing.mode: pinned）の子は切り替えない
    nextTarget = { backend: 'codex', model: 'gpt-5.5', account: null };
    runs.length = 0; reroutes.length = 0;
    const pinned = await manager.call('parent', 'ply_delegate', { backend: 'claude', task: 'pinned', title: 'Pinned' });
    await until(() => manager.get(pinned.taskId)?.status === 'failed');
    t.ok('固定の委譲はログイン切れでも切り替えない', runs.length === 1 && reroutes.length === 0, JSON.stringify({ runs, reroutes }));
  } finally { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); }
}
