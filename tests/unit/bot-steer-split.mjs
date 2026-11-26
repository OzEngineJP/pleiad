// 人の途中送信で、bot のターンの投稿を分ける細かい場合（ADR 0117 の追記。節 12）。
//   人がスレッドへ投稿して、走っている bot のターンへ途中送信が届いたら、今の投稿をそこまでの本文で確定し（書いている印を外す）、続きは新しい投稿に出す。
//   - 身代わりのサービス・バックエンド（LLM もサーバーも使わない）: 分ける・分けない（bot・AI・聞こえた投稿・リアクション）・止める・失敗・
//     リアクション・返事の @・呼んだ bot へ返す返事・流し（06）の切り出し
//   - fake バックエンドのサーバー: 実際の並び（根・確定した投稿・人の投稿・新しい投稿）・channelPost の edit と add・リアクション・［止める］
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createDispatcher, PROGRESS_MIN_CHARS } from '../../core/bots/dispatch.mjs';
import { newStream, applyStreamEvent, unsettledFor } from '../../web/channels/stream-model.mjs';

export const name = 'bot-steer-split';
export const title = '途中送信で投稿を分ける: 分ける・分けない・止める・失敗・リアクション・返事の @・呼んだ bot への返事・流し・実サーバーの並びと channelPost（ADR 0117）';

