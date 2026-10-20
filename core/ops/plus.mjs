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
];
