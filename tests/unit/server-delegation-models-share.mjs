// 設定 › 委譲の画面が 1 回組み立てる routing 状態で、同じエージェントのモデル一覧は 1 回だけ引く。
// Devin の `devin models list` は起動に秒かかるので、候補ごとに取りに行くと画面がその回数だけ待つ。
// 置き場（TTL）の内は続けて組み立てても取り直さない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-delegation-models-share';
export const title = '委譲の画面の 1 回の組み立てで Devin のモデル一覧は 1 回だけ引く（TTL で続けても引かない）';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-routing-models-'));
  const log = path.join(scratch, 'devin.log');
  const server = await startServer({ dataDir: path.join(scratch, 'data'), env: {
    AGENT_HOST_BACKENDS: 'devin', AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`, FAKE_DEVIN_LOG: log,
  } });
  const c = await open({ port: server.port, token: server.token });
  const listCalls = async () => { try { return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(l => l === 'models').length; } catch { return 0; } };
  try {
    // 保存の応答自体が 1 回組み立てる（settings.set の shape = delegationRoutingState）
    const saved = await c.cmd('setDelegationRouting', { settings: { enabled: true, tiers: { t1: ['devin:swe-2-high', 'devin:glm-5-2'] } } });
    t.ok('候補ごとの強さの持ち方が届く', saved.candidates.filter(x => x.backend === 'devin').every(x => x.effort));
    t.ok('2 候補あっても 1 回の組み立てで `devin models list` は 1 回だけ起きる', await listCalls() === 1, String(await listCalls()));
    const state = await c.cmd('delegationRouting');
    t.ok('続けて組み立てても TTL の内は取り直さない', state.candidates.length > 0 && await listCalls() === 1, String(await listCalls()));
  } finally {
    c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true });
  }
}
