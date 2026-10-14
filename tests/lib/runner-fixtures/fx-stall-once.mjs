import fs from "node:fs";
import path from "node:path";
export const name = "fx-stall-once";
export const title = "ランナーの試験用: 1 回目だけ結果を返さないまま止まる（2 回目は通る。stall-once-attempts に 1 回ごとに 1 行足す）";
export default async function (t) {
  const file = path.join(process.env.RUNNER_FIXTURE_OUT, "stall-once-attempts");
  fs.appendFileSync(file, "x\n");
  const attempt = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  if (attempt === 1) { console.log("  STALL-ONCE-OUTPUT"); await new Promise(() => {}); }
  t.ok("2 回目は通る", true);
}
