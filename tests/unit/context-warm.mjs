import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createContextBridge } from '../../core/context-bridge.mjs';
import { hash } from '../../core/context-runtime.mjs';
import { mcpHttpFixture } from './context-transports.mjs';

export const name = 'context-warm';
export const title = '外部 MCP の並列接続・再利用・一覧キャッシュ・終了時の回収';
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tool = (name = 'echo', version = 1) => ({ name, description: `v${version}`, inputSchema: { type: 'object', properties: version === 1 ? {} : { version: { type: 'number' } } } });
const init = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
const runtime = servers => ({ owners: { mcp: 'ply' }, policy: { cwd: process.cwd() }, prompt: '', skills: [], servers, report: { entries: servers.map(({ id }) => ({ id })) } });
const until = async test => { for (let i = 0; i < 200; i++) { if (await test()) return; await delay(25); } throw new Error('fixture timeout'); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export default async function(t) {
  const resources = [], ports = [];
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-context-warm-'));
  async function setup(reply, options) {
    const fixture = mcpHttpFixture(reply), bridge = createContextBridge(options), host = http.createServer(bridge.handle);
    resources.push(async () => { await bridge.dispose(); fixture.end(); for (const s of [host, fixture.server]) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });
    await new Promise(r => fixture.server.listen(0, '127.0.0.1', r));
    await new Promise(r => host.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${host.address().port}`;
    const item = (id, extra = {}) => ({ id, name: id, origins: [{ source: 'claude' }], definition: { url: `http://127.0.0.1:${fixture.server.address().port}/${id}`, headers: { Authorization: 'Bearer fixture' }, ...extra } });
    const open = async (servers, extra = {}) => { const r = runtime(servers); const port = await bridge.open({ runtime: r, origin, isActive: () => true, ...extra }); ports.push(port); return { port, runtime: r }; };
    return { bridge, item, open };
  }
  const rpc = async (port, method, params = {}) => (await (await fetch(port.url, { method: 'POST', headers: { ...port.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
  const names = async port => (await rpc(port, 'tools/list')).tools.filter(t => t.name.startsWith('m_')).map(t => t.name);
  const call = (port, id, original = 'echo') => rpc(port, 'tools/call', { name: `m_${hash([id, original]).slice(0,24)}`, arguments: {} });
  try {
    {
      const barrier = gate(), eight = gate(), slow = gate();
      let initializing = 0, peak = 0, starts = 0, lists = 0;
      const f = await setup(async (m, req) => {
        if (m.method === 'initialize') { starts++; initializing++; peak = Math.max(peak, initializing); if (starts === 8) eight.resolve(); await barrier.promise; initializing--; return init; }
        if (m.method === 'tools/list') { lists++; if (req.url === '/s0') await slow.promise; else slow.resolve(); return { tools: [tool()] }; }
        return {};
      });
      const servers = Array.from({ length: 10 }, (_, i) => f.item(`s${i}`));
      const progress = [], pending = f.open(servers, { progress: p => progress.push(p) });
      await eight.promise;
      assert.equal(starts, 8); barrier.resolve();
      const first = await pending;
      assert.equal(peak, 8);
      assert.deepEqual(await names(first.port), servers.map(s => `m_${hash([s.id, 'echo']).slice(0,24)}`));
      assert.equal(progress.length, 10); assert.equal(new Set(progress.map(p => p.name)).size, 10); assert(progress.every(p => p.total === 10));
      await first.port.close();
      const second = await f.open(servers);
      assert.equal(first.port.shape, second.port.shape); assert.equal(starts, 10); assert.equal(lists, 10);
      t.ok('最大8接続を並列に進め、s0の一覧を遅らせても index 順で登録。2ターン目は再接続も一覧取得も無い', true);
    }
    {
      let first = 'a', done = gate(), order = [];
      const f = await setup(async (m, req) => {
        if (m.method === 'initialize') return init;
        if (m.method === 'tools/list') {
          const id = req.url.slice(1);
          if (id !== first) { await done.promise; await delay(30); }
          order.push(id); done.resolve(); return { tools: [tool()] };
        }
        return {};
      });
      const servers = [f.item('a'), f.item('b')];
      const a = await f.open(servers); assert.deepEqual(order, ['a','b']); await a.port.close();
      first = 'b'; done = gate(); order = [];
      // 再起動で接続だけ新しくし、enabled_toolsの変更で一覧キャッシュも使わない。
      const b = await f.open(servers.map(s => ({ ...s, definition: { ...s.definition, enabled_tools: ['echo'] } })), { restarted: true });
      assert.deepEqual(order, ['b','a']);
      assert.equal(a.port.shape, b.port.shape);
      assert.deepEqual(await names(b.port), servers.map(s => `m_${hash([s.id, 'echo']).slice(0,24)}`));
      t.ok('HTTPの一覧応答順を反転して新規接続しても、ツールのindex順とshapeは同じ', true);
    }
    {
      let starts = 0, failPing = false;
      const f = await setup(m => {
        if (m.method === 'initialize') { starts++; return init; }
        if (m.method === 'ping' && failPing) { failPing = false; return { error: { code: -32603, message: 'fixture ping failure' } }; }
        return m.method === 'tools/list' ? { tools: [tool()] } : {};
      });
      const item = f.item('reuse');
      const a = await f.open([item]); await a.port.close(); failPing = true;
      const b = await f.open([item]); assert.equal(starts, 2); await b.port.close();
      const c = await f.open([{ ...item, definition: { ...item.definition, headers: { ...item.definition.headers, Version: '2' } } }]);
      assert.equal(starts, 3); await c.port.close();
      const d = await f.open([item], { restarted: true }); assert.equal(starts, 4); await d.port.close();
      const e = await f.open([item], { restarted: true }); assert.equal(starts, 5);
      const firstCall = await call(e.port, item.id), secondCall = await call(e.port, item.id);
      assert.equal(firstCall.content.length, 1); assert.deepEqual(secondCall.content, []);
      t.ok('ping失敗・実効定義変更・restarted は毎回接続を作り直す', true);
    }
    {
      const held = gate(), entered = gate();
      let starts = 0, version = 1, calls = 0;
      const f = await setup(async m => {
        if (m.method === 'initialize') { starts++; return init; }
        if (m.method === 'tools/list') { if (starts > 1) { entered.resolve(); await held.promise; } return { tools: [tool('echo', version)] }; }
        if (m.method === 'tools/call') { calls++; if (calls === 1) return { error: { code: -32602, message: 'old schema' } }; return { content: [{ type: 'text', text: 'updated' }] }; }
        return {};
      });
      const item = f.item('cache');
      const first = await f.open([item]); await first.port.close(); version = 2;
      const second = await f.open([item], { restarted: true });
      await entered.promise;
      // 一覧が応答していないのに open が終わり、古い一覧で呼び出しを始められる。
      const pending = call(second.port, item.id);
      await until(() => calls === 1); held.resolve();
      assert((await pending).content.some(c => c.text === 'updated')); assert.equal(calls, 2);
      assert((await rpc(second.port, 'tools/list')).tools.find(t => t.name.startsWith('m_')).description.includes('v2'));
      t.ok('再接続は tools/list のキャッシュですぐ返り、古い定義で失敗した呼び出しは一覧更新後に1回だけ再実行する', true);
      await second.port.close();
    }
    {
      let tools = [tool()], calls = 0, lists = 0;
      const f = await setup(m => {
        if (m.method === 'initialize') return init;
        if (m.method === 'tools/list') { lists++; return { tools }; }
        if (m.method === 'tools/call') { calls++; return { isError: true, content: [{ type: 'text', text: 'fixture failure' }] }; }
        return {};
      });
      const item = f.item('removed');
      const a = await f.open([item]); await a.port.close();
      const b = await f.open([item]);
      assert((await call(b.port, item.id)).isError); assert.equal(calls, 1); assert.equal(lists, 2);
      tools = [];
      assert((await call(b.port, item.id)).isError); assert.equal(calls, 2); assert.deepEqual(await names(b.port), []);
      t.ok('同じ定義の業務エラーは再実行せず、keep-warm中に消えたツールも一覧から除く', true);
    }
    {
      let version = 1, calls = 0;
      const f = await setup(m => m.method === 'initialize' ? init : m.method === 'tools/list' ? { tools: [tool('echo', version++)] } : m.method === 'tools/call' ? (calls++, { error: { code: -32602, message: 'invalid input' } }) : {});
      const item = f.item('retry');
      const a = await f.open([item]);
      assert((await call(a.port, item.id)).isError); assert.equal(calls, 2);
      t.ok('入力仕様が変わっていても再実行は1回まで', true);
    }
    {
      let version = 1; const held = gate(), updating = gate();
      const f = await setup(async m => {
        if (m.method === 'initialize') return init;
        if (m.method === 'tools/list') { if (version === 2) { updating.resolve(); await held.promise; } return { tools: [tool('echo', version)] }; }
        return {};
      });
      const item = f.item('race'), bad = f.item('bad', { url: 'invalid' });
      const a = await f.open([item]); await a.port.close(); version = 2;
      const b = await f.open([item, bad], { restarted: true, changed: async () => { await updating.promise; held.resolve(); await delay(30); } });
      assert((await rpc(b.port, 'tools/list')).tools.find(t => t.name.startsWith('m_')).description.includes('v2'));
      await b.port.close();
      const abort = new AbortController();
      await assert.rejects(f.open([item, bad], { signal: abort.signal, changed: () => abort.abort() }));
      t.ok('失敗行の保存中に届いた一覧も公開し、その間のabortは成功として返さない', true);
    }
    {
      let lists = 0; const failed = gate(), refreshed = gate();
      const f = await setup(m => {
        if (m.method === 'initialize') return init;
        if (m.method === 'tools/list') {
          lists++;
          if (lists === 2) { failed.resolve(); return { error: { code: -32603, message: 'temporary list failure' } }; }
          if (lists === 3) refreshed.resolve();
          return { tools: [tool('echo', lists === 1 ? 1 : 2)] };
        }
        return {};
      });
      const item = f.item('refresh-failure');
      const a = await f.open([item]); await a.port.close();
      const b = await f.open([item], { restarted: true }); await failed.promise; await delay(30); await b.port.close();
      const c = await f.open([item]); await refreshed.promise;
      await until(async () => (await rpc(c.port, 'tools/list')).tools.find(t => t.name.startsWith('m_')).description.includes('v2'));
      assert.equal(lists, 3);
      t.ok('バックグラウンドの一覧取得が失敗しても、次ターンに再取得して提示を更新する', true);
    }
    {
      const f = await setup((m, req) => m.method === 'initialize' ? init : m.method === 'tools/list' ? { tools: Array.from({ length: req.url === '/large' ? 499 : req.url === '/over' ? 2 : 1 }, (_, i) => tool(`t${i}`)) } : {});
      const opened = await f.open([f.item('large'), f.item('over'), f.item('last')]);
      assert.deepEqual(opened.runtime.report.entries.map(e => [e.status, e.tools]), [['connected',499],['failed',0],['connected',1]]);
      assert.equal((await names(opened.port)).length, 500);
      t.ok('500件の会計は index 順で、超えたサーバーだけを外し後続の小さいサーバーは登録する', true);
    }
    {
      let starts = 0, calls = 0;
      const f = await setup(m => {
        if (m.method === 'initialize') { starts++; return init; }
        if (m.method === 'tools/list') return { tools: [tool()] };
        if (m.method === 'tools/call') { calls++; return { content: [] }; }
        return {};
      });
      const item = f.item('shared'), abort = new AbortController();
      const a = await f.open([item], { authorize: () => false, signal: abort.signal });
      const b = await f.open([item]);
      assert.equal(starts, 1); assert((await call(a.port, item.id)).isError); assert.equal(calls, 0);
      abort.abort(); await a.port.close();
      assert.equal((await call(b.port, item.id)).isError, undefined); assert.equal(calls, 1);
      await b.port.close();
      await f.open([]);
      const c = await f.open([item]); assert.equal(starts, 2); await c.port.close();
      t.ok('共有接続でも認可はbindingごと。片方の中断は他方を閉じず、削除された接続は再利用しない', true);
    }
    {
      const entered = gate(), held = gate(); let starts = 0;
      const f = await setup(async m => {
        if (m.method === 'initialize') { starts++; return init; }
        if (m.method === 'tools/list') return { tools: [tool()] };
        if (m.method === 'tools/call') { if (m.params.arguments.hold) { entered.resolve(); await held.promise; } return { content: [] }; }
        return {};
      });
      const item = f.item('cancel'), abort = new AbortController();
      const a = await f.open([item], { signal: abort.signal }), b = await f.open([item]);
      const pending = rpc(a.port, 'tools/call', { name: `m_${hash([item.id, 'echo']).slice(0,24)}`, arguments: { hold: true } });
      await entered.promise; abort.abort(); await a.port.close();
      assert((await pending).isError); assert.equal((await call(b.port, item.id)).isError, undefined); assert.equal(starts, 1);
      held.resolve();
      t.ok('共有接続の実行中リクエストも、そのbindingだけ中断できる', true);
    }
    {
      const entered = gate(), held = gate(); let starts = 0;
      const f = await setup(async m => {
        if (m.method === 'initialize') { starts++; if (starts === 1) { entered.resolve(); await held.promise; } return init; }
        return m.method === 'tools/list' ? { tools: [tool()] } : {};
      });
      const abort = new AbortController(), item = f.item('abort');
      const pending = f.open([item], { signal: abort.signal });
      const rejected = assert.rejects(pending);
      await entered.promise; abort.abort(); held.resolve(); await rejected;
      await f.open([item]); assert.equal(starts, 2);
      const before = starts, already = new AbortController(); already.abort();
      await assert.rejects(f.open([item], { signal: already.signal })); assert.equal(starts, before);
      t.ok('接続前・接続中のabortは公開せず、遅れてつながったclientも回収する', true);
    }
    {
      const log = path.join(scratch, 'stdio.jsonl'), childFile = path.join(scratch, 'child.pid');
      const item = { id: 'stdio', name: 'stdio', origins: [{ source: 'claude' }], definition: { command: process.execPath, args: [fileURLToPath(new URL('../lib/stdio-mcp.mjs', import.meta.url))], env: { MCP_TEST_LOG: log, MCP_TEST_CHILD_PID: childFile } } };
      const f = await setup(() => ({}), { warmIdleMs: 80 });
      const a = await f.open([item]);
      await until(async () => !!await fs.readFile(childFile, 'utf8').catch(() => ''));
      const parentPid = JSON.parse((await fs.readFile(log, 'utf8')).split('\n')[0]).pid;
      const childPid = Number(await fs.readFile(childFile, 'utf8'));
      await delay(120); assert(alive(parentPid), '利用中はTTLで閉じない');
      await a.port.close(); await until(() => !alive(parentPid) && !alive(childPid));
      const b = await f.open([item]);
      const latestPid = JSON.parse((await fs.readFile(log, 'utf8')).trim().split('\n').at(-1)).pid;
      await until(async () => Number(await fs.readFile(childFile, 'utf8')) !== childPid);
      const nextChildPid = Number(await fs.readFile(childFile, 'utf8')); assert(alive(nextChildPid));
      await f.bridge.dispose(); await until(() => !alive(latestPid) && !alive(nextChildPid));
      assert.equal(await rpc(b.port, 'ping'), undefined);
      await assert.rejects(() => f.open([item]));
      t.ok('利用中は保持し、アイドルTTL・disposeで stdio の親子を回収。dispose後は新規利用を断る', true);
    }
    {
      // worktree を消す前の回収（Issue #142）: cwd がその中の stdio の MCP だけ畳み、dir が消せる。畳まれた分は次の利用で起き直る
      const dirA = path.join(scratch, 'wt-a'), dirB = path.join(scratch, 'wt-b');
      await fs.mkdir(dirA, { recursive: true }); await fs.mkdir(dirB, { recursive: true });
      const stdio = (id, log, child) => ({ id, name: id, origins: [{ source: 'claude' }], definition: { command: process.execPath, args: [fileURLToPath(new URL('../lib/stdio-mcp.mjs', import.meta.url))], env: { MCP_TEST_LOG: log, MCP_TEST_CHILD_PID: child } } });
      const logA = path.join(scratch, 'fold-a.jsonl'), childA = path.join(scratch, 'fold-a.pid');
      const logB = path.join(scratch, 'fold-b.jsonl'), childB = path.join(scratch, 'fold-b.pid');
      const itemA = stdio('fold-a', logA, childA), itemB = stdio('fold-b', logB, childB);
      const f = await setup(m => m.method === 'initialize' ? init : m.method === 'tools/list' ? { tools: [tool()] } : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'HTTP_OK' }] } : {});
      const httpItem = f.item('fold-http');
      const rt = (cwd, servers) => ({ owners: { mcp: 'ply' }, policy: { cwd }, prompt: '', skills: [], servers, report: { entries: servers.map(({ id }) => ({ id })) } });
      const a = await f.open([itemA], { runtime: rt(dirA, [itemA]) });
      const b = await f.open([itemB], { runtime: rt(dirB, [itemB]) });
      // http/sse はプロセスを起こさないので cwd を持たない。畳む対象から外れることを確かめるため同じ dirA に置く
      const httpPort = await f.open([httpItem], { runtime: rt(dirA, [httpItem]) });
      await until(async () => !!await fs.readFile(childA, 'utf8').catch(() => '') && !!await fs.readFile(childB, 'utf8').catch(() => ''));
      const pidA = JSON.parse((await fs.readFile(logA, 'utf8')).split('\n')[0]).pid;
      const pidB = JSON.parse((await fs.readFile(logB, 'utf8')).split('\n')[0]).pid;
      const childPidA = Number(await fs.readFile(childA, 'utf8'));
      if (process.platform === 'win32') await assert.rejects(fs.rmdir(dirA));   // cwd に掴まれている間は消せない（事象の確認）
      const folded = await f.bridge.closeUnder(dirA);
      assert.equal(folded, 1);                                                 // dirA の stdio だけ（dirB と http は対象外）
      await until(() => !alive(pidA) && !alive(childPidA));
      assert(alive(pidB), '別の cwd の stdio は畳まない');
      assert((await call(httpPort.port, httpItem.id)).content[0].text === 'HTTP_OK');  // http/sse は畳まない
      await until(async () => { try { await fs.rmdir(dirA); return true; } catch { return false; } });
      // 畳まれた分は次の利用で起き直る（遅延起動と同じ形・恒久的には壊れない）
      await fs.mkdir(dirA, { recursive: true });
      const a2 = await f.open([itemA], { runtime: rt(dirA, [itemA]) });
      assert((await call(a2.port, itemA.id)).content[0].text === 'stdio-result');
      await a2.port.close();
      t.ok('cwd が dir の中の stdio の MCP だけ畳んで dir を消せる。別の cwd・http/sse は畳まず、次の利用で起き直る', true);
    }
    {
      const log = path.join(scratch, 'abort.jsonl'), pidFile = path.join(scratch, 'abort-child.pid');
      const item = { id: 'abort-stdio', name: 'abort-stdio', origins: [{ source: 'claude' }], definition: { command: process.execPath, args: [fileURLToPath(new URL('../lib/stdio-mcp.mjs', import.meta.url))], env: { MCP_TEST_LOG: log, MCP_TEST_CHILD_PID: pidFile, MCP_TEST_WAIT_INITIALIZE: '1' } } };
      const f = await setup(() => ({})), abort = new AbortController();
      const rejected = assert.rejects(f.open([item], { signal: abort.signal }));
      await until(async () => !!await fs.readFile(pidFile, 'utf8').catch(() => ''));
      await until(async () => (await fs.readFile(log, 'utf8').catch(() => '')).includes('initialize'));
      const parentPid = JSON.parse((await fs.readFile(log, 'utf8')).split('\n')[0]).pid, childPid = Number(await fs.readFile(pidFile, 'utf8'));
      abort.abort(); await rejected; await until(() => !alive(parentPid) && !alive(childPid));
      t.ok('initializeが応答しなくてもabortで接続中のstdio親子を回収する', true);
    }
    if (process.platform === 'win32') {
      const child = fork(fileURLToPath(new URL('../lib/context-exit.mjs', import.meta.url)), [scratch], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = ''; child.stderr.on('data', c => { stderr += c; });
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`exit fixture ${code}: ${stderr}`))); });
      await until(async () => !!await fs.readFile(path.join(scratch, 'exit-child.pid'), 'utf8').catch(() => ''));
      const parentPid = JSON.parse((await fs.readFile(path.join(scratch, 'exit.jsonl'), 'utf8')).split('\n')[0]).pid;
      const childPid = Number(await fs.readFile(path.join(scratch, 'exit-child.pid'), 'utf8'));
      child.send('exit'); assert.deepEqual(await exited, { code: 0, signal: null });
      await until(() => !alive(parentPid) && !alive(childPid));
      t.ok('process.exit の同期ハンドラでも stdio の子孫を残さない（Windows）', true);
    }
  } finally {
    await Promise.allSettled(ports.map(p => p.close()));
    for (const dispose of resources.reverse()) await dispose();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
