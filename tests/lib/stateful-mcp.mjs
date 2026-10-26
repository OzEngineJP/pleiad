// 試験用の、中の状態を持つ stdio の MCP（ADR 0270 段 2c の「途中でサーバーを止めて起こし直す」試験）。
// 呼ばれた回数をプロセスの中で数え、tools/call のたびに `count:<n>` を返す。initialize を受けた回数も数え、
// MCP_TEST_LOG のファイルへ 1 行ずつ残す（起こし直した後に 2 回目の initialize を送っていないことを確かめる）。
import fs from 'node:fs';
import readline from 'node:readline';

const logFile = process.env.MCP_TEST_LOG || null;
const pidFile = process.env.MCP_TEST_PID || null;
let calls = 0;
let initializes = 0;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));

const log = entry => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };
log({ method: 'start' });

const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!Object.hasOwn(request, 'id')) continue;   // 通知（notifications/initialized など）
  const method = request.method;
  if (method === 'initialize') initializes++;
  log({ method, ...(method === 'initialize' ? { initializes } : {}) });
  const result = method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stateful', version: '1' } }
    : method === 'tools/list' ? { tools: [{ name: 'count', description: 'Counts the calls in this process', inputSchema: { type: 'object', properties: {} } }] }
      : method === 'tools/call' ? (() => { calls++; log({ method: 'tools/call', calls }); return { content: [{ type: 'text', text: `count:${calls}` }] }; })()
        : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
log({ method: 'exit', calls, initializes });
