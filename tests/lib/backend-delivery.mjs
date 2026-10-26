// 配達物（runArgs の機能の渡し物）が、エージェントごとの偽のプロセス・プロトコルに実際に届いたかを見る道具（issue #146）。
//
// DELIVERY_CAPABILITIES: 配達物を持つ能力の印。core/backends/contract.mjs の RUN_ARG_FEATURES から作る（手で書かない）。
// DELIVERY_PROBES: エージェント → 1 ターン流して、印ごとに「どこで受け取ったか」を返す関数。
//   偽のプロセス（Devin・Grok・Antigravity・OpenCode）は、届いた mcpServers・環境変数・発言に足した指示を控える。
//   Claude は SDK の query の options を、Codex は app-server の thread/start の config を身代わりにして見る。
//   返りは { evidence: { 印: 証拠 }, seen: 何が届いたかの要約（落ちたときの文に出す） }。
//   対応・補うの印は、届いていなければ false（または無い）。偽のプロセスに控えさせる口は tests/lib/fake-*.mjs。
//
// 渡し物は server と同じく能力の印で絞る（gateRunArgs）。対応でない印の渡し物は最初から渡さない。
// エージェントを足したら DELIVERY_PROBES にも足す（tests/unit/backend-contract.mjs が落とす）。
import fss from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './server.mjs';
import { RUN_ARG_FEATURES, gateRunArgs, isCapabilityState } from '../../core/backends/contract.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';
import { rpc as codexRpc } from '../../core/backends/codex-rpc.mjs';
import { backend as antigravity } from '../../core/backends/antigravity.mjs';
import { backend as opencode, stopOpencodeServer } from '../../core/backends/opencode.mjs';
import { backend as devin } from '../../core/backends/devin.mjs';
import { backend as grok } from '../../core/backends/grok.mjs';
import { opencodeRelay } from '../../core/opencode-relay.mjs';
import { agyHooksFile, grokHooksFile } from '../../core/hooks-plan.mjs';

/** 配達物を持つ印（runArgs で渡すもの）。RUN_ARG_FEATURES の値の集合 */
export const DELIVERY_CAPABILITIES = Object.freeze([...new Set(Object.values(RUN_ARG_FEATURES))]);

/** その印が「対応」か「補う」か（届くことを要求するか）。impossible・todo は要求しない */
export function deliveryRequired(value) {
  return isCapabilityState(value) ? value.state === 'covered' : Boolean(value);
}

// 届いたかを見分ける印。値は偽のプロセスと指示の本文にそのまま出る
export const MARK = Object.freeze({
  instructions: 'PLY-DELIVERY-INSTRUCTIONS',
  agents: 'PLY-DELIVERY-AGENTS',
  browserInstructions: 'PLY-DELIVERY-BROWSER',
  visualize: 'PLY-DELIVERY-VISUALIZE',
  secretName: 'DELIVERY_CHECK_TOKEN',
  secretValue: 'delivery-secret-value',
  browserEnv: Object.freeze({ AGENT_BROWSER_CONFIG: '/tmp/ply-delivery/agent-browser.json', AGENT_BROWSER_SESSION: 'ply-delivery', AGENT_BROWSER_SOCKET_DIR: '/tmp/ply-delivery/sock', AGENT_BROWSER_NAMESPACE: '', AGENT_BROWSER_PIN_TAB: '1', AGENT_BROWSER_IDLE_TIMEOUT_MS: '86400000' }),
  runtime: (name) => ({ url: `http://127.0.0.1:1/mcp/${name}`, headers: { Authorization: `Bearer ${name}-token` } }),
});

const runtime = (name) => MARK.runtime(name);
const instr = (name) => `PLY-DELIVERY-${String(name).toUpperCase()}`;

/**
 * deliveryArgs が渡す runArgs の配達物のキー。`RUN_ARG_FEATURES` にキーを足したら、ここにも足す
 * （backend-contract が、試験で渡していない配達物ができていないかを見る）
 */
