// plus.*: Pleiad Plus の状態（docs/plus.md）。ログイン・ログアウトは human-only の WS コマンド（plusLogin・plusLoginCancel・plusLogout）で、ここには無い。
// agent にはアカウントを名指しする欄（uid・account.uid・account.email）を伏せる。トークン・apiKey はどの口にも出さない。
// Plus の行を混ぜて返すほかの操作（voice.status・delegation.routing の plus）も plusIdentityShown を通す。
import { z } from 'zod';
import { defineOp, MASK } from './registry.mjs';
import { byAgent, run } from './redact.mjs';

const loose = z.record(z.string(), z.unknown());
/** 取り込む・捨てるの入力: 待っている 1 件と、人が見た版（plus.syncInboxItem が返した sha256・rev）。版が違えば書かずに changed */
const inboxVersion = z.object({
  id: z.string().min(1).max(64).describe('agent:ops.plus.syncInboxItem.id'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().describe('agent:ops.plus.syncInboxTake.sha256'),
  rev: z.number().int().describe('agent:ops.plus.syncInboxTake.rev'),
});

const IDENTITY = ['uid', 'email'];
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 名指しする欄のうち、値のある文字列だけを伏せる（null は「無い」のまま残す） */
const maskIdentity = (v) => (record(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, IDENTITY.includes(k) && typeof x === 'string' && x !== '' ? MASK : x])) : v);

/**
 * agent に見せる Plus の状態・Plus の行: その段と account の段の uid・email を伏せる。人（画面）には今のまま返す。
 * 状態（core/plus/session.mjs の statusShape）は上の段にも uid を持つので、account だけでは足りない
 */
export function plusIdentityShown(ctx, status) {
  if (!byAgent(ctx) || !record(status)) return status;
  const out = maskIdentity(status);
  return record(out.account) ? { ...out, account: maskIdentity(out.account) } : out;
}

