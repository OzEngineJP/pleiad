import readline from 'node:readline';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
if (process.env.MCP_TEST_CHILD_ONLY) {
  fs.writeFileSync(process.env.MCP_TEST_CHILD_PID, String(process.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const child = process.env.MCP_TEST_CHILD_PID ? spawn(process.execPath, [process.argv[1]], {
  env: { ...process.env, MCP_TEST_CHILD_ONLY: '1' }, stdio: 'ignore', windowsHide: true,
}) : null;
if (child) process.once('SIGTERM', () => { child.kill(); process.exit(0); });
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const req = JSON.parse(line);
  if (!Object.hasOwn(req, 'id')) continue;
  if (process.env.MCP_TEST_LOG) fs.appendFileSync(process.env.MCP_TEST_LOG, JSON.stringify({ pid: process.pid, method: req.method }) + '\n');
  if (req.method === 'initialize' && process.env.MCP_TEST_WAIT_INITIALIZE) await new Promise(() => {});
  const result = req.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : req.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo fixture', inputSchema: { type: 'object', properties: {} } }] }
    : req.method === 'tools/call' ? { content: [{ type: 'text', text: process.env.MCP_TEST_VALUE || 'stdio-result' }] }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
}
child?.kill();
