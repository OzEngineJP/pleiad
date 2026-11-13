// context.*: コンテキスト（指示・Skills・外部 MCP をどこから読み、誰が担当するか）の設定、Pleiad の指示、会話ごとの読み込み直しと MCP の外し方（ADR 0095）。
// 画面の WS コマンド（contextSettings・setPlyInstructions など）はこの操作を呼ぶ薄い外側。本体はサーバーが ctx.context で渡す（core/server.mjs の opsDeps）。
//
// 危険度:
//   setSettings・setPlyInstructions は guarded。どちらも全部の会話のエージェントに渡る文脈を変える（どのフォルダーの指示・Skills を読むか、
//   担当を Pleiad にして Pleiad の MCP の登録をつなぐか、会話ごとに足す指示の本文）。同じ値を変える settings.set の
//   context.default・plyInstructions も guarded（ADR 0088）なので、こちらだけ緩めると抜け道になる。
//   refresh は write（その会話の固定した文脈を、今のファイルから読み直すだけ。読む場所は変わらない）。
//   setSessionMcp は write で、外した MCP を戻す向き（removed: false）だけ riskOf が guarded に上げる（戻すと次のターンでつなぎ直す）。
// 中身を読む操作（session・diff・scan・skills・agentMcp・nativeInstructions・findings。ADR 0105）は read。画面（人）には今までの形を返し（uiHandler）、
// AI・CLI には一覧を limit / cursor で区切り、本文を切り、コマンド・URL・env の秘密を伏せた形を返す（maskTree）。
// 探索（scan・skills・会話の文脈の突き合わせ）は 1 つずつ。画面は接続ごと、AI はまとめて 1 つ（ctx.scanLock。core/server.mjs）。
import { z } from 'zod';
import { agentT, t } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';
import { diffRows } from './settings.mjs';
import { mcpAgentsFromLegacy, toggleMcpAgent } from '../context-settings.mjs';
import { buildMcpMatrix, mcpLegacyInfo } from '../context-mcp-matrix.mjs';
import { byAgent, cwdFor, maskTree, run, sessionFor } from './redact.mjs';
import { clip, pageOf, PAGE_MAX } from './host.mjs';

const D = (id, key) => `agent:ops.context.${id}.${key}`;
const A = (key) => `agent:ops.context.arg.${key}`;
const loose = z.record(z.string(), z.unknown());
const reason = z.string().max(500).optional().describe(A('reason'));

/** 中身を読む操作の本文の字数（既定・上限） */
export const CONTEXT_CHARS_DEFAULT = 2_000;
export const CONTEXT_CHARS_MAX = 20_000;
const limit = z.number().int().min(1).max(PAGE_MAX).optional().describe(A('limit'));
const cursor = z.string().max(400).optional().describe(A('cursor'));
const maxChars = z.number().int().min(100).max(CONTEXT_CHARS_MAX).optional().describe(A('maxChars'));
const backendArg = z.string().max(40).nullable().optional().describe(A('backend'));
const sessionArg = z.string().max(200).nullable().optional().describe(A('sessionId'));
const cwdArg = z.string().max(4096).nullable().optional().describe(A('cwd'));

/**
 * 探索の行 1 つ（AI 向け）: 本文（content）は切り、切ったら truncated。外部 MCP の行の本文は設定ファイルの生の中身で、
 * 複数行に分かれた引数の秘密（"--token",\n "値"）を形で伏せきれないので返さない（コマンド・引数・env・URL は行の欄で伏せて返る）
 */
