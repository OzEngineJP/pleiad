// git.prs: 会話の PR（会話が作ったものと、委譲した子の会話が作ったもの）と、その状態（読み取りだけ。docs/git-panel-pr.md、ADR 0206）。
// 右パネルの git の頭の PR の行の元。状態（open・draft・merged・closed とチェック）は gh pr view の読み取りで、60 秒覚える。
// gh が無い・ログインしていないときは、番号・repo・URL だけ返し、reason で理由を伝える。core は正規化した形だけを画面へ渡す。
import { z } from 'zod';
import { defineOp } from './registry.mjs';
import { maskTree, run } from './redact.mjs';

const D = (id, key) => `agent:ops.git.${id}.${key}`;
const A = (key) => `agent:ops.git.arg.${key}`;
const sessionId = z.string().max(200).nullable().optional().describe(A('sessionId'));

const pr = z.object({
  number: z.number().int(), url: z.string(), repo: z.string().nullable(),
  title: z.string().optional(), state: z.enum(['open', 'draft', 'merged', 'closed']).optional(), checks: z.enum(['pass', 'fail', 'pending']).optional(),
  child: z.boolean().optional(),
});

export const gitPrsOps = [
  defineOp({
    id: 'git.prs', summary: 'agent:ops.git.prs.summary', risk: 'read',
    input: z.object({ sessionId, states: z.boolean().optional().describe(D('prs', 'states')) }),
    output: z.object({ prs: z.array(pr), reason: z.enum(['no-gh', 'no-auth']).nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'prs'] } },
    legacyCommand: 'gitPrs',
    handler: (ctx, args) => run(ctx, async () => maskTree(await ctx.git.prs({ ...args, sessionId: args.sessionId || ctx.actor.sessionId || undefined }))),
  }),
];
