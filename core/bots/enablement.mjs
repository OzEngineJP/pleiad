import { OpError } from '../ops/registry.mjs';
import { agentT } from '../i18n.mjs';

export function createBotEnablement({ read, existing, locale, changed, now = Date.now }) {
  let current = null;
  let reading;
  let transition = Promise.resolve();
  let closing = false;
  let generation = 0;
  let background = new AbortController();
  const running = new Set();

  async function track(sessionId, manual, work) {
    const controller = manual ? null : new AbortController();
    const entry = { sessionId, manual, controller, done: Promise.resolve().then(() => work(controller?.signal)) };
    running.add(entry);
    try { return await entry.done; }
    finally { running.delete(entry); }
  }

  async function load() {
    if (current) return current;
    reading ??= (async () => {
      const saved = (await read()).botEnablement;
      const next = typeof saved?.enabled === 'boolean'
        ? saved : { enabled: await existing(), since: 0 };
      return current = next;
    })().finally(() => { reading = null; });
    return reading;
  }

  const enabled = () => !closing && current?.enabled === true;
  const error = () => new OpError('BOT_DISABLED', agentT(locale(), 'settings.botDisabled'));
  const allowed = async () => {
    try { await load(); return enabled(); } catch { return false; }
  };
  async function requireEnabled() {
    await load();
    if (!enabled()) throw error();
  }

  return {
    load, enabled, allowed, requireEnabled, error,
    since: () => current?.since ?? 0,
    generation: () => generation,
    backgroundSignal: () => background.signal,
    finishing: (sessionId) => Boolean(sessionId && [...running].some(entry => entry.sessionId === sessionId && entry.manual)),
    promote(sessionId) {
      if (!enabled()) return;
      for (const entry of running) if (entry.sessionId === sessionId) entry.manual = true;
    },
    track,
    async run(sessionId, isManual, work) {
      if (!await allowed() || !enabled()) return 'cancelled';
      return track(sessionId, isManual, work);
    },
    set(value, save) {
      const next = transition.then(async () => {
        const previous = await load();
        closing = !value;
        try {
          const saved = { enabled: value, since: value === previous.enabled ? previous.since : now() };
          await save(saved);
          if (value !== previous.enabled) {
            generation++;
            if (value) background = new AbortController();
            else {
              background.abort();
              const draining = [];
              for (const entry of running) {
                if (entry.manual) draining.push(entry.done);
                else entry.controller?.abort();
              }
              await Promise.allSettled(draining);
            }
          }
          current = saved;
        } finally {
          closing = false;
        }
        await changed(value, previous.enabled);
      });
      transition = next.catch(() => {});
      return next;
    },
  };
}