export const plusOps = [
  defineOp({
    id: 'plus.status', summary: 'agent:ops.plus.status.summary', risk: 'read',
    input: z.object({ refresh: z.boolean().optional().describe('agent:ops.plus.status.refresh') }),
    output: z.object({ available: z.boolean(), signedIn: z.boolean(), account: loose.nullable() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['plus', 'status'] } },
    legacyCommand: 'plusStatus',
    handler: (ctx, { refresh } = {}) => run(ctx, async () => plusIdentityShown(ctx,(await ctx.plus?.status?.({ refresh: refresh === true })) ?? { available: false, signedIn: false, account: null })),
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
    riskReason: 'Changes the account-level sync flag on the server for every PC on the account; only the settings screen on the host PC can call it (not on MCP or the CLI)',
    input: z.object({ enabled: z.boolean().describe('agent:ops.plus.syncSetEnabled.enabled') }),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
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
    riskReason: 'Deletes the synced content on the server and starts over with a new key on every PC; only the settings screen on the host PC can call it, behind its own confirm (not on MCP or the CLI)',
    // confirm: 鍵を持たない PC がサーバーのデータを消すとき、人が件数を見て確かめた印（無い・合わなければ confirmNeeded で今の値を返す）
    input: z.object({
      confirm: z.object({
        keyId: z.string().min(1).max(200),
        itemCount: z.number().int().min(0),
      }).nullable().optional().describe('agent:ops.plus.syncReset.confirm'),
    }),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx, { confirm } = {}) => run(ctx, () => ctx.plus.syncReset(confirm ?? null)),
  }),
  // 受け入れ待ち（ADR 0246）: ほかの PC から届いた skill・指示ファイル。中身を見せるので画面だけの口にする（MCP・CLI に出さない）。
  // 取り込む・捨てるは ~/.claude などに書くので、この PC の画面だけ（つないだ端末からは呼べない）
  defineOp({
    id: 'plus.syncInbox', summary: 'agent:ops.plus.syncInbox.summary', risk: 'read',
    input: z.object({}),
    output: z.object({ items: z.array(loose) }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx) => run(ctx, async () => (await ctx.plus?.syncInbox?.()) ?? { items: [] }),
  }),
  defineOp({
    id: 'plus.syncInboxItem', summary: 'agent:ops.plus.syncInboxItem.summary', risk: 'read',
    input: z.object({ id: z.string().min(1).max(64).describe('agent:ops.plus.syncInboxItem.id') }),
    output: z.object({ item: loose.nullable() }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx, { id }) => run(ctx, async () => (await ctx.plus?.syncInboxItem?.(id)) ?? { item: null }),
  }),
  defineOp({
    id: 'plus.syncInboxTake', summary: 'agent:ops.plus.syncInboxTake.summary', risk: 'write',
    riskReason: 'Writes (or deletes) a skill or instruction file that arrived from another PC, after the person read its diff; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: inboxVersion,
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx, { id, sha256, rev }) => run(ctx, () => ctx.plus.syncInboxTake(id, { sha256, rev })),
  }),
  defineOp({
    id: 'plus.syncInboxDrop', summary: 'agent:ops.plus.syncInboxDrop.summary', risk: 'write',
    riskReason: 'Discards a change that arrived from another PC without touching local files; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: inboxVersion,
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx, { id, sha256, rev }) => run(ctx, () => ctx.plus.syncInboxDrop(id, { sha256, rev })),
  }),
  defineOp({
    id: 'plus.hostReregister', summary: 'agent:ops.plus.hostReregister.summary', risk: 'write',
    riskReason: 'Registers this PC on the Plus account again after the user removed it; only the settings screen on the host PC can call it (not on MCP or the CLI)',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx) => run(ctx, async () => { await ctx.plus.hostReregister(); return { ok: true }; }),
  }),
  defineOp({
    id: 'plus.syncOpenConflicts', summary: 'agent:ops.plus.syncOpenConflicts.summary', risk: 'write',
    riskReason: 'Opens the conflicts folder on this PC in the OS; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx) => run(ctx, () => ctx.plus.syncOpenConflicts()),
  }),
  // 同期の鍵の受け渡し（docs/plus.md「同期の鍵の受け渡し」）。渡す・回復を頼む・仕上げる・止めるは、鍵を持つ PC の前の人だけ
  defineOp({
    id: 'plus.syncApprove', summary: 'agent:ops.plus.syncApprove.summary', risk: 'write',
    riskReason: 'Hands the account sync key to another PC after the person compared the confirmation code; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: z.object({
      hostId: z.string().min(1).max(64).describe('agent:ops.plus.syncApprove.hostId'),
      code: z.string().regex(/^\d{6}$/).describe('agent:ops.plus.syncApprove.code'),
    }),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx, { hostId, code }) => run(ctx, () => ctx.plus.syncApprove(hostId, code)),
  }),
  defineOp({
    id: 'plus.syncDeny', summary: 'agent:ops.plus.syncDeny.summary', risk: 'write',
    riskReason: 'Refuses a PC that asked for the sync key; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: z.object({ hostId: z.string().min(1).max(64).describe('agent:ops.plus.syncApprove.hostId') }),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx, { hostId }) => run(ctx, () => ctx.plus.syncDeny(hostId)),
  }),
  defineOp({
    id: 'plus.syncAcceptRestart', summary: 'agent:ops.plus.syncAcceptRestart.summary', risk: 'write',
    riskReason: 'Moves this PC to a sync key that its previous key cannot vouch for (after a recovery), through the approval window; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: z.object({ keyId: z.string().min(1).max(128).describe('agent:ops.plus.syncAcceptRestart.keyId') }),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx, { keyId }) => run(ctx, () => ctx.plus.syncAcceptRestart(keyId)),
  }),
  defineOp({
    id: 'plus.syncRecoveryRequest', summary: 'agent:ops.plus.syncRecoveryRequest.summary', risk: 'write',
    riskReason: 'Starts the 72-hour wait to restart sync with a new key when no PC holds the key; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx) => run(ctx, () => ctx.plus.syncRecoveryRequest()),
  }),
  defineOp({
    id: 'plus.syncRecoveryCancel', summary: 'agent:ops.plus.syncRecoveryCancel.summary', risk: 'write',
    riskReason: 'Withdraws this PC\'s own recovery request; only the settings screen calls it (not on MCP or the CLI)',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx) => run(ctx, () => ctx.plus.syncRecoveryCancel()),
  }),
  defineOp({
    id: 'plus.syncRecoveryComplete', summary: 'agent:ops.plus.syncRecoveryComplete.summary', risk: 'write',
    riskReason: 'Restarts sync with a new key after the recovery wait, deleting the data on the server; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx) => run(ctx, () => ctx.plus.syncRecoveryComplete()),
  }),
  defineOp({
    id: 'plus.syncRecoveryStop', summary: 'agent:ops.plus.syncRecoveryStop.summary', risk: 'write',
    riskReason: 'Stops another PC\'s recovery request with a signature from the current sync key; only the host PC\'s settings screen can call it (not on MCP or the CLI)',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    handler: (ctx) => run(ctx, () => ctx.plus.syncRecoveryStop()),
  }),
];
