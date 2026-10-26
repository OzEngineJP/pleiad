// 無停止の更新 段 2b（ADR 0270）: Devin・Grok の ACP の子を保持役に載せ、サーバーを普通に止めて起こし直してもターンが続くことを確かめる。
// サーバーを普通に止めて起こし直す。通常の起動で保持役の子の札と記録からターンを拾う（restoreTurn → adoptTurn）。
//   1. Devin: [slow] [gate:…] のターンの途中（ツールの実行中）で止めても、CLI は走り続け、新しいサーバーが記録の再生と続きで最後まで流す
//   2. Devin: 承認待ちの途中で止めても、新しいサーバーが同じ id の承認を聞き直し、答えるとターンが終わる
//   3. Grok: [slow] のターンが同じように続く
//   4. Grok: 途中送信（steer）が、止める前に CLI へ渡っていれば失われず、返答に現れる
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';
import { installRestartMode, uninstallRestartMode } from '../lib/restart.mjs';

export const name = 'restart-acp';
export const title = '途中でサーバーを止めて起こし直す: Devin・Grok の ACP のターン（保持役の子）が続く';

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
const textOf = events => events.filter(event => event.type === 'text.delta').map(event => event.text).join('');

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-restart-acp-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const work = path.join(scratch, 'work');
  const gates = path.join(scratch, 'gates');
  await Promise.all([work, gates].map(dir => fs.mkdir(dir, { recursive: true })));
  // 環境変数で入っている仕掛け（PLEIAD_TEST_RESTART）は外し、この suite は明示的に起こし直す
  uninstallRestartMode();
  const controller = installRestartMode({ trigger: 'manual' });
  const env = {
    AGENT_HOST_BACKENDS: 'devin,grok',
    AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-devin.mjs')}"`,
    AGENT_HOST_GROK_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-grok.mjs')}"`,
    AGENT_HOST_RUNTIME_ROOT: root,
    FAKE_DEVIN_STATE_DIR: path.join(scratch, 'devin-state'),
    FAKE_DEVIN_GATE_DIR: gates,
    FAKE_DEVIN_SLOW_MS: '30000',
    GROK_HOME: path.join(scratch, 'grok-home'),
    FAKE_GROK_SLOW_MS: '30000',
  };
  let holderPid = null, server = null, c = null;
  const childPids = new Set();
  // 承認は、この suite が明示的に答える（自動許可しない）。pendingSession のターンの id を控えるだけ
  let pendingSession = null;
  const permissionIds = [];
  try {
    // 保持役を先に起こしておく（detached。サーバーが入れ替わっても子は残る）
    const found = await ensureHolder({ dataDir, root, idleMs: 60_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    server = await startServer({ env, dataDir, timeoutMs: 30_000 });
    c = await open({ port: server.port, token: server.token, onEvent: event => {
      if (event.type === 'permission' && event.sessionId === pendingSession) permissionIds.push(event.id);
    } });
    const runningOf = async sessionId => (await c.cmd('running')).turns.find(turn => turn.sessionId === sessionId) ?? null;
    const heldTurn = async sessionId => until(() => runningOf(sessionId).then(turn => turn?.held ? turn : null), WAIT_MS, `${sessionId} のターンが held`);

    // ---- 1. Devin: ツールの実行中（ゲートが開くまで）で普通に止めて起こし直す
    {
      const from = c.mark();
      const running = c.runTurn({ backend: 'devin', cwd: work, prompt: '[slow] [gate:devin-restart] first', model: 'swe-2-high' });
      const started = await c.waitFor(event => event.type === 'session' && event.first === true, { ms: WAIT_MS, from });
      const sessionId = started.sessionId;
      await heldTurn(sessionId);
      server = await controller.restart();
      assert.equal(controller.restarts, 1);
      // 起こし直したサーバーでターンが続いていることを確かめてから、ゲートを開く
      const replayed = await c.waitFor(event => event.type === 'activity' && event.sessionId === sessionId, { ms: WAIT_MS, from });
      assert.ok(replayed);
      await fs.writeFile(path.join(gates, 'devin-restart'), '');
      const turn = await running;
      const devinText = textOf(turn.events);
      t.ok('Devin: ツールの実行中に止めて起こし直しても、ターンは最後まで流れて ok',
        turn.outcome === 'ok' && devinText.startsWith('fixture: ') && devinText.includes('[slow] [gate:devin-restart] first'), devinText.slice(-200));
      await sleep(300);
      assert.equal(c.since(from).filter(event => event.type === 'turnEnd' && event.sessionId === sessionId).length, 1, 'turnEnd は 1 回');
      const loaded = await c.cmd('loadSession', { sessionId });
      t.ok('Devin: 人の発言と返答は履歴に 1 回ずつ（記録の再生と続きが重ならない）',
        loaded.messages.filter(message => message.role === 'user' && message.text === '[slow] [gate:devin-restart] first').length === 1
        && loaded.messages.filter(message => message.role === 'assistant' && message.text.startsWith('fixture: ') && message.text.includes('[slow] [gate:devin-restart] first')).length === 1,
        JSON.stringify(loaded.messages.map(message => [message.role, message.text.slice(0, 40)])));
    }

    // ---- 2. Devin: 承認待ちの途中で止めて起こし直す（新しいサーバーが同じ id の承認を聞き直す）
    {
      const from = c.mark();
      const running = c.runTurn({ backend: 'devin', cwd: work, prompt: '[permission] approve me', model: 'swe-2-high' });
      const started = await c.waitFor(event => event.type === 'session' && event.first === true, { ms: WAIT_MS, from });
      pendingSession = started.sessionId;
      const firstAsk = await c.waitFor(event => event.type === 'permission' && event.sessionId === pendingSession, { ms: WAIT_MS, from });
      await heldTurn(pendingSession);
      const afterRestart = c.mark();
      server = await controller.restart();
      assert.equal(controller.restarts, 2);
      // 起こし直したサーバーが、答えていない同じ承認を聞き直す（id はツールの id から決まる同じ値）
      const again = await c.waitFor(event => event.type === 'permission' && event.sessionId === pendingSession && event.id === firstAsk.id, { ms: WAIT_MS, from: afterRestart });
      await c.cmd('resolvePermission', { id: again.id, allow: true });
      const turn = await running;
      t.ok('Devin: 承認待ちの途中で止めて起こし直しても、同じ id の承認を聞き直して答えれば最後まで流れる',
        turn.outcome === 'ok' && permissionIds.filter(id => id === firstAsk.id).length >= 2, JSON.stringify(permissionIds));
      const loaded = await c.cmd('loadSession', { sessionId: pendingSession });
      t.ok('Devin: 承認したツールの結果が履歴に載る', loaded.messages.some(message => (message.toolCalls ?? []).some(call => call.result?.text === 'fixture tool result')));
    }

    // ---- 3. Grok: ターンの途中（[slow]）で止めて起こし直す
    {
      const from = c.mark();
      const running = c.runTurn({ backend: 'grok', cwd: work, prompt: '[slow] grok first', mode: 'auto' });
      const started = await c.waitFor(event => event.type === 'session' && event.first === true, { ms: WAIT_MS, from });
      const sessionId = started.sessionId;
      await heldTurn(sessionId);
      server = await controller.restart();
      assert.equal(controller.restarts, 3);
      const replayed = await c.waitFor(event => event.type === 'activity' && event.sessionId === sessionId, { ms: WAIT_MS, from });
      assert.ok(replayed);
      const turn = await running;
      const grokText = textOf(turn.events);
      t.ok('Grok: ターンの途中で止めて起こし直しても、ターンは最後まで流れて ok',
        turn.outcome === 'ok' && grokText.startsWith('fixture: ') && grokText.includes('[slow] grok first'), grokText.slice(-200));
      await sleep(300);
      assert.equal(c.since(from).filter(event => event.type === 'turnEnd' && event.sessionId === sessionId).length, 1, 'turnEnd は 1 回');
      const loaded = await c.cmd('loadSession', { sessionId });
      t.ok('Grok: 人の発言と返答は履歴に 1 回ずつ', loaded.messages.filter(message => message.role === 'user' && message.text === '[slow] grok first').length === 1
        && loaded.messages.filter(message => message.role === 'assistant' && message.text.startsWith('fixture: ') && message.text.includes('[slow] grok first')).length === 1,
        JSON.stringify(loaded.messages.map(message => [message.role, message.text.slice(0, 40)])));
    }

    // ---- 4. Grok: 途中送信（止める前に CLI へ渡ったもの）が失われない
    {
      const from = c.mark();
      const running = c.runTurn({ backend: 'grok', cwd: work, prompt: '[slow] grok hold', mode: 'auto' });
      const started = await c.waitFor(event => event.type === 'session' && event.first === true, { ms: WAIT_MS, from });
      const sessionId = started.sessionId;
      await heldTurn(sessionId);
      const steerFrom = c.mark();
      await c.cmd('sendMessage', { sessionId, messageId: 'restart-acp-steer-0001', prompt: 'steer-across-restart' });
      // 保持役が子へ書き終えた合図（渡った）を待ってから止める（同じ接続の順序で、停止より先に子へ届く）
      await c.waitFor(event => event.type === 'userMessage.delivered' && event.messageId === 'restart-acp-steer-0001', { ms: 10_000, from: steerFrom });
      server = await controller.restart();
      assert.equal(controller.restarts, 4);
      const turn = await running;
      t.ok('Grok: 止める前に渡した途中送信が、起こし直した後も読まれて返答に現れる',
        turn.outcome === 'ok' && textOf(turn.events).includes('fixture: steer-across-restart'), textOf(turn.events));
    }

    assert.ok(!server.tail(400).includes('[unhandledRejection]'), server.tail(30));
    assert.deepEqual(controller.errors, [], '起こし直しの間に、仕掛けの中の失敗が無い');

    // 後片付けの前に、保持役に残っている子の pid を控える。終わったターンの ACP の子は残っていない
    {
      const probe = await connectHolder({ dataDir, root });
      for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid);
      assert.deepEqual(probe.welcome.children.filter(child => String(child.id).startsWith('acp-')).map(child => child.id), [],
        '終わった ACP の子は保持役に残っていない');
      probe.close();
    }
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
