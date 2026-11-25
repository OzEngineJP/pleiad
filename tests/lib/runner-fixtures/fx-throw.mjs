export const name = "fx-throw";
export const title = "ランナーの試験用: 例外で中断する";
export default async function (t) {
  t.ok("例外の前", true);
  // fetch の「fetch failed」のように、原因が cause にだけある例外（ランナーが cause の 1 行を出すことの確認用）
  throw new Error("FX-THROW-BOOM", { cause: Object.assign(new Error("FX-CAUSE-MESSAGE"), { code: "FX_CAUSE_CODE" }) });
}
