// hooks.*: Hooks。各エージェントの元の設定ファイルの定義（core/hooks-config.mjs）と、Pleiad 自身の登録と担当（<data>/hooks.json。core/ply-hooks.mjs、ADR 0049）。
// 画面の WS コマンド（scanHooks・savePlyHook など）はこの操作を呼ぶ薄い外側（ADR 0095）。本体はサーバーが ctx.hooks で渡す（core/server.mjs の opsDeps）。
// Hooks はエージェントの操作のたびに任意のコマンドを動かすので、書き込み（保存・写す・有効にする・担当・修復・削除）は guarded。
// 例外: 書く前の確認（dryRun）は書かないので write、無効にする向き（togglePlyHook の enabled: false、一覧で Pleiad の登録を外す向き）は関所を狭めるので write（riskOf が上げる）。
// 一覧（hooks.set*）でエージェントの設定の定義・作業場所の Hooks を外す向きは、利用者の見張りの Hook を止めるので hooks.setOwner と同じ guarded。
// 返りのコマンドはモジュールが形で伏せる（maskText）。agent にはさらに、会話の記録に載るコマンドも伏せる。
// 定義 1 つを読む hooks.read・hooks.readPly（readHook・readPlyHook。ADR 0094）は、画面の編集のシートには元のコマンドを、agent には形で伏せたコマンドを返す。
import { z } from 'zod';
import { t } from '../i18n.mjs';
import { HOOK_AGENTS, maskText } from '../hooks-config.mjs';
import { defineOp, OpError } from './registry.mjs';
import { diffRows } from './settings.mjs';
import { byAgent, cwdFor, hasMask, restoreMasked, run, sessionFor } from './redact.mjs';

const D = (id, key) => `agent:ops.hooks.${id}.${key}`;
const A = (key) => `agent:ops.hooks.arg.${key}`;

const reason = z.string().max(500).optional().describe(A('reason'));
const cwd = z.string().max(4096).optional().describe(A('cwd'));
const loose = z.record(z.string(), z.unknown());

/** agent への返り: command という名前の文字列を、形で伏せる（画面の行はもう伏せてある。会話の記録の登録などに残った分の網） */
function maskCommands(value) {
  if (Array.isArray(value)) return value.map(maskCommands);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'command' && typeof v === 'string' ? maskText(v) : maskCommands(v)]));
  return value;
}
const shown = (ctx, value) => (byAgent(ctx) ? maskCommands(value) : value);
/** 定義 1 つの command（元の文字列）: 人にはそのまま、agent には形で伏せる */
const masked = (ctx, value) => (ctx.principal.by === 'human' || typeof value?.command !== 'string' ? value : { ...value, command: maskText(value.command) });

/**
 * Hook × エージェントの一覧に移った（hooks-agents.json がある）人の、旧い担当の操作（担当の切り替え・場所ごとの担当・取り込み・切り替えの確認・写す）は、
 * 実行時に効かないので、効いたように見せず理由と新しい操作の名前で断る（ADR 0338）。承認のカードを出す前（riskOf）に断る
 */
async function refuseIfMoved(ctx, op) {
  if (await ctx.hooks?.agents?.exists?.()) throw new OpError('HOOKS_MOVED', t('hooksAgents.legacyMoved', { op }));
}

/** 書く前の確認（dryRun）は書かないので write のまま、書くときだけ guarded */
const unlessDryRun = (_ctx, args) => (args.dryRun === true ? 'write' : 'guarded');

/** Pleiad の登録 1 つを承認カードに出す形（コマンドは伏せる） */
const hookView = (h) => (h ? { name: h.name, agent: h.agent, event: h.event, matcher: h.matcher || undefined, command: maskText(String(h.command ?? '')), targets: h.targets, enabled: h.enabled !== false } : null);
const findHook = (view, id) => (view?.hooks ?? []).find((h) => h.id === id) ?? null;

/**
 * agent が読んだ（伏せた）コマンドをそのまま書き戻したら、元のコマンドを残す。元を伏せた形と同じでなければ断る。
 * original は伏せる前のコマンド（無ければ伏せ字は戻せない）
 */
const keepCommand = (ctx, command, original, where) => (typeof command === 'string' && hasMask(command)
  ? restoreMasked(ctx, command, typeof original === 'string' ? maskText(original) : undefined, original, where) : command);

