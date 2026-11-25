// 委譲した子の回が終わったら（完了・失敗・止められた）、終了通知を 1 つ作る（ADR 0352）。委譲の管理（core/agent-tasks.mjs）だけで確かめる。
//   - ply_task_cancel は止める合図を送るだけ。止まったことは同じ終了通知で届く（終わり方は依頼元が取り消した）
//   - もう終わっていて通知が届いていなければ、その通知をそのまま届ける（戻り値で結果を渡さず、既読にしない）
//   - 人が子を直接止めた: 依頼元が止められていなければすぐ届ける（終わり方は人が止めた・結果は止めた時点までの返答）
//   - 子を取り消すと孫も止まる。孫の終了通知で子（取り消している途中の会話）を起こさず、子の次のターンの始めに渡す（takeHeld）
//   - 依頼元が止められている間に、人が子だけを起こして子が終わった: 依頼元を起こさず、次のターンの始めに渡す
//   - 止める合図を受けた回には、外から起きたターンを合流させない。回が締まってから次の回として走らせる
//   - 出来事（回の終わり・人の直接の指示）は起きた順に貯め、届けるときにまだ届けていない分を全部 1 通に載せ、今の子の状態を添える
//   - 人の指示は伏せて 300 字に切る。人の指示だけでは依頼元を起こさない。届けていない出来事は再起動の後も残って届く
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { hookedTaskStorage } from '../lib/task-storage.mjs';

