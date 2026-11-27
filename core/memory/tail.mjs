// bot の会話へ渡す記憶の文（ADR 0110）。キャッシュの並び: ツール → 人格 → 核の写し（始まり・圧縮の後に 1 回）→ 履歴 → 今のターンの末尾 → 発言。
//   核の写し … <pleiad-memory-core>。会話の始まりと圧縮の完了後の最初のターンの notes に 1 回だけ（session.snapshotDue）
//   末尾    … <pleiad-turn-context>。毎ターンの notes に: 時刻（分まで）・前のターンからの記憶の差分（20 件まで）・この話に関係する記憶（5 件まで）
// i18n-dynamic: agent:memory.turn.
// i18n-dynamic: agent:memory.kind.
// 文は辞書 agent:memory.*（会話の言語）。ここは文の組み立てだけで、ファイルも索引も触らない（service.mjs が材料を渡す）。
// 途中送信（control.steer）の道では末尾を付けない。差分は memRev を進めないので、次の新しいターンで渡る（dispatch の責務）。
import { agentT } from '../i18n.mjs';
import { memoryCoreEnvelope, turnContextEnvelope } from '../channels/types.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';
import { USER_LAYER } from './store.mjs';
import { strengthOf, kindOrder, FADED_BELOW } from './strength.mjs';

/** 末尾の差分に出す件数の上限。超えたら件数と memory.search で引けることだけ */
export const DELTA_MAX = 20;
/** 関係する記憶の件数の上限 */
export const RELATED_MAX = 5;
/** 核の写しの 1 層あたりのトークンの目安（新しいものから入れ、残りは件数だけ）。段の無い既存の記憶に使う */
export const CORE_LAYER_TOKENS = 1200;
/** 段の付いた記憶の核の写しの目安。「いつも」と、今の作業場所の「この作業場所で」で分ける */
export const CORE_ALWAYS_TOKENS = 400;
export const CORE_WORKSPACE_TOKENS = 800;
/** 関係する記憶の 1 件の上限と、末尾 1 回の合計の上限（トークン）。件数は RELATED_MAX */
export const RELATED_ITEM_TOKENS = 150;
export const RELATED_TOTAL_TOKENS = 2000;
/** memory.search の件数と合計の上限（各件は RESULT_TOKENS まで。service.mjs） */
export const SEARCH_MAX = 8;
export const SEARCH_TOTAL_TOKENS = 1200;

const pad = (n) => String(n).padStart(2, '0');

