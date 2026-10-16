// 次の発言の候補（docs/design.md「次の発言の候補」、ADR 0211）。返答が終わった会話の、空の入力欄にグレーで出す 1 行。
//
// 作り方はエージェントで違う:
//   - Claude: Claude Code の予測（Agent SDK の promptSuggestions）。ターンの中で prompt_suggestion が届く（core/backends/claude.mjs）。
//     親の会話のキャッシュに相乗りするので、ほぼ使用量を使わない
//   - Codex・Antigravity: ネイティブの予測が無い（Codex は app-server に口が無い。TUI に一度入って外された）。ターンの後に、
//     直近の発言の要約をこの指示と一緒に軽いモデルへ 1 回渡して作る（backend.suggestNext）。
//     会話の fork で作ると、Codex は新しいスレッドの id でキャッシュが分かれ、会話が長いほど 1 回ごとに全量を払う（2026-10-15 実測）。
//     要約なら会話の長さによらず、1 回の費用がほぼ一定になる
// 返りを読む・切る・作りかけを止めるのはここ（バックエンドに依らない）。前後を作るのは core/server.mjs（suggestAfterTurn）。

/** 候補の上限（字）。Codex の TUI の予測と同じ */
export const SUGGESTION_MAX = 240;
/** 作り始めてから諦めるまで */
export const SUGGESTION_TIMEOUT_MS = 90_000;
/** 要約に入れる発言の数・1 件の字数（最後の返答だけ長く）・全体の字数 */
const GIST_MESSAGES = 8;
const GIST_CHARS = 1_500;
const GIST_LAST_REPLY_CHARS = 4_000;
const GIST_TOTAL_CHARS = 12_000;

const SCHEMA = { type: 'object', properties: { suggestion: { type: ['string', 'null'] } }, required: ['suggestion'], additionalProperties: false };

// モデルへの指示。会話の言語に依らず英語で渡し、候補は利用者の書く言語で作らせる（画面の文言ではないので辞書に置かない）。
// 本文は Codex の TUI の予測の指示（codex-rs/tui/assets/prompt_suggestion.txt。openai/codex #47911）に、要約で渡すことを足したもの
const INSTRUCTION = [
  'This is an app-generated request for a suggested next user message. The user did not write this message.',
  '',
  "Your suggestion will appear in the user's empty message composer. They can accept it, edit it, or ignore it; it will not be sent automatically.",
  '',
  'Below is the recent part of a conversation between the user and an AI agent, oldest first. The last entry is the agent\'s latest reply.',
  '',
  "Predict this user's next message from the conversation. Before choosing a new content question, consider whether they want an operation on material already produced. The object may be the assistant's own answer, a draft, a list, a comparison, or an external artifact. They may want to reuse it in a different form, make it easier to read or copy, obtain more items of the same kind, retry an earlier response after discussing its flaw, or make one precise change. Choose such a move only when the user's purpose, prior reactions, or intended use supports it. Preserve the actual object and requested deliverable; an adjacent explanation or extra content is a different action. If no transformation is supported, choose the strongest grounded question, reply, or continuation. Keep the necessary linked requirements, without inventing observations or a new agenda.",
  '',
  `Write it in the language the user writes in. Set suggestion to exactly one natural message in the user's voice, one line, at most ${SUGGESTION_MAX} characters. No alternatives or explanation. Prefer a grounded prediction; use null only if every concrete next move is arbitrary. Do not use any tools.`,
  '',
  `Return only JSON matching this schema: ${JSON.stringify(SCHEMA)}.`,
].join('\n');

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * 会話の履歴（NormalizedMessage の配列）から、候補を作るための要約を作る。人と AI の本文だけ（システムの行・ツール・思考は入れない）。
 * 最後が AI の返答でなければ作らない（null）。新しい方から GIST_MESSAGES 件、全体は GIST_TOTAL_CHARS 字まで
 */
export function suggestionGist(messages) {
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.kind && !m.internalTaskNotice && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim());
  if (rows.at(-1)?.role !== 'assistant') return null;
  const picked = [];
  let total = 0;
  for (let i = rows.length - 1; i >= 0 && picked.length < GIST_MESSAGES; i--) {
    const m = rows[i];
    const text = clip(m.text.trim(), i === rows.length - 1 ? GIST_LAST_REPLY_CHARS : GIST_CHARS);
    if (picked.length && total + text.length > GIST_TOTAL_CHARS) break;
    total += text.length;
    picked.unshift(`[${m.role === 'user' ? 'user' : 'agent'}]\n${text}`);
  }
  return picked.join('\n\n');
}

/** モデルへ渡す 1 通（指示 + 要約） */
export function suggestionPrompt(gist) {
  return `${INSTRUCTION}\n\n<conversation>\n${gist}\n</conversation>`;
}

/**
 * モデルの返り（{"suggestion": …} の JSON。前後に字や ``` が付くこともある）から候補を取り出す。
 * 1 行に畳み、前後の引用符を落とす。空・null・上限を超えたもの・JSON でないものは null
 */
export function parseSuggestion(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value;
  try { value = JSON.parse(text.slice(start, end + 1))?.suggestion; } catch { return null; }
  return cleanSuggestion(value);
}

/** 候補の文を 1 行に整える。使えなければ null（Claude の予測もここを通す） */
export function cleanSuggestion(value) {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/g, ' ').trim().replace(/^["'「『](.*)["'」』]$/s, '$1').trim();
  if (!line || line.length > SUGGESTION_MAX) return null;
  return line;
}

/**
 * 会話ごとの作りかけ。同じ会話で新しく始めたら前のものは止める（新しいターン・送信でも止める）。
 * run(signal) は生の返り（parseSuggestion で読む）を返す。onSuggestion(sessionId, text) は読めたときだけ呼ぶ
 */
export function createSuggestionJobs({ onSuggestion, onError = () => {}, timeoutMs = SUGGESTION_TIMEOUT_MS } = {}) {
  const jobs = new Map();   // sessionId -> AbortController
  function cancel(sessionId) {
    const ac = jobs.get(sessionId);
    if (!ac) return false;
    jobs.delete(sessionId);
    ac.abort();
    return true;
  }
  function start(sessionId, run) {
    cancel(sessionId);
    const ac = new AbortController();
    jobs.set(sessionId, ac);
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    const done = (async () => {
      try {
        const raw = await run(ac.signal);
        if (ac.signal.aborted || jobs.get(sessionId) !== ac) return;
        const text = parseSuggestion(raw);
        if (text) onSuggestion(sessionId, text);
      } catch (error) {
        if (!ac.signal.aborted) onError(sessionId, error);
      } finally {
        clearTimeout(timer);
        if (jobs.get(sessionId) === ac) jobs.delete(sessionId);
      }
    })();
    return done;
  }
  return {
    start, cancel,
    cancelAll() { for (const id of [...jobs.keys()]) cancel(id); },
    has: (sessionId) => jobs.has(sessionId),
    get size() { return jobs.size; },
  };
}
