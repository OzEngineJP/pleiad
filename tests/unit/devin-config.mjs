import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareDevinLaunch, METADATA_CONFIG } from '../../core/backends/devin-config.mjs';

export const name = 'devin-config';
export const title = 'Devin native 設定と認証を保ち、metadata と専用セッションの置き場を分ける';
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-devin-config-'));
  try {
    const cwd = path.join(root, 'project'), configHome = path.join(root, 'user-config');
    await fs.mkdir(cwd); await fs.mkdir(configHome);
    const file = path.join(configHome, 'keep.json'); await fs.writeFile(file, 'native sentinel');
    const env = { DEVIN_CONFIG_HOME: configHome, WINDSURF_API_KEY: 'fake-key', DEVIN_MODEL: 'user-choice', CUSTOM: 'keep' };
    const native = await prepareDevinLaunch({ command: ['fake', '--user-flag'], cwd, env, dataDir: root });
    assert.deepEqual(native.command, ['fake', '--user-flag']);
    assert.equal(native.env.DEVIN_CONFIG_HOME, configHome); assert.equal(native.env.WINDSURF_API_KEY, 'fake-key');
    assert.equal(native.env.CUSTOM, 'keep'); assert.equal(native.cwd, cwd);
    t.ok('通常の会話は user 設定・既存認証・追加引数をそのまま保つ', true);
    const meta = await prepareDevinLaunch({ command: ['fake'], cwd, env, dataDir: root, metadata: true });
    const config = JSON.parse(await fs.readFile(meta.command[2], 'utf8'));
    assert.deepEqual(config, METADATA_CONFIG);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(meta.command[2]), 'mcp_config.json'), 'utf8')), { mcpServers: {} });
    t.ok('metadata は固定の小さな設定・空 MCP と専用 cwd に隔離する', meta.cwd !== cwd && meta.env.DEVIN_CONFIG_HOME !== configHome && Object.values(config.read_config_from).every(v => v === false));
    t.ok('通常セッションと metadata セッションは別の内部領域を使う', native.env.DEVIN_SESSIONS_DIR !== meta.env.DEVIN_SESSIONS_DIR && native.env.DEVIN_SESSIONS_DIR.startsWith(root));
    assert.equal(await fs.readFile(file, 'utf8'), 'native sentinel');
    assert.deepEqual(await fs.readdir(configHome), ['keep.json']);
    t.ok('user 設定も資格情報もコピー・上書きしない', true);
    t.ok('入力の env と command を書き換えない', env.DEVIN_CONFIG_HOME === configHome && !Object.hasOwn(env, 'DEVIN_SESSIONS_DIR'));
    if (process.platform !== 'win32') t.ok('内部 metadata 設定は所有者だけ読み書きできる', ((await fs.stat(meta.command[2])).mode & 0o777) === 0o600);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
