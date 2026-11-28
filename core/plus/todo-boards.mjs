import { z } from 'zod';
import { defineOp, OpError } from '../ops/registry.mjs';

const ref = z.object({
  tenantId: z.uuid(), workspaceId: z.uuid(), databaseId: z.uuid(), viewId: z.uuid(),
});
const catalog = z.object({
  boards: z.array(ref.extend({ title: z.string(), viewName: z.string(), workspaceName: z.string().nullable() })),
});
const board = z.object({
  title: z.string(), viewName: z.string(),
  url: z.url({ protocol: /^https?$/ }),
  columns: z.array(z.object({ id: z.uuid(), label: z.string() })),
  conversation: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  rows: z.array(z.object({
    title: z.string(), columnId: z.uuid().nullable(),
    conversationStates: z.array(z.enum(['not_started', 'running', 'completed', 'failed'])),
  })),
});
const base = '/v1/todo-boards';
const unavailable = () => new OpError('TODO_BOARDS_UNAVAILABLE', 'Could not read the Plus board');

export function createTodoBoards(session) {
  async function read(path, schema, isBoard = false) {
    const state = session.snapshot();
    if (!state.signedIn) throw new OpError(state.available ? 'TODO_BOARDS_SIGN_IN' : 'TODO_BOARDS_UNAVAILABLE', 'Plus sign-in is required');
    try {
      const value = await session.client.request('GET', path, { redirect: 'error' });
      const latest = session.snapshot();
      // A response from the previous account must never reach the current screen.
      if (!latest.signedIn || latest.uid !== state.uid) throw unavailable();
      return schema.parse(value);
    } catch (error) {
      if (error.status === 401 || error.code === 'unauthenticated') throw new OpError('TODO_BOARDS_SIGN_IN', 'Plus sign-in is required');
      if (error.status === 403 || (error.status === 404 && isBoard && error.code === 'not_found')) {
        throw new OpError('TODO_BOARDS_FORBIDDEN', 'This Plus board cannot be opened');
      }
      throw unavailable();
    }
  }

  return {
    catalog: () => read(base, catalog),
    board: ({ tenantId, workspaceId, databaseId, viewId, offset }) =>
      read(`${base}/${tenantId}/${workspaceId}/${databaseId}/${viewId}?offset=${offset}`, board, true),
  };
}

export const todoBoardOps = [
  defineOp({
    id: 'todoBoards.catalog', summary: 'agent:ops.todoBoards.catalog.summary', risk: 'read',
    input: z.object({}), output: catalog, surfaces: { ui: true, mcp: false, cli: false },
    handler: ctx => ctx.todoBoards.catalog(),
  }),
  defineOp({
    id: 'todoBoards.read', summary: 'agent:ops.todoBoards.read.summary', risk: 'read',
    input: ref.extend({ offset: z.number().int().min(0).max(2147483647).default(0) }), output: board,
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx, args) => ctx.todoBoards.board(args),
  }),
];
