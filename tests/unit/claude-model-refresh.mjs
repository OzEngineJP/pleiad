// Claude の models(cwd, { refresh: true })（server.mjs の共通 validModel が「一覧に無い」を確かめ直すために呼ぶ）:
//   - TTL は無視して取り直し、結果を待つ
//   - ただし一覧を取ってから 60 秒（失敗の再試行待ちと同じ間隔）の内は手元の一覧を返す
//   - probe の失敗の直後も再試行待ちを守る（待たない・起こさない）
// あわせて backend.validModel（共通の確かめのあとの最後の判断）: 一覧を 1 度も取れていない間は
// 形の良い id を通し、一覧が取れたあとは断る。
// 実際の CLI は呼ばず、setClaudeSdkForTest で probe と executable を差し替えて確かめる。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";

export const name = "claude-model-refresh";
export const title = "Claude のモデル一覧: { refresh } の取り直しと、一覧を取れていない間の最後の判断";

// 版付きの id（固定の一覧のエイリアスと重ならないもの）で取り直しを見分ける
const ROW_V1 = { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", description: "v1" };
const ROW_V2 = { value: "claude-sonnet-5-5", resolvedModel: "claude-sonnet-5-5", description: "v2" };
const has = (models, id) => Object.hasOwn(models, id);

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-model-refresh-"));
  const exe = path.join(dir, "claude-fake-cli");
  fs.writeFileSync(exe, "v1");   // 他のテストが覚えた一覧と目印が食い違うので、一覧は忘れた状態から始まる
  const cwd = path.join(dir, "work");
  fs.mkdirSync(cwd);

  const realNow = Date.now;
  let nowMs = realNow();
  let calls = 0, rows = [ROW_V1], fail = null;
  const restore = setClaudeSdkForTest({
    executable: () => exe,
    cliSigThrottleMs: 0,
    probe: () => { calls++; return fail ? Promise.reject(fail) : Promise.resolve({ rows, efforts: {}, applied: true }); },
  });
  try {
    Date.now = () => nowMs;

    // 一覧を 1 度も取れていない間（probe が失敗し続ける）: 固定の一覧で答え、形の良い id は最後の判断で通す
    fail = new Error("probe-down");
    const ghost = await claude.models(cwd, { refresh: true });
    t.ok("取れなければ固定の一覧で答える", has(ghost, "sonnet") && calls === 1, `${calls} 回 ${Object.keys(ghost).join(",")}`);
    t.ok("一覧を取れていない間は、固定の一覧に無い形の良い id を通す（CLI が確かめる）",
      await claude.validModel("claude-fable-9-9", cwd) === true);
    t.ok("形の悪い id は通さない",
      await claude.validModel("bad\nmodel", cwd) === false && await claude.validModel(123, cwd) === false);

    // 一覧を取れたあとは、最後の判断は「一覧どおり」に譲る
    fail = null;
    nowMs += 61_000;   // 失敗の再試行待ち（60 秒）を過ぎさせる
    const first = await claude.models(cwd);
    t.ok("取り直せれば取った一覧で答える", has(first, "claude-sonnet-5") && calls === 2, `${calls} 回 ${Object.keys(first).join(",")}`);
    t.ok("一覧が取れたあとは、一覧に無い形の良い id は断る", await claude.validModel("claude-fable-9-9", cwd) === false);

    // 取ってから 60 秒の内の取り直しは手元の一覧を返す（確かめが並ぶ経路で CLI を続けて起こさない）
    const soon = await claude.models(cwd, { refresh: true });
    t.ok("取ってから 60 秒以内の取り直しは手元の一覧（probe を増やさない）",
      has(soon, "claude-sonnet-5") && calls === 2, `${calls} 回`);

    rows = [ROW_V2];
    nowMs += 61_000;
    const fresh = await claude.models(cwd, { refresh: true });
    t.ok("60 秒を過ぎた取り直しは TTL を無視して引き直し、新しい一覧で答える",
      has(fresh, "claude-sonnet-5-5") && !has(fresh, "claude-sonnet-5") && calls === 3, `${calls} 回 ${Object.keys(fresh).join(",")}`);

    const after = await claude.models(cwd);
    t.ok("取り直した一覧は覚えられる（続く読み取りは新しい一覧）", has(after, "claude-sonnet-5-5") && calls === 3, `${calls} 回`);

    // probe の失敗の直後（60 秒）の取り直しは待たない・起こさない（前の一覧のまま）
    fail = new Error("probe-down-2");
    nowMs += 61_000;
    const failed = await claude.models(cwd, { refresh: true });
    t.ok("取り直しが失敗したら前の一覧を残す", has(failed, "claude-sonnet-5-5") && calls === 4, `${calls} 回`);
    const rightAfter = await claude.models(cwd, { refresh: true });
    t.ok("失敗の直後は取り直さず待たない（前の一覧のまま）", has(rightAfter, "claude-sonnet-5-5") && calls === 4, `${calls} 回`);
  } finally {
    Date.now = realNow;
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
