// 依頼元の AI が、委譲する子の Claude のアカウントを登録済みの中から選ぶ（ADR 0205、docs/agent-delegation.md「Claude のアカウントを選ぶ」）。
// 依頼元は fake、子は身代わりの Claude CLI でサーバー全体を通す。LLM は呼ばない
//   - ply_usage: Claude の各アカウントに account の名前（login・内部の id）。トークンの無い行は runnable: false。資格情報・メールアドレスは出さない
//   - ply_delegate: backend: "claude" と account で、その子はそのアカウントで走り、routing.target に残る
//   - 断る: 登録に無い名前（選べる名前を添える）・トークンの無いアカウント・backend なし・Claude 以外の backend。断ったら何も作らない
//   - ply_task_send: account で子のアカウントを次のターンから替える。変更の記録・routing.changed に残る。断ったら何も変えない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';
import { startFakeAnthropicApi } from '../lib/fake-anthropic-api.mjs';

export const name = 'server-delegate-account';
export const title = '依頼元の AI が ply_delegate・ply_task_send の account で子の Claude のアカウントを選ぶ';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

const TOKEN = 'sk-ant-oat01-' + 'D'.repeat(48);
const ORG = '33333333-1111-4000-8000-00000000000c';
// トークンを入れていない登録（表示名にメールアドレスを含む）
const NO_TOKEN = 'acct-aaaaaaaaaaaa';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-delegate-account-'));
  const api = await startFakeAnthropicApi({ [TOKEN]: ORG });
  const cliDir = path.join(scratch, 'cli-config');
  await fs.mkdir(cliDir, { recursive: true });
  await fs.writeFile(path.join(cliDir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG, emailAddress: 'logged-in@example.com' } }));
  await fs.writeFile(path.join(scratch, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: NO_TOKEN, name: 'no-token@example.com' }] }));
  const fake = await installFakeClaude(path.join(scratch, 'cli'));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake,claude', ...fake.env, CLAUDE_CONFIG_DIR: cliDir, AGENT_HOST_ANTHROPIC_API: api.url } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const tasks = async () => c.cmd('agentTasks');
  const task = async taskId => (await tasks()).find(r => r.taskId === taskId);
  const row = async sessionId => (await c.cmd('listSessions')).find(s => s.id === sessionId);
  const awaitTask = async (taskId, fn, what = '') => {
    const deadline = Date.now() + 60_000;
    let r;
    while (Date.now() < deadline) { r = await task(taskId); if (r && fn(r)) return r; await sleep(50); }
    throw new Error(`task timeout ${what}: ` + JSON.stringify(r && { status: r.status, backend: r.backend, notification: r.notification, error: r.error }));
  };
  // その会話から ply_agents のツールを 1 回呼び、戻り（エラーなら { error }）を読む
  const call = async (sessionId, name, args) => {
    const from = c.mark();
    await c.runTurn({ sessionId, prompt: prompt(name, args) });
    const ev = await c.waitFor(e => e.type === 'tool.result' && e.sessionId === sessionId, { from, ms: 60000 });
    return ev.isError ? { error: ev.text } : JSON.parse(ev.text);
  };
  // 変更の記録は AI の口（ply_control の sessions.changes）で読む
  let reader = null;
  const changes = async sessionId => {
    const turn = await c.runTurn({ ...(reader ? { sessionId: reader } : { backend: 'fake', cwd: ROOT }),
      prompt: 'control:' + JSON.stringify({ name: 'call_op', arguments: { op: 'sessions.changes', args: { sessionId, limit: 50 } } }) });
    reader = turn.sessionId;
    const got = JSON.parse(turn.events.find(e => e.type === 'tool.result').text);
    return (got.result ?? got).changes ?? [];
  };
  let parent;
  // 依頼元へ完了通知が届き、依頼元のターンが終わるまで待つ
  const settle = async taskId => {
    await awaitTask(taskId, r => !['queued', 'running', 'cancelling'].includes(r.status) && !['none', 'pending', 'delivering'].includes(r.notification), 'settle');
    for (let i = 0; i < 200 && (await c.cmd('running')).turns.some(x => x.sessionId === parent); i++) await sleep(50);
  };
  try {
    const saved = await c.cmd('saveClaudeAccount', { name: '仕事用 work@example.com', token: TOKEN });
    const work = saved.id;
    t.ok('登録したアカウントの id は acct- と 12 桁の 16 進', /^acct-[0-9a-f]{12}$/.test(work), work);

    // ---- ply_usage に account の名前。資格情報・メールアドレスは出さない
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_usage', { backend: 'claude' }) });
    parent = first.sessionId;
    const usageText = first.events.find(e => e.type === 'tool.result').text;
    const accounts = JSON.parse(usageText).backends[0].accounts ?? [];
    t.ok('ply_usage の Claude の各アカウントに account の名前（login・登録した id）', ['login', work, NO_TOKEN].every(a => accounts.some(x => x.account === a)), JSON.stringify(accounts.map(a => a.account)));
    t.ok('トークンの無いアカウントは runnable: false', accounts.find(x => x.account === NO_TOKEN)?.runnable === false && accounts.find(x => x.account === work)?.runnable === undefined);
    t.ok('ply_usage に資格情報・メールアドレスを出さない', !usageText.includes(TOKEN) && !/sk-ant|work@example|no-token@example|logged-in@example|hasToken/.test(usageText), usageText.slice(0, 300));

    // ---- 断る。断ったら何も作らない
    const before = (await tasks()).length;
    const unknown = await call(parent, 'ply_delegate', { kind: 'mechanical', backend: 'claude', account: 'acct-ffffffffffff', task: 'hello' });
    t.ok('登録に無い名前は account_unknown で断り、選べる名前を添える', String(unknown.error ?? '').includes('account_unknown') && unknown.error.includes(work) && unknown.error.includes('login') && !unknown.error.includes(NO_TOKEN), unknown.error);
    const noToken = await call(parent, 'ply_delegate', { kind: 'mechanical', backend: 'claude', account: NO_TOKEN, task: 'hello' });
    t.ok('トークンの無いアカウントは account_no_token で断る', String(noToken.error ?? '').includes('account_no_token'), noToken.error);
    const noBackend = await call(parent, 'ply_delegate', { kind: 'mechanical', account: work, task: 'hello' });
    t.ok('backend なしの account は断る（自動の振り分けは今どおり）', Boolean(noBackend.error) && noBackend.error.includes('backend'), noBackend.error);
    const otherBackend = await call(parent, 'ply_delegate', { kind: 'mechanical', backend: 'fake', account: work, task: 'hello' });
    t.ok('Claude 以外の backend の account は断る', Boolean(otherBackend.error) && otherBackend.error.includes('fake'), otherBackend.error);
    t.ok('断った委譲はタスクを作らない', (await tasks()).length === before);

    // ---- 固定の委譲でアカウントを選ぶ
    const made = await call(parent, 'ply_delegate', { kind: 'mechanical', backend: 'claude', account: work, task: 'hello' });
    t.ok('backend: "claude" と account で委譲できる', !made.error && made.taskId, JSON.stringify(made).slice(0, 300));
    await settle(made.taskId);
    let done = await task(made.taskId);
    let child = await row(made.sessionId);
    t.ok('子の会話はそのアカウントで走る', done.status === 'completed' && child.backend === 'claude' && child.claudeAccount === work, JSON.stringify({ status: done.status, error: done.error, account: child.claudeAccount }));
    t.ok('routing.target にアカウントと伏せた見出しが残る', done.routing?.target?.account === work && done.routing.target.accountLabel === '仕事用 w***@example.com'
      && !JSON.stringify(done.routing).includes('work@example'), JSON.stringify(done.routing));

    // ---- ply_task_send で断る。何も変えない
    const snapshot = async () => JSON.stringify({ task: await task(made.taskId), child: await row(made.sessionId), changes: await changes(made.sessionId) });
    const kept = await snapshot();
    const badSend = await call(parent, 'ply_task_send', { taskId: made.taskId, account: 'nope' });
    t.ok('ply_task_send でも登録に無い名前は断る', String(badSend.error ?? '').includes('account_unknown'), badSend.error);
    const noTokenSend = await call(parent, 'ply_task_send', { taskId: made.taskId, account: NO_TOKEN, message: 'again' });
    t.ok('トークンの無いアカウントは message と一緒でも断る', String(noTokenSend.error ?? '').includes('account_no_token'), noTokenSend.error);
    t.ok('断ったらタスク・子の会話・変更の記録を変えない', (await snapshot()) === kept);

    // ---- ply_task_send でアカウントを替える（次のターンから）
    const switched = await call(parent, 'ply_task_send', { taskId: made.taskId, account: 'login' });
    t.ok('設定だけ替えられ、新しいアカウントを返す', !switched.error && switched.settings?.appliesTo === 'nextTurn', JSON.stringify(switched).slice(0, 300));
    done = await task(made.taskId);
    child = await row(made.sessionId);
    t.ok('子の次のターンの予約（nextSettings.account）に入る。完了した子は勝手に走らせない', done.status === 'completed' && child.claudeAccount === work && child.nextSettings?.account === '',
      JSON.stringify({ status: done.status, account: child.claudeAccount, next: child.nextSettings }));
    t.ok('routing.changed に元のアカウントが残り、target は新しいアカウント', done.routing?.changed?.by === 'parent' && done.routing.changed.from?.account === work
      && done.routing.target?.account === '' && !JSON.stringify(done.routing).includes('work@example'), JSON.stringify(done.routing));
    const logged = (await changes(made.sessionId)).filter(x => x.field === 'account');
    t.ok('子の会話の変更の記録に、伏せた見出しで残る（by: agent）', logged.length === 1 && logged[0].by === 'agent' && logged[0].bySession === parent
      && logged[0].from === '仕事用 w***@example.com' && !JSON.stringify(logged).includes(work), JSON.stringify(logged));
    await call(parent, 'ply_task_send', { taskId: made.taskId, message: 'again' });
    await settle(made.taskId);
    child = await row(made.sessionId);
    t.ok('次のターンは新しいアカウントで走る', child.claudeAccount === '' && !child.nextSettings?.account, JSON.stringify({ account: child.claudeAccount, next: child.nextSettings }));

    // ---- Claude 以外の子
    const plain = await call(parent, 'ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:ONE' });
    await settle(plain.taskId);
    const plainBefore = JSON.stringify(await task(plain.taskId));
    const wrong = await call(parent, 'ply_task_send', { taskId: plain.taskId, account: work });
    t.ok('Claude 以外の子の account は断り、何も変えない', Boolean(wrong.error) && JSON.stringify(await task(plain.taskId)) === plainBefore && !(await row(plain.sessionId)).nextSettings, wrong.error);
    const toClaude = await call(parent, 'ply_task_send', { taskId: plain.taskId, backend: 'claude', account: work });
    child = await row(plain.sessionId);
    t.ok('同じ送信で backend: "claude" に替えるなら account も書ける', !toClaude.error && child.nextSettings?.backend === 'claude' && child.nextSettings.account === work,
      JSON.stringify({ error: toClaude.error, next: child.nextSettings }));
  } finally {
    c.close();
    await server.stop();
    await api.close?.();
  }
}
