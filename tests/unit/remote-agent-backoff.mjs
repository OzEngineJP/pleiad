// AI 用の線（agentOpen）の張り直し: ホストが居ない（host-offline）間だけ待ちの上限を 5 分に延ばす
// （core/remote/device-link.mjs の backoff.offlineMaxMs・core/remote/device.mjs の AGENT_LINK_OFFLINE_MAX_MS。
// 張り直しのたびに中継の券を Plus の api へ取り直すので、オフラインのままのホストへ 30 秒ごとに取り直し続けるのを延ばす）。
//   - DeviceLink: offlineMaxMs を渡した線は 4404 が続くと待ちがその上限まで倍々に延びる。渡さない線は maxMs のまま（既定の振る舞い）
//   - host-offline で延びたあと別の理由（1013 = 中継の一時的な失敗）で切れたら、次の待ちは maxMs 側に戻る
//   - 延びた待ちの間も retryNow は今すぐつなぎ直す。つながって stableMs 続けば、次の失敗は minMs からやり直す
//   - agentOpen の線（own・plus の両方の記録）にだけオフライン用の上限が渡り、窓のプロキシと既定値は変わらない
// 前半は接続をすぐ決めたコードで閉じる偽の中継、後半（つながる場面）は本物の中継（relay/server.mjs）とホストをこのプロセスで立てる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { DeviceLink, LINK_BACKOFF } from '../../core/remote/device-link.mjs';
import { generateKeyPair, hostIdFor } from '../../core/remote/noise.mjs';
import { plainCipher } from '../../core/secret-store.mjs';

export const name = 'remote-agent-backoff';
export const title = 'AI の線の張り直し: host-offline の間だけ上限を延ばす（他の切断・窓の線・既定値は今のまま）';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const within = (p, ms, label) => {
  let timer;
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); })]);
};
const until = async (fn, ms, label) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`); await sleep(30); }
};

/** すぐ決めた close code で閉じるだけの偽の中継（来た接続を数える）。code はあとから変えられる。 */
async function startCloseRelay(code) {
  const server = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const api = { code };
  let connects = 0;
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => { connects++; ws.on('error', () => {}); ws.close(api.code); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    api, url: `http://127.0.0.1:${server.address().port}`, connects: () => connects,
    close() { for (const ws of wss.clients) ws.terminate(); wss.close(); return new Promise(r => server.close(r)); },
  };
}

/** DeviceLink の状態の変化を、次の張り直しまでの待ち（retryAt − since）と一緒に覚える。 */
function watchDelays(link) {
  const rows = [];
  link.on('status', s => rows.push({ state: s.state, delay: s.retryAt ? Date.parse(s.retryAt) - Date.parse(s.since) : null, retryAt: s.retryAt ?? null }));
  return rows;
}