export const DELIVERY_ARG_KEYS = Object.freeze([
  'browserEnv', 'browserInstructions', 'browserRuntime', 'computerRuntime', 'contextRuntime', 'controlRuntime',
  'hooksRuntime', 'secretsRuntime', 'shellRuntime', 'agentRuntime', 'addedInstructions', 'visualizeInstructions',
]);

/** 1 ターンに渡す配達物。能力の印で絞る（server の gateRunArgs と同じ） */
export function deliveryArgs(caps, overrides = {}) {
  const useAgents = deliveryRequired(caps?.plyAgents);
  const wantsInstructions = deliveryRequired(caps?.plyInstructions);
  // エージェントのシェルを切れるエージェントだけ、ply_shell の使い方の指示を渡す（server の shellRuntimeFor と同じ）
  const nativeOff = deliveryRequired(caps?.nativeShellOff);
  const text = [wantsInstructions ? MARK.instructions : null, useAgents ? MARK.agents : null].filter(Boolean).join('\n\n');
  const args = {
    prompt: 'delivery check',
    sessionId: null,
    cwd: overrides.cwd,
    mode: overrides.mode ?? 'default',
    emit() {},
    askPermission: async () => ({ allow: true }),
    signal: new AbortController(),
    locale: 'ja',
    hostSessionId: 'delivery-host',
    addedInstructions: !useAgents && text ? text : null,
    agentRuntime: useAgents ? { ...runtime('agents'), instructions: text } : null,
    browserEnv: { ...MARK.browserEnv },
    browserInstructions: MARK.browserInstructions,
    browserRuntime: runtime('browser'),
    computerRuntime: { ...runtime('computer'), instructions: instr('computer') },
    contextRuntime: { ...runtime('context'), prompt: instr('context'), sections: [], owners: { instruction: 'ply', skill: 'ply', mcp: 'ply' } },
    controlRuntime: { ...runtime('control'), instructions: instr('control'), env: { PLEIAD_CONTROL_URL: 'http://127.0.0.1:1', PLEIAD_CONTROL_TOKEN: 'control-token' } },
    hooksRuntime: overrides.hooksRuntime ?? null,
    secretsRuntime: { env: { [MARK.secretName]: MARK.secretValue }, instructions: instr('secrets') },
    shellRuntime: { ...runtime('shell'), nativeOff, instructions: nativeOff ? instr('shell') : null },
    visualizeInstructions: MARK.visualize,
    ...overrides,
  };
  return gateRunArgs(args, caps, { strict: false, log: () => {} });
}

/**
 * Hooks を Pleiad がそろえるターンの runtime（core/hooks-unify.mjs の prepareHooksTurn が返す形）を、登録 1 件で組む。
 * コマンドは印のファイルに 1 行書く（偽のプロセスが実際に動かしたかを、OpenCode の試験が見る）
 */
