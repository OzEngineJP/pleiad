// agy の裏へ回ったコマンドを止める（docs/multi-backend.md §2.8「裏へ回ったコマンド」）。
//
// agy（1.3.4）の run_command は、WaitMsBeforeAsync（20 秒）を過ぎても終わらないコマンドを裏のタスクへ回し、AI は wait で待ち続ける。
// 待ちに上限は無く、Pleiad のエージェントには command_status / send_command_input を名指す口も無い。stream には ACTIVE が出たまま、
// コマンドが本当に終わるまで DONE が来ない。止めるには、そのコマンドを走らせているプロセスを落とすしかない。
//
// **落としてよいのは、その会話の agy の直下の子で、コマンドを走らせているシェル（とその子孫）だけ。**
// agy 自身・中継（agy-context-relay）・会話の外のプロセスは落とさない。見つからない・あいまいなときは何も落とさない。
// 実機（Windows）の木: agy.exe → powershell -Command "<コマンド>" → node.exe・chrome.exe …
import { execFile } from "node:child_process";

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

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/**
 * プロセスの一覧 [{ pid, ppid, command }]。Windows は parent の直下の子だけ（Win32_Process。止めるのは taskkill /T が木ごとに落とす）、
 * ほかは全部（ps。子孫を辿って落とすため）
 */
export async function listProcesses({ parent } = {}) {
  if (process.platform === "win32") {
    const filter = Number.isInteger(parent) ? ` -Filter 'ParentProcessId=${parent}'` : "";
    const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
      + `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,CommandLine)`;
    const raw = JSON.parse(String(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])).trim() || "[]");
    return (Array.isArray(raw) ? raw : [raw]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, command: p.CommandLine ?? "" }));
  }
  const out = String(await run("ps", ["-A", "-o", "pid=,ppid=,args="]));
  return out.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
}

/** pid のプロセスを木ごと落とす。Windows は taskkill /T /F、ほかは子孫を辿って SIGKILL */
export async function killTree(pid, list) {
  if (process.platform === "win32") {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  const all = list ?? await listProcesses();
  const victims = [pid, ...descendantsOf(all, pid)];
  let killed = 0;
  for (const target of victims) { try { process.kill(target, "SIGKILL"); killed++; } catch {} }
  if (!killed) throw new Error(`no process to kill (${pid})`);
}
