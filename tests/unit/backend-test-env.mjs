// 実 CLI を利用できる親環境を真似ても、Devin の試験は利用者の設定・資格情報へ届かない。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, startServer } from '../lib/server.mjs';

export const name = 'backend-test-env';
export const title = 'Devin の実 CLI・資格情報・設定・会話の置き場を試験から隔離する';

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-backend-env-'));
  try {
    const testEnv = pathToFileURL(path.join(ROOT, 'tests/lib/test-env.mjs')).href;
    const source = `await import(${JSON.stringify(testEnv)}); console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => /DEVIN|WINDSURF_API_KEY/i.test(key)))));`;
    const inherited = {
      AGENT_HOST_DATA: path.join(root, 'data'), AGENT_HOST_DEVIN_BIN: 'should-never-run',
      DEVIN_API_KEY: 'fake-inherited-key', DEVIN_CONFIG_HOME: path.join(root, 'inherited-config'),
      DEVIN_SESSIONS_DIR: path.join(root, 'inherited-sessions'), DEVIN_MODEL: 'inherited-model',
      WINDSURF_API_KEY: 'fake-inherited-windsurf-key',
    };
    const safe = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', source], {
      cwd: ROOT, env: { ...process.env, ...inherited }, timeout: 30_000,
    }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout.trim()))));
    t.ok('test-env は継承した実 CLI の指定・認証キー・モデルを外す', safe.AGENT_HOST_DEVIN_BIN === 'missing-pleiad-test-devin-cli' && !safe.DEVIN_API_KEY && !safe.WINDSURF_API_KEY && !safe.DEVIN_MODEL, JSON.stringify(Object.keys(safe)));
    t.ok('test-env の設定と会話は試験のデータ置き場に向く', safe.DEVIN_CONFIG_HOME === path.join(inherited.AGENT_HOST_DATA, 'devin-config') && safe.DEVIN_SESSIONS_DIR === path.join(inherited.AGENT_HOST_DATA, 'devin-sessions'));

    // 本物のサーバーの代わりに、startServer の環境だけを報告する HTTP サーバー。
    const entry = path.join(root, 'env-server.mjs');
    await fs.writeFile(entry, [
      "import http from 'node:http';",
      "const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /DEVIN|WINDSURF_API_KEY/i.test(key)));",
      "http.createServer((req, res) => { res.end(JSON.stringify(env)); }).listen(0, '127.0.0.1', function () { console.log('http://127.0.0.1:' + this.address().port + '/?token=fixture'); });",
    ].join('\n'));
    const saved = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, inherited);
      for (const explicit of [false, true]) {
        const serverData = path.join(root, explicit ? 'explicit' : 'default');
        const env = explicit ? { AGENT_HOST_DEVIN_BIN: 'fake-cli', DEVIN_API_KEY: 'fake-explicit-key' } : {};
        const server = await startServer({ entry, dataDir: serverData, env });
        try {
          const childEnv = await (await fetch(`http://127.0.0.1:${server.port}`)).json();
          if (!explicit) t.ok('startServer 単独でも継承した実 CLI・認証キー・モデルを外す', childEnv.AGENT_HOST_DEVIN_BIN === 'missing-pleiad-test-devin-cli' && !childEnv.DEVIN_API_KEY && !childEnv.WINDSURF_API_KEY && !childEnv.DEVIN_MODEL);
          else t.ok('試験が明示する身代わりと偽の認証キーは渡せる', childEnv.AGENT_HOST_DEVIN_BIN === 'fake-cli' && childEnv.DEVIN_API_KEY === 'fake-explicit-key');
          t.ok(`startServer の設定と会話は個別の一時領域に向く（${explicit ? 'explicit' : 'default'}）`, childEnv.DEVIN_CONFIG_HOME === path.join(serverData, 'devin-config') && childEnv.DEVIN_SESSIONS_DIR === path.join(serverData, 'devin-sessions'));
        } finally { await server.stop(); }
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
