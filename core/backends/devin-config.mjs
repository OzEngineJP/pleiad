import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const IMPORTS = ['agents_standard', 'cursor', 'windsurf', 'claude', 'copilot', 'opencode', 'zed'];
const TURN_CONFIG_MAX_BYTES = 1024 * 1024;
export const METADATA_CONFIG = Object.freeze({ read_config_from: Object.fromEntries(IMPORTS.map(id => [id, false])), hooks: {}, auto_update: false, notify: 'never' });

export function devinTurnConfig({ hooksRuntime = null, nativeShellOff = false } = {}) {
  const config = {};
  const supplied = hooksRuntime?.supplied ?? [];
  if (supplied.length) {
    config.read_config_from = Object.fromEntries(IMPORTS.map(id => [id, false]));
    const hooks = {};
    for (const { hook, d } of supplied) {
      if (typeof hook?.command !== 'string' || !hook.command.trim()) continue;
      const handler = { type: 'command', command: hook.command };
      const timeout = d.timeout ?? hook.timeout;
      if (Number.isInteger(timeout) && timeout >= 1 && timeout <= 86400) handler.timeout = timeout;
      (hooks[d.event] ??= []).push({ matcher: typeof d.matcher === 'string' ? d.matcher : '', hooks: [handler] });
    }
    config.hooks = hooks;
  }
  if (nativeShellOff) config.disabled_tools = ['exec', 'shell_command', 'write_to_process', 'kill_shell', 'get_output'];
  return Object.keys(config).length ? config : null;
}

/** Native turns keep the user's configuration and credentials in their original locations. */
export async function prepareDevinLaunch({ command, cwd, env = process.env, dataDir = env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host'), metadata = false, turnConfig = null }) {
  const base = path.join(dataDir, 'devin');
  const sessions = path.join(base, metadata ? 'metadata-sessions' : 'sessions');
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  const launch = { command: [...command], cwd: path.resolve(cwd), env: { ...env, DEVIN_SESSIONS_DIR: sessions } };
  if (!metadata) {
    if (turnConfig) {
      const turnConfigs = path.join(base, 'turn-configs');
      await fs.mkdir(turnConfigs, { recursive: true, mode: 0o700 });
      const content = JSON.stringify(turnConfig);
      if (Buffer.byteLength(content) > TURN_CONFIG_MAX_BYTES) throw Object.assign(new Error('Devin turn config exceeds 1 MiB'), { code: 'DEVIN_CONFIG_TOO_LARGE' });
      const configPath = path.join(turnConfigs, `${crypto.randomUUID()}.json`);
      await fs.writeFile(configPath, content, { mode: 0o600, flag: 'wx' });
      launch.command.push('--config', configPath);
      launch.cleanup = () => fs.rm(configPath, { force: true });
    }
    return launch;
  }
  const configHome = path.join(base, 'metadata-config');
  const configDir = path.join(configHome, 'devin');
  const work = path.join(base, 'metadata-work');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  // Fixed, bounded metadata settings only. No user settings or credentials are copied.
  const configPath = path.join(configDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(METADATA_CONFIG), { mode: 0o600 });
  await fs.writeFile(path.join(configDir, 'mcp_config.json'), '{"mcpServers":{}}', { mode: 0o600 });
  launch.command.push('--config', configPath);
  launch.cwd = work;
  launch.env.DEVIN_CONFIG_HOME = configHome;
  return launch;
}
