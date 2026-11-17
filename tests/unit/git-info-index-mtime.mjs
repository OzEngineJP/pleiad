// core/git-info.mjs の snapshotTree・indexTree は本物の index を一時ファイルへ写してから git に渡す。
// その写しが元の index の更新時刻（mtime）を引き継ぐこと（racy git）を、時刻をそろえた一時リポジトリで決まった形で確かめる。
//
// 起きていた不具合: fs.copyFile の写しは mtime が「今」になる。元の index と同じ区間に書いたエントリ（ステージした直後に、
// 同じ大きさの内容へ作業ツリーで戻した、など）は、元の index なら racily clean（エントリの mtime ≧ index の mtime）として
// 中身を読んで比べられるのに、写しでは racy でなくなり、add -A が「変わっていない」と読み違える（変更の件数と一覧が食い違う）。
// browser-files-reread の「ステージ後に作業ツリーで戻した」の揺れの元（確率で出る）を、時刻を指定して必ず再現する。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotTree, indexTree } from '../../core/git-info.mjs';

export const name = 'git-info-index-mtime';
export const title = 'git の撮影: index の写しは元の更新時刻を引き継ぐ（racy git）。ステージ後に同じ大きさで戻した変更を見落とさない';

const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).replace(/\r?\n$/, '');
/** 書く側の git（一時リポジトリの組み立て） */
const sh = (cwd, ...args) => run(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args]);
/** 読むだけの git。--no-optional-locks で index を書き直させない（書き直すと、そろえた更新時刻が「今」に戻る） */
const look = (cwd, ...args) => run(cwd, ['--no-optional-locks', ...args]);

/**
 * mod.txt を 'b\n' でステージし、作業ツリーで 'a\n'（HEAD と同じ内容・同じ大きさ）へ戻した一時リポジトリを作る。
 * エントリの mtime（作業ツリーのファイルの mtime）と index ファイルの mtime は、1 時間前の決まった時刻にそろえる:
 *   index の mtime = base + frac 秒、エントリの mtime = それより later 秒だけ新しい（0 なら同じ）。どちらも racy（エントリ ≧ index）。
 * stat の一致は mtime と大きさだけで決める（core.checkStat=minimal・trustctime=false）。ctime・inode は書き直すたびに変わり、
 * 時刻を指定して作れないので、見ないようにする。見ないのは写しの側も同じなので、判定の差は mtime だけから出る
 */
async function racyRepo(scratch, label, { frac, later }) {
  const repo = path.join(scratch, label);
  await fs.mkdir(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['core.checkStat', 'minimal'], ['core.trustctime', 'false'], ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) sh(repo, 'config', key, value);
  const file = path.join(repo, 'mod.txt');
  const index = path.join(repo, '.git', 'index');
  await fs.writeFile(file, 'a\n');
  await fs.writeFile(path.join(repo, 'keep.txt'), 'keep\n');
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'init');
  const indexAt = Math.floor(Date.now() / 1000) - 3600 + frac;
  const entryAt = indexAt + later;
  await fs.writeFile(file, 'b\n');
  await fs.utimes(file, entryAt, entryAt);
  sh(repo, 'add', 'mod.txt');                                   // エントリの stat は mtime = entryAt・大きさ 2
  await fs.utimes(index, indexAt, indexAt);                     // 書き終えた index の mtime を、エントリと同じか少し前へ戻す
  await fs.writeFile(file, 'a\n');                              // 同じ大きさの内容へ戻す（HEAD と同じ）
  await fs.utimes(file, entryAt, entryAt);                      // mtime もエントリと同じに戻す → stat だけを見ると「変わっていない」
  return { repo, index };
}

