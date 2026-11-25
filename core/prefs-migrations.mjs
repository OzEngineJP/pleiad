// 設定（prefs.json）の一度きりの移行。データの形式番号は上げない（DB の形は変えず、前の版へ戻れなくしないため）。
// 済んだ移行の名前は prefs.json の migrations（文字列の配列）に残し、二度は走らせない。前の版も prefs.json の知らない項目を
// そのまま書き戻す（core/store.mjs の jsonFile は読んだ全体を書く）ので、版を戻して上げ直しても印は残り、もう走らない。
//
// devin-acp-candidates（ADR 0356）: 委譲の自動選択の段（delegationRouting.tiers）に保存した Devin の候補は、前のモデル名
// （`devin models list` のカタログの名前）で、今の CLI では選べない。読み替えずに全部外し、利用者に新しい一覧から選び直してもらう。
// 印を立てた後は、選び直した Devin の候補に触れない。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertNotGuarded } from './test-guard.mjs';
import { parseCandidate } from './delegation-routing.mjs';

export const DEVIN_ACP_CANDIDATES = 'devin-acp-candidates';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const exists = file => { try { fs.accessSync(file); return true; } catch { return false; } };

/** prefs の委譲の設定から、Devin の候補（backend が devin のもの。アカウント付きも）とその強さの上書きを外した写しと、外した候補 */
export function withoutDevinCandidates(prefs) {
  const routing = isObject(prefs) ? prefs.delegationRouting : null;
  if (!isObject(routing)) return { prefs, removed: [] };
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
 * 起動で 1 回だけ、委譲の段から Devin の候補を外して印（migrations に DEVIN_ACP_CANDIDATES）を立てる（同期。データ置き場のロックを持って、
 * store が prefs.json を読む前に呼ぶ）。印があれば何もしない（null）。
 * 候補を外すときは移す前の prefs.json を backup-prefs-<日時>/ へ写す。書き込みは一時ファイルから置き換え、読み戻して確かめる。
 * 失敗したら投げる（印は立たず、次の起動でやり直す。外す処理は何度走っても同じ結果）。prefs.json が読めない（壊れている）ときは触らずに投げる。
 * prefs.json が無い置き場は印だけの prefs.json を作る（後で選んだ Devin の候補を、次の起動で外さないため）。
 * 戻り値: { count, backup }（外した数と写しの場所。外すものが無ければ backup は null）か null。afterPrefsWrite は試験が失敗を差し込むためのもの
 */
export function removeDevinCandidatesOnce(dir, { now = new Date(), afterPrefsWrite } = {}) {
  const file = path.join(dir, 'prefs.json');
  let original = null;
  try { original = fs.readFileSync(file, 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  const prefs = original === null ? {} : JSON.parse(original);
  if (!isObject(prefs)) throw new Error('prefs.json is not an object');
  if (Array.isArray(prefs.migrations) && prefs.migrations.includes(DEVIN_ACP_CANDIDATES)) return null;
  assertNotGuarded(dir, 'migrate settings in');
  const { prefs: cleaned, removed } = withoutDevinCandidates(prefs);
  const next = { ...cleaned, migrations: [...(Array.isArray(prefs.migrations) ? prefs.migrations : []), DEVIN_ACP_CANDIDATES] };
  let backup = null;
  if (removed.length || cleaned !== prefs) {
    backup = path.join(dir, `backup-prefs-${stamp(now)}`);
    for (let n = 2; exists(backup); n++) backup = path.join(dir, `backup-prefs-${stamp(now)}-${n}`);
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'prefs.json'), original, 'utf8');
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    // core/store.mjs の jsonFile と同じ書き方（字下げ 2）
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    afterPrefsWrite?.();
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
  if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), next)) throw new Error('read-back differs from the migrated prefs.json');
  return { count: removed.length, backup };
}
