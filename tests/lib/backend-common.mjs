// 全エージェントに共通の試験（tests/unit/backend-common.mjs）の道具。宣言（core/backends/*.mjs の能力の印・agents.mjs）から回す。
//
// RIGS: エージェントごとの身代わり（LLM を呼ばない）でサーバーを起こす形。エージェントを足すときは、身代わり（tests/lib/fake-<id>.mjs）を書き、
//   ここに 1 つ足す。core/backends/agents.mjs のエージェント（fake を含む）に RIGS が無いと backend-contract が落とす。
//   slow は中断されるまで終わらない発言、fail は失敗で終わる発言（エージェントごとの身代わりの合図）。
//   running は、slow の発言が走り出したと見なすイベントの type（省くと会話の id が決まった時点。OpenCode は発言が渡る前の中断が error になるので tool.start まで待つ）。
// 共通の流れ（checkConformance・checkAbort・checkError・checkResume）: 全エージェント（fake を含む）が、同じ検査を通る。
// 配達物（runArgs の機能の渡し物）: エージェントごとの偽のプロセス・プロトコルに 1 ターン流して、どこで受け取ったかを見る（issue #146）。
//   DELIVERY_PROBES: エージェント → 1 ターン流して { seen, evidence } を返す関数。evidence は { 印: 届いたか }。
//     偽のプロセス（Devin・Grok・Antigravity・OpenCode）は、届いた mcpServers・環境変数・発言に足した指示を控える（tests/lib/fake-*.mjs）。
//     Claude は SDK の query の options を、Codex は app-server の thread/start の config を身代わりにして見る。
//   probeVerdict: 証拠を宣言に照らす。次の 3 つを落とす（tests/unit/backend-common.mjs）。
//     (1) 対応（補う）の印の証拠が無い・偽 (2) 宣言が対応でない印なのに証拠が真（宣言が古い） (3) 知らない証拠が出ている
//     証拠が要る印 = capability-marks.mjs の probe: true（PROBE_MARKS。runArgs の配達物の印は全部これ）+ そのエージェントの EXTRA_PROBES。
//
// 渡し物は server と同じく能力の印で絞る（gateRunArgs）。対応でない印の渡し物は最初から渡さない。
// エージェントを足したら RIGS と DELIVERY_PROBES にも足す（tests/unit/backend-contract.mjs が落とす）。
import fss from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { ROOT } from './server.mjs';
import { installFakeClaude } from './fake-claude.mjs';
import { AGENTS } from '../../core/backends/agents.mjs';
import { CAPABILITIES, RUN_ARG_FEATURES, gateRunArgs, isCapabilityState } from '../../core/backends/contract.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';
import { rpc as codexRpc } from '../../core/backends/codex-rpc.mjs';
import { backend as antigravity } from '../../core/backends/antigravity.mjs';
import { backend as opencode, stopOpencodeServer } from '../../core/backends/opencode.mjs';
import { backend as devin } from '../../core/backends/devin.mjs';
import { backend as grok } from '../../core/backends/grok.mjs';
import { opencodeRelay } from '../../core/opencode-relay.mjs';
import { agyHooksFile, grokHooksFile } from '../../core/hooks-plan.mjs';

const node = (file) => `node "${path.join(ROOT, 'tests/lib', file)}"`;
const dir = async (...parts) => { const p = path.join(...parts); await fs.mkdir(p, { recursive: true }); return p; };

