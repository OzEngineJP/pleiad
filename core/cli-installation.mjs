import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseCommand } from './command-line.mjs';
import { t } from './i18n.mjs';
import { AGENTS, agentOf } from './backends/agents.mjs';

/** id -> インストールの案内（エージェントの記述の cli.installUrl）。CLI を使わないもの（fake）は載らない */
export const INSTALL_URLS = Object.fromEntries(Object.entries(AGENTS).filter(([, a]) => a.cli?.installUrl).map(([id, a]) => [id, a.cli.installUrl]));

export function findExecutable(command, env = process.env, platform = process.platform) {
  const dirs = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  // エージェントの独自の置き場（エージェントの記述の cli.searchDirs。agy の `%LOCALAPPDATA%\agy\bin` など）。
  // **PATH だけを見ていると見つからない**: 起動済みの Pleiad は PATH の変更を拾えないので、入れた直後に「再確認」を押しても
  // 未インストールのままになる。置き場を直接見て、再起動を要らなくする
  for (const a of Object.values(AGENTS)) dirs.push(...(a.cli?.searchDirs?.(env) ?? []));
  const roots = /[\\/]/.test(command) ? [''] : [...String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean), ...dirs];
  const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const root of roots) for (const ext of exts) {
    const candidate = root ? path.join(root, command + ext) : command + ext;
    if (platform === 'win32' && !/\.(exe|cmd|bat|com)$/i.test(candidate)) continue;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  return null;
}

/**
 * npm の .cmd/.bat の包み（"%_prog%" "%dp0%\node_modules\…\bin\x.js" %*）を、中のスクリプトに解く。
 * 戻り値は { kind: 'node', script } か { kind: 'exe', script }、解けなければ null。
 * 包みは cmd.exe 経由でしか起こせず、保持役（shell: false）では起こせない（ADR 0270 の規則 ①）
 */
export function unwrapCommandShim(file, { readFile = fs.readFileSync, platform = process.platform } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(String(file))) return null;
  let text;
  try { text = String(readFile(file, 'utf8')); } catch { return null; }
  const dir = path.dirname(file);
  // %dp0% は包みのフォルダー（末尾に \）。JS のスクリプトを先に、無ければ node.exe 以外の実行ファイルを取る
  const candidates = [...text.matchAll(/%dp0%[\\/]+([^"\r\n]+?\.(?:js|mjs|cjs|exe))(?=["\s])/gi)].map(m => path.resolve(dir, m[1]));
  const target = candidates.find(p => /\.[cm]?js$/i.test(p))
    ?? candidates.find(p => /\.exe$/i.test(p) && !/^node\.exe$/i.test(path.basename(p)));
  if (!target) return null;
  try { if (!fs.statSync(target).isFile()) return null; } catch { return null; }
  return { kind: /\.exe$/i.test(target) ? 'exe' : 'node', script: target };
}

/**
 * 保持役が shell 無しで起こせる形に直す。.cmd/.bat は包みの中身（node のスクリプト・実行ファイル）に解く。
 * 解けなければ null（その子は保持役に載せない）
 */
export function directCommand(argv, { platform = process.platform, node = process.execPath } = {}) {
  const [command, ...args] = Array.isArray(argv) ? argv : [];
  if (!command) return null;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(String(command))) return { command, args };
  const inner = unwrapCommandShim(command, { platform });
  if (!inner) return null;
  return inner.kind === 'node' ? { command: node, args: [inner.script, ...args] } : { command: inner.script, args };
}

export function cliCommand(id) {
  // **id は必ずバックエンド id で引く**（installation() は backend.id で引かれる。実行ファイル名は記述の cli.exe）
  const cli = agentOf(id)?.cli ?? null;
  const configured = cli?.binEnv ? process.env[cli.binEnv] : null;
  const argv = configured ? parseCommand(configured) : [cli?.exe ?? id];
  const exe = argv[0] && findExecutable(argv[0]);
  const packageName = cli?.npmPackage;
  if (exe && packageName && /\.(cmd|bat)$/i.test(exe)) {
    try {
      const packageDir = path.join(path.dirname(exe), 'node_modules', packageName);
      const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[id];
      const script = bin && path.resolve(packageDir, bin);
      if (script && /\.[cm]?js$/i.test(script) && fs.statSync(script).isFile()) return [process.execPath, script, ...argv.slice(1)];
      // 包みの中身がネイティブの実行ファイル（@opencode/cli の bin/opencode.exe）なら、cmd を挟まずに直に起こす
      if (script && process.platform === 'win32' && /\.exe$/i.test(script) && fs.statSync(script).isFile()) return [script, ...argv.slice(1)];
    } catch {}
  }
  // 包みの中身の場所が分からない（npmPackage の書かれていない CLI・別の置き方の包み）ときは、包みの本文から解く
  if (exe && /\.(cmd|bat)$/i.test(exe)) {
    const direct = directCommand([exe, ...argv.slice(1)]);
    if (direct) return [direct.command, ...direct.args];
  }
  return exe ? [exe, ...argv.slice(1)] : null;
}

export function claudeExecutable() {
  const argv = cliCommand('claude');
  if (!argv) throw new Error(t('cli.claudeNotInstalled'));
  return argv[0] === process.execPath && argv[1] ? argv[1] : argv[0];
}

export function installation(id) {
  return { installed: !INSTALL_URLS[id] || Boolean(cliCommand(id)), installUrl: INSTALL_URLS[id] };
}

export function spawnCli(argv, args, options = {}) {
  if (!argv) throw new Error(t('cli.installAgent'));
  const [command, ...prefix] = argv;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // 包みの中身を直に起こせるなら cmd.exe を挟まない（保持役と同じ形。木に cmd.exe が残らない）
    const direct = directCommand([command, ...prefix, ...args]);
    if (direct) return spawn(direct.command, direct.args, { ...options, windowsHide: true });
    const quote = value => {
      if (/["%\r\n]/.test(value)) throw new Error(t('cli.badArgument'));
      return `"${value}"`;
    };
    return spawn([command, ...prefix, ...args].map(quote).join(' '), { ...options, shell: true, windowsHide: true });
  }
  return spawn(command, [...prefix, ...args], { ...options, windowsHide: true });
}
