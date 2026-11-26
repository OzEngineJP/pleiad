// スレッドの bot の返事の「書きかけ」を、保存より先に、書いたそばから投稿の本文の下へ出す（ADR 0364）。
// 流れは、開いているスレッドの画面にだけ届く（core/server.mjs の「スレッド」の枠。web/channels/thread.mjs が watchSession で宣言する）。
//   - 受けた出来事（text.delta・text.end・tool.start）は、会話ごとに貯めるだけにする。描くのは 1 コマに 1 回（web/live-turn.mjs の appendText と同じ）
//   - 出すのは「確定前の分」: 書きかけの全体から、保存された投稿の本文を先頭から外した残り（web/channels/stream-model.mjs）。
//     channelPost で本文が伸びれば、その分は本文に吸収されて残りが縮む。保存は今までどおり 1 秒に 1 回・文の切れ目まで
//   - 届いた分は 120ms（--dur-fast・--ease-out）で浮かび上がる。動きを減らす設定では出すだけ（CSS の .chunk も止める）
//   - 出す先は、その会話の最後の投稿（作業中のもの）だけ
import { el } from '../dom.mjs';
import { newStream, applyStreamEvent, unsettledFor } from './stream-model.mjs';

/** 書きかけを貯める会話の数の上限（古い会話から捨てる。1 つのスレッドで同時に書く bot はごく少ない） */
const MAX_SESSIONS = 24;
/** ターンが終わってから、保存された最後の本文が届くのを待つ上限（ms）。それまでは書きかけを残して、本文が一瞬縮んで見えるのを避ける */
const SETTLE_MS = 4000;
const STREAM_EVENTS = new Set(['text.delta', 'text.end', 'tool.start']);

/**
 * @param {object} deps
 * @param {(sessionId: string) => ({ post: object, before: string[] } | null)} deps.chainFor その会話の最後の投稿（作業中のもの）と、その前に確定した同じ会話の投稿の本文（古い順）。無ければ null
 * @param {(postId: string) => void} deps.repaint 投稿を描き直す（描き直しの中で attach が呼ばれる）
 * @param {() => boolean} deps.nearBottom 末尾を見ているか
 * @param {() => void} deps.follow 末尾へ追う
 */
