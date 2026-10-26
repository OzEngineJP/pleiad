// mark 型のエージェントロゴ（SVG の #mark を currentColor で描くもの）の文書内シンボル。
//
// <use href="./brand/x.svg#mark"> の外部参照は、挿すたびにファイルを取り直す（web/ の静的配信は
// キャッシュ系の応答を付けない。core/server.mjs）。一覧の行を作り直すたびにロゴが空白になるので、
// 文書内の <symbol> を指す <use href="#…"> に替える。文書内参照はフェッチが要らず、シンボルは
// 文書へ足された時点で参照が解決し直される（live）ので、行は届く前に置いてよい。

import { svgEl } from "./dom.mjs";

const loads = new Map();   // logo のファイル名 → 読み込み中/済みの Promise。失敗したら捨て、次の呼び出しで取り直す
let holder = null;         // シンボルを置く隠し svg

/** シンボルの id。<use href="#…"> の参照先。ファイル名をそのまま id にするとほかの要素とぶつかるので接頭辞を付ける */
const symbolId = (logo) => `brand-mark-${String(logo).replace(/\.svg$/i, "")}`;

function symbols() {
  if (!holder?.parentNode) {
    holder = svgEl("svg", { "aria-hidden": "true", style: "position:absolute;width:0;height:0;overflow:hidden" });
    (document.body ?? document.documentElement).append(holder);
  }
  return holder;
}

/**
 * web/brand/<logo> を 1 度だけ読み、中の #mark を文書内の <symbol> として登録する。
 * 読み込み中でも登録済みでも参照先の id を返す。<use> はシンボルが届くまで何も描かず、届いた時点で描かれる
 */
export function ensureBrandMark(logo) {
  const id = symbolId(logo);
  if (!loads.has(logo)) {
    loads.set(logo, (async () => {
      const res = await fetch(`./brand/${logo}`);
      if (!res.ok) throw new Error(String(res.status));
      const doc = new DOMParser().parseFromString(await res.text(), "image/svg+xml");
      const mark = doc.getElementById("mark");
      if (!mark) throw new Error("no #mark");
      const symbol = svgEl("symbol", { id });
      const viewBox = doc.documentElement.getAttribute("viewBox");
      if (viewBox) symbol.setAttribute("viewBox", viewBox);
      mark.removeAttribute("id");   // シンボルごとに id が要る。中の id は重複するので外す
      symbol.append(mark);
      symbols().append(symbol);
    })().catch(() => loads.delete(logo)));
  }
  return id;
}

/** エージェントの一覧（describeBackends の行）にある mark 型のロゴを裏で読み始める（描く前に届かせる） */
export function preloadBrandMarks(list) {
  for (const b of Array.isArray(list) ? list : []) if (b?.brand?.logo && b.brand.mark) ensureBrandMark(b.brand.logo);
}
