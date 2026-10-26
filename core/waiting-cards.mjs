// 承認・質問のカードの控え（ADR 0270 段 3 の ②「続きに要る状態は DB か保持役の記録にしか置かない」）。
//
// runtime.waiting は写しで、正本は DB の waiting_cards の行（core/db.mjs・core/store.mjs）。
// 起動で行を読み、付け直したターンが同じ id で出し直したカードは「拾った」と印を付ける。
// 拾わなかった行は、ターンの外の待ち（outlivesTurn）なら取り下げを会話へ届け、ターンの中のカードなら
// そのターンが再起動で止まったことを「止めたもの」（stops）に残す（黙って消さない）。
// 答えを待つ約束は行に持たない: 保持役の子の控え（jsonrpc・claude-control）から出し直す（段 2b の道）。
//
// 行の形: { id, sessionId, origin, toolName, askedAt, payload, target, detached, outlivesTurn }
//   origin   … カードを出した会話（中継の複製は置かない）。取り下げを届ける先
//   payload  … 画面へ出す中身（入力は core/server.mjs が切り詰める）
//   target   … stops の 1 行に出す対象（出したときに作る。payload を切り詰めても残る）
export function createWaitingCards({ load, put, remove, log = () => {} }) {
  let restored = null;
  let claimed = new Set();
  const report = (what, error) => log(`  [waiting-cards] ${what}: ${String(error?.message ?? error)}`);
  return {
    /** 起動で 1 回。読めなければ空から始める（カードが消えるだけで、起動は止めない） */
    load() {
      try { restored = new Map((load() ?? []).map(row => [row.id, row])); }
      catch (error) { report('could not read the rows', error); restored = new Map(); }
      claimed = new Set();
      return restored;
    },
    /** カードを出した（DB に置く）。起動で拾った同じ id なら、出し直した印を付ける（askedAt は元のまま） */
    put(card) {
      const old = restored?.get(card.id);
      try { put({ ...card, askedAt: old?.askedAt ?? card.askedAt }); }
      catch (error) { report(`could not keep the card (${card.id})`, error); }
      if (old) claimed.add(card.id);
    },
    /** 決着した（DB から消す） */
    remove(ids) {
      try { remove(ids); }
      catch (error) { report(`could not remove the cards (${(ids ?? []).join(', ')})`, error); }
      for (const id of ids ?? []) restored?.delete(id);
    },
    /** 起動で拾って、まだ出し直していない行。origin を渡すとその会話の分だけ */
    unclaimed(origin = undefined) {
      return restored ? [...restored.values()].filter(row => !claimed.has(row.id) && (origin === undefined || row.origin === origin)) : [];
    },
    /** 起動で拾った行の数（ログ用） */
    get restoredCount() { return restored?.size ?? 0; },
  };
}