const fakeLinkArgs = relayUrl => ({ creds: { hostId: hostIdFor(generateKeyPair().publicKey), hostPublicKey: generateKeyPair().publicKey, relayUrl, deviceId: 'd1', token: 't' }, keyPair: generateKeyPair() });

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-agent-backoff-')));
  const links = [];
  const closers = [];
  try {
    t.ok('既定値: offlineMaxMs を渡さなければ maxMs と同じ（今の振る舞い）',
      new DeviceLink(fakeLinkArgs('http://127.0.0.1:1')).backoff.offlineMaxMs === LINK_BACKOFF.maxMs && LINK_BACKOFF.offlineMaxMs === undefined);

    // ---- 偽の中継に 4404 で断られ続ける線（offlineMaxMs 付き）
    const closeRelay = await startCloseRelay(4404);
    closers.push(closeRelay);
    const { creds, keyPair } = fakeLinkArgs(closeRelay.url);
    const wide = new DeviceLink({ creds, keyPair, backoff: { minMs: 50, maxMs: 200, stableMs: 60_000, offlineMaxMs: 800 }, connectTimeoutMs: 2000 });
    links.push(wide);
    const wideRows = watchDelays(wide);
    wide.start();
    const wideDelays = await until(() => {
      const ds = wideRows.filter(r => r.state === 'host-offline').map(r => r.delay);
      return ds.length >= 8 ? ds : null;
    }, 20_000, 'host-offline が続く');
    t.ok('offlineMaxMs を渡した線は、host-offline が続くと待ちが倍々に延びて offlineMaxMs ±25%（800ms → 600〜1000）に張り付く',
      wideDelays[0] <= 70 && wideDelays.slice(-3).every(d => d >= 590 && d <= 1010), JSON.stringify(wideDelays));

    // ---- 同じ偽の中継でも、offlineMaxMs の無い線は maxMs のまま
    const plain = new DeviceLink({ creds, keyPair, backoff: { minMs: 50, maxMs: 200, stableMs: 60_000 }, connectTimeoutMs: 2000 });
    links.push(plain);
    const plainRows = watchDelays(plain);
    plain.start();
    const plainDelays = await until(() => {
      const ds = plainRows.filter(r => r.state === 'host-offline').map(r => r.delay);
      return ds.length >= 8 ? ds : null;
    }, 20_000, 'offlineMaxMs の無い線も host-offline が続く');
    t.ok('offlineMaxMs を渡さない線は、host-offline が続いても待ちは maxMs ±25%（200ms → 150〜250）のまま',
      plainDelays.every(d => d <= 260) && plainDelays.slice(-3).every(d => d >= 140), JSON.stringify(plainDelays));

    // ---- 延びた待ちの間も、retryNow は今すぐつなぎ直す
    const huge = new DeviceLink({ creds, keyPair, backoff: { minMs: 200, maxMs: 200, stableMs: 60_000, offlineMaxMs: 300_000 }, connectTimeoutMs: 2000 });
    links.push(huge);
    const hugeRows = watchDelays(huge);
    huge.start();
    const grown = await until(() => hugeRows.filter(r => r.state === 'host-offline' && r.delay > 4_000).at(-1), 20_000, '待ちが 4 秒を超えて延びる');
    const left = Date.parse(grown.retryAt) - Date.now();
    const seen = closeRelay.connects();
    huge.retryNow();
    await until(() => closeRelay.connects() > seen, 5_000, 'retryNow の張り直し');
    t.ok('延びた待ち（残り 2 秒以上）の間も、retryNow で今すぐつなぎ直せる', left > 2_000, `残り ${left}ms`);

    // ---- host-offline で延びたあと、別の理由（1013 = 中継の一時的な失敗）で切れたら maxMs 側に戻る
    closeRelay.api.code = 1013;
    const mark = wideRows.length;
    const back = await until(() => wideRows.slice(mark).find(r => r.state === 'offline' && r.delay != null), 20_000, '1013 で offline に');
    t.ok('host-offline で延びたあと別の理由（1013）で切れたら、次の待ちは maxMs ±25% の側に戻る', back.delay <= 260, String(back.delay));
    links.splice(0).forEach(l => l.stop());
    await closeRelay.close();

    // ---- agentOpen: own と plus の両方の記録の線にだけオフライン用の上限が渡る。窓のプロキシは変わらない
    const closeRelay2 = await startCloseRelay(4404);
    closers.push(closeRelay2);
    const wiring = createRemoteDevice({ dir: path.join(scratch, 'wiring'), cipher: plainCipher, app: 'test', name: 'w', platform: 'desktop',
      plusAuth: () => ({ getIdToken: async () => 'idtok' }) });
    closers.push({ close: () => wiring.closeAll() });
    const ownRec = { keyPair: generateKeyPair() };
    ownRec.hostId = hostIdFor(ownRec.keyPair.publicKey);
    const plusRec = { keyPair: generateKeyPair() };
    plusRec.hostId = hostIdFor(plusRec.keyPair.publicKey);
    await wiring.store.saveHost({ hostId: ownRec.hostId, hostPublicKey: ownRec.keyPair.publicKey, relayUrl: closeRelay2.url, deviceId: 'd-own', token: 't', keyPair: ownRec.keyPair });
    await wiring.store.saveHost({ hostId: plusRec.hostId, hostPublicKey: plusRec.keyPair.publicKey, relayUrl: closeRelay2.url, deviceId: 'd-plus', token: 't', via: 'plus', uid: 'u', keyPair: plusRec.keyPair });
    await wiring.agentSync();
    const ownLink = wiring.agent(ownRec.hostId)?.link;
    const plusLink = wiring.agent(plusRec.hostId)?.link;
    t.ok('agentOpen の線は own と plus の両方でオフライン用の上限 5 分を持つ（他の上限は既定のまま）',
      ownLink?.backoff.offlineMaxMs === 300_000 && plusLink?.backoff.offlineMaxMs === 300_000 && ownLink.backoff.maxMs === 30_000,
      JSON.stringify([ownLink?.backoff, plusLink?.backoff]));
    const px = await wiring.open(ownRec.hostId);
    t.ok('人が開く窓の線（DeviceProxy）は変わらない（オフライン用の上限は maxMs と同じ）',
      px.link.backoff.offlineMaxMs === px.link.backoff.maxMs, JSON.stringify(px.link.backoff));
    await wiring.closeAll();
    await closeRelay2.close();

    // ---- 本物の中継とホスト: 4404 で延び → つながって stableMs → 次の失敗は minMs からやり直す
    const SECRET = crypto.randomBytes(32).toString('base64url');
    const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
    const relayPort = (await relay.listen(0, '127.0.0.1')).port;
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    closers.push({ close: () => relay.close() });
    const host = createRemoteHost({ dataDir: path.join(scratch, 'host'), cipher: plainCipher, target: () => ({ host: '127.0.0.1', port: 1 }), token: 'tok', env: {}, backoff: { minMs: 60, maxMs: 300 }, log: () => {} });
    closers.push({ close: async () => { try { host.stop(); } catch {} } });
    const devKey = generateKeyPair();
    const devToken = crypto.randomBytes(32);
    const deviceRecord = {
      id: `d${crypto.randomBytes(12).toString('base64url')}`, name: 'agent laptop', platform: 'desktop', app: 'test',
      publicKey: devKey.publicKey.toString('base64url'), tokenHash: crypto.createHash('sha256').update(devToken).digest('hex'),
      createdAt: new Date().toISOString(), lastSeenAt: null,
    };
    await host.store.addDevice(deviceRecord);
    const identity = await host.store.identity();
    const dev = createRemoteDevice({ dir: path.join(scratch, 'device'), cipher: plainCipher, app: 'test', name: 'agent laptop', platform: 'desktop',
      proxyOptions: { backoff: { minMs: 100, maxMs: 400, stableMs: 400, offlineMaxMs: 2000 }, connectTimeoutMs: 5000 }, log: () => {} });
    closers.push({ close: () => dev.closeAll() });
    await dev.store.saveHost({ hostId: identity.hostId, hostPublicKey: Buffer.from(identity.publicKey, 'base64url'), relayUrl, deviceId: deviceRecord.id, token: devToken.toString('base64url'), keyPair: devKey });
    // ホストが中継へつなぐ前に線を張る: 中継は 4404 を返し、agentOpen の線は offlineMaxMs へ向かって延びる
    await dev.agentSync();
    const agentLink = dev.agent(identity.hostId)?.link;
    const agentRows = watchDelays(agentLink);
    t.ok('試験の backoff は agentOpen の線へそのまま渡る（offlineMaxMs も上書きできる）', agentLink?.backoff.offlineMaxMs === 2000, JSON.stringify(agentLink?.backoff));
    const grownRow = await until(() => agentRows.find(r => r.state === 'host-offline' && r.delay > 500), 20_000, 'host-offline で maxMs（400）を超えて延びる');
    t.ok('agentOpen の線は、本物の中継の 4404 が続くと maxMs（400）を超えて offlineMaxMs まで延びる', grownRow.delay <= 2100, String(grownRow.delay));
    await within(host.start(), 10_000, 'ホストの起動');
    await within(host.setSettings({ relayUrl, enrollSecret: SECRET, enabled: true, hostName: 'desk' }), 10_000, 'ホストの有効化');
    await until(() => agentLink.state === 'connected', 20_000, 'ホストが現れてつながる');
    t.ok('ホストが現れると、延びた待ちを待たずに次の張り直しでつながる', true);
    await sleep(900);   // stableMs（400）を越えてつながり続ける
    const mark2 = agentRows.length;
    await within(relay.close(), 5_000, '中継の停止');
    const down = await until(() => agentRows.slice(mark2).find(r => r.state === 'offline' && r.delay != null), 10_000, '中継が落ちて offline に');
    t.ok('つながって stableMs 続いた後は張り直しの回数が初めに戻る（次の待ちは minMs ±25%）', down.delay >= 60 && down.delay <= 160, String(down.delay));
  } finally {
    for (const l of links.splice(0)) { try { l.stop(); } catch {} }
    for (const c of closers.splice(0)) { try { await c.close(); } catch {} }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
