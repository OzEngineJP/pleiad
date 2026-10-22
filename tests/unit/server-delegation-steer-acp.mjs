import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { injectTaskInstructions } from '../../web/task-instructions.mjs';

export const name = 'server-delegation-steer-acp';
export const title = '委譲の追加指示（ply_task_send）: ACP の子（Devin）で受理後の決着（渡った・捨てられた）を指示の状態に反映する';
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-steer-acp-'));
  let server, c;
  try {
    server = await startServer({ dataDir: path.join(scratch, 'data'), env: {
      AGENT_HOST_BACKENDS: 'fake,devin',
      AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`,
      DEVIN_CONFIG_HOME: path.join(scratch, 'devin-config'),
      FAKE_DEVIN_SLOW_MS: '8000',
    } });
    c = await open({ port: server.port, token: server.token, autoAllow: true });

    const tasksOf = async parent => (await c.cmd('agentTasks')).filter(r => r.parentSessionId === parent);
    const awaitTask = async (parent, fn, ms = 30_000) => {
      const end = Date.now() + ms; let rows;
      while (Date.now() < end) { rows = await tasksOf(parent); if (rows[0] && fn(rows[0])) return rows[0]; await sleep(50); }
      throw new Error('task timeout: ' + JSON.stringify(rows.map(({ task, status }) => ({ task, status }))));
    };
    const instructions = async task => (await c.cmd('agentTaskInstructions', { taskId: task.taskId })).instructions;
    const stateOf = async task => (await instructions(task)).map(x => `${x.text}:${x.state}`).join();
    const awaitState = async (task, want, ms = 10_000) => {
      const end = Date.now() + ms; let now;
      while (Date.now() < end) { now = await stateOf(task); if (now === want) return now; await sleep(20); }
      return now;
    };
    // Devin の子（[slow] で回を保持）を作り、子のターンがプロンプトを受け付けるまで待つ
    // （委譲の子は会話が先に作られるので session イベントに first は付かない。thinking は prompting を立てた直後に出る）
    const child = async (taskText) => {
      const mark = c.mark();
      const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'devin', task: taskText }) })).sessionId;
      const task = await awaitTask(parent, r => r.status === 'running' && r.sessionId);
      await c.waitFor(e => e.type === 'activity' && e.sessionId === task.sessionId && e.state === 'thinking', { from: mark, ms: 30000 });
      return { parent, task, mark };
    };
    const send = (parent, task, message) => c.runTurn({ sessionId: parent, prompt: ply('ply_task_send', { taskId: task.taskId, message }) });
    const events = (task, from, type) => c.since(from).filter(e => e.type === type && e.sessionId === task.sessionId);

    // ---- 受理 → 回の決着で「渡った」: 同じターンの中で読まれ、指示は delivered
    {
      const a = await child('[slow] hold-for-steer');
      const markA = c.mark();
      const out = JSON.parse((await send(a.parent, a.task, 'follow-up A').then(r => r.events.find(e => e.type === 'tool.result'))).text);
      t.ok('受理された時点では送信中（queued には戻さない・依頼元の pendingMessages は 0）',
        out.pendingMessages === 0 && await awaitState(a.task, 'follow-up A:sending') === 'follow-up A:sending', await stateOf(a.task));
      const um = events(a.task, markA, 'taskInstruction');
      t.ok('子の会話の中の位置は受け付けの出来事（taskInstruction）で確定する', um.length === 1 && um[0].text === 'follow-up A' && Boolean(um[0].instructionId), JSON.stringify(um));
      const held = await awaitTask(a.parent, r => r.status === 'completed', 30_000);
      t.ok('回の決着で渡った合図（userMessage.delivered）が届き、指示は delivered になる',
        events(a.task, markA, 'userMessage.delivered').length === 1 && await stateOf(a.task) === 'follow-up A:delivered', await stateOf(a.task));
      const text = JSON.stringify((await c.cmd('loadSession', { sessionId: a.task.sessionId })).messages);
      t.ok('同じ回に折り込まれて答えられる（新しいターンは増えない）', held.result.includes('follow-up A') || text.includes('fixture: follow-up A'), held.result?.slice(0, 200));
    }

    // ---- 受理の判定の窓（300ms）より速い成功: 渡った合図が受理の応答より先に出ても、
    // 指示は delivered で決着し、送信中・待機のまま残らない（server は合図の控えを steer を呼ぶ前に置く）。
    // 受付の出来事（taskInstruction）は常に合図より先に出るので、早い合図が表示を送信中へ戻すこともない
    {
      const f = await child('[slow] fast-steer');
      const markF = c.mark();
      const out = JSON.parse((await send(f.parent, f.task, '[fast-steer] quick').then(r => r.events.find(e => e.type === 'tool.result'))).text);
      const order = c.since(markF).filter(e => e.sessionId === f.task.sessionId && ['taskInstruction', 'userMessage.delivered'].includes(e.type)).map(e => e.type);
      t.ok('受付の出来事が先、渡った合図が後の順になっている', order.join() === 'taskInstruction,userMessage.delivered', order.join());
      t.ok('指示は delivered で決着し、依頼元の pendingMessages は 0',
        out.pendingMessages === 0 && await awaitState(f.task, '[fast-steer] quick:delivered') === '[fast-steer] quick:delivered', await stateOf(f.task));
      await awaitTask(f.parent, r => r.status === 'completed', 30_000);
      t.ok('子のターンが終わっても送信中・待機に戻らず、送り直しも無い',
        await stateOf(f.task) === '[fast-steer] quick:delivered' && events(f.task, markF, 'taskInstruction').length === 1, await stateOf(f.task));
    }

    // ---- 受理 → 中断で決着:「渡った」合図が無いまま捨てられた分は delivered のままにせず dropped にする
    {
      const b = await child('[slow] drop-me');
      const markB = c.mark();
      await send(b.parent, b.task, 'follow-up B');
      await awaitState(b.task, 'follow-up B:sending');
      await c.cmd('abort', { sessionId: b.task.sessionId });
      t.ok('受理後に中断で捨てられた指示は delivered のまま残らず dropped になる',
        await awaitState(b.task, 'follow-up B:dropped') === 'follow-up B:dropped', await stateOf(b.task));
      t.ok('画面へも userMessage.dropped が出る', events(b.task, markB, 'userMessage.dropped').length >= 1);
      await awaitTask(b.parent, r => ['failed', 'cancelled', 'completed'].includes(r.status), 30_000);
    }

    // ---- 受理後に cancelled で決着（既読不明）: 既に実行された可能性があるので、dropped にして自動では送り直さない
    {
      const d = await child('[slow] unknown-drop');
      const markD = c.mark();
      await send(d.parent, d.task, '[drop-steer] maybe-read');
      await awaitState(d.task, '[drop-steer] maybe-read:sending');
      const doneD = await awaitTask(d.parent, r => r.status === 'completed', 30_000);
      t.ok('既読不明の決着は dropped のまま残し、待機へ戻さない',
        await stateOf(d.task) === '[drop-steer] maybe-read:dropped', await stateOf(d.task));
      const turnsD = c.since(markD).filter(e => e.type === 'turnEnd' && e.sessionId === d.task.sessionId);
      const userTextsD = (await c.cmd('loadSession', { sessionId: d.task.sessionId })).messages.filter(m => m.role === 'user').map(m => m.text);
      t.ok('自動で次のターンへ送り直さない（新しいターンも重複配送も無い）',
        turnsD.length === 1 && userTextsD.filter(x => x.includes('maybe-read')).length <= 1, JSON.stringify({ turnsD: turnsD.length, doneD: doneD.status }));
    }

    // ---- 子が返答を終えて待っている間に受け付けた指示（新しいターンのプロンプトとして届く分）:
    // 受付時に会話の記録の末尾の行を錨に取り、再読み出し（ACP の履歴は全行が時刻なし）でも受け付けた位置に戻る
    {
      const done = parent => awaitTask(parent, r => r.status === 'completed' && r.notification === 'sent', 30_000);
      // 完了通知のターン（依頼元の会話）が切り替え中の間に ply_task_send が断られることがある。親が空くまでやり直す
      const sendIdle = async (parent, task, message) => {
        for (let i = 0; ; i++) {
          try { return await send(parent, task, message); }
          catch (e) { if (i >= 60 || !String(e?.message ?? e).includes('切り替え中')) throw e; await sleep(100); }
        }
      };
      // 待っている子へ送った指示は子の新しいターンになる。依頼元のタスクは前の回から completed・sent のままなので、
      // done だけでは子のターンの終わりを待てない（負荷が高いと、終わる前に記録を読んでしまう）。子の turnEnd を待つ
      const sendAndSettle = async (parent, task, message) => {
        const from = c.mark();
        await sendIdle(parent, task, message);
        await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === task.sessionId, { from, ms: 30_000 });
        await done(parent);
      };
      const g = await child('anchor-check');
      await done(g.parent);
      const before = await c.cmd('loadSession', { sessionId: g.task.sessionId });
      const tailUuid = before.messages.at(-1)?.uuid;
      t.ok('第 1 ターンの履歴の末尾の行は uuid を持つ', Boolean(tailUuid));
      await sendAndSettle(g.parent, g.task, 'idle-follow');
      const instrA = (await instructions(g.task)).find(x => x.text === 'idle-follow');
      t.ok('ターンが走っていないときに受け付けた指示に、記録の末尾の行の uuid の錨が付く',
        instrA?.anchor?.kind === 'uuid' && instrA.anchor.v === tailUuid, JSON.stringify(instrA?.anchor ?? null));
      await sendAndSettle(g.parent, g.task, 'idle-second');

      const after = await c.cmd('loadSession', { sessionId: g.task.sessionId });
      const all = await instructions(g.task);
      const insA = all.find(x => x.text === 'idle-follow'), insB = all.find(x => x.text === 'idle-second');
      const echoB = after.messages.findIndex(m => m.uuid === insB?.nativeId);
      t.ok('2 件目の錨は、受け付けた時点の末尾の行（前の指示への返答）を指す',
        echoB > 0 && insB?.anchor?.v === after.messages[echoB - 1]?.uuid, JSON.stringify(insB?.anchor ?? null));

      // 読み直し: 届いた行（nativeId の行）を消した上で、各指示は受け付けた位置に戻る（末尾にまとまらない）。
      // out の並び: …第 1 ターンの返答（tailUuid）→ ins:idle-follow → その返答 → ins:idle-second → その返答
      const show = out => JSON.stringify(out.map(m => m.role === 'instruction' ? `ins:${m.instruction.text}` : `${m.role}:${String(m.text ?? '').slice(0, 40)}`));
      const check = out => {
        const at = out.findIndex(m => m.uuid === tailUuid);
        return at >= 0 && out[at + 1]?.instruction?.id === insA?.id && out[at + 3]?.instruction?.id === insB?.id
          && out.filter(m => m.role !== 'instruction').length === after.messages.length - 2;
      };
      const placed = injectTaskInstructions(all, after.messages);
      t.ok('読み直し後も各指示は受け付けた位置に戻る（末尾にまとまらない）', check(placed), show(placed));
      // 錨の無い記録（旧データ）でも、届いた行（nativeId）が消えた位置に戻る
      const noAnchor = all.map(({ anchor, ...rest }) => rest);
      const placedNoAnchor = injectTaskInstructions(noAnchor, after.messages);
      t.ok('錨の無い記録でも、消した履歴の行の位置に戻る', check(placedNoAnchor), show(placedNoAnchor));
    }
  } finally {
    c?.close();
    await server?.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