export default async function (t) {
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-index-mtime-')));
  try {
    // index の mtime とエントリの mtime の関係（どれも racy）。端数のある時刻は、写しの時刻をミリ秒へ丸めても racy が保たれることを見る
    const cases = [
      ['秒に揃えた時刻で、エントリと index が同じ', { frac: 0, later: 0 }],
      ['ミリ秒より細かい端数のある時刻で、エントリと index が同じ', { frac: 0.1234567, later: 0 }],
      ['エントリが index より 0.4 ミリ秒新しい', { frac: 0.2, later: 0.0004 }],
      ['エントリが index より 2 秒新しい', { frac: 0.5, later: 2 }],
    ];
    for (const [i, [label, spec]] of cases.entries()) {
      const { repo, index } = await racyRepo(scratch, `case${i}`, spec);
      // 前提: 本物の index では、git 自身が racy と判断して中身を比べ、戻した変更（作業ツリー ≠ ステージ）を見つける。
      // ここが崩れる（git や置き場が時刻をそろえさせない）なら、この試験は何も確かめていないので、黙って通さず落とす
      assert.equal(look(repo, 'diff', '--name-only'), 'mod.txt', `${label}: 前提が崩れた（本物の index で git が戻した変更を見つけない）`);
      assert.equal(look(repo, 'diff', '--cached', '--name-only'), 'mod.txt', `${label}: 前提が崩れた（ステージした内容が HEAD と同じ）`);
      const before = { mtimeMs: (await fs.stat(index)).mtimeMs, bytes: await fs.readFile(index) };

      const tree = await snapshotTree(repo);
      assert.ok(tree, `${label}: 撮影できた`);
      const head = look(repo, 'rev-parse', 'HEAD^{tree}');
      const worked = look(repo, 'show', `${tree}:mod.txt`);
      t.ok(`${label}: 撮影した tree の mod.txt は今の作業ツリーの内容 'a'（ステージした 'b' ではない）`, worked === 'a', `mod.txt = ${JSON.stringify(worked)}`);
      t.ok(`${label}: 作業ツリーは HEAD と同じなので、撮影した tree も HEAD の tree と同じ`, tree === head, `${tree} / HEAD ${head}`);

      const staged = await indexTree(repo);
      assert.ok(staged, `${label}: ステージ済みの tree を読めた`);
      t.ok(`${label}: ステージ済みの tree はステージした内容 'b'（作業ツリーではない）`, look(repo, 'show', `${staged}:mod.txt`) === 'b');

      const after = { mtimeMs: (await fs.stat(index)).mtimeMs, bytes: await fs.readFile(index) };
      t.ok(`${label}: 本物の index の更新時刻と中身は変えない`, after.mtimeMs === before.mtimeMs && after.bytes.equals(before.bytes), `mtime ${before.mtimeMs} → ${after.mtimeMs}`);
    }

    // 時刻を移せない（utimes が失敗する）ときは、これまでどおり写しただけで撮影を続ける
    {
      const repo = path.join(scratch, 'utimes-fails');
      await fs.mkdir(repo);
      sh(repo, 'init', '-q', '-b', 'main');
      sh(repo, 'config', 'core.autocrlf', 'false');
      await fs.writeFile(path.join(repo, 'keep.txt'), 'keep\n');
      sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'init');
      await fs.writeFile(path.join(repo, 'keep.txt'), 'changed\n');
      await fs.writeFile(path.join(repo, 'new.txt'), 'n\n');
      const real = fs.utimes;
      let calls = 0;
      fs.utimes = async () => { calls++; throw Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' }); };
      let tree;
      try { tree = await snapshotTree(repo); } finally { fs.utimes = real; }
      t.ok('写しの時刻を移そうとする（utimes を呼ぶ）', calls >= 1, `${calls} 回`);
      assert.ok(tree, 'utimes が失敗しても撮影できる');
      t.ok('時刻を移せなくても（utimes が失敗）、写しただけで撮影を続ける（変更・未追跡のファイルは撮れる）',
        look(repo, 'show', `${tree}:keep.txt`) === 'changed' && look(repo, 'show', `${tree}:new.txt`) === 'n');
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
