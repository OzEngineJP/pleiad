import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { forwardStream, pageResponseLimit } from '../../core/remote/forward.mjs';
import { RESET_CODE } from '../../core/remote/frames.mjs';

export const name = 'remote-forward-pages';
export const title = 'スマホのページ転送: 行き先・認証・Cookie の隔離・応答上限';

class Stream extends EventEmitter {
  constructor(request, kind = 'http') {
    super(); this.request = request; this.kind = kind; this.bytes = 0; this.chunks = [];
    this.done = new Promise(resolve => { this.finish = resolve; });
  }
  respond(head) { this.head = head; return Promise.resolve(); }
  write(chunk) { this.bytes += chunk.length; if (this.bytes < 4096) this.chunks.push(chunk); return Promise.resolve(); }
  end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.finish(this); return Promise.resolve(); }
  reset(code) { this.code = code; this.destroyed = true; this.emit('reset', code); this.finish(this); }
}

export default async function(t) {
  const requests = [];
  const handle = (req, res) => {
    requests.push({ path: req.url, headers: req.headers, method: req.method, port: req.socket.localPort });
    if (req.url.includes('declared')) { res.writeHead(200, { 'content-length': 40 * 1024 * 1024 }); return res.end(); }
    if (req.url.includes('compressed')) { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end('compressed'); }
    const isolatedOrigin = `http://localhost:${isolatedServer.address().port}`;
    res.writeHead(200, { 'set-cookie': 'host-secret=hidden', 'content-security-policy': `frame-src ${isolatedOrigin}; connect-src ${isolatedOrigin}0 ${isolatedOrigin}/assets/` });
    const size = req.url.includes('large') ? 9 * 1024 * 1024 : req.url.includes('huge') ? 33 * 1024 * 1024 : 2;
    let sent = 0;
    const pump = () => {
      while (!res.destroyed && sent < size) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, size - sent), 120); sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      if (!res.destroyed) res.end();
    };
    pump();
  };
  const server = http.createServer(handle);
  const isolatedServer = http.createServer(handle);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  isolatedServer.listen(0, '127.0.0.1'); await once(isolatedServer, 'listening');
  const target = () => ({ host: '127.0.0.1', port: server.address().port });
  const pagePorts = { main: target().port, pages: 7421, isolated: isolatedServer.address().port };
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => ws.send(JSON.stringify({ kind: 'response', result: { browserUnify: { pages: pagePorts.pages, isolated: pagePorts.isolated } } })));
  const localPorts = { main: 51234, isolated: 51235 };
  const run = async (path, extra = {}, options = {}) => {
    const stream = new Stream({ method: 'GET', path, ...extra }, options.kind);
    forwardStream(stream, { target, token: 'host-ui', pagePorts, ...options });
    return await Promise.race([stream.done, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('forward timeout')), 5000); timer.unref();
      stream.done.finally(() => clearTimeout(timer));
    })]);
  };
  try {
    const page = await run('/_pleiad/s/s1/files?token=device&path=a', { pagePorts: localPorts,
      headers: { cookie: 'device-secret', authorization: 'bearer device', host: 'evil', 'x-pleiad-page-ports': 'evil', 'accept-encoding': 'gzip' } });
    const req = requests.at(-1);
    t.ok('ファイルページはホストの Cookie で読み、端末の token・Cookie・Authorization を落とす',
      page.head.status === 200 && req.port === pagePorts.main && req.path === '/_pleiad/s/s1/files?path=a' && req.headers.cookie === 'agent_host_token=host-ui' && !req.headers.authorization);
    t.ok('認証済みの端末 origin をヘッダーへ渡し、CSP を端末の隔離 port に直す',
      JSON.parse(req.headers['x-pleiad-page-ports']).pages === localPorts.main && req.headers['accept-encoding'] === 'identity' &&
      page.head.headers['content-security-policy'] === `frame-src http://localhost:51235; connect-src http://localhost:${pagePorts.isolated}0 http://localhost:${pagePorts.isolated}/assets/`);
    t.ok('ホストの Set-Cookie は端末へ渡さない', !page.head.headers['set-cookie']);
    const isolated = await run('/viz/key/index.html?token=device', { destination: 'isolated', pagePorts: localPorts,
      headers: { cookie: 'secret', authorization: 'secret', origin: 'http://evil' } });
    t.ok('隔離の port へ localhost の Host で転送し Cookie・Authorization・Origin を付けない', isolated.head.status === 200 &&
      requests.at(-1).port === pagePorts.isolated && requests.at(-1).headers.host === `localhost:${pagePorts.isolated}` && !requests.at(-1).headers.cookie &&
      !requests.at(-1).headers.authorization && !requests.at(-1).headers.origin && requests.at(-1).path === '/viz/key/index.html');
    for (const path of ['/', '/ws', '/api/env', '/viz/../../mcp', '/f/../api/env', '//evil/viz/key']) {
      const r = await run(path, { destination: 'isolated' });
      t.ok(`隔離から本体へ抜ける道を断る: ${path}`, r.code === RESET_CODE.FORBIDDEN);
    }
    t.ok('隔離は WebSocket を通さない', (await run('/ws', { destination: 'isolated' }, { kind: 'ws' })).code === RESET_CODE.FORBIDDEN);
    t.ok('不明な行き先を断る', (await run('/_pleiad/s/s1/files', { destination: 'other' })).code === RESET_CODE.FORBIDDEN);
    t.ok('ページの port が未設定なら旗 off の道へ足さない',
      (await run('/_pleiad/s/s1/files', {}, { pagePorts: null })).code === RESET_CODE.FORBIDDEN &&
      (await run('/viz/key/x', { destination: 'isolated' }, { pagePorts: null })).code === RESET_CODE.FORBIDDEN);
    t.ok('ページの変更系メソッドを断る', (await run('/_pleiad/s/s1/files', { method: 'POST' })).code === RESET_CODE.FORBIDDEN);
    t.ok('ページのテキストは実際の本体を数えて 8 MiB で切る', (await run('/_pleiad/s/s1/api/large')).code === RESET_CODE.FORBIDDEN);
    const raw = await run('/_pleiad/s/s1/api/raw?large=1');
    t.ok('api/raw は 8 MiB を越えても 32 MiB までは通す', raw.code == null && raw.bytes === 9 * 1024 * 1024);
    t.ok('api/raw も 32 MiB で切る', (await run('/_pleiad/s/s1/api/raw?huge=1')).code === RESET_CODE.FORBIDDEN);
    t.ok('隔離の本体も 32 MiB で切る', (await run('/f/key/huge.html', { destination: 'isolated' })).code === RESET_CODE.FORBIDDEN);
    t.ok('Content-Length が上限を越えたら本体を待たずに断る', (await run('/_pleiad/s/s1/api/declared')).code === RESET_CODE.FORBIDDEN);
    t.ok('identity を無視した圧縮応答は断る', (await run('/_pleiad/s/s1/api/compressed')).code === RESET_CODE.FORBIDDEN);
    t.ok('HEAD は大きなファイルの長さだけを返せる', (await run('/_pleiad/s/s1/api/raw?declared=1', { method: 'HEAD' })).head.status === 200);
    t.ok('上限は正規化したページの道で判定する', pageResponseLimit('/a/../_pleiad/s/s1/api/raw') === 32 * 1024 * 1024 &&
      pageResponseLimit('/%5fpleiad/s/s1/files') === 8 * 1024 * 1024 && pageResponseLimit('/local-file') === 0);
    const readCaps = async (hostPorts, devicePorts) => {
      const stream = new Stream({ path: '/ws', pagePorts: devicePorts }, 'ws');
      stream.accept = () => Promise.resolve();
      stream.send = data => { stream.caps = JSON.parse(data); stream.reset(RESET_CODE.CANCEL); return Promise.resolve(); };
      forwardStream(stream, { target, token: 'host-ui', pagePorts: hostPorts });
      await stream.done;
      return stream;
    };
    const caps = await readCaps(pagePorts, localPorts);
    t.ok('ホストの機能応答の port を端末の待ち受けに直す', caps.caps.result.browserUnify.pages === localPorts.main &&
      caps.caps.result.browserUnify.isolated === localPorts.isolated);
    t.ok('旗 off の転送は応答の port を変えない',
      (await readCaps(null, localPorts)).caps.result.browserUnify.isolated === pagePorts.isolated);
    t.ok('端末の隔離待ち受けが無ければ新機能を案内しない',
      !(await readCaps(pagePorts, { main: 51234, isolated: 0 })).caps.result.browserUnify);
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    for (const s of [server, isolatedServer]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  }
}