export async function hookRuntime(scratch, agent) {
  const marker = path.join(scratch, 'hook-ran.txt');
  const script = path.join(scratch, 'delivery-hook.mjs');
  await fs.writeFile(script, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\nprocess.stdout.write('{}');\n`);
  const command = `"${process.execPath}" "${script}"`;
  const hook = { id: 'delivery-hook', name: 'delivery hook', agent, event: 'PreToolUse', command, targets: [agent], enabled: true };
  const d = { event: 'PreToolUse', matcher: '', adapter: false, innerTimeout: null, timeout: 20, async: false, warnings: [] };
  const supplied = [{ hook, d }];
  return {
    agent, cwd: scratch, supplied, record: {}, marker,
    table: { PreToolUse: [{ hooks: [{ type: 'command', command, timeout: 20 }] }] },
    index: [{ event: 'PreToolUse', group: 0, id: hook.id }],
    file: agyHooksFile({ supplied, adapterName: 'delivery-adapter.mjs' }),
    adapter: { name: 'delivery-adapter.mjs', text: '// delivery fixture\n' },
    names: [], shape: 'delivery', emulates: 'claude',
    pluginHooks: grokHooksFile(supplied, { adapterPath: null }),
    compatHookEnv: { GROK_CLAUDE_HOOKS_ENABLED: 'false', GROK_CURSOR_HOOKS_ENABLED: 'false', GROK_CODEX_HOOKS_ENABLED: 'false' },
  };
}

const textOf = (events, sessionId) => events.filter((e) => e.type === 'text.delta' && (!sessionId || e.sessionId === sessionId)).map((e) => e.text).join('');
const jsonOf = (text) => { try { return JSON.parse(text); } catch { return null; } };
const has = (value, needle) => typeof value === 'string' && value.includes(needle);
// ply_shell: 口が届いたか。エージェントのシェルを切れるエージェントは、切る指示も届いているか（server が nativeOff を渡すのはそのときだけ）
const shellDelivered = (caps, serverOk, text) => Boolean(serverOk) && (!deliveryRequired(caps?.nativeShellOff) || has(text, instr('shell')));
const envOf = (env, key, expected) => env?.[key] === expected;
const mcpUrl = (config, name) => config?.[`mcp_servers.${name}`]?.url;

/** 偽のプロセスの起動の環境変数を差し替えて戻す */
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** OpenCode の中継（core/opencode-relay.mjs）を、Pleiad のサーバーの代わりにこのプロセスで受ける */
async function relayOrigin() {
  const relay = await listen((req, res) => { try { opencodeRelay.handle(req, res, new URL(req.url, 'http://127.0.0.1')); } catch { res.writeHead(500); res.end(); } });
  opencodeRelay.setOrigin(relay.origin);
  return relay;
}

/** agy の身代わりが控えた pid を止める（会話の agy は runTurn の後に残る） */
async function killAgy(pidFile) {
  let pids = [];
  try { pids = JSON.parse(await fs.readFile(pidFile, 'utf8')); } catch { return; }
  for (const pid of pids) { try { process.kill(pid); } catch { /* 終わっている */ } }
}

// ---------------------------------------------------------------------------------------------------------------------
// エージェントごとの 1 ターン

/** Claude Code: SDK の query の options（mcpServers・env・systemPrompt.append・hooks）に届いたか */
async function probeClaude({ scratch, caps }) {
  let received = null, envFileText = null;
  const restore = setClaudeSdkForTest({
    executable: () => 'fake-claude',
    query: ({ prompt, options }) => {
      received = options;
      envFileText = options?.env?.CLAUDE_ENV_FILE ? fss.readFileSync(options.env.CLAUDE_ENV_FILE, 'utf8') : null;
      const q = { options, close() {}, initializationResult: async () => ({}), getContextUsage: async () => ({ memoryFiles: [] }), mcpServerStatus: async () => [] };
      q[Symbol.asyncIterator] = async function* () {
        // 最初の発言が届くまで待つ（入力はターンの終わりまで開いたままなので、読み切ろうとしない）
        await prompt.next();
        void (async () => { try { for await (const _ of prompt) { /* 読み捨てる */ } } catch { /* 閉じた */ } })();
        yield { type: 'result', subtype: 'success', num_turns: 1, session_id: 'delivery-claude' };
      };
      return q;
    },
  });
  try {
    await claude.runTurn(deliveryArgs(caps, { cwd: scratch, hooksRuntime: await hookRuntime(scratch, 'claude') }));
  } finally { restore(); }
  const options = received ?? {};
  const append = String(options.systemPrompt?.append ?? '');
  const servers = Object.keys(options.mcpServers ?? {});
  const env = options.env ?? {};
  const seen = { servers, env: Object.keys(env).filter((k) => /^(AGENT_BROWSER_|PLEIAD_|CLAUDE_ENV_FILE)/.test(k)), append: append.slice(0, 400), envFile: String(envFileText ?? '').slice(0, 200) };
  return {
    seen,
    evidence: {
      plyInstructions: has(append, MARK.instructions),
      plyAgents: servers.includes('ply_agents') && has(append, MARK.agents),
      browser: servers.includes('ply_browser') && envOf(env, 'AGENT_BROWSER_CONFIG', MARK.browserEnv.AGENT_BROWSER_CONFIG) && has(append, MARK.browserInstructions),
      plyControl: servers.includes('ply_control') && envOf(env, 'PLEIAD_CONTROL_TOKEN', 'control-token') && has(append, instr('control')),
      secrets: has(envFileText, `${MARK.secretName}='${MARK.secretValue}'`) && has(append, instr('secrets')),
      visualize: has(append, MARK.visualize),
      hooks: Boolean(options.hooks?.PreToolUse?.length),
      plyShell: shellDelivered(caps, servers.includes('ply_shell'), append) && (!deliveryRequired(caps?.nativeShellOff) || (options.disallowedTools ?? []).some((name) => /Bash/.test(name))),
      plyContext: servers.includes('ply_context') && has(append, instr('context')),
      computerUse: servers.includes('ply_computer') && has(append, instr('computer')),
    },
  };
}

/** Codex: app-server の新規 thread/start と再開 thread/resume の config に配達物が届いたか */
async function probeCodex({ scratch, caps }) {
  const log = path.join(scratch, 'codex.log');
  const stateDir = path.join(scratch, 'codex-state');
  await fs.mkdir(stateDir, { recursive: true });
  const hooks = await hookRuntime(scratch, 'codex');
  let sessionId = null;
  await withEnv({ AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, FAKE_CODEX_LOG: log, FAKE_CODEX_STATE_DIR: stateDir }, async () => {
    try {
      const first = await codex.runTurn(deliveryArgs(caps, { cwd: scratch, mode: 'full', hooksRuntime: hooks, autoCompactWindow: 183_000 }));
      sessionId = first.sessionId;
      await codex.runTurn(deliveryArgs(caps, { cwd: scratch, sessionId, mode: 'full', hooksRuntime: hooks, autoCompactWindow: 183_000 }));
    }
    finally { await codexRpc.stop().catch(() => {}); }
  });
  const rows = String(await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => jsonOf(line)).filter(Boolean);
  const start = rows.filter((r) => r.method === 'thread/start').at(-1) ?? {};
  const compactStart = rows.find((r) => r.method === 'thread/start' && r.config?.model_auto_compact_token_limit === 150_000) ?? {};
  const compactResume = rows.find((r) => r.method === 'thread/resume' && r.config?.model_auto_compact_token_limit === 150_000) ?? {};
  const config = start.config ?? {};
  const developer = String(rows.filter((r) => r.method === 'turn/start').at(-1)?.developerInstructions ?? '');
  const shellEnv = config['shell_environment_policy.set'] ?? {};
  const seen = { configKeys: Object.keys(config), developer: developer.slice(0, 400), shellEnv: Object.keys(shellEnv), compactStart: Boolean(compactStart.method), compactResume: Boolean(compactResume.method) };
  return {
    seen,
    evidence: {
      plyInstructions: has(developer, MARK.instructions),
      plyAgents: Boolean(mcpUrl(config, 'ply_agents')) && has(developer, MARK.agents),
      browser: Boolean(mcpUrl(config, 'ply_browser')) && envOf(shellEnv, 'AGENT_BROWSER_CONFIG', MARK.browserEnv.AGENT_BROWSER_CONFIG) && has(developer, MARK.browserInstructions),
      plyControl: Boolean(mcpUrl(config, 'ply_control')) && envOf(shellEnv, 'PLEIAD_CONTROL_TOKEN', 'control-token') && has(developer, instr('control')),
      secrets: envOf(shellEnv, MARK.secretName, MARK.secretValue) && has(developer, instr('secrets')),
      visualize: has(developer, MARK.visualize),
      hooks: Boolean(config.hooks?.PreToolUse?.length),
      plyShell: shellDelivered(caps, Boolean(mcpUrl(config, 'ply_shell')), developer),
      plyContext: Boolean(mcpUrl(config, 'ply_context')) && has(developer, instr('context')),
      computerUse: Boolean(mcpUrl(config, 'ply_computer')) && has(developer, instr('computer')),
      autoCompactWindow: Boolean(compactStart.method && compactResume.method),
    },
  };
}

/** Antigravity: 起動の環境変数・--add-dir の agent.md（mcpServers・指示）・hooks.json・発言に足した指示に届いたか */
async function probeAntigravity({ scratch, caps }) {
  const envFile = path.join(scratch, 'agy-env.json');
  const promptLog = path.join(scratch, 'agy-prompts.log');
  const pidFile = path.join(scratch, 'agy-pids.json');
  const events = { first: [], resumed: [], sibling: [] };
  let sessionId = null;
  try {
    await withEnv({ AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests/lib/fake-agy.mjs')}"`, FAKE_AGY_ENV_FILE: envFile, FAKE_AGY_PROMPT_LOG: promptLog, FAKE_AGY_PID_FILE: pidFile }, async () => {
      const hooksRuntime = await hookRuntime(scratch, 'antigravity');
      const first = await antigravity.runTurn(deliveryArgs(caps, { cwd: scratch, prompt: 'wire-all', shellAppends: ['PLY-DELIVERY-SHELL-RESULT'], hooksRuntime, emit: (e) => events.first.push(e) }));
      sessionId = first.sessionId;
      await antigravity.runTurn(deliveryArgs(caps, { cwd: scratch, sessionId, prompt: 'wire-all', shellAppends: ['PLY-DELIVERY-SHELL-RESUMED'], visualizeInstructions: `${MARK.visualize}-RESUMED`, hooksRuntime, emit: (e) => events.resumed.push(e) }));
      await antigravity.runTurn(deliveryArgs(caps, { cwd: scratch, prompt: 'wire-all', shellAppends: ['PLY-DELIVERY-SHELL-SIBLING'], visualizeInstructions: 'PLY-SIBLING-VISUALIZE-ONLY', hooksRuntime, emit: (e) => events.sibling.push(e) }));
    });
  } finally { await killAgy(pidFile); }
  const seenEntry = jsonOf(String(await fs.readFile(envFile, 'utf8').catch(() => '[]')))?.[0] ?? {};
  const wires = Object.fromEntries(Object.entries(events).map(([key, value]) => [key, String(jsonOf(textOf(value))?.wire ?? '')]));
  const firstMessages = sessionId ? await antigravity.getMessages(sessionId).catch(() => []) : [];
  const siblingSessionId = events.sibling.find((event) => event.type === 'session')?.sessionId ?? null;
  const siblingMessages = siblingSessionId ? await antigravity.getMessages(siblingSessionId).catch(() => []) : [];
  const agentMd = String(seenEntry.agentMd ?? '');
  const env = seenEntry.env ?? {};
  const seen = { env: Object.keys(env).sort(), agent: seenEntry.agent, agentMd: agentMd.slice(0, 400), hooks: String(seenEntry.hooksJson ?? '').slice(0, 200), wire: wires.first.slice(0, 200) };
  return {
    seen,
    evidence: {
      plyInstructions: has(wires.first, MARK.instructions),
      plyAgents: has(wires.first, MARK.agents) && has(agentMd, '--agents'),
      browser: envOf(env, 'AGENT_BROWSER_CONFIG', MARK.browserEnv.AGENT_BROWSER_CONFIG) && has(agentMd, '--browser') && has(agentMd, MARK.browserInstructions),
      plyControl: envOf(env, 'PLEIAD_CONTROL_TOKEN', 'control-token') && has(agentMd, '--control') && has(agentMd, instr('control')),
      secrets: envOf(env, MARK.secretName, MARK.secretValue) && has(agentMd, instr('secrets')),
      visualize: has(wires.first, MARK.visualize) && has(wires.resumed, `${MARK.visualize}-RESUMED`),
      shell: has(wires.first, 'PLY-DELIVERY-SHELL-RESULT') && has(wires.resumed, 'PLY-DELIVERY-SHELL-RESUMED'),
      conversationIsolation: has(wires.sibling, 'PLY-SIBLING-VISUALIZE-ONLY') && !has(wires.sibling, `${MARK.visualize}-RESUMED`)
        && !siblingMessages.some((message) => /PLY-DELIVERY-(?:VISUALIZE|SHELL-RESUMED)/.test(message.text ?? '')),
      instructionsStayOutOfHistory: !firstMessages.some((message) => /PLY-DELIVERY-(?:INSTRUCTIONS|AGENTS|VISUALIZE)/.test(message.text ?? '')),
      hooks: has(String(seenEntry.hooksJson ?? ''), 'pleiad-delivery-hook'),
      plyContext: envOf(env, 'PLY_CONTEXT_URL', runtime('context').url) && has(agentMd, '--context') && has(agentMd, instr('context')),
      computerUse: envOf(env, 'PLY_COMPUTER_URL', runtime('computer').url) && has(agentMd, '--computer') && has(agentMd, instr('computer')),
    },
  };
}

