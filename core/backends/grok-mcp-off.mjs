// Grok 自身の MCP を名前で止めるターンの GROK_HOME（ADR 0330）。
// Grok は会話ごとに MCP を名前で止める引数を持たないが、GROK_HOME の config.toml の disabled_mcp_servers（名前の配列）は、
// 利用者の config.toml・Claude の設定からの取り込み・作業場所の .grok/config.toml・.mcp.json のどの定義にも効く。
// そこで止める名前があるターンだけ、GROK_HOME の写し（core/backends/mcp-off-home.mjs）を作り、写しの config.toml に止める名前を足す。
// 本物の GROK_HOME（~/.grok・アカウントの置き場・互換の接続先の置き場）の中身は書き換えない。
// managed_config.toml・requirements.toml の denied_mcp_servers は使わない: ログインした会話では、Grok が起動の直後に
// 管理の設定をサーバーと同期し、写しに書いたファイルを消す（実機で確認、Grok 1.0.62、2026-11-15）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseToml } from '../toml.mjs';
import { claimMcpOffHome, syncMcpOffHome } from './mcp-off-home.mjs';

export const GROK_CONFIG = 'config.toml';
const KEY = 'disabled_mcp_servers';
const MANAGED = 'managed_config.toml';

const unsupported = reason => Object.assign(new Error(`Cannot turn off MCP servers for this conversation: ${reason}`), { code: 'MCP_OFF_UNSUPPORTED' });

/**
 * 本物の config.toml の中身 text に、止める名前 names を disabled_mcp_servers として足した中身。
 * 本物に disabled_mcp_servers があれば、その名前と合わせる。書いた結果を解析し直し、
 * 「本物の中身＋止める名前」と一致しなければ（書き方を読み違えた）止めずに MCP_OFF_UNSUPPORTED にする。
 */
export function grokConfigWithDisabled(text, names) {
  const base = String(text ?? '');
  let parsed;
  try { parsed = parseToml(base); } catch { throw unsupported(`${GROK_CONFIG} in the Grok settings folder could not be read as TOML.`); }
  const had = parsed[KEY];
  if (had !== undefined && !(Array.isArray(had) && had.every(n => typeof n === 'string'))) throw unsupported(`${KEY} in ${GROK_CONFIG} is not a list of names.`);
  const all = [...new Set([...(had ?? []), ...names])].sort();
  const line = `${KEY} = ${JSON.stringify(all)} # Added by Pleiad for this conversation (MCP servers turned off for Grok)`;
  let out;
  if (had === undefined) {
    // ファイルの先頭は必ず最上位の表なので、先頭に 1 行足す（最初の [表] の後ろに置くと、その表のキーになる）
    out = `${line}\n${base}`;
  } else {
    // 最上位に 1 行で書いた disabled_mcp_servers = [...] だけを置き換える。複数行・点つきのキーなどは、下の照合で断る
    const re = new RegExp(`^[ \\t]*${KEY}[ \\t]*=[ \\t]*\\[[^\\]\\n]*\\][ \\t]*(#[^\\n]*)?$`, 'm');
    const header = base.search(/^[ \t]*\[/m);
    const at = base.search(re);
    out = at >= 0 && (header < 0 || at < header) ? base.replace(re, line) : base;
  }
  let check = null;
  try { check = parseToml(out); } catch {}
  if (!check || !isDeepStrictEqual(check, { ...parsed, [KEY]: all })) throw unsupported(`${KEY} in ${GROK_CONFIG} is written in a form Pleiad cannot extend. Write it on one line near the top, like ${KEY} = ["name"].`);
  return out;
}

/**
 * 止める名前 suppress を効かせた GROK_HOME の写しを root の下に作り、その場所を返す。source は本物の GROK_HOME。
 * 写さないもの: 写しの config.toml（Pleiad が書く）と managed_config.lock。SQLite の DB（worktrees.db など）は写し側に別に作られる
 */
export async function prepareGrokMcpOff({ root, source, suppress }) {
  const target = await claimMcpOffHome(root, source, suppress);
  const config = await fs.readFile(path.join(source, GROK_CONFIG), 'utf8').catch(e => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
  const content = grokConfigWithDisabled(config, suppress);
  // 写しにだけある普通の managed_config.toml（前の版の Pleiad が書いたもの・Grok が写しに同期したもの）は、本物に無ければ消す。
  // 残すと、起動のときに本物と違う管理の設定で読まれる。本物にあればリンクに戻る（syncMcpOffHome）
  const managed = path.join(target, MANAGED);
  const info = await fs.lstat(managed).catch(() => null);
  if (info?.isFile() && !(await fs.stat(path.join(source, MANAGED)).catch(() => null))) await fs.unlink(managed).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  // sessions（会話の記録）は、止める名前が無いターン・再開・分岐が本物の置き場で読むので、必ず本物へのリンクにする
  await syncMcpOffHome({ source, target, generated: { [GROK_CONFIG]: content }, skip: name => name === 'managed_config.lock', shared: ['sessions'] });
  return target;
}
