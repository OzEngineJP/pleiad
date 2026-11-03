// Pleiad が起こした子の追跡（core/proc-track.mjs）。worktree を消す前に、cwd がその中の子を子孫ごと止める:
//   - 追跡は cwd で選ぶ（フォルダーの外は止めない）
//   - detached・Start-Process で木から外れた子孫はプロセス表で拾う（ppid の鎖が追跡中の pid に届く）
//   - pid の使い回しで別物を止めない（子は親が生まれた後・死ぬ前に生まれたものだけ。自分・祖先は外す）
//   - 保持役の子は HolderClient.killUnder が cwd で止める
import { spawn } from 'node:child_process';
import os from 'node:os';
import { trackChild, rootsUnder, killUnder, insidePath } from '../../core/proc-track.mjs';
import { run } from '../../core/process.mjs';
import { insideDir } from '../../core/worktrees.mjs';
import { startHolder, fakeChild, waitFor, sleep, isAlive, tempDir, removeDir } from '../lib/holder-harness.mjs';

export const name = 'proc-track';
export const title = '起こした子の追跡: cwd が中のものを子孫ごと止める・使い回しの pid は外す・保持役の子は cwd で止める';

const fakeHandle = (pid, exitNow = false) => ({ pid, once: (ev, fn) => { if (exitNow && ev === 'exit') fn(); } });

export default async function (t) {
  const S = 1_000_000_000;   // 適当に古い時刻（子の作成時刻は根より後・自分より前に見える値にする）
  const now = Date.now();

  // ---- 追跡: cwd がフォルダーの中（同じ場所を含む）の子だけ選ぶ
  trackChild(fakeHandle(900001), 'D:/x/wt');
  trackChild(fakeHandle(900002), 'D:/x/else');
  t.ok('追跡: cwd が中の子だけを rootsUnder が返す（外・似た名前は外す）', rootsUnder('d:/X/WT').map(r => r.pid).join() === '900001' && rootsUnder('D:/x/wt2').length === 0 && insidePath('D:/x/wt/a', 'd:/x/wt') && !insidePath('D:/x/wt2', 'd:/x/wt'));

  // ---- killUnder: 注入したプロセス表で、木から外れた子孫を拾う
  {
    const killed = [];
    trackChild(fakeHandle(900010), 'D:/x/wt');
    const table = [
      { pid: 4, ppid: 0, created: 0 },
      { pid: 900010, ppid: 4, created: now - 1000 },          // 追跡中の根
      { pid: 900011, ppid: 900010, created: now - 900 },      // 根の直接の子（detached）
      { pid: 900012, ppid: 900011, created: now - 800 },      // 孫
      { pid: 900013, ppid: 4, created: now - 500 },           // 無関係
      { pid: process.pid, ppid: 4, created: now - 2000 },     // 自分
    ];
    const r = await killUnder('d:/x/wt', { platform: 'linux', list: table, exec: async () => ({}), kill: pid => { killed.push(pid); return true; } });
    t.ok('killUnder: 根を木ごと（POSIX はグループ -pid）＋表で拾った detached の子孫を止める（無関係・自分・祖先は外す）',
      killed.includes(-900010) && killed.includes(900011) && killed.includes(900012) && !killed.includes(900013) && !killed.includes(process.pid) && !killed.includes(4), JSON.stringify(killed));
  }

  // ---- pid の使い回し: 根が死んだ後に生まれたもの・根より前に生まれたものは止めない
  {
    const killed = [];
    trackChild(fakeHandle(900020, true), 'D:/x/wt');          // 終わった子（endedAt ≈ 今）
    const table = [
      { pid: 900020, ppid: 4, created: now - 1000 },          // 使い回された根の pid（表にはまだ居る扱い）
      { pid: 900021, ppid: 900020, created: now + 60_000 },   // 根が死んだ後に生まれたもの → 外す
      { pid: 900022, ppid: 900020, created: 0 },              // 根より前に生まれたもの → 外す
      { pid: 900023, ppid: 900020, created: now - 500 },      // 根が生きている間に生まれた子 → 止める
    ];
    await killUnder('d:/x/wt', { platform: 'win32', list: table, exec: async () => ({}), kill: pid => { killed.push(pid); return true; } });
    t.ok('pid の使い回し: 根が死んだ後・生まれる前のものは止めない（生きている間の子だけ）', killed.includes(900023) && !killed.includes(900021) && !killed.includes(900022) && !killed.includes(900020), JSON.stringify(killed));
  }

  // ---- Windows の実機: run() が追跡した子が Start-Process で残した detached の孫を拾う
  if (process.platform === 'win32') {
    const dir = tempDir();
    try {
      await run('powershell.exe', ['-NoProfile', '-Command', "Start-Process -WindowStyle Hidden ping -ArgumentList '-t','127.0.0.1'"], { cwd: dir });
      await sleep(700);
      const pings = () => run('powershell.exe', ['-NoProfile', '-Command', "(Get-Process ping -ErrorAction SilentlyContinue).Id -join ','"], { windowsHide: true });
      const before = (await pings()).stdout.trim();
      const r = await killUnder(dir);
      const after = (await pings()).stdout.trim();
      t.ok('実機: Start-Process で木から外れた子（ping）も、cwd が中の追跡の子の子孫として止める',
        before.length > 0 && r.killed >= 1 && after.length === 0, JSON.stringify({ before, after, ...r }));
    } finally { removeDir(dir); }
  }

  // ---- 保持役の子: cwd が中のものを木ごと止める
  {
    const h = await startHolder();
    const dir = tempDir();
    try {
      const a = await h.connect();
      a.client.spawn({ ...fakeChild('wu', 'echo'), cwd: dir });
      a.client.spawn({ ...fakeChild('wo', 'echo'), cwd: os.tmpdir() });
      await waitFor(() => a.events.lines('wu').some(l => l.ready) && a.events.lines('wo').some(l => l.ready), 8000, 'children ready');
      const pid = id => h.holder.snapshot().children.find(c => c.id === id)?.pid;
      const killed = await a.client.killUnder(dir, { inside: insideDir });
      await waitFor(() => !isAlive(pid('wu')), 8000, 'wu killed');
      t.ok('保持役の子: cwd が中のものだけを木ごと止める（外のものは生きている）', killed.join() === 'wu' && !isAlive(pid('wu')) && isAlive(pid('wo')), JSON.stringify(killed));
    } finally { await h.stop(); removeDir(dir); }
  }
}
