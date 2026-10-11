// Codex の会話の履歴を読む（thread/read の代わり）。
//
// thread/read { includeTurns: true } は会話を 1 行の応答で丸ごと返す。画像を作った会話は 1 枚につき 1.6 MB ほどの
// base64（imageGeneration の result）を抱えるので、14 枚で 22 MB を超え、保持役の 1 行の上限（16 MiB）で捨てられる
// （応答が来ないまま待ち続け、会話が開けない・追加の指示が届かない・終わった子が「実行中」のまま残る）。
//
// paginated のスレッド（codex-cli 0.156 以降に作った会話）は、メタデータだけの thread/read の後に
//   thread/turns/list { itemsView: "notLoaded" }  … ターンの並びと時刻（数百バイト）
//   thread/items/list { limit }                   … アイテムを少しずつ
// で読む。画像を含むページの後はページを小さくし、1 行が上限を超えたら（CodexRpc が LINE_OVERFLOW で失敗にする）
// 同じ位置を半分の大きさで読み直す。legacy のスレッドとページ読みを知らない版は、今までどおり 1 回で読む。
// どちらも、保存先（savedPath）がある画像の base64 は捨てる（画面は /local-file で保存先を開く）。
// 1 回の応答は HISTORY_TIMEOUT_MS で打ち切る（他の thread/read と同じ 30 秒）。
//
// codex の thread_history_1.sqlite（thread_items）を直に読む手もあるが、codex の内部の形で、legacy のスレッドが載らず、
// CODEX_HOME ごとに場所が変わるので使わない（docs/multi-backend.md「Codex の履歴の読み出し」）。

import { t } from "../i18n.mjs";

export const HISTORY_TIMEOUT_MS = 30_000;
/** CodexRpc が「応答の 1 行が保持役の上限を超えて捨てられた」ときに付ける code */
export const LINE_OVERFLOW = "LINE_OVERFLOW";
/** CodexRpc が時間切れに付ける code */
export const RPC_TIMEOUT = "RPC_TIMEOUT";

const TURNS_PAGE = 100;
const ITEMS_PAGE = 32;
/** 画像を含むページの次の大きさ（1 枚 1.6 MB ほど。上限の 16 MiB に十分な余裕を持たせる） */
const IMAGE_PAGE = 2;
const MAX_PAGES = 20_000;

const noSuchMethod = (err) =>
  err?.code === -32601 || (err?.code === -32600 && /unknown variant/i.test(String(err?.message ?? "")));

/** ページ読みを知らない版だと分かったら、以後は 1 回で読む */
let paging = true;

/** テスト用: 覚えたことを忘れる */
export function resetHistoryState() {
  paging = true;
}

/** 保存先のある画像から base64 を外す。保存先が無い（古い版・保存に失敗した）ときは画面に出す元なので残す */
export function stripImageData(item) {
  if (item?.type !== "imageGeneration" || !item.savedPath || item.result == null) return item;
  const { result: _drop, ...rest } = item;
  return rest;
}

/**
 * 時間切れと上限超えを、履歴の読み出しの言葉に直す。code はそのまま残す（呼び出し側が見分ける）
 */
export function historyError(err, method, timeoutMs) {
  if (err?.code === LINE_OVERFLOW) {
    return Object.assign(new Error(t("codex.errors.historyTooLarge", { method })), { code: LINE_OVERFLOW, cause: err });
  }
  if (err?.code === RPC_TIMEOUT) {
    return Object.assign(new Error(t("codex.errors.historyTimeout", { method, seconds: Math.round(timeoutMs / 1000) })), { code: RPC_TIMEOUT, cause: err });
  }
  return err;
}

/**
 * スレッドを thread/read { includeTurns: true } と同じ形（thread.turns[].items[]）で返す。無ければ null。
 * 画像の base64 は運ばない（上の説明）
 */
export async function readThread(rpc, threadId, { timeoutMs = HISTORY_TIMEOUT_MS } = {}) {
  const call = (method, params) => rpc.request(method, params, timeoutMs);
  const meta = await call("thread/read", { threadId }).catch((err) => { throw historyError(err, "thread/read", timeoutMs); });
  const thread = meta?.thread;
  if (!thread) return null;
  if (paging && thread.historyMode === "paginated") {
    try {
      return { ...thread, turns: await readPaged(call, threadId, timeoutMs) };
    } catch (err) {
      if (!noSuchMethod(err)) throw err;
      paging = false;
      console.error("  codex: thread/turns/list・thread/items/list を使えない版。履歴は thread/read で 1 回で読む");   // i18n-ignore: サーバーのログ
    }
  }
  const full = await call("thread/read", { threadId, includeTurns: true })
    .catch((err) => { throw historyError(err, "thread/read", timeoutMs); });
  if (!full?.thread) return null;
  return { ...full.thread, turns: (full.thread.turns ?? []).map((turn) => ({ ...turn, items: (turn.items ?? []).map(stripImageData) })) };
}

async function readPaged(call, threadId, timeoutMs) {
  const turns = [];
  const byId = new Map();
  let cursor = null;
  let pages = 0;
  do {
    if (++pages > MAX_PAGES) throw new Error(t("codex.errors.historyTooManyPages", { pages: MAX_PAGES, method: "thread/turns/list" }));
    const res = await call("thread/turns/list", { threadId, cursor, limit: TURNS_PAGE, sortDirection: "asc", itemsView: "notLoaded" })
      .catch((err) => { throw historyError(err, "thread/turns/list", timeoutMs); });
    for (const turn of res?.data ?? []) {
      if (!turn?.id || byId.has(turn.id)) continue;
      const entry = { ...turn, items: [] };
      delete entry.itemsView;
      byId.set(turn.id, entry);
      turns.push(entry);
    }
    cursor = res?.nextCursor ?? null;
  } while (cursor);

  let limit = ITEMS_PAGE;
  cursor = null;
  pages = 0;
  // 読み直し（continue）は同じ位置から。do-while の continue は条件を見るので、最初のページで抜けてしまう
  for (;;) {
    if (++pages > MAX_PAGES) throw new Error(t("codex.errors.historyTooManyPages", { pages: MAX_PAGES, method: "thread/items/list" }));
    let res;
    try {
      res = await call("thread/items/list", { threadId, cursor, limit, sortDirection: "asc" });
    } catch (err) {
      // 1 行が上限を超えた。同じ位置を小さく読み直す（1 件でも超えるなら読めない）
      if (err?.code === LINE_OVERFLOW && limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
        pages--;
        continue;
      }
      throw historyError(err, "thread/items/list", timeoutMs);
    }
    let images = false;
    for (const row of res?.data ?? []) {
      const item = row?.item;
      if (!item) continue;
      if (item.type === "imageGeneration") images = true;
      let turn = byId.get(row.turnId);
      if (!turn) {
        // ターンの一覧を読んだ後に始まったターン。並びの末尾に足す
        turn = { id: row.turnId ?? null, items: [], status: "inProgress", startedAt: row.startedAtMs != null ? Math.floor(row.startedAtMs / 1000) : null };
        if (row.turnId) byId.set(row.turnId, turn);
        turns.push(turn);
      }
      turn.items.push(stripImageData(item));
    }
    limit = images ? IMAGE_PAGE : Math.min(ITEMS_PAGE, limit * 2);
    cursor = res?.nextCursor ?? null;
    if (!cursor) return turns;
  }
}
