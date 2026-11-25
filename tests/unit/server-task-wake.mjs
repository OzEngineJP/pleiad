// 止まった委譲の子が外から起きたとき（ADR 0355）をサーバー越しに（fake バックエンド）。
//   - 終わった子へ人が直接送ると、タスクが running に戻り（lastActivityAt も動く）、止まったら completed・最新の返答を結果にして、依頼元へ 1 回知らせる
//   - 走っている間に人がもう 1 件送っても（途中送信を受けないターン＝次のターンで渡る）、知らせは止まったときの 1 回。人の指示 2 件の中身と、回の終わり（きっかけ：人の指示）を起きた順に載せる（ADR 0355）
//   - 人が子のターンを止める（走っているタスクとして取り消す）→「再開」を押すと、再開のターンも running → completed で知らせ、きっかけに「再開」が載る
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';

export const name = 'server-task-wake';
export const title = '止まった委譲の子が外から起きた: 人の送信・続けて 2 件・再開で、タスクが動き、止まったら 1 回知らせる（fake）';

const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const delegate = task => ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task });
// 途中送信を受けないターン（2 件目は送信待ちに残り、このターンが終わってから次のターンで渡る）
const slowSteps = (ms, text) => 'steps:' + JSON.stringify({ steps: [{ tool: 'Grep', input: { pattern: 'x' }, result: 'none', ms }, { text }] });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-task-wake-'));
  const gates = await createFakeGates(scratch);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', ...gates.env }, dataDir: path.join(scratch, 'data') });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const rowOf = async taskId => (await c.cmd('agentTasks')).find(r => r.taskId === taskId);
    const awaitRow = async (taskId, fn, ms = 60_000) => {
      const end = Date.now() + ms; let row;
      while (Date.now() < end) { row = await rowOf(taskId); if (row && fn(row)) return row; await sleep(50); }
      throw new Error('task timeout: ' + JSON.stringify(row));
    };
    const noticesOf = (parent, from = 0) => c.since(from).filter(e => e.type === 'taskNotice' && e.sessionId === parent);

    // 1. 終わった子へ人が送る → running → completed、1 回知らせる。走っている間の 2 件目も同じ回にまとまる
    const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('echo:最初の依頼') })).sessionId;
    const first = (await c.cmd('agentTasks')).find(r => r.parentSessionId === parent);
    const done = await awaitRow(first.taskId, r => r.status === 'completed' && r.notification === 'sent');
    const child = done.sessionId;
    t.ok('最初の依頼で 1 回知らせた', noticesOf(parent).length === 1, String(noticesOf(parent).length));

    const mark = c.mark();
    await sleep(20);
    await c.cmd('sendMessage', { sessionId: child, messageId: 'wake-human-0001', prompt: slowSteps(1500, '一つ目の返答') });
    const running = await awaitRow(first.taskId, r => r.status === 'running');
    t.ok('人の送信で、終わった子のタスクが running に戻る', running.status === 'running');
    t.ok('lastActivityAt が動く', Number(running.lastActivityAt) > Number(done.lastActivityAt), `${done.lastActivityAt} → ${running.lastActivityAt}`);
    t.ok('走っている間は、まだ知らせない', noticesOf(parent, mark).length === 0);
    await c.cmd('sendMessage', { sessionId: child, messageId: 'wake-human-0002', prompt: 'echo:二つ目の返答' });
    const woke = await awaitRow(first.taskId, r => r.status === 'completed' && r.notification === 'sent' && r.humanInstructions === 2);
    // 2 件目のターンの後にもう知らせが来ないことを、少し待って確かめる
    await sleep(800);
    const wokeNotices = noticesOf(parent, mark);
    t.ok('止まったら completed・sent になり、知らせは 1 回', wokeNotices.length === 1, wokeNotices.map(n => n.text).join(' ||| '));
    t.ok('結果は最新の返答', woke.result?.includes('二つ目の返答') && !woke.result?.includes('一つ目の返答'), woke.result);
    t.ok('知らせに人の指示 2 件と回の終わり（きっかけ：人の指示）が起きた順に載る', /人が子に指示しました：「steps:[^\n]*一つ目の返答[^\n]*」\n- その後、人が子に指示しました：「echo:二つ目の返答」\n- その後、子の回が終わりました：完了しました（きっかけ：人の指示）\n/.test(wokeNotices[0]?.text ?? ''), wokeNotices[0]?.text);
    t.ok('知らせの本文も最新の返答', wokeNotices[0]?.text.includes('二つ目の返答'), wokeNotices[0]?.text);
    const childTurns = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === child).length;
    t.ok('子のターンは 2 回走った（2 件目は次のターンで渡った）', childTurns === 2, String(childTurns));

    // 2. 人が子のターンを止めて、再開を押す
    const mark2 = c.mark();
    await c.cmd('sendMessage', { sessionId: child, messageId: 'wake-human-0003', prompt: 'slow' });
    await awaitRow(first.taskId, r => r.status === 'running');
    await sleep(300);
    await c.cmd('abort', { sessionId: child });
    // 子の会話を直接止めると、走っているタスクは取り消す（今までの決まり。起きた子も running なので同じ）
    const stopped = await awaitRow(first.taskId, r => r.status === 'cancelled');
    t.ok('起きた子の会話を止めると、走っているタスクとして取り消す', stopped.status === 'cancelled', JSON.stringify(stopped));
    // 人が止めた回の知らせ（人の指示「slow」→ 人が止めた）が届いてから再開する
    await awaitRow(first.taskId, r => r.notification === 'sent' && noticesOf(parent, mark2).length === 1);
    t.ok('人が止めた回の知らせに、その前の人の指示と「人が止めた」が順に載る', /人が子に指示しました：「slow」\n- その後、子の回が終わりました：人が止めました/.test(noticesOf(parent, mark2)[0]?.text ?? ''), noticesOf(parent, mark2)[0]?.text);
    const mark3 = c.mark();
    let resumed = null;
    for (let i = 0; i < 80 && !resumed; i++) {
      resumed = await c.cmd('resume', { sessionId: child }).catch(e => { if (i === 79) throw e; return null; });
      if (!resumed) await sleep(100);
    }
    t.ok('再開を受け付けた', Boolean(resumed), JSON.stringify(resumed));
    const after = await awaitRow(first.taskId, r => r.status === 'completed' && r.notification === 'sent' && noticesOf(parent, mark3).length >= 1);
    await sleep(500);
    const resumeNotices = noticesOf(parent, mark3);
    t.ok('再開のターンが止まったら 1 回知らせる', resumeNotices.length === 1, resumeNotices.map(n => n.text).join(' ||| '));
    t.ok('知らせのきっかけに「再開」', /子の回が終わりました：完了しました（きっかけ：再開）/.test(resumeNotices[0]?.text ?? ''), resumeNotices[0]?.text);
    t.ok('再開は人の指示に数えない', after.humanInstructions === 3, String(after.humanInstructions));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
