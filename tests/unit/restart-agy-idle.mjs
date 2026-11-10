// 途中でサーバーを止めて起こし直す（tests/lib/restart.mjs）: 保持役に載せた、次の発言を待つ agy（idle の子）が残らない。
//
// 待つ agy を止めるタイマー（core/backends/antigravity.mjs の armIdle）は前のサーバーのメモリにあり、ターンの終わりに札と印も外れているので、
// 新しいサーバーは付け直さず、使い回しもしない。起動で止める（core/backends/antigravity-held.mjs の sweepIdleAtStart。docs/zero-downtime-update/stage3-agy.md）。
//   1. 待っている agy（I）を持ったまま普通に止めて起こし直すと、agy のターンを始めなくても子が止まり、エージェント定義の置き場（held-*）も消える
//   2. 同じ起こし直しで、ターン中の agy（R。札と印がある）は止めずに付け直し、ターンは 1 回だけ ok で締まる。次のターンも同じ agy を使う
//   3. 止めた I の次のターンは `--conversation` で起こし直して続く
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';
import { cleanupTestHolder } from '../lib/cleanup-test-holder.mjs';
import { installRestartMode, uninstallRestartMode } from '../lib/restart.mjs';

export const name = 'restart-agy-idle';
export const title = '途中でサーバーを止めて起こし直す: 保持役の待っている agy は起動で止め、ターン中の agy は付け直す';