export const name = 'agent-tasks-end-notice';
export const title = '子の回の終了通知: ply_task_cancel・人の止め・依頼元が止められている間・止めた直後の外からのターン';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(15); } throw new Error('timeout'); }

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-task-end-'));
  let seq = 0;
  const notReady = new Set(), stoppedOwners = new Set(), gates = new Map();
  // 届いた終了通知: [依頼元, taskId, status, stoppedBy, result, events]
  const delivered = [];
  const externalRuns = [];
  let hooked = hookedTaskStorage(dir, {});
  const options = {
    taskStorage: hooked.taskStorage, dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
    prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend }),
    execute: async (task, prompt, signal, opts = {}) => {
      if (opts.external) {
        const o = await opts.external.turn({});
        externalRuns.push([task.taskId, o]);
        return { outcome: signal.aborted ? 'aborted' : 'ok', text: `woken:${o}` };
      }
      if (prompt.startsWith('hold')) {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        // 止める合図を受けた後も、少し後片付けをしてから返る回（gate が開くまで）
        if (gates.has(prompt)) await gates.get(prompt).promise;
        return { outcome: 'aborted', text: `partial:${prompt}` };
      }
      return { outcome: 'ok', text: `result:${prompt}` };
    },
    ready: async task => !notReady.has(task.parentSessionId),
    ownerStopped: owner => stoppedOwners.has(owner),
    deliver: async tasks => {
      for (const x of tasks) delivered.push([x.parentSessionId, x.taskId, x.status, x.stoppedBy ?? null, x.result, x.events ?? []]);
      return 'ok';
    },
  };
  const gate = key => { let open; const promise = new Promise(r => { open = r; }); gates.set(key, { promise, open }); return () => open(); };
  const of = taskId => delivered.filter(x => x[1] === taskId);
  let manager = await createAgentTasks(options);
  // 出来事の並び（種類と要点だけ）
  const shape = events => events.map(e => e.kind === 'run' ? `run:${e.status}:${e.stoppedBy ?? '-'}:${e.result ?? ''}` : `human:${e.text}:${e.attachments}`);
  try {
    // ---- 終わっていて通知が届いていない子の ply_task_cancel: その通知をそのまま 1 回届ける
    notReady.add('parent');
    const quick = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'quick' });
    await until(() => manager.get(quick.taskId).status === 'completed' && manager.get(quick.taskId).notification === 'pending');
    const pendingOut = await manager.call('parent', 'ply_task_cancel', { taskId: quick.taskId });
    t.ok('終わって通知の届いていない子の ply_task_cancel は結果を渡さず、既読にもしない',
      pendingOut.status === 'completed' && !('result' in pendingOut) && /まだ届いていない|not delivered yet/.test(pendingOut.message)
      && manager.get(quick.taskId).notification === 'pending', JSON.stringify({ pendingOut, notification: manager.get(quick.taskId).notification }));
    notReady.delete('parent');
    await until(() => manager.get(quick.taskId).notification === 'sent');
    await sleep(600);
    t.ok('その終了通知（合図が届く前の終わり方＝完了）が 1 回だけ届く',
      of(quick.taskId).length === 1 && of(quick.taskId)[0][2] === 'completed' && of(quick.taskId)[0][4] === 'result:quick', JSON.stringify(of(quick.taskId)));

    // ---- 走っている子の ply_task_cancel: 合図を送ってすぐ戻り、止まったら終了通知（依頼元が取り消した）を 1 つ
    const held = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'hold-a' });
    await until(() => manager.get(held.taskId).status === 'running');
    const sent = await manager.call('parent', 'ply_task_cancel', { taskId: held.taskId });
    t.ok('ply_task_cancel は止める合図を送ったことと今の状態だけを返す', ['cancelling', 'cancelled'].includes(sent.status) && !('result' in sent), JSON.stringify(sent));
    await until(() => manager.get(held.taskId).notification === 'sent');
    await sleep(600);
    t.ok('止まったら終了通知を 1 つ届ける（cancelled・依頼元が取り消した・止めた時点までの返答）',
      of(held.taskId).length === 1 && of(held.taskId)[0][2] === 'cancelled' && of(held.taskId)[0][3] === 'parent' && of(held.taskId)[0][4] === 'partial:hold-a',
      JSON.stringify(of(held.taskId)));
    t.ok('止めた側（stoppedBy）は ply_task_status に出さない', !('stoppedBy' in manager.get(held.taskId)) && !('ownerStop' in manager.get(held.taskId)));

    // ---- 人が子を直接止めた: 依頼元が止められていなければ、すぐ届ける
    const human = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'hold-b' });
    await until(() => manager.get(human.taskId).status === 'running');
    await manager.cancel(human.taskId, { by: 'human' });
    await until(() => manager.get(human.taskId).notification === 'sent');
    t.ok('人が直接止めた子の終了通知はすぐ届く（人が止めた・止めた時点までの返答）',
      of(human.taskId).length === 1 && of(human.taskId)[0][2] === 'cancelled' && of(human.taskId)[0][3] === 'human' && of(human.taskId)[0][4] === 'partial:hold-b',
      JSON.stringify(of(human.taskId)));

    // ---- 子を取り消すと孫も止まる。孫の終了通知で子（取り消している途中）を起こさない
    const child = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'hold-c' });
    await until(() => manager.get(child.taskId).status === 'running');
    const childSession = manager.get(child.taskId).sessionId;
    const grand = await manager.call(childSession, 'ply_delegate', { backend: 'fake', task: 'hold-d' });
    await until(() => manager.get(grand.taskId).status === 'running');
    await manager.call('parent', 'ply_task_cancel', { taskId: child.taskId });
    await until(() => manager.get(child.taskId).notification === 'sent');
    await until(() => manager.get(grand.taskId).status === 'cancelled' && manager.get(grand.taskId).notification === 'pending');
    await sleep(1200);
    t.ok('孫の終了通知で子の会話を起こさない（pending のまま貯める）', of(grand.taskId).length === 0 && manager.get(grand.taskId).notification === 'pending',
      JSON.stringify({ grand: of(grand.taskId), notification: manager.get(grand.taskId).notification }));
    t.ok('取り消した子の終了通知は依頼元へ 1 つ届く', of(child.taskId).length === 1 && of(child.taskId)[0][3] === 'parent', JSON.stringify(of(child.taskId)));
    const takenGrand = await manager.takeHeld(childSession);
    t.ok('子の次のターンの始めに、孫の終了通知を渡す', takenGrand?.tasks.length === 1 && takenGrand.tasks[0].taskId === grand.taskId
      && takenGrand.tasks[0].status === 'cancelled' && takenGrand.tasks[0].stoppedBy === 'owner'
      && shape(takenGrand.tasks[0].events).join('|') === 'run:cancelled:owner:partial:hold-d', JSON.stringify(takenGrand?.tasks));
    await takenGrand?.settle('ok');
    t.ok('渡ったら sent になり、もう一度は渡さない', manager.get(grand.taskId).notification === 'sent' && (await manager.takeHeld(childSession)) === null);

    // ---- 依頼元が止められている間に、人が子だけを起こして子が終わった: 依頼元を起こさず、次のターンの始めに渡す
    const done = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'quick-2' });
    await until(() => manager.get(done.taskId).notification === 'sent');
    stoppedOwners.add('parent');
    const doneSession = manager.get(done.taskId).sessionId;
    const turned = await manager.external(doneSession, 'human', async hooks => { if (hooks) await hooks.began(); return hooks ? 'linked' : 'plain'; });
    await until(() => manager.get(done.taskId).status === 'completed' && manager.get(done.taskId).notification === 'pending');
    await sleep(1200);
    t.ok('止められている依頼元を、人が起こした子の終了通知で起こさない', turned === 'linked' && of(done.taskId).length === 1
      && manager.get(done.taskId).notification === 'pending', JSON.stringify({ turned, delivered: of(done.taskId), notification: manager.get(done.taskId).notification }));
    stoppedOwners.delete('parent');
    const takenDone = await manager.takeHeld('parent', { stopped: true });
    t.ok('依頼元の次のターンの始めに、その終了通知を渡す', takenDone?.tasks.length === 1 && takenDone.tasks[0].taskId === done.taskId
      && takenDone.tasks[0].result === 'woken:linked' && takenDone.tasks[0].events.length === 1
      && takenDone.tasks[0].events[0].kind === 'run' && takenDone.tasks[0].events[0].cause.join() === 'human', JSON.stringify(takenDone?.tasks));
    await takenDone?.settle('ok');
    // 渡らずに終わったら pending に戻し、普通の配送に任せる
    stoppedOwners.add('parent');
    const again = await manager.external(doneSession, 'resume', async hooks => { if (hooks) await hooks.began(); return 'again'; });
    await until(() => manager.get(done.taskId).notification === 'pending');
    stoppedOwners.delete('parent');
    const notTaken = await manager.takeHeld('parent', { stopped: true });
    await notTaken?.settle('undelivered');
    await until(() => manager.get(done.taskId).notification === 'sent');
    t.ok('次のターンが渡さずに終わった終了通知は、普通の配送で 1 回届く', again === 'again' && Boolean(notTaken)
      && of(done.taskId).length === 2 && of(done.taskId)[1][4] === 'woken:again', JSON.stringify(of(done.taskId)));

    // ---- 止める合図を受けた回（取り消し中）に、外からのターンを合流させない。回が締まってから次の回として走らせる
    const open = gate('hold-e');
    const late = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'hold-e' });
    await until(() => manager.get(late.taskId).status === 'running');
    await manager.cancel(late.taskId, { by: 'human' });
    t.ok('止める合図の後、回が締まるまでは取り消し中', manager.get(late.taskId).status === 'cancelling');
    const lateSession = manager.get(late.taskId).sessionId;
    const runsBefore = externalRuns.length;
    let finishNext;
    const nextGate = new Promise(r => { finishNext = r; });
    const sendAfterStop = manager.external(lateSession, 'human', async hooks => {
      if (!hooks) return 'plain';
      await hooks.began();
      // 人の指示が子に渡った（server の onPromptDelivered → recordHumanDelivery → humanSent と同じ順）
      await manager.humanSent(lateSession, { text: 'つぎはこれを見て', attachments: 2 });
      await nextGate;
      return 'next';
    });
    await sleep(200);
    t.ok('取り消し中の回には合流しない（まだ走らせない）', externalRuns.length === runsBefore);
    open();
    await until(() => of(late.taskId).length === 1);
    const first = of(late.taskId)[0];
    t.ok('人が止めてすぐ送った: 1 通に「人が止めた＋途中の返答」「その指示の中身」「今は動いている」が載る', first[2] === 'running'
      && shape(first[5]).join('|') === 'run:cancelled:human:partial:hold-e|human:つぎはこれを見て:2', JSON.stringify(first));
    finishNext();
    const lateOut = await sendAfterStop;
    await until(() => manager.get(late.taskId).status === 'completed' && manager.get(late.taskId).notification === 'sent');
    await sleep(300);
    t.ok('その次の回が終わったら、完了の知らせがもう 1 通届く（届けた出来事は載せ直さない）', lateOut === 'next'
      && of(late.taskId).length === 2 && of(late.taskId)[1][2] === 'completed' && of(late.taskId)[1][4] === 'woken:next'
      && shape(of(late.taskId)[1][5]).join('|') === 'run:completed:-:woken:next', JSON.stringify(of(late.taskId)));

    // ---- 依頼元がターンの途中（届けられない）→ 子が終わる → 人が送る → 子がまた終わる: 空いたら 3 つを起きた順に 1 通で
    notReady.add('parent');
    const busy = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'quick-3' });
    await until(() => manager.get(busy.taskId).status === 'completed' && manager.get(busy.taskId).notification === 'pending');
    const busySession = manager.get(busy.taskId).sessionId;
    await manager.external(busySession, 'human', async hooks => { await hooks.began(); await manager.humanSent(busySession, { text: 'もう一度' }); return 'two'; });
    await until(() => manager.get(busy.taskId).status === 'completed' && manager.get(busy.taskId).events?.length === 3);
    await sleep(300);
    t.ok('依頼元が届けられない間は届けない', of(busy.taskId).length === 0);
    notReady.delete('parent');
    await until(() => manager.get(busy.taskId).notification === 'sent');
    await sleep(300);
    t.ok('空いたら 3 つの出来事を起きた順に 1 通で届ける', of(busy.taskId).length === 1
      && shape(of(busy.taskId)[0][5]).join('|') === 'run:completed:-:result:quick-3|human:もう一度:0|run:completed:-:woken:two'
      && of(busy.taskId)[0][5][2].cause.join() === 'human', JSON.stringify(of(busy.taskId)));
    t.ok('届けた出来事は行から消える', !manager.get(busy.taskId).events?.length, JSON.stringify(manager.get(busy.taskId).events));

    // ---- 人の指示は秘密の形を伏せ、300 字に切る
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    await manager.humanSent(busySession, { text: `鍵は ${secret} です。` + 'あ'.repeat(400) });
    const clipped = manager.get(busy.taskId).events?.at(-1);
    t.ok('人の指示の中身は伏せて 300 字（＋…）に切る', clipped?.kind === 'human' && !clipped.text.includes(secret) && clipped.text.startsWith('鍵は AKIA')
      && clipped.text.length === 301 && clipped.text.endsWith('…'), JSON.stringify(clipped));

    // ---- 人の指示だけでは依頼元を起こさない（止まっている子・走っている子とも）。次の知らせに載る
    await sleep(600);
    t.ok('止まっている子への人の指示だけでは知らせない', of(busy.taskId).length === 1 && manager.get(busy.taskId).notification === 'sent');
    const runner = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'hold-f' });
    await until(() => manager.get(runner.taskId).status === 'running');
    const runnerSession = manager.get(runner.taskId).sessionId;
    await manager.humanSent(runnerSession, { text: '途中で一言' });
    await sleep(600);
    t.ok('走っている子への人の指示だけでも知らせない', of(runner.taskId).length === 0 && manager.get(runner.taskId).notification === 'none',
      JSON.stringify({ delivered: of(runner.taskId), notification: manager.get(runner.taskId).notification }));
    await manager.call('parent', 'ply_task_cancel', { taskId: runner.taskId });
    await until(() => of(runner.taskId).length === 1);
    t.ok('その指示は次の回の終わりの知らせに、起きた順で載る', shape(of(runner.taskId)[0][5]).join('|') === 'human:途中で一言:0|run:cancelled:parent:partial:hold-f',
      JSON.stringify(of(runner.taskId)));

    // ---- 届けていない出来事は再起動の後も残り、届く
    notReady.add('parent');
    const kept = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'quick-4' });
    await until(() => manager.get(kept.taskId).status === 'completed' && manager.get(kept.taskId).notification === 'pending');
    await manager.humanSent(manager.get(kept.taskId).sessionId, { text: '再起動の前' });
    await manager.close();
    hooked.close();
    hooked = hookedTaskStorage(dir, {});
    manager = await createAgentTasks({ ...options, taskStorage: hooked.taskStorage });
    t.ok('再起動の後も、届けていない出来事が行に残る', shape(manager.get(kept.taskId).events ?? []).join('|') === 'run:completed:-:result:quick-4|human:再起動の前:0',
      JSON.stringify(manager.get(kept.taskId)));
    notReady.delete('parent');
    await until(() => of(kept.taskId).length === 1);
    t.ok('再起動の後に 1 通で届く', shape(of(kept.taskId)[0][5]).join('|') === 'run:completed:-:result:quick-4|human:再起動の前:0', JSON.stringify(of(kept.taskId)));
  } finally {
    await manager.close();
    hooked.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
