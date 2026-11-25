// 設定（prefs.json）の一度きりの移行。データの形式番号は上げない（DB の形は変えず、前の版へ戻れなくしないため）。
// このファイルは書かない: 設定を受け取って、移行した設定を返すだけ。書き込みは core/store.mjs の migratePrefs が、
// setPref と同じ口（一時ファイルから置き換え）で行う（新しい書き込みの口を足さない。tests/data-writes-allowlist.mjs）。
// 済んだ移行の名前は prefs.json の migrations（文字列の配列）に残し、二度は走らせない。前の版も prefs.json の知らない項目を
// そのまま書き戻す（core/store.mjs の jsonFile は読んだ全体を書く）ので、版を戻して上げ直しても印は残り、もう走らない。
//
// devin-acp-candidates（ADR 0356）: 委譲の自動選択の段（delegationRouting.tiers）に保存した Devin の候補は、前のモデル名
// （`devin models list` のカタログの名前）で、今の CLI では選べない。読み替えずに全部外し、利用者に新しい一覧から選び直してもらう。
// 印を立てた後は、選び直した Devin の候補に触れない。
import { isDeepStrictEqual } from 'node:util';
import { parseCandidate } from './delegation-routing.mjs';

export const DEVIN_ACP_CANDIDATES = 'devin-acp-candidates';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** prefs の委譲の設定から、Devin の候補（backend が devin のもの。アカウント付きも）とその強さの上書きを外した写しと、外した候補 */
export function withoutDevinCandidates(prefs) {
  const routing = isObject(prefs) ? prefs.delegationRouting : null;
  if (!isObject(routing)) return { prefs, removed: [] };
  // backend-allow: 1 回きりの移行は Devin の保存済みの候補だけを名指しで外す（別のエージェントへ広げない。ADR 0356）。能力の印・記述からは引けない
  const isDevin = id => parseCandidate(id)?.backend === 'devin';
  const removed = [];
  const next = { ...routing };
  if (isObject(routing.tiers)) {
    next.tiers = Object.fromEntries(Object.entries(routing.tiers).map(([level, list]) => {
      if (!Array.isArray(list)) return [level, list];
      for (const id of list) if (isDevin(id)) removed.push(id);
      return [level, list.filter(id => !isDevin(id))];
    }));
  }
  // 候補ごとの強さの上書き（efforts[段][候補]）も、外した候補の分を外す（'*' は段の既定なので残す）
  if (isObject(routing.efforts)) {
    next.efforts = Object.fromEntries(Object.entries(routing.efforts).map(([level, row]) =>
      [level, isObject(row) ? Object.fromEntries(Object.entries(row).filter(([key]) => !isDevin(key))) : row]));
  }
  return isDeepStrictEqual(next, routing) ? { prefs, removed } : { prefs: { ...prefs, delegationRouting: next }, removed };
}

/**
 * 起動で 1 回だけ、委譲の段から Devin の候補を外して印（migrations に DEVIN_ACP_CANDIDATES）を立てた設定を返す（同期・純粋。
 * store.migratePrefs(removeDevinCandidatesOnce) に渡す。データ置き場のロックを持って、store が prefs.json を読む前に呼ぶ）。
 * 印があれば何もしない（null。store は書かない）。外す候補が無くても印は立てる（後で選んだ Devin の候補を、次の起動で外さないため）。
 * 戻り値: { prefs, count }（移行した設定と、外した数）か null。ほかの移行の名前は残して後ろに足す。
 */
export function removeDevinCandidatesOnce(prefs) {
  const done = isObject(prefs) && Array.isArray(prefs.migrations) ? prefs.migrations : [];
  if (done.includes(DEVIN_ACP_CANDIDATES)) return null;
  const { prefs: cleaned, removed } = withoutDevinCandidates(prefs);
  return { prefs: { ...cleaned, migrations: [...done, DEVIN_ACP_CANDIDATES] }, count: removed.length };
}
