import fs from "node:fs";
import path from "node:path";
export const name = "fx-g-hold";
export const title = "ランナーの試験用: fx-g-probe が結果を書くまで worker を 1 本ふさぐ（--jobs 2 で fx-g-dirty と fx-g-probe を同じ worker に続けて流すため）";
export default async function (t) {
  const file = path.join(process.env.RUNNER_FIXTURE_OUT, "g-probe.json");
  const end = Date.now() + 30_000;
  while (!fs.existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  t.ok("fx-g-probe が走った", fs.existsSync(file));
}
