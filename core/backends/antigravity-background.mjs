// agy の裏へ回ったコマンドを止める（docs/multi-backend.md §2.8「裏へ回ったコマンド」）。
//
// agy（1.3.4）の run_command は、WaitMsBeforeAsync（20 秒）を過ぎても終わらないコマンドを裏のタスクへ回し、AI は wait で待ち続ける。
// 待ちに上限は無く、Pleiad のエージェントには command_status / send_command_input を名指す口も無い。stream には ACTIVE が出たまま、
// コマンドが本当に終わるまで DONE が来ない。止めるには、そのコマンドを走らせているプロセスを落とすしかない。
//
// **落としてよいのは、その会話の agy の直下の子で、コマンドを走らせているシェル（とその子孫）だけ。**
// agy 自身・中継（agy-context-relay）・会話の外のプロセスは落とさない。見つからない・あいまいなときは何も落とさない。
// 実機（Windows）の木: agy.exe → powershell -Command "<コマンド>" → node.exe・chrome.exe …
import { run as runProcess } from "../process.mjs";

/** 一覧の札に出すコマンドの長さ */
const LABEL_MAX = 80;

/** 一覧の札に出すコマンド（空白を詰めて短くする） */
export function commandLabel(command) {
  const text = String(command ?? "").replace(/\s+/g, " ").trim();
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

/**
 * 比べるための形。シェルはコマンドを引用符で包み、中の引用符をエスケープする（powershell -Command "node -e \"…\""）ので、
 * 引用符・エスケープの文字を除き、空白を詰め、大小をそろえて比べる
 */
export function commandKey(command) {
  return String(command ?? "").replace(/["'`\\^]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 中継（Pleiad が agy に渡す MCP の口）。agy の直下の子だが、コマンドではない */
const RELAY_RE = /agy-context-relay/i;

/**
 * 止めるプロセスを選ぶ。list は [{ pid, ppid, command }]（command はそのプロセスのコマンドライン）。
 * agy の直下の子のうち、コマンドラインに command を含むもの。agy 自身と中継は選ばない。
 * @returns {{ pid: number } | { error: "notFound" | "ambiguous", count?: number }}
 */
export function pickCommandProcess(list, { agyPid, command }) {
  const key = commandKey(command);
  if (!Number.isInteger(agyPid) || agyPid <= 0 || !key) return { error: "notFound" };
  const hits = (Array.isArray(list) ? list : []).filter((p) => Number.isInteger(p?.pid) && p.pid !== agyPid && p.ppid === agyPid
    && !RELAY_RE.test(String(p.command ?? "")) && commandKey(p.command).includes(key));
  if (!hits.length) return { error: "notFound" };
  if (hits.length > 1) return { error: "ambiguous", count: hits.length };
  return { pid: hits[0].pid };
}

/** pid の子孫（自分は含まない）。親より先に子を並べない（幅優先） */
export function descendantsOf(list, pid) {
  const out = [];
  const seen = new Set([pid]);
  for (let i = -1; i < out.length; i++) {
    const parent = i < 0 ? pid : out[i];
    for (const p of list) if (p.ppid === parent && !seen.has(p.pid)) { seen.add(p.pid); out.push(p.pid); }
  }
  return out;
}

/**
 * 保持役が持つ agy の pid を、保持役の直下の子から引く（保持役は agy を shell 無しで起こすので、agy の親は保持役）。
 * markers（agent の置き場・`--conversation <id>`）のどれかをコマンドラインに含む子が 1 つだけなら、その pid。決められなければ null
 */
export function pickHeldAgy(list, { holderPid, markers }) {
  const keys = (markers ?? []).map(commandKey).filter(Boolean);
  if (!Number.isInteger(holderPid) || !keys.length) return null;
  const hits = (Array.isArray(list) ? list : []).filter((p) => p.ppid === holderPid && p.pid !== holderPid
    && keys.some((k) => commandKey(p.command).includes(k)));
  return hits.length === 1 ? hits[0].pid : null;
}

const run = async (file, args) => {
  const result = await runProcess(file, args, { windowsHide: true, maxOutputChars: 16 * 1024 * 1024, timeoutMs: 30_000 });
  if (result.startError) throw Object.assign(new Error(result.startError), { code: result.startCode ?? "SPAWN" });
  if (result.exitCode !== 0) throw Object.assign(new Error(`${file} exited ${result.exitCode}`), { code: result.exitCode ?? "EXIT", stderr: result.stderr });
  return result.stdout;
};

/**
 * プロセスの一覧 [{ pid, ppid, command }]。**parent（整数）を渡すと、どの OS でも parent の直下の子だけ**。省くと全部。
 * Windows は Win32_Process を parent で絞り、ほかは ps -A の全部から ppid で絞る。
 * 全部の一覧は、POSIX で子孫を辿って落とす killTree が自分で取る（呼び出し側は parent で絞った一覧を渡して、全部を落とす先に使わない）
 */
export async function listProcesses({ parent, platform = process.platform, exec = run } = {}) {
  if (platform === "win32") {
    const filter = Number.isInteger(parent) ? ` -Filter 'ParentProcessId=${parent}'` : "";
    const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
      + `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,CommandLine)`;
    const raw = JSON.parse(String(await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])).trim() || "[]");
    return (Array.isArray(raw) ? raw : [raw]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, command: p.CommandLine ?? "" }));
  }
  const out = String(await exec("ps", ["-A", "-o", "pid=,ppid=,args="]));
  const all = out.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  return Number.isInteger(parent) ? all.filter((p) => p.ppid === parent) : all;
}

