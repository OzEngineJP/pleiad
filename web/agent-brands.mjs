// エージェントのロゴと短い名前（サーバーのエージェントの記述 core/backends/agents.mjs。describeBackends の brand・shortLabel）。
// 画面は id ごとの表を持たず、エージェントの一覧を受けたとき（web/client.mjs の loadBackends）にここへ入れる。DOM に依存しない
const agents = new Map();   // id -> { label, shortLabel, brand: { logo, mark } | null, contextAt: 'turn' | 'conversation' | null }

/** エージェントの一覧（describeBackends の行）を入れ直す。並びは一覧の順。表示に使う対応が変わったかを返す */
export function setAgentBrands(list) {
  const next = new Map();
  for (const b of Array.isArray(list) ? list : []) {
    if (!b?.id) continue;
    next.set(b.id, { label: b.label ?? b.id, shortLabel: b.shortLabel ?? null, brand: b.brand?.logo ? { logo: b.brand.logo, mark: Boolean(b.brand.mark) } : null, contextAt: b.contextAt ?? null });
  }
  const changed = next.size !== agents.size || [...next].some(([id, a]) => {
    const prev = agents.get(id);
    return !prev || prev.label !== a.label || prev.shortLabel !== a.shortLabel || prev.contextAt !== a.contextAt
      || prev.brand?.logo !== a.brand?.logo || prev.brand?.mark !== a.brand?.mark;
  });
  agents.clear();
  for (const [id, a] of next) agents.set(id, a);
  return changed;
}

/** ロゴ（web/brand/ のファイル名と描き方）。無ければ null */
export const agentBrand = (id) => agents.get(id)?.brand ?? null;

/** 区切りに出す短い名前。無ければ正式名 */
export const agentShortLabel = (id, fallback = id) => agents.get(id)?.shortLabel ?? agents.get(id)?.label ?? fallback;

/** 正式名。知らない id なら null */
export const agentLabel = (id) => agents.get(id)?.label ?? null;

/** 会話を始めるときだけ設定を読むエージェント（記述の contextAt: 'conversation'）の id。始まっている会話には次のターンでも届かない */
export const conversationContextAgents = () => [...agents].filter(([, a]) => a.contextAt === 'conversation').map(([id]) => id);

/** ロゴのあるエージェントの id（一覧の順） */
export const brandedAgents = () => [...agents].filter(([, a]) => a.brand).map(([id]) => id);
