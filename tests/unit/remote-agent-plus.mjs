// Pleiad Plus 経由だけでペアリングした PC へ、端末の AI から任せる（docs/remote.md §4.5「端末の線」、ADR 0146）。
// 偽の Plus（tests/lib/fake-plus.mjs）と認可付き公式中継（relay/server.mjs + tests/lib/plus-relay-authz.mjs）、
// ホスト（core/remote/connector.mjs + core/plus/hosts.mjs。/agent の口は core/remote/agent-port.mjs）をこのプロセスで立て、
// 端末は createRemoteDevice で Plus の受け入れ（admit）だけをする（hosts.json は via: 'plus' の記録だけ）。
//   - AI の線（agentOpen）が plus の資格と鍵で張られ、ready になる（前は own の資格だけを探して張らなかった）
//   - Plus を使えない間（plusAuth が null）は plus の記録に線を張らない
//   - 同じホストに own と plus があるときは own を選ぶ（pickHostRecord。窓と同じ規則）
//   - 端末のローカルのサーバー（main の身代わり tests/lib/remote-agent-parent-port.mjs）から ply_delegate { host } で任せられる
// LLM も外のネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { createPlusLink } from '../../core/remote/plus-link.mjs';
import { createPlusHost } from '../../core/plus/hosts.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createIdTokenVerifier } from '../../core/plus/verify.mjs';
import { createAgentPort } from '../../core/remote/agent-port.mjs';
import { createPlusRelayAuthz } from '../lib/plus-relay-authz.mjs';
import { plainCipher } from '../../core/secret-store.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createRemoteDevice, pickHostRecord } from '../../core/remote/device.mjs';

export const name = 'remote-agent-plus';
export const title = 'Plus 経由だけの PC へ端末の AI から任せる: plus の資格で AI の線が張られ ready・Plus を使えない間は張らない・own と plus の選び方・ply_delegate { host }';

