const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const TASK_LINK_PATH = '/_remote/task-link';

export function createTaskLinkHandler({ create, lookup, read, save, list, request, identity }) {
  const pending = new Map();
  const delivered = new Map();
  const path = (link) => '/v1/task-links/' + link.tenantId + '/' + link.requestId;
  const ticket = (link) => request('POST', path(link) + '/ticket', { body: { hostId: link.hostId } });

  async function publish(sessionId) {
    if (pending.has(sessionId)) return pending.get(sessionId);
    const work = (async () => {
      const meta = await read(sessionId);
      const link = meta?.taskLink;
      if (!link || !meta.creationReady) return;
      const state = meta.turnStartedAt ? 'running' : meta.interrupted || meta.taskLinkFailed ? 'failed'
        : meta.completedAt ? 'completed' : 'not_started';
      let status = meta.taskLinkStatus;
      if (status?.state !== state) {
        status = { state, version: (status?.version ?? 0) + 1 };
        await save(sessionId, status);
      }
      if (delivered.get(sessionId) === status.version || !identity(link)) return;
      const { token } = await ticket(link);
      await request('POST', path(link) + '/state', {
        auth: false, headers: { 'x-pleiad-task-link-ticket': token },
        body: { hostId: link.hostId, openRef: sessionId, ...status },
      });
      delivered.set(sessionId, status.version);
    })();
    pending.set(sessionId, work);
    try { await work; }
    finally { pending.delete(sessionId); }
  }

  let timer;
  function start() {
    if (timer) return;
    let sweeping = false;
    const sweep = async () => {
      if (sweeping) return;
      sweeping = true;
      try {
        for (const [id, meta] of Object.entries(await list())) {
          if (meta.taskLink) await publish(id).catch(() => {});
        }
      } finally { sweeping = false; }
    };
    timer = setInterval(() => void sweep().catch(() => {}), 5_000);
    timer.unref();
    void sweep().catch(() => {});
  }

  async function handle(scope, input) {
    if (!scope || !uuid.test(scope.tenantId ?? '') || !identity(scope)) return null;
    const { uid, tenantId, hostId } = scope;
    if (input?.action === 'open' && typeof input.openRef === 'string' && uuid.test(input.openRef)) {
      const meta = await read(input.openRef);
      const link = meta?.taskLink;
      if (!meta?.creationReady || link?.uid !== uid || link.tenantId !== tenantId || link.hostId !== hostId) return null;
      await ticket(link);
      return { sessionId: input.openRef };
    }
    if (input?.action !== 'start' || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) return null;
    const link = { requestId: input.requestId, tenantId, uid, hostId };
    const { agent, openRef } = await ticket(link);
    if (typeof agent !== 'string' || !agent) return null;
    const requestId = 'task-link:' + tenantId + ':' + input.requestId;
    const existing = await lookup(requestId);
    if (openRef && existing?.id !== openRef) return null;
    const { sessionId } = await create({ requestId, backend: agent, taskLink: link }, scope);
    await publish(sessionId);
    return { sessionId };
  }
  return { handle, publish, start };
}

export async function serveTaskLink(stream, scope, handle) {
  const result = await handle(scope, stream.request.taskLink).catch(() => null);
  if (stream.destroyed) return;
  await stream.respond({ status: result ? 200 : 403, headers: { 'content-type': 'application/json' } });
  if (result) await stream.write(Buffer.from(JSON.stringify(result)));
  await stream.end();
}
