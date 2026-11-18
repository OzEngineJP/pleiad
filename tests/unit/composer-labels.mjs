// 入力欄の設定: モデルの一覧の「ほかのモデル」の分け方（web/composer-labels.mjs の splitModelRows。docs/design-system.md「入力欄の設定」）。
//
//   - Claude: 系統（Fable・Opus・Sonnet・Haiku）ごとに一番新しい版だけを上に。古い版と知らない系統（Mythos）は下。版の無い名前は上
//   - ほかのエージェント: 補足が previous generation / legacy のものを下。Antigravity は分けない
//   - 既定のモデルは古くても上。下の行で補足が系統と同じもの・legacy のものは補足を出さない（quiet）
// DOM も LLM も使わない。
import { splitModelRows } from "../../web/composer-labels.mjs";

export const name = "composer-labels";
export const title = "入力欄の設定: モデルの一覧の「ほかのモデル」の分け方";

const OPUS = "最も賢い", SONNET = "速さと賢さの釣り合い", HAIKU = "速く軽い";

export default async function (t) {
  const claude = {
    "": { label: "既定", resolvesTo: "opus" },
    opus: { label: "Opus 5.5", note: OPUS },
    "opus[1m]": { label: "Opus 5.5 (1M)", note: OPUS },
    "claude-opus-5": { label: "Opus 5", note: OPUS },
    "claude-opus-4-6": { label: "Opus 4.6", note: OPUS },
    sonnet: { label: "Sonnet 5.5", note: SONNET },
    "claude-sonnet-4-5": { label: "Sonnet 4.5", note: SONNET },
    haiku: { label: "Haiku", note: HAIKU },
    mythos: { label: "Mythos Preview", note: "研究用" },
  };
  const ids = Object.keys(claude).filter(Boolean);
  const c = splitModelRows(claude, ids);
  t.ok("Claude: 系統ごとに一番新しい版（1M も同じ版）と版の無い名前が上",
    JSON.stringify(c.main) === JSON.stringify(["opus", "opus[1m]", "sonnet", "haiku"]), JSON.stringify(c.main));
  t.ok("Claude: 古い版と知らない系統は「ほかのモデル」",
    JSON.stringify(c.other) === JSON.stringify(["claude-opus-5", "claude-opus-4-6", "claude-sonnet-4-5", "mythos"]), JSON.stringify(c.other));
  t.ok("Claude: 系統と同じ補足の古い行は補足を出さず、自分だけの補足は出す",
    c.quiet.has("claude-opus-5") && c.quiet.has("claude-sonnet-4-5") && !c.quiet.has("mythos"), JSON.stringify([...c.quiet]));
  t.ok("Claude: 版は数で比べる（5.10 は 5.9 より新しい）",
    JSON.stringify(splitModelRows({ a: { label: "Opus 5.9" }, b: { label: "Opus 5.10" } }, ["a", "b"]).main) === JSON.stringify(["b"]));

  const pinned = { ...claude, "": { label: "既定", resolvesTo: "claude-opus-4-6" } };
  const p = splitModelRows(pinned, ids);
  t.ok("既定のモデルは古い版でも上に残す", p.main.includes("claude-opus-4-6") && !p.other.includes("claude-opus-4-6"), JSON.stringify(p.main));

  const codex = {
    "": { label: "既定" },
    "gpt-5.6": { label: "gpt-5.6", note: "Latest frontier model" },
    "gpt-5.6-mini": { label: "gpt-5.6-mini", note: "Fast and cheap" },
    "gpt-5.2": { label: "gpt-5.2", note: "Previous generation frontier model" },
    "gpt-4.1": { label: "gpt-4.1", note: "Legacy model" },
  };
  const x = splitModelRows(codex, Object.keys(codex).filter(Boolean));
  t.ok("ほかのエージェント: previous generation と legacy の補足のものを下へ",
    JSON.stringify(x.main) === JSON.stringify(["gpt-5.6", "gpt-5.6-mini"]) && JSON.stringify(x.other) === JSON.stringify(["gpt-5.2", "gpt-4.1"]), JSON.stringify(x));
  t.ok("ほかのエージェント: legacy の補足は出さず、自分だけの補足は出す", x.quiet.has("gpt-4.1") && !x.quiet.has("gpt-5.2"));

  // 分け方はエージェントの id ではなく一覧の中身で決める。系統（family）にまとめた一覧（Antigravity）は、補足が何でも分けない
  const agy = { "a-high": { label: "Gemini 3.1 Pro", note: "legacy", family: "gemini-3.1-pro", level: "high" }, b: { label: "Claude Opus 4.6", note: "" } };
  t.ok("系統にまとめた一覧（Antigravity）は分けない", splitModelRows(agy, ["a-high", "b"]).other.length === 0);
  // Antigravity の系統を持たない一覧（「Claude Opus 4.6」「Gemini 3 Flash」）は頭が系統の名前ではないので、Claude の分け方にならない
  const agyFlat = { c: { label: "Claude Opus 4.6", note: null }, g: { label: "Gemini 3 Flash", note: null } };
  t.ok("頭が系統の名前でない一覧は、Claude の分け方にしない", splitModelRows(agyFlat, ["c", "g"]).other.length === 0);
}
