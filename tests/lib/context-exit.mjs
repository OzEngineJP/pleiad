import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContextBridge } from '../../core/context-bridge.mjs';

const bridge = createContextBridge();
process.on('exit', () => { void bridge.dispose(); });
const item = { id: 'exit', name: 'exit', origins: [{ source: 'claude' }], definition: {
  command: process.execPath, args: [fileURLToPath(new URL('./stdio-mcp.mjs', import.meta.url))],
  env: { MCP_TEST_LOG: path.join(process.argv[2], 'exit.jsonl'), MCP_TEST_CHILD_PID: path.join(process.argv[2], 'exit-child.pid') },
} };
await bridge.open({ runtime: { owners: { mcp: 'ply' }, policy: { cwd: process.cwd() }, skills: [], servers: [item], report: { entries: [{ id: item.id }] } }, origin: 'http://127.0.0.1', isActive: () => true });
process.once('message', () => process.exit(0));
process.send('ready');
