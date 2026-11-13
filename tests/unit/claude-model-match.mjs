// ply_delegate の model に AI が正式な ID（claude-sonnet-5-5 など）を書いたときの当て方（core/backends/claude-models.mjs）。
// 一覧の id・行の resolvedModel に正確に一致する行だけに当て、一覧に無い名前は系統名へ縮めない
// （'claude-fable-5-2' を 'fable' にすると、'fable' の指す版は CLI が決めるので別の版で走ることがある。
//   当たらない名前はそのまま送り、CLI/API が使えなければ理由を返す。ADR 0310）。
// 実際の CLI は呼ばず、setClaudeSdkForTest で一覧を差し替えて確かめる。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";
import { buildClaudeModels, catalogIsComplete, matchClaudeModel } from "../../core/backends/claude-models.mjs";

export const name = "claude-model-match";
export const title = "Claude のモデル名: 正確に当たる行だけ読み替え、一覧に無い名前は系統名へ縮めない";

const ROWS = [
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", description: "Sonnet 5.5 · test" },
  { value: "opus", resolvedModel: "claude-opus-5-5", description: "Opus 5.5 · test" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", description: "Opus 5.5 with 1M context · test" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", description: "Haiku 4.5 · test" },
];
// CLI 2.1.322 の実測に沿った形。完全な一覧は系統ごとに別名の行を持つ（fable は Fable 5.2 を指す）。
// 短い一覧は版つきの行だけで、系統の別名の行が欠ける
const COMPLETE_ROWS = [
  { value: "default", resolvedModel: "claude-opus-5-5" },
  { value: "fable", resolvedModel: "claude-fable-5-2", description: "Fable 5.2 · test" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", description: "Fable 5.1 · test" },
  { value: "opus", resolvedModel: "claude-opus-5-5", description: "Opus 5.5 · test" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", description: "Sonnet 5.5 · test" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", description: "Haiku 4.5 · test" },
];
const SHORT_ROWS = [
  { value: "default", resolvedModel: "claude-opus-5-5" },
  { value: "opus", resolvedModel: "claude-opus-5-5", description: "Opus 5.5 · test" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", description: "Fable 5.1 with 1M context · test" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", description: "Sonnet 5.5 · test" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", description: "Haiku 4.5 · test" },
];

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-model-match-"));
  const exe = path.join(dir, "claude-fake-cli");
  fs.writeFileSync(exe, "match-v1");   // 他のテストが覚えた一覧と目印が食い違うので、一覧は忘れた状態から始まる
  const cwd = path.join(dir, "work");
  fs.mkdirSync(cwd);
  const restore = setClaudeSdkForTest({
    executable: () => exe,
    cliSigThrottleMs: 0,
    probe: () => Promise.resolve({ rows: ROWS, efforts: {}, applied: true }),
  });
  try {
    await claude.models(cwd);
    t.ok("（前提）正式な ID は一覧の id ではないので、そのままでは一覧に無い", !Object.hasOwn(await claude.models(cwd), "claude-sonnet-5-5"));
    t.ok("正式な ID は resolvedModel が一致する行に当たる", await claude.matchModel("claude-sonnet-5-5", cwd) === "sonnet");
    t.ok("1M の正式な ID は resolvedModel が一致する行に当たる", await claude.matchModel("claude-opus-5-5[1m]", cwd) === "opus[1m]");
    t.ok("大文字小文字は問わない", await claude.matchModel("Claude-Sonnet-5-5", cwd) === "sonnet");
    t.ok("一覧の id はそのまま当たる（一覧に無い系統は隠しの別名の行）", await claude.matchModel("fable", cwd) === "fable" && (await claude.models(cwd)).fable.hidden === true);
    t.ok("版が一覧に無い正式な ID は当たらない（系統名へ縮めない。指す版は CLI が決めるので別の版で走ることがある）", await claude.matchModel("claude-opus-4-1", cwd) === null);
    t.ok("版が一覧に無い 1M の ID も系統の 1M の行へは縮めない", await claude.matchModel("claude-opus-4-1[1m]", cwd) === null);
    t.ok("知らない名前は当たらない（null）", await claude.matchModel("no-such-model", cwd) === null && await claude.matchModel("gpt-5", cwd) === null);
    t.ok("空の名前は当たらない", await claude.matchModel("", cwd) === null);

    // buildClaudeModels・matchClaudeModel を表で直に確かめる（CLI 2.1.322 の短い一覧の形）
    const short = buildClaudeModels({ rows: SHORT_ROWS });
    t.ok("短い一覧の隠しの fable は版つきの名前を借りない（Fable 5.1 ではなく Fable）",
      short.fable.label === "Fable" && short.fable.hidden === true, short.fable.label);
    t.ok("claude-fable-5-2 が一覧に無くても fable に縮まない（そのまま渡す）",
      matchClaudeModel(short, SHORT_ROWS, "claude-fable-5-2") === null);
    t.ok("claude-fable-5-1 は resolvedModel が一致する行に当たる",
      matchClaudeModel(short, SHORT_ROWS, "claude-fable-5-1") === "claude-fable-5-1[1m]");
    const full = buildClaudeModels({ rows: COMPLETE_ROWS });
    t.ok("完全な一覧では fable の行は隠しではなく、その版の名前で出る",
      full.fable.hidden !== true && full.fable.label === "Fable 5.2", full.fable.label);
    t.ok("完全な一覧では claude-fable-5-2 は fable の行に当たる",
      matchClaudeModel(full, COMPLETE_ROWS, "claude-fable-5-2") === "fable");
    t.ok("短い一覧・完全な一覧を catalogIsComplete で見分ける（系統の別名の行の有無）",
      catalogIsComplete(COMPLETE_ROWS) && !catalogIsComplete(SHORT_ROWS) && !catalogIsComplete(null));

    const mythosRows = [
      ...COMPLETE_ROWS,
      { value: "claude-mythos-5-2", resolvedModel: "claude-mythos-5-2", displayName: "Mythos 5.2", description: "" },
      { value: "claude-mythos-5-1", resolvedModel: "claude-mythos-5-1", displayName: "Mythos 5.1", description: "" },
    ];
    const withMythos = buildClaudeModels({ rows: mythosRows });
    t.ok("Mythos は CLI の行のまま（別名 mythos を作らず、空の注記だけ辞書から補う）",
      withMythos["claude-mythos-5-2"]?.label === "Mythos 5.2"
      && Boolean(withMythos["claude-mythos-5-2"]?.note)
      && withMythos["claude-mythos-5-1"]?.label === "Mythos 5.1"
      && withMythos["claude-mythos-5-1"]?.note === withMythos["claude-mythos-5-2"]?.note
      && !("mythos" in withMythos) && !("mythos" in full)
      && catalogIsComplete(mythosRows)
      && matchClaudeModel(withMythos, mythosRows, "claude-mythos-5-2") === "claude-mythos-5-2"
      && matchClaudeModel(full, COMPLETE_ROWS, "claude-mythos-5-2") === null,
      JSON.stringify(withMythos["claude-mythos-5-2"]));
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
