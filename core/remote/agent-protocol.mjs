// 端末の AI からの委譲の口 /agent の取り決め（docs/remote.md §4.5、ADR 0146）。ホスト（agent-port.mjs）と端末（agent-link.mjs・
// ローカルのサーバーの core/remote-delegation.mjs）が同じ定数と検査を使う。純粋な部品だけ。
import crypto from 'node:crypto';

/** 口の path。接続口が自分で受ける（forward.mjs はローカルのサーバーへ通さない） */
export const AGENT_PATH = '/agent';
export const AGENT_PROTO = 1;
/** AI の依頼として口に出す操作は、委譲の 6 つだけ（任意の操作を呼ぶ道は無い） */
export const AGENT_OPS = Object.freeze(['delegate', 'status', 'wait', 'send', 'cancel', 'list']);
/** 端末ごとの上限（ADR 0146）: 動いているタスク・delegate と send の頻度・1 つの便りの大きさ・同時の依頼 */
export const AGENT_LIMITS = Object.freeze({ active: 8, perMinute: 20, messageBytes: 256 * 1024, pending: 32, portsPerDevice: 4, pendingPerDevice: 64, viewsPerConn: 4 });
/** 完了した便りに載せる結果の長さ（ply_task_status の 1 ページと同じ） */
export const RESULT_PAGE = 16_000;
/** ホストが ready で名乗る機能の印（口の版 AGENT_PROTO は上げず、追加の能力はここに足す。古い端末は知らない項目を無視する） */
export const AGENT_FEATURES = Object.freeze({
  instructionAnchor: true,   // 経過の読み出しが、追加の指示の受付位置（anchor・taskInstruction の印の行）を運ぶ
  instructionSteer: true,    // send が走っている子のターンへ即座に渡す（次のターン送りにならない）
});
/** 端末が受け取った features を正規化する（知っている印だけ・boolean に）。古いホスト（features 無し）は全部 false */
export function normalizeAgentFeatures(value) {
  const f = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.keys(AGENT_FEATURES).map(k => [k, f[k] === true]));
}

/**
 * タスクの便り（{ t:'task' } の task・delegate/status/wait/send/cancel の応答の task）の項目と、端末の写し（台帳の行）の項目の対応の正本。
 * 送る側（core/server.mjs の remoteTaskEvent）・写す側（core/remote-delegation.mjs の patchOf）・受ける側（core/agent-tasks.mjs の MIRROR_FIELDS）は
 * すべてここから導く（写しに載せる項目を足す・変えるときは、この表を変える）。
 *   wire   便りの項目の名前
 *   mirror 写しの項目の名前（省略は便りと同じ。載せない項目は書かない）
 *   plain  true は値をそのまま写す（便りに無ければ写しから消す）。省略は値の畳み方が項目ごとに違う（status は見せかけの判定、
 *          result は終わったものだけ、routing は形を直す、telemetry は活動の写しの各項目へ分ける）ので、写す側の個別の処理が持つ
 */
export const REMOTE_TASK_FIELDS = Object.freeze([
  { wire: 'taskId' },                  // 写しの鍵（写しの項目ではない）
  { wire: 'requesterSessionId' },      // 端末自身の会話（写しには載せない）
  { wire: 'notification' },            // 通知の状態は端末側で決める（写さない）
  { wire: 'createdAt' }, { wire: 'updatedAt' },   // 写しは自分の時刻を持つ
  { wire: 'title', plain: true },
  { wire: 'status', mirror: 'hostWaiting' },      // 'waiting' の見せかけ → 写しの hostWaiting
  { wire: 'rawStatus', mirror: 'status' },        // 便りの rawStatus（無ければ status）が写しの status
  { wire: 'error', plain: true },
  { wire: 'backend', plain: true }, { wire: 'model', plain: true }, { wire: 'effort', plain: true },
  { wire: 'mode', plain: true }, { wire: 'cwd', plain: true },
  { wire: 'sessionId', mirror: 'remoteSessionId', plain: true },   // ホストでの会話
  { wire: 'worktree', plain: true },
  { wire: 'routing', mirror: 'routing' },         // 形を直して写す（mode:'host'・decidedBy:'host'）
  { wire: 'result', mirror: 'result' }, { wire: 'resultLength', mirror: 'resultLength' },   // 終わったものだけ
  { wire: 'instructionRevision', plain: true },   // 追加の指示の記録の変化の番号（端末の強制再読みに使う）
  { wire: 'pendingMessages', mirror: 'hostPendingMessages', plain: true },   // ホストで待機中の追加指示の件数
  { wire: 'telemetry', mirror: ['hostTelemetry', 'hostLockWaiting', 'hostBackground', 'lastActivityAt', 'lastOutputAt', 'activeCommands'] },
]);

