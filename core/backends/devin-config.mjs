import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { stripJsonc } from '../context-scan.mjs';
import { t } from '../i18n.mjs';
import { canLinkMcpOffHome, claimMcpOffHome, pruneMcpOffKept, settleMcpOffHomes, syncMcpOffHome } from './mcp-off-home.mjs';

/**
 * 写しの中で Devin が新しく作ったとき、本物の置き場へ運んでよい名前（ADR 0336）。Devin が設定の置き場の直下に作ると分かっているものだけ
 * （config.json: 設定。credentials.toml: ログインの認証情報。mcp_config.json: MCP の定義）。ほかの名前（一時ファイルなど）は運ばない。
 * 本物に既にある名前を Devin が置き換えたものは、この一覧に無くても運ぶ（settleMcpOffHome）
 */
export const DEVIN_CARRY = Object.freeze(['config.json', 'credentials.toml', 'mcp_config.json']);
const IMPORTS = ['agents_standard', 'cursor', 'windsurf', 'claude', 'copilot', 'opencode', 'zed'];
const TURN_CONFIG_MAX_BYTES = 1024 * 1024;
/** 会話限定の設定の残り（サーバーが落ちて閉じる処理が走らなかったもの）を消すまでの時間 */
export const TURN_CONFIG_STALE_MS = 24 * 60 * 60 * 1000;

async function pruneTurnConfigs(dir, now = Date.now()) {
  let names = [];
  try { names = await fs.readdir(dir); } catch { return; }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try { if (now - (await fs.stat(file)).mtimeMs > TURN_CONFIG_STALE_MS) await fs.rm(file, { force: true }); } catch {}
  }
}
export const METADATA_CONFIG = Object.freeze({ read_config_from: Object.fromEntries(IMPORTS.map(id => [id, false])), hooks: {}, auto_update: false, notify: 'never' });

