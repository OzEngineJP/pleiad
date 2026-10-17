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
      // 包みの中身がネイティブの実行ファイル（opencode-ai の bin/opencode.exe）なら、cmd を挟まずに直に起こす
      if (script && process.platform === 'win32' && /\.exe$/i.test(script) && fs.statSync(script).isFile()) return [script, ...argv.slice(1)];
    } catch {}
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
    const quote = value => {
      if (/["%\r\n]/.test(value)) throw new Error(t('cli.badArgument'));
      return `"${value}"`;
    };
    return spawn([command, ...prefix, ...args].map(quote).join(' '), { ...options, shell: true, windowsHide: true });
  }
  return spawn(command, [...prefix, ...args], { ...options, windowsHide: true });
}
