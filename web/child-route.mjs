// 会話を開くときの行き先。委譲の子（孫を含む）はメインの画面には出さず、依頼元の根の会話をメインに、その上のモーダルで子を出す（ADR 0318）。
// 子かどうかと根の引き方は、脇の一覧が「どの会話を行として出すか」と同じ決まり（web/client.mjs の renderSessions）:
//   delegation を持たない会話・端末の AI から任された子（delegation.remote）・依頼元の会話を消した子（ADR 0147。一覧に親が無い）は根として、メインで開く。
//   それ以外の子は、parentSessionId を辿って、最初に根になる会話までが 1 つの木。

/** 一覧に行として出る会話（根）か。ids は一覧にある会話の id の集合 */
export function isRootRow(row, ids) {
  const d = row?.delegation;
  return !d || Boolean(d.remote) || !ids.has(d.parentSessionId);
}

/**
 * 会話の id の行き先。
 * - 子でないとき（ふつうの会話・根として扱う子・一覧に無い id）は null（メインで開く）
 * - 子のとき { root: 根の会話の id, taskId: その子のタスクの id（無ければ null）, depth: 根からの深さ（子 = 1、孫 = 2） }
 * 画面に taskId が無い古い記録の子は taskId が null（根だけを開く）
 */
export function childRoute(id, sessions) {
  const byId = new Map((sessions ?? []).map((s) => [s.id, s]));
  const ids = new Set(byId.keys());
  const row = byId.get(id);
  if (!row || isRootRow(row, ids)) return null;
  const taskId = typeof row.delegation.taskId === 'string' && row.delegation.taskId ? row.delegation.taskId : null;
  let root = row, depth = 0;
  const seen = new Set();
  while (!isRootRow(root, ids) && !seen.has(root.id)) {
    seen.add(root.id);
    root = byId.get(root.delegation.parentSessionId);
    depth++;
  }
  // 親子が輪になっている（ありえないが壊れた記録）なら、子として扱わない
  if (!root || !isRootRow(root, ids)) return null;
  return { root: root.id, taskId, depth };
}

/** 保存していた「開いていた会話」の id を、起動・つなぎ直しで開く id にする（子なら根）。一覧がまだ無い・知らない id はそのまま */
export function restoredSession(id, sessions) {
  return childRoute(id, sessions)?.root ?? id;
}

/**
 * 会話を開く呼び出しの順番札（openConversation）。開く途中には待ちがあり（会話の読み込み・タスクの行・最初の描画）、
 * その間に後の呼び出しや、利用者が別の会話を選んだとき、前の呼び出しは何もせずに終わる（後から子のモーダルを上に重ねない）。
 * - begin() は新しい札を取る。それまでの札は古くなる
 * - interrupt() は利用者の選び直し（別の会話を開く操作）。持っている札をすべて古くする
 * - 札の stale() は、待った後に呼ぶ。true なら何もしない
 */
export function createOpenGate() {
  let gen = 0;
  return {
    begin() { const mine = ++gen; return { stale: () => mine !== gen }; },
    interrupt() { gen++; },
  };
}
