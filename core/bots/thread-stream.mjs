// スレッドの bot の返事の「書きかけ」を、開いているスレッドの画面にだけ流す（ADR 0367。ADR 0109・0024 の改め）。
// 保存（ターンの投稿の本文）は今のまま 1 秒に 1 回・文の切れ目まで。ここは配信の側だけで、保存には触れない。
//   - 流す出来事は、文章の流れ（text.delta）と、その区切り（text.end・tool.start）だけ。画面は dispatch と同じ畳み方（区切りまでを 1 段落）で書きかけを組み立てる。
//   - 届け先は、server.mjs の接続ごとの「スレッド」の枠（{ channelId, threadId }）に当たる接続だけ。ほかの接続（中継のスマホを含む）への配信は増えない。
//   - 秘密情報の伏せ（ADR 0217）は emitGlobal の中で済んでいる。ここで扱う出来事は、伏せたあとの走っているターンの写し（stream.events）から取る。
/** スレッドの枠へ流す出来事（streamEvents の一部） */
export const THREAD_STREAM_EVENTS = new Set(['text.delta', 'text.end', 'tool.start']);

/**
 * スレッドを開いた接続へ流し直す分: 走っているターンの写し（伏せたあとの出来事）から、文章の流れと区切りだけを取り、続く text.delta は 1 つにまとめる。
 * 順序と区切りは変えない（画面が dispatch と同じ畳み方で組み立てるため）。
 */
export function threadStreamSnapshot(events) {
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!THREAD_STREAM_EVENTS.has(event?.type)) continue;
    const last = out.at(-1);
    if (event.type === 'text.delta' && last?.type === 'text.delta') {
      last.text += String(event.text ?? '');
      last.streamSeq = event.streamSeq;
      continue;
    }
    // 画面が使うのは種類・会話・文字・通し番号だけ（道具の中身などは運ばない）
    out.push({ type: event.type, sessionId: event.sessionId, ...(event.type === 'text.delta' ? { text: String(event.text ?? '') } : {}), streamSeq: event.streamSeq });
  }
  return out;
}