export function createThreadStream({ chainFor, repaint, nearBottom, follow }) {
  const states = new Map();   // sessionId -> 書きかけ
  const nodes = new Map();    // sessionId -> .post-tail（描き直しをまたいで同じ入れ物を使う。出した分の浮かび上がりをやり直さない）
  const shown = new Set();    // 確定前の分が出ている会話
  const settling = new Map(); // sessionId -> タイマー（turnEnd のあと、最後の本文を待っている）
  const dirty = new Set();
  let frame = 0;

  const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  function nodeOf(sessionId) {
    let node = nodes.get(sessionId);
    if (!node) {
      node = el('div', 'post-tail');
      node.hidden = true;
      node.setAttribute('aria-hidden', 'true');   // 読み上げは保存された本文だけ（流れの途中の文字では読み直さない）
      // 浮かび上がりが済んだ分は、ただの文字に戻す（要素が増え続けない）
      node.addEventListener('animationend', (event) => {
        const chunk = event.target;
        if (chunk === node || !chunk.classList?.contains('chunk')) return;
        chunk.replaceWith(chunk.textContent);
        node.normalize();
      });
      nodes.set(sessionId, node);
    }
    return node;
  }

  /** 確定前の分を入れ物へ。最初と続きは、足した分だけ浮かび上がらせる。続きでない（吸収で縮んだ・流し直し）なら描き直す（浮かび上がらせない） */
  function paintTail(node, text) {
    const prev = node.dataset.shown ?? '';
    if (text === prev) return;
    if (!prev || text.startsWith(prev)) {
      const added = text.slice(prev.length);
      node.append(reduced() ? added : el('span', 'chunk', added));
    } else node.textContent = text;
    node.dataset.shown = text;
    node.hidden = !text;
  }

  const textFor = (sessionId) => {
    const stream = states.get(sessionId);
    const info = stream ? chainFor(sessionId) : null;
    return info ? { info, text: unsettledFor(stream, info.before, info.post.text ?? '') ?? '' } : { info: null, text: '' };
  };

  /** 貯めた分を今描く（1 コマに 1 回）。末尾を見ていたときだけ末尾へ追う（読み返している人を引き戻さない） */
  function flush() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const ids = [...dirty];
    dirty.clear();
    if (!ids.length) return;
    const stick = nearBottom();
    let grew = false;
    for (const id of ids) {
      const { info, text } = textFor(id);
      const node = text ? nodeOf(id) : nodes.get(id);
      if (!node) { shown.delete(id); continue; }
      const before = (node.dataset.shown ?? '').length;
      if (text) shown.add(id); else shown.delete(id);
      // 入れ物が最後の投稿の中に無い（出始め・投稿が描き直された）: 描き直す（attach が置く。状態の行も「考えている」から「書いている」に替わる）
      if (text && node.closest('.post')?.dataset.postId !== info.post.id) repaint(info.post.id);
      else paintTail(node, text);
      if ((node.dataset.shown ?? '').length > before) grew = true;
    }
    if (stick && grew) follow();
  }
  const schedule = () => { frame ||= requestAnimationFrame(flush); };

  function drop(sessionId) {
    clearTimeout(settling.get(sessionId));
    settling.delete(sessionId);
    states.delete(sessionId);
    dirty.add(sessionId);
    schedule();
  }

  /** 流れの出来事を受ける（text.delta・text.end・tool.start・turnEnd）。replay（会話を読み直した流し直し）は呼ばない */
  function event(ev) {
    const sessionId = ev?.sessionId;
    if (!sessionId) return;
    if (ev.type === 'turnEnd') {
      // 最後の保存された本文（channelPost）が届くまで書きかけを残す。届かなくても上限で外す
      if (states.has(sessionId) && !settling.has(sessionId)) settling.set(sessionId, setTimeout(() => drop(sessionId), SETTLE_MS));
      return;
    }
    if (!STREAM_EVENTS.has(ev.type)) return;
    if (settling.has(sessionId)) drop(sessionId);   // 終わったはずの会話がまた書き始めた: 新しいターン
    let stream = states.get(sessionId);
    if (!stream) {
      if (states.size >= MAX_SESSIONS) drop(states.keys().next().value);
      stream = newStream();
      states.set(sessionId, stream);
    }
    if (applyStreamEvent(stream, ev)) { dirty.add(sessionId); schedule(); }
  }

  /** スレッドの枠を宣言した返事（threadStream）: いま書いている途中の分の流し直し。今ある書きかけは置き換える */
  function snapshot(list) {
    clear();
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry?.sessionId) continue;
      const stream = newStream();
      for (const ev of entry.events ?? []) applyStreamEvent(stream, ev);
      states.set(entry.sessionId, stream);
      dirty.add(entry.sessionId);
    }
    schedule();
  }

  /** 書きかけを全部捨てる（出ている分は消える）。入れ物は残す */
  function clear() {
    for (const timer of settling.values()) clearTimeout(timer);
    settling.clear();
    for (const id of states.keys()) dirty.add(id);
    states.clear();
    if (dirty.size) schedule();
  }

  return {
    event,
    snapshot,
    clear,
    /** スレッドを閉じた・別のスレッドへ移った: 入れ物ごと捨てる */
    forget() {
      clear();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      dirty.clear();
      nodes.clear();
      shown.clear();
    },
    /** 投稿が描き直されるときに呼ぶ（thread.mjs の decorate）。確定前の分があれば入れ物を本文の下に置き、置いたら入れ物を返す */
    attach(bodyEl, post) {
      const sessionId = post?.turn?.sessionId;
      if (!sessionId || !bodyEl || chainFor(sessionId)?.post.id !== post.id) return null;
      const { text } = textFor(sessionId);
      if (!text) { shown.delete(sessionId); return null; }
      const node = nodeOf(sessionId);
      paintTail(node, text);
      shown.add(sessionId);
      bodyEl.after(node);
      return node;
    },
    /** 状態の行を「書いている」にするか（保存された本文が無くても、書きかけが出ているとき） */
    streaming: (post) => Boolean(post?.turn?.sessionId) && shown.has(post.turn.sessionId),
    /** 投稿が作業中でなくなった: ターンが終わっていれば、書きかけを捨てる（最後の本文は投稿に入っている） */
    settled(sessionId) { if (settling.has(sessionId)) drop(sessionId); },
  };
}
