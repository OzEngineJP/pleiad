// プロセスの木の中立の部品（core/process-tree.mjs）。どのバックエンドにも属さず、ACP の CLI・OpenCode のサーバー・agy の裏のコマンドが使う。
//
// 前半は一覧（{ pid, ppid, command }）と差し替えた exec だけで測る純粋な部品（プロセスを起こさない）。
// 後半は本物の孫つきの子を起こして、一覧に孫が見え、killTree が木ごと落とすことを確かめる。
// 移行の間は core/backends/antigravity-background.mjs からも同じ関数を出す（既存の参照を壊さない）ので、同一の関数であることも見る。
import { spawn } from "node:child_process";
import * as tree from "../../core/process-tree.mjs";
import * as background from "../../core/backends/antigravity-background.mjs";
import { systemTool } from "../../core/win-system.mjs";

export const name = "process-tree";
export const title = "プロセスの木（一覧・子孫・祖先・木ごと落とす）の中立の部品と、antigravity-background からの再 export";

const { ancestorsOf, descendantsOf, killTree, listProcesses } = tree;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; } };
const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

export default async function (t) {
  // ---- 再 export（C5 まで、antigravity-background の既存の参照を壊さない）
  t.ok("antigravity-background は同じ関数を再 export する（別の実装を持たない）",
    ["ancestorsOf", "descendantsOf", "killTree", "listProcesses"].every((key) => typeof tree[key] === "function" && background[key] === tree[key]),
    JSON.stringify(["ancestorsOf", "descendantsOf", "killTree", "listProcesses"].map((key) => background[key] === tree[key])));
  t.ok("pick・札・比べる形は antigravity-background に残る（木の部品に混ぜない）",
    ["pickCommandProcess", "pickHeldAgy", "commandLabel", "commandKey"].every((key) => typeof background[key] === "function" && !(key in tree)));

  // ---- 子孫
  const list = [
    { pid: 100, ppid: 1, command: "agy" },
    { pid: 200, ppid: 100, command: "sh" },
    { pid: 201, ppid: 100, command: "relay" },
    { pid: 300, ppid: 200, command: "node" },
    { pid: 301, ppid: 300, command: "chrome" },
    { pid: 400, ppid: 999, command: "other" },
  ];
  t.ok("子孫は幅優先で、自分を含めない", JSON.stringify(descendantsOf(list, 100)) === "[200,201,300,301]", JSON.stringify(descendantsOf(list, 100)));
  t.ok("子の無い pid・一覧に無い pid の子孫は空", descendantsOf(list, 301).length === 0 && descendantsOf(list, 12345).length === 0);
  const loop = [{ pid: 1, ppid: 2, command: "" }, { pid: 2, ppid: 1, command: "" }];
  t.ok("親子が輪になっていても止まる", JSON.stringify(descendantsOf(loop, 1)) === "[2]", JSON.stringify(descendantsOf(loop, 1)));

  // ---- 祖先
  const chain = [
    { pid: 1, ppid: 0, command: "init" }, { pid: 10, ppid: 1, command: "runner" }, { pid: 20, ppid: 10, command: "node tests" },
    { pid: 30, ppid: 20, command: "node suite" },
  ];
  t.ok("祖先は親から順に、自分を含めない", JSON.stringify(ancestorsOf(chain, 30)) === "[20,10,1]", JSON.stringify(ancestorsOf(chain, 30)));
  t.ok("一覧に無い pid の祖先は空・輪でも止まる", ancestorsOf(chain, 999).length === 0 && ancestorsOf(loop, 1).length === 2);

  // ---- 一覧（ps と Win32_Process の出力は差し替える）
  const PS = [
    "    1     0 /sbin/init",
    "   50     1 node holder.mjs",
    "  100    50 devin acp",
    "  200   100 /bin/sh -c node -e \"setInterval(()=>{},1000)\"",
    "garbage line",
  ].join("\n");
  const psCalls = [];
  const fakePs = async (file, args) => { psCalls.push([file, ...args].join(" ")); return PS; };
  const pidsOf = (rows) => rows.map((p) => p.pid).join(",");
  t.ok("POSIX: parent を渡すと直下の子だけ・壊れた行は除く", pidsOf(await listProcesses({ parent: 50, platform: "linux", exec: fakePs })) === "100"
    && pidsOf(await listProcesses({ platform: "linux", exec: fakePs })) === "1,50,100,200");
  t.ok("POSIX: ps -A で全部を引く", psCalls[0] === "ps -A -o pid=,ppid=,args=", psCalls[0]);
  const psWin = [], psFiles = [];
  const fakePowershell = async (file, args) => { psFiles.push(file); psWin.push(args.at(-1)); return '[{"ProcessId":5,"ParentProcessId":4,"CommandLine":"x"}]'; };
  const win = await listProcesses({ parent: 4, platform: "win32", exec: fakePowershell });
  t.ok("Windows: Win32_Process を parent で絞り、System32 の powershell.exe を絶対パスで呼ぶ",
    pidsOf(win) === "5" && psWin[0].includes("-Filter 'ParentProcessId=4'") && psFiles[0] === systemTool("powershell"), psWin[0]);

  // ---- 落とす先の守り（process.kill は呼ばせない。守りで例外になる pid だけを渡す）
  const self = { pid: 30, ppid: 20 };
  const refuse = async (pid, rows, options) => killTree(pid, rows, { self, ...options }).then(() => "killed", (e) => e.message);
  const noExec = async () => { throw new Error("exec must not run"); };
  for (const platform of ["win32", "linux"]) {
    const o = { platform, exec: noExec };
    t.ok(`${platform}: pid が 1 以下・整数でないもの・この process・その親は落とさない`,
      (await Promise.all([1, 0, -5, 1.5, null, undefined, "200", 30, 20].map((pid) => refuse(pid, chain, o)))).every((r) => r.startsWith("refusing")));
  }
  t.ok("POSIX: この process の祖先も落とさない", (await refuse(10, chain, { platform: "linux", exec: noExec })).startsWith("refusing"));
  const calls = [];
  const noInstance = async (file, args) => { calls.push([file, ...args].join(" ")); throw new Error("taskkill: no running instance"); };
  const raced = await killTree(200, null, { platform: "win32", exec: noInstance, isAlive: () => false }).then(() => "ok", (e) => e.message);
  t.ok("Windows: taskkill /T /F を System32 の絶対パスで呼び、失敗しても根が消えていれば落とせたとみなす",
    raced === "ok" && calls[0] === `${systemTool("taskkill")} /PID 200 /T /F`, JSON.stringify({ raced, calls }));
  const stuck = await killTree(200, null, { platform: "win32", exec: noInstance, isAlive: () => true, graceMs: 100 }).then(() => "ok", (e) => e.message);
  t.ok("Windows: 根が残っていれば失敗を返す", stuck === "taskkill: no running instance", stuck);

  // ---- 本物の木（子が孫を起こす）。一覧に孫が見え、killTree が子と孫を落とす
  const grandchild = "setInterval(()=>{},1000)";
  const parentScript = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', windowsHide: true }); process.stdout.write('GRANDCHILD ' + g.pid + '\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", parentScript], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let grandPid = null;
  try {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    t.ok("本物の木: 子が孫を起こす", await until(() => (grandPid = Number(/GRANDCHILD (\d+)/.exec(out)?.[1]) || null), 10_000) && alive(child.pid) && alive(grandPid), out);
    const direct = await listProcesses({ parent: child.pid });
    t.ok("本物の木: parent を渡した一覧に孫が見える", direct.some((p) => p.pid === grandPid && p.ppid === child.pid), JSON.stringify(direct.map((p) => p.pid)));
    const all = await listProcesses();
    // Windows は子の下に conhost.exe が付くことがあるので、孫が入っていて自分が入っていないことだけを見る
    const below = descendantsOf(all, child.pid);
    t.ok("本物の木: 全部の一覧から子孫を辿ると孫が出る（自分は含めない）", below.includes(grandPid) && !below.includes(child.pid), JSON.stringify(below));
    await killTree(child.pid);
    const gone = await until(() => !alive(child.pid) && !alive(grandPid), 10_000);
    t.ok("本物の木: killTree は子と孫を木ごと落とす", gone, JSON.stringify({ child: alive(child.pid), grandchild: alive(grandPid) }));
  } finally {
    for (const pid of [child.pid, grandPid]) if (Number.isInteger(pid) && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}