/** 仮の親の ID。端末の会話の ID はホストに無いので、この形で「祖先」として扱う（ADR 0146） */
export const REMOTE_OWNER_PREFIX = 'remote:';

export const remoteOwnerId = (deviceId, sessionId) => `${REMOTE_OWNER_PREFIX}${deviceId}:${sessionId}`;
export const isRemoteOwner = id => typeof id === 'string' && id.startsWith(REMOTE_OWNER_PREFIX);
/** 'remote:<deviceId>:<sessionId>' → { deviceId, sessionId }（形が違えば null）。deviceId は ':' を含まない */
export function parseRemoteOwner(id) {
  if (!isRemoteOwner(id)) return null;
  const rest = id.slice(REMOTE_OWNER_PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  return { deviceId: rest.slice(0, i), sessionId: rest.slice(i + 1) };
}

/** 口の便りで返す失敗の種類。code はエージェントに返す文にも使う */
export class AgentError extends Error {
  constructor(code, message, extra = {}) { super(message ?? code); this.name = 'AgentError'; this.code = code; Object.assign(this, extra); }
}

const SCOPES = ['none', 'readonly', 'workspace', 'full'];
const AUTONOMIES = ['ask', 'judge', 'never'];
const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';

/** 端末が送る依頼元。形を正規化する（承認モードの位置は core/modes.mjs の modePosition と同じ形。不明な値は弱い側へ） */
export function normalizeRequester(value) {
  const r = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const sessionId = text(r?.sessionId, 200);
  if (!sessionId || sessionId.includes('\0')) return null;
  const m = r?.mode && typeof r.mode === 'object' ? r.mode : {};
  return {
    sessionId, title: text(r?.title, 200), backend: text(r?.backend, 40), locale: text(r?.locale, 20),
    mode: {
      scope: SCOPES.includes(m.scope) ? m.scope : 'workspace',
      autonomy: AUTONOMIES.includes(m.autonomy) ? m.autonomy : 'ask',
      enforced: m.enforced === true,
    },
  };
}

/**
 * 中継する承認の受領証。承認の ID・タスク・道具・入力（質問なら質問の中身も）に結んだ hash（ADR 0082 の受領証の考え）。
 * ホストが中継したときに作り、答えに添えて返させる
 */
export function relayReceipt({ id, taskId, toolName, input, questions, salt }) {
  return crypto.createHash('sha256').update(JSON.stringify([salt, id, taskId, toolName ?? '', input ?? null, questions ?? null])).digest('hex');
}

/** 人の答えのうち、口へ運ぶ項目（質問の答え・注釈・自由記述）。大きさを絞る（承認の答えと同じ 1 通の上限の中で） */
export function normalizeAnswerExtras(msg) {
  const bounded = (v, max) => { if (v == null) return null; try { return JSON.stringify(v).length <= max ? v : null; } catch { return null; } };
  return {
    answers: bounded(msg?.answers, 16 * 1024), annotations: bounded(msg?.annotations, 16 * 1024),
    response: typeof msg?.response === 'string' ? msg.response.slice(0, 8 * 1024) : bounded(msg?.response, 16 * 1024),
  };
}

export const sameReceipt = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
