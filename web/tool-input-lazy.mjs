// ツール呼び出しの入力（input）の大きい中身を、行を開いたときに取る（ADR 0335）。
// loadSession は、入力の中の大きい文字列（コマンド・書き込みの本文・画像のデータなど。LAZY_MIN 以上）を頭だけにして運び、
// 呼び出しに lazyInput = { size, sig, change? } を付ける（web/history-sync.mjs の stubCall）。画面は頭だけで行を描き（閉じた見た目は変わらない）、
// 行が開かれたら GET /tool-input から入力の全文を取って、開いた中身を描き直す。
// 持っている発言（state.messages）は書き換えない。取った全文は、描いた行の中だけで使う。
// 入力は記録に追記された後に変わらないので、(sessionId, 呼び出しの id, sig) ごとにサーバーは長く覚えさせる。2 回目からは HTTP の覚えから出る

/** 全文を取る URL。sig は全文の署名（サーバーが照らし、別の中身なら 404。覚えの鍵にもなる） */
export function toolInputUrl(lazy) {
  return `/tool-input?${new URLSearchParams({ sessionId: lazy.sessionId, id: lazy.id, sig: String(lazy.sig) })}`;
}

/** renderToolCall に渡す lazyInput（{ sessionId, id, sig, size?, change? }）が、取りに行ける形か */
export const isLazyInput = (lazy) => Boolean(lazy && typeof lazy === "object" && lazy.sessionId && lazy.id && lazy.sig !== undefined && lazy.sig !== null);

/**
 * 発言の呼び出し（call）から、行に渡す印を作る。印の無い呼び出し・会話の id が分からないときは null（全文の入力として描く）。
 * sessionId は描く側が足す（サーバーの印には無い）
 */
export function lazyInputOf(call, sessionId) {
  const lazy = call?.lazyInput;
  if (!lazy || !sessionId || !call.id) return null;
  return { sessionId, id: String(call.id), sig: lazy.sig, size: lazy.size, ...("change" in lazy ? { change: lazy.change } : {}) };
}

const KEEP = 4;
const inputs = new Map();

/** 入力の全文（JSON を解いたもの）を取る。同じ入力を続けて頼まれたら 1 度だけ取る。直近の KEEP 件だけ覚える（1 件が数 MiB になりうる） */
export function fetchToolInput(lazy) {
  const url = toolInputUrl(lazy);
  let hit = inputs.get(url);
  if (hit) { inputs.delete(url); inputs.set(url, hit); return hit; }
  hit = fetch(url, { credentials: "same-origin" }).then((res) => {
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  });
  hit.catch(() => { if (inputs.get(url) === hit) inputs.delete(url); });
  inputs.set(url, hit);
  while (inputs.size > KEEP) inputs.delete(inputs.keys().next().value);
  return hit;
}
