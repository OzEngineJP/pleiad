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
//   search({ query, layer?, layers?, limit }): Promise<MemoryEntry[]>   … 各 150 トークンまで。layer 省略なら layers（無ければ全層）。保存だけ（tier = archive）は出さない（list には出る）
//   write({ layer, text, why?, sources, kind?, weight?, status?, tier?, workspace? }, author, ctx): Promise<MemoryEntry>   … 出どころの検査（MEMORY_SOURCE・MEMORY_REJECTED）はここ。
//       kind・weight・status は記憶の種類・重み・状態（strength.mjs。ADR 0118）。AI の重み 3 は guard.capWeight が根拠を見て 2 に抑える
//       tier・workspace は段と作業場所（store.mjs）。省いたときの既定: 人は always。bot・AI は ctx.sessionCwd（会話の cwd）に git の本体があれば
//       workspace + その場所、無ければ always。tier=workspace で場所が決まらなければ MEMORY_REJECTED（workspaceUnknown）。workspace だけ渡せば tier は workspace
//   edit({ id, text?, why?, sources?, kind?, weight?, status?, tier?, workspace? }, author, ctx): Promise<MemoryEntry>・forget({ id }, author, ctx): Promise<MemoryEntry>・unforget({ id }, author, ctx): Promise<MemoryEntry>
//       … edit の workspace は null で外せる。tier・workspace だけの直しは updatedAt を進めない
//       … 人も AI も使える（edit は write、forget は guarded）。誰がしたかは log.jsonl の by に残す。無い id は MEMORY_NOT_FOUND
//       … 約束（kind = promise）は人以外は書けない（write・直した結果が約束になる edit は MEMORY_REJECTED: promiseTodo / promiseLoop。ctx.hasTodos が真なら ToDo へ、
//         偽なら気がかりへ置くよう返す。段だけ archive へ寄せる直しは通す）。段の無い既存の約束は、最初の読み込みでコードが保存だけ（archive）にする
//         （archiveLegacyPromises。AI なし・updatedAt 据え置き・記録に migration を残す・段を外しても再度は行わない）
//   rev(): number                                                 … log.jsonl の最後の rev
//   turnContext({ bot, session, sessionId?, incomingText, now?, locale? }):
//       Promise<{ notes: string[], memRev: number, delivered: string[], snapshotDue: boolean }>
//       … bot は Bot（id）、session は sidecar の SessionBot（memRev・snapshotDue・delivered）。notes は memoryCoreEnvelope（snapshotDue のときだけ）と
//         turnContextEnvelope（毎ターン）の並び。返りの memRev・delivered・snapshotDue を dispatch が sidecar に書き戻す。dispatch.turnExtras がこれを返す
import path from 'node:path';
import { agentT } from '../i18n.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';
import { canonicalWorkspace, slashPath } from '../git-root.mjs';
import { createMemoryStore, fingerprintOf, isLayer, isTier, isWorkspace, oneLine, USER_LAYER } from './store.mjs';
import { createMemoryIndex } from './index.mjs';
import { MemoryError, checkText, checkSources, sourceResolvers, capWeight } from './guard.mjs';
import { strengthOf, FADED_BELOW } from './strength.mjs';
import { foldDelta, pickCore, coreSnapshot, turnContext as turnContextText } from './tail.mjs';

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

