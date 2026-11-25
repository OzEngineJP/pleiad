// 設定（prefs.json）の一度きりの移行（core/prefs-migrations.mjs、ADR 0356）。
// 委譲の段の Devin の候補だけを外す・ほかは残す・印が立つ・2 回目は何もしない・版を戻して上げ直しても印で何もしない・書き込みに失敗したらやり直せる。
// 移行そのものは設定を受け取って返すだけの純粋な関数（ここで直接試す）。書き込みは core/store.mjs の migratePrefs（setPref と同じ口）を通るので、
// store が使い捨ての置き場を読み込み時に決める都合で、子プロセスで起動 1 回分ずつ試す（server.mjs と同じ呼び方）。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeDevinCandidatesOnce, DEVIN_ACP_CANDIDATES } from '../../core/prefs-migrations.mjs';
import { DATA_SCHEMA } from '../../core/data-schema.mjs';
import { ROOT } from '../lib/server.mjs';

export const name = 'prefs-migrations';
export const title = '設定の一度きりの移行: 委譲の段の Devin の候補を印で 1 回だけ外す（形式番号は上げない・書き込みは store の設定の口）';

const canon = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const sameJson = (a, b) => canon(a) === canon(b);
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
const WITHOUT_DEVIN = {
  tiers: { t1: ['claude:haiku'], t2: ['codex:gpt-6-luna', 'antigravity:gemini-3.8-flash-high'], t3: [], t4: ['claude:opus'] },
  efforts: { t1: { '*': 'low', 'claude:haiku': '' }, t3: { '*': 'medium' } },
};

// 起動 1 回分: 新しい store（データ置き場は読み込み時に決まる）に、server.mjs と同じく migratePrefs(removeDevinCandidatesOnce) を呼ぶ。
// 結果は最後の 1 行の JSON
const script = `
import fs from 'node:fs/promises';
import path from 'node:path';
const routing = JSON.parse(process.env.ROUTING);
let n = 0;
const place = async prefs => {
  const dir = path.join(process.env.TEST_ROOT, 'd' + n++);
  await fs.mkdir(dir, { recursive: true });
  if (prefs !== undefined) await fs.writeFile(path.join(dir, 'prefs.json'), typeof prefs === 'string' ? prefs : JSON.stringify(prefs, null, 2));
  return dir;
};
const text = dir => fs.readFile(path.join(dir, 'prefs.json'), 'utf8').catch(() => null);
const parsed = async dir => JSON.parse(await text(dir));
const boot = async dir => {
  process.env.AGENT_HOST_DATA = dir;
  const store = await import(process.env.STORE_URL + '?boot=' + n++);
  const mig = await import(process.env.MIG_URL);
  let result = null, error = null;
  try { result = await store.migratePrefs(mig.removeDevinCandidatesOnce); } catch (e) { error = String(e && e.message || e); }
  return { store, result: result && { count: result.count }, error };
};
const out = {};

// 1 回目: 外れる・印が立つ・ほかは残る。メモリの設定（getPrefs）もファイルと同じ
const original = { locale: 'ja', delegationRouting: routing, backends: { devin: { model: 'swe-1-6' } } };
const dir = await place(original);
const first = await boot(dir);
out.first = { result: first.result, error: first.error, file: await parsed(dir), memory: await first.store.getPrefs(), files: await fs.readdir(dir) };

// 利用者が新しい一覧から選び直した Devin の候補は、次の起動で消さない
const chosen = await parsed(dir);
chosen.delegationRouting.tiers.t3 = ['devin:swe-2-high'];
await fs.writeFile(path.join(dir, 'prefs.json'), JSON.stringify(chosen, null, 2));
const chosenText = await text(dir);
const second = await boot(dir);
out.second = { result: second.result, error: second.error, same: (await text(dir)) === chosenText };

// 前の版（印を知らない）は prefs.json の全体を読んで書き戻す。そこで Devin の候補を選んでから版を上げ直す
const downgraded = await parsed(dir);
downgraded.locale = 'en';
downgraded.delegationRouting.tiers.t1 = ['devin:swe-2-high', 'claude:haiku'];
await fs.writeFile(path.join(dir, 'prefs.json'), JSON.stringify(downgraded, null, 2));
const downgradedText = await text(dir);
const third = await boot(dir);
out.third = { result: third.result, error: third.error, same: (await text(dir)) === downgradedText };

// 前の版で済ませた別の移行の名前があれば、残して後ろに足す。Devin の候補が無ければ候補は変えない
const other = await place({ migrations: ['someday'], delegationRouting: { tiers: { t1: ['claude:haiku'] } } });
const otherBoot = await boot(other);
out.other = { result: otherBoot.result, error: otherBoot.error, file: await parsed(other), files: await fs.readdir(other) };

// prefs.json が無い置き場は印だけの prefs.json を作る。2 回目は何もしない
const fresh = await place(undefined);
const freshBoot = await boot(fresh);
const freshFile = await parsed(fresh);
const freshAgain = await boot(fresh);
out.fresh = { result: freshBoot.result, error: freshBoot.error, file: freshFile, againResult: freshAgain.result };

// 壊れた prefs.json には触れずに失敗を返す（印も立たない）
const brokenText = '{"delegationRouting":';
const broken = await place(brokenText);
const brokenBoot = await boot(broken);
out.broken = { result: brokenBoot.result, error: brokenBoot.error, same: (await text(broken)) === brokenText, files: await fs.readdir(broken) };

// 書き込みの途中（置き換え）で失敗したら、prefs.json は元のまま・メモリも元のまま・印は立たず、次の起動でやり直せる
const failing = await place({ delegationRouting: routing });
const failingText = await text(failing);
const fsp = (await import('node:fs/promises')).default;
const realRename = fsp.rename;
fsp.rename = async () => { throw new Error('injected'); };
const failed = await boot(failing);
fsp.rename = realRename;
const failedMemory = await failed.store.getPrefs();
const failedSame = (await text(failing)) === failingText;
const retried = await boot(failing);
out.failing = { error: failed.error, same: failedSame, memory: failedMemory, retry: retried.result, retryFile: await parsed(failing) };

console.log(JSON.stringify(out));
`;

