// Grok のバックエンド（core/backends/grok.mjs）へ、ACP の身代わりを差し込んで確かめる:
// 会話ごとの MCP（ply_agents と headers）・Hooks のプラグイン（_meta.pluginDirs）・互換の Hooks を止める環境変数が、
// session/new と session/load の両方に届き、渡さないターン・別の会話・履歴の読み込みには混ざらない。
// プラグインの置き場はターンの終わりに消え、持ち主の居ない残りは次の書き込みで消える。
// turn_completed の usage（ターンのモデル呼び出しの合計）は文脈の量にしない
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrokBackend } from '../../core/backends/grok.mjs';
import { createGrokMapper } from '../../core/backends/grok-normalize.mjs';

export const name = 'grok-backend';
export const title = 'Grok: 会話ごとの MCP・Hooks のプラグイン・互換の止め方が session/new と session/load に届き、ほかへ漏れない・置き場の掃除';

const MODEL = 'grok-fixture';

export default async function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-grok-backend-'));
  const dataDir = path.join(root, 'data'), cwd = path.join(root, 'project'), other = path.join(root, 'other');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  const calls = [];
  let nextId = 0;
  let rejectResume = false;
  let holdPrompt = false, releasePrompt, permissionRequest = null, permissionResponse, selectionMismatch = false, resumeSelection = null;
  const sessions = new Map();
  class FakeAcp {
    constructor(options) { this.options = options; this.init = null; }
    notify() {}
    async start() {
      this.init = { _meta: { modelState: { currentModelId: MODEL, availableModels: [{ modelId: MODEL, _meta: { totalContextTokens: 1000 } }] } } };
      const profileAt = this.options.args.indexOf('--agent-profile');
      this.profile = profileAt >= 0 ? this.options.args[profileAt + 1] : null;
      try { this.profileText = this.profile ? fs.readFileSync(this.profile, 'utf8') : null; } catch { this.profileText = null; }
      try { this.configText = fs.readFileSync(path.join(this.options.env.GROK_HOME, 'config.toml'), 'utf8'); } catch { this.configText = null; }
      return this.init;
    }
    async call(method, params) {
      const entry = { method, params, env: this.options.env };
      entry.args = this.options.args;
      entry.profile = this.profile;
      entry.profileText = this.profileText;
      entry.configText = this.configText;
      const dirs = params?._meta?.pluginDirs ?? [];
      // 呼ばれた時点で置き場に hooks.json があるか（Grok が読むのはこの時点）
      entry.pluginFiles = dirs.map(d => { try { return JSON.parse(fs.readFileSync(path.join(d, 'hooks', 'hooks.json'), 'utf8')); } catch { return null; } });
      calls.push(entry);
      if (method === 'session/new') {
        if (params.cwd.includes('broken')) throw new Error('fixture: session/new failed');
        const sessionId = `grok-fixture-${++nextId}`; sessions.set(sessionId, params.cwd);
        return { sessionId };
      }
      if (method === '_x.ai/session/rename') return { success: true };
      if (method === '_x.ai/session/fork') {
        const sessionId = `grok-fixture-${++nextId}`; sessions.set(sessionId, params.newCwd);
        return { newSessionId: sessionId };
      }
      if (method === 'session/load') {
        if (params.sessionId === 'grok-child-fixture') this.options.onUpdate({ sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child fixture answer' } } });
        return { sessionId: params.sessionId, ...resumeSelection };
      }
      if (method === 'session/resume') {
        if (rejectResume) throw Object.assign(new Error('method not found'), { code: -32601 });
        return { sessionId: params.sessionId, models: { currentModelId: MODEL, availableModels: [{ modelId: MODEL }] }, configOptions: [], ...resumeSelection };
      }
      if (method === 'session/close') return { _meta: { 'x.ai/closeOutcome': 'closed' } };
      if (method === 'session/set_config_option') return { configOptions: [{ id: params.configId, currentValue: selectionMismatch ? 'different' : params.value }] };
      if (method === '_x.ai/interject') {
        this.options.onInterjection(params);
        return { result: { status: 'queued' } };
      }
      if (method === 'session/prompt') {
        if (holdPrompt) await new Promise(resolve => { releasePrompt = resolve; });
        if (permissionRequest) permissionResponse = await this.options.onRequest('session/request_permission', { ...permissionRequest, sessionId: params.sessionId });
        const text = params.prompt?.map(part => part.text ?? '').join('') ?? '';
        this.options.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } });
        if (text.includes('fixture request child')) {
          this.options.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'subagent_spawned', child_session_id: 'grok-child-fixture', subagent_id: 'sub-1', description: 'fixture child' } });
          this.options.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'subagent_finished', child_session_id: 'grok-child-fixture', subagent_id: 'sub-1', status: 'completed' } });
        }
        this.options.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture reply' } } });
        return { stopReason: 'end_turn' };
      }
      return {};
    }
    async close() {}
  }
  const backend = createGrokBackend({ Acp: FakeAcp, command: () => ['grok-fixture'], dataDir });
  const base = path.join(dataDir, 'grok-hooks');
  const pluginHooks = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node adapter.mjs pre' }] }] } };
  const compatHookEnv = { GROK_CLAUDE_HOOKS_ENABLED: 'false', GROK_CURSOR_HOOKS_ENABLED: 'false', GROK_CODEX_HOOKS_ENABLED: 'false' };
  const agentRuntime = { url: 'http://127.0.0.1:1/mcp/agents', headers: { Authorization: 'Bearer fixture-token', 'X-Ply-Session': 'fixture' }, instructions: 'fixture instructions' };
  const turn = (args) => backend.runTurn({ prompt: 'hello', mode: 'ask', emit: () => {}, ...args });
  const of = (method, from) => calls.slice(from).filter(c => c.method === method);
  const compatOff = env => Object.keys(compatHookEnv).every(k => env?.[k] === 'false');
  const compatUntouched = env => Object.keys(compatHookEnv).every(k => env?.[k] === process.env[k]);
  const ownDirs = () => { try { return fs.readdirSync(base).filter(n => n.startsWith(`${process.pid}-`)); } catch { return []; } };

  try {
    t.ok('Grok の native AGENTS.md・Skills と重なる Pleiad 担当は拒否し、MCP だけの担当は受ける',
      backend.plyContextRefusal({ instruction: 'ply', skill: 'native', mcp: 'ply' })
        && backend.plyContextRefusal({ instruction: 'native', skill: 'native', mcp: 'ply' }) === null);
    // 持ち主の居ない残り（終わったプロセスの pid）と、生きている別のプロセス（親）の置き場を先に置く
    const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
    for (const owner of [dead, process.ppid]) fs.mkdirSync(path.join(base, `${owner}-fixture`, 'hooks'), { recursive: true });

    // 1. 渡すターン（新しい会話）: session/new に MCP（headers 付き）とプラグインの置き場、CLI に互換を止める環境変数
    let mark = calls.length;
    const first = await turn({ cwd, agentRuntime, hooksRuntime: { pluginHooks, compatHookEnv } });
    const firstMessages = await backend.getMessages(first.sessionId);
    const created = of('session/new', mark)[0];
    const mcp = created?.params?.mcpServers ?? [];
    t.ok('session/new に ply_agents を type: http と headers の { name, value } で渡す',
      mcp.length === 1 && mcp[0].name === 'ply_agents' && mcp[0].type === 'http' && mcp[0].url === agentRuntime.url
      && JSON.stringify(mcp[0].headers) === JSON.stringify([{ name: 'Authorization', value: 'Bearer fixture-token' }, { name: 'X-Ply-Session', value: 'fixture' }]), JSON.stringify(mcp));
    const firstDir = created?.params?._meta?.pluginDirs?.[0];
    t.ok('session/new の _meta.pluginDirs の置き場に、渡した hooks.json がある',
      created?.params?._meta?.pluginDirs?.length === 1 && path.dirname(firstDir) === base && JSON.stringify(created.pluginFiles[0]) === JSON.stringify(pluginHooks), JSON.stringify(created?.params?._meta));
    t.ok('渡すターンの CLI は互換の Hooks を止める環境変数で起こす', compatOff(created?.env));
    t.ok('発言に ply_agents の説明を足す', of('session/prompt', mark)[0]?.params?.prompt?.[0]?.text.includes('fixture instructions'));
    t.ok('ターンが終わると置き場を消す', !fs.existsSync(firstDir) && ownDirs().length === 0, JSON.stringify(ownDirs()));
    t.ok('最初の書き込みで、持ち主の居ない残りを消し、生きている別のプロセスの置き場は残す',
      !fs.existsSync(path.join(base, `${dead}-fixture`)) && fs.existsSync(path.join(base, `${process.ppid}-fixture`)));

    mark = calls.length;
    const forked = await backend.fork(first.sessionId, { title: 'fork title' });
    await backend.setTitle(forked.sessionId, 'fixture title');
    t.ok('ネイティブの全履歴 fork と題名変更は Grok 拡張 RPC に届く',
      of('_x.ai/session/fork', mark).some(c => c.params.sourceSessionId === first.sessionId && c.params.sourceCwd === cwd && c.params.newCwd === cwd)
      && of('_x.ai/session/rename', mark).some(c => c.params.sessionId === forked.sessionId && c.params.title === 'fork title')
      && of('_x.ai/session/rename', mark).some(c => c.params.sessionId === forked.sessionId && c.params.title === 'fixture title'));

    // 2. 同じ会話の次のターン: session/resume にも MCP と新しい置き場を渡す（セッション限定のプラグインは保存されない）
    mark = calls.length;
    await turn({ sessionId: first.sessionId, cwd, agentRuntime, hooksRuntime: { pluginHooks, compatHookEnv } });
    const loaded = of('session/resume', mark)[0];
    const loadDir = loaded?.params?._meta?.pluginDirs?.[0];
    t.ok('session/resume にも ply_agents（headers 付き）を渡す', loaded?.params?.mcpServers?.[0]?.name === 'ply_agents' && loaded.params.mcpServers[0].headers.length === 2);
    t.ok('session/resume にも、そのターンの新しい置き場と hooks.json を渡す',
      Boolean(loadDir) && loadDir !== firstDir && JSON.stringify(loaded.pluginFiles[0]) === JSON.stringify(pluginHooks) && compatOff(loaded.env));
    t.ok('次のターンの置き場も終わりに消す', !fs.existsSync(loadDir) && ownDirs().length === 0);

    rejectResume = true;
    mark = calls.length;
    await turn({ sessionId: first.sessionId, cwd });
    t.ok('session/resume が未対応なら session/load に戻す',
      of('session/resume', mark).length === 1 && of('session/load', mark).length === 1);
    rejectResume = false;

    // 3. 同じ会話で、そろえない・委譲を使わないターン: 前のターンの MCP・プラグイン・環境変数を持ち越さない
    mark = calls.length;
    await turn({ sessionId: first.sessionId, cwd });
    const plain = of('session/resume', mark)[0];
    t.ok('渡さないターンの session/resume は mcpServers が空で _meta が無い', JSON.stringify(plain?.params?.mcpServers) === '[]' && !('_meta' in (plain?.params ?? {})), JSON.stringify(plain?.params));
    t.ok('渡さないターンは互換の Hooks の環境変数を変えない', compatUntouched(plain?.env));

    // 4. 別の会話（別の場所）の新しいターン: 前の会話の分が混ざらない
    mark = calls.length;
    await turn({ cwd: other });
    const fresh = of('session/new', mark)[0];
    t.ok('別の会話の session/new は mcpServers が空で _meta が無く、環境変数も変えない',
      JSON.stringify(fresh?.params?.mcpServers) === '[]' && !('_meta' in (fresh?.params ?? {})) && compatUntouched(fresh?.env), JSON.stringify(fresh?.params));

    // 5. 履歴の読み込み（getMessages）は、渡した会話でも MCP もプラグインも渡さない（覚えた履歴を外して読み直させる）
    await backend.releaseConversation(first.sessionId);
    t.ok('releaseConversation は native session/close を送る', of('session/close', 0).length === 1);
    mark = calls.length;
    await backend.getMessages(first.sessionId);
    const history = of('session/load', mark)[0];
    t.ok('履歴の読み込みの session/load は mcpServers が空で _meta が無い', history && JSON.stringify(history.params.mcpServers) === '[]' && !('_meta' in history.params), JSON.stringify(history?.params));

    // 6. session/new が失敗しても置き場を残さない
    const broken = path.join(root, 'broken');
    fs.mkdirSync(broken);
    const failed = await turn({ cwd: broken, hooksRuntime: { pluginHooks, compatHookEnv } }).then(() => null, e => e);
    t.ok('session/new が失敗したターンも置き場を消す', Boolean(failed) && ownDirs().length === 0, String(failed?.message));

    await backend.releaseConversation(first.sessionId);
    await turn({ sessionId: first.sessionId, cwd });
    const resumedMessages = await backend.getMessages(first.sessionId);
    t.ok('履歴 mapper が無い状態で resume しても新しい UUID は既存行と衝突しない',
      resumedMessages.length === 2 && firstMessages.length === 2
      && resumedMessages.every(m => !firstMessages.some(old => old.uuid === m.uuid)), JSON.stringify(resumedMessages.map(m => m.uuid)));

    // 共通機能は新規・再開・古いCLIのloadのすべてに渡す。履歴には注入文を残さない。
    const runtime = name => ({ url: `http://127.0.0.1:1/${name}`, headers: { Authorization: `Bearer ${name}` }, instructions: `fixture-${name}-instructions` });
    const delivery = { agentRuntime, browserRuntime: runtime('browser'), controlRuntime: { ...runtime('control'), env: { PLEIAD_CONTROL_URL: 'fixture-control-url' } },
      computerRuntime: runtime('computer'), shellRuntime: runtime('shell'), browserEnv: { AGENT_BROWSER_CONFIG: 'fixture-browser-config' },
      browserInstructions: 'fixture-browser-instructions', visualizeInstructions: 'fixture-visualize-instructions',
      secretsRuntime: { env: { PLEIAD_FIXTURE_SECRET: 'fixture-secret-value' }, instructions: 'fixture-secrets-instructions' }, hooksRuntime: { pluginHooks, compatHookEnv } };
    let deliveryId;
    for (const phase of ['new', 'resume', 'load']) {
      mark = calls.length;
      rejectResume = phase === 'load';
      const result = await turn({ cwd, ...delivery, ...(deliveryId ? { sessionId: deliveryId } : {}) });
      deliveryId = result.sessionId;
      const setup = of(phase === 'new' ? 'session/new' : phase === 'load' ? 'session/load' : 'session/resume', mark)[0];
      t.ok(`${phase}: ブラウザー・操作一覧・コンピューター・シェル・委譲のMCPに会話の認証情報を渡す`,
        JSON.stringify(setup.params.mcpServers.map(s => s.name)) === JSON.stringify(['ply_browser', 'ply_control', 'ply_computer', 'ply_shell', 'ply_agents'])
        && setup.params.mcpServers.every(s => s.type === 'http' && s.headers[0].name === 'Authorization'));
      t.ok(`${phase}: 接続用・秘密情報の環境変数とHooksの互換設定を同時に渡す`,
        setup.env.AGENT_BROWSER_CONFIG === 'fixture-browser-config' && setup.env.PLEIAD_CONTROL_URL === 'fixture-control-url'
        && setup.env.PLEIAD_FIXTURE_SECRET === 'fixture-secret-value' && compatOff(setup.env));
      const text = of('session/prompt', mark)[0].params.prompt[0].text;
      t.ok(`${phase}: 全機能の指示が届き、秘密の値と注入文を発言の記録に混ぜない`,
        ['browser', 'control', 'computer', 'shell', 'secrets', 'visualize'].every(name => text.includes(`fixture-${name}-instructions`))
        && !text.includes('fixture-secret-value') && (await backend.getMessages(deliveryId)).filter(m => m.role === 'user').every(m => m.text === 'hello'));
    }
    rejectResume = false;
    mark = calls.length;
    await turn({ cwd, ...delivery, mode: 'plan' });
    t.ok('計画モードでは操作用のブラウザー指示を配らない', !of('session/prompt', mark)[0].params.prompt[0].text.includes('fixture-browser-instructions'));
    await backend.releaseConversation(deliveryId);
    mark = calls.length;
    await backend.getMessages(deliveryId);
    const isolated = of('session/load', mark)[0];
    t.ok('履歴取得に追加MCP・秘密情報・接続用環境変数を持ち込まない', isolated.params.mcpServers.length === 0
      && isolated.env.PLEIAD_FIXTURE_SECRET === process.env.PLEIAD_FIXTURE_SECRET
      && isolated.env.AGENT_BROWSER_CONFIG === process.env.AGENT_BROWSER_CONFIG);

    // ネイティブ shell を Pleiad の設定で切るプロファイルは、新規・再開の ACP 起動だけに付ける。
    const nativeOff = { url: 'http://127.0.0.1:1/shell', headers: {}, nativeOff: true, instructions: 'fixture-shell-instructions' };
    mark = calls.length;
    const shellOffNew = await turn({ cwd, shellRuntime: nativeOff });
    const shellOffProfile = of('session/new', mark)[0];
    t.ok('shellTool=ply の新規 Grok 会話で bash を外す一時プロファイルを起動引数に渡す',
      shellOffProfile?.profile && shellOffProfile.profileText.includes('run_terminal_cmd')
      && of('session/set_mode', mark).some(c => c.params.modeId === 'default'));
    t.ok('一時プロファイルをターン終了後に消す', Boolean(shellOffProfile?.profile) && !fs.existsSync(shellOffProfile.profile));
    mark = calls.length;
    await turn({ cwd, sessionId: shellOffNew.sessionId, shellRuntime: nativeOff, mode: 'plan' });
    const shellOffResume = of('session/resume', mark)[0];
    t.ok('再開会話でも bash を外し、読み取り専用モードの ACP 設定を維持する',
      shellOffResume?.profileText?.includes('run_terminal_cmd') && of('session/set_mode', mark).some(c => c.params.modeId === 'plan'));
    mark = calls.length;
    await turn({ cwd: other });
    t.ok('別会話にネイティブ shell を外すプロファイルを持ち越さない', !of('session/new', mark)[0]?.profile);
    mark = calls.length;
    await turn({ cwd: other });
    const separate = of('session/new', mark)[0];
    t.ok('別会話に追加MCP・秘密情報・接続用環境変数を持ち越さない', separate.params.mcpServers.length === 0
      && separate.env.PLEIAD_FIXTURE_SECRET === process.env.PLEIAD_FIXTURE_SECRET
      && separate.env.AGENT_BROWSER_CONFIG === process.env.AGENT_BROWSER_CONFIG);

    // 互換の接続先と ply_context はターンだけに渡し、再開と別会話を分ける。
    const endpoint = { id: 'ep-0123456789ab', kind: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:43123/v1',
      key: 'fixture-endpoint-key', roles: { main: 'fixture-model' } };
    const contextRuntime = { url: 'http://127.0.0.1:43123/mcp/context', headers: { Authorization: 'Bearer fixture-context-token' },
      prompt: 'fixture ply context instructions', owners: { instruction: 'native', skill: 'native', mcp: 'ply' } };
    mark = calls.length;
    const endpointTurn = await turn({ cwd, endpoint, contextRuntime });
    const endpointNew = of('session/new', mark)[0];
    t.ok('新規 Grok 会話に OpenAI Chat Completions の接続先と ply_context を渡す',
      endpointNew?.env?.GROK_MODELS_BASE_URL === endpoint.baseUrl && endpointNew?.env?.XAI_API_KEY === endpoint.key
      && endpointNew?.configText?.includes(endpoint.baseUrl) && endpointNew?.configText?.includes('env_key = "XAI_API_KEY"')
      && !endpointNew?.configText?.includes(endpoint.key)
      && endpointNew?.params?.mcpServers?.some(s => s.name === 'ply_context' && s.url === contextRuntime.url)
      && endpointNew?.params?.mcpServers?.some(s => s.name === 'ply_context' && s.headers?.[0]?.value === contextRuntime.headers.Authorization)
      && of('session/prompt', mark)[0]?.params?.prompt?.[0]?.text?.includes(contextRuntime.prompt));
    mark = calls.length;
    await turn({ cwd, sessionId: endpointTurn.sessionId, endpoint, contextRuntime, mode: 'plan' });
    const endpointResume = of('session/resume', mark)[0];
    t.ok('再開 Grok 会話にも今回の接続先・ply_context・読み取り専用モードを渡す',
      endpointResume?.env?.GROK_MODELS_BASE_URL === endpoint.baseUrl && endpointResume?.env?.XAI_API_KEY === endpoint.key
      && endpointResume?.env?.GROK_HOME === endpointNew?.env?.GROK_HOME && endpointResume?.configText?.includes(endpoint.baseUrl)
      && endpointResume?.params?.mcpServers?.some(s => s.name === 'ply_context')
      && of('session/set_mode', mark).some(c => c.params.modeId === 'plan'));
    const restarted = createGrokBackend({ Acp: FakeAcp, command: () => ['grok-fixture'], dataDir });
    mark = calls.length;
    await restarted.runTurn({ prompt: 'resume after backend restart', cwd, sessionId: endpointTurn.sessionId, mode: 'ask', endpoint, emit: () => {} });
    const afterRestart = of('session/resume', mark)[0];
    t.ok('バックエンド再起動後も保存した会話専用ホームと互換接続先を再利用する',
      afterRestart?.env?.GROK_HOME === endpointNew?.env?.GROK_HOME && afterRestart?.configText?.includes(endpoint.baseUrl));
    mark = calls.length;
    await turn({ cwd: other, endpoint });
    const secondEndpointConversation = of('session/new', mark)[0];
    // 置き場は接続先ごとに 1 つ（会話ごとに作ると会話の数だけ増えて消えない）。同じ接続先の会話は ~/.grok と同じく置き場を共有する
    t.ok('同じ互換接続先の別の会話は、その接続先の Grok ホームを共有する', secondEndpointConversation?.env?.GROK_HOME === endpointNew?.env?.GROK_HOME);
    mark = calls.length;
    await turn({ cwd: other, endpoint: { ...endpoint, id: 'ep-ba9876543210', baseUrl: 'http://127.0.0.1:43124/v1' } });
    const otherEndpointConversation = of('session/new', mark)[0];
    t.ok('別の互換接続先の会話には別の Grok ホームを割り当てる', otherEndpointConversation?.env?.GROK_HOME !== endpointNew?.env?.GROK_HOME
      && otherEndpointConversation?.configText?.includes('43124'));
    mark = calls.length;
    await turn({ cwd: other });
    const isolatedEndpoint = of('session/new', mark)[0];
    t.ok('別会話に接続先・ply_context を持ち越さない',
      isolatedEndpoint?.env?.GROK_MODELS_BASE_URL !== endpoint.baseUrl && isolatedEndpoint?.env?.XAI_API_KEY !== endpoint.key
      && !isolatedEndpoint?.params?.mcpServers?.some(s => s.name === 'ply_context'));
    mark = calls.length;
    const parent = await turn({ cwd, prompt: 'fixture request child' });
    const child = (await backend.listSubagents(parent.sessionId))[0];
    const childMessages = await backend.getSubagentMessages(parent.sessionId, child);
    t.ok('子通知から会話の子だけを一覧し、その中身を取得する', child === 'grok-child-fixture'
      && childMessages.some(m => m.role === 'assistant' && m.text.includes('child fixture answer'))
      && (await backend.getSubagentMessages('unrelated-parent', child)).length === 0);

    // 設定の途中変更は稼働中のセッションだけに渡し、モデルのACKの不一致は成功にしない。
    let ready;
    const readiness = new Promise(resolve => { ready = resolve; });
    const control = { onReady: ready };
    holdPrompt = true;
    const running = turn({ cwd, control });
    await readiness;
    t.ok('Grokの稼働中のモデル・承認モードを変更できる', await backend.setModelLive(control.handle, MODEL) && await backend.setModeLive(control.handle, 'plan'));
    selectionMismatch = true;
    t.ok('モデルのACKが指定と異なるときは次ターンへ回す', !await backend.setModelLive(control.handle, MODEL));
    selectionMismatch = false;
    t.ok('未知の承認モードは送らない', !await backend.setModeLive(control.handle, 'unknown'));
    holdPrompt = false; releasePrompt(); await running;
    t.ok('終わったターンに設定変更を送らない', !await backend.setModelLive(control.handle, MODEL) && !await backend.setModeLive(control.handle, 'ask'));

    // 保存済みのモデル・effortが起動引数を上書きしても、プロンプトを送る前に今回の指定へ戻す。
    resumeSelection = { models: { currentModelId: 'saved-model' }, configOptions: [
      { id: 'model', currentValue: 'saved-model' }, { id: 'reasoning_effort', currentValue: 'low' }] };
    for (const fallback of [false, true]) {
      rejectResume = fallback;
      mark = calls.length;
      await turn({ cwd, sessionId: first.sessionId, model: MODEL });
      const restored = of('session/set_config_option', mark)[0];
      const promptIndex = calls.slice(mark).findIndex(c => c.method === 'session/prompt');
      t.ok(`再開後の保存済みモデルを送信前に戻す（load=${fallback}）`, restored?.params.value === MODEL
        && calls.indexOf(restored) - mark < promptIndex);
    }
    rejectResume = false;
    mark = calls.length;
    await turn({ cwd, sessionId: first.sessionId, effort: 'high' });
    t.ok('再開後の保存済みeffortを今回の指定へ戻す', of('session/set_config_option', mark).some(c => c.params.configId === 'reasoning_effort' && c.params.value === 'high'));
    mark = calls.length;
    await turn({ cwd, sessionId: first.sessionId, model: MODEL, effort: 'high' });
    t.ok('モデルを戻した後にもeffortを再適用する', JSON.stringify(of('session/set_config_option', mark).map(c => c.params.configId)) === JSON.stringify(['model', 'reasoning_effort']));
    selectionMismatch = true;
    mark = calls.length;
    let rejectedSelection = false;
    try { await turn({ cwd, sessionId: first.sessionId, model: MODEL }); } catch { rejectedSelection = true; }
    t.ok('モデルの復元ACKが不一致なら送信しない', rejectedSelection && of('session/prompt', mark).length === 0);
    selectionMismatch = false; resumeSelection = null;

    for (const hasAlways of [true, false]) {
      let canAlways;
      permissionRequest = { toolCall: { toolCallId: `permission-${hasAlways}`, title: 'Read fixture', rawInput: {} }, options: [
        { kind: 'allow_once', optionId: 'once' }, { kind: 'reject_once', optionId: 'deny' }, ...(hasAlways ? [{ kind: 'allow_always', optionId: 'persistent' }] : [])] };
      await turn({ cwd, askPermission: async request => { canAlways = request.canAlways; return { allow: true, always: true }; } });
      t.ok(`Grok: CLIが提示した恒常許可だけを返す（${hasAlways}）`, canAlways === hasAlways && permissionResponse.outcome.optionId === (hasAlways ? 'persistent' : 'once'));
    }
    permissionRequest = null;

    {
    holdPrompt = true; releasePrompt = null;
    const nativeControl = {}, nativeEvents = [];
    const held = turn({ cwd, control: nativeControl, emit: event => nativeEvents.push(event) });
    for (let n = 0; n < 100 && !releasePrompt; n++) await new Promise(resolve => setTimeout(resolve, 5));
    const accepted = await nativeControl.steer({ id: 'interject-live', args: { prompt: 'follow-up' } });
    t.ok('ネイティブの途中入力通知が応答より先に届いても配送を確認できる', accepted && nativeEvents.some(e => e.type === 'userMessage.delivered' && e.messageId === 'interject-live' && e.nativeId));
    releasePrompt();
    const finished = await held;
    holdPrompt = false;
    const delivery = nativeEvents.find(e => e.messageId === 'interject-live');
    const transcript = await backend.getMessages(finished.sessionId);
    t.ok('途中入力の配送IDが実際の履歴行を指す', transcript.filter(m => m.role === 'user' && m.text === 'follow-up').length === 1
      && transcript.some(m => m.liveUuid === delivery.nativeId));

    }
    // 8. Grok の追加アカウントは専用 GROK_HOME を使い、既定ログインと会話の再開に混ざらない。
    const previousHome = process.env.AGENT_HOST_GROK_HOME;
    const defaultHome = path.join(root, 'default-grok-home');
    process.env.AGENT_HOST_GROK_HOME = defaultHome;
    try {
      const accountId = 'acct-0123456789ab';
      const accountDir = path.join(dataDir, 'accounts', 'grok', accountId);
      fs.mkdirSync(accountDir, { recursive: true });
      const account = { id: accountId, name: 'fixture', dir: accountDir, credential: { auth: { fixture: { token: 'private' } } } };
      t.ok('Grok アカウントは専用の暗号化ストア資格情報を専用ホームへ復元する',
        (await backend.accountStatus({ account })).hasCredential && fs.existsSync(path.join(accountDir, 'auth.json'))
        && !fs.existsSync(path.join(defaultHome, 'auth.json')));
      const scoped = await backend.forAccount(account);
      mark = calls.length;
      const firstAccountTurn = await scoped.runTurn({ prompt: 'private account turn', cwd, mode: 'ask', emit: () => {} });
      const scopedNew = of('session/new', mark)[0];
      t.ok('新しい Grok アカウント会話は専用 GROK_HOME で起動する', scopedNew?.env?.GROK_HOME === accountDir);
      mark = calls.length;
      await scoped.runTurn({ prompt: 'resume private account', sessionId: firstAccountTurn.sessionId, cwd, mode: 'ask', emit: () => {} });
      t.ok('再開した Grok アカウント会話も同じ専用 GROK_HOME を使う', of('session/resume', mark)[0]?.env?.GROK_HOME === accountDir);
      mark = calls.length;
      await turn({ cwd });
      t.ok('既定 Grok 会話は追加アカウントの認証ホームを使わない', of('session/new', mark)[0]?.env?.GROK_HOME === defaultHome);
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_HOST_GROK_HOME;
      else process.env.AGENT_HOST_GROK_HOME = previousHome;
    }
    // 7. turn_completed の usage は呼び出しの合計で、文脈の占有ではない。usage_update の used/size だけを文脈の量にする
    {
      mark = calls.length;
      const suggestion = await backend.suggestNext({ prompt: '{"suggestion":"Continue"}', signal: new AbortController().signal });
      const suggestionSession = of('session/new', mark)[0];
      t.ok('suggestNext は提案を返し、MCP と Hooks を持たない読み取り専用セッションを作る',
        suggestion === 'fixture reply'
        && suggestionSession?.params?.mcpServers?.length === 0
        && !suggestionSession?.params?._meta?.pluginDirs
        && of('session/set_mode', mark).some(c => c.params.modeId === 'plan')
        && of('session/close', mark).length === 1);
    }
    {
      const original = process.env.GROK_CONFIG;
      delete process.env.GROK_CONFIG;
      try {
        mark = calls.length;
        const first = await turn({ cwd, autoCompactWindow: 200 });
        const configOf = entry => JSON.parse(entry?.env?.GROK_CONFIG ?? '{}')?.session?.auto_compact_threshold_percent;
        const created = of('session/new', mark)[0];
        t.ok('autoCompactWindow をコンテキスト窓に対する割合へ変換して新規会話に渡す', configOf(created) === 20);
        mark = calls.length;
        await turn({ cwd, sessionId: first.sessionId, autoCompactWindow: 300 });
        t.ok('autoCompactWindow を再開会話にも渡す', configOf(of('session/resume', mark)[0]) === 30);
      } finally {
        if (original === undefined) delete process.env.GROK_CONFIG;
        else process.env.GROK_CONFIG = original;
      }
    }
    {
      mark = calls.length;
      await backend.compact({ cwd, sessionId: first.sessionId, mode: 'ask', emit: () => {} });
      t.ok('compact() はネイティブの /compact を既存セッションへ送る',
        of('session/prompt', mark).some(c => c.params.prompt?.some(p => p.text === '/compact')));
    }
    const events = [];
    const mapper = createGrokMapper('grok-fixture-usage', e => events.push(e), { windowTokens: 1000 });
    mapper.beginTurn('hello');
    mapper.accept({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 580, outputTokens: 1, totalTokens: 581 } });
    t.ok('turn_completed の usage から文脈の量を出さない', !events.some(e => e.type === 'contextWindow'), JSON.stringify(events));
    mapper.accept({ sessionUpdate: 'usage_update', used: 290, size: 1000 });
    t.ok('usage_update の used/size は文脈の量にする', events.some(e => e.type === 'contextWindow' && e.usedTokens === 290 && e.windowTokens === 1000));
    mapper.accept({ sessionUpdate: 'auto_compact_started', tokens_used: 850, context_window: 1000, percentage: 85, reason: 'threshold' });
    mapper.accept({ sessionUpdate: 'auto_compact_completed', tokens_before: 850, tokens_after: 140, summary_preview: 'kept the plan' });
    t.ok('Grok の自動圧縮通知を Pleiad の圧縮履歴用イベントへ写す',
      events.some(e => e.type === 'compaction' && e.phase === 'start' && e.beforeTokens === 850)
      && events.some(e => e.type === 'compaction' && e.phase === 'complete' && e.beforeTokens === 850 && e.afterTokens === 140 && e.summary === 'kept the plan'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
