import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { stripJsonc } from '../context-scan.mjs';
import { canLinkMcpOffHome, claimMcpOffHome, pruneMcpOffKept, settleMcpOffHomes, syncMcpOffHome } from './mcp-off-home.mjs';

/**
 * 写しの中で Devin が新しく作ったとき、本物の置き場へ運んでよい名前（ADR 0336）。Devin が設定の置き場の直下に作ると分かっているものだけ
 * （config.json: 設定。credentials.toml: ログインの認証情報。mcp_config.json: MCP の定義）。ほかの名前（一時ファイルなど）は運ばない。
 * 本物に既にある名前を Devin が置き換えたものは、この一覧に無くても運ぶ（settleMcpOffHome）
 */
export const DEVIN_CARRY = Object.freeze(['config.json', 'credentials.toml', 'mcp_config.json']);
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

/** Devin が読む設定の置き場（<置き場>/devin）。DEVIN_CONFIG_HOME が無ければ、Windows は %APPDATA%、ほかは XDG_CONFIG_HOME か ~/.config */
export function devinConfigDir(env = process.env) {
  return env.DEVIN_CONFIG_HOME ? path.join(env.DEVIN_CONFIG_HOME, 'devin') : path.join(env.APPDATA ?? env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'devin');
}

const readJsonc = async (file) => {
  // 先頭の BOM（メモ帳などで保存した UTF-8）は外して読む
  const text = (await fs.readFile(file, 'utf8').catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e))))?.replace(/^\uFEFF/, '') ?? null;
  if (text === null || !text.trim()) return null;
  try { const value = JSON.parse(stripJsonc(text)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { throw Object.assign(new Error(`Cannot turn off MCP servers for this conversation: ${path.basename(file)} in the Devin settings folder is not valid JSON.`), { code: 'MCP_OFF_UNSUPPORTED' }); }
};

/**
 * Devin 自身の MCP を名前で止めるターンの設定の置き場（ADR 0336）。DEVIN_CONFIG_HOME に渡す場所を返す。
 * 本物の置き場（source。%APPDATA%\devin など）を写し、写しの mcp_config.json だけ、止める名前に disabled: true を付けて書く。
 * 本物に無い名前（Claude の ~/.claude.json などからの取り込み）は { disabled: true } の項目を足す（取り込みより mcp_config.json が勝つ）。
 * config.json に mcpServers が残っている（Devin が mcp_config.json へ移す前の形）ときは、写しの config.json からは除き、
 * その定義を写しの mcp_config.json に移す（リンクのままだと、Devin の移し替えが本物の config.json を書き換える）。
 * 作業場所の .devin/mcp_config.json・.mcp.json の定義はここでは止まらない（能力の印 nativeMcpOff: 'user'）
 * 写しの中で Devin が置き換えたファイル（認証情報の更新など）と、新しく作った DEVIN_CARRY の名前は本物へ運ぶ。運べない中身は kept（既定は root の隣の mcp-off-kept）に残す（settleMcpOffHome）
 */
export async function prepareDevinMcpOff({ root, source, suppress, kept = path.join(path.dirname(root), 'mcp-off-kept') }) {
  const target = await claimMcpOffHome(root, source, suppress);
  const mcp = (await readJsonc(path.join(source, 'mcp_config.json'))) ?? {};
  const config = await readJsonc(path.join(source, 'config.json'));
  const moved = config && Object.hasOwn(config, 'mcpServers');
  const servers = { ...(moved && config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}), ...(mcp.mcpServers && typeof mcp.mcpServers === 'object' ? mcp.mcpServers : {}) };
  for (const name of new Set(suppress)) servers[name] = { ...(servers[name] && typeof servers[name] === 'object' ? servers[name] : {}), disabled: true };
  const generated = { 'mcp_config.json': `${JSON.stringify({ ...mcp, mcpServers: servers }, null, 2)}\n` };
  if (moved) { const { mcpServers: _m, ...rest } = config; generated['config.json'] = `${JSON.stringify(rest, null, 2)}\n`; }
  await syncMcpOffHome({ source, target: path.join(target, 'devin'), generated, kept, carry: DEVIN_CARRY });
  return target;
}

/**
 * Native turns keep the user's configuration and credentials in their original locations.
 * mcpOff: 止める Devin 自身の MCP の名前（contextRuntime.mcp.suppress）。あるときだけ DEVIN_CONFIG_HOME を写しに替える（prepareDevinMcpOff）。
 * シンボリックリンクを作れない PC（canLinkMcpOffHome）や、写しのリンクを作れなかったときは、写しを使わず今までと同じ起動にする
 * （画面は鍵にしてあるので、保存してある off でターンを止めない）。写しのリンクを作れなかったときは launch.mcpOffFailed に止められなかった名前を載せる
 * （呼び手が実行時の報告の行に「止められなかった」の印を付ける）
 */
export async function prepareDevinLaunch({ command, cwd, env = process.env, dataDir = env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host'), metadata = false, turnConfig = null, mcpOff = [] }) {
  const base = path.join(dataDir, 'devin');
  const sessions = path.join(base, metadata ? 'metadata-sessions' : 'sessions');
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  const launch = { command: [...command], cwd: path.resolve(cwd), env: { ...env, DEVIN_SESSIONS_DIR: sessions } };
  if (!metadata) {
    // 前のターンの写しに残った Devin の更新（止める名前を on に戻した後も）を、本物へ運んでおく
    await settleMcpOffHomes(path.join(base, 'mcp-off'), devinConfigDir(env)).catch(() => {});
    // 何も残さない日が続いても、期限を過ぎた kept を消す
    await pruneMcpOffKept(path.join(base, 'mcp-off-kept')).catch(() => {});
    if (mcpOff.length && canLinkMcpOffHome(dataDir)) {
      try { launch.env.DEVIN_CONFIG_HOME = await prepareDevinMcpOff({ root: path.join(base, 'mcp-off'), source: devinConfigDir(env), suppress: mcpOff }); }
      catch (error) { if (error?.code !== 'MCP_OFF_LINK_FAILED') throw error; launch.mcpOffFailed = [...new Set(mcpOff)]; }
    }
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
