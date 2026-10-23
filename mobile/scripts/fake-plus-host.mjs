// Android の Plus 接続を試すためのローカルホスト。偽の Plus と relay/server.mjs だけを使う。
// 中継と PC は券（docs/plus.md「券」）も ID トークンも受ける。v2-on で券だけにする（中継は券の無い接続を
// 4401 'update required'、PC は ID トークンだけの申し込みを 'update_required' で断る）。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { createPlusLink } from '../../core/remote/plus-link.mjs';
import { createPlusHost } from '../../core/plus/hosts.mjs';
import { createPlusConfig } from '../../core/plus/config.mjs';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createIdTokenVerifier } from '../../core/plus/verify.mjs';
import { createTicketIssuer, createTicketVerifier } from '../../core/plus/tickets.mjs';
import { createPlusRelayAuthz } from '../../tests/lib/plus-relay-authz.mjs';
import { startFakePlus } from '../../tests/lib/fake-plus.mjs';
import { plainCipher } from '../../core/secret-store.mjs';

const out = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-android-plus-'));
const hostHttp = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><body><h1>Fake Plus Host</h1><p>${req.method} ${req.url}</p></body></html>`);
});
await new Promise(resolve => hostHttp.listen(0, '127.0.0.1', resolve));
const targetPort = hostHttp.address().port;

const ownRelay = createRelay({ enrollSecret: crypto.randomBytes(32).toString('base64url'), trustProxy: false, logger: () => {} });
const ownAddr = await ownRelay.listen(0, '127.0.0.1');
const ownUrl = `http://127.0.0.1:${ownAddr.port}`;
const plus = await startFakePlus();
const uid = 'user-1';
plus.state.accounts[uid] = {
  uid, email: 'user@example.com', provider: 'test', status: 'plus',
  plan: { id: 'plus', name: 'Plus' },
  limits: { hosts: 4, devicesPerHost: 8, sessionsPerHost: 2 },
  usage: { devices: 0, sessions: 0 }, sync: {},
};
plus.state.accounts['user-2'] = { ...plus.state.accounts[uid], uid: 'user-2', email: 'other@example.com' };
const verifier = createIdTokenVerifier({ jwksUrl: plus.jwksUrl, projectId: () => 'test-project' });
const authz = createPlusRelayAuthz({
  verify: token => verifier.verify(token), keysUrl: plus.ticketKeysUrl,
  isBound: async (accountUid, hostId) => plus.state.hosts[hostId]?.uid === accountUid,
});
const officialRelay = createRelay({
  enrollSecret: crypto.randomBytes(32).toString('base64url'), trustProxy: false, logger: () => {}, authz,
  // 試験は 1 分の間に何度も受け入れを試す（断り・承認の窓・取り直し）
  admitPerMinute: 100,
});
const officialAddr = await officialRelay.listen(0, '127.0.0.1');
const officialUrl = `http://127.0.0.1:${officialAddr.port}`;
const plusConfig = createPlusConfig({ env: { AGENT_HOST_PLUS_API: plus.url }, dataDir: scratch, appVersion: 'test' });
const sessionState = { signedIn: true, account: plus.state.accounts[uid] };
const session = {
  snapshot: () => ({ signedIn: sessionState.signedIn, account: sessionState.signedIn ? sessionState.account : null }),
  getIdToken: async () => plus.issueIdToken(uid),
  client: createPlusClient({ config: plusConfig, getIdToken: async () => plus.issueIdToken(uid), appVersion: 'test' }),
  setHost: () => {}, onChange: () => {},
};
const issuer = createTicketIssuer({ request: (method, p, body) => session.client.request(method, p, { body }), admission: () => admission });
const ticketVerifier = createTicketVerifier({ keysUrl: () => plus.ticketKeysUrl });
let admission = null;   // v2-on で 2（券だけを受ける PC）
let plusCount = 0;
let host;
const remote = createRemoteHost({
  dataDir: path.join(scratch, 'remote'), cipher: plainCipher,
  target: () => ({ host: '127.0.0.1', port: targetPort }), token: 'host-token', env: {},
  backoff: { minMs: 80, maxMs: 300 }, log: () => {},
  // 承認の窓に出た申し込みを試験へ知らせる（試験は approve / deny で答える）
  emit: ev => { if (ev.type === 'remotePairing' && ev.phase === 'request') out({ event: 'pair-request', id: ev.request.id, code: ev.request.code, via: ev.request.via }); },
});
const makePlusLink = (admitLimit = 20) => createPlusLink({
  session, verifier, issuer, ticketVerifier, remote, admitLimit,
  onAdmitted: async () => { plusCount = (await remote.store.devices()).filter(d => d.via === 'plus').length; await host.syncDeviceCount(); },
  log: line => out({ event: 'error', message: line }),
});
const plusLink = makePlusLink();
host = createPlusHost({
  session, store: remote.store, appVersion: 'test', platform: 'linux', hostName: () => 'fake-plus-host',
  plusDevices: () => plusCount, retryMs: 100, log: line => out({ event: 'error', message: line }),
  onHostState: state => remote.setPlusHostState(state),
});
remote.setPlusProvider(plusLink.provider);

