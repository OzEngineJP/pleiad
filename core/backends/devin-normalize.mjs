// ACP replay and live updates use the same normalized transcript shape as the
// existing backends: { uuid, role, text, thinking?, toolCalls? }.
import crypto from 'node:crypto';
import { MAX_RESULT_CHARS, cutText } from './shared.mjs';
import { computerResult, computerFailed, acpComputerText } from './computer-delivery.mjs';

// Bound previews before retaining state, cloning it or emitting tool events.
// Result text uses the shared backend limit; structured inputs and ACP diffs
// also need a total budget because they can contain entire source files.
export const MAX_DEVIN_TOOL_CHARS = 16 * 1024;
function compactToolValue(value) {
  let remaining = MAX_DEVIN_TOOL_CHARS, nodes = 256, truncated = false;
  function text(value) {
    const kept = Buffer.from(value.slice(0, remaining), 'utf8').toString('utf8');
    remaining -= kept.length;
    if (kept.length === value.length) return kept;
    truncated = true;
    return `${kept}\n…`;
  }
  function visit(value, depth = 0) {
    if (--nodes < 0 || depth > 12 || remaining <= 0) { truncated = true; return '…'; }
    if (typeof value === 'string') return text(value);
    if (!value || typeof value !== 'object') return value;
    let source = value;
    if (typeof value.oldText === 'string' && typeof value.newText === 'string'
      && value.oldText.length + value.newText.length > MAX_DEVIN_TOOL_CHARS) {
      const before = value.oldText, after = value.newText;
      let prefix = 0, suffix = 0;
      while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
      while (suffix < Math.min(before.length, after.length) - prefix
        && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      const excerpt = str => {
        const start = Math.max(0, prefix - 160), end = str.length - Math.max(0, suffix - 160);
        const stop = Math.min(end, start + MAX_DEVIN_TOOL_CHARS / 4);
        return `${start ? '…' : ''}${str.slice(start, stop)}${stop < str.length ? '…' : ''}`;
      };
      source = { ...value, oldText: excerpt(before), newText: excerpt(after), truncated: true,
        oldLength: before.length, newLength: after.length };
      truncated = true;
    }
    const out = Array.isArray(source) ? [] : {};
    for (const key of Object.keys(source)) {
      if (remaining <= 0 || nodes <= 0) { truncated = true; break; }
      const name = Array.isArray(source) ? key : text(key);
      Object.defineProperty(out, name, { value: visit(source[key], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  const preview = visit(value);
  return { preview, truncated };
}

const contentText = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('\n');
  if (value?.type === 'diff') return `${value.path ?? ''}\n-${value.oldText ?? ''}\n+${value.newText ?? ''}`;
  if (value?.type === 'text') return String(value.text ?? '');
  if (value?.content) return contentText(value.content);
  return '';
};
const inputOf = value => value && typeof value === 'object' ? value : value == null ? {} : { value };

export function createDevinMapper(sessionId, emit = () => {}) {
  const messages = [], tools = new Map(), toolStates = new Map();
  let current = null, expectedEcho = null, echo = '', live = false, turn = null, sepText = false, sepThink = false;
  const pendingUsers = [];
  let queuedEcho = null;
  // uuid は位置から作る（ホスト記録の無いネイティブの会話は、この uuid のまま再開・再起動の後も同じ行を指す）。
  // ただし圧縮で位置がずれると別の発言に当たるので、ホスト記録に重ねるときは使わない（core/conversations.mjs の mergeMessages）。
  // 再生（session/load）の行には positional の印を付け、順序と中身で当てさせる。ライブの行には、ターンごとの乱数の入った liveUuid を付ける
  function row(role) {
    if (current?.role !== role) {
      const uuid = `${sessionId}:${role}:${messages.length}`;
      current = live
        ? { uuid, liveUuid: `${sessionId}:${turn}:${role}:${messages.length}`, role, text: '', at: null }
        : { uuid, role, text: '', at: null, positional: true };
      messages.push(current);
    }
    return current;
  }
  function send(event) { if (live) emit({ ...event, sessionId }); }
  let usageTotals = {}, measuredUsage = false, lastUsageKey = null, usageActivity = 0, lastUsageActivity = 0;
  function recordUsage(meta) {
    if (!live || !meta || typeof meta !== 'object') return;
    const fields = ['cognition.ai/inputTokens', 'cognition.ai/outputTokens', 'cognition.ai/cachedReadTokens'];
    if (!fields.some(key => Object.hasOwn(meta, key))) return;
    const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const values = fields.map(key => count(meta[key]));
    const key = JSON.stringify(values);
    // Devin repeats a request's counters in its subagent context refresh. A new
    // response/tool boundary allows two distinct requests with identical counts.
    if (key === lastUsageKey && (Object.hasOwn(meta, 'cognition.ai/subagent_context') || usageActivity === lastUsageActivity)) return;
    lastUsageKey = key; lastUsageActivity = usageActivity;
    for (const [index, name] of ['inputTokens', 'outputTokens', 'cachedTokens'].entries()) {
      const value = values[index];
      usageTotals[name] = value == null || (measuredUsage && usageTotals[name] == null) ? null : (usageTotals[name] ?? 0) + value;
    }
    measuredUsage = true;
    send({ type: 'usage', ...usageTotals });
  }
  function accept(update) {
    const kind = update?.sessionUpdate;
    if (live && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'user_message_chunk'].includes(kind)) usageActivity++;
    if (kind === 'usage_update') {
      recordUsage(update._meta);
      // Devin の使用状況（used/size は文脈の占有、cost はセッションの費用）
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
        current.text = current.sent = echo; expectedEcho = null; return;
      }
      // 返答の前に届いた途中送信は同じ行に続く。再生でも同じ行に続くので、送った全文にも足す（記録の照合のハッシュ）
      if (live && !queuedEcho && pendingUsers.length) {
        queuedEcho = pendingUsers.shift();
        queuedEcho.seen = 0;
        current = null;
        const message = row('user');
        queuedEcho.nativeId = message.liveUuid ?? message.uuid;
      }
      const message = row('user');
      message.text += text;
      if (typeof message.sent === 'string') message.sent += text;
      if (queuedEcho) {
        queuedEcho.seen += text.length;
        if (queuedEcho.seen >= queuedEcho.text.length) queuedEcho = null;
      }
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
        if (update[key] != null) {
          const { preview, truncated } = compactToolValue(update[key]);
          state[key] = preview;
          if (truncated) state.truncated = true;
        }
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
        const cut = text => ({ text: cutText(text, MAX_RESULT_CHARS, '\n…'), truncated: Boolean(state.truncated) || text.length > MAX_RESULT_CHARS });
        const computerTool = call.name.includes('ply_computer') || String(state.rawInput?.tool_name ?? '').includes('ply_computer');
        const result = computerTool ? computerResult(acpComputerText(raw), cut) : cut(raw);
        result.isError = state.status !== 'completed' || computerFailed(result.computer);
        const changed = JSON.stringify(call.result) !== JSON.stringify(result);
        call.result = result;
        if (changed) send({ type: 'tool.result', id, ...result });
      }
    }
  }
  return {
    accept,
    getToolCall: id => toolStates.has(id) ? structuredClone(toolStates.get(id)) : null,
    /**
     * sent は送る全文（Pleiad の指示を前に足したもの）。エコーの照合にだけ使う。shown は人が書いた分（先頭のメモと `!` の結果を含む）で、
     * 行の text にする。sent は行に持たせ、記録は全文のハッシュだけを残して、再生の全文を原文に戻すのに使う
     */
    beginTurn(sent, shown = sent) {
      current = null; live = true; turn = crypto.randomUUID();
      usageTotals = {}; measuredUsage = false; lastUsageKey = null; usageActivity = 0; lastUsageActivity = 0;
      Object.assign(row('user'), { text: shown, sent });
      expectedEcho = sent; echo = '';
      return current.liveUuid ?? current.uuid;
    },
    queueUser(text) {
      const entry = { text: String(text) };
      pendingUsers.push(entry);
      const withdraw = () => { const i = pendingUsers.indexOf(entry); if (i >= 0) pendingUsers.splice(i, 1); };
      Object.defineProperty(withdraw, 'nativeId', { get: () => entry.nativeId });
      return withdraw;
    },
    // 発言の id はネイティブの会話の行の uuid。ホスト記録の会話では、記録の行に合わせて liveUuid に替える（core/conversations.mjs の hostEvent）
    finish() { if (current?.role === 'assistant') send({ type: 'text.end', uuid: current.uuid, ...(current.liveUuid ? { liveUuid: current.liveUuid } : {}) }); live = false; pendingUsers.length = 0; queuedEcho = null; },
    messages: () => structuredClone(messages),
  };
}
