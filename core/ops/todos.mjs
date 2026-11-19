// todos.*: 会話の ToDo（ADR 0342。本体は core/todos.mjs、handler は ctx.todos（core/server.mjs の opsDeps）を呼ぶ）。
// 画面（会話の ToDo のパネル）と AI（ply_control の list_ops / call_op）が同じ操作を使う。AI への使い方の説明は、
// 既定の「会話の ToDo」で利用のタイミングを伝え、ここの summary（web/locales/*/agent.json の ops.todos.*）で引数を説明する。
//
// 危険度: 書く操作は write。会話の中の自分用のメモで、送る・消える・権限が広がることは無い（会話を消せば一緒に消える）。
// AI は sessionId を省けば自分の会話。ほかの会話の ToDo も、題や状態と同じく人と同じ扱いで書ける（ADR 0082）。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';
import { byAgent } from './redact.mjs';
import { TODO_ITEMS_MAX, TODO_LINKS_MAX, TODO_PATH_MAX, TODO_STATUSES, TODO_TEXT_MAX, TODO_TITLE_MAX, TODO_URL_MAX, LINK_KINDS } from '../todos.mjs';

const D = (id, key) => `agent:ops.todos.${id}.${key}`;
const RISK_REASON = "A to-do item is a note inside one conversation. Writing it sends nothing, deletes no work and widens no permission; it is removed together with the conversation. A human can edit another conversation's to-dos too, so an agent is treated the same (ADR 0082)";

const sessionId = id => z.string().min(1).max(200).optional().describe(D(id, 'sessionId'));
const ifRev = id => z.number().int().min(0).optional().describe(D(id, 'ifRev'));
const linkInput = id => z.object({
  kind: z.enum(LINK_KINDS).optional(),
  path: z.string().max(TODO_PATH_MAX).optional(),
  url: z.string().max(TODO_URL_MAX).optional(),
  title: z.string().max(TODO_TITLE_MAX).optional(),
}).describe(D(id, 'link'));
const status = id => z.enum(TODO_STATUSES).optional().describe(D(id, 'status'));
const after = id => z.array(z.string().min(1).max(80)).max(TODO_ITEMS_MAX).optional().describe(D(id, 'after'));
const links = id => z.array(linkInput(id)).max(TODO_LINKS_MAX).optional().describe(D(id, 'links'));

const linkOut = z.object({ id: z.string(), kind: z.enum(LINK_KINDS), path: z.string().optional(), url: z.string().optional(), title: z.string().optional() });
const byOut = z.object({ kind: z.enum(['user', 'agent']), backend: z.string().optional() }).nullable();
const itemOut = z.object({
  id: z.string(), text: z.string(), status: z.enum(TODO_STATUSES), waiting: z.boolean(), after: z.array(z.string()), links: z.array(linkOut),
  order: z.number(), by: byOut, updatedBy: byOut, createdAt: z.number().nullable(), updatedAt: z.number().nullable(),
});
const listOut = z.object({ sessionId: z.string(), rev: z.number().int(), items: z.array(itemOut) });

/** AI は sessionId を省けば自分の会話。画面は省けない */
function target(ctx, given) {
  const id = given ?? (byAgent(ctx) ? ctx.actor?.sessionId : null);
  if (!id) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
  return id;
}
const missing = (ctx, id) => new OpError('SESSION_NOT_FOUND', agentT(ctx.locale, 'ops.errors.SESSION_NOT_FOUND', { id }));
/** 書いた人。AI は自分の会話のエージェント（画面の「Claude が完了」の名前に使う） */
async function byOf(ctx) {
  if (!byAgent(ctx)) return { kind: 'user' };
  const own = ctx.actor?.sessionId ? await ctx.sessions.get(ctx.actor.sessionId).catch(() => null) : null;
  const backend = own?.row?.backend; // ctx.sessions.get は { row, children, history }
  return backend ? { kind: 'agent', backend: String(backend) } : { kind: 'agent' };
}
/** core/todos.mjs の TodoError を、AI が読み分けられる OpError に */
function opError(ctx, e) {
  if (!e?.code || !['INVALID', 'NOT_FOUND', 'CONFLICT', 'CYCLE'].includes(e.code)) return e;
  if (e.code === 'INVALID') return new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: e.message }));
  if (e.code === 'NOT_FOUND') return new OpError('TODO_NOT_FOUND', agentT(ctx.locale, 'ops.errors.TODO_NOT_FOUND', { id: e.detail?.id ?? '' }));
  if (e.code === 'CONFLICT') return new OpError('TODO_CONFLICT', agentT(ctx.locale, 'ops.errors.TODO_CONFLICT', { rev: e.detail?.rev ?? '' }));
  return new OpError('TODO_CYCLE', agentT(ctx.locale, 'ops.errors.TODO_CYCLE', { id: e.detail?.id ?? '' }));
}
/** 書く前に会話があるか確かめ、書いて、決まった形で返す */
async function write(ctx, given, fn) {
  const id = target(ctx, given);
  if (!(await ctx.sessions.get(id))) throw missing(ctx, id);
  const by = await byOf(ctx);
  try { return { sessionId: id, ...fn({ kind: 'session', id }, by) }; }
  catch (e) { throw opError(ctx, e); }
}

