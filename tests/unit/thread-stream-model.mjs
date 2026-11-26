// スレッドの書きかけの組み立て（ADR 0364）。ブラウザもサーバーも要らない。
//   - core/bots/thread-stream.mjs: 走っているターンの写しから、流れの 3 種類だけを切り出す（道具の中身は運ばない・続く text.delta は 1 つに）
//   - web/channels/stream-model.mjs: 出来事の取り込み（通し番号で重なりを落とす）・書きかけの畳み方（dispatch の finalizePost と同じ）・
//     確定した投稿を先頭から外した「確定前の分」（途中送信で投稿が分かれた並びも含む。ADR 0117 の改め）
//   - web/channels/thread-stream.mjs: 1 コマに 1 回だけ描く・本文の下に出す・吸収で縮む・動きを減らす設定・最後の投稿にだけ出す
import { threadStreamSnapshot, THREAD_STREAM_EVENTS } from '../../core/bots/thread-stream.mjs';
import { stripSilentMark, speakingParts } from '../../core/bots/silence.mjs';
import { stripMark, holdMark, newStream, applyStreamEvent, streamText, unsettledText, unsettledFor } from '../../web/channels/stream-model.mjs';
import { createThreadStream } from '../../web/channels/thread-stream.mjs';
import { el } from '../../web/dom.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'thread-stream-model';
export const title = 'スレッドの書きかけ: 写しの切り出し・出来事の取り込み・確定前の分の切り出し（投稿が分かれても）・描画は 1 コマに 1 回';

const delta = (text, streamSeq, sessionId = 's1') => ({ type: 'text.delta', sessionId, text, streamSeq });
const end = (streamSeq, sessionId = 's1') => ({ type: 'text.end', sessionId, streamSeq });
const tool = (streamSeq, sessionId = 's1') => ({ type: 'tool.start', sessionId, id: 't1', name: 'Grep', input: { pattern: 'secret' }, streamSeq });
const fold = (events) => { const s = newStream(); for (const e of events) applyStreamEvent(s, e); return s; };

