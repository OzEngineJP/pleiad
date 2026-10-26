// 外部 MCP のツール一覧の写し（遅延起動）と、起こしたプロセスの台帳（孤児の掃除）。pleiad.db の行（core/db.mjs、ADR は docs/adr/）。
//
// 写し（mcp_tool_cache）: 起きていない MCP のツール一覧。最初の呼び出しまでプロセスを起こさない
// 遅延起動（core/context-connections.mjs）が、起きたときに覚えた一覧を次の起動でも広告するために使う。
// 台帳（mcp_processes）: stdio で起こした根の PID と、当時のサーバー（親）の PID・起動時刻を記録する。
// 起動時の掃除（sweep）で、記録の親が死んでいる分を木ごと止める。画面には出さず、サーバーのログと台帳に残す（承認済みの形）。
import { run } from './process.mjs';
import { openData } from './data-schema.mjs';
import { mcpToolCacheTable, mcpProcessTable } from './db.mjs';
import { t } from './i18n.mjs';
import { insideDir } from './worktrees.mjs';

export const MCP_CACHE_LIMIT = 128;
export const MCP_PROCESS_LIMIT = 256;
// 記録の親の起動時刻と、今その PID を持つプロセスの起動時刻に許す差（PID 再利用の見分け。起動時刻の読み方の誤差を吸う）
const START_TOLERANCE_MS = 15_000;
const FILETIME_EPOCH_DIFF = 116444736000000000n; // FILETIME（1601 起点の 100ns）→ epoch ms の差

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** pids のプロセスの起動時刻（epoch ms）の一覧。居ない pid は載らない。一覧そのものが取れなければ投げる（取れなければ止めない、誤爆を防ぐ側） */
async function startTimesOf(pids, { now = Date.now } = {}) {
  const out = new Map();
  if (!pids.length) return out;
  if (process.platform === 'win32') {
    const res = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id):$($_.StartTime.ToFileTimeUtc())" }`],
      { timeoutMs: 15_000, windowsHide: true, maxOutputChars: 4 * 1024 * 1024 });
    // 死んでいる pid が混ざると Get-Process は出力しつつ status 1 で返る。起動自体が失敗したときだけ取れないとみなす
    if (res.startError) throw new Error(res.startError);
    for (const line of String(res.stdout ?? '').split(/\r?\n/)) {
      const m = /^(\d+):(\d+)\s*$/.exec(line.trim());
      if (m) out.set(Number(m[1]), Number((BigInt(m[2]) - FILETIME_EPOCH_DIFF) / 10000n));
    }
    return out;
  }
  // etimes（秒）は macOS の ps に無いので、Linux と macOS の両方にある etime（[[dd-]hh:]mm:ss）を読む
  const res = await run('ps', ['-o', 'pid=,etime=', '-p', pids.join(',')], { timeoutMs: 15_000 });
  // 死んでいる pid が混ざると ps も非 0 で返る（残りの pid は出力される）
  if (res.startError) throw new Error(res.startError);
  const at = now();
  for (const line of String(res.stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    const secs = m ? elapsedSeconds(m[2]) : null;
    if (secs != null) out.set(Number(m[1]), at - secs * 1000);
  }
  return out;
}

/** ps の etime（[[dd-]hh:]mm:ss）を秒にする。読めなければ null */
export function elapsedSeconds(text) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

/** 木ごと止める。Windows は taskkill /T、POSIX は detached で分けたプロセスグループごと（core/context-bridge.mjs） */
async function killTree(pid) {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeoutMs: 5000 });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); return; } catch { /* グループで無ければ根だけ */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* もう居ない */ }
}