/** OpenCode: 中継（opencodeRelay）に結び付いた口・環境変数・system・Hooks に届いたか */
async function probeOpenCode({ scratch, caps }) {
  const config = path.join(scratch, 'xdg');
  await fs.mkdir(path.join(config, 'opencode'), { recursive: true });
  const relay = await relayOrigin();
  const events = [];
  let sessionId = null;
  try {
    await withEnv({ AGENT_HOST_OPENCODE_BIN: `node "${path.join(ROOT, 'tests/lib/fake-opencode.mjs')}"`, XDG_CONFIG_HOME: config, FAKE_OPENCODE_STATE_DIR: path.join(scratch, 'oc-state') }, async () => {
      const hooks = await hookRuntime(scratch, 'opencode');
      try {
        const result = await opencode.runTurn(deliveryArgs(caps, { cwd: scratch, mode: 'full', hooksRuntime: hooks, emit: (e) => events.push(e) }));
        sessionId = result?.sessionId ?? null;
      } finally { await stopOpencodeServer().catch(() => {}); }
    });
    const token = opencodeRelay.token('login');
    const get = async (query) => (await fetch(`${relay.origin}/mcp/opencode/env?${query}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const context = sessionId ? await get(`kind=context&session=${encodeURIComponent(sessionId)}&account=login`).catch(() => ({})) : {};
    const env = sessionId ? await get(`session=${encodeURIComponent(sessionId)}&account=login`).catch(() => ({})) : {};
    // プラグインの tool.execute.before と同じ口を叩く（Hooks が中継に結び付いているか）
    if (sessionId) await fetch(`${relay.origin}/mcp/opencode/hook?account=login`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session: sessionId, phase: 'before', tool: 'bash', args: { command: 'echo delivery' } }) }).catch(() => {});
    const hookRan = Boolean(await fs.stat(path.join(scratch, 'hook-ran.txt')).catch(() => null));
    const system = String(context.system ?? '');
    const servers = context.requiredServers ?? [];
    const seen = { servers, env: Object.keys(env ?? {}).sort(), system: system.slice(0, 400), hookRan, sessionId };
    return {
      seen,
      evidence: {
        plyInstructions: has(system, MARK.instructions),
        plyAgents: servers.includes('ply_agents') && has(system, MARK.agents),
        browser: servers.includes('ply_browser') && envOf(env, 'AGENT_BROWSER_CONFIG', MARK.browserEnv.AGENT_BROWSER_CONFIG) && has(system, MARK.browserInstructions),
        plyControl: servers.includes('ply_control') && envOf(env, 'PLEIAD_CONTROL_TOKEN', 'control-token') && has(system, instr('control')),
        secrets: envOf(env, MARK.secretName, MARK.secretValue) && has(system, instr('secrets')),
        visualize: has(system, MARK.visualize),
        hooks: hookRan,
        plyShell: shellDelivered(caps, servers.includes('ply_shell'), system),
        plyContext: servers.includes('ply_context') && has(system, instr('context')),
        computerUse: servers.includes('ply_computer') && has(system, instr('computer')),
      },
    };
  } finally {
    if (sessionId) { try { opencode.forget?.(sessionId, null); } catch { /* 無い */ } }
    await relay.close();
  }
}

/** Devin: ACP の session/new の mcpServers・起動の環境変数・発言に足した指示に届いたか */
async function probeDevin({ scratch, caps }) {
  const events = [];
  try {
    await withEnv({ AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"`, DEVIN_CONFIG_HOME: path.join(scratch, 'devin-home') }, async () => {
      await devin.runTurn(deliveryArgs(caps, { cwd: scratch, mode: 'smart', prompt: '[env]', emit: (e) => events.push(e) }));
    });
  } finally { /* runTurn が ACP を閉じる */ }
  const observed = jsonOf(textOf(events)) ?? {};
  const prompt = String(observed.prompt ?? '');
  const seen = { servers: observed.mcpServers ?? [], env: observed.seenEnv ?? [], prompt: prompt.slice(0, 300) };
  return {
    seen,
    evidence: {
      plyInstructions: has(prompt, MARK.instructions),
      plyAgents: (observed.mcpServers ?? []).includes('ply_agents') && has(prompt, MARK.agents),
      browser: (observed.mcpServers ?? []).includes('ply_browser') && (observed.seenEnv ?? []).includes('AGENT_BROWSER_CONFIG') && has(prompt, MARK.browserInstructions),
      plyControl: (observed.mcpServers ?? []).includes('ply_control') && (observed.seenEnv ?? []).includes('PLEIAD_CONTROL_TOKEN') && has(prompt, instr('control')),
      secrets: (observed.seenEnv ?? []).includes(MARK.secretName) && has(prompt, instr('secrets')),
      visualize: has(prompt, MARK.visualize),
      plyShell: shellDelivered(caps, (observed.mcpServers ?? []).includes('ply_shell'), prompt),
      plyContext: (observed.mcpServers ?? []).includes('ply_context') && has(prompt, instr('context')),
      computerUse: (observed.mcpServers ?? []).includes('ply_computer') && has(prompt, instr('computer')),
    },
  };
}

