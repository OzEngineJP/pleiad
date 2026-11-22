import { randomUUID } from 'node:crypto';
import { t } from './i18n.mjs';
import { OpError } from './ops/registry.mjs';

export function createDesktopLifecycleClient({ port, version, timeoutMs = 10_000 }) {
  const waiting = new Map();
  port.on('message', ({ data }) => {
    if (data?.type === 'desktop-lifecycle') waiting.get(data.id)?.(data);
  });
  port.on('disconnect', () => {
    for (const finish of waiting.values()) finish(null);
  });
  return async function lifecycle(action, args, actor) {
    const unavailable = code => {
      const reason = code === 'server' ? t('lifecycle.server') : t('lifecycle.disconnected');
      if (action !== 'status') throw new OpError('DESKTOP_UNAVAILABLE', reason);
      const capability = { supported: false, reason };
      return { version, channel: null, target: null, phase: 'unavailable', progress: null, error: null,
        prepare: capability, apply: capability, restart: capability, result: null };
    };
    if (!port.hosted) return unavailable('server');
    const id = randomUUID();
    const reply = await new Promise(resolve => {
      const finish = data => { clearTimeout(timer); waiting.delete(id); resolve(data); };
      const timer = setTimeout(() => finish(null), action === 'prepare' ? 15 * 60_000 : timeoutMs);
      waiting.set(id, finish);
      if (!port.postMessage({ type: 'desktop-lifecycle', id, action, args, owner: actor?.sessionId ?? null })) finish(null);
    });
    if (!reply) return unavailable('disconnected');
    if (!reply.ok) throw new OpError('DESKTOP_LIFECYCLE_FAILED', reply.error);
    return reply.result;
  };
}
