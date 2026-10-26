// 無停止の更新 段階 3 の `!` の行: 入力欄の `!`（シェルの行）を保持役の子に載せ、通常停止したサーバー A の後で
// 起動したサーバー B が続きを読む（core/shell-held.mjs・core/shell-runs.mjs の restore。docs/zero-downtime-update/plan.md「段階 3」の `!` の行の実装のメモ）。
//   1. 切り替え: 実行場所の置き場（AGENT_HOST_RUNTIME_ROOT）があれば既定で載る（running の shells に held）。AGENT_HOST_SHELL_HOLDER=off なら今の流れ（サーバーの子）
//   2. 載せた行も今の流れと同じ: 標準入力は閉じている（read は待たずに終わる）・終了コード・stdout と stderr を分ける・止めると stopped
//   3. A で走らせたまま通常停止する。時点: 出力の途中（A が流した後、停止中に出た出力も B が流す）・終わった直後（A が離れた後、B が起きる前に終わった）・
//      停止要求の直後。どれも出力の取りこぼし・重なりが無く、終わり（shell.done と会話の未送の追記）が 1 回だけ
//   4. サーバー停止で held の `!` の行は止めない。アプリ終了では保持役が子を止める
//   5. 後片付け: 保持役・包み・シェル・サーバーが残らない
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions } from '../lib/data-store.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';


export const name = 'adopt-shell';
export const title = '`!` の行を保持役に載せ、通常起動で続きを読む（出力の途中・終わった直後・止める最中。出力と終わりが 1 回だけ）';