export function createMcpLedger({ dataDir, log = () => {}, now = Date.now, selfPid = process.pid, alive: aliveFn, killTree: killTreeFn, startTimes: startTimesFn, selfStartedAt } = {}) {
  let handle = null, cache = null, procs = null;
  const tables = () => {
    if (!cache) { handle = openData(dataDir); cache = mcpToolCacheTable(handle.db, { limit: MCP_CACHE_LIMIT }); procs = mcpProcessTable(handle.db, { limit: MCP_PROCESS_LIMIT }); }
    return { cache, procs };
  };
  const aliveP = aliveFn ?? alive;
  const kill = killTreeFn ?? killTree;
  const startTimes = startTimesFn ?? startTimesOf;
  const selfStarted = selfStartedAt ?? (() => now() - process.uptime() * 1000);
  const unclosed = () => { try { return tables().procs.unclosed(); } catch { return []; } };

  const snapshots = {
    get(key) { try { return tables().cache.get(key); } catch { return undefined; } },
    put(key, serverId, snapshot) { try { tables().cache.put(key, serverId, snapshot, now()); } catch { /* 台帳が書けなくても起動は止めない */ } },
    delete(key) { try { tables().cache.delete(key); } catch { /* 同上 */ } },
    /** keys に載るサーバー id のうち、keys に無い key の行を消す（定義の変更で別キーになった分） */
    prune(serverIds, keys) { try { return tables().cache.prune(serverIds, keys); } catch { return 0; } },
  };

  const processes = {
    /** 起動した根の PID を記録する。seq（close に渡す）を返す。台帳が書けなくても起動は止めない */
    record({ pid, command = null, cwd = null, key = null }) {
      try { return tables().procs.add({ pid, parentPid: selfPid, parentStarted: selfStarted(), command, cwd, key, at: now() }); } catch { return null; }
    },
    /** 正常に閉じたこと（孤児の掃除から外れる）を記録する */
    close(seq) { if (seq != null) try { tables().procs.close(seq, now()); } catch { /* 台帳の失敗で終了は止めない */ } },
  };

  /**
   * 台帳に残っている起動のうち、記録の親（当時のサーバー）が死んでいるものを木ごと止める。
   * PID を別のプロセスが使い回しているだけかもしれないので、親の起動時刻を台帳と突き合わせる。
   * 起動時刻が取れなければ止めない（誤爆を防ぐ側）。止めた行を返す。
   */
  function sweep() {
    return sweepRows(async () => unclosed().filter(r => r.parentPid !== selfPid && r.pid !== selfPid), 'orphaned');
  }

  /**
   * 記録に残る起動のうち、cwd が dir の中（同じ場所を含む）のものを木ごと止める（worktree を消す前）。
   * 対象はこのサーバーが起こした分と、記録の親が死んでいる孤児（別の生きたサーバーのものは触らない）。
   * PID を別のプロセスが使い回しているだけかもしれないので、起動時刻を記録（started_at）と突き合わせる。止めた行を返す。
   */
  function sweepCwd(dir) {
    return sweepRows(async () => unclosed().filter(r => r.cwd && r.pid !== selfPid && insideDir(r.cwd, dir) && (r.parentPid === selfPid || !aliveP(r.parentPid))), 'worktree', dir);
  }

  /**
   * 掃除の本体（sweep・sweepCwd）。rows() が対象の行、reason は台帳に残す理由。
   * 親の死は、親の PID の起動時刻を台帳と突き合わせて見分ける（PID の使い回しで誤爆しない）。取れなければ止めない
   */
  async function sweepRows(rows, reason) {
    const targets = await rows();
    if (!targets.length) return [];
    const pidOf = reason === 'worktree' ? row => row.pid : row => row.parentPid;
    let starts;
    try { starts = await startTimes([...new Set(targets.map(pidOf))], { now }); }
    catch { return []; }
    const killed = [];
    for (const row of targets) {
      if (reason === 'worktree') {
        const at = starts.get(row.pid);
        // 起動時刻が記録と違う = PID 再利用（止めない）。取れなければもう居ないので記録だけ締める
        if (at !== undefined && Math.abs(at - row.startedAt) > START_TOLERANCE_MS) continue;
        if (at !== undefined) await kill(row.pid);
      } else {
        const parentAt = starts.get(row.parentPid);
        const parentGone = parentAt === undefined && !aliveP(row.parentPid);
        const reused = parentAt !== undefined && (row.parentStarted == null || Math.abs(parentAt - row.parentStarted) > START_TOLERANCE_MS);
        if (!parentGone && !reused) continue;
        await kill(row.pid);
      }
      try { tables().procs.killed(row.seq, reason, now()); } catch { /* 記録の失敗で掃除は止めない */ }
      killed.push(row);
      const name = row.command ?? row.key ?? String(row.pid);
      log(reason === 'worktree' ? t('context.bridge.mcpFolded', { name, pid: row.pid }) : t('context.bridge.mcpReaped', { name, pid: row.pid }));
    }
    return killed;
  }

  /** DB を閉じる（試験。サーバーはプロセスの寿命まで持つ） */
  function release() { try { handle?.release(); } catch { /* 閉じるだけ */ } }

  return { snapshots, processes, sweep, sweepCwd, release };
}
