// ply_delegate の model の扱い（core/server.mjs の prepare / canonicalModel）。fake でサーバー全体を通す。LLM は呼ばない
//   - 一覧の id はそのまま
//   - 正式な ID（backend が matchModel で一覧の id に当てるもの）は当てはめて走る
//   - 当たらない名前は、黙って既定に戻さず model_unknown で断る（選べる名前を添える）。子の会話もタスクも作らない
//   - model を書かなければ今までどおり既定
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-model-name';
export const title = 'ply_delegate の model: 正式な ID は一覧に当て、当たらない名前は既定に戻さず断る';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-delegation-model-name-'));
  // 一覧をファイルから読ませ、models() の呼び出しを <file>.calls に記録させる
  // （正式な ID の読み替えで、取り直し（{ refresh }）が走らないことを確かめる）
  const modelsFile = path.join(scratch, 'fake-models.json');
  const same = { fast: {}, smart: {}, tiny: {} };
  fss.writeFileSync(modelsFile, JSON.stringify({ normal: same, refreshed: same }));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_MODELS: modelsFile } });
  const c = await open({ port: server.port, token: server.token });
  const call = async (sessionId, name, args) => {
    const from = c.mark();
    await c.runTurn({ sessionId, prompt: prompt(name, args) });
    const ev = await c.waitFor(e => e.type === 'tool.result' && e.sessionId === sessionId, { from, ms: 60000 });
    return ev.isError ? { error: ev.text } : JSON.parse(ev.text);
  };
  const tasks = async () => c.cmd('agentTasks');
  const taskOf = async taskId => {
    for (let i = 0; i < 200; i++) { const r = (await tasks()).find(x => x.taskId === taskId); if (r) return r; await sleep(50); }
    return null;
  };
  let parent;
  // 依頼元へ完了通知が届き、依頼元のターンが終わるまで待つ（その間に依頼元で次のターンを始めない）
  const settle = async taskId => {
    for (let i = 0; i < 1200; i++) {
      const r = (await tasks()).find(x => x.taskId === taskId);
      if (r && !['queued', 'running', 'cancelling'].includes(r.status) && !['none', 'pending', 'delivering'].includes(r.notification)) break;
      await sleep(50);
    }
    for (let i = 0; i < 200 && (await c.cmd('running')).turns.some(x => x.sessionId === parent); i++) await sleep(50);
  };
  try {
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', model: 'fast', task: 'echo:A' }) });
    parent = first.sessionId;
    const plain = JSON.parse(first.events.find(e => e.type === 'tool.result').text);
    t.ok('一覧の id はそのまま子のモデルになる', (await taskOf(plain.taskId))?.model === 'fast');
    await settle(plain.taskId);

    const callsBefore = fss.existsSync(`${modelsFile}.calls`) ? fss.readFileSync(`${modelsFile}.calls`, 'utf8') : '';
    const official = await call(parent, 'ply_delegate', { kind: 'mechanical', backend: 'fake', model: 'fake-smart-3-5', task: 'echo:B' });
    const officialTask = official.taskId ? await taskOf(official.taskId) : null;
    t.ok('正式な ID は一覧の id に当てて走る（既定には落ちない）', !official.error && officialTask?.model === 'smart', JSON.stringify(official).slice(0, 300));
    if (official.taskId) await settle(official.taskId);
    // canonicalModel は手元の一覧と matchModel で先に当てるので、正式な ID の読み替えで取り直し（models({ refresh })）は走らない
    const callsAfter = fss.existsSync(`${modelsFile}.calls`) ? fss.readFileSync(`${modelsFile}.calls`, 'utf8') : '';
    t.ok('正式な ID の読み替えで取り直し（{ refresh }）は走らない',
      !callsAfter.slice(callsBefore.length).includes('refresh'), callsAfter.slice(callsBefore.length).trim().split('\n').join(',') || '(無し)');

    const before = (await tasks()).length;
    const unknown = await call(parent, 'ply_delegate', { kind: 'mechanical', backend: 'fake', model: 'no-such-model', task: 'echo:C' });
    t.ok('当たらない名前は model_unknown で断り、選べる名前を添える', String(unknown.error ?? '').includes('model_unknown') && String(unknown.error).includes('no-such-model')
      && ['fast', 'smart', 'tiny'].every(m => String(unknown.error).includes(m)), unknown.error);
    t.ok('断ったときは子のタスクを作らない', (await tasks()).length === before);

    const unset = await call(parent, 'ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:D' });
    const unsetTask = await taskOf(unset.taskId);
    await settle(unset.taskId);
    t.ok('model を書かなければ今までどおり既定（空）', !unset.error && (unsetTask?.model ?? '') === '', JSON.stringify(unsetTask?.model));
  } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
}
