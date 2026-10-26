// 段 1（issue #143）: 「途中でサーバーを止めて起こし直す」試験の仕掛け（tests/lib/restart.mjs）を、既存の土台に被せて確かめる。
// 止め方は引き継ぎ（handover）ではなく、普通に止めて普通に起こす（SIGTERM → 5 秒で SIGKILL。ADR 0270 の規則 ③）。
// 保持役（core/holder/）は生かしたまま。起こし直したサーバーには AGENT_HOST_ADOPT_HOLDER=1 を渡す（今日の「起動＝復元」の代わり）。
//   1. Claude のターン（fake の held: で代用）: ツールの実行中に止めて起こし直すと、ターンは最後まで流れ、turnEnd・完了時刻・使用量が 1 回。
//      履歴の本文とツールの結果も 1 回ずつ（記録の再生と続きが重ならない）
//   2. ply_shell の start のジョブ: ジョブを始めてターンを終え、止めて起こし直した後に list で読む。今の作りではジョブは消える（赤。
//      段 2・3 で保持役の子に載せたら「残る」に反転する。この判定は今の穴を記録するためのもの）
// サーバーは試験用のデータ置き場で起こす（利用者の ~/.agent-host には触れない）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';
import { installRestartMode, uninstallRestartMode } from '../lib/restart.mjs';

export const name = 'restart-mode';
export const title = '途中でサーバーを止めて起こし直す: 保持役の子（held:）のターンは続き、ply_shell の start のジョブは今の作りでは消える';

const WAIT_MS = 30_000;
const steps = list => `held:steps:${JSON.stringify({ steps: list })}`;
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
const shellCall = (name, args = {}) => `shell:${JSON.stringify({ name, arguments: args })}`;
const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));

