// テストの補助 runTurn（tests/lib/ws-client.mjs）が、自分が始めた会話の session・turnEnd だけを見ること。
// 以前はどの会話の turnEnd でも返り、最初の session の ID を返していた。裏で委譲の完了通知のターンが走ると、
// 別の会話の ID か null を返してテストが時間切れになった（CI の ubuntu/Node 20）。fake バックエンドだけで、LLM は呼ばない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'ws-client-run-turn';
export const title = 'runTurn は開始の受理と自分のターンの終わりを確認する';

export default async function (t) {
  // 同じ会話の前のターンが終わってから、今回の開始要求への返事が届く順を固定する。
  // 完了通知と ply_task_send が重なると、この順で拒否が成功に見えることがある。
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => wss.once('listening', resolve));
  wss.on('connection', ws => {
    let startId;
    ws.send(JSON.stringify({ kind: 'ready' }));
    ws.on('message', raw => {
      const { id, command, args } = JSON.parse(raw);
      const event = value => ws.send(JSON.stringify({ kind: 'event', event: { sessionId: 'same-session', ...value } }));
      const reply = value => ws.send(JSON.stringify({ kind: 'response', id, ...value }));
      if (command === 'runTurn') {
        event({ type: 'turnEnd', outcome: 'aborted' });
        event({ type: 'cwd', cwd: 'prepared-directory' });
        if (args.prompt === 'reject') reply({ ok: false, error: 'busy fixture' });
        else if (args.prompt === 'immediate') {
          reply({ ok: true, result: 'started' });
          event({ type: 'session' });
          event({ type: 'turnResult', outcome: 'ok' });
          event({ type: 'turnEnd', outcome: 'ok' });
        } else startId = id;
      } else {
        if (command === 'accept') {
          ws.send(JSON.stringify({ kind: 'response', id: startId, ok: true, result: 'started' }));
          event({ type: 'session' });
          event({ type: 'turnResult', outcome: 'ok' });
        }
        if (command === 'finish') event({ type: 'turnEnd', outcome: 'ok' });
        reply({ ok: true });
      }
    });
  });
  let stub;
  try {
    stub = await open({ port: wss.address().port, token: 'fixture' });
    let rejected = false;
    let rejection;
    try { await stub.runTurn({ sessionId: 'same-session', prompt: 'reject' }, { ms: 1000 }); }
    catch (e) { rejection = e.message; rejected = rejection === 'busy fixture'; }
    t.ok('前の turnEnd が先に届いても、今回の開始要求の拒否を返す', rejected, String(rejection));

    let returned = null;
    const running = stub.runTurn({ sessionId: 'same-session', prompt: 'accept' }, { ms: 1000 }).then(r => { returned = r; return r; });
    running.catch(() => {}); // 後続のコマンドを待つ間の拒否も、下の await で試験の例外として受ける。
    await stub.cmd('barrier');
    t.ok('開始受理より前の同じ会話の turnEnd では返らない', returned === null);
    await stub.cmd('accept');
    await stub.cmd('finish');
    const result = await running;
    t.ok('受理した回の結果と終わりを返す', result.outcome === 'ok' && result.events.at(-1)?.type === 'turnEnd' && result.events.at(-1).outcome === 'ok');
    t.ok('開始応答より前の準備中の通知も一覧に残る', result.events.some(e => e.type === 'cwd' && e.cwd === 'prepared-directory'));
    const immediate = await stub.runTurn({ sessionId: 'same-session', prompt: 'immediate' }, { ms: 1000 });
    t.ok('開始応答と同じ受信バッチの今回の終了を取りこぼさない', immediate.outcome === 'ok' && immediate.events.at(-1)?.type === 'turnEnd' && immediate.events.at(-1).outcome === 'ok');
  } finally {
    stub?.terminate(); await new Promise(resolve => wss.close(resolve));
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-runturn-'));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(scratch, 'data') });
  const c = await open(server);
  try {
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'hello' });
    const other = first.sessionId;
    t.ok('新しい会話の ID を返す', typeof other === 'string' && other.length > 0, String(other));

    // 裏の会話（other）で終わらないターンを走らせておく
    let from = c.mark();
    await c.cmd('runTurn', { sessionId: other, prompt: 'slow' });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === other, { from, ms: 5000 });

    // 新しい会話を始め、その session が来てから裏の会話を止める。裏の turnEnd は新しい会話のターンの途中に届く
    from = c.mark();
    let returned = null;
    const running = c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'slow' }, { ms: 20000 }).then(r => { returned = r; return r; });
    const own = (await c.waitFor(e => e.type === 'session' && e.sessionId && e.sessionId !== other, { from, ms: 5000 })).sessionId;
    await c.cmd('abort', { sessionId: other });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === other, { from, ms: 5000 });
    await sleep(200);
    t.ok('裏の会話の turnEnd では返らない', returned === null, JSON.stringify(returned && { sessionId: returned.sessionId, outcome: returned.outcome }));

    await c.cmd('abort', { sessionId: own });
    const result = await running;
    t.ok('自分の会話の ID を返す', result.sessionId === own, `${result.sessionId} / ${own}`);
    t.ok('自分の会話の turnEnd まで待つ', result.events.some(e => e.type === 'turnEnd' && e.sessionId === own));
    t.ok('結果は自分の会話のもの', result.outcome === 'aborted', String(result.outcome));

    // 続きの会話（sessionId を渡す）も、その会話の turnEnd で返る
    const again = await c.runTurn({ sessionId: other, prompt: 'hello again' });
    t.ok('既存の会話では渡した ID を返す', again.sessionId === other && again.outcome === 'ok', `${again.sessionId} ${again.outcome}`);
  } finally {
    c.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