const WAIT_MS = 25_000;
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
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-shell-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const gates = path.join(scratch, 'gates');
  await fs.mkdir(gates);
  // シェル（Windows は Git Bash、ほかは $SHELL か /bin/sh）が読むゲートのファイル。開けるまで待つ（時間ではなくファイルの出来事で進める）
  const gate = gateName => path.join(gates, gateName).replace(/\\/g, '/');
  const waitGate = gateName => `while [ ! -f '${gate(gateName)}' ]; do sleep 0.05; done`;
  const openGate = gateName => fs.writeFile(path.join(gates, gateName), '');
  const env = { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_RUNTIME_ROOT: root };
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  const pendingOf = (id, runId) => (sessionMeta(id)?.shellPending ?? []).filter(e => e.runId === runId);
  let s1 = null, s2 = null, c1 = null, c2 = null, holderPid = null, off = null;
  const childPids = new Set();
  // 保持役の子の状態（つなぐと、つないでいた親は切られる。サーバーが居ない間だけ使う）
  const collect = () => connectHolder({ dataDir, root }).catch(() => null);
  try {
    // 保持役を先に起こしておく（detached。誰もつながず子も無ければ 20 秒で終わる）。サーバーは同じ保持役につなぐ
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    // ---- 1. AGENT_HOST_SHELL_HOLDER=off は今の流れ（別のデータ置き場・実行場所。保持役は起こさない）
    {
      const offData = path.join(scratch, 'off-data');
      off = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_RUNTIME_ROOT: path.join(scratch, 'off-runtime'), AGENT_HOST_SHELL_HOLDER: 'off' }, dataDir: offData, timeoutMs: 40_000 });
      const c = await open({ port: off.port, token: off.token });
      try {
        const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
        const from = c.mark();
        await c.cmd('runShell', { sessionId, runId: 'shell-off-0001', command: `echo off-run; ${waitGate('off')}`, cwd: ROOT });
        await c.waitFor(e => e.type === 'shell.output' && e.runId === 'shell-off-0001' && e.text.includes('off-run'), { from, ms: WAIT_MS });
        const running = await c.cmd('running');
        const row = running.shells.find(s => s.runId === 'shell-off-0001');
        await openGate('off');
        await c.waitFor(e => e.type === 'shell.done' && e.runId === 'shell-off-0001', { from, ms: WAIT_MS });
        const probe = await connectHolder({ dataDir: offData, root: path.join(scratch, 'off-runtime') }).catch(error => error);
        t.ok('AGENT_HOST_SHELL_HOLDER=off: `!` の行は保持役に載らない（running の shells に held が無く、保持役も起きない）', row && !row.held && probe?.code === 'HOLDER_NONE', JSON.stringify(row));
      } finally { c.close(); await off.stop(); off = null; }
    }

    s1 = await startServer({ env, dataDir, timeoutMs: 40_000 });
    c1 = await open({ port: s1.port, token: s1.token });
    const { sessionId } = await c1.cmd('newSession', { backend: 'fake', cwd: ROOT });
    const run = async (runId, command, client = c1) => {
      const reply = await client.cmd('runShell', { sessionId, runId, command, cwd: ROOT });
      assert.equal(reply.runId, runId);
    };
    const outputsOf = (events, runId, stream = 'stdout') => events.filter(e => e.type === 'shell.output' && e.runId === runId && e.stream === stream).map(e => e.text).join('');
    const donesOf = (events, runId) => events.filter(e => e.type === 'shell.done' && e.runId === runId);

    // ---- 2. 載せた行も今の流れと同じ
    {
      const from = c1.mark();
      await run('shell-same-0001', `read line; echo "read:$?"; echo to-err >&2; exit 4`);
      const done = await c1.waitFor(e => e.type === 'shell.done' && e.runId === 'shell-same-0001', { from, ms: WAIT_MS });
      const events = c1.since(from);
      assert.equal(done.exitCode, 4, JSON.stringify(done));
      assert.equal(outputsOf(events, 'shell-same-0001').trim(), 'read:1', '標準入力は閉じている（read は待たずに終わる）');
      assert.equal(outputsOf(events, 'shell-same-0001', 'stderr').trim(), 'to-err', 'stderr は stderr として流れる');
      const entry = await until(() => pendingOf(sessionId, 'shell-same-0001')[0], WAIT_MS, '未送の追記');
      assert.equal(entry.stdout.trim(), 'read:1');
      assert.equal(entry.stderr.trim(), 'to-err');
      assert.equal(entry.exitCode, 4);
      t.ok('保持役に載せた行: 標準入力は閉じていて read は待たない・stdout と stderr を分ける・終了コードと未送の追記は今の流れと同じ', true);

      const from2 = c1.mark();
      await run('shell-stop-0001', `echo before-stop; sleep 600`);
      await c1.waitFor(e => e.type === 'shell.output' && e.runId === 'shell-stop-0001', { from: from2, ms: WAIT_MS });
      const running = await c1.cmd('running');
      assert.equal(running.shells.find(s => s.runId === 'shell-stop-0001')?.held, true, '既定（実行場所の置き場あり）で保持役に載る（running の shells に held）');
      assert.equal(running.count, 0, '`!` の行は count に入らない');
      assert.equal((await c1.cmd('stopShell', { runId: 'shell-stop-0001' })).stopped, true);
      const stopped = await c1.waitFor(e => e.type === 'shell.done' && e.runId === 'shell-stop-0001', { from: from2, ms: WAIT_MS });
      assert.equal(stopped.stopped, true, JSON.stringify(stopped));
      assert.equal(stopped.exitCode, null);
      t.ok('既定で保持役に載り（running の shells に held）、止めると stopped で終わる（シェルの木ごと）', true);
    }

    // ---- 3. A を止めて B を起こす。M: 出力の途中 / F: A が離れた後・B が起きる前に終わる / S: 止めるのを頼んだ直後
    const from1 = c1.mark();
    await run('shell-mid-00001', `echo first; ${waitGate('mid')}; echo second; echo err-second >&2; ${waitGate('mid2')}; echo third; exit 3`);
    await run('shell-fin-00001', `echo fin-first; ${waitGate('fin')}; echo fin-last; exit 5`);
    await run('shell-stp-00001', `echo stp-first; sleep 600`);
    for (const runId of ['shell-mid-00001', 'shell-fin-00001', 'shell-stp-00001']) {
      await c1.waitFor(e => e.type === 'shell.output' && e.runId === runId, { from: from1, ms: WAIT_MS });
    }
    // A の通常停止中に出た分を、B が保持役の記録から読み直す
    const portA = s1.port, tokenA = s1.token;
    const events1 = c1.since(from1);
    await c1.cmd('stopShell', { runId: 'shell-stp-00001' });
    c1.close(); c1 = null;
    await s1.stop(); s1 = null;
    // A が居ない間に出る出力と、終わる行（B はまだ居ない。保持役が記録する）
    await openGate('mid');
    await openGate('fin');
    {
      const probe = await until(async () => {
        const client = await collect();
        const child = client?.welcome.children.find(x => x.label?.runId === 'shell-fin-00001');
        if (child && !child.alive) return client;
        client?.close();
        return null;
      }, WAIT_MS, 'F が S2 の起きる前に終わる');
      const mid = probe.welcome.children.find(x => x.label?.runId === 'shell-mid-00001');
      assert.ok(mid?.alive && mid.label.kind === 'shell', 'M は走ったまま保持役に残る（札つき）');
      probe.close();
    }
    s2 = await startServer({ env: { ...env, AGENT_HOST_PORT: String(portA), AGENT_HOST_TOKEN: tokenA }, dataDir, timeoutMs: 60_000 });
    assert.equal(s2.port, portA, 'S2 は S1 と同じポート');
    c2 = await open({ port: portA, token: tokenA });
    // S2 で続きを流して終わる
    await until(() => (c2.events.some(e => e.type === 'shell.output' && e.runId === 'shell-mid-00001' && e.text.includes('second'))) || outputsOf(events1, 'shell-mid-00001').includes('second'), WAIT_MS, 'M の second');
    {
      const loaded = await c2.cmd('loadSession', { sessionId });
      const row = loaded.messages.find(m => m.runId === 'shell-mid-00001');
      assert.ok(row?.running && row.stdout === 'first\nsecond\n', `開き直すと B で走っている行（A の分と停止中の分）: ${JSON.stringify(row)}`);
    }
    await openGate('mid2');
    const doneM = await c2.waitFor(e => e.type === 'shell.done' && e.runId === 'shell-mid-00001', { ms: WAIT_MS });
    assert.equal(doneM.exitCode, 3);
    const doneF = await until(() => donesOf(c2.events, 'shell-fin-00001')[0], WAIT_MS, 'F の終わり');
    assert.equal(doneF.exitCode, 5);
    await until(() => [...donesOf(events1, 'shell-stp-00001'), ...donesOf(c2.events, 'shell-stp-00001')].length, WAIT_MS, 'S の終わり');
    await until(() => ['shell-mid-00001', 'shell-fin-00001', 'shell-stp-00001'].every(id => pendingOf(sessionId, id).length), WAIT_MS, '未送の追記');
    await sleep(300);   // 遅れて重なる出来事が無いことを見る（待ちの終わりは上の出来事）
    const all = [...events1, ...c2.events];
    {
      assert.equal(outputsOf(all, 'shell-mid-00001'), 'first\nsecond\nthird\n', `M: 出力は欠けず重ならない（S1 の分 ${JSON.stringify(outputsOf(events1, 'shell-mid-00001'))}）`);
      assert.equal(outputsOf(all, 'shell-mid-00001', 'stderr'), 'err-second\n');
      assert.equal(outputsOf(events1, 'shell-mid-00001'), 'first\n', 'M: A が流したのは停止前の分だけ');
      assert.equal(donesOf(all, 'shell-mid-00001').length, 1, 'M: shell.done は 1 回');
      const [entry, ...rest] = pendingOf(sessionId, 'shell-mid-00001');
      assert.equal(rest.length, 0, 'M: 未送の追記は 1 件');
      assert.equal(entry.stdout, 'first\nsecond\nthird\n');
      assert.equal(entry.stderr, 'err-second\n');
      assert.equal(entry.exitCode, 3);
      t.ok('出力の途中で A を止める: A が流した分を B は流し直さず、停止中の出力と続きを B が流す。終わり（shell.done・未送の追記）は B で 1 回', true);
    }
    {
      assert.equal(outputsOf(all, 'shell-fin-00001'), 'fin-first\nfin-last\n');
      assert.equal(donesOf(all, 'shell-fin-00001').length, 1);
      assert.equal(pendingOf(sessionId, 'shell-fin-00001').length, 1);
      assert.equal(pendingOf(sessionId, 'shell-fin-00001')[0].exitCode, 5);
      t.ok('S1 が離れた後・S2 が起きる前に終わった行: S2 が終わりを 1 回だけ記録する（出力も欠けない）', true);
    }
    {
      const dones = donesOf(all, 'shell-stp-00001');
      assert.equal(dones.length, 1, `S: shell.done は 1 回（${dones.map(d => (events1.includes(d) ? 'S1' : 'S2')).join(',')}）`);
      assert.equal(dones[0].stopped, true, JSON.stringify(dones[0]));
      const entries = pendingOf(sessionId, 'shell-stp-00001');
      assert.equal(entries.length, 1, 'S: 未送の追記は 1 件');
      assert.equal(entries[0].stopped, true);
      t.ok(`止める最中に引き継ぐ: 止めた行として 1 回だけ終わる（終わりを記録したのは ${events1.includes(dones[0]) ? 'S1' : 'S2'}）`, true);
    }
    // 次の発言で渡すのは S2（未送の追記はそのまま渡る）
    {
      const from = c2.mark();
      await c2.cmd('sendMessage', { sessionId, messageId: 'adopt-shell-next-01', prompt: 'echo:next' });
      await c2.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: WAIT_MS });
      const handed = c2.since(from).find(e => e.type === 'shell.handed');
      assert.ok(['shell-mid-00001', 'shell-fin-00001', 'shell-stp-00001'].every(id => handed?.runIds?.includes(id)), JSON.stringify(handed));
      t.ok('B が復元した行は B の次の発言で渡る', true);
    }
    // 保持役から子の記録が捨てられている（終わりを記録した後の release）
    {
      const probe = await collect();
      const left = (probe?.welcome.children ?? []).filter(x => x.label?.kind === 'shell');
      probe?.close();
      assert.equal(left.length, 0, `保持役に残る \`!\` の子は無い: ${JSON.stringify(left.map(x => [x.label.runId, x.alive]))}`);
      t.ok('終わった `!` の子は保持役から捨てられる（release）', true);
    }
    assert.ok(!s2.tail(400).includes('[unhandledRejection]'), s2.tail(20));
    c2.close(); c2 = null;
    await s2.stop(); s2 = null;
  } finally {
    c1?.close();
    c2?.close();
    await off?.stop();
    await s1?.stop();
    await s2?.stop();
    if (holderPid) {
      // 終わるのを待つのは、今の時点で保持役が生きていると言う子だけ（終わった子の pid は使い回されうる）
      const probe = await collect();
      if (probe) for (const child of probe.welcome.children) if (child.pid && child.alive) childPids.add(child.pid);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
      for (const pid of childPids) await until(() => !alive(pid), 10_000, `包み（${pid}）が終わる`).catch(() => { try { process.kill(pid); } catch { /* 既に終わっている */ } });
    }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
