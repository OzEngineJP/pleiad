// 夜の整理は「増やす」から「選び直す」へ（記憶の段 2 の実装単位 5。ADR 0359）: 既存の記憶は全件ではなく選んだ分だけを渡す（保存だけ・約束・忘れた記憶・
// 読まない作業場所の記憶は渡さない。重みは使わない。記憶の分は 12,000 トークン・1 回の入力は 40,000 トークン未満）・AI は渡した記憶の段の付け直しを返せる
// （段・作業場所はコードが決める。1 回の実行で 20 件まで。人が書いた記憶・人が選んだ段・約束は付け直さない・変更記録に残して戻せる）・
// 同じ文・忘れた記憶かどうかは渡した分ではなく全件をコードが調べる。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backend as fake } from '../../core/backends/fake.mjs';
import { createChannelService } from '../../core/channels/service.mjs';
import { createMemoryService } from '../../core/memory/service.mjs';
import { createMemoryLearner } from '../../core/memory/learn.mjs';
import { clock } from '../../core/routines/clock.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';
import { NIGHTLY_MEMORY_TOKENS, NIGHTLY_INPUT_TOKENS, NIGHTLY_TIER_CHANGES, nightlyItemOf, nightlyMemoryBudget, selectNightlyCandidates, parseTierChanges, decideNightlyTier } from '../../core/memory/nightly.mjs';

export const name = 'memory-nightly';
export const title = '夜の整理は選んだ記憶だけを渡し、段の付け直しはコードが決めて 20 件まで・人の記憶と約束は触らず・全件で重複を調べる';

const HUMAN = { kind: 'human' };
const LEARNER = { kind: 'bot', botId: 'b_learner' };
const CWDS = { s_alpha: '/repo/alpha', s_beta: '/repo/beta' };
const line = (prompt, head) => prompt.split('\n').find((part) => part.startsWith(head))?.slice(head.length);