export default async function (t) {
  // ---- core: 写しの切り出し
  {
    const events = [
      { type: 'activity', state: 'writing', streamSeq: 1 },
      delta('あ', 2), delta('い', 3),
      tool(4),
      { type: 'tool.result', id: 't1', text: 'x', streamSeq: 5 },
      delta('う', 6), end(7),
    ];
    const snap = threadStreamSnapshot(events);
    t.ok('写しは流れの 3 種類だけ', snap.every((e) => THREAD_STREAM_EVENTS.has(e.type)) && snap.length === 4, JSON.stringify(snap.map((e) => e.type)));
    t.ok('続く text.delta は 1 つにまとまり、通し番号は最後のもの', snap[0].type === 'text.delta' && snap[0].text === 'あい' && snap[0].streamSeq === 3, JSON.stringify(snap[0]));
    t.ok('区切り（tool.start・text.end）の順序は変わらない', snap.map((e) => e.type).join() === 'text.delta,tool.start,text.delta,text.end', snap.map((e) => e.type).join());
    t.ok('道具の入力・名前は運ばない', !('input' in snap[1]) && !('name' in snap[1]) && !JSON.stringify(snap).includes('secret'), JSON.stringify(snap[1]));
    t.ok('写しを畳むと、元の出来事を畳んだのと同じ書きかけになる', streamText(fold(snap)) === streamText(fold(events)), `${streamText(fold(snap))} / ${streamText(fold(events))}`);
    t.ok('写しが無い・配列でないときは空', threadStreamSnapshot(undefined).length === 0 && threadStreamSnapshot(null).length === 0 && threadStreamSnapshot([]).length === 0);
    t.ok('元の出来事は書き換えない', events[1].text === 'あ' && events[2].text === 'い');
  }

  // ---- web: 出来事の取り込み
  {
    const s = newStream();
    t.ok('text.delta は書いている途中に足す', applyStreamEvent(s, delta('こん', 1)) && s.cur === 'こん');
    t.ok('通し番号が済んだ出来事は無視する（流し直しと生の流れが重なっても 2 度書かない）', !applyStreamEvent(s, delta('こん', 1)) && !applyStreamEvent(s, delta('古い', 0)) && s.cur === 'こん');
    t.ok('次の番号は取り込む', applyStreamEvent(s, delta('にちは', 2)) && s.cur === 'こんにちは' && s.seq === 2);
    t.ok('text.end は書いている途中を 1 つの段落に確定する', applyStreamEvent(s, end(3)) && s.parts.join('|') === 'こんにちは' && s.cur === '');
    t.ok('空の区切りは段落を足さない', applyStreamEvent(s, tool(4)) && s.parts.length === 1);
    t.ok('知らない種類は取り込まない', !applyStreamEvent(s, { type: 'activity', streamSeq: 5 }) && !applyStreamEvent(s, null));
    const noSeq = newStream();
    t.ok('通し番号の無い出来事は毎回取り込む', applyStreamEvent(noSeq, { type: 'text.delta', text: 'a' }) && applyStreamEvent(noSeq, { type: 'text.delta', text: 'a' }) && noSeq.cur === 'aa');
    // 流し直し（写し）のあとに、重なった生の流れが来ても 2 度書かない
    const joined = newStream();
    for (const e of threadStreamSnapshot([delta('あ', 1), delta('い', 2), end(3), delta('う', 4)])) applyStreamEvent(joined, e);
    for (const e of [delta('い', 2), end(3), delta('う', 4), delta('え', 5)]) applyStreamEvent(joined, e);
    t.ok('写しと生の流れが重なっても、重なった分は 1 度だけ', streamText(joined) === 'あい\n\nうえ', streamText(joined));
  }

  // ---- web: 書きかけの畳み方は dispatch の finalizePost と同じ（段落は「空行 1 つ」・黙る印と空の段落は落とす）
  {
    const marks = ['', 'こんにちは', '[[no-reply]]', 'a [[ no reply ]] b', '[[NO_REPLY]]\n', 'x  \n[[noreply]]\ny', ' [[No Reply]] ', '[[no-reply]] [[no-reply]]', '[[no- reply]]'];
    t.ok('黙る印の外し方は core/bots/silence.mjs と同じ（写しの突き合わせ）', marks.every((x) => stripMark(x) === stripSilentMark(x)), JSON.stringify(marks.filter((x) => stripMark(x) !== stripSilentMark(x))));
    const scenarios = [
      [delta('前置き。', 1), end(2), tool(3), delta('結論。', 4)],
      [delta('[[no-reply]]', 1), end(2), delta('話す。', 3)],
      [delta('一つ目。', 1), tool(2), tool(3), delta('二つ目。', 4), end(5), delta('', 6)],
      [delta('  ', 1), end(2), delta('本文', 3)],
    ];
    const ok = scenarios.every((events) => {
      const s = fold(events);
      return streamText(s) === speakingParts([...s.parts, s.cur]).join('\n\n');
    });
    t.ok('畳んだ全体は speakingParts でつないだ本文と同じ', ok, JSON.stringify(scenarios.map((e) => streamText(fold(e)))));
    t.ok('空の段落・印だけの段落は落ちる', streamText(fold(scenarios[1])) === '話す。' && streamText(fold(scenarios[3])) === '本文', JSON.stringify([streamText(fold(scenarios[1])), streamText(fold(scenarios[3]))]));
    t.ok('段落は空行 1 つでつなぐ', streamText(fold(scenarios[0])) === '前置き。\n\n結論。', streamText(fold(scenarios[0])));
    // 黙る印は書き終わるまで出さない（途中の「[[no-re」が一瞬見えない）
    t.ok('末尾が黙る印の途中なら出さない', holdMark('話す。 [[no-re') === '話す。 ' && holdMark('話す。[[') === '話す。' && holdMark('話す。[') === '話す。' && holdMark('話す。[[no-reply]') === '話す。', [holdMark('話す。 [[no-re'), holdMark('話す。[['), holdMark('話す。['), holdMark('話す。[[no-reply]')].join('|'));
    t.ok('印でない括弧は出す', holdMark('配列 [1]') === '配列 [1]' && holdMark('[[x') === '[[x' && holdMark('通常の文') === '通常の文');
    t.ok('印が書き終われば外れる', streamText(fold([delta('話す。[[no-reply]]', 1)])) === '話す。' && streamText(fold([delta('話す。[[no-re', 1)])) === '話す。');
  }

  // ---- web: 確定前の分（書きかけの全体から、保存された投稿の本文を先頭から外した残り）
  {
    t.ok('保存が無ければ書きかけの全体', unsettledText('あいう', []) === 'あいう');
    t.ok('保存された本文を先頭から外した残り', unsettledText('あい。\n\nう', ['あい。']) === 'う', JSON.stringify(unsettledText('あい。\n\nう', ['あい。'])));
    t.ok('保存が全部に追いつけば空', unsettledText('あい。', ['あい。']) === '');
    t.ok('空白の違い（改行・全角・末尾）は見ない', unsettledText('あい。\n\n う', ['あい。 ', '']) === 'う' && unsettledText('あ\n\nい', ['あ い']) === '', JSON.stringify([unsettledText('あい。\n\n う', ['あい。 ', '']), unsettledText('あ\n\nい', ['あ い'])]));
    t.ok('本文が出るまでの代わり（…）と空は数えない', unsettledText('あい', ['…']) === 'あい' && unsettledText('あい', ['', '  ']) === 'あい');
    t.ok('保存された本文が書きかけの先頭と合わなければ null（出さない）', unsettledText('あい', ['ぜんぜん別の本文']) === null);
    t.ok('保存のほうが長い（取りこぼし）なら null', unsettledText('あ', ['あい']) === null);

    // 1 つのターンで 1 投稿: 保存は 1 秒に 1 回・文の切れ目まで → 残りは次の保存までに書かれた分
    const stream = fold([delta('一文目。', 1), delta('二文目の途中', 2)]);
    t.ok('最後の投稿の本文に追いついていない分が出る', unsettledFor(stream, [], '一文目。') === '二文目の途中', String(unsettledFor(stream, [], '一文目。')));
    t.ok('本文が伸びれば、その分は吸収されて残りが縮む', unsettledFor(stream, [], '一文目。二文目の途') === '中' && unsettledFor(stream, [], '一文目。二文目の途中') === '', JSON.stringify([unsettledFor(stream, [], '一文目。二文目の途'), unsettledFor(stream, [], '一文目。二文目の途中')]));
    t.ok('投稿に本文がまだ無い（…）なら全部が残り', unsettledFor(stream, [], '…') === '一文目。二文目の途中');

    // 節 12: 途中送信で投稿が分かれる。前の投稿は確定した本文、続きは新しい投稿（ADR 0117 の改め）
    const split = fold([delta('前半の文。', 1), end(2), delta('後半を書いている', 3)]);
    t.ok('分かれた最後の投稿には、前の投稿の本文を外した続きが出る', unsettledFor(split, ['前半の文。'], '…') === '後半を書いている', String(unsettledFor(split, ['前半の文。'], '…')));
    t.ok('分かれた最後の投稿の本文が伸びれば、その分だけ縮む', unsettledFor(split, ['前半の文。'], '後半を') === '書いている', String(unsettledFor(split, ['前半の文。'], '後半を')));
    t.ok('前の投稿の本文を渡さなければ、前半も残りに入る（thread.mjs の streamChain が前の投稿を渡す理由）', unsettledFor(split, [], '…') === '前半の文。\n\n後半を書いている', String(unsettledFor(split, [], '…')));
    const twice = fold([delta('一。', 1), end(2), delta('二。', 3), end(4), delta('三の途中', 5)]);
    t.ok('2 回分かれても、前の 2 つの本文を順に外す', unsettledFor(twice, ['一。', '二。'], '…') === '三の途中', String(unsettledFor(twice, ['一。', '二。'], '…')));
    t.ok('前の別のターンの投稿が混ざっていたら、合うところから数える', unsettledFor(split, ['別のターンの投稿', '前半の文。'], '…') === '後半を書いている', String(unsettledFor(split, ['別のターンの投稿', '前半の文。'], '…')));
    t.ok('どれも合わなければ null（出さない）', unsettledFor(split, [], '全く違う本文') === null);
  }

  // ---- web: 描画（1 コマに 1 回・本文の下・吸収・動きを減らす設定・最後の投稿にだけ）
  {
    const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, mm: globalThis.matchMedia };
    const protos = { closest: N.prototype.closest, replaceWith: N.prototype.replaceWith, normalize: N.prototype.normalize, after: N.prototype.after };
    // 本物の after と同じく、すでに親に居る node は動かす（この最小の DOM は複製してしまう）
    const plainAfter = N.prototype.after;
    N.prototype.after = function (...n) { for (const c of n) if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c); plainAfter.apply(this, n); };
    let nextId = 1;
    const pending = new Map();
    globalThis.requestAnimationFrame = (cb) => { const id = nextId++; pending.set(id, cb); return id; };
    globalThis.cancelAnimationFrame = (id) => { pending.delete(id); };
    let reduced = false;
    globalThis.matchMedia = () => ({ matches: reduced });
    N.prototype.closest = function (sel) { for (let x = this; x; x = x.parent) if (x.matches?.(sel)) return x; return null; };
    N.prototype.replaceWith = function (x) {
      const p = this.parent;
      const c = typeof x === 'string' ? { textContent: x, children: [], parent: p, dataset: {}, matches: () => false } : x;
      c.parent = p;
      p.children.splice(p.children.indexOf(this), 1, c);
    };
    N.prototype.normalize = function () {};
    const step = () => { const list = [...pending.values()]; pending.clear(); for (const cb of list) cb(); };

    const posts = new Map();   // id -> { post, post el, body }
    const addPost = (id, sessionId, text = '…', state = 'working') => {
      const post = { id, text, state, turn: { botId: 'b1', sessionId } };
      const postEl = el('div', 'post');
      postEl.dataset.postId = id;
      const body = el('div', 'post-body');
      postEl.append(body);
      posts.set(id, { post, postEl, body });
      return post;
    };
    let chain = () => null;
    const repaints = [];
    let nearBottom = true;
    let follows = 0;
    let ctrl = null;
    try {
      ctrl = createThreadStream({
        chainFor: (sid) => chain(sid),
        repaint: (id) => { repaints.push(id); const x = posts.get(id); ctrl.attach(x.body, x.post); },
        nearBottom: () => nearBottom,
        follow: () => { follows++; },
      });
      const p1 = addPost('p1', 's1');
      chain = (sid) => (sid === 's1' ? { post: p1, before: [] } : null);
      const tailOf = (id) => posts.get(id).postEl.querySelector('.post-tail');

      ctrl.event(delta('はじめ', 1));
      for (let i = 2; i <= 30; i++) ctrl.event(delta('に', i));
      t.ok('出来事は貯めるだけ（描かない）。積む rAF は 1 つ', repaints.length === 0 && pending.size === 1 && !tailOf('p1'), `${repaints.length} 回 / rAF ${pending.size}`);
      step();
      const tail = tailOf('p1');
      t.ok('1 コマで描き直し、書きかけは本文の下に出る', repaints.length === 1 && Boolean(tail) && tail.parent === posts.get('p1').postEl && posts.get('p1').postEl.children.indexOf(tail) === posts.get('p1').postEl.children.indexOf(posts.get('p1').body) + 1, `repaint ${repaints.length}`);
      t.ok('出ている文字は貯めた全部', tail.textContent === `はじめ${'に'.repeat(29)}` && !tail.hidden, tail.textContent);
      t.ok('読み上げには出さない（保存された本文だけ）', tail.getAttribute('aria-hidden') === 'true');
      t.ok('書きかけが出ていれば、状態の行は「書いている」にできる', ctrl.streaming(p1) === true && ctrl.streaming(addPost('other', 's9')) === false);
      t.ok('末尾を見ていれば末尾へ追う', follows === 1, String(follows));

      // 続き: 同じ入れ物に足した分が、浮かび上がる要素（.chunk）になる。末尾を見ていなければ追わない
      nearBottom = false;
      ctrl.event(delta('つづき', 31));
      ctrl.event(delta('だよ', 32));
      step();
      t.ok('続きは同じ入れ物へ足し、足した分が .chunk になる', tailOf('p1') === tail && repaints.length === 1 && tail.children.at(-1).className === 'chunk' && tail.children.at(-1).textContent === 'つづきだよ', `${tail.children.at(-1)?.className} / ${tail.children.at(-1)?.textContent}`);
      t.ok('読み返している人（末尾を見ていない）は引き戻さない', follows === 1, String(follows));
      nearBottom = true;

      // 浮かび上がりが済んだ分は、ただの文字に戻る
      const chunk = tail.children.at(-1);
      tail.dispatchEvent({ type: 'animationend', target: chunk });
      t.ok('浮かび上がりが済んだ .chunk はただの文字になる（要素が増え続けない）', !tail.children.includes(chunk) && tail.textContent.endsWith('つづきだよ'), tail.textContent.slice(-8));

      // 動きを減らす設定: 出すだけ
      reduced = true;
      ctrl.event(delta('静か', 33));
      step();
      t.ok('動きを減らす設定では .chunk を作らず、文字だけ足す', tail.textContent.endsWith('静か') && !tail.children.some((c) => c.className === 'chunk' && c.textContent === '静か'));
      reduced = false;

      // 吸収: 保存された本文が伸びたら、その分は書きかけから消える（描き直しの中の attach）
      p1.text = `はじめ${'に'.repeat(29)}つづき`;
      ctrl.attach(posts.get('p1').body, p1);
      t.ok('保存された本文に入った分は、書きかけから消える（吸収）', tailOf('p1').textContent === 'だよ静か', tailOf('p1').textContent);
      t.ok('保存が追いつけば入れ物は隠れ、状態の行は「書いている」でなくなる', (() => { p1.text = `はじめ${'に'.repeat(29)}つづきだよ静か`; return ctrl.attach(posts.get('p1').body, p1) === null && ctrl.streaming(p1) === false; })());

      // 流し直し（写し）と生の流れの重なり
      ctrl.snapshot([{ sessionId: 's1', events: [delta('写し', 100), delta('の分', 101)] }]);
      p1.text = '…';
      ctrl.event(delta('の分', 101));   // 重なり
      ctrl.event(delta('！', 102));
      step();
      t.ok('写しと重なった生の流れは 1 度だけ', tailOf('p1')?.textContent === '写しの分！', String(tailOf('p1')?.textContent));

      // 完了: 最後の保存が届くまで残し、投稿が作業中でなくなったら捨てる
      ctrl.event({ type: 'turnEnd', sessionId: 's1' });
      step();
      t.ok('turnEnd のあとも、最後の保存が届くまで書きかけは残る（本文が一瞬縮んで見えない）', ctrl.streaming(p1) === true);
      ctrl.settled('s1');
      step();
      t.ok('投稿が確定したら書きかけは捨てられる', ctrl.streaming(p1) === false && tailOf('p1')?.hidden === true, String(tailOf('p1')?.hidden));

      // 作業中でない投稿・別の会話には出さない
      ctrl.event(delta('また', 200, 's2'));
      step();
      t.ok('投稿が無い会話の流れは、描かずに貯めるだけ', !tailOf('p1')?.textContent.includes('また'));

      // 節 12: 途中送信で投稿が分かれたら、流しはいつも最後の投稿へ
      const first = addPost('q1', 's3', '前半の文。', 'done');
      const next = addPost('q2', 's3', '…');
      chain = (sid) => (sid === 's3' ? { post: next, before: ['前半の文。'] } : null);
      ctrl.event(delta('前半の文。', 1, 's3'));
      ctrl.event(end(2, 's3'));
      ctrl.event(delta('後半を書いている', 3, 's3'));
      step();
      t.ok('分かれた 2 つの投稿のうち、流しは最後の投稿にだけ出る', tailOf('q2')?.textContent === '後半を書いている' && !tailOf('q1'), JSON.stringify([tailOf('q2')?.textContent, tailOf('q1')?.textContent]));
      t.ok('確定した前の投稿には、描き直しでも出さない', ctrl.attach(posts.get('q1').body, first) === null);
      t.ok('最後の投稿の状態の行は、本文が無くても「書いている」', ctrl.streaming(next) === true);

      // 閉じる・別のスレッドへ移る
      ctrl.forget();
      t.ok('スレッドを閉じたら書きかけと入れ物を捨て、積んだ rAF も残さない', ctrl.streaming(next) === false && pending.size === 0);
    } finally {
      ctrl?.forget();
      globalThis.requestAnimationFrame = saved.raf;
      globalThis.cancelAnimationFrame = saved.caf;
      if (saved.mm === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = saved.mm;
      for (const [k, v] of Object.entries(protos)) { if (v === undefined) delete N.prototype[k]; else N.prototype[k] = v; }
      if (saved.raf === undefined) delete globalThis.requestAnimationFrame;
      if (saved.caf === undefined) delete globalThis.cancelAnimationFrame;
    }
  }
}
