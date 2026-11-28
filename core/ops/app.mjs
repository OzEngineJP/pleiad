// app.*: Pleiad 全体の状態とデスクトップの更新・再起動。
import { z } from 'zod';
import { defineOp } from './registry.mjs';

const requestId = z.uuid().describe('agent:ops.app.lifecycle.requestId');
const targetVersion = z.string().min(1).max(64).describe('agent:ops.app.lifecycle.targetVersion');
const result = z.object({
  requestId: z.uuid(),
  action: z.enum(['install', 'restart']),
  targetVersion: z.string(),
  state: z.enum(['accepted', 'succeeded', 'failed']),
  version: z.string().optional(),
  serverVersion: z.string().optional(),
  error: z.string().optional(),
});
const capability = z.object({ supported: z.boolean(), reason: z.string().nullable() });
const updateStatus = z.object({
  version: z.string(),
  channel: z.enum(['stable', 'beta']).nullable(),
  target: z.string().nullable(),
  phase: z.string(),
  progress: z.number().nullable(),
  error: z.string().nullable(),
  prepare: capability,
  apply: capability,
  restart: capability,
  result: z.union([result, z.object({ requestId: z.uuid(), state: z.literal('unknown'), error: z.string() })]).nullable(),
});
const surfaces = (name) => ({ ui: false, mcp: 'catalog', cli: { path: ['app', name] } });

const stopOps = ['apply', 'restart'].map((name) => defineOp({
  id: `app.${name === 'apply' ? 'updateApply' : 'restart'}`,
  summary: name === 'apply' ? 'agent:ops.app.updateApply.summary' : 'agent:ops.app.restart.summary',
  risk: 'guarded',
  input: z.object({ requestId, targetVersion, reason: z.string().max(500).optional().describe('agent:ops.app.lifecycle.reason') }),
  output: result,
  surfaces: surfaces(name === 'apply' ? 'update-apply' : 'restart'),
  // The exact version and request are bound to the approval receipt.
  confirm: (_ctx, { requestId, targetVersion }) => ({ requestId, targetVersion, note: targetVersion }),
  handler: (ctx, { reason: _reason, ...args }) => ctx.app.lifecycle(name === 'apply' ? 'install' : 'restart', args, ctx.actor),
}));

