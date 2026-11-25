// 設定（prefs.json）の一度きりの移行（core/prefs-migrations.mjs、ADR 0356）。
// 委譲の段の Devin の候補だけを外す・ほかは残す・印が立つ・2 回目は何もしない・版を戻して上げ直しても印で何もしない・書き込みに失敗したらやり直せる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeDevinCandidatesOnce, DEVIN_ACP_CANDIDATES } from '../../core/prefs-migrations.mjs';
import { DATA_SCHEMA } from '../../core/data-schema.mjs';

export const name = 'prefs-migrations';
export const title = '設定の一度きりの移行: 委譲の段の Devin の候補を印で 1 回だけ外す（形式番号は上げない）';

const read = file => fs.readFile(file, 'utf8').catch(() => null);
const canon = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const sameJson = (a, b) => canon(a) === canon(b);

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-prefs-migrations-'));
  let n = 0;
  const place = async prefs => {
    const dir = path.join(root, `d${n++}`);
    await fs.mkdir(dir, { recursive: true });
    if (prefs !== undefined) await fs.writeFile(path.join(dir, 'prefs.json'), typeof prefs === 'string' ? prefs : JSON.stringify(prefs, null, 2));
    return dir;
  };
  const prefsOf = async dir => JSON.parse(await read(path.join(dir, 'prefs.json')));
  const backups = async dir => (await fs.readdir(dir)).filter(name => name.startsWith('backup-prefs-'));
  const routing = () => ({
    avoidPercent: 70,
    tiers: {
      t1: ['devin:swe-1-6', 'claude:haiku'],
      t2: ['codex:gpt-6-luna', 'devin@acct-x:glm-5', 'antigravity:gemini-3.8-flash-high'],
      t3: ['devin:swe-2-high'],
      t4: ['claude:opus'],
    },
    efforts: { t1: { '*': 'low', 'devin:swe-1-6': 'high', 'claude:haiku': '' }, t3: { '*': 'medium', 'devin:swe-2-high': 'max' } },
  });
  try {
    t.ok('データの形式番号は 4 のまま（設定だけの移行で版を上げない）', DATA_SCHEMA === 4, String(DATA_SCHEMA));

    const original = { locale: 'ja', delegationRouting: routing(), backends: { devin: { model: 'swe-1-6' } } };
    const dir = await place(original);
    const result = removeDevinCandidatesOnce(dir);
    const after = await prefsOf(dir);
    t.ok('委譲の段から Devin の候補（アカウント付きも）だけを外し、ほかのエージェントの候補は順のまま残す',
      sameJson(after.delegationRouting.tiers, { t1: ['claude:haiku'], t2: ['codex:gpt-6-luna', 'antigravity:gemini-3.8-flash-high'], t3: [], t4: ['claude:opus'] }),
      JSON.stringify(after.delegationRouting.tiers));
    t.ok('外した候補の強さの上書きも外し、段の既定（*）・ほかの候補の上書き・ほかの設定は変えない',
      sameJson(after.delegationRouting.efforts, { t1: { '*': 'low', 'claude:haiku': '' }, t3: { '*': 'medium' } }) && after.delegationRouting.avoidPercent === 70
        && after.locale === 'ja' && after.backends.devin.model === 'swe-1-6',
      JSON.stringify(after));
    t.ok('印（migrations に devin-acp-candidates）が立つ', sameJson(after.migrations, [DEVIN_ACP_CANDIDATES]), JSON.stringify(after.migrations));
    const names = await backups(dir);
    t.ok('外した数と写しの場所を返す（写しは移す前の prefs.json そのまま）', result?.count === 3 && names.length === 1 && result.backup === path.join(dir, names[0])
      && sameJson(JSON.parse(await read(path.join(result.backup, 'prefs.json'))), original), JSON.stringify(result));

    // 利用者が新しい一覧から選び直した Devin の候補は、次の起動で消さない
    const chosen = { ...after, delegationRouting: { ...after.delegationRouting, tiers: { ...after.delegationRouting.tiers, t3: ['devin:swe-2-high'] } } };
    await fs.writeFile(path.join(dir, 'prefs.json'), JSON.stringify(chosen, null, 2));
    t.ok('2 回目の起動は何もしない（選び直した Devin の候補が残る・写しも増えない）',
      removeDevinCandidatesOnce(dir) === null && sameJson(await prefsOf(dir), chosen) && (await backups(dir)).length === 1);

    // 前の版（印を知らない）は prefs.json の全体を読んで書き戻す（core/store.mjs の jsonFile）。そこで Devin の候補を選んでから版を上げ直す
    const downgraded = { ...(await prefsOf(dir)), locale: 'en' };
    downgraded.delegationRouting.tiers.t1 = ['devin:swe-2-high', 'claude:haiku'];
    await fs.writeFile(path.join(dir, 'prefs.json'), JSON.stringify(downgraded, null, 2));
    t.ok('前の版に戻して上げ直しても、印が残っていれば何もしない', removeDevinCandidatesOnce(dir) === null && sameJson(await prefsOf(dir), downgraded));

    // 前の版で済ませた別の移行の名前があれば、残して後ろに足す
    const other = await place({ migrations: ['someday'], delegationRouting: { tiers: { t1: ['claude:haiku'] } } });
    const otherResult = removeDevinCandidatesOnce(other);
    t.ok('Devin の候補が無ければ候補は変えず、写しも作らずに印だけ立てる（ほかの移行の名前は残す）',
      otherResult?.count === 0 && otherResult.backup === null && (await backups(other)).length === 0
        && sameJson(await prefsOf(other), { migrations: ['someday', DEVIN_ACP_CANDIDATES], delegationRouting: { tiers: { t1: ['claude:haiku'] } } }));

    const fresh = await place(undefined);
    t.ok('prefs.json が無い置き場は印だけの prefs.json を作る（後で選んだ Devin の候補を次の起動で外さない）',
      removeDevinCandidatesOnce(fresh)?.count === 0 && sameJson(await prefsOf(fresh), { migrations: [DEVIN_ACP_CANDIDATES] }) && removeDevinCandidatesOnce(fresh) === null);

    const broken = await place('{"delegationRouting":');
    const brokenError = (() => { try { removeDevinCandidatesOnce(broken); return null; } catch (e) { return e; } })();
    t.ok('壊れた prefs.json には触れずに失敗を返す（印も立たない）', !!brokenError && (await read(path.join(broken, 'prefs.json'))) === '{"delegationRouting":');

    // 書き込みに失敗したら、prefs.json は元のまま・印は立たず、次の起動でやり直せる
    const failing = await place({ delegationRouting: routing() });
    const before = await read(path.join(failing, 'prefs.json'));
    const error = (() => { try { removeDevinCandidatesOnce(failing, { afterPrefsWrite: () => { throw new Error('injected'); } }); return null; } catch (e) { return e; } })();
    t.ok('書き込みの途中で失敗したら投げ、prefs.json は 1 バイトも変わらない（印も立たない・一時ファイルも残さない）',
      error?.message === 'injected' && (await read(path.join(failing, 'prefs.json'))) === before
        && !(await fs.readdir(failing)).some(name => name.endsWith('.tmp')));
    const retry = removeDevinCandidatesOnce(failing);
    const retried = await prefsOf(failing);
    t.ok('原因が無くなれば次の起動でやり直せる（結果は同じ・印が立つ）', retry?.count === 3
      && sameJson(retried.delegationRouting.tiers.t1, ['claude:haiku']) && sameJson(retried.migrations, [DEVIN_ACP_CANDIDATES]));
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
