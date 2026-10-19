import { createAcpSteer } from '../../core/backends/acp-steer.mjs';
import { createDevinMapper } from '../../core/backends/devin-normalize.mjs';
import { createGrokMapper } from '../../core/backends/grok-normalize.mjs';

export const name = 'acp-steer';
export const title = 'acp-steer: 受理後の決着の合図（delivered / 既読不明 dropped unknown）・早期拒否・drain・受理前の合図なし。normalize の分割 user チャンク連結と queued の user 行の置き場';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function (t) {
  const mk = () => {
    const sent = [], events = [];
    let resolveNext, rejectNext;
    const client = { call: (method, params) => {
      sent.push(params);
      return new Promise((res, rej) => { resolveNext = res; rejectNext = rej; });
    } };
    let open = true;
    const steer = createAcpSteer({ client, sessionId: 's1', emit: e => events.push(e), ready: () => open });
    return { sent, events, client, steer, resolve: v => resolveNext(v), reject: e => rejectNext(e), close: () => { open = false; } };
  };

  // 受理 → 成功の決着で delivered。emit は受理の返事（true）のあとに来る（登録前に合図が飛んでロストしない）
  {
    const { steer, events, resolve } = mk();
    const ok = await steer.steer({ id: 'm1', args: { prompt: 'hi' } });
    t.ok('受理は true を返す', ok === true);
    resolve({ stopReason: 'end_turn' });
    await sleep(0);
    t.ok('cancelled 以外の決着で delivered が届く', events.length === 1 && events[0].type === 'userMessage.delivered' && events[0].messageId === 'm1', JSON.stringify(events));
  }

  // 決着も拒否も無いうちは、判定の窓（300ms）が過ぎるまで返らず、合図も出さない
  {
    const { steer, events } = mk();
    const p = steer.steer({ id: 'm2', args: { prompt: 'hi' } });
    t.ok('受理されるまで返らない（早期に emit しない）', await Promise.race([p.then(() => 'done'), sleep(10).then(() => 'wait')]) === 'wait' && events.length === 0);
    await p;
  }
  // 窓の中で呼び出しが成功で決着した（回が速く終わった）: 受理として直ぐ返り、delivered を出す
  {
    const { steer, events, resolve } = mk();
    const started = Date.now();
    const p = steer.steer({ id: 'm2b', args: { prompt: 'hi' } });
    resolve({ stopReason: 'end_turn' });
    const ok = await p;
    await sleep(0);
    t.ok('窓の中の成功は受理（窓を待たずに返る）', ok === true && Date.now() - started < 250, `${ok} ${Date.now() - started}ms`);
    t.ok('窓の中の成功でも delivered が 1 度だけ届く', events.length === 1 && events[0].type === 'userMessage.delivered' && events[0].messageId === 'm2b', JSON.stringify(events));
  }
  // 記録の口（onSent）は書いた直後に呼ぶ。取り消しは確実に届かなかった早期のプロトコル拒否でだけ
  {
    const run = async settle => {
      let resolveNext, rejectNext; const log = [];
      const client = { call: () => new Promise((res, rej) => { resolveNext = res; rejectNext = rej; }) };
      const steer = createAcpSteer({ client, sessionId: 's1', emit: () => {}, ready: () => true,
        onSent: text => { log.push(`sent:${text}`); return () => log.push('withdraw'); } });
      const p = steer.steer({ id: 'w', args: { prompt: 'x' } });
      const atWrite = [...log];
      await settle({ resolve: v => resolveNext(v), reject: e => rejectNext(e), p });
      return { atWrite, log };
    };
    const reject = await run(async ({ reject, p }) => { reject(Object.assign(new Error('bad'), { code: -32602 })); await p; });
    t.ok('onSent は受理の判定を待たずに書いた直後に呼ぶ', reject.atWrite.join() === 'sent:x', JSON.stringify(reject.atWrite));
    t.ok('早期のプロトコル拒否は取り消す', reject.log.join() === 'sent:x,withdraw', JSON.stringify(reject.log));
    const unknown = await run(async ({ reject, p }) => { reject(Object.assign(new Error('boom'), { code: -32000 })); await p.catch(() => {}); });
    t.ok('結果不明の早期拒否は取り消さない（送り直されないので記録に残す）', unknown.log.join() === 'sent:x', JSON.stringify(unknown.log));
    const cancelled = await run(async ({ resolve, p }) => { await p; resolve({ stopReason: 'cancelled' }); await sleep(0); });
    t.ok('受理後の cancelled は取り消さない', cancelled.log.join() === 'sent:x', JSON.stringify(cancelled.log));
  }

  // 早期のプロトコル拒否: false を返し、合図は出さない（呼ぶ側の requeue と二重にならない）
  {
    const { steer, events, reject } = mk();
    const p = steer.steer({ id: 'm3', args: { prompt: 'hi' } });
    reject(Object.assign(new Error('not found'), { code: -32602 }));
    t.ok('早期の拒否は受理しない', (await p) === false && events.length === 0);
  }

  // 早期の拒否でもプロトコル以外のコードは結果不明として投げる（合図なし）
  {
    const { steer, events, reject } = mk();
    const p = steer.steer({ id: 'm4', args: { prompt: 'hi' } });
    reject(Object.assign(new Error('boom'), { code: -32000 }));
    await p.then(() => { throw new Error('not thrown'); }, () => {});
    t.ok('結果不明の拒否は合図を出さない', events.length === 0);
  }

  // 受理後の cancelled: 読まれたか分からないので unknown 付き dropped（自動再送しない側）
  {
    const { steer, events, resolve } = mk();
    await steer.steer({ id: 'm5', args: { prompt: 'hi' } });
    resolve({ stopReason: 'cancelled' });
    await sleep(0);
    t.ok('受理後の cancelled は既読不明の dropped', events.length === 1 && events[0].type === 'userMessage.dropped' && events[0].unknown === true, JSON.stringify(events));
  }

  // 受理後の接続断（reject）: 同じく既読不明
  {
    const { steer, events, reject } = mk();
    await steer.steer({ id: 'm6', args: { prompt: 'hi' } });
    reject(new Error('connection lost'));
    await sleep(0);
    t.ok('受理後の接続断も既読不明の dropped', events[0]?.type === 'userMessage.dropped' && events[0].unknown === true, JSON.stringify(events));
  }

  // ready() false（閉じかけ・drain 中）は受理しない
  {
    const { steer, sent, close } = mk();
    close();
    t.ok('ready() が false なら呼ばずに断る', (await steer.steer({ id: 'm7', args: { prompt: 'x' } })) === false && sent.length === 0);
  }

  // drain は受理済みの決着まで待ち、alive() false で諦める
  {
    const { steer, resolve } = mk();
    await steer.steer({ id: 'm8', args: { prompt: 'x' } });
    let done = false;
    const d = steer.drain().then(() => { done = true; });
    await sleep(20);
    t.ok('決着まで drain は待つ', done === false && steer.size === 1);
    resolve({ stopReason: 'end_turn' });
    await d;
    t.ok('決着で drain が抜ける', done === true && steer.size === 0);
  }
  {
    const { steer } = mk();
    await steer.steer({ id: 'm9', args: { prompt: 'x' } });
    await steer.drain({ alive: () => false });
    t.ok('alive() false なら決着を待たずに抜ける', true);
  }

  // normalize: 分割された user_message_chunk は 1 つの発言に連結する（replay・echo）
  {
    const mapper = createDevinMapper('s', () => {});
    mapper.accept({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hel' } });
    mapper.accept({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'lo' } });
    const msgs = mapper.messages();
    t.ok('分割の user チャンクは 1 行に連結する', msgs.length === 1 && msgs[0].role === 'user' && msgs[0].text === 'hello', JSON.stringify(msgs));
  }
  // Grok: echo の無い途中送信は、受理した時点ではなく回の区切りで user 行にする。
  // (a) 元の user の echo が終わる前に受理しても行を壊さない、(b) 応答の途中に受理しても
  // 流れている assistant 行を分断しない。live と session/load の再生で uuid・順序・本文が揃う
  {
    const u = text => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
    const a = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const th = text => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
    const tc = { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' };
    const liveMapper = createGrokMapper('s', () => {});
    liveMapper.beginTurn('q1');
    liveMapper.accept(u('q'));            // (a) echo の途中で受理
    liveMapper.queueUser('s1');
    liveMapper.accept(u('1'));            // echo が揃う → 元の user 行はそのまま
    liveMapper.accept(a('main '));
    liveMapper.queueUser('s2');           // (b) 応答の途中で受理
    liveMapper.accept(a('reply'));
    liveMapper.accept(tc);
    liveMapper.accept(th('think1'));      // s1 の回の出力 → 直前に user 行 s1 が立つ
    liveMapper.accept(a('r1'));
    liveMapper.accept(tc);
    liveMapper.accept(a('r2'));           // s2 の回の出力 → 直前に user 行 s2 が立つ
    liveMapper.accept(tc);
    liveMapper.finish();
    // native の再生（session/load は保存済みの messages を交互に流す）と同じ並びになること
    const replayMapper = createGrokMapper('s', () => {});
    for (const upd of [u('q1'), th('think0'), a('main reply'), u('s1'), th('think1'), a('r1'), u('s2'), a('r2')]) replayMapper.accept(upd);
    const sig = ms => ms.map(m => `${m.uuid}|${m.role}|${m.text}`).join(';');
    const live = liveMapper.messages(), replay = replayMapper.messages();
    t.ok('live の行構造が正しい（依頼2件・返答2件が native の順）',
      sig(live) === 's:user:0|user|q1;s:assistant:1|assistant|main reply;s:user:2|user|s1;s:assistant:3|assistant|r1;s:user:4|user|s2;s:assistant:5|assistant|r2', JSON.stringify(live));
    t.ok('live と再生で uuid・順序・本文が揃う', sig(live) === sig(replay), JSON.stringify({ live: sig(live), replay: sig(replay) }));
  }
  // 送ったのに回られず残った分は finish() で末尾に置く（無くさない）
  {
    const mapper = createGrokMapper('s', () => {});
    mapper.beginTurn('q');
    mapper.queueUser('never-ran');
    mapper.accept({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ans' } });
    mapper.finish();
    const msgs = mapper.messages();
    t.ok('回られなかった途中送信も履歴に残る', msgs.length === 3 && msgs[2].role === 'user' && msgs[2].text === 'never-ran', JSON.stringify(msgs));
  }
  // Grok（acp-steer と mapper をつないだ形）: 受理の判定の窓（300ms）の中で今の回が終わり、
  // 途中送信の回の出力まで届いても、user 行はその出力の直前に置く（窓の後に積むと、出力が元の
  // assistant 行に混ざり、user 行が後ろへずれる）。live と再生で uuid・順序・本文が揃う
  {
    const u = text => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
    const a = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const tc = { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' };
    const sig = ms => ms.map(m => `${m.uuid}|${m.role}|${m.text}`).join(';');
    const wire = () => {
      const mapper = createGrokMapper('s', () => {});
      let resolveCall, rejectCall;
      const client = { call: () => new Promise((res, rej) => { resolveCall = res; rejectCall = rej; }) };
      const steer = createAcpSteer({ client, sessionId: 's', emit: () => {}, ready: () => true, onSent: text => mapper.queueUser(text) });
      return { mapper, steer, resolve: v => resolveCall(v), reject: e => rejectCall(e) };
    };
    const replayMapper = createGrokMapper('s', () => {});
    for (const upd of [u('q1'), a('main'), u('s1'), a('r1')]) replayMapper.accept(upd);
    const replay = sig(replayMapper.messages());

    // 窓の中で s1 の回まで終わり、呼び出しも成功で決着する（速い成功）
    {
      const { mapper, steer, resolve } = wire();
      mapper.beginTurn('q1'); mapper.accept(u('q1')); mapper.accept(a('main'));
      const p = steer.steer({ id: 'f', args: { prompt: 's1' } });
      mapper.accept(tc); mapper.accept(a('r')); mapper.accept(a('1')); mapper.accept(tc);
      resolve({ stopReason: 'end_turn' });
      const ok = await p;
      mapper.finish();
      t.ok('速い成功: user 行が s1 の回の出力の直前に立ち、再生と揃う', ok === true && sig(mapper.messages()) === replay, JSON.stringify({ live: sig(mapper.messages()), replay }));
    }
    // 窓の中で今の回が終わって s1 の回の出力が始まり、受理の判定はその後（窓が過ぎてから）
    {
      const { mapper, steer, resolve } = wire();
      mapper.beginTurn('q1'); mapper.accept(u('q1')); mapper.accept(a('main'));
      const p = steer.steer({ id: 'g', args: { prompt: 's1' } });
      mapper.accept(tc); mapper.accept(a('r'));
      const ok = await p;
      mapper.accept(a('1')); mapper.accept(tc);
      resolve({ stopReason: 'end_turn' });
      await sleep(0);
      mapper.finish();
      t.ok('判定待ちの間に始まった出力でも user 行は出力の直前で、分断しない', ok === true && sig(mapper.messages()) === replay, JSON.stringify({ live: sig(mapper.messages()), replay }));
    }
    // 早期のプロトコル拒否（次のターンで送り直す）は記録に残さない（同じ発言が 2 行にならない）
    {
      const { mapper, steer, reject } = wire();
      mapper.beginTurn('q1'); mapper.accept(u('q1'));
      const p = steer.steer({ id: 'r', args: { prompt: 's1' } });
      reject(Object.assign(new Error('bad'), { code: -32602 }));
      const ok = await p;
      mapper.accept(a('main')); mapper.accept(tc);
      mapper.finish();
      t.ok('早期の拒否は user 行を残さない', ok === false && sig(mapper.messages()) === 's:user:0|user|q1;s:assistant:1|assistant|main', sig(mapper.messages()));
    }
    // 履歴の再生で立った区切りで、このターンの最初の出力の前に途中送信を置かない
    {
      const mapper = createGrokMapper('s', () => {});
      for (const upd of [u('q0'), a('r0'), tc]) mapper.accept(upd);
      mapper.beginTurn('q1'); mapper.accept(u('q1'));
      mapper.queueUser('s1');
      mapper.accept(a('main')); mapper.accept(tc); mapper.accept(a('r1'));
      mapper.finish();
      t.ok('再生の区切りは持ち越さない', sig(mapper.messages()) === 's:user:0|user|q0;s:assistant:1|assistant|r0;s:user:2|user|q1;s:assistant:3|assistant|main;s:user:4|user|s1;s:assistant:5|assistant|r1', sig(mapper.messages()));
    }
  }

  // interject（Grok のターン内差し込み）: 受理の返事で即座に delivered + nativeId。session/prompt には下らない
  {
    const sent = [], events = [], interjected = [];
    const client = { call: (m, p) => { sent.push(p); return new Promise(() => {}); } };
    const steer = createAcpSteer({ client, sessionId: 's', emit: e => events.push(e), ready: () => true,
      interject: async (text, item) => { interjected.push([text, item.id]); return { nativeId: `ij-${item.id}` }; } });
    const ok = await steer.steer({ id: 'i1', args: { prompt: 'mid' } });
    t.ok('interject の受理は true', ok === true);
    t.ok('受理で delivered + nativeId が即座に届く（回の決着を待たない）',
      events.length === 1 && events[0].type === 'userMessage.delivered' && events[0].messageId === 'i1' && events[0].nativeId === 'ij-i1', JSON.stringify(events));
    t.ok('session/prompt には下らない', sent.length === 0 && interjected.length === 1 && interjected[0][0] === 'mid');
    t.ok('drain に残らない', steer.size === 0);
  }
  // interject が未実装（'unsupported'）なら session/prompt へ下り、以後は試さない
  {
    const sent = [], events = [], resolvers = []; let interjectCalls = 0;
    const client = { call: (m, p) => { sent.push([m, p]); return new Promise(res => resolvers.push(res)); } };
    const steer = createAcpSteer({ client, sessionId: 's', emit: e => events.push(e), ready: () => true,
      interject: async () => { interjectCalls++; return 'unsupported'; } });
    const p = steer.steer({ id: 'u1', args: { prompt: 'mid' } });
    await sleep(0);
    resolvers.shift()({ stopReason: 'end_turn' });
    const ok1 = await p;
    const p2 = steer.steer({ id: 'u2', args: { prompt: 'next' } });
    await sleep(0);
    resolvers.shift()?.({ stopReason: 'end_turn' });
    t.ok('unsupported のあとは session/prompt に下る', ok1 === true && await p2 === true
      && sent.length === 2 && sent.every(([m]) => m === 'session/prompt') && interjectCalls === 1, JSON.stringify({ sent, interjectCalls }));
    await sleep(0);
  }
  // session/prompt の決着で result._meta.promptId を nativeId として delivered に載せる
  {
    const events = []; let resolveNext;
    const client = { call: () => new Promise(res => { resolveNext = res; }) };
    const steer = createAcpSteer({ client, sessionId: 's', emit: e => events.push(e), ready: () => true });
    const p = steer.steer({ id: 'n1', args: { prompt: 'hi' } });
    resolveNext({ stopReason: 'end_turn', _meta: { promptId: 'pid-1' } });
    await p; await sleep(0);
    t.ok('delivered に _meta.promptId が載る', events[0]?.type === 'userMessage.delivered' && events[0]?.nativeId === 'pid-1', JSON.stringify(events));
  }
  // interject が未受理（false）を返したら送信待ちへ戻す（session/prompt には下らない）
  {
    const events = [];
    const client = { call: () => new Promise(() => {}) };
    const steer = createAcpSteer({ client, sessionId: 's', emit: e => events.push(e), ready: () => true,
      interject: async () => false });
    t.ok('interject の未受理は false（送信待ちへ）', await steer.steer({ id: 'f1', args: { prompt: 'x' } }) === false && events.length === 0);
  }
}
