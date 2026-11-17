// Claude の起動（会話・保持役の起動の変換・内部ターン・題の生成・モデル一覧・コネクター一覧・使用量）を、変更前の main の記録で固定する（段 0。ADR 0339）。
// LLM も本物の CLI も呼ばない（起動の入力を記録する偽の CLI。tests/lib/launch-record-cli.mjs）。認証の値は固定の偽物だけ。
//   - 期待値は tests/fixtures/claude-launch-main.json。「親の env × アカウント × 接続先」× 経路ごとの、SDK に渡した options と、実際に起こされた CLI の argv・cwd・env の記録の
//     sha256 と、認証に関わる env の値。このブランチの組み立ての関数からは作らない（旧い道が変わると両方が一緒にずれて気づけないため）
//   - 含めない経路: 保持役に載せるかの判断（heldPlan。保持役の実体が要る）と、その先の保持役の中の動き。保持役への起動の変換（createHeldCli の spawn）だけを記録する。
//     付け直し（adoptTurn）は runTurn に同じ options を渡すだけなので別には記録しない
//   - fixture の採り直し（main の値を取り直すときだけ）:
//       1. main の commit を別の worktree に出す（git worktree add --detach <作業用>/main-wt main）。node_modules はリンクを張る（cmd /c mklink /J）
//       2. この試験の記録の道具（tests/lib/claude-launch-record.mjs と launch-record-cli.mjs、fake-claude.mjs）は、このブランチのものを使う（root だけを main-wt に向ける）:
//          LAUNCH_RECORD_ROOT=<作業用>/main-wt LAUNCH_RECORD_WRITE=<書き出す先> node tests/run.mjs claude-launch-main-pinned
//       3. 書き出した JSON を tests/fixtures/claude-launch-main.json へ写す
//       4. 中のリンク（node_modules）を cmd /c rmdir で外してから git worktree remove で消す
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAll, digest, scenarios, FAKE } from '../lib/claude-launch-record.mjs';

export const name = 'claude-launch-main-pinned';
export const title = 'Claude の起動: 全経路 × 親の env・アカウント・接続先の組み合わせが main の記録と同じ（認証は偽物のみ）';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/claude-launch-main.json', import.meta.url));

export default async function (t) {
  const root = process.env.LAUNCH_RECORD_ROOT || REPO;
  const got = digest(await recordAll({ root }));
  if (process.env.LAUNCH_RECORD_WRITE) {
    await fs.writeFile(process.env.LAUNCH_RECORD_WRITE, JSON.stringify(got, null, 1) + '\n');
    t.ok('fixture を書き出した', true);
    return;
  }
  const want = JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
  const labels = scenarios().map(([p, a, e]) => `${p}/${a}/${e}`);
  t.ok('組み合わせの数が fixture と同じ', JSON.stringify(Object.keys(want)) === JSON.stringify(labels), `${Object.keys(want).length} / ${labels.length}`);
  const bad = [];
  for (const label of labels) {
    for (const route of new Set([...Object.keys(want[label] ?? {}), ...Object.keys(got[label] ?? {})])) {
      if (JSON.stringify(got[label]?.[route]) !== JSON.stringify(want[label]?.[route])) bad.push(`${label} ${route}`);
    }
  }
  t.ok(`全 ${labels.length} 組み合わせ × 経路の起動の記録が main と同じ`, bad.length === 0, bad.slice(0, 10).join(' | '));
  // 記録に本物の秘密が入っていない: 認証に関わる env の値は固定の偽物だけ
  const fakes = new Set(Object.values(FAKE));
  const odd = [];
  for (const [label, rec] of Object.entries(want)) for (const [route, r] of Object.entries(rec)) for (const [k, v] of Object.entries(r.auth ?? {})) {
    if (v && !fakes.has(v) && !/^<tmp>|^https:\/\/compat\.example\.invalid$/.test(v)) odd.push(`${label} ${route} ${k}`);
  }
  t.ok('fixture の認証の値は偽物だけ', odd.length === 0, odd.slice(0, 5).join(' | '));
  // 起動の記録が取れていること（すべて null の空の fixture で通らない）
  const procs = Object.values(want).flatMap(rec => Object.entries(rec).filter(([k, r]) => k !== 'heldSpawn' && r.proc !== null));
  t.ok('起動の記録が取れている経路が十分にある', procs.length >= labels.length * 4, String(procs.length));
}
