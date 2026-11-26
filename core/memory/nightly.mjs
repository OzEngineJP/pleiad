// 夜の整理（ADR 0363 段階 2 の単位 5）の、AI にもファイルにも触れない部分。走らせる側は core/memory/learn.mjs（process・applyTierChanges）。
//
// 役目を「全件を渡して増やす」から「上限内で選び直す」へ変える。
//   ・AI へ渡す既存の記憶は選んだ分だけ。保存だけ（archive）・約束は渡さない。「いつも」を配る枠（CORE_ALWAYS_TOKENS）の中で先に入れ、
//     次に、読む会話の作業場所の「この作業場所で」・段の無い記憶を入れる。並びは配るときと同じ（tail.mjs の tieredOrder。重みは使わない）。
//     記憶の分は 12,000 トークンまで。会話の分（本文 2.4 万字）と指示を足して 1 回の入力が約 40,000 トークンに収まるよう、残りの分だけに絞る
//   ・AI は新しい記憶に加えて、渡した記憶の段を付け直す候補（tiers）を返せる。付ける段・作業場所はコードが決める（decideNightlyTier）。
//     人が書いた記憶・人が選んだ段・約束は付け直さない。1 回の実行で 20 件まで
//   ・同じ文・忘れた記憶かどうかは、渡した分ではなく全件（保存だけ・忘れた記憶を含む）を使ってコードが調べる（memory.write の検査。ここは触れない）
import { estimateTokens } from '../../web/token-estimate.mjs';
import { MEMORY_TIERS, oneLine } from './store.mjs';
import { CORE_ALWAYS_TOKENS, sameWorkspace, tieredOrder } from './tail.mjs';
import { SORT_REASON_MAX, workspaceNameOf } from './sort.mjs';

/** 1 回の呼び出しに渡す既存の記憶の合計の上限（トークン） */
export const NIGHTLY_MEMORY_TOKENS = 12_000;
/** 1 回の呼び出しの入力全体の目安（トークン。指示・人の発言・既存の記憶の合計）。記憶の分はこの残りに収める */
export const NIGHTLY_INPUT_TOKENS = 40_000;
/** 1 回の実行（呼び出しは 5 回まで）で付け直せる記憶の数の上限 */
export const NIGHTLY_TIER_CHANGES = 20;
/** 見積もりのずれを見込む余白（トークン） */
const MARGIN_TOKENS = 500;

const authorName = (a) => (a?.kind === 'bot' ? `bot:${a.botId ?? ''}` : a?.kind ?? null);
/** 人が書いた・直した行か（本文は書き換えず、置き換えを新しく書く。段も付け直さない） */
export const isHumanWritten = (entry) => entry?.by?.kind === 'human' || entry?.origBy?.kind === 'human';

/** AI へ渡す 1 件。重み・強さは渡さない（選び方にも付け直しにも使わない）。作業場所は短い名前だけ */
export const nightlyItemOf = (entry) => ({
  id: entry.id, layer: entry.layer, text: entry.text,
  ...(entry.kind ? { kind: entry.kind } : {}),
  ...(entry.status ? { status: entry.status } : {}),
  tier: entry.tier ?? null,
  ...(entry.workspace ? { workspace: workspaceNameOf(entry.workspace) } : {}),
  by: authorName(entry.by),
  ...(entry.origBy ? { origBy: authorName(entry.origBy) } : {}),
});

/** 記憶の分に使える残りのトークン（入力全体の目安から、指示と人の発言の分と余白を引き、記憶の上限で切る） */
export const nightlyMemoryBudget = (otherTokens) => Math.max(0, Math.min(NIGHTLY_MEMORY_TOKENS, NIGHTLY_INPUT_TOKENS - otherTokens - MARGIN_TOKENS));

