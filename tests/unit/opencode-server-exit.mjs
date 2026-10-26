import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpencodeServer } from '../../core/backends/opencode-server.mjs';

export const name = 'opencode-server-exit';
export const title = 'OpenCode の直接の子: 終了処理の共有・停止と子の終了での購読解除';

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-oc-exit-'));
  const started = path.join(dir, 'started.txt');
  const fake = fileURLToPath(new URL('../lib/fake-opencode.mjs', import.meta.url));
  const servers = [];
  const before = process.listenerCount('exit');
  const make = () => {
    const server = createOpencodeServer({ command: () => [process.execPath, fake],
      env: async () => ({ FAKE_OPENCODE_STARTED_FILE: started }),
      origin: async () => 'http://pleiad-test', currentOrigin: () => 'http://pleiad-test' });
    servers.push(server);
    return server;
  };
  try {
    for (let i = 0; i < 3; i++) {
      const server = make();
      await server.ensure();
      assert.equal(process.listenerCount('exit'), before + 1);
      await server.stop();
      assert.equal(process.listenerCount('exit'), before);
    }
    t.ok('専用のサーバーを繰り返し作って止めても終了処理の購読が残らない', true);

    const first = make(), second = make();
    await first.ensure();
    await second.ensure();
    assert.equal(process.listenerCount('exit'), before + 1);
    const gone = new Promise(resolve => second.onGone(resolve));
    const pid = Number((await fs.readFile(started, 'utf8')).trim().split('\n').at(-1));
    process.kill(pid);
    let timer;
    try { await Promise.race([gone, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OpenCode child did not exit')), 10_000); })]); }
    finally { clearTimeout(timer); }
    assert.equal(process.listenerCount('exit'), before + 1);
    await first.stop();
    assert.equal(process.listenerCount('exit'), before);
    t.ok('複数の子でも待ち受けは 1 本で、子の終了を検知した後と最後の停止で購読を外す', true);
  } finally {
    for (const server of servers) await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
