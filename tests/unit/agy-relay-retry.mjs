// agy の中継（core/agy-context-relay.mjs）の再試行（無停止の更新 段階 3）。サーバーが入れ替わる間（口が閉じて開き直すまで 1〜数秒）にツールを引く・呼ぶと、
// 中継が「つながる前の失敗」だけ数秒やり直し、agy にはエラーを見せない。つながった後の切れ（ECONNRESET など）は呼び出しが二重に走りうるので、やり直さない。
// 待つ上限は PLY_RELAY_RETRY_MS（0 で再試行しない）。中継は本物のプロセス、口は本物の HTTP サーバー（閉じて、開き直す）
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../lib/server.mjs';

export const name = 'agy-relay-retry';
export const title = 'agy の中継: 口が数秒つながらなくても、つながる前の失敗だけやり直す';

const AUTH = `Bearer ${'a'.repeat(64)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 空きポートを 1 つ決める（閉じた口の代わり） */
async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/** 中継を起こし、JSON-RPC を 1 つ流して、返事を待つ。{ reply, ms } */
async function ask(port, message, { retryMs, env = {}, onSpawn } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'core', 'agy-context-relay.mjs')], {
    env: { ...process.env, PLY_CONTEXT_URL: `http://127.0.0.1:${port}/mcp/context`, PLY_CONTEXT_AUTHORIZATION: AUTH, ...(retryMs !== undefined ? { PLY_RELAY_RETRY_MS: String(retryMs) } : {}), ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  const started = Date.now();
  onSpawn?.();
  const got = new Promise(resolve => child.stdout.on('data', chunk => { out += chunk; if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0])); }));
  child.stdin.write(`${JSON.stringify(message)}\n`);
  try { return { reply: await Promise.race([got, sleep(30_000).then(() => null)]), ms: Date.now() - started }; }
  finally { child.kill(); }
}

