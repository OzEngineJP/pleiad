// git の裏の作業の見張り（ADR 0353。core/git-info.mjs・git-activity.mjs。LLM は呼ばない）。遅い・止まる git を作る偽の git（tests/lib/fake-git.mjs）で、
// 遅いファイルシステムで裏の作業が積み上がらないことを、時間どおりに確かめる:
//   - 止めても終われない git: 上限で戻る → 生きている間は新しい git を起こさず BUSY → 終われば自動で戻る
//   - 止められる git の時間切れが続く: 2 回目から休み（REST）。休みの間は起こさない
//   - 場所が BUSY・REST のとき: 状態は前に読めた値を返す（無ければ null）。変更の一覧・履歴・数えも新しい git を起こさない
//   - 同じ種類の裏の作業は 1 本ずつ: 状態の取り直し（fresh でない 5 つ → 1 本、fresh の 5 つ → 2 本）・撮影（5 つ → add 2 本）・変更の数え（5 つ → 撮影 1 本）
//   - 残っている隠し ref の片付け: リポジトリごとに 1 回・読めなかったらあけてやり直し（本物の git で消す所は git-info・server-git が見る）。
//     数百本ずつ・長い上限・時間切れは休み（REST）に数えない・途中までなら残りから続く（数千本を 1 回の読みの上限に入れない）
//   - ターンごとの撮影をやめた（ADR 0353）: 撮影の口・環境変数・表示の値がコードに残っていない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as git from '../../core/git-info.mjs';
import { createGitActivity } from '../../core/git-activity.mjs';

export const name = 'git-background-guard';
export const title = 'git の裏の作業の見張り: 止まらない git は BUSY・続く時間切れは REST・同じ種類は 1 本・隠し ref の片付けは 1 回・撮影の口は無い（偽の git）';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FAKE = path.join(ROOT, 'tests', 'lib', 'fake-git.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(mjs|cjs|js|json|css|html|md)$/.test(entry.name) || entry.name === 'Dockerfile') out.push(full);
  }
  return out;
}