/** Grok: ACP の session/new の mcpServers・環境変数・ターンのプラグインの hooks・発言に足した指示に届いたか */
async function probeGrok({ scratch, caps }) {
  const events = [];
  const home = path.join(scratch, 'grok-home');
  await fs.mkdir(home, { recursive: true });
  try {
    await withEnv({ AGENT_HOST_GROK_BIN: `node "${path.join(ROOT, 'tests/lib/fake-grok.mjs')}"`, GROK_HOME: home, AGENT_HOST_GROK_HOME: home }, async () => {
      await grok.runTurn(deliveryArgs(caps, { cwd: scratch, mode: 'accept-edits', prompt: '[env]', hooksRuntime: await hookRuntime(scratch, 'grok'), emit: (e) => events.push(e) }));
    });
  } finally { /* runTurn が ACP を閉じる */ }
  const observed = jsonOf(textOf(events)) ?? {};
  const prompt = String(observed.prompt ?? '');
  const hookText = JSON.stringify(observed.hooks ?? []);
  const seen = { servers: observed.mcpServers ?? [], env: observed.seenEnv ?? [], hooks: hookText.slice(0, 200), prompt: prompt.slice(0, 300) };
  return {
    seen,
    evidence: {
      plyInstructions: has(prompt, MARK.instructions),
      plyAgents: (observed.mcpServers ?? []).includes('ply_agents') && has(prompt, MARK.agents),
      browser: (observed.mcpServers ?? []).includes('ply_browser') && (observed.seenEnv ?? []).includes('AGENT_BROWSER_CONFIG') && has(prompt, MARK.browserInstructions),
      plyControl: (observed.mcpServers ?? []).includes('ply_control') && (observed.seenEnv ?? []).includes('PLEIAD_CONTROL_TOKEN') && has(prompt, instr('control')),
      secrets: (observed.seenEnv ?? []).includes(MARK.secretName) && has(prompt, instr('secrets')),
      visualize: has(prompt, MARK.visualize),
      hooks: has(hookText, 'delivery-hook.mjs') && (observed.seenEnv ?? []).includes('GROK_CLAUDE_HOOKS_ENABLED'),
      plyShell: shellDelivered(caps, (observed.mcpServers ?? []).includes('ply_shell'), prompt)
        && (!deliveryRequired(caps?.nativeShellOff) || observed.nativeShellOff === true),
      computerUse: (observed.mcpServers ?? []).includes('ply_computer') && has(prompt, instr('computer')),
    },
  };
}

