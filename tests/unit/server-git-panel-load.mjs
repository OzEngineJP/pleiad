// git パネルの読み込みをサーバー越しに（fake + 一時リポジトリ）。
// 履歴の「始まりまで読む」（gitHistory through）・作業場所は一覧だけ先に（gitWorktrees only: list）・
// パネルを開いたときの worktree の片付けは、開いたリポジトリだけを、間隔を空けて 1 回（AGENT_HOST_WORKTREE_PANEL_SWEEP_MS）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-git-panel-load';
export const title = 'git パネルの読み込み（サーバー越し）: 始まりまで読む・作業場所は一覧だけ先に・開いたときの片付けは間隔を空ける';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const exists = (p) => fs.stat(p).then(() => true, () => false);
const slash = (p) => p.replaceAll('\\', '/');
const SWEEP_MS = 10_000;

export default async function (t) {
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = slash(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-gpl-'))));
  const repo = `${scratch}/repo`;
  await fs.mkdir(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  const commit = async (n) => { await fs.writeFile(`${repo}/f${n}.txt`, `${n}\n`); sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', `c${n}`); };
  await commit(0);

  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_WORKTREES: 'on', AGENT_HOST_WORKTREE_GRACE_MS: '0', AGENT_HOST_GIT_SNAPSHOTS: 'on', AGENT_HOST_WORKTREE_PANEL_SWEEP_MS: String(SWEEP_MS) },
    dataDir: `${scratch}/data`, timeoutMs: 30_000,
  });
  const c = await open({ port: server.port, token: server.token });
  try {
    // 会話の始まり = 最初のターンの撮影の親（c0）。そのあとに 8 コミット
    const first = await c.runTurn({ backend: 'fake', cwd: repo, prompt: 'echo:start' });
    const sid = first.sessionId;
    const startHash = sh(repo, 'rev-parse', 'HEAD');
    for (let i = 1; i <= 8; i++) await commit(i);

    // ---- 履歴: 1 ページ目で始まりの位置が分かり、「始まりまで読む」で続きを 1 回で読む
    const page1 = (await c.cmd('gitHistory', { sessionId: sid, limit: 3 })).history;
    t.ok('gitHistory: 始まりが読んだ範囲より後ろでも、session.pos が分かる（札を出す元）', page1.commits.length === 3 && page1.next !== null && page1.session?.head === startHash && page1.session.pos === 8 && !page1.session.lost, JSON.stringify(page1.session));
    const rest = (await c.cmd('gitHistory', { sessionId: sid, limit: 3, cursor: page1.next, through: true })).history;
    t.ok('gitHistory through: 続きから始まりのコミットまでを 1 回で読む（3 件 + 6 件ではなく、4〜8 の 6 件）', rest.commits.length === 6 && rest.commits.at(-1).hash === startHash && rest.session.pos === 8, JSON.stringify({ n: rest.commits.length, s: rest.session }));
    const plainNext = (await c.cmd('gitHistory', { sessionId: sid, limit: 3, cursor: page1.next })).history;
    t.ok('through を付けなければ、これまでどおり limit 件', plainNext.commits.length === 3);
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

    // ---- パネルを開いたときの片付け: 間隔を空ける（SWEEP_MS の間は 1 回まで）
    const spare = async () => { const r = await c.cmd('worktreeSplit', { sessionId: sid, cwd: repo }); return r.worktree; };
    const gone = async (w, ms) => { for (let i = 0; i < ms / 100 && await exists(w.path); i++) await sleep(100); return !(await exists(w.path)); };
    const a = await spare();
    t.ok('前提: 使っていない worktree ができている', await exists(a.path));
    let swept = Date.now();   // 片付けが走った時刻（サーバー側は呼ばれた直後に記録する）
    await c.cmd('gitPanel', { sessionId: sid, only: 'light' });
    t.ok('パネルを開くと、使っていない worktree は片付く（1 回目）', await gone(a, 8000));
    // 間隔の中でもう一度開く。遅い機械で間隔を越えてしまったら、その回は片付けが走るので、数え直して 3 回まで試す
    let kept = null; let b = null;
    for (let n = 0; n < 3 && kept === null; n++) {
      b = await spare();
      const at = Date.now();
      await c.cmd('gitPanel', { sessionId: sid, only: 'light' });
      if (at - swept < SWEEP_MS - 2000) { await sleep(800); kept = await exists(b.path); break; }
      await gone(b, 8000); swept = at;
    }
    t.ok('間隔の中でもう一度開いても、片付けは走らない（開くたびに調べない）', kept === true, `kept=${kept}`);
    if (kept) {
      await sleep(Math.max(0, SWEEP_MS - (Date.now() - swept)) + 300);
      // 別の片付けが走っている最中に開いた分は捨てられる（間隔の印は付かない）ので、開き直して 3 回まで待つ
      let again = false;
      for (let n = 0; n < 3 && !again; n++) { await c.cmd('gitPanel', { sessionId: sid, only: 'light' }); again = await gone(b, 6000); }
      t.ok('間隔が過ぎた後に開くと、また片付く', again);
    }
  } finally {
    c.close();
    await server.stop?.();
    await fs.rm(`${repo}.pleiad`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