/** サーバーを普通に止めて普通に起こし直し、同じハンドルを新しい値に差し替える（restart.mjs の restart と同じことを、試験から明示的に） */
async function restart(controller) {
  const next = await controller.restart();
  assert.ok(next, 'restart は新しいサーバーのハンドルを返す');
  return next;
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-restart-mode-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const pidFile = path.join(scratch, 'job.pid');
  const env = { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_USAGE: '1', AGENT_HOST_RUNTIME_ROOT: root };
  // 環境変数で入っている仕掛け（PLEIAD_TEST_RESTART）は外し、この suite は明示的に起こし直す
  uninstallRestartMode();
  const controller = installRestartMode({ trigger: 'manual' });
  let holderPid = null;
  let server = null;
  let c = null;
  const childPids = new Set();
  try {
    // 保持役を先に起こしておく（detached。サーバーが入れ替わっても子は残る）
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 60_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    server = await startServer({ env, dataDir, timeoutMs: 30_000 });
    c = await open({ port: server.port, token: server.token, autoAllow: true });
    const sessionMeta = id => readSessions(dataDir)[id] ?? null;
    const usageOfSession = id => (readUsage(dataDir)?.records ?? []).filter(record => record.sessionId === id);

    // ---- 1. Claude のターン（held: の fake で代用）
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:restart-held' }, { ms: WAIT_MS });
    assert.equal(first.outcome, 'ok');
    const sessionId = first.sessionId;
    const before = sessionMeta(sessionId)?.completedAt;
    assert.ok(before, '最初のターンの完了時刻がある');
    const script = steps([
      { tool: 'Grep', input: { pattern: 'a' }, result: 'r1', ms: 50 },
      { tool: 'Read', input: { path: 'b' }, result: 'r2', ms: 6000 },
      { text: 'final R' },
    ]);
    const from = c.mark();
    void c.cmd('sendMessage', { sessionId, messageId: 'restart-held-0001', prompt: script }).catch(() => {});
    await c.waitFor(event => event.type === 'tool.start' && event.sessionId === sessionId && event.name === 'Read', { ms: WAIT_MS, from });
    const oldPid = server.child.pid;
    const oldPort = server.port;
    const oldToken = server.token;
    // ツール（6 秒）の実行中に、普通に止めて普通に起こす
    server = await restart(controller);
    assert.notEqual(server.child.pid, oldPid, 'サーバーのプロセスが入れ替わる');
    assert.equal(server.port, oldPort, '同じポートで起こし直す');
    assert.equal(server.token, oldToken, '同じトークンで起こし直す');
    assert.equal(controller.restarts, 1);
    await c.waitFor(event => event.type === 'turnEnd' && event.sessionId === sessionId, { ms: WAIT_MS, from });
    await sleep(500);
    {
      const ends = c.since(from).filter(event => event.type === 'turnEnd' && event.sessionId === sessionId);
      assert.equal(ends.length, 1, 'turnEnd は 1 回');
      assert.equal(ends[0].outcome, 'ok', '最後まで流れて ok');
      const meta = sessionMeta(sessionId);
      assert.equal(meta.interrupted ?? null, null, 'restart の中断にならない');
      assert.equal(meta.turnStartedAt ?? null, null, '走っている印は片付く');
      assert.ok(meta.completedAt > before, '完了時刻を書く');
      assert.equal(usageOfSession(sessionId).length, 2, '使用量は 2 ターン分（最初のターンと、付け直したターン）');
      const loaded = await c.cmd('loadSession', { sessionId });
      assert.equal(loaded.messages.filter(message => message.role === 'assistant' && message.text === 'final R').length, 1, '最後の本文は履歴に 1 回');
      assert.equal(loaded.messages.filter(message => message.role === 'user' && message.text === script).length, 1, '人の発言は 1 回');
      const results = loaded.messages.flatMap(message => message.toolCalls ?? []).map(call => call.result.text);
      assert.deepEqual(results, ['r1', 'r2'], 'ツールの結果が欠けず重ならない');
      const running = await c.cmd('running');
      assert.ok(!running.turns.some(turn => turn.sessionId === sessionId), '走っているターンから外れる');
    }
    t.ok('held: のターン（Claude の代用）: ツールの実行中に普通に止めて起こし直しても、記録の再生と続きで最後まで流れ、turnEnd・完了時刻・使用量・本文・ツールの結果が 1 回ずつ', true);

    // ---- 2. ply_shell の start のジョブ
    // ジョブのプロセスは、サーバーが止まっても残るかもしれない。pid を控えて後片付けで止める
    const command = `${node} -e "require('fs').writeFileSync('${pidFile.replace(/\\/g, '/')}', String(process.pid)); setInterval(() => console.log('tick'), 300)"`;
    const startFrom = c.mark();
    const started = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: shellCall('start', { command, cwd: ROOT }) }, { ms: WAIT_MS });
    assert.equal(started.outcome, 'ok');
    const startResult = c.since(startFrom).find(event => event.type === 'tool.result' && /ジョブ sh-[a-f0-9]+/.test(String(event.text ?? '')));
    const jobId = /sh-[a-f0-9]+/.exec(String(startResult?.text ?? ''))?.[0] ?? null;
    assert.ok(jobId, `ply_shell の start がジョブの id を返す: ${startResult?.text}`);
    const jobPid = await until(() => fs.readFile(pidFile, 'utf8').then(text => Number(text) || null, () => null), WAIT_MS, 'ジョブの pid');
    assert.ok(alive(jobPid), 'ジョブは走っている');

    server = await restart(controller);
    assert.equal(controller.restarts, 2);
    // 起こし直したサーバーで、同じ会話の新しいターンからジョブの一覧を読む
    const listFrom = c.mark();
    const listed = await c.runTurn({ backend: 'fake', sessionId, cwd: ROOT, prompt: shellCall('list') }, { ms: WAIT_MS });
    assert.equal(listed.outcome, 'ok');
    const listText = c.since(listFrom).filter(event => event.type === 'tool.result').at(-1)?.text ?? '';
    const jobs = JSON.parse(listText).jobs ?? [];
    const survived = jobs.some(job => job.jobId === jobId);
    // 今の作りでは、ジョブの一覧はサーバーのメモリにしかないので、起こし直すと空になる（段 2・3 で保持役の子に載せる）
    t.ok('ply_shell の start のジョブは、今の作りではサーバーを止めて起こし直すと消える（赤。段 2・3 で「残る」に反転する）', !survived, JSON.stringify({ jobId, jobs, listText }));
    t.ok('起こし直したサーバーでも、同じ会話のターンは始められる（会話の記録は DB から戻る）', listed.outcome === 'ok' && Boolean(listed.sessionId), JSON.stringify(listed.sessionId));
    // 消えた側の口も確かめる（output はジョブが無いと言う）
    const outputFrom = c.mark();
    await c.runTurn({ backend: 'fake', sessionId, cwd: ROOT, prompt: shellCall('output', { jobId, since: 0 }) }, { ms: WAIT_MS });
    const outputText = c.since(outputFrom).filter(event => event.type === 'tool.result').at(-1)?.text ?? '';
    t.ok('ジョブが消えているので output も「ジョブがありません」になる（今の作り）', /ジョブがありません/.test(outputText), outputText);

    // 後片付け: 走ったままのジョブ（残っていれば）を止める
    if (alive(jobPid)) {
      if (process.platform === 'win32') {
        const { spawnSync } = await import('node:child_process');
        spawnSync('taskkill', ['/PID', String(jobPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try { process.kill(-jobPid, 'SIGKILL'); } catch { try { process.kill(jobPid, 'SIGKILL'); } catch { /* 既に終わっている */ } }
      }
      await until(() => !alive(jobPid), 10_000, 'ジョブが終わる').catch(() => {});
    }
    assert.ok(!server.tail(300).includes('[unhandledRejection]'), server.tail(20));
    assert.deepEqual(controller.errors, [], '起こし直しの間に、仕掛けの中の失敗が無い');

    // 保持役の子（held: の偽の CLI）は、ターンが終わったら記録ごと捨てられている
    {
      const probe = await connectHolder({ dataDir, root });
      for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid);
      assert.deepEqual(probe.welcome.children.map(child => child.id), [], '終わったターンの子の記録は捨てられている');
      probe.close();
    }
  } finally {
    c?.close();
    await server?.stop().catch(() => {});
    // 保持役を終わらせる（子も木ごと止まる）
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
