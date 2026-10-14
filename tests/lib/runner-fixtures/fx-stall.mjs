import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
export const name = "fx-stall";
export const title = "ランナーの試験用: 出力と子プロセスを残して、結果を返さないまま止まる（suite ごとの上限で止められる）";
export default async function (t) {
  const out = process.env.RUNNER_FIXTURE_OUT;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.appendFileSync(path.join(out, "stall-attempts"), "x\n");
  fs.writeFileSync(path.join(out, `child-${name}.json`), JSON.stringify({ worker: process.pid, child: child.pid }));
  console.log("  STALL-PARTIAL-OUTPUT: ここまでは進んだ");
  await new Promise(() => {});
  t.ok("ここへは来ない", false);
}
