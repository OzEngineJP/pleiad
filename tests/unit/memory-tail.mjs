// ターンの末尾の文（core/memory/tail.mjs・service.turnContext。ADR 0110）: 時刻・記憶の差分（rev）・関係する記憶・渡し済みを繰り返さない・
// 核の写しは会話の始まりと圧縮の後だけ・時刻は末尾だけ。sidecar の memRev・snapshotDue・delivered を使う。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMemoryService } from '../../core/memory/service.mjs';
import {
  foldDelta, pickCore, pickTieredCore, coreFitCounts, fitEntries, clipEntry, sameWorkspace, coreSnapshot, turnContext, formatNow,
  DELTA_MAX, RELATED_MAX, RELATED_ITEM_TOKENS, RELATED_TOTAL_TOKENS, SEARCH_MAX, SEARCH_TOTAL_TOKENS, CORE_ALWAYS_TOKENS, CORE_WORKSPACE_TOKENS,
} from '../../core/memory/tail.mjs';
import { splitLeadingNotes } from '../../core/system-messages.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';

export const name = 'memory-tail';
export const title = '毎ターンの末尾: 時刻・記憶の差分・関係する記憶・渡し済みを繰り返さない・核の写しは始まりと圧縮の後だけ';

const BOT = { id: 'b_owl12345' };
const OTHER = 'b_fox98765';
const HUMAN = { kind: 'human' };
const AT = new Date(2026, 9, 3, 10, 41).getTime();

const CORE_TAG = '<pleiad-memory-core>';
const TURN_TAG = '<pleiad-turn-context>';
const hasCore = (notes) => notes.some((n) => n.startsWith(CORE_TAG));
const turnNote = (notes) => notes.find((n) => n.startsWith(TURN_TAG)) ?? '';

