// ACP replay and live updates use the same normalized transcript shape as the
// existing backends: { uuid, role, text, thinking?, toolCalls? }.
import { MAX_RESULT_CHARS, cutText } from './shared.mjs';

const contentText = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('\n');
  if (value?.type === 'text') return String(value.text ?? '');
  if (value?.content) return contentText(value.content);
  return '';
};
const inputOf = value => value && typeof value === 'object' ? value : value == null ? {} : { value };

export function createDevinMapper(sessionId, emit = () => {}) {
  const messages = [], tools = new Map();
  let current = null, expectedEcho = null, echo = '', live = false;
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
      message.text += text;
      if (text) send({ type: 'text.delta', text });
    } else if (kind === 'agent_thought_chunk') {
      expectedEcho = null;
      const message = row('assistant'), text = contentText(update.content);
      if (!message.thinking) send({ type: 'thinking.start' });
      message.thinking = (message.thinking ?? '') + text;
      if (text) send({ type: 'thinking.delta', text });
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = update.toolCallId;
      if (typeof id !== 'string' || !id) return;
      let call = tools.get(id);
      if (!call) {
        const message = row('assistant');
        call = { id, name: String(update.title ?? update.kind ?? 'tool'), input: inputOf(update.rawInput), result: null };
        (message.toolCalls ??= []).push(call); tools.set(id, call);
        send({ type: 'tool.start', id, name: call.name, input: call.input });
      }
      if (update.rawInput !== undefined) call.input = inputOf(update.rawInput);
      if (['completed', 'failed', 'cancelled'].includes(update.status)) {
        const raw = contentText(update.content) || contentText(update.rawOutput)
          || (update.rawOutput != null ? JSON.stringify(update.rawOutput) : '');
        const result = { text: cutText(raw, MAX_RESULT_CHARS, '\n…'), isError: update.status !== 'completed', truncated: raw.length > MAX_RESULT_CHARS };
        const changed = JSON.stringify(call.result) !== JSON.stringify(result);
        call.result = result;
        if (changed) send({ type: 'tool.result', id, ...result });
      }
    }
  }
  return {
    accept,
    beginTurn(prompt) {
      current = null; row('user').text = prompt;
      expectedEcho = prompt; echo = ''; live = true;
    },
    finish() { if (current?.role === 'assistant') send({ type: 'text.end', uuid: current.uuid }); live = false; },
    messages: () => structuredClone(messages),
  };
}
