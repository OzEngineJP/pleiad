// bot の記憶（S3。ADR 0110）。正本は store.mjs の markdown、索引は index.mjs、ターンの末尾の文は tail.mjs、出どころの検査は guard.mjs。
// 夜の整理（学習）は P3 の core/memory/learn.mjs。core/ops/memory.mjs の handler は `ctx.memory` としてこれを呼ぶ。
// 形の正本は core/channels/types.mjs の MemoryEntry、置き場は <data>/memory/（types.mjs の冒頭）。
//
// createMemoryService({ dataDir, channels?, emit, now, localeOf?, loadSqlite?, log? }) → MemoryService
//   dataDir … <data>。記憶は <dataDir>/memory/ に置く
//   channels … ChannelService（出どころの投稿を引く）。無ければ post の出どころは確かめられない
//   emit … memoryChanged { layer, rev } を出す
//   localeOf() … 記憶の markdown の見出しの言語（既定 ja。会話の言語ではなく PC の言語）
//   loadSqlite … index.mjs へ（テストで node:sqlite を読み込めない状態を差し込む）
//
// MemoryService（author は types.mjs の Author。ctx は { sessions, sessionId, locale }）:
//   start(): Promise<void>・stop(): void
//   list({ layer }): Promise<MemoryEntry[]>                       … layer は 'user' か botId。ファイルの順。各行に今の強さ strength と faded（核の写しに入らない）を付ける
//   get({ id }): Promise<MemoryEntry|null>
//   search({ query, layer?, layers?, limit }): Promise<MemoryEntry[]>   … 8 件・各 150 トークン・合計 1200 トークンまで。layer 省略なら layers（無ければ全層）。保存だけ（tier = archive）は出さない（list には出る）。
//       ほかの作業場所の記憶は引ける（会話へ自動で渡すものとは違う）
//   coreFit({ layer?, workspace? }): Promise<{ layer, workspace, omitted: { untiered, always, workspace }, total, inactiveWorkspace }>
//       … 会話の始まりに入りきらない記憶の件数（MCP・CLI 用。設定画面は出さない）。layer は user（既定。user だけ）か bot の id（その bot と user を合わせて）。
//         workspace を省くと、作業場所ごとに見て入りきらなかった数の合計
//   write({ layer, text, why?, sources, kind?, weight?, status?, tier?, workspace? }, author, ctx): Promise<MemoryEntry>   … 出どころの検査（MEMORY_SOURCE・MEMORY_REJECTED）はここ。
//       kind・weight・status は記憶の種類・重み・状態（strength.mjs。ADR 0118）。AI の重み 3 は guard.capWeight が根拠を見て 2 に抑える
//       tier・workspace は段と作業場所（store.mjs）。省いたときの既定: 人は always。bot・AI は ctx.sessionCwd（会話の cwd）に git の本体があれば
//       workspace + その場所、無ければ always。tier=workspace で場所が決まらなければ MEMORY_REJECTED（workspaceUnknown）。workspace だけ渡せば tier は workspace
//   edit({ id, text?, why?, sources?, kind?, weight?, status?, tier?, workspace? }, author, ctx): Promise<MemoryEntry>・forget({ id }, author, ctx): Promise<MemoryEntry>・unforget({ id }, author, ctx): Promise<MemoryEntry>
//       … edit の workspace は null で外せる。tier・workspace だけの直しは updatedAt を進めない
//       … 人も AI も使える（edit は write、forget は guarded）。誰がしたかは log.jsonl の by に残す。無い id は MEMORY_NOT_FOUND
//       … 約束（kind = promise）は人以外は書けない（write・直した結果が約束になる edit は MEMORY_REJECTED: promiseTodo / promiseLoop。ctx.hasTodos が真なら ToDo へ、
//         偽なら気がかりへ置くよう返す。service は断るだけで、実際に置くのは core/ops/memory.mjs の memory.write（redirectPromise）。
//         段だけ archive へ寄せる直しは通す）。段の無い既存の約束は、最初の読み込みでコードが保存だけ（archive）にする
//         （archiveLegacyPromises。AI なし・updatedAt 据え置き・記録に migration を残す・段を外しても再度は行わない）
//   place({ id, tier?, workspace?, reason?, migration?, expect?, by?, unlessHumanPlaced? }): Promise<{ placed, entry?, reason? }>
//       … コードが段・作業場所だけを付け替える（夜の整理の最後の振り分けとその取り消し。core/memory/learn.mjs の sortNight・sortUndo）。null・省略で外す。
//         本文・出どころ・強さ・updatedAt には触れず、by は既定でシステム。expect（今の { tier?, workspace? }）を渡すと、今もそのままのときだけ直す（人が後から直した記憶を上書きしない）。
//         unlessHumanPlaced を真にすると、段・作業場所を最後に変えたのが人の記憶には触れない（夜の整理が使う）。
//         返りの reason は notFound / changed / human / same。migration・reason は変更記録に残る
//   archiveLegacyPromises(): Promise<string[]>・placements(migration): Promise<{ id, from, to }[]>
//       … 前者は上の約束の移行を今すぐもう一度行う（何度でも同じ。振り分けの最初に呼ぶ）。後者は一括移行が変えた段・作業場所の前後（取り消しの材料）
//   rev(): number                                                 … log.jsonl の最後の rev
//   turnContext({ bot, session, sessionId?, incomingText, cwd?, now?, locale? }):
//       Promise<{ notes: string[], memRev: number, delivered: string[], snapshotDue: boolean, omitted?: { untiered, always, workspace } }>
//       … bot は Bot（id）、session は sidecar の SessionBot（memRev・snapshotDue・delivered）。notes は memoryCoreEnvelope（snapshotDue のときだけ）と
//         turnContextEnvelope（毎ターン）の並び。返りの memRev・delivered・snapshotDue を dispatch が sidecar に書き戻す。dispatch.turnExtras がこれを返す
//       … cwd は会話の cwd。その git の本体（canonicalWorkspace）が今の作業場所で、無ければ「この作業場所で」の記憶は渡さない。
//         核の写し（snapshotDue）は tail.mjs の pickTieredCore（いつも 6000・この作業場所で 3000・段なしは従来の層ごと 1200 トークン）。入りきらなかった件数は返りの omitted
//         （核の写しを作ったターンだけ）。差分は 20 件まで（保存だけ・ほかの作業場所は出さない）。関係する記憶は 5 件・各 150・合計 2000 トークンまで
import path from 'node:path';
import { agentT } from '../i18n.mjs';
import { canonicalWorkspace, slashPath } from '../git-root.mjs';
import { createMemoryStore, fingerprintOf, isLayer, isTier, isWorkspace, oneLine, USER_LAYER } from './store.mjs';
import { createMemoryIndex } from './index.mjs';
import { MemoryError, checkText, checkSources, sourceResolvers, capWeight } from './guard.mjs';
import { strengthOf, FADED_BELOW } from './strength.mjs';
import { foldDelta, pickTieredCore, coreFitCounts, coreSnapshot, turnContext as turnContextText, sameWorkspace, fitEntries, RELATED_MAX, RELATED_ITEM_TOKENS, RELATED_TOTAL_TOKENS, SEARCH_MAX, SEARCH_TOTAL_TOKENS } from './tail.mjs';