/** 時刻（分まで。PC の現地時刻と UTC からのずれ）。2026-10-03 10:41 +09:00 (土) */
export function formatNow(ms, locale) {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  let weekday = '';
  try { weekday = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { weekday: 'short' }).format(d); } catch { /* 曜日が無くてもよい */ }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}${weekday ? ` (${weekday})` : ''}`;
}

const layerLabel = (locale, layer) => (layer === USER_LAYER ? agentT(locale, 'memory.layer.user') : agentT(locale, 'memory.layer.bot'));

/**
 * 差分の記録を、見る側に意味のある変更にたたむ（同じ id の複数の変更は最後の 1 つ。見せる前に消えたもの・見ていないものは出さない）。
 * records は rev の昇順。skipVia は、この会話が自分で書いた記憶（履歴に tool の結果がある）。返りは { items, skipped }
 *   items: { kind: 'add'|'edit'|'forget', layer, id, text }[]（時系列）。skipped: 自分が書いた記憶の id（見せないが渡した扱いにする）
 */
export function foldDelta(records, { layers, skipVia = null } = {}) {
  const byId = new Map();
  for (const r of records) {
    if (layers && !layers.includes(r.layer)) continue;
    if (!['add', 'edit', 'forget', 'unforget'].includes(r.op)) continue;
    const prev = byId.get(r.id);
    const kind = r.op === 'unforget' ? 'add' : r.op;
    const first = prev?.first ?? kind;
    byId.set(r.id, { first, kind, layer: r.layer, id: r.id, text: r.text ?? '', via: r.via ?? null, rev: r.rev, firstVia: prev ? prev.firstVia : (r.via ?? null) });
  }
  const items = [];
  const skipped = [];
  for (const v of [...byId.values()].sort((a, b) => a.rev - b.rev)) {
    // 範囲の中で作られて消えたものは、見せる前に無くなったので出さない
    if (v.first === 'add' && v.kind === 'forget') continue;
    const kind = v.first === 'add' && v.kind === 'edit' ? 'add' : v.kind;
    if (skipVia && v.via === skipVia && kind !== 'forget') { skipped.push(v.id); continue; }
    items.push({ kind, layer: v.layer, id: v.id, text: v.text });
  }
  return { items, skipped };
}

/**
 * 核の写しに入れる記憶を選ぶ（ADR 0118）。層ごとの目安まで、強さ（strength.mjs: 重み × 新しさ）の強い順に入れる。同じ強さなら人が書いた・直した記憶
 * （by.kind === 'human'）を先に、それから新しい更新から。人の行は重み 3 で薄れないので、書き込みを重ねる bot が新しさだけで人の記憶を押し出せない。
 * 薄れた記憶（FADED_BELOW 未満）は入れず、消しもしない（memory.search・関係する記憶では出る）。
 * 返りは { user, bot, omitted, faded, ids }。本文は種類の順（やめたこと → 約束 → …）、同じ種類の中は時系列。omitted は入れなかった数（faded を含む）
 */
export function pickCore(userEntries, botEntries, { layerTokens = CORE_LAYER_TOKENS, now = Date.now() } = {}) {
  const humanFirst = (e) => (e.by?.kind === 'human' ? 0 : 1);
  const take = (list) => {
    const strength = new Map(list.map((e) => [e.id, strengthOf(e, now)]));
    const live = list.filter((e) => strength.get(e.id) >= FADED_BELOW);
    const picked = [];
    let used = 0;
    for (const e of [...live].sort((a, b) => (strength.get(b.id) - strength.get(a.id)) || (humanFirst(a) - humanFirst(b)) || (b.updatedAt - a.updatedAt) || (b.at - a.at))) {
      const cost = estimateTokens(e.text) + 3;
      if (used + cost > layerTokens && picked.length) break;
      picked.push(e); used += cost;
    }
    const keep = new Set(picked.map((e) => e.id));
    const shown = list.map((e, i) => [e, i]).filter(([e]) => keep.has(e.id)).sort(([a, i], [b, j]) => (kindOrder(a) - kindOrder(b)) || (i - j)).map(([e]) => e);
    return { picked: shown, omitted: list.length - picked.length, faded: list.length - live.length };
  };
  const u = take(userEntries), b = take(botEntries);
  return { user: u.picked, bot: b.picked, omitted: u.omitted + b.omitted, faded: u.faded + b.faded, ids: [...u.picked, ...b.picked].map((e) => e.id) };
}

const cleanWorkspace = (v) => String(v ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
/** 2 つの作業場所が同じか（\ と末尾の / はそろえて比べる）。どちらかが無ければ同じではない（作業場所の無い会話は「この作業場所で」を受けない） */
export const sameWorkspace = (a, b) => Boolean(a) && Boolean(b) && cleanWorkspace(a) === cleanWorkspace(b);

/** 本文を tokens トークンに収まるまで切った行（収まっていればそのまま） */
export function clipEntry(entry, tokens) {
  if (estimateTokens(entry.text) <= tokens) return entry;
  let text = [...entry.text];
  while (text.length > 1 && estimateTokens(`${text.join('')}…`) > tokens) text = text.slice(0, Math.floor(text.length * 0.9));
  return { ...entry, text: `${text.join('')}…` };
}

/**
 * 順位の順の記憶を、件数（max）・1 件（perItem トークン）・合計（total トークン）の上限に収める。1 件は切り、合計を超える件から後は出さない。
 * 関係する記憶（末尾）と memory.search が同じ形で使う
 */
export function fitEntries(entries, { max, perItem, total }) {
  const out = [];
  let used = 0;
  for (const entry of entries) {
    if (out.length >= max) break;
    const clipped = clipEntry(entry, perItem);
    const cost = estimateTokens(clipped.text);
    if (used + cost > total) break;
    out.push(clipped);
    used += cost;
  }
  return out;
}

/**
 * 段の付いた記憶の並び順（核の写しと夜の整理の候補の選び方が共有する。重み・薄れは使わない）:
 * 人が書いた・直したもの → やめたこと（kind = stop）→ 新しく更新した順 → 新しく書いた順 → id
 */
export const tieredOrder = (a, b) => {
  const human = (e) => (e.by?.kind === 'human' || e.origBy?.kind === 'human' ? 0 : 1);
  return (human(a) - human(b)) || (b.updatedAt - a.updatedAt) || (b.at - a.at) || (a.id < b.id ? -1 : 1);
};

/**
 * 重要な記憶を核の写しに入れる。上限を超えたときは人が書いた・直したものを先に、新しい更新を優先する。
 * 「保存だけ」は返さない。「この作業場所で」は workspace が今の作業場所と同じものだけ。合わないものは入りきらなかった数に入れない。
 * 返りは pickCore と同じ形に、omittedByTier・inactiveWorkspace を足したもの。
 */
export function pickTieredCore(userEntries, botEntries, { workspace = null, locale = 'ja',
  alwaysTokens = CORE_ALWAYS_TOKENS, workspaceTokens = CORE_WORKSPACE_TOKENS } = {}) {
  const all = [...userEntries, ...botEntries].filter((e) => e.kind !== 'promise');
  const take = (list, budget) => {
    const picked = [];
    let used = 0;
    for (const e of [...list].sort(tieredOrder)) {
      const cost = estimateTokens(coreLine(locale, e)) + 1;
      if (used + cost > budget) continue;
      picked.push(e);
      used += cost;
    }
    return { picked, omitted: list.length - picked.length };
  };
  const always = take(all.filter((e) => e.tier === 'always' && !e.workspace), alwaysTokens);
  const matching = all.filter((e) => e.tier === 'workspace' && sameWorkspace(e.workspace, workspace));
  const inactiveWorkspace = all.filter((e) => e.tier === 'workspace' && !sameWorkspace(e.workspace, workspace)).length;
  const local = take(matching, workspaceTokens);
  const keep = new Set([...always.picked, ...local.picked].map((e) => e.id));
  const user = userEntries.filter((e) => keep.has(e.id));
  const bot = botEntries.filter((e) => keep.has(e.id));
  const omittedByTier = { untiered: 0, always: always.omitted, workspace: local.omitted };
  const omitted = always.omitted + local.omitted;
  return { user, bot, omitted, omittedByTier, inactiveWorkspace, faded: 0, ids: [...user, ...bot].map((e) => e.id) };
}

/**
 * 会話の始まりに入りきらない記憶の件数（MCP・CLI 用。設定画面は出さない）。段ごとに { untiered, always, workspace }。
 * workspace を渡せばその作業場所で見たとき、省けば作業場所ごとに見て入りきらなかった数の合計。保存だけ（archive）は数えない。
 * 返りは { omitted: { untiered, always, workspace }, total, inactiveWorkspace }（inactiveWorkspace は今の作業場所に合わず、渡さない件。作業場所を省くと 0）
 */
export function coreFitCounts(userEntries, botEntries, { workspace = null, now = Date.now() } = {}) {
  const base = pickTieredCore(userEntries, botEntries, { workspace, now });
  let local = base.omittedByTier.workspace;
  if (!workspace) {
    const places = new Map();
    for (const e of [...userEntries, ...botEntries]) if (e.tier === 'workspace' && e.workspace) places.set(cleanWorkspace(e.workspace), e.workspace);
    local = 0;
    for (const place of places.values()) local += pickTieredCore(userEntries, botEntries, { workspace: place, now }).omittedByTier.workspace;
  }
  const omitted = { untiered: base.omittedByTier.untiered, always: base.omittedByTier.always, workspace: local };
  return { omitted, total: omitted.untiered + omitted.always + omitted.workspace, inactiveWorkspace: workspace ? base.inactiveWorkspace : 0 };
}

/** 核の写しの 1 行。種類があれば見出しの代わりに頭に付ける（「[約束] …」。済んだ約束は「[約束・済み] …」） */
const coreLine = (locale, e) => {
  if (!e.kind) return `- ${e.text}`;
  const label = agentT(locale, `memory.kind.${e.kind}`);
  return `- [${e.kind === 'promise' && e.status === 'dropped' ? agentT(locale, 'memory.kind.stop')
    : e.kind === 'promise' && e.status === 'done' ? agentT(locale, 'memory.kind.promiseDone') : label}] ${e.text}`;
};

/** 核の写しの notes 1 件。記憶が 1 つも無いときは null（始まりに空の包みを足さない） */
export function coreSnapshot({ core, locale }) {
  if (!core.user.length && !core.bot.length) return null;
  const lines = [agentT(locale, 'memory.core.intro')];
  if (core.user.length) lines.push('', agentT(locale, 'memory.core.user'), ...core.user.map((e) => coreLine(locale, e)));
  if (core.bot.length) lines.push('', agentT(locale, 'memory.core.bot'), ...core.bot.map((e) => coreLine(locale, e)));
  if (core.omitted) lines.push('', agentT(locale, 'memory.more', { n: core.omitted }));
  return memoryCoreEnvelope(lines.join('\n'));
}

/**
 * 毎ターンの末尾の notes 1 件。
 *   now … ms。delta … foldDelta の items。related … 関係する記憶（MemoryEntry の配列）
 */
export function turnContext({ now, delta = [], locale }) {
  const time = agentT(locale, 'memory.turn.time', { time: formatNow(now, locale) });
  const build = (shown) => {
    const lines = [time];
    if (delta.length) lines.push('', agentT(locale, 'memory.turn.changes'), ...shown);
    if (delta.length > shown.length) lines.push(`- ${agentT(locale, 'memory.more', { n: delta.length - shown.length })}`);
    return turnContextEnvelope(lines.join('\n'));
  };
  const shown = [];
  for (const d of delta.slice(-DELTA_MAX).reverse()) {
    const line = `- ${agentT(locale, `memory.turn.${d.kind}`, { layer: layerLabel(locale, d.layer), text: d.text })}`;
    if (estimateTokens(build([line, ...shown])) <= 300) shown.unshift(line);
  }
  return build(shown);
}