export default async function (t) {
  const listed = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const serve = (port, onRequest) => new Promise(resolve => {
    const server = http.createServer(onRequest);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
  const ok = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  // 閉じた口が、中継の再試行の間に開き直る: エラーにならず、開いた後の返事が返る
  {
    const port = await freePort();
    let server = null;
    let opened;
    try {
      const { reply, ms } = await ask(port, listed, { onSpawn: () => {
        opened = (async () => { await sleep(700); server = await serve(port, (req, res) => { req.resume(); req.on('end', () => ok(res, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'after_reopen' }] } })); }); })();
      } });
      await opened;
      t.ok('閉じた口が数秒で開き直せば、中継は再試行して返事を返す（エラーを agy に見せない）', reply?.result?.tools?.[0]?.name === 'after_reopen' && !reply.error, JSON.stringify(reply));
      t.ok('返事は口が開いた後に届く（待った分だけ遅れる）', ms >= 600, `${ms} ms`);
    } finally { server?.close(); }
  }

  // 開かないままなら、上限（PLY_RELAY_RETRY_MS）でエラーにする
  {
    const port = await freePort();
    const { reply, ms } = await ask(port, listed, { retryMs: 600 });
    t.ok('開かないままなら、上限の後に「つながらない」のエラーを返す（中継は落ちない）', reply?.error?.code === -32603 && /Pleiad/.test(reply.error.message), JSON.stringify(reply));
    t.ok('上限を過ぎるまでは待つ', ms >= 500 && ms < 10_000, `${ms} ms`);
  }

  // 再試行なし（0）: 今までどおり即エラー
  {
    const port = await freePort();
    const { reply, ms } = await ask(port, listed, { retryMs: 0 });
    t.ok('PLY_RELAY_RETRY_MS=0 は再試行しない（即エラー）', reply?.error?.code === -32603 && ms < 3000, `${ms} ms ${JSON.stringify(reply)}`);
  }

  // つながった後の切れは、やり直さない（呼び出しが二重に走りうる）
  {
    const port = await freePort();
    let hits = 0;
    const server = await serve(port, req => { hits++; req.socket.destroy(); });
    try {
      const { reply } = await ask(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'once', arguments: {} } });
      t.ok('つながった後の切れは再試行しない（呼び出しは 1 回だけ届く）。エラーは返る', hits === 1 && reply?.error?.code === -32603, `hits=${hits} ${JSON.stringify(reply)}`);
    } finally { server.close(); }
  }

  // 口が開いていれば、今までどおり 1 回で返る（401 などの HTTP のエラーはやり直さない）
  {
    const port = await freePort();
    let hits = 0;
    const server = await serve(port, (req, res) => { hits++; req.resume(); req.on('end', () => { res.writeHead(401); res.end(); }); });
    try {
      const { reply } = await ask(port, listed);
      t.ok('HTTP のエラー（401）は再試行しない', hits === 1 && reply?.error?.code === -32001, `hits=${hits} ${JSON.stringify(reply)}`);
    } finally { server.close(); }
  }

  // 正常系（initialize / tools/list / tools/call 成功）では i18n.mjs を読み込まずに軽く起動する
  {
    const port = await freePort();
    const server = await serve(port, (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const msg = JSON.parse(body);
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
          : msg.method === 'tools/list' ? { tools: [{ name: 'ping_tool', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'pong' }] };
        ok(res, { jsonrpc: '2.0', id: msg.id, result });
      });
    });
    const probeHook = 'data:text/javascript,' + encodeURIComponent(
      "import { registerHooks } from 'node:module'; registerHooks({ load(url, ctx, next) { if (url.endsWith('/i18n.mjs')) process.stderr.write('LOADED_I18N\\n'); return next(url, ctx); } });",
    );
    const child = spawn(process.execPath, ['--import', probeHook, path.join(ROOT, 'core', 'agy-context-relay.mjs')], {
      env: { ...process.env, PLY_CONTEXT_URL: `http://127.0.0.1:${port}/mcp/context`, PLY_CONTEXT_AUTHORIZATION: AUTH, PLY_CONTEXT_LOCALE: 'ja' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      let out = '', err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping_tool', arguments: {} } },
      ];
      for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
      for (let i = 0; i < 100 && out.split('\n').filter(Boolean).length < requests.length; i++) await sleep(50);
      const replies = out.split('\n').filter(Boolean).map(line => JSON.parse(line));
      t.ok('正常系（initialize / tools/list / tools/call）は i18n.mjs を読み込まずに成功する',
        replies.length === 3 && replies[0].result?.serverInfo?.name === 'test'
        && replies[1].result?.tools?.[0]?.name === 'ping_tool'
        && replies[2].result?.content?.[0]?.text === 'pong'
        && !err.includes('LOADED_I18N'),
        JSON.stringify({ replies, err }));
    } finally { child.kill(); server.close(); }
  }

  // エラー時は i18n.mjs を遅延読み込みし、ja / en それぞれのロケール文言を返す（401 / 500 / 接続不能）
  {
    const port401 = await freePort();
    const port500 = await freePort();
    const closedPort = await freePort();
    const s401 = await serve(port401, (req, res) => { req.resume(); req.on('end', () => { res.writeHead(401); res.end(); }); });
    const s500 = await serve(port500, (req, res) => { req.resume(); req.on('end', () => { res.writeHead(500); res.end(); }); });
    try {
      const ja401 = (await ask(port401, listed, { env: { PLY_CONTEXT_LOCALE: 'ja' } })).reply;
      const ja500 = (await ask(port500, listed, { env: { PLY_CONTEXT_LOCALE: 'ja' } })).reply;
      const jaDown = (await ask(closedPort, listed, { retryMs: 0, env: { PLY_CONTEXT_LOCALE: 'ja' } })).reply;
      t.ok('日本語ロケールで 401 / 500 / 接続不能のエラー文言を遅延読み込みで返す',
        ja401?.error?.code === -32001 && ja401.error.message.includes('このターンでは使えません')
        && ja500?.error?.code === -32603 && ja500.error.message.includes('HTTP 500') && ja500.error.message.includes('届きません')
        && jaDown?.error?.code === -32603 && jaDown.error.message.includes('届きません'),
        JSON.stringify({ ja401, ja500, jaDown }));

      const en401 = (await ask(port401, listed, { env: { PLY_CONTEXT_LOCALE: 'en' } })).reply;
      const en500 = (await ask(port500, listed, { env: { PLY_CONTEXT_LOCALE: 'en' } })).reply;
      const enDown = (await ask(closedPort, listed, { retryMs: 0, env: { PLY_CONTEXT_LOCALE: 'en' } })).reply;
      t.ok('英語ロケールで 401 / 500 / 接続不能のエラー文言を遅延読み込みで返す',
        en401?.error?.code === -32001 && en401.error.message.includes('not available in this turn')
        && en500?.error?.code === -32603 && en500.error.message.includes('HTTP 500') && en500.error.message.includes('Cannot reach Pleiad context')
        && enDown?.error?.code === -32603 && enDown.error.message.includes('Cannot reach Pleiad context'),
        JSON.stringify({ en401, en500, enDown }));
    } finally { s401.close(); s500.close(); }
  }
}
