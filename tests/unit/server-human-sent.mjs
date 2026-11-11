// 人が委譲の子の会話へ直接送った発言（モーダルの入力欄。ADR 0317）をサーバー越しに（fake バックエンド）。
//   - 送った時に本文のハッシュを会話に残し、履歴の発言に sentByHuman が付く（読み直しても残る）。依頼（最初の発言）には付かない
//   - 委譲の子でない会話（依頼元）への送信には付かない
//   - 届いた出来事にも sentByHuman（開いているモーダルがその場で「あなた」の名札を描ける）
//   - 子が終わったとき、親の AI へ渡す完了通知に「人からの指示 N 件」が 1 回だけ載る（送るたびには知らせない）。人が送っていない子には載らない
//   - 同じ文面を親の AI（ply_task_send）と人が送っても、「あなた」は人の分だけ（順序が入れ替わっても）。同じ messageId の送り直しは数えない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';

export const name = 'server-human-sent';
export const title = '人が子の会話へ直接送った発言: 履歴の「あなた」の印・出来事の印・完了通知の「人からの指示 N 件」（fake）';

const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const delegate = task => ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-human-sent-'));
  const gates = await createFakeGates(scratch);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', ...gates.env }, dataDir: path.join(scratch, 'data') });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const tasksOf = async parent => (await c.cmd('agentTasks')).filter(r => r.parentSessionId === parent);
    const awaitTasks = async (parent, fn, ms = 60_000) => {
      const end = Date.now() + ms; let rows;
      while (Date.now() < end) { rows = await tasksOf(parent); if (fn(rows)) return rows; await sleep(50); }
      throw new Error('task timeout: ' + JSON.stringify(rows));
    };

    // 子が走っている間に、人が子へ直接送る（走っている子の送信は、途中送信か次のターンで届く）
    const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 gate:human-child') })).sessionId;
    const [running] = await awaitTasks(parent, rows => rows[0]?.sessionId && rows[0]?.status === 'running');
    const child = running.sessionId;
    t.ok('子が走っていて、人からの指示はまだ数えない', !running.humanInstructions);
    const mark = c.mark();
    await c.cmd('sendMessage', { sessionId: child, messageId: 'human-child-0001', prompt: 'echo:人からの追加' });
    t.ok('走っている子への送信に、まだ完了通知は無い', !c.since(mark).some(e => e.type === 'taskNotice' && e.sessionId === parent));
    await gates.open('human-child');
    const [done] = await awaitTasks(parent, rows => rows[0]?.status === 'completed' && rows[0]?.notification === 'sent');
    t.ok('子の行が人からの指示を 1 件と数える', done.humanInstructions === 1, String(done.humanInstructions));
    const notices = c.since(0).filter(e => e.type === 'taskNotice' && e.sessionId === parent);
    t.ok('完了通知に「人からの指示 1 件」が 1 回', notices.length === 1 && /人からの指示 1 件/.test(notices[0].text), notices.map(n => n.text).join(' ||| '));

    const delivered = c.since(0).find(e => e.type === 'userMessage' && e.sessionId === child && e.text === 'echo:人からの追加');
    t.ok('子の会話に届いた出来事に sentByHuman', delivered?.sentByHuman === true, JSON.stringify(delivered));
    const loaded = await c.cmd('loadSession', { sessionId: child });
    const users = loaded.messages.filter(m => m.role === 'user' && !m.kind);
    const request = users.find(m => m.text.includes('bg 1'));
    const human = users.find(m => m.text === 'echo:人からの追加');
    t.ok('履歴の人の発言に sentByHuman（読み直しても残る）', human?.sentByHuman === true, JSON.stringify(users));
    t.ok('最初の依頼には付かない', request && !request.sentByHuman && !request.sentBy);
    t.ok('別の会話の AI の印（sentBy）は使わない', !human?.sentBy);

    // 人が送っていない子の完了通知には載せない
    const quiet = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('echo:人は送らない') })).sessionId;
    await awaitTasks(quiet, rows => rows[0]?.status === 'completed' && rows[0]?.notification === 'sent');
    const quietNotices = c.since(0).filter(e => e.type === 'taskNotice' && e.sessionId === quiet);
    t.ok('人が送っていない子の通知に「人からの指示」は載らない', quietNotices.length === 1 && !quietNotices[0].text.includes('人からの指示'), quietNotices[0]?.text);

    // 委譲の子でない会話（依頼元）への送信には付けない
    const mark2 = c.mark();
    await c.cmd('sendMessage', { sessionId: parent, messageId: 'human-parent-0001', prompt: 'echo:親への送信' });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === parent, { from: mark2, ms: 30_000 });
    const parentLoaded = await c.cmd('loadSession', { sessionId: parent });
    const sentToParent = parentLoaded.messages.find(m => m.role === 'user' && m.text === 'echo:親への送信');
    t.ok('依頼元への送信には sentByHuman を付けない', sentToParent && !sentToParent.sentByHuman);
    t.ok('依頼元への送信は子の人からの指示の数を増やさない', (await tasksOf(parent))[0].humanInstructions === 1);

    // 同じ文面を親の AI と人が送る（AI → 人 → AI）。名札は台帳で見分け、人の 1 件だけに「あなた」が付く。同じ messageId の送り直しは数えない
    const same = 'echo:続けて';
    const parent2 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('echo:最初の依頼') })).sessionId;
    const [first2] = await awaitTasks(parent2, rows => rows[0]?.status === 'completed' && rows[0]?.notification === 'sent');
    const child2 = first2.sessionId;
    // 依頼元が完了通知の続きを走らせている間は送れない。空くまで繰り返す
    const parentRun = async (sessionId, prompt) => {
      for (let tries = 0; ; tries++) {
        try { return await c.cmd('runTurn', { sessionId, prompt }); }
        catch (e) { if (tries >= 80) throw e; await sleep(250); }
      }
    };
    const aiSend = async () => {
      const m = c.mark();
      await parentRun(parent2, ply('ply_task_send', { taskId: first2.taskId, message: same }));
      await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === child2, { from: m, ms: 30_000 });
    };
    await aiSend();
    const humanSend = async (messageId, { runs = true } = {}) => {
      const m = c.mark();
      await c.cmd('sendMessage', { sessionId: child2, messageId, prompt: same });
      if (runs) await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === child2, { from: m, ms: 30_000 });
    };
    await humanSend('human-same-0001');
    await humanSend('human-same-0001', { runs: false });   // 同じ messageId の送り直し（応答が届かず送り直した）
    await aiSend();
    const sameLoaded = await c.cmd('loadSession', { sessionId: child2 });
    const sameUsers = sameLoaded.messages.filter(m => m.role === 'user' && !m.kind && m.text === same);
    t.ok('同じ文面の発言が 3 件ある（AI・人・AI）', sameUsers.length === 3, String(sameUsers.length));
    t.ok('人の 1 件だけに「あなた」が付く（AI → 人 → AI の順）', sameUsers.map(m => Boolean(m.sentByHuman)).join() === 'false,true,false', sameUsers.map(m => m.sentByHuman).join());
    t.ok('同じ messageId の送り直しは数えない', (await tasksOf(parent2))[0].humanInstructions === 1, String((await tasksOf(parent2))[0].humanInstructions));
    // 人が先、AI が後（人 → AI）
    const parent3 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('echo:最初の依頼3') })).sessionId;
    const [first3] = await awaitTasks(parent3, rows => rows[0]?.status === 'completed' && rows[0]?.notification === 'sent');
    const m3 = c.mark();
    await c.cmd('sendMessage', { sessionId: first3.sessionId, messageId: 'human-same-0003', prompt: same });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === first3.sessionId, { from: m3, ms: 30_000 });
    const m4 = c.mark();
    await parentRun(parent3, ply('ply_task_send', { taskId: first3.taskId, message: same }));
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === first3.sessionId, { from: m4, ms: 30_000 });
    const order = (await c.cmd('loadSession', { sessionId: first3.sessionId })).messages.filter(m => m.role === 'user' && !m.kind && m.text === same);
    t.ok('人 → AI の順でも、人の 1 件だけに「あなた」が付く', order.length === 2 && order.map(m => Boolean(m.sentByHuman)).join() === 'true,false', order.map(m => m.sentByHuman).join());
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
