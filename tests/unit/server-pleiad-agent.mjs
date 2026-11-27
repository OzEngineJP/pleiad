import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlusClient } from '../../core/plus/client.mjs';
import { createPlusModelConnection } from '../../core/plus/model-connection.mjs';
import { startPleiadAgentFixture } from '../lib/pleiad-agent-fixture.mjs';
import { installFakePlusModels, startFakePlus } from '../lib/fake-plus.mjs';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';
import { connectHolder } from '../../core/holder/client.mjs';
import { defaultHolderRoot } from '../../core/process.mjs';
import { hash } from '../../core/context-runtime.mjs';
import { ROOT, startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-pleiad-agent';
export const title = 'Pleiad Agent の道具・添付と送信待ち';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agent-'));
  const cwd = path.join(scratch, '日本語 の作業場所');
  const desktopDir = path.join(scratch, 'desktop');
  const fixture = await startPleiadAgentFixture({ token: 'fixture-key-only',
    usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.01 },
    reply: body => body.messages.at(-1)?.content === '[fixture:visualize]' ? [
      'visualize' + JSON.stringify({ path: path.join(cwd, 'chart.html'), title: 'Figure' }),
      'visualize' + JSON.stringify({ path: path.join(cwd, 'invalid.html'), title: 'Invalid figure' }),
    ].join('\n') : undefined });
  const plus = await startFakePlus();
  const runtime = { tenantId: '11111111-1111-4111-8111-111111111111',
    cloudHostId: '22222222-2222-4222-8222-222222222222', generation: 2, token: 'r'.repeat(43) };
  const desktopToken = plus.issueIdToken('fixture-user');
  const completions = installFakePlusModels(plus, { upstream: fixture.model.baseUrl + '/chat/completions',
    upstreamKey: 'fixture-key-only', runtime, desktopToken });
  const byok = await startFakeCompatApi({ keys: ['desktop-fixture-key'], models: [{ id: 'desktop-fixture', vision: true }] });
  const options = { dataDir: path.join(scratch, 'data'), env: {
    ...fixture.env, AGENT_HOST_KIND: 'cloud', AGENT_HOST_BACKENDS: 'fake,claude',
    AGENT_HOST_PLUS_API: plus.url, AGENT_HOST_PLEIAD_AGENT_BASE_URL: 'http://127.0.0.1:1/v1',
    PLEIAD_CLOUD_RUNTIME_TOKEN: runtime.token, PLEIAD_CLOUD_TENANT_ID: runtime.tenantId,
    PLEIAD_CLOUD_HOST_ID: runtime.cloudHostId, PLEIAD_CLOUD_GENERATION: String(runtime.generation),
  } };
  let server, client;
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

    const filePath = path.join(cwd, '結果 ファイル.txt');
    const exists = () => fs.stat(filePath).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    const writeArgs = { sessionId, messageId: 'ply-agent-write-001', prompt: '[fixture:write]', mode: 'default' };
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
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: approveMark });
    t.ok('承認された編集内容を書き込む', await fs.readFile(filePath, 'utf8') === '画面で編集した本文');
    t.ok('書き込みの再開で利用者の発言は増えない',
      (await client.cmd('loadSession', { sessionId })).messages.filter(m => m.role === 'user' && m.text.includes('[fixture:write]')).length === 1);

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
    const updated = await invoke('todos.update', { ifRev: added.rev, items: [{ id: added.items[0].id, status: 'done' }] });
    const conflict = await invoke('todos.update', { ifRev: added.rev, items: [{ id: added.items[0].id, status: 'doing' }] }).catch(error => error);
    const todos = await invoke('todos.list', {});
    t.ok('古い版の ToDo 編集と競合した場合に新しい状態を保つ', updated.rev > added.rev && conflict instanceof Error &&
      todos.items[0].status === 'done');

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
    server = await startServer({ dataDir: desktopDir, env: {
      ...fixture.env, AGENT_HOST_BACKENDS: 'pleiad-agent,fake', AGENT_HOST_PLUS_API: plus.url,
    } });
    client = await open({ ...server, autoAllow: true });
    const desktopSession = (await client.cmd('newSession', { backend: 'pleiad-agent', cwd })).sessionId;
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
  } finally {
    client?.close();
    try { await server?.stop(); } finally {
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
