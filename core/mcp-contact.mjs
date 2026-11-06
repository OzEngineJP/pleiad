// Pleiad の MCP の口（/mcp/context・/mcp/agents など）へ、どのトークンで接続が来たかの写し（メモリだけ）。
//
// agy は組織の管理ポリシー（MCP サーバーを無効）でカスタムエージェントの MCP を起こさないことがあり、
// そのことを stream-json に出さない。Pleiad は中継に渡したトークンで 1 度でも接続が来たかを見て気づく
// （core/backends/antigravity.mjs。docs/multi-backend.md §2.8「組織の管理ポリシー」）。
// 値はトークンそのものではなく形だけを見て、上限の数を超えたら古いものから捨てる。

const MAX = 512;
const seen = new Set();

const valid = (authorization) => typeof authorization === 'string' && /^Bearer [a-f0-9]{64}$/.test(authorization);

/** 口に来た要求の Authorization を覚える。形の合わないものは捨てる */
export function noteMcpContact(authorization) {
  if (!valid(authorization)) return;
  seen.delete(authorization);
  seen.add(authorization);
  if (seen.size > MAX) seen.delete(seen.values().next().value);
}

/** そのトークンで接続が来たか */
export function mcpContacted(authorization) {
  return valid(authorization) && seen.has(authorization);
}
