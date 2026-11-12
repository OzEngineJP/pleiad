// 委譲の子へ人が直接送った発言の名札（あなた）の元になる欄（sentByHuman）が、そのターンの最初の発言でも、
// 走っている間に開き直した loadSession の返り値（live）に入っていること（ADR 0317・段 6-2）。
// 文字起こしが書かれる前の最初の発言は、進行中のターンの user（turn.stream.user）から返る。ここに欄が無いと、開き直したとき名札が変わる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'child-first-message-sender';
export const title = '委譲の子: 人が直接送った最初の発言の名札の元（sentByHuman）が、走っている間の開き直しでも返る';

export default async function (t) {
  await fs.mkdir(path.join(ROOT, 'temporary'), { recursive: true });
  const base = await fs.mkdtemp(path.join(ROOT, 'temporary', 'child-first-sender-'));
  const work = path.join(base, 'work');
  await fs.mkdir(work);
  let server, client;
  try {
    server = await startServer({ dataDir: path.join(base, 'data'), env: { AGENT_HOST_BACKENDS: 'fake' } });
    client = await open({ ...server });
    await client.cmd('authLogin', { backend: 'fake' });
    await client.cmd('completeSetup', { backend: 'fake' });

    const quick = path.join(base, 'quick.json');
    const slow = path.join(base, 'slow.json');
    await fs.writeFile(quick, JSON.stringify({ steps: [{ text: 'はじめます。' }] }));
    await fs.writeFile(slow, JSON.stringify({ steps: [{ text: 'はじめます。' }, ...Array.from({ length: 20 }, (_, i) => ({ tool: 'Bash', input: { command: `run ${i}` }, result: `out ${i}`, ms: 400 }))] }));

    const first = await client.runTurn({ backend: 'fake', cwd: work, prompt: 'echo:Sender' });
    const parent = first.sessionId;
    const ply = (n, args) => 'ply:' + JSON.stringify({ name: n, arguments: args });
    const mark = client.mark();
    for (let tries = 0; ; tries++) {
      try { await client.cmd('runTurn', { sessionId: parent, prompt: ply('ply_delegate', { backend: 'fake', kind: 'mechanical', title: '名札の子', task: `steps:@${quick}` }) }); break; }
      catch (error) { if (tries >= 80) throw error; await sleep(250); }
    }
    const res = await client.waitFor(e => e.sessionId === parent && e.type === 'tool.result', { from: mark, ms: 30_000 });
    const taskId = JSON.parse(res.text).taskId;
    const taskOf = async () => (await client.cmd('agentTasks')).find(r => r.taskId === taskId);
    const until = Date.now() + 60_000;
    while (Date.now() < until && !(await taskOf())?.sessionId) await sleep(150);
    const childId = (await taskOf()).sessionId;
    while (Date.now() < until && !['completed', 'failed', 'cancelled'].includes((await taskOf()).status)) await sleep(150);

    // 開き直しは、送る前から続けて読む（文字起こしが書かれる前の短い間を逃さない）。終わった子へ人が直接送る（新しいターンの最初の発言）のは画面の入力欄と同じ sendMessage
    // 見えた最初の発言が毎回「あなた」の元を持つことを見る（書かれる前は進行中のターンの user、書かれた後は履歴の台帳から返る。どちらの道でも同じ名札になる）
    const samples = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const data = await client.cmd('loadSession', { sessionId: childId, live: true });
        const user = (data.messages ?? []).findLast(m => m.role === 'user' && m.text.includes('slow.json'));
        if (user) samples.push({ live: Boolean(data.stream), pending: !user.uuid, sentByHuman: user.sentByHuman === true });
        await sleep(5);
      }
    })();
    await client.cmd('sendMessage', { sessionId: childId, messageId: 'human-first-0001', prompt: `steps:@${slow}` });
    await sleep(3_000);
    polling = false;
    await poller;
    t.ok('走っているターンの最初の発言が、開き直しの返り値にある', samples.length > 3 && samples.every(s => s.live), JSON.stringify(samples.slice(0, 3)));
    t.ok('どの開き直しでも、その発言に sentByHuman（あなたの名札の元）が付いている', samples.length > 0 && samples.every(s => s.sentByHuman), JSON.stringify(samples.filter(s => !s.sentByHuman).slice(0, 3)));
  } finally {
    client?.close();
    await server?.stop();
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
