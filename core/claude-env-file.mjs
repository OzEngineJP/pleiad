// Claude の会話のシェルにだけ渡す環境変数（ADR 0217「環境変数の渡し方」→ ADR 0284）。
//
// Claude Code は CLAUDE_ENV_FILE のスクリプトを、Bash ツールの各コマンドの前に同じシェルで読む。秘密情報と変数をここに書けば、
// CLI 本体の env（options.env）には入らない。利用者が自分のアプリのために登録した ANTHROPIC_API_KEY などが、Claude Code 自身の認証・接続先を替えない。
//
// ファイルは 2 つ（ADR 0284）。**値は `run/claude-env-<uuid>.vals`（0600）にだけ書き、CLAUDE_ENV_FILE の `run/claude-env-<uuid>.sh` には
// そのファイルを読む source 行だけを置く**。値の入ったスクリプト本文は Claude Code が `bash.exe -c` の引数に埋め込み、
// 値がプロセスのコマンドラインに残るため。
// どちらもターンの終わりに消す（消し損ねは起動時に片付ける。フラグ設定のファイルと同じ扱い）。
// 利用者が自分で CLAUDE_ENV_FILE を付けていれば、そのファイルを先に読む（Pleiad の値が後で勝つ）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ENV_FILE = /^claude-env-[0-9a-f-]+\.sh$/;
const VALS_FILE = /^claude-env-[0-9a-f-]+\.vals$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 値ファイルの名前（スクリプトの名前から導く。札にはスクリプトの名前だけを入れる） */
export const claudeEnvValuesName = name => String(name).replace(/\.sh$/, '.vals');

/** sh の単一引用符で包む（' は '\'' にする）。テンプレートの入れ子は data-writes の走査を誤読させるので、文字列の連結で書く */
export const shQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

/** sh のパス。Windows の Git Bash でも読めるよう、区切りは / にする */
const shPath = file => String(file).replace(/\\/g, '/');

/**
 * CLAUDE_ENV_FILE のスクリプトの中身。値は書かない（中身は bash.exe -c の引数に載るので、ファイルのパスだけ）。
 * valuesFile は値ファイルのフルパス。inherit は利用者が元から付けていた CLAUDE_ENV_FILE（無ければ null。先に読み、Pleiad の値が後で勝つ）
 */
export function envScript({ valuesFile, inherit = null }) {
  const lines = ['# Pleiad: environment variables for this conversation (ADR 0284). Deleted when the turn ends.'];
  if (inherit) lines.push(`[ -f ${shQuote(shPath(inherit))} ] && . ${shQuote(shPath(inherit))}`);
  lines.push(`[ -f ${shQuote(shPath(valuesFile))} ] && . ${shQuote(shPath(valuesFile))}`);
  return lines.join('\n') + '\n';
}

/** 値ファイル（.vals）の中身。vars は { NAME: value }。export 行だけ（source される）。値の無いファイルは作らない */
export function envValues(vars) {
  const lines = ['# Pleiad: values for this conversation (sourced by the matching claude-env-*.sh).'];
  for (const [name, value] of Object.entries(vars ?? {})) if (NAME.test(name)) lines.push(`export ${name}=${shQuote(value)}`);
  return lines.join('\n') + '\n';
}

/** 書く。vars が空なら書かずに null。返りの dispose() でスクリプトと値ファイルを消す */
export async function writeClaudeEnvFile(dataDir, vars, { inherit = process.env.CLAUDE_ENV_FILE ?? null } = {}) {
  if (!vars || !Object.keys(vars).length) return null;
  const dir = path.join(dataDir, 'run');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `claude-env-${crypto.randomUUID()}.sh`);
  const values = path.join(dir, claudeEnvValuesName(path.basename(file)));
  const mode = { encoding: 'utf8', mode: 0o600, flag: 'wx' };
  try {
    await fs.writeFile(values, envValues(vars), mode);
    await fs.chmod(values, 0o600).catch(() => {});
    await fs.writeFile(file, envScript({ valuesFile: values, inherit: inherit && !ENV_FILE.test(path.basename(inherit)) ? inherit : null }), mode);
    await fs.chmod(file, 0o600).catch(() => {});
  } catch (e) {
    await fs.rm(values, { force: true }).catch(() => {});
    await fs.rm(file, { force: true }).catch(() => {});
    throw e;
  }
  let gone = false;
  return { file, values, dispose: async () => { if (gone) return; gone = true; await fs.rm(values, { force: true }).catch(() => {}); await fs.rm(file, { force: true }).catch(() => {}); } };
}

/** 付け直したターン（無停止の更新）のファイル。旧サーバーが書き、札が名前を持つ。名前の形が違えば null（run\ の外は指さない） */
export function adoptClaudeEnvFile(dataDir, name) {
  if (typeof name !== 'string' || !ENV_FILE.test(name)) return null;
  const file = path.join(dataDir, 'run', name);
  const values = path.join(dataDir, 'run', claudeEnvValuesName(name));
  let gone = false;
  return { file, values, dispose: async () => { if (gone) return; gone = true; await fs.rm(values, { force: true }).catch(() => {}); await fs.rm(file, { force: true }).catch(() => {}); } };
}

/** 前の起動で消し損ねたファイルを片付ける（起動時）。except は付け直すターンの札が指すファイルの名前（スクリプト側。値ファイルは対になって残る） */
export async function sweepClaudeEnvFiles(dataDir, { olderThanMs = 0, except = [] } = {}) {
  const dir = path.join(dataDir, 'run');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return 0; }
  const live = new Set(names);
  let n = 0;
  for (const name of names) {
    const isScript = ENV_FILE.test(name);
    // スクリプトと対の値ファイルは、札が指すスクリプトが残るなら残す。対のスクリプトが無い値ファイルは残った方（片付ける）
    if (!isScript && !VALS_FILE.test(name)) continue;
    const script = isScript ? name : name.replace(/\.vals$/, '.sh');
    if (except.includes(script)) continue;
    if (!isScript && live.has(script)) continue;   // スクリプトの分で一緒に消す
    const f = path.join(dir, name);
    const st = await fs.stat(f).catch(() => null);
    if (!st || (olderThanMs > 0 && Date.now() - st.mtimeMs < olderThanMs)) continue;
    await fs.rm(f, { force: true }).catch(() => {}); n++;
    if (isScript) { const v = claudeEnvValuesName(name); if (await fs.rm(path.join(dir, v), { force: true }).then(() => true, () => false)) n++; }
  }
  return n;
}
