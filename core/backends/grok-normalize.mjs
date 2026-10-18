// ACP replay and live updates use the same normalized transcript shape as the
// existing backends: { uuid, role, text, thinking?, toolCalls? }.
// 写し方は devin-normalize.mjs と同じ（ACP の sessionUpdate の形は共通）。
import { MAX_RESULT_CHARS, cutText } from './shared.mjs';

const contentText = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('\n');
  if (value?.type === 'text') return String(value.text ?? '');
  if (value?.content) return contentText(value.content);
  return '';
};
const inputOf = value => value && typeof value === 'object' ? value : value == null ? {} : { value };

export function createGrokMapper(sessionId, emit = () => {}, { windowTokens = null } = {}) {
  const messages = [], tools = new Map(), toolStates = new Map();
  let current = null, expectedEcho = null, echo = '', live = false, sepText = false, sepThink = false;
  // 送ったが回の中ではまだ置けない途中送信（エコーが来ないので自分で行を作る。{ text }）と、直近に届いた回の区切り
  const pendingUsers = [];
  let turnBoundary = false;
  // queued の回の出力が始まる直前に、送った順に user 行を 1 つ置く。
  // 送った時点ではなくターンの境界で置くので、流れている元の行（user の echo・assistant の本文）を分断しない
  function flushQueued() {
    if (turnBoundary && pendingUsers.length) { current = null; row('user').text = pendingUsers.shift().text; turnBoundary = false; }
  }
  function row(role) {
    if (current?.role !== role) {
      current = { uuid: `${sessionId}:${role}:${messages.length}`, role, text: '', at: null };
      messages.push(current);
    }
    return current;
  }
  function send(event) { if (live) emit({ ...event, sessionId }); }
  function accept(update) {
    const kind = update?.sessionUpdate;
    if (kind === 'usage_update') {
      // used/size は文脈の占有、cost はセッションの費用（形は Devin と同じ）
      const used = Number(update.used), size = Number(update.size);
      if (live && Number.isFinite(used) && Number.isFinite(size) && size > 0) send({ type: 'contextWindow', usedTokens: used, windowTokens: size });
      const cost = Number(update.cost?.amount);
      if (live && Number.isFinite(cost) && String(update.cost?.currency ?? '').toUpperCase() === 'USD') send({ type: 'usage', costUsd: cost });
      return;
    }
    // Grok のターンの終わり（_x.ai/session_notification で届く）。usage.totalTokens は文脈の占有
    if (kind === 'turn_completed') {
      const used = Number(update.usage?.totalTokens);
      if (live && Number.isFinite(used) && Number.isFinite(windowTokens) && windowTokens > 0) send({ type: 'contextWindow', usedTokens: used, windowTokens });
      // 回の区切り。受理した途中送信（queued）は、次に出力が始まる直前に user 行を置く（下の flushQueued）
      turnBoundary = true;
      return;
    }
    // Grok のフックの実行（_x.ai/session_notification で届く）
    if (kind === 'hook_run_started') { send({ type: 'hookRun', phase: 'started' }); return; }
    if (kind === 'hook_execution') { send({ type: 'hookRun', phase: 'response' }); return; }
    if (kind === 'user_message_chunk') {
      const text = contentText(update.content);
      if (live && expectedEcho !== null && !current?.thinking && !current?.toolCalls?.length && current?.role === 'user') {
        echo += text;
        if (expectedEcho.startsWith(echo)) { if (echo === expectedEcho) expectedEcho = null; return; }
        // Preserve unexpected delivered input rather than silently losing it.
        current.text = echo; expectedEcho = null; return;
      }
      row('user').text += text;
    } else if (kind === 'agent_message_chunk') {
      expectedEcho = null;
      flushQueued();
      const message = row('assistant'), text = contentText(update.content);
      // ツールを挟んだあとの本文は別の段落（区切り無しに連結すると、断片同士がくっつく）
      message.text += (sepText && message.text ? '\n\n' : '') + text; sepText = false;
      if (text) send({ type: 'text.delta', text });
    } else if (kind === 'agent_thought_chunk') {
      expectedEcho = null;
      flushQueued();
      const message = row('assistant'), text = contentText(update.content);
      if (!message.thinking) send({ type: 'thinking.start' });
      message.thinking = (message.thinking ?? '') + (sepThink && message.thinking ? '\n\n' : '') + text; sepThink = false;
      if (text) send({ type: 'thinking.delta', text });
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      flushQueued();
      const id = update.toolCallId;
      if (typeof id !== 'string' || !id) return;
      const state = toolStates.get(id) ?? { toolCallId: id };
      for (const key of ['title', 'name', 'kind', 'status', 'rawInput', 'rawOutput', 'content', 'locations']) {
        if (update[key] != null) state[key] = structuredClone(update[key]);
      }
      toolStates.set(id, state);
      let call = tools.get(id);
      if (!call) {
        const message = row('assistant');
        call = { id, name: String(state.title ?? state.name ?? state.kind ?? 'tool'), input: inputOf(state.rawInput), result: null };
        (message.toolCalls ??= []).push(call); tools.set(id, call); sepText = sepThink = true;
        // ACP の kind: 'execute' はシェルのコマンド（名前は自由な題なので、名前では見分けられない。core/shell-tools.mjs）
        send({ type: 'tool.start', id, name: call.name, input: call.input, ...(state.kind === 'execute' ? { shell: true } : {}) });
      }
      call.name = String(state.title ?? state.name ?? state.kind ?? 'tool');
      call.input = inputOf(state.rawInput);
      if (['completed', 'failed', 'cancelled'].includes(state.status)) {
        const raw = contentText(state.content) || contentText(state.rawOutput)
          || (state.rawOutput != null ? JSON.stringify(state.rawOutput) : '');
        const result = { text: cutText(raw, MAX_RESULT_CHARS, '\n…'), isError: state.status !== 'completed', truncated: raw.length > MAX_RESULT_CHARS };
        const changed = JSON.stringify(call.result) !== JSON.stringify(result);
        call.result = result;
        if (changed) send({ type: 'tool.result', id, ...result });
      }
    }
  }
  return {
    accept,
    getToolCall: id => toolStates.has(id) ? structuredClone(toolStates.get(id)) : null,
    beginTurn(prompt) {
      current = null; row('user').text = prompt;
      // 区切りはこのターンの中で届いたものだけを数える（履歴の再生で立った区切りで、このターンの最初の出力の前に置かない）
      expectedEcho = prompt; echo = ''; live = true; turnBoundary = false;
    },
    // Grok は途中送信を user_message_chunk でエコーしない（実測 1.0.62）。
    // 書いた直後に pendingUsers に積み、次の回の出力が始まる直前に user 行として置く（flushQueued）。
    // 戻り値はまだ置いていない分の取り消し（確実に届かなかった早期の拒否で acp-steer が呼ぶ）
    queueUser(text) {
      const entry = { text: String(text) };
      pendingUsers.push(entry);
      return () => { const i = pendingUsers.indexOf(entry); if (i >= 0) pendingUsers.splice(i, 1); };
    },
    finish() {
      if (current?.role === 'assistant') send({ type: 'text.end', uuid: current.uuid });
      // 送ったのに回られず残った分（中断・既読不明）は、送った順に末尾へ置いて無くさない
      while (pendingUsers.length) { current = null; row('user').text = pendingUsers.shift().text; }
      live = false;
    },
    messages: () => structuredClone(messages),
  };
}
