// 系譜（枝の印）の照合に使う会話の「概要」（outline）の、指紋と抜粋（ADR 0334）。
// サーバー（core/server.mjs の loadSession の outline）と画面（web/branches.mjs）が同じ関数を使う。
// 画面の照合は「同じ発言か」と「札に出す先頭の抜粋」しか本文を見ない。全文を運ばずに、この 2 つだけを渡す。
import { hash53 } from "./hash53.mjs";

/** 札に出す発言の抜粋。1 行に畳み、長ければ切る（札は省略で縮むので、全文は title と読み上げ名で渡す） */
export const excerptOf = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

/** 発言のツール名の並び（toolCalls の名前 → tools の順） */
export const toolNames = (m) => (m.toolCalls ?? []).map((c) => c.name).concat(m.tools ?? []).join("\0");

/** 概要の発言か（本文の代わりに指紋 fp を持つ） */
export const isDigest = (m) => typeof m?.fp === "number";

const fingerprints = new WeakMap();
/**
 * 発言 1 件の指紋（本文とツール名から数える 53 ビットの値）。概要の発言は持っている fp、全文の発言は数える。
 * 同じオブジェクトなら 1 度しか数えない（窓の発言を、他の枝の概要と何度も照合するため）。
 * 区切りの曖昧さが出ないよう JSON の配列にしてから数える
 */
export function fingerprint(m) {
  if (isDigest(m)) return m.fp;
  let fp = fingerprints.get(m);
  if (fp === undefined) fingerprints.set(m, fp = hash53(JSON.stringify([m.text ?? "", toolNames(m)])));
  return fp;
}

/**
 * 概要の 1 件（サーバーが `outline: { digest: true }` の頼みに返す形）。
 * uuid・役割・指紋 fp に加え、人の発言で本文があるときだけ抜粋 ex（札の見分けに使う先頭 200 字）を持つ
 */
export function digestOf(m) {
  const out = { uuid: m.uuid, role: m.role, fp: fingerprint(m) };
  if (m.role === "user" && typeof m.text === "string" && m.text.trim()) out.ex = excerptOf(m.text);
  return out;
}

/**
 * 2 つの発言の役割・本文・ツール名が同じか。両方とも全文なら本文をそのまま比べる（これまでと同じ）。
 * どちらかが概要なら、指紋で比べる（全文の側は指紋を数える）
 */
export function sameContent(a, b) {
  if (a.role !== b.role) return false;
  if (!isDigest(a) && !isDigest(b)) return (a.text ?? "") === (b.text ?? "") && toolNames(a) === toolNames(b);
  return fingerprint(a) === fingerprint(b);
}

/** 札に出す抜粋。概要の発言は持っている ex、全文の発言は本文から。人の発言で本文が無ければ空 */
export const promptExcerpt = (m) => (isDigest(m) ? m.ex ?? "" : excerptOf(m.text));