export default async function (t) {
  const keepAlive = setInterval(() => {}, 1000);
  const roots = [];
  const stack = [];
  try {
    // ---- 純粋な部品: 選び方
    const e = (id, extra = {}) => ({ id, layer: 'user', text: `記憶 ${id}`, by: LEARNER, updatedAt: 100, ...extra });
    const picked = selectNightlyCandidates([
      e('a_always', { tier: 'always' }), e('a_arch', { tier: 'archive' }), e('a_promise', { kind: 'promise', tier: 'always' }),
      e('w_alpha', { tier: 'workspace', workspace: '/repo/alpha' }), e('w_beta', { tier: 'workspace', workspace: '/repo/beta' }),
      e('u_none'), e('u_alpha', { workspace: '/repo/alpha' }), e('u_beta', { workspace: '/repo/beta' }),
      e('b_layer', { layer: 'b_other', tier: 'always' }),
    ], { workspaces: ['/repo/alpha'], layers: ['user'] });
    const ids = picked.entries.map((x) => x.id);
    t.ok('保存だけ・約束・読まない作業場所の「この作業場所で」・段の無い他の作業場所・見ない層は選ばない',
      !ids.some((id) => ['a_arch', 'a_promise', 'w_beta', 'u_beta', 'b_layer'].includes(id)), JSON.stringify(ids));
    t.ok('「いつも」・読む作業場所の記憶・作業場所の無い段なしを選ぶ。「いつも」が先', ids[0] === 'a_always' && ['w_alpha', 'u_none', 'u_alpha'].every((id) => ids.includes(id)) && picked.total === 7, JSON.stringify(picked));
    const heavy = (id, weight, updatedAt) => e(id, { tier: 'always', weight, updatedAt });
    const byRecent = (list) => selectNightlyCandidates(list, { workspaces: [], layers: ['user'] }).entries.map((x) => x.id).join(',');
    t.ok('選ぶ順に重みは使わない（重みを入れ替えても同じ順）',
      byRecent([heavy('x', 1, 10), heavy('y', 5, 20)]) === 'y,x' && byRecent([heavy('x', 5, 10), heavy('y', 1, 20)]) === 'y,x');
    const crowd = Array.from({ length: 400 }, (_, i) => e(`c_${String(i).padStart(3, '0')}`, { tier: 'always', text: `長い記憶 ${i} ${'あ'.repeat(200)}`, updatedAt: 1000 + i }));
    const limited = selectNightlyCandidates(crowd, { workspaces: [], layers: ['user'] });
    t.ok(`記憶の分は ${NIGHTLY_MEMORY_TOKENS} トークンまで（残りは渡さない）。新しい順に入る`,
      limited.tokens <= NIGHTLY_MEMORY_TOKENS && limited.entries.length > 0 && limited.entries.length < 400 && limited.omitted === 400 - limited.entries.length && limited.entries[0].id === 'c_399'
      && estimateTokens(JSON.stringify(limited.entries.map(nightlyItemOf))) <= NIGHTLY_MEMORY_TOKENS, JSON.stringify({ n: limited.entries.length, tokens: limited.tokens }));
    t.ok('予算を絞ると渡す分も減る・0 なら空', selectNightlyCandidates(crowd, { layers: ['user'], budget: 1000 }).tokens <= 1000 && selectNightlyCandidates(crowd, { layers: ['user'], budget: 0 }).entries.length === 0);
    const item = nightlyItemOf(e('m_1', { tier: 'workspace', workspace: '/repo/alpha', weight: 5, strength: 3, why: '理由', sources: [{ kind: 'message' }], kind: 'pref' }));
    t.ok('渡す 1 件に重み・強さ・出どころ・理由・パス全体は入らない（作業場所は短い名前）',
      !('weight' in item) && !('strength' in item) && !('sources' in item) && !('why' in item) && item.workspace === 'alpha' && !JSON.stringify(item).includes('/repo') && item.tier === 'workspace' && item.by === 'bot:b_learner');
    t.ok('記憶の分の予算は、入力の目安から指示・発言の分を引いた残り（12,000 まで・0 未満にならない）',
      nightlyMemoryBudget(0) === NIGHTLY_MEMORY_TOKENS && nightlyMemoryBudget(30_000) === NIGHTLY_INPUT_TOKENS - 30_000 - 500 && nightlyMemoryBudget(50_000) === 0);

    // ---- 純粋な部品: 付け直しの返りと決め方
    const sent = ['m_1', 'm_2', 'm_3', 'm_4'];
    const changes = parseTierChanges([
      { id: 'm_1', tier: 'archive', reason: '済み\nの件' }, { id: 'm_1', tier: 'always', reason: '二重' }, { id: 'zzz', tier: 'archive' },
      { id: 'm_2', tier: 'forever' }, { id: 'm_3', tier: 'workspace', reason: 'あ'.repeat(200) }, null, 'x', { tier: 'always' },
    ], sent);
    t.ok('返りの不正（知らない id・二重・綴り違い・形違い）は捨てる。理由は 1 行・40 字まで',
      changes.length === 2 && changes[0].id === 'm_1' && changes[0].tier === 'archive' && !changes[0].reason.includes('\n') && [...changes[1].reason].length <= 80 && changes[1].tier === 'workspace', JSON.stringify(changes));
    t.ok('tiers が配列でなければ空', parseTierChanges(undefined, sent).length === 0 && parseTierChanges({ id: 'm_1' }, sent).length === 0 && parseTierChanges('x', sent).length === 0);
    const decide = (change, entry, ws) => decideNightlyTier(change, { by: LEARNER, ...entry }, ws);
    t.ok('約束・人が書いた記憶（origBy が人でも）・今と同じ段は付け直さない',
      decide({ tier: 'archive' }, { kind: 'promise' }).skip === 'promise' && decide({ tier: 'archive' }, { by: HUMAN }).skip === 'human' && decide({ tier: 'archive' }, { origBy: HUMAN }).skip === 'human'
      && decide({ tier: 'always' }, { tier: 'always' }).skip === 'same' && decide({ tier: 'archive' }, { tier: 'archive' }).skip === 'same');
    t.ok('「この作業場所で」は作業場所が決まらなければ付け直さない（保存だけへ隠さない）。決まれば記憶に付いていた作業場所を先に使う',
      decide({ tier: 'workspace' }, {}, null).skip === 'workspaceUnknown' && decide({ tier: 'workspace' }, {}, '/repo/alpha').workspace === '/repo/alpha'
      && decide({ tier: 'workspace' }, { workspace: '/repo/beta' }, '/repo/alpha').workspace === '/repo/beta'
      && decide({ tier: 'workspace' }, { tier: 'workspace', workspace: '/repo/beta' }, null).skip === 'same');
    t.ok('「いつも」「保存だけ」へ移すとき、付いていた作業場所は残す（戻すときの手がかり）',
      decide({ tier: 'archive' }, { tier: 'workspace', workspace: '/repo/beta' }).workspace === '/repo/beta' && decide({ tier: 'always' }, {}).workspace === null);

    // ---- 部品を組み立てる
    async function fixture(label, { call = null, prefs = { backend: 'fake', memoryAutoLearn: true } } = {}) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `memory-nightly-${label}-`));
      roots.push(dir);
      const channels = createChannelService({ dir: path.join(dir, 'channels') });
      await channels.start();
      const memory = createMemoryService({ dataDir: dir, channels });
      await memory.start();
      const sessions = new Map();
      let serial = 0;
      const say = (sessionId, ...texts) => {
        const row = sessions.get(sessionId) ?? { messages: [], lastModified: 0 };
        for (const text of texts) row.messages.push({ role: 'user', uuid: `u${++serial}`, text, at: Date.now() });
        row.lastModified = Math.max(row.lastModified + 1, Date.now());
        sessions.set(sessionId, row);
      };
      const prompts = [];
      const host = {
        store: { getAll: async () => ({}), get: async (id) => (CWDS[id] ? { cwd: CWDS[id] } : {}), getPrefs: async () => prefs, setMeta: async () => {}, setMode: async () => {}, setModel: async () => {}, setSessionData: async () => {} },
        getBackend: (id) => (id === 'fake' ? fake : null), listBackends: () => [fake], resolveModel: async () => '', resolveEffort: async () => '',
        internalCall: async (req) => {
          prompts.push(req.prompt);
          const answer = call ? await call(req.prompt, prompts.length) : { memories: [] };
          return { text: JSON.stringify(answer), usage: null, callId: `call-${prompts.length}` };
        },
      };
      const learner = createMemoryLearner({ dataDir: dir, channels, bots: { get: async () => null }, memory, host, clock,
        readMessages: async (id) => sessions.get(id)?.messages ?? [], listSessions: async () => [...sessions].map(([id, row]) => ({ id, backend: 'fake', lastModified: row.lastModified })),
        workspaceOf: (cwd) => cwd });
      stack.push(async () => { learner.close(); memory.stop(); await channels.close(); });
      const add = (text, extra = {}) => memory.store.add({ layer: 'user', text, by: LEARNER, ...extra }).then((r) => r.entry);
      const byId = async (id) => (await memory.list({})).find((x) => x.id === id);
      const sentOf = (prompt) => JSON.parse(line(prompt, 'Existing memories: ') ?? '[]');
      return { dir, memory, learner, prompts, say, add, byId, sentOf };
    }

    // ---- 1 回の流れ: 選んだ分だけ渡す・段を付け直す・人の記憶と約束は触らない・全件で重複を調べる
    const alpha = { kind: 'message', sessionId: 's_alpha', messageId: 'x1', quote: 'pnpm を使う', at: 5 };
    let ids1;
    const a = await fixture('flow', { call: () => {
      return {
        memories: [
          { action: 'add', layer: 'user', kind: 'pref', text: 'ZZARCHIVEDZZ 保存だけに置いた古い記憶', sourceIndexes: [0] },   // 保存だけの記憶と同じ文（渡していないが、全件で重複と分かる）
          { action: 'add', layer: 'user', kind: 'pref', text: 'ZZFORGOTTENZZ 忘れた記憶', sourceIndexes: [0] },   // 忘れた記憶と同じ文
          { action: 'add', layer: 'user', kind: 'pref', text: '新しい記憶 ZZNEWZZ', sourceIndexes: [0] },
        ],
        tiers: [
          { id: ids1.l2, tier: 'workspace', reason: 'alpha だけの話' }, { id: ids1.l3, tier: 'archive', reason: '済みの件' },
          { id: ids1.h, tier: 'archive', reason: '人の行' }, { id: ids1.l1, tier: 'always', reason: '今のまま' },
          { id: ids1.archived, tier: 'always', reason: '渡していない行' }, { id: ids1.promise, tier: 'archive', reason: '約束' }, { id: 'zzz', tier: 'always' },
        ],
      };
    } });
    const l1 = await a.add('返事は短く、結論を最初に書く', { kind: 'pref', tier: 'always' });
    const l2 = await a.add('alpha では pnpm を使う', { tier: 'always', sources: [alpha] });
    const l3 = await a.add('古い一時メモ ZZOLDZZ', { tier: 'always' });
    const h = await a.add('人が書いた決まり ZZHUMANZZ', { by: HUMAN, tier: 'always' });
    const archived = await a.add('ZZARCHIVEDZZ 保存だけに置いた古い記憶', { by: HUMAN, tier: 'archive' });
    const wBeta = await a.add('beta だけの記憶 ZZBETAZZ', { by: HUMAN, tier: 'workspace', workspace: '/repo/beta' });
    const wAlpha = await a.add('alpha だけの記憶 ZZALPHAZZ', { by: HUMAN, tier: 'workspace', workspace: '/repo/alpha' });
    const untiered = await a.add('段の無い記憶 ZZUNTIEREDZZ');
    const promise = await a.add('見積もりを来週までに出す約束 ZZPROMISEZZ', { by: HUMAN, kind: 'promise' });
    const forgotten = await a.add('ZZFORGOTTENZZ 忘れた記憶', { by: HUMAN, tier: 'always' });
    await a.memory.forget({ id: forgotten.id }, HUMAN, {});
    ids1 = { l1: l1.id, l2: l2.id, l3: l3.id, h: h.id, archived: archived.id, promise: promise.id };
    const countOf = async (needle) => (await a.memory.list({})).filter((x) => x.text.includes(needle)).length;
    a.say('s_alpha', 'alpha の整理をお願いします');
    const run1 = await a.learner.runNow();
    t.ok('AI は 1 回だけ呼ぶ', a.prompts.length === 1, JSON.stringify(a.prompts.length));
    const sent1 = a.sentOf(a.prompts[0]);
    const sentIds1 = sent1.map((x) => x.id);
    t.ok('渡すのは「いつも」・読む作業場所の記憶・段の無い記憶だけ',
      [l1, l2, l3, h, wAlpha, untiered].every((x) => sentIds1.includes(x.id)), JSON.stringify(sent1.map((x) => x.text)));
    t.ok('保存だけ・約束・忘れた記憶・読まない作業場所の記憶は渡さない',
      !['ZZARCHIVEDZZ', 'ZZBETAZZ', 'ZZPROMISEZZ'].some((word) => a.prompts[0].includes(`"text":"${word}`) || sent1.some((x) => x.text.includes(word))) && !sent1.some((x) => x.text.includes('ZZFORGOTTENZZ') && x.id === forgotten.id));
    t.ok('渡す 1 件に重み・強さ・出どころは入らない', sent1.every((x) => Object.keys(x).every((k) => ['id', 'layer', 'text', 'kind', 'status', 'tier', 'workspace', 'by', 'origBy'].includes(k))) && !/"(weight|strength|sources)"/.test(line(a.prompts[0], 'Existing memories: ')));
    t.ok('指示に段の付け直し（tiers・20 件まで）と、作業場所はコードが決めることを書く',
      a.prompts[0].includes('"tiers"') && a.prompts[0].includes(`at most ${NIGHTLY_TIER_CHANGES} tier changes`) && a.prompts[0].includes('the code decides it'));
    const after = { l1: await a.byId(l1.id), l2: await a.byId(l2.id), l3: await a.byId(l3.id), h: await a.byId(h.id), archived: await a.byId(archived.id), promise: await a.byId(promise.id) };
    t.ok('段を付け直した件数は 2（作業場所へ・保存だけへ）。結果にも残る', run1.retiered === 2 && (await a.learner.status()).lastResult.retiered === 2, JSON.stringify(run1));
    t.ok('「この作業場所で」へ付けた記憶には、出どころの会話から決めた正規の作業場所が付く', after.l2.tier === 'workspace' && after.l2.workspace === '/repo/alpha');
    t.ok('保存だけへ付け直した', after.l3.tier === 'archive');
    t.ok('人が書いた記憶・今と同じ段・渡していない記憶・約束は動かない',
      after.h.tier === 'always' && after.l1.tier === 'always' && after.archived.tier === 'archive' && after.promise.tier === undefined && after.promise.kind === 'promise');
    t.ok('本文・by・updatedAt は付け直しで動かない（AI が書いた行のまま）',
      [[l2, after.l2], [l3, after.l3]].every(([before, now]) => now.text === before.text && now.updatedAt === before.updatedAt && now.by.kind === 'bot' && now.by.botId === 'b_learner'));
    t.ok('新しい記憶は 1 件だけ書く（同じ文・忘れた記憶は全件の検査で断る。渡していなくても重複にならない）',
      run1.changed === 1 && await countOf('ZZNEWZZ') === 1 && await countOf('ZZARCHIVEDZZ') === 1 && await countOf('ZZFORGOTTENZZ') === 0, JSON.stringify({ changed: run1.changed }));
    const logs = a.memory.store.recordsSince(0).filter((r) => /^nightly:\d{4}-\d{2}-\d{2}$/.test(r.migration ?? ''));
    t.ok('変更記録にその日の印（nightly:<日付>）・付け直した者（learner）・前後（place）・理由が残る',
      logs.length === 2 && logs.every((r) => r.by?.kind === 'bot' && r.by.botId === 'b_learner' && r.place?.to?.tier && r.reason)
      && logs.find((r) => r.id === l2.id).place.to.workspace === '/repo/alpha' && logs.find((r) => r.id === l3.id).place.from.tier === 'always', JSON.stringify(logs));
    const placements = await a.memory.placements(logs[0].migration);
    t.ok('記録から前後が分かり、そのまま戻せる',
      placements.length === 2 && (await a.memory.place({ id: l3.id, tier: placements.find((p) => p.id === l3.id).from.tier ?? null, reason: 'undo', expect: { tier: 'archive' } })).placed === true && (await a.byId(l3.id)).tier === 'always');

    // ---- 人が選んだ段は付け直さない（人が後から直した記憶を AI が戻さない）
    // 人が l1 の段を「この作業場所で」に直した。次の回の AI は同じ答え（l1 を「いつも」へ・l3 を保存だけへ・人の行を保存だけへ）を返す
    await a.memory.place({ id: l1.id, tier: 'workspace', workspace: '/repo/alpha', by: HUMAN, reason: '人が選んだ' });
    a.say('s_alpha', '次の発言です。もう一度整理をお願いします');
    const run2 = await a.learner.runNow();
    t.ok('2 回目は l3 だけ付け直す（人が選んだ l1・人が書いた行・今と同じ段は付け直さない）', run2.retiered === 1 && (await a.byId(l3.id)).tier === 'archive', JSON.stringify(run2));
    t.ok('人が選んだ段は、その後の夜の整理が戻さない（変更記録にも learner の付け直しは残らない）',
      (await a.byId(l1.id)).tier === 'workspace' && !a.memory.store.recordsSince(0).some((r) => r.id === l1.id && r.place && r.by?.botId === 'b_learner'));
    t.ok('同じ文は 2 回目も重複で断る（新しい記憶は増えない）', run2.changed === 0 && await countOf('ZZNEWZZ') === 1);

    // ---- 1 回の実行で付け直すのは 20 件まで（束をまたいで）・次の実行は新しく数える
    const cap = await fixture('cap', { call: (prompt, n) => ({ memories: [], tiers: cap.sentOf(prompt).filter((x) => x.text.startsWith('整理対象')).map((x) => ({ id: x.id, tier: 'archive', reason: '古い' })) }) });
    const targets = [];
    for (let i = 0; i < 25; i++) targets.push(await cap.add(`整理対象 ${i} の記憶`, { tier: 'always' }));
    for (let i = 0; i < 45; i++) cap.say('s_alpha', `発言 ${i}`);   // 40 件を超えるので 2 回の呼び出しに分かれる
    const capRun = await cap.learner.runNow();
    const archivedNow = async () => (await cap.memory.list({})).filter((x) => x.text.startsWith('整理対象') && x.tier === 'archive').length;
    t.ok('2 回の呼び出し（束）にまたがっても付け直しは 20 件まで', cap.prompts.length === 2 && capRun.retiered === NIGHTLY_TIER_CHANGES && await archivedNow() === NIGHTLY_TIER_CHANGES, JSON.stringify({ calls: cap.prompts.length, capRun }));
    t.ok('枠を使い切った後の呼び出しには tiers の指示を付けない（残りの枠が分かる）',
      cap.prompts[0].includes(`at most ${NIGHTLY_TIER_CHANGES} tier changes`) && !cap.prompts[1].includes('tier changes') && !cap.prompts[1].includes('"tiers"'));
    cap.say('s_alpha', '次の回の発言');
    const capNext = await cap.learner.runNow();
    t.ok('次の実行は枠を数え直す（残りの 5 件）', capNext.retiered === targets.length - NIGHTLY_TIER_CHANGES && await archivedNow() === targets.length, JSON.stringify(capNext));
    t.ok('結果に付け直した数が残る', (await cap.learner.status()).lastResult.retiered === targets.length - NIGHTLY_TIER_CHANGES);

    // ---- 大量の記憶でも 1 回の入力は 40,000 トークン未満・記憶の分は 12,000 トークンまで
    const big = await fixture('big', { call: () => ({ memories: [] }) });
    for (let i = 0; i < 300; i++) await big.add(`大量の記憶 ${i} ${'あ'.repeat(200)}`, { by: HUMAN, tier: 'always' });
    for (let i = 0; i < 40; i++) big.say('s_alpha', `${'長い発言です。'.repeat(300)} ${i}`);   // 本文は 1 件 2,000 字までに切る
    await big.learner.runNow();
    const bigPrompt = big.prompts[0];
    const bigSent = big.sentOf(bigPrompt);
    t.ok(`渡した記憶は 300 件のうち一部だけ・記憶の分は ${NIGHTLY_MEMORY_TOKENS} トークンまで`,
      bigSent.length > 0 && bigSent.length < 300 && estimateTokens(JSON.stringify(bigSent)) <= NIGHTLY_MEMORY_TOKENS, JSON.stringify({ n: bigSent.length, tokens: estimateTokens(JSON.stringify(bigSent)) }));
    t.ok(`1 回の入力全体（指示・発言・記憶）は ${NIGHTLY_INPUT_TOKENS} トークン未満`, estimateTokens(bigPrompt) < NIGHTLY_INPUT_TOKENS, String(estimateTokens(bigPrompt)));
  } finally {
    for (const close of stack.reverse()) await close().catch(() => {});
    clearInterval(keepAlive);
    for (const dir of roots) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}
