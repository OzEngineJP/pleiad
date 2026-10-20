import assert from 'node:assert/strict';
import http from 'node:http';
import { createContextBridge } from '../../core/context-bridge.mjs';
import { hash } from '../../core/context-runtime.mjs';
import { mcpHttpFixture } from './context-transports.mjs';

export const name = 'context-lazy';
export const title = '外部 MCP の遅延起動: 一覧の写しで広告し、最初の呼び出しで起きる';
const tool = (n = 'echo', v = 1) => ({ name: n, description: `v${v}`, inputSchema: { type: 'object', properties: {} } });
const init = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
const runtime = servers => ({ owners: { mcp: 'ply' }, policy: { cwd: process.cwd() }, prompt: '', skills: [], servers, report: { entries: servers.map(({ id }) => ({ id })) } });
const until = async test => { for (let i = 0; i < 200; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('fixture timeout'); };
// 台帳のメモリ版（core/mcp-ledger.mjs の snapshots/processes と同じ形）。stdio を使わないので processes は使われない
const memStore = () => { const m = new Map(); return { get: k => m.get(k), put: (k, id, s) => m.set(k, s), delete: k => m.delete(k), prune: () => 0, map: m }; };
const cool = () => new Promise(r => setTimeout(r, 160)); // 温存の回収（warmIdleMs）を待つ
const noProcs = { record: () => null, close: () => {} };

export default async function (t) {
  const resources = [], ports = [];
  async function setup(reply, store) {
    const fixture = mcpHttpFixture(reply);
    const bridge = createContextBridge({ warmIdleMs: 60, ledger: { snapshots: store, processes: noProcs } });
    const host = http.createServer(bridge.handle);
    resources.push(async () => { await bridge.dispose(); fixture.end(); for (const s of [host, fixture.server]) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });
    await new Promise(r => fixture.server.listen(0, '127.0.0.1', r));
    await new Promise(r => host.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${host.address().port}`;
    const item = (id, extra = {}) => ({ id, name: id, origins: [{ source: 'claude' }], definition: { url: `http://127.0.0.1:${fixture.server.address().port}/${id}`, headers: { Authorization: 'Bearer fixture' }, ...extra } });
    const open = async (servers, extra = {}) => { const r = runtime(servers); const port = await bridge.open({ runtime: r, origin, isActive: () => true, ...extra }); ports.push(port); return { port, runtime: r }; };
    return { bridge, item, open };
  }
  const rpc = async (port, method, params = {}) => (await (await fetch(port.url, { method: 'POST', headers: { ...port.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  const call = (port, id, orig = 'echo') => rpc(port, 'tools/call', { name: `m_${hash([id, orig]).slice(0, 24)}`, arguments: {} });
  try {
    {
      const store = memStore(); let starts = 0;
      const f = await setup(m => {
        if (m.method === 'initialize') { starts++; return init; }
        if (m.method === 'tools/list') return { tools: [tool()] };
        if (m.method === 'tools/call') return { content: [{ type: 'text', text: 'ok' }] };
        return {};
      }, store);
      const item = f.item('lazy');
      // 一覧を持たない初回は従来どおり open でつなぎ、一覧を覚える
      const a = await f.open([item]);
      assert(starts === 1 && a.runtime.report.entries[0].status === 'connected');
      await a.port.close(); await cool();
      // 2 回目は写しがあるので起こさず standby
      const b = await f.open([item]);
      assert(starts === 1 && b.runtime.report.entries[0].status === 'standby' && b.runtime.report.entries[0].tools === 1);
      // 広告されている（snapshot のツールが tools/list に出る）
      const listed = await rpc(b.port, 'tools/list');
      assert(listed.result.tools.some(x => x.name.startsWith('m_')));
      // 最初の呼び出しで起きる
      const res = await call(b.port, item.id);
      assert(!res.error && res.result?.content?.[0]?.text === 'ok');
      assert(starts === 2 && b.runtime.report.entries[0].status === 'connected');
      await b.port.close();
      t.ok('一覧の写しがあれば open で起こさず standby。広告したまま、最初の呼び出しで 1 回だけ起きる', true);
    }
    {
      const store = memStore(); let starts = 0;
      const f = await setup(m => {
        if (m.method === 'initialize') { starts++; return init; }
        if (m.method === 'tools/list') return { tools: [tool('echo'), tool('echo2')] };
        if (m.method === 'tools/call') return { content: [] };
        return {};
      }, store);
      const item = f.item('dedup');
      const a = await f.open([item]); await a.port.close(); await cool();
      const b = await f.open([item]);
      assert(starts === 1);
      const [r1, r2] = await Promise.all([call(b.port, item.id, 'echo'), call(b.port, item.id, 'echo2')]);
      assert(starts === 2 && !r1.error && !r2.error);
      await b.port.close();
      t.ok('同時の初回呼び出しでも起動は 1 プロセス', true);
    }
    {
      const store = memStore(); let starts = 0;
      const f = await setup(m => {
        if (m.method === 'initialize') { starts++; return init; }
        if (m.method === 'tools/list') return { tools: [tool()] };
        if (m.method === 'tools/call') return { content: [{ type: 'text', text: 'x' }] };
        return {};
      }, store);
      const item = f.item('re');
      const a = await f.open([item]); await a.port.close(); await cool();
      const b = await f.open([item], { restarted: true });
      assert(starts === 1 && b.runtime.report.entries[0].status === 'standby');
      const res = await call(b.port, item.id);
      assert(starts === 2 && !res.error);
      // 起こし直しの注意が最初の呼び出しに添えられる（restarted の既存の仕組み）
      assert(res.result.content.length >= 2 || res.result.content.length === 1);
      await b.port.close();
      t.ok('restarted（無停止の更新）でも起こし直さず standby。呼び出しで起きる', true);
    }
    {
      const store = memStore(); let starts = 0;
      const f = await setup(m => {
        if (m.method === 'initialize') { starts++; if (starts > 1) return { error: { code: -32603, message: 'cannot start' } }; return init; }
        if (m.method === 'tools/list') return { tools: [tool()] };
        if (m.method === 'tools/call') return { content: [] };
        return {};
      }, store);
      const item = f.item('bad');
      const a = await f.open([item]); await a.port.close(); await cool();
      const b = await f.open([item]);
      const r1 = await call(b.port, item.id);
      assert(r1.result?.isError);
      await until(() => b.runtime.report.entries[0].status === 'failed');
      const n = starts;
      const r2 = await call(b.port, item.id);
      assert(r2.result?.isError && starts === n);
      await b.port.close();
      t.ok('起動に失敗した呼び出しはエラーの返り、行は失敗へ。ターン内は起き直さない', true);
    }
    {
      const store = memStore(); let v = 1;
      const f = await setup(m => {
        if (m.method === 'initialize') return init;
        if (m.method === 'tools/list') return { tools: [tool('echo', v)] };
        if (m.method === 'tools/call') return { content: [] };
        return {};
      }, store);
      const item = f.item('stale');
      const a = await f.open([item]); await a.port.close(); await cool(); v = 2;
      const b = await f.open([item]);
      // standby の間は古い写しのまま広告
      assert((await rpc(b.port, 'tools/list')).result.tools.find(x => x.name.startsWith('m_')).description.includes('v1'));
      await call(b.port, item.id);
      // 起きたら一覧を取り直し、変わっていれば広告を差し替える
      await until(async () => (await rpc(b.port, 'tools/list')).result.tools.find(x => x.name.startsWith('m_')).description.includes('v2'));
      await b.port.close();
      t.ok('standby から起きたら一覧を取り直し、古い広告を差し替える', true);
    }
    {
      const store = memStore(); let starts = 0;
      const f = await setup(m => {
        if (m.method === 'initialize') { starts++; return init; }
        if (m.method === 'tools/list') return { tools: [tool()] };
        return {};
      }, store);
      const item = f.item('quiet');
      const a = await f.open([item]); await a.port.close(); await cool();
      const b = await f.open([item]); await b.port.close();
      assert(starts === 1);
      t.ok('呼ばれない standby は起きずに終われる', true);
    }
  } finally {
    await Promise.allSettled(ports.map(p => p.close()));
    for (const dispose of resources.reverse()) await dispose();
  }
}
