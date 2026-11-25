// git パネルの読み込み（core/git-history.mjs・git-activity.mjs）: 履歴のページ（limit と skip）・
// 作業場所は一覧だけを先に返し、中身は同時に読む行の数を絞る。一時リポジトリで確かめる。
// 会話の始まりの位置（startPosition）と「始まりまで読む」は、「この会話の間」とともに ADR 0352 でやめた。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as history from '../../core/git-history.mjs';
import { createGitActivity } from '../../core/git-activity.mjs';

export const name = 'git-panel-load';
export const title = 'git パネルの読み込み: 履歴のページ・作業場所の一覧だけ先に・同時に読む数の上限';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();

export default async function (t) {
  // ---- 同時に走らせる数（git を呼ばない）
  let running = 0, peak = 0;
  const done = await history.mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  t.ok('mapLimit: 同時は n 個まで・結果は元の順', peak === 3 && done.join() === '2,4,6,8,10,12,14,16,18,20', `peak=${peak} ${done}`);
  t.ok('mapLimit: 空でも落ちない', (await history.mapLimit([], 4, async () => 1)).length === 0);
  t.ok('同時に読む行の既定は 4〜6', history.WORKTREE_READ_CONCURRENCY >= 4 && history.WORKTREE_READ_CONCURRENCY <= 6);
  t.ok('会話の始まりを探す口は無い（ADR 0352）', history.startPosition === undefined && history.START_SEARCH_MAX === undefined);

  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-git-panel-load-')));
  const repo = path.join(scratch, 'repo');
  await fs.mkdir(repo);
  try {
    sh(repo, 'init', '-q', '-b', 'main');
    const commitN = async (n, tag) => { await fs.writeFile(path.join(repo, `${tag}${n}.txt`), `${n}\n`); sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', `${tag} ${n}`); };
    for (let i = 1; i <= 3; i++) await commitN(i, 'old');
    const activity = createGitActivity();
    for (let i = 1; i <= 7; i++) await commitN(i, 'new');

    // ---- 履歴のページ（会話の始まりの位置・「始まりまで読む」は ADR 0352 でやめた。ページは limit と skip だけ）
    const all = await history.readHistory(repo, { limit: 50 });
    const first = await activity.commits(repo, { limit: 3 });
    t.ok('commits: 1 ページ目は limit 件・next は次の位置・会話の始まり（session）は付けない',
      first.commits.length === 3 && first.next === 3 && first.root && first.session === undefined && first.commits[0].hash === all.commits[0].hash, JSON.stringify({ n: first.commits.length, next: first.next, session: first.session }));
    const second = await activity.commits(repo, { limit: 3, skip: first.next });
    t.ok('commits: 続きは skip から（並びは readHistory と同じ）', second.commits.map((c) => c.hash).join() === all.commits.slice(3, 6).map((c) => c.hash).join() && second.next === 6);
    const last = await activity.commits(repo, { limit: 3, skip: 9 });
    t.ok('commits: 最後のページは next なし', last.commits.length === 1 && last.next === null);
    t.ok('commits: through（始まりまで読む）は無視される（limit のページのまま）', (await activity.commits(repo, { limit: 3, skip: 3, through: true })).commits.length === 3);
    t.ok('commits: git 管理外は null', await activity.commits(scratch, { limit: 3 }) === null);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }

  // ---- 作業場所: 一覧だけ（1 回の worktree list）と、中身まで
  const scratch2 = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-git-panel-wt-')));
  const repo2 = path.join(scratch2, 'repo');
  await fs.mkdir(repo2);
  try {
    sh(repo2, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(repo2, 'a.txt'), 'a\n'); sh(repo2, 'add', '.'); sh(repo2, 'commit', '-q', '-m', 'first');
    for (let i = 1; i <= 5; i++) {
      const dir = path.join(scratch2, `wt${i}`);
      sh(repo2, 'worktree', 'add', '-q', '-b', `exp${i}`, dir);
      if (i % 2) { await fs.writeFile(path.join(dir, `e${i}.txt`), 'e\n'); sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', `exp ${i}`); await fs.writeFile(path.join(dir, 'dirty.txt'), 'd\n'); }
    }
    const lv = await history.listWorktrees(repo2);
    t.ok('listWorktrees: 件数・名前・場所・ここ・主。状態はまだ 0・null', lv.total === 6 && lv.rows.length === 6 && lv.rows[0].main && lv.rows[0].here && lv.rows.every((r) => r.dirty === 0 && r.ahead === 0 && r.at === null) && lv.rows[1].branch === 'exp1', JSON.stringify(lv.rows[1]));
    const full = await history.readWorktrees(repo2);
    t.ok('readWorktrees: 中身まで（変更・ahead・日時）', full.rows[1].dirty === 1 && full.rows[1].ahead === 1 && full.rows[1].at > 0 && full.rows[2].dirty === 0 && full.rows[2].ahead === 0, JSON.stringify(full.rows[1]));
    t.ok('readWorktrees: 一覧と同じ並び・件数', full.total === lv.total && full.rows.map((r) => r.path).join() === lv.rows.map((r) => r.path).join());
    const one = await history.readWorktrees(repo2, { concurrency: 1 });
    t.ok('readWorktrees: 同時に読む数を 1 にしても同じ結果', JSON.stringify(one.rows) === JSON.stringify(full.rows));
    const capped = await history.listWorktrees(repo2, { limit: 3 });
    t.ok('listWorktrees: 上限を超えた分は rows に出さず、total は全件', capped.rows.length === 3 && capped.total === 6);
  } finally {
    try { for (let i = 1; i <= 5; i++) sh(repo2, 'worktree', 'remove', '--force', path.join(scratch2, `wt${i}`)); } catch { /* 後で全部消す */ }
    await fs.rm(scratch2, { recursive: true, force: true });
  }
}
