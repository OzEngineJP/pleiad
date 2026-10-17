// Claude の会話のシェルにだけ渡す環境変数（ADR 0217「環境変数の渡し方」）。
//
// Claude Code は CLAUDE_ENV_FILE のスクリプトを、Bash ツールの各コマンドの前に同じシェルで読む。秘密情報と変数をここに書けば、
// CLI 本体の env（options.env）には入らない。利用者が自分のアプリのために登録した ANTHROPIC_API_KEY などが、Claude Code 自身の認証・接続先を替えない。
// データ置き場の run/claude-env-<uuid>.sh に 0600 で書き、ターンの終わりに消す（消し損ねは起動時に片付ける。フラグ設定のファイルと同じ扱い）。
// 利用者が自分で CLAUDE_ENV_FILE を付けていれば、そのファイルを先に読む（Pleiad の値が後で勝つ）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ENV_FILE = /^claude-env-[0-9a-f-]+\.sh$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** sh の単一引用符で包む（' は '\'' にする） */
export const shQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** スクリプトの中身。vars は { NAME: value }。inherit は利用者が元から付けていた CLAUDE_ENV_FILE（無ければ null） */
export function envScript(vars, { inherit = null } = {}) {
  const lines = ['# Pleiad: environment variables for this conversation (ADR 0217). Deleted when the turn ends.'];
  // Windows の Git Bash でも読めるよう、区切りは / にする
  if (inherit) { const own = String(inherit).replace(/\\/g, '/'); lines.push(`[ -f ${shQuote(own)} ] && . ${shQuote(own)}`); }
  for (const [name, value] of Object.entries(vars ?? {})) if (NAME.test(name)) lines.push(`export ${name}=${shQuote(value)}`);
  return lines.join('\n') + '\n';
}

/** 書く。vars が空なら書かずに null。返りの dispose() で消す */
export async function writeClaudeEnvFile(dataDir, vars, { inherit = process.env.CLAUDE_ENV_FILE ?? null } = {}) {
  if (!vars || !Object.keys(vars).length) return null;
  const dir = path.join(dataDir, 'run');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `claude-env-${crypto.randomUUID()}.sh`);
  await fs.writeFile(file, envScript(vars, { inherit: inherit && !ENV_FILE.test(path.basename(inherit)) ? inherit : null }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.chmod(file, 0o600).catch(() => {});
  let gone = false;
  return { file, dispose: async () => { if (gone) return; gone = true; await fs.rm(file, { force: true }).catch(() => {}); } };
}

/** 付け直したターン（無停止の更新）のファイル。旧サーバーが書き、札が名前を持つ。名前の形が違えば null（run\ の外は指さない） */
export function adoptClaudeEnvFile(dataDir, name) {
  if (typeof name !== 'string' || !ENV_FILE.test(name)) return null;
  const file = path.join(dataDir, 'run', name);
  let gone = false;
  return { file, dispose: async () => { if (gone) return; gone = true; await fs.rm(file, { force: true }).catch(() => {}); } };
}

/** 前の起動で消し損ねたファイルを片付ける（起動時）。except は付け直すターンの札が指すファイルの名前 */
export async function sweepClaudeEnvFiles(dataDir, { olderThanMs = 0, except = [] } = {}) {
  const dir = path.join(dataDir, 'run');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!ENV_FILE.test(name) || except.includes(name)) continue;
    const f = path.join(dir, name);
    const st = await fs.stat(f).catch(() => null);
    if (!st || (olderThanMs > 0 && Date.now() - st.mtimeMs < olderThanMs)) continue;
    await fs.rm(f, { force: true }).catch(() => {}); n++;
  }
  return n;
}
