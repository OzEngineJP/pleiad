// 全バックエンドの共通の契約を、エージェントごとの身代わり（LLM を呼ばない）で動かして確かめる（tests/lib/backend-contracts.mjs の checkConformance）。
// エージェントの記述（core/backends/agents.mjs）の全部を回す。試験のサーバーは、バックエンドが出したイベントも契約に照らす（tests/lib/server.mjs の stop）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { AGENTS } from '../../core/backends/agents.mjs';
import { RIGS, checkConformance } from '../lib/backend-contracts.mjs';

export const name = 'backend-conformance';
export const title = '全バックエンドの共通の契約（1 ターン・履歴の形と uuid・続き・タイトル・分岐・イベントの形）を身代わりで確かめる';

export default async function (t) {
  for (const id of Object.keys(AGENTS)) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `pleiad-conformance-${id}-`));
    const rig = await RIGS[id](scratch);
    const dataDir = path.join(scratch, 'data');
    const server = await startServer({ dataDir, env: rig.env, timeoutMs: 60_000 });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    let error = null;
    try {
      const backends = await c.cmd('backends');
      t.ok(`${id}: 有効になり、画面へ渡す記述（短い名前・ロゴ・圧縮の行）が付く`, backends.length === 1 && backends[0].id === id
        && 'shortLabel' in backends[0] && 'brand' in backends[0] && 'idleCompaction' in backends[0], JSON.stringify(backends[0] ?? null));
      await checkConformance(t, c, { id, cwd: ROOT, prompt: rig.prompt });
    } catch (e) {
      error = e;
    } finally {
      c.close();
      try { await server.stop(); } catch (e) { t.ok(`${id}: バックエンドのイベントが契約に外れない`, false, String(e.message)); }
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
    if (error) t.ok(`${id}: 共通の契約を最後まで確かめられる`, false, `${error.stack ?? error}\n${server.tail()}`);
  }
}