export { MemoryError };

/** memory.search の各件の上限（トークン） */
export const RESULT_TOKENS = 150;
/** 渡し済みの id を覚える数（圧縮で空になるので、普段は届かない上限） */
const DELIVERED_MAX = 400;
/** 既存の約束を保存だけ（archive）にする一括移行の名前（store.edit の migration。記録に残り、同じ id にはやり直さない） */
export const PROMISE_ARCHIVE_MIGRATION = 'promise-archive';
/** 保存だけの記憶か（会話・検索・夜の整理の AI へ渡さない。一覧には出る） */
const archived = (entry) => entry?.tier === 'archive';
/** bot が 1 ターンに user 層へ書ける件数（全 bot が読む層なので、暴走・汚染の幅を抑える。超えたら MEMORY_REJECTED:userWriteLimit） */
export const USER_WRITES_PER_TURN = 5;

/** 外へ出す行に今の強さを付ける（保存はしない。小数 2 桁） */
const withStrength = (entry, at) => {
  const strength = strengthOf(entry, at);
  return { ...entry, strength: Math.round(strength * 100) / 100, faded: strength < FADED_BELOW };
};

/** 会話の作業場所（here）から見える記憶か。保存だけ（archive）は見えない。「この作業場所で」は here と同じ作業場所のものだけ（here が無ければ見えない）。
 *  段の無い記憶・「いつも」はどの会話にも見える。memory.search だけはほかの作業場所も引ける（これは使わない） */
