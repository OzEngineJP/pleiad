// 約束を記憶に書かない・既存の約束を保存だけへ・保存だけ（archive）を AI の配送・検索・夜の整理から外す（記憶の段 2 の実装単位 2。ADR 0359）:
// AI・夜の整理が kind=promise を書く・直すのは MEMORY_REJECTED（ToDo のある会話は promiseTodo・無ければ promiseLoop。保存しない）・人は書ける・
// 段の無い既存の約束は起動で AI なしに archive へ（updatedAt 据え置き・記録に migration と前後・何度起動しても同じ・段を外せば戻り、外した後は再度行わない）・
// archive は turnContext（核の写し・差分・関係する記憶）・search・夜の整理の材料に出ず、list・get には出る。段の無い記憶はこれまでどおり。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryError } from '../../core/memory/guard.mjs';
import { createMemoryService, PROMISE_ARCHIVE_MIGRATION } from '../../core/memory/service.mjs';
import { createMemoryStore } from '../../core/memory/store.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'memory-promise';
export const title = '約束は記憶に書かない・既存の約束は保存だけへ（AI なし・戻せる）・保存だけは配送・検索・夜の整理に出ない';

const BOT = 'b_owl12345';
const HUMAN = { kind: 'human' };
const BOT_AUTHOR = { kind: 'bot', botId: BOT };
const LEARNER = { kind: 'bot', botId: 'learner' };
const Q_FRI = '金曜に出さないでほしい';
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof MemoryError ? `${e.code}:${e.reason}` : `ERR:${e.message}`; } };

