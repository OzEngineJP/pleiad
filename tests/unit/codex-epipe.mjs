// Codex の app-server の子への書き込みの失敗（EPIPE など）で、サーバーが落ちない（core/backends/codex-rpc.mjs）。
//
// 子が終わる・入力を閉じる瞬間と書き込みが競ると、親はまだ exit を受けておらず stdin.writable も真のまま書き、失敗は stdin の 'error' で後から来る。
// 受け手が無いと Node が例外として投げてプロセスごと落ちる（2026-11-26 の起動直後の落ち方）。2 つの場面で見る:
//   A. 子が生きたまま stdin に 'error'（EPIPE）が来る（決まった順で、誤りの形・子を止めること・onDown を見る）
//   B. 本物の競り合い: tests/lib/scripted-codex.mjs の test/exit で子を終わらせ、子が消えるまで親のイベントループを止めて待ってから書く
//      （exit の知らせより先に書く）。Windows の名前付きパイプは小さな書き込みを黙って受けるので、パイプの容量を超える行を書く
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRpc } from "../../core/backends/codex-rpc.mjs";
import { t as tr } from "../../core/i18n.mjs";

export const name = "codex-epipe";
export const title = "Codex の app-server の子への書き込みの失敗（EPIPE）でサーバーが落ちず、待っている依頼が失敗で返り、次の依頼で起こし直す";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "tests", "lib", "scripted-codex.mjs");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
// Linux では、終わった子は親が wait するまで zombie として残り、kill(pid, 0) が通り続ける（親のイベントループを止めて待つここでは永久に）。zombie は終わったものとして数える
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
};
const describe = (result) => String(result.error?.message ?? JSON.stringify(result.value));

/** 子が終わるまで同期で待つ（イベントループを回さないので、親はまだ exit を受けない）。終わったら true */
function blockUntilGone(pid, ms = 10_000) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    Atomics.wait(cell, 0, 0, 10);
  }
  return true;
}

/** A. 子が生きたまま stdin に 'error' が来る */
async function inputErrorWhileAlive(t, r, uncaught) {
  await r.start();
  const first = r.proc;
  const downs = [];
  const off = r.onDown((err) => downs.push(err));
  // 答えの来ない依頼（scripted-codex は thread/start を test/release まで返さない）
  const hanging = settle(r.request("thread/start", {}, 10_000));
  await wait(50);
  let thrown = null;
  try { first.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -4047, syscall: "write" })); }
  catch (error) { thrown = error; }   // 受け手が無いと emit がその場で投げる（本物では未処理の例外になってプロセスが落ちる）
  const result = await hanging;
  await wait(200);
  off();
  const notConnected = tr("codex.errors.notConnected");
  t.ok("A: stdin の 'error' に受け手がある（投げない）", thrown === null && uncaught.length === 0, String(thrown?.stack ?? uncaught[0]?.stack ?? ""));
  t.ok("A: 待っていた依頼は「つながっていない」で失敗する（時間切れまで待たない）", result.error?.message?.startsWith(notConnected) === true, describe(result));
  t.ok("A: 誤りに元の EPIPE を添える", result.error?.cause?.code === "EPIPE", String(result.error?.cause?.code));
  t.ok("A: pending は空になり、落ちたときと同じく onDown が 1 回だけ呼ばれ（後から来る exit で重ねない）、proc を手放す",
    r.pending.size === 0 && downs.length === 1 && r.proc === null, `pending=${r.pending.size} downs=${downs.length} proc=${Boolean(r.proc)}`);
  const gone = first.exitCode !== null || first.signalCode !== null || await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    first.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
  t.ok("A: 入力が壊れた子は止める（残さない）", gone, `exit=${first.exitCode} signal=${first.signalCode}`);
  const again = await settle(r.request("test/state", {}, 10_000));
  t.ok("A: 次の依頼で app-server を起こし直して通る", Array.isArray(again.value?.turns) && Boolean(r.proc) && r.proc !== first, describe(again));
}

/** B. 子が終わった瞬間（親はまだ exit を受けていない）に書く */
async function writeAfterChildExit(t, r, uncaught) {
  await r.start();
  const first = r.proc;
  const downs = [];
  const off = r.onDown((err) => downs.push(err));
  const hanging = settle(r.request("thread/start", {}, 10_000));
  await r.request("test/exit");
  const gone = blockUntilGone(first.pid);
  const before = { exit: first.exitCode, writable: first.stdin.writable, same: r.proc === first };
  const failed = settle(r.request("test/state", { pad: "x".repeat(256 * 1024) }, 10_000));   // 同期の部分で stdin へ書く
  t.ok("B: 前提: 子は終わったが、親はまだ exit を受けておらず stdin.writable も真のまま書く", gone && before.exit === null && before.writable === true && before.same,
    JSON.stringify({ gone, ...before }));
  const results = await Promise.all([failed, hanging]);
  await wait(200);
  off();
  // 書き込みの失敗（つながっていない）と exit（落ちた）のどちらが先に届くかは OS 次第。どちらでも失敗で返ればよい
  const failedFast = (res) => res.error && (res.error.message.startsWith(tr("codex.errors.notConnected"))
    || res.error.message.startsWith(tr("codex.errors.appServerDied", { why: "" }).trim()));
  t.ok("B: 書き込みの失敗は未処理の例外にならない（サーバーが落ちない）", uncaught.length === 0, uncaught.map((e) => String(e?.stack ?? e)).join("\n"));
  t.ok("B: 書き込んだ依頼も、先に待っていた依頼も失敗で返る（時間切れまで待たない）", failedFast(results[0]) && failedFast(results[1]),
    `${describe(results[0])} / ${describe(results[1])}`);
  t.ok("B: pending は空になり、onDown は 1 回だけ", r.pending.size === 0 && downs.length === 1 && r.proc === null, `pending=${r.pending.size} downs=${downs.length}`);
  const again = await settle(r.request("test/state", {}, 10_000));
  t.ok("B: 次の依頼で app-server を起こし直して通る", Array.isArray(again.value?.turns) && Boolean(r.proc) && r.proc !== first, describe(again));
}

export default async function (t) {
  const previous = process.env.AGENT_HOST_CODEX_BIN;
  process.env.AGENT_HOST_CODEX_BIN = `node "${SCRIPT}"`;
  const r = new CodexRpc();
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  // 直す前は、ここで拾わなければ試験の worker ごと落ちる。拾って「落ちる形だった」と判定に出す
  process.on("uncaughtException", onUncaught);
  try {
    await inputErrorWhileAlive(t, r, uncaught);
    await writeAfterChildExit(t, r, uncaught);
  } finally {
    process.off("uncaughtException", onUncaught);
    await r.stop();
    if (previous === undefined) delete process.env.AGENT_HOST_CODEX_BIN;
    else process.env.AGENT_HOST_CODEX_BIN = previous;
  }
}