export const RIGS = {
  fake: async (scratch) => ({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_STATE_DIR: await dir(scratch, 'fake-state') }, prompt: (text) => text, slow: 'slow', fail: 'fail' }),
  claude: async (scratch) => {
    const cli = await installFakeClaude(path.join(scratch, 'cli'));
    const config = await dir(scratch, 'claude-config');
    return {
      env: { AGENT_HOST_BACKENDS: 'claude', ...cli.env, CLAUDE_CONFIG_DIR: config }, prompt: (text) => text,
      slow: `script:${JSON.stringify({ steps: [{ slow: true }, { text: 'never' }] })}`,
      fail: `script:${JSON.stringify({ steps: [{ text: 'partial' }, { fail: true }] })}`,
    };
  },
  // codex・opencode は身代わりの会話を state-dir に残す（サーバーを起こし直しても続きが出る）。agy は home の下に残す（実機と同じ置き場。本物の home を汚さない）
  codex: async (scratch) => ({ env: { AGENT_HOST_BACKENDS: 'codex', AGENT_HOST_CODEX_BIN: node('fake-codex.mjs'), FAKE_CODEX_STATE_DIR: await dir(scratch, 'codex-state') }, prompt: (text) => text, slow: 'slow', fail: 'fail-turn' }),
  antigravity: async (scratch) => {
    const home = await dir(scratch, 'agy-home');
    return { env: { AGENT_HOST_BACKENDS: 'antigravity', AGENT_HOST_AGY_BIN: node('fake-agy.mjs'), USERPROFILE: home, HOME: home }, prompt: (text) => text, slow: 'slow', fail: 'fail' };
  },
  opencode: async (scratch) => ({ env: { AGENT_HOST_BACKENDS: 'opencode', AGENT_HOST_OPENCODE_BIN: node('fake-opencode.mjs'), FAKE_OPENCODE_STATE_DIR: await dir(scratch, 'oc-state') }, prompt: (text) => text, slow: 'slow', fail: 'fail', running: 'tool.start' }),
  devin: async () => ({ env: { AGENT_HOST_BACKENDS: 'devin', AGENT_HOST_DEVIN_BIN: node('fake-devin.mjs') }, prompt: (text) => text, slow: '[slow]', fail: '[fail]' }),
  grok: async (scratch) => ({ env: { AGENT_HOST_BACKENDS: 'grok', AGENT_HOST_GROK_BIN: node('fake-grok.mjs'), GROK_HOME: await dir(scratch, 'grok-home') }, prompt: (text) => text, slow: '[slow]', fail: '[fail]' }),
};

/** 各エージェントのラップ前のバックエンド（能力の印を読むだけ。ターンは始めない） */
export async function loadNatives(ids = Object.keys(AGENTS)) {
  const natives = {};
  for (const id of ids) natives[id] = (await import(new URL(`../../core/backends/${AGENTS[id].module.replace(/^\.\//, '')}`, import.meta.url))).backend;
  return natives;
}

// ---------------------------------------------------------------------------------------------------------------------
// 共通の流れ

/**
 * 全バックエンドが守る共通の契約。c は ws-client の接続。
 * 確かめること: 新しい会話の 1 ターン（ok・会話の id・turnResult はちょうど 1 つ）、履歴の形と読み直しで変わらない uuid、一覧の行、
 * 続きのターン（前の発言の uuid が変わらない）、タイトル（ネイティブでも Pleiad の控えでも）、発言の手前までの分岐（ネイティブでも Pleiad の写しでも）
 */
