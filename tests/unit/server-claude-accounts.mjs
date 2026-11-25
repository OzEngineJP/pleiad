// Claude のアカウント切り替えを server の配線で通す。fake バックエンドは Claude と同じく選んだアカウント（account）を受け取り、
// "whoami" でその id の指紋を返す。LLM は呼ばない。アカウントはログインが済んだ形で置く（tests/lib/claude-account-seed.mjs。ADR 0352）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { seedClaudeAccount } from '../lib/claude-account-seed.mjs';

export const name = 'server-claude-accounts';
export const title = 'Claude のアカウント: 一覧・ログインの無いアカウントは選ばせず止める・会話ごとの選択・分岐と委譲での引き継ぎ・削除したら止める';

const fingerprint = id => `account:${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
const lastText = history => [...history.messages].reverse().find(m => m.role === 'assistant')?.text ?? '';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-accounts-server-'));
  // ログイン中のアカウント（CLAUDE_CONFIG_DIR/.claude.json）は使い捨ての場所に置く
  const cliDir = path.join(scratch, 'cli-config');
  await fs.mkdir(cliDir, { recursive: true });
  await fs.writeFile(path.join(cliDir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: '22222222-1111-4000-8000-00000000000a', emailAddress: 'logged-in@example.com' } }));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', CLAUDE_CONFIG_DIR: cliDir }, dataDir: scratch });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const row = async id => (await c.cmd('listSessions')).find(s => s.id === id);
  try {
    t.ok('最初は何も登録していない', (await c.cmd('claudeAccounts')).accounts.length === 0);
    // 何も登録していない人には今と同じ動き
    const { sessionId: plain } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    await c.runTurn({ sessionId: plain, prompt: 'whoami' });
    t.ok('未選択の会話にはアカウントを渡さない', lastText(await c.cmd('loadSession', { sessionId: plain })) === 'account:none');
    t.ok('一覧の行はログイン中のアカウント（空）', (await row(plain)).claudeAccount === '');

    const work = await seedClaudeAccount(scratch, '仕事用', { oauthAccount: { organizationUuid: '11111111-2222-4000-8000-00000000000b', emailAddress: 'work@example.com' } });
    const listed = (await c.cmd('claudeAccounts')).accounts;
    t.ok('一覧は名前とログインの有無だけ（トークン・持ち主の照合の項目は無い。ADR 0352）', listed.length === 1 && listed[0].id === work && listed[0].name === '仕事用'
      && listed[0].usageLogin === true && !('hasToken' in listed[0]) && !('tokenCheck' in listed[0]), JSON.stringify(listed[0]));

    // ログインがまだのアカウントは選ばせず、ログインへ案内する
    const pending = await seedClaudeAccount(scratch, 'ログインがまだ', { login: false });
    t.ok('ログインがまだのアカウントは一覧で分かる', (await c.cmd('claudeAccounts')).accounts.find(a => a.id === pending)?.usageLogin === false);
    const { sessionId: noLogin } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    let refusedPick = null;
    await c.cmd('setTurnSettings', { sessionId: noLogin, account: pending }).catch(e => { refusedPick = e; });
    t.ok('ログインがまだのアカウントは選べず、ログインへ案内する', refusedPick?.message.includes('ログインしてください'), refusedPick?.message);
    // 選んだ後でログインの印が無くなった（ログインし直しの途中など）: 送信を止める
    const later = await seedClaudeAccount(scratch, 'あとで切れる');
    await c.cmd('setTurnSettings', { sessionId: noLogin, account: later });
    await fs.rm(path.join(scratch, 'claude-usage', later, 'ply-usage-login.json'));
    let stopped = null;
    await c.runTurn({ sessionId: noLogin, prompt: 'whoami' }).catch(e => { stopped = e; });
    t.ok('ログインが無くなったアカウントの会話は送信を止める', stopped?.message.includes('ログイン') && !lastText(await c.cmd('loadSession', { sessionId: noLogin })).startsWith('account:'), stopped?.message);
    await c.cmd('deleteClaudeAccount', { id: pending });
    await c.cmd('deleteClaudeAccount', { id: later });

    await c.cmd('setTurnSettings', { sessionId: plain, account: 'nope' }).then(
      () => t.ok('登録していないアカウントは選べない', false), e => t.ok('登録していないアカウントは選べない', e.message.includes('登録されていません')));

    const next = await c.cmd('setTurnSettings', { sessionId: plain, account: work });
    t.ok('選択は次のターンの予約になる', next?.account === work && (await row(plain)).claudeAccount === '');
    await c.runTurn({ sessionId: plain, prompt: 'whoami' });
    t.ok('次のターンから選んだアカウントで走る', lastText(await c.cmd('loadSession', { sessionId: plain })) === fingerprint(work));
    const applied = await row(plain);
    t.ok('走ったら会話に確定し、予約は消える', applied.claudeAccount === work && applied.nextSettings === null);
    await c.runTurn({ sessionId: plain, prompt: 'whoami' });
    t.ok('以後のターンも同じアカウント', lastText(await c.cmd('loadSession', { sessionId: plain })) === fingerprint(work));

    // 分岐した子は親のアカウントを継ぐ
    const forked = await c.cmd('fork', { sessionId: plain });
    t.ok('分岐した会話は親のアカウントを継ぐ', (await row(forked.sessionId)).claudeAccount === work);
    await c.runTurn({ sessionId: forked.sessionId, prompt: 'whoami' });
    t.ok('分岐した会話も同じアカウントで走る', lastText(await c.cmd('loadSession', { sessionId: forked.sessionId })) === fingerprint(work));

    // 引き継いで作る新しい会話も
    const { sessionId: sibling } = await c.cmd('newSession', { sourceSessionId: plain, cwd: ROOT });
    t.ok('引き継いで作る新しい会話も同じアカウント', (await row(sibling)).claudeAccount === work);
    // 引き継ぎ元の無い新しい会話は、前回選んだアカウントで始まる
    const { sessionId: fresh } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    t.ok('新しい会話は前回選んだアカウントで始まる', (await row(fresh)).claudeAccount === work);

    // アカウントを書かない固定の委譲は、段ごとの候補に入っているアカウントだけを使う（ADR 0264）。どの段にも無ければ断る
    const from = c.mark();
    await c.runTurn({ sessionId: plain, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'whoami' }) });
    const refusedDelegate = await c.waitFor(e => e.type === 'tool.result' && e.sessionId === plain, { from, ms: 60000 });
    t.ok('段にそのエージェントのアカウントが 1 つも無ければ、固定の委譲を断り、自動の選択を勧める',
      refusedDelegate.isError && refusedDelegate.text.includes('段') && refusedDelegate.text.includes('自動'), refusedDelegate.text);
    await c.cmd('setDelegationRouting', { settings: { tiers: { t1: [`fake@${work}:fake-model`] } } });

    // 委譲した子の会話も親のアカウントを継ぐ（継ぐアカウントが段にある）
    await c.runTurn({ sessionId: plain, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'whoami' }) });
    let task;
    for (let i = 0; i < 600 && !(task = (await c.cmd('agentTasks')).find(r => r.parentSessionId === plain && r.notification === 'sent')); i++) await sleep(50);
    t.ok('委譲した子の会話は親のアカウントで走る', task?.result === fingerprint(work), task ? `${task.status} ${task.result}` : 'no task');
    t.ok('委譲した子の会話にもアカウントが残る', task && (await row(task.sessionId)).claudeAccount === work);

    // ログイン中のアカウントへ戻す
    await c.cmd('setTurnSettings', { sessionId: sibling, account: '' });
    t.ok('ログイン中のアカウントへ戻す予約', (await row(sibling)).nextSettings?.account === '');
    await c.runTurn({ sessionId: sibling, prompt: 'whoami' });
    t.ok('戻したらアカウントを渡さない', lastText(await c.cmd('loadSession', { sessionId: sibling })) === 'account:none' && (await row(sibling)).claudeAccount === '');
    const { sessionId: freshLogin } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    t.ok('ログイン中へ戻した後の新しい会話はログイン中のアカウント', ((await row(freshLogin)).claudeAccount ?? '') === '');
    await c.cmd('setTurnSettings', { sessionId: freshLogin, account: work });

    // 名前の変更は選択に影響しない
    await c.cmd('saveClaudeAccount', { id: work, name: '仕事' });
    t.ok('名前を変えても一覧に残る', (await c.cmd('claudeAccounts')).accounts[0].name === '仕事');

    // 削除したら黙って別のアカウントで走らせない
    await c.cmd('deleteClaudeAccount', { id: work });
    let refused = null;
    await c.runTurn({ sessionId: forked.sessionId, prompt: 'whoami' }).catch(e => { refused = e; });
    t.ok('削除したアカウントを選んでいる会話は送信を止める', refused?.message.includes('削除されています'), refused?.message);
    const { sessionId: afterDelete } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    t.ok('前回のアカウントを消したら、新しい会話はログイン中のアカウント', ((await row(afterDelete)).claudeAccount ?? '') === '');
    t.ok('止めた会話は何も走らせていない', lastText(await c.cmd('loadSession', { sessionId: forked.sessionId })) === fingerprint(work));
    await c.cmd('suggestTitle', { sessionId: forked.sessionId }).then(
      () => t.ok('タイトル生成も別のアカウントへ落とさない', false),
      e => t.ok('タイトル生成も別のアカウントへ落とさない', e.message.includes('削除されています')));
    // 消したアカウントの会話は一覧に残り、画面が呼ぶものは落ちない。別のアカウント（ログイン中）を選び直せば、また走る
    const stranded = await row(forked.sessionId);
    t.ok('消したアカウントの会話も一覧に残る', stranded?.claudeAccount === work);
    t.ok('消したアカウントの会話でも、アカウントの選択肢は引ける', (await c.cmd('claudeAccounts')).accounts.every(a => a.id !== work));
    const reselected = await c.cmd('setTurnSettings', { sessionId: forked.sessionId, account: '' });
    t.ok('消したアカウントの会話でも、別のアカウントを選び直せる', reselected?.account === '');
    await c.runTurn({ sessionId: forked.sessionId, prompt: 'whoami' });
    t.ok('選び直した次のターンはそのアカウントで走る', lastText(await c.cmd('loadSession', { sessionId: forked.sessionId })) === 'account:none' && (await row(forked.sessionId)).claudeAccount === '');

    t.ok('サーバーのログに組織・メールアドレスを出さない', !server.tail(200).includes('@example.com'));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
