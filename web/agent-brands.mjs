// エージェントのロゴと短い名前（サーバーのエージェントの記述 core/backends/agents.mjs。describeBackends の brand・shortLabel）。
// 画面は id ごとの表を持たず、エージェントの一覧を受けたとき（web/client.mjs の loadBackends）にここへ入れる。DOM に依存しない
const agents = new Map();   // id -> { label, shortLabel, brand: { logo, mark } | null }

/** エージェントの一覧（describeBackends の行）を入れ直す。並びは一覧の順 */
export function setAgentBrands(list) {
  agents.clear();
  for (const b of Array.isArray(list) ? list : []) {
    if (!b?.id) continue;
    agents.set(b.id, { label: b.label ?? b.id, shortLabel: b.shortLabel ?? null, brand: b.brand?.logo ? { logo: b.brand.logo, mark: Boolean(b.brand.mark) } : null });
  }
}

/** ロゴ（web/brand/ のファイル名と描き方）。無ければ null */
export const agentBrand = (id) => agents.get(id)?.brand ?? null;

/** 区切りに出す短い名前。無ければ正式名 */
export const agentShortLabel = (id, fallback = id) => agents.get(id)?.shortLabel ?? agents.get(id)?.label ?? fallback;

/** 正式名。知らない id なら null */
export const agentLabel = (id) => agents.get(id)?.label ?? null;

/** ロゴのあるエージェントの id（一覧の順） */
export const brandedAgents = () => [...agents].filter(([, a]) => a.brand).map(([id]) => id);
