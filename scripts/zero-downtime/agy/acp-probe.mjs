// agy の ACP（`agy acp`。1.5.15 以降）を話す probe の共通部品（無停止の更新 段階 3）。引数と依頼の形は本体（core/backends/antigravity.mjs）と同じ。
// 起こす agy は AGENT_HOST_AGY_BIN で身代わりに替えられる（段取りだけの確かめ: AGENT_HOST_AGY_BIN='node tests/lib/fake-agy.mjs'。
// このときモデルの応答は台本なので、本文（pong-token・finished）の判定は外れる。段取り・終了コード・片付けを見るのに使う）。
//
// agy の ACP は 1 会話 1 プロセス。initialize → session/new（cwd・mcpServers）→ session/prompt（応答は stopReason）。
// 本文・ツールは session/update の通知で来る（agent_message_chunk・tool_call・tool_call_update）。承認は --dangerously-skip-permissions で省く
import { cliCommand } from '../../../core/cli-installation.mjs';
import { agyAcpArgs } from '../../../core/backends/antigravity-acp.mjs';

/** 起こす agy。options は agyAcpArgs と同じ（cwd・home・extraDirs・restricted・skipPermissions） */
export function agyLaunch(options = {}) {
  const [command, ...rest] = cliCommand('antigravity') ?? ['agy'];
  return { command, args: [...rest, ...agyAcpArgs(options)] };
}

export const INITIALIZE = {
  protocolVersion: 1,
  clientInfo: { name: 'zdu-probe', version: '0.0.0' },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

/** 1 行 1 JSON の依頼（末尾の改行つき） */
export const request = (id, method, params) => `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
export const promptParams = (sessionId, text) => ({ sessionId, prompt: [{ type: 'text', text }] });
export const parse = line => { try { return JSON.parse(line); } catch { return null; } };

const updateOf = m => (m?.method === 'session/update' ? m.params?.update ?? null : null);

/** 受け取った 1 行の要約（ログ用） */
export function desc(m) {
  if (!m) return '?';
  const u = updateOf(m);
  if (u) return u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update' ? `${u.sessionUpdate}/${u.status ?? ''}${u.title ? `(${u.title})` : ''}` : u.sessionUpdate ?? 'update';
  if (m.method) return m.method;
  if (m.error) return `error ${m.error.code}`;
  return m.result?.stopReason ? `response#${m.id} ${m.result.stopReason}` : `response#${m.id}`;
}

/** フレームの列から本文（agent_message_chunk をつないだもの） */
export const replyText = frames => frames.map(updateOf).filter(u => u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text').map(u => u.content.text).join('');
/** フレームの列から、完了したツール呼び出し（tool_call_update の completed） */
export const toolEnds = frames => frames.map(updateOf).filter(u => u?.sessionUpdate === 'tool_call_update' && /completed/i.test(u.status ?? ''));
/** ツールが始まった（tool_call） */
export const toolStarts = frames => frames.map(updateOf).filter(u => u?.sessionUpdate === 'tool_call');

/** 付け直した側で、前の親が送った依頼の答えを受ける枠を開ける（再生と続きで届く response の id）。Rpc（../codex/lib.mjs）に使う */
export function expectResponse(rpc, id, ms = 90_000) {
  rpc.nextId = Math.max(rpc.nextId, id);
  return new Promise(resolve => {
    const timer = setTimeout(() => { rpc.pending.delete(id); resolve({ timeout: true }); }, ms);
    rpc.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } });
  });
}

/** モデルを会話に当てる（session/set_config_option の model。本体の applyTarget と同じ）。当たったモデルの id を返す（断られたら null） */
export async function setModel(rpc, sessionId, model) {
  if (!model) return null;
  const applied = await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: model }, 30_000);
  const current = applied.result?.configOptions?.find(option => option.id === 'model')?.currentValue ?? null;
  return current === model ? current : null;
}

/** ACP を始める（initialize → session/new）。Rpc を渡す。sessionId と、agy が返した選択肢を返す */
export async function startSession(rpc, { cwd, mcpServers = [], meta = null } = {}) {
  const init = await rpc.request('initialize', INITIALIZE, 60_000);
  if (init.error || init.timeout) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
  const created = await rpc.request('session/new', { cwd, mcpServers, ...(meta ? { _meta: meta } : {}) }, 60_000);
  const sessionId = created.result?.sessionId;
  if (!sessionId) throw new Error(`session/new failed: ${JSON.stringify(created).slice(0, 300)}`);
  return { sessionId, init: init.result, created: created.result };
}
