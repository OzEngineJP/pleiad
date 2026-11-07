// Pleiad の MCP の口（/mcp/context・/mcp/agents など）へ、どのトークンで接続が来たかの写し（メモリだけ）。
//
// agy は組織の管理ポリシー（MCP サーバーを無効）でカスタムエージェントの MCP を起こさないことがあり、
// そのことを stream-json に出さない。Pleiad は中継に渡したトークンで 1 度でも接続が来たかを見て気づく
// （core/backends/antigravity.mjs。docs/multi-backend.md §2.8「組織の管理ポリシー」）。
// 値はトークンそのものではなく形だけを見て、上限の数を超えたら古いものから捨てる。
// 口を持つサーバー（core/server.mjs）が watchMcpContacts で印を付けたプロセスだけが判定に使う。
// バックエンドだけを読み込むプロセス（試験の worker など）は接続を見られないので、来ていないと決めつけない。

const MAX = 512;
const seen = new Set();
let watching = false;

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

/** このプロセスが Pleiad の MCP の口を持ち、接続を覚えていることを示す */
export function watchMcpContacts() {
  watching = true;
}

/** 接続を覚えているプロセスか（false なら、来ていないかどうかは分からない） */
export function mcpContactsWatched() {
  return watching;
}