const visibleIn = (here) => (entry) => !archived(entry) && (entry.tier !== 'workspace' || sameWorkspace(entry.workspace, here));

export function createMemoryService({ dataDir, channels = null, emit = () => {}, now = Date.now, localeOf = () => 'ja', loadSqlite, log = () => {}, withLayer = (_layer, fn) => fn(), workspaceOf = canonicalWorkspace } = {}) {
  const dir = path.join(dataDir, 'memory');
  const titleOf = (layer) => (layer === USER_LAYER ? agentT(localeOf(), 'memory.title.user') : agentT(localeOf(), 'memory.title.bot'));
  const store = createMemoryStore({ dir, now, titleOf });
  const index = createMemoryIndex({ file: path.join(dir, 'index.sqlite'), ...(loadSqlite ? { loadSqlite } : {}), log });
  let started = false;
  let indexed = null;   // 索引に渡した正本の印（store.hash）
  const userWrites = new Map();   // bot の会話の sessionId（会話の外なら bot:<id>）→ このターンに user 層へ書いた件数。ターンの始まり（turnContext）で 0 に戻す

  const announce = (layer) => emit({ type: 'memoryChanged', layer, rev: store.rev() });

  /**
   * 段の無い既存の約束（kind = promise）を、AI を使わずコードで保存だけ（archive）にする（ADR 0363）。起動の最初の読み込みで 1 度行い、何度走っても同じ。
   * updatedAt は進めず、変更記録に「システムが段を付けた（migration）」と前後を残す。段を外せば元に戻り、外した後の起動でもやり直さない（記録にある id は飛ばす）。
   * ToDo・気がかりへは写さない。返りは変えた層
   */
  async function archiveLegacy() {
    const done = store.migrated(PROMISE_ARCHIVE_MIGRATION);
    const layers = new Set();
    for (const entry of store.entries()) {
      if (entry.kind !== 'promise' || entry.tier || done.has(entry.id)) continue;
      if (await store.edit({ id: entry.id, tier: 'archive', by: { kind: 'system' }, migration: PROMISE_ARCHIVE_MIGRATION })) layers.add(entry.layer);
    }
    return [...layers];
  }

  /** 人が markdown を直接直していたら記録に足して配る。変わった層の数 */
  async function catchUp() {
    if (!started) {
      await store.init();
      const moved = await archiveLegacy();   // 失敗したら started にしない（次の呼び出しでやり直す）
      started = true;
      for (const layer of moved) announce(layer);
    }
    const changed = await store.sync();
    for (const layer of changed) announce(layer);
    return changed.length;
  }
  async function ensureIndex() {
    await catchUp();
    const hash = store.hash();
    if (hash === indexed) return;
    await index.sync(store.entries(), hash);
    indexed = hash;
  }

  const notFound = (id) => new MemoryError('MEMORY_NOT_FOUND', 'notFound', id);
  const needLayer = (layer) => { if (!isLayer(layer)) throw new MemoryError('MEMORY_REJECTED', 'layer', String(layer)); };
  const isHuman = (author) => author?.kind === 'human';
  const rejected = (reason, detail) => new MemoryError('MEMORY_REJECTED', reason, detail);
  /** 約束は人でなければ記憶に書かない。会話に ToDo があれば ToDo へ、無ければ気がかりへ置くよう断る（ctx.hasTodos は core/ops/memory.mjs が付ける） */
  const promiseRefusal = (ctx) => rejected(ctx?.hasTodos ? 'promiseTodo' : 'promiseLoop');

  /** 外から来た作業場所の形をそろえて検査する（\ は / へ・末尾の / は落とす。形が合わなければ MEMORY_REJECTED）。空は「無し」（null） */
  const placeOf = (value) => {
    if (value == null || value === '') return null;
    const place = slashPath(typeof value === 'string' ? value.trim() : value);
    if (!isWorkspace(place)) throw rejected('workspace');
    return place;
  };
  /** 会話の cwd の作業場所（git の本体。git の外・読めなければ null） */
  const hereOf = async (ctx) => (typeof ctx?.sessionCwd === 'string' && ctx.sessionCwd ? (await workspaceOf(ctx.sessionCwd).catch(() => null)) ?? null : null);

  /** 新しい記憶の段と作業場所（省いたときの既定は冒頭の write の説明） */
  async function newPlacement({ tier, workspace }, human, ctx) {
    if (tier != null && !isTier(tier)) throw rejected('tier');
    const given = placeOf(workspace);
    if (tier == null) {
      if (given) return { tier: 'workspace', workspace: given };
      if (human) return { tier: 'always' };
      const here = await hereOf(ctx);
      return here ? { tier: 'workspace', workspace: here } : { tier: 'always' };
    }
    if (tier !== 'workspace') return { tier };
    const place = given ?? await hereOf(ctx);
    if (!place) throw rejected('workspaceUnknown');
    return { tier, workspace: place };
  }

  /** 直しの段と作業場所。今の行から変わるものだけを返す（無ければ空）。workspace は null で外す */
  async function editedPlacement({ tier, workspace }, old, ctx) {
    if (tier != null && !isTier(tier)) throw rejected('tier');
    const given = workspace === null ? null : placeOf(workspace);
    const effective = tier ?? (given ? 'workspace' : old.tier);   // workspace だけ渡したら、write と同じく workspace の段にする
    const out = {};
    if (effective != null && effective !== old.tier) out.tier = effective;
    if (workspace === null && effective !== 'workspace') { if (old.workspace) out.workspace = null; }
    else if (given && effective === 'workspace' && given !== old.workspace) out.workspace = given;
    if (effective === 'workspace' && !(out.workspace ?? old.workspace)) {
      const place = await hereOf(ctx);
      if (!place) throw rejected('workspaceUnknown');
      out.workspace = place;
    }
    return out;
  }

  /** 差分の記録のうち、この会話（visible: visibleIn(作業場所)）へ見せない id。今が保存だけ・ほかの作業場所の記憶と、そのまま忘れた記憶
   *  （段を付けただけの記録が差分に出ないように。ほかの作業場所の記憶は、その場所の会話にだけ届ける） */
  const hiddenIds = (records, visible) => {
    const hidden = new Set();
    const last = new Map();
    for (const r of records) last.set(r.id, r);
    for (const [id, r] of last) {
      const entry = store.get(id) ?? (r.op === 'forget' ? r.entry : null);
      if (entry && !visible(entry)) hidden.add(id);
    }
    return hidden;
  };

  /** 出どころの検査（人でなければ必須）。返りは { sources: 確かめた出どころ, humanQuotes: そのうち人の発言の引用 } */
  async function verified(sources, author, ctx) {
    const resolvers = sourceResolvers({ channels, sessions: ctx?.sessions, botOfSession: ctx?.botOfSession });
    const human = isHuman(author);
    if (human && !sources?.length) return { sources: [], humanQuotes: [] };
    const out = await checkSources(sources, resolvers, { required: !human });
    return { sources: out.sources, humanQuotes: out.humanQuotes };
  }

  /** bot が user 層へ書く（本文を変える）ときの 1 ターンの上限。数えるのは書けたときだけ（ensure → bump の順） */
  const budgetKey = (author, ctx) => (author?.kind === 'bot' && ctx?.sessionId ? ctx.sessionId : author?.kind === 'bot' ? `bot:${author.botId}` : null);
  // ctx.userWriteLimit は夜の整理（core/memory/learn.mjs）だけが渡す。1 回の呼び出しに人の発言を 40 件までまとめるので、上限をその呼び出しの候補の数にする（ADR 0127）。
  // ops の ctx は server が組み立て、AI の入力からは入らない
  const ensureBudget = (layer, author, ctx) => {
    const key = layer === USER_LAYER ? budgetKey(author, ctx) : null;
    const limit = Number.isInteger(ctx?.userWriteLimit) && ctx.userWriteLimit > 0 ? ctx.userWriteLimit : USER_WRITES_PER_TURN;
    if (key && (userWrites.get(key) ?? 0) >= limit) throw new MemoryError('MEMORY_REJECTED', 'userWriteLimit', String(limit));
    return key;
  };
  const bump = (key) => { if (key) userWrites.set(key, (userWrites.get(key) ?? 0) + 1); };

  const service = {
    async purgeBot(botId) {
      needLayer(botId);
      if (botId === USER_LAYER) throw new Error('cannot purge shared memory');
      await catchUp();
      await store.purgeLayer(botId);
      await index.reset();
      indexed = null;
      announce(botId);
    },
    dataDir, emit, now,
    store, index,
    // 起動では正本を読むだけ（索引は最初の検索・末尾の組み立てで作る。bot を使わない人の置き場に索引のファイルを作らない）
    async start() { await catchUp(); },
    stop() { index.close(); store.close(); started = false; indexed = null; },

    async list({ layer } = {}) {
      await catchUp();
      const at = now();
      return (layer ? store.entries(layer) : store.entries()).map((e) => withStrength(e, at));
    },
    async get({ id } = {}) {
      await catchUp();
      return store.get(id);
    },
    async search({ query, layer, layers, limit = 5 } = {}) {
      await ensureIndex();
      const scope = layer ? [layer] : layers?.length ? layers : null;
      const at = now();
      // 保存だけ（archive）は探しても出さない（AI へ渡す道なので。人は一覧で見る）。ほかの作業場所の記憶は引ける。8 件・合計 1200 トークンまで
      const max = Math.min(SEARCH_MAX, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 5));
      const hits = await index.search({ query, ...(scope ? { layers: scope } : {}), limit: max, accept: (e) => !archived(e) });
      return fitEntries(hits, { max, perItem: RESULT_TOKENS, total: SEARCH_TOTAL_TOKENS }).map((e) => withStrength(e, at));
    },

    /**
     * 会話の始まりに入りきらない記憶の件数（MCP・CLI 用。設定画面は出さない）。layer は bot の id（その bot と user を合わせて見る）か user（user だけ。既定）。
     * workspace を省くと、作業場所ごとに見て入りきらなかった数の合計。返りは tail.mjs の coreFitCounts の形に layer・workspace を足したもの
     */
    async coreFit({ layer = USER_LAYER, workspace = null } = {}) {
      needLayer(layer);
      await catchUp();
      const place = placeOf(workspace);
      const live = (name) => store.entries(name).filter((e) => !archived(e));
      const fit = coreFitCounts(live(USER_LAYER), layer === USER_LAYER ? [] : live(layer), { workspace: place, now: now() });
      return { layer, workspace: place, ...fit };
    },

    async write({ layer, text, why, sources, kind, weight, status, tier, workspace } = {}, author, ctx = {}) {
      needLayer(layer);
      await catchUp();
      const human = isHuman(author);
      if (!human && kind === 'promise' && !ctx.nightlyOrganizer) throw promiseRefusal(ctx);   // 書かない（保存もしない）。ToDo か気がかりへ
      const placement = await newPlacement({ tier, workspace }, human, ctx);
      const budget = ensureBudget(layer, author, ctx);
      const clean = checkText(text, { human, isTombstoned: store.isTombstoned, fingerprint: fingerprintOf });
      const note = why == null || why === '' ? undefined : checkText(why, { human, isTombstoned: null }).slice(0, 300);
      const proven = await verified(sources, author, ctx);
      const fp = fingerprintOf(clean);
      if (store.entries(layer).some((e) => fingerprintOf(e.text) === fp)) throw new MemoryError('MEMORY_REJECTED', 'duplicate');
      const tags = { kind, weight: capWeight(weight, { human, kind, humanQuotes: proven.humanQuotes }), status, ...placement };
      const added = await store.add({ layer, text: clean, why: note, sources: proven.sources, by: author, via: ctx.sessionId, unique: true, ...tags });
      if (added.duplicate) throw new MemoryError('MEMORY_REJECTED', 'duplicate');
      const { entry } = added;
      bump(budget);
      announce(layer);
      return entry;
    },

    async edit({ id, text, why, sources, kind, weight, status, tier, workspace } = {}, author, ctx = {}) {
      await catchUp();
      const old = store.get(id);
      if (!old) throw notFound(id);
      const human = isHuman(author);
      // 直した結果が約束になる（今が約束のままの直しも含む）なら、人でなければ書かない。保存だけへ寄せる直し（段だけ archive）は通す
      const resultKind = kind === undefined ? old.kind : kind;
      const onlyArchiving = tier === 'archive' && [text, why, sources, kind, weight, status, workspace].every((v) => v === undefined);
      if (!human && resultKind === 'promise' && !onlyArchiving && !ctx.nightlyOrganizer) throw promiseRefusal(ctx);
      const placement = await editedPlacement({ tier, workspace }, old, ctx);
      const placing = tier != null || workspace !== undefined;
      const changing = text !== undefined && oneLine(text) !== old.text;
      const budget = changing ? ensureBudget(old.layer, author, ctx) : null;
      const clean = text === undefined ? undefined : checkText(text, { human, isTombstoned: store.isTombstoned, fingerprint: fingerprintOf });
      const note = why === undefined ? undefined : why === '' ? '' : checkText(why, { human, isTombstoned: null }).slice(0, 300);
      // AI が本文を変えるときは、新しく書くときと同じく人の発言の根拠が要る
      const proven = clean !== undefined && clean !== old.text ? await verified(sources, author, ctx) : { sources: [], humanQuotes: [] };
      if (clean !== undefined && clean !== old.text) {
        const fp = fingerprintOf(clean);
        if (store.entries(old.layer).some((e) => e.id !== id && fingerprintOf(e.text) === fp)) throw new MemoryError('MEMORY_REJECTED', 'duplicate');
      }
      const cappedWeight = capWeight(weight, { human, kind: kind ?? old.kind ?? null, humanQuotes: proven.humanQuotes });
      // 段・作業場所だけの依頼で何も変わらないときは、記録も updatedAt も動かさない
      const others = [clean, note, kind, cappedWeight, status].some((v) => v !== undefined) || proven.sources.length > 0;
      if (placing && !others && !Object.keys(placement).length) return old;
      const done = await store.edit({ id, text: clean, why: note, sources: proven.sources.length ? proven.sources : undefined, by: author, via: ctx.sessionId,
        kind, weight: cappedWeight, status, ...placement });
      if (!done) throw notFound(id);
      bump(budget);
      announce(done.entry.layer);
      return done.entry;
    },

    /**
     * コードが段・作業場所だけを付け替える（夜の整理の振り分けとその取り消し。本文・出どころ・強さには触れず、updatedAt も進めない）。
     * tier・workspace は null か省略で外す。expect（{ tier?, workspace? }）を渡すと、今がその段・作業場所のままのときだけ直す
     * （振り分けの途中・後に人が直した記憶を上書きしないため）。by は既定でシステム。migration・reason は変更記録に残る。
     * unlessHumanPlaced を真にすると、段・作業場所を最後に変えたのが人（画面の選び直し）の記憶には触れない（夜の整理が人の選んだ段を戻さないため）。
     * 返りは { placed: true, entry } か { placed: false, reason: 'notFound' | 'changed' | 'human' | 'same' }
     */
    async place({ id, tier, workspace, reason, migration, expect, by = { kind: 'system' }, unlessHumanPlaced = false } = {}) {
      await catchUp();
      const old = store.get(id);
      if (!old) return { placed: false, reason: 'notFound' };
      if (expect && ((old.tier ?? null) !== (expect.tier ?? null) || (old.workspace ?? null) !== (expect.workspace ?? null))) return { placed: false, reason: 'changed' };
      if (unlessHumanPlaced && store.lastPlacedBy(id)?.kind === 'human') return { placed: false, reason: 'human' };
      if (tier != null && !isTier(tier)) throw rejected('tier');
      const place = workspace == null ? null : placeOf(workspace);
      if (tier === 'workspace' && !place) throw rejected('workspaceUnknown');
      if ((old.tier ?? null) === (tier ?? null) && (old.workspace ?? null) === place) return { placed: false, reason: 'same' };
      const note = reason ? [...oneLine(reason)].slice(0, 80).join('') : undefined;
      const done = await store.edit({ id, tier: tier ?? null, workspace: place, by, reason: note, ...(migration ? { migration } : {}) });
      if (!done) return { placed: false, reason: 'notFound' };
      announce(done.entry.layer);
      return { placed: true, entry: done.entry };
    },

    /** 一括移行 migration（place の migration）が段・作業場所を変えた記憶ごとの最初の前と最後の後。[{ id, from, to }]（from・to は { tier?, workspace? }）。取り消しの材料 */
    async placements(migration) {
      await catchUp();
      return [...store.migrations(migration)].map(([id, { from, to }]) => ({ id, from, to }));
    },

    /** 段の無い既存の約束を保存だけにする移行（冒頭の archiveLegacy）。起動の最初の読み込みで済んでいるが、振り分けの最初にもう一度呼ぶ（何度呼んでも同じ）。変えた層の配列 */
    async archiveLegacyPromises() {
      await catchUp();
      const moved = await archiveLegacy();
      for (const layer of moved) announce(layer);
      return moved;
    },

    async forget({ id } = {}, author, ctx = {}) {
      await catchUp();
      const done = await store.forget({ id, by: author, via: ctx.sessionId });
      if (!done) throw notFound(id);
      announce(done.entry.layer);
      return done.entry;
    },

    /** 忘れた直後で戻せる記憶の写し（無ければ null）。unforget の前に、見える層か確かめるのに使う */
    async forgotten({ id } = {}) {
      await catchUp();
      return store.forgottenEntry(id);
    },

    async unforget({ id } = {}, author, ctx = {}) {
      await catchUp();
      const done = await store.unforget({ id, by: author, via: ctx.sessionId });
      if (!done) throw notFound(id);
      announce(done.entry.layer);
      return done.entry;
    },

    rev: () => store.rev(),

    async turnContext({ bot, session = {}, sessionId = null, incomingText = '', cwd = null, now: at = now(), locale } = {}) {
      await ensureIndex();
      if (sessionId) userWrites.delete(sessionId);   // 新しいターンの始まり: user 層への書き込みの数え直し
      const layers = bot?.id ? [USER_LAYER, bot.id] : [USER_LAYER];
      const rev = store.rev();
      const due = session.snapshotDue === true;
      // この会話の作業場所（cwd の git の本体。git の外・cwd が無い会話は null = 「この作業場所で」の記憶は 1 件も渡さない）
      const here = await hereOf({ sessionCwd: cwd });
      const visible = visibleIn(here);
      let delivered = due ? [] : [...(session.delivered ?? [])];
      const notes = [];
      let delta = [];
      let omitted = null;
      if (due) {
        // 核の写しが今の全体を含むので、差分は要らない。保存だけ（archive）は入れない。入りきらなかった数は返りの omitted に（段ごと）
        const live = (layer) => store.entries(layer).filter((e) => !archived(e));
        const core = pickTieredCore(live(USER_LAYER), bot?.id ? live(bot.id) : [], { workspace: here, now: at });
        const snapshot = coreSnapshot({ core, locale });
        if (snapshot) notes.push(snapshot);
        delivered = core.ids;
        omitted = core.omittedByTier;
      } else {
        const records = store.recordsSince(Number.isInteger(session.memRev) ? session.memRev : 0);
        const hidden = hiddenIds(records, visible);
        const folded = foldDelta(hidden.size ? records.filter((r) => !hidden.has(r.id)) : records, { layers, skipVia: sessionId });
        delta = folded.items;
        delivered = [...delivered, ...folded.skipped, ...delta.filter((d) => d.kind !== 'forget').map((d) => d.id)];
      }
      // 関係する記憶: 段の付いたもの（始まりに入りきらなかった「いつも」と、今の作業場所の「この作業場所で」。入ったものは渡し済みで外れる）を先に、
      // 残りの枠を段の無い記憶で埋める。保存だけ・ほかの作業場所は出さない。5 件・1 件 150 トークン・合計 2000 トークンまで
      let hits = [];
      if (incomingText) {
        hits = await index.related({ text: incomingText, layers, exclude: delivered, limit: RELATED_MAX, accept: (e) => Boolean(e.tier) && visible(e) });
        if (hits.length < RELATED_MAX) {
          const more = await index.related({ text: incomingText, layers, exclude: [...delivered, ...hits.map((h) => h.entry.id)], limit: RELATED_MAX - hits.length, accept: visible });
          hits = [...hits, ...more];
        }
      }
      const related = fitEntries(hits.map((h) => h.entry), { max: RELATED_MAX, perItem: RELATED_ITEM_TOKENS, total: RELATED_TOTAL_TOKENS });
      delivered = [...new Set([...delivered, ...related.map((e) => e.id)])].slice(-DELIVERED_MAX);
      notes.push(turnContextText({ now: at, delta, related, locale }));
      return { notes, memRev: rev, delivered, snapshotDue: false, ...(omitted ? { omitted } : {}) };
    },
  };
  let operations = Promise.resolve();
  for (const [name, operation] of Object.entries(service)) {
    if (['rev', 'stop', 'now', 'emit'].includes(name) || typeof operation !== 'function') continue;
    service[name] = (...args) => {
      const execute = async () => {
        if (['write', 'edit', 'forget', 'unforget', 'place'].includes(name)) await catchUp();
        const layer = name === 'write' ? args[0]?.layer : ['edit', 'forget', 'unforget', 'place'].includes(name)
          ? (store.get(args[0]?.id) ?? store.forgottenEntry(args[0]?.id))?.layer : null;
        return layer ? withLayer(layer, () => operation(...args)) : operation(...args);
      };
      const run = operations.then(execute, execute);
      operations = run.catch(() => {});
      return run;
    };
  }
  return service;
}
