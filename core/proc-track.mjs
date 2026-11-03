// Pleiad が起こした子（core/process.mjs の run・spawnChild・detach）の pid と cwd を覚え、
// cwd がフォルダーの中にあるものを、その子孫と一緒に止める。worktree を消す前に呼ぶ（Windows は cwd が掴まれた場所を消せない）。
//
//   - 生きている追跡中の子は木ごと止める（Windows は taskkill /T、ほかはプロセスグループ）
//   - detached・Start-Process で木から外れた子孫は、プロセス表を読んで ppid の鎖が追跡中の pid に届くものを拾う。
//     pid の使い回しで別物を止めないよう、子は親（根）が生まれた後・死ぬ前に生まれたものだけに絞る（CreationDate）
//   - 保持役（core/holder/）の子は含めない（保持役が起こした子なので、追跡にもプロセス表の鎖にも現れない。
//     cwd で止めるのは HolderClient.killUnder と server.mjs の unhold）
//   - 自分・自分の祖先は絶対に止めない
//
// 追跡はメモリの中だけ（このプロセスが起こした子しか分からない。前の世代の子は保持役の側で拾う）
import { bootEnv } from './boot-env.mjs';

/** 終わった子の記録を、子孫を拾うために残す時間 */
const ENDED_KEEP_MS = 10 * 60_000;
/** 追跡の上限（git など短命の子は大量にある。古い順に捨てる） */
const TRACK_MAX = 4096;
/** 時刻の比較の許容（プロセスの作成時刻と Node が知る時刻のずれ・pid の使い回しの窓） */
const SLACK_MS = 2000;
/** プロセス表を読む上限 */
const TABLE_TIMEOUT_MS = 30_000;

const tracked = new Map();   // pid -> { pid, cwd, spawnedAt, endedAt }

const fold = (p) => String(p ?? '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
/** dir が parent の中（同じ場所を含む）か（worktrees.mjs の insideDir と同じ。依存を入れないため写す） */
export const insidePath = (dir, parent) => {
  const d = fold(dir), p = fold(parent);
  return Boolean(d) && Boolean(p) && (d === p || d.startsWith(`${p}/`));
};

/** spawn した子を追跡する（process.mjs が呼ぶ）。cwd が無い子は cwd で選べないので覚えない */
export function trackChild(child, cwd) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 1 || typeof cwd !== 'string' || !cwd) return;
  if (tracked.size >= TRACK_MAX) tracked.delete(tracked.keys().next().value);
  tracked.set(pid, { pid, cwd, spawnedAt: Date.now(), endedAt: null });
  child.once?.('exit', () => { const t = tracked.get(pid); if (t && t.endedAt == null) t.endedAt = Date.now(); });
  child.once?.('close', () => setTimeout(() => { if (tracked.get(pid)?.endedAt != null) tracked.delete(pid); }, ENDED_KEEP_MS).unref?.());
}

/** 追跡中の子（試験が見る） */
export const trackedChildren = () => [...tracked.values()];

/** cwd が dir の中（同じ場所を含む）にある追跡中の子 */
export function rootsUnder(dir, { inside = insidePath } = {}) {
  return [...tracked.values()].filter(t => inside(t.cwd, dir));
}

let runCache = null;
const defaultExec = async (file, args) => {
  runCache ??= (await import('./process.mjs')).run;
  return runCache(file, args, { windowsHide: true, timeoutMs: TABLE_TIMEOUT_MS, maxOutputChars: 64 * 1024 * 1024 });
};
const defaultKill = (pid, signal = 'SIGKILL') => process.kill(pid, signal);

/**
 * 今動いているプロセスの一覧 { pid, ppid, created(ms|null) }。
 * Windows は Get-CimInstance（作成時刻つき。pid の使い回しを時刻で除く）、ほかは ps（作成時刻は取らない）
 */
export async function listProcesses({ platform = process.platform, exec = defaultExec } = {}) {
  if (platform === 'win32') {
    const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress"]);
    if (r.exitCode !== 0 || !r.stdout?.trim()) return [];
    const rows = JSON.parse(r.stdout);
    const list = Array.isArray(rows) ? rows : [rows];
    // CIM の CreationDate は "/Date(<ms>)/"（PS5.1）か ISO 8601（PS7）
    const created = (v) => {
      const m = typeof v === 'string' && v.match(/^\/Date\((\d+)/);
      if (m) return Number(m[1]);
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : null;
    };
    return list.map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId ?? 0, created: created(p.CreationDate) })).filter(p => Number.isInteger(p.pid));
  }
  const r = await exec('ps', ['-A', '-o', 'pid=,ppid=']);
  if (r.exitCode !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map(line => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return Number.isInteger(pid) ? { pid, ppid: ppid ?? 0, created: null } : null;
  }).filter(Boolean);
}