export const appOps = [
  defineOp({
    id: 'app.updateStatus',
    summary: 'agent:ops.app.updateStatus.summary',
    risk: 'read',
    input: z.object({ requestId: requestId.optional() }),
    output: updateStatus,
    surfaces: surfaces('update-status'),
    handler: (ctx, args) => ctx.app.lifecycle('status', args, ctx.actor),
  }),
  defineOp({
    id: 'app.updatePrepare',
    summary: 'agent:ops.app.updatePrepare.summary',
    risk: 'write',
    riskReason: 'Downloads a verified update without stopping the app or applying it',
    input: z.object({}),
    output: updateStatus,
    surfaces: surfaces('update-prepare'),
    handler: (ctx, args) => ctx.app.lifecycle('prepare', args, ctx.actor),
  }),
  ...stopOps,
  defineOp({
    id: 'app.status',
    summary: 'agent:ops.app.status.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({
      version: z.string(),
      protocolVersion: z.number().int(),
      startedAt: z.number(),
      locale: z.object({ setting: z.string(), lang: z.string() }),
      running: z.number().int(),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['status'] } },
    // 版・起動時刻・画面の言語・走っている作業の数。サーバーが ctx.app.status を渡す
    handler: (ctx) => ctx.app.status(),
  }),

  defineOp({
    id: 'app.running',
    summary: 'agent:ops.app.running.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({
      count: z.number().int(),
      turns: z.array(z.object({ sessionId: z.string().nullable(), backend: z.string().nullable(), title: z.string().nullable() })),
      tasks: z.array(z.object({ taskId: z.string(), status: z.string(), parentSessionId: z.string().nullable() })),
      waiting: z.number().int(),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['running'] } },
    legacyCommand: 'running',
    // いま走っている作業（会話のターン・委譲の子・承認待ちの数）。サーバーが ctx.app.running を渡す
    handler: (ctx) => ctx.app.running(),
    // 画面は、ターン・サブエージェント・裏の作業の状態を読む。待ちカードは waitingCards で届く。
    uiHandler: (ctx) => ctx.app.runningWork(),
  }),

  defineOp({
    id: 'app.cliSetup',
    summary: 'agent:ops.app.cliSetup.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({
      command: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()),
      json: z.string(),
      claude: z.string(),
    }),
    // 設定 › プラグインの「MCP の設定をコピー」。ホストの PC のパスなので、ホストの画面だけに出す（ADR 0090）
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx) => ctx.app.cliSetup(),
  }),

  defineOp({
    id: 'app.reportSlow',
    summary: 'agent:ops.app.reportSlow.summary',
    risk: 'write',
    riskReason: 'Appends bounded diagnostic timing entries (timestamps, command names, durations, session ids, wait phases) from the UI to slow-commands.log without storing prompts, titles, paths, or settings values; restricted to UI only',
    input: z.object({
      entries: z.array(z.object({
        at: z.string().max(40).optional().describe('agent:ops.app.reportSlow.at'),
        kind: z.enum(['client-pending', 'client-rtt', 'submit-wait', 'waiting-card']).describe('agent:ops.app.reportSlow.kind'),
        phase: z.enum(['received', 'ignored', 'drawn']).optional(),
        id: z.string().max(80).optional(),
        revision: z.number().int().nonnegative().optional(),
        connectionId: z.uuid().optional(),
        surface: z.enum(['conversation', 'detail', 'thread']).optional(),
        command: z.string().max(80).optional().describe('agent:ops.app.reportSlow.command'),
        ms: z.number().nonnegative().optional().describe('agent:ops.app.reportSlow.ms'),
        sessionId: z.string().max(80).optional().describe('agent:ops.app.reportSlow.sessionId'),
        outcome: z.enum(['pending', 'ok', 'error', 'closed', 'cancelled', 'sent']).optional().describe('agent:ops.app.reportSlow.outcome'),
        errorCode: z.string().max(64).optional().describe('agent:ops.app.reportSlow.errorCode'),
        pendingCount: z.number().int().nonnegative().optional().describe('agent:ops.app.reportSlow.pendingCount'),
        wait: z.object({
          phase: z.string().max(32).optional().describe('agent:ops.app.reportSlow.waitPhase'),
          newSessionMs: z.number().nonnegative().optional().describe('agent:ops.app.reportSlow.waitMs'),
          settingsMs: z.number().nonnegative().optional().describe('agent:ops.app.reportSlow.waitMs'),
          modeMs: z.number().nonnegative().optional().describe('agent:ops.app.reportSlow.waitMs'),
          worktreeMs: z.number().nonnegative().optional().describe('agent:ops.app.reportSlow.waitMs'),
          postSettingsMs: z.number().nonnegative().optional().describe('agent:ops.app.reportSlow.waitMs'),
          sendMs: z.number().nonnegative().optional().describe('agent:ops.app.reportSlow.waitMs'),
          compactMs: z.number().nonnegative().optional().describe('agent:ops.app.reportSlow.waitMs'),
          hadSettingsWrite: z.boolean().optional().describe('agent:ops.app.reportSlow.waitFlag'),
          hadModeWrite: z.boolean().optional().describe('agent:ops.app.reportSlow.waitFlag'),
          hadWorktree: z.boolean().optional().describe('agent:ops.app.reportSlow.waitFlag'),
          cancelled: z.boolean().optional().describe('agent:ops.app.reportSlow.waitFlag'),
          hasNewSession: z.boolean().optional().describe('agent:ops.app.reportSlow.waitFlag'),
        }).optional().describe('agent:ops.app.reportSlow.wait'),
      }).describe('agent:ops.app.reportSlow.entry')).max(100).describe('agent:ops.app.reportSlow.entries'),
    }),
    output: z.object({ recorded: z.number().int().nonnegative() }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx, { entries }) => ctx.app.reportSlow(entries),
  }),
];