const WAIT_MS = 30_000;
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
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-restart-agy-idle-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const work = path.join(scratch, 'work');
  const pidFile = path.join(scratch, 'agy-pids.json');
  const argsFile = path.join(scratch, 'agy-args.json');
  await fs.mkdir(work, { recursive: true });
  const gates = await createFakeGates(scratch);
  const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]'));
  // 起こされた pid・引数のうち会話の agy だけを拾う（送信の関所・裏の一覧取得も同じ控えに残る。会話の起こしは --input-format を持つ）
  const convPids = async () => {
    const [pids, args] = await Promise.all([readJson(pidFile), readJson(argsFile)]);
    return pids.filter((_, i) => args[i]?.includes('--input-format'));
  };
  const convArgs = async () => (await readJson(argsFile)).filter(a => a.includes('--input-format'));
  // 既定が先から分かっている状態を作る一覧の写し。無いと、ターンのあいだに一覧が届いて渡すモデルが変わり、会話を --conversation で起こし直して揺れる
  const dir = path.join(dataDir, 'antigravity');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({
    rows: [
      { id: 'fake-antigravity-1', label: 'Fake Antigravity 1' },
      { id: 'fake-antigravity-2', label: 'Fake Antigravity 2 (Thinking)' },
      { id: 'fake-flash-high', label: 'Fake Flash (High)' },
      { id: 'fake-flash-low', label: 'Fake Flash (Low)' },
    ],
    defaultLabel: 'Fake Flash (High)', fetchedAt: Date.now(),
  }));
  // 環境変数で入っている仕掛け（PLEIAD_TEST_RESTART）は外し、この suite は明示的に起こし直す
  uninstallRestartMode();
  const controller = installRestartMode({ trigger: 'manual' });
  // 待つ agy を止めるまでの時間は既定（30 分）のまま。この試験の間にタイマーでは止まらない
  const env = {
    AGENT_HOST_BACKENDS: 'antigravity', AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-agy.mjs')}"`, AGENT_HOST_RUNTIME_ROOT: root,
    FAKE_AGY_PID_FILE: pidFile, FAKE_AGY_ARGS_FILE: argsFile, FAKE_AGY_GATE_DIR: gates.env.AGENT_HOST_FAKE_GATE_DIR,
  };
  let holderPid = null, server = null, c = null;
  try {
    // 保持役を先に起こしておく（detached。サーバーが入れ替わっても子は残る）
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 60_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    server = await startServer({ env, dataDir, timeoutMs: 30_000 });
    c = await open({ port: server.port, token: server.token });

    // I: ターンを終えて次の発言を待つ agy
    const idle = await c.runTurn({ backend: 'antigravity', cwd: work, prompt: 'plain' }, { ms: WAIT_MS });
    assert.equal(idle.outcome, 'ok', server.tail(10));
    const [idlePid] = await convPids();
    const idleArgs = (await convArgs())[0] ?? [];
    const idleHome = idleArgs[idleArgs.lastIndexOf('--add-dir') + 1];
    assert.ok(path.basename(String(idleHome)).startsWith('held-'), `保持役に載せた agy の置き場は held-* ${JSON.stringify(idleArgs)}`);
    await fs.stat(idleHome);

    // R: ツールの実行中（ゲートが開くまで）の agy
    const from = c.mark();
    const running = c.runTurn({ backend: 'antigravity', cwd: work, prompt: 'gated:r-tool' }, { ms: WAIT_MS * 2 });
    const started = await c.waitFor(event => event.type === 'tool.start', { ms: WAIT_MS, from });
    const rId = started.sessionId;
    await until(async () => (await c.cmd('running')).turns.some(turn => turn.sessionId === rId && turn.held), WAIT_MS, 'R のターンが保持役に載る');
    await sleep(800);   // 札の置き直し（touchCard）が保持役へ届くまで
    const rPid = (await convPids()).at(-1);
    assert.notEqual(rPid, idlePid, '会話ごとに別の agy');
    assert.ok(alive(idlePid) && alive(rPid));

    server = await controller.restart();
    assert.equal(controller.restarts, 1);

    // 1. 待っている agy は、新しいサーバーの起動で止まる（agy のターンを始めなくても）
    await until(() => !alive(idlePid), 15_000, '待っている agy が起動で止まる')
      .catch(error => { throw new Error(`${error.message}\n${server.tail(20)}`); });
    await until(() => fs.stat(idleHome).then(() => false, () => true), 10_000, '止めた agy の置き場が消える');
    t.ok('待っている agy を持ったまま止めて起こし直すと、agy のターンを始めなくても子が止まり、置き場も消える',
      server.tail(200).includes('待機中の agy 1 件を止めた'), server.tail(20));

    // 2. ターン中の agy は止めずに付け直し、ターンは 1 回だけ ok で締まる
    assert.ok(alive(rPid), 'ターン中の agy は起こし直しても走り続ける');
    await gates.open('r-tool');
    const turn = await running;
    await sleep(300);
    const ends = c.since(from).filter(event => event.type === 'turnEnd' && event.sessionId === rId);
    t.ok('ターン中の agy（札と印がある）は起動で止めず、付け直したターンは 1 回だけ ok で締まる',
      turn.outcome === 'ok' && ends.length === 1 && server.tail(300).includes('ターンを付け直した'), JSON.stringify({ outcome: turn.outcome, ends: ends.length }));
    const spawnedBefore = (await convPids()).length;
    const nextR = await c.runTurn({ backend: 'antigravity', sessionId: rId, cwd: work, prompt: 'next R' }, { ms: WAIT_MS });
    assert.equal(nextR.outcome, 'ok', server.tail(10));
    // 同じ agy を使い回すか、届いた一覧で既定が明示されて --conversation で起こし直す（新しい会話にはならない）
    const convsAfterR = await convArgs();
    const spawnedAfterR = convsAfterR.length;
    t.ok('付け直した agy の会話の次のターンは同じ会話で続く（使い回しか --conversation で起こし直し）',
      spawnedAfterR <= spawnedBefore + 1 && convsAfterR.slice(spawnedBefore).every(a => a[a.indexOf('--conversation') + 1] === rId),
      JSON.stringify({ spawnedBefore, spawnedAfterR, added: convsAfterR.slice(spawnedBefore) }));

    // 3. 止めた I の次のターンは --conversation で起こし直す
    const nextI = await c.runTurn({ backend: 'antigravity', sessionId: idle.sessionId, cwd: work, prompt: 'after restart I' }, { ms: WAIT_MS });
    assert.equal(nextI.outcome, 'ok', server.tail(10));
    const pids = await convPids();
    const last = (await convArgs()).at(-1) ?? [];
    t.ok('止めた agy の会話の次のターンは --conversation で起こし直して続く',
      pids.length === spawnedAfterR + 1 && last[last.indexOf('--conversation') + 1] === idle.sessionId, JSON.stringify({ pids, last }));
    assert.ok(!server.tail(300).includes('[unhandledRejection]'), server.tail(20));
  } finally {
    c?.close();
    await server?.stop().catch(() => {});
    if (holderPid && alive(holderPid)) {
      // 保持役が今生きていると言う子だけを待つ（終わった pid は別のプロセスへ使い回されうる）
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      const pids = (probe?.welcome?.children ?? []).filter(child => child.pid && child.alive).map(child => child.pid);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
      for (const pid of pids) await until(() => !alive(pid), 10_000, `偽の agy（${pid}）が終わる`).catch(() => {});
    }
    uninstallRestartMode();
    await cleanupTestHolder(dataDir, root).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
