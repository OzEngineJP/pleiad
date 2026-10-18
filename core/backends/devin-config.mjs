import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const IMPORTS = ['agents_standard', 'cursor', 'windsurf', 'claude', 'copilot', 'opencode', 'zed'];
export const METADATA_CONFIG = Object.freeze({ read_config_from: Object.fromEntries(IMPORTS.map(id => [id, false])), hooks: {}, auto_update: false, notify: 'never' });

/** Native turns keep the user's configuration and credentials in their original locations. */
export async function prepareDevinLaunch({ command, cwd, env = process.env, dataDir = env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host'), metadata = false }) {
  const base = path.join(dataDir, 'devin');
  const sessions = path.join(base, metadata ? 'metadata-sessions' : 'sessions');
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  const launch = { command: [...command], cwd: path.resolve(cwd), env: { ...env, DEVIN_SESSIONS_DIR: sessions } };
  if (!metadata) return launch;
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
