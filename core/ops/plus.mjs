// plus.*: Pleiad Plus の状態（docs/plus.md）。ログイン・ログアウトは human-only の WS コマンド（plusLogin・plusLoginCancel・plusLogout）で、ここには無い。
// agent には account.uid・account.email を伏せる。トークン・apiKey はどの口にも出さない。
import { z } from 'zod';
import { defineOp, MASK } from './registry.mjs';
import { byAgent, run } from './redact.mjs';

const loose = z.record(z.string(), z.unknown());

/** agent に見せる Plus の状態: アカウントを名指しする欄（uid・email）を伏せる */
function plusShown(ctx, status) {
  if (!byAgent(ctx) || !status || typeof status !== 'object') return status;
  return {
    ...status,
    account: status.account ? { ...status.account, uid: MASK, email: MASK } : status.account,
  };
}

export const plusOps = [
  defineOp({
    id: 'plus.status', summary: 'agent:ops.plus.status.summary', risk: 'read',
    input: z.object({ refresh: z.boolean().optional().describe('agent:ops.plus.status.refresh') }),
    output: z.object({ available: z.boolean(), signedIn: z.boolean(), account: loose.nullable() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['plus', 'status'] } },
    legacyCommand: 'plusStatus',
    handler: (ctx, { refresh } = {}) => run(ctx, async () => plusShown(ctx, (await ctx.plus?.status?.({ refresh: refresh === true })) ?? { available: false, signedIn: false, account: null })),
  }),
  // 同期（docs/plus.md「同期」）。状態は plusSyncStatus 出来事で全接続へ。内容・論理名・鍵はどの口にも出さない
  defineOp({
    id: 'plus.syncStatus', summary: 'agent:ops.plus.syncStatus.summary', risk: 'read',
    input: z.object({}),
    output: z.object({ state: z.string() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['plus', 'sync'] } },
    handler: (ctx) => run(ctx, async () => (await ctx.plus?.syncStatus?.()) ?? { state: 'off' }),
  }),
  defineOp({
    id: 'plus.syncSetEnabled', summary: 'agent:ops.plus.syncSetEnabled.summary', risk: 'write',
    riskReason: 'Changes the account-level sync flag on the server for every PC on the account; only the settings screen calls it (not on MCP or the CLI)',
    input: z.object({ enabled: z.boolean().describe('agent:ops.plus.syncSetEnabled.enabled') }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx, { enabled }) => run(ctx, () => ctx.plus.syncSetEnabled(enabled)),
  }),
  defineOp({
    id: 'plus.syncNow', summary: 'agent:ops.plus.syncNow.summary', risk: 'write',
    riskReason: 'Runs one sync round against the server; only the settings screen calls it (not on MCP or the CLI)',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx) => run(ctx, () => ctx.plus.syncNow()),
  }),
  defineOp({
    id: 'plus.syncReset', summary: 'agent:ops.plus.syncReset.summary', risk: 'write',
    riskReason: 'Deletes the synced content on the server and starts over with a new key on every PC; only the settings screen calls it, behind its own confirm (not on MCP or the CLI)',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx) => run(ctx, () => ctx.plus.syncReset()),
  }),
  defineOp({
    id: 'plus.syncOpenConflicts', summary: 'agent:ops.plus.syncOpenConflicts.summary', risk: 'write',
    riskReason: 'Opens the conflicts folder on this PC in the OS; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx) => run(ctx, () => ctx.plus.syncOpenConflicts()),
  }),
];