/** Hook × エージェントの一覧の行 1 つ（承認カードの名前）。読めなければ key のまま */
async function agentsRow(ctx, key, cwd) {
  const m = await ctx.hooks.agents.matrix({ cwd: cwd ?? null, trust: false }).catch(() => null);
  return { matrix: m, row: m?.rows.find((r) => r.key === key) ?? null };
}
/**
 * 承認のカードの文に、この操作で Devin の取り込みが止まり始める（core の試算 dry の devinImportsStop）ことを足す（ADR 0338）。
 * 試算が読めない・断られるなら足さない（実行の時に同じ理由で断る）。外す向きで write のまま通る操作（Pleiad の登録を外す・使わない）は、
 * Devin へ渡すものを減らすだけで取り込みを止め始めないので、試算しない（riskOf が guarded にした操作だけここを通る）
 */
async function withStopNote(note, preview) {
  let stops = false;
  try { stops = (await preview())?.devinImportsStop === true; } catch { stops = false; }
  return stops ? t('opsApproval.hooksDevinImportsStop', { note }) : note;
}
const rowLabel = (row, key) => row?.name ?? (row ? `${row.event ?? ''} ${maskText(row.command ?? '')}`.trim() : key);
const agentKey = z.string().min(1).max(40);
const revision = z.string().max(100).optional().describe(D('setAgent', 'revision'));
// 外す向きの強さは、同じ結果になる今の操作にそろえる（ADR 0095・0338）。
//   Pleiad の登録（h-…）を外す = togglePlyHook の enabled: false と同じ write。
//   エージェントの設定の定義（hk-…）・作業場所の Hooks（ws:hooks）・組 own / place を外す = 利用者の見張りの Hook を止めるので、
//   hooks.setOwner・hooks.saveNative と同じ guarded（承認のカード）。入れる向きは、コマンドが動き始めるのでいつも guarded
const isReg = (key) => typeof key === 'string' && key.startsWith('h-');
const NARROWS = 'Turning a Pleiad registration (h-…) off only narrows what runs, like hooks.toggle with enabled: false. Turning off an agent\'s own definition (hk-…), the workspace hooks (ws:hooks) or the own/place groups stops a hook the user set in the agent\'s settings, like hooks.setOwner, and turning anything on starts running a command, so riskOf raises those to guarded';

const WRITE_PREVIEW = 'A dry run (dryRun: true) writes nothing and only returns the planned change; writing is raised to guarded by riskOf (hooks run arbitrary commands)';

