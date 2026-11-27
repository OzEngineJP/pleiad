// bot の頭の中の保存（ADR 0126）。SQLite の行（core/db.mjs の brainTable・memoryStateTable。ADR 0115）。
//   brain_stream … 思考の流れ。心拍ごとに 1 行の追記。bot ごとに 30 日・3,000 行まで（それより古い行は追記のたびに落とす）
//   brain_loops  … 気がかり。開いているものは 1 体 12 件まで。解決したものと手放したものも記憶の一覧に残す。
//   memory_state … kind 'brain'（id = botId）= 心拍の状態（カーソル・次に起きる時刻・欲求の前回値・止めた印）
//
//   createBrainStore({ dataDir, now, emit }) → BrainStore
//     append(botId, { kind, text?, refs?, taint?, tokens?, meta? }): Row      … 足した行（seq・at 付き）。kind は STREAM_KINDS
//     list(botId, { before?, limit? }): Row[]（新しい順）・tail(botId, n): Row[]（古い順）・since(botId, at): Row[]・count(botId): number
//     loops(botId, status = 'open'): Loop[]（古い順）・applyLoops(botId, ops, { taint? }): { applied, rejected }
//     state(botId): State・setState(botId, patch): State
//     clear(botId): { stream, loops }   … 人が消す（状態は残す）
//     close(): void   … DB の接続を離す
//   Row: { seq, botId, at, kind, text, refs, taint, tokens, meta }・Loop: { botId, id, status, text, wakeOn, due, taint, createdAt, updatedAt }
//   emit({ type: 'brainChanged', botId }) を、行・気がかり・状態が変わったときに出す（画面の描き直し）
import crypto from 'node:crypto';
import { openData } from '../data-schema.mjs';
import { brainTable, memoryStateTable } from '../db.mjs';
import { followUpTable } from './follow-ups.mjs';
import { WORK_NOTES_VERSION } from './inner.mjs';

export const STREAM_KINDS = Object.freeze(['think', 'quiet', 'act', 'result', 'loop', 'dream', 'summary']);
export const STREAM_TEXT_MAX = 300;
export const STREAM_KEEP_DAYS = 30;
export const STREAM_KEEP_MAX = 3000;
const PRUNE_EVERY = 50;
const DAY_MS = 86_400_000;

