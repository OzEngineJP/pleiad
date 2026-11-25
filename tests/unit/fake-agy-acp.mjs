// fake-agy の ACP モード（`agy acp`）。本物（agy 1.5.17）で測った口を、AcpClient（core/backends/acp-client.mjs）で実際に繋いで確かめる。
// 先に、既存の stream-json の側（--version・models・--print /usage・--print= の約束・1 ターン）が崩れていないことを見る。
// 続けて ACP: initialize・session/new の見せ方・prompt の流れ（本文→ツール→usage）・設定の変更・中断・失敗・load / resume / list / close・
// MCP（mcpServers を実際に起こして握手）・認証・環境変数の台本・クライアントへの許可の依頼・stdin を閉じたときの終了。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../../core/backends/acp-client.mjs';

export const name = 'fake-agy-acp';
export const title = 'fake-agy の ACP モード（agy acp）: stream-json は無傷・initialize・session・prompt・中断・load・MCP・認証・環境変数の台本';

const fake = fileURLToPath(new URL('../lib/fake-agy.mjs', import.meta.url));
const mcpFixture = fileURLToPath(new URL('../lib/stdio-mcp.mjs', import.meta.url));
const textPrompt = (sessionId, text) => ({ sessionId, prompt: [{ type: 'text', text }] });
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await sleep(10); } return false; };
const lines = async file => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const kinds = seen => seen.map(p => p.update?.sessionUpdate);
const chunksOf = (seen, sessionId) => seen.filter(p => p.sessionId === sessionId && p.update?.sessionUpdate === 'agent_message_chunk').map(p => p.update.content.text);
const PROMPT_MS = 20_000;