export function devinTurnConfig({ hooksRuntime = null, nativeShellOff = false } = {}) {
  const config = {};
  const supplied = hooksRuntime?.supplied ?? [];
  // 取り込み（Claude などの設定の hooks・MCP・ルール）を止めるか。旧「Pleiad がそろえる」は渡すものがあるターンだけ止める。
  // Hook × エージェントの一覧（ADR 0338）は stopImports で決める（止めずに渡すときは read_config_from を書かない。取り込みはそのまま動く。実機で確認）
  const stopImports = hooksRuntime ? (typeof hooksRuntime.stopImports === 'boolean' ? hooksRuntime.stopImports : supplied.length > 0) : false;
  if (stopImports) config.read_config_from = Object.fromEntries(IMPORTS.map(id => [id, false]));
  if (supplied.length) {
    const hooks = {};
    for (const { hook, d } of supplied) {
      if (typeof hook?.command !== 'string' || !hook.command.trim()) continue;
      // Devin が知らないイベントが 1 つでもあると、Devin は hooks を丸ごと捨てる（重ねた利用者の hooks も外れる）ので渡さない
      if (!DEVIN_HOOK_EVENTS.has(d.event)) continue;
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

/** 文字列の外の、閉じ括弧の直前のカンマを外す（Devin の JSONC は末尾のカンマを受け付ける。実機 3000.11.92 で確認） */
function stripTrailingCommas(text) {
  let out = '', str = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (str) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; out += c; continue; }
    if (c === ',') { let j = i + 1; while (j < text.length && /\s/.test(text[j])) j++; if (text[j] === '}' || text[j] === ']') continue; }
    out += c;
  }
  return out;
}
const BOM = /^\uFEFF/;
/** Devin の設定ファイル（JSONC: コメント・末尾のカンマ・先頭の BOM）を JSON として読む。壊れていれば投げる（code は呼び手が付ける） */
const parseDevinJsonc = (text) => JSON.parse(stripTrailingCommas(stripJsonc(text.replace(BOM, ''))));

const readJsonc = async (file) => {
  // 先頭の BOM（メモ帳などで保存した UTF-8）は外して読む
  const text = await fs.readFile(file, 'utf8').catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (text === null || !text.replace(BOM, '').trim()) return null;
  try { const value = parseDevinJsonc(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { throw Object.assign(new Error(`Cannot turn off MCP servers for this conversation: ${path.basename(file)} in the Devin settings folder is not valid JSON.`), { code: 'MCP_OFF_UNSUPPORTED' }); }
};

/** Devin が受け付ける hooks のイベント名（3000.11.92）。ほかの名前が 1 つでもあると、Devin は hooks を丸ごと既定の {} に戻す */
const DEVIN_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PostCompaction', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'PermissionRequest', 'Notification', 'SubagentStop']);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const optString = v => v === undefined || typeof v === 'string';
/**
 * Pleiad が足すキーについて、利用者の値を Devin が受け付けるか。Devin は受け付けない値のキーを丸ごと既定に戻すので、足した Pleiad の分も一緒に外れる。
 * 実機（3000.11.92）の警告で確かめた形だけを見る（余分な欄・未知の取り込み名・未知の道具名・timeout の null は Devin も受け付ける。
 * matcher の null・type の欠け・負や小数の timeout・未知のイベント名は受け付けない）
 */
const DEVIN_KEY_CHECKS = {
  hooks: v => isObject(v) && Object.entries(v).every(([event, groups]) => DEVIN_HOOK_EVENTS.has(event) && Array.isArray(groups)
    && groups.every(g => isObject(g) && optString(g.matcher) && Array.isArray(g.hooks)
      && g.hooks.every(h => isObject(h) && (h.type === 'command' || h.type === 'prompt') && optString(h.command) && optString(h.prompt)
        && (h.timeout === undefined || h.timeout === null || (Number.isSafeInteger(h.timeout) && h.timeout >= 0))))),
  read_config_from: v => isObject(v) && IMPORTS.every(id => v[id] === undefined || v[id] === null || typeof v[id] === 'boolean'),
  disabled_tools: v => Array.isArray(v) && v.every(x => typeof x === 'string'),
};
const userConfigError = reason => Object.assign(new Error(t('devin.errors.userConfigInvalid', { reason })), { code: 'DEVIN_USER_CONFIG_INVALID' });

/**
 * 利用者の Devin の設定（config.json）を読む。無い・空なら null。
 * 読めない・JSONC として壊れている・全体がオブジェクトでないときは DEVIN_USER_CONFIG_INVALID で断る
 * （Devin 自身は警告を 1 行出して既定の設定で動くが、Pleiad の中ではその警告が見えず、利用者の設定が黙って外れる）。中身は誤りの文に載せない
 */
export async function readDevinUserConfig(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw userConfigError(t('devin.errors.configUnreadable')); }
  if (!text.replace(BOM, '').trim()) return null;
  let value;
  try { value = parseDevinJsonc(text); } catch { throw userConfigError(t('devin.errors.configInvalidJson')); }
  if (!isObject(value)) throw userConfigError(t('devin.errors.configNotObject'));
  return value;
}

/**
 * 利用者の設定（user）に、会話限定の Pleiad の分（part。devinTurnConfig の返り値）を重ねる。
 * Devin の --config は利用者の config.json を置き換える（重ねない。実機で確認）ので、利用者の設定を土台にして Pleiad の分だけを足す。
 * - hooks: イベントごとに利用者の後ろへ足す（利用者の hooks は残る）
 * - read_config_from: 利用者の値に、Pleiad が止める取り込み（false）だけを上書きする。Pleiad は false しか書かないので、利用者が止めた取り込みを広げない
 * - disabled_tools: 和集合
 * - ほかのキー（permissions・agent.model・devin.org_id など）: 利用者のまま
 * Pleiad が足すキーで、利用者の値を Devin が受け付けないときは DEVIN_USER_CONFIG_INVALID で断る（足しても Devin がキーごと捨て、Pleiad の分も外れる）
 */
export function overlayDevinConfig(user, part) {
  if (!part) return user ?? null;
  const base = isObject(user) ? user : {};
  for (const key of Object.keys(part)) {
    if (base[key] !== undefined && DEVIN_KEY_CHECKS[key] && !DEVIN_KEY_CHECKS[key](base[key])) throw userConfigError(t('devin.errors.configInvalidValue', { key }));
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(part)) {
    if (key === 'hooks') {
      const hooks = { ...(base.hooks ?? {}) };
      for (const [event, groups] of Object.entries(value)) hooks[event] = [...(hooks[event] ?? []), ...groups];
      merged.hooks = hooks;
    } else if (key === 'read_config_from') {
      merged.read_config_from = { ...(base.read_config_from ?? {}), ...Object.fromEntries(Object.entries(value).filter(([, on]) => on === false)) };
    } else if (key === 'disabled_tools') {
      merged.disabled_tools = [...new Set([...(base.disabled_tools ?? []), ...value])];
    } else merged[key] = value;
  }
  return merged;
}

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
      // Devin の --config は利用者の config.json を置き換える（重ねない）。利用者の設定を読んで Pleiad の分を重ねた写しを渡す（利用者のファイルには書かない）。
      // 読むのは、このターンの Devin が見る置き場（MCP を止めるターンは写し。写しの config.json は本物へのリンクか、mcpServers を mcp_config.json へ移した形）
      const user = await readDevinUserConfig(path.join(devinConfigDir(launch.env), 'config.json'));
      const turnConfigs = path.join(base, 'turn-configs');
      await fs.mkdir(turnConfigs, { recursive: true, mode: 0o700 });
      await pruneTurnConfigs(turnConfigs);
      // 写しには利用者の設定（プロキシの URL などを含みうる）が入る: 利用者だけが読める置き場に 0600 で作り、ターンの終わりに消す。中身はログに出さない
      const content = JSON.stringify(overlayDevinConfig(user, turnConfig));
      if (Buffer.byteLength(content) > TURN_CONFIG_MAX_BYTES) throw Object.assign(new Error(t('devin.errors.turnConfigTooLarge')), { code: 'DEVIN_CONFIG_TOO_LARGE' });
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