/** pid のプロセスがまだあるか（権限が無くて触れないものも、あるとみなす） */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; } };

/** from の祖先（自分は含まない）。親が一覧に無いところで止まる */
export function ancestorsOf(list, from) {
  const parentOf = new Map(list.map((p) => [p.pid, p.ppid]));
  const out = [];
  for (let pid = parentOf.get(from); Number.isInteger(pid) && pid > 0 && !out.includes(pid) && out.length < 1024; pid = parentOf.get(pid)) out.push(pid);
  return out;
}

/**
 * pid のプロセスを木ごと落とす。Windows は taskkill /T /F、ほかは子孫を辿って SIGKILL。
 * **落とさないもの**: pid が 1 以下（init・システム）・この process（self.pid）・その親（self.ppid）は、落とさずに例外にする。
 * POSIX は全部の一覧（list を省くと取り直す。parent で絞った一覧では子孫が足りない）から、この process の祖先も例外にする
 * （試験が「シェルの子」とみなした一覧で、init・runner・CI のエージェントまで SIGKILL した。2026-10-14）。
 * taskkill /T は子を落とした後で根を落とす。子が終わると自分も終わるシェル（cmd /c・powershell -Command）は、taskkill が根に届く前に
 * 終わりかけて、「実行中のタスクのインスタンスがありません」「実行しようとした操作はサポートされていません」で失敗が返る。
 * 根が（少し待って）消えれば落ちているので、失敗にしない
 */
export async function killTree(pid, list, { platform = process.platform, exec = run, isAlive = alive, graceMs = 2000, self = { pid: process.pid, ppid: process.ppid } } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === self.pid || pid === self.ppid) throw new Error(`refusing to kill pid ${pid}`);
  if (platform === "win32") {
    try {
      await exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch (err) {
      for (const end = Date.now() + graceMs; isAlive(pid);) {
        if (Date.now() >= end) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return;
  }
  const all = list ?? await listProcesses({ platform, exec });
  const spared = new Set([self.pid, self.ppid, ...ancestorsOf(all, self.pid)]);
  if (spared.has(pid)) throw new Error(`refusing to kill pid ${pid}`);
  const victims = [pid, ...descendantsOf(all, pid)].filter((target) => target > 1 && !spared.has(target));
  let killed = 0;
  for (const target of victims) { try { process.kill(target, "SIGKILL"); killed++; } catch {} }
  if (!killed) throw new Error(`no process to kill (${pid})`);
}