export default async function (t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ply-bg-guard-'));
  const logFile = path.join(scratch, 'git.log');
  const ctlFile = path.join(scratch, 'ctl.json');
  const keep = { log: process.env.FAKE_GIT_LOG, ctl: process.env.FAKE_GIT_CTL };
  process.env.FAKE_GIT_LOG = logFile;
  process.env.FAKE_GIT_CTL = ctlFile;
  const mkRepo = (n) => { const dir = path.join(scratch, n); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const control = (rules = {}, extra = {}) => fs.writeFileSync(ctlFile, JSON.stringify({ rules, ...extra }));
  const lines = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { const [pid, n] = l.split('\t'); return { pid: Number(pid), name: n }; }); } catch { return []; } };
  const count = (n) => lines().filter((l) => l.name === n).length;
  const reset = () => { fs.writeFileSync(logFile, ''); control(); git.placeGuard.reset(); };
  const waitFor = async (cond, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(25); } return false; };
  const placeOf = (dir) => git.placeGuard.placeOf(dir);
  const useGit = (opts = {}) => git.setGitBin(process.execPath, { args: [FAKE], ...opts });
  const strays = new Set();
  const harvest = () => { for (const l of lines()) strays.add(l.pid); };

  try {
    // ---- 撮影の口が残っていない
    {
      const activity = createGitActivity();
      const keys = Object.keys(activity).sort().join();
      t.ok('createGitActivity は撮影・撮影の要約の口を持たない（begin・attach・finish・summary が無い）', keys === 'changeCount,changes,commit,commits,diff,invalidate,status', keys);
      const tokens = ['AGENT_HOST_GIT_SNAPSHOTS', 'GIT_BEGIN_WAIT_MS', 'gitSetup', 'gitLate', 'sessionBase', 'SESSION_RANGES', 'hasSession', 'paintDelegateGit', 'renderDelegateGit', 'gitSummary', 'pruneTurnRefs'];
      const hits = [];
      for (const dir of ['core', 'web', 'scripts', 'deploy']) {
        const base = path.join(ROOT, dir);
        if (!fs.existsSync(base)) continue;
        for (const file of sourceFiles(base)) {
          const text = fs.readFileSync(file, 'utf8');
          for (const token of tokens) if (text.includes(token)) hits.push(`${path.relative(ROOT, file)}:${token}`);
        }
      }
      t.ok('コード・画面・スクリプトに、撮影の環境変数・待つ上限・表示の値・「この会話の間」の部品・委譲の変更の行が残っていない', hits.length === 0, hits.join(' '));
      const gitInfo = fs.readFileSync(path.join(ROOT, 'core', 'git-info.mjs'), 'utf8');
      t.ok('git-info は ターンごとの撮影の関数（snapshotTurn・turnRefs 系）を持たない', !/export (async )?function (snapshotTurn|beginTurn|finishTurn|turnRefs|forgetSession|pruneTurnRefs)\b/.test(gitInfo));
    }

    // ---- 止めても終われない git: 上限で戻る → BUSY → 終われば自動で戻る
    {
      reset();
      const repo = mkRepo('unkillable');
      useGit({ killWith: () => {} });
      control({ status: { hang: true } });
      const started = Date.now();
      const r = await git.readGit(repo, ['status', '--porcelain=v2'], { timeout: 300 });
      const elapsed = Date.now() - started;
      harvest();
      t.ok('kill が効かない git でも、上限 + 3 秒ほどで戻る（時間切れ）', r.ok === false && r.code === 'TIMEOUT' && elapsed < 6000, `${elapsed}ms ${JSON.stringify(r)}`);
      t.ok('生きている子がある場所は BUSY（読みも撮影も）', git.placeBlocked(repo) === 'BUSY' && git.placeBlocked(repo, 'heavy') === 'BUSY');
      const before = lines().length;
      const again = await git.readGit(repo, ['status', '--porcelain=v2'], { timeout: 300 });
      t.ok('BUSY の間の読みは、git を起こさず ok:false・code BUSY で即戻る', again.ok === false && again.code === 'BUSY' && lines().length === before, JSON.stringify(again));
      t.ok('repoInfo・状態・撮影も、BUSY の間は git を起こさない（null）', await git.repoInfo(repo) === null && await git.readStatus(repo) === null && await git.snapshotTree(repo) === null && lines().length === before);
      const activity = createGitActivity();
      t.ok('変更の一覧・履歴・数え・状態は BUSY の間 null（git を起こさない）',
        await activity.changes(repo, 's') === null && await activity.commits(repo) === null && await activity.changeCount(repo) === null && await activity.status(repo, { fresh: true }) === null && lines().length === before);
      // 子が本当に終われば自動で戻る
      for (const l of lines()) { try { process.kill(l.pid); } catch { /* もう居ない */ } }
      t.ok('子が終わると BUSY は自動で解ける', await waitFor(() => git.placeBlocked(repo) === null, 5000));
      control();
      const ok = await git.readGit(repo, ['rev-parse', '--show-toplevel']);
      t.ok('解けた後の読みは、また普通に走る', ok.ok === true, JSON.stringify(ok));
    }

    // ---- 止められる git の時間切れが続く: 2 回目から休み（REST）
    {
      reset();
      useGit();
      const repo = mkRepo('timeouts');
      control({ status: { hang: true } });
      const first = await git.readGit(repo, ['status', '--porcelain=v2'], { timeout: 300 });
      t.ok('1 回目の時間切れでは休まない（一時の遅れかもしれない）', first.code === 'TIMEOUT' && git.placeBlocked(repo) === null, JSON.stringify(first));
      const second = await git.readGit(repo, ['status', '--porcelain=v2'], { timeout: 300 });
      harvest();
      const rest = git.placeGuard.snapshot(placeOf(repo)).light.restUntil - Date.now();
      t.ok('続けて 2 回目の時間切れで休む（REST。最初の休みは 30 秒）', second.code === 'TIMEOUT' && git.placeBlocked(repo) === 'REST' && rest > 20_000 && rest <= 30_000, `rest ${rest}ms`);
      const before = lines().length;
      const third = await git.readGit(repo, ['status', '--porcelain=v2'], { timeout: 300 });
      t.ok('休みの間は git を起こさず code REST で即戻る', third.ok === false && third.code === 'REST' && lines().length === before, JSON.stringify(third));
      t.ok('休みの間は、状態・撮影も起こさない', await git.readStatus(repo) === null && await git.snapshotTree(repo) === null && lines().length === before);
      t.ok('同じ場所の別の読み（rev-parse）も休み。別の場所は動く', git.placeBlocked(repo) === 'REST' && git.placeBlocked(mkRepo('other-place')) === null);
      control();
      const other = await git.readGit(mkRepo('other-place'), ['rev-parse', '--show-toplevel']);
      t.ok('別の場所の git は普通に走る（休みは場所ごと）', other.ok === true && git.placeBlocked(repo) === 'REST');
    }

    // ---- BUSY・REST のとき、状態は前に読めた値を返す
    {
      reset();
      useGit();
      const repo = mkRepo('lastgood');
      const activity = createGitActivity();
      const good = await activity.status(repo, { fresh: true });
      t.ok('普通のときは状態を読む（fake の branch main・root は場所）', good?.branch === 'main' && typeof good.root === 'string' && count('status') === 1, JSON.stringify(good));
      let release = () => {};
      git.placeGuard.leftover(placeOf(repo), { pid: process.pid, ended: new Promise((resolve) => { release = resolve; }) });
      t.ok('止まった子を数えると、その場所は BUSY', git.placeBlocked(repo) === 'BUSY');
      const before = lines().length;
      const kept = await activity.status(repo, { fresh: true });
      t.ok('BUSY の間の状態は、読み直さず前に読めた値を返す（git を起こさない）', kept?.branch === 'main' && kept.at === good.at && lines().length === before, JSON.stringify(kept));
      git.placeGuard.leftover(placeOf(mkRepo('never-read')), { pid: process.pid, ended: new Promise(() => {}) });
      t.ok('前に読めた値が無い場所は null（git を起こさない）', await activity.status(path.join(scratch, 'never-read'), { fresh: true }) === null && lines().length === before);
      release();
      t.ok('子が終わると、また読み直す', await waitFor(() => git.placeBlocked(repo) === null, 2000) && (await activity.status(repo, { fresh: true }))?.branch === 'main' && count('status') >= 2);
    }

    // ---- 同じ種類の裏の作業は 1 本ずつ
    {
      reset();
      useGit();
      const repo = mkRepo('coalesce');
      control({ status: { delayMs: 400 } });
      const a = createGitActivity();
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => a.status(repo, { fresh: true })));
      t.ok('fresh の状態を 5 つ同時に頼んでも、git status は 2 本だけ（走っているもの + その次の 1 回を共有）', count('status') === 2 && results.every((r) => r?.branch === 'main'), `status ${count('status')}`);
      reset();
      control({ status: { delayMs: 400 } });
      const b = createGitActivity();
      const plain = await Promise.all([1, 2, 3, 4, 5].map(() => b.status(repo)));
      t.ok('fresh でない状態を 5 つ同時に頼むと、git status は 1 本（走っているものに合流）', count('status') === 1 && plain.every((r) => r?.branch === 'main'), `status ${count('status')}`);
      const cached = await b.status(repo);
      t.ok('読み終えた直後（2 秒以内）は取り直さない', count('status') === 1 && cached?.branch === 'main');
    }
    {
      reset();
      useGit();
      const repo = mkRepo('snapshots');
      control({ add: { delayMs: 400 } });
      const trees = await Promise.all([1, 2, 3, 4, 5].map(() => git.snapshotTree(repo)));
      t.ok('撮影を 5 つ同時に頼んでも、git add -A は 2 本だけ（走っているもの + その次の 1 回）', count('add') === 2 && trees.every((x) => /^b{40}$/.test(x ?? '')), `add ${count('add')} ${JSON.stringify(trees)}`);
      const solo = await git.snapshotTree(repo);
      t.ok('重ならない撮影は、そのつど 1 本走る', count('add') === 3 && /^b{40}$/.test(solo ?? ''));
    }
    {
      reset();
      useGit();
      const repo = mkRepo('counting');
      control({ add: { delayMs: 1500 } });   // 5 本の rev-parse（repoInfo）が全部終わるまで撮影が続くように、長めに遅らせる
      const activity = createGitActivity();
      const counts = await Promise.all([1, 2, 3, 4, 5].map(() => activity.changeCount(repo)));
      t.ok('変更の数えを 5 つ同時に頼んでも、撮影（git add -A）は 1 本だけ共有する', count('add') === 1 && counts.every((x) => x === counts[0]), `add ${count('add')} ${JSON.stringify(counts)}`);
    }

    // ---- 隠し ref の片付けは、リポジトリごとに 1 回・読めなかったらあけてやり直す
    {
      reset();
      useGit();
      let clock = 1_000_000;
      const activity = createGitActivity({ now: () => clock });
      const repo = mkRepo('tidy-a');
      control({ 'for-each-ref': { exit: 1 } });
      await activity.status(repo, { fresh: true });
      t.ok('状態を初めて読んだ場所で、片付けのために for-each-ref を 1 回読む（読めなかった: git が断った）', await waitFor(() => count('for-each-ref') === 1, 3000), `for-each-ref ${count('for-each-ref')}`);
      clock += 30_000;
      await activity.status(repo, { fresh: true });
      await sleep(200);
      t.ok('読めなかった後 60 秒たつまでは、やり直さない', count('for-each-ref') === 1, `for-each-ref ${count('for-each-ref')}`);
      clock += 31_000;
      control();
      await activity.status(repo, { fresh: true });
      t.ok('60 秒あけたら、次の読み取りでやり直す', await waitFor(() => count('for-each-ref') === 2, 3000), `for-each-ref ${count('for-each-ref')}`);
      await sleep(100);
      clock += 500_000;
      await activity.status(repo, { fresh: true });
      await activity.changeCount(repo);
      await sleep(200);
      t.ok('片付けが済んだリポジトリは、以後なんど読んでも片付けない（1 回だけ）', count('for-each-ref') === 2, `for-each-ref ${count('for-each-ref')}`);
      await activity.status(mkRepo('tidy-b'), { fresh: true });
      t.ok('別のリポジトリは、また 1 回片付ける', await waitFor(() => count('for-each-ref') === 3, 3000), `for-each-ref ${count('for-each-ref')}`);
      // 同じ場所を別々の入口から同時に読んでも、片付けは重ねない（場所の見張りの合流）
      control({ 'for-each-ref': { delayMs: 1500 } });
      const entrances = [1, 2, 3].map(() => createGitActivity({ now: () => clock }));
      await Promise.all(entrances.map((a) => a.status(mkRepo('tidy-c'), { fresh: true })));
      await sleep(2200);
      t.ok('同じ場所を 3 つの入口から同時に読んでも、片付けの for-each-ref は 1 本に合流する', count('for-each-ref') === 4, `for-each-ref ${count('for-each-ref')}`);
    }

    // ---- 隠し ref の片付けは、数百本ずつ・長い上限・時間切れを休みに数えない・残りから続く（数千本を 1 回の 4 秒の上限に入れない）
    const refsOut = (n, from = 0) => Array.from({ length: n }, (_, i) => `refs/pleiad/turn/s1/${from + i}-start\n`).join('');
    {
      reset();
      useGit();
      const repo = mkRepo('cleanup-chunks');
      control({ 'for-each-ref': { out: refsOut(7) } });
      const removed = await git.dropTurnRefs(repo, { chunk: 3 });
      t.ok('dropTurnRefs: 7 本を 3 本ずつ消す（update-ref は 3 回）。消した数を返す', removed === 7 && count('for-each-ref') === 1 && count('update-ref') === 3, `removed ${removed} update-ref ${count('update-ref')}`);
      reset();
      control({ 'for-each-ref': { out: refsOut(700) } });
      const many = await git.dropTurnRefs(repo);
      t.ok('既定は 300 本ずつ（700 本は update-ref 3 回）', many === 700 && count('update-ref') === 3, `removed ${many} update-ref ${count('update-ref')}`);
      reset();
      control({ 'for-each-ref': { out: refsOut(7) } });
      const budget = await git.dropTurnRefs(repo, { chunk: 3, budgetMs: 0 });
      t.ok('全体の時間の上限を超えたら、残りは消さず null（次回へ回す）', budget === null && count('update-ref') === 0, `budget ${budget} update-ref ${count('update-ref')}`);
      const rest = await git.dropTurnRefs(repo, { chunk: 3 });
      t.ok('次に呼ぶと、そのときの残りを読み直して消す', rest === 7 && count('for-each-ref') === 2 && count('update-ref') === 3, `rest ${rest} update-ref ${count('update-ref')}`);
    }
    {
      reset();
      useGit();
      const repo = mkRepo('cleanup-no-rest');
      control({ 'for-each-ref': { out: refsOut(4) }, 'update-ref': { hang: true } });
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await git.dropTurnRefs(repo, { timeout: 300 }));
      harvest();
      const lane = git.placeGuard.snapshot(placeOf(repo)).light;
      t.ok('削除の時間切れ（3 回続けても）は null で、場所は休まない（REST にならない・数えにも載らない）', results.every((x) => x === null) && count('update-ref') === 3 && git.placeBlocked(repo) === null && lane.consecutive === 0 && lane.restUntil === 0, `${JSON.stringify(results)} ${JSON.stringify(lane)}`);
      control({ 'for-each-ref': { hang: true } });
      const listing = [await git.dropTurnRefs(repo, { timeout: 300 }), await git.dropTurnRefs(repo, { timeout: 300 })];
      harvest();
      t.ok('一覧を読む for-each-ref の時間切れも、休みに数えない', listing.every((x) => x === null) && git.placeBlocked(repo) === null && git.placeGuard.snapshot(placeOf(repo)).light.consecutive === 0);
      control({ status: { hang: true } });
      const real = await git.readGit(repo, ['status', '--porcelain=v2'], { timeout: 300 });
      harvest();
      t.ok('片付けの時間切れのあとの、普通の読みの時間切れは 1 回目として数える（まだ休まない）', real.code === 'TIMEOUT' && git.placeBlocked(repo) === null && git.placeGuard.snapshot(placeOf(repo)).light.consecutive === 1);
      git.placeGuard.leftover(placeOf(repo), { pid: process.pid, ended: new Promise(() => {}) });
      const before = lines().length;
      t.ok('場所が BUSY のときは、片付けも git を起こさない（null）', await git.dropTurnRefs(repo, { timeout: 300 }) === null && lines().length === before);
    }
    {
      // 片付けを呼ぶ側（createGitActivity）: 消せなかったら済みにせず、60 秒あけて残りをやり直す。済んだら二度とやらない
      reset();
      useGit();
      let clock = 1_000_000;
      const activity = createGitActivity({ now: () => clock });
      const repo = mkRepo('tidy-partial');
      control({ 'for-each-ref': { out: refsOut(5) }, 'update-ref': { exit: 1 } });
      await activity.status(repo, { fresh: true });
      t.ok('消せなかった（update-ref を git が断った）', await waitFor(() => count('update-ref') === 1, 3000), `update-ref ${count('update-ref')}`);
      await sleep(100);
      clock += 30_000;
      await activity.status(repo, { fresh: true });
      await sleep(200);
      t.ok('消せなかった後 60 秒たつまでは、やり直さない', count('for-each-ref') === 1 && count('update-ref') === 1, `for-each-ref ${count('for-each-ref')}`);
      clock += 31_000;
      control({ 'for-each-ref': { out: refsOut(2) } });
      await activity.status(repo, { fresh: true });
      t.ok('60 秒あけたら、残り（読み直した 2 本）を消す', await waitFor(() => count('update-ref') === 2, 3000) && count('for-each-ref') === 2, `update-ref ${count('update-ref')}`);
      await sleep(100);
      clock += 500_000;
      await activity.status(repo, { fresh: true });
      await sleep(200);
      t.ok('消し終えた後は、もう片付けない', count('for-each-ref') === 2 && count('update-ref') === 2);
    }
  } finally {
    harvest();
    for (const pid of strays) { try { process.kill(pid); } catch { /* もう居ない */ } }
    git.setGitBin(process.env.AGENT_HOST_GIT_BIN || null);
    git.placeGuard.reset();
    if (keep.log === undefined) delete process.env.FAKE_GIT_LOG; else process.env.FAKE_GIT_LOG = keep.log;
    if (keep.ctl === undefined) delete process.env.FAKE_GIT_CTL; else process.env.FAKE_GIT_CTL = keep.ctl;
    await sleep(100);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
