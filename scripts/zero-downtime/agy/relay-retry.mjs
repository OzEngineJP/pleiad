// 無停止の更新 段階 3（agy）: 中継（core/agy-context-relay.mjs）の再試行を、本物の agy（ACP）・本物の中継・本物の MCP の口（core/mcp-bridge.mjs）で確かめる。
// stage0-codex-agy §4 は「口を閉じたままツールを呼ぶと、中継に再試行が無いので即エラー」だった（codex/62-agy-mcp.mjs）。再試行を足した後、口が数秒閉じて開き直しても
// agy にはエラーが見えないか。LLM は 2 ターン（短い応答）。中継は本体と同じく ACP の session/new の mcpServers で渡す（relayMcpServers）。
//   1. 口が開いている: ツールが通る（基準）
//   2. 口を閉じたままターン（session/prompt）を送り、数秒後（--reopen-ms。既定 1500）に同じポートで開き直す。中継が再試行して、ツール（一覧・呼び出し）が通るか
// 置き場は worktree の temporary/zdu-agy-relay/。agy の会話は ~/.gemini/antigravity-cli に残る（終わりに会話 id を出す）。
//
//   node scripts/zero-downtime/agy/relay-retry.mjs [--model <id>] [--reopen-ms <ms>]
// 再試行なしとの対照は、PLY_RELAY_RETRY_MS=0 を付けて流す（中継の env に渡す。session/new の mcpServers の env）。
// agy は AGENT_HOST_AGY_BIN で身代わり（node tests/lib/fake-agy.mjs）に替えられる（段取りだけの確かめ。pong の判定は台本なので外れる）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HolderSim } from '../codex/holder-sim.mjs';
import { Rpc } from '../codex/lib.mjs';
import { createMcpBridge } from '../../../core/mcp-bridge.mjs';
import { relayMcpServers } from '../../../core/backends/antigravity-context.mjs';
import { agyLaunch, parse, promptParams, replyText, setModel, startSession } from './acp-probe.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const model = flag('--model', 'gemini-3.8-flash-low');
const reopenMs = Number(flag('--reopen-ms', 1500));
const base = path.join(repo, 'temporary', 'zdu-agy-relay');
fs.rmSync(base, { recursive: true, force: true });
const work = path.join(base, 'work');
fs.mkdirSync(work, { recursive: true });
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let calls = 0;
const bridge = createMcpBridge({ path: '/mcp/context', serverName: 'Pleiad Context',
  tools: () => [{ name: 'probe_ping', description: 'Returns a pong token. Call with no arguments.', inputSchema: { type: 'object', properties: {} } }],
  call: async () => `pong-token-${++calls}` });
let srv, port = 0;
const sockets = new Set();
const openServer = () => new Promise(resolve => {
  srv = http.createServer((req, res) => bridge.handle(req, res));
  srv.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  srv.listen(port, '127.0.0.1', () => { port = srv.address().port; resolve(); });
});
const closeServer = async () => { srv.closeAllConnections?.(); for (const s of sockets) s.destroy(); await new Promise(resolve => srv.close(resolve)); };
await openServer();
const opened = bridge.open({ origin: `http://127.0.0.1:${port}`, locale: 'en' });
const mcpServers = relayMcpServers({ contextEnabled: true, env: {
  PLY_CONTEXT_URL: opened.url, PLY_CONTEXT_AUTHORIZATION: opened.headers.Authorization, PLY_CONTEXT_LOCALE: 'en',
  ...(process.env.PLY_RELAY_RETRY_MS !== undefined ? { PLY_RELAY_RETRY_MS: process.env.PLY_RELAY_RETRY_MS } : {}) } });
const { command, args } = agyLaunch({ cwd: work, skipPermissions: true });
const h = new HolderSim(command, args, { cwd: work, env: { ...process.env } });
const rpc = new Rpc('agy', text => h.write(text));
const frames = [];
h.sink = line => { const m = parse(line); if (!m) return; frames.push(m); rpc.feed(`${line}\n`); };
let sessionId = null;
async function turn(label, prompt, { whileSending = null } = {}) {
  const n0 = frames.length, started = Date.now();
  const pending = rpc.request('session/prompt', promptParams(sessionId, prompt), 120_000);
  const during = whileSending?.();
  const response = await pending;
  await during;
  const text = replyText(frames.slice(n0));
  log(`${label}: ${response.result?.stopReason ?? (response.error ? `error ${JSON.stringify(response.error).slice(0, 200)}` : 'NO RESPONSE')} (${Date.now() - started} ms) reply=${JSON.stringify(text).slice(0, 300)}`);
  return { ok: Boolean(response.result?.stopReason), text };
}
let ok = false;
try {
  log('agy', model, 'relay retry probe; mcpServers', mcpServers.map(s => s.name).join(','));
  sessionId = (await startSession(rpc, { cwd: work, mcpServers })).sessionId;
  log('session', sessionId, '; model applied:', await setModel(rpc, sessionId, model));
  const r1 = await turn('1. 口が開いている', 'Call the MCP tool probe_ping exactly once and tell me the exact token it returned. If the tool fails or does not exist, say FAILED and quote the error.');
  const base1 = calls;
  await closeServer();
  log(`--- 口を閉じた。ターンを送り、${reopenMs} ms 後に同じポートで開き直す`);
  const r2 = await turn(`2. 閉じたまま送って ${reopenMs} ms 後に開き直す`, 'Call the MCP tool probe_ping once more and tell me the exact token it returned. If the tool fails or does not exist, say FAILED and quote the error.', {
    whileSending: async () => { await sleep(reopenMs); await openServer(); log('--- 口を開き直した'); } });
  log('口が閉じていた間に始めたターンで、開き直した口が受けた呼び出し:', calls - base1);
  ok = r1.ok && r2.ok && /pong-token-1/.test(r1.text) && /pong-token-2/.test(r2.text) && calls - base1 === 1;
} finally {
  log('SESSION_ID(for cleanup):', sessionId, '| stderr:', h.err.slice(0, 300));
  try { h.child.stdin.end(); } catch { /* 終わっている */ }
  await Promise.race([h.exited, sleep(15_000)]);
  if (h.exit === null) h.kill();
  try { await closeServer(); } catch { /* 閉じている */ }
  await sleep(800);
  fs.rmSync(base, { recursive: true, force: true });
  console.log(JSON.stringify({ ok }));
  process.exit(ok ? 0 : 1);
}