export const todoOps = [
  defineOp({
    id: 'todos.list', summary: D('list', 'summary'), risk: 'read', scope: 'session',
    input: z.object({ sessionId: sessionId('list') }),
    output: listOut,
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['todos', 'list'], positional: ['sessionId'] } },
    handler: async (ctx, { sessionId: given }) => {
      const id = target(ctx, given);
      // 画面は開いている会話を読むだけ（会話の確かめは一覧ごとに重いので、AI のときだけ）
      if (byAgent(ctx) && !(await ctx.sessions.get(id))) throw missing(ctx, id);
      try { return { sessionId: id, ...ctx.todos.list({ kind: 'session', id }) }; }
      catch (e) { throw opError(ctx, e); }
    },
  }),
  defineOp({
    id: 'todos.add', summary: D('add', 'summary'), risk: 'write', riskReason: RISK_REASON, scope: 'session',
    input: z.object({
      sessionId: sessionId('add'),
      items: z.array(z.object({
        text: z.string().min(1).max(TODO_TEXT_MAX).describe(D('add', 'text')),
        status: status('add'), after: after('add'), links: links('add'),
        ref: z.string().min(1).max(40).optional().describe(D('add', 'ref')),
      })).min(1).max(TODO_ITEMS_MAX).describe(D('add', 'items')),
      before: z.string().min(1).max(80).optional().describe(D('add', 'before')),
      ifRev: ifRev('add'),
    }),
    output: listOut,
    surfaces: { ui: true, mcp: 'catalog', cli: true },
    handler: (ctx, { sessionId: given, items, before, ifRev: rev }) =>
      write(ctx, given, (scope, by) => ctx.todos.add(scope, { entries: items, before, ifRev: rev, by })),
  }),
  defineOp({
    id: 'todos.update', summary: D('update', 'summary'), risk: 'write', riskReason: RISK_REASON, scope: 'session',
    input: z.object({
      sessionId: sessionId('update'),
      items: z.array(z.object({
        id: z.string().min(1).max(80).describe(D('update', 'id')),
        text: z.string().min(1).max(TODO_TEXT_MAX).optional().describe(D('update', 'text')),
        status: status('update'), after: after('update'), links: links('update'),
        addLinks: z.array(linkInput('update')).max(TODO_LINKS_MAX).optional().describe(D('update', 'addLinks')),
        removeLinks: z.array(z.string().max(TODO_URL_MAX)).max(TODO_LINKS_MAX).optional().describe(D('update', 'removeLinks')),
        before: z.string().min(1).max(80).nullable().optional().describe(D('update', 'before')),
      })).min(1).max(TODO_ITEMS_MAX).describe(D('update', 'items')),
      ifRev: ifRev('update'),
    }),
    output: listOut,
    surfaces: { ui: true, mcp: 'catalog', cli: true },
    handler: (ctx, { sessionId: given, items, ifRev: rev }) =>
      write(ctx, given, (scope, by) => ctx.todos.update(scope, { changes: items, ifRev: rev, by })),
  }),
  defineOp({
    id: 'todos.remove', summary: D('remove', 'summary'), risk: 'write', riskReason: RISK_REASON, scope: 'session',
    input: z.object({
      sessionId: sessionId('remove'),
      ids: z.array(z.string().min(1).max(80)).min(1).max(TODO_ITEMS_MAX).describe(D('remove', 'ids')),
      ifRev: ifRev('remove'),
    }),
    output: listOut,
    surfaces: { ui: true, mcp: 'catalog', cli: true },
    handler: (ctx, { sessionId: given, ids, ifRev: rev }) =>
      write(ctx, given, (scope, by) => ctx.todos.remove(scope, { ids, ifRev: rev, by })),
  }),
  defineOp({
    id: 'todos.checkLinks', summary: D('checkLinks', 'summary'), risk: 'read', scope: 'session',
    input: z.object({ sessionId: sessionId('checkLinks'), id: z.string().min(1).max(80).describe(D('checkLinks', 'id')) }),
    output: z.object({ links: z.array(z.object({ id: z.string(), exists: z.boolean() })) }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: async (ctx, { sessionId: given, id }) => {
      const sid = target(ctx, given);
      try { return ctx.todos.checkLinks({ kind: 'session', id: sid }, { id }); }
      catch (e) { throw opError(ctx, e); }
    },
  }),
];
