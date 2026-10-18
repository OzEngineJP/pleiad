import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';
import { createDevinBackend } from '../../core/backends/devin.mjs';

export const name = 'server-devin';
export const title = 'Devin: fake ACP でターン・再開・履歴・承認・中断・設定変更の拒否・cwd と native 設定の保持';
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-server-devin-'));
  const cwd = path.join(root, 'project'), other = path.join(root, 'other'), nativeConfig = path.join(root, 'native-config');
  await Promise.all([cwd, other, nativeConfig].map(p => fs.mkdir(p)));
  let server, c;
  const permissions = [];
  try {
    server = await startServer({ dataDir: path.join(root, 'data'), env: { AGENT_HOST_BACKENDS: 'devin', AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`, DEVIN_CONFIG_HOME: nativeConfig } });
    c = await open({ port: server.port, token: server.token, onEvent: async (e, self) => { if (e.type === 'permission') { permissions.push(e); await self.cmd('resolvePermission', { id: e.id, allow: false }); } } });
    const models = await c.cmd('models', { backend: 'devin', cwd });
    t.ok('ライブカタログの無料既定と有料候補を返す', models[''].resolvesTo === 'swe-2-high' && models['paid-exact']);
    const backends = await c.cmd('backends');
    t.ok('未実装機能を表示せず、思考は variant ID で選ぶ', backends[0].capabilities.plyContext === false && !backends[0].capabilities.accounts && backends[0].capabilities.effortInModelId && backends[0].capabilities.approvals === 'interactive');
    const first = await c.runTurn({ backend: 'devin', cwd, prompt: '[permission] alpha', model: 'swe-2-medium', mode: 'accept-edits' });
    const sid = first.sessionId, loaded = await c.cmd('loadSession', { sessionId: sid });
    t.ok('承認を Pleiad に渡し、本文・思考・ツールの結果を保存する', first.outcome === 'ok' && permissions.length === 1 && loaded.messages.some(m => m.role === 'assistant' && m.thinking && m.toolCalls?.length));
    const before = structuredClone(loaded.messages);
    const next = await c.runTurn({ sessionId: sid, prompt: 'beta', model: 'swe-2-max', mode: 'ask' });
    const after = await c.cmd('loadSession', { sessionId: sid });
    t.ok('再開時の replay を重複させず前の UUID を保つ', next.outcome === 'ok' && after.messages.filter(m => m.role === 'user').length === 2 && before.every((m, i) => after.messages[i].uuid === m.uuid));
    const env = await c.runTurn({ backend: 'devin', cwd: other, prompt: '[env]', model: 'swe-2-high' });
    const text = env.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    const observed = JSON.parse(text);
    t.ok('別 cwd は別プロセスで起動し native 設定の場所を保つ', observed.cwd === other && observed.configHome === nativeConfig);
    for (const marker of ['model', 'thought_level', 'speed', 'mode']) {
      const turn = await c.runTurn({ backend: 'devin', cwd, prompt: `[${marker}-drift]`, model: 'swe-2-high' });
      t.ok(`実行中の確認済み設定の変更を拒否する（${marker}）`, turn.outcome === 'error');
    }
    const valid = await c.runTurn({ backend: 'devin', cwd, prompt: '[config-valid]', model: 'swe-2-high' });
    t.ok('完全な同一設定の通知は受け入れる', valid.outcome === 'ok');
    for (const marker of ['config-empty', 'config-invalid', ...['mode', 'model', 'thought_level', 'speed'].flatMap(kind => ['missing', 'duplicate', 'renamed'].map(fault => `${kind}-${fault}`))]) {
      const turn = await c.runTurn({ backend: 'devin', cwd, prompt: `[${marker}]`, model: 'swe-2-high' });
      t.ok(`必須設定の不完全な通知を拒否する（${marker}）`, turn.outcome === 'error' && turn.events.filter(e => e.type === 'turnResult').length === 1);
    }
    const dead = await c.runTurn({ backend: 'devin', cwd, prompt: '[kill]', model: 'swe-2-high' });
    t.ok('CLI の終了を失敗として一度だけ確定する', dead.outcome === 'error' && dead.events.filter(e => e.type === 'turnResult').length === 1);
    const from = c.mark();
    const running = c.runTurn({ backend: 'devin', cwd, prompt: '[slow]', model: 'swe-2-high' });
    const active = await c.waitFor(e => e.type === 'session' && e.first === true, { ms: 10000, from });
    await c.cmd('abort', { sessionId: active.sessionId });
    const stopped = await running;
    t.ok('中断は cancel 通知で完了し turnResult は一度だけ', stopped.outcome === 'aborted' && stopped.events.filter(e => e.type === 'turnResult').length === 1);
    c.close(); c = null;
    await server.stop(); server = null;
    server = await startServer({ dataDir: path.join(root, 'data'), env: { AGENT_HOST_BACKENDS: 'devin', AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`, DEVIN_CONFIG_HOME: nativeConfig } });
    c = await open(server);
    const restored = await c.cmd('loadSession', { sessionId: sid });
    t.ok('サーバー再起動後も共通 DB の cwd でネイティブ履歴を復元する', restored.messages.filter(m => m.role === 'user').length === 2 && after.messages.every((m, i) => restored.messages[i].uuid === m.uuid), JSON.stringify({ before: after.messages.map(m => [m.uuid, m.role]), restored: restored.messages.map(m => [m.uuid, m.role]) }));

    const catalogue = async () => ({ data: { families: [{ family_uid: 'swe-2', variants: [{ model_uid: 'swe-2-high', cost_tier: 'Free' }] }] } });
    const command = () => [process.execPath, path.join(ROOT, 'tests/lib/fake-devin.mjs')];
    class CloseFailure extends DevinAcp { async close() { await super.close(); throw new Error('fixture close failed'); } }
    const events = [];
    const backend = createDevinBackend({ Acp: CloseFailure, catalogue, command, dataDir: path.join(root, 'close-data') });
    await assert.rejects(backend.runTurn({ cwd, prompt: 'done', model: 'swe-2-high', emit: e => events.push(e) }), /fixture close failed/);
    t.ok('close の失敗を成功にせず、一度だけ失敗として返す', events.filter(e => e.type === 'turnResult').length === 1 && events.find(e => e.type === 'turnResult').outcome === 'error' && events.find(e => e.type === 'turnResult').error.includes('fixture close failed'));
    t.ok('使用量の取得日時は不明を明示する', (await backend.usage()).checkedAt === null);

    const bounded = createDevinBackend({ catalogue, command, dataDir: path.join(root, 'bounded-data'), cancelGraceMs: 100 });
    const signal = new AbortController(), cancelled = [], started = Date.now();
    await bounded.runTurn({ cwd, prompt: '[stubborn]', model: 'swe-2-high', signal, emit: e => cancelled.push(e), onPromptDelivered: () => setTimeout(() => signal.abort(), 50) });
    t.ok('cancel に応じない CLI も期限内に終了する', Date.now() - started < 5000 && cancelled.filter(e => e.type === 'turnResult').length === 1 && cancelled.find(e => e.type === 'turnResult').outcome === 'aborted');
  } finally { c?.close(); await server?.stop(); await fs.rm(root, { recursive: true, force: true }); }
}
