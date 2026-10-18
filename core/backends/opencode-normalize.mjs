// OpenCode の出来事・発言を Pleiad の正規化イベント・NormalizedMessage に写す（docs/multi-backend.md §2.10）。
// SDK にもネットワークにも依存しない純粋な関数（tests/unit/opencode-normalize.mjs）。
//
// 実機（opencode 1.19.3）の形:
//   message.updated       { info: { id, role, sessionID, error?, tokens, cost, summary? } }
//   message.part.updated  { part: { id, messageID, sessionID, type: text | reasoning | tool | step-start | step-finish | compaction …, … } }
//   message.part.delta    { messageID, partID, field: 'text', delta }
//   session.status        { status: { type: busy | idle } | { type: retry, attempt, message, action?, next } }（next は次の再試行の epoch ms。retryOf）
//   session.error         { error: { name, data: { message } } }
//   session.idle          {}
// tool の部品は state.status が pending → running → completed / error と進み、callID が呼び出しの id
import { COMPUTER_TOOL_PREFIX, computerResult, computerFailed } from './computer-delivery.mjs';
import { MAX_RESULT_CHARS, cutText } from './shared.mjs';

/** Pleiad の MCP のサーバー（OpenCode の MCP の設定のキー）。ツールの名前は `<サーバー>_<ツール>` で届く */
export const PLY_SERVERS = ['ply_agents', 'ply_control', 'ply_computer', 'ply_browser', 'ply_context', 'ply_shell'];

/**
 * OpenCode のツールの名前 -> 表示の名前。Pleiad の MCP のツールは、Claude と同じ `mcp__<サーバー>__<ツール>` にそろえる
 * （ply_computer の結果の表示・委譲のツールの見分けがこの名前を見る。docs/computer-use.md「tool.start / tool.result」）
 */
export function toolName(name) {
  const raw = String(name ?? '');
  for (const server of PLY_SERVERS) if (raw.startsWith(`${server}_`) && raw.length > server.length + 1) return `mcp__${server}__${raw.slice(server.length + 1)}`;
  return raw;
}

/** 発言の部品の本文（text・reasoning のうち、OpenCode が足した synthetic を除く） */
const partText = (parts, type) => (parts ?? []).filter((p) => p?.type === type && !p.synthetic && !p.ignored).map((p) => p.text ?? '').join('');

/** ツールの部品の結果。ply_computer は他のエージェントと同じく印の行から images と computer を作る */
function toolResult(part, { full = false } = {}) {
  const state = part?.state ?? {};
  const isError = state.status === 'error';
  const raw = isError ? String(state.error ?? '') : String(state.output ?? '');
  const max = full ? Infinity : MAX_RESULT_CHARS;
  const cut = (text) => ({ text: cutText(text, max, '\n…'), truncated: text.length > max || Boolean(state.metadata?.truncated) });
  if (toolName(part.tool).startsWith(COMPUTER_TOOL_PREFIX)) {
    const shown = computerResult(raw, cut);
    return { ...shown, isError: isError || computerFailed(shown.computer) };
  }
  return { ...cut(raw), isError };
}

/** ツールの入力。OpenCode の state.input をそのまま */
const toolInput = (part) => (part?.state?.input && typeof part.state.input === 'object' ? part.state.input : {});

// 上限を言うエラーの種類（応答の本文の error.code / error.type）。FreeUsageLimitError・GoUsageLimitError は OpenCode Zen の無料枠・Go の枠
const LIMIT_CODES = new Set(['usage_limit_reached', 'rate_limit_exceeded', 'quota_exceeded', 'insufficient_quota', 'FreeUsageLimitError', 'GoUsageLimitError']);