export default async function (t) {
  t.ok('データの形式番号は 4 のまま（設定だけの移行で版を上げない）', DATA_SCHEMA === 4, String(DATA_SCHEMA));

  // ---- 移行そのもの（純粋）
  const original = { locale: 'ja', delegationRouting: routing(), backends: { devin: { model: 'swe-1-6' } } };
  const snapshot = JSON.parse(JSON.stringify(original));
  const pure = removeDevinCandidatesOnce(original);
  t.ok('委譲の段から Devin の候補（アカウント付きも）だけを外し、ほかのエージェントの候補は順のまま残す',
    sameJson(pure?.prefs.delegationRouting.tiers, WITHOUT_DEVIN.tiers), JSON.stringify(pure?.prefs.delegationRouting.tiers));
  t.ok('外した候補の強さの上書きも外し、段の既定（*）・ほかの候補の上書き・ほかの設定は変えない',
    sameJson(pure?.prefs.delegationRouting.efforts, WITHOUT_DEVIN.efforts) && pure.prefs.delegationRouting.avoidPercent === 70
      && pure.prefs.locale === 'ja' && pure.prefs.backends.devin.model === 'swe-1-6', JSON.stringify(pure?.prefs));
  t.ok('印（migrations に devin-acp-candidates）が立ち、外した数を返す・渡した設定は書き換えない',
    sameJson(pure?.prefs.migrations, [DEVIN_ACP_CANDIDATES]) && pure.count === 3 && sameJson(original, snapshot), JSON.stringify(pure));
  t.ok('印があれば何もしない（null。選び直した Devin の候補も残す）',
    removeDevinCandidatesOnce(pure.prefs) === null && removeDevinCandidatesOnce({ migrations: [DEVIN_ACP_CANDIDATES], delegationRouting: { tiers: { t1: ['devin:swe-2-high'] } } }) === null);
  const someday = removeDevinCandidatesOnce({ migrations: ['someday'], delegationRouting: { tiers: { t1: ['claude:haiku'] } } });
  t.ok('Devin の候補が無ければ候補は変えずに印だけ立てる（ほかの移行の名前は残して後ろに足す）',
    someday?.count === 0 && sameJson(someday.prefs, { migrations: ['someday', DEVIN_ACP_CANDIDATES], delegationRouting: { tiers: { t1: ['claude:haiku'] } } }), JSON.stringify(someday));
  t.ok('設定が空でも印だけ立てる（後で選んだ Devin の候補を次の起動で外さない）',
    sameJson(removeDevinCandidatesOnce({})?.prefs, { migrations: [DEVIN_ACP_CANDIDATES] }));

  // ---- 書き込みは store の設定の口（子プロセスで起動 1 回分ずつ）
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-prefs-migrations-'));
  try {
    const url = file => pathToFileURL(path.join(ROOT, file)).href;
    const stdout = await new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TEST_ROOT: root, ROUTING: JSON.stringify(routing()), STORE_URL: url('core/store.mjs'), MIG_URL: url('core/prefs-migrations.mjs') },
    }, (err, out, errOut) => err ? rej(new Error(`${err.message}\n${errOut}`)) : res(out)));
    const r = JSON.parse(stdout.trim().split(/\r?\n/).pop());

    t.ok('1 回目の起動: prefs.json から Devin の候補だけが外れ、印が立ち、ほかの設定は残る（写しの置き場は作らない）',
      !r.first.error && r.first.result?.count === 3 && sameJson(r.first.file.delegationRouting.tiers, WITHOUT_DEVIN.tiers)
        && sameJson(r.first.file.delegationRouting.efforts, WITHOUT_DEVIN.efforts) && sameJson(r.first.file.migrations, [DEVIN_ACP_CANDIDATES])
        && r.first.file.locale === 'ja' && r.first.file.backends.devin.model === 'swe-1-6'
        && r.first.files.length === 1 && r.first.files[0] === 'prefs.json', JSON.stringify(r.first));
    t.ok('起動のあとの store の設定（getPrefs）は、書いたファイルと同じ', sameJson(r.first.memory, r.first.file), JSON.stringify(r.first.memory));
    t.ok('2 回目の起動は何もしない（選び直した Devin の候補が残る・ファイルは 1 バイトも変わらない）',
      !r.second.error && r.second.result === null && r.second.same === true, JSON.stringify(r.second));
    t.ok('前の版に戻して上げ直しても、印が残っていれば何もしない', !r.third.error && r.third.result === null && r.third.same === true, JSON.stringify(r.third));
    t.ok('Devin の候補が無ければ候補は変えず、印だけ立てる（ほかの移行の名前は残す・余分なファイルを作らない）',
      !r.other.error && r.other.result?.count === 0 && r.other.files.length === 1
        && sameJson(r.other.file, { migrations: ['someday', DEVIN_ACP_CANDIDATES], delegationRouting: { tiers: { t1: ['claude:haiku'] } } }), JSON.stringify(r.other));
    t.ok('prefs.json が無い置き場は印だけの prefs.json を作り、次の起動は何もしない',
      !r.fresh.error && r.fresh.result?.count === 0 && sameJson(r.fresh.file, { migrations: [DEVIN_ACP_CANDIDATES] }) && r.fresh.againResult === null, JSON.stringify(r.fresh));
    t.ok('壊れた prefs.json には触れずに失敗を返す（印も立たない・ファイルも増えない）',
      !!r.broken.error && r.broken.result === null && r.broken.same === true && r.broken.files.length === 1, JSON.stringify(r.broken));
    t.ok('書き込みの途中で失敗したら投げ、prefs.json もメモリの設定も元のまま（印も立たない）',
      r.failing.error === 'injected' && r.failing.same === true && sameJson(r.failing.memory, { delegationRouting: routing() }), JSON.stringify(r.failing));
    t.ok('原因が無くなれば次の起動でやり直せる（結果は同じ・印が立つ）',
      r.failing.retry?.count === 3 && sameJson(r.failing.retryFile.delegationRouting.tiers.t1, ['claude:haiku'])
        && sameJson(r.failing.retryFile.migrations, [DEVIN_ACP_CANDIDATES]), JSON.stringify(r.failing.retryFile));
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
