// AskUserQuestion の回答の組み立て。
//
// AskUserQuestion は「危ないから承認する」ツールではなく、こちらに聞いているツール。
// 回答は input の `answers`（質問文 -> 回答）で返す。単一選択は文字列、
// 複数選択は配列（選択肢の value にカンマが入りうるので、区切り文字ではなく要素の境界で持つ）。
// 文字列を求めるバックエンド（Claude の SDK など）は、受け取る側で配列を結合する。
// UI は DOM を抱えていてそのままは呼べないので、規則だけここに写して固定する。
//
// ※ web/client.mjs の questionCard を変えたら、ここも合わせて変えること。
export const name = "ask-answers";
export const title = "質問への回答の組み立て";

/** questionCard の answersNow と同じ規則 */
function build(questions, picked, notes) {
  const out = {};
  for (const q of questions) {
    const parts = [...(picked.get(q.question) ?? [])];
    const free = notes.get(q.question);
    if (free) parts.push(free);
    if (parts.length) out[q.question] = q.multiSelect ? parts : parts.join(", ");
  }
  return out;
}
const ready = (questions, answers) => Object.keys(answers).length >= questions.length;

export default function (t) {
  const q1 = { question: "どれにする？", multiSelect: false };
  const q2 = { question: "どれを有効にする？", multiSelect: true };

  t.ok("選んだ選択肢が回答になる",
    build([q1], new Map([["どれにする？", new Set(["A"])]]), new Map())["どれにする？"] === "A");

  t.ok("複数選択は配列のまま（カンマ入りの選択肢でも切れない）",
    JSON.stringify(build([q2], new Map([["どれを有効にする？", new Set(["A,B", "C"])]]), new Map())["どれを有効にする？"]) === '["A,B","C"]',
    "opencode の選択肢の value はカンマを含みうる");

  t.ok("自由記述だけでも回答になる",
    build([q1], new Map(), new Map([["どれにする？", "自分で書いた案"]]))["どれにする？"] === "自分で書いた案",
    "『その他』は選択肢に含めない決まりなので UI 側で用意する");

  t.ok("選択と自由記述は両方乗る",
    build([q1], new Map([["どれにする？", new Set(["A"])]]), new Map([["どれにする？", "ただし条件付き"]]))["どれにする？"]
      === "A, ただし条件付き");

  t.ok("複数選択でも自由記述は配列の要素として乗る",
    JSON.stringify(build([q2], new Map([["どれを有効にする？", new Set(["A"])]]), new Map([["どれを有効にする？", "自分で書いた案"]]))["どれを有効にする？"])
      === '["A","自分で書いた案"]');

  t.ok("答えていない質問はキーごと出さない",
    Object.keys(build([q1, q2], new Map([["どれにする？", new Set(["A"])]]), new Map())).length === 1);

  t.ok("全部答えるまで送れない",
    ready([q1, q2], build([q1, q2], new Map([["どれにする？", new Set(["A"])]]), new Map())) === false);

  t.ok("全部答えたら送れる",
    ready([q1, q2], build([q1, q2],
      new Map([["どれにする？", new Set(["A"])], ["どれを有効にする？", new Set(["X"])]]), new Map())) === true);

  t.ok("空白だけの自由記述は回答にしない",
    Object.keys(build([q1], new Map(), new Map([["どれにする？", ""]]))).length === 0);
}