export async function checkConformance(t, c, { id, cwd, prompt }) {
  const label = (s) => `${id}: ${s}`;
  const first = await c.runTurn({ backend: id, cwd, prompt: prompt('contract alpha') }, { ms: 120_000 });
  const sid = first.sessionId;
  const results = first.events.filter((e) => e.type === 'turnResult' && e.sessionId === sid);
  t.ok(label('新しい会話の 1 ターンが ok で終わり、会話の id が決まる'), first.outcome === 'ok' && typeof sid === 'string' && sid.length > 0, JSON.stringify({ outcome: first.outcome, sid }));
  t.ok(label('turnResult はちょうど 1 つ'), results.length === 1, String(results.length));
  t.ok(label('本文が流れる（text.delta）'), first.events.some((e) => e.type === 'text.delta' && e.sessionId === sid));
  const firstDelta = first.events.findIndex((e) => e.type === 'text.delta' && e.sessionId === sid);
  t.ok(label('送信から最初の応答まで稼働表示が出る'), firstDelta > -1 && first.events.slice(0, firstDelta).some((e) => e.type === 'activity'));

  const load = () => c.cmd('loadSession', { sessionId: sid });
  const a = await load();
  const users = a.messages.filter((m) => m.role === 'user');
  const assistants = a.messages.filter((m) => m.role === 'assistant');
  t.ok(label('履歴に自分の発言と返答がある'), users.some((m) => String(m.text).includes('contract alpha')) && assistants.length >= 1, JSON.stringify(a.messages.map((m) => [m.role, m.text])));
  t.ok(label('発言はどれも uuid と role を持つ'), a.messages.every((m) => typeof m.uuid === 'string' && m.uuid && ['user', 'assistant', 'system'].includes(m.role)));
  t.ok(label('読み直しても履歴は同じ'), JSON.stringify(a.messages) === JSON.stringify((await load()).messages));

  const row = (await c.cmd('listSessions')).find((s) => s.id === sid);
  t.ok(label('一覧にこのエージェントの会話として出る'), row?.backend === id && row?.cwd === cwd, JSON.stringify(row));

  const second = await c.runTurn({ sessionId: sid, prompt: prompt('contract beta') }, { ms: 120_000 });
  const b = await load();
  t.ok(label('続きのターンも ok'), second.outcome === 'ok' && b.messages.filter((m) => m.role === 'user').length === users.length + 1, JSON.stringify(b.messages.map((m) => [m.role, m.text])));
  const secondDelta = second.events.findIndex((e) => e.type === 'text.delta' && e.sessionId === sid);
  t.ok(label('続きのターンでも送信から最初の応答まで稼働表示が出る'), secondDelta > -1 && second.events.slice(0, secondDelta).some((e) => e.type === 'activity'));
  t.ok(label('続きのターンで前の発言の uuid が変わらない'), a.messages.every((m, i) => b.messages[i]?.uuid === m.uuid), JSON.stringify([a.messages.map((m) => m.uuid), b.messages.map((m) => m.uuid)]));

  await c.cmd('setTitle', { sessionId: sid, title: 'contract title' });
  t.ok(label('タイトルを付けられる（ネイティブか Pleiad の控え）'), (await c.cmd('listSessions')).find((s) => s.id === sid)?.title === 'contract title');

  const boundary = b.messages.findIndex((m) => m.role === 'assistant');
  const fork = await c.cmd('fork', { sessionId: sid, upToMessageId: b.messages[boundary].uuid, title: 'contract fork' });
  const child = await c.cmd('loadSession', { sessionId: fork.sessionId });
  // uuid は同じとは限らない（Claude のネイティブの分岐は振り直す）。役割と本文が同じ
  t.ok(label('発言の手前までの分岐は、その発言までをそのまま持つ'), child.messages.length === boundary + 1
    && child.messages.every((m, i) => m.role === b.messages[i].role && m.text === b.messages[i].text), JSON.stringify(child.messages.map((m) => [m.role, m.text])));
  t.ok(label('分岐しても元の会話は変わらない'), JSON.stringify(b) === JSON.stringify(await load()));
  return { sessionId: sid };
}

/** 中断: 走っている最中に止めると、turnResult はちょうど 1 つで outcome は aborted（成功にも失敗にもならない） */
export async function checkAbort(t, c, { id, cwd, rig }) {
  const label = (s) => `${id}: ${s}`;
  const mark = c.mark();
  const turn = c.runTurn({ backend: id, cwd, prompt: rig.slow }, { ms: 60_000 });
  turn.catch(() => {});
  const started = await c.waitFor((e) => e.type === 'session', { ms: 30_000, from: mark });
  const sid = started.sessionId;
  // 発言がエージェントに渡って走り出すまで待つ（その前の中断は、エージェントによって error になる競り合いがある）
  if (rig.running) await c.waitFor((e) => e.type === rig.running && e.sessionId === sid, { ms: 30_000, from: mark });
  const stopped = await c.cmd('abort', { sessionId: sid });
  const done = await turn;
  const results = c.since(mark).filter((e) => e.type === 'turnResult' && e.sessionId === sid);
  t.ok(label('走っているターンを中断できる'), stopped.aborted === 1, JSON.stringify(stopped));
  t.ok(label('中断のターンの turnResult はちょうど 1 つで outcome は aborted'), results.length === 1 && results[0].outcome === 'aborted' && done.outcome === 'aborted', JSON.stringify(results.map((e) => e.outcome)));
}

