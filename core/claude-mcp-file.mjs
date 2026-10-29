// Claude へ渡す HTTP の MCP の設定（ADR 0284）。
//
// ply_agents・ply_context・ply_computer・ply_browser・ply_control・ply_shell などの HTTP の MCP は、
// 会話ごとのトークンを `headers.Authorization` に持つ。**`mcpServers` のオブジェクトで渡すと SDK が `--mcp-config` の JSON に
// 直列化し、トークンが claude.exe のコマンドラインに残る**。
// そこで `{ mcpServers: … }` をデータ置き場の `run/claude-mcp-<uuid>.json` に 0600 で書き、`--mcp-config` にはパスだけを渡す。
// ターンの終わりに消す（消し損ねは起動時に片付ける。claude-env-file.mjs・フラグ設定のファイルと同じ扱い）。
// 札にはファイルの名前だけを入れる（トークンは入れない）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MCP_FILE = /^claude-mcp-[0-9a-f-]+\.json$/;

/**
 * HTTP の MCP の設定を書く。servers は { name: { type: 'http', url, headers, timeout? } }（sdk 型はここへ来ない）。
 * 返りの dispose() で消す。空なら書かずに null（--mcp-config は付けない）
 */
export async function writeClaudeMcpFile(dataDir, servers) {
  if (!servers || !Object.keys(servers).length) return null;
  const dir = path.join(dataDir, 'run');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `claude-mcp-${crypto.randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify({ mcpServers: servers }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.chmod(file, 0o600).catch(() => {});
  let gone = false;
  return { file, dispose: async () => { if (gone) return; gone = true; await fs.rm(file, { force: true }).catch(() => {}); } };
}

/** 付け直したターン（無停止の更新）のファイル。旧サーバーが書き、札が名前を持つ。名前の形が違えば null（run\ の外は指さない） */
export function adoptClaudeMcpFile(dataDir, name) {
  if (typeof name !== 'string' || !MCP_FILE.test(name)) return null;
  const file = path.join(dataDir, 'run', name);
  let gone = false;
  return { file, dispose: async () => { if (gone) return; gone = true; await fs.rm(file, { force: true }).catch(() => {}); } };
}

/** 前の起動で消し損ねたファイルを片付ける（起動時）。except は付け直すターンの札が指すファイルの名前 */
export async function sweepClaudeMcpFiles(dataDir, { olderThanMs = 0, except = [] } = {}) {
  const dir = path.join(dataDir, 'run');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!MCP_FILE.test(name) || except.includes(name)) continue;
    const f = path.join(dir, name);
    const st = await fs.stat(f).catch(() => null);
    if (!st || (olderThanMs > 0 && Date.now() - st.mtimeMs < olderThanMs)) continue;
    await fs.rm(f, { force: true }).catch(() => {}); n++;
  }
  return n;
}
