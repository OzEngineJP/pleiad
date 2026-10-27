// 無停止の更新 段 2b（ADR 0270）: Codex のターン専用の app-server（Pleiad がコンテキストを持つ会話）を保持役に載せ、
// サーバーを普通に止めて起こし直してもターンが続くことを確かめる。
// 止め方は引き継ぎ（handover）ではなく、普通に止めて普通に起こす（SIGTERM → 5 秒で SIGKILL。ADR 0270 の規則 ③）。
// 専用の app-server は 1 ターン 1 本（子の id は codex-turn-…）。起動で拾った新しいサーバーは、札のターンを CodexRpc につないで続きを受ける
// （core/backends/codex-held.mjs の expandCodexHeld → codex.mjs の adoptTurn）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';
import { installRestartMode, uninstallRestartMode } from '../lib/restart.mjs';

export const name = 'restart-codex-turn';
export const title = '途中でサーバーを止めて起こし直す: Codex のターン専用の app-server（PleiPad がコンテキストを持つ会話）が続く';

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
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-restart-codex-turn-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const work = path.join(scratch, 'work');
  const home = path.join(scratch, 'home');
  const gates = path.join(scratch, 'gates');
  await Promise.all([work, home, gates].map(dir => fs.mkdir(dir, { recursive: true })));
  uninstallRestartMode();
  const controller = installRestartMode({ trigger: 'manual' });
  const env = {
    AGENT_HOST_BACKENDS: 'codex',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs')}"`,
    AGENT_HOST_RUNTIME_ROOT: root,
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    AGENT_HOST_FAKE_GATE_DIR: gates,
  };
  let holderPid = null, server = null, c = null;
  const childPids = new Set();
  try {
    const found = await ensureHolder({ dataDir, root, idleMs: 60_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    server = await startServer({ env, dataDir, timeoutMs: 30_000 });
    c = await open({ port: server.port, token: server.token });
    // この場所の指示を Pleiad が担当にする（Pleiad のコンテキストの口を開く会話 = ターン専用の app-server を使う）
    await c.cmd('setContextSettings', { place: work, kind: 'instruction', value: { owner: 'ply', user: { sources: ['codex'], excludePaths: [] }, directory: { sources: ['common'], excludePaths: [] } } });

    const from = c.mark();
    const running = c.runTurn({ backend: 'codex', cwd: work, prompt: 'gate:codex-dedicated', mode: 'auto' });
    const started = await c.waitFor(event => event.type === 'session' && event.first === true, { ms: WAIT_MS, from });
    const sessionId = started.sessionId;
    const held = await until(async () => {
      const turn = (await c.cmd('running')).turns.find(row => row.sessionId === sessionId);
      return turn?.held ? turn : null;
    }, WAIT_MS, 'Codex のターンが held（ターン専用の app-server が保持役の子）');
    assert.ok(held);

    const afterRestart = c.mark();
    server = await controller.restart();
    assert.equal(controller.restarts, 1);
    // 起こし直したサーバーが、同じ app-server につないでターンを続ける（running の held が戻る）。ゲートを開くと終わる
    await until(async () => {
      const turn = (await c.cmd('running')).turns.find(row => row.sessionId === sessionId);
      return turn?.held ? turn : null;
    }, WAIT_MS, '起こし直したサーバーで Codex のターンが held に戻る');
    await fs.writeFile(path.join(gates, 'codex-dedicated'), '');
    const result = await c.waitFor(event => event.type === 'tool.result' && event.sessionId === sessionId, { ms: WAIT_MS, from: afterRestart });
    const turn = await running;
    const text = turn.events.filter(event => event.type === 'text.delta').map(event => event.text).join('');
    t.ok('Codex の専用 app-server: ツールの実行中に止めて起こし直しても、ターンは最後まで流れて ok',
      turn.outcome === 'ok' && text.includes('end codex-dedicated'), JSON.stringify({ outcome: turn.outcome, text: text.slice(-200) }));
    await sleep(300);
    const ends = c.since(from).filter(event => event.type === 'turnEnd' && event.sessionId === sessionId);
    assert.equal(ends.length, 1, 'turnEnd は 1 回');
    assert.equal(ends[0].outcome, 'ok');
    // 起こし直した後の出来事は、続きの側（ゲートの完了・本文の後半・turnEnd）だけ。再生は画面へ流さない（二重にならない）
    const tail = c.since(from).filter(event => event.sessionId === sessionId && ['tool.result', 'text.delta'].includes(event.type));
    t.ok('Codex の専用 app-server: 止めた後の続きが届き、記録の再生で二重にならない',
      String(result.text).includes('built') && tail.filter(event => event.type === 'text.delta' && event.text === 'end codex-dedicated').length === 1,
      JSON.stringify(tail.map(event => [event.type, event.text])));

    // 途中送信を受け付けた直後に止める。Codex は turn/steer の応答と、userMessage の通知が別なので両方の境目を守る。
    {
      const steerFrom = c.mark();
      const steering = c.runTurn({ backend: 'codex', cwd: work, prompt: 'slow:codex-steer-across-restart', mode: 'auto' }, { ms: WAIT_MS });
      const started = await c.waitFor(event => event.type === 'session' && event.first === true, { ms: WAIT_MS, from: steerFrom });
      const steerSession = started.sessionId;
      await until(async () => (await c.cmd('running')).turns.find(row => row.sessionId === steerSession)?.held ? true : null, WAIT_MS, 'Codex の steer 用ターンが保持役に載る');
      await c.cmd('sendMessage', { sessionId: steerSession, messageId: 'restart-codex-steer-0001', prompt: 'codex-steer-across-restart' });
      server = await controller.restart();
      assert.equal(controller.restarts, 2);
      const delivered = await c.waitFor(event => event.type === 'userMessage' && event.messageId === 'restart-codex-steer-0001', { ms: WAIT_MS, from: steerFrom });
      const matching = c.since(steerFrom).filter(event => event.type === 'userMessage' && event.messageId === 'restart-codex-steer-0001');
      t.ok('Codex の途中送信: 送信の受理直後に止めても、新サーバーで同じ発言が一度だけ届く',
        delivered?.messageId === 'restart-codex-steer-0001' && matching.length === 1, JSON.stringify(matching));
      // Codex の fake は steer を記録した後もターンの終了通知を返さないため、終了待ちはしない。
      void steering;
    }
    assert.ok(!server.tail(400).includes('[unhandledRejection]'), server.tail(30));
    assert.deepEqual(controller.errors, [], '起こし直しの間に、仕掛けの中の失敗が無い');

    // 後片付けの前に、保持役に残っている子の pid を控える。steer 後のターンはまだ進行中なので app-server は保持される
    {
      const probe = await connectHolder({ dataDir, root });
      for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid);
      assert.equal(probe.welcome.children.filter(child => String(child.id).startsWith('codex-turn-')).length, 1,
        'steer を受けた進行中ターンの専用 app-server は保持役に残る');
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
