import { randomUUID } from 'node:crypto';
import { registry } from '../../core/ops/index.mjs';
import { receiptOf } from '../../core/ops/registry.mjs';
import { createWorkspaceOperations } from '../../core/plus/workspace.mjs';

export const name = 'workspace-ops';
export const title = 'ワークスペース操作の所属と承認';

export default async function (t) {
  const pageId = randomUUID();
  const blockId = randomUUID();
  let tenantId = randomUUID();
  let signedIn = true;
  let card;
  const calls = [];
  const workspace = createWorkspaceOperations({
    workspaceOf: async (id) => id === 'own' ? 'personal' : null,
    session: {
      status: async () => ({ signedIn, uid: 'user' }),
      client: { async request(_method, path, { body, headers }) {
        calls.push({ path, body, headers });
        if (path.endsWith('/grant')) return { tenantId, ticket: 'opaque' };
        if (path.endsWith('/search')) return { pages: [], more: false };
        return { pageId, blockId, version: '1:1' };
      } },
    },
  });
  const actor = { by: 'agent', via: 'mcp', sessionId: 'own' };
  const deps = { workspace, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }),
    approve: async (request) => { card = request; return { pending: true, requestId: 'approval-request' }; } };
  const input = { pageId, baseVersion: '1:0', requestId: randomUUID(), change: { kind: 'appendParagraph', text: 'task' } };
  t.ok('MCP lists the five workspace operations', registry.list(actor).filter(({ id }) => id.startsWith('workspace.')).length === 5);
  const pending = await registry.invoke(actor, 'workspace.writePage', input, deps);
  t.ok('The write stops at approval and its content stays on the host', pending.pending && calls.length === 1 &&
    calls[0].path.endsWith('/grant') && !JSON.stringify(calls[0].body).includes('task') && calls[0].body.targetId === pageId);
  t.ok('The approval card includes the requested change', card.change.rows.some(row =>
    row.path === 'workspace.change' && JSON.parse(row.after).text === input.change.text));
  t.ok('The approval receipt binds the request and change', card.receipt === receiptOf(card.op, input, card.change.before) &&
    card.receipt !== receiptOf(card.op, { ...input, requestId: randomUUID() }, card.change.before) &&
    card.receipt !== receiptOf(card.op, { ...input, change: { ...input.change, text: 'different' } }, card.change.before));
  tenantId = randomUUID();
  const renewed = await card.proceed();
  t.ok('A different tenant requires a new approval', renewed.pending && calls.every(({ path }) => path.endsWith('/grant')));
  const executed = await card.proceed();
  t.ok('Approval sends exactly one scoped write', executed.ok && executed.result?.version === '1:1' &&
    calls.filter(({ headers }) => headers?.['x-pleiad-workspace-grant'] === 'opaque').length === 1 &&
    calls.at(-1).path.includes(tenantId) && calls[0].body.expectedUid === 'user' && calls[0].body.workspace === 'personal');
  t.ok('Agents cannot use a different conversation', (await registry.invoke(actor, 'workspace.search', { sessionId: 'another' }, deps)).code === 'WORKSPACE_CONVERSATION_REQUIRED');
  t.ok('MCP calls require a bound conversation', (await registry.invoke({ by: 'agent', via: 'mcp' }, 'workspace.search', { sessionId: 'own' }, deps)).code === 'WORKSPACE_CONVERSATION_REQUIRED');
  t.ok('Read-only mode denies writes', (await registry.invoke(actor, 'workspace.writePage', input,
    { ...deps, modeOf: async () => ({ scope: 'readonly', autonomy: 'ask' }) })).code === 'READ_ONLY_MODE');
  signedIn = false;
  t.ok('Signed-out users get a sign-in reason for reads and writes',
    (await registry.invoke(actor, 'workspace.search', {}, deps)).code === 'WORKSPACE_SIGN_IN_REQUIRED' &&
    (await registry.invoke(actor, 'workspace.writePage', input, deps)).code === 'WORKSPACE_SIGN_IN_REQUIRED');
}
