// 状態のグループの名前替え・削除（renameStatus。core/server.mjs の renameStatusGroup）が、会話の数に関わらず全部の会話に届く。
// 状態を会話の側（tag）に持つエージェント（Claude と fake）は、ネイティブ一覧の上位 500 件に入らない古い会話にも tag が残る。
// それを取りこぼすと、削除したグループが、古い会話が動いた時（一覧の上位へ戻った時）に生き返る。
// fake に Pleiad の記録の無いネイティブの会話を 600 件置き（AGENT_HOST_FAKE_NATIVE_SESSIONS）、一番古いものにだけ消す状態を付けて確かめる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { readSessions } from '../lib/data-store.mjs';

export const name = 'server-status-rename-all';
export const title = '状態の名前替え・削除は、500 件より古い会話（会話の側の tag）にも届く';

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-rename-all-')));
  const dataDir = path.join(scratch, 'data');
  const seed = path.join(scratch, 'natives.json');
  const base = Date.now() - 86400000;
  // 新しい順に 0..599。一番古い old-599 と、上位の old-0 にだけ「古い器」が付いている
  const rows = Array.from({ length: 600 }, (_, i) => ({ sessionId: `old-${i}`, cwd: ROOT, title: `古い会話 ${i}`, lastModified: base - i * 1000,
    tag: i === 0 || i === 599 ? '古い器' : null }));
  await fs.writeFile(seed, JSON.stringify(rows));
  const server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_NATIVE_SESSIONS: seed }, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const before = await c.cmd('listSessions');
    t.ok('前提: 一番古い会話は一覧（上位の件数）に入らず、上位の会話は「古い器」で出る',
      !before.some((s) => s.id === 'old-599') && before.find((s) => s.id === 'old-0')?.status === '古い器', String(before.length));

    const renamed = await c.cmd('renameStatus', { from: '古い器', to: '新しい器' });
    t.ok('名前替えは 500 件より古い会話も数に入れる', renamed.moved === 2, JSON.stringify(renamed));
    t.ok('古い会話の記録にも新しい名前が残る', (await readSessions(dataDir))['old-599']?.status === '新しい器');

    const removed = await c.cmd('renameStatus', { from: '新しい器', to: '' });
    t.ok('削除も 500 件より古い会話まで外す', removed.moved === 2, JSON.stringify(removed));
    t.ok('古い会話の記録の状態も外れる', (await readSessions(dataDir))['old-599']?.status == null);

    // 古い会話が動いて一覧の上位へ戻っても、会話の側の tag から消したグループが生き返らない
    await c.runTurn({ sessionId: 'old-599', prompt: 'echo:また動いた' });
    const row = (await c.cmd('listSessions')).find((s) => s.id === 'old-599');
    t.ok('動いて上位に戻った古い会話は状態なしのまま（会話の側の tag も外れている）', row && row.status == null, JSON.stringify(row?.status));
    const groups = (await c.cmd('listStatuses')).filter((s) => s.kept).map((s) => s.status);
    t.ok('消したグループは器にも残らない', !groups.includes('古い器') && !groups.includes('新しい器'), groups.join());
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
