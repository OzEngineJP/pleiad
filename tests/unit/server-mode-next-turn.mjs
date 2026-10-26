// 承認モード・モデルの途中切り替えに対応しないエージェント（能力の印 liveMode・liveModel が対応でない。fake を FAKE_LIVE=off で起動）
// で、走っている最中に替えたときの届き方（#147）。
//   - 今のターンは前のモード・モデルのまま走る。会話の mode・model は変えず、次のターンへの予約（nextSettings）にする
//   - 予約は「次のターンから適用」の帯の元（画面は nextSettings の変化で帯を出す）
//   - 次のターンが始まったら予約は使われて消え、会話の mode・model になる
//   - 走っていなければ今までどおり会話の mode・model を替える
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-mode-next-turn';
export const title = '途中切り替えに対応しないエージェントの承認モード: 走っている間の変更は次のターンへの予約になる';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-mode-next-')));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', FAKE_LIVE: 'off' }, dataDir, timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token });
  try {
    const session = (id) => c.cmd('listSessions').then((rows) => (rows ?? []).find((x) => x.id === id));

    // ---- 走っているターンの間: 予約になり、会話の mode は変わらない
    const turn = await c.runTurn({ prompt: 'control-info', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
    const id = turn.sessionId;
    const from = c.mark();
    const slow = c.runTurn({ prompt: 'slow', sessionId: id }, { ms: 30_000 });
    await c.waitFor((e) => e.type === 'running' || (e.type === 'session' && e.sessionId === id), { from, ms: 15_000 }).catch(() => null);
    await sleep(300);

    const changed = c.cmd('setMode', { sessionId: id, mode: 'auto' });
    const nextEv = await c.waitFor((e) => e.type === 'nextSettings' && e.sessionId === id && e.nextSettings?.mode === 'auto', { from, ms: 15_000 });
    const reply = await changed;
    t.ok('setMode は live:false で返る', reply?.live === false, JSON.stringify(reply));
    t.ok('次のターンへの予約（nextSettings.mode）が届く', nextEv.nextSettings.mode === 'auto');
    await sleep(300);
    const mid = await session(id);
    t.ok('走っている間は会話の mode は前のまま（チップの値だけ先に変えない）', mid?.mode === 'default', JSON.stringify(mid?.mode));

    // ---- 次のターンで予約が使われ、会話の mode になる
    await c.cmd('abort', { sessionId: id });
    await slow.catch(() => {});
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === id, { from, ms: 15_000 }).catch(() => null);
    const queued = await session(id);
    t.ok('止めたあとも予約は残る（次のターンへ持ち越す）', queued?.nextSettings?.mode === 'auto', JSON.stringify(queued?.nextSettings));

    const nextFrom = c.mark();
    await c.runTurn({ prompt: 'control-info', sessionId: id }, { ms: 30_000 });
    const done = await session(id);
    t.ok('次のターンが始まると予約が使われて消え、会話の mode になる',
      done?.mode === 'auto' && !done?.nextSettings?.mode, JSON.stringify({ mode: done?.mode, nextSettings: done?.nextSettings }));
    const cleared = c.since(nextFrom).some((e) => e.type === 'nextSettings' && e.sessionId === id && e.nextSettings === null);
    t.ok('予約が消えたことも届く（帯を畳む）', cleared);

    // ---- 走っていなければ今までどおり会話の mode を替える
    const idle = await c.cmd('setMode', { sessionId: id, mode: 'plan' });
    await sleep(300);
    const idleNow = await session(id);
    t.ok('走っていない変更は予約にならず、そのまま会話の mode になる', idle?.live === false && idleNow?.mode === 'plan' && !idleNow?.nextSettings, JSON.stringify({ reply: idle, mode: idleNow?.mode }));

    // ---- モデルも同じ（liveModel が対応でなければ予約。画面のモデル切り替えは setTurnSettings だが、
    //      AI・CLI の sessions.setModel が走っている最中に来ても、見た目だけ先に変えない）
    const modelFrom = c.mark();
    const slow2 = c.runTurn({ prompt: 'slow', sessionId: id }, { ms: 30_000 });
    await c.waitFor((e) => e.type === 'running' && e.sessionId === id, { from: modelFrom, ms: 15_000 }).catch(() => null);
    await sleep(300);
    const modelChanged = c.cmd('setModel', { sessionId: id, model: 'smart' });
    const modelNext = await c.waitFor((e) => e.type === 'nextSettings' && e.sessionId === id && e.nextSettings?.model === 'smart', { from: modelFrom, ms: 15_000 }).catch(() => null);
    const modelReply = await modelChanged;
    t.ok('モデルも live:false で返り、次のターンへの予約になる', modelReply?.live === false && modelNext?.nextSettings?.model === 'smart', JSON.stringify({ reply: modelReply, next: modelNext?.nextSettings }));
    await sleep(300);
    const midModel = await session(id);
    t.ok('走っている間は会話の model も前のまま', (midModel?.model ?? '') === '', JSON.stringify(midModel?.model));
    await c.cmd('abort', { sessionId: id });
    await slow2.catch(() => {});
    await c.runTurn({ prompt: 'control-info', sessionId: id }, { ms: 30_000 });
    const doneModel = await session(id);
    t.ok('次のターンでモデルの予約も使われて消える', doneModel?.model === 'smart' && !doneModel?.nextSettings?.model, JSON.stringify({ model: doneModel?.model, nextSettings: doneModel?.nextSettings }));
  } finally {
    c?.close?.();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
