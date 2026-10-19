// ACP replay and live updates use the same normalized transcript shape as the
// existing backends: { uuid, role, text, thinking?, toolCalls? }.
// 写し方は devin-normalize.mjs と同じ（ACP の sessionUpdate の形は共通）。
import crypto from 'node:crypto';
import { MAX_RESULT_CHARS, cutText } from './shared.mjs';
import { computerResult, computerFailed, acpComputerText } from './computer-delivery.mjs';

const contentText = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('\n');
  if (value?.type === 'text') return String(value.text ?? '');
  if (value?.content) return contentText(value.content);
  return '';
};
const inputOf = value => value && typeof value === 'object' ? value : value == null ? {} : { value };

export function createGrokMapper(sessionId, emit = () => {}, { windowTokens = null, messageNamespace = null } = {}) {
  const messages = [], tools = new Map(), toolStates = new Map();
  let emitTurn = emit;
  let current = null, expectedEcho = null, echo = '', live = false, turn = null, sepText = false, sepThink = false;
  // uuid は位置から作る（ホスト記録の無いネイティブの会話は、この uuid のまま再開・再起動の後も同じ行を指す）。
  // ただし圧縮で位置がずれると別の発言に当たるので、ホスト記録に重ねるときは使わない（core/conversations.mjs の mergeMessages）。
  // 再生（session/load）の行には positional の印を付け、順序と中身で当てさせる。ライブの行には、ターンごとの乱数の入った liveUuid を付ける
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
      const uuid = `${sessionId}:${messageNamespace ? `${messageNamespace}:` : ''}${role}:${messages.length}`;
      current = live
        ? { uuid, liveUuid: `${sessionId}:${turn}:${role}:${messages.length}`, role, text: '', at: null }
        : { uuid, role, text: '', at: null, positional: true };
      messages.push(current);
    }
    return current;
  }
  function send(event) { if (live) emitTurn({ ...event, sessionId }); }
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
    // Grok のターンの終わり（_x.ai/session_notification で届く）。usage はターンのモデル呼び出しの合計（課金の量）で、
    // 呼び出しが 2 回なら文脈の占有のほぼ 2 倍になる（2026-10-19 実機）。文脈の量としては出さない
    if (kind === 'turn_completed') {
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
        current.text = current.sent = echo; expectedEcho = null; return;
      }
      // 返答の前に届いた途中送信は同じ行に続く。再生でも同じ行に続くので、送った全文にも足す（記録の照合のハッシュ）
      const message = row('user');
      message.text += text;
      if (typeof message.sent === 'string') message.sent += text;
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
        const cut = text => ({ text: cutText(text, MAX_RESULT_CHARS, '\n…'), truncated: text.length > MAX_RESULT_CHARS });
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
    setEmit: emit => { emitTurn = emit; },
    getToolCall: id => toolStates.has(id) ? structuredClone(toolStates.get(id)) : null,
    /**
     * sent は送る全文（Pleiad の指示を前に足したもの）。エコーの照合にだけ使う。shown は人が書いた分（先頭のメモと `!` の結果を含む）で、
     * 行の text にする。sent は行に持たせ、記録は全文のハッシュだけを残して、再生の全文を原文に戻すのに使う
     */
    beginTurn(sent, shown = sent) {
      current = null; live = true; turn = crypto.randomUUID();
      Object.assign(row('user'), { text: shown, sent });
      expectedEcho = sent; echo = ''; turnBoundary = false;
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
      if (current?.role === 'assistant') send({ type: 'text.end', uuid: current.uuid, ...(current.liveUuid ? { liveUuid: current.liveUuid } : {}) });
      // 送ったのに回られず残った分（中断・既読不明）は、送った順に末尾へ置いて無くさない
      while (pendingUsers.length) { current = null; row('user').text = pendingUsers.shift().text; }
      live = false;
    },
    messages: () => structuredClone(messages),
  };
}