const UID = 'user-plus-agent-1';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const within = (p, ms, label) => {
  let timer;
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); })]);
};
const until = async (fn, ms, label) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`); await sleep(50); }
};

export default async function (t) {
  // ---- 選び方（純粋な部品）: own を先に、使えない記録は飛ばす
  const recs = [
    { hostId: 'h1', via: 'plus' }, { hostId: 'h1', via: 'own' }, { hostId: 'h2', via: 'plus' },
    { hostId: 'h3', via: 'own', revokedAt: 'x' }, { hostId: 'h3', via: 'plus' },
  ];
  t.ok('pickHostRecord: own と plus の両方があれば own（並びに依らない）', pickHostRecord(recs, 'h1')?.via === 'own');
  t.ok('pickHostRecord: plus だけなら plus', pickHostRecord(recs, 'h2')?.via === 'plus');
  t.ok('pickHostRecord: 使えない own（取り消し）は飛ばして plus', pickHostRecord(recs, 'h3', { usable: h => !h.revokedAt })?.via === 'plus');
  t.ok('pickHostRecord: 使える記録が無ければ null', pickHostRecord(recs, 'h2', { usable: h => h.via === 'own' }) === null && pickHostRecord(recs, 'nope') === null);

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-remote-agent-plus-')));
  const hostDataDir = path.join(scratch, 'host-data');
  const devDir = path.join(scratch, 'device');
  const termDir = path.join(scratch, 'term');

  const plus = await startFakePlus();
  plus.state.accounts[UID] = {
    uid: UID, email: 'user@example.test', provider: 'test', status: 'plus',
    plan: { id: 'plus', name: 'Plus' },
    limits: { hosts: 4, devicesPerHost: 4, sessionsPerHost: 2 },
    usage: { devices: 0, sessions: 0 }, sync: {},
  };
  const verifier = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'test-project' });
  const authz = createPlusRelayAuthz({
    verify: token => verifier.verify(token), keysUrl: plus.ticketKeysUrl,
    isBound: async (uid, hostId) => plus.state.hosts[hostId]?.uid === uid,
  });
  const relay = createRelay({ enrollSecret: crypto.randomBytes(32).toString('base64url'), trustProxy: false, logger: () => {}, authz, admitPerMinute: 100 });
  const relayUrl = `http://127.0.0.1:${(await relay.listen(0, '127.0.0.1')).port}`;

  // ホストの /agent の口。委譲の本体は呼ばれた依頼を覚えて、ホストのタスクの形で返す
  const invoked = [];
  let remoteHost = null;
  const port = createAgentPort({
    allowed: deviceId => remoteHost.agentAllowed(deviceId),
    hostName: () => 'plus-desk',
    invoke: async call => {
      invoked.push({ op: call.op, deviceId: call.device.id, args: call.args, requester: call.requester });
      if (call.op === 'delegate') return { task: { taskId: 'ply-task-0a1b2c3d-0000-4000-8000-000000000001', status: 'running', title: call.args.title ?? null, updatedAt: Date.now() } };
      return {};
    },
  });
  const st = { signedIn: true, account: plus.state.accounts[UID] };
  const plusConfig = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: hostDataDir, appVersion: 'test' });
  const session = {
    snapshot: () => ({ signedIn: st.signedIn, account: st.signedIn ? st.account : null }),
    getIdToken: async () => plus.issueIdToken(UID),
    client: createPlusClient({ config: plusConfig, getIdToken: async () => plus.issueIdToken(UID), appVersion: 'test' }),
    setHost: () => {},
    onChange: () => {},
  };
  remoteHost = createRemoteHost({
    dataDir: hostDataDir, cipher: plainCipher,
    target: () => ({ host: '127.0.0.1', port: 9 }),
    token: 'test-host-token', env: {}, backoff: { minMs: 60, maxMs: 200 }, log: () => {},
    agent: {
      attach: (stream, device) => port.attach(stream, device),
      closeDevice: (deviceId, reason) => port.closeDevice(deviceId, reason),
      refresh: deviceId => port.refresh(deviceId),
    },
    onIdentity: () => { void hostService.maybeRegister(); },
  });
  let plusDeviceCount = 0;
  const plusLink = createPlusLink({
    session, verifier, remote: remoteHost,
    onAdmitted: async () => {
      plusDeviceCount = (await remoteHost.store.devices()).filter(d => d.via === 'plus').length;
      await hostService.syncDeviceCount();
    },
    log: () => {},
  });
  const hostService = createPlusHost({
    session, store: remoteHost.store, appVersion: 'test',
    hostName: () => 'plus-desk', plusDevices: () => plusDeviceCount, retryMs: 40, log: () => {},
    onHostState: s => remoteHost.setPlusHostState(s),
  });
  remoteHost.setPlusProvider(plusLink.provider);
  const syncHost = async () => {
    await hostService.maybeRegister();
    const r = await remoteHost.status();
    plusDeviceCount = r.plus?.devices ?? 0;
    plusLink.update({
      enabled: r.enabled, signedIn: st.signedIn, uid: UID,
      accountStatus: st.account?.status ?? null, connect: r.plus?.connect === true,
      hostState: hostService.host().state, limits: st.account?.limits ?? null, relayUrl,
    });
    remoteHost.refreshPlus();
  };

  let term = null, ct = null;
  const devices = [];
  const makeDevice = opts => { const d = createRemoteDevice({ dir: devDir, cipher: plainCipher, app: 'test', name: 'mac-test', platform: 'desktop',
    proxyOptions: { backoff: { minMs: 100, maxMs: 400, stableMs: 500 }, connectTimeoutMs: 5000 }, log: () => {}, ...opts }); devices.push(d); return d; };
  try {
    await remoteHost.start();
    await remoteHost.setSettings({ enabled: true, hostName: 'plus-desk', plusConnect: true });
    const identity = await remoteHost.store.identity();
    const hostId = identity.hostId;
    const hostPublicKey = Buffer.from(identity.publicKey, 'base64url');
    await syncHost();
    await until(async () => (await remoteHost.status()).links.plus?.state === 'connected', 10_000, 'ホストが公式中継につながる');

    // ---- 端末: Plus で受け入れてもらう（hosts.json は via: 'plus' の記録だけ）
    const pairer = makeDevice();
    const admitting = pairer.admit({ hostId, hostPublicKey, relayUrl, idToken: plus.issueIdToken(UID), uid: UID, mode: 'pair', onCode: () => {} });
    const req = await until(async () => (await remoteHost.status()).pairing.requests.find(r => r.via === 'plus'), 10_000, 'ホストの承認の窓');
    await remoteHost.approve(req.id);
    await within(admitting, 10_000, 'Plus の受け入れ');
    await pairer.closeAll();
    const saved = (await pairer.store.hosts()).filter(h => h.hostId === hostId);
    t.ok('端末の hosts.json はそのホストの via: plus の記録だけ', saved.length === 1 && saved[0].via === 'plus', JSON.stringify(saved.map(h => h.via)));
    const deviceId = (await remoteHost.status()).devices.find(d => d.via === 'plus')?.id;
    t.ok('ホストの端末一覧に Plus のデスクトップ版の端末が載り、AI の依頼を受けてよい', Boolean(deviceId) && remoteHost.agentAllowed(deviceId) === true);

    // ---- Plus を使えない間（plusAuth が null）は、plus の記録に線を張らない
    const noPlus = makeDevice({ plusAuth: () => null });
    await noPlus.agentSync();
    t.ok('Plus を使えない間は plus の記録に AI の線を張らない', noPlus.agent(hostId) === null);
    await noPlus.closeAll();

    // ---- Plus を使える: plus の資格と鍵で AI の線が張られ、ready になる
    const dev = makeDevice({ plusAuth: () => ({ getIdToken: async () => plus.issueIdToken(UID) }) });
    await dev.agentSync();
    const agent = dev.agent(hostId);
    t.ok('Plus 経由だけのホストにも AI の線が張られる', Boolean(agent));
    await until(() => agent?.status?.state === 'ready', 15_000, 'AI の線が ready');
    t.ok('AI の線が ready になり、ホストが許可（allowed）を返す', agent.status.state === 'ready' && agent.status.allowed === true, JSON.stringify(agent.status));
    const row = (await dev.list()).find(h => h.hostId === hostId);
    t.ok('一覧の plus の記録に AI の線の状態が付く', row?.agent?.state === 'ready' && row.via === 'plus');
    const again = await dev.store.host(hostId, 'plus');
    t.ok('つながると plus の記録の最後の接続が書かれる（own の記録は作らない）', Boolean(again?.lastConnectedAt) && (await dev.store.host(hostId, 'own')) === null);
    await dev.closeAll();

    // ---- 端末のローカルのサーバー（main の身代わり付き）から ply_delegate { host } で任せる
    term = await startServer({
      env: { AGENT_HOST_BACKENDS: 'fake', FAKE_REMOTE_DEVICE_DIR: devDir, FAKE_REMOTE_DEVICE_PLUS_ID_TOKEN: plus.issueIdToken(UID) },
      dataDir: termDir, entry: path.join(ROOT, 'tests', 'lib', 'remote-agent-parent-port.mjs'), timeoutMs: 60_000,
    });
    ct = await open({ port: term.port, token: term.token });
    const toolResult = r => { const e = r.events.findLast(x => x.type === 'tool.result'); return { isError: Boolean(e?.isError), text: e?.text ?? '', json: (() => { try { return JSON.parse(e?.text); } catch { return null; } })() }; };
    let sid = null;
    const delegate = async () => {
      const r = await ct.runTurn({ ...(sid ? { sessionId: sid } : { backend: 'fake', cwd: ROOT }),
        prompt: prompt('ply_delegate', { host: 'plus-desk', kind: 'mechanical', backend: 'fake', task: 'echo:VIA_PLUS', title: 'Plus 経由で任せる' }) }, { ms: 60_000 });
      sid ??= r.sessionId;
      const res = toolResult(r);
      if (res.isError && res.text !== last?.text) t.note(`ply_delegate: ${res.text.slice(0, 300)}`);
      return res.isError ? (last = res, null) : res;
    };
    let last = null;
    const started = await until(delegate, 30_000, 'Plus 経由のホストへ ply_delegate { host } が通る').catch(e => { e.message += ` 最後の答え: ${last?.text?.slice(0, 200)}`; throw e; });
    t.ok('ply_delegate { host } が Plus 経由のホストへ届き、taskId と host の名前が返る',
      started.json?.taskId === 'ply-task-0a1b2c3d-0000-4000-8000-000000000001' && started.json.host === 'plus-desk', started.text.slice(0, 200));
    const call = invoked.find(c => c.op === 'delegate');
    t.ok('ホストの口に、その端末から delegate の依頼が届く（依頼文と依頼元の会話）',
      call?.deviceId === deviceId && call.args.task === 'echo:VIA_PLUS' && call.requester?.sessionId === sid, JSON.stringify(call ?? null).slice(0, 200));
  } finally {
    ct?.close();
    await within(term?.stop() ?? Promise.resolve(), 15_000, '端末のサーバーの停止').catch(e => t.note(e.message));
    for (const d of devices) await d.closeAll().catch(() => {});
    try { remoteHost.stop(); } catch {}
    await relay.close().catch(() => {});
    await plus.close().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
