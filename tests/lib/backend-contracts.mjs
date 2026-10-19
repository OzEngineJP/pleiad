// バックエンドの共通の契約の試験（tests/unit/backend-conformance.mjs）の道具と、能力の印ごとの契約の試験の置き場。
//
// RIGS: エージェントごとの身代わり（LLM を呼ばない）でサーバーを起こす形。エージェントを足すときは、身代わり（tests/lib/fake-<id>.mjs）を書き、
//   ここに 1 つ足す。core/backends/agents.mjs のエージェント（fake を含む）に RIGS が無いと backend-contract が落とす。
// CAPABILITY_CONTRACTS: 能力の印（core/backends/contract.mjs）ごとに、その印の契約を確かめる試験。
//   'conformance' は下の checkConformance が全バックエンドで確かめる、文字列の配列は既存の suite（tests/run.mjs の名前）。
//   印を足すときはここにも足す（無い・名前の suite が無いと backend-contract が落とす）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './server.mjs';
import { installFakeClaude } from './fake-claude.mjs';

export const RIGS = {
  fake: async () => ({ env: { AGENT_HOST_BACKENDS: 'fake' }, prompt: (text) => text }),
  claude: async (scratch) => {
    const cli = await installFakeClaude(path.join(scratch, 'cli'));
    const config = path.join(scratch, 'claude-config');
    await fs.mkdir(config, { recursive: true });
    return { env: { AGENT_HOST_BACKENDS: 'claude', ...cli.env, CLAUDE_CONFIG_DIR: config }, prompt: (text) => text };
  },
  codex: async () => ({ env: { AGENT_HOST_BACKENDS: 'codex', AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"` }, prompt: (text) => text }),
  antigravity: async () => ({ env: { AGENT_HOST_BACKENDS: 'antigravity', AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests/lib/fake-agy.mjs')}"` }, prompt: (text) => text }),
  opencode: async () => ({ env: { AGENT_HOST_BACKENDS: 'opencode', AGENT_HOST_OPENCODE_BIN: `node "${path.join(ROOT, 'tests/lib/fake-opencode.mjs')}"` }, prompt: (text) => text }),
  devin: async () => ({ env: { AGENT_HOST_BACKENDS: 'devin', AGENT_HOST_DEVIN_BIN: `node "${path.join(ROOT, 'tests/lib/fake-devin.mjs')}"` }, prompt: (text) => text }),
  grok: async (scratch) => {
    const home = path.join(scratch, 'grok-home');
    await fs.mkdir(home, { recursive: true });
    return { env: { AGENT_HOST_BACKENDS: 'grok', AGENT_HOST_GROK_BIN: `node "${path.join(ROOT, 'tests/lib/fake-grok.mjs')}"`, GROK_HOME: home }, prompt: (text) => text };
  },
};

export const CAPABILITY_CONTRACTS = {
  title: ['conformance', 'server-codex'],
  tag: ['server-fake'],
  fork: ['conformance', 'server-fork', 'server-antigravity'],
  forkMessage: ['server-fork'],
  rewind: ['server-rewind', 'server-antigravity'],
  subagents: ['server-background', 'server-codex'],
  liveModel: ['server-delegation-settings', 'server-ux'],
  liveMode: ['server-ux'],
  hostTools: ['event-session-id'],
  approvals: ['computer-policy', 'server-antigravity', 'devin-acp', 'server-devin'],
  alwaysAllow: ['server-fake'],
  mcpApproval: ['server-codex', 'server-devin'],
  login: ['server-codex', 'server-fake'],
  accounts: ['server-claude-accounts', 'agent-accounts', 'codex-accounts', 'opencode-accounts', 'server-agent-accounts', 'server-agent-account-adopt'],
  compatEndpoints: ['compat-endpoints'],
  compact: ['server-compaction', 'server-codex-compaction'],
  autoCompactWindow: ['server-compaction-delegated'],
  promptSuggestions: ['server-prompt-suggestions'],
  plyAgents: ['agent-tasks'],
  plyInstructions: ['server-added-context', 'agent-tasks'],
  plyContext: ['server-agy-context', 'server-opencode-context', 'context-owner-capability'],
  computerUse: ['computer-bridge'],
  plyShell: ['shell-bridge', 'shell-delivery'],
  nativeShellOff: ['shell-delivery'],
  shell: ['server-shell'],
  effortInModelId: ['effort', 'devin-models', 'server-devin'],
  instructionsAtStart: ['bot-dispatch'],
  failureDiagnostics: ['server-antigravity', 'server-devin'],
  promptDelivery: ['message-queue', 'server-antigravity'],
  handover: ['adopt-held', 'adopt-claude', 'adopt-codex', 'adopt-agy', 'adopt-opencode'],
  browser: ['agent-browser-env', 'browser-bridge', 'server-devin'],
  plyControl: ['control-delivery', 'ops-control', 'server-devin'],
  secrets: ['server-secrets', 'mcp-secret-store'],
  visualize: ['server-visualize'],
  hooks: ['server-hooks', 'server-hooks-unify'],
};

/**
 * 全バックエンドが守る共通の契約。c は ws-client の接続、caps は describeBackends の capabilities。
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
