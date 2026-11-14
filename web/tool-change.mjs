// 編集・書き込みのツールが変えた量（行の右端の「−2 +3」・まとまりの見出しの「N ファイルを変更」）の計算。
// 画面（web/render.mjs の toolChange・差分の枠）とサーバー（web/history-sync.mjs が大きい入力を印にするとき、
// 印に量を添える。ADR 0334）で同じ計算を使うので、DOM を持たない 1 ファイルに置く
import { FILE_KEYS } from './file-keys.mjs';

export const lineCount = (s) => (String(s ?? "") ? String(s).split("\n").length : 0);

/** 行単位。前後の一致部分を落として、変わったところだけ残す */
export function diffLines(oldS, newS) {
  const a = String(oldS ?? "").split("\n");
  const b = String(newS ?? "").split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre &&
         a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  return { del: a.slice(pre, a.length - post), add: b.slice(pre, b.length - post) };
}

// 名前で決まるツール（Claude Code）。バックエンドが申告した shape（toolHints。Codex の fileChange・agy の write_file / edit_file）は SHAPE_KIND
const NAME_KIND = { MultiEdit: "multi", Write: "write", Edit: "edit", NotebookEdit: "edit" };
const SHAPE_KIND = { write: "write", edit: "edit" };

/** 変える量を持つツールの種類（"multi" | "write" | "edit"）。変えないツールは null。shape は toolHints の shape */
export function changeKind(name, shape) {
  return NAME_KIND[String(name ?? "")] ?? SHAPE_KIND[shape] ?? null;
}

/** kind（changeKind の値）のツールの入力が変えた量 { path, del, add }（Codex の fileChange は paths も）。変えないツール・パスの無い入力は null */
export function changeOf(kind, input) {
  if (!kind) return null;
  const inp = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const path = FILE_KEYS.map((k) => inp[k]).find((v) => typeof v === "string" && v);
  if (!path) {
    // Codex の fileChange は変更したパスの一覧だけを持つ（量は分からないので 0。数えるのはファイルの数だけ）
    const paths = Array.isArray(inp.files) ? inp.files.filter((p) => typeof p === "string" && p) : [];
    return paths.length ? { path: paths[0], paths, del: 0, add: 0 } : null;
  }
  if (kind === "write") return { path, del: 0, add: lineCount(inp.content ?? inp.CodeContent) };
  if (kind === "edit") {
    const { del, add } = diffLines(inp.old_string ?? inp.TargetContent, inp.new_string ?? inp.ReplacementContent);
    return { path, del: del.length, add: add.length };
  }
  let del = 0, add = 0;
  for (const e of Array.isArray(inp.edits) ? inp.edits : []) {
    const d = diffLines(e?.old_string, e?.new_string);
    del += d.del.length; add += d.add.length;
  }
  return { path, del, add };
}