/**
 * 夜の整理で AI へ渡す既存の記憶を選ぶ。
 *   entries … 全層の記憶（保存だけ・約束は入れない）。workspaces … 今回読む会話の正規の作業場所の配列。layers … 見る層（user と、読む会話の bot の id）
 *   budget … 記憶の合計の上限（トークン。既定は 12,000）。alwaysBudget … 「いつも」へ使う分（既定は配るときの枠）
 * 返りは { entries（渡す記憶。「いつも」が先）, tokens（見積もり）, omitted（候補にあって渡さなかった数）, total（保存だけ・約束を除いた全部の数） }
 */
export function selectNightlyCandidates(entries, { workspaces = [], layers = null, budget = NIGHTLY_MEMORY_TOKENS, alwaysBudget = CORE_ALWAYS_TOKENS } = {}) {
  const live = entries.filter((e) => e.tier !== 'archive' && e.kind !== 'promise');
  const here = (e) => workspaces.some((w) => sameWorkspace(e.workspace, w));
  const inLayer = (e) => !layers || layers.includes(e.layer);
  const cost = (e) => estimateTokens(JSON.stringify(nightlyItemOf(e))) + 3;
  const take = (list, limit) => {
    const picked = [];
    let used = 0;
    for (const e of [...list].sort(tieredOrder)) {
      const c = cost(e);
      if (used + c > limit) continue;
      picked.push(e);
      used += c;
    }
    return { picked, used };
  };
  const always = take(live.filter((e) => inLayer(e) && e.tier === 'always'), Math.min(alwaysBudget, budget));
  const related = take(live.filter((e) => inLayer(e) && (e.tier === 'workspace' ? here(e) : !e.tier && (!e.workspace || here(e)))), Math.max(0, budget - always.used));
  const picked = [...always.picked, ...related.picked];
  return { entries: picked, tokens: always.used + related.used, omitted: live.length - picked.length, total: live.length };
}

/**
 * AI の返りの tiers を読む。配列でなければ空。渡していない id・段の綴り違い・同じ id の 2 回目は捨てる（段の変更は渡した記憶だけ）。
 * 返りは [{ id, tier, reason }]（reason は 1 行・SORT_REASON_MAX 字まで）
 */
export function parseTierChanges(raw, sentIds) {
  if (!Array.isArray(raw)) return [];
  const sent = new Set(sentIds);
  const seen = new Set();
  const out = [];
  for (const row of raw) {
    if (!row || typeof row.id !== 'string' || !sent.has(row.id) || seen.has(row.id) || !MEMORY_TIERS.includes(row.tier)) continue;
    seen.add(row.id);
    out.push({ id: row.id, tier: row.tier, reason: [...oneLine(typeof row.reason === 'string' ? row.reason : '')].slice(0, SORT_REASON_MAX).join('') });
  }
  return out;
}

/**
 * 付け直しの候補を、実際に付ける段・作業場所に決める（付けるものが無ければ { skip: 理由 }）。workspace は、コードが決めた正規の作業場所（記憶に付いていればそれ）。
 *   約束・人が書いた記憶は付け直さない。今と同じ段は何もしない。「この作業場所で」へは、作業場所が決まらなければ付け直さない（保存だけへ隠さず、そのまま残す）。
 *   「いつも」「保存だけ」へ移すとき、付いていた作業場所は残す（戻すときの手がかり）
 */
export function decideNightlyTier(change, entry, workspace = null) {
  if (entry.kind === 'promise') return { skip: 'promise' };
  if (isHumanWritten(entry)) return { skip: 'human' };
  if ((entry.tier ?? null) === change.tier && change.tier !== 'workspace') return { skip: 'same' };
  const reason = change.reason || undefined;
  if (change.tier === 'workspace') {
    const place = entry.workspace || workspace;
    if (!place) return { skip: 'workspaceUnknown' };
    if (entry.tier === 'workspace' && entry.workspace === place) return { skip: 'same' };
    return { tier: 'workspace', workspace: place, reason };
  }
  return { tier: change.tier, workspace: entry.workspace ?? null, reason };
}
