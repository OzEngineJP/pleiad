// agy の裏へ回ったコマンドを止めるときの、落とす先の選び方（core/backends/antigravity-background.mjs）。
//
// プロセスは起こさない。一覧（{ pid, ppid, command }）を渡して、純粋な部品として測る。
// 守ること: agy の直下の子でコマンドを走らせているものだけを選ぶ。agy 自身・中継・孫・会話の外は選ばない。
// 見つからない・あいまいなら選ばない。コマンドラインの形は実機（Windows の agy 1.3.4）の木に合わせた。
import { ancestorsOf, commandKey, commandLabel, descendantsOf, killTree, listProcesses, pickCommandProcess, pickHeldAgy } from "../../core/backends/antigravity-background.mjs";

export const name = "antigravity-background";
export const title = "agy の裏のコマンドを止めるとき、その会話の agy の直下の子だけを選ぶ";

const COMMAND = 'node -e "setInterval(()=>{},1000)"';
const AGY = 100;

// agy.exe → powershell -Command "<コマンド>" → node.exe（実機の形）。中継も agy の直下の子。
// agy 自身のコマンドライン（--print= の prompt）・中継・孫・会話の外にも、同じコマンドの文字が入っている
const tree = () => [
  { pid: AGY, ppid: 1, command: `agy.exe --print= ${COMMAND}` },
  { pid: 200, ppid: AGY, command: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command "node -e \\"setInterval(()=>{},1000)\\""' },
  { pid: 201, ppid: AGY, command: `node.exe D:\\pleiad\\agy-context-relay.mjs --note "${COMMAND}"` },
  { pid: 300, ppid: 200, command: COMMAND },
  { pid: 301, ppid: 300, command: "chrome.exe --headless" },
  { pid: 400, ppid: 999, command: `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "${COMMAND}"` },
];

export default async function (t) {
  // ---- 札
  t.ok("札は空白を詰める", commandLabel("npm  run\n  dev") === "npm run dev", commandLabel("npm  run\n  dev"));
  const long = commandLabel("x".repeat(200));
  t.ok("札は 80 文字に切って印を付ける", long.length === 80 && long.endsWith("…"), String(long.length));

  // ---- 比べる形。シェルが包んだ引用符・エスケープを越えて当たる
  const key = commandKey(COMMAND);
  t.ok("powershell が包んだ形にも当たる", commandKey(tree()[1].command).includes(key), commandKey(tree()[1].command));
  t.ok("cmd が包んだ形にも当たる", commandKey(`cmd.exe /d /s /c "${COMMAND}"`).includes(key));
  t.ok("sh が包んだ形にも当たる", commandKey(`/bin/sh -c '${COMMAND}'`).includes(key));
  t.ok("違うコマンドには当たらない", !commandKey('node -e "setInterval(()=>{},2000)"').includes(key));

  // ---- 選ぶ
  t.ok("agy の直下のシェルを選ぶ（agy 自身・中継・孫・外は選ばない）",
    JSON.stringify(pickCommandProcess(tree(), { agyPid: AGY, command: COMMAND })) === '{"pid":200}',
    JSON.stringify(pickCommandProcess(tree(), { agyPid: AGY, command: COMMAND })));
  const withoutShell = tree().filter((p) => p.pid !== 200);
  const none = pickCommandProcess(withoutShell, { agyPid: AGY, command: COMMAND });
  t.ok("直下に無ければ、孫・会話の外・中継・agy 自身に当たっても選ばない", none.error === "notFound" && !("pid" in none), JSON.stringify(none));
  const onlyOutside = tree().filter((p) => p.pid === 400);
  t.ok("会話の外だけに当たっても選ばない", pickCommandProcess(onlyOutside, { agyPid: AGY, command: COMMAND }).error === "notFound");
  const selfLoop = [{ pid: AGY, ppid: AGY, command: `agy.exe ${COMMAND}` }];
  t.ok("agy 自身は親が自分に見えても選ばない", pickCommandProcess(selfLoop, { agyPid: AGY, command: COMMAND }).error === "notFound");
  const twice = [...tree(), { pid: 202, ppid: AGY, command: `powershell.exe -Command "${COMMAND}"` }];
  const ambiguous = pickCommandProcess(twice, { agyPid: AGY, command: COMMAND });
  t.ok("直下に 2 つ当たれば、あいまいとして選ばない", ambiguous.error === "ambiguous" && ambiguous.count === 2 && !("pid" in ambiguous),
    JSON.stringify(ambiguous));
  t.ok("コマンドが空なら選ばない", pickCommandProcess(tree(), { agyPid: AGY, command: "  " }).error === "notFound");
  t.ok("agy の pid が分からなければ選ばない",
    [null, undefined, 0, -1, "100"].every((agyPid) => pickCommandProcess(tree(), { agyPid, command: COMMAND }).error === "notFound"));
  t.ok("一覧が壊れていても選ばない", pickCommandProcess(null, { agyPid: AGY, command: COMMAND }).error === "notFound");

  // ---- 子孫（Windows 以外で木ごと落とすとき）
  t.ok("子孫は親から順に、自分を含めずに並ぶ", JSON.stringify(descendantsOf(tree(), 200)) === "[300,301]", JSON.stringify(descendantsOf(tree(), 200)));
  const loop = [{ pid: 1, ppid: 2, command: "" }, { pid: 2, ppid: 1, command: "" }];
  t.ok("親子が輪になっていても止まる", JSON.stringify(descendantsOf(loop, 1)) === "[2]", JSON.stringify(descendantsOf(loop, 1)));

  // ---- 保持役が持つ agy（pid を持たない）を、保持役の直下の子から引く
  const HOLDER = 50;
  const held = [
    { pid: HOLDER, ppid: 1, command: "node holder.mjs" },
    { pid: 61, ppid: HOLDER, command: "agy.exe --print= --add-dir C:\\data\\agents\\a1 --conversation c-1" },
    { pid: 62, ppid: HOLDER, command: "agy.exe --print= --add-dir C:\\data\\agents\\b2 --conversation c-2" },
    { pid: 63, ppid: 7, command: "agy.exe --print= --add-dir C:\\data\\agents\\a1" },
  ];
  t.ok("agent の置き場で引ける（保持役の子だけを見る）", pickHeldAgy(held, { holderPid: HOLDER, markers: ["C:\\data\\agents\\a1"] }) === 61);
  t.ok("--conversation で引ける", pickHeldAgy(held, { holderPid: HOLDER, markers: [null, "--conversation c-2"] }) === 62);
  t.ok("2 つ当たれば決めない", pickHeldAgy(held, { holderPid: HOLDER, markers: ["--print="] }) === null);
  t.ok("目印が無ければ決めない", pickHeldAgy(held, { holderPid: HOLDER, markers: [] }) === null);
  t.ok("保持役の pid が分からなければ決めない", pickHeldAgy(held, { holderPid: null, markers: ["c-1"] }) === null);

  // ---- 落とす（Windows の taskkill は差し替えて、プロセスは起こさない）
  // シェルは子が落ちると自分で終わるので、taskkill /T が根に届く前に消えて「インスタンスがありません」の失敗が返ることがある
  const calls = [];
  const noInstance = async (file, args) => { calls.push([file, ...args].join(" ")); throw new Error("taskkill: no running instance"); };
  const raced = await killTree(200, null, { platform: "win32", exec: noInstance, isAlive: () => false }).then(() => "ok", (e) => e.message);
  t.ok("taskkill が失敗しても、根が消えていれば落とせたとみなす", raced === "ok" && calls[0] === "taskkill /PID 200 /T /F", JSON.stringify({ raced, calls }));
  let polls = 0;
  const exiting = await killTree(200, null, { platform: "win32", exec: noInstance, isAlive: () => ++polls < 3 }).then(() => "ok", (e) => e.message);
  t.ok("根が終わりかけなら、消えるのを待って落とせたとみなす", exiting === "ok" && polls === 3, JSON.stringify({ exiting, polls }));
  const stuck = await killTree(200, null, { platform: "win32", exec: noInstance, isAlive: () => true, graceMs: 200 }).then(() => "ok", (e) => e.message);
  t.ok("根が残っていれば失敗を返す", stuck === "taskkill: no running instance", stuck);

  // ---- 一覧の絞り込み（ps の出力を差し替える。どの OS でも parent の直下の子だけが返る）
  const PS = [
    "    1     0 /sbin/init",
    "   50     1 node holder.mjs",
    "  100    50 agy --print= --conversation c-1",
    "  200   100 /bin/sh -c node -e \"setInterval(()=>{},1000)\"",
    "  300   200 node -e setInterval(()=>{},1000)",
    "  400     1 /usr/bin/runner-agent",
    "garbage line",
  ].join("\n");
  const psCalls = [];
  const fakePs = async (file, args) => { psCalls.push([file, ...args].join(" ")); return PS; };
  const pidsOf = (rows) => rows.map((p) => p.pid).join(",");
  const direct = await listProcesses({ parent: 100, platform: "linux", exec: fakePs });
  t.ok("POSIX でも parent の直下の子だけ（孫・init・外は入らない）", pidsOf(direct) === "200" && direct[0].ppid === 100, pidsOf(direct));
  t.ok("POSIX の一覧は pid・ppid・コマンドラインに分かれる", direct[0].command === '/bin/sh -c node -e "setInterval(()=>{},1000)"', direct[0].command);
  t.ok("init の直下を引いても、孫は入らない", pidsOf(await listProcesses({ parent: 1, platform: "linux", exec: fakePs })) === "50,400");
  t.ok("parent を省くと全部（壊れた行は除く）", pidsOf(await listProcesses({ platform: "linux", exec: fakePs })) === "1,50,100,200,300,400");
  t.ok("parent が整数でなければ絞らない", pidsOf(await listProcesses({ parent: "100", platform: "linux", exec: fakePs })) === "1,50,100,200,300,400");
  t.ok("子の無い parent は空", (await listProcesses({ parent: 999, platform: "linux", exec: fakePs })).length === 0);
  t.ok("ps -A で全部を引く", psCalls[0] === "ps -A -o pid=,ppid=,args=", psCalls[0]);
  const psWin = [];
  const fakePowershell = async (file, args) => { psWin.push(args.at(-1)); return '[{"ProcessId":5,"ParentProcessId":4,"CommandLine":"x"}]'; };
  const win = await listProcesses({ parent: 4, platform: "win32", exec: fakePowershell });
  t.ok("Windows は Win32_Process を parent で絞って引く", pidsOf(win) === "5" && psWin[0].includes("-Filter 'ParentProcessId=4'"), psWin[0]);

  // ---- 祖先
  const chain = [
    { pid: 1, ppid: 0, command: "init" }, { pid: 10, ppid: 1, command: "runner" }, { pid: 20, ppid: 10, command: "node tests" },
    { pid: 30, ppid: 20, command: "node suite" }, { pid: 31, ppid: 20, command: "other" },
  ];
  t.ok("祖先は親から順に、自分を含めずに並ぶ", JSON.stringify(ancestorsOf(chain, 30)) === "[20,10,1]", JSON.stringify(ancestorsOf(chain, 30)));
  t.ok("一覧に無い pid の祖先は空", ancestorsOf(chain, 999).length === 0);
  t.ok("親子が輪になっていても止まる", ancestorsOf(loop, 1).length === 2, JSON.stringify(ancestorsOf(loop, 1)));

  // ---- 落とす先の守り（process.kill を差し替えず、守りで例外になる pid だけを渡す。落とせてしまえば試験自身が落ちる）
  const self = { pid: 30, ppid: 20 };
  const refuse = async (pid, list, options) => killTree(pid, list, { self, ...options }).then(() => "killed", (e) => e.message);
  const noExec = async () => { throw new Error("exec must not run"); };
  for (const platform of ["win32", "linux"]) {
    const o = { platform, exec: noExec };
    t.ok(`${platform}: pid が 1 以下・整数でないものは落とさない`,
      (await Promise.all([1, 0, -5, 1.5, null, undefined, "200"].map((pid) => refuse(pid, chain, o)))).every((r) => r.startsWith("refusing")));
    t.ok(`${platform}: この process と親は落とさない`, (await refuse(30, chain, o)).startsWith("refusing") && (await refuse(20, chain, o)).startsWith("refusing"));
  }
  t.ok("POSIX: この process の祖先（親の親・init の下の runner）は落とさない", (await refuse(10, chain, { platform: "linux", exec: noExec })).startsWith("refusing"));
  // 祖先のどれかが子孫に入っていても、自分と祖先は落とさない（落とせた pid が無ければ、no process の例外で止まる）
  const skewed = [{ pid: 40, ppid: 1, command: "x" }, { pid: 30, ppid: 40, command: "me" }, { pid: 41, ppid: 30, command: "child" }];
  t.ok("POSIX: 自分の祖先を落とそうとしたら断る（一覧が自分の上に木を張っていても）",
    (await refuse(40, skewed, { platform: "linux", exec: noExec })).startsWith("refusing"));
}