/** table の中で pid の祖先（自分は含めない） */
function ancestorsOf(table, pid) {
  const byId = new Map(table.map(p => [p.pid, p]));
  const out = [];
  let cur = byId.get(pid);
  let depth = 0;
  while (cur && depth++ < 64) {
    const parent = byId.get(cur.ppid);
    if (!parent) break;
    out.push(parent.pid);
    cur = parent;
  }
  return out;
}

/** p が追跡中のどれかの子孫か。pid の使い回しを、生まれた順（子は親より後）と根の生死の時刻で除く */
function descendantOfRoots(table, proc, roots) {
  const byId = new Map(table.map(p => [p.pid, p]));
  for (const root of roots) {
    if (proc.created != null && proc.created < root.spawnedAt - SLACK_MS) continue;
    if (root.endedAt != null && proc.created != null && proc.created > root.endedAt + SLACK_MS) continue;
    let cur = proc, depth = 0;
    while (cur && depth++ < 64) {
      if (cur.ppid === root.pid) return root;
      const parent = byId.get(cur.ppid);
      if (!parent) break;
      if (parent.created != null && cur.created != null && cur.created < parent.created - SLACK_MS) break;
      cur = parent;
    }
  }
  return null;
}

/**
 * cwd が dir の中（同じ場所を含む）にある追跡中の子と、その子孫を止める。
 * exec・kill・list・inside は試験が差し込む口。戻りは { roots, killed }（止めた pid の数）
 */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

export async function killUnder(dir, { platform = process.platform, exec = null, kill = null, list = null, inside = insidePath, waitMs = 3000 } = {}) {
  const roots = rootsUnder(dir, { inside });
  if (!roots.length) return { roots: 0, killed: 0 };
  exec ??= defaultExec;
  kill ??= defaultKill;
  const killed = new Set();
  // 生きている追跡中の子は木ごと（Windows は taskkill /T、ほかは detached で作ったプロセスグループ）
  for (const root of roots) {
    if (root.endedAt != null) continue;
    try {
      if (platform === 'win32') await exec('taskkill', ['/PID', String(root.pid), '/T', '/F']);
      else kill(-root.pid, 'SIGKILL');
      killed.add(root.pid);
    } catch { /* もう居ない */ }
  }
  // detached・Start-Process で木から外れた子孫を、プロセス表から拾って 1 本ずつ止める
  const table = list ?? await listProcesses({ platform, exec }).catch(() => null);
  if (Array.isArray(table) && table.length) {
    const spared = new Set([process.pid, process.ppid, ...ancestorsOf(table, process.pid)]);
    for (const p of table) {
      if (killed.has(p.pid) || spared.has(p.pid) || p.pid <= 1) continue;
      if (!descendantOfRoots(table, p, roots)) continue;
      try { kill(p.pid, 'SIGKILL'); killed.add(p.pid); } catch { /* もう居ない */ }
    }
  }
  // 止めたものが終わるまで待つ（cwd の掴みが外れてから片付けを続ける。プロセス表に残るゾンビは待たない）
  const deadline = Date.now() + waitMs;
  while ([...killed].some(alive) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  return { roots: roots.length, killed: killed.size };
}

/**
 * 保持役（core/holder/）の子のうち、cwd が dir の中（同じ場所を含む）にあるものを木ごと止める。
 * 生きている保持役が無ければ何もしない（起こしにいかない）。戻りは止めた子の id の一覧
 */
export async function killHeldUnder(dir, { dataDir, inside = insidePath, waitMs = 3000 } = {}) {
  if (!dataDir) return [];
  try {
    const [{ holderLink }, { holderRootFor }] = await Promise.all([import('./holder/link.mjs'), import('./process.mjs')]);
    const root = holderRootFor({ dataDir, root: bootEnv('AGENT_HOST_RUNTIME_ROOT') });
    const client = await holderLink({ dataDir, root, launch: false });
    return await client.killUnder(dir, { inside, waitMs });
  } catch { return []; }
}