/** 時刻の値（epoch 秒・epoch ms・ISO の文字列）-> epoch ms。読めなければ null */
const epochMs = (v) => {
  const at = typeof v === 'number' ? v * (v < 1e12 ? 1000 : 1) : v;
  const ms = at == null ? NaN : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** retry-after-ms・retry-after（秒か HTTP の日付）-> 解ける時刻の epoch ms。無ければ null */
function retryAfterAt(headers, now) {
  const h = headers && typeof headers === 'object' ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) : {};
  const ms = Number(h['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return now + ms;
  const raw = h['retry-after'];
  if (raw == null || raw === '') return null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return now + sec * 1000;
  const date = new Date(String(raw)).getTime();
  return Number.isFinite(date) ? date : null;
}

/**
 * OpenCode のエラー -> { name, message, aborted, auth, limited, resetsAt? }。resetsAt は解ける時刻の epoch ms
 * （本文の resets_at、無ければ 429 の retry-after。server の turnResult が数で受ける）
 */
export function errorOf(error, now = Date.now()) {
  if (!error) return null;
  const name = String(error.name ?? '');
  const message = String(error.data?.message ?? error.message ?? name ?? 'error');
  const data = error.data ?? error;
  let body = data.responseBody;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch { body = null; }
  const code = body?.error?.code ?? body?.error?.type ?? data.code;
  const status = Number(data.statusCode ?? data.status);
  const limited = status === 429 || LIMIT_CODES.has(code);
  const resetsAt = epochMs(body?.error?.resets_at ?? data.resetsAt) ?? (limited ? retryAfterAt(data.responseHeaders, now) : null);
  return { name, message, aborted: name === 'MessageAbortedError', auth: name === 'ProviderAuthError', limited, ...(resetsAt ? { resetsAt } : {}) };
}

// 再試行の待ちのうち、待っても今は通らない上限（ADR 0229）。action.reason は OpenCode が付ける理由
// （free_tier_limit = Zen の無料枠、account_rate_limit = Go の枠。next がその枠の解ける時刻）
const DEFINITE_REASONS = new Set(['free_tier_limit', 'account_rate_limit']);
// action の無い再試行でも、文言が枠の使い切り・残高不足を言うものは同じ扱い。"Rate limit exceeded"・"Too Many Requests" は含めない
// （数秒〜数分で通ることのある込み具合の 429。待ちとして見せ、止めない）
const DEFINITE_TEXT = /free usage exceeded|usage limit reached|insufficient[ _](?:balance|quota|funds|credits?)|quota exceeded|credit balance is too low/i;
// 上限らしい再試行（画面の文言を「上限で待機中」にする）。5xx・混雑・通信の失敗の再試行は「エラーで再試行を待っている」
const LIMIT_TEXT = /rate.?limit|too many requests|usage limit|quota|\b429\b|limit reached/i;

/**
 * session.status の retry -> { attempt, next, message, reason, limit, definite, resetsAt }。
 *   next      次の再試行の epoch ms（OpenCode 1.19.3 で確かめた形。分からなければ null）
 *   limit     上限による待ちか（文言・理由から推す）。false は 5xx・混雑・通信の失敗の再試行
 *   definite  待っても今は通らない上限（ターンを止めて limited で終える）
 *   resetsAt  definite で、枠の解ける時刻が分かるとき（Go の枠の next）。分からなければ null
 */
export function retryOf(status) {
  const attempt = Number.isFinite(status?.attempt) ? status.attempt : null;
  const next = Number.isFinite(status?.next) ? status.next : null;
  const message = String(status?.message ?? '').slice(0, 300);
  const reason = typeof status?.action?.reason === 'string' ? status.action.reason : null;
  const definite = DEFINITE_REASONS.has(reason) || DEFINITE_TEXT.test(message);
  const limit = definite || LIMIT_TEXT.test(message);
  return { attempt, next, message, reason, limit, definite, resetsAt: definite && reason === 'account_rate_limit' ? next : null };
}

/**
 * 1 つのターンの出来事を写す。sessionId は OpenCode の会話の id（子の会話の出来事は渡さない）。
 * emit は正規化イベントの受け口。hooks:
 *   onUserMessage({ messageId, text })  自分の発言が会話に入った（渡った合図・途中送信の照合）
 *   onChild({ childId, callId })        task のツールが子の会話を作った（サブエージェント）
 *   windowTokens()                      今のモデルの文脈の窓（contextWindow に使う。分からなければ null）
 */
export function createTurnMapper({ sessionId, emit, onUserMessage = () => {}, onChild = () => {}, windowTokens = () => null }) {
  const roles = new Map();      // messageID -> role
  const parts = new Map();      // partID -> { type, messageID, streamed, started, done }
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
  let error = null;
  let idle = false;
  let wroteText = false;
  let usedTool = false;
  let retrying = null;          // 今の再試行の待ち（retryOf の形）。次の busy で解ける
  let limit = null;             // 待っても通らない上限の再試行（retryOf の形）。呼ぶ側がターンを止めて limited で終える

  const partOf = (part) => {
    let entry = parts.get(part.id);
    if (!entry) { entry = { type: part.type, messageID: part.messageID, streamed: '', started: false, done: false, resync: false }; parts.set(part.id, entry); }
    return entry;
  };

  function onPart(part) {
    const role = roles.get(part.messageID) ?? 'assistant';
    const entry = partOf(part);
    if (part.type === 'text') {
      if (role === 'user') {
        if (!part.synthetic && part.text) onUserMessage({ messageId: part.messageID, text: part.text });
        return;
      }
      if (part.synthetic) return;
      // 差分（message.part.delta）が来なかった分は、部品の本文の残りを流す
      const text = String(part.text ?? '');
      if (entry.resync && text.length >= entry.streamed.length) entry.resync = false;
      if (text.length > entry.streamed.length && text.startsWith(entry.streamed)) {
        if (!entry.started) { emit({ type: 'activity', state: 'writing' }); entry.started = true; }
        emit({ type: 'text.delta', text: text.slice(entry.streamed.length) });
        entry.streamed = text;
        wroteText = true;
      }
      if (part.time?.end && !entry.done) { entry.done = true; emit({ type: 'text.end', uuid: part.messageID }); }
      return;
    }
    if (part.type === 'reasoning') {
      if (!entry.started) { entry.started = true; emit({ type: 'thinking.start' }); emit({ type: 'activity', state: 'thinking' }); }
      const text = String(part.text ?? '');
      if (entry.resync && text.length >= entry.streamed.length) entry.resync = false;
      if (text.length > entry.streamed.length && text.startsWith(entry.streamed)) {
        emit({ type: 'thinking.delta', text: text.slice(entry.streamed.length) });
        entry.streamed = text;
      }
      return;
    }
    if (part.type === 'tool') {
      usedTool = true;
      const status = part.state?.status;
      const id = String(part.callID ?? part.id);
      const name = toolName(part.tool);
      if (!entry.started && (status === 'running' || status === 'completed' || status === 'error')) {
        entry.started = true;
        emit({ type: 'tool.start', id, name, input: toolInput(part), ...(Number.isFinite(part.state?.time?.start) ? { startedAt: part.state.time.start } : {}) });
        emit({ type: 'activity', state: 'running', label: name });
      }
      // task のツールは子の会話を作る（state.metadata.sessionId）。子の承認を親の会話で聞き、サブエージェントとして読む
      const child = part.state?.metadata?.sessionId;
      if (part.tool === 'task' && typeof child === 'string' && child && child !== sessionId) onChild({ childId: child, callId: id });
      if (!entry.done && (status === 'completed' || status === 'error')) {
        entry.done = true;
        emit({ type: 'tool.result', id, ...toolResult(part, { full: true }) });
      }
      return;
    }
    if (part.type === 'step-finish') {
      if (entry.done) return;
      entry.done = true;
      const tokens = part.tokens ?? {};
      const cacheRead = Number(tokens.cache?.read) || 0;
      // 入力にはキャッシュの読みを、出力には考えた分を含める（antigravity.mjs の usageFor と同じ約束）
      usage.inputTokens += (Number(tokens.input) || 0) + cacheRead;
      usage.outputTokens += (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
      usage.cachedTokens += cacheRead;
      usage.costUsd += Number(part.cost) || 0;
      emit({ type: 'usage', ...usage });
      const window = windowTokens();
      const used = (Number(tokens.input) || 0) + cacheRead + (Number(tokens.cache?.write) || 0) + (Number(tokens.output) || 0);
      if (Number.isFinite(window) && window > 0 && used > 0) emit({ type: 'contextWindow', usedTokens: used, windowTokens: window });
    }
  }

  return {
    /** 出来事を 1 つ受ける（この会話の分だけ渡す）。ターンの終わり（session.idle）なら true */
    handle(event) {
      const p = event?.properties ?? {};
      switch (event?.type) {
        case 'message.updated': {
          const info = p.info ?? {};
          if (info.id) roles.set(info.id, info.role);
          if (info.role === 'assistant' && info.error) error = errorOf(info.error);
          return false;
        }
        case 'message.part.updated':
          if (p.part) onPart(p.part);
          return false;
        case 'message.part.delta': {
          if (p.field !== 'text' || typeof p.delta !== 'string') return false;
          const entry = parts.get(p.partID);
          // 付け直しで取り直した途中の部品は、次の部品の更新（全文）まで差分を読まない（取り直した本文と重なる）
          if (!entry || entry.resync || roles.get(p.messageID) === 'user') return false;
          if (entry.type === 'text') {
            if (!entry.started) { emit({ type: 'activity', state: 'writing' }); entry.started = true; }
            emit({ type: 'text.delta', text: p.delta });
            entry.streamed += p.delta;
            wroteText = true;
          } else if (entry.type === 'reasoning') {
            emit({ type: 'thinking.delta', text: p.delta });
            entry.streamed += p.delta;
          }
          return false;
        }
        case 'session.status':
          // 再試行の待ち（ADR 0229）。人の応答を待つ waiting とは別の状態で、次の再試行の時刻と回数を添える。
          // 待っても通らない上限なら覚えておき、呼ぶ側がターンを止める
          if (p.status?.type === 'retry') {
            retrying = retryOf(p.status);
            if (retrying.definite) limit ??= retrying;
            const { attempt, next, message, reason } = retrying;
            emit({ type: 'activity', state: 'retrying', retry: { attempt, next, message, reason, limit: retrying.limit } });
          } else if (p.status?.type === 'busy' && retrying) {
            // 再試行が始まった（通れば、続く出来事で考えている・書いているに替わる）
            retrying = null;
            emit({ type: 'activity', state: 'running' });
          }
          return false;
        case 'session.error':
          if (p.error) error = errorOf(p.error);
          return false;
        case 'session.idle':
          idle = true;
          return true;
        default:
          return false;
      }
    },
    /** 付け直しで発言を取り直した後: 途中の本文・考えの部品は、次の部品の更新まで差分を捨てる（溜めた差分は取り直した本文に入っている） */
    resync() { for (const entry of parts.values()) if (!entry.done && (entry.type === 'text' || entry.type === 'reasoning')) entry.resync = true; },
    get error() { return error; },
    get usage() { return { ...usage }; },
    get idle() { return idle; },
    get wroteText() { return wroteText; },
    get pristine() { return !wroteText && !usedTool; },
    /** 今の再試行の待ち（retryOf の形。待っていなければ null） */
    get retrying() { return retrying; },
    /** 待っても通らない上限の再試行（retryOf の形。無ければ null）。呼ぶ側がターンを止め、limited で終える */
    get limit() { return limit; },
  };
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * GET /session/{id}/message の返り（[{ info, parts }]）-> NormalizedMessage[]。
 * 圧縮の要約（assistant の summary: true）は区切り（compactSummary）にし、圧縮の印だけの user の発言（compaction の部品）は落とす。
 * 本文の無い user の発言（入力欄の `!` で OpenCode が足した synthetic の行など）も落とす
 */
export function messagesToNormalized(list, { fullResults = false } = {}) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const info = m?.info ?? {};
    const parts = m?.parts ?? [];
    if (!info.id) continue;
    const at = iso(info.time?.created);
    if (info.role === 'user') {
      if (parts.some((p) => p?.type === 'compaction')) continue;
      const text = partText(parts, 'text');
      if (!text) continue;
      out.push({ role: 'user', text, uuid: info.id, at });
      continue;
    }
    if (info.role !== 'assistant') continue;
    const text = partText(parts, 'text');
    if (info.summary) {
      out.push({ role: 'system', kind: 'compactSummary', text: '', summary: text, boundary: true, uuid: info.id, at });
      continue;
    }
    const thinking = partText(parts, 'reasoning');
    const toolCalls = parts.filter((p) => p?.type === 'tool').map((p) => {
      const done = p.state?.status === 'completed' || p.state?.status === 'error';
      const result = done ? toolResult(p, { full: fullResults }) : null;
      return { id: String(p.callID ?? p.id), name: toolName(p.tool), input: toolInput(p), result: result ? { text: result.text, isError: result.isError, truncated: result.truncated, ...(result.images ? { images: result.images } : {}) } : null };
    });
    if (!text && !thinking && !toolCalls.length) continue;
    out.push({ role: 'assistant', text, uuid: info.id, at, ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
  }
  return out;
}

/** OpenCode の会話の行 -> listSessions の行 */
export function sessionRow(s) {
  if (!s?.id) return null;
  return {
    sessionId: s.id,
    title: s.title || null,
    cwd: s.directory ?? null,
    createdAt: iso(s.time?.created),
    lastModified: Number.isFinite(s.time?.updated) ? s.time.updated : null,
    tag: null,   // 状態タグは無い。Pleiad の控えが正本（capabilities.tag: false）
  };
}
