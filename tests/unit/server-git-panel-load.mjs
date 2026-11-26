// git パネルの読み込みをサーバー越しに（fake + 一時リポジトリ）。
// 履歴のページ（gitHistory。会話の始まりまで読む through は ADR 0354 でやめた）・作業場所は一覧だけ先に（gitWorktrees only: list）・
// パネルを開いたときの worktree の片付けは、開いたリポジトリだけを、間隔を空けて 1 回（AGENT_HOST_WORKTREE_PANEL_SWEEP_MS）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-git-panel-load';
export const title = 'git パネルの読み込み（サーバー越し）: 履歴のページ・作業場所は一覧だけ先に・開いたときの片付けは間隔を空ける';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const exists = (p) => fs.stat(p).then(() => true, () => false);
const slash = (p) => p.replaceAll('\\', '/');
// 1 つ目のサーバーの、パネルを開いたときの片付けの間隔。試験の間に過ぎないよう長くする（過ぎた後は、間隔 1ms の 2 つ目のサーバーで確かめる）
const SWEEP_MS = 3_600_000;

export default async function (t) {
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = slash(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-gpl-'))));
  const repo = `${scratch}/repo`;
  await fs.mkdir(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  const commit = async (n) => { await fs.writeFile(`${repo}/f${n}.txt`, `${n}\n`); sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', `c${n}`); };
  await commit(0);

  // AGENT_HOST_WORKTREE_LOG: 片付けの始まり・終わり・飛ばした理由の行を出させる（試験はその行を待つ）
  const serverEnv = { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_WORKTREES: 'on', AGENT_HOST_WORKTREE_GRACE_MS: '0', AGENT_HOST_WORKTREE_LOG: '1' };
  let server = await startServer({
    env: { ...serverEnv, AGENT_HOST_WORKTREE_PANEL_SWEEP_MS: String(SWEEP_MS) },
    dataDir: `${scratch}/data`, timeoutMs: 30_000,
  });
  let c = await open({ port: server.port, token: server.token });
  try {
    // 最初のターンで会話を作り、そのあとに 8 コミット
    const first = await c.runTurn({ backend: 'fake', cwd: repo, prompt: 'echo:start' });
    const sid = first.sessionId;
    for (let i = 1; i <= 8; i++) await commit(i);

    // ---- 履歴: limit 件ずつ。会話の始まりの位置（session）と「始まりまで読む」（through）は ADR 0354 でやめた
    const page1 = (await c.cmd('gitHistory', { sessionId: sid, limit: 3 })).history;
    t.ok('gitHistory: 1 ページ目は limit 件・next あり・会話の始まり（session）は付けない', page1.commits.length === 3 && page1.next !== null && page1.session === undefined, JSON.stringify({ n: page1.commits.length, next: page1.next, session: page1.session }));
    const plainNext = (await c.cmd('gitHistory', { sessionId: sid, limit: 3, cursor: page1.next })).history;
    t.ok('gitHistory: 続きも limit 件（3 + 3）', plainNext.commits.length === 3 && plainNext.commits[0].hash !== page1.commits[0].hash);
    const ignored = (await c.cmd('gitHistory', { sessionId: sid, limit: 3, cursor: page1.next, through: true })).history;
    t.ok('through を付けても無視され、limit 件のまま', ignored.commits.length === 3 && ignored.commits[0].hash === plainNext.commits[0].hash, JSON.stringify({ n: ignored.commits.length }));
    const none = (await c.cmd('gitHistory', { sessionId: 'no-such-session', limit: 3 })).history;
    t.ok('知らない会話は null（落ちない）', none === null);

    // ---- 作業場所: 一覧だけ（状態は読まない）→ 中身まで
    const other = `${scratch}/other`;
    sh(repo, 'worktree', 'add', '-q', '-b', 'exp', other);
    await fs.writeFile(`${other}/e.txt`, 'e\n'); sh(other, 'add', '.'); sh(other, 'commit', '-q', '-m', 'exp'); await fs.writeFile(`${other}/dirty.txt`, 'd\n');
    const light = (await c.cmd('gitWorktrees', { sessionId: sid, only: 'list' })).worktrees;
    const lrow = light.rows.find((r) => r.branch === 'exp');
    t.ok('gitWorktrees only: list: 件数・名前・場所だけ。partial で、状態（変更・ahead・日時）は空', light.partial === true && light.total === 2 && light.rows.length === 2 && lrow && lrow.dirty === 0 && lrow.ahead === 0 && lrow.at === null && light.rows[0].main === true && light.rows[0].here === true, JSON.stringify(light));
    const full = (await c.cmd('gitWorktrees', { sessionId: sid })).worktrees;
    const frow = full.rows.find((r) => r.branch === 'exp');
    t.ok('gitWorktrees（そのまま）: 中身まで読む（partial なし）', full.partial === undefined && frow.dirty === 1 && frow.ahead === 1 && frow.at > 0, JSON.stringify(frow));

    // ---- パネルを開いたときの片付け: 間隔を空ける（間隔の中は 1 回まで）
    // 片付けの始まり・終わり・飛ばした理由は、サーバーの worktree のログ（AGENT_HOST_WORKTREE_LOG）の行で待つ。時計で推し量らない
    // （重い PC では worktree を作るだけで 10 秒かかり、「前の片付けから何秒」の窓に入れなかった）
    const spare = async () => { const r = await c.cmd('worktreeSplit', { sessionId: sid, cwd: repo }); return r.worktree; };
    const SWEEP_LINE = /worktree: sweep (start|done|skip interval|skip busy) (repo=|all)/;
    // 走っている片付け（起動時・ターンの終わりの全部の片付けを含む）が無くなるまで待つ。片付けは重ならないので、始まりと終わりの行の数が揃えば止まっている
    const idle = async () => {
      for (;;) {
        const seen = server.lines(SWEEP_LINE);
        const started = seen.filter((l) => / sweep start /.test(l.line)).length;
        if (seen.filter((l) => / sweep done /.test(l.line)).length >= started) return;
        await server.waitLine(/worktree: sweep done /, { from: seen.at(-1).n, ms: 60_000 });
      }
    };
    // パネルを開き、その呼び出しで片付けをどうしたか（start・skip interval・skip busy）の行を返す。片付けの要否は応答の前に決まる
    const openPanel = async () => {
      await idle();
      const from = server.mark();
      await c.cmd('gitPanel', { sessionId: sid, only: 'light' });
      return server.waitLine(/worktree: sweep (start|skip interval|skip busy) repo=/, { from, ms: 60_000 });
    };
    // 片付けの行（start）の後の、終わりの行まで待つ
    const finished = (started) => server.waitLine(/worktree: sweep done repo=/, { from: started.n, ms: 60_000 });

    const a = await spare();
    t.ok('前提: 使っていない worktree ができている', await exists(a.path));
    const firstSweep = await openPanel();
    if (/ sweep start /.test(firstSweep.line)) await finished(firstSweep);
    t.ok('パネルを開くと、使っていない worktree は片付く（1 回目）', / sweep start /.test(firstSweep.line) && !(await exists(a.path)), firstSweep.line);
    // 間隔（このサーバーは 1 時間）の中でもう一度開く
    const b = await spare();
    const within = await openPanel();
    t.ok('間隔の中でもう一度開いても、片付けは走らない（開くたびに調べない）', / skip interval /.test(within.line) && await exists(b.path), within.line);

    // ---- 間隔が過ぎた後: 間隔を 1ms にしたサーバーで（同じデータ置き場）。1 回目の片付けの後、worktree を作る間に間隔は必ず過ぎている
    c.close();
    await server.stop();
    server = await startServer({ env: { ...serverEnv, AGENT_HOST_WORKTREE_PANEL_SWEEP_MS: '1' }, dataDir: `${scratch}/data`, timeoutMs: 30_000 });
    c = await open({ port: server.port, token: server.token });
    const opened = await openPanel();
    if (/ sweep start /.test(opened.line)) await finished(opened);
    const d = await spare();
    const after = await openPanel();
    if (/ sweep start /.test(after.line)) await finished(after);
    t.ok('間隔が過ぎた後に開くと、また片付く', / sweep start /.test(opened.line) && / sweep start /.test(after.line) && !(await exists(b.path)) && !(await exists(d.path)), `${opened.line} / ${after.line}`);
  } finally {
    c.close();
    await server.stop?.();
    await fs.rm(`${repo}.pleiad`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
