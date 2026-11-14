// Grok 自身の MCP を名前で止めるターンの GROK_HOME（ADR 0330）。
// Grok は会話ごとに MCP を名前で止める引数を持たないが、GROK_HOME の managed_config.toml の [[denied_mcp_servers]] は、
// 利用者の config.toml・Claude の設定からの取り込み・作業場所の .grok/config.toml・.mcp.json のどの定義にも効く。
// そこで止める名前があるターンだけ、GROK_HOME の写し（core/backends/mcp-off-home.mjs）を作り、写しの managed_config.toml に止める名前を足す。
// 本物の GROK_HOME（~/.grok・アカウントの置き場・互換の接続先の置き場）の中身は書き換えない。
import fs from 'node:fs/promises';
import path from 'node:path';
import { claimMcpOffHome, syncMcpOffHome } from './mcp-off-home.mjs';

export const GROK_MANAGED_CONFIG = 'managed_config.toml';

/** 本物の managed_config.toml の中身 text に、止める名前 names を足した中身 */
export function grokManagedConfig(text, names) {
  const base = String(text ?? '');
  // 本物が denied_mcp_servers を「= [...]」の形で書いているなら、表の配列を足すと TOML として重なる（Grok が読めない）。止めずに知らせる
  if (/^\s*denied_mcp_servers\s*=/m.test(base)) throw Object.assign(new Error(`Cannot turn off MCP servers for this conversation: ${GROK_MANAGED_CONFIG} in the Grok settings folder sets denied_mcp_servers inline. Write it as [[denied_mcp_servers]] tables instead.`), { code: 'MCP_OFF_UNSUPPORTED' });
  const blocks = [...new Set(names)].sort().map(n => `[[denied_mcp_servers]]\nserver_name = ${JSON.stringify(n)}\n`).join('\n');
  return `${base}${base && !base.endsWith('\n') ? '\n' : ''}${base ? '\n' : ''}# Added by Pleiad for this conversation (MCP servers turned off for Grok)\n${blocks}`;
}

/**
 * 止める名前 suppress を効かせた GROK_HOME の写しを root の下に作り、その場所を返す。source は本物の GROK_HOME。
 * 写さないもの: 写しの managed_config.toml（Pleiad が書く）と、そのロック（managed_config.lock）。SQLite の DB（worktrees.db など）は写し側に別に作られる
 */
export async function prepareGrokMcpOff({ root, source, suppress }) {
  const target = await claimMcpOffHome(root, source, suppress);
  const managed = await fs.readFile(path.join(source, GROK_MANAGED_CONFIG), 'utf8').catch(e => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
  // sessions（会話の記録）は、止める名前が無いターン・再開・分岐が本物の置き場で読むので、必ず本物へのリンクにする
  await syncMcpOffHome({ source, target, generated: { [GROK_MANAGED_CONFIG]: grokManagedConfig(managed, suppress) }, skip: name => name === 'managed_config.lock', shared: ['sessions'] });
  return target;
}
