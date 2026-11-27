import { z } from 'zod';
import { defineOp, OpError } from './registry.mjs';

const id = z.uuid();
const session = { sessionId: z.string().min(1).max(200).optional() };
const property = z.union([z.literal('title'), id]);
const value = z.union([
  z.string().max(8000), z.number(), z.boolean(), z.array(id).max(100),
  z.strictObject({ date: z.iso.date() }), z.strictObject({ instant: z.string(), timeZone: z.string() }),
]);
const filter = z.union([
  z.strictObject({ propertyId: property, op: z.enum(['empty', 'not_empty']) }),
  z.strictObject({ propertyId: property, op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains']), value }),
]);
const change = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('appendParagraph'), text: z.string().min(1).max(16_000).regex(/^[^\x00-\x1f]+$/).refine(text => text.trim().length > 0) }),
  z.strictObject({ kind: z.literal('replaceText'), text: z.string().max(16_000).regex(/^[^\x00-\x1f]*$/) }),
]);
const version = z.string().regex(/^\d+:\d+$/);

function requestOf(ctx, { sessionId: requested, ...input }) {
  const bound = ctx.actor.sessionId;
  if (ctx.actor.by === 'agent' && (!bound || requested && requested !== bound)) {
    throw new OpError('WORKSPACE_CONVERSATION_REQUIRED', 'Use the workspace of the conversation that made this call.');
  }
  const sessionId = bound ?? requested;
  if (!sessionId) throw new OpError('WORKSPACE_CONVERSATION_REQUIRED', 'Choose a conversation first.');
  return { sessionId, input };
}

function operationInput(ctx, args, name) {
  const request = requestOf(ctx, args);
  const { input } = request;
  if (name === 'writePage' && (input.change.kind === 'replaceText') !== Boolean(input.blockId)) {
    throw new OpError('INVALID', 'Supply a block ID to replace text. Omit it to append a paragraph.');
  }
  return request;
}

function workspaceOp(name, shape, output, write = false) {
  const prepared = new WeakMap();
  return defineOp({
    id: 'workspace.' + name,
    summary: 'agent:ops.workspace.' + name + '.summary',
    risk: write ? 'guarded' : 'read',
    scope: 'session',
    input: z.object(Object.fromEntries(Object.entries({ ...session, ...shape })
      .map(([key, schema]) => [key, schema.describe('agent:ops.workspace.fields.' + key)]))),
    output,
    surfaces: { ui: true, cli: false, mcp: 'catalog' },
    ...(write ? { async confirm(ctx, args) {
      const { sessionId, input } = operationInput(ctx, args, name);
      const grant = await ctx.workspace.prepare(sessionId, name, input);
      prepared.set(ctx, grant);
      return {
        before: { tenantId: grant.tenantId, uid: grant.uid, sessionId },
        rows: Object.entries({ workspace: grant.tenantId, ...input }).map(([key, after]) =>
          ({ path: 'workspace.' + key, before: null, after: JSON.stringify(after) })),
      };
    } } : {}),
    async handler(ctx, args) {
      const { sessionId, input } = operationInput(ctx, args, name);
      const grant = prepared.get(ctx) ?? await ctx.workspace.prepare(sessionId, name, input);
      return ctx.workspace.execute(name, input, grant);
    },
  });
}

export const workspaceOps = [
  workspaceOp('search', { query: z.string().max(256).optional(), limit: z.int().min(1).max(100).optional() },
    z.object({ pages: z.array(z.object({ pageId: id, title: z.string(), kind: z.string(), databaseId: id.nullable() })), more: z.boolean() })),
  workspaceOp('readPage', { pageId: id },
    z.object({ pageId: id, title: z.string(), version, markdown: z.string(), blocks: z.array(z.object({ id, type: z.string() })) })),
  workspaceOp('writePage', { pageId: id, baseVersion: version, blockId: id.optional(), change, requestId: id },
    z.object({ pageId: id, blockId: id, version }), true),
  workspaceOp('queryDatabase', {
    databaseId: id, viewId: id.optional(), filters: z.array(filter).max(20).optional(),
    sorts: z.array(z.strictObject({ propertyId: property, direction: z.enum(['asc', 'desc']) })).max(8).optional(),
    offset: z.int().min(0).max(2147483647).optional(), limit: z.int().min(1).max(500).optional(),
  }, z.object({ properties: z.array(z.object({
    id, name: z.string(), kind: z.string(), options: z.array(z.object({ id, label: z.string() })),
  })), rows: z.array(z.object({ id, title: z.string(), version: z.number(), values: z.record(id, value.nullable()) })), nextOffset: z.number().nullable() })),
  workspaceOp('createTask', { databaseId: id, title: z.string().min(1).max(200), values: z.record(id, value.nullable()).optional(), requestId: id },
    z.object({ id, version: z.number() }), true),
];
