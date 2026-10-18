import { createAcpSteer } from '../../core/backends/acp-steer.mjs';
import { createDevinMapper } from '../../core/backends/devin-normalize.mjs';
import { createGrokMapper } from '../../core/backends/grok-normalize.mjs';

export const name = 'acp-steer';
export const title = 'acp-steer: 受理後の決着の合図（delivered / 既読不明 dropped unknown）・早期拒否・drain・受理前の合図なし。normalize の分割 user チャンク連結';
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

  // 300ms 以内の早期成功でも同じ（受理後にだけ合図を出す）
  {
    const { steer, events } = mk();
    const p = steer.steer({ id: 'm2', args: { prompt: 'hi' } });
    t.ok('受理されるまで返らない（早期に emit しない）', await Promise.race([p.then(() => 'done'), sleep(10).then(() => 'wait')]) === 'wait' && events.length === 0);
    await p;
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
  {
    const mapper = createGrokMapper('s', () => {});
    mapper.beginTurn('first');
    mapper.accept({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } });
    mapper.noteUser('steered note');
    mapper.accept({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'more' } });
    const msgs = mapper.messages();
    t.ok('エコーの無い途中送信は noteUser で別の user 行に残る',
      msgs.length === 4 && msgs[2].role === 'user' && msgs[2].text === 'steered note' && msgs[3].text === 'more', JSON.stringify(msgs));
  }
}
