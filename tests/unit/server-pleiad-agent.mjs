import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createPlusModelConnection } from '../../core/plus/model-connection.mjs';
import { startPleiadAgentFixture } from '../lib/pleiad-agent-fixture.mjs';
import { installFakePlusModels, startFakePlus } from '../lib/fake-plus.mjs';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { connectHolder } from '../../core/holder/client.mjs';
import { defaultHolderRoot } from '../../core/process.mjs';
import { hash } from '../../core/context-runtime.mjs';
import { ROOT, startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-pleiad-agent';
export const title = 'Pleiad Agent の道具・添付と送信待ち';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agent-'));
  const cwd = path.join(scratch, '日本語 の作業場所');
  const desktopDir = path.join(scratch, 'desktop');
  const clockFile = path.join(scratch, 'routine-clock');
  const minute = 60_000;
  const routineStart = Math.floor(Date.now() / minute) * minute + 30_000;
  const setClock = now => fs.writeFile(clockFile, String(now));
  const packagedRoot = process.env.PLEIAD_TEST_PACKAGED_APP;
  const serverEntry = packagedRoot ? { entry: path.join(packagedRoot, 'core', 'server.mjs') } : {};
  let releaseSuggestion;
  const staleSuggestion = new Promise(resolve => { releaseSuggestion = resolve; });
  let releaseChild;
  const childResponse = new Promise(resolve => { releaseChild = resolve; });
  const fixture = await startPleiadAgentFixture({ token: 'fixture-key-only',
    usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.01 },
    reply: async body => {
      const prompt = body.messages.at(-1)?.content;
      if (body.messages.length === 1 && !body.tools?.length && typeof prompt === 'string') {
        if (prompt.startsWith('This is an app-generated request')) {
          if (!prompt.includes('new suggestion target')) {
            await staleSuggestion;
            return JSON.stringify({ suggestion: 'Obsolete suggestion' });
          }
          return JSON.stringify({ suggestion: 'Current suggestion' });
        }
        return 'Proposed title';
      }
      if (prompt === 'delegate to fixture') return { tool: { name: 'mcp__ply_agents__ply_delegate',
        args: { kind: 'mechanical', backend: 'fake', task: 'echo:native parent child' } } };
      if (prompt === 'host shell fixture') return { tool: { name: 'mcp__ply_shell__run',
        args: { command: 'echo PLEIAD_SHELL_FIXTURE' } } };
      if (prompt === 'computer screenshot fixture') return { tool: { name: 'mcp__ply_computer__screenshot',
        args: { title: '画面を確かめる' } } };
      if (prompt === 'browser handoff fixture') return { tool: { name: 'mcp__ply_browser__hand_to_user',
        args: { reason: 'login', message: 'ログインしてください' } } };
      if (typeof prompt === 'string' && prompt.includes('child approval fixture')) return {
        tool: { name: 'write_file', args: { filePath: 'delegated.txt', content: 'approved child result' } },
      };
      if (typeof prompt === 'string' && prompt.includes('child of fixture')) {
        await childResponse;
        return 'Pleiad Agent child response';
      }
      return prompt === '[fixture:visualize]' ? [
      'visualize' + JSON.stringify({ path: path.join(cwd, 'chart.html'), title: 'Figure' }),
      'visualize' + JSON.stringify({ path: path.join(cwd, 'invalid.html'), title: 'Invalid figure' }),
      ].join('\n') : undefined;
    } }, { packagedRoot });
  const plus = await startFakePlus();
  const runtime = { tenantId: '11111111-1111-4111-8111-111111111111',
    cloudHostId: '22222222-2222-4222-8222-222222222222', generation: 2, token: 'r'.repeat(43) };
  const desktopToken = plus.issueIdToken('fixture-user');
  const completions = installFakePlusModels(plus, { upstream: fixture.model.baseUrl + '/chat/completions',
    upstreamKey: 'fixture-key-only', runtime, desktopToken });
  const byok = await startFakeCompatApi({ keys: ['desktop-fixture-key'], models: [{ id: 'desktop-fixture', vision: true }] });
  const options = { ...serverEntry, dataDir: path.join(scratch, 'data'), env: {
    ...fixture.env, AGENT_HOST_KIND: 'cloud', AGENT_HOST_BACKENDS: 'fake,claude',
    AGENT_HOST_PLUS_API: plus.url, AGENT_HOST_PLEIAD_AGENT_BASE_URL: 'http://127.0.0.1:1/v1',
    PLEIAD_CLOUD_RUNTIME_TOKEN: runtime.token, PLEIAD_CLOUD_TENANT_ID: runtime.tenantId,
    PLEIAD_CLOUD_HOST_ID: runtime.cloudHostId, PLEIAD_CLOUD_GENERATION: String(runtime.generation),
  } };
  const desktopOptions = { ...serverEntry, dataDir: desktopDir, env: {
    ...fixture.env, AGENT_HOST_BACKENDS: 'pleiad-agent,fake', AGENT_HOST_PLUS_API: plus.url,
    AGENT_HOST_WORKTREES: 'on', AGENT_HOST_COMPUTER_DRIVER: 'fake',
    TEST_ROUTINES_CLOCK: clockFile,
    NODE_OPTIONS: `--loader="${pathToFileURL(path.join(ROOT, 'tests/lib/routines-clock-loader.mjs')).href}"`,
  } };
  let server, client, chrome;
  async function waitForCard(sessionId, kind, from) {
    try {
      return await client.waitFor(e => e.type === 'permission' && e.sessionId === sessionId && e.kind === kind, { from, ms: 20_000 });
    } catch (error) {
      throw new Error(`${error.message}\n${server.tail()}`, { cause: error });
    }
  }
  async function restart() {
    client.close();
    await server.kill();
    server = await startServer(options);
    client = await open(server);
  }
  try {
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, '添付 ファイル.txt'), '道具の結果');
    server = await startServer(options);
    client = await open(server);
    const backends = await client.cmd('backends');
    t.ok('管理下ホストは実際の Pleiad Agent だけを公開する', backends.map(backend => backend.id).join() === 'pleiad-agent');
    t.ok('管理下のホストは利用者の接続先を出さない', backends[0].capabilities.compatEndpoints === false);
    t.ok('Pleiad のシェルだけを公開し、存在しないネイティブ設定の切り替えは出さない',
      backends[0].capabilities.plyShell === true && backends[0].capabilities.nativeShellOff === false &&
      backends[0].capabilities.nativeMcpOff === false);
    const catalog = await client.cmd('models', { backend: 'pleiad-agent' });
    t.ok('Plus のモデル一覧と推論の強さを返す', catalog.fixture?.label === 'Fixture model' &&
      catalog.fixture.efforts.join() === 'high', JSON.stringify(catalog));
    const blocked = await client.cmd('compatEndpointCheck', { input: { agent: 'pleiad-agent', preset: 'openai',
      baseUrl: byok.url + '/v1', key: 'desktop-fixture-key', authMode: 'bearer' } });
    t.ok('管理下のホストは持ち込みのキーで接続を確認しない', blocked.ok === false && byok.requests.length === 0);
    const { sessionId } = await client.cmd('newSession', { backend: 'pleiad-agent', cwd });
    const name = '送信する ファイル.txt';
    const file = await client.cmd('attachFile', { sessionId, name, mime: 'text/plain', data: Buffer.from('添付の内容').toString('base64') });
    const mark = client.mark();
    await client.cmd('setTurnSettings', { sessionId, model: 'fixture', effort: 'high' });
    fixture.model.hold();
    await client.cmd('sendMessage', { sessionId, messageId: 'ply-agent-read-001', prompt: '[fixture:read]' });
    await client.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === 'ply-agent-read-001', { from: mark });
    const queued = { sessionId, messageId: 'ply-agent-attach-001', prompt: '添付を見る\n[添付] ' + file.path,
      attachments: [{ path: file.path, name, mime: 'text/plain' }] };
    await client.cmd('sendMessage', queued);
    await client.cmd('sendMessage', queued);
    const waiting = await client.cmd('listMessages', { sessionId });
    t.ok('同じ送信 ID の添付は、実行中のターンの後ろに一つだけ並ぶ',
      waiting.filter(row => row.id === queued.messageId && row.status === 'queued').length === 1, JSON.stringify(waiting.map(({ id, status }) => ({ id, status }))));
    fixture.model.release();
    const delivered = await client.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === queued.messageId, { from: mark });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: client.events.indexOf(delivered) + 1 });
    const events = client.since(mark);
    t.ok('短命の券をモデルのリクエストごとに取り、推論の強さを Plus に渡す',
      completions.length === 3 && new Set(completions.map(row => row.ticket)).size === 3 &&
      new Set(completions.map(row => row.id)).size === 3 && completions[0].body.reasoning?.effort === 'high',
      JSON.stringify(completions.map(row => row.body.reasoning)));
    t.ok('使用量と費用を道具呼び出しを含むターン全体で合計する',
      events.some(e => e.type === 'usage' && e.inputTokens === 20 && e.outputTokens === 6 && e.costUsd === 0.02));
    const { local } = await client.cmd('providerUsage', { backend: 'pleiad-agent' });
    t.ok('設定の使用量にトークン数と米ドルでの費用が現れる', local.fiveHour.turns === 2 &&
      local.fiveHour.inputTokens.value === 30 && local.fiveHour.outputTokens.value === 9 && local.fiveHour.costUsd.value === 0.03);
    const tool = events.find(e => e.type === 'tool.start' && e.name === 'read_file');
    t.ok('ファイル読み取りと結果が同じ道具の ID で表示される',
      Boolean(tool && events.some(e => e.type === 'tool.result' && e.id === tool.id && e.text.includes('道具の結果'))));
    t.ok('添付の本文とパスが会話に表示され、モデルにはパスが一度だけ届く',
      events.some(e => e.type === 'present' && e.path === file.path && e.content === '添付の内容') &&
      fixture.model.calls.filter(body => JSON.stringify(body.messages.at(-1)).includes('添付を見る')).length === 1);
    const history = await client.cmd('loadSession', { sessionId });
    const attached = history.presents.find(item => item.path === file.path);
    t.ok('再読み込みした会話に添付と読み取り結果が残る',
      Boolean(attached?.content === '添付の内容' &&
        history.messages.some(message => message.uuid === attached.messageId && message.role === 'user') &&
        history.messages.some(message => message.toolCalls?.some(call => call.id === tool?.id && call.result?.content === '道具の結果'))));
    t.ok('モデルの認証キーをリクエスト本文や会話に出さない',
      !JSON.stringify([fixture.model.calls, history, events]).includes('fixture-key-only'));

    const { sessionId: steerSession } = await client.cmd('newSession', { backend: 'pleiad-agent', cwd });
    const steerMark = client.mark();
    fixture.model.hold();
    try {
      await client.cmd('sendMessage', { sessionId: steerSession, messageId: 'ply-agent-before-steer', prompt: '[fixture:read]' });
      await client.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === 'ply-agent-before-steer', { from: steerMark });
      const steer = { sessionId: steerSession, messageId: 'ply-agent-steer', prompt: '途中で伝えた指示' };
      await client.cmd('sendMessage', steer);
      await client.cmd('sendMessage', steer);
      await client.waitFor(e => e.type === 'userMessage' && e.messageId === steer.messageId && e.pending, { from: steerMark });
    } finally {
      fixture.model.release();
    }
    await client.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === 'ply-agent-steer', { from: steerMark });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === steerSession, { from: steerMark });
    const steered = await client.cmd('loadSession', { sessionId: steerSession });
    t.ok('実行中に重ねて送った同じ指示は、同じターンのモデルと履歴に一度だけ届く',
      fixture.model.calls.at(-1).messages.filter(m => m.role === 'user' && m.content === '途中で伝えた指示').length === 1 &&
      steered.messages.filter(m => m.role === 'user' && m.text === '途中で伝えた指示').length === 1);

    const filePath = path.join(cwd, '結果 ファイル.txt');
    const exists = () => fs.stat(filePath).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    const writeArgs = { sessionId, messageId: 'ply-agent-write-001', prompt: '[fixture:write]', mode: 'default' };
    const { sessionId: planSession } = await client.cmd('newSession', { backend: 'pleiad-agent', cwd });
    const planMark = client.mark();
    await client.cmd('sendMessage', { ...writeArgs, sessionId: planSession, messageId: 'ply-agent-enter-plan' });
    const beforePlan = await waitForCard(planSession, 'tool', planMark);
    await client.cmd('setTurnSettings', { sessionId: planSession, mode: 'plan' });
    const appliedPlan = await client.cmd('applyTurnSettingsNow', { sessionId: planSession });
    await client.waitFor(e => e.type === 'permissionSettled' && e.id === beforePlan.id, { from: planMark });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === planSession, { from: planMark });
    const planned = await client.runTurn({ sessionId: planSession, prompt: '[fixture:write]', mode: 'plan' });
    t.ok('作業中にプランモードへ変えると書き込みの承認を閉じ、その後の書き込みも実行しない',
      appliedPlan.applied === 'live' && planned.outcome === 'ok' && !await exists());

    const writeMark = client.mark();
    await client.cmd('sendMessage', writeArgs);
    const approval = await waitForCard(sessionId, 'tool', writeMark);
    t.ok('道具を実行する前に書き込みの承認カードを表示する', approval.editableField === 'content' && !await exists());
    await restart();
    const restoredApproval = await waitForCard(sessionId, 'tool', 0);
    t.ok('再起動後も承認カードの ID と変更内容が一致する', restoredApproval.id === approval.id &&
      restoredApproval.input.content === 'proposed text' && !await exists());
    const approveMark = client.mark();
    await client.cmd('resolvePermission', { id: restoredApproval.id, allow: true, editedInput: '画面で編集した本文' });
    const resumedWrite = await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: approveMark });
    t.ok('承認された編集内容を書き込む', await exists() && await fs.readFile(filePath, 'utf8') === '画面で編集した本文',
      JSON.stringify(resumedWrite));
    t.ok('書き込みの再開で利用者の発言は増えない',
      (await client.cmd('loadSession', { sessionId })).messages.filter(m => m.role === 'user' && m.text.includes('[fixture:write]')).length === 1);
    const { sessionId: alwaysSession } = await client.cmd('newSession', { backend: 'pleiad-agent', cwd });
    const grantMark = client.mark();
    await client.cmd('sendMessage', { ...writeArgs, sessionId: alwaysSession, messageId: 'ply-agent-always-allow' });
    const grant = await waitForCard(alwaysSession, 'tool', grantMark);
    await client.cmd('resolvePermission', { id: grant.id, allow: true, always: true });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === alwaysSession, { from: grantMark });
    t.ok('常に許可を選んだターンで、既存のファイルを上書きできる',
      await fs.readFile(filePath, 'utf8') === 'proposed text');
    await fs.writeFile(filePath, 'before restarting');
    await restart();
    const alwaysMark = client.mark();
    const always = await client.runTurn({ sessionId: alwaysSession, prompt: '[fixture:write]', mode: 'default' }, { ms: 15_000 });
    t.ok('常に許可した道具を同じ会話で使うと、再起動後も承認を聞かない',
      always.outcome === 'ok' && !client.since(alwaysMark).some(event => event.type === 'permission' && event.sessionId === alwaysSession) &&
      await fs.readFile(filePath, 'utf8') === 'proposed text');

    const surveyMark = client.mark();
    await client.cmd('sendMessage', { sessionId, messageId: 'ply-agent-survey-001', prompt: '[fixture:survey]' });
    const survey = await waitForCard(sessionId, 'question', surveyMark);
    await restart();
    const restoredSurvey = await waitForCard(sessionId, 'question', 0);
    t.ok('再起動後に同じ質問と選択肢が現れる', restoredSurvey.id === survey.id &&
      restoredSurvey.questions[0].options.map(item => item.label).join() === 'Blue,Red');
    const answerMark = client.mark();
    await client.cmd('resolvePermission', { id: restoredSurvey.id, allow: true, answers: { 'Color?': 'Blue' } });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: answerMark });
    t.ok('質問の回答が元の質問 ID でモデルに届く', fixture.model.calls.at(-1).messages.some(message =>
      message.role === 'tool' && message.content.includes('Blue') && message.content.includes('color')));

    const stopMark = client.mark();
    await client.cmd('sendMessage', { sessionId, messageId: 'ply-agent-stop-001', prompt: '[fixture:survey]' });
    const waitingQuestion = await waitForCard(sessionId, 'question', stopMark);
    await client.cmd('abort', { sessionId });
    const settled = await client.waitFor(e => e.type === 'permissionSettled' && e.id === waitingQuestion.id, { from: stopMark });
    t.ok('中断すると未回答の質問カードを閉じる', settled.allow === false);
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: stopMark });

    const mcpMark = client.mark();
    await client.cmd('sendMessage', { sessionId, messageId: 'ply-agent-mcp-001', prompt: '[fixture:mcp:mcp__ply_agents__ply_task_list]' });
    const mcpCard = await waitForCard(sessionId, 'tool', mcpMark);
    t.ok('会話に結び付けた Pleiad の道具にも承認が効く', mcpCard.toolName === 'mcp__ply_agents__ply_task_list');
    await client.cmd('resolvePermission', { id: mcpCard.id, allow: true });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: mcpMark });
    t.ok('承認後にホストの道具が実行される', fixture.model.calls.at(-1).messages.some(message =>
      message.role === 'tool' && message.content.includes('ply_task_list ok')));

    const beforeFork = await client.cmd('loadSession', { sessionId });
    const target = beforeFork.messages.filter(message => message.role === 'user')[1];
    const branch = await client.cmd('fork', { sessionId, beforeMessageId: target.uuid });
    const child = await client.cmd('loadSession', { sessionId: branch.sessionId });
    const branchRow = (await client.cmd('lineage', { sessionId: branch.sessionId })).sessions.find(row => row.id === branch.sessionId);
    const prefix = beforeFork.messages.slice(0, beforeFork.messages.findIndex(message => message.uuid === target.uuid));
    t.ok('発言の編集から分岐すると、その手前の発言 ID と分岐元が残る',
      branchRow?.parent?.beforeMessage === target.uuid && child.messages.map(m => m.uuid).join() === prefix.map(m => m.uuid).join());
    t.ok('分岐元には元の履歴と添付が残る',
      (await client.cmd('loadSession', { sessionId })).messages.map(m => m.uuid).join() === beforeFork.messages.map(m => m.uuid).join() &&
      beforeFork.presents.some(p => p.path === file.path) && !child.presents.some(p => p.path === file.path));

    const branchTurn = await client.runTurn({ sessionId: branch.sessionId, prompt: 'continue branch' }, { ms: 15_000 });
    t.ok('分岐から送ると手前の道具の結果がモデルに届く', branchTurn.outcome === 'ok' &&
      fixture.model.calls.at(-1).messages.some(m => m.role === 'tool' && m.content.includes('道具の結果')));

    const rewindMark = client.mark();
    await client.cmd('sendMessage', { sessionId, messageId: 'ply-agent-rewind-001', prompt: 'replacement',
      rewind: { beforeMessageId: target.uuid } });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: rewindMark, ms: 15_000 });
    const rewound = await client.cmd('loadSession', { sessionId });
    t.ok('同じ会話の巻き戻しでは発言の手前を残し、その後の添付を外す',
      rewound.messages.slice(0, prefix.length).map(m => m.uuid).join() === prefix.map(m => m.uuid).join() &&
      rewound.messages.some(m => m.role === 'user' && m.text === 'replacement') &&
      !rewound.messages.some(m => m.uuid === target.uuid) && !rewound.presents.some(p => p.path === file.path));

    const compactMark = client.mark();
    await client.cmd('compactConversation', { sessionId });
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: compactMark, ms: 15_000 });
    t.ok('既存の圧縮操作で開始・完了と文脈の大きさが届き、発言 ID を保つ',
      client.since(compactMark).some(e => e.type === 'compaction' && e.phase === 'complete') &&
      client.since(compactMark).some(e => e.type === 'contextWindow') &&
      (await client.cmd('loadSession', { sessionId })).messages.map(m => m.uuid).join() === rewound.messages.map(m => m.uuid).join());

    await fs.writeFile(path.join(cwd, 'chart.html'), '<p>Fixture chart</p>');
    await fs.writeFile(path.join(cwd, 'invalid.html'), Buffer.from([255]));
    const vizTurn = await client.runTurn({ sessionId, prompt: '[fixture:visualize]' }, { ms: 15_000 });
    const vizHistory = await client.cmd('loadSession', { sessionId });
    t.ok('会話には HTML の可視化と、UTF-8 でない可視化のエラーが残る', vizTurn.outcome === 'ok' &&
      vizHistory.presents.some(p => p.kind === 'visualization' && p.caption === 'Figure' && p.content === '<p>Fixture chart</p>') &&
      vizHistory.presents.some(p => p.kind === 'visualization' && p.caption === 'Invalid figure' && p.error));

    const invoke = (op, args) => client.cmd('invoke', { op, args: { sessionId, ...args } });
    const added = await invoke('todos.add', { items: [{ text: 'Inspect chart' }] });
    const artifact = path.join(cwd, 'chart.html');
    const updated = await invoke('todos.update', { ifRev: added.rev, items: [{ id: added.items[0].id, status: 'done',
      links: [{ path: artifact, title: 'Figure' }] }] });
    const conflict = await invoke('todos.update', { ifRev: added.rev, items: [{ id: added.items[0].id, status: 'doing' }] }).catch(error => error);
    const todos = await invoke('todos.list', {});
    t.ok('古い版の ToDo 編集と競合した場合に新しい状態を保つ', updated.rev > added.rev && conflict instanceof Error &&
      todos.items[0].status === 'done' && todos.items[0].links[0]?.path === artifact);

    const plusClient = createPlusClient({ config: { apiBase: plus.url }, getIdToken: async () => desktopToken });
    const desktopPlus = createPlusModelConnection({ apiBase: plus.url, client: plusClient });
    const auth = await desktopPlus.authorization('fixture', new AbortController().signal);
    t.ok('デスクトップの Plus 接続は個人ワークスペースの短命の券を取得する',
      auth.key !== desktopToken && auth.headers['x-pleiad-tenant'] === runtime.tenantId &&
      plus.state.calls.some(row => row.path === '/v1/model-tickets' && row.auth === 'Bearer ' + desktopToken));
    t.ok('短命の券とクラウドの認証情報は会話に含まれない',
      !JSON.stringify([events, history]).includes(runtime.token) &&
      completions.every(row => !JSON.stringify([events, history]).includes(row.ticket)));

    const resultsBefore = completions.length;
    client.close();
    await server.stop();
    await setClock(routineStart);
    server = await startServer(desktopOptions);
    let holdChildApproval = false;
    client = await open({ ...server, onEvent(event, api) {
      if (event.type === 'permission' && !(holdChildApproval && event.toolName === 'write_file')) {
        return api.cmd('resolvePermission', { id: event.id, allow: true }).catch(() => {});
      }
    } });
    const desktopSession = (await client.cmd('newSession', { backend: 'pleiad-agent', cwd })).sessionId;
    const releaseSession = (await client.cmd('newSession', { backend: 'pleiad-agent', cwd })).sessionId;
    await client.cmd('setTurnSettings', { sessionId: releaseSession, model: 'fixture', effort: 'high' });
    await client.runTurn({ sessionId: releaseSession, prompt: 'title and suggestions' });
    await client.cmd('setTitle', { sessionId: releaseSession, title: 'Title written by a person' });
    const beforeTitle = await client.cmd('loadSession', { sessionId: releaseSession });
    const suggestedTitle = await client.cmd('suggestTitle', { sessionId: releaseSession });
    const titleCall = fixture.model.calls.at(-1);
    const afterTitle = await client.cmd('loadSession', { sessionId: releaseSession });
    t.ok('題の提案は手動の題や履歴を変えず、選んだモデルで道具なしの要求を送る',
      suggestedTitle.title === 'Proposed title' &&
      (await client.cmd('listSessions')).find(row => row.id === releaseSession)?.title === 'Title written by a person' &&
      JSON.stringify(beforeTitle.messages) === JSON.stringify(afterTitle.messages) &&
      titleCall.model === 'fixture' && titleCall.messages.length === 1 && !titleCall.tools?.length);

    await client.cmd('setStatus', { sessionId: releaseSession, status: '確認済み', reasonKey: 'menu' });
    const listed = (await client.cmd('listSessions')).find(row => row.id === releaseSession);
    t.ok('会話メニューで変えた状態は Pleiad Agent の会話一覧に残る', listed?.status === '確認済み');

    const { sessionId: shellSession } = await client.cmd('newSession', { backend: 'pleiad-agent', cwd });
    const shellMark = client.mark();
    const shellTurn = await client.runTurn({ sessionId: shellSession, prompt: 'host shell fixture' });
    t.ok('Pleiad のシェルは承認を経て実行され、モデルに結果が戻る',
      shellTurn.outcome === 'ok' &&
      client.since(shellMark).some(e => e.type === 'permission' && e.toolName === 'ply_shell' && e.sessionId === shellSession) &&
      fixture.model.calls.at(-1).messages.some(m => m.role === 'tool' && m.content.includes('PLEIAD_SHELL_FIXTURE')));

    const suggestionMark = client.mark();
    await client.cmd('setPref', { key: 'composer.suggestions', value: true });
    await client.runTurn({ sessionId: releaseSession, prompt: 'old suggestion target' });
    const waitFor = async (predicate) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        const value = await predicate();
        if (value) return value;
        await sleep(50);
      }
      throw new Error('The expected fixture operation did not finish');
    };
    await waitFor(() => fixture.model.calls.some(body => body.messages.at(-1)?.content?.startsWith?.('This is an app-generated request')));
    try {
      await client.runTurn({ sessionId: releaseSession, prompt: 'new suggestion target' });
      const candidate = await client.waitFor(e => e.type === 'promptSuggestion' && e.sessionId === releaseSession &&
        e.text === 'Current suggestion', { from: suggestionMark });
      releaseSuggestion();
      t.ok('次の発言を送ると古い候補を破棄し、新しい候補だけを出す', candidate.text === 'Current suggestion' &&
        !client.since(suggestionMark).some(e => e.type === 'promptSuggestion' && e.text === 'Obsolete suggestion'));
    } finally {
      releaseSuggestion();
      await client.cmd('setPref', { key: 'composer.suggestions', value: false });
    }

    const delegatedByNative = await client.runTurn({ sessionId: releaseSession, prompt: 'delegate to fixture' });
    const repo = path.join(scratch, 'delegate repo');
    await fs.mkdir(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true });
    git('init', '--quiet');
    git('-c', 'user.name=Pleiad Test', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'Seed');
    const { sessionId: fakeParentId } = await client.cmd('newSession', { backend: 'fake', cwd: repo });
    const fakeParent = await client.runTurn({ sessionId: fakeParentId, prompt: 'ply:' + JSON.stringify({
      name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'pleiad-agent', task: 'child of fixture', isolate: true },
    }) });
    const delegatedTask = async (parent, backend, status) => waitFor(async () => (await client.cmd('agentTasks')).find(task =>
      task.parentSessionId === parent && task.backend === backend && task.status === status));
    const isolatedChild = await delegatedTask(fakeParent.sessionId, 'pleiad-agent', 'running');
    try {
      t.ok('明示して分離した Pleiad Agent の子には親と別の作業ツリーが割り当てられる',
        Boolean(isolatedChild.worktree?.path && path.resolve(isolatedChild.worktree.path) !== path.resolve(repo)) &&
        path.resolve(isolatedChild.cwd) === path.resolve(isolatedChild.worktree.path), JSON.stringify({
          cwd: isolatedChild.cwd, workspace: isolatedChild.workspace, worktree: isolatedChild.worktree,
        }));
    } finally {
      releaseChild();
    }
    const [fakeChild, nativeChild] = await Promise.all([
      delegatedTask(releaseSession, 'fake', 'completed'), delegatedTask(fakeParent.sessionId, 'pleiad-agent', 'completed'),
    ]);
    t.ok('Pleiad Agent は既存の委譲を通じて、別のエージェントの親にも子にもなれる',
      delegatedByNative.outcome === 'ok' && fakeChild.sessionId && nativeChild.sessionId);
    holdChildApproval = true;
    const childApprovalMark = client.mark();
    const { sessionId: approvalParentId } = await client.cmd('newSession', { backend: 'fake', cwd: repo });
    await client.runTurn({ sessionId: approvalParentId, mode: 'default', prompt: 'ply:' + JSON.stringify({
      name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'pleiad-agent', task: 'child approval fixture' },
    }) });
    const childCard = await client.waitFor(event => event.type === 'permission' && event.toolName === 'write_file', { from: childApprovalMark });
    const writingChild = await waitFor(async () => (await client.cmd('agentTasks')).find(task => task.sessionId === childCard.sessionId && task.status === 'running'));
    const writtenBeforeApproval = await fs.stat(path.join(repo, 'delegated.txt')).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    await client.cmd('resolvePermission', { id: childCard.id, allow: true });
    holdChildApproval = false;
    await waitFor(async () => (await client.cmd('agentTasks')).find(task => task.taskId === writingChild.taskId && task.status === 'completed'));
    t.ok('委譲の親にひも付く承認待ちの子は、承認後に作業を終える', !writtenBeforeApproval && writingChild.parentSessionId === approvalParentId &&
      await fs.readFile(path.join(repo, 'delegated.txt'), 'utf8') === 'approved child result');

    const screenshot = await client.runTurn({ backend: 'pleiad-agent', cwd, prompt: 'computer screenshot fixture' });
    const shot = screenshot.events.find(event => event.type === 'tool.result' && event.computer?.tool === 'screenshot');
    const loadedShot = (await client.cmd('loadSession', { sessionId: screenshot.sessionId })).messages.flatMap(message => message.toolCalls ?? [])
      .find(call => call.id === shot?.id);
    t.ok('Pleiad Agent の画面撮影は会話の途中と履歴に画像を出す', shot?.images?.length === 1 &&
      shot.images[0].url === loadedShot?.images?.[0]?.url && !shot.text.includes('[ply_computer]'));
    const nativeInstruction = 'Fixture instruction from CLAUDE.md';
    const hostInstruction = 'Fixture instruction from AGENTS.md';
    await fs.writeFile(path.join(cwd, 'CLAUDE.md'), nativeInstruction);
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), hostInstruction);
    const skillDir = path.join(cwd, '.claude', 'skills', 'fixture-review');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: fixture-review\ndescription: Review the fixture\n---\nReview the fixture.');
    const none = { sources: [], excludePaths: [] };
    const setInstructions = (owner, sources) => client.cmd('setContextSettings', { cwd, place: cwd, kind: 'instruction',
      value: { owner, user: none, directory: { ...none, sources } } });
    const latestInput = () => JSON.stringify(fixture.model.calls.at(-1).messages);
    const onlyInstruction = (expected, other) => latestInput().split(expected).length === 2 && !latestInput().includes(other);
    await setInstructions('native', ['claude']);
    await client.runTurn({ sessionId: desktopSession, prompt: 'native instructions' });
    t.ok('エージェント管理にすると Claude の指示が一度届く', onlyInstruction(nativeInstruction, hostInstruction));
    await setInstructions('ply', ['common']);
    await client.runTurn({ sessionId: desktopSession, prompt: 'host instructions' });
    t.ok('Pleiad 管理に切り替えると共通の指示が一度届く', onlyInstruction(hostInstruction, nativeInstruction));
    const slash = await client.cmd('slashSkills', { cwd });
    t.ok('入力欄のスラッシュ候補に作業場所の Skill が現れる', JSON.stringify(slash).includes('fixture-review'));

    const desktopHistory = await client.cmd('loadSession', { sessionId: desktopSession });
    const secondUser = desktopHistory.messages.filter(message => message.role === 'user')[1];
    const desktopBranch = await client.cmd('fork', { sessionId: desktopSession, beforeMessageId: secondUser.uuid });
    const continued = await client.runTurn({ sessionId: desktopBranch.sessionId, prompt: 'desktop branch reply' });
    const input = fixture.model.calls.at(-1).messages;
    t.ok('デスクトップの分岐はモデルに元の発言を一度だけ渡し、除外した発言を渡さない',
      continued.outcome === 'ok' && input.filter(m => m.role === 'user' && m.content === 'native instructions').length === 1 &&
      !latestInput().includes('host instructions') && input.at(-1).content === 'desktop branch reply');

    await fs.writeFile(path.join(cwd, 'hook-result.txt'), 'read from host hook');
    await fs.writeFile(path.join(cwd, 'rewrite-read.mjs'), [
      "let body = ''; for await (const chunk of process.stdin) body += chunk;",
      "const { tool_input } = JSON.parse(body);",
      "if (!tool_input.file_path) process.exit(1);",
      "await (await import('node:fs/promises')).appendFile('hook-fired.txt', 'ran\\n');",
      "console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...tool_input, file_path: 'hook-result.txt' } } }));",
    ].join('\n'));
    await client.cmd('savePlyHook', { cwd, value: { name: 'Rewrite fixture read', agent: 'claude',
      event: 'PreToolUse', matcher: 'Read', command: 'node rewrite-read.mjs', targets: ['pleiad-agent'] } });
    const hooks = await client.cmd('hooksMatrix', { cwd });
    const hook = hooks.rows.find(row => row.name === 'Rewrite fixture read');
    if (!hook) throw new Error('Configured hook is missing from the matrix');
    await client.cmd('setHookAgent', { cwd, key: hook.key, agent: 'pleiad-agent', on: true, revision: hooks.revision });
    const readWithHook = await client.runTurn({ sessionId: desktopSession, prompt: '[fixture:read]' });
    t.ok('設定で登録したフックが一度だけ実行され、変更後のパスを読む',
      readWithHook.outcome === 'ok' && await fs.readFile(path.join(cwd, 'hook-fired.txt'), 'utf8').catch(() => '') === 'ran\n' &&
      fixture.model.calls.at(-1).messages.some(m => m.role === 'tool' && m.content.includes('read from host hook')));

    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { counter: {
      command: process.execPath, args: [path.join(ROOT, 'tests', 'lib', 'stateful-mcp.mjs')],
    } } }));
    await client.cmd('setContextSettings', { cwd, place: cwd, kind: 'mcp',
      value: { owner: 'ply', user: none, directory: { ...none, sources: ['claude'] } } });
    await client.runTurn({ sessionId: desktopSession, prompt: 'connect configured MCP' });
    const context = await client.cmd('sessionContext', { sessionId: desktopSession });
    const counter = context?.report?.entries?.find(entry => entry.name === 'counter' && entry.status === 'connected');
    if (counter) {
      const tool = 'mcp__ply_context__m_' + hash([counter.id, 'count']).slice(0, 24);
      await client.runTurn({ sessionId: desktopSession, prompt: '[fixture:mcp:' + tool + ']' });
    }
    t.ok('設定済みの外部 MCP を会話の道具として実行する', Boolean(counter) &&
      fixture.model.calls.at(-1).messages.some(m => m.role === 'tool' && m.content.includes('count:1')));


    for (const [provider, suffix, authMode] of [['openai', '/v1', 'bearer'], ['openrouter', '/api/v1', 'bearer'], ['anthropic', '', 'x-api-key']]) {
      const input = { agent: 'pleiad-agent', name: provider, preset: provider, baseUrl: byok.url + suffix,
        authMode, roles: { main: 'desktop-fixture' } };
      if (provider === 'openrouter') {
        const { id: keyRef } = await client.cmd('setApiKey', { provider, label: provider, key: 'openrouter-host-fixture-key' });
        const wrongHost = await client.cmd('compatEndpointCheck', { input: { ...input, keyRef } });
        t.ok('公式の OpenRouter キーを別のホストへ送らない',
          !wrongHost.ok && !byok.requests.some(row => row.headers.authorization === 'Bearer openrouter-host-fixture-key'));
      }
      // A loopback URL uses a host-bound key even with the OpenRouter preset.
      const { id: keyRef } = await client.cmd('setApiKey', {
        provider: provider === 'openrouter' ? 'custom' : provider, label: provider, key: 'desktop-fixture-key',
      });
      input.keyRef = keyRef;
      const checked = await client.cmd('compatEndpointCheck', { input });
      t.ok(provider + ' の接続の確認でモデル一覧を取得する',
        checked.ok && checked.models.includes('desktop-fixture') && checked.modelInfo['desktop-fixture']?.vision, JSON.stringify(checked));
      const { id: endpoint } = await client.cmd('compatEndpointSave', { input, receipt: checked.receipt });
      await client.cmd('setTurnSettings', { sessionId: desktopSession, endpoint, effort: 'high' });
      const result = await client.runTurn({ sessionId: desktopSession, prompt: 'hello from desktop' }, { ms: 15000 });
      const request = byok.requests.findLast(row => row.body?.stream === true);
      const protocolMatches = provider === 'anthropic'
        ? request?.path === '/v1/messages' && request.headers['x-api-key'] === 'desktop-fixture-key' && request.body.thinking?.type === 'enabled'
        : request?.path === suffix + '/chat/completions' && request.headers.authorization === 'Bearer desktop-fixture-key' &&
          (provider === 'openrouter' ? request.body.reasoning?.effort : request.body.reasoning_effort) === 'high';
      t.ok(provider + ' は保存済みのキーと推論の強さでストリーミングする',
        result.outcome === 'ok' && request?.body.model === 'desktop-fixture' && protocolMatches,
        JSON.stringify({ outcome: result.outcome, path: request?.path }));
      t.ok(provider + ' のキーは会話と設定の応答に含まれない',
        !JSON.stringify([result, await client.cmd('invoke', { op: 'apiKeys.list' })]).includes('desktop-fixture-key'));
    }
    t.ok('利用者の接続を選んだターンは管理の接続を使わない', completions.length === resultsBefore);

    await client.cmd('switchBackend', { sessionId: desktopSession, backend: 'fake' });
    const switched = await client.runTurn({ sessionId: desktopSession, backend: 'fake', prompt: 'echo:switched' });
    const handedOff = await client.cmd('loadSession', { sessionId: desktopSession });
    t.ok('エージェントの切り替え後も同じ会話で両方の履歴を読める',
      switched.outcome === 'ok' && handedOff.messages.some(m => m.uuid === secondUser.uuid) &&
      handedOff.messages.some(m => m.role === 'user' && m.text === 'echo:switched'));

    const hostOp = (op, args) => client.cmd('invoke', { op, args });
    await hostOp('settings.set', { key: 'botEnabled', value: true });
    const bot = await hostOp('bots.create', { name: 'Owl', backend: 'pleiad-agent' });
    const channel = await hostOp('channels.create', { name: 'release-check' });
    const readChannel = threadId => hostOp('channels.read', { channelId: channel.id, ...(threadId ? { threadId } : {}) });
    const waitForReply = root => waitFor(async () => (await readChannel(root.id)).posts.find(post =>
      post.turn?.botId === bot.id && post.state === 'done' && post.text));
    const post = await hostOp('channels.post', { channelId: channel.id, text: '@Owl Channel request' });
    const reply = await waitForReply(post);
    t.ok('Pleiad Agent のボットが呼びかけを受け取り、スレッドに返信する',
      reply.threadId === post.id && reply.text.includes('Channel request'));

    const routine = await hostOp('routines.create', { name: 'Restart fixture', botId: bot.id, channelId: channel.id,
      prompt: 'Routine request', trigger: { kind: 'cron', expr: '* * * * *' } });
    client.close();
    await server.stop();
    await setClock(routineStart + 5 * minute);
    server = await startServer(desktopOptions);
    client = await open(server);
    const roots = async () => (await readChannel()).posts.filter(post => post.author.routineId === routine.id);
    const missed = await waitFor(async () => (await roots())[0]);
    const scheduledReply = await waitForReply(missed);
    t.ok('再起動時に Pleiad Agent のルーティンを一度だけ実行し、取りこぼしと返信を同じスレッドに表示する',
      missed.routine?.missed === true && scheduledReply.text.includes('Routine request') && (await roots()).length === 1);

    client.close();
    await server.stop();
    chrome = await startFakeChrome({ permission: 'auto' });
    const browserData = path.join(scratch, 'browser');
    server = await startServer({ dataDir: browserData, entry: path.join(ROOT, 'tests/lib/parent-port-server.mjs'),
      env: { ...fixture.env, AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir, AGENT_HOST_AGENT_BROWSER_PRESTART: 'off',
        TEST_PARENT_PORT_ENTRY: serverEntry.entry ?? '' } });
    client = await open({ ...server, onEvent(event, api) {
      if (event.type === 'permission' && !event.browserHandoff) {
        return api.cmd('resolvePermission', { id: event.id, allow: true }).catch(() => {});
      }
    } });
    await client.cmd('chromeConnect');
    await client.waitFor(event => event.type === 'chromeBrowser' && event.state === 'connected', { ms: 20_000 });
    const handoff = async () => {
      const { sessionId } = await client.cmd('newSession', { backend: 'pleiad-agent', cwd });
      const from = client.mark();
      await client.cmd('sendMessage', { sessionId, messageId: 'browser-handoff-fixture', prompt: 'browser handoff fixture' });
      const card = await client.waitFor(event => event.type === 'permission' && event.sessionId === sessionId &&
        event.browserHandoff?.state === 'asked', { from, ms: 20_000 });
      return { card, from, sessionId };
    };
    const resumed = await handoff();
    const configs = path.join(browserData, 'agent-browser');
    const cdpUrl = await waitFor(async () => {
      for (const dir of await fs.readdir(configs).catch(() => [])) {
        const text = await fs.readFile(path.join(configs, dir, 'agent-browser.json'), 'utf8').catch(() => null);
        if (text) return JSON.parse(text).cdp;
      }
      return null;
    });
    const browserAgent = new WebSocket(cdpUrl);
    try {
      await new Promise((resolve, reject) => {
        browserAgent.addEventListener('error', () => reject(new Error('Fake Chrome did not connect')), { once: true });
        browserAgent.addEventListener('open', resolve, { once: true });
      });
      browserAgent.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));
      await client.waitFor(event => event.type === 'chromeWindow' && event.sessionId === resumed.sessionId && event.windows > 0,
        { from: resumed.from, ms: 20_000 });
      const watch = await client.cmd('browserScreencast', { sessionId: resumed.sessionId, source: 'chrome', width: 400, height: 300, device: 'phone' });
      await client.cmd('chromeTakeOver', { sessionId: resumed.sessionId, by: 'screen', tabId: watch.tabId, width: 400, height: 300, scale: 1 });
      await client.waitFor(event => event.type === 'permissionUpdate' && event.browserHandoff?.state === 'operating',
        { from: resumed.from, ms: 20_000 });
      await client.cmd('chromeResume', { sessionId: resumed.sessionId });
      await client.waitFor(event => event.type === 'turnEnd' && event.sessionId === resumed.sessionId, { from: resumed.from, ms: 20_000 });
    } finally {
      browserAgent.close();
    }
    const stopped = await handoff();
    await client.cmd('abort', { sessionId: stopped.sessionId });
    await client.waitFor(event => event.type === 'turnEnd' && event.sessionId === stopped.sessionId, { from: stopped.from, ms: 20_000 });
    t.ok('偽の Chrome で Pleiad Agent から操作の手渡しを依頼でき、再開と停止で待ちを抜ける',
      resumed.card.browserHandoff.message === 'ログインしてください' && stopped.card.id !== resumed.card.id);
  } finally {
    releaseSuggestion();
    releaseChild();
    client?.close();
    try { await server?.stop(); } finally {
      await chrome?.stop();
      await byok.close();
      await plus.close();
      await fixture.close();
      const holder = await connectHolder({ dataDir: desktopDir, root: defaultHolderRoot(desktopDir) }).catch(() => null);
      holder?.shutdown();
      holder?.close();
      await fs.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}
