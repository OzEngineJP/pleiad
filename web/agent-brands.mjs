// エージェントのロゴと短い名前（サーバーのエージェントの記述 core/backends/agents.mjs。describeBackends の brand・shortLabel）。
// 吹き出し・知らせ・読み上げの `{{agent}}` に入れる名前は agentName() だけが返す（内部の id は出さない）。
// 画面は id ごとの表を持たず、エージェントの一覧を受けたとき（web/client.mjs の loadBackends）にここへ入れる。DOM に依存しない
import { t } from './i18n.mjs';

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

// サーバーが表と一緒に渡す列の表示名（id -> 名前。doc・MCP・Hooks の表の `labels`）。有効なエージェントの一覧に無い列（devin・grok を止めている画面）でも、内部の id を出さないための控え
const named = new Map();

/** 表（instGrid・skillGrid・mcpMatrix・hooksMatrix）の `labels` を控える。吹き出し・知らせ・読み上げの `{{agent}}` が、一覧に無い id でも表示名になる */
export function rememberAgentNames(labels) {
  if (!labels || typeof labels !== 'object') return;
  for (const [id, name] of Object.entries(labels)) if (id && typeof name === 'string' && name) named.set(id, name);
}

/** 控えた表示名を空にする（試験用。画面は表を受けるたびに足すだけで、消さない）。 */
export const forgetAgentNames = () => named.clear();

/** 区切りに出す短い名前。エージェントの一覧に無ければ表が渡した名前。どちらにも無ければ null（内部の id は返さない） */
export const agentShortLabel = (id) => agents.get(id)?.shortLabel ?? agents.get(id)?.label ?? named.get(id) ?? null;

/**
 * 吹き出し・知らせ・読み上げの `{{agent}}` に入れる表示名（行の鍵・マスの鍵・右の欄の理由・凡例・確認の帯で同じ）。
 * エージェントの一覧 → 表が渡した名前（`labels`）の順に引き、どちらにも無ければ「いずれかのエージェント」。内部の id（antigravity・opencode など）は返さない
 */
export const agentName = (id) => agentShortLabel(id) ?? t('context.someAgent');

/** 正式名。知らない id なら null */
export const agentLabel = (id) => agents.get(id)?.label ?? null;

/** 会話を始めるときだけ設定を読むエージェント（記述の contextAt: 'conversation'）の id。始まっている会話には次のターンでも届かない */
export const conversationContextAgents = () => [...agents].filter(([, a]) => a.contextAt === 'conversation').map(([id]) => id);

/** ロゴのあるエージェントの id（一覧の順） */
export const brandedAgents = () => [...agents].filter(([, a]) => a.brand).map(([id]) => id);
