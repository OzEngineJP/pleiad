import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { createRemoteAgentService } from '../../core/remote/agent-service.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'managed-host';
export const title = '管理下ホストのバックエンド制限と利用者の PC への委譲';

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-managed-host-'));
  const secret = crypto.randomBytes(32).toString('base64url');
  const relay = createRelay({ enrollSecret: secret, trustProxy: false, logger: () => {} });
  const relayPort = (await relay.listen(0, '127.0.0.1')).port;
  const device = createRemoteDevice({ dir: path.join(dir, 'device'), app: 'test', name: 'cloud-test' });
  const cloudDir = path.join(dir, 'cloud');
  await fs.mkdir(cloudDir);
  await fs.writeFile(path.join(cloudDir, 'bots.json'), JSON.stringify({
    version: 1, bots: [{ id: 'old-bot', name: 'Old Bot', backend: 'fake', mode: 'ask' }],
  }));
  await fs.writeFile(path.join(cloudDir, 'routines.json'), JSON.stringify({
    version: 1, routines: [{ id: 'old-routine', name: 'Old Routine', botId: 'old-bot', channelId: 'old-channel',
      prompt: 'echo:unexpected', trigger: { kind: 'daily', at: '09:00' }, paused: true }],
  }));
  const pc = await startServer({ dataDir: path.join(dir, 'pc'), env: { AGENT_HOST_BACKENDS: 'fake' } });
  const cloud = await startServer({
    dataDir: cloudDir,
    env: { AGENT_HOST_KIND: 'cloud', AGENT_HOST_BACKENDS: 'fake,claude' },
    entry: path.join(ROOT, 'tests/lib/managed-host.mjs'),
    ipc: true,
    lazy: true,
  });
  const service = createRemoteAgentService({
    getDevice: async () => device,
    post: message => { if (cloud.child.connected) cloud.child.send(message, () => {}); },
  });
  cloud.child.on('message', service.handle);
  let cloudWs, pcWs;
  try {
    await cloud.ready();
    cloudWs = await open({ ...cloud, autoAllow: true });
    pcWs = await open(pc);
    const cmd = (command, args) => cloudWs.cmd(command, args);
    const invoke = (op, args) => cmd('invoke', { op, args });
    const denied = async (label, call) => {
      const error = await call.then(() => null, err => err);
      t.ok(label, error?.code === 'MANAGED_BACKEND_DENIED' && /fake|codex|claude/.test(error.message), error?.message);
    };
    t.ok('管理下ホストは環境変数の登録候補を無視し、画面に Pleiad Agent だけを返す',
      (await cmd('backends')).map(b => b.id).join() === 'pleiad-agent'
      && (await cmd('onboardingStatus')).agents.map(b => b.id).join() === 'pleiad-agent');
    t.ok('印の無い PC は従来どおり指定されたバックエンドで会話を作れる',
      (await pcWs.cmd('backends')).map(b => b.id).join() === 'fake'
      && Boolean((await pcWs.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId));
    const endpoints = await cmd('compatEndpoints', { agent: 'pleiad-agent' });
    t.ok('管理下ホストでは ChatGPT プランの接続先が出ない',
      endpoints.endpoints.every(e => e.kind !== 'chatgpt-plan'));
    const chatGptLogin = await cmd('chatGptConnection', { action: 'login' }).then(() => null, error => error);
    t.ok('管理下ホストで ChatGPT のログインを直接呼んでも拒否する', chatGptLogin?.code === 'host_only', chatGptLogin?.message);
    const chatGptRun = await cmd('runTurn', {
      backend: 'pleiad-agent', cwd: ROOT, endpoint: 'chatgpt-' + 'a'.repeat(32), prompt: 'must not run',
    }).then(() => null, error => error);
    t.ok('管理下ホストで保存済みの ChatGPT プランを指定しても実行を拒否する', Boolean(chatGptRun), chatGptRun?.message);
    const made = await cmd('newSession', { backend: 'pleiad-agent', cwd: ROOT });
    t.ok('管理下ホストは Pleiad Agent で会話を作れる', Boolean(made.sessionId));
    await denied('起動後に環境変数を消しても会話の作成を拒む', cmd('newSession', { backend: 'fake', cwd: ROOT }));
    await denied('runTurn で他社バックエンドを指定できない', cmd('runTurn', { backend: 'fake', cwd: ROOT, prompt: 'echo:unexpected' }));
    await denied('保存済みの他社バックエンドの会話を再開できない', cmd('resume', { sessionId: 'managed-test-old-session' }));
    await denied('会話を他社バックエンドへ引き継げない', cmd('switchBackend', { sessionId: made.sessionId, backend: 'fake' }));
    await denied('設定の既定を他社バックエンドに変更できない', cmd('setPref', { key: 'backend', value: 'fake' }));
    await denied('委譲ルーティングに他社バックエンドを追加できない', cmd('setDelegationRouting', { settings: { tiers: { t1: ['fake:fake-model'] } } }));
    const routing = await cmd('setDelegationRouting', { settings: { enabled: false } });
    t.ok('委譲ルーティングの画面から他社候補を除き、設定の更新はできる',
      Object.values(routing.settings.tiers).every(candidates => candidates.every(candidate => candidate.startsWith('pleiad-agent:'))));
    await denied('保存済みの他社バックエンドを使うルーティンを起動できない', invoke('routines.run', { routineId: 'old-routine' }));
    await denied('試しの実行も他社バックエンドを拒む', invoke('routines.run', { routineId: 'old-routine', dryRun: true }));
    await denied('操作の直接呼び出しでも他社バックエンドを拒む', invoke('agents.models', { backend: 'fake' }));
    await denied('他社バックエンドの MCP 設定を読めない', cmd('listMcpConfig', { format: 'codex', scope: 'user' }));
    await denied('他社バックエンドの MCP 設定を取り込めない', invoke('mcp.import', { items: [{ format: 'codex', scope: 'user', name: 'test' }] }));
    await denied('他社 CLI のログインを起動できない', cmd('claudeLoginStart', { kind: 'claude', name: 'Blocked' }));
    const delegate = async args => {
      const r = await cloudWs.runTurn({
        backend: 'pleiad-agent', cwd: ROOT,
        prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', task: 'echo:MANAGED_PC', ...args } }),
      }, { ms: 30_000 });
      return r.events.findLast(e => e.type === 'tool.result');
    };
    const local = await delegate({ backend: 'fake' });
    t.ok('MCP のローカル委譲は他社バックエンドを理由つきで拒む', local?.isError && /fake/.test(local.text), local?.text);
    const missing = await delegate({ host: 'missing-pc', backend: 'fake' });
    t.ok('条件に合うペアリング済み PC がない理由を返す', missing?.isError && /missing-pc/.test(missing.text), missing?.text);

    const settings = { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: secret, enabled: true };
    const pair = async (ws, dev, hostName) => {
      const from = ws.mark();
      await ws.cmd('setRemoteSettings', { ...settings, hostName });
      await ws.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 10_000 });
      const offer = await ws.cmd('remotePairingStart');
      const pending = dev.pair(offer.payload);
      const req = await ws.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
      await ws.cmd('remotePairingApprove', { id: req.request.id });
      return pending;
    };
    await pair(pcWs, device, 'managed-test-pc');
    await service.refresh();
    const repeat = async fn => {
      const end = Date.now() + 20_000;
      do { const value = await fn(); if (value) return value; await sleep(150); } while (Date.now() < end);
      return null;
    };
    t.ok('ランナーを介して利用者の PC に到達できる', Boolean(await repeat(async () => {
      const result = await delegate({ host: 'managed-test-pc', backend: 'fake' });
      return !result?.isError && JSON.parse(result?.text ?? 'null')?.taskId;
    })));
    const completed = await repeat(async () => (await pcWs.cmd('agentTasks')).find(row => row.status === 'completed' && row.result === 'MANAGED_PC'));
    t.ok('他社バックエンドを使う作業は PC 上で完了し、クラウドに結果が届く',
      Boolean(completed && await repeat(async () => (await cmd('agentTasks')).find(row => row.taskId === completed.taskId && row.result === 'MANAGED_PC'))));
    const unsupported = await delegate({ host: 'managed-test-pc', backend: 'codex' });
    t.ok('PC に指定のバックエンドが登録されていない理由を返す',
      unsupported?.isError && /バックエンド|backend/.test(unsupported.text), unsupported?.text);

    const inbound = createRemoteDevice({ dir: path.join(dir, 'inbound'), app: 'test', name: 'inbound-test' });
    try {
      const { hostId } = await pair(cloudWs, inbound, 'managed-test-cloud');
      await inbound.agentSync();
      const agent = await repeat(() => inbound.agent(hostId)?.usable && inbound.agent(hostId));
      if (!agent) throw new Error('クラウドへの委譲の接続が開かなかった');
      const requester = { sessionId: 'source-session', mode: { scope: 'workspace', autonomy: 'ask', enforced: true }, locale: 'en' };
      await denied('リモートの委譲を受け入れる入口も他社バックエンドを理由つきで拒む',
        agent.request('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:unexpected' }, requester));
    } finally {
      await inbound.closeAll();
    }
  } finally {
    cloudWs?.close();
    pcWs?.close();
    service.close();
    await device.closeAll();
    await Promise.all([cloud.stop(), pc.stop()]);
    await relay.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
