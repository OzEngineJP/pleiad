// 無停止の更新 段 2c（ADR 0270）: 外部の stdio MCP を保持役に載せ、サーバーを普通に止めて起こし直しても
// 子と中の状態が残り、新しいサーバーが付け直すことを確かめる（規則 ③: 起動の処理が復元の処理）。
// 止め方は引き継ぎ（handover）ではなく、普通に止めて普通に起こす（SIGTERM → 5 秒で SIGKILL。tests/lib/restart.mjs）。
//
//   1. 呼ばれた回数を数える MCP（tests/lib/stateful-mcp.mjs）を .mcp.json から起こし、ツールを 1 回呼ぶ（count:1）
//   2. サーバーを普通に止めて起こし直す。MCP の子は保持役に残る
//   3. 同じ会話でツールをもう 1 回呼ぶと count:2（中の状態が残っている＝同じプロセスに付いた）
//   4. initialize は 1 回だけ（札に残した結果を読み直し、2 回目の initialize を MCP に送らない）
//   5. サーバーの終わり（SIGTERM）では MCP の子を止めない（アプリの終了だけが止める）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';
import { hash } from '../../core/context-runtime.mjs';
import { installRestartMode, uninstallRestartMode } from '../lib/restart.mjs';

export const name = 'restart-mcp';
export const title = '途中でサーバーを止めて起こし直す: 外部の stdio MCP（保持役の子）と中の状態が残り、initialize は 1 回だけ';

const WAIT_MS = 40_000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(check, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-restart-mcp-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const repo = path.join(scratch, 'repo');
  const logFile = path.join(scratch, 'mcp.jsonl');
  const pidFile = path.join(scratch, 'mcp.pid');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { counter: {
    command: process.execPath, args: [path.join(ROOT, 'tests', 'lib', 'stateful-mcp.mjs')],
    env: { MCP_TEST_LOG: logFile, MCP_TEST_PID: pidFile },
  } } }));
  // 環境変数で入っている仕掛け（PLEIAD_TEST_RESTART）は外し、この suite は明示的に起こし直す
  uninstallRestartMode();
  const controller = installRestartMode({ trigger: 'manual' });
  let holderPid = null, server = null, c = null;
  const childPids = new Set();
  try {
    // 保持役を先に起こしておく（detached。サーバーが入れ替わっても子は残る）
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 60_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_RUNTIME_ROOT: root }, dataDir, timeoutMs: 30_000 });
    c = await open({ port: server.port, token: server.token, autoAllow: true });

    // 外部 MCP は既定でエージェント任せ。この場所だけ Pleiad が担当する（.mcp.json の counter をつなぐ）
    const none = { sources: [], excludePaths: [] };
    await c.cmd('setContextSettings', { cwd: repo, place: repo, kind: 'mcp', value: { owner: 'ply', user: none, directory: { sources: ['claude'], excludePaths: [] } } });

    const first = await c.runTurn({ backend: 'fake', cwd: repo, prompt: 'echo:first' }, { ms: WAIT_MS });
    assert.equal(first.outcome, 'ok');
    const sessionId = first.sessionId;
    const record = await c.cmd('sessionContext', { sessionId });
    const mcp = record?.report?.entries?.find(entry => entry.kind === 'mcp' && entry.name === 'counter');
    assert.ok(mcp, `sessionContext に外部 MCP の行がある: ${JSON.stringify(record?.report?.entries?.map(entry => [entry.kind, entry.name, entry.status]))}`);
    assert.equal(mcp.status, 'connected', 'MCP がつながっている');
    const tool = `m_${hash([mcp.id, 'count']).slice(0, 24)}`;
    const call = async () => {
      const from = c.mark();
      const turn = await c.runTurn({ sessionId, backend: 'fake', cwd: repo, prompt: `context:${JSON.stringify({ name: tool, arguments: {} })}` }, { ms: WAIT_MS });
      return { outcome: turn.outcome, text: c.since(from).filter(event => event.type === 'text.delta').map(event => event.text).join('') };
    };

    const one = await call();
    assert.equal(one.outcome, 'ok');
    assert.match(one.text, /count:1/, `1 回目の呼び出しは count:1: ${one.text}`);
    const pid = await until(() => fs.readFile(pidFile, 'utf8').then(text => Number(text) || null, () => null), WAIT_MS, 'MCP の pid');
    assert.ok(alive(pid), 'MCP の子が走っている');

    // 保持役の子として載り、initialize の結果が札に残っている（付け直す側が initialize を送り直さずに済む）
    {
      const probe = await connectHolder({ dataDir, root });
      const child = probe.welcome.children.find(entry => entry.label?.k === 'mcp');
      assert.ok(child, 'MCP の子が保持役に居る');
      assert.ok(child.label?.init?.protocolVersion, 'initialize の結果が札に載っている');
      assert.ok(child.label.init.capabilities?.tools, '札の capabilities に tools がある');
      probe.close();
    }

    // 普通に止めて、同じデータ置き場・同じトークン・同じポートで普通に起こす
    server = await controller.restart();
    assert.equal(controller.restarts, 1);
    assert.ok(alive(pid), 'サーバーを止めても MCP の子は止まらない');

    const two = await call();
    t.ok('外部の stdio MCP は、サーバーを止めて起こし直しても中の状態が残る（同じ子に付き、呼び出しの回数が続く）',
      two.outcome === 'ok' && /count:2/.test(two.text), two.text);
    t.ok('MCP の子は同じプロセス（起こし直していない）', Number(await fs.readFile(pidFile, 'utf8')) === pid && alive(pid), String(pid));

    const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const initializes = lines.filter(line => line.method === 'initialize');
    t.ok('initialize は 1 回だけ（札に残した結果を読み直し、2 回目の initialize を MCP に送らない）',
      initializes.length === 1, JSON.stringify(initializes));

    // サーバーの終わり（SIGTERM）でも止めない。止めるのはアプリの終了と会話の後片付け（warm の idle・worktree を消す前）
    const before = await connectHolder({ dataDir, root });
    for (const child of before.welcome.children) if (child.pid) childPids.add(child.pid);
    before.close();
    assert.ok(childPids.has(pid), '保持役の子の一覧に MCP が居る');
    assert.deepEqual(controller.errors, [], '起こし直しの間に、仕掛けの中の失敗が無い');
    assert.ok(!server.tail(300).includes('[unhandledRejection]'), server.tail(20));
  } finally {
    c?.close();
    await server?.stop().catch(() => {});
    if (holderPid && alive(holderPid)) {
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
    }
    for (const pid of childPids) await until(() => !alive(pid), 10_000, `子（${pid}）が終わる`).catch(() => {});
    uninstallRestartMode();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