const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 600)}`);
};

// 見せる文になる長さ（progressBody は PROGRESS_MIN_CHARS 以上の文の切れ目まで）
const BODY_A = 'まず、手元の設定ファイルを読み直して、今の値がどうなっているかを一通り確かめました。';
const BODY_B = '確かめた結果、設定は正しい向きでした。次は、その設定で試験を流して、結果を見てから報告します。';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-steer-split-'));
  const servers = [], clients = [];
  try {
    t.ok('前提: 試験の文は途中経過に出る長さ', [...BODY_A].length >= PROGRESS_MIN_CHARS && [...BODY_B].length >= PROGRESS_MIN_CHARS, `${[...BODY_A].length}/${[...BODY_B].length}/${PROGRESS_MIN_CHARS}`);

    // ================================================================ 身代わりのサービス
    let worlds = 0;
    const tick = () => sleep(60);
    const human = (id, text, extra = {}) => ({ id, channelId: 'c_1', threadId: 'p_root', author: { kind: 'human' }, text, mentions: ['b_1'], at: 2000, reactions: {}, ...extra });
    const world = ({ steerKind = 'plain', lynx = false } = {}) => {
      const posts = [
        { id: 'p_root', channelId: 'c_1', threadId: null, author: { kind: 'human' }, text: '根', mentions: ['b_1'], at: 1000, reactions: {} },
        human('p_h1', '@Owl 追記 1'),
        human('p_h2', '@Owl 追記 2', { at: 3000 }),
      ];
      const threads = { 'c_1/p_root': { channelId: 'c_1', threadId: 'p_root', sessions: { b_1: 's1', ...(lynx ? { b_2: 's2' } : {}) }, state: 'idle', calls: 0, stopped: null } };
      const side = (botId) => ({ bot: { botId, kind: 'thread', channelId: 'c_1', threadId: 'p_root', memRev: 0, snapshotDue: false, delivered: [], postCursor: 'p_root' } });
      const sessions = { s1: side('b_1'), ...(lynx ? { s2: side('b_2') } : {}) };
      const steers = [], started = [], aborted = [], removed = [];
      const control = steerKind === 'none' ? {} : { steer: async (m) => { steers.push(m); return true; }, ...(steerKind === 'confirm' ? { steerConfirms: true } : {}) };
      const turn = { info: { sessionId: 's1' }, control, ac: { signal: { aborted: false } }, outcome: null, usage: {}, agentLocale: 'ja' };
      const turns = new Map([['s1', turn]]);
      const channel = { id: 'c_1', kind: 'channel', name: 'dev' };
      const channels = {
        dir: path.join(tmp, `stub-${++worlds}`),
        get: async () => channel, getPost: async ({ postId }) => structuredClone(posts.find((x) => x.id === postId) ?? null),
        read: async () => ({ posts: structuredClone(posts) }),
        post: async (a, by) => {
          const post = { id: `p_t${posts.length}`, channelId: a.channelId, threadId: a.threadId, author: by?.kind === 'system' ? { kind: 'system' } : { kind: 'bot', botId: by?.botId ?? 'b_1' }, text: a.text, state: a.state, turn: a.turn, ...(typeof a.failure === 'string' ? { failure: a.failure } : {}), mentions: [], at: 4000, reactions: {} };
          posts.push(post);
          return post;
        },
        // 本文の @Lynx は、書いた時点で b_2 に解く（本物の ChannelService が @ を投稿の時点で解くのと同じ形）
        edit: async (a) => {
          const post = posts.find((x) => x.id === a.postId);
          Object.assign(post, ...[a.text !== undefined && { text: a.text, mentions: /@Lynx/.test(a.text) ? ['b_2'] : [] }, a.state && { state: a.state }, a.presents && { presents: a.presents }, a.failedWithBody && { failedWithBody: true }, typeof a.failure === 'string' && { failure: a.failure }].filter(Boolean));
          return structuredClone(post);
        },
        remove: async (a) => { removed.push(a.postId); },
        threads: {
          get: async (c, th) => structuredClone(threads[`${c}/${th}`] ?? null), list: async (c) => structuredClone(Object.values(threads).filter((x) => !c || x.channelId === c)),
          update: async (c, th, patch) => {
            const cur = (threads[`${c}/${th}`] ??= { channelId: c, threadId: th, sessions: {}, state: 'idle', calls: 0, stopped: null });
            const next = typeof patch === 'function' ? patch(structuredClone(cur)) : patch;
            Object.assign(cur, next, next.sessions ? { sessions: { ...cur.sessions, ...next.sessions } } : {});   // sessions は本物と同じく足し込む
            return structuredClone(cur);
          },
        },
      };
      const host = {
        dataDir: tmp, store: { get: async (id) => structuredClone(sessions[id] ?? {}), setSessionData: async (id, f, v) => { sessions[id] = { ...sessions[id], [f]: v }; } },
        runtime: { turns }, noticeTarget: async () => (control.steer ? turn : null), noticeBlocked: async () => false,
        agentLocaleFor: async () => 'ja', currentLocale: () => 'ja', emitSession: () => {},
        abortSessions: async (a) => { aborted.push(a); },
        runTurn: async (args, _onStarted, hooks) => { started.push({ args, hooks }); return 'ok'; },
        lastReply: async () => '終わり',
      };
      const BOTS = [{ id: 'b_1', name: 'Owl', icon: '🦉' }, ...(lynx ? [{ id: 'b_2', name: 'Lynx', icon: '🐺' }] : [])];
      const bots = { get: async ({ botId }) => BOTS.find((b) => b.id === botId) ?? null, list: async () => BOTS };
      const memory = { turnContext: async () => ({ notes: [], memRev: 0, delivered: [], snapshotDue: false }) };
      const d = createDispatcher({ channels, bots, memory, host });
      return { d, posts, threads, sessions, steers, started, aborted, removed, turn, turns, channel, human: posts[1] };
    };
    // このターンの投稿（問いかけの投稿 p_q は別のターンのものなので数えない）
    const turnPosts = (w) => w.posts.filter((p) => p.turn && p.turn.sessionId === 's1' && p.id !== 'p_q');
    const lynxAt = (id, text, extra = {}) => ({ id, channelId: 'c_1', threadId: 'p_root', author: { kind: 'bot', botId: 'b_2' }, text, mentions: ['b_1'], at: 2500, reactions: {}, ...extra });
    const say = (w, text) => { w.d.onTurnEvent(w.turn, { type: 'text.delta', text }); w.d.onTurnEvent(w.turn, { type: 'text.end' }); };
    const finish = async (w, outcome = 'ok', extra = {}) => { w.turns.delete('s1'); await w.d.onTurnEnd(w.turn, { outcome, ...extra }); };
    const inboxOf = async (w, sessionId) => (await w.d.inbox.list({ sessionId }));

    // ---- 分ける: 今の投稿は本文のまま done、続きは新しい投稿（見せる文ができてから）。確定した投稿は終わりまで変わらない
    {
      const w = world();
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, BODY_A);
      await w.d.onPosted(w.human, w.channel);
      await tick();
      t.ok('分ける: 人の途中送信で今の投稿を本文のまま done にする（書いている印を外す）。途中送信は 1 回だけ渡る',
        turnPosts(w).length === 1 && first.text === BODY_A && first.state === 'done' && w.steers.length === 1, JSON.stringify(w.posts));
      w.d.onTurnEvent(w.turn, { type: 'text.delta', text: BODY_B });
      await tick();
      const second = turnPosts(w)[1];
      t.ok('分ける: 続きの文ができたら、新しい投稿（同じ turn）を作る。作業中で、本文は続きだけ',
        turnPosts(w).length === 2 && second.id !== first.id && second.state === 'working' && second.text === BODY_B
        && second.turn.botId === 'b_1' && second.turn.sessionId === 's1' && first.text === BODY_A && first.state === 'done', JSON.stringify(turnPosts(w)));
      w.d.onTurnEvent(w.turn, { type: 'text.end' });
      await finish(w);
      t.ok('分ける: 終わると新しい投稿が done。確定した投稿は終わりまで変わらない',
        turnPosts(w).length === 2 && second.text === BODY_B && second.state === 'done' && first.text === BODY_A && first.state === 'done', JSON.stringify(turnPosts(w)));
      // 流し（06）: 流れは最後の投稿へ。前の投稿の本文を外した続きが出る
      const fold = (events) => { const s = newStream(); for (const e of events) applyStreamEvent(s, e); return s; };
      const stream = fold([{ type: 'text.delta', sessionId: 's1', text: BODY_A, streamSeq: 1 }, { type: 'text.end', sessionId: 's1', streamSeq: 2 }, { type: 'text.delta', sessionId: 's1', text: BODY_B, streamSeq: 3 }]);
      const lastOf = turnPosts(w).filter((p) => !p.deletedAt).at(-1);
      t.ok('流し: 会話の最後の投稿は新しい投稿。確定した投稿の本文を外すと、新しい投稿に載る分だけが残る',
        lastOf === second && unsettledFor(stream, [first.text], '…') === BODY_B && unsettledFor(stream, [first.text], second.text) === '', String(unsettledFor(stream, [first.text], '…')));
    }

    // ---- 分ける（渡った合図を後から出すバックエンド）: 合図の前に分かれる。読まれる前に書かれた文も新しい投稿に入る
    {
      const w = world({ steerKind: 'confirm' });
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, BODY_A);
      await w.d.onPosted(w.human, w.channel);
      w.d.onTurnEvent(w.turn, { type: 'text.delta', text: BODY_B });   // 人の投稿を bot が読む前に書いた文
      w.d.onTurnEvent(w.turn, { type: 'userMessage.delivered', messageId: w.steers[0].id });
      await tick();
      const second = turnPosts(w)[1];
      t.ok('分ける: 合図を待つバックエンドでも、渡す前に分かれ、人の投稿の後に書いた文は新しい投稿に入る',
        first.text === BODY_A && first.state === 'done' && second?.text === BODY_B && second.state === 'working', JSON.stringify(turnPosts(w)));
      w.d.onTurnEvent(w.turn, { type: 'text.end' });
      await finish(w);
    }

    // ---- 何も言わずに終われば、新しい投稿は作らない（確定した投稿だけが残る）
    {
      const w = world();
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, BODY_A);
      await w.d.onPosted(w.human, w.channel);
      await tick();
      await finish(w);
      t.ok('黙って終われば新しい投稿は作らない（確定した投稿は done のまま）', turnPosts(w).length === 1 && first.state === 'done' && first.text === BODY_A, JSON.stringify(turnPosts(w)));
    }

    // ---- 分けない: 人の投稿でない途中送信・聞こえた投稿・リアクションは、今の投稿のまま続ける
    const noSplit = async (label, deliver, { lynx = false, steered = true } = {}) => {
      const w = world({ lynx });
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, BODY_A);
      await deliver(w);
      await tick();
      t.ok(`分けない（${label}）: ターンに届くが、投稿は作業中のまま 1 つ`,
        (!steered || w.steers.length >= 1) && turnPosts(w).length === 1 && first.state === 'working', JSON.stringify([w.steers.length, turnPosts(w)]));
      say(w, BODY_B);
      await finish(w);
      t.ok(`分けない（${label}）: 続きの文は同じ投稿に入り、終わりに 1 つの投稿が done`,
        turnPosts(w).length === 1 && first.state === 'done' && first.text === `${BODY_A}\n\n${BODY_B}`, JSON.stringify(turnPosts(w)));
    };
    await noSplit('bot の @', async (w) => {
      w.posts.push(lynxAt('p_lynx', '@Owl 確認して'));
      await w.d.onPosted(w.posts.at(-1), w.channel);
    }, { lynx: true });
    await noSplit('Chats の AI（agent）の @', async (w) => {
      w.posts.push({ id: 'p_ai', channelId: 'c_1', threadId: 'p_root', author: { kind: 'agent' }, text: '@Owl 確認して', mentions: ['b_1'], at: 2500, reactions: {} });
      await w.d.onPosted(w.posts.at(-1), w.channel);
    });
    await noSplit('聞こえた投稿', async (w) => {
      await w.d.wake({ botId: 'b_1', channel: w.channel, threadId: 'p_root', post: w.human, heard: true, talkingTo: 'b_2' });
    });
    await noSplit('問いかけへの答えのリアクション', async (w) => {
      w.posts.push({ id: 'p_q', channelId: 'c_1', threadId: 'p_root', author: { kind: 'bot', botId: 'b_1' }, turn: { botId: 'b_1', sessionId: 's1' }, text: '二つあります。どちらにしますか？', state: 'done', mentions: [], at: 500, reactions: { '👍': [{ kind: 'human' }] } });
      await w.d.onReacted(w.posts.at(-1), w.channel, { emoji: '👍', on: true, by: { kind: 'human' } });
    });

    // ---- 止める: ［止める］・中断の印は最後の投稿に出す。確定した投稿は done のまま
    {
      const w = world();
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, BODY_A);
      await w.d.onPosted(w.human, w.channel);
      w.d.onTurnEvent(w.turn, { type: 'text.delta', text: BODY_B });
      await tick();
      const second = turnPosts(w)[1];
      w.threads['c_1/p_root'].stopped = { by: { kind: 'human' }, at: 5000 };
      await w.d.stopThread({ channelId: 'c_1', threadId: 'p_root' }, { kind: 'human' });
      await finish(w, 'aborted', { interrupted: { reason: 'user' } });
      t.ok('止める: 最後の投稿が stopped（中断の印）、前の確定した投稿は done のまま', first.state === 'done' && first.text === BODY_A
        && second.state === 'stopped' && second.text === BODY_B && turnPosts(w).length === 2 && w.aborted.length === 1 && w.aborted[0].sessionId === 's1', JSON.stringify(turnPosts(w)));
    }
    {
      const w = world();
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, BODY_A);
      await w.d.onPosted(w.human, w.channel);
      await tick();
      w.threads['c_1/p_root'].stopped = { by: { kind: 'human' }, at: 5000 };
      await w.d.stopThread({ channelId: 'c_1', threadId: 'p_root' }, { kind: 'human' });
      await finish(w, 'aborted', { interrupted: { reason: 'user' } });
      t.ok('止める: 分けた直後に止めても、何も書いていない新しい投稿は作らない（確定した投稿は done のまま。中断はスレッドの印）',
        turnPosts(w).length === 1 && first.state === 'done' && w.posts.some((p) => p.author.kind === 'system' && p.state === 'stopped'), JSON.stringify(w.posts));
    }

    // ---- 失敗: 失敗と［やり直す］は最後の投稿に出す。確定した投稿は done のまま
    {
      const w = world();
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, BODY_A);
      await w.d.onPosted(w.human, w.channel);
      await tick();
      w.d.onTurnEvent(w.turn, { type: 'turnResult', outcome: 'error', error: '接続が切れました' });
      await finish(w, 'error');
      const last = turnPosts(w)[1];
      t.ok('失敗: 分けた直後の失敗は、本文の無い新しい投稿に失敗の印だけを出す。確定した投稿は done のまま',
        turnPosts(w).length === 2 && last.state === 'failed' && String(last.failure).includes('接続が切れました') && !last.failedWithBody
        && first.state === 'done' && first.text === BODY_A && !first.failure, JSON.stringify(turnPosts(w)));
    }
    {
      const w = world();
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, BODY_A);
      await w.d.onPosted(w.human, w.channel);
      w.d.onTurnEvent(w.turn, { type: 'text.delta', text: BODY_B });
      await tick();
      w.d.onTurnEvent(w.turn, { type: 'turnResult', outcome: 'error', error: '接続が切れました' });
      await finish(w, 'error');
      const last = turnPosts(w)[1];
      t.ok('失敗: 新しい投稿に本文があれば、本文を残して失敗の印を付ける（failedWithBody）。確定した投稿は done のまま',
        turnPosts(w).length === 2 && last.state === 'failed' && last.failedWithBody === true && last.text === BODY_B
        && first.state === 'done' && !first.failure && !first.failedWithBody, JSON.stringify(turnPosts(w)));
    }

    // ---- リアクション: どの投稿にも turn があり、付けたリアクションは同じ会話へ届く
    {
      const w = world();
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, BODY_A);
      await w.d.onPosted(w.human, w.channel);
      w.d.onTurnEvent(w.turn, { type: 'text.delta', text: BODY_B });
      await tick();
      const second = turnPosts(w)[1];
      await w.d.onReacted(first, w.channel, { emoji: '🎉', on: true, by: { kind: 'human' } });
      await w.d.onReacted(second, w.channel, { emoji: '🎉', on: true, by: { kind: 'human' } });
      const reactions = (await inboxOf(w, 's1')).filter((i) => i.reaction);
      t.ok('リアクション: 確定した投稿・新しい投稿のどちらに付けても、同じ会話（s1）に届く（どちらの投稿にも turn がある）',
        first.turn?.sessionId === 's1' && second.turn?.sessionId === 's1'
        && reactions.some((i) => i.postId === first.id) && reactions.some((i) => i.postId === second.id) && reactions.every((i) => i.sessionId === 's1'), JSON.stringify(reactions));
      w.d.onTurnEvent(w.turn, { type: 'text.end' });
      await finish(w);
    }

    // ---- 返事の @ は、確定したその時に解く（返事の終わりを待たない）
    {
      const w = world({ lynx: true });
      await w.d.turnExtras(w.turn);
      const first = turnPosts(w)[0];
      say(w, `${BODY_A}\n\n@Lynx 設定の向きを見てください。`);
      await w.d.onPosted(w.human, w.channel);
      await tick();
      const lynx = (await inboxOf(w, 's2')).filter((i) => i.postId === first.id);
      t.ok('返事の @: 分けて確定した投稿の @ は、その時に Lynx を起こす（呼んだのは Owl）',
        first.state === 'done' && lynx.length === 1 && lynx[0].caller === 'b_1' && w.started.some((s) => s.args.sessionId === 's2'), JSON.stringify([lynx, w.started.map((s) => s.args.sessionId)]));
      await finish(w);
      t.ok('返事の @: ターンの終わりに同じ @ をもう一度解かない（Lynx は 1 回しか起きない）',
        (await inboxOf(w, 's2')).filter((i) => i.postId === first.id).length === 1 && w.started.filter((s) => s.args.sessionId === 's2').length === 1, JSON.stringify(await inboxOf(w, 's2')));
    }

    // ---- 呼んだ bot への返事は最後の投稿。最後の投稿に返事が無ければ、前の投稿のもの
    {
      const callBack = async (writeLast) => {
        const w = world({ lynx: true });
        await w.d.turnExtras(w.turn);
        const first = turnPosts(w)[0];
        say(w, BODY_A);
        w.posts.push(lynxAt('p_lynx', '@Owl 確認して'));
        await w.d.onPosted(w.posts.at(-1), w.channel);   // Lynx が呼んだ
        await w.d.onPosted(w.human, w.channel);          // 人の途中送信で分かれる
        if (writeLast) w.d.onTurnEvent(w.turn, { type: 'text.delta', text: BODY_B });
        await tick();
        await finish(w);
        const replies = (await inboxOf(w, 's2')).filter((i) => i.reply === 'b_1');
        return { w, first, second: turnPosts(w)[1], replies };
      };
      const a = await callBack(true);
      t.ok('呼んだ bot へ返す返事は最後の投稿（新しい投稿）', a.replies.length === 1 && a.replies[0].postId === a.second?.id && a.second?.text === BODY_B, JSON.stringify([a.replies, turnPosts(a.w)]));
      const b = await callBack(false);
      t.ok('最後の投稿が無い（黙って終えた）ときは、前の投稿の返事を呼んだ bot へ返す', b.replies.length === 1 && b.replies[0].postId === b.first.id && turnPosts(b.w).length === 1, JSON.stringify([b.replies, turnPosts(b.w)]));
    }

    // ---- 分けた後の channels.post は新しい投稿（claimPost は postId なし = ChannelService が追加する）
    {
      const w = world();
      await w.d.turnExtras(w.turn);
      const mine = { channelId: 'c_1', threadId: 'p_root', botId: 'b_1', sessionId: 's1' };
      say(w, BODY_A);
      await w.d.onPosted(w.human, w.channel);
      await tick();
      t.ok('分けた後の channels.post は、確定した投稿に書かず、新しい投稿になる（postId なし）', w.d.claimPost(mine).postId === null && turnPosts(w).length === 1);
      await finish(w);
    }

    // ================================================================ 実サーバー（fake バックエンド）
    {
      const scratch = await fs.realpath(await fs.mkdtemp(path.join(tmp, 'e2e-')));
      const gates = await createFakeGates(scratch);
      const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', ...gates.env }, dataDir: path.join(scratch, 'data'), timeoutMs: 60_000 });
      servers.push(server);
      const c = await open({ port: server.port, token: server.token });
      clients.push(c);
      const call = (op, args) => c.cmd('invoke', { op, args });
      const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
      const dev = await call('channels.create', { name: 'dev', members: [owl.id] });
      const read = async (threadId) => (await call('channels.read', { channelId: dev.id, threadId })).posts;
      const WORKING = BODY_A;   // fake の台本 "bg <本数> gate:<名前> say:<本文>" の一言目（途中経過に出る長さ）

      // 走っている間（ゲートが開くまで）に、人が @Owl で書き足す。一言目が投稿に出てから送る（出る前なら確定する投稿が無い）
      const run = async (gate) => {
        const from = c.mark();
        const root = await call('channels.post', { channelId: dev.id, text: `@Owl bg 1 gate:${gate} say:${WORKING}` });
        await until(async () => (await read(root.id)).some((p) => p.turn?.botId === owl.id && p.text.includes(WORKING)), { label: `${gate}: 一言目の投稿` });
        const human = await call('channels.post', { channelId: dev.id, threadId: root.id, text: '@Owl もう一つ確認してください。お願いします。' });
        const posts = await until(async () => {
          const all = await read(root.id);
          const mine = all.filter((p) => p.turn?.botId === owl.id);
          return mine.length >= 2 && mine[0].state === 'done' && mine[1].text.includes('受け取った') ? all : null;
        }, { label: `${gate}: 2 つ目の投稿` });
        return { root, human, posts, from };
      };

      const a = await run('split-a');
      const mineA = a.posts.filter((p) => p.turn?.botId === owl.id);
      const idx = (id) => a.posts.findIndex((p) => p.id === id);
      t.ok('実サーバー: 並びは 根・確定した投稿・人の投稿・新しい投稿', mineA.length === 2 && idx(a.root.id) < idx(mineA[0].id) && idx(mineA[0].id) < idx(a.human.id) && idx(a.human.id) < idx(mineA[1].id),
        JSON.stringify(a.posts.map((p) => [p.id, p.author.kind, p.state ?? null])));
      t.ok('実サーバー: 確定した投稿は途中送信の前の本文のまま done、新しい投稿は作業中で続きだけ（同じ会話）',
        mineA[0].text.includes(WORKING) && !mineA[0].text.includes('受け取った') && mineA[0].state === 'done'
        && mineA[1].state === 'working' && mineA[1].text.includes('受け取った') && !mineA[1].text.includes(WORKING) && mineA[0].turn.sessionId === mineA[1].turn.sessionId, JSON.stringify(mineA));
      const events = c.since(a.from).filter((e) => e.type === 'channelPost' && e.channelId === dev.id);
      const at = (fn) => events.findIndex(fn);
      const iHuman = at((e) => e.op === 'add' && e.post.id === a.human.id);
      const iEdit = at((e) => e.op === 'edit' && e.post.id === mineA[0].id && e.post.state === 'done');
      const iAdd = at((e) => e.op === 'add' && e.post.id === mineA[1].id);
      t.ok('実サーバー: channelPost は 人の投稿の add → 前の投稿の確定（edit・done）→ 新しい投稿の add の順', iHuman >= 0 && iEdit > iHuman && iAdd > iEdit,
        JSON.stringify(events.map((e) => [e.op, e.post.id, e.post.state ?? null])));
      // リアクションはどちらの投稿に付けても同じ会話へ届く
      const reacted = c.mark();
      await call('channels.react', { channelId: dev.id, postId: mineA[0].id, emoji: '🎉', on: true });
      await call('channels.react', { channelId: dev.id, postId: mineA[1].id, emoji: '🎉', on: true });
      const after = await read(a.root.id);
      t.ok('実サーバー: リアクションは確定した投稿にも新しい投稿にも付く', ['0', '1'].every((i) => Object.keys(after.find((p) => p.id === mineA[Number(i)].id)?.reactions ?? {}).length > 0)
        && !c.since(reacted).some((e) => e.type === 'error'), JSON.stringify(after.map((p) => [p.id, p.reactions])));
      // ゲートを開くと終わる。確定した投稿は変わらない
      await gates.open('split-a');
      await until(async () => (await read(a.root.id)).filter((p) => p.turn?.botId === owl.id).at(-1)?.state === 'done', { label: 'split-a が done' });
      const doneA = (await read(a.root.id)).filter((p) => p.turn?.botId === owl.id);
      t.ok('実サーバー: 終わっても、確定した投稿は途中送信の前の本文のまま done', doneA[0].id === mineA[0].id && doneA[0].text === mineA[0].text && doneA[0].state === 'done' && doneA.at(-1).state === 'done', JSON.stringify(doneA));

      // ［止める］: 最後の投稿が stopped、確定した投稿は done のまま
      const b = await run('split-b');
      await call('channels.stopThread', { channelId: dev.id, threadId: b.root.id });
      const stopped = await until(async () => {
        const mine = (await read(b.root.id)).filter((p) => p.turn?.botId === owl.id);
        return mine.length >= 2 && mine.at(-1).state === 'stopped' ? mine : null;
      }, { label: 'split-b の最後の投稿が stopped' });
      t.ok('実サーバー: ［止める］は最後の投稿を stopped にし、確定した投稿は done のまま', stopped[0].state === 'done' && stopped[0].text.includes(WORKING) && stopped.at(-1).text.includes('受け取った'), JSON.stringify(stopped));
      t.ok('実サーバー: サーバーのログに例外が出ていない', !/Unhandled|TypeError|ReferenceError/.test(server.tail(80)), server.tail(30));
    }
  } finally {
    for (const c of clients) c.close?.();
    for (const s of servers) await s.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
