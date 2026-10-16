// 無停止の更新の引き継ぎが、委譲の完了通知で止まり続けない（本物の core/server.mjs。入口は tests/lib/adopt-server.mjs）。
// 子が終わる → 依頼元の会話が空いている → 完了通知で新しいターンが始まる。そのターンが続いている間（ゲートで止める）も:
//   1. 依頼元が通知を受け取った時点で記録は sent になり（引き継いだ後の書き込みに頼らない）、引き継ぎの「短い処理が終わっているか」は ok になる
//   2. ターンが続いている間も、終わった後も、通知を送り直さない（依頼元に通知の発言が 1 つだけ）
// （通知を受け取る前の短い間だけ ok にならない・待たせている会話を答える規則は tests/unit/agent-tasks-notice-accepted.mjs・handover-core.mjs）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readAgentTasks } from '../lib/data-store.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';

export const name = 'handover-notice';
export const title = '引き継ぎ: 委譲の完了通知で始まったターンが続いていても、通知を受け取った後は引き継げる（通知は送り直さない）';

const prompt = (toolName, args) => 'ply:' + JSON.stringify({ name: toolName, arguments: args });
const WAIT_MS = 30_000;
async function until(check, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-handover-notice-'));
  const dataDir = path.join(scratch, 'data');
  const scenesDir = path.join(scratch, 'scenes');
  await fs.mkdir(scenesDir);
  const gates = await createFakeGates(scratch);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', ADOPT_SCENES_DIR: scenesDir, ...gates.env }, dataDir,
    entry: path.join(ROOT, 'tests', 'lib', 'adopt-server.mjs') });
  const scene = async (sceneName, input = {}) => {
    const done = path.join(scenesDir, `${sceneName}.done`);
    await fs.writeFile(path.join(scenesDir, `${sceneName}.tmp`), JSON.stringify(input));
    await fs.rename(path.join(scenesDir, `${sceneName}.tmp`), path.join(scenesDir, `${sceneName}.go`));
    const text = await until(() => fs.readFile(done, 'utf8').catch(() => null), WAIT_MS, `場面 ${sceneName}`);
    await fs.rm(done);
    const out = JSON.parse(text);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  };
  const c = await open({ port: server.port, token: server.token, onEvent: async (ev, api) => {
    if (ev.type === 'permission') await api.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {});
  } });
  try {
    await scene('handoverSettled');   // 場面の入口が立つまで待つ
    // 子の結果に HOLD_TURN:<ゲート> を入れる。結果を載せた完了通知で始まる依頼元のターンは、ゲートが開くまで終わらない
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:HOLD_TURN:notice-turn' }) }, { ms: WAIT_MS });
    const owner = first.sessionId;
    const rows = () => Object.values(readAgentTasks(dataDir));
    await until(() => rows().length === 1 && rows()[0].notification === 'sent', WAIT_MS, '完了通知の受理（sent の保存）');
    const running = await until(async () => { const r = await c.cmd('running'); return r.turns.some(x => x.sessionId === owner) ? r : null; }, WAIT_MS, '通知で始まった依頼元のターン');
    t.ok('完了通知で依頼元の会話に新しいターンが始まり、続いている（ゲートで止めている）', running.turns.some(x => x.sessionId === owner));
    t.ok('通知を受け取った時点で記録は sent（ターンの終わりを待たない）', rows()[0].notification === 'sent' && rows()[0].parentSessionId === owner);
    const settled = await scene('handoverSettled');
    t.ok('通知で始まったターンが続いていても、引き継ぎの前の「短い処理」は終わっている', settled.ok === true && settled.detail === '' && settled.sessions.length === 0, JSON.stringify(settled));
    await sleep(1500);
    const noticeCount = async () => (await c.cmd('loadSession', { sessionId: owner })).messages.filter(m => m.role === 'user' && !String(m.text).startsWith('ply:') && String(m.text).includes('HOLD_TURN:notice-turn')).length;
    t.ok('ターンが続いている間に通知を送り直さない（通知の発言は 1 つ）', await noticeCount() === 1);
    await gates.open('notice-turn');
    await until(async () => !(await c.cmd('running')).turns.some(x => x.sessionId === owner), WAIT_MS, '通知のターンの終わり');
    await sleep(1500);
    t.ok('ターンが終わった後も通知を送り直さず、sent のまま', await noticeCount() === 1 && rows()[0].notification === 'sent');
    t.ok('終わった後も引き継げる', (await scene('handoverSettled')).ok === true);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
