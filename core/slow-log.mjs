import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** @type {Readonly<{ clientMs: number, serverMs: number, loopMs: number, loopWindowMs: number, submitMs: number }>} */
export const DEFAULT_SLOW_THRESHOLDS = Object.freeze({
  clientMs: 2000,
  serverMs: 1000,
  loopMs: 500,
  loopWindowMs: 1000,
  submitMs: 2000,
});

export const SLOW_LOG_FILENAME = 'slow-commands.log';
export const DEFAULT_SLOW_LOG_MAX_BYTES = 128 * 1024;
const MAX_BATCH_ENTRIES = 100;

const ALLOWED_KINDS = new Set([
  'client-pending',
  'client-rtt',
  'server-cmd',
  'event-loop',
  'submit-wait',
  'submit-switched',
]);
const ALLOWED_SOURCES = new Set(['client', 'server']);
const ALLOWED_OUTCOMES = new Set(['pending', 'ok', 'error', 'closed', 'cancelled', 'switched', 'sent']);
const ALLOWED_PHASES = new Set([
  'newSession',
  'preSend',
  'settings',
  'mode',
  'worktree',
  'postSettings',
  'send',
  'compact',
  'done',
]);

const SAFE_TOKEN_RE = /^[a-zA-Z0-9_.:-]+$/;

const WAIT_MS_KEYS = [
  'newSessionMs',
  'settingsMs',
  'modeMs',
  'worktreeMs',
  'postSettingsMs',
  'sendMs',
  'compactMs',
];
const WAIT_BOOL_KEYS = ['hadSettingsWrite', 'hadModeWrite', 'hadWorktree', 'cancelled', 'switched', 'hasNewSession'];

function parseThreshold(raw, fallback, min = 0) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.round(n);
}

/**
 * Reads threshold overrides from environment variables (primarily for tests/diagnostics).
 */
export function readSlowThresholds(env = process.env) {
  return {
    clientMs: parseThreshold(env?.AGENT_HOST_SLOW_CLIENT_MS, DEFAULT_SLOW_THRESHOLDS.clientMs, 1),
    serverMs: parseThreshold(env?.AGENT_HOST_SLOW_SERVER_MS, DEFAULT_SLOW_THRESHOLDS.serverMs, 1),
    loopMs: parseThreshold(env?.AGENT_HOST_SLOW_LOOP_MS, DEFAULT_SLOW_THRESHOLDS.loopMs, 1),
    loopWindowMs: parseThreshold(env?.AGENT_HOST_SLOW_LOOP_WINDOW_MS, DEFAULT_SLOW_THRESHOLDS.loopWindowMs, 10),
    submitMs: parseThreshold(env?.AGENT_HOST_SLOW_SUBMIT_MS, DEFAULT_SLOW_THRESHOLDS.submitMs, 1),
  };
}

function safeToken(value, maxLen = 80) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return undefined;
  if (!SAFE_TOKEN_RE.test(trimmed)) return undefined;
  return trimmed;
}

function safeMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function safeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function safeAt(value, now) {
  if (typeof value === 'string' && value.length <= 40) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(now()).toISOString();
}