/** エージェント → 1 ターン流して、印ごとの証拠を返す関数（{ scratch, caps } を受ける） */
export const DELIVERY_PROBES = Object.freeze({
  claude: probeClaude,
  codex: probeCodex,
  antigravity: probeAntigravity,
  opencode: probeOpenCode,
  devin: probeDevin,
  grok: probeGrok,
});

/** 印ごとの、どこに届くはずかの短い説明（落ちたときの文に出す） */
export const DELIVERY_HINTS = Object.freeze({
  plyInstructions: '発言の前に足す指示（Claude は systemPrompt.append、Codex は developerInstructions、ほかは発言の本文）',
  plyAgents: 'ply_agents の MCP の登録と、その instructions',
  browser: 'AGENT_BROWSER_* の環境変数・ply_browser の MCP・ブラウザーの指示',
  plyControl: 'ply_control の MCP・PLEIAD_CONTROL_* の環境変数・使い方の指示',
  secrets: '秘密情報の環境変数と、名前だけの一覧の指示',
  visualize: '可視化の指示（visualizeInstructions）',
  hooks: 'Pleiad がそろえる Hooks（コールバック・config.hooks・hooks.json・ターンのプラグイン）',
  plyShell: 'ply_shell の MCP・使い方の指示（nativeOff ならエージェントのシェルを切る）',
  plyContext: 'ply_context の MCP と、コンテキストの指示',
  computerUse: 'ply_computer の MCP と、使い方の指示',
});

/**
 * 印が対応なのに、そのエージェントで届くことを確かめる試験が無いときの文（あれば null）。
 * tests/unit/backend-contract.mjs が、印の値と DELIVERY_PROBES から機械的に呼ぶ（エージェント・配達物を足したときに漏れない）
 */
export function deliveryContractProblem({ key, id, suite, suites, probes = DELIVERY_PROBES, file = null }) {
  if (typeof suite === 'string' && suites?.has(suite) && typeof probes?.[id] === 'function') return null;
  return `どこに何を書くか: tests/lib/backend-delivery.mjs の DELIVERY_PROBES に ${id} の probe（1 ターン流して ${key} の届け方を返す）を書き、`
    + `tests/lib/backend-contracts.mjs の CAPABILITY_CONTRACTS.${key}.agents.${id} に 'backend-delivery' を書く。`
    + `（印 ${key} が対応でないなら ${file ? `core/backends/${file}` : `core/backends/${id}.mjs`} の宣言を見直す）`;
}
