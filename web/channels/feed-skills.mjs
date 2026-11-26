// チャンネルの流れの入力欄の「/」候補の「だれの・どこの」スキルを決める（web/channels/feed.mjs が ch-composer.mjs に渡す）。
// 候補の出し方・絞り込み・確定はスレッドの返信欄と同じ web/slash-skills.mjs。ここは、その部品に渡す 3 つだけを作る:
//   key(text)     … 引き先の印。宛先の bot（本文で @ した bot。誰も @ していなければ、呼べるメンバー）それぞれの動く場所（作業ディレクトリ）
//                    を束ねた文字列。同じ印の間は候補を使い回し、変われば取り直す（slash-skills の cwd の欄に入れる）
//   load(key)     … 印のとおり、動く場所ごとに core の slashSkills を引き、名前でまとめる（同じ名前は 1 行。どの bot のものかを持たせる）
//   headLabel/badge … 見出し（「Owl のスキル · パス」）と、複数の bot の候補が混ざるときの行頭の顔
// bot の動く場所は core の pickCwd と同じ判定（web/work-place.mjs。チャンネルのフォルダーが bot のフォルダーの中ならそこ、外なら bot のフォルダー）。
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { botIcon } from './bot-icon.mjs';
import { findMentionBlocks } from './mention-blocks.mjs';
import { createWorkPlaces } from './work-places.mjs';

/**
 * 候補を引く bot。本文で @ した bot（素の bot は除く。重複なし）。誰も @ していなければ fallback（呼べるメンバー。DM は DM の bot）。
 * 並びは bots・fallback の並び（書いた順にしない。同じ宛先なら同じ印になる）
 * @returns {{ bots: object[], from: 'mention'|'members' }}
 */
export function skillBots(text, { bots = [], fallback = [] } = {}) {
  const ids = new Set(findMentionBlocks(text, bots).filter((m) => !m.bot.plain).map((m) => m.bot.id));
  if (ids.size) return { bots: bots.filter((b) => ids.has(b.id)), from: 'mention' };
  return { bots: fallback.filter(Boolean), from: 'members' };
}

/**
 * bot を動く場所（作業ディレクトリ）ごとに束ねる。場所は places.of(bot, channelCwd).cwd（空は「既定の場所」）
 * @returns {{ from: string, groups: { cwd: string, botIds: string[] }[], key: string }}
 */
