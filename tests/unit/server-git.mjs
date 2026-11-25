// git の動きをサーバー越しに（fake + 一時リポジトリ。ADR 0085・ADR 0353）。
// ターンごとの変更の記録（始まり・終わりの撮影と、返答の下の present kind: git）は ADR 0353 でやめた。
// 何も記録せず・隠し ref も作らず・present も出さないこと、git 管理外は何もしないこと、
// gitStatus / gitPanel / gitDiff の口、委譲の子の完了通知に「変更:」の行が無いことを確かめる。
// （worktree の子の「作業場所: worktree …」の行は server-worktree の試験が確かめる）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { COMMANDS } from '../../core/protocol.mjs';

export const name = 'server-git';
export const title = 'git の動き（サーバー越し）: ターンの記録はしない・パネルの口・git 管理外・委譲の完了通知に変更の行は無い';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-git-')));
  const repo = path.join(scratch, 'repo');
  const plain = path.join(scratch, 'plain');
  await fs.mkdir(path.join(repo, 'core'), { recursive: true });
  await fs.mkdir(plain, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'core', 'a.mjs'), 'one\ntwo\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'first');
  // 前の版が撮って残した隠し ref（ADR 0085）。サーバーが作業場所を初めて読んだときに 1 回だけ消す（ADR 0353）。archive の ref は残す
  const first0 = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'update-ref', 'refs/pleiad/turn/old-session/1-start', first0);
  sh(repo, 'update-ref', 'refs/pleiad/turn/old-session/1-end', first0);
  sh(repo, 'update-ref', 'refs/pleiad/archive/keep', first0);

  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(scratch, 'data'), timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const refs = () => sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/pleiad/').split('\n').filter(Boolean);
  // この試験が最初から置いた ref（old-session と archive）を除いた、新しく作られた ref
  const made = () => refs().filter((r) => !r.startsWith('refs/pleiad/archive/') && !r.includes('/old-session/'));
  const gitPresent = (events) => events.filter((e) => e.type === 'present' && e.kind === 'git');
  try {
    t.ok('コマンドを protocol に登録している', ['gitStatus', 'gitPanel', 'gitDiff'].every((n) => COMMANDS.has(n)));

    // ---- 1. ブランチを作り、直し、コミットし、PR を出すターン（記録はしない）。台本の最初のツールは ask: true で承認待ちに止め、作業場所を変えてから進める
    const steps = { steps: [
      { tool: 'Bash', input: { command: 'git checkout -b fix/x' }, result: "Switched to a new branch 'fix/x'", ask: true },
      { tool: 'Bash', input: { command: 'git commit -am "fix: a"' }, result: '[fix/x abcdef0] fix: a\n 1 file changed', ms: 100 },
      { tool: 'Bash', input: { command: 'gh pr create' }, result: 'https://github.com/example/p/pull/9', ms: 100 },
      { text: '直しました' },
    ] };
    const from = c.mark();
    const running = c.runTurn({ backend: 'fake', cwd: repo, prompt: `steps:${JSON.stringify(steps)}` });
    const asked = await Promise.race([
      c.waitFor((e) => e.type === 'permission', { from, ms: 30_000 }),
      running.then((result) => { throw new Error(`承認より先にターンが終わった: ${JSON.stringify({ outcome: result.outcome, events: result.events?.map(e => e.type) })}`); }),
    ]);
    // ターンの途中（記録があれば、始まりの撮影が済んでいるころ）に、隠し ref が作られていない
    await sleep(300);
    t.ok('ターンの始まりに隠し ref を作らない（撮影をやめた）', made().length === 0, made().join());
    sh(repo, 'checkout', '-q', '-b', 'fix/x');
    await fs.writeFile(path.join(repo, 'core', 'a.mjs'), 'one\nTWO\nthree\n');
    sh(repo, 'commit', '-q', '-am', 'fix: a');
    await fs.writeFile(path.join(repo, 'new.txt'), 'x\n');
    await c.cmd('resolvePermission', { id: asked.id, allow: true });
    const first = await running;
    const sid = first.sessionId;
    t.ok('ターンの終わりに present kind: git を出さない（返答の下の変更の行はやめた）', gitPresent(first.events).length === 0, JSON.stringify(gitPresent(first.events)));
    t.ok('ターンの終わりにも隠し ref を作らない', made().length === 0, made().join());
    t.ok('ユーザーのブランチは増えず、作業ツリー（未追跡 new.txt）はそのまま', sh(repo, 'branch', '--list').split('\n').length === 2 && sh(repo, 'status', '--porcelain').includes('?? new.txt'));
    const loaded = await c.cmd('loadSession', { sessionId: sid });
    t.ok('会話に保存された present にも kind: git は無い', !(loaded.presents ?? []).some((p) => p.kind === 'git'), JSON.stringify(loaded.presents));

    // ---- 2. 何も動かないターンも同じ
    const quiet = await c.runTurn({ sessionId: sid, prompt: 'echo:ok' });
    t.ok('git が動かなかったターンも present kind: git・隠し ref は無い', gitPresent(quiet.events).length === 0 && made().length === 0);

    // ---- 3. パネルの口（この会話の間の範囲は無い）
    const status = await c.cmd('gitStatus', { sessionId: sid });
    t.ok('gitStatus: ブランチ・変更の数・linked でない', status.git?.branch === 'fix/x' && status.git.dirty === 1 && status.git.linked === false && status.git.ahead === null, JSON.stringify(status));
    const panel = await c.cmd('gitPanel', { sessionId: sid });
    t.ok('gitPanel: 状態・タイムライン（作成・コミット・PR の順）・コミットしていない変更', panel.git.branch === 'fix/x'
      && panel.timeline.map((e) => e.kind).join() === 'branch,commit,pr' && panel.timeline[1].hash === 'abcdef0' && panel.timeline.every((e) => e.uuid)
      && panel.changes.range === 'uncommitted' && panel.changes.hasSession === undefined && panel.changes.files.map((f) => f.path).join() === 'new.txt' && panel.changes.files[0].state === 'A', JSON.stringify([panel.timeline, panel.changes]));
    const asSession = await c.cmd('gitPanel', { sessionId: sid, range: 'session' });
    t.ok('range: session を送られても、コミットしていない変更として返す（この会話の間はやめた）', asSession.changes.range === 'uncommitted' && asSession.changes.files.map((f) => f.path).join() === 'new.txt', JSON.stringify(asSession.changes));
    const diff = await c.cmd('gitDiff', { sessionId: sid, path: 'new.txt' });
    t.ok('gitDiff: コミットしていない変更のハンクの行', diff.diff?.hunks[0].lines.some((l) => l.t === '+' && l.s === 'x') && diff.diff.binary === false, JSON.stringify(diff));
    const noSummary = await c.cmd('gitStatus', { sessionId: sid, summary: true });
    t.ok('gitStatus: summary を送られても、会話の間のまとめ（session）は返さない', noSummary.git?.branch === 'fix/x' && noSummary.git.session === undefined, JSON.stringify(noSummary.git));

    // ---- 4. 作業場所の検証
    t.ok('知らない会話は null', (await c.cmd('gitStatus', { sessionId: 'no-such-session' })).git === null);
    t.ok('会話の無い下書きの cwd は、使ったことのある場所だけ通す', (await c.cmd('gitStatus', { cwd: repo })).git?.branch === 'fix/x' && (await c.cmd('gitStatus', { cwd: scratch })).git === null);
    t.ok('引数が無くても落ちない', (await c.cmd('gitStatus', {})).git === null && (await c.cmd('gitDiff', {})).diff === null);

    // ---- 5. git 管理外
    const nogit = await c.runTurn({ backend: 'fake', cwd: plain, prompt: 'echo:hi' });
    t.ok('git 管理外では present を出さず、状態は null', gitPresent(nogit.events).length === 0 && (await c.cmd('gitStatus', { sessionId: nogit.sessionId })).git === null);
    t.ok('git 管理外のターンは ref を作らない', made().length === 0);

    // ---- 6. 前の版が残した隠し ref（最初に置いた old-session）は、サーバーが作業場所を読んだ後に消えている（1 回だけ・裏で）。ユーザーのブランチ・archive の ref・作業ツリーには触れない
    for (let i = 0; i < 100 && refs().some((r) => r.startsWith('refs/pleiad/turn/')); i++) await sleep(100);
    t.ok('残っていた refs/pleiad/turn/ は消える（archive の ref・ブランチ・作業ツリーはそのまま）', refs().join() === 'refs/pleiad/archive/keep' && sh(repo, 'branch', '--list').split('\n').length === 2 && sh(repo, 'status', '--porcelain').includes('?? new.txt'), refs().join());

    // ---- 7. 委譲の子の完了通知: worktree を切らない子には「変更:」の行も作業場所の行も載せない（同じ作業場所の別の会話のコミットが混ざり、当てにならないため）
    const wt = path.join(scratch, 'wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'pleiad/ply-1', wt);
    const childSteps = { steps: [{ tool: 'Bash', input: { command: 'work' }, result: 'ok', ask: true }, { text: '終わった' }] };
    const parentFrom = c.mark();
    const parentRun = c.runTurn({ backend: 'fake', cwd: repo, prompt: ply('ply_delegate', { kind: 'implement', backend: 'fake', task: `steps:${JSON.stringify(childSteps)}`, cwd: wt }) });
    // 子のツールを承認待ちに止め、子が作業場所を変え終わるまで終わらせない（実時間の長さで待たない）。
    // 親は ply_delegate を返すと子を待たずにターンを終えられるので、親のターンの終わりとは競わせず、子の承認だけを待つ（issue #73）
    const started = await c.waitFor((e) => e.type === 'permission', { from: parentFrom, ms: 30_000 });
    await fs.writeFile(path.join(wt, 'w1.txt'), 'a\nb\n');
    sh(wt, 'add', '.'); sh(wt, 'commit', '-q', '-m', 'child: w1');
    await fs.writeFile(path.join(wt, 'w2.txt'), 'c\n');
    await c.cmd('resolvePermission', { id: started.id, allow: true });
    const parent = await parentRun;
    // 遅い環境では、子が始まって終わるまでに 10 秒を超える。待つ上限は長く取る
    let row;
    for (let i = 0; i < 600 && !(row = (await c.cmd('agentTasks')).find((r) => r.parentSessionId && ['completed', 'failed'].includes(r.status))); i++) await sleep(100);
    t.ok('子のタスクの記録に変更の要約（git）は載らない', Boolean(row) && row.git === undefined, JSON.stringify(row?.git));
    const notices = [];
    for (let i = 0; i < 300 && !notices.length; i++) { notices.push(...c.since(parentFrom).filter((e) => e.type === 'taskNotice' && /Pleiad タスク完了通知/.test(e.text))); await sleep(100); }
    t.ok('完了通知は届くが、「変更: …」の行は無い（worktree を切らない子には作業場所の行も無い）', notices.length > 0 && notices.every((n) => !/変更:/.test(n.text) && !/作業場所: worktree/.test(n.text) && !/\{\{/.test(n.text)), notices.map((n) => n.text).join('\n---\n').slice(0, 600));
    // ply_task_status にも gitSummary は無い
    for (let i = 0; i < 300 && (await c.cmd('running')).turns.length; i++) await sleep(100);
    const status2 = await c.runTurn({ sessionId: parent.sessionId, prompt: ply('ply_task_status', { taskId: row.taskId }) });
    const reply = (await c.cmd('loadSession', { sessionId: status2.sessionId })).messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
    t.ok('ply_task_status の結果に gitSummary・git は無い', reply.includes('"taskId"') && !reply.includes('gitSummary') && !reply.includes('"git"'), reply.slice(0, 400));
    t.ok('委譲の子も隠し ref を作らない', made().length === 0 && !refs().some((r) => r.startsWith('refs/pleiad/turn/')), refs().join());
  } finally {
    c.close();
    await server.stop?.();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
