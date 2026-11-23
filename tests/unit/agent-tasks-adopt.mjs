// サーバーを起こし直したときの委譲の子の復元（ADR 0270）: agentTasks.adoptRun。
// A の通常終了で manager を閉じた後も、保持役の子と DB の running 記録が残る。B は同じデータ置き場でそのタスクを復元し、
// 結果の確定（execute の後半）を adoptRun() から続ける。
//   - 起動の復元は付け直すタスクを interrupted にしない（付け直さないタスクは今までどおり interrupted）
//   - 終了した A は結果を書かない・通知しない（結果は起動した B が 1 回だけ書く）
//   - 途中送信で渡している最中の追加指示（sending）は claim として引き継ぎ、渡った合図（steered）で配送済みにする。合図なしで終われば待機へ戻して次のターンで 1 回
//   - 付け直せなかった子は停止確認に従う。取り消しの最中（cancelling）のタスクは、付け直しても cancelled で終わる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { readAgentTasks, writeAgentTasks } from '../lib/data-store.mjs';

export const name = 'agent-tasks-adopt';
export const title = '委譲の子を起動で復元: 通常終了後も実行を続け、結果を 1 回だけ確定する（途中送信・あきらめ・取り消し）';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(15); } throw new Error('timeout'); }

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-tasks-'));
  const delivered = [], executed = [];
  let seq = 0;
  // 実行中の子を表す execute。通常終了で manager が abort したら、ローカルの待ちだけ解いて結果は書かない
  const hands = new Map();
  const open = ({ adopting = [], execute, ...options }) => createAgentTasks({
    dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0, adopting, ...options,
    prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend }),
    execute: async (task, prompt, signal) => {
      executed.push([task.taskId, prompt]);
      return execute ? execute(task, prompt, signal) : new Promise(resolve => {
        hands.set(task.taskId, () => {});
        signal.addEventListener('abort', () => resolve({ outcome: 'aborted' }), { once: true });
      });
    },
    deliver: async tasks => { delivered.push(...tasks.map(x => [x.taskId, x.status, x.result])); return 'ok'; },
    childSteerable: async () => true,
    steer: async () => 'pending',
  });
  const states = (manager, id) => manager.instructions(id).instructions.map(x => `${x.text}:${x.state}`).join();
  const start = async (manager, task) => {
    const job = await manager.call('p', 'ply_delegate', { backend: 'fake', task });
    await until(() => manager.get(job.taskId).status === 'running' && hands.has(job.taskId));
    return job.taskId;
  };
  let a = null, b = null;
  try {
    // ---- A: 子のターンを走らせ、追加指示を途中送信で渡して合図を待つ（sending）。普通に終了する
    a = await open({});
    const id = await start(a, 'work');
    const other = await start(a, 'other');   // 付け直さないタスク
    t.ok('委譲の子が並行して実行中でも、結果通知の確定を待つ必要はない', a.busy && !a.settling);
    await a.call('p', 'ply_task_send', { taskId: id, message: 'extra' });
    const extra = a.instructions(id).instructions[0];
    t.ok('旧サーバー: 途中送信で渡した追加指示は、渡った合図まで sending', extra.state === 'sending', extra.state);
    await a.close();
    t.ok('通常終了: 実行中の子の結果を確定せず、通知もしない（running のまま）', a.get(id).status === 'running' && a.get(id).notification === 'none' && delivered.length === 0,
      JSON.stringify(a.get(id)));
    a = null;

    // ---- B: 起動で復元するタスクだけ interrupted にしない
    let finish;
    b = await open({ adopting: [id], execute: async () => { throw new Error('execute は呼ばれない'); } });
    t.ok('復元: 付け直すタスクは running のまま', b.get(id).status === 'running', b.get(id).status);
    t.ok('復元: 付け直さないタスクは今までどおり interrupted（restored に載る）', b.get(other).status === 'interrupted' && b.restored.map(x => x.taskId).join() === other);
    t.ok('復元: 付け直すタスクの途中送信の追加指示（sending）はそのまま', states(b, id) === 'extra:sending', states(b, id));
    await sleep(700);
    t.ok('復元: 付け直す前に新しい実行・通知は始まらない', executed.length === 2 && b.get(id).status === 'running' && delivered.length === 0);
    const adopted = b.adoptRun(id, () => new Promise(resolve => { finish = resolve; }), { claims: [extra.id, 'unknown-id'] });
    t.ok('adoptRun は引き継げたら true、2 回目は引き継がない（false）', adopted === true && b.adoptRun(id, async () => ({ outcome: 'ok' })) === false);
    await b.steered(id, extra.id, 'delivered');
    t.ok('渡った合図で、引き継いだ追加指示が配送済みになる', states(b, id) === 'extra:delivered', states(b, id));
    finish({ outcome: 'ok', text: 'adopted result' });
    await until(() => b.get(id).status === 'completed' && b.get(id).notification === 'sent');
    t.ok('結果の確定: completed で、結果は付け直した側のもの。完了通知は 1 回', b.get(id).result === 'adopted result'
      && delivered.filter(x => x[0] === id).length === 1, JSON.stringify(delivered));
    t.ok('execute（実行の開始）は呼ばれていない', executed.length === 2);
    await b.close();
    b = null;

    // ---- 合図なしで子のターンが終わる: claim は待機へ戻り、次のターンで 1 回
    a = await open({});
    const id3 = await start(a, 'work3');
    await a.call('p', 'ply_task_send', { taskId: id3, message: 'extra3' });
    const extra3 = a.instructions(id3).instructions[0];
    await a.close();
    a = null;
    b = await open({ adopting: [id3], execute: async (task, prompt) => ({ outcome: 'ok', text: `second:${prompt}` }) });
    b.adoptRun(id3, async task => { await b.settleSteers(task.sessionId); return { outcome: 'ok', text: 'first' }; }, { claims: [extra3.id] });
    await until(() => b.get(id3).status === 'completed' && b.get(id3).result === 'second:extra3');
    t.ok('合図なしで終われば待機へ戻り、次のターンで 1 回だけ配送する', states(b, id3) === 'extra3:delivered'
      && executed.filter(x => x[0] === id3).length === 2 && executed.at(-1)[1] === 'extra3', JSON.stringify(executed));
    await b.close();
    b = null;

    // ---- 付け直した回のターン開始の指示: promptAccepted で delivered（途中送信の claim は除く）
    a = await open({ execute: async (task, prompt, signal) => prompt === 'work6'
      ? { outcome: 'ok', text: 'first' }
      : new Promise(resolve => { hands.set(task.taskId, () => {}); signal.addEventListener('abort', () => resolve({ outcome: 'aborted' }), { once: true }); }) });
    const job6 = await a.call('p', 'ply_delegate', { backend: 'fake', task: 'work6' });
    const id6 = job6.taskId;
    await until(() => a.get(id6).status === 'completed');
    await a.call('p', 'ply_task_send', { taskId: id6, message: 'next6' });
    await until(() => hands.has(id6) && states(a, id6) === 'next6:sending');
    await a.call('p', 'ply_task_send', { taskId: id6, message: 'steer6' });
    const steer6 = a.instructions(id6).instructions[1];
    t.ok('旧サーバー: ターン開始の指示と合図待ちの途中送信が sending で並ぶ', states(a, id6) === 'next6:sending,steer6:sending', states(a, id6));
    await a.close();
    a = null;
    b = await open({ adopting: [id6], execute: async () => ({ outcome: 'ok', text: 'resumed' }) });
    let finish6;
    t.ok('付け直せる', b.adoptRun(id6, () => new Promise(resolve => { finish6 = resolve; }), { claims: [steer6.id], prompt: 'work6' }) === true);
    await b.promptAccepted(id6);
    t.ok('ターン開始の指示は受け取りで配送済み、途中送信の claim は送信中のまま', states(b, id6) === 'next6:delivered,steer6:sending', states(b, id6));
    await b.steered(id6, steer6.id, 'delivered');
    finish6({ outcome: 'ok', text: 'resumed' });
    await until(() => b.get(id6).status === 'completed');
    t.ok('終われば全部配送済み', states(b, id6) === 'next6:delivered,steer6:delivered');
    await b.close();
    b = null;

    // ---- 付け直しをあきらめた（待ち受けのポートが取れないなど）: interrupted
    a = await open({});
    const id4 = await start(a, 'work4');
    await a.close();
    a = null;
    b = await open({ adopting: [id4], execute: async () => ({ outcome: 'ok' }) });
    t.ok('あきらめ: finish が無ければ false', b.adoptRun(id4, null) === false);
    await until(() => b.get(id4).status === 'interrupted');
    t.ok('あきらめたタスクは interrupted で、完了通知は出ない', b.get(id4).error && !delivered.some(x => x[0] === id4));
    await b.close();
    b = null;

    // ---- 保持役のターン復元が失敗しても、子は停止したことにはならない
    a = await open({});
    const orphan = await start(a, 'orphan');
    const failedReplay = await start(a, 'failed replay');
    const quitting = await start(a, 'quit');
    await a.call('p', 'ply_task_send', { taskId: orphan, message: 'previous' });
    await a.close();
    a = null;
    const alive = new Set([orphan, failedReplay, quitting]), unconfirmed = [];
    b = await open({ adopting: [failedReplay, quitting], stopUnconfirmed: async r => alive.has(r.taskId),
      reportUnconfirmedStop: async r => unconfirmed.push(r.taskId),
      execute: async (_task, prompt) => ({ outcome: 'ok', text: prompt }) });
    b.adoptRun(failedReplay, async () => ({ adoptionFailed: true }));
    await until(() => unconfirmed.includes(failedReplay));
    t.ok('札から復元できなかった子と再生で失敗した子は共に停止未確認で、止めた一覧に載らない',
      [orphan, failedReplay].every(id => unconfirmed.includes(id) && b.get(id).status === 'stopUnconfirmed' && !b.restored.some(x => x.taskId === id)));
    let refusal;
    try { await b.call('p', 'ply_task_send', { taskId: orphan, message: 'new work' }); }
    catch (error) { refusal = error; }
    t.ok('生存中は追加指示を受け付けず、前の指示を消さない', refusal?.message && states(b, orphan) === 'previous:sending'
      && readAgentTasks(dir)[orphan].instructions.length === 1 && executed.filter(x => x[0] === orphan).length === 1);
    alive.delete(orphan);
    await b.call('p', 'ply_task_send', { taskId: orphan, message: 'new work' });
    await until(() => b.get(orphan).status === 'completed');
    t.ok('終了の確認後だけ次のターンを開始し、追加指示を 1 回渡す',
      executed.filter(x => x[0] === orphan).map(x => x[1]).join(',') === 'orphan,new work' && b.get(orphan).result === 'new work');
    t.ok('アプリ終了の期限切れでは、停止済みの結果を残さない',
      await b.deferHeldStop(quitting, 'app-server') && (await b.settleHeldStop(quitting, false)).stopUnconfirmed
      && readAgentTasks(dir)[quitting].status === 'stopUnconfirmed');
    t.ok('アプリ終了で終了を確認した場合は取り消し済みになる',
      !(await b.settleHeldStop(quitting, true)).stopUnconfirmed && readAgentTasks(dir)[quitting].status === 'cancelled');
    b.adoptRun(quitting, null);
    await b.close();
    b = null;

    a = await open({});
    const timedOut = await start(a, 'quit timeout');
    await a.deferHeldStop(timedOut, 'app-server');
    await a.settleHeldStop(timedOut, false);
    await a.close();
    a = null;
    b = await open({ adopting: [timedOut], stopUnconfirmed: async task => task.heldQuit === 'app-server' });
    t.ok('アプリ終了で停止未確認の子は、再起動後も停止を確認するまで再開しない',
      b.get(timedOut).status === 'stopUnconfirmed' && !b.adoptRun(timedOut, async () => ({ outcome: 'ok' })));
    await b.close();
    b = null;

    // ---- 取り消しの最中（cancelling）に旧サーバーが落ちた: 付け直しても cancelled で終わる
    a = await open({});
    const id5 = await start(a, 'work5');
    await a.close();
    a = null;
    const rows = readAgentTasks(dir);
    rows[id5].status = 'cancelling';
    writeAgentTasks(dir, rows);
    b = await open({ adopting: [id5], execute: async () => ({ outcome: 'ok' }) });
    t.ok('取り消しの最中のタスクも、付け直すなら cancelling のまま', b.get(id5).status === 'cancelling', b.get(id5).status);
    b.adoptRun(id5, async (task, signal) => ({ outcome: signal.aborted ? 'aborted' : 'ok', text: 'stopped' }));
    await until(() => b.get(id5).status === 'cancelled');
    t.ok('取り消し済みの印のまま付け直すと、結果は cancelled', b.get(id5).status === 'cancelled');
  } finally {
    await a?.close().catch(() => {});
    await b?.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