/** エラー: 失敗のターンは turnResult に error を載せて終わり、サーバーは落ちずに後のターンに答える */
export async function checkError(t, c, { id, cwd, rig }) {
  const label = (s) => `${id}: ${s}`;
  const mark = c.mark();
  const failed = await c.runTurn({ backend: id, cwd, prompt: rig.fail }, { ms: 60_000 });
  const results = c.since(mark).filter((e) => e.type === 'turnResult');
  t.ok(label('失敗のターンは turnResult がちょうど 1 つで、outcome は error・error に理由が載る'),
    results.length === 1 && results[0].outcome === 'error' && typeof results[0].error === 'string' && results[0].error.length > 0 && failed.outcome === 'error',
    JSON.stringify(results.map((e) => [e.outcome, e.error])));
  const later = await c.runTurn({ backend: id, cwd, prompt: rig.prompt('contract after error') }, { ms: 120_000 });
  t.ok(label('失敗の後も、サーバーは生きていて新しいターンに答える'), later.outcome === 'ok' && later.events.some((e) => e.type === 'text.delta'), JSON.stringify({ outcome: later.outcome }));
}

/**
 * 再起動の後の続き: サーバーを止めて同じデータ置き場・同じトークンで起こし直し、同じ会話の続きのターンが通る（履歴も残る）。
 * state = { server, c } を新しいものに差し替える（呼び出し側が後片付けに使う）
 */
export async function checkResume(t, state, { id, cwd, rig, sessionId, dataDir, timeoutMs = 60_000 }) {
  const label = (s) => `${id}: ${s}`;
  const { startServer } = await import('./server.mjs');
  const { open } = await import('./ws-client.mjs');
  const { server: before, c: oldClient } = state;
  oldClient.close();
  await before.stop();
  state.server = await startServer({ dataDir, env: { ...rig.env, AGENT_HOST_TOKEN: before.token }, timeoutMs });
  state.c = await open({ port: state.server.port, token: state.server.token, autoAllow: true });
  const c = state.c;
  const loaded = await c.cmd('loadSession', { sessionId });
  const users = loaded.messages.filter((m) => m.role === 'user');
  t.ok(label('サーバーを起こし直しても、会話の履歴が残っている'), users.some((m) => String(m.text).includes('contract alpha')) && users.some((m) => String(m.text).includes('contract beta')),
    JSON.stringify(loaded.messages.map((m) => [m.role, m.text])));
  const resumed = await c.runTurn({ sessionId, prompt: rig.prompt('contract gamma') }, { ms: 120_000 });
  const after = await c.cmd('loadSession', { sessionId });
  t.ok(label('起こし直しの後も、同じ会話の続きのターンが ok で終わる'), resumed.outcome === 'ok' && resumed.sessionId === sessionId
    && after.messages.filter((m) => m.role === 'user').length === users.length + 1, JSON.stringify({ outcome: resumed.outcome, sessionId: resumed.sessionId }));
  void cwd;
}

// ---------------------------------------------------------------------------------------------------------------------
// 配達物

/** 配達物の印が、対応か補うか（届くことを要求するか）。impossible・todo は要求しない */
export function deliveryRequired(value) {
  return isCapabilityState(value) ? value.state === 'covered' : Boolean(value);
}

/** 全エージェントで確かめる印（capability-marks.mjs の probe: true） */
export const PROBE_MARKS = Object.freeze(Object.entries(CAPABILITIES).filter(([, spec]) => spec.probe).map(([key]) => key));