async function sync() {
  await host.maybeRegister();
  const status = await remote.status();
  plusCount = status.plus?.devices ?? plusCount;
  plusLink.update({
    enabled: status.enabled === true, signedIn: sessionState.signedIn, uid: uid,
    accountStatus: sessionState.account?.status ?? null, connect: status.plus?.connect === true,
    hostState: host.host().state, limits: sessionState.account?.limits ?? null, relayUrl: officialUrl, admission,
  });
  remote.refreshPlus();
}

// 制御の接続を張り直した（中継が新しい /v1/host を通した）ところまで待つ。券を取る分だけ張り直しが遅いので、
// 前の接続の「connected」のうちに端末を送ると、張り直しで閉じられる
const controlOpens = () => authz.state.seen.filter(s => s.route === '/v1/host' && s.ok).length;
async function swapProvider(provider) {
  const before = controlOpens();
  await remote.setPlusProvider(provider);
  await until(async () => controlOpens() > before && (await remote.status()).links.plus.state === 'connected');
}

async function until(fn, timeoutMs = 12_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('local Plus host did not reach the expected state');
}

let stopping = false;
try {
  await remote.setSettings({ relayUrl: ownUrl, enrollSecret: 'local-test-enroll-secret', enabled: true, hostName: 'fake-plus-host', plusConnect: true });
  await until(async () => {
    await sync();
    return host.host().state === 'registered' && (await remote.status()).links.plus.state === 'connected';
  });
  const identity = await remote.store.peekIdentity();
  out({
    event: 'ready', hostId: identity.hostId, publicKey: identity.publicKey.toString('base64url'),
    hostName: 'fake-plus-host', relayUrl: officialUrl, apiUrl: plus.url,
    idToken: plus.issueIdToken(uid), otherIdToken: plus.issueIdToken('user-2'), uid,
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async line => {
    const [command, value] = line.trim().split(/\s+/);
    try {
      if (command === 'loose') authz.state.looseDevices = value === 'on';
      else if (command === 'limit') {
        sessionState.account = { ...sessionState.account, limits: { ...sessionState.account.limits, devicesPerHost: Number(value) } };
        await sync();
      } else if (command === 'unavailable') {
        sessionState.account = { ...sessionState.account, limits: null };
        await sync();
      } else if (command === 'restore') {
        sessionState.account = plus.state.accounts[uid];
        await sync();
      } else if (command === 'rate-on') {
        const limited = makePlusLink(0);
        limited.update({ enabled: true, signedIn: true, uid, accountStatus: 'plus', connect: true, hostState: 'registered', limits: sessionState.account.limits, relayUrl: officialUrl, admission });
        await swapProvider(limited.provider);
        out({ event: 'rate-ready' });
      } else if (command === 'rate-off') {
        await swapProvider(plusLink.provider);
        out({ event: 'rate-restored' });
      } else if (command === 'v2-on' || command === 'v2-off') {
        // v2-on host: PC だけを券だけにする（中継は ID トークンも通す。PC の 'update_required' を確かめる）
        const on = command === 'v2-on';
        authz.state.v2Required = on && value !== 'host';
        admission = on ? 2 : null;
        plus.state.admission = on ? 2 : 1;
        await sync();
        out({ event: on ? 'v2-ready' : 'v2-restored' });
      } else if (command === 'tickets-off') {
        // 券の口が無い前の版の api（challenge が 404、/v1/auth/config に admission が無い）
        plus.state.tickets = false;
        out({ event: 'tickets-off' });
      } else if (command === 'ticket-fail') {
        // 次の券の発行を value の状態で断る（426 update_required・404 not_found など）
        const status = Number(value);
        plus.state.ticketFail = [{ path: '/v1/tickets/challenge', status, code: status === 426 ? 'update_required' : status === 404 ? 'not_found' : 'internal' }];
        out({ event: 'ticket-fail', status });
      } else if (command === 'ticket-fail-off') {
        plus.state.ticketFail = [];
        out({ event: 'ticket-fail-off' });
      } else if (command === 'seen') {
        // 中継が端末の接続で見たもの（券か ID トークンか）
        out({ event: 'seen', seen: authz.state.seen.filter(s => s.route.startsWith('/v1/device')).slice(-Number(value || 5)) });
      } else if (command === 'close-device') {
        const closed = authz.handle.closeTag(`d:${value}`, 4401, 'revoked');
        out({ event: 'closed-revoked', deviceId: value, count: closed });
      } else if (command === 'revoke') {
        await remote.revoke(value);
        out({ event: 'revoked', deviceId: value });
      } else if (command === 'approve') {
        const device = await remote.approve(value);
        out({ event: 'approved', requestId: value, deviceId: device.id });
      } else if (command === 'deny') {
        await remote.deny(value);
        out({ event: 'denied', requestId: value });
      } else if (command === 'quit') await stop();
      else if (command) throw new Error(`unknown command: ${command}`);
    } catch (error) { out({ event: 'error', message: error.message }); }
  });
  rl.on('close', () => { if (!process.stdin.isTTY) void stop(); });
} catch (error) {
  out({ event: 'error', message: error.message });
  await stop();
}

async function stop() {
  if (stopping) return;
  stopping = true;
  try { await remote.setSettings({ enabled: false, plusConnect: false }); } catch {}
  try { await hostHttp.close(); } catch {}
  try { await ownRelay.close(); } catch {}
  try { await officialRelay.close(); } catch {}
  try { await plus.close(); } catch {}
  await fs.rm(scratch, { recursive: true, force: true });
  out({ event: 'stopped' });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
