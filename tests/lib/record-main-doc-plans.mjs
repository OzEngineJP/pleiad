// main の実装で、旧い保存の組み合わせ × 作業場所 × 6 エージェントの計画を採り、tests/fixtures/context-doc-main-plans.json に書く。
// 使い方: node tests/lib/record-main-doc-plans.mjs <main の写しの根（core/ と package.json がある所）> [出力先]
// 例: git worktree add <dir> main（か git archive main core web package.json）で作った写しを渡す。
// 写しの core/ は、この作業ツリーの node_modules か、写しの上のフォルダーの node_modules で動く。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeFixture, recordPlans } from './context-doc-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(process.argv[2] ?? '');
const out = path.resolve(process.argv[3] ?? path.join(here, '..', 'fixtures', 'context-doc-main-plans.json'));
if (!process.argv[2]) { console.error('usage: node tests/lib/record-main-doc-plans.mjs <mainRoot> [out]'); process.exit(2); }

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-doc-main-')));
try {
  const fx = await makeFixture(root);
  const recorded = await recordPlans(mainRoot, fx, { glue: 'main' });
  let commit = null;
  try { commit = execFileSync('git', ['-C', mainRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  const body = { note: 'main の実装で採った計画（tests/lib/record-main-doc-plans.mjs）。手で直さない', recordedFrom: commit, platform: process.platform, ...recorded };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${out}`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