function entryRow(e, chars) {
  if (!e || typeof e !== 'object' || typeof e.content !== 'string') return e;
  if (e.kind === 'mcp') { const { content: _c, ...rest } = e; return rest; }
  return { ...e, content: clip(e.content, chars), ...(e.content.length > chars ? { truncated: true } : {}) };
}
/** 探索の結果（AI 向け）: entries を種類で絞って区切り、本文を切り、秘密を伏せる */
function scanPage(ctx, report, { kind, limit: n, cursor: c, maxChars: chars = CONTEXT_CHARS_DEFAULT }) {
  if (!report || typeof report !== 'object') return report ?? null;
  const all = (report.entries ?? []).filter((e) => !kind || e?.kind === kind);
  const page = pageOf(ctx, all, { limit: n, cursor: c });
  // configs は外部 MCP の設定ファイルそのもの（生の本文）。場所と大きさだけ返す
  const configs = Array.isArray(report.configs) ? report.configs.map(({ content: _c, ...rest }) => rest) : report.configs;
  return maskTree({ ...report, ...(configs !== undefined ? { configs } : {}), entries: page.items.map((e) => entryRow(e, chars)), total: page.total, next: page.next });
}
/** 探索は 1 つずつ（ほかが探していれば SCAN_BUSY）。錠が無ければ（単体の検査）そのまま */
const exclusive = (ctx, fn) => (ctx.scanLock ? ctx.scanLock.run(fn) : fn());
/** AI が backend を省いたら、その会話のエージェント */
const backendFor = async (ctx, backend) => backend ?? (byAgent(ctx) && ctx.actor?.sessionId ? await ctx.sessionBackend?.(ctx.actor.sessionId) : undefined);

const needSession = (ctx, sessionId) => {
  const id = sessionFor(ctx, sessionId);
  if (!id && byAgent(ctx)) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
  return id;
};

/** setContextSettings の 1 か所の変更を、承認カードの前後にする（今の画面の形から、変える種類だけ） */
function contextChange(view, args) {
  const level = args.place ? (view?.places ?? []).find((p) => p.current) ?? null : view?.defaults ?? null;
  const where = args.place ? 'context.place' : 'context.default';
  if (args.remove) return diffRows(where, { path: args.place }, null);
  if (args.add) return diffRows(where, null, { path: args.place });
  if (Object.hasOwn(args, 'roots')) {
    const kinds = args.kind ? [args.kind] : Object.keys(level?.roots ?? {});
    return diffRows(`${where}.roots`, Object.fromEntries(kinds.map((k) => [k, level?.roots?.[k]?.value ?? null])), Object.fromEntries(kinds.map((k) => [k, args.roots])));
  }
  return diffRows(`${where}.${args.kind ?? ''}`, level?.kinds?.[args.kind]?.value ?? null, args.value ?? null);
}

/**
 * 一覧（context.mcpMatrix）と更新（context.setMcpAgent）が同じ材料で組み立てるための入力。cwd・place が同じなら同じ一覧になる。
 * wait: コネクターの一覧が未読なら、読み終えるまで待つ（読めなければ readFailed）
 */
async function matrixInput(ctx, { cwd, place, refresh = false, wait = false }) {
  const dir = (await cwdFor(ctx, cwd)) ?? null;
  const view = await ctx.context.view(dir);
  const level = place ? (view.places ?? []).find((p) => p.path === place) ?? view.defaults : view.defaults;
  const [known, list] = await Promise.all([ctx.context.agentMcp(dir), ctx.mcp.list().catch(() => ({ servers: [] }))]);
  const servers = list.servers ?? [];
  // 読み取りの起動で、利用者の stdio の MCP が動かないように、claude.ai 以外の既知の名前（Pleiad の登録すべて・Claude の設定の MCP）を止める
  const deny = [...servers.map((s) => s.name), ...(known.agents?.claude ?? []).map((s) => s.name)];
  const claude = Object.hasOwn(known.agents ?? {}, 'claude'); // backend-allow: コネクターの読み取りは Claude 固有（ADR 0325）
  const extras = await ctx.context.claudeExtras({ refresh, deny, wait: wait && claude, cwd: dir });
  const input = {
    kind: level.kinds.mcp.value, owners: Object.fromEntries(['instruction', 'skill', 'mcp'].map((k) => [k, level.kinds[k]?.value?.owner])),
    registered: servers.map((s) => ({ name: s.name, transport: s.transport ?? null })),
    native: known.agents ?? {}, plugins: extras.plugins,
    // null（1 度も読めていない）と [] （読めて 0 件）は最後まで区別する。null のまま保存すると、止めたはずのコネクターが開く
    connectors: Array.isArray(extras.connectors) ? extras.connectors : null,
    reading: extras.reading === true,
  };
  return { input, extras, level, dir, claude };
}

