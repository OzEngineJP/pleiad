import assert from 'node:assert/strict';
import http from 'node:http';
import { connectServer, createContextBridge, listAllPages } from '../../core/context-bridge.mjs';
import { hash } from '../../core/context-runtime.mjs';
import { mcpHttpFixture } from './context-transports.mjs';

export const name = 'context-paging';
export const title = '外部 MCP の一覧: 件数の上限なし・進まないページングで止まる・同名ツールは 1 件';
const init = { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fixture', version: '1' } };
const tool = (n, description) => ({ name: n, description, inputSchema: { type: 'object', properties: {} } });
const code = async fn => { try { await fn(); } catch (e) { return typeof e.code === 'string' ? e.code : e.name; } return null; };
const NOT_ADVANCING = /先に進まない|not advancing/;

export default async function (t) {
  const cleanup = [];
  async function upstream(reply) {
    const fixture = mcpHttpFixture(m => m.method === 'initialize' ? init : reply(m));
    await new Promise(r => fixture.server.listen(0, '127.0.0.1', r));
    cleanup.push(async () => { fixture.end(); fixture.server.closeAllConnections(); await new Promise(r => fixture.server.close(r)); });
    return { id: 'paging', name: 'paging', origins: [{ source: 'claude' }], definition: { url: `http://127.0.0.1:${fixture.server.address().port}/x`, headers: { Authorization: 'Bearer fixture' } } };
  }
  async function connect(reply, logs) {
    const result = await connectServer(await upstream(reply), { cwd: process.cwd(), log: m => logs?.push(m) });
    cleanup.push(async () => { await result.client?.close().catch(() => {}); });
    return result;
  }
  try {
    {
      // listAllPages の単体
      const pagesOf = (...pages) => async cursor => pages[cursor ? Number(cursor) : 0];
      const ok = await listAllPages(pagesOf({ tools: [{ name: 'a' }], nextCursor: '1' }, { tools: [{ name: 'b' }] }));
      assert.equal(ok.length, 2);
      assert.equal(await code(() => listAllPages(async () => ({ tools: [{ name: 'a' }], nextCursor: 'same' }))), 'PAGING_LOOP', 'cursor repeat');
      assert.equal(await code(() => listAllPages(pagesOf({ tools: [{ name: 'a' }], nextCursor: '1' }, { tools: [], nextCursor: '2' }, { tools: [] }))), 'PAGING_LOOP', 'empty page');
      assert.equal(await code(() => listAllPages(pagesOf({ tools: [{ name: 'a' }], nextCursor: '1' }, { tools: [{ name: 'a' }], nextCursor: '2' }, { tools: [] }))), 'PAGING_LOOP', 'only seen names');
      // 最後のページは空でもよい（nextCursor が無ければ終わり）
      assert.equal((await listAllPages(pagesOf({ tools: [{ name: 'a' }], nextCursor: '1' }, { tools: [] }))).length, 2);
      // ページが多くても遅くても通る（時間の上限が無い）
      const many = await listAllPages(async cursor => { const n = Number(cursor ?? 0); await new Promise(r => setTimeout(r, 5)); return { tools: [{ name: `t${n}` }], ...(n < 60 ? { nextCursor: String(n + 1) } : {}) }; });
      assert.equal(many.length, 61);
      // signal で止まる
      const ctl = new AbortController();
      const stopped = await code(() => listAllPages(async cursor => { ctl.abort(); return { tools: [{ name: `x${cursor}` }], nextCursor: `${cursor}+` }; }, { signal: ctl.signal }));
      assert.equal(stopped, 'AbortError');
      t.ok('listAllPages: カーソルの再出現・新しい項目の無いページで PAGING_LOOP。多くても遅くても通り、signal で止まる', true);
    }
    {
      // 600 件（6 ページ）でも connected
      const r = await connect(m => {
        if (m.method !== 'tools/list') return {};
        const page = Number(m.params?.cursor ?? 0);
        return { tools: Array.from({ length: 100 }, (_, i) => tool(`t${page * 100 + i}`)), ...(page < 5 ? { nextCursor: String(page + 1) } : {}) };
      });
      assert.equal(r.status, 'connected'); assert.equal(r.tools.length, 600);
      t.ok('501 件以上（600 件・6 ページ）でも connected になり、全件返る', true);
    }
    {
      const r = await connect(m => m.method === 'tools/list' ? { tools: [tool('a')], nextCursor: 'same' } : {});
      assert.equal(r.status, 'failed'); assert.match(r.reason, NOT_ADVANCING);
      let n = 0;
      const e = await connect(m => m.method === 'tools/list' ? { tools: [], nextCursor: `n${n++}` } : {});
      assert.equal(e.status, 'failed'); assert.match(e.reason, NOT_ADVANCING);
      t.ok('tools/list: カーソルの再出現・空ページで nextCursor が出続けたら、失敗の理由が利用者向けの文言になる', true);
    }
    {
      const logs = [];
      const r = await connect(m => m.method === 'tools/list' ? { tools: [tool('dup', 'first'), tool('dup', 'second'), tool('other')] } : {}, logs);
      assert.deepEqual(r.tools.map(x => x.name), ['dup', 'other']); assert.equal(r.tools[0].description, 'first');
      await r.list(); await r.list();
      assert.equal(logs.filter(l => l.includes('duplicate tool "dup"')).length, 1);
      t.ok('同名ツールは最初の 1 件だけ残り、捨てたログは更新しても 1 回だけ', true);
    }
    {
      // bridge を通す: 同名ツールで tools と呼び出し先が一致し、resources/prompts の進まないページングは文言で失敗する
      const item = await upstream(m => {
        if (m.method === 'tools/list') return { tools: [tool('dup', 'first'), tool('dup', 'second')] };
        if (m.method === 'resources/list') return { resources: [{ name: 'g', uri: 'fixture://g' }], nextCursor: 'same' };
        if (m.method === 'prompts/list') return { prompts: [{ name: 'p' }], nextCursor: 'same' };
        if (m.method === 'tools/call') return { content: [{ type: 'text', text: 'CALLED' }] };
        return {};
      });
      const bridge = createContextBridge(), host = http.createServer(bridge.handle);
      cleanup.push(async () => { await bridge.dispose(); host.closeAllConnections(); await new Promise(r => host.close(r)); });
      await new Promise(r => host.listen(0, '127.0.0.1', r));
      const runtime = { owners: { mcp: 'ply' }, policy: { cwd: process.cwd() }, prompt: '', skills: [], servers: [item], report: { entries: [{ id: item.id }] } };
      const port = await bridge.open({ runtime, origin: `http://127.0.0.1:${host.address().port}`, isActive: () => true });
      const rpc = async (method, params = {}) => (await (await fetch(port.url, { method: 'POST', headers: { ...port.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
      const listed = (await rpc('tools/list')).result.tools.filter(x => x.name.startsWith('m_'));
      const expected = `m_${hash([item.id, 'dup']).slice(0, 24)}`;
      assert.deepEqual(listed.map(x => x.name), [expected]);
      assert.match(listed[0].description, /first/);
      assert.equal((await rpc('tools/call', { name: expected })).result.content[0].text, 'CALLED');
      for (const method of ['resources/list', 'prompts/list']) assert.match(JSON.stringify(await rpc(method)), NOT_ADVANCING);
      await port.close();
      t.ok('bridge を通しても、同名ツールは tools と呼び出し先が 1 件で一致し、resources/prompts の進まないページングは文言で失敗する', true);
    }
  } finally { for (const close of cleanup.reverse()) await close(); }
}
