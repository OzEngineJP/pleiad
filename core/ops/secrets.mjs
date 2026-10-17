// secrets.*: 設定 › 秘密情報と変数（core/secrets.mjs。ADR 0217）。
//
// 値は返さない（変数の値だけは返す）。危険度は ADR 0217 の表のとおり:
//   一覧 read・変数 write・使い道を狭める write／広げる guarded・削除 guarded・AI が作った値 guarded・人に頼む write。
//   人の項目の秘密の値を入れる・差し替える（secrets.save・secrets.import・secrets.answerRequest）は human-only（「秘密の値」の組。ADR 0094）。
// 本体はサーバーが ctx.secrets で渡す（core/server.mjs の secretsOps）。
import { z } from 'zod';
import { defineOp, OpError } from './registry.mjs';
import { SecretsError, MAX_LABEL, MAX_NOTE, MAX_VALUE, MAX_SITES, MAX_FOLDERS, MAX_USERNAME, normalizeScope, normalizeSite } from '../secrets.mjs';

const D = (op, arg) => `agent:ops.secrets.${op}.${arg}`;
const mapped = async (fn) => {
  try { return await fn(); }
  catch (e) { throw e instanceof SecretsError ? new OpError(e.code, e.message) : e; }
};
const loose = z.record(z.string(), z.unknown());
const scope = z.union([z.literal('all'), z.object({ folders: z.array(z.string().min(1).max(1024)).min(1).max(MAX_FOLDERS) })]);
const env = z.object({ name: z.string().min(1).max(128), scope: scope.optional() });
const sites = z.array(z.string().min(1).max(300)).max(MAX_SITES);

const agentOf = (ctx) => ctx.principal?.by === 'agent';
const target = (ctx, id) => (id.startsWith('key-') ? ctx.secrets.keyUse(id) : ctx.secrets.store.known(id));

/** 渡す場所が広がるか（無かった → ある・フォルダー → すべて・フォルダーが増える） */
function scopeWidens(before, after) {
  if (!after) return false;
  if (!before) return true;
  if (after === 'all') return before !== 'all';
  if (before === 'all') return false;
  const had = new Set(before.folders.map((f) => f.toLowerCase()));
  return after.folders.some((f) => !had.has(f.toLowerCase()));
}
/** 使い道（環境変数・サイト）の変更が、AI に使わせる範囲を広げるか */
async function usesWiden(ctx, { id, env: nextEnv, sites: nextSites }) {
  const before = await target(ctx, id);
  if (!before) return false;
  if (before.kind === 'var') return false;   // 変数は画面にも出す値で、広げても秘密は出ない
  if (nextEnv !== undefined) {
    const after = nextEnv ? normalizeScope(nextEnv.scope ?? 'all') : null;
    if (scopeWidens(before.env?.scope ?? null, after)) return true;
  }
  if (nextSites !== undefined) {
    const had = new Set(before.sites ?? []);
    if (nextSites.map(normalizeSite).some((s) => s && !had.has(s))) return true;
  }
  return false;
}
const scopeText = (s) => (!s ? null : s === 'all' ? 'all' : s.folders.join(', '));

