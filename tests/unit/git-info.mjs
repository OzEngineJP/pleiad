// ホストの git の問い合わせ（core/git-info.mjs・git-timeline.mjs・git-activity.mjs。ADR 0085・0353）。
// 状態の解析・差分の解析・コマンドの結果からのタイムライン・パネルの変更の一覧と差分・残っている隠し ref の片付けを、一時リポジトリで確かめる。
// ユーザーの index・HEAD・ブランチに触れないこと、git 管理外は null になることも見る。
// ターンごとの撮影（ADR 0085 の決定 2・3・6）は ADR 0353 でやめた。撮影の試験は無い（呼び出しが残っていないことは git-background-guard が見る）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from '../../core/git-info.mjs';
import { createGitActivity } from '../../core/git-activity.mjs';
import { eventsFromCall, timelineOf, shellWords, createCallTracker, commandOf } from '../../core/git-timeline.mjs';

export const name = 'git-info';
export const title = 'git の動き: 状態・差分の解析、コマンド結果からのタイムライン、変更の一覧と差分、残った隠し ref の片付け（一時リポジトリ）';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });

export default async function (t) {
  // ---- 解析（git を呼ばない）
  const st = git.parseStatus([
    '# branch.oid 3f2a9c1d4e5f60718293a4b5c6d7e8f901234567', '# branch.head fix/token', '# branch.upstream origin/fix/token', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb core/auth.mjs', '2 R. N... 100644 100644 100644 aaa bbb R100 new.mjs', 'old.mjs', 'u UU N... 1 2 3 4 aaa bbb ccc x.mjs', '? scratch.txt', '? other.txt', ''].join('\0'));
  t.ok('status: ブランチ・upstream・ahead/behind', st.branch === 'fix/token' && st.upstream === 'origin/fix/token' && st.ahead === 2 && st.behind === 1, JSON.stringify(st));
  t.ok('status: 変更・競合・未追跡の数（名前の変更は元のパスを数えない）', st.changed === 2 && st.conflicts === 1 && st.untracked === 2 && st.dirty === 5, JSON.stringify(st));
  const detached = git.parseStatus('# branch.oid abc\0# branch.head (detached)\0');
  t.ok('status: 分離した HEAD と最初のコミット前', detached.detached && detached.branch === null && git.parseStatus('# branch.oid (initial)\0# branch.head main\0').oid === null);
  const files = git.parseNumstat('3\t1\tcore/a.mjs\0-\t-\timg.png\0');
  t.ok('numstat: 行数とバイナリ', files.length === 2 && files[0].add === 3 && files[0].del === 1 && files[1].binary === true && files[1].add === 0, JSON.stringify(files));
  t.ok('name-status: 新規・変更・削除', [...git.parseNameStatus('A\0new.txt\0M\0a.txt\0D\0gone.txt\0')].map(([p, s]) => `${p}:${s}`).join() === 'new.txt:A,a.txt:M,gone.txt:D');
  const parsed = git.parseUnifiedDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn\n keep\n-old\n+new\n\\ No newline at end of file\n');
  t.ok('統一差分: ヘッダーを捨て、行を + - 空白で分ける', parsed.hunks.length === 1 && parsed.hunks[0].header.startsWith('@@ -1,2') && parsed.hunks[0].lines.map((l) => l.t).join('') === ' -+', JSON.stringify(parsed));

  // ---- タイムライン（git を呼ばない）
  t.ok('語の分割: 引用符・連結', shellWords('git add a && git commit -m "fix: a b" ; echo x').join('|') === 'git|add|a|&&|git|commit|-m|fix: a b|;|echo|x');
  t.ok('checkout -b / switch -c / 前置きの -C', eventsFromCall({ command: 'git checkout -b fix/x', text: "Switched to a new branch 'fix/x'" })[0]?.branch === 'fix/x'
    && eventsFromCall({ command: 'git -C repo switch -c feat/y', text: '' })[0]?.branch === 'feat/y'
    && eventsFromCall({ command: 'git switch --create z', text: '' })[0]?.branch === 'z');
  t.ok('チェックアウトだけ・ブランチの切り替えだけは作成にしない', eventsFromCall({ command: 'git checkout main', text: '' }).length === 0 && eventsFromCall({ command: 'git switch main', text: '' }).length === 0);
  const commit = eventsFromCall({ command: 'git add a && git commit -m "fix: a"', text: '[fix/x 3f2a9c1abc] fix: a\n 1 file changed, 2 insertions(+)\n' });
  t.ok('commit: [ブランチ hash] 件名（hash は 7 桁）', commit.length === 1 && commit[0].kind === 'commit' && commit[0].branch === 'fix/x' && commit[0].hash === '3f2a9c1' && commit[0].subject === 'fix: a', JSON.stringify(commit));
  t.ok('commit: 最初のコミット (root-commit)', eventsFromCall({ command: 'git commit -m a', text: '[main (root-commit) abcdef0] a\n' })[0]?.hash === 'abcdef0');
  t.ok('commit: 失敗・何もコミットしていない結果は拾わない', eventsFromCall({ command: 'git commit -m a', text: 'nothing to commit', isError: false }).length === 0
    && eventsFromCall({ command: 'git commit -m a', text: '[main abcdef0] a', isError: true }).length === 0
    && eventsFromCall({ command: 'git commit -m a', text: 'exit=1\n[main abcdef0] a' }).length === 0);
  t.ok('commit: git commit でないコマンドの出力に似た行は拾わない', eventsFromCall({ command: 'echo "[main abcdef0] fake"', text: '[main abcdef0] fake' }).length === 0);
  const pr = eventsFromCall({ command: 'gh pr create --title "x" --body "y"', text: 'https://github.com/example/pleiad/pull/128\n' });
  t.ok('gh pr create: URL と番号', pr.length === 1 && pr[0].kind === 'pr' && pr[0].number === 128 && pr[0].url.endsWith('/pull/128'), JSON.stringify(pr));
  t.ok('PowerShell の ; 連結', eventsFromCall({ command: 'git checkout -b a; git commit -m b', text: '[a 1234567] b' }).map((e) => e.kind).join() === 'branch,commit');
  t.ok('入力の command / CommandLine / 配列', commandOf({ command: 'git status' }) === 'git status' && commandOf({ CommandLine: 'git log' }) === 'git log' && commandOf({ command: ['git', 'status'] }) === 'git status' && commandOf({}) === null);
  const line = timelineOf([
    { role: 'user', text: 'x', uuid: 'u0', at: '2026-10-03T03:00:00Z' },
    { role: 'assistant', uuid: 'a1', at: '2026-10-03T03:31:00Z', toolCalls: [{ id: 't1', name: 'Bash', input: { command: 'git checkout -b fix/token-refresh' }, result: { text: 'Switched', isError: false } }] },
    { role: 'assistant', uuid: 'a2', at: '2026-10-03T03:38:00Z', toolCalls: [{ id: 't2', name: 'Bash', input: { command: 'git commit -m "fix"' }, result: { text: '[fix/token-refresh 3f2a9c1] fix\n', isError: false } },
      { id: 't3', name: 'Bash', input: { command: 'gh pr create' }, result: null }] },
    { role: 'assistant', uuid: 'a3', at: '2026-10-03T03:39:00Z', toolCalls: [{ id: 't4', name: 'Bash', input: { command: 'gh pr create' }, result: { text: 'https://github.com/e/p/pull/9', isError: false } }] },
  ]);
  t.ok('タイムライン: 時刻順・各行に会話の場所（uuid）・結果の無い呼び出しは出さない', line.map((e) => e.kind).join() === 'branch,commit,pr' && line[1].uuid === 'a2' && line[1].toolId === 't2' && line[2].at === '2026-10-03T03:39:00Z', JSON.stringify(line));
  const tracker = createCallTracker();
  tracker.track({ type: 'tool.start', id: 'x', name: 'Bash', input: { command: 'gh pr create' } });
  tracker.track({ type: 'tool.result', id: 'x', text: 'https://github.com/e/p/pull/7', isError: false });
  t.ok('呼び出しの追跡（PR のメモが使う）: tool.start と tool.result を id で組にする', tracker.events().length === 1 && tracker.events()[0].number === 7);

  // ---- 本物の git（一時リポジトリ）
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-git-info-'));
  const repo = path.join(scratch, 'repo');
  try {
    await fs.mkdir(path.join(repo, 'core'), { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(repo, 'core', 'auth.mjs'), 'one\ntwo\nthree\n');
    await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
    sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'first');

    const activity = createGitActivity();
    const sid = 'session-aaaa-1';

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-nogit-'));
    t.ok('git 管理外は null（状態・ルート・変更の一覧・数え）', await git.repoInfo(outside) === null && await git.readStatus(outside) === null
      && await activity.changes(outside, sid) === null && await activity.changeCount(outside) === null && await activity.status(outside) === null);
    await fs.rm(outside, { recursive: true, force: true });

    const info = await git.repoInfo(path.join(repo, 'core'));
    // 一時フォルダーは短い名前（CI の RUNNER~1）で返ることがあり、git は長い名前で答える。比べる前に実名へ直す
    t.ok('ルートは cwd がサブディレクトリでも取れる・普通のリポジトリは linked でない', info?.root.toLowerCase() === realpathSync.native(repo).replaceAll('\\', '/').toLowerCase() && info.linked === false, JSON.stringify(info));

    const headBefore = sh(repo, 'rev-parse', 'HEAD').trim();

    // ファイルを変え、新規を足し、ブランチを作ってステージする（コミットはしない）
    await fs.writeFile(path.join(repo, 'core', 'auth.mjs'), 'one\nTWO\nthree\nfour\n');
    await fs.writeFile(path.join(repo, 'new.txt'), 'a\nb\n');
    await fs.writeFile(path.join(repo, 'ignored.txt'), 'x\n');
    sh(repo, 'checkout', '-q', '-b', 'fix/token');
    sh(repo, 'add', 'core/auth.mjs');

    // パネル（コミットしていない変更）
    const unc = await activity.changes(path.join(repo, 'core'), sid);
    t.ok('パネル「コミットしていない変更」: HEAD と今の差（新規含む・.gitignore のものは出さない・失敗の印なし）',
      unc?.range === 'uncommitted' && unc.failed === undefined && unc.files.map((f) => `${f.state}:${f.path}`).join() === 'M:core/auth.mjs,A:new.txt' && unc.total.add === 4 && unc.total.del === 1, JSON.stringify(unc));
    t.ok('パネル: ステージ済み・変更の区別（ステージした分と、していない新規）', unc.files[0].staged === true && unc.files[1].unstaged === true
      && unc.groups.staged.some((f) => f.path === 'core/auth.mjs') && unc.groups.work.some((f) => f.path === 'new.txt'), JSON.stringify(unc.groups));
    t.ok('パネルの範囲に「この会話の間」は無い（range は uncommitted だけ）', unc.hasSession === undefined && unc.range === 'uncommitted');

    const d = await activity.diff(repo, sid, 'core/auth.mjs');
    t.ok('差分: ハンクの行（+ − 空白）', d?.hunks.length === 1 && d.hunks[0].lines.some((l) => l.t === '-' && l.s === 'two') && d.hunks[0].lines.some((l) => l.t === '+' && l.s === 'TWO') && !d.binary, JSON.stringify(d));
    await fs.writeFile(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
    const bin = await activity.diff(repo, sid, 'bin.dat');
    t.ok('バイナリは本文を返さない', bin?.binary === true && bin.hunks.length === 0, JSON.stringify(bin));
    t.ok('パスのグロブは文字どおりに扱う（*.txt は 1 ファイルにも当たらない）', (await activity.diff(repo, sid, '*.txt'))?.hunks.length === 0);
    await fs.rm(path.join(repo, 'bin.dat'), { force: true });

    // ユーザーの HEAD・ブランチ・index・作業ツリーは読み取りで動かない
    t.ok('読み取りはユーザーの index に触れない（new.txt はステージされないまま・auth.mjs だけステージ）', sh(repo, 'status', '--porcelain').includes('?? new.txt') && sh(repo, 'diff', '--cached', '--name-only').trim() === 'core/auth.mjs');
    t.ok('読み取りはブランチ一覧を変えない・隠し ref も作らない', sh(repo, 'branch', '--list').split('\n').filter(Boolean).length === 2 && !/pleiad/.test(sh(repo, 'branch', '-a')) && sh(repo, 'for-each-ref', 'refs/pleiad/').trim() === '');

    // 新しいタブの「変更 N ファイル」
    t.ok('changeCount: 変更の一覧と同じ数え方（新規含む・ignore は数えない）', await activity.changeCount(repo) === 2);

    // 状態
    const status = await activity.status(repo, { fresh: true });
    t.ok('状態: ブランチ・変更の数（未追跡含む）・upstream なし', status.branch === 'fix/token' && status.dirty === 2 && status.upstream === null && status.ahead === null, JSON.stringify(status));

    // 残っている隠し ref の片付け（refs/pleiad/turn/ だけ。ブランチ・退避の ref・index・作業ツリーに触れない）
    sh(repo, 'update-ref', 'refs/pleiad/turn/session-old-1/1-start', headBefore);
    sh(repo, 'update-ref', 'refs/pleiad/turn/session-old-1/1-end', headBefore);
    sh(repo, 'update-ref', 'refs/pleiad/turn/session-old-2/1-start', headBefore);
    sh(repo, 'update-ref', 'refs/pleiad/archive/ply-9', headBefore);
    t.ok('dropTurnRefs: refs/pleiad/turn/ を全部消し、消した数を返す', (await git.dropTurnRefs(info.root)) === 3 && sh(repo, 'for-each-ref', 'refs/pleiad/turn/').trim() === '');
    t.ok('dropTurnRefs: ブランチ・worktree の退避の ref は残る', sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/pleiad/').trim() === 'refs/pleiad/archive/ply-9'
      && sh(repo, 'rev-parse', 'main').trim() === headBefore && sh(repo, 'branch', '--list').split('\n').filter(Boolean).length === 2);
    t.ok('dropTurnRefs: ユーザーの index・作業ツリーは動かない', sh(repo, 'diff', '--cached', '--name-only').trim() === 'core/auth.mjs' && sh(repo, 'status', '--porcelain').includes('?? new.txt'));
    t.ok('dropTurnRefs: 消すものが無ければ 0（もう 1 回呼んでよい）', (await git.dropTurnRefs(info.root)) === 0);

    // 数千本（Pleiad 自身の開発用リポジトリに 2,182 本あった）。1 回の読みの上限（4 秒）に 1 本の update-ref --stdin で入れず、数百本ずつ消す
    {
      const total = () => sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/pleiad/turn/').split('\n').filter(Boolean).length;
      const make = (n, prefix) => execFileSync('git', ['update-ref', '--stdin'], { cwd: repo, windowsHide: true,
        input: Array.from({ length: n }, (_, i) => `create refs/pleiad/turn/${prefix}/${String(i).padStart(5, '0')}-start ${headBefore}\n`).join('') });
      make(3000, 'many');
      t.ok('前提: 3000 本の隠し ref を作った（archive の退避が 1 本ある）', total() === 3000 && sh(repo, 'for-each-ref', 'refs/pleiad/archive/').includes('ply-9'));
      const startedAt = Date.now();
      const removed = await git.dropTurnRefs(info.root);
      const elapsed = Date.now() - startedAt;
      t.ok(`dropTurnRefs: 3000 本を全部消し、消した数を返す（${elapsed}ms）`, removed === 3000 && total() === 0, `removed ${removed} left ${total()}`);
      t.ok('dropTurnRefs: 数千本消しても、場所は休まない（REST にならず、時間切れを数えない）', git.placeBlocked(info.root) === null && git.placeGuard.snapshot(git.placeGuard.placeOf(info.root)).light.consecutive === 0);
      t.ok('dropTurnRefs: 退避の ref・ブランチ・index は残る', sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/pleiad/').trim() === 'refs/pleiad/archive/ply-9'
        && sh(repo, 'rev-parse', 'main').trim() === headBefore && sh(repo, 'diff', '--cached', '--name-only').trim() === 'core/auth.mjs');

      // 途中で止まっても、次に呼べば残りから続く（2 つ目の塊に、ロックの残った ref を入れて、その塊だけ git に断らせる）
      make(900, 'resume');
      const lock = path.join(repo, '.git', 'refs', 'pleiad', 'turn', 'resume', '00450-start.lock');
      await fs.writeFile(lock, '');
      const partial = await git.dropTurnRefs(info.root, { chunk: 300 });
      t.ok('dropTurnRefs: 2 つ目の塊が消せなくても、1 つ目（300 本）は消えていて、null を返す（済みにしない）', partial === null && total() === 600, `partial ${partial} left ${total()}`);
      t.ok('dropTurnRefs: 消せなかっただけでは、場所は休まない', git.placeBlocked(info.root) === null);
      await fs.rm(lock, { force: true });
      const resumed = await git.dropTurnRefs(info.root, { chunk: 300 });
      t.ok('dropTurnRefs: 次に呼ぶと、残りの 600 本だけを消して済む', resumed === 600 && total() === 0, `resumed ${resumed} left ${total()}`);
    }
    await fs.writeFile(path.join(repo, 'ignored.txt'), 'x\n');

    // worktree
    const wt = path.join(scratch, 'wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'pleiad/ply-1', wt);
    const wtInfo = await git.repoInfo(wt);
    t.ok('git worktree は linked（worktree）で、状態のブランチも取れる', wtInfo?.linked === true && (await git.readStatus(wt))?.branch === 'pleiad/ply-1');
    await fs.writeFile(path.join(wt, 'x.txt'), 'x\n');
    const wchanges = await activity.changes(wt, 'session-dddd-4');
    t.ok('worktree でも変更の一覧が出る（その worktree の分だけ）', wchanges?.files.map((f) => f.path).join() === 'x.txt' && wchanges.total.add === 1, JSON.stringify(wchanges));

    // 初回のコミット前のリポジトリ
    const fresh = path.join(scratch, 'fresh');
    await fs.mkdir(fresh);
    sh(fresh, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(fresh, 'a.txt'), 'a\n');
    const fchanges = await activity.changes(fresh, 'session-eeee-5');
    t.ok('コミット前のリポジトリ: 変更の一覧は動く（空の tree との差）', fchanges?.failed === undefined && fchanges?.files.map((f) => f.path).join() === 'a.txt', JSON.stringify(fchanges));
    t.ok('コミット前のリポジトリ: 新しいタブの「変更 N ファイル」も数える（ターンの撮影は無くなったので、HEAD が無くても毎ターン読み直さない）', await activity.changeCount(fresh) === 1);
    t.ok('コミット前のリポジトリ: 利用者が開いた画面の撮影（snapshotTree）は撮れる', Boolean(await git.snapshotTree(fresh)));
    t.ok('コミット前のリポジトリ: dropTurnRefs は 0（ref が無い）', (await git.dropTurnRefs(path.join(fresh))) === 0);

    // 書く操作は refs/pleiad だけ・読み取り以外は断る
    let threw = 0;
    try { git.readGit(repo, ['commit', '-m', 'x']); } catch { threw++; }
    try { await git.updateRef(repo, 'refs/heads/main', headBefore); } catch { threw++; }
    t.ok('許可していない git のサブコマンドと refs/pleiad/ 以外への update-ref は投げる', threw === 2);
    t.ok('ユーザーのブランチの先頭はここまでの読み取りで動いていない', sh(repo, 'rev-parse', 'main').trim() === headBefore);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