function sanitizeWait(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  if (typeof raw.phase === 'string' && ALLOWED_PHASES.has(raw.phase)) {
    out.phase = raw.phase;
  }
  for (const key of WAIT_MS_KEYS) {
    const ms = safeMs(raw[key]);
    if (ms !== undefined) out[key] = ms;
  }
  for (const key of WAIT_BOOL_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Strips any payload fields (message text, titles, file paths, settings values) and
 * returns a sanitized diagnostic log entry, or null if the entry is invalid.
 */
export function sanitizeSlowEntry(raw, { defaultSource = 'server', now = Date.now } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.kind !== 'string' || !ALLOWED_KINDS.has(raw.kind)) return null;
  const source = typeof raw.source === 'string' && ALLOWED_SOURCES.has(raw.source) ? raw.source : defaultSource;
  if (!ALLOWED_SOURCES.has(source)) return null;

  const entry = {
    at: safeAt(raw.at, now),
    kind: raw.kind,
    source,
  };

  const command = safeToken(raw.command, 80);
  if (command !== undefined) entry.command = command;

  const ms = safeMs(raw.ms);
  if (ms !== undefined) entry.ms = ms;

  const sessionId = safeToken(raw.sessionId, 80);
  if (sessionId !== undefined) entry.sessionId = sessionId;

  if (typeof raw.outcome === 'string' && ALLOWED_OUTCOMES.has(raw.outcome)) {
    entry.outcome = raw.outcome;
  }

  const errorCode = safeToken(raw.errorCode, 64);
  if (errorCode !== undefined) entry.errorCode = errorCode;

  const inFlight = safeCount(raw.inFlight);
  if (inFlight !== undefined) entry.inFlight = inFlight;

  const pendingCount = safeCount(raw.pendingCount);
  if (pendingCount !== undefined) entry.pendingCount = pendingCount;

  const windowMs = safeMs(raw.windowMs);
  if (windowMs !== undefined) entry.windowMs = windowMs;

  const meanMs = safeMs(raw.meanMs);
  if (meanMs !== undefined) entry.meanMs = meanMs;

  const p99Ms = safeMs(raw.p99Ms);
  if (p99Ms !== undefined) entry.p99Ms = p99Ms;

  const wait = sanitizeWait(raw.wait);
  if (wait !== undefined) entry.wait = wait;

  return entry;
}

/**
 * Creates a bounded append-only diagnostic logger (`slow-commands.log`) for slow WS commands,
 * server event-loop stalls, slow client RTTs, and submit wait / switch-away events.
 */
export function createSlowLog({
  dataDir,
  thresholds = readSlowThresholds(),
  maxBytes = DEFAULT_SLOW_LOG_MAX_BYTES,
  now = Date.now,
} = {}) {
  if (!dataDir) throw new Error('createSlowLog: dataDir is required');
  const logPath = path.join(dataDir, SLOW_LOG_FILENAME);
  const effectiveMaxBytes = Math.max(1024, Math.floor(maxBytes));

  let queue = Promise.resolve();
  let dirReady = false;
  let closed = false;
  let loopMonitor = null;
  let loopTimer = null;
  let loopInFlight = null;

  async function writeBlock(block) {
    if (!dirReady) {
      await fs.promises.mkdir(dataDir, { recursive: true });
      dirReady = true;
    }
    const stat = await fs.promises.stat(logPath).catch(() => null);
    const blockBytes = Buffer.byteLength(block, 'utf8');
    if (!stat || stat.size + blockBytes <= effectiveMaxBytes) {
      await fs.promises.appendFile(logPath, block, 'utf8');
      return;
    }
    const prev = await fs.promises.readFile(logPath, 'utf8').catch(() => '');
    const combined = prev + block;
    const keepFrom = Math.max(0, combined.length - Math.floor(effectiveMaxBytes / 2));
    const nl = keepFrom > 0 ? combined.indexOf('\n', keepFrom) : -1;
    const trimmed = nl >= 0 ? combined.slice(nl + 1) : combined.slice(keepFrom);
    await fs.promises.writeFile(logPath, trimmed, 'utf8');
  }

  function enqueueLines(entries, defaultSource) {
    if (closed || !Array.isArray(entries) || entries.length === 0) return 0;
    const lines = [];
    for (const raw of entries.slice(0, MAX_BATCH_ENTRIES)) {
      const entry = sanitizeSlowEntry(raw, { defaultSource, now });
      if (entry) lines.push(JSON.stringify(entry));
    }
    if (lines.length === 0) return 0;
    const block = `${lines.join('\n')}\n`;
    queue = queue.then(() => writeBlock(block)).catch(() => {});
    return lines.length;
  }

  function sampleLoop() {
    if (!loopMonitor) return;
    const rawMax = loopMonitor.max;
    const rawMean = loopMonitor.mean;
    const rawP99 = loopMonitor.percentile(99);
    loopMonitor.reset();
    const maxMs = Number.isFinite(rawMax) ? Math.round(rawMax / 1e6) : 0;
    if (maxMs < thresholds.loopMs) return;
    const meanMs = Number.isFinite(rawMean) ? Math.round(rawMean / 1e6) : 0;
    const p99Ms = Number.isFinite(rawP99) ? Math.round(rawP99 / 1e6) : 0;
    const inFlight = typeof loopInFlight === 'function' ? loopInFlight() : undefined;
    enqueueLines([
      {
        kind: 'event-loop',
        source: 'server',
        ms: maxMs,
        windowMs: thresholds.loopWindowMs,
        meanMs,
        p99Ms,
        ...(inFlight !== undefined ? { inFlight } : {}),
      },
    ], 'server');
  }

  return {
    logPath,
    thresholds: Object.freeze({ ...thresholds }),

    clientConfig() {
      return {
        clientMs: thresholds.clientMs,
        submitMs: thresholds.submitMs,
      };
    },

    recordServerCommand({ command, ms, sessionId, outcome = 'ok', errorCode, inFlight } = {}) {
      if (command === 'invoke:app.reportSlow') return 0;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < thresholds.serverMs) return 0;
      return enqueueLines([
        {
          kind: 'server-cmd',
          source: 'server',
          command,
          ms,
          sessionId,
          outcome,
          errorCode,
          inFlight,
        },
      ], 'server');
    },

    recordClientBatch(entries) {
      return { recorded: enqueueLines(entries, 'client') };
    },

    startLoopMonitor({ getInFlight } = {}) {
      if (closed || loopMonitor) return;
      loopInFlight = typeof getInFlight === 'function' ? getInFlight : null;
      loopMonitor = monitorEventLoopDelay({ resolution: 20 });
      loopMonitor.enable();
      loopTimer = setInterval(sampleLoop, thresholds.loopWindowMs);
      loopTimer.unref?.();
    },

    flush() {
      return queue;
    },

    async close() {
      if (loopTimer) {
        clearInterval(loopTimer);
        loopTimer = null;
      }
      if (loopMonitor) {
        sampleLoop();
        try { loopMonitor.disable(); } catch {}
        loopMonitor = null;
      }
      closed = true;
      await queue;
    },
  };
}