const defs = [
  // ---- 各エージェントの設定ファイル
  defineOp({
    id: 'hooks.scan', summary: 'agent:ops.hooks.scan.summary', risk: 'read',
    input: z.object({
      cwd,
      scope: z.enum(['user', 'directory']).optional().describe(D('scan', 'scope')),
      trust: z.boolean().optional().describe(D('scan', 'trust')),
    }),
    output: z.object({ files: z.array(loose), entries: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'scan'] } },
    legacyCommand: 'scanHooks',
    handler: async (ctx, args) => run(ctx, async () => shown(ctx, await ctx.hooks.scan({ ...args, cwd: await cwdFor(ctx, args.cwd) }))),
  }),
  defineOp({
    id: 'hooks.read',
    summary: 'agent:ops.hooks.read.summary',
    risk: 'read',
    input: z.object({
      agent: z.enum(HOOK_AGENTS).describe(D('read', 'agent')),
      scope: z.string().min(1).max(40).describe(D('read', 'scope')),
      base: z.string().max(4000).nullable().optional().describe(D('read', 'base')),
      file: z.string().max(4000).nullable().optional().describe(D('read', 'file')),
      loc: z.object({
        event: z.string().min(1).max(100),
        group: z.number().int().min(-1),
        handler: z.number().int().min(0),
        name: z.string().max(200).nullable().optional(),
      }).describe(D('read', 'loc')),
    }),
    output: z.object({
      agent: z.string(), scope: z.string(), path: z.string(), revision: z.string(), event: z.string(), name: z.string().nullable(), matcher: z.string().nullable(),
      command: z.string().nullable(), timeout: z.unknown(), async: z.boolean(), keys: z.array(z.string()), editable: z.boolean(), enabled: z.boolean().optional(),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'read'] } },
    legacyCommand: 'readHook',
    handler: async (ctx, args) => masked(ctx, await ctx.hooks.read({ ...args, base: args.base ?? undefined, file: args.file ?? undefined })),
  }),
  defineOp({
    id: 'hooks.saveNative', summary: 'agent:ops.hooks.saveNative.summary', risk: 'write', riskReason: WRITE_PREVIEW,
    riskOf: unlessDryRun,
    input: z.object({
      items: z.array(loose).min(1).max(12).describe(D('saveNative', 'items')),
      dryRun: z.boolean().optional().describe(A('dryRun')),
      allowReformat: z.boolean().optional().describe(A('allowReformat')),
      reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { items }) => {
      const dry = await ctx.hooks.save({ items, dryRun: true }).catch(() => null);
      const rows = (dry?.results ?? []).slice(0, 8).map((r) => ({ path: `hooks.${r.agent ?? ''}.${r.op ?? ''}`, before: null, after: JSON.stringify(r.path ?? r.error ?? '') }));
      return { key: null, before: (dry?.results ?? []).map((r) => r.revision ?? null), rows, note: t('opsApproval.hooksSaveNative', { count: items.length }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'save-native'] } },
    legacyCommand: 'saveHooks',
    handler: (ctx, { reason: _r, ...args }) => run(ctx, async () => {
      let items = args.items;
      // agent が読んだ（伏せた）コマンドを編集で書き戻したら、元のコマンドを残す
      if (byAgent(ctx)) items = await Promise.all(items.map(async (item, i) => {
        if (item.op !== 'edit' || !hasMask(item.command)) return item;
        const original = await ctx.hooks.read({ agent: item.agent, scope: item.scope, base: item.base, file: item.file, loc: item.loc }).catch(() => null);
        return { ...item, command: keepCommand(ctx, item.command, original?.command, `items[${i}].command`) };
      }));
      return ctx.hooks.save({ ...args, items });
    }),
  }),
  defineOp({
    id: 'hooks.copy', summary: 'agent:ops.hooks.copy.summary', risk: 'write', riskReason: WRITE_PREVIEW,
    riskOf: async (ctx, args) => { await refuseIfMoved(ctx, 'hooks.copy'); return unlessDryRun(ctx, args); },
    input: z.object({
      source: loose.describe(D('copy', 'source')),
      targets: z.array(loose).min(1).max(6).describe(D('copy', 'targets')),
      dryRun: z.boolean().optional().describe(A('dryRun')),
      allowReformat: z.boolean().optional().describe(A('allowReformat')),
      reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { source, targets }) => {
      const dry = await ctx.hooks.copy({ source, targets, dryRun: true }).catch(() => null);
      const rows = (dry?.results ?? []).slice(0, 6).map((r) => ({ path: `hooks.${r.agent ?? ''}`, before: null, after: JSON.stringify(r.command ?? r.error ?? '') }));
      return { key: null, before: [dry?.source?.revision ?? null, ...(dry?.results ?? []).map((r) => r.revision ?? null)], rows, note: t('opsApproval.hooksCopy', { count: targets.length }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'copy'] } },
    legacyCommand: 'copyHooks',
    handler: (ctx, { reason: _r, ...args }) => run(ctx, async () => shown(ctx, await ctx.hooks.copy(args))),
  }),
  defineOp({
    id: 'hooks.session', summary: 'agent:ops.hooks.session.summary', risk: 'read', scope: 'session',
    input: z.object({
      sessionId: z.string().max(200).optional().describe(A('sessionId')),
      backend: z.string().max(40).optional().describe(D('session', 'backend')),
      cwd,
      trust: z.boolean().optional().describe(D('scan', 'trust')),
    }),
    output: z.object({ agent: z.string().nullable(), runs: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'session'] } },
    legacyCommand: 'sessionHooks',
    handler: async (ctx, args) => run(ctx, async () => {
      const sessionId = sessionFor(ctx, args.sessionId);
      return shown(ctx, await ctx.hooks.session({ ...args, sessionId, cwd: await cwdFor(ctx, args.cwd), backend: args.backend ?? (byAgent(ctx) && sessionId ? await ctx.sessionBackend?.(sessionId) : undefined) }));
    }),
  }),

  // ---- Pleiad の登録と担当
  defineOp({
    id: 'hooks.list', summary: 'agent:ops.hooks.list.summary', risk: 'read',
    input: z.object({ cwd }),
    output: z.object({ hooks: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'list'] } },
    legacyCommand: 'plyHooks',
    handler: async (ctx, { cwd: dir }) => run(ctx, async () => shown(ctx, await ctx.hooks.view((await cwdFor(ctx, dir)) ?? null))),
  }),
  defineOp({
    id: 'hooks.readPly',
    summary: 'agent:ops.hooks.readPly.summary',
    risk: 'read',
    input: z.object({ id: z.string().min(1).max(200).describe(D('readPly', 'id')) }),
    output: z.object({ id: z.string(), name: z.string(), agent: z.string(), event: z.string(), matcher: z.string(), command: z.string(), targets: z.array(z.string()), enabled: z.boolean() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'read-ply'], positional: ['id'] } },
    legacyCommand: 'readPlyHook',
    handler: async (ctx, { id }) => masked(ctx, await ctx.hooks.readPly(id)),
  }),
  defineOp({
    id: 'hooks.save', summary: 'agent:ops.hooks.save.summary', risk: 'guarded',
    input: z.object({ value: loose.describe(D('save', 'value')), cwd, reason }),
    approvalWords: 'hooks',
    confirm: async (ctx, { value }) => {
      const view = await ctx.hooks.view(null).catch(() => null);
      const before = value.id ? hookView(findHook(view, value.id)) : null;
      return { key: null, before: view?.revision ?? null, rows: diffRows(`hooks.${value.name ?? value.id ?? ''}`, before, hookView({ ...value, enabled: true })),
        note: value.id ? t('opsApproval.hooksEdit', { name: String(value.name ?? '') }) : t('opsApproval.hooksAdd', { name: String(value.name ?? '') }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'save'] } },
    legacyCommand: 'savePlyHook',
    handler: (ctx, { value, cwd: dir }) => run(ctx, async () => {
      let next = value;
      if (byAgent(ctx) && typeof value.id === 'string' && hasMask(value.command)) {
        const original = await ctx.hooks.readPly(value.id).catch(() => null);
        next = { ...value, command: keepCommand(ctx, value.command, original?.command, 'value.command') };
      }
      return shown(ctx, await ctx.hooks.saveHook(next, (await cwdFor(ctx, dir)) ?? null));
    }),
  }),
  defineOp({
    id: 'hooks.remove', summary: 'agent:ops.hooks.remove.summary', risk: 'guarded',
    input: z.object({ id: z.string().min(1).max(100).describe(A('id')), cwd, reason }),
    approvalWords: 'hookDelete',
    confirm: async (ctx, { id }) => {
      const view = await ctx.hooks.view(null).catch(() => null);
      const h = findHook(view, id);
      return { key: null, before: view?.revision ?? null, rows: diffRows(`hooks.${h?.name ?? id}`, hookView(h), null), note: t('opsApproval.hooksRemove', { name: h?.name ?? id }), loosens: false };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'remove'], positional: ['id'] } },
    legacyCommand: 'removePlyHook',
    handler: (ctx, { id, cwd: dir }) => run(ctx, async () => shown(ctx, await ctx.hooks.remove(id, (await cwdFor(ctx, dir)) ?? null))),
  }),
  defineOp({
    id: 'hooks.toggle', summary: 'agent:ops.hooks.toggle.summary', risk: 'write',
    riskReason: 'Turning a registered hook off only narrows what runs; turning it on is raised to guarded by riskOf (it starts running a command)',
    riskOf: (_ctx, { enabled }) => (enabled === false ? 'write' : 'guarded'),
    input: z.object({ id: z.string().min(1).max(100).describe(A('id')), enabled: z.boolean().optional().describe(D('toggle', 'enabled')), cwd, reason }),
    approvalWords: 'hooks',
    confirm: async (ctx, { id, enabled }) => {
      const view = await ctx.hooks.view(null).catch(() => null);
      const h = findHook(view, id);
      return { key: null, before: view?.revision ?? null, rows: [{ path: `hooks.${h?.name ?? id}.enabled`, before: JSON.stringify(h ? h.enabled !== false : null), after: JSON.stringify(enabled !== false) }],
        note: t('opsApproval.hooksEnable', { name: h?.name ?? id, command: h ? maskText(String(h.command ?? '')) : '' }), loosens: enabled !== false };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'toggle'], positional: ['id'] } },
    legacyCommand: 'togglePlyHook',
    handler: (ctx, { id, enabled, cwd: dir }) => run(ctx, async () => shown(ctx, await ctx.hooks.toggle(id, enabled !== false, (await cwdFor(ctx, dir)) ?? null))),
  }),
  // 担当を変える前の見込み（取り込む定義・止める定義と、hooks.setOwner に渡す imports の digest と revision。ADR 0105）。何も書かない
  defineOp({
    id: 'hooks.unifyPreview', summary: 'agent:ops.hooks.unifyPreview.summary', risk: 'read',
    input: z.object({ cwd: z.string().max(4096).nullable().optional().describe(A('cwd')), direction: z.enum(['ply', 'native']).optional().describe(D('unifyPreview', 'direction')) }),
    output: z.object({ revision: z.unknown() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'unify-preview'] } },
    legacyCommand: 'hooksUnifyPreview',
    handler: async (ctx, { cwd: dir, direction }) => {
      await refuseIfMoved(ctx, 'hooks.unifyPreview');
      return run(ctx, async () => shown(ctx, await ctx.hooks.unifyPreview({ cwd: dir === null ? null : (await cwdFor(ctx, dir)) ?? null, direction: direction ?? 'ply' })));
    },
  }),
  defineOp({
    id: 'hooks.setOwner', summary: 'agent:ops.hooks.setOwner.summary', risk: 'guarded',
    riskOf: async (ctx) => { await refuseIfMoved(ctx, 'hooks.setOwner'); return 'guarded'; },
    input: z.object({
      place: z.string().max(4096).nullable().optional().describe(D('setOwner', 'place')),
      value: z.object({ owner: z.enum(['native', 'ply']), disabled: z.array(z.string().max(100)).max(200).optional() }).passthrough().nullable().optional().describe(D('setOwner', 'value')),
      imports: z.array(z.object({ id: z.string().max(100), digest: z.string().max(200) }).passthrough()).max(100).optional().describe(D('setOwner', 'imports')),
      revision: z.string().max(100).optional().describe(D('setOwner', 'revision')),
      cwd, reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { place, value, imports }) => {
      const view = await ctx.hooks.view(place ?? null).catch(() => null);
      const before = place ? view?.place?.value ?? null : view?.defaults?.value ?? null;
      return { key: null, before: view?.revision ?? null, rows: diffRows(place ? 'hooks.place' : 'hooks.default', before, value ?? null),
        note: t('opsApproval.hooksOwner', { place: place ?? t('opsApproval.everywhere'), count: imports?.length ?? 0 }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'owner'] } },
    legacyCommand: 'setHooksOwner',
    handler: (ctx, { reason: _r, ...args }) => run(ctx, async () => shown(ctx, await ctx.hooks.setOwner(args))),
  }),
  defineOp({
    id: 'hooks.repair', summary: 'agent:ops.hooks.repair.summary', risk: 'guarded',
    input: z.object({ cwd, reason }),
    approvalWords: 'hooks',
    confirm: async (ctx) => {
      const view = await ctx.hooks.view(null).catch(() => null);
      return { key: null, before: view?.revision ?? view?.error ?? null, rows: [], note: t('opsApproval.hooksRepair'), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'repair'] } },
    legacyCommand: 'repairPlyHooks',
    handler: (ctx, { cwd: dir }) => run(ctx, async () => shown(ctx, await ctx.hooks.repair((await cwdFor(ctx, dir)) ?? null))),
  }),

  // ---- Hook × エージェント（<data>/hooks-agents.json。core/hooks-agents.mjs、ADR 0338）。外部 MCP の一覧（context.mcpMatrix・setMcpAgent）と同じ形
  // 移行していなければ、今の担当の動きを写した形を返す（押した時点で写して保存する）。押せないセル（mode が toggle でない）は断る
  defineOp({
    id: 'hooks.matrix', summary: 'agent:ops.hooks.matrix.summary', risk: 'read',
    input: z.object({ cwd, trust: z.boolean().optional().describe(D('scan', 'trust')) }),
    output: z.object({ agents: z.array(z.string()), rows: z.array(loose), adopted: z.boolean(), revision: z.string() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'matrix'] } },
    legacyCommand: 'hooksMatrix',
    handler: (ctx, { cwd: dir, trust }) => run(ctx, async () => shown(ctx, await ctx.hooks.agents.matrix({ cwd: (await cwdFor(ctx, dir)) ?? null, trust: trust !== false }))),
  }),
  defineOp({
    id: 'hooks.setAgent', summary: 'agent:ops.hooks.setAgent.summary', risk: 'write', riskReason: NARROWS,
    riskOf: (_ctx, { on, key }) => (on === false && isReg(key) ? 'write' : 'guarded'),
    input: z.object({
      key: z.string().min(1).max(40).describe(D('setAgent', 'key')),
      agent: agentKey.describe(D('setAgent', 'agent')),
      on: z.boolean().describe(D('setAgent', 'on')),
      cwd, revision, reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { key, agent, on, cwd: dir }) => {
      const { matrix, row } = await agentsRow(ctx, key, dir);
      const note = await withStopNote(t('opsApproval.hooksAgent', { name: rowLabel(row, key), agent }),
        async () => ctx.hooks.agents.setAgent({ key, agent, on, cwd: (await cwdFor(ctx, dir)) ?? null, dry: true }));
      return { key: null, before: matrix?.revision ?? null, rows: [{ path: `hooks.agents.${key}.${agent}`, before: JSON.stringify(row?.cells?.[agent]?.state ?? null), after: JSON.stringify(on ? 'on' : 'off') }],
        note, loosens: on !== false || !isReg(key) };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'agent'], positional: ['key', 'agent'] } },
    legacyCommand: 'setHookAgent',
    handler: (ctx, { key, agent, on, cwd: dir, revision: expect }) => run(ctx, async () => {
      const r = await ctx.hooks.agents.setAgent({ key, agent, on, cwd: (await cwdFor(ctx, dir)) ?? null, expect: expect ?? null });
      return { ok: true, revision: r.revision, place: r.place, ...(r.devinImportsStop ? { devinImportsStop: true } : {}) };
    }),
  }),
  defineOp({
    id: 'hooks.setRow', summary: 'agent:ops.hooks.setRow.summary', risk: 'write', riskReason: NARROWS,
    riskOf: (_ctx, { on, key }) => (on === false && isReg(key) ? 'write' : 'guarded'),
    input: z.object({ key: z.string().min(1).max(40).describe(D('setAgent', 'key')), on: z.boolean().describe(D('setRow', 'on')), cwd, revision, reason }),
    approvalWords: 'hooks',
    confirm: async (ctx, { key, on, cwd: dir }) => {
      const { matrix, row } = await agentsRow(ctx, key, dir);
      const note = await withStopNote(t('opsApproval.hooksRow', { name: rowLabel(row, key) }),
        async () => ctx.hooks.agents.setRow({ key, on, cwd: (await cwdFor(ctx, dir)) ?? null, dry: true }));
      return { key: null, before: matrix?.revision ?? null, rows: [{ path: `hooks.agents.${key}`, before: JSON.stringify(row ? row.on : null), after: JSON.stringify(on) }],
        note, loosens: on !== false || !isReg(key) };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'row'], positional: ['key'] } },
    legacyCommand: 'setHookRow',
    handler: (ctx, { key, on, cwd: dir, revision: expect }) => run(ctx, async () => {
      const r = await ctx.hooks.agents.setRow({ key, on, cwd: (await cwdFor(ctx, dir)) ?? null, expect: expect ?? null });
      return { ok: true, revision: r.revision, place: r.place, ...(r.devinImportsStop ? { devinImportsStop: true } : {}) };
    }),
  }),
  defineOp({
    id: 'hooks.setGroup', summary: 'agent:ops.hooks.setGroup.summary', risk: 'write', riskReason: NARROWS,
    riskOf: (_ctx, { on, group }) => (on === false && group === 'ply' ? 'write' : 'guarded'),
    input: z.object({
      group: z.enum(['ply', 'own', 'place', 'root']).describe(D('setGroup', 'group')),
      agent: agentKey.optional().describe(D('setGroup', 'agent')),
      on: z.boolean().describe(D('setRow', 'on')),
      cwd, revision, reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { group, agent, on, cwd: dir }) => {
      const m = await ctx.hooks.agents.matrix({ cwd: (dir ?? null), trust: false }).catch(() => null);
      const note = await withStopNote(t('opsApproval.hooksGroup', { group, agent: agent ?? '*' }),
        async () => ctx.hooks.agents.setGroup({ group, agent: agent ?? null, on, cwd: (await cwdFor(ctx, dir)) ?? null, dry: true }));
      return { key: null, before: m?.revision ?? null, rows: [{ path: `hooks.agents.group.${group}${agent ? `.${agent}` : ''}`, before: null, after: JSON.stringify(on) }],
        note, loosens: on !== false || group !== 'ply' };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'group'], positional: ['group'] } },
    legacyCommand: 'setHookGroup',
    handler: (ctx, { group, agent, on, cwd: dir, revision: expect }) => run(ctx, async () => {
      const r = await ctx.hooks.agents.setGroup({ group, agent: agent ?? null, on, cwd: (await cwdFor(ctx, dir)) ?? null, expect: expect ?? null });
      return { ok: true, revision: r.revision, place: r.place, ...(r.devinImportsStop ? { devinImportsStop: true } : {}) };
    }),
  }),
  defineOp({
    id: 'hooks.setPlace', summary: 'agent:ops.hooks.setPlace.summary', risk: 'write',
    riskReason: 'Not using a Pleiad registration (h-…) in a place only narrows what runs there. Not using an agent\'s own definition or the workspace hooks there, using a hook again, or dropping the place override is raised to guarded by riskOf',
    riskOf: (_ctx, { use, reset, key }) => (use === false && reset !== true && isReg(key) ? 'write' : 'guarded'),
    input: z.object({
      place: z.string().min(1).max(4096).describe(D('setPlace', 'place')),
      key: z.string().min(1).max(40).optional().describe(D('setAgent', 'key')),
      use: z.boolean().optional().describe(D('setPlace', 'use')),
      reset: z.boolean().optional().describe(D('setPlace', 'reset')),
      revision, reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { place, key, use, reset }) => {
      const { matrix, row } = key ? await agentsRow(ctx, key, place) : { matrix: null, row: null };
      return { key: null, before: matrix?.revision ?? null,
        rows: [{ path: reset ? `hooks.agents.places.${place}.agents` : `hooks.agents.places.${place}.${key}`, before: reset ? null : JSON.stringify(row?.here?.use ?? null), after: reset ? 'null' : JSON.stringify(use !== false) }],
        note: await withStopNote(t('opsApproval.hooksPlace', { place, name: reset ? '*' : rowLabel(row, key) }),
          () => ctx.hooks.agents.setPlace({ place, key: key ?? null, use: use !== false, reset: reset === true, dry: true })),
        loosens: !(use === false && reset !== true && isReg(key)) };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'place'], positional: ['place', 'key'] } },
    legacyCommand: 'setHookPlace',
    handler: (ctx, { place, key, use, reset, revision: expect }) => run(ctx, async () => {
      const r = await ctx.hooks.agents.setPlace({ place, key: key ?? null, use: use !== false, reset: reset === true, expect: expect ?? null });
      return { ok: true, revision: r.revision, ...(r.devinImportsStop ? { devinImportsStop: true } : {}) };
    }),
  }),
  // フォルダーの差分（形式 2）。行の差分を消して受け継ぐ値へ戻す・フォルダーの差分を全部消す。戻すと切った Hook がまた動きうるので、書くときは guarded
  defineOp({
    id: 'hooks.revertRow', summary: 'agent:ops.hooks.revertRow.summary', risk: 'write', riskReason: WRITE_PREVIEW,
    riskOf: unlessDryRun,
    input: z.object({
      cwd: z.string().min(1).max(4096).describe(A('cwd')),
      key: z.string().min(1).max(40).optional().describe(D('setAgent', 'key')),
      keys: z.array(z.string().min(1).max(40)).max(500).optional().describe(D('revertRow', 'keys')),
      dryRun: z.boolean().optional().describe(A('dryRun')),
      revision, reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { cwd: dir, key, keys }) => {
      const m = await ctx.hooks.agents.matrix({ cwd: dir, trust: false }).catch(() => null);
      const list = [...new Set([...(key ? [key] : []), ...(keys ?? [])])];
      const names = list.map((k) => rowLabel(m?.rows.find((r) => r.key === k) ?? null, k));
      return { key: null, before: m?.revision ?? null, rows: list.map((k) => ({ path: `hooks.agents.places.${dir}.${k}`, before: JSON.stringify(m?.rows.find((r) => r.key === k)?.overridden ?? null), after: 'false' })),
        note: await withStopNote(t('opsApproval.hooksPlace', { place: dir, name: names.join(', ') || '*' }),
          () => ctx.hooks.agents.revertRow({ cwd: dir, key: key ?? null, keys: keys ?? null, dry: true })),
        loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'revert'], positional: ['cwd', 'key'] } },
    legacyCommand: 'revertHookRow',
    handler: (ctx, { cwd: dir, key, keys, dryRun, revision: expect }) => run(ctx, async () => {
      const r = await ctx.hooks.agents.revertRow({ cwd: dir, key: key ?? null, keys: keys ?? null, expect: expect ?? null, dry: dryRun === true });
      return { ok: true, removed: r.removed, revision: r.revision, ...(dryRun === true ? { dryRun: true } : {}), ...(r.devinImportsStop ? { devinImportsStop: true } : {}) };
    }),
  }),
  defineOp({
    id: 'hooks.removePlace', summary: 'agent:ops.hooks.removePlace.summary', risk: 'write', riskReason: WRITE_PREVIEW,
    riskOf: unlessDryRun,
    input: z.object({ cwd: z.string().min(1).max(4096).describe(A('cwd')), dryRun: z.boolean().optional().describe(A('dryRun')), revision, reason }),
    approvalWords: 'hooks',
    confirm: async (ctx, { cwd: dir }) => {
      const m = await ctx.hooks.agents.matrix({ cwd: null, trust: false }).catch(() => null);
      const at = (m?.places ?? []).find((p) => typeof p.path === 'string' && p.path.toLowerCase() === String(dir).toLowerCase()) ?? null;
      return { key: null, before: m?.revision ?? null, rows: [{ path: `hooks.agents.places.${dir}`, before: JSON.stringify(at?.changes ?? 0), after: '0' }],
        note: await withStopNote(t('opsApproval.hooksPlace', { place: dir, name: '*' }), () => ctx.hooks.agents.removePlace({ cwd: dir, dry: true })),
        loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'remove-place'], positional: ['cwd'] } },
    legacyCommand: 'removeHookPlace',
    handler: (ctx, { cwd: dir, dryRun, revision: expect }) => run(ctx, async () => {
      const r = await ctx.hooks.agents.removePlace({ cwd: dir, expect: expect ?? null, dry: dryRun === true });
      return { ok: true, removed: r.removed, revision: r.revision, ...(dryRun === true ? { dryRun: true } : {}), ...(r.devinImportsStop ? { devinImportsStop: true } : {}) };
    }),
  }),
  defineOp({
    id: 'hooks.resetAgents', summary: 'agent:ops.hooks.resetAgents.summary', risk: 'guarded',
    input: z.object({ reason }),
    approvalWords: 'hooks',
    confirm: async (ctx) => {
      const m = await ctx.hooks.agents.matrix({ cwd: null, trust: false }).catch(() => null);
      return { key: null, before: m?.revision ?? null, rows: [{ path: 'hooks.agents', before: JSON.stringify(m?.adopted ?? null), after: 'false' }], note: t('opsApproval.hooksAgentsReset'), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'reset-agents'] } },
    legacyCommand: 'resetHooksAgents',
    handler: (ctx) => run(ctx, () => ctx.hooks.agents.reset()),
  }),
];

/**
 * Hooks を書き換える操作。終わったら全画面へ settingsChanged（hooks）を配る（ctx.hooks.changed。どの口から変えても、開いている
 * 設定のページ・会話の右のパネルを取り直す。指示・Skills の表の Devin の取り込むマスも Hooks で変わる。ADR 0338）。書く前の確認（dryRun）は配らない
 */
const CHANGES = new Set(['hooks.saveNative', 'hooks.copy', 'hooks.save', 'hooks.remove', 'hooks.toggle', 'hooks.setOwner', 'hooks.repair',
  'hooks.setAgent', 'hooks.setRow', 'hooks.setGroup', 'hooks.setPlace', 'hooks.revertRow', 'hooks.removePlace', 'hooks.resetAgents']);
export const hookOps = defs.map((op) => (!CHANGES.has(op.id) ? op : Object.freeze({
  ...op,
  handler: async (ctx, args) => {
    const result = await op.handler(ctx, args);
    if (args?.dryRun !== true) ctx.hooks?.changed?.(ctx.actor);
    return result;
  },
})));