const clip = (value, max) => [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
const taintOf = (v) => (v === 'webhook' || v === 'web' ? v : null);

export const emptyState = () => ({
  cursorAt: null, nextAt: null, reservedAt: null, lastBeatAt: null, lastHumanAt: null,
  sinceMuse: 0, failures: 0, drives: null, paused: false, sleepingSince: null,
});

export function createBrainStore({ dataDir, now = Date.now, emit = () => {} } = {}) {
  let handle = null, stream = null, states = null, followUps = null;
  const appends = new Map();
  const open = () => {
    if (!handle) {
      handle = openData(dataDir);
      stream = brainTable(handle.db);
      states = memoryStateTable(handle.db);
      followUps = followUpTable(handle.db, now);
    }
    return stream;
  };
  const changed = (botId, loopsChanged = false) => { try { emit({ type: 'brainChanged', botId, loopsChanged }); } catch { /* 画面への知らせの失敗で保存を戻さない */ } };

  function prune(botId) {
    const t = open();
    t.prune(botId, now() - STREAM_KEEP_DAYS * DAY_MS, STREAM_KEEP_MAX);
  }

  const service = {
    append(botId, { kind, text = '', refs = [], taint = null, tokens = null, meta = null } = {}) {
      if (!STREAM_KINDS.includes(kind)) throw new Error(`brain stream kind must be one of ${STREAM_KINDS.join(' / ')}: ${kind}`);
      const at = now();
      const data = {
        text: clip(text, STREAM_TEXT_MAX),
        ...(refs.length ? { refs: refs.map(String).slice(0, 5) } : {}),
        ...(taintOf(taint) ? { taint: taintOf(taint) } : {}),
        ...(tokens ? { tokens } : {}),
        ...(meta ? { meta } : {}),
      };
      const seq = open().append(botId, at, kind, data);
      const n = (appends.get(botId) ?? 0) + 1;
      appends.set(botId, n);
      if (n % PRUNE_EVERY === 0) prune(botId);
      changed(botId);
      return { seq, botId, at, kind, ...data, text: data.text, refs: data.refs ?? [], taint: data.taint ?? null };
    },
    list: (botId, opts) => open().list(botId, opts),
    tail: (botId, n) => open().tail(botId, n),
    since: (botId, at, limit) => open().since(botId, at, limit),
    count: (botId) => open().count(botId),

    loops(botId, status = 'open') { open(); return followUps.loops(botId, status); },
    /**
     * 気がかりの足す・直す・手放す。add の id が既にあれば直す。外部由来の印は引き継ぐ。
     */
    applyLoops(botId, ops, { taint = null, sources = [], sessionId = null, author, runId, workNotesVersion = WORK_NOTES_VERSION } = {}) {
      open();
      const t = followUps;
      const applied = [];
      let rejected = 0;
      t.transaction(() => {
        for (const op of ops ?? []) {
          const at = now();
          const current = op.id ? t.loop(botId, op.id) : null;
          const text = op.text === undefined ? undefined : String(op.text ?? '').replace(/\s+/g, ' ').trim();
          if ((text !== undefined && (!text || [...text].length > 200)) || (op.op === 'add' && text === undefined)) {
            rejected++;
            continue;
          }
          if (op.op === 'add' && !(current && current.status === 'open')) {
            const id = op.id && !current ? op.id : `l${crypto.randomBytes(3).toString('hex')}`;
            t.putLoop(botId, id, 'open', at, { text, wakeOn: op.wakeOn ?? null, due: op.due ?? null, taint: taintOf(taint),
              sources: op.sources ?? sources, sessionId: op.sessionId ?? sessionId, author, createdAt: at, workNotesVersion });
            applied.push({ op: 'add', id, text });
            continue;
          }
          const target = current ?? null;
          if (!target || (target.status !== 'open' && op.op !== 'add')
            || (op.expect && (target.updatedAt !== op.expect.updatedAt || target.text !== op.expect.text))) { rejected++; continue; }
          if (op.op === 'resolve' || op.op === 'drop') {
            t.putLoop(botId, target.id, op.op === 'resolve' ? 'resolved' : 'dropped', at, target, runId);
            applied.push({ op: op.op, id: target.id, text: target.text });
          } else {   // update（と、開いている id への add）
            const next = { ...target, text: text ?? target.text, ...(op.wakeOn !== undefined ? { wakeOn: op.wakeOn } : {}), ...(op.due !== undefined ? { due: op.due } : {}),
              sources: target.sources?.length ? target.sources : op.sources ?? sources,
              taint: target.taint ?? taintOf(taint), workNotesVersion: op.text ? workNotesVersion : target.workNotesVersion ?? null };
            if (op.due !== undefined && op.due !== target.due) delete next.expiryUndone;
            t.putLoop(botId, target.id, 'open', at, next);
            applied.push({ op: 'update', id: target.id, text: next.text });
          }
        }
      });
      if (applied.length) changed(botId, true);
      return { applied, rejected };
    },

    expireConcerns() {
      open();
      const runId = 'expiry-' + new Date(now()).toISOString().slice(0, 10);
      const bots = followUps.expire(runId);
      for (const botId of bots) changed(botId, true);
    },
    lastExpiry() { open(); return followUps.lastExpiry(); },
    runChanges(runId) { open(); return followUps.changes(runId); },
    undoRunChange(runId, id, rev) {
      open();
      const botId = followUps.undo(runId, id, rev);
      if (botId) changed(botId, true);
      return Boolean(botId);
    },

    state(botId) {
      open();
      return { ...emptyState(), ...(states.get('brain', botId) ?? {}) };
    },
    setState(botId, patch) {
      open();
      const next = { ...service.state(botId), ...patch };
      states.save([['brain', botId, next]]);
      changed(botId);
      return next;
    },

    clear(botId) {
      const t = open();
      const out = { stream: t.clearStream(botId), loops: followUps.clearLoops(botId) };
      changed(botId, out.loops > 0);
      return out;
    },
    purgeBot(botId) {
      service.clear(botId);
      const changes = [['brain', botId, undefined]];
      // 使用量の仕組み（ADR 0119）をやめる前に書いた 'brain.spend' の行が残っていれば、bot を消すときに一緒に消す（読み込みには使わない）
      for (const key of Object.keys(states.ofKind('brain.spend'))) if (key.endsWith('/' + botId)) changes.push(['brain.spend', key, undefined]);
      states.save(changes);
    },
    close() { handle?.release(); handle = null; stream = null; states = null; followUps = null; },
  };
  return service;
}

export function concernSources(session, sessionId) {
  if (session?.channelId) return [{ kind: 'post', channelId: session.channelId, ...(session.threadId ? { threadId: session.threadId } : {}) }];
  return sessionId ? [{ kind: 'message', sessionId }] : [];
}
