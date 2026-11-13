// サーバー通し: Claude のアカウントごとのモデル一覧・検証・委譲・bot・設定 › 委譲・アカウント追加/入替/削除（fake CLI）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';
import { startFakeAnthropicApi } from '../lib/fake-anthropic-api.mjs';

export const name = 'server-claude-account-models';
export const title = 'サーバー通し: Claude アカウントごとのモデル一覧・設定・委譲・bot・トークン入替';

const TOK_VERIFIED = 'sk-ant-oat01-' + 'V'.repeat(40);
const TOK_PLAIN = 'sk-ant-oat01-' + 'N'.repeat(40);

const STANDARD_14 = [
  { value: 'default', displayName: 'Default', description: 'Use default model' },
  { value: 'opus', displayName: 'Opus', description: 'Opus 4.6' },
  { value: 'fable', displayName: 'Fable', description: 'Fable 5' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 4.6' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5' },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: '' },
  { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: '' },
  { value: 'claude-opus-5', displayName: 'Opus 5', description: '' },
  { value: 'claude-fable-5', displayName: 'Fable 5', description: '' },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' },
  { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: '' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: '' },
];
const MYTHOS_16 = [
  ...STANDARD_14,
  { value: 'claude-mythos-5-2', resolvedModel: 'claude-mythos-5-2', displayName: 'Mythos 5.2', description: '' },
  { value: 'claude-mythos-5-1', resolvedModel: 'claude-mythos-5-1', displayName: 'Mythos 5.1', description: '' },
];

