// 会話の PR をサーバー越しに（fake + 偽の gh。ADR 0206）。
// 会話が gh pr create した PR を会話ごとに覚える・gitPrs（states: false は番号だけ・既定は gh の状態つき）・
// 委譲した子の会話の PR が親の一覧に child: true で合流する・今から作る PR だけ（子の昔の PR は戻さない）・知らない会話は空、を確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { COMMANDS } from '../../core/protocol.mjs';

export const name = 'server-prs';
export const title = '会話の PR（サーバー越し）: 作った PR を覚える・状態は gh で読む（偽の gh）・委譲した子の PR が親の一覧に合流する';

const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const URL1 = 'https://github.com/example/pleiad/pull/20';
const URL2 = 'https://github.com/example/pleiad/pull/21';
const prSteps = (url) => `steps:${JSON.stringify({ steps: [{ tool: 'Bash', input: { command: 'gh pr create --fill' }, result: `Creating pull request\n\n${url}\n` }, { text: '出しました' }] })}`;

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-prs-')));
  const work = path.join(scratch, 'work');
  await fs.mkdir(work, { recursive: true });
  // 偽の gh: pr view <URL> の読み取りだけに答える（番号で状態を変える）
  const gh = path.join(scratch, 'fake-gh.mjs');
  await fs.writeFile(gh, [
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.FAKE_GH_LOG, process.argv.slice(2).join(' ') + '\\n');",
    "const [a, b, url] = process.argv.slice(2);",
    "if (a !== 'pr' || b !== 'view') { process.stderr.write('read only'); process.exit(1); }",
    "const n = Number(/\\/pull\\/(\\d+)/.exec(url)[1]);",
    "process.stdout.write(JSON.stringify({ title: 'PR ' + n, state: n === 21 ? 'MERGED' : 'OPEN', isDraft: false, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }));",
  ].join('\n'));
  const ghLog = path.join(scratch, 'gh.log');
  await fs.writeFile(ghLog, '');
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_GIT_SNAPSHOTS: 'off', AGENT_HOST_GH: gh, FAKE_GH_LOG: ghLog }, dataDir: path.join(scratch, 'data'), timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const ghCalls = async () => (await fs.readFile(ghLog, 'utf8')).split('\n').filter(Boolean);
  try {
    t.ok('gitPrs を protocol に登録している', COMMANDS.has('gitPrs'));

    // ---- 1. 自分の会話の PR
    const first = await c.runTurn({ backend: 'fake', cwd: work, prompt: prSteps(URL1) });
    const sid = first.sessionId;
    const numbers = await c.cmd('gitPrs', { sessionId: sid, states: false });
    t.ok('states: false は gh を呼ばず、番号・URL・repo だけ', numbers.prs.length === 1 && numbers.prs[0].number === 20 && numbers.prs[0].url === URL1 && numbers.prs[0].repo === 'example/pleiad'
      && !numbers.prs[0].state && !numbers.prs[0].child && numbers.reason === null && (await ghCalls()).length === 0, JSON.stringify(numbers));
    const full = await c.cmd('gitPrs', { sessionId: sid });
    t.ok('既定は gh の状態つき（題・open・チェック pass）', full.prs[0].title === 'PR 20' && full.prs[0].state === 'open' && full.prs[0].checks === 'pass' && full.reason === null, JSON.stringify(full));
    await c.cmd('gitPrs', { sessionId: sid });
    t.ok('60 秒は覚えていて、gh を呼び直さない', (await ghCalls()).length === 1, (await ghCalls()).join(' | '));
    const again = await c.runTurn({ sessionId: sid, prompt: prSteps(URL1) });
    t.ok('同じ PR をもう一度作っても 1 件', again.sessionId === sid && (await c.cmd('gitPrs', { sessionId: sid, states: false })).prs.length === 1);

    // ---- 2. 委譲した子の PR
    const childTask = prSteps(URL2);
    const parentRun = await c.runTurn({ sessionId: sid, prompt: ply('ply_delegate', { kind: 'implement', backend: 'fake', task: childTask, cwd: work }) });
    let row;
    for (let i = 0; i < 600 && !(row = (await c.cmd('agentTasks')).find((r) => r.parentSessionId === sid && ['completed', 'failed'].includes(r.status))); i++) await sleep(100);
    t.ok('子の会話が終わる', row?.status === 'completed', JSON.stringify(row));
    for (let i = 0; i < 300 && (await c.cmd('running')).turns.length; i++) await sleep(100);
    const merged = await c.cmd('gitPrs', { sessionId: sid, states: false });
    t.ok('親の一覧に子の PR が合流する（子の方が新しいので先頭・child: true・親の PR は child ではない）', merged.prs.map((p) => p.number).join() === '21,20'
      && merged.prs[0].child === true && !merged.prs[1].child, JSON.stringify(merged));
    const mergedFull = await c.cmd('gitPrs', { sessionId: sid });
    t.ok('子の PR にも状態がつく（merged）', mergedFull.prs[0].state === 'merged' && mergedFull.prs[0].child === true && mergedFull.prs[1].state === 'open');
    const childOnly = await c.cmd('gitPrs', { sessionId: row.sessionId, states: false });
    t.ok('子の会話の一覧は自分の PR だけ（child ではない）', childOnly.prs.length === 1 && childOnly.prs[0].number === 21 && !childOnly.prs[0].child, JSON.stringify(childOnly));
    void parentRun;

    // ---- 3. 知らない会話・引数なし
    t.ok('知らない会話・引数なしは空', (await c.cmd('gitPrs', { sessionId: 'no-such-session' })).prs.length === 0 && (await c.cmd('gitPrs', {})).prs.length === 0);
    // gh は読み取りだけ（pr view 以外を呼んでいない）
    t.ok('gh は pr view だけを呼ぶ', (await ghCalls()).every((l) => /^pr view https:\/\/github\.com\/example\/pleiad\/pull\/\d+ --json /.test(l)), (await ghCalls()).join(' | '));
  } finally {
    c.close();
    await server.stop?.();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
