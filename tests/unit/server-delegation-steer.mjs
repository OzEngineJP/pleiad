import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';

export const name = 'server-delegation-steer';
export const title = '委譲の追加指示（ply_task_send）: 走っている子のターンへ途中送信で渡す・受理されない/結果不明/捨てられた/合図なしは待機か未配送（fake）';
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const delegate = task => ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task });

// 終わった後に新しいターンが走らないことの観察（子の終わりを待つ時間ではない）
const NO_LATE_TURN_MS = { a: 800, thrown: 600, e1: 600 };

export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-steer-'));
  const servers = [], clients = [];
  const boot = async env => {
    const dataDir = await fs.mkdtemp(path.join(scratch, 'data-'));
    const gates = await createFakeGates(scratch);
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', ...gates.env, ...env }, dataDir });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    servers.push(server); clients.push(c);
    const tasksOf = async parent => (await c.cmd('agentTasks')).filter(r => r.parentSessionId === parent);
    const awaitTask = async (parent, fn, ms = 60_000) => {
      const end = Date.now() + ms; let rows;
      while (Date.now() < end) { rows = await tasksOf(parent); if (rows[0] && fn(rows[0])) return rows[0]; await sleep(50); }
      throw new Error('task timeout: ' + JSON.stringify(rows.map(({ task, status, notification }) => ({ task, status, notification }))));
    };
    // 子（bg 台本）を依頼元ごとに 1 つ作り、子のターンが待ちに入る（途中送信を受けられる）まで進める。
    // 子は finish() でゲートを開くまで終わらない。終わらせるのは、場面で見たい状態を見終えてから
    const child = async (gate, { after } = {}) => {
      const mark = c.mark();
      const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate(`bg 1 gate:${gate}`) })).sessionId;
      const task = await awaitTask(parent, r => r.status === 'running');
      await c.waitFor(e => e.type === 'phase' && e.sessionId === task.sessionId && e.state === 'waiting', { from: mark, ms: 30000 });
      await after?.(task);
      return { parent, task, mark, finish: () => gates.open(gate) };
    };
    const send = (parent, task, message) => c.runTurn({ sessionId: parent, prompt: ply('ply_task_send', { taskId: task.taskId, message }) });
    const instructions = async task => (await c.cmd('agentTaskInstructions', { taskId: task.taskId })).instructions;
    const stateOf = async task => (await instructions(task)).map(x => `${x.text}:${x.state}`).join();
    const awaitState = async (task, want, ms = 10_000) => {
      const end = Date.now() + ms; let now;
      while (Date.now() < end) { now = await stateOf(task); if (now === want) return now; await sleep(20); }
      return now;
    };
    // 結果が確定し、完了通知が依頼元へ届き終わるまで
    const settled = (parent, fn = () => true) => awaitTask(parent, r => r.status === 'completed' && r.notification === 'sent' && fn(r));
    const turnEnds = (task, from) => c.since(from).filter(e => e.type === 'turnEnd' && e.sessionId === task.sessionId);
    const events = (task, from, type) => c.since(from).filter(e => e.type === type && e.sessionId === task.sessionId);
    const userTexts = async task => (await c.cmd('loadSession', { sessionId: task.sessionId })).messages.filter(m => m.role === 'user').map(m => m.text);
    return { c, gates, awaitTask, settled, child, send, instructions, stateOf, awaitState, turnEnds, events, userTexts };
  };
  try {
    // ---- 「渡った」合図を持たないバックエンド（fake の既定）
    {
      const { c, gates, awaitTask, settled, child, send, stateOf, awaitState, turnEnds, events, userTexts } = await boot({});

      // 走っている子へ渡す: 同じターンに入り、その場で配送済み。新しいターンは走らない
      const a = await child('a');
      const markA = c.mark();
      await send(a.parent, a.task, 'echo:STEER_A');
      t.ok('走っている子には途中送信で渡り、その場で配送済みになる', await stateOf(a.task) === 'echo:STEER_A:delivered');
      const um = events(a.task, markA, 'taskInstruction');
      t.ok('受け付けた時点で位置の出来事（taskInstruction）を出す',
        um.length === 1 && um[0].text === 'echo:STEER_A' && um[0].instructionId && um[0].taskId === a.task.taskId, JSON.stringify(um));
      await a.finish();
      const doneA = await settled(a.parent);
      await sleep(NO_LATE_TURN_MS.a);
      t.ok('同じターンの中で答え、新しいターンは走らない', turnEnds(a.task, a.mark).length === 1 && doneA.pendingMessages === 0);
      const historyA = await c.cmd('loadSession', { sessionId: a.task.sessionId });
      t.ok('子の履歴に指示と、その場の返答が並ぶ', historyA.messages.some(m => m.role === 'user' && m.text === 'echo:STEER_A')
        && historyA.messages.some(m => m.role === 'assistant' && m.text.includes('受け取った: echo:STEER_A')));
      t.ok('完了通知は 1 回', (await c.cmd('agentTasks')).find(r => r.taskId === a.task.taskId).notification === 'sent');

      // 受理されない（DECLINE_STEER）: 待機のまま、次のターンで 1 回
      const b = await child('b');
      const outB = JSON.parse((await send(b.parent, b.task, 'echo:LATER DECLINE_STEER').then(r => r.events.find(e => e.type === 'tool.result'))).text);
      t.ok('受理されなければ待機（queued）で、依頼元には待機件数が見える', await stateOf(b.task) === 'echo:LATER DECLINE_STEER:queued' && outB.pendingMessages === 1);
      await b.finish();
      const doneB = await awaitTask(b.parent, r => r.result === 'LATER DECLINE_STEER' && r.status === 'completed');
      t.ok('次のターンで 1 回だけ配送する', turnEnds(b.task, b.mark).length === 2 && await stateOf(b.task) === 'echo:LATER DECLINE_STEER:delivered'
        && (await userTexts(b.task)).filter(x => x.includes('LATER')).length === 1, doneB.status);

      // 結果不明（THROW_STEER）: 送り直さない（未配送で残す）
      const cth = await child('cth');
      const outTh = JSON.parse((await send(cth.parent, cth.task, 'echo:THROWN THROW_STEER').then(r => r.events.find(e => e.type === 'tool.result'))).text);
      t.ok('結果不明は未配送（dropped）で残し、待機にしない。依頼元には確かめるよう一言添える', await stateOf(cth.task) === 'echo:THROWN THROW_STEER:dropped'
        && outTh.pendingMessages === 0 && typeof outTh.warning === 'string');
      await cth.finish();
      await settled(cth.parent);
      await sleep(NO_LATE_TURN_MS.thrown);
      t.ok('自動で送り直さない', turnEnds(cth.task, cth.mark).length === 1 && !(await userTexts(cth.task)).some(x => x.includes('THROWN')));

      // 次ターンの設定の予約があっても、関係ない指示（message だけの send）は今のターンへ渡す。
      // 予約を待つのは、設定と同じ呼び出しで積まれた指示だけ（instruction.nextTurn）
      const d = await child('d');
      await c.cmd('setTurnSettings', { sessionId: d.task.sessionId, backend: 'fake', model: 'fast' });
      await send(d.parent, d.task, 'echo:NEXT');
      t.ok('予約と関係ない指示は、予約があっても今のターンへ途中送信で渡る', await stateOf(d.task) === 'echo:NEXT:delivered', await stateOf(d.task));
      const outD2 = JSON.parse((await c.runTurn({ sessionId: d.parent, prompt: ply('ply_task_send', { taskId: d.task.taskId, message: 'echo:FOR_NEXT', model: 'deep' }) })
        .then(r => r.events.find(e => e.type === 'tool.result'))).text);
      t.ok('設定と同じ呼び出しの指示は、替えた後のターンを待つ', await stateOf(d.task) === 'echo:NEXT:delivered,echo:FOR_NEXT:queued' && outD2.pendingMessages === 1, await stateOf(d.task));
      await d.finish();
      await awaitTask(d.parent, r => r.status === 'completed' && r.result === 'FOR_NEXT');
      t.ok('替えた後のターンで 1 回だけ配送する', turnEnds(d.task, d.mark).length === 2 && await stateOf(d.task) === 'echo:NEXT:delivered,echo:FOR_NEXT:delivered'
        && (await userTexts(d.task)).filter(x => x.includes('FOR_NEXT')).length === 1, await stateOf(d.task));

      // ターン開始の入力にした指示は、子がプロンプトを受け取った時点で配送済み（ターンの終わりを待たない。Issue #106）
      const f = await child('f');
      const textF = 'DECLINE_STEER HOLD_TURN:f2 do it';
      await send(f.parent, f.task, textF);
      t.ok('走っている子へは受理されず待機', await awaitState(f.task, `${textF}:queued`) === `${textF}:queued`);
      await f.finish();
      await awaitTask(f.parent, r => r.status === 'running');
      t.ok('ターン開始の入力にした指示は、子が受け取った時点で配送済み（ターンの終わりを待たない）',
        await awaitState(f.task, `${textF}:delivered`) === `${textF}:delivered`, await stateOf(f.task));
      await gates.open('f2');
      await settled(f.parent);
      t.ok('次のターンで 1 回だけ配送する', turnEnds(f.task, f.mark).length === 2 && (await userTexts(f.task)).filter(x => x === textF).length === 1);
    }

    // ---- 「渡った」合図を後から出すバックエンド（本物の claude / codex と同じ steerConfirms）
    // 受理から渡るまでの間は時間でなく、HOLD_CONFIRM のゲートで決める。それ以外の合図は即（20ms）出す
    {
      const { c, gates, awaitTask, settled, child, send, stateOf, awaitState, turnEnds, events, userTexts } = await boot({ AGENT_HOST_FAKE_STEER_CONFIRM_MS: '20' });

      // 受理 → 合図まで送信中 → 渡った
      const e1 = await child('e1');
      const mark1 = c.mark();
      const held = 'echo:CONFIRMED HOLD_CONFIRM:e1-confirm';
      await send(e1.parent, e1.task, held);
      t.ok('受理しただけでは送信中（sending）。位置の出来事は受け付け時に出ている', await stateOf(e1.task) === `${held}:sending`
        && events(e1.task, mark1, 'taskInstruction').some(e => e.text === held), await stateOf(e1.task));
      t.ok('合図の前には、渡ったとも捨てられたとも言わない', events(e1.task, mark1, 'userMessage.delivered').length === 0 && events(e1.task, mark1, 'userMessage.dropped').length === 0);
      await gates.open('e1-confirm');
      await c.waitFor(e => e.type === 'userMessage.delivered' && e.sessionId === e1.task.sessionId, { from: mark1, ms: 10000 });
      t.ok('渡った合図で配送済みになる', await awaitState(e1.task, `${held}:delivered`) === `${held}:delivered`);
      await e1.finish();
      await settled(e1.parent);
      await sleep(NO_LATE_TURN_MS.e1);
      t.ok('新しいターンは走らない', turnEnds(e1.task, e1.mark).length === 1);

      // 読まれずに捨てられた（userMessage.dropped）: 待機へ戻り、次のターンで 1 回だけ
      const e2 = await child('e2');
      const mark2 = c.mark();
      await send(e2.parent, e2.task, 'echo:DROPPED DROP_STEER');
      await c.waitFor(e => e.type === 'userMessage.dropped' && e.sessionId === e2.task.sessionId, { from: mark2, ms: 10000 });
      t.ok('捨てられたら待機（queued）へ戻る', await awaitState(e2.task, 'echo:DROPPED DROP_STEER:queued') === 'echo:DROPPED DROP_STEER:queued');
      await e2.finish();
      await awaitTask(e2.parent, r => r.status === 'completed' && r.result === 'DROPPED DROP_STEER');
      t.ok('次のターンで 1 回だけ配送する', turnEnds(e2.task, e2.mark).length === 2 && await stateOf(e2.task) === 'echo:DROPPED DROP_STEER:delivered'
        && (await userTexts(e2.task)).filter(x => x.includes('DROPPED')).length === 1);

      // 合図が来ないままターンが終わった: 待機へ戻り、次のターンで 1 回だけ。画面の発言は下げる
      const e3 = await child('e3');
      const mark3 = c.mark();
      await send(e3.parent, e3.task, 'echo:SILENT SILENT_STEER');
      t.ok('合図が来るまでは送信中', await awaitState(e3.task, 'echo:SILENT SILENT_STEER:sending') === 'echo:SILENT SILENT_STEER:sending');
      await e3.finish();
      await awaitTask(e3.parent, r => r.status === 'completed' && r.result === 'SILENT SILENT_STEER');
      t.ok('合図なしでターンが終わったら、次のターンで 1 回だけ配送する', turnEnds(e3.task, e3.mark).length === 2 && await stateOf(e3.task) === 'echo:SILENT SILENT_STEER:delivered'
        && (await userTexts(e3.task)).filter(x => x.includes('SILENT')).length === 1);
      t.ok('渡っていない発言は画面から下げる（userMessage.dropped）', events(e3.task, mark3, 'userMessage.dropped').length === 1);

      // 配送確認待ちでも、後続をバックエンドへ送信する。
      const e4 = await child('e4');
      const hold4 = 'echo:FIRST HOLD_CONFIRM:e4-confirm';
      await send(e4.parent, e4.task, hold4);
      await send(e4.parent, e4.task, 'echo:SECOND');
      t.ok('先の合図待ちでも後続は送信済みで確認待ちになる', await stateOf(e4.task) === `${hold4}:sending,echo:SECOND:sending`);
      await gates.open('e4-confirm');
      t.ok('先と後の両方に配送確認を反映する', await awaitState(e4.task, `${hold4}:delivered,echo:SECOND:delivered`) === `${hold4}:delivered,echo:SECOND:delivered`);
      await e4.finish(); await settled(e4.parent);
      t.ok('後続を同じターンで処理する', turnEnds(e4.task, e4.mark).length === 1);

      // 一時的に送れない間の待機分は、予約が外れたら1回で送る。
      const e5 = await child('e5');
      await c.cmd('setTurnSettings', { sessionId: e5.task.sessionId, backend: 'fake', model: 'fast' });
      await send(e5.parent, e5.task, 'echo:BATCH_FIRST');
      await send(e5.parent, e5.task, 'echo:BATCH_SECOND');
      const mark5 = c.mark();
      await c.cmd('setTurnSettings', { sessionId: e5.task.sessionId, cancel: true });
      const batch5 = 'echo:BATCH_FIRST\n\necho:BATCH_SECOND';
      const want5 = 'echo:BATCH_FIRST:delivered,echo:BATCH_SECOND:delivered';
      t.ok('まとめた受信確認を全指示に反映する', await awaitState(e5.task, want5) === want5);
      const messages5 = events(e5.task, e5.mark, 'taskInstruction');
      t.ok('子の会話の中の位置は指示ごとの出来事で確定する（1 件ずつ）', messages5.length === 2 && messages5[0].text === 'echo:BATCH_FIRST' && messages5[1].text === 'echo:BATCH_SECOND', JSON.stringify(messages5));
      t.ok('履歴にまとめた本文が1回だけ入る', (await userTexts(e5.task)).filter(text => text === batch5).length === 1);
      await e5.finish(); await settled(e5.parent);
      t.ok('一括送信で新しいターンを増やさない', turnEnds(e5.task, e5.mark).length === 1);

    }
  } finally {
    for (const c of clients) c.close();
    for (const s of servers) await s.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