/** 150 トークンに収まるまで切る（本文は 300 字までなので、普通は切らない） */
const clip = (entry) => {
  if (estimateTokens(entry.text) <= RESULT_TOKENS) return entry;
  let text = [...entry.text];
  while (text.length > 1 && estimateTokens(`${text.join('')}…`) > RESULT_TOKENS) text = text.slice(0, Math.floor(text.length * 0.9));
  return { ...entry, text: `${text.join('')}…` };
};

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
   * 段の無い既存の約束（kind = promise）を、AI を使わずコードで保存だけ（archive）にする（ADR 0359）。起動の最初の読み込みで 1 度行い、何度走っても同じ。
   * updatedAt は進めず、変更記録に「システムが段を付けた（migration）」と前後を残す。段を外せば元に戻り、外した後の起動でもやり直さない（記録にある id は飛ばす）。
   * ToDo・気がかりへは写さない。返りは変えた層
   */
  async function archiveLegacyPromises() {
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
      const moved = await archiveLegacyPromises();   // 失敗したら started にしない（次の呼び出しでやり直す）
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

  /** 差分の記録のうち AI へ見せない id（今が保存だけの記憶と、保存だけのまま忘れた記憶。段を付けただけの記録が差分に出ないように） */
  const hiddenIds = (records) => {
    const hidden = new Set();
    const last = new Map();
    for (const r of records) last.set(r.id, r);
    for (const [id, r] of last) {
      const now = store.get(id);
      if (now ? archived(now) : r.op === 'forget' && archived(r.entry)) hidden.add(id);
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
      // 保存だけ（archive）は探しても出さない（AI へ渡す道なので。人は一覧で見る）
      return (await index.search({ query, ...(scope ? { layers: scope } : {}), limit, accept: (e) => !archived(e) })).map((e) => withStrength(clip(e), at));
    },

    async write({ layer, text, why, sources, kind, weight, status, tier, workspace } = {}, author, ctx = {}) {
      needLayer(layer);
      await catchUp();
      const human = isHuman(author);
      if (!human && kind === 'promise') throw promiseRefusal(ctx);   // 書かない（保存もしない）。ToDo か気がかりへ
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
      if (!human && resultKind === 'promise' && !onlyArchiving) throw promiseRefusal(ctx);
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

    async turnContext({ bot, session = {}, sessionId = null, incomingText = '', now: at = now(), locale } = {}) {
      await ensureIndex();
      if (sessionId) userWrites.delete(sessionId);   // 新しいターンの始まり: user 層への書き込みの数え直し
      const layers = bot?.id ? [USER_LAYER, bot.id] : [USER_LAYER];
      const rev = store.rev();
      const due = session.snapshotDue === true;
      let delivered = due ? [] : [...(session.delivered ?? [])];
      const notes = [];
      let delta = [];
      if (due) {
        // 核の写しが今の全体を含むので、差分は要らない。保存だけ（archive）は入れない
        const live = (layer) => store.entries(layer).filter((e) => !archived(e));
        const core = pickCore(live(USER_LAYER), bot?.id ? live(bot.id) : [], { now: at });
        const snapshot = coreSnapshot({ core, locale });
        if (snapshot) notes.push(snapshot);
        delivered = core.ids;
      } else {
        const records = store.recordsSince(Number.isInteger(session.memRev) ? session.memRev : 0);
        const hidden = hiddenIds(records);
        const folded = foldDelta(hidden.size ? records.filter((r) => !hidden.has(r.id)) : records, { layers, skipVia: sessionId });
        delta = folded.items;
        delivered = [...delivered, ...folded.skipped, ...delta.filter((d) => d.kind !== 'forget').map((d) => d.id)];
      }
      const related = incomingText
        ? (await index.related({ text: incomingText, layers, exclude: delivered, limit: 5, accept: (e) => !archived(e) })).map((r) => r.entry)
        : [];
      delivered = [...new Set([...delivered, ...related.map((e) => e.id)])].slice(-DELIVERED_MAX);
      notes.push(turnContextText({ now: at, delta, related, locale }));
      return { notes, memRev: rev, delivered, snapshotDue: false };
    },
  };
  let operations = Promise.resolve();
  for (const [name, operation] of Object.entries(service)) {
    if (['rev', 'stop', 'now', 'emit'].includes(name) || typeof operation !== 'function') continue;
    service[name] = (...args) => {
      const execute = async () => {
        if (['write', 'edit', 'forget', 'unforget'].includes(name)) await catchUp();
        const layer = name === 'write' ? args[0]?.layer : ['edit', 'forget', 'unforget'].includes(name)
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