export const contextOps = [
  defineOp({
    id: 'context.settings', summary: 'agent:ops.context.settings.summary', risk: 'read',
    input: z.object({ cwd: z.string().max(4096).optional().describe(A('cwd')) }),
    output: z.object({ defaults: loose, places: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'settings'] } },
    legacyCommand: 'contextSettings',
    handler: async (ctx, { cwd }) => run(ctx, async () => ctx.context.view((await cwdFor(ctx, cwd)) ?? null)),
  }),
  defineOp({
    id: 'context.mcpMatrix', summary: 'agent:ops.context.mcpMatrix.summary', risk: 'read',
    input: z.object({
      cwd: z.string().max(4096).optional().describe(A('cwd')),
      place: z.string().max(4096).nullable().optional().describe(D('setSettings', 'place')),
      refresh: z.boolean().optional().describe(D('mcpMatrix', 'refresh')),
    }),
    output: z.object({ agents: z.array(z.string()), rows: z.array(loose), locked: z.boolean(), connectors: z.string() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'mcp-matrix'] } },
    legacyCommand: 'mcpMatrix',
    handler: (ctx, { cwd, place, refresh }) => run(ctx, async () => {
      const { input } = await matrixInput(ctx, { cwd, place, refresh: refresh === true });
      return buildMcpMatrix(input);
    }),
  }),
  defineOp({
    id: 'context.setSettings', summary: 'agent:ops.context.setSettings.summary', risk: 'guarded',
    input: z.object({
      place: z.string().max(4096).nullable().optional().describe(D('setSettings', 'place')),
      kind: z.enum(['instruction', 'skill', 'mcp']).optional().describe(D('setSettings', 'kind')),
      value: z.unknown().optional().describe(D('setSettings', 'value')),
      roots: z.array(z.string().max(4096)).max(50).nullable().optional().describe(D('setSettings', 'roots')),
      add: z.boolean().optional().describe(D('setSettings', 'add')),
      remove: z.boolean().optional().describe(D('setSettings', 'remove')),
      cwd: z.string().max(4096).optional().describe(A('cwd')),
      reason,
    }),
    approvalWords: 'context',
    confirm: async (ctx, { reason: _r, ...args }) => {
      const view = await ctx.context.view(args.place ?? null).catch(() => null);
      return { key: null, before: view, rows: contextChange(view, args), note: t('opsApproval.contextSettings', { place: args.place ?? t('opsApproval.everywhere') }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'set'] } },
    legacyCommand: 'setContextSettings',
    handler: (ctx, { reason: _r, ...args }) => run(ctx, () => ctx.context.set(args, ctx.actor)),
  }),
  defineOp({
    id: 'context.setMcpAgent', summary: 'agent:ops.context.setMcpAgent.summary', risk: 'guarded',
    riskReason: 'Turning a server off for an agent only narrows what it can call; turning it on (or spreading it to another agent) connects it, so it is raised to guarded by riskOf',
    riskOf: (_ctx, { on }) => (on === false ? 'write' : 'guarded'),
    input: z.object({
      name: z.string().min(1).max(128).describe(D('setMcpAgent', 'name')),
      agent: z.string().max(40).describe(D('setMcpAgent', 'agent')),
      on: z.boolean().describe(D('setMcpAgent', 'on')),
      place: z.string().max(4096).nullable().optional().describe(D('setSettings', 'place')),
      cwd: z.string().max(4096).optional().describe(A('cwd')),
      reason,
    }),
    approvalWords: 'mcp',
    confirm: async (_ctx, { name, agent, on }) => ({ key: null, before: null, rows: [{ path: `context.mcp.${name}.${agent}`, before: JSON.stringify(on ? 'off' : 'on'), after: JSON.stringify(on ? 'on' : 'off') }],
      note: t('opsApproval.mcpAgent', { name, agent }), loosens: on !== false }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'mcp-agent'], positional: ['name', 'agent'] } },
    legacyCommand: 'setMcpAgent',
    handler: (ctx, { name, agent, on, place, cwd }) => run(ctx, async () => {
      const where = place ?? null;
      // 「Pleiad がそろえる」の移行（agents が無い）と、コネクターの名前を触るときは、コネクターの一覧を読み終えてから決める
      const first = await matrixInput(ctx, { cwd, place: where });
      const kind = first.level.kinds.mcp.value;
      const needConnectors = first.claude && (name.startsWith('claude.ai ') || (!kind.agents && kind.owner === 'ply'));
      const { input } = needConnectors && first.input.connectors === null ? await matrixInput(ctx, { cwd, place: where, wait: true }) : first;
      const ids = Object.keys(input.native);
      if (!ids.includes(agent)) throw new OpError('INVALID', t('context.settings.unknownAgent', { agent }));
      // 読めなかったまま「Pleiad がそろえる」を写すと、外してあったコネクターが Claude に開いてしまう。保存しない
      // 待っても読めなかったとき（読み取りの失敗・Claude が起動できない）。未読のまま保存しない
      if (needConnectors && input.connectors === null) throw new OpError('INVALID', t('context.settings.connectorsUnread'));
      const matrix = buildMcpMatrix(input);
      const row = matrix.rows.find((r) => r.key === name);
      if (!row) throw new OpError('INVALID', t('context.settings.unknownMcp', { name }));
      const cell = row.cells[agent];
      if (!cell || cell.mode !== 'toggle') throw new OpError('INVALID', t('context.settings.mcpNotPressable', { name, agent }));
      const info = mcpLegacyInfo(input);
      const current = kind.agents ?? mcpAgentsFromLegacy(kind, info);
      // プラグインの MCP・claude.ai のコネクターは Claude 自身の名前として数える（止めるのは deniedMcpServers）
      const full = { ...info, native: { ...info.native, ...(info.extras?.claude ? { claude: [...(info.native.claude ?? []), ...info.extras.claude] } : {}) } };
      const next = toggleMcpAgent(current, { name, agent, on }, full);
      // 名前で外してあったもの（disabled）は agents に写したので、二重に効かせないよう消す
      const { disabled: _d, ...rest } = kind;
      const result = await ctx.context.set({ place: where, kind: 'mcp', value: { ...rest, agents: next }, cwd }, ctx.actor);
      return { ok: true, agents: next, defaults: result.defaults };
    }),
  }),
  defineOp({
    id: 'context.plyInstructions', summary: 'agent:ops.context.plyInstructions.summary', risk: 'read',
    input: z.object({}),
    output: z.object({ items: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'instructions'] } },
    legacyCommand: 'plyInstructions',
    handler: (ctx) => run(ctx, () => ctx.context.plyInstructions()),
  }),
  defineOp({
    id: 'context.setPlyInstructions', summary: 'agent:ops.context.setPlyInstructions.summary', risk: 'guarded',
    input: z.object({
      action: z.enum(['save', 'toggle', 'delete', 'reset', 'order']).describe(D('setPlyInstructions', 'action')),
      id: z.string().max(100).optional().describe(D('setPlyInstructions', 'id')),
      name: z.string().max(200).optional().describe(D('setPlyInstructions', 'name')),
      body: z.string().max(20000).optional().describe(D('setPlyInstructions', 'body')),
      target: z.string().max(20).optional().describe(D('setPlyInstructions', 'target')),
      agents: z.array(z.string().max(40)).max(10).optional().describe(D('setPlyInstructions', 'agents')),
      on: z.boolean().optional().describe(D('setPlyInstructions', 'on')),
      ids: z.array(z.string().max(100)).max(100).optional().describe(D('setPlyInstructions', 'ids')),
      reason,
    }),
    approvalWords: 'context',
    confirm: async (ctx, { reason: _r, ...action }) => {
      const before = ctx.context.plyInstructionItems();
      let after = null;
      try { after = ctx.context.previewPlyInstructions(action); } catch { after = null; }
      const pick = (list) => (list ? Object.fromEntries(list.map((i) => [i.id, { on: i.on !== false, ...(i.name ? { name: i.name } : {}), ...(i.body ? { body: i.body } : {}), ...(i.target ? { target: i.target } : {}) }])) : null);
      return { key: null, before, rows: diffRows('plyInstructions', pick(before), pick(after)), note: t('opsApproval.plyInstructions'), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'set-instructions'] } },
    legacyCommand: 'setPlyInstructions',
    handler: (ctx, { reason: _r, ...action }) => run(ctx, () => ctx.context.setPlyInstructions(action, ctx.actor)),
  }),
  defineOp({
    id: 'context.refresh', summary: 'agent:ops.context.refresh.summary', risk: 'write', scope: 'session',
    riskReason: 'Re-reads the pinned instructions and Skills of one conversation from the same places; it does not change where they are read from or who owns them',
    input: z.object({ sessionId: z.string().max(200).optional().describe(A('sessionId')) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'refresh'] } },
    legacyCommand: 'refreshContext',
    handler: (ctx, { sessionId }) => run(ctx, async () => { await ctx.context.refresh(needSession(ctx, sessionId)); return { ok: true }; }),
  }),
  defineOp({
    id: 'context.setSessionMcp', summary: 'agent:ops.context.setSessionMcp.summary', risk: 'write', scope: 'session',
    riskReason: 'Removing an MCP server from one conversation only narrows what it can call; putting it back (removed: false) is raised to guarded by riskOf (it is connected again on the next turn)',
    riskOf: (_ctx, { removed }) => (removed === false ? 'guarded' : 'write'),
    input: z.object({
      sessionId: z.string().max(200).optional().describe(A('sessionId')),
      name: z.string().min(1).max(128).describe(D('setSessionMcp', 'name')),
      removed: z.boolean().optional().describe(D('setSessionMcp', 'removed')),
      reason,
    }),
    approvalWords: 'mcp',
    confirm: async (ctx, { sessionId, name, removed }) => {
      const id = sessionFor(ctx, sessionId);
      const list = id ? await ctx.context.removedMcp(id).catch(() => []) : [];
      return { key: null, before: list, rows: [{ path: `context.session.mcp.${name}`, before: JSON.stringify(list.includes(name) ? 'removed' : 'on'), after: JSON.stringify(removed === false ? 'on' : 'removed') }],
        note: t('opsApproval.sessionMcp', { name }), loosens: removed === false };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'session-mcp'], positional: ['name'] } },
    legacyCommand: 'setSessionMcp',
    handler: (ctx, { sessionId, name, removed }) => run(ctx, async () => { await ctx.context.setSessionMcp(needSession(ctx, sessionId), name, removed !== false); return { ok: true }; }),
  }),

  // ---- 中身を読む（ADR 0105）
  defineOp({
    id: 'context.session', summary: 'agent:ops.context.session.summary', risk: 'read', scope: 'session',
    input: z.object({ sessionId: sessionArg, compare: z.boolean().optional().describe(D('session', 'compare')), kind: z.enum(['instruction', 'skill', 'mcp']).optional().describe(D('scan', 'kind')), limit, cursor, maxChars }),
    output: z.object({ report: loose.nullable() }).passthrough().nullable(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'session'] } },
    legacyCommand: 'sessionContext',
    // 画面は会話を言わなければ null（新しい会話の右パネル）
    uiHandler: (ctx, { sessionId, compare }) => (sessionId ? ctx.context.session(sessionId, { compare: compare !== false, lock: ctx.scanLock }) : null),
    handler: (ctx, { sessionId, compare, ...page }) => run(ctx, async () => {
      const got = await ctx.context.session(needSession(ctx, sessionId), { compare: compare !== false, lock: ctx.scanLock });
      return got ? maskTree({ ...got, report: scanPage(ctx, got.report, page) }) : null;
    }),
  }),
  defineOp({
    id: 'context.diff', summary: 'agent:ops.context.diff.summary', risk: 'read', scope: 'session',
    input: z.object({ sessionId: sessionArg, limit, cursor, maxChars }),
    output: z.object({ files: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'diff'] } },
    legacyCommand: 'contextDiff',
    uiHandler: (ctx, { sessionId }) => ctx.context.diff(sessionId),
    handler: (ctx, { sessionId, limit: n, cursor: c, maxChars: chars = CONTEXT_CHARS_DEFAULT }) => run(ctx, async () => {
      const page = pageOf(ctx, (await ctx.context.diff(needSession(ctx, sessionId)))?.files ?? [], { limit: n, cursor: c });
      const cut = (text) => (typeof text === 'string' ? clip(text, chars) : text);
      const long = (text) => typeof text === 'string' && text.length > chars;
      return maskTree({ total: page.total, next: page.next,
        files: page.items.map((f) => ({ ...f, before: cut(f.before), after: cut(f.after), ...(long(f.before) || long(f.after) ? { truncated: true } : {}) })) });
    }),
  }),
  defineOp({
    id: 'context.scan', summary: 'agent:ops.context.scan.summary', risk: 'read',
    input: z.object({
      cwd: cwdArg,
      place: z.enum(['default']).optional().describe(D('scan', 'place')),
      scope: z.enum(['user', 'directory']).optional().describe(D('scan', 'scope')),
      kind: z.enum(['instruction', 'skill', 'mcp']).optional().describe(D('scan', 'kind')),
      limit, cursor, maxChars,
    }),
    output: z.object({ entries: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'scan'] } },
    legacyCommand: 'scanContext',
    uiHandler: (ctx, { cwd, place, scope }) => exclusive(ctx, () => ctx.context.scan({ cwd, place, scope })),
    handler: (ctx, { cwd, place, scope, ...page }) => run(ctx, async () => {
      const dir = await cwdFor(ctx, cwd);
      return scanPage(ctx, await exclusive(ctx, () => ctx.context.scan({ cwd: dir, place, scope })), page);
    }),
  }),
  defineOp({
    id: 'context.skills', summary: 'agent:ops.context.skills.summary', risk: 'read',
    input: z.object({ cwd: cwdArg, limit, cursor }),
    output: z.object({ skills: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'skills'] } },
    legacyCommand: 'slashSkills',
    uiHandler: (ctx, { cwd }) => exclusive(ctx, () => ctx.context.skills(cwd)),
    handler: (ctx, { cwd, limit: n, cursor: c }) => run(ctx, async () => {
      const dir = await cwdFor(ctx, cwd);
      const page = pageOf(ctx, await exclusive(ctx, () => ctx.context.skills(dir)), { limit: n, cursor: c });
      return maskTree({ total: page.total, skills: page.items, next: page.next });
    }),
  }),
  defineOp({
    id: 'context.agentMcp', summary: 'agent:ops.context.agentMcp.summary', risk: 'read',
    input: z.object({ cwd: cwdArg }),
    output: z.object({ agents: loose }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'agent-mcp'] } },
    legacyCommand: 'agentMcp',
    uiHandler: (ctx, { cwd }) => ctx.context.agentMcp(cwd),
    handler: (ctx, { cwd }) => run(ctx, async () => maskTree(await ctx.context.agentMcp(await cwdFor(ctx, cwd)))),
  }),
  defineOp({
    id: 'context.nativeInstructions', summary: 'agent:ops.context.nativeInstructions.summary', risk: 'read',
    input: z.object({ cwd: cwdArg, backend: backendArg, limit, cursor }),
    output: z.object({ entries: z.array(loose).nullable() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'native-instructions'] } },
    legacyCommand: 'nativeInstructions',
    uiHandler: (ctx, { cwd, backend }) => ctx.context.nativeInstructions(cwd, backend),
    handler: (ctx, { cwd, backend, limit: n, cursor: c }) => run(ctx, async () => {
      const got = await ctx.context.nativeInstructions(await cwdFor(ctx, cwd), await backendFor(ctx, backend));
      if (!Array.isArray(got?.entries)) return maskTree(got);
      const page = pageOf(ctx, got.entries, { limit: n, cursor: c });
      return maskTree({ ...got, entries: page.items, total: page.total, next: page.next });
    }),
  }),
  defineOp({
    id: 'context.findings', summary: 'agent:ops.context.findings.summary', risk: 'read', scope: 'session',
    input: z.object({ sessionId: sessionArg, cwd: cwdArg, backend: backendArg }),
    output: z.object({ duplicates: z.array(loose), missing: z.array(loose) }).passthrough().nullable(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'findings'] } },
    legacyCommand: 'contextFindings',
    uiHandler: (ctx, { sessionId, cwd, backend }) => ctx.context.findings(sessionId, cwd, backend),
    handler: (ctx, { sessionId, cwd, backend }) => run(ctx, async () =>
      maskTree(await ctx.context.findings(needSession(ctx, sessionId), await cwdFor(ctx, cwd), await backendFor(ctx, backend)))),
  }),
];