export const secretOps = [
  defineOp({
    id: 'secrets.list',
    summary: 'agent:ops.secrets.list.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({ items: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['secrets', 'list'] } },
    // AI・CLI は値の無い一覧（変数の値だけ）。画面は台帳そのもの（変数の値・API キーの使い道・暗号化の状態）
    handler: (ctx) => mapped(() => ctx.secrets.store.agentList()),
    uiHandler: (ctx) => mapped(() => ctx.secrets.store.list()),
  }),

  // 人が入れる・変える（秘密の値を含む）。画面だけ
  defineOp({
    id: 'secrets.save',
    summary: 'agent:ops.secrets.save.summary',
    risk: 'human-only',
    input: z.object({
      id: z.string().max(40).optional().describe(D('save', 'id')),
      kind: z.enum(['login', 'secret', 'var']).optional().describe(D('save', 'kind')),
      label: z.string().max(MAX_LABEL * 2).optional().describe(D('save', 'label')),
      note: z.string().max(MAX_NOTE * 2).optional().describe(D('save', 'note')),
      username: z.string().max(MAX_USERNAME).optional().describe(D('save', 'username')),
      value: z.string().max(MAX_VALUE).optional().describe(D('save', 'value')),
      password: z.string().max(MAX_VALUE).optional().describe(D('save', 'password')),
      sites: sites.optional().describe(D('save', 'sites')),
      env: env.nullable().optional().describe(D('save', 'env')),
      toSecret: z.boolean().optional().describe(D('save', 'toSecret')),
    }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx, { id, kind, value, password, ...rest }) => mapped(async () => {
      if (!id) {
        if (!kind) throw new SecretsError('INVALID');
        return ctx.secrets.store.create({ kind, value, password, ...rest }, { by: 'human' });
      }
      const item = ctx.secrets.store.known(id);
      if (!item) throw new SecretsError('NOT_FOUND');
      const patch = { ...rest };
      if (item.kind === 'var' && value !== undefined) patch.value = value;
      if (item.kind === 'secret' && value) patch.secretValue = value;
      if (item.kind === 'login' && password) patch.secretValue = password;
      return ctx.secrets.store.update(id, patch);
    }),
  }),
  defineOp({
    id: 'secrets.import',
    summary: 'agent:ops.secrets.import.summary',
    risk: 'human-only',
    input: z.object({
      entries: z.array(z.object({ name: z.string().max(200), value: z.string().max(MAX_VALUE), secret: z.boolean() })).max(500).describe(D('import', 'entries')),
      scope: scope.optional().describe(D('import', 'scope')),
      overwrite: z.boolean().optional().describe(D('import', 'overwrite')),
    }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx, { entries, scope: s, overwrite }) => mapped(() => ctx.secrets.store.importEnv(entries, { scope: s ?? 'all', overwrite: overwrite === true })),
  }),

  // 変数（秘密でない値。画面にも出す）。AI も足せる
  defineOp({
    id: 'secrets.setVariable',
    summary: 'agent:ops.secrets.setVariable.summary',
    risk: 'write',
    riskReason: 'A variable is a non-secret value that is shown on screen as is (NODE_ENV=development); it is passed to the shell of later turns of conversations in its folders. It cannot touch a secret value, a password or an API key (secrets.save / secrets.create), and turning a secret back into a variable is refused (ADR 0217)',
    input: z.object({
      id: z.string().max(40).optional().describe(D('setVariable', 'id')),
      name: z.string().min(1).max(128).describe(D('setVariable', 'name')),
      value: z.string().max(MAX_VALUE).describe(D('setVariable', 'value')),
      scope: scope.optional().describe(D('setVariable', 'scope')),
      note: z.string().max(MAX_NOTE).optional().describe(D('setVariable', 'note')),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['secrets', 'set-variable'] } },
    handler: (ctx, { id, name, value, scope: s, note }) => mapped(async () => {
      const envValue = { name, scope: s ?? 'all' };
      if (!id) {
        const { id: created } = await ctx.secrets.store.create({ kind: 'var', label: name, value, env: envValue, note }, { by: agentOf(ctx) ? 'ai' : 'human' });
        return { id: created, name };
      }
      const item = ctx.secrets.store.known(id);
      if (!item) throw new SecretsError('NOT_FOUND');
      if (item.kind !== 'var') throw new SecretsError('NOT_VARIABLE');
      await ctx.secrets.store.update(id, { value, env: { name, scope: s ?? item.env?.scope ?? 'all' }, ...(item.label === item.env?.name ? { label: name } : {}), ...(note !== undefined ? { note } : {}) });
      return { id, name };
    }),
  }),

  // 使い道（環境変数・サイト）。API キー（key-…）は環境変数とメモだけ
  defineOp({
    id: 'secrets.setUses',
    summary: 'agent:ops.secrets.setUses.summary',
    risk: 'write',
    riskReason: 'Narrowing how a saved value is used (no longer passing it as an environment variable, fewer folders, removing a site) only reduces what the agent can use, and renaming the variable changes nothing about who can read it. Widening it (passing a secret as an environment variable, to more folders or everywhere, or to a new site) is raised to guarded by riskOf (ADR 0217)',
    input: z.object({
      id: z.string().min(1).max(40).describe(D('setUses', 'id')),
      env: env.nullable().optional().describe(D('setUses', 'env')),
      sites: sites.optional().describe(D('setUses', 'sites')),
      note: z.string().max(MAX_NOTE).optional().describe(D('setUses', 'note')),
      reason: z.string().max(500).optional().describe(D('setUses', 'reason')),
    }),
    riskOf: async (ctx, args) => (agentOf(ctx) && await usesWiden(ctx, args) ? 'guarded' : 'write'),
    confirm: async (ctx, args) => {
      const before = await target(ctx, args.id);
      return {
        before: before ? { env: before.env ?? null, sites: before.sites ?? [] } : null, loosens: true,
        rows: [{ path: 'item', before: null, after: before?.label ?? args.id },
          ...(args.env !== undefined ? [{ path: 'env', before: before?.env ? `${before.env.name} · ${scopeText(before.env.scope)}` : null, after: args.env ? `${args.env.name} · ${scopeText(normalizeScope(args.env.scope ?? 'all'))}` : null }] : []),
          ...(args.sites !== undefined ? [{ path: 'sites', before: (before?.sites ?? []).join(', ') || null, after: args.sites.join(', ') || null }] : [])],
      };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['secrets', 'set-uses'] } },
    handler: (ctx, { id, env: nextEnv, sites: nextSites, note }) => mapped(async () => {
      if (id.startsWith('key-')) {
        const r = await ctx.secrets.store.setKeyUse(id, { ...(nextEnv !== undefined ? { env: nextEnv } : {}), ...(note !== undefined ? { note } : {}) });
        return { id, env: r.use?.env ?? null };
      }
      const r = await ctx.secrets.store.update(id, { ...(nextEnv !== undefined ? { env: nextEnv } : {}), ...(nextSites !== undefined ? { sites: nextSites } : {}), ...(note !== undefined ? { note } : {}) });
      return { id, env: r.item.env, sites: r.item.sites };
    }),
  }),

  defineOp({
    id: 'secrets.delete',
    summary: 'agent:ops.secrets.delete.summary',
    risk: 'write',
    riskReason: 'Deleting a variable (a non-secret value shown on screen) can be undone by setting it again. Deleting a secret, a password or a login cannot be undone without a person entering the value again, so riskOf raises it to guarded (ADR 0217)',
    input: z.object({ id: z.string().min(1).max(40).describe(D('delete', 'id')), reason: z.string().max(500).optional().describe(D('delete', 'reason')) }),
    riskOf: (ctx, { id }) => (agentOf(ctx) && ctx.secrets.store.known(id)?.kind !== 'var' ? 'guarded' : 'write'),
    confirm: (ctx, { id }) => {
      const item = ctx.secrets.store.known(id);
      return { before: item ? { id: item.id, updatedAt: item.updatedAt } : null, rows: [{ path: 'item', before: item?.label ?? id, after: null }] };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['secrets', 'delete'], positional: ['id'] } },
    handler: (ctx, { id }) => mapped(async () => { await ctx.secrets.store.remove(id); return { id, deleted: true }; }),
  }),

  // AI が自分で作った値（サービスに作ったアカウントのパスワードなど）。人の項目の値は替えられない
  defineOp({
    id: 'secrets.create',
    summary: 'agent:ops.secrets.create.summary',
    risk: 'guarded',
    input: z.object({
      id: z.string().max(40).optional().describe(D('create', 'id')),
      kind: z.enum(['secret', 'login']).describe(D('create', 'kind')),
      label: z.string().min(1).max(MAX_LABEL).describe(D('create', 'label')),
      value: z.string().max(MAX_VALUE).optional().describe(D('create', 'value')),
      username: z.string().max(MAX_USERNAME).optional().describe(D('create', 'username')),
      password: z.string().max(MAX_VALUE).optional().describe(D('create', 'password')),
      sites: sites.optional().describe(D('create', 'sites')),
      env: env.nullable().optional().describe(D('create', 'env')),
      note: z.string().max(MAX_NOTE).optional().describe(D('create', 'note')),
      reason: z.string().max(500).optional().describe(D('create', 'reason')),
    }),
    confirm: (ctx, args) => {
      const before = args.id ? ctx.secrets.store.known(args.id) : null;
      return {
        before: before ? { id: before.id, updatedAt: before.updatedAt } : null, loosens: true,
        rows: [{ path: 'item', before: before?.label ?? null, after: args.label },
          { path: 'kind', before: before?.kind ?? null, after: args.kind },
          ...(args.sites?.length ? [{ path: 'sites', before: null, after: args.sites.join(', ') }] : []),
          ...(args.env ? [{ path: 'env', before: null, after: `${args.env.name} · ${scopeText(normalizeScope(args.env.scope ?? 'all'))}` }] : [])],
      };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['secrets', 'create'] } },
    handler: (ctx, { id, kind, label, value, username, password, sites: s, env: e, note }) => mapped(async () => {
      if (id) {
        const item = ctx.secrets.store.known(id);
        if (!item) throw new SecretsError('NOT_FOUND');
        if (item.by !== 'ai') throw new SecretsError('HUMAN_ITEM');
        const secretValue = item.kind === 'login' ? password : value;
        const r = await ctx.secrets.store.update(id, { label, ...(secretValue ? { secretValue } : {}), ...(username !== undefined ? { username } : {}),
          ...(s !== undefined ? { sites: s } : {}), ...(e !== undefined ? { env: e } : {}), ...(note !== undefined ? { note } : {}) });
        return { id, label: r.item.label };
      }
      const r = await ctx.secrets.store.create({ kind, label, value, username, password, sites: s, env: e ?? null, note }, { by: 'ai' });
      return { id: r.id, label: r.item.label };
    }),
  }),

  // 人に値を頼む（会話に入力のカードを出す）。値は人の画面から保存先へ直に入り、AI には保存した名前だけが後で届く
  defineOp({
    id: 'secrets.request',
    summary: 'agent:ops.secrets.request.summary',
    risk: 'write',
    riskReason: 'Only shows a card in the calling conversation asking a person to enter a value; nothing is saved or passed unless the person enters it and presses save, and the value never comes back to the agent (only the saved name does, ADR 0217)',
    modeGate: false,
    scope: 'session',
    input: z.object({
      kind: z.enum(['secret', 'login', 'var']).describe(D('request', 'kind')),
      name: z.string().max(128).optional().describe(D('request', 'name')),
      label: z.string().max(MAX_LABEL).optional().describe(D('request', 'label')),
      reason: z.string().min(1).max(500).describe(D('request', 'reason')),
      sites: sites.optional().describe(D('request', 'sites')),
      username: z.string().max(MAX_USERNAME).optional().describe(D('request', 'username')),
      scope: z.enum(['all', 'folder']).optional().describe(D('request', 'scope')),
    }),
    surfaces: { ui: false, mcp: 'catalog', cli: { path: ['secrets', 'request'] } },
    handler: (ctx, args) => mapped(() => ctx.secrets.request(ctx, args)),
  }),
  defineOp({
    id: 'secrets.answerRequest',
    summary: 'agent:ops.secrets.answerRequest.summary',
    risk: 'human-only',
    input: z.object({
      requestId: z.string().min(1).max(100).describe(D('answerRequest', 'requestId')),
      label: z.string().max(MAX_LABEL * 2).optional().describe(D('answerRequest', 'label')),
      value: z.string().max(MAX_VALUE).optional().describe(D('answerRequest', 'value')),
      username: z.string().max(MAX_USERNAME).optional().describe(D('answerRequest', 'username')),
      password: z.string().max(MAX_VALUE).optional().describe(D('answerRequest', 'password')),
      scope: scope.optional().describe(D('answerRequest', 'scope')),
    }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx, args) => mapped(() => ctx.secrets.answer(ctx, args)),
  }),
];