export default async function (t) {
  // ---- 純関数
  t.ok('formatNow は分までの現地時刻・UTC からのずれ・曜日', /^2026-10-03 10:41 [+-]\d\d:\d\d \(.+\)$/.test(formatNow(AT, 'ja')) && !/:\d\d:\d\d/.test(formatNow(AT, 'en').replace(/[+-]\d\d:\d\d/, '')));
  const rec = (rev, op, id, text, extra = {}) => ({ rev, op, layer: 'user', id, text, ...extra });
  t.ok('foldDelta は同じ id の変更を 1 つにたたむ（追加→直し は追加・本文は最後）', (() => {
    const { items } = foldDelta([rec(1, 'add', 'm_a', 'あ'), rec(2, 'edit', 'm_a', 'あい')]);
    return items.length === 1 && items[0].kind === 'add' && items[0].text === 'あい';
  })());
  t.ok('foldDelta は範囲の中で作って消したものを出さない', foldDelta([rec(1, 'add', 'm_a', 'あ'), rec(2, 'forget', 'm_a', 'あ')]).items.length === 0);
  t.ok('foldDelta は前から在った記憶の forget・edit をそのまま出す', (() => {
    const { items } = foldDelta([rec(5, 'edit', 'm_a', 'い'), rec(6, 'forget', 'm_b', 'う')]);
    return items.map((x) => x.kind).join() === 'edit,forget';
  })());
  t.ok('foldDelta は自分の会話が書いた記憶（via）を出さず「渡した扱い」にする。忘却は出す', (() => {
    const { items, skipped } = foldDelta([rec(1, 'add', 'm_a', 'あ', { via: 's1' }), rec(2, 'forget', 'm_b', 'い', { via: 's1' })], { skipVia: 's1' });
    return items.length === 1 && items[0].kind === 'forget' && skipped.join() === 'm_a';
  })());
  // S-8: 核の写しは、人が書いた・直した記憶を先に入れる（bot が書いたものの新しさで押し出さない）
  t.ok('S-8: pickCore は人が書いた古い記憶を、bot が書いた新しい記憶より先に入れる（目安が足りないとき押し出されるのは bot の分）', (() => {
    const e = (id, by, updatedAt, text = 'あ'.repeat(40)) => ({ id, layer: 'user', text, by, at: updatedAt, updatedAt, sources: [] });
    const human = [e('m_h1', HUMAN, 10), e('m_h2', HUMAN, 20)];
    const bots = Array.from({ length: 30 }, (_, i) => e(`m_b${i}`, { kind: 'bot', botId: OTHER }, 1000 + i));
    const picked = pickCore([...human, ...bots], [], { layerTokens: 160 });
    return picked.user.some((x) => x.id === 'm_h1') && picked.user.some((x) => x.id === 'm_h2') && picked.omitted > 0 && picked.user.length < 32;
  })());
  t.ok('S-8: 人が書いた記憶が目安を超えるときは、その中で新しい順（bot の分は入らない）', (() => {
    const e = (id, by, updatedAt) => ({ id, layer: 'user', text: 'あ'.repeat(40), by, at: updatedAt, updatedAt, sources: [] });
    const picked = pickCore([e('m_old', HUMAN, 1), e('m_new', HUMAN, 9), e('m_bot', { kind: 'bot', botId: OTHER }, 99)], [], { layerTokens: 1 });
    return picked.user.map((x) => x.id).join() === 'm_new' && picked.omitted === 2;
  })());
  t.ok('S-8: AI が書き換えた行は by が AI になるので、人の行としては先に入らない', (() => {
    const e = (id, by, updatedAt) => ({ id, layer: 'user', text: 'あ'.repeat(40), by, at: updatedAt, updatedAt, sources: [] });
    const picked = pickCore([e('m_rewritten', { kind: 'bot', botId: OTHER }, 1), e('m_human', HUMAN, 2)], [], { layerTokens: 1 });
    return picked.user.length === 1 && picked.user[0].id === 'm_human';
  })());
  t.ok('foldDelta は層で絞る', foldDelta([rec(1, 'add', 'm_a', 'あ', { layer: OTHER })], { layers: ['user', BOT.id] }).items.length === 0);
  t.ok('pickCore は新しいものから目安のトークンまで入れ、残りは件数にする', (() => {
    const list = Array.from({ length: 30 }, (_, i) => ({ id: `m_${i}`, text: `${'長い記憶 '.repeat(20)}${i}`, at: i, updatedAt: i }));
    const core = pickCore(list, [], { layerTokens: 400, now: 30 });
    return core.user.length < 30 && core.omitted === 30 - core.user.length && core.user.at(-1).id === 'm_29' && core.ids.length === core.user.length;
  })());
  t.ok('記憶が 1 つも無ければ核の写しは作らない（空の包みを足さない）', coreSnapshot({ core: { user: [], bot: [], omitted: 0 }, locale: 'ja' }) === null);
  t.ok('末尾は件数とトークン数を制限し、残りは検索へ案内する', (() => {
    const delta = Array.from({ length: DELTA_MAX + 7 }, (_, i) => ({ kind: 'add', layer: 'user', id: `m_${i}`, text: `記憶${i}` }));
    const text = turnContext({ now: AT, delta, locale: 'ja' });
    return text.includes('記憶26') && !text.includes('記憶0\n') && text.includes('memory.search') && estimateTokens(text) <= 300;
  })());
  t.ok('関連候補は自動では添えない', (() => {
    const related = Array.from({ length: 9 }, (_, i) => ({ text: `関係${i}` }));
    return (turnContext({ now: AT, related, locale: 'ja' }).match(/関係\d/g) ?? []).length === 0;
  })());

  // ---- 段 2 単位 3: 段と作業場所で配送する（pickTieredCore・fitEntries・coreFitCounts・関係する記憶の上限）
  const ent = (id, extra = {}) => ({ id, layer: 'user', text: 'あ'.repeat(40), by: HUMAN, at: 1, updatedAt: 1, sources: [], ...extra });
  const WS = 'D:/dev/app', WS_OTHER = 'D:/dev/other';
  t.ok('配送の上限: 全体 400・この作業場所 800 トークン', CORE_ALWAYS_TOKENS === 400 && CORE_WORKSPACE_TOKENS === 800);
  t.ok('pickTieredCore: 段の無い記憶は自動配送の対象外', (() => {
    const list = Array.from({ length: 30 }, (_, i) => ent(`m_${i}`, { text: `${'長い記憶 '.repeat(20)}${i}`, at: i, updatedAt: i }));
    const tiered = pickTieredCore(list, []);
    return tiered.ids.length === 0 && tiered.omitted === 0;
  })());
  t.ok('pickTieredCore: 全体は400トークンまで・今の作業場所は800トークンまで・保存だけ（archive）は入れない', (() => {
    const list = [
      ...Array.from({ length: 3 }, (_, i) => ent(`m_a${i}`, { tier: 'always', text: 'あ'.repeat(170), updatedAt: 10 + i })),
      ...Array.from({ length: 2 }, (_, i) => ent(`m_w${i}`, { tier: 'workspace', workspace: WS, text: 'い'.repeat(450), updatedAt: 10 + i })),
      ent('m_arc', { tier: 'archive', updatedAt: 99 }),
    ];
    const core = pickTieredCore(list, [], { workspace: WS, now: 100 });
    const ids = core.ids;
    return ids.filter((id) => id.startsWith('m_a') && id !== 'm_arc').length === 2 && ids.filter((id) => id.startsWith('m_w')).length === 1 && !ids.includes('m_arc')
      && core.omittedByTier.always === 1 && core.omittedByTier.workspace === 1 && core.omittedByTier.untiered === 0 && core.omitted === 2;
  })());
  t.ok('pickTieredCore: 上限を超えるときは 人が書いた・直したもの → 新しい更新の順', (() => {
    const bot = { kind: 'bot', botId: OTHER };
    const list = [
      ent('m_botnew', { tier: 'always', by: bot, updatedAt: 90, text: 'う'.repeat(100) }),
      ent('m_stop', { tier: 'always', by: bot, kind: 'stop', updatedAt: 10, text: 'え'.repeat(100) }),
      ent('m_humanold', { tier: 'always', by: HUMAN, updatedAt: 1, text: 'お'.repeat(100) }),
      ent('m_rewritten', { tier: 'always', by: bot, origBy: HUMAN, updatedAt: 95, text: 'か'.repeat(100) }),   // 人の行を AI が直した行は人の行として先に入れる
      ent('m_botold', { tier: 'always', by: bot, updatedAt: 5, text: 'き'.repeat(100) }),
    ];
    const core = pickTieredCore(list, [], { now: 100, alwaysTokens: 220 });   // 1 件 103 → 2 件まで
    const ids = core.ids.slice().sort();
    const first = pickTieredCore(list, [], { now: 100, alwaysTokens: 340 }).ids.slice().sort();   // 3 件まで
    return ids.join() === ['m_humanold', 'm_rewritten'].sort().join() && first.join() === ['m_humanold', 'm_rewritten', 'm_botnew'].sort().join() && core.omittedByTier.always === 3;
  })());
  t.ok('pickTieredCore: 作業場所が違う・作業場所の無い会話は workspace を渡さず、入りきらなかった数にも入れない（inactiveWorkspace に数える）', (() => {
    const list = [ent('m_ws', { tier: 'workspace', workspace: WS }), ent('m_ws2', { tier: 'workspace', workspace: WS_OTHER }), ent('m_al', { tier: 'always' })];
    const here = pickTieredCore(list, [], { workspace: WS, now: 100 });
    const other = pickTieredCore(list, [], { workspace: WS_OTHER, now: 100 });
    const none = pickTieredCore(list, [], { workspace: null, now: 100 });
    return here.ids.sort().join() === 'm_al,m_ws' && other.ids.sort().join() === 'm_al,m_ws2' && none.ids.join() === 'm_al'
      && here.inactiveWorkspace === 1 && none.inactiveWorkspace === 2 && here.omitted === 0 && none.omitted === 0;
  })());
  t.ok('pickTieredCore: 作業場所は \\ と末尾の / を揃えて比べる・どちらかが空なら同じではない', sameWorkspace('D:\\dev\\app\\', 'D:/dev/app') && !sameWorkspace('', '') && !sameWorkspace(null, WS) && !sameWorkspace(WS, WS_OTHER));
  t.ok('pickTieredCore: 段の付いた記憶は薄れの仕組みで落とさない（古くて人の行でなくても、上限の中なら入る）', (() => {
    const old = ent('m_old', { tier: 'always', by: { kind: 'bot', botId: OTHER }, at: 1, updatedAt: 1, text: '古い記憶' });
    return pickTieredCore([old], [], { now: Date.now() + 5 * 365 * 24 * 3600 * 1000 }).ids.includes('m_old');
  })());
  t.ok('pickTieredCore: 自分の層（bot）の記憶も同じ規則で入り、層ごとの本文に分かれる', (() => {
    const core = pickTieredCore([ent('m_u', { tier: 'always' })], [ent('m_b', { tier: 'always', layer: 'b_owl12345' })], { now: 100 });
    return core.user.map((e) => e.id).join() === 'm_u' && core.bot.map((e) => e.id).join() === 'm_b';
  })());
  t.ok('coreFitCounts: 入りきらなかった数を段ごとに返す（作業場所を省くと作業場所ごとの合計。保存だけは数えない）', (() => {
    const mk = (n, ws, i0) => Array.from({ length: n }, (_, i) => ent(`m_${ws}_${i0 + i}`, { tier: 'workspace', workspace: ws, text: 'あ'.repeat(450), updatedAt: i0 + i }));
    const list = [...mk(2, WS, 0), ...mk(3, WS_OTHER, 10), ent('m_arc', { tier: 'archive' })];
    const all = coreFitCounts(list, [], { now: 100 });
    const here = coreFitCounts(list, [], { workspace: WS, now: 100 });
    return all.omitted.workspace === 1 + 2 && all.omitted.always === 0 && all.omitted.untiered === 0 && all.total === 3 && all.inactiveWorkspace === 0
      && here.omitted.workspace === 1 && here.inactiveWorkspace === 3 && here.total === 1;
  })());
  t.ok('fitEntries: 件数・1 件・合計の上限（1 件は切る・合計を超える件から後は出さない・順位は保つ）', (() => {
    const list = [{ id: 'a', text: 'あ'.repeat(400) }, { id: 'b', text: 'い'.repeat(100) }, { id: 'c', text: 'う'.repeat(100) }, { id: 'd', text: 'え'.repeat(10) }];
    const out = fitEntries(list, { max: 3, perItem: 150, total: 280 });
    return out.map((e) => e.id).join() === 'a,b' && out[0].text.endsWith('…') && estimateTokens(out[0].text) <= 150 && out[1].text === 'い'.repeat(100)
      && fitEntries(list, { max: 1, perItem: 1000, total: 10000 }).length === 1 && fitEntries([], { max: 3, perItem: 1, total: 1 }).length === 0;
  })());
  t.ok('clipEntry: 収まる本文は触らない・収まらなければ … で切る', (() => {
    const short = { id: 'a', text: '短い' };
    return clipEntry(short, 150) === short && clipEntry({ id: 'b', text: 'あ'.repeat(500) }, 150).text.endsWith('…') && estimateTokens(clipEntry({ id: 'b', text: 'あ'.repeat(500) }, 150).text) <= 150;
  })());
  t.ok('長い差分を含めても末尾は300トークン以内', (() => {
    const long = Array.from({ length: 5 }, (_, i) => ({ kind: 'add', layer: 'user', text: `長い記憶${i}${'あ'.repeat(1000)}` }));
    const text = turnContext({ now: AT, delta: long, locale: 'ja' });
    return estimateTokens(text) <= 300 && !text.includes('長い記憶') && text.includes('memory.search');
  })());
  t.ok('memory.search の上限: 8 件・合計 1200 トークン', SEARCH_MAX === 8 && SEARCH_TOTAL_TOKENS === 1200);

  // ---- サービス: 時刻・核・差分・関係する記憶
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-tail-'));
  try {
    const svc = createMemoryService({ dataDir: dir });
    await svc.start();
    const ask = (session, incomingText = '', extra = {}) => svc.turnContext({ bot: BOT, session, incomingText, now: AT, locale: 'ja', ...extra });

    // 記憶が空の会話の始まり
    const empty = await ask({ snapshotDue: true, memRev: 0, delivered: [] });
    t.ok('記憶が無い始まりは、核の写しが無く、時刻だけの末尾', !hasCore(empty.notes) && empty.notes.length === 1 && turnNote(empty.notes).includes('今の時刻: 2026-10-03 10:41') && empty.snapshotDue === false && empty.memRev === 0);

    await svc.write({ layer: 'user', tier: 'always', text: 'PR は小さく、テストを先に書く' }, HUMAN);
    await svc.write({ layer: 'user', tier: 'always', text: 'acme-web の本番デプロイは金曜に出さない', why: '週末に障害を持ち越さないため' }, HUMAN);
    await svc.write({ layer: BOT.id, tier: 'always', text: '返事の最後に次の一手を 1 つ書く' }, HUMAN);
    await svc.write({ layer: OTHER, tier: 'always', text: 'フォックスだけの記憶 キツネの話' }, HUMAN);

    const start = await ask({ snapshotDue: true, memRev: 0, delivered: [] }, 'こんにちは');
    const [core, turn] = start.notes;
    t.ok('会話の始まりは核の写し（<pleiad-memory-core>）と末尾（<pleiad-turn-context>）の順', start.notes.length === 2 && core.startsWith(CORE_TAG) && turn.startsWith(TURN_TAG));
    t.ok('核の写しは user 層と自分の層の記憶を持ち、ほかの bot の層は持たない', core.includes('PR は小さく') && core.includes('金曜に出さない') && core.includes('次の一手') && !core.includes('キツネ'));
    t.ok('核の写しに時刻は入れない（時刻は末尾だけ）', !/\d{4}-\d\d-\d\d \d\d:\d\d/.test(core) && /今の時刻/.test(turn) && !/今の時刻/.test(core));
    t.ok('始まりの末尾に差分は付けない（核の写しが今の全体）', !turn.includes('記憶が変わりました'));
    t.ok('返りは sidecar へ書き戻す値: memRev は今の rev・delivered は核の記憶・snapshotDue は false', start.memRev === svc.rev() && start.delivered.length === 3 && start.snapshotDue === false);

    // 次のターン: 核は出さない・差分なし
    const t2 = await ask({ snapshotDue: false, memRev: start.memRev, delivered: start.delivered }, 'テストの書き方を教えて');
    t.ok('次のターンは核の写しを繰り返さない（末尾だけ）', !hasCore(t2.notes) && t2.notes.length === 1 && turnNote(t2.notes).startsWith(TURN_TAG));
    t.ok('差分が無ければ「変わりました」は書かない', !turnNote(t2.notes).includes('記憶が変わりました'));
    t.ok('渡し済みの記憶は「関係する記憶」で繰り返さない', !turnNote(t2.notes).includes('PR は小さく') && t2.delivered.length === start.delivered.length);

    // 差分: 別の会話・人が記憶を足した
    const added = await svc.write({ layer: 'user', tier: 'always', text: '会議は 15 分で切り上げる' }, HUMAN, { sessionId: 'other-session' });
    await svc.write({ layer: OTHER, text: 'フォックスの層に足した' }, HUMAN);
    const t3 = await ask({ snapshotDue: false, memRev: t2.memRev, delivered: t2.delivered }, '今日の予定');
    t.ok('前のターンからの追加が末尾の差分で届く（自分の層・user 層だけ）', turnNote(t3.notes).includes('記憶が変わりました') && turnNote(t3.notes).includes('追加（ユーザーについて）: 会議は 15 分で切り上げる') && !turnNote(t3.notes).includes('フォックスの層'));
    t.ok('差分は memRev を進め、次のターンでは繰り返さない', t3.memRev === svc.rev() && !turnNote((await ask({ snapshotDue: false, memRev: t3.memRev, delivered: t3.delivered }, '今日の予定')).notes).includes('会議は 15 分'));
    t.ok('届けた差分の id は delivered に入る', t3.delivered.includes(added.id));

    // 自分の会話が書いた記憶は差分で返さない
    const mine = await svc.write({ layer: BOT.id, tier: 'always', text: '自分で覚えたメモ' }, HUMAN, { sessionId: 'my-session' });
    const t4 = await ask({ snapshotDue: false, memRev: t3.memRev, delivered: t3.delivered }, 'ありがとう', { sessionId: 'my-session' });
    t.ok('同じ会話が書いた記憶は差分に出さない（履歴に tool の結果がある）が、渡した扱いにする', !turnNote(t4.notes).includes('自分で覚えたメモ') && t4.delivered.includes(mine.id) && t4.memRev === svc.rev());
    const t4b = await ask({ snapshotDue: false, memRev: t3.memRev, delivered: t3.delivered }, 'ありがとう', { sessionId: 'another-session' });
    t.ok('別の会話には同じ記憶が差分で届く', turnNote(t4b.notes).includes('自分で覚えたメモ'));

    // 直し・忘却
    await svc.edit({ id: added.id, text: '会議は 30 分で切り上げる' }, HUMAN);
    const tEdit = await ask({ snapshotDue: false, memRev: t4.memRev, delivered: t4.delivered }, '予定');
    t.ok('記憶の直しは「直した」で届く', turnNote(tEdit.notes).includes('直した（ユーザーについて）: 会議は 30 分で切り上げる'));
    await svc.forget({ id: added.id }, HUMAN);
    const tForget = await ask({ snapshotDue: false, memRev: tEdit.memRev, delivered: tEdit.delivered }, '予定');
    t.ok('忘却は「忘れた」で届く', turnNote(tForget.notes).includes('忘れた（ユーザーについて）: 会議は 30 分で切り上げる'));
    const created = await svc.write({ layer: 'user', text: 'すぐ消すメモ' }, HUMAN);
    await svc.forget({ id: created.id }, HUMAN);
    t.ok('渡す前に作って消した記憶は、出さない', !turnNote((await ask({ snapshotDue: false, memRev: tForget.memRev, delivered: tForget.delivered }, '予定')).notes).includes('すぐ消すメモ'));

    // 関係する記憶（渡し済みを除く・自分の層と user 層だけ）
    const fresh = { snapshotDue: false, memRev: svc.rev(), delivered: [] };
    const rel = await ask(fresh, 'acme-web の本番デプロイの手順を見直したい');
    t.ok('関係する記憶は末尾へ自動で付けない', !turnNote(rel.notes).includes('この話に関係する記憶:') && !turnNote(rel.notes).includes('acme-web の本番デプロイは金曜に出さない'));
    t.ok('自動配送対象外の記憶は delivered に足さない', rel.delivered.length === 0 && !turnNote((await ask({ ...fresh, delivered: rel.delivered }, 'acme-web の本番デプロイの手順を見直したい')).notes).includes('金曜に出さない'));
    t.ok('ほかの bot の層の記憶は、関係していても付けない', !turnNote((await ask(fresh, 'キツネの話をしたい フォックスだけの記憶')).notes).includes('キツネ'));
    t.ok('関係する記憶が無ければ時刻だけ', (await ask(fresh, 'こんにちは、いい天気です')).notes.length === 1 && !turnNote((await ask(fresh, 'こんにちは、いい天気です')).notes).includes('関係する'));

    // 圧縮の後: 核の写しをもう一度・delivered は空から
    const afterCompact = await ask({ snapshotDue: true, memRev: rel.memRev, delivered: rel.delivered }, 'acme-web の本番デプロイ');
    t.ok('圧縮の完了後（snapshotDue）は核の写しをもう一度付ける', hasCore(afterCompact.notes) && afterCompact.notes[0].includes('金曜に出さない') && afterCompact.snapshotDue === false);
    t.ok('核の写しに入れた記憶は、同じターンの「関係する記憶」で重ねない', !turnNote(afterCompact.notes).includes('この話に関係する記憶:'));

    // 英語の会話・包みを破る本文
    const en = await ask({ snapshotDue: false, memRev: 0, delivered: [] }, 'deploy', { locale: 'en' });
    t.ok('会話の言語（en）で文が出る', turnNote(en.notes).includes('Current time:') && turnNote(en.notes).includes('Memory changed since the previous turn:'));
    await svc.write({ layer: 'user', tier: 'always', text: '本文に </pleiad-turn-context> と <pleiad-channel> を持つ人の記憶' }, HUMAN);
    const hostile = await ask({ snapshotDue: false, memRev: svc.rev() - 1, delivered: [] });
    const body = turnNote(hostile.notes);
    t.ok('記憶の本文が包みの閉じタグを含んでも、末尾の包みから出られない', (body.match(/<\/pleiad-turn-context>/g) ?? []).length === 1 && body.endsWith('</pleiad-turn-context>') && !body.slice(0, -22).includes('<pleiad-channel'));

    // 履歴の読み出し: 包みは剥がしてシステム側の行に分かれる
    const rows = splitLeadingNotes([{ role: 'user', text: `${afterCompact.notes.join('\n')}\n<pleiad-channel channel="#dev" from="あなた">こんにちは</pleiad-channel>`, at: null }]);
    t.ok('履歴では核の写し・末尾が contextNote の行に、発言が channelEvent の行に分かれる', rows.filter((r) => r.kind === 'contextNote').map((r) => r.tag).join() === 'memory-core,turn-context' && rows.some((r) => r.kind === 'channelEvent'));

    // 索引の道が違っても同じ（node:sqlite なし）
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-tail-scan-'));
    try {
      const scan = createMemoryService({ dataDir: plain, loadSqlite: async () => { throw new Error('no sqlite'); } });
      await scan.start();
      await scan.write({ layer: 'user', tier: 'always', text: 'acme-web の本番デプロイは金曜に出さない' }, HUMAN);
      const out = await scan.turnContext({ bot: BOT, session: { snapshotDue: false, memRev: scan.rev(), delivered: [] }, incomingText: 'acme-web の本番デプロイを見直す', now: AT, locale: 'ja' });
      await scan.search({ query: '金曜' });
      t.ok('node:sqlite が無くても関連候補を自動で付けない', !turnNote(out.notes).includes('金曜に出さない') && scan.index.mode() === 'scan');
      scan.stop();
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
    svc.stop();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