const channels = {
  list: async () => [{ id: 'c_dev0001', name: 'dev' }],
  read: async () => ({ posts: [{ id: 'p_human01', channelId: 'c_dev0001', text: 'デプロイは金曜に出さないでほしい。週末に直せないから', at: 100, author: { kind: 'human' } }], nextBefore: null }),
};
const sessions = { read: async () => null, get: async () => null };
const botOfSession = async (id) => (String(id).startsWith('sbot') ? { botId: BOT, kind: 'thread' } : null);
const grounds = [{ kind: 'post', channelId: 'c_dev0001', postId: 'p_human01', quote: Q_FRI }];
const botCtx = (extra = {}) => ({ sessions, botOfSession, sessionId: 'sbot-1', ...extra });
const AT = new Date(2026, 9, 3, 10, 41).getTime();
const TURN_TAG = '<pleiad-turn-context>';
const CORE_TAG = '<pleiad-memory-core>';
const flat = (notes) => notes.join('\n');

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-promise-'));
  try {
    // ---- AI・夜の整理は約束を書けない（保存もしない）。人は書ける
    const clock = (() => { let c = 10_000; return () => ++c; })();
    const svc = createMemoryService({ dataDir: path.join(root, 'write'), channels, now: clock });
    await svc.start();
    const wPromise = (author, ctx, extra = {}) => svc.write({ layer: 'user', text: '来週までに見積もりを出す約束', sources: grounds, kind: 'promise', ...extra }, author, ctx);
    t.ok('AI が約束を書くと MEMORY_REJECTED（promiseLoop: ToDo の無い会話は気がかりへ）。保存もされない',
      await code(() => wPromise(BOT_AUTHOR, botCtx())) === 'MEMORY_REJECTED:promiseLoop' && !svc.store.entries().some((e) => e.kind === 'promise'));
    t.ok('ToDo のある会話（ctx.hasTodos）は promiseTodo（ToDo へ）', await code(() => wPromise(BOT_AUTHOR, botCtx({ hasTodos: true }))) === 'MEMORY_REJECTED:promiseTodo');
    t.ok('bot でない AI・夜の整理（learner）も同じ。保存もされない',
      await code(() => wPromise({ kind: 'agent', sessionId: 'sx' }, { sessions, botOfSession, sessionId: 'sx' })) === 'MEMORY_REJECTED:promiseLoop'
      && await code(() => wPromise(LEARNER, botCtx({ sessionId: undefined }))) === 'MEMORY_REJECTED:promiseLoop' && svc.store.entries().length === 0);
    const human = await wPromise(HUMAN, {}, { sources: undefined });
    t.ok('人は約束を書ける（今までどおり。段は always）', human.kind === 'promise' && human.tier === 'always');
    const aiStop = await svc.write({ layer: 'user', text: '金曜はデプロイしない（決めたこと）', sources: grounds, kind: 'stop' }, BOT_AUTHOR, botCtx());
    t.ok('AI は約束以外の種類（stop など）をこれまでどおり書ける', aiStop.kind === 'stop');

    // 直し: 約束にする直しは断る。約束でない行を約束に変える・約束の本文を AI が直すのも断る。保存だけへ寄せるのは通る
    t.ok('AI が約束でない行を約束に直すのは MEMORY_REJECTED（種類の直し）', await code(() => svc.edit({ id: aiStop.id, kind: 'promise' }, BOT_AUTHOR, botCtx())) === 'MEMORY_REJECTED:promiseLoop'
      && svc.store.get(aiStop.id).kind === 'stop');
    t.ok('AI が約束の行の本文を直すのも断る（結果が約束のまま）', await code(() => svc.edit({ id: human.id, text: '来週までに見積もりと設計を出す約束' }, BOT_AUTHOR, botCtx({ hasTodos: true }))) === 'MEMORY_REJECTED:promiseTodo'
      && svc.store.get(human.id).text === '来週までに見積もりを出す約束');
    t.ok('AI が約束の行を別の種類に直すのは通る（結果が約束でない。人は約束へ戻せる）', (await svc.edit({ id: human.id, kind: 'pref' }, BOT_AUTHOR, botCtx())).kind === 'pref'
      && (await svc.edit({ id: human.id, kind: 'promise' }, HUMAN, {})).kind === 'promise');
    const archivedByAi = await svc.edit({ id: human.id, tier: 'archive' }, BOT_AUTHOR, botCtx());
    t.ok('AI が約束の行を保存だけ（archive）に寄せるのは通る（段だけの直し）', archivedByAi.tier === 'archive' && archivedByAi.kind === 'promise');
    t.ok('保存だけに寄せるときに本文・種類も直すのは断る（約束のまま）', await code(() => svc.edit({ id: human.id, tier: 'archive', text: '別の約束の本文に直す' }, BOT_AUTHOR, botCtx())) === 'MEMORY_REJECTED:promiseLoop');
    t.ok('人は約束を直せる', (await svc.edit({ id: human.id, text: '人が直した約束の本文', tier: 'always' }, HUMAN, {})).text === '人が直した約束の本文');
    svc.stop();

    // ---- ops: memory.write は ToDo のある会話か（ctx.todos.list）で理由を分ける
    const svcOps = createMemoryService({ dataDir: path.join(root, 'ops'), channels });
    await svcOps.start();
    const asked = [];
    const todos = { 'sbot-todo': [{ id: 'td_1', text: '見積もり' }], 'sbot-none': [] };
    const deps = { locale: 'ja', memory: svcOps, sessions, botOfSession, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), audit: () => {},
      todos: { list: ({ kind, id }) => { if (kind !== 'session' || !(id in todos)) throw new Error('not found'); return { rev: 1, items: todos[id] }; } },
      approve: async (req) => { asked.push(req); return { pending: true, requestId: `r${asked.length}` }; } };
    const agentP = (sessionId) => ({ by: 'agent', via: 'mcp', sessionId });
    const write = (sessionId, extra = {}) => registry.invoke(agentP(sessionId), 'memory.write', { layer: 'self', text: '週明けに連絡する約束', sources: grounds, kind: 'promise', ...extra }, deps);
    const withTodo = await write('sbot-todo');
    t.ok('memory.write: ToDo のある会話では「ToDo へ」と案内して断る（promiseTodo の案内文）', withTodo.code === 'MEMORY_REJECTED' && /todos\.add/.test(withTodo.error ?? withTodo.message ?? JSON.stringify(withTodo)), JSON.stringify(withTodo));
    const noTodo = await write('sbot-none');
    t.ok('memory.write: ToDo の無い会話では「気がかりへ」と案内して断る（promiseLoop の案内文）', noTodo.code === 'MEMORY_REJECTED' && /brain\.loopAdd/.test(noTodo.error ?? noTodo.message ?? JSON.stringify(noTodo)), JSON.stringify(noTodo));
    const noList = await write('sbot-unknown');
    t.ok('ToDo の一覧が引けない会話も promiseLoop（気がかりへ）', noList.code === 'MEMORY_REJECTED' && /brain\.loopAdd/.test(noList.error ?? noList.message ?? JSON.stringify(noList)));
    t.ok('どれも保存されない', !svcOps.store.entries().some((e) => e.kind === 'promise'));
    t.ok('約束でない書き込みは ToDo の有無に関わらず通る', (await write('sbot-todo', { kind: 'stop', text: '本番は金曜に出さない' })).ok === true);
    svcOps.stop();

    // ---- 既存の約束の一括移行（起動の最初の読み込みで 1 度。AI なし・updatedAt 据え置き・記録・戻せる・再起動で増えない）
    const dataDir = path.join(root, 'migrate');
    let c = 20_000;
    const tick = () => ++c;
    const seed = createMemoryStore({ dir: path.join(dataDir, 'memory'), now: tick, titleOf: () => 'あなたについて' });
    await seed.init();
    const oldPromise = (await seed.add({ layer: 'user', text: '段の無い古い約束（人が書いた）', by: HUMAN, kind: 'promise' })).entry;
    const botPromise = (await seed.add({ layer: BOT, text: 'bot が書いた古い約束', by: BOT_AUTHOR, kind: 'promise', sources: [] })).entry;
    const keep = (await seed.add({ layer: 'user', text: '段の無い普通の好み', by: HUMAN, kind: 'preference' })).entry;
    const plainOld = (await seed.add({ layer: 'user', text: '種類の無い古い行', by: HUMAN })).entry;
    const placed = (await seed.add({ layer: 'user', text: '段のある約束（人が always にした）', by: HUMAN, kind: 'promise', tier: 'always' })).entry;
    seed.close();

    const events = [];
    const mig = createMemoryService({ dataDir, channels, now: tick, emit: (e) => events.push(e) });
    await mig.start();
    const list0 = await mig.list({});
    const after = (id) => list0.find((e) => e.id === id);
    t.ok('起動で段の無い約束（user 層・bot の層とも）は archive になる', after(oldPromise.id).tier === 'archive' && after(botPromise.id).tier === 'archive');
    t.ok('updatedAt・by・本文は動かさない（AI も通さない）', after(oldPromise.id).updatedAt === oldPromise.updatedAt && after(oldPromise.id).by.kind === 'human' && !after(oldPromise.id).origBy
      && after(oldPromise.id).text === oldPromise.text && after(botPromise.id).by.botId === BOT && after(botPromise.id).updatedAt === botPromise.updatedAt);
    t.ok('約束でない行・種類の無い行・すでに段のある約束は触らない（段なしはこれまでどおり）', after(keep.id).tier === undefined && after(plainOld.id).tier === undefined && after(placed.id).tier === 'always');
    const logOf = (service, id) => service.store.recordsSince(0).filter((r) => r.id === id && r.op === 'edit');
    const rec = logOf(mig, oldPromise.id);
    t.ok('変更記録に「システムが archive にした」と前後（place）・移行の名前（migration）が残る', rec.length === 1 && rec[0].migration === PROMISE_ARCHIVE_MIGRATION && rec[0].by.kind === 'system'
      && rec[0].place.from.tier === undefined && rec[0].place.to.tier === 'archive', JSON.stringify(rec));
    t.ok('移行は memoryChanged で知らせる', events.some((e) => e.type === 'memoryChanged'));
    const rev1 = mig.rev();
    mig.stop();

    const again = createMemoryService({ dataDir, channels, now: tick });
    await again.start();
    await again.list({});
    t.ok('もう一度起動しても記録は増えない（同じ結果・rev も同じ）', again.rev() === rev1 && logOf(again, oldPromise.id).length === 1 && again.store.recordsSince(0).filter((r) => r.migration === PROMISE_ARCHIVE_MIGRATION).length === 2);
    // 戻せる: 段を外すと段なしに戻り、次の起動でもやり直さない
    const restored = (await again.store.edit({ id: oldPromise.id, tier: null, by: HUMAN })).entry;
    t.ok('段を外すと元（段なし）に戻る。updatedAt・by は動かない', restored.tier === undefined && restored.updatedAt === oldPromise.updatedAt && restored.kind === 'promise' && restored.by.kind === 'human');
    const moved = await again.edit({ id: botPromise.id, tier: 'always' }, HUMAN, {});
    t.ok('サービスの edit でも別の段へ移せる（人の分類。updatedAt は動かない）', moved.tier === 'always' && moved.updatedAt === botPromise.updatedAt);
    again.stop();
    const third = createMemoryService({ dataDir, channels, now: tick });
    await third.start();
    t.ok('外した約束は次の起動でもう一度 archive にしない', (await third.get({ id: oldPromise.id })).tier === undefined && (await third.get({ id: botPromise.id })).tier === 'always');

    // ---- archive は turnContext（核の写し・差分・関係する記憶）・search に出ない。list・get には出る
    const live = createMemoryService({ dataDir: path.join(root, 'deliver'), channels, now: tick });
    await live.start();
    const ask = (session, incomingText = '', extra = {}) => live.turnContext({ bot: { id: BOT }, session, incomingText, now: AT, locale: 'ja', ...extra });
    const noteOf = (r) => flat(r.notes);
    const shown = await live.write({ layer: 'user', text: 'レビューは小さい差分で出す', tier: 'always' }, HUMAN, {});
    const hidden = await live.write({ layer: 'user', text: '保存だけにした古い見積もりの約束', tier: 'archive', kind: 'promise' }, HUMAN, {});
    const hiddenBot = await live.write({ layer: BOT, text: '保存だけにした bot の層の見積もりの約束', tier: 'archive' }, HUMAN, {});
    const start = await ask({ snapshotDue: true, memRev: 0, delivered: [] }, '見積もりの約束はどうなった');
    t.ok('核の写しに archive は入らない（段のない・always の行は入る）', noteOf(start).includes(CORE_TAG) && noteOf(start).includes('レビューは小さい差分') && !noteOf(start).includes('見積もりの約束'));
    t.ok('関係する記憶にも archive は出ない（本文が質問と重なっても）', !noteOf(start).includes('保存だけにした') && !start.delivered.includes(hidden.id) && !start.delivered.includes(hiddenBot.id) && start.delivered.includes(shown.id));
    const next = await ask({ snapshotDue: false, memRev: start.memRev, delivered: start.delivered }, '見積もりの約束はどうなった');
    t.ok('次のターンの関係する記憶にも出ない', !flat(next.notes).includes('見積もりの約束') && flat(next.notes).includes(TURN_TAG));

    // 差分: archive の追加・直し・忘却は出ない。archive から戻した行は「直した」で届く。archive へ寄せた行は出ない（段を付けた記録が差分に出ない）
    const visible = await live.write({ layer: 'user', text: '朝会は 10 分で終える', tier: 'always' }, HUMAN, { sessionId: 'other' });
    const plain = await live.write({ layer: 'user', text: 'あとで保存だけにする行です', tier: 'always' }, HUMAN, { sessionId: 'other' });
    await live.write({ layer: 'user', text: '保存だけで足された約束の行', tier: 'archive', kind: 'promise' }, HUMAN, { sessionId: 'other' });
    await live.edit({ id: plain.id, tier: 'archive' }, HUMAN, { sessionId: 'other' });
    await live.edit({ id: hidden.id, text: '保存だけの約束の本文を直した' }, HUMAN, { sessionId: 'other' });
    const delta = await ask({ snapshotDue: false, memRev: next.memRev, delivered: next.delivered }, '予定');
    t.ok('差分に archive の追加・直し・振り分けは出ない（見える追加は出る）', noteOf(delta).includes('朝会は 10 分で終える') && !noteOf(delta).includes('保存だけ') && !noteOf(delta).includes('あとで保存だけにする') && !delta.delivered.includes(plain.id));
    await live.forget({ id: hiddenBot.id }, HUMAN, { sessionId: 'other' });
    const delta2 = await ask({ snapshotDue: false, memRev: delta.memRev, delivered: delta.delivered }, '予定');
    t.ok('archive の記憶を忘れても差分（忘れた）には出ない', !noteOf(delta2).includes('忘れた') && !noteOf(delta2).includes('bot の層の見積もり'));
    await live.edit({ id: plain.id, tier: 'always' }, HUMAN, { sessionId: 'other' });
    const delta3 = await ask({ snapshotDue: false, memRev: delta2.memRev, delivered: delta2.delivered }, '予定');
    t.ok('保存だけから戻した行は、また配送の対象になる（差分に出る）', noteOf(delta3).includes('あとで保存だけにする行です'));

    // search / list / get
    const found = await live.search({ query: '見積もりの約束', layer: 'user' });
    t.ok('search に archive は出ない', !found.some((e) => e.id === hidden.id) && !(await live.search({ query: '見積もりの約束' })).some((e) => e.tier === 'archive'));
    t.ok('search は archive 以外の行を引く（段なし・always）', (await live.search({ query: 'レビューは小さい差分' })).some((e) => e.id === shown.id));
    const all = await live.list({ layer: 'user' });
    t.ok('list には archive も出る（段つき）', all.find((e) => e.id === hidden.id)?.tier === 'archive' && (await live.get({ id: hidden.id })).tier === 'archive');
    live.stop();

    // ---- 段の無い記憶はこれまでどおり配送・検索される
    const legacy = createMemoryService({ dataDir: path.join(root, 'legacy'), channels, now: tick });
    await legacy.start();
    await legacy.store.add({ layer: 'user', text: '段のない古い好み：コーヒーは濃いめ', by: HUMAN });
    const l0 = await legacy.turnContext({ bot: { id: BOT }, session: { snapshotDue: true, memRev: 0, delivered: [] }, incomingText: 'コーヒー', now: AT, locale: 'ja' });
    t.ok('段の無い記憶はこれまでどおり核の写し・検索に出る', flat(l0.notes).includes('コーヒーは濃いめ') && (await legacy.search({ query: 'コーヒーは濃いめ' })).length === 1);
    legacy.stop();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
