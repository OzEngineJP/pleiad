// agy の裏へ回ったコマンドを止めるときの、落とす先の選び方（core/backends/antigravity-background.mjs）。
//
// プロセスは起こさない。一覧（{ pid, ppid, command }）を渡して、純粋な部品として測る。
// 守ること: agy の直下の子でコマンドを走らせているものだけを選ぶ。agy 自身・中継・孫・会話の外は選ばない。
// 見つからない・あいまいなら選ばない。コマンドラインの形は実機（Windows の agy 1.3.4）の木に合わせた。
import { commandKey, commandLabel, descendantsOf, killTree, pickCommandProcess, pickHeldAgy } from "../../core/backends/antigravity-background.mjs";

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
}
