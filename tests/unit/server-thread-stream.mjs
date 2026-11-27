// スレッドの bot の書きかけの流し（ADR 0367）: 3 つ目の窓口 thread（watchSession { slot: 'thread', channelId, threadId }）。
// fake バックエンドでサーバーを立て、スレッドの bot が書いている最中を、宣言した接続・別のスレッドを宣言した接続・main だけの接続（スマホ・中継と同じ）・
// 宣言していない接続の 4 本で確かめる。LLM もネットワークも要らない。
//   - 流れ（text.delta・text.end・tool.start）は、そのスレッドの窓口を宣言した接続だけに足して届く（保存は今のまま）
//   - 窓口を宣言した返事に、いま書いている途中の分（伏せたあとの写し）が載る
//   - 秘密情報の値は流れにも写しにも出ない（ADR 0217）
//   - 窓口を外す・別のスレッドへ替えれば届かない。ほかの接続（main だけ）への配達は増えない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { streamEvents } from '../../web/session-stream.mjs';
import { THREAD_STREAM_EVENTS } from '../../core/bots/thread-stream.mjs';

export const name = 'server-thread-stream';
export const title = 'スレッドの書きかけの流し: 開いているスレッドの接続だけに届く・流し直し・伏せ・外せる・ほかの接続は増えない（ADR 0367）';

