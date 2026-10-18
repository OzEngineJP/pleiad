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

export function createGrokMapper(sessionId, emit = () => {}) {
  const messages = [], tools = new Map(), toolStates = new Map();
  let current = null, expectedEcho = null, echo = '', live = false, sepText = false, sepThink = false;
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
      // Grok の使用状況（used/size は文脈の占有、cost はセッションの費用）
      const used = Number(update.used), size = Number(update.size);
      if (live && Number.isFinite(used) && Number.isFinite(size) && size > 0) send({ type: 'contextWindow', usedTokens: used, windowTokens: size });
      const cost = Number(update.cost?.amount);
      if (live && Number.isFinite(cost) && String(update.cost?.currency ?? '').toUpperCase() === 'USD') send({ type: 'usage', costUsd: cost });
      return;
    }
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
      const message = row('assistant'), text = contentText(update.content);
      // ツールを挟んだあとの本文は別の段落（区切り無しに連結すると、断片同士がくっつく）
      message.text += (sepText && message.text ? '\n\n' : '') + text; sepText = false;
      if (text) send({ type: 'text.delta', text });
    } else if (kind === 'agent_thought_chunk') {
      expectedEcho = null;
      const message = row('assistant'), text = contentText(update.content);
      if (!message.thinking) send({ type: 'thinking.start' });
      message.thinking = (message.thinking ?? '') + (sepThink && message.thinking ? '\n\n' : '') + text; sepThink = false;
      if (text) send({ type: 'thinking.delta', text });
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
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
      expectedEcho = prompt; echo = ''; live = true;
    },
    finish() { if (current?.role === 'assistant') send({ type: 'text.end', uuid: current.uuid }); live = false; },
    messages: () => structuredClone(messages),
  };
}
