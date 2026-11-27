import http from 'node:http';
import net from 'node:net';
import { createContextBridge } from '../../core/context-bridge.mjs';
import { hash } from '../../core/context-runtime.mjs';
import { mcpHttpFixture } from './context-transports.mjs';

export const name = 'context-bridge-timeouts';
export const title = '外部 MCP の中継: 本文の無通信の上限は、本文を読む間だけに効く';
const IDLE_MS = 150;
const tool = { name: 'slow', inputSchema: { type: 'object', properties: {} } };
const init = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const memStore = () => { const m = new Map(); return { get: k => m.get(k), put: (k, id, s) => m.set(k, s), delete: k => m.delete(k), prune: () => 0 }; };
const noProcs = { record: () => null, close: () => {} };

export default async function (t) {
  let slowInit = false;
  const fixture = mcpHttpFixture(async m => {
    if (m.method === 'initialize') { if (slowInit) await sleep(IDLE_MS * 3); return init; }
    if (m.method === 'tools/list') return { tools: [tool] };
    if (m.method === 'tools/call') { await sleep(IDLE_MS * 3); return { content: [{ type: 'text', text: 'SLOW_OK' }] }; }
    return {};
  });
  const bridge = createContextBridge({ warmIdleMs: 60, bodyIdleMs: IDLE_MS, ledger: { snapshots: memStore(), processes: noProcs } });
  const host = http.createServer(bridge.handle);
  const ports = [];
  try {
    await new Promise(r => fixture.server.listen(0, '127.0.0.1', r));
    await new Promise(r => host.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${host.address().port}`;
    const item = { id: 'slow', name: 'slow', origins: [{ source: 'claude' }], definition: { url: `http://127.0.0.1:${fixture.server.address().port}/slow`, headers: { Authorization: 'Bearer fixture' } } };
    const open = async () => { const runtime = { owners: { mcp: 'ply' }, policy: { cwd: process.cwd() }, prompt: '', skills: [], servers: [item], report: { entries: [{ id: item.id }] } }; const port = await bridge.open({ runtime, origin, isActive: () => true }); ports.push(port); return { port, runtime }; };
    const call = async port => (await (await fetch(port.url, { method: 'POST', headers: { ...port.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `m_${hash([item.id, tool.name]).slice(0, 24)}`, arguments: {} } }) })).json());

    const a = await open();
    const direct = await call(a.port);
    t.ok('本文の上限より長くかかるツールの答えも、接続を切らずに返す', direct.result?.content?.[0]?.text === 'SLOW_OK', JSON.stringify(direct));
    await a.port.close(); await sleep(160);

    // 一覧の写しで standby になった MCP の最初の呼び出し（起動＋実行）も、本文の上限で切らない
    slowInit = true;
    const b = await open();
    const standby = b.runtime.report.entries[0].status === 'standby';
    const woken = await call(b.port);
    t.ok('standby の MCP を起こす最初の呼び出しが上限より長くても返す', standby && woken.result?.content?.[0]?.text === 'SLOW_OK' && b.runtime.report.entries[0].status === 'connected', JSON.stringify({ standby, woken }));
    await b.port.close();

    // 本文を送り切らない依頼は、無通信の上限で切る
    const c = await open();
    const url = new URL(c.port.url);
    const cut = await new Promise(resolve => {
      const started = Date.now();
      const socket = net.connect(Number(url.port), url.hostname, () => {
        socket.write(`POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${c.port.headers.Authorization}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"jsonrpc"`);
      });
      socket.on('error', () => {});
      socket.on('close', () => resolve(Date.now() - started));
      setTimeout(() => { socket.destroy(); resolve(null); }, IDLE_MS * 20).unref();
    });
    t.ok('本文を送り切らない依頼は、無通信の上限で切る', cut !== null && cut >= IDLE_MS - 20, String(cut));
  } finally {
    await Promise.allSettled(ports.map(p => p.close()));
    await bridge.dispose(); fixture.end();
    for (const s of [host, fixture.server]) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  }
}
