// worktree を消す前に、その中を cwd に持つ外部 MCP を畳む（Issue #142）。
// 実際の git worktree と実際の stdio の MCP（親＋孫プロセス）で、server.mjs と同じ結線
// （contextBridge.closeUnder + mcpLedger.sweepCwd）を確かめる。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContextBridge } from '../../core/context-bridge.mjs';
import { createMcpLedger } from '../../core/mcp-ledger.mjs';
import { createWorktrees } from '../../core/worktrees.mjs';
import { hash } from '../../core/context-runtime.mjs';
import { openData } from '../../core/data-schema.mjs';
import { mcpProcessTable } from '../../core/db.mjs';

export const name = 'worktree-mcp';
export const title = 'worktree を消す前に、その中を cwd に持つ MCP（親＋孫）を畳んで消せる。次の利用で起き直る（実 git・実 stdio）';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
const exists = (p) => fs.stat(p).then(() => true, () => false);
const slash = (p) => p.replaceAll('\\', '/');
const until = async test => { for (let i = 0; i < 200; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('fixture timeout'); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export default async function (t) {
  const scratch = slash(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-wt-mcp-')));
  const resources = [];
  try {
    const repo = `${scratch}/repo`;
    await fs.mkdir(repo, { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    await fs.writeFile(`${repo}/a.txt`, 'one\n');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'init');

    const dataDir = `${scratch}/data`;
    const ledger = createMcpLedger({ dataDir });
    const bridge = createContextBridge({ ledger });
    const host = http.createServer(bridge.handle);
    resources.push(async () => { await bridge.dispose(); ledger.release(); host.closeAllConnections(); await new Promise(r => host.close(r)); });
    await new Promise(r => host.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${host.address().port}`;

    // server.mjs と同じ結線: 消す直前に、接続の回収 → 台帳に残った分の掃除
    const wts = createWorktrees({ dataDir,
      users: async () => ({ busy: [], attached: [] }),
      release: async () => {},
      unhold: async entry => { await bridge.closeUnder(entry.path); await ledger.sweepCwd(entry.path); } });

    const log = `${scratch}/mcp.jsonl`, childPidFile = `${scratch}/mcp-child.pid`;
    const item = { id: 'wt-mcp', name: 'wt-mcp', origins: [{ source: 'claude' }], definition: { command: process.execPath, args: [fileURLToPath(new URL('../lib/stdio-mcp.mjs', import.meta.url))], env: { MCP_TEST_LOG: log, MCP_TEST_CHILD_PID: childPidFile } } };
    const rt = cwd => ({ owners: { mcp: 'ply' }, policy: { cwd }, prompt: '', skills: [], servers: [item], report: { entries: [{ id: item.id }] } });
    const rpc = async (port, method, params = {}) => (await (await fetch(port.url, { method: 'POST', headers: { ...port.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
    const call = port => rpc(port, 'tools/call', { name: `m_${hash([item.id, 'echo']).slice(0, 24)}`, arguments: {} });
    const procs = () => { const { db, release } = openData(dataDir); try { return mcpProcessTable(db); } finally { release(); } };

    // worktree を作り、その中を cwd に MCP を起こす。ターンの口を閉じても warm で生きている（issue の形）
    const w = (await wts.create({ cwd: repo, sessionId: 's1' })).entry;
    const port1 = await bridge.open({ runtime: rt(w.path), origin, isActive: () => true });
    await until(async () => !!await fs.readFile(childPidFile, 'utf8').catch(() => ''));
    const rootPid = JSON.parse((await fs.readFile(log, 'utf8')).split('\n')[0]).pid;
    const grandPid = Number(await fs.readFile(childPidFile, 'utf8'));
    assert(alive(rootPid) && alive(grandPid));
    assert(procs().unclosed().length === 1, '台帳に起きた根が記録されている');
    assert((await call(port1)).content[0].text === 'stdio-result');
    await port1.close();
    assert(alive(rootPid), 'warm に残る MCP はまだ生きている');

    // 消す → cwd の持ち主（親＋孫）を畳んでから消せる
    const r1 = await wts.settle(w.id);
    assert.equal(r1.action, 'removed', JSON.stringify(r1));
    assert(!(await exists(w.path)), 'worktree の場所が消える');
    await until(() => !alive(rootPid) && !alive(grandPid));
    assert(procs().unclosed().length === 0, '台帳の行も締まる');
    t.ok('worktree の中を cwd に持つ MCP（親＋孫）を畳んでから消せる', true);

    // 畳まれた分は次の利用で起き直る（新しい worktree・新しいプロセス）
    const w2 = (await wts.create({ cwd: repo, sessionId: 's2' })).entry;
    await fs.writeFile(childPidFile, '');
    const port2 = await bridge.open({ runtime: rt(w2.path), origin, isActive: () => true });
    assert((await call(port2)).content[0].text === 'stdio-result');
    await until(async () => { const c = await fs.readFile(childPidFile, 'utf8').catch(() => ''); return !!c.trim() && Number(c) !== grandPid; });
    await port2.close();
    assert.equal((await wts.settle(w2.id)).action, 'removed');
    t.ok('畳まれた分は次の利用で起き直る', true);
  } finally {
    for (const r of resources) await r().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
