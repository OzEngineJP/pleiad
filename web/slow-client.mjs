/**
 * Client-side slow command & submit-wait diagnostic tracker.
 * Queues timing records locally and flushes asynchronously via `app.reportSlow`
 * without ever blocking user actions or storing message text / paths / titles.
 */
export function createSlowClient({
  sendBatch,
  thresholds: initialThresholds = { clientMs: 2000, submitMs: 2000 },
  now = () => Date.now(),
  monoNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  isConnected = () => true,
  maxQueue = 200,
} = {}) {
  const thresholds = {
    clientMs: positiveInt(initialThresholds?.clientMs, 2000),
    submitMs: positiveInt(initialThresholds?.submitMs, 2000),
  };

  const queue = [];
  let inFlight = 0;
  let flushing = false;
  let flushScheduled = false;

  function positiveInt(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.round(value) : fallback;
  }

  function applyTestOverrides() {
    const ov = typeof globalThis !== 'undefined' ? globalThis.__slowThresholds : null;
    if (!ov || typeof ov !== 'object') return;
    if (ov.clientMs !== undefined) thresholds.clientMs = positiveInt(ov.clientMs, thresholds.clientMs);
    if (ov.submitMs !== undefined) thresholds.submitMs = positiveInt(ov.submitMs, thresholds.submitMs);
  }

  applyTestOverrides();

  function configure(next) {
    if (next && typeof next === 'object') {
      thresholds.clientMs = positiveInt(next.clientMs, thresholds.clientMs);
      thresholds.submitMs = positiveInt(next.submitMs, thresholds.submitMs);
    }
    applyTestOverrides();
  }

  function enqueue(entry) {
    queue.push(entry);
    if (queue.length > maxQueue) {
      queue.splice(0, queue.length - maxQueue);
    }
  }

  function requeueFront(batch) {
    if (!batch?.length) return;
    queue.unshift(...batch);
    if (queue.length > maxQueue) {
      queue.splice(0, queue.length - maxQueue);
    }
  }

  async function flush() {
    if (flushing || !queue.length || typeof sendBatch !== 'function' || !isConnected()) return;
    flushing = true;
    try {
      while (queue.length > 0 && isConnected()) {
        const batch = queue.splice(0, 50);
        try {
          await sendBatch(batch);
        } catch {
          if (!isConnected()) requeueFront(batch);
          break;
        }
      }
    } finally {
      flushing = false;
      if (queue.length > 0 && isConnected()) scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushing || flushScheduled || queue.length === 0 || !isConnected()) return;
    flushScheduled = true;
    Promise.resolve().then(() => {
      flushScheduled = false;
      void flush();
    });
  }

  function cmdLabelOf(command, args) {
    if (command === 'invoke' && typeof args?.op === 'string') return `invoke:${args.op}`;
    return typeof command === 'string' ? command : '';
  }

  function sessionIdOf(args) {
    if (typeof args?.sessionId === 'string') return args.sessionId;
    if (typeof args?.args?.sessionId === 'string') return args.args.sessionId;
    return undefined;
  }

  function track(command, args, promise) {
    if (!promise || (command === 'invoke' && args?.op === 'app.reportSlow')) return promise;
    applyTestOverrides();
    const cmdLabel = cmdLabelOf(command, args);
    const sessionId = sessionIdOf(args);
    const startMono = monoNow();
    inFlight += 1;
    let settled = false;
    let overdue = false;

    const timer = setTimer(() => {
      if (settled || !isConnected()) return;
      overdue = true;
      enqueue({
        at: new Date(now()).toISOString(),
        kind: 'client-pending',
        source: 'client',
        command: cmdLabel,
        ms: Math.max(0, Math.round(monoNow() - startMono)),
        ...(sessionId ? { sessionId } : {}),
        outcome: 'pending',
        pendingCount: inFlight,
      });
      scheduleFlush();
    }, thresholds.clientMs);

    const onSettled = (ok, err) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      inFlight = Math.max(0, inFlight - 1);
      const elapsed = Math.max(0, Math.round(monoNow() - startMono));
      if (!overdue && elapsed < thresholds.clientMs) return;
      const outcome = ok ? 'ok' : (isConnected() ? 'error' : 'closed');
      const errorCode = !ok && typeof err?.code === 'string' ? err.code : undefined;
      enqueue({
        at: new Date(now()).toISOString(),
        kind: 'client-rtt',
        source: 'client',
        command: cmdLabel,
        ms: elapsed,
        ...(sessionId ? { sessionId } : {}),
        outcome,
        ...(errorCode ? { errorCode } : {}),
      });
      scheduleFlush();
    };

    promise.then(() => onSettled(true, null), (err) => onSettled(false, err));
    return promise;
  }

  function recordSubmitWait({ sessionId, ms, outcome = 'sent', wait } = {}) {
    applyTestOverrides();
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < thresholds.submitMs) return false;
    enqueue({
      at: new Date(now()).toISOString(),
      kind: 'submit-wait',
      source: 'client',
      command: 'submit',
      ms: Math.max(0, Math.round(ms)),
      ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
      outcome,
      ...(wait ? { wait } : {}),
    });
    scheduleFlush();
    return true;
  }

  function recordSubmitSwitched({ sessionId, ms = 0, wait } = {}) {
    enqueue({
      at: new Date(now()).toISOString(),
      kind: 'submit-switched',
      source: 'client',
      command: 'submit',
      ms: Math.max(0, Math.round(ms)),
      ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
      outcome: 'switched',
      ...(wait ? { wait } : {}),
    });
    scheduleFlush();
  }

  return {
    get thresholds() {
      applyTestOverrides();
      return { ...thresholds };
    },
    get queueSize() {
      return queue.length;
    },
    configure,
    track,
    recordSubmitWait,
    recordSubmitSwitched,
    flush,
  };
}