export default async function test(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-fake-agy-acp-'));
  // 呼び出し元の FAKE_AGY_*・MCP_TEST_* は持ち込まない（台本は各ケースが環境変数で決める）
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FAKE_AGY_|MCP_TEST_)/.test(key)));
  const data = name => path.join(root, name);
  const clients = [];
  const open = async ({ env = {}, args = ['acp'], ...options } = {}) => {
    const seen = [];
    const client = new AcpClient({
      label: 'Agy', args, command: [process.execPath, fake], cwd: root, timeoutMs: 8000,
      env: { ...base, AGENT_HOST_DATA: data('state'), ...env }, onUpdate: params => seen.push(params), ...options,
    });
    clients.push(client);
    const init = await client.start();
    return { client, seen, init };
  };
  const newSession = (client, params = {}) => client.call('session/new', { cwd: root, mcpServers: [], ...params });
  const prompt = (client, sessionId, text) => client.call('session/prompt', textPrompt(sessionId, text), { timeoutMs: PROMPT_MS });
  // 1 ターン分の本文だけを読む（その前の通知は捨てる）
  const say = async (client, seen, sessionId, text) => {
    seen.length = 0;
    const result = await prompt(client, sessionId, text);
    return { result, text: chunksOf(seen, sessionId).join('') };
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const sync = (argv, env = {}) => spawnSync(process.execPath, [fake, ...argv], { env: { ...base, ...env }, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  const streamTurn = (text, env = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fake, '--print=', '--output-format', 'stream-json', '--input-format', 'stream-json'], { env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = '', done = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('stream-json turn timed out')); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let frame = null;
        try { frame = JSON.parse(line); } catch {}
        if (frame?.event === 'result' && !done) { done = true; clearTimeout(timer); child.stdin.end(); resolve(frame.result); }
      }
    });
    child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: text } })}\n`);
  });

  try {
    // ---- stream-json の側は無傷
    t.ok('--version は FAKE_AGY_VERSION を返し、既定は 1.5.15', sync(['--version'], { FAKE_AGY_VERSION: '9.9.9' }).stdout.trim() === '9.9.9' && sync(['--version']).stdout.trim() === '1.5.15');
    const models = sync(['models'], { FAKE_AGY_EXTRA_MODELS: 'gemini-x,gemini-y' });
    const rows = models.stdout.split(/\r?\n/).filter(line => line.includes('\t')).map(line => line.split('\t'));
    t.ok('models は id<TAB>表示名で、4 つの身代わりの後ろに FAKE_AGY_EXTRA_MODELS を並べる',
      models.status === 0 && rows.length === 6 && rows[0][0] === 'fake-antigravity-1' && rows[2][1] === 'Fake Flash (High)' && rows[4][0] === 'gemini-x' && rows[5][0] === 'gemini-y',
      JSON.stringify(rows));
    const usage = sync(['--print', '/usage']);
    t.ok('--print /usage は SUCCESS の usage を返す', usage.status === 0 && JSON.parse(usage.stdout).status === 'SUCCESS');
    const bare = sync(['--model', 'x']);
    t.ok('--print= の無い起動は 2 で落ちる（agy acp だけがこの約束の外）', bare.status === 2 && /--print took/.test(bare.stderr), bare.stderr);
    const turn = await streamTurn('hi');
    t.ok('stream-json の 1 ターンは今までどおり了解 + 本文を返し、累計の usage が付く',
      turn.status === 'SUCCESS' && turn.response === '了解: hi' && turn.usage?.total_tokens === 21, JSON.stringify(turn));

    // ---- initialize
    const { client, seen, init } = await open({ env: { FAKE_AGY_VERSION: '1.5.17' } });
    t.ok('initialize: protocolVersion 1・agentInfo の版は FAKE_AGY_VERSION・loadSession と promptCapabilities',
      init.protocolVersion === 1 && init.agentInfo?.name === 'agy' && init.agentInfo.version === '1.5.17'
        && init.agentCapabilities?.loadSession === true && init.agentCapabilities.promptCapabilities?.image === true && init.agentCapabilities.promptCapabilities.embeddedContext === true,
      JSON.stringify(init));
    t.ok('initialize: sessionCapabilities（resume・close・load・list・additionalDirectories）・auth.logout・_meta.antigravity',
      ['resume', 'close', 'load', 'list', 'additionalDirectories'].every(key => key in init.agentCapabilities.sessionCapabilities)
        && 'logout' in init.agentCapabilities.auth && init.agentCapabilities._meta?.antigravity?.systemPrompt?.append === true,
      JSON.stringify(init.agentCapabilities));
    t.ok('initialize: authMethods は 4 つ（id・name を持つ）', Array.isArray(init.authMethods) && init.authMethods.length === 4 && init.authMethods.every(m => m.id && m.name),
      JSON.stringify(init.authMethods?.map(m => m.id)));

    // ---- session/new
    const created = await newSession(client);
    t.ok('session/new: sessionId は UUID',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(created.sessionId), created.sessionId);
    t.ok('session/new: models は 4 つの身代わりで、現在は既定の表示名のモデル（fake-flash-high）',
      created.models?.currentModelId === 'fake-flash-high' && created.models.availableModels.length === 4
        && created.models.availableModels[0].modelId === 'fake-antigravity-1' && created.models.availableModels.every(m => m.modelId && m.name),
      JSON.stringify(created.models));
    t.ok('session/new: modes は 4 つで現在は default、configOptions は model・thought_level・mode',
      created.modes?.currentModeId === 'default' && created.modes.availableModes.length === 4
        && JSON.stringify(created.configOptions.map(o => o.id)) === '["model","thought_level","mode"]'
        && created.configOptions.find(o => o.id === 'thought_level').currentValue === 'medium'
        && created._meta?.antigravity?.tier?.name === 'Fake Tier',
      JSON.stringify({ modes: created.modes?.currentModeId, options: created.configOptions?.map(o => o.id) }));
    t.ok('session/new の後に available_commands_update と usage_update（used 0）が通知で届く',
      await until(() => seen.some(p => p.sessionId === created.sessionId && p.update.sessionUpdate === 'available_commands_update')
        && seen.some(p => p.sessionId === created.sessionId && p.update.sessionUpdate === 'usage_update')),
      JSON.stringify(kinds(seen)));
    const sid = created.sessionId;
    const announced = seen.find(p => p.update.sessionUpdate === 'usage_update');
    t.ok('usage_update は used・size（100 万）と _meta.antigravity.usage を持ち、最初は 0', announced?.update.used === 0 && announced.update.size === 1_000_000 && announced.update._meta?.antigravity?.usage?.total_tokens === 0,
      JSON.stringify(announced));

    // ---- session/prompt
    seen.length = 0;
    const done = await prompt(client, sid, 'こんにちは');
    const flow = kinds(seen);
    t.ok('prompt: end_turn で終わり、本文は 4 文字以内のチャンクで流れて「了解: <本文>」になる',
      done.stopReason === 'end_turn' && chunksOf(seen, sid).join('') === '了解: こんにちは' && chunksOf(seen, sid).every(chunk => [...chunk].length <= 4) && chunksOf(seen, sid).length >= 3,
      JSON.stringify({ done, chunks: chunksOf(seen, sid) }));
    const call = seen.find(p => p.update.sessionUpdate === 'tool_call')?.update;
    const callDone = seen.find(p => p.update.sessionUpdate === 'tool_call_update')?.update;
    t.ok('prompt: ツールは tool_call（in_progress）→ tool_call_update（completed と出力）で、同じ toolCallId',
      call?.status === 'in_progress' && call.kind === 'execute' && call.rawInput?.CommandLine === 'echo hello' && callDone?.status === 'completed'
        && callDone.toolCallId === call.toolCallId && callDone.content?.[0]?.content?.text === 'hello\r\n',
      JSON.stringify({ call, callDone }));
    t.ok('prompt: 順番は本文 → tool_call → tool_call_update → usage_update', flow.lastIndexOf('agent_message_chunk') < flow.indexOf('tool_call') && flow.indexOf('tool_call') < flow.indexOf('tool_call_update') && flow.indexOf('tool_call_update') < flow.indexOf('usage_update'),
      JSON.stringify(flow));
    const first = seen.find(p => p.update.sessionUpdate === 'usage_update').update;
    await prompt(client, sid, 'もう一度');
    const second = seen.filter(p => p.update.sessionUpdate === 'usage_update').at(-1).update;
    t.ok('prompt: usage は会話の累計（1 ターン 21 ずつ）', first.used === 21 && second.used === 42 && second._meta.antigravity.usage.output_tokens === 14, JSON.stringify({ first: first.used, second: second.used }));
    const toolIds = new Set(seen.filter(p => p.update.sessionUpdate === 'tool_call').map(p => p.update.toolCallId));
    t.ok('prompt: toolCallId はターンをまたいでも重ならない', toolIds.size === 2, JSON.stringify([...toolIds]));
    const empty = await settle(client.call('session/prompt', { sessionId: sid, prompt: [] }, { timeoutMs: PROMPT_MS }));
    t.ok('prompt: 本文が空でも落ちずに end_turn で返す', empty.value?.stopReason === 'end_turn', JSON.stringify(empty));

    // ---- 設定の変更
    seen.length = 0;
    const changed = await client.call('session/set_config_option', { sessionId: sid, configId: 'thought_level', value: 'high' });
    t.ok('set_config_option: 値を変えて configOptions を返し、config_option_update が届く',
      changed.configOptions.find(o => o.id === 'thought_level').currentValue === 'high'
        && await until(() => seen.some(p => p.update.sessionUpdate === 'config_option_update' && p.update.configOptions.find(o => o.id === 'thought_level').currentValue === 'high')),
      JSON.stringify(changed.configOptions?.map(o => [o.id, o.currentValue])));
    const modelChanged = await client.call('session/set_config_option', { sessionId: sid, configId: 'model', value: 'fake-antigravity-2' });
    t.ok('set_config_option: model も変えられる', modelChanged.configOptions.find(o => o.id === 'model').currentValue === 'fake-antigravity-2');
    const badOption = await settle(client.call('session/set_config_option', { sessionId: sid, configId: 'thought_level', value: 'extreme' }));
    const badConfig = await settle(client.call('session/set_config_option', { sessionId: sid, configId: 'nope', value: 'x' }));
    t.ok('set_config_option: 知らない値と知らない項目は -32602', badOption.error?.code === -32602 && badConfig.error?.code === -32602, JSON.stringify({ a: badOption.error?.code, b: badConfig.error?.code }));
    seen.length = 0;
    await client.call('session/set_mode', { sessionId: sid, modeId: 'plan' });
    const badMode = await settle(client.call('session/set_mode', { sessionId: sid, modeId: 'nope' }));
    t.ok('set_mode: current_mode_update が届き、知らないモードは -32602',
      await until(() => seen.some(p => p.update.sessionUpdate === 'current_mode_update' && p.update.currentModeId === 'plan')) && badMode.error?.code === -32602);
    const unknownSession = await settle(client.call('session/set_mode', { sessionId: 'no-such', modeId: 'plan' }));
    t.ok('知らない session は -32602（prompt も set_mode も）', unknownSession.error?.code === -32602
      && (await settle(client.call('session/prompt', textPrompt('no-such', 'x'), { timeoutMs: PROMPT_MS }))).error?.code === -32602);
    const unknownMethod = await settle(client.call('session/frobnicate', {}));
    t.ok('知らない method は -32601', unknownMethod.error?.code === -32601, JSON.stringify(unknownMethod.error?.code));
    t.ok('toString や constructor のような名前の method でも -32601（表の継承を踏まない）', (await settle(client.call('toString', {}))).error?.code === -32601 && (await settle(client.call('constructor', {}))).error?.code === -32601);

    // ---- 中断
    seen.length = 0;
    const slow = await newSession(client);
    const running = settle(client.call('session/prompt', textPrompt(slow.sessionId, 'slow'), { timeoutMs: PROMPT_MS }));
    const queued = settle(client.call('session/prompt', textPrompt(slow.sessionId, '次のもの'), { timeoutMs: PROMPT_MS }));
    t.ok('slow は本文「待つ」を出して中断まで止まる', await until(() => chunksOf(seen, slow.sessionId).join('') === '待つ'), JSON.stringify(chunksOf(seen, slow.sessionId)));
    client.notify('session/cancel', { sessionId: slow.sessionId });
    const cancelled = await running;
    const cancelledQueued = await queued;
    t.ok('session/cancel: 走っているターンは cancelled で返り、順番待ちの prompt も始まる前に cancelled で返る',
      cancelled.value?.stopReason === 'cancelled' && cancelledQueued.value?.stopReason === 'cancelled' && !chunksOf(seen, slow.sessionId).join('').includes('了解'),
      JSON.stringify({ cancelled, cancelledQueued, chunks: chunksOf(seen, slow.sessionId) }));
    const after = await prompt(client, slow.sessionId, 'つづき');
    t.ok('中断の後の次のターンは通る', after.stopReason === 'end_turn' && chunksOf(seen, slow.sessionId).join('').endsWith('了解: つづき'));
    const cancelOnly = await settle(client.call('session/cancel', { sessionId: slow.sessionId }));
    t.ok('session/cancel を id 付きで送っても空の答えを返す', cancelOnly.value && Object.keys(cancelOnly.value).length === 0, JSON.stringify(cancelOnly));

    // ---- 失敗と台本
    const failed = await settle(prompt(client, sid, 'fail'));
    t.ok('fail は JSON-RPC の内部エラー（-32603）で、次のターンは通る', failed.error?.code === -32603 && (await say(client, seen, sid, 'ok')).text === '了解: ok', JSON.stringify(failed.error?.code));
    t.ok('[fail] を含む本文と fail-400 も同じく -32603',
      (await settle(prompt(client, sid, '本文 [fail]'))).error?.code === -32603 && (await settle(prompt(client, sid, 'fail-400'))).error?.code === -32603);
    seen.length = 0;
    const errorBody = await settle(prompt(client, sid, 'error-body'));
    t.ok('error-body は本文を出してからエラー（-32000）で終える', errorBody.error?.code === -32000 && chunksOf(seen, sid).join('') === '本文は届いた', JSON.stringify(errorBody.error?.code));
    seen.length = 0;
    const denied = await prompt(client, sid, 'admin-denied');
    t.ok('admin-denied は失敗のツールと、_meta.antigravity.deniedActions を持つ end_turn', denied.stopReason === 'end_turn' && denied._meta?.antigravity?.deniedActions?.[0]?.action === 'command'
      && seen.some(p => p.update.sessionUpdate === 'tool_call_update' && p.update.status === 'failed'), JSON.stringify(denied));
    const preamble = 'Pleiad が追加した指示（これは前置き）\n\n本物の発言';
    t.ok('前置きの付いた本文は末尾の段落だけで台本が動く', (await say(client, seen, sid, preamble)).text === '了解: 本物の発言');
    t.ok('wire-has: は届いた本文（前置きを含む全体）に含まれるかを答える', (await say(client, seen, sid, 'Pleiad が追加した指示（前置き）\n\nwire-has:前置き')).text === 'wire-has:yes');
    const dump = JSON.parse((await say(client, seen, sid, `${preamble}\n\nwire-dump`)).text);
    t.ok('wire-dump は前置きを含む本文の段落数と頭・尻を返す', dump.paragraphs === 3 && dump.head.startsWith('Pleiad が追加した指示') && dump.tail.endsWith('wire-dump'), JSON.stringify(dump));
    // 候補づくり・hooks・agent-body は本物と同じくホームの下を使う。実際のホームを汚さないよう、使い捨てのホームで動かす
    const home = data('home');
    const homed = await open({ env: { USERPROFILE: home, HOME: home } });
    const homedSession = await newSession(homed.client);
    const suggestion = await say(homed.client, homed.seen, homedSession.sessionId, 'Return only JSON matching this schema {"suggestion": string}');
    t.ok('候補づくりの指示には JSON で答え、会話の置き場をホームの下に作る',
      suggestion.result.stopReason === 'end_turn' && suggestion.text === '{"suggestion":"テストを流して"}'
        && await fs.stat(path.join(home, '.gemini', 'antigravity-cli', 'conversations', `${homedSession.sessionId}.db`)).then(() => true, () => false));
    t.ok('agent-body と agy-hooks は、カスタムエージェントも hooks も無ければ (no agent) と hooks:none',
      (await say(homed.client, homed.seen, homedSession.sessionId, 'agent-body')).text === '(no agent)' && (await say(homed.client, homed.seen, homedSession.sessionId, 'agy-hooks')).text === 'hooks:none');

    // ---- 起動の引数・環境変数の控え
    const promptLog = data('prompts.log'), pidFile = data('pids.json'), argsFile = data('args.json'), acpLog = data('acp.jsonl');
    const logged = await open({ env: { FAKE_AGY_PROMPT_LOG: promptLog, FAKE_AGY_PID_FILE: pidFile, FAKE_AGY_ARGS_FILE: argsFile, FAKE_AGY_ACP_LOG: acpLog }, args: ['acp', '--model', 'fake-antigravity-2', '--dangerously-skip-permissions'] });
    const loggedSession = await newSession(logged.client);
    await prompt(logged.client, loggedSession.sessionId, '控える\n二行目');
    t.ok('PROMPT_LOG は 1 ターンを 1 行で控え、PID_FILE・ARGS_FILE は起こした pid と引数を控える',
      (await fs.readFile(promptLog, 'utf8')).trim() === '控える 二行目'
        && JSON.parse(await fs.readFile(pidFile, 'utf8')).includes(logged.client.pid)
        && JSON.parse(await fs.readFile(argsFile, 'utf8')).at(-1)[0] === 'acp');
    t.ok('--model は初期モデルに、--dangerously-skip-permissions は現在のモード（skip）に効く',
      loggedSession.models.currentModelId === 'fake-antigravity-2' && loggedSession.modes.currentModeId === 'skip',
      JSON.stringify({ model: loggedSession.models.currentModelId, mode: loggedSession.modes.currentModeId }));
    const methodsSeen = (await lines(acpLog)).map(frame => frame.method);
    t.ok('FAKE_AGY_ACP_LOG は受けた依頼を順に控える（initialize → session/new → session/prompt）', JSON.stringify(methodsSeen) === '["initialize","session/new","session/prompt"]', JSON.stringify(methodsSeen));
    const flagged = await open({ env: { FAKE_AGY_DEFAULT_LABEL: 'Fake Flash (Low)', FAKE_AGY_PERMISSION_MODE: 'sandbox', FAKE_AGY_EXTRA_MODELS: 'gemini-x' } });
    const flaggedSession = await newSession(flagged.client);
    t.ok('DEFAULT_LABEL は既定のモデル・PERMISSION_MODE は現在のモード・EXTRA_MODELS は選択肢に効く',
      flaggedSession.models.currentModelId === 'fake-flash-low' && flaggedSession.modes.currentModeId === 'sandbox' && flaggedSession.models.availableModels.some(m => m.modelId === 'gemini-x'),
      JSON.stringify(flaggedSession.models));
    const review = await open({ env: { FAKE_AGY_ADMIN_REVIEW: '1' } });
    t.ok('ADMIN_REVIEW は現在のモードを request-review にする', (await newSession(review.client)).modes.currentModeId === 'request-review');
    const logFile = data('agy.log');
    const labelled = await open({ args: ['acp', '--log-file', logFile], env: { FAKE_AGY_DEFAULT_LABEL: 'Fake Flash (Low)' } });
    void labelled;
    t.ok('--log-file には、選ばれているモデルの表示名を本物と同じ行で書く', /label="Fake Flash \(Low\)"/.test(await fs.readFile(logFile, 'utf8')));
    const modelsFail = await open({ env: { FAKE_AGY_MODELS_FAIL: '1' } });
    t.ok('MODELS_FAIL の agy は session/new を -32603 で断る', (await settle(newSession(modelsFail.client))).error?.code === -32603);

    // ---- load・resume・list・close
    const keeper = await open();
    const kept = await newSession(keeper.client, { cwd: path.join(root, 'kept') });
    await prompt(keeper.client, kept.sessionId, '覚えておく');
    await keeper.client.close();
    const reopened = await open();
    reopened.seen.length = 0;
    const loaded = await reopened.client.call('session/load', { sessionId: kept.sessionId, cwd: path.join(root, 'kept'), mcpServers: [] });
    const replay = reopened.seen.filter(p => p.update.sessionUpdate === 'user_message_chunk' || p.update.sessionUpdate === 'agent_message_chunk');
    t.ok('session/load: 別のプロセスでも残した会話を読み直し、返事の前に user / agent の本文を再生する',
      loaded.models?.currentModelId === 'fake-flash-high' && replay.length === 2 && replay[0].update.sessionUpdate === 'user_message_chunk' && replay[0].update.content.text === '覚えておく'
        && replay[1].update.content.text === '了解: 覚えておく', JSON.stringify(replay));
    t.ok('session/load の後に続きのターンが通り、usage は前の累計から続く（42）',
      (await prompt(reopened.client, kept.sessionId, '続き')).stopReason === 'end_turn'
        && reopened.seen.filter(p => p.update.sessionUpdate === 'usage_update').at(-1).update.used === 42);
    const resumer = await open();
    resumer.seen.length = 0;
    const resumed = await resumer.client.call('session/resume', { sessionId: kept.sessionId, cwd: path.join(root, 'kept'), mcpServers: [] });
    t.ok('session/resume: 会話は再生しない（モデルの一覧だけ返す）',
      resumed.models?.availableModels?.length === 4 && await until(() => resumer.seen.some(p => p.update.sessionUpdate === 'available_commands_update'))
        && !resumer.seen.some(p => p.update.sessionUpdate === 'user_message_chunk' || p.update.sessionUpdate === 'agent_message_chunk'), JSON.stringify(kinds(resumer.seen)));
    const missing = await settle(resumer.client.call('session/load', { sessionId: 'does-not-exist', cwd: root, mcpServers: [] }));
    const traversal = await settle(resumer.client.call('session/resume', { sessionId: '../escape', cwd: root, mcpServers: [] }));
    t.ok('知らない会話の load / resume は -32002（パスを抜ける id も同じ）', missing.error?.code === -32002 && traversal.error?.code === -32002, JSON.stringify({ a: missing.error?.code, b: traversal.error?.code }));
    const listed = await resumer.client.call('session/list', {});
    const listedKept = await resumer.client.call('session/list', { cwd: path.join(root, 'kept') });
    t.ok('session/list: 会話を新しい順に返し、cwd で絞れる',
      listed.sessions.length >= 2 && listed.sessions.some(s => s.sessionId === kept.sessionId) && listedKept.sessions.length === 1 && listedKept.sessions[0].sessionId === kept.sessionId
        && listedKept.sessions[0].title === '覚えておく', JSON.stringify(listedKept));
    await resumer.client.call('session/close', { sessionId: kept.sessionId });
    const closedPrompt = await settle(prompt(resumer.client, kept.sessionId, 'x'));
    const closedTwice = await settle(resumer.client.call('session/close', { sessionId: kept.sessionId }));
    t.ok('session/close の後の prompt と二重の close は -32602', closedPrompt.error?.code === -32602 && closedTwice.error?.code === -32602);
    const cwdSession = await newSession(resumer.client, { cwd: path.join(root, 'with-dirs'), additionalDirectories: [path.join(root, 'extra')] });
    t.ok('additionalDirectories を渡した session も作れる', Boolean(cwdSession.sessionId));

    // ---- システムプロンプトの追加
    const appended = await open();
    const withPrompt = await newSession(appended.client, { _meta: { antigravity: { systemPrompt: { append: '追加の指示です' } } } });
    const legacy = await newSession(appended.client, { _meta: { systemPrompt: { append: '旧い置き場' } } });
    const plain = await newSession(appended.client);
    t.ok('session/new の _meta で足したシステムプロンプトは、台本 system-prompt で読み戻せる（_meta.antigravity と _meta の両方。無ければ (none)）',
      (await say(appended.client, appended.seen, withPrompt.sessionId, 'system-prompt')).text === '追加の指示です'
        && (await say(appended.client, appended.seen, legacy.sessionId, 'system-prompt')).text === '旧い置き場'
        && (await say(appended.client, appended.seen, plain.sessionId, 'system-prompt')).text === '(none)');

    // ---- MCP（mcpServers を実際に起こして握手）
    const mcpLog = data('mcp.jsonl');
    const mcpServers = [{ name: 'fixture', command: process.execPath, args: [mcpFixture], env: [{ name: 'MCP_TEST_LOG', value: mcpLog }, { name: 'MCP_TEST_VALUE', value: 'from-mcp' }] }];
    const withMcp = await open();
    const mcpSession = await withMcp.client.call('session/new', { cwd: root, mcpServers });
    const toolList = await prompt(withMcp.client, mcpSession.sessionId, 'mcp-tools');
    const listedTools = JSON.parse(chunksOf(withMcp.seen, mcpSession.sessionId).join(''));
    t.ok('MCP: mcpServers が起こされ、握手（server/discover → initialize → tools/list）をして、mcp-tools がツールを返す',
      toolList.stopReason === 'end_turn' && listedTools.length === 1 && listedTools[0].server === 'fixture' && listedTools[0].name === 'echo',
      JSON.stringify({ listedTools }));
    const handshake = (await lines(mcpLog)).map(entry => entry.method);
    t.ok('MCP: 握手は server/discover → initialize → tools/list の順に 1 回ずつ（initialized は通知で数えない）',
      JSON.stringify(handshake) === '["server/discover","initialize","tools/list"]', JSON.stringify(handshake));
    withMcp.seen.length = 0;
    await prompt(withMcp.client, mcpSession.sessionId, 'mcp-call:echo {"x":1}');
    const mcpCall = withMcp.seen.find(p => p.update.sessionUpdate === 'tool_call')?.update;
    const mcpDone = withMcp.seen.find(p => p.update.sessionUpdate === 'tool_call_update')?.update;
    t.ok('MCP: mcp-call: は call_mcp_tool の tool_call（ServerName 空・ToolName・Arguments）を出して、MCP の返事を本文にする',
      mcpCall?.title === 'call_mcp_tool' && mcpCall.rawInput?.ToolName === 'echo' && mcpCall.rawInput.Arguments?.x === 1 && mcpDone?.content?.[0]?.content?.text === 'from-mcp'
        && chunksOf(withMcp.seen, mcpSession.sessionId).join('') === 'mcp:from-mcp', JSON.stringify({ mcpCall, mcpDone }));
    t.ok('MCP: 無いツールは no-tool: で答える', await (async () => {
      withMcp.seen.length = 0;
      await prompt(withMcp.client, mcpSession.sessionId, 'mcp-call:missing');
      return chunksOf(withMcp.seen, mcpSession.sessionId).join('') === 'no-tool:missing';
    })());
    const disabledLog = data('mcp-disabled.jsonl');
    const mcpOff = await open({ env: { FAKE_AGY_MCP_DISABLED: '1' } });
    const offSession = await mcpOff.client.call('session/new', { cwd: root, mcpServers: [{ ...mcpServers[0], env: [{ name: 'MCP_TEST_LOG', value: disabledLog }] }] });
    await prompt(mcpOff.client, offSession.sessionId, 'mcp-tools');
    t.ok('MCP_DISABLED の agy は MCP を起こさず（握手が 1 つも来ない）、ツールの一覧は空', JSON.parse(chunksOf(mcpOff.seen, offSession.sessionId).join('')).length === 0 && (await lines(disabledLog)).length === 0);
    const closedMcp = data('mcp-closed.jsonl');
    const mcpClose = await open();
    const closeSession = await mcpClose.client.call('session/new', { cwd: root, mcpServers: [{ ...mcpServers[0], env: [{ name: 'MCP_TEST_LOG', value: closedMcp }] }] });
    await prompt(mcpClose.client, closeSession.sessionId, 'mcp-tools');
    const mcpPid = (await lines(closedMcp))[0]?.pid;
    await mcpClose.client.call('session/close', { sessionId: closeSession.sessionId });
    t.ok('session/close は、その会話の MCP の子も止める', Number.isInteger(mcpPid) && await until(() => !alive(mcpPid), 5000), String(mcpPid));

    // ---- 認証
    const authFile = data('auth/ok');
    const needs = await open({ env: { FAKE_AGY_NEEDS_AUTH: '1', FAKE_AGY_AUTH_FILE: authFile } });
    const unauthenticated = await settle(newSession(needs.client));
    const badMethod = await settle(needs.client.call('authenticate', { methodId: 'nope' }));
    t.ok('未認証の agy は session/new を -32000 で断り、知らない認証方式は -32602', unauthenticated.error?.code === -32000 && badMethod.error?.code === -32602, JSON.stringify({ a: unauthenticated.error?.code, b: badMethod.error?.code }));
    await needs.client.call('authenticate', { methodId: 'oauth-personal' });
    const signedIn = await newSession(needs.client);
    t.ok('authenticate の後は session/new が通り、資格情報の印のファイルが残る（次のプロセスの models が通る）',
      Boolean(signedIn.sessionId) && (await fs.readFile(authFile, 'utf8')) === 'ok' && sync(['models'], { FAKE_AGY_NEEDS_AUTH: '1', FAKE_AGY_AUTH_FILE: authFile }).status === 0);
    t.ok('資格情報が残っていれば、新しいプロセスは認証なしで session/new が通る', Boolean((await newSession((await open({ env: { FAKE_AGY_NEEDS_AUTH: '1', FAKE_AGY_AUTH_FILE: authFile } })).client)).sessionId));
    await needs.client.call('logout', {});
    const loggedOut = await settle(newSession(needs.client));
    const removed = await fs.stat(authFile).then(() => false, () => true);
    t.ok('logout は印を消し、同じプロセスでも session/new が -32000 に戻る', removed && loggedOut.error?.code === -32000, JSON.stringify(loggedOut.error?.code));
    const ready = await open({ env: { FAKE_AGY_NEEDS_AUTH: '0' } });
    t.ok('NEEDS_AUTH が無ければ authenticate を呼ばずに session/new が通る', Boolean((await newSession(ready.client)).sessionId));

    // ---- 台本（署名・ゲート・途中・終了）
    const signatureDir = data('signature');
    const signed = await open({ env: { FAKE_AGY_SIGNATURE_DIR: signatureDir } });
    const signedSession = await newSession(signed.client);
    await prompt(signed.client, signedSession.sessionId, 'poison-signature');
    const poisoned = await settle(prompt(signed.client, signedSession.sessionId, 'もう一度'));
    const freshSession = await newSession(signed.client);
    t.ok('SIGNATURE_DIR: poison-signature の後は、その会話だけが「Invalid thought signature」で断られ、別の会話は通る',
      poisoned.error?.code === -32000 && (await prompt(signed.client, freshSession.sessionId, 'ふつう')).stopReason === 'end_turn', JSON.stringify(poisoned.error?.code));
    const afterStep = await settle(prompt(signed.client, freshSession.sessionId, 'signature-after-step'));
    t.ok('signature-after-step は step を出してから署名のエラーで断る', afterStep.error?.code === -32000 && signed.seen.some(p => p.sessionId === freshSession.sessionId && p.update.sessionUpdate === 'tool_call'));
    const gateDir = data('gate');
    await fs.mkdir(gateDir, { recursive: true });
    const gated = await open({ env: { FAKE_AGY_GATE_DIR: gateDir } });
    const gatedSession = await newSession(gated.client);
    const gatedRun = prompt(gated.client, gatedSession.sessionId, 'gated:one');
    t.ok('gated: は前置きを出して、ゲートが開くまでツールの実行中で待つ',
      await until(() => chunksOf(gated.seen, gatedSession.sessionId).join('') === '前置き。') && !gated.seen.some(p => p.update.sessionUpdate === 'tool_call_update'));
    await fs.writeFile(path.join(gateDir, 'one'), '');
    const gatedDone = await gatedRun;
    t.ok('gated: ゲートが開くと完了と本文を出し、応答の後に .done の印を置く',
      gatedDone.stopReason === 'end_turn' && chunksOf(gated.seen, gatedSession.sessionId).join('') === '前置き。終わり: one' && await until(() => fs.stat(path.join(gateDir, 'one.done')).then(() => true, () => false)));
    const partialSession = await newSession(gated.client);
    const partialRun = settle(prompt(gated.client, partialSession.sessionId, 'partial'));
    t.ok('partial は途中の本文とツールを出して中断まで待ち、中断で cancelled', await until(() => chunksOf(gated.seen, partialSession.sessionId).join('') === '途中まで'));
    gated.client.notify('session/cancel', { sessionId: partialSession.sessionId });
    t.ok('partial の中断は cancelled で返る', (await partialRun).value?.stopReason === 'cancelled');
    const okSession = await newSession(gated.client);
    const okRun = await prompt(gated.client, okSession.sessionId, 'partial-ok');
    t.ok('partial-ok は途中の後に続きを足して終わる', okRun.stopReason === 'end_turn' && chunksOf(gated.seen, okSession.sessionId).join('') === '途中まで。続き');
    const failSession = await newSession(gated.client);
    t.ok('partial-fail は途中の後にエラー（-32000）で終わる', (await settle(prompt(gated.client, failSession.sessionId, 'partial-fail'))).error?.code === -32000);
    const limit = await settle(prompt(gated.client, failSession.sessionId, 'limit-no-reply'));
    t.ok('limit-no-reply は本文なしで上限のエラー（-32000）になる', limit.error?.code === -32000);

    // ---- クライアントへの許可の依頼
    const asked = [];
    const permitting = await open({ onRequest: async (method, params) => { asked.push({ method, params }); return { outcome: { outcome: 'selected', optionId: 'allow_once' } }; } });
    const permittingSession = await newSession(permitting.client);
    permitting.seen.length = 0;
    await prompt(permitting.client, permittingSession.sessionId, 'ファイルを消す [permission]');
    t.ok('[permission]: session/request_permission を client に依頼し、選ばれた allow_once を返事に書く',
      asked[0]?.method === 'session/request_permission' && asked[0].params.options.some(o => o.optionId === 'allow_once') && asked[0].params.toolCall?.rawInput?.CommandLine === 'echo permission'
        && chunksOf(permitting.seen, permittingSession.sessionId).join('') === 'permission:allow_once'
        && permitting.seen.some(p => p.update.sessionUpdate === 'tool_call_update' && p.update.status === 'completed'),
      JSON.stringify({ asked: asked.map(a => a.method), chunks: chunksOf(permitting.seen, permittingSession.sessionId) }));
    const refusing = await open({ onRequest: async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }) });
    const refusingSession = await newSession(refusing.client);
    await prompt(refusing.client, refusingSession.sessionId, '[permission]');
    t.ok('[permission]: reject_once なら失敗のツールにして permission:reject_once と書く',
      chunksOf(refusing.seen, refusingSession.sessionId).join('') === 'permission:reject_once' && refusing.seen.some(p => p.update.sessionUpdate === 'tool_call_update' && p.update.status === 'failed'));
    const noHandler = await open();
    const noHandlerSession = await newSession(noHandler.client);
    await prompt(noHandler.client, noHandlerSession.sessionId, '[permission]');
    t.ok('[permission]: client が依頼を断ったら permission:error と書いて終える（止まらない）', chunksOf(noHandler.seen, noHandlerSession.sessionId).join('') === 'permission:error');

    // ---- 終了
    const exiting = await open();
    const exitingSession = await newSession(exiting.client);
    const exitPid = exiting.client.pid;
    const exitRun = await settle(prompt(exiting.client, exitingSession.sessionId, 'result-then-exit'));
    t.ok('result-then-exit は返事を返し切ってからプロセスが終わる', exitRun.value?.stopReason === 'end_turn' && chunksOf(exiting.seen, exitingSession.sessionId).join('') === '完了した返事' && await until(() => !alive(exitPid), 5000));
    // stdin を閉じるだけで（kill なしで）終わる。親が消えたら道連れになる約束
    const closing = spawn(process.execPath, [fake, 'acp'], { env: { ...base, AGENT_HOST_DATA: data('state') }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const closed = new Promise(resolve => closing.once('exit', (code, signal) => resolve({ code, signal })));
    closing.stdin.end();
    const closedBy = await Promise.race([closed, sleep(8000).then(() => 'timeout')]);
    if (closedBy === 'timeout') closing.kill();
    t.ok('stdin を閉じると agy acp は 0 で終わる', closedBy?.code === 0, JSON.stringify(closedBy));
    const partialExit = await open();
    const partialExitSession = await newSession(partialExit.client);
    const partialExitRun = await settle(prompt(partialExit.client, partialExitSession.sessionId, 'partial-exit'));
    t.ok('partial-exit は途中の本文を出してからプロセスごと落ち、応答は失敗で返る', Boolean(partialExitRun.error) && chunksOf(partialExit.seen, partialExitSession.sessionId).join('') === '途中まで');
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
