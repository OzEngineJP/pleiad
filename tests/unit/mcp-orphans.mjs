import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMcpLedger, elapsedSeconds } from '../../core/mcp-ledger.mjs';
import { ensureDataSchema } from '../../core/data-schema.mjs';
import { openData } from '../../core/data-schema.mjs';
import { mcpProcessTable, mcpToolCacheTable } from '../../core/db.mjs';

export const name = 'mcp-orphans';
export const title = '取り残した MCP プロセスを起動時に木ごと片付ける（PID 再利用の誤爆はしない）';
const until = async test => { for (let i = 0; i < 200; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('fixture timeout'); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });

export default async function (t) {
  // ps の etime（macOS の ps には etimes が無いので、両方にある etime を読む）
  t.ok('etime の mm:ss・hh:mm:ss・dd-hh:mm:ss を秒にし、読めなければ null',
    elapsedSeconds('00:05') === 5 && elapsedSeconds(' 01:02') === 62 && elapsedSeconds('1:02:03') === 3723
    && elapsedSeconds('2-01:02:03') === 176523 && elapsedSeconds('x') === null && elapsedSeconds('12') === null);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-orphans-'));
  const dataDir = path.join(dir, 'data');
  const children = [];
  try {
    await ensureDataSchema(dataDir);

    // ---- 一覧の写し（mcp_tool_cache） ----
    {
      const { db, release } = openData(dataDir);
      try {
        const cache = mcpToolCacheTable(db, { limit: 4 });
        cache.put('s1:aaa', 's1', { tools: [{ name: 'a' }], caps: {} });
        assert.deepEqual(cache.get('s1:aaa'), { tools: [{ name: 'a' }], caps: {} });
        cache.put('s1:bbb', 's1', { tools: [], caps: { resources: {} } });
        cache.put('s2:ccc', 's2', { tools: [], caps: {} });
        cache.prune(['s1'], new Set(['s1:bbb']));
        assert(cache.get('s1:aaa') === undefined && cache.get('s1:bbb') !== undefined && cache.get('s2:ccc') !== undefined);
        cache.delete('s1:bbb');
        assert(cache.get('s1:bbb') === undefined);
      } finally { release(); }
      t.ok('一覧の写しは DB の行に残り、キー・サーバー id ごとの整理が効く', true);
    }

    // ---- 孤児の掃除 ----
    {
      // 死んだ親（終わらせた子の pid を使い回しにくい高い値ではなく、実際に死んだ pid）
      const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
      await new Promise(r => dead.once('exit', r));
      const deadParent = dead.pid;

      const orphan = sleeper(); children.push(orphan);
      const stillHasParent = sleeper(); children.push(stillHasParent);
      const liveParent = sleeper(); children.push(liveParent);
      const reusedParent = sleeper(); children.push(reusedParent);
      const orphanOnReused = sleeper(); children.push(orphanOnReused);

      const { db, release } = openData(dataDir);
      let seqOrphan, seqAlive, seqReused;
      try {
        const procs = mcpProcessTable(db);
        // 親が死んでいる孤児 → 止める
        seqOrphan = procs.add({ pid: orphan.pid, parentPid: deadParent, parentStarted: 1, command: 'fake-mcp', key: 'k1' });
        // 親が生きていて起動時刻も近い → 台帳の持ち主（別の生きたサーバー）の子。止めない
        seqAlive = procs.add({ pid: stillHasParent.pid, parentPid: liveParent.pid, parentStarted: Date.now(), command: 'live', key: 'k2' });
        // 親の PID は生きているが起動時刻が台帳と違う → PID 再利用とみなして止める
        seqReused = procs.add({ pid: orphanOnReused.pid, parentPid: reusedParent.pid, parentStarted: Date.now() - 3_600_000, command: 'reuse', key: 'k3' });
      } finally { release(); }

      const logs = [];
      const ledger = createMcpLedger({ dataDir, log: l => logs.push(l) });
      let swept;
      try { swept = await ledger.sweep(); } finally { ledger.release(); }
      assert(swept.length === 2, `孤児 2 件だけ: ${JSON.stringify(swept.map(r => r.pid))}`);
      await until(() => !alive(orphan.pid) && !alive(orphanOnReused.pid));
      assert(alive(stillHasParent.pid) && alive(liveParent.pid) && alive(reusedParent.pid), '親の生きているものは止めない');
      assert(logs.length === 2, `ログ 2 行: ${logs.join(' | ')}`);

      const { db: db2, release: release2 } = openData(dataDir);
      try {
        const rows = mcpProcessTable(db2).rows();
        const bySeq = Object.fromEntries(rows.map(r => [r.seq, r]));
        assert(bySeq[seqOrphan].killedAt && bySeq[seqReused].killedAt);
        assert(bySeq[seqAlive].killedAt == null && bySeq[seqAlive].closedAt == null);
        // close した行は次の掃除の対象から外れる
        mcpProcessTable(db2).close(seqAlive);
        assert(mcpProcessTable(db2).unclosed().length === 0);
      } finally { release2(); }
      t.ok('親の死んだ MCP は木ごと止めて台帳に残す。親の生きているものと、閉じたものは残す', true);
    }

    // ---- worktree を消す前の回収（sweepCwd。Issue #142）----
    {
      const wt = path.join(dir, 'wt');
      const dead2 = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
      await new Promise(r => dead2.once('exit', r));
      const deadParent2 = dead2.pid;
      const otherParent = sleeper(); children.push(otherParent);   // 別の生きたサーバー役
      const mine = sleeper(); children.push(mine);                 // cwd が wt の中・このサーバーの子 → 止める
      const orphanIn = sleeper(); children.push(orphanIn);         // cwd が wt の中・親は死んでいる → 止める
      const foreign = sleeper(); children.push(foreign);           // cwd が wt の中・別の生きたサーバーの子 → 止めない
      const outside = sleeper(); children.push(outside);           // cwd が wt の外・このサーバーの子 → 止めない
      const prefix = sleeper(); children.push(prefix);             // cwd が wt と同じ綴りで始まるだけの外（wt2）→ 止めない
      const reused = sleeper(); children.push(reused);             // cwd が wt の中だが記録の起動時刻と違う（PID 再利用）→ 止めない
      const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
      await new Promise(r => gone.once('exit', r));                // もう居ない → 記録だけ締める

      let seqMine, seqOrphan, seqForeign, seqOutside, seqPrefix, seqReused, seqGone;
      const { db, release } = openData(dataDir);
      try {
        const procs = mcpProcessTable(db);
        const now = Date.now();
        seqMine = procs.add({ pid: mine.pid, parentPid: process.pid, parentStarted: now, command: 'm1', cwd: path.join(wt, 'sub'), at: now });
        seqOrphan = procs.add({ pid: orphanIn.pid, parentPid: deadParent2, parentStarted: 1, command: 'm2', cwd: wt, at: now });
        seqForeign = procs.add({ pid: foreign.pid, parentPid: otherParent.pid, parentStarted: now, command: 'm3', cwd: wt, at: now });
        seqOutside = procs.add({ pid: outside.pid, parentPid: process.pid, parentStarted: now, command: 'm4', cwd: path.join(dir, 'elsewhere'), at: now });
        seqPrefix = procs.add({ pid: prefix.pid, parentPid: process.pid, parentStarted: now, command: 'm5', cwd: `${wt}2`, at: now });
        seqReused = procs.add({ pid: reused.pid, parentPid: process.pid, parentStarted: now, command: 'm6', cwd: wt, at: now - 3_600_000 });
        seqGone = procs.add({ pid: gone.pid, parentPid: deadParent2, parentStarted: 1, command: 'm7', cwd: wt, at: now });
      } finally { release(); }

      const logs = [];
      const ledger = createMcpLedger({ dataDir, log: l => logs.push(l) });
      let swept;
      try { swept = await ledger.sweepCwd(wt); } finally { ledger.release(); }
      assert(swept.length === 3, `wt の中の自分の子・孤児・もう居ない分の 3 件だけ: ${JSON.stringify(swept.map(r => r.pid))}`);
      await until(() => !alive(mine.pid) && !alive(orphanIn.pid));
      assert(alive(foreign.pid) && alive(outside.pid) && alive(prefix.pid) && alive(reused.pid), '別サーバーの子・外の cwd・接頭辞だけの外・PID 再利用は止めない');
      assert(logs.length === 3, `ログ 3 行: ${logs.join(' | ')}`);

      const { db: db2, release: release2 } = openData(dataDir);
      try {
        const bySeq = Object.fromEntries(mcpProcessTable(db2).rows().map(r => [r.seq, r]));
        for (const seq of [seqMine, seqOrphan, seqGone]) assert(bySeq[seq].killedAt && bySeq[seq].reason === 'worktree', `seq ${seq} が worktree 理由で締まる`);
        for (const seq of [seqForeign, seqOutside, seqPrefix, seqReused]) assert(bySeq[seq].killedAt == null && bySeq[seq].closedAt == null, `seq ${seq} は残る`);
      } finally { release2(); }
      t.ok('消す場所の中を cwd に持つ分だけ止めて台帳に残す（自分の子と孤児）。別サーバーの子・外・PID 再利用は残す', true);
    }
  } finally {
    for (const c of children) { try { process.kill(process.platform === 'win32' ? c.pid : -c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch {} } }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
