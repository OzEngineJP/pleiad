// 端末のローカルのサーバー（core/server.mjs）を、Electron の main の身代わりを付けて起こす入口（docs/remote.md §4.5 の端末側の試験用）。
// 本物の main（desktop/remote-agent-bridge.cjs）と同じ橋の中身（core/remote/agent-service.mjs）を、本物の端末の部品
// （core/remote/device.mjs。ペアリング済みのホストの資格情報）につないで動かす。中継・ホストは別に立ててある本物。
//
// 環境変数:
//   FAKE_REMOTE_DEVICE_DIR   端末の置き場（hosts.json・secrets.json。テストが createRemoteDevice でペアリングしてから起こす）
//   FAKE_REMOTE_DEVICE_NAME  端末の名前（ホストの端末一覧に出るものはペアリング時に決まる。ここは HELLO の名前）
//   FAKE_REMOTE_DEVICE_PLUS_ID_TOKEN  Plus 経由（via: 'plus'）の記録の線が中継へ出す ID トークン（偽の Plus が出したもの）。
//                            無ければ本物の main の「Plus を使えない間」と同じに、plus の記録には線を張らない
// ホストの一覧の変更（増減・名前）は、本物の窓の IPC の代わりに hosts.json を見て拾う（テストが createDeviceStore の updateHost で書く）。
import fs from 'node:fs';
import path from 'node:path';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { createRemoteAgentService } from '../../core/remote/agent-service.mjs';

const dir = process.env.FAKE_REMOTE_DEVICE_DIR;
if (!dir) throw new Error('FAKE_REMOTE_DEVICE_DIR is required');
const listeners = [];
const toWorker = message => { for (const fn of listeners) fn({ data: message }); };
const device = createRemoteDevice({
  dir, app: 'test', name: process.env.FAKE_REMOTE_DEVICE_NAME || 'laptop-test', platform: 'desktop',
  proxyOptions: { backoff: { minMs: 100, maxMs: 400, stableMs: 500, offlineMaxMs: 4000 }, connectTimeoutMs: 5000 },
  plusAuth: process.env.FAKE_REMOTE_DEVICE_PLUS_ID_TOKEN ? () => ({ getIdToken: async () => process.env.FAKE_REMOTE_DEVICE_PLUS_ID_TOKEN }) : null,
});
const service = createRemoteAgentService({ getDevice: async () => device, post: toWorker, log: line => console.log(`  [remote-agent] ${line}`) });
process.parentPort = {
  postMessage(message) {
    if (message?.type === 'remote-agent') return service.handle(message);
  },
  on(type, fn) { if (type === 'message') listeners.push(fn); },
};
// hosts.json のホストが変わったら、窓のペアリング・削除と同じに線を張り直す
const hostsFile = path.join(dir, 'hosts.json');
let last = '';
const watch = setInterval(() => {
  let now = '';
  try { now = JSON.stringify((JSON.parse(fs.readFileSync(hostsFile, 'utf8')).hosts ?? []).map(h => [h.hostId, h.label ?? ''])); } catch { return; }
  if (now !== last) { const first = last === ''; last = now; if (!first) service.refresh(); }
}, 150);
watch.unref();
process.on('exit', () => { service.close(); });
await import('../../core/server.mjs');
