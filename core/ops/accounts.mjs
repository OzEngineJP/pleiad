// アカウントの契約・資格情報は人だけが管理する。選択済みの行の利用は sessions / delegation の口を通す。
import { z } from 'zod';
import { defineOp } from './registry.mjs';

const id = z.string().regex(/^acct-[0-9a-f]{12}$/);
const name = z.string().trim().min(1).max(60);
export const accountOps = [
  ['list', z.object({ backend: z.string().min(1).max(40) })],
  ['create', z.object({ backend: z.string().min(1).max(40), name })],
  ['rename', z.object({ id, name })],
  ['remove', z.object({ id })],
  ['login', z.object({ id, open: z.boolean().optional(), attempt: z.string().min(1).max(80).optional() })],
  ['cancel', z.object({ id, attempt: z.string().min(1).max(80).optional() })],
].map(([verb, input]) => defineOp({
  id: `accounts.${verb}`, summary: `agent:ops.accounts.${verb}.summary`, risk: 'human-only',
  surfaces: { ui: true, mcp: false, cli: false },
  input: z.object(Object.fromEntries(Object.entries(input.shape).map(([key, schema]) => [key, schema.describe(`agent:ops.accounts.${verb}.${key}`)]))),
  handler: (ctx, args) => ctx.accounts[verb](args),
}));