export function skillPlan(bots, channelCwd, places, from = 'members') {
  const byCwd = new Map();
  for (const bot of bots ?? []) {
    const cwd = places.of(bot, channelCwd).cwd || '';
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(bot.id);
  }
  const groups = [...byCwd].map(([cwd, botIds]) => ({ cwd, botIds })).sort((a, b) => (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
  return { from, groups, key: JSON.stringify({ from, groups }) };
}

/** skillPlan の key を戻す（読めない・空なら空の引き先） */
export function parsePlan(key) {
  try {
    const p = JSON.parse(key);
    const groups = Array.isArray(p?.groups) ? p.groups.filter((g) => g && Array.isArray(g.botIds)).map((g) => ({ cwd: String(g.cwd ?? ''), botIds: g.botIds.map(String) })) : [];
    return { from: p?.from === 'mention' ? 'mention' : 'members', groups };
  } catch { return { from: 'members', groups: [] }; }
}

/**
 * 動く場所ごとに取れたスキルを、名前で 1 行にまとめる。どの bot のものかを botIds に持たせる。同じ名前の説明は先に取れた方。名前順。
 * @param {{ botIds: string[], skills: object[] }[]} results
 */
export function mergeSkills(results) {
  const byName = new Map();
  for (const { botIds, skills } of results ?? []) {
    for (const s of skills ?? []) {
      if (!s?.name) continue;
      const hit = byName.get(s.name);
      if (!hit) byName.set(s.name, { ...s, botIds: [...botIds] });
      else for (const id of botIds) if (!hit.botIds.includes(id)) hit.botIds.push(id);
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 1 つの場所のスキルを core の slashSkills で引く。ほかの画面（コンテキスト・スレッドの返信欄）の探索と重なって SCAN_BUSY が返ったら、
 * 少し待って引き直す（web/context.mjs の callDocRetry と同じ。待つのは 200ms × 15 回まで）
 */
export async function scanSkills(host, cwd, { retries = 15, waitMs = 200 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const got = await host.cmd('slashSkills', { cwd: cwd || undefined });
      return Array.isArray(got) ? got : [];
    } catch (e) {
      if (e?.code !== 'SCAN_BUSY' || i >= retries) throw e;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * @param {object} o
 * @param {object} o.host cmd・state.homeDir
 * @param {() => object[]} o.allBots 本文の @ で呼べる bot（DM は空）
 * @param {() => object[]} o.fallback 誰も @ していないときの宛先（呼べるメンバー。DM は DM の bot）
 * @param {() => string|null} o.channelCwd チャンネルの既定の作業フォルダー
 * @returns {{ key: (text: string) => string, load: (key: string) => Promise<object[]>, headLabel: (key: string) => Node|string|null, badge: (skill: object) => Node|null, warm: () => void }}
 */
export function createFeedSkills({ host, allBots, fallback, channelCwd }) {
  const places = createWorkPlaces({ host });
  let shown = { plan: parsePlan(''), bots: new Map() };   // 今出している候補の引き先（見出し・行頭の顔に使う）
  const lookup = () => new Map([...(fallback() ?? []), ...(allBots() ?? [])].filter(Boolean).map((b) => [b.id, b]));
  // 場所ごとの組の並び（場所の名前順）ではなく、宛先の並び（@ なら呼べる bot の並び・メンバーならメンバーの並び）に揃える
  const botsOf = (plan, byId) => {
    const source = (plan.from === 'mention' ? allBots() : fallback()) ?? [];
    const rank = new Map(source.filter(Boolean).map((b, i) => [b.id, i]));
    return plan.groups.flatMap((g) => g.botIds).map((id) => byId.get(id)).filter(Boolean)
      .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  };

  return {
    key(text) {
      const { bots, from } = skillBots(text, { bots: allBots() ?? [], fallback: fallback() ?? [] });
      places.warm(bots);
      return skillPlan(bots, channelCwd() ?? null, places, from).key;
    },
    async load(key) {
      const byId = lookup();
      const asked = parsePlan(key);
      const bots = botsOf(asked, byId);
      await places.ensure(bots);   // モードの表が取れてから場所を決める（取る前は範囲を限れる扱い。取れた後の判定で引く）
      const plan = skillPlan(bots, channelCwd() ?? null, places, asked.from);
      // サーバーの探索は接続ごとに 1 つずつ（走っている間の 2 つ目は SCAN_BUSY）。場所ごとの取得は並べずに順に引く
      // 引く順は宛先の並び（同じ名前の説明は先に引いた bot のもの。顔の並びと同じ bot の説明になる）
      const rank = new Map(bots.map((b, i) => [b.id, i]));
      const first = (g) => Math.min(...g.botIds.map((id) => rank.get(id) ?? 1e9));
      const ok = [];
      let failure = null;
      for (const g of [...plan.groups].sort((a, b) => first(a) - first(b))) {
        try { ok.push({ botIds: g.botIds, skills: await scanSkills(host, g.cwd) }); }
        catch (e) { failure ??= e; }   // 1 か所が取れなくても、取れた場所の候補は出す
      }
      if (plan.groups.length && !ok.length) throw failure ?? new Error('slashSkills');
      shown = { plan, bots: byId };
      return mergeSkills(ok);
    },
    headLabel(key) {
      const plan = parsePlan(key);
      const byId = lookup();
      const bots = botsOf(plan, byId);
      if (!bots.length) return null;
      const lead = el('span', 'sk-head');
      if (bots.length === 1) {
        const cwd = plan.groups[0]?.cwd ?? '';
        lead.append(botIcon(bots[0], 'sk-face', 16), el('span', 'sk-who', t('channels:feed.skills.one', { name: bots[0].name })));
        if (cwd) { const where = el('code', 'sk-where', cwd); where.title = cwd; lead.append(where); }
        return lead;
      }
      lead.append(el('span', 'sk-who', plan.from === 'mention'
        ? t('channels:feed.skills.some', { names: bots.map((b) => b.name).join(t('channels:feed.reactionSep')) })
        : t('channels:feed.skills.members')));
      return lead;
    },
    /** 複数の bot の候補が混ざるときだけ、そのスキルを持つ bot の顔を行頭に（1 体なら見出しに出ているので付けない） */
    badge(skill) {
      const all = botsOf(shown.plan, shown.bots);
      if (all.length < 2) return null;
      const mine = new Set(skill?.botIds ?? []);
      const owners = all.filter((b) => mine.has(b.id));
      if (!owners.length) return null;
      const faces = el('span', 'sk-faces');
      faces.title = owners.map((b) => b.name).join(t('channels:feed.reactionSep'));
      faces.append(...owners.map((b) => botIcon(b, 'sk-face', 16)));
      return faces;
    },
    /** 呼べる bot のモードの表を先に取っておく（初めて「/」を打ったとき、場所の判定が後から変わって取り直しにならないように） */
    warm() { places.warm(allBots() ?? []); places.warm(fallback() ?? []); },
  };
}
