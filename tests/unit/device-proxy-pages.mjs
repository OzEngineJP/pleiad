import http from 'node:http';
import { EventEmitter } from 'node:events';
import { DeviceProxy, PROXY_COOKIE } from '../../core/remote/device-proxy.mjs';
import { isHostOnlyUrl, watchHostOnlyLinks } from '../../web/host-only-links.mjs';

export const name = 'device-proxy-pages';
export const title = '端末プロキシのファイルページ: Cookie 認証・localhost の隔離待ち受け・両端の上限';

function request(port, path, { host = '127.0.0.1', authority = `127.0.0.1:${port}`, headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method, agent: false, headers: { host: authority, ...headers } }, res => {
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, bytes, aborted: true }));
    });
    req.on('error', reject); req.end();
  });
}

export default async function(t) {
  const heads = [];
  let releases = 0, resets = 0;
  const proxy = new DeviceProxy({ creds: {}, keyPair: {} });
  proxy.link.start = () => {};
  proxy.link.stop = () => {};
  proxy.link.ready = async () => ({ openHttp(head) {
    heads.push(head);
    const stream = new EventEmitter();
    stream.reset = code => { resets++; stream.destroyed = true; stream.emit('reset', code); };
    stream.end = async () => {
      queueMicrotask(() => {
        const declared = head.path.includes('declared');
        stream.emit('response', { status: 200, headers: { 'set-cookie': 'host=hidden',
          ...(declared ? { 'content-length': 40 * 1024 * 1024 } : {}),
          ...(head.path.includes('compressed') ? { 'content-encoding': 'gzip' } : {}) } });
        const size = head.path.includes('huge') ? 33 * 1024 * 1024 : head.path.includes('large') ? 9 * 1024 * 1024 : 2;
        let sent = 0;
        const pump = () => {
          if (stream.destroyed) return;
          if (sent >= size) { stream.emit('end'); return; }
          const chunk = Buffer.alloc(Math.min(64 * 1024, size - sent)); sent += chunk.length;
          stream.emit('data', chunk, () => { releases++; setImmediate(pump); });
        };
        if (!declared) pump(); else if (!stream.destroyed) stream.emit('end');
      });
    };
    return stream;
  } });
  await proxy.start();
  const cookie = { cookie: `${PROXY_COOKIE}=${proxy.token}` };
  const isolated = { authority: `localhost:${proxy.isolatedPort}` };
  try {
    const boot = await request(proxy.port, `/?token=${proxy.token}`);
    t.ok('既存の入口は query token を Cookie に替える', boot.status === 200 && boot.headers['set-cookie'][0].startsWith(PROXY_COOKIE));
    for (const path of ['/_pleiad/s/s1/files', '/%5fpleiad/s/s1/files', '/x/../_pleiad/s/s1/files']) {
      t.ok(`ファイルページは query token だけでは読めない: ${path}`, (await request(proxy.port, `${path}?token=${proxy.token}`)).status === 401);
    }
    const files = await request(proxy.port, '/_pleiad/s/s1/files?token=drop', { headers: cookie });
    t.ok('ファイルページは Cookie で読み、ホストの Cookie を受け取らない', files.status === 200 && !files.headers['set-cookie']);
    const site = value => request(proxy.port, '/_pleiad/s/s1/files', { headers: { ...cookie, 'sec-fetch-site': value } });
    t.ok('ファイルページは、ほかのサイトから始まった要求を断る（ホストの入口と同じ）', (await site('cross-site')).status === 403 && (await site('same-site')).status === 403);
    t.ok('同じ origin とアドレスバーからの要求は通し、出どころをホストへ渡す', (await site('same-origin')).status === 200 &&
      heads.at(-1).headers['sec-fetch-site'] === 'same-origin' && (await site('none')).status === 200);
    t.ok('転送には端末の両ポートだけを添え token・Cookie は送らない', heads.at(-1).pagePorts.main === proxy.port &&
      heads.at(-1).pagePorts.isolated === proxy.isolatedPort && !heads.at(-1).headers.cookie && !heads.at(-1).path.includes('token='));
    t.ok('本体は Host が違うと断る', (await request(proxy.port, '/', { ...isolated, headers: cookie })).status === 403);
    t.ok('隔離待ち受けは 127.0.0.1 の Host を断る', (await request(proxy.isolatedPort, '/viz/key/index.html')).status === 403);
    const viz = await request(proxy.isolatedPort, `/viz/key/index.html?token=${proxy.token}`, { ...isolated, headers: cookie });
    t.ok('localhost の隔離待ち受けは Cookie なしでキー付きの道を転送する', viz.status === 200 && !viz.headers['set-cookie'] &&
      heads.at(-1).destination === 'isolated' && !heads.at(-1).headers.cookie && !heads.at(-1).path.includes('token='));
    for (const path of ['/', '/api/env', '/_pleiad/s/s1/files', '/ws', '/viz/../api/env']) {
      t.ok(`隔離から本体の道を読めない: ${path}`, (await request(proxy.isolatedPort, path, isolated)).status === 403);
    }
    t.ok('隔離とページは GET・HEAD だけ', (await request(proxy.isolatedPort, '/f/key/a.html', { ...isolated, method: 'POST' })).status === 405 &&
      (await request(proxy.port, '/_pleiad/s/s1/files', { headers: cookie, method: 'POST' })).status === 405);
    if (proxy.isolatedServers.length === 2) {
      t.ok('localhost が IPv6 を選んでも同じ隔離 port で読める',
        (await request(proxy.isolatedPort, '/viz/key/index.html', { ...isolated, host: '::1' })).status === 200);
    }
    t.ok('端末自身も Content-Length の上限を検査する',
      (await request(proxy.port, '/_pleiad/s/s1/api/declared', { headers: cookie })).status === 502);
    t.ok('端末自身も圧縮されたページ応答を断る',
      (await request(proxy.port, '/_pleiad/s/s1/api/compressed', { headers: cookie })).status === 502);
    const large = await request(proxy.port, '/_pleiad/s/s1/api/large', { headers: cookie });
    t.ok('端末自身も実際のテキストを数えて 8 MiB で切る', large.aborted && large.bytes <= 8 * 1024 * 1024);
    const raw = await request(proxy.port, '/_pleiad/s/s1/api/raw?large=1', { headers: cookie });
    t.ok('端末の raw は 8 MiB を越えて読める', !raw.aborted && raw.bytes === 9 * 1024 * 1024);
    const rawHuge = await request(proxy.port, '/_pleiad/s/s1/api/raw?huge=1', { headers: cookie });
    t.ok('端末の raw も 32 MiB で切る', rawHuge.aborted && rawHuge.bytes <= 32 * 1024 * 1024);
    t.ok('端末の HEAD は大きなファイルの長さだけを返せる',
      (await request(proxy.port, '/_pleiad/s/s1/api/declared', { method: 'HEAD', headers: cookie })).status === 200);
    const huge = await request(proxy.isolatedPort, '/f/key/huge.html', isolated);
    t.ok('端末の隔離応答は 32 MiB で切り、転送も取り消す', huge.aborted && huge.bytes <= 32 * 1024 * 1024 && resets >= 4 && releases > 0);
    const origin = `http://127.0.0.1:${proxy.port}`, iso = `http://localhost:${proxy.isolatedPort}`;
    t.ok('登録済みの隔離 origin だけはホスト専用リンクと誤認しない', !isHostOnlyUrl(`${iso}/viz/key/index.html`, origin, iso) &&
      isHostOnlyUrl(`${iso}/api/env`, origin, iso) && isHostOnlyUrl('http://localhost:9999/viz/key/', origin, iso) &&
      isHostOnlyUrl(`${iso}/f/key/a.html`, origin));
    const handlers = {};
    let prevented = false;
    const stop = watchHostOnlyLinks({ root: { addEventListener: (k, fn) => { handlers[k] = fn; }, removeEventListener: k => { delete handlers[k]; } },
      onHostScreen: () => false, origin: () => origin, isolatedOrigin: () => iso, notify: () => {} });
    handlers.click({ target: { closest: () => ({ getAttribute: () => `${iso}/viz/key/index.html` }) }, preventDefault: () => { prevented = true; } });
    t.ok('リンク監視にも隔離 origin を渡せる', !prevented); stop();
  } finally { await proxy.close(); }
  const originalListen = http.Server.prototype.listen;
  const makeProxy = () => {
    const p = new DeviceProxy({ creds: {}, keyPair: {} });
    p.link.start = () => {}; p.link.stop = () => {}; p.link.ready = proxy.link.ready;
    return p;
  };
  const retry = makeProxy();
  let collision = true;
  http.Server.prototype.listen = function(...args) {
    if (args[0]?.host === '::1' && collision) {
      collision = false;
      queueMicrotask(() => this.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' })));
      return this;
    }
    return originalListen.apply(this, args);
  };
  try {
    await retry.start();
    t.ok('IPv6 のポート競合では両側を取り直してから隔離 port を公開する', retry.isolatedPort > 0 &&
      (await request(retry.isolatedPort, '/viz/key/index.html', { authority: `localhost:${retry.isolatedPort}` })).status === 200);
  } finally { http.Server.prototype.listen = originalListen; await retry.close(); }
  const fallback = makeProxy();
  http.Server.prototype.listen = function(...args) {
    if (this !== fallback.server) {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('unavailable'), { code: 'EACCES' })));
      return this;
    }
    return originalListen.apply(this, args);
  };
  try {
    await fallback.start();
    t.ok('隔離の待ち受けに失敗しても従来の本体は起動する', fallback.isolatedPort === 0 &&
      (await request(fallback.port, `/?token=${fallback.token}`)).status === 200);
  } finally { http.Server.prototype.listen = originalListen; await fallback.close(); }
  t.ok('閉じると本体と隔離の両方の待ち受けを解放する', !proxy.server.listening && proxy.isolatedServers.every(s => !s.listening));
}
