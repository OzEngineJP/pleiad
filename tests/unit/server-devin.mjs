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
    const sessionAt = first.events.findIndex(e => e.type === 'session'), thinkAt = first.events.findIndex(e => e.type === 'activity' && e.state === 'thinking'), textAt = first.events.findIndex(e => e.type === 'text.delta');
    t.ok('送ってから最初の応答まで稼働表示が出る（送信準備中→考えている）',
      first.events.find(e => e.type === 'activity')?.state === 'preparing' && sessionAt > -1 && thinkAt > sessionAt && thinkAt < textAt);
    const before = structuredClone(loaded.messages);
    const next = await c.runTurn({ sessionId: sid, prompt: 'beta', model: 'swe-2-max', mode: 'ask' });
    const nextStates = next.events.filter(e => e.type === 'activity').map(e => e.state);
    t.ok('再開の送信でも同じ順で出す', nextStates[0] === 'preparing' && nextStates.includes('thinking'));
    const after = await c.cmd('loadSession', { sessionId: sid });
    t.ok('再開時の replay を重複させず前の UUID を保つ', next.outcome === 'ok' && after.messages.filter(m => m.role === 'user').length === 2 && before.every((m, i) => after.messages[i].uuid === m.uuid));
    const compactFrom = c.mark();
    const compactResult = await c.cmd('compactConversation', { sessionId: sid });
    const compactDone = await c.waitFor(e => e.type === 'compaction' && e.sessionId === sid && e.phase === 'complete', { from: compactFrom, ms: 20_000 });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sid, { from: compactFrom, ms: 20_000 });
    const afterCompact = await c.cmd('loadSession', { sessionId: sid });
    t.ok('/compact を送って手動圧縮が完了し、前後の文脈量を持つ',
      compactResult.status === 'started' && compactDone.trigger === 'manual'
      && compactDone.beforeTokens > compactDone.afterTokens
      && afterCompact.compactions?.some(x => x.phase === 'complete')
      && afterCompact.messages.filter(m => m.role === 'user').length === 2, JSON.stringify(compactDone));
    const editId = (await c.cmd('newSession', { backend: 'devin', cwd })).sessionId;
    const edit = await c.runTurn({ sessionId: editId, prompt: '[large-edit]', model: 'swe-2-high' });
    const edited = await c.cmd('loadSession', { sessionId: editId });
    const editCall = edited.messages.flatMap(m => m.toolCalls ?? []).find(call => call.name === 'Edit file');
    assert.equal(edit.outcome, 'ok');
    assert.equal(editCall.input.file_path, 'large.mjs');
    assert.ok(editCall.input.oldText.includes('before'));
    assert.ok(JSON.stringify(edited.messages).length < 80000);
    const resumedEdit = await c.runTurn({ sessionId: editId, prompt: 'after large edit', model: 'swe-2-high' });
    assert.equal(resumedEdit.outcome, 'ok');
    t.ok('巨大 Edit を保存し、その再生を通って次のプロンプトを送信できる', true);
    const env = await c.runTurn({ backend: 'devin', cwd: other, prompt: '[env]', model: 'swe-2-high' });
    const text = env.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    const observed = JSON.parse(text);
    t.ok('別 cwd は別プロセスで起動し native 設定の場所を保つ', observed.cwd === other && observed.configHome === nativeConfig);
    // ply_control は ACP の mcpServers（type: 'http'）と会話束縛の CLI の env で届く（印 plyControl。ブラウザーは Chrome の層が無い試験では渡らない）
    t.ok('ply_control を mcpServers で渡し、会話束縛の CLI の環境変数が届く', observed.mcpServers?.includes('ply_control') && observed.seenEnv?.includes('PLEIAD_CONTROL_URL') && observed.seenEnv?.includes('PLEIAD_CONTROL_TOKEN'), JSON.stringify({ mcpServers: observed.mcpServers, seenEnv: observed.seenEnv }));
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
    // ---- 途中送信（走っている回へ session/prompt を重ねると、同じ回に折り込まれて届く）
    const sm = c.mark();
    const holding = c.runTurn({ backend: 'devin', cwd, prompt: '[slow] first', model: 'swe-2-high' });
    const steerSession = await c.waitFor(e => e.type === 'session' && e.first === true, { ms: 10000, from: sm });
    await c.cmd('sendMessage', { sessionId: steerSession.sessionId, messageId: 'devin-steer-0001', prompt: 'steer-note' });
    const held = await holding;
    const heldText = held.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    const umEvents = c.since(sm);
    t.ok('途中送信が同じ回に折り込まれて答えられ、発言の行が出て turnResult は一度だけ',
      heldText.includes('fixture: steer-note')
      && umEvents.some(e => e.type === 'userMessage' && e.messageId === 'devin-steer-0001')
      && held.events.filter(e => e.type === 'turnResult').length === 1 && held.outcome === 'ok', heldText);
    t.ok('受理した発言は pending で出し、呼び出しの決着で userMessage.delivered が届く',
      umEvents.find(e => e.type === 'userMessage' && e.messageId === 'devin-steer-0001')?.pending === true
      && umEvents.some(e => e.type === 'userMessage.delivered' && e.messageId === 'devin-steer-0001'), JSON.stringify(umEvents.filter(e => e.messageId === 'devin-steer-0001')));
    c.close(); c = null;
    await server.stop(); server = null;
    const conversationDir = path.join(root, 'data', 'conversations');
    const saved = await Promise.all((await fs.readdir(conversationDir)).filter(name => name.endsWith('.json'))
      .map(async name => JSON.parse(await fs.readFile(path.join(conversationDir, name), 'utf8'))));
    const storedEdit = saved.find(record => record.messages.some(m => m.toolCalls?.some(call => call.id === editCall.id)));
    assert.ok(storedEdit);
    const storedCall = storedEdit.messages.flatMap(m => m.toolCalls ?? []).find(call => call.name === 'Edit file');
    assert.ok(JSON.stringify(storedEdit).length < 80000);
    assert.ok(storedCall.input.oldText.includes('before') && storedCall.input.newText.includes('after'));
    t.ok('保存された会話ファイルにも巨大 diff の全文を残さない', true);
    server = await startServer({ dataDir: path.join(root, 'data'), env: { AGENT_HOST_BACKENDS: 'devin', AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`, DEVIN_CONFIG_HOME: nativeConfig } });
    c = await open(server);
    const restored = await c.cmd('loadSession', { sessionId: sid });
    t.ok('サーバー再起動後も共通 DB の cwd でネイティブ履歴を復元する', restored.messages.filter(m => m.role === 'user').length === 2 && after.messages.every((m, i) => restored.messages[i].uuid === m.uuid), JSON.stringify({ before: after.messages.map(m => [m.uuid, m.role]), restored: restored.messages.map(m => [m.uuid, m.role]) }));

    const restoredEdit = await c.cmd('loadSession', { sessionId: editId });
    assert.ok(JSON.stringify(restoredEdit.messages).length < 80000);
    assert.ok(restoredEdit.messages.flatMap(m => m.toolCalls ?? []).find(call => call.name === 'Edit file').input.newText.includes('after'));
    t.ok('再起動後も復元するツールの入力は縮小済み', true);

    const catalogue = async () => ({ families: [{ family_uid: 'swe-2', variants: [{ model_uid: 'swe-2-high', cost_tier: 'Free' }] }] });
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

    for (const drift of ['after-mode', 'after-config-mode', 'after-model', 'before-mode', 'after-empty', 'after-duplicate', 'before-recovered', 'after-recovered']) {
      class SetupDrift extends DevinAcp { constructor(options) { super({ ...options, env: { ...options.env, FAKE_DEVIN_SETUP_DRIFT: drift } }); } }
      const dataDir = path.join(root, drift), updates = [];
      const guarded = createDevinBackend({ Acp: SetupDrift, catalogue, command, dataDir });
      let delivered = false;
      const turn = guarded.runTurn({ cwd, prompt: 'must use ask and SWE-2 High', model: 'swe-2-high', mode: 'ask', emit: event => updates.push(event), onPromptDelivered: () => { delivered = true; } });
      const recovered = drift.endsWith('recovered');
      if (recovered) await turn; else await assert.rejects(turn);
      const nativeDir = path.join(dataDir, 'devin', 'sessions');
      const [file] = await fs.readdir(nativeDir);
      const saved = JSON.parse(await fs.readFile(path.join(nativeDir, file), 'utf8'));
      t.ok(`最終 ACK 前後の同一 batch の最新設定で prompt の送信を判断する（${drift}）`,
        delivered === recovered && updates.find(event => event.type === 'turnResult').outcome === (recovered ? 'ok' : 'error') && saved.messages.filter(message => message.role === 'user').length === (recovered ? 1 : 0));
    }
    for (const kind of ['permission-id-only', 'permission-partial', 'permission-null', 'permission-unknown']) {
      const requests = [], decisions = [];
      class PermissionClient extends DevinAcp {
        constructor(options) {
          super({ ...options, onResponse: response => { options.onResponse(response); if (response.method === 'session/prompt') decisions.push(response.result.permissionResult); } });
        }
      }
      const permissionBackend = createDevinBackend({ Acp: PermissionClient, catalogue, command, dataDir: path.join(root, kind) });
      await permissionBackend.runTurn({ cwd, prompt: `[${kind}]`, model: 'swe-2-high', emit() {}, askPermission: request => { requests.push(request); return { allow: false }; } });
      assert.deepEqual(decisions, [{ outcome: { outcome: 'selected', optionId: 'reject_once' } }]);
      if (kind === 'permission-unknown') assert.equal(requests.length, 0);
      else {
        assert.equal(requests.length, 1);
        assert.equal(requests[0].toolName, kind === 'permission-partial' ? 'Updated permission' : 'Fixture permission');
        assert.deepEqual(requests[0].input, { command: 'echo fixture' });
      }
      t.ok(`承認要求は既知の詳細を非 null patch と統合し、不明操作は拒否する（${kind}）`, true);
    }
  } finally { c?.close(); await server?.stop(); await fs.rm(root, { recursive: true, force: true }); }
}