const SECRET = 'ts-' + 'q'.repeat(28);
const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 400)}`);
};

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-thread-stream-')));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(scratch, 'data'), timeoutMs: 60_000 });
  const conns = [];
  const connect = async () => { const c = await open({ port: server.port, token: server.token }); conns.push(c); return c; };
  const runner = await connect();   // 宣言していない接続（今までどおり全部届く）
  const sub = await connect();      // スレッドの窓口を宣言する（main は別の会話）
  const other = await connect();    // 別のスレッドの窓口を宣言する
  const phone = await connect();    // main だけを宣言する（スマホ・中継と同じ通り道）
  const call = (c, op, args) => c.cmd('invoke', { op, args });
  const turn = { cwd: ROOT, backend: 'fake', mode: 'default' };
  const streamOf = (c, from, sessionId) => c.since(from).filter((e) => e.sessionId === sessionId && streamEvents.has(e.type) && e.type !== 'turnEnd');
  const textOf = (events) => events.filter((e) => e.type === 'text.delta').map((e) => e.text).join('');
  const countsOf = (events) => events.reduce((m, e) => { m[e.type] = (m[e.type] || 0) + 1; return m; }, {});
  const endOf = (c, id, from) => c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === id, { ms: 30_000, from });
  const script = (...steps) => `steps:${JSON.stringify({ steps })}`;

  try {
    // 前提: 秘密情報・別の会話（main の宣言先）・bot とチャンネル
    await call(runner, 'secrets.save', { kind: 'secret', label: 'thread stream', value: SECRET, env: { name: 'THREAD_STREAM_TOKEN', scope: 'all' } });
    const m = (await runner.runTurn({ ...turn, prompt: 'echo:main の会話', sessionId: null }, { ms: 20_000 })).sessionId;
    for (const c of [sub, other, phone]) await c.cmd('loadSession', { sessionId: m, live: true, watch: true });
    await call(runner, 'settings.set', { key: 'botEnabled', value: true });
    const owl = await call(runner, 'bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const dev = await call(runner, 'channels.create', { name: 'dev', members: [owl.id] });
    const read = (threadId) => call(runner, 'channels.read', { channelId: dev.id, threadId });

    // ---- 1 回目: 書いている最中にスレッドの窓口を宣言する（最初の一文は写しで、あとは生の流れで届く）
    const first = `最初に ${SECRET} を言う。`;
    const second = `次に ${SECRET} をもう一度。おわり。`;
    let from = runner.mark();
    const root = await call(runner, 'channels.post', { channelId: dev.id, text: `@Owl ${script({ text: first }, { tool: 'Grep', input: {}, result: 'x', ms: 1800 }, { text: second })}` });
    const first1 = await runner.waitFor((e) => e.type === 'text.delta' && e.sessionId && e.sessionId !== m, { ms: 20_000, from });
    const s = first1.sessionId;
    t.ok('前提: スレッドの bot の会話が書き始める', Boolean(s) && s !== m, String(s));
    // 最初の一文を書き終えて道具に入った所（道具は 1.8 秒かかる）で、窓口を宣言する
    await runner.waitFor((e) => e.type === 'tool.start' && e.sessionId === s, { ms: 20_000, from });

    // 別のスレッド（や別のチャンネル）の窓口を宣言した接続には届かない
    const none = await other.cmd('watchSession', { slot: 'thread', channelId: dev.id, threadId: 'no-such-thread' });
    t.ok('別のスレッドの窓口の返事は空（そのスレッドで書いている会話は無い）', Array.isArray(none?.threadStream) && none.threadStream.length === 0, JSON.stringify(none));

    const fromSub = sub.mark(), fromOther = other.mark(), fromPhone = phone.mark(), fromRunner = runner.mark();
    const got = await sub.cmd('watchSession', { slot: 'thread', channelId: dev.id, threadId: root.id });
    const snap = got?.threadStream?.find((x) => x.sessionId === s);
    const snapText = textOf(snap?.events ?? []);
    t.ok('窓口を宣言した返事に、いま書いている途中の分（書き終えた一文と区切り）が載る', Boolean(snap) && snapText.includes('最初に') && snap.events.some((e) => e.type === 'tool.start'), JSON.stringify(got).slice(0, 400));
    t.ok('返事の写しは秘密情報を伏せている', !snapText.includes(SECRET) && snapText.includes('***'), snapText);
    t.ok('返事の写しは流れの 3 種類だけ', (snap?.events ?? []).every((e) => THREAD_STREAM_EVENTS.has(e.type)), JSON.stringify((snap?.events ?? []).map((e) => e.type)));
    t.ok('写しの出来事には通し番号が付く（画面が生の流れと重ねて 2 度書かないため）', (snap?.events ?? []).every((e) => Number.isFinite(e.streamSeq)), JSON.stringify(snap?.events));

    await Promise.all([endOf(sub, s, fromSub), endOf(phone, s, fromPhone), endOf(runner, s, fromRunner), endOf(other, s, fromOther)]);
    await sleep(100);

    // 窓口を宣言した接続には、このあとの流れが（流れの 3 種類だけ）届く。伏せてある
    const live = streamOf(sub, fromSub, s);
    t.ok('窓口を宣言した接続に、流れ（text.delta・text.end）だけが届く（道具の結果・稼働の表示などは来ない）', live.length > 0 && live.every((e) => THREAD_STREAM_EVENTS.has(e.type)), JSON.stringify(countsOf(live)));
    t.ok('宣言のあとに書かれた本文が届く（宣言の前の分は写しで、重ならない）', textOf(live).includes('をもう一度') && !textOf(live).includes('最初に'), textOf(live));
    t.ok('届いた流れは秘密情報を伏せている', !textOf(live).includes(SECRET) && textOf(live).includes('***'), textOf(live));
    t.ok('写しと生の流れの通し番号は続いている（重ならない・抜けない）', Math.min(...live.map((e) => e.streamSeq)) > Math.max(...snap.events.map((e) => e.streamSeq)), JSON.stringify({ snap: snap.events.map((e) => e.streamSeq), live: live.map((e) => e.streamSeq) }));
    t.ok('完了（turnEnd）は届く', sub.since(fromSub).some((e) => e.type === 'turnEnd' && e.sessionId === s));

    // 別のスレッドを宣言した接続・main だけの接続（スマホ・中継と同じ）には、流れは 1 つも増えない
    t.ok('別のスレッドの窓口を宣言した接続には、流れが届かない', streamOf(other, fromOther, s).length === 0, JSON.stringify(countsOf(streamOf(other, fromOther, s))));
    t.ok('main だけの接続（スマホ・中継）には、流れが届かない', streamOf(phone, fromPhone, s).length === 0, JSON.stringify(countsOf(streamOf(phone, fromPhone, s))));
    const nonStream = (c, f) => countsOf(c.since(f).filter((e) => e.sessionId === s && !streamEvents.has(e.type) && e.type !== 'reply'));
    t.ok('main だけの接続への、流れ以外の出来事は宣言していない接続と同じだけ（増えも減りもしない）',
      JSON.stringify(nonStream(phone, fromPhone)) === JSON.stringify(nonStream(runner, fromRunner)), JSON.stringify({ phone: nonStream(phone, fromPhone), runner: nonStream(runner, fromRunner) }));
    t.ok('main だけの接続にも完了（turnEnd）は届く', phone.since(fromPhone).some((e) => e.type === 'turnEnd' && e.sessionId === s));
    // （from は投稿の前に取った印。tool.start は窓口の宣言の前に届いている）
    t.ok('宣言していない接続には今までどおり全部届く（本文・道具・稼働）', textOf(streamOf(runner, from, s)).length > 0 && ['tool.start', 'tool.result', 'activity'].every((type) => streamOf(runner, from, s).some((e) => e.type === type)), JSON.stringify(countsOf(streamOf(runner, from, s))));

    // 保存は今のまま: 完了した投稿の本文は伏せた形で保存され、流れの有無に関わらない
    const done = await until(async () => (await read(root.id)).posts.find((p) => p.turn?.botId === owl.id && p.state === 'done'), { label: '投稿が done' });
    t.ok('保存された投稿の本文は秘密情報を伏せている', !JSON.stringify(done).includes(SECRET), done.text);

    // ---- 窓口を外す: 同じスレッドの 2 回目のターンの流れは届かない
    const released = await sub.cmd('watchSession', { slot: 'thread' });
    t.ok('窓口を外す（ids を渡さない）と ok が返る', released === 'ok', JSON.stringify(released));
    from = sub.mark();
    const fromRunner2 = runner.mark();
    await call(runner, 'channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:外したあとの返事' });
    await endOf(runner, s, fromRunner2);
    await sleep(100);
    t.ok('2 回目のターンは宣言していない接続には流れが届く（前提）', streamOf(runner, fromRunner2, s).length > 0);
    t.ok('窓口を外した接続には流れが届かない', streamOf(sub, from, s).length === 0, JSON.stringify(countsOf(streamOf(sub, from, s))));

    // ---- 書いていないときに宣言した返事は空。そのあと始まるターンの流れは頭から届く
    const idle = await sub.cmd('watchSession', { slot: 'thread', channelId: dev.id, threadId: root.id });
    t.ok('書いていないスレッドの窓口の返事は空', Array.isArray(idle?.threadStream) && idle.threadStream.length === 0, JSON.stringify(idle));
    from = sub.mark();
    await call(runner, 'channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:もう一度流す' });
    await endOf(sub, s, from);
    await sleep(100);
    const again = streamOf(sub, from, s);
    t.ok('宣言したあとに始まったターンの流れは頭から届く', textOf(again).includes('もう一度流す'), textOf(again));
    t.ok('そのターンも流れの 3 種類だけ', again.every((e) => THREAD_STREAM_EVENTS.has(e.type)), JSON.stringify(countsOf(again)));
    t.ok('通し番号は増え続ける（流し直しと重ねても 2 度書かない）', again.every((e, i) => i === 0 || e.streamSeq > again[i - 1].streamSeq), JSON.stringify(again.map((e) => e.streamSeq)));

    // ---- 窓口を別のスレッドへ替えれば、元のスレッドの流れは届かない
    await sub.cmd('watchSession', { slot: 'thread', channelId: dev.id, threadId: 'moved-away' });
    from = sub.mark();
    const fromRunner4 = runner.mark();
    await call(runner, 'channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:替えたあとの返事' });
    await endOf(runner, s, fromRunner4);
    await sleep(100);
    t.ok('別のスレッドへ替えたら、元のスレッドの流れは届かない', streamOf(sub, from, s).length === 0, JSON.stringify(countsOf(streamOf(sub, from, s))));
    t.ok('サーバーのログに例外が出ていない', !/Unhandled|TypeError|ReferenceError/.test(server.tail(80)), server.tail(30));
  } finally {
    for (const c of conns) c.close();
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
