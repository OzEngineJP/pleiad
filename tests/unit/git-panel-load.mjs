// git パネルの読み込み（core/git-history.mjs・git-activity.mjs）: 会話の始まりの位置を 1 回の呼びで出す・「始まりまで読む」・
// 作業場所は一覧だけを先に返し、中身は同時に読む行の数を絞る。一時リポジトリで確かめる。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as history from '../../core/git-history.mjs';
import { createGitActivity } from '../../core/git-activity.mjs';

export const name = 'git-panel-load';
export const title = 'git パネルの読み込み: 会話の始まりの位置・始まりまで読む・作業場所の一覧だけ先に・同時に読む数の上限';

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
  t.ok('始まりを探す上限は 2,000 件', history.START_SEARCH_MAX === 2000);

  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-git-panel-load-')));
  const repo = path.join(scratch, 'repo');
  await fs.mkdir(repo);
  try {
    sh(repo, 'init', '-q', '-b', 'main');
    const commitN = async (n, tag) => { await fs.writeFile(path.join(repo, `${tag}${n}.txt`), `${n}\n`); sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', `${tag} ${n}`); };
    for (let i = 1; i <= 3; i++) await commitN(i, 'old');
    const activity = createGitActivity();
    // 会話の始まり = 最初の撮影の親（ここ）。その後に 7 コミット
    const turn = await activity.begin({ cwd: repo });
    await activity.attach(turn, 'sess-load');
    const startHash = sh(repo, 'rev-parse', 'HEAD');
    for (let i = 1; i <= 7; i++) await commitN(i, 'new');

    // ---- 位置は 1 回の rev-list
    const sp = await history.startPosition(repo, startHash);
    t.ok('startPosition: 先頭から数えた位置（0 始まり）。新しい 7 件の次', sp.pos === 7 && sp.scanned === 10, JSON.stringify(sp));
    const spHead = await history.startPosition(repo, sh(repo, 'rev-parse', 'HEAD'));
    t.ok('startPosition: 先頭は 0', spHead.pos === 0);
    const spCap = await history.startPosition(repo, startHash, { max: 5 });
    t.ok('startPosition: max より後は null（見た件数は max）', spCap.pos === null && spCap.scanned === 5, JSON.stringify(spCap));
    t.ok('startPosition: 履歴に無い hash は null', (await history.startPosition(repo, 'f'.repeat(40))).pos === null);
    t.ok('startPosition: hash でないものは git を呼ばず null', (await history.startPosition(repo, 'HEAD; rm')).pos === null);
    const all = await history.readHistory(repo, { limit: 50 });
    t.ok('startPosition は readHistory と同じ並び', all.commits.findIndex((c) => c.hash === startHash) === sp.pos);

    // ---- ページの中に始まりがある → pos が付く（札は要らない）
    const inPage = await activity.commits(repo, 'sess-load', { limit: 50 });
    t.ok('commits: 読んだページに始まりがあれば pos（その行に ⚑）', inPage.session.pos === 7 && inPage.session.head === startHash && !inPage.session.lost, JSON.stringify(inPage.session));
    // ---- ページより後ろ → 先頭のページでも pos が分かる（履歴を読み進めない）
    const first = await activity.commits(repo, 'sess-load', { limit: 3 });
    t.ok('commits: 始まりが読んだ範囲より後ろでも、1 ページ目で pos が分かる', first.commits.length === 3 && first.next === 3 && first.session.pos === 7 && !first.session.lost, JSON.stringify(first.session));
    // ---- 「始まりまで読む」（through）: cursor から始まりまでを 1 回で
    const through = await activity.commits(repo, 'sess-load', { limit: 3, skip: first.next, through: true });
    t.ok('commits through: 続きから始まりのコミットまでを 1 回で（件数は 3〜7 の 5 件）', through.commits.length === 5 && through.commits.at(-1).hash === startHash && through.session.pos === 7, JSON.stringify({ n: through.commits.length, s: through.session }));
    t.ok('commits through: 始まりの次に続きがある（next）', through.next === 8, String(through.next));
    // ---- 見つからない（履歴から消えた）
    sh(repo, 'switch', '-q', '-c', 'gone');
    await commitN(1, 'gone');
    const lonely = await activity.begin({ cwd: repo });
    await activity.attach(lonely, 'sess-lost');
    const lostHead = sh(repo, 'rev-parse', 'HEAD');
    sh(repo, 'switch', '-q', 'main');
    sh(repo, 'branch', '-D', 'gone');   // 始まりのコミットがどの ref からも辿れなくなる
    const lost = await activity.commits(repo, 'sess-lost', { limit: 50 });
    t.ok('commits: 履歴を読み切っても始まりが無ければ lost', lost.session.lost === true && lost.session.pos === undefined && lost.session.head === lostHead, JSON.stringify(lost.session));
    const lostThrough = await activity.commits(repo, 'sess-lost', { limit: 50, skip: 0, through: true });
    t.ok('commits through: 見つからなければ空のページと lost（読み続けない）', lostThrough.commits.length === 0 && lostThrough.next === null && lostThrough.session.lost === true);
    // ---- 撮影が無い会話は session が null（⚑ も札も出ない）
    const none = await activity.commits(repo, 'sess-none', { limit: 5 });
    t.ok('commits: 撮影の無い会話は session: null', none.session === null);
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
