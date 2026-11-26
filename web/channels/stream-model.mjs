// スレッドの bot の返事の「書きかけ」の組み立て（ADR 0367）。純粋な部品（DOM に触れない。web/channels/thread-stream.mjs が使う）。
// core/bots/dispatch.mjs が投稿の本文を組む畳み方と同じにする:
//   - 文章の流れ（text.delta）は貯め、区切り（text.end・tool.start）で 1 つの段落に確定する
//   - 段落は黙る印（[[no-reply]]）を外し、空になったものは落とし、「空行 1 つ」でつなぐ
// 画面に出す「確定前の分」は、書きかけの全体から、いま保存されている投稿の本文（と、その前に確定した投稿の本文）を先頭から外した残り。
// 保存は 1 秒に 1 回・文の切れ目までなので、残りは「次の保存までに書かれた分」になる。

// core/bots/silence.mjs の MARK_RE と stripSilentMark と同じ（web は core を読み込まない。tests/unit/thread-stream-model.mjs が突き合わせる）
const MARK_RE = /\[\[\s*no[-_ ]?reply\s*\]\]/gi;
export const stripMark = (text) => String(text ?? '').replace(MARK_RE, '').replace(/[ \t]+\n/g, '\n').trim();
const MARK_COMPACT = '[[noreply]]';
// 書きかけの末尾が印の途中（「[[no-re」）のとき
const MARK_TAIL = /\[\[?[^[\]]*\]?$/;

/** 書きかけの末尾が黙る印の途中なら、その分を出さない（印が書き終わると stripMark が外す） */
export function holdMark(text) {
  const m = MARK_TAIL.exec(text);
  if (!m) return text;
  const compact = m[0].toLowerCase().replace(/[\s_-]/g, '');
  return compact.length < MARK_COMPACT.length && MARK_COMPACT.startsWith(compact) ? text.slice(0, m.index) : text;
}

/** 会話 1 つぶんの書きかけ。parts は確定した段落、cur は書いている途中、seq は最後に取り込んだ出来事の通し番号 */
export const newStream = () => ({ parts: [], cur: '', seq: 0 });

/** 出来事を取り込む。変わったら true（通し番号が済んだものなら無視。流し直しと生の流れが重なっても 2 度書かない） */
export function applyStreamEvent(stream, event) {
  if (Number.isFinite(event?.streamSeq)) {
    if (event.streamSeq <= stream.seq) return false;
    stream.seq = event.streamSeq;
  }
  switch (event?.type) {
    case 'text.delta':
      stream.cur += String(event.text ?? '');
      return true;
    case 'text.end':
    case 'tool.start':
      if (stream.cur.trim()) stream.parts.push(stream.cur.trim());
      stream.cur = '';
      return true;
    default:
      return false;
  }
}

/** 書きかけの全体（dispatch の finalizePost と同じ畳み方）。末尾の印の途中は出さない */
export function streamText(stream) {
  return [...stream.parts, holdMark(stream.cur)].map(stripMark).filter(Boolean).join('\n\n');
}

const isSpace = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ' || ch === '　';

/** full の at から text が続くか（空白の違いは見ない）。続くなら text の終わりの位置、違えば -1 */
function skipText(full, at, text) {
  if (full.startsWith(text, at)) return at + text.length;
  let i = at;
  for (let j = 0; j < text.length; j++) {
    const ch = text[j];
    if (isSpace(ch)) continue;
    while (i < full.length && isSpace(full[i])) i++;
    if (full[i] !== ch) return -1;
    i++;
  }
  return i;
}

// 投稿を作った直後の印（core/bots/dispatch.mjs の PLACEHOLDER）。本文が出るまでの代わりで、文ではない
const PLACEHOLDER = '…';
const hasWords = (text) => { const s = String(text ?? '').trim(); return s !== '' && s !== PLACEHOLDER; };

/**
 * 書きかけの全体 full から、確定した投稿の本文（saved。古い順）を先頭から順に外した残り（確定前の分）。
 * 本文が書きかけの先頭と合わなければ null（取りこぼし・別のターンの分。出さない）。
 */
export function unsettledText(full, saved) {
  let at = 0;
  for (const text of saved) {
    if (!hasWords(text)) continue;
    at = skipText(full, at, String(text).trim());
    if (at < 0) return null;
  }
  return full.slice(at).replace(/^\s+/, '');
}

/**
 * 最後の投稿（last）と、その前に確定した投稿の本文の並び（before。古い順・直前まで続く同じ会話の投稿）から、確定前の分を出す。
 * before の先頭が別のターンの投稿（書きかけと合わない）なら、その分を飛ばして合うところから数える。
 */
export function unsettledFor(stream, before, lastText) {
  const full = streamText(stream);
  for (let i = 0; i <= before.length; i++) {
    const rest = unsettledText(full, [...before.slice(i), lastText]);
    if (rest !== null) return rest;
  }
  return null;
}
