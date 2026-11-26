// 項目 4（agy）: Pleiad の MCP の口が不通のとき。agy は MCP を stdio の中継（core/agy-context-relay.mjs）越しに使う。
// 本体と同じく、中継は ACP の session/new の mcpServers に渡す（relayMcpServers。接続先とトークンは env の { name, value }）。
// 実物の中継 + 実物の MCP の口（core/mcp-bridge.mjs）で、口を閉じた状態でツールを呼ばせる。LLM は 3 回（短い応答）。
//   1. 口が開いている: ping が通る
//   2. 口を閉じたまま: ツールの失敗で済むか、agy が MCP ごと外すか
//   3. 口を同じポートで開き直す: また使えるか（外されていないか）
// `startdown` を付けると、口を閉じたまま agy を起こし（中継の initialize が失敗する場合）、開いた後に同じ agy で使えるかを見る。
// agy は AGENT_HOST_AGY_BIN で身代わり（node tests/lib/fake-agy.mjs）に替えられる（段取りだけの確かめ。pong の判定は台本なので外れる）。
import { HolderSim } from './holder-sim.mjs';
import { Rpc, log, sleep } from './lib.mjs';
import { agyLaunch, parse, promptParams, replyText, setModel, startSession, toolEnds, toolStarts } from '../agy/acp-probe.mjs';
import { createMcpBridge } from '../../../core/mcp-bridge.mjs';
import { relayMcpServers } from '../../../core/backends/antigravity-context.mjs';
import http from 'node:http';
import fs from 'node:fs'; import path from 'node:path';
const base = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../../temporary/zdu');
fs.mkdirSync(base, { recursive: true });
const work = fs.mkdtempSync(path.join(base, 'agy-work-'));

let calls = 0; const seen = [];
const bridge = createMcpBridge({ path: '/mcp/context', serverName: 'Pleiad Context',
  tools: () => [{ name: 'probe_ping', description: 'Returns a pong token. Call with no arguments.', inputSchema: { type: 'object', properties: {} } }],
  call: async () => `pong-token-${++calls}` });
let srv, port = 0; const sockets = new Set();
const openServer = () => new Promise((res) => { srv = http.createServer((req, rs) => { seen.push(req.method); bridge.handle(req, rs); }); srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); }); srv.listen(port, '127.0.0.1', () => { port = srv.address().port; res(); }); });
const closeServer = async () => { srv.closeAllConnections?.(); for (const s of sockets) s.destroy(); await new Promise((r) => srv.close(r)); };
await openServer();
const opened = bridge.open({ origin: `http://127.0.0.1:${port}`, locale: 'en' });
const startDown = process.argv[2] === 'startdown';   // 口が閉じたまま agy を起動する（中継の initialize が失敗する場合）
if (startDown) { await closeServer(); log('--- MCP port CLOSED before agy starts'); }
const mcpServers = relayMcpServers({ contextEnabled: true, env: { PLY_CONTEXT_URL: opened.url, PLY_CONTEXT_AUTHORIZATION: opened.headers.Authorization, PLY_CONTEXT_LOCALE: 'en' } });
const model = process.env.PROBE_AGY_MODEL ?? 'gemini-3.8-flash-low';
const { command, args } = agyLaunch({ cwd: work, skipPermissions: true });
const h = new HolderSim(command, args, { cwd: work, env: { ...process.env } });
const rpc = new Rpc('agy', (s) => h.write(s));
const frames = [];
h.sink = (line) => { const m = parse(line); if (!m) return; frames.push(m); rpc.feed(`${line}\n`); };
let sessionId = null;
async function turn(label, prompt) {
  const n0 = frames.length, t0 = Date.now();
  const r = await rpc.request('session/prompt', promptParams(sessionId, prompt), 120_000);
  const slice = frames.slice(n0);
  const starts = toolStarts(slice), ends = toolEnds(slice);
  log(`${label}: ${r.result?.stopReason ?? (r.error ? `error ${JSON.stringify(r.error).slice(0, 200)}` : 'NO RESPONSE')} (${Date.now() - t0}ms)\n   reply: ${JSON.stringify(replyText(slice)).slice(0, 400)}\n   tools: ${starts.map((u) => u.title).join(', ') || '(none)'} / completed ${ends.length}`);
  const last = [...starts, ...ends].at(-1); if (last) log('   last tool update:', JSON.stringify(last).slice(0, 500));
}
try {
  log('agy mcp probe; model', model, '; mcpServers', mcpServers.map((s) => s.name).join(','));
  const started = await startSession(rpc, { cwd: work, mcpServers });
  sessionId = started.sessionId;
  log('session', sessionId, '; model applied:', await setModel(rpc, sessionId, model));
  if (startDown) {
    await turn('S1. agy started while port CLOSED', 'Call the MCP tool probe_ping exactly once and tell me the exact token it returned. If the tool fails or does not exist, say FAILED and quote the error.');
    await openServer(); log('--- MCP port OPENED (same port)');
    const b = calls;
    await turn('S2. after OPEN (same agy process)', 'Call the MCP tool probe_ping once more and tell me the exact token it returned. If the tool fails or does not exist, say FAILED and quote the error.');
    log('   tool calls served after opening:', calls - b);
  } else {
    await turn('1. port OPEN', 'Call the MCP tool probe_ping (from the ply_context server) exactly once and tell me the exact token it returned. If the tool fails, say FAILED and quote the error.');
    log('   MCP-side requests so far:', seen.length, 'tool calls served:', calls);
    await closeServer(); log('--- MCP port CLOSED');
    await turn('2. port CLOSED', 'Call the MCP tool probe_ping again exactly once and tell me the exact token it returned. If the tool fails, say FAILED and quote the error.');
    await openServer(); log('--- MCP port REOPENED (same port)');
    const before = calls;
    await turn('3. after REOPEN', 'Call the MCP tool probe_ping once more and tell me the exact token it returned. If the tool fails, say FAILED and quote the error.');
    log('   tool calls served by the reopened port:', calls - before, '(0 = agy no longer reaches the MCP)');
  }
} finally {
  log('SESSION_ID(for cleanup):', sessionId, '| stderr:', h.err.slice(0, 400));
  try { h.child.stdin.end(); } catch {}
  await Promise.race([h.exited, sleep(15000)]); if (h.exit === null) h.kill();
  try { await closeServer(); } catch {}
  await sleep(800); fs.rmSync(work, { recursive: true, force: true });
}