const prompt = (toolName, args) => 'ply:' + JSON.stringify({ name: toolName, arguments: args });

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-srv-claude-acct-models-')));
  const cliDir = path.join(scratch, 'cli');
  const claudeConfig = path.join(scratch, 'claude-config');
  const modelsFile = path.join(scratch, 'fake-claude-models.json');
  const probeLog = path.join(scratch, 'fake-claude-probes.log');
  await fs.mkdir(claudeConfig, { recursive: true });
  await fs.writeFile(path.join(scratch, 'prefs.json'), JSON.stringify({ composerSuggestions: false }));
  await fs.writeFile(modelsFile, JSON.stringify({
    login: STANDARD_14,
    default: STANDARD_14,
    tokens: {
      [TOK_VERIFIED]: MYTHOS_16,
      [TOK_PLAIN]: STANDARD_14,
    },
    labels: {
      [TOK_VERIFIED]: 'verified',
      [TOK_PLAIN]: 'plain',
    },
  }));

  const cli = await installFakeClaude(cliDir);
  const api = await startFakeAnthropicApi({ [TOK_VERIFIED]: 'org-verified', [TOK_PLAIN]: 'org-plain' });
  const server = await startServer({
    dataDir: scratch,
    env: {
      AGENT_HOST_BACKENDS: 'claude,fake',
      ...cli.env,
      CLAUDE_CONFIG_DIR: claudeConfig,
      AGENT_HOST_ANTHROPIC_API: api.url,
      AGENT_HOST_ROUTING_USAGE: 'on',
      FAKE_CLAUDE_MODELS_FILE: modelsFile,
      FAKE_CLAUDE_PROBE_LOG: probeLog,
    },
  });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const callTool = async (sessionId, toolName, args) => {
    const from = c.mark();
    await c.runTurn({ sessionId, prompt: prompt(toolName, args) });
    const ev = await c.waitFor((e) => e.type === 'tool.result' && e.sessionId === sessionId, { from, ms: 60_000 });
    let data = null;
    try { data = JSON.parse(ev.text); } catch { /* error text */ }
    return { isError: Boolean(ev.isError), text: ev.text, data };
  };
  const taskOf = async (taskId) => {
    for (let i = 0; i < 200; i++) {
      const hit = (await c.cmd('agentTasks')).find((x) => x.taskId === taskId);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
  };
  const waitTurnFree = async (sessionId) => {
    for (let i = 0; i < 400 && (await c.cmd('running')).turns.some((x) => x.sessionId === sessionId); i++) await sleep(50);
  };
  const settleTask = async (taskId, parentSid) => {
    for (let i = 0; i < 1200; i++) {
      const r = (await c.cmd('agentTasks')).find((x) => x.taskId === taskId);
      if (r && !['queued', 'running', 'cancelling'].includes(r.status) && !['none', 'pending', 'delivering'].includes(r.notification)) break;
      await sleep(50);
    }
    await waitTurnFree(parentSid);
  };

  try {
    // 1. ログイン中は Mythos を持たない
    const mLogin0 = await c.cmd('models', { backend: 'claude', cwd: ROOT });
    assert.equal('claude-mythos-5-2' in mLogin0, false);

    // 2. 承認のあるアカウントと承認の無いアカウントを登録 → 承認のあるアカウントだけ Mythos 5.2 / 5.1 を持つ（説明も補われる）
    const savedVerified = await c.cmd('saveClaudeAccount', { name: 'verified', token: TOK_VERIFIED });
    const savedPlain = await c.cmd('saveClaudeAccount', { name: 'plain', token: TOK_PLAIN });
    const verifiedId = savedVerified.id;
    const plainId = savedPlain.id;

    // 起動・保存の先読みが回りきるか、models 呼び出しで両アカウントが引く
    let mVerified;
    for (let i = 0; i < 100; i++) {
      mVerified = await c.cmd('models', { backend: 'claude', cwd: ROOT, account: verifiedId });
      if ('claude-mythos-5-2' in mVerified) break;
      await sleep(100);
    }
    const mPlain = await c.cmd('models', { backend: 'claude', cwd: ROOT, account: plainId });
    const mLogin = await c.cmd('models', { backend: 'claude', cwd: ROOT });
    const mOpVerified = await c.cmd('invoke', { op: 'agents.models', args: { backend: 'claude', cwd: ROOT, account: verifiedId } });
    assert.equal('claude-mythos-5-2' in mVerified && mVerified['claude-mythos-5-2'].label === 'Mythos 5.2', true);
    assert.equal('mythos' in mVerified, false);
    assert.equal('claude-mythos-5-2' in mOpVerified && mOpVerified['claude-mythos-5-2'].label === 'Mythos 5.2', true);
    assert.equal('claude-mythos-5-2' in mPlain, false);
    assert.equal('claude-mythos-5-2' in mLogin, false);
    t.ok('models RPC / agents.models op: 承認のあるアカウントだけに Mythos 5.2 が出て、ほかのアカウントとログイン中のアカウントには出ない', true);

    // エフォートの段もアカウント付きで引ける
    const efVerified = await c.cmd('efforts', { backend: 'claude', cwd: ROOT, model: 'claude-mythos-5-2', account: verifiedId });
    assert.equal(Boolean(efVerified && typeof efVerified === 'object'), true);
    t.ok('efforts RPC: account 指定つきでエラーなく解決できる', true);

    // 3. 会話の setModel / setTurnSettings をアカウントごとに検査する
    const { sessionId: sPlain } = await c.cmd('newSession', { backend: 'claude', cwd: ROOT });
    await c.cmd('setTurnSettings', { sessionId: sPlain, account: plainId });
    await assert.rejects(c.cmd('setModel', { sessionId: sPlain, model: 'claude-mythos-5-2' }));
    await assert.rejects(c.cmd('setTurnSettings', { sessionId: sPlain, model: 'claude-mythos-5-2' }));

    const { sessionId: sVerified } = await c.cmd('newSession', { backend: 'claude', cwd: ROOT });
    await c.cmd('setTurnSettings', { sessionId: sVerified, account: verifiedId });
    await c.cmd('setModel', { sessionId: sVerified, model: 'claude-mythos-5-2' });
    const rowVerified = (await c.cmd('listSessions')).find((s) => s.id === sVerified);
    assert.equal(rowVerified?.nextSettings?.model ?? rowVerified?.model, 'claude-mythos-5-2');
    // 新しいアカウントとモデルを同時に渡す場合は、新しいアカウント（承認の無いほう）の一覧で弾く
    await assert.rejects(c.cmd('setTurnSettings', { sessionId: sVerified, account: plainId, model: 'claude-mythos-5-2' }));
    // 新アカウントに無いモデルを抱えたままアカウントだけ替えようとすると accounts: 'agent' と同じく拒否され、共通モデルへ戻せば切替できる
    await assert.rejects(c.cmd('setTurnSettings', { sessionId: sVerified, account: plainId }));
    await c.cmd('setModel', { sessionId: sVerified, model: 'sonnet' });
    await c.cmd('setTurnSettings', { sessionId: sVerified, account: plainId });
    const rowAfterSwitch = (await c.cmd('listSessions')).find((s) => s.id === sVerified);
    assert.equal(rowAfterSwitch.nextSettings?.account ?? rowAfterSwitch.claudeAccount, plainId);
    t.ok('setModel / setTurnSettings: 指定アカウントのモデル一覧で検出し、accounts: agent と同じ切替仕様を保つ', true);

    // 4. ply_delegate / ply_task_send の検証
    const firstTurn = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', {
      kind: 'mechanical', backend: 'claude', account: plainId, model: 'claude-mythos-5-2', task: 'hello-plain',
    }) });
    const parentSid = firstTurn.sessionId;
    const plainEv = firstTurn.events.find((e) => e.type === 'tool.result');
    assert.equal(Boolean(plainEv?.isError) && String(plainEv?.text).includes('model_unknown'), true, plainEv?.text);
    await waitTurnFree(parentSid);

    const loginDel = await callTool(parentSid, 'ply_delegate', {
      kind: 'mechanical', backend: 'claude', model: 'claude-mythos-5-2', task: 'hello-login',
    });
    assert.equal(loginDel.isError && loginDel.text.includes('model_unknown'), true, loginDel.text);
    await waitTurnFree(parentSid);

    const verifiedDel = await callTool(parentSid, 'ply_delegate', {
      kind: 'mechanical', backend: 'claude', account: verifiedId, model: 'claude-mythos-5-2', task: 'say-ok',
    });
    assert.equal(!verifiedDel.isError && Boolean(verifiedDel.data?.taskId), true, verifiedDel.text);
    const verifiedTask = await taskOf(verifiedDel.data.taskId);
    assert.equal(verifiedTask?.model, 'claude-mythos-5-2');
    assert.equal(verifiedTask?.routing?.target?.account, verifiedId);
    await settleTask(verifiedDel.data.taskId, parentSid);
    const verifiedChild = (await c.cmd('listSessions')).find((s) => s.id === verifiedTask?.sessionId);
    assert.equal(verifiedChild?.claudeAccount, verifiedId);
    t.ok('ply_delegate: 承認のあるアカウントでは claude-mythos-5-2 を通し、ほかのアカウントとログイン中のアカウントでは model_unknown で断る', true);

    // 4b. ply_task_send のアカウント切り替え時のモデル検証
    const badSwitch = await callTool(parentSid, 'ply_task_send', {
      taskId: verifiedDel.data.taskId, account: plainId, model: 'claude-mythos-5-2',
    });
    assert.equal(badSwitch.isError && badSwitch.text.includes('model_unknown'), true, badSwitch.text);
    await waitTurnFree(parentSid);
    const okSwitch = await callTool(parentSid, 'ply_task_send', {
      taskId: verifiedDel.data.taskId, account: plainId, model: 'sonnet',
    });
    assert.equal(!okSwitch.isError, true, okSwitch.text);
    await waitTurnFree(parentSid);
    t.ok('ply_task_send: 切り替え先のアカウントに無い Mythos は断り、そのアカウントにある Sonnet への変更は通す', true);

    // 5. bot（bots.create / bots.setAccount / bots.update）のサーバー経路
    const b = await c.cmd('invoke', { op: 'bots.create', args: { name: 'MythosBot', backend: 'claude' } });
    await c.cmd('invoke', { op: 'bots.setAccount', args: { botId: b.id, account: plainId } });
    let plainBotRejected = false;
    try { await c.cmd('invoke', { op: 'bots.update', args: { botId: b.id, model: 'claude-mythos-5-2' } }); }
    catch (e) { plainBotRejected = e?.code === 'INVALID' || /model: unknown|INVALID|利用できない|unavailable|選べません/.test(e.message); }
    assert.equal(plainBotRejected, true);
    await c.cmd('invoke', { op: 'bots.setAccount', args: { botId: b.id, account: verifiedId } });
    const updatedBot = await c.cmd('invoke', { op: 'bots.update', args: { botId: b.id, model: 'claude-mythos-5-2' } });
    assert.equal(updatedBot.model, 'claude-mythos-5-2');
    await c.cmd('invoke', { op: 'bots.setAccount', args: { botId: b.id, account: plainId } });
    const botAfterPlain = await c.cmd('invoke', { op: 'bots.get', args: { botId: b.id } });
    assert.equal(botAfterPlain.account, plainId);
    assert.equal(botAfterPlain.model, 'claude-mythos-5-2');
    t.ok('bots.*: bot のアカウントに応じたモデル一覧で update を検証し、アカウント変更時は bot.model を保つ', true);

    // 6. 設定 › 委譲（delegationRouting）の一覧警告と、トークン入れ替え時の自動無効化 + 再読み込み
    await c.cmd('setDelegationRouting', { settings: { tiers: { t4: [`claude@${verifiedId}:claude-mythos-5-2`, `claude@${plainId}:claude-mythos-5-2`] } } });
    let routing;
    for (let i = 0; i < 80; i++) {
      await c.cmd('delegationRouting', { refresh: true });
      routing = await c.cmd('delegationRouting');
      if (routing.warnings.some((w) => w.candidate === `claude@${plainId}:claude-mythos-5-2` && w.reason === 'model_unknown')) break;
      await sleep(100);
    }
    assert.equal(routing.warnings.some((w) => w.candidate === `claude@${verifiedId}:claude-mythos-5-2`), false, JSON.stringify(routing.warnings));
    assert.equal(routing.warnings.some((w) => w.candidate === `claude@${plainId}:claude-mythos-5-2` && w.reason === 'model_unknown'), true, JSON.stringify(routing.warnings));
    t.ok('delegationRouting: アカウントごとの accountModels で、承認の無いアカウントだけに model_unknown 警告を出し、承認のあるアカウントには出さない', true);

    // トークンを承認のあるアカウントのものに入れ替えるとキャッシュが無効化され、そのアカウントも Mythos 5.2 を返して警告が消える
    await c.cmd('saveClaudeAccount', { id: plainId, name: 'plain-upgraded', token: TOK_VERIFIED });
    let mPlainUpgraded;
    for (let i = 0; i < 100; i++) {
      mPlainUpgraded = await c.cmd('models', { backend: 'claude', cwd: ROOT, account: plainId });
      if ('claude-mythos-5-2' in mPlainUpgraded) break;
      await sleep(100);
    }
    assert.equal('claude-mythos-5-2' in mPlainUpgraded, true);
    let routingAfterSwap;
    for (let i = 0; i < 80; i++) {
      await c.cmd('delegationRouting', { refresh: true });
      routingAfterSwap = await c.cmd('delegationRouting');
      if (!routingAfterSwap.warnings.some((w) => w.candidate === `claude@${plainId}:claude-mythos-5-2`)) break;
      await sleep(100);
    }
    assert.equal(routingAfterSwap.warnings.some((w) => w.candidate === `claude@${plainId}:claude-mythos-5-2`), false, JSON.stringify(routingAfterSwap.warnings));
    t.ok('saveClaudeAccount でトークンを入れ替えるとキャッシュを引き直し、委譲の警告も消える', true);

    // 7. 削除・ログとファイルの秘匿確認
    await c.cmd('deleteClaudeAccount', { id: verifiedId });
    assert.equal((await c.cmd('claudeAccounts')).accounts.some((a) => a.id === verifiedId), false);
    const probeTrace = fss.existsSync(probeLog) ? await fs.readFile(probeLog, 'utf8') : '';
    assert.equal(probeTrace.includes('verified') && probeTrace.includes('plain'), true, probeTrace);
    const tail = server.tail(400);
    assert.equal(!tail.includes(TOK_VERIFIED) && !tail.includes(TOK_PLAIN), true);
    t.ok('各アカウント別に CLI が起動され、サーバーログにトークンを一切出力しない', true);
  } finally {
    c.close();
    await server.stop();
    await api.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