/**
 * 一部のエージェントだけが確かめる証拠。印（autoCompactWindow・nativeShellOff・compatEndpoints・shell）は対応のときだけ要求し、
 * 印でないもの（会話の分離など）は常に要求する。エージェントの新しい証拠を足したら、ここにも書く（無いと「知らない証拠」で落ちる）
 */
export const EXTRA_PROBES = Object.freeze({
  codex: ['autoCompactWindow'],
  devin: ['nativeShellOff'],
  grok: ['compatEndpoints'],
  antigravity: ['shell', 'conversationIsolation', 'instructionsStayOutOfHistory'],
});

/**
 * 証拠を宣言に照らす（純粋な関数）。caps はそのエージェントの能力の印、result は probe の返り。
 *   required: 要る証拠 / missing: 要るのに無い / notDelivered: あるが偽（届いていない）
 *   unknown: 知らない証拠 / stale: 宣言が対応でない印なのに証拠が真（宣言が古い）
 */
export function probeVerdict({ id, caps, result, extras = EXTRA_PROBES[id] ?? [] }) {
  const evidence = result?.evidence ?? {};
  const known = [...PROBE_MARKS, ...extras];
  const required = known.filter((key) => !Object.hasOwn(CAPABILITIES, key) || deliveryRequired(caps?.[key]));
  return {
    required,
    missing: required.filter((key) => !Object.hasOwn(evidence, key)),
    notDelivered: required.filter((key) => Object.hasOwn(evidence, key) && !evidence[key]),
    unknown: Object.keys(evidence).filter((key) => !known.includes(key)),
    // 宣言が対応でない印は渡し物を絞って渡さないので、証拠は偽になる。真なら、宣言が古い（届くのに impossible・todo と書いている）
    stale: Object.keys(evidence).filter((key) => known.includes(key) && !required.includes(key) && evidence[key] === true),
  };
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
 * deliveryArgs が渡す runArgs の配達物のキー。`RUN_ARG_FEATURES` から作る（手で写さない）。
 * キーを足したら deliveryArgs にも足す（backend-contract が、deliveryArgs が全部のキーを渡すかを見る）
 */
export const DELIVERY_ARG_KEYS = Object.freeze(Object.keys(RUN_ARG_FEATURES));

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
  let received = null, envFileText = null, envValuesText = null, mcpConfText = null;
  const restore = setClaudeSdkForTest({
    executable: () => 'fake-claude',
    query: ({ prompt, options }) => {
      received = options;
      envFileText = options?.env?.CLAUDE_ENV_FILE ? fss.readFileSync(options.env.CLAUDE_ENV_FILE, 'utf8') : null;
      // 値ファイル: CLAUDE_ENV_FILE のスクリプトが読む .vals（ADR 0284。値はこちらにだけある。スクリプトの中身は argv に載る）
      const valsPath = envFileText && /\. '([^']+\.vals)'/.exec(envFileText)?.[1];
      envValuesText = valsPath && fss.existsSync(valsPath) ? fss.readFileSync(valsPath, 'utf8') : null;
      // HTTP の MCP は --mcp-config のファイルに載る（トークンを argv に出さない）
      const mcpConf = options?.extraArgs?.['mcp-config'];
      mcpConfText = mcpConf && fss.existsSync(mcpConf) ? fss.readFileSync(mcpConf, 'utf8') : null;
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
  // 届いた MCP の一覧 = インプロセスの sdk 型（options.mcpServers）+ --mcp-config のファイルの中身
  const servers = [...Object.keys(options.mcpServers ?? {}), ...Object.keys((JSON.parse(mcpConfText ?? '{}').mcpServers) ?? {})];
  const env = options.env ?? {};
  const seen = { servers, env: Object.keys(env).filter((k) => /^(AGENT_BROWSER_|PLEIAD_|CLAUDE_ENV_FILE)/.test(k)), append: append.slice(0, 400), envFile: String(envFileText ?? '').slice(0, 200) };
  return {
    seen,
    evidence: {
      plyInstructions: has(append, MARK.instructions),
      plyAgents: servers.includes('ply_agents') && has(append, MARK.agents),
      browser: servers.includes('ply_browser') && envOf(env, 'AGENT_BROWSER_CONFIG', MARK.browserEnv.AGENT_BROWSER_CONFIG) && has(append, MARK.browserInstructions),
      plyControl: servers.includes('ply_control') && envOf(env, 'PLEIAD_CONTROL_TOKEN', 'control-token') && has(append, instr('control')),
      // 値は .vals にだけあり、スクリプトの中身（argv に載る）には無い。MCP のトークンはファイルにあり options.mcpServers には無い
      secrets: has(envValuesText, `${MARK.secretName}='${MARK.secretValue}'`) && !has(envFileText, MARK.secretValue) && has(append, instr('secrets')),
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
  await withEnv({ AGENT_HOST_CODEX_BIN: node('fake-codex.mjs'), FAKE_CODEX_LOG: log, FAKE_CODEX_STATE_DIR: stateDir }, async () => {
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
    await withEnv({ AGENT_HOST_AGY_BIN: node('fake-agy.mjs'), FAKE_AGY_ENV_FILE: envFile, FAKE_AGY_PROMPT_LOG: promptLog, FAKE_AGY_PID_FILE: pidFile }, async () => {
      const hooksRuntime = await hookRuntime(scratch, 'antigravity');
      const first = await antigravity.runTurn(deliveryArgs(caps, { cwd: scratch, prompt: 'wire-all', shellAppends: ['PLY-DELIVERY-SHELL-RESULT'], hooksRuntime, emit: (e) => events.first.push(e) }));
      sessionId = first.sessionId;
      await antigravity.runTurn(deliveryArgs(caps, { cwd: scratch, sessionId, prompt: 'wire-all', shellAppends: ['PLY-DELIVERY-SHELL-RESUMED'], visualizeInstructions: `${MARK.visualize}-RESUMED`, hooksRuntime, emit: (e) => events.resumed.push(e) }));
      await antigravity.runTurn(deliveryArgs(caps, { cwd: scratch, prompt: 'wire-all', shellAppends: ['PLY-DELIVERY-SHELL-SIBLING'], visualizeInstructions: 'PLY-SIBLING-VISUALIZE-ONLY', hooksRuntime, emit: (e) => events.sibling.push(e) }));
    });
  } finally { await killAgy(pidFile); }
  // 起こされた agy は全部ここに控えられる（--version・models・acp）。会話の agy は --agent を持つ 1 本目
  const spawnedEntries = jsonOf(String(await fs.readFile(envFile, 'utf8').catch(() => '[]'))) ?? [];
  const seenEntry = spawnedEntries.find((entry) => entry?.agent) ?? spawnedEntries.find((entry) => entry?.agentMd) ?? spawnedEntries[0] ?? {};
  const wires = Object.fromEntries(Object.entries(events).map(([key, value]) => [key, String(jsonOf(textOf(value))?.wire ?? '')]));
  const firstMessages = sessionId ? await antigravity.getMessages(sessionId).catch(() => []) : [];
  const siblingSessionId = events.sibling.find((event) => event.type === 'session')?.sessionId ?? null;
  const siblingMessages = siblingSessionId ? await antigravity.getMessages(siblingSessionId).catch(() => []) : [];
  const agentMd = String(seenEntry.agentMd ?? '');
  const env = seenEntry.env ?? {};
  const seen = { env: Object.keys(env).sort(), agent: seenEntry.agent, agentMd: agentMd.slice(0, 400), hooks: String(seenEntry.hooksJson ?? '').slice(0, 200), wire: wires.first.slice(0, 200), history: firstMessages.map((message) => `${message.role}: ${String(message.text ?? '').slice(0, 120)}`) };
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
      // 身代わりは受けた発言の全体（wire）を返答に写すので、見るのは自分の発言（user）の側だけ
      instructionsStayOutOfHistory: firstMessages.some((message) => message.role === 'user')
        && !firstMessages.some((message) => message.role === 'user' && /PLY-DELIVERY-(?:INSTRUCTIONS|AGENTS|VISUALIZE)/.test(message.text ?? '')),
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
    await withEnv({ AGENT_HOST_OPENCODE_BIN: node('fake-opencode.mjs'), XDG_CONFIG_HOME: config, FAKE_OPENCODE_STATE_DIR: path.join(scratch, 'oc-state') }, async () => {
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
  const configCapture = path.join(scratch, 'devin-turn-config.json');
  try {
    await withEnv({ AGENT_HOST_DEVIN_BIN: node('fake-devin.mjs'), DEVIN_CONFIG_HOME: path.join(scratch, 'devin-home'),
      FAKE_DEVIN_CONFIG_CAPTURE: configCapture }, async () => {
      await devin.runTurn(deliveryArgs(caps, { cwd: scratch, mode: 'smart', prompt: '[env]', hooksRuntime: await hookRuntime(scratch, 'devin'), emit: (e) => events.push(e) }));
    });
  } finally { /* runTurn が ACP を閉じる */ }
  const observed = jsonOf(textOf(events)) ?? {};
  const config = JSON.parse(await fs.readFile(configCapture, 'utf8').catch(() => '{}'));
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
      hooks: config.hooks?.PreToolUse?.some(group => group.hooks?.some(h => h.type === 'command' && h.command.includes('delivery-hook.mjs')))
        && config.read_config_from?.claude === false,
      plyShell: shellDelivered(caps, (observed.mcpServers ?? []).includes('ply_shell'), prompt),
      nativeShellOff: ['exec', 'shell_command', 'write_to_process', 'kill_shell', 'get_output'].every(name => config.disabled_tools?.includes(name)),
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
    await withEnv({ AGENT_HOST_GROK_BIN: node('fake-grok.mjs'), GROK_HOME: home, AGENT_HOST_GROK_HOME: home }, async () => {
      await grok.runTurn(deliveryArgs(caps, { cwd: scratch, mode: 'accept-edits', prompt: '[env]', hooksRuntime: await hookRuntime(scratch, 'grok'),
        endpoint: { id: 'ep-0123456789ab', kind: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:43123/v1', key: 'delivery-key', roles: { main: 'delivery-model' } },
        emit: (e) => events.push(e) }));
    });
  } finally { /* runTurn が ACP を閉じる */ }
  const observed = jsonOf(textOf(events)) ?? {};
  const prompt = String(observed.prompt ?? '');
  const hookText = JSON.stringify(observed.hooks ?? []);
  const seen = { servers: observed.mcpServers ?? [], env: observed.seenEnv ?? [], compatEndpoint: Boolean(observed.compatEndpoint), hooks: hookText.slice(0, 200), prompt: prompt.slice(0, 300) };
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
      compatEndpoints: Boolean(observed.compatEndpoint) && (observed.seenEnv ?? []).includes('XAI_API_KEY'),
      plyContext: (observed.mcpServers ?? []).includes('ply_context') && has(prompt, instr('context')),
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

/** 証拠ごとの、どこに届くはずかの短い説明（落ちたときの文に出す） */
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
  compatEndpoints: 'GROK_MODELS_BASE_URL・XAI_API_KEY の会話限定の起動環境',
  autoCompactWindow: '委譲の子の自動圧縮の閾値（thread/start・thread/resume の config の model_auto_compact_token_limit）',
  nativeShellOff: 'エージェント自身のシェルのツールを切る（ACP の disabled_tools）',
  shell: '入力欄の ! の結果を発言に足して渡す（shellAppends。再開でも届く）',
  conversationIsolation: '会話ごとの足し物（可視化・シェルの結果）が、別の会話に漏れない',
  instructionsStayOutOfHistory: '足した指示が、会話の履歴に残らない',
});
