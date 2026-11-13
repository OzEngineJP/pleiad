// Claude 側にだけある外部 MCP（プラグインの MCP と claude.ai のコネクター）を読む。ADR 0325。
// どちらも Claude の設定ファイル（.claude.json など）には出ず、ここで読まないと一覧に出せない。
//   プラグイン: ~/.claude/plugins/installed_plugins.json と各プラグインの .mcp.json（ディスクだけで読める）
//   コネクター: Claude を起動しないと分からない。画面を開いたときに裏で 1 回だけ起こして読み、直近の一覧を覚えておく
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from './atomic-file.mjs';
import { containsPath } from './context-settings.mjs';

const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Claude のプラグインの MCP。この作業場所（cwd）で有効なプラグインだけ。戻り: [{ plugin, server, key, transport }]（key は deniedMcpServers の名前）
 * インストールの範囲（scope）が project / local のプラグインは、その場所（projectPath。作業場所がその下にあるとき）だけ。
 * 有効かは、ユーザーの settings.json に、作業場所の .claude/settings.json・settings.local.json を後ろから重ねた enabledPlugins で決める
 */
export async function readClaudePlugins({ claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), cwd = null } = {}) {
  const installed = await readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  if (!isObj(installed?.plugins)) return [];
  const enabled = {};
  const layers = [path.join(claudeHome, 'settings.json'), ...(cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : [])];
  for (const file of layers) { const e = (await readJson(file))?.enabledPlugins; if (isObj(e)) Object.assign(enabled, e); }
  const here = install => {
    const scope = install?.scope ?? 'user';
    if (scope === 'user') return true;
    return Boolean(cwd && typeof install.projectPath === 'string' && containsPath(install.projectPath, cwd));
  };
  const out = [];
  for (const [id, installs] of Object.entries(installed.plugins)) {
    if (enabled[id] === false) continue;
    const dir = Array.isArray(installs) ? installs.find(i => typeof i?.installPath === 'string' && here(i))?.installPath : null;
    if (!dir) continue;
    const meta = await readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
    const plugin = typeof meta?.name === 'string' && meta.name ? meta.name : id.split('@')[0];
    const servers = (await readJson(path.join(dir, '.mcp.json')))?.mcpServers;
    if (!isObj(servers)) continue;
    for (const [server, def] of Object.entries(servers)) {
      const transport = isObj(def) ? (def.type ?? (def.url ? 'http' : 'stdio')) : null;
      out.push({ plugin, server, key: `plugin:${plugin}:${server}`, transport });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** 覚えておく件数の上限（コネクターの名前。実際は数個） */
export const CONNECTOR_CACHE_MAX = 200;
/** 読み取りを待つ時間（ms）。Claude の起動直後は接続状況がまだ空なので、少し待ってから読む */
export const CONNECTOR_WAIT_MS = 2000;
/** 読めた一覧をそのまま使う時間（ms）。設定を開くたびに Claude を起こさない */
export const CONNECTOR_TTL_MS = 5 * 60_000;

const CONNECTOR_PREFIX = 'claude.ai ';
/** mcpServerStatus() の結果から、claude.ai のコネクターの名前だけを取り出す */
export function connectorNames(status) {
  const rows = Array.isArray(status) ? status : Array.isArray(status?.mcpServers) ? status.mcpServers : [];
  return [...new Set(rows.map(r => r?.name).filter(n => typeof n === 'string' && n.startsWith(CONNECTOR_PREFIX)).map(n => n.slice(CONNECTOR_PREFIX.length)))].sort();
}

/**
 * コネクターの読み取り。probe({ deny }) は Claude を話さずに起こし、claude.ai のコネクターの名前の配列を返す関数（失敗は投げる）。
 *   deny: 起こすとき止める名前（資格情報の要らない Pleiad の登録。話しかけないので、読み取りが本物の接続を開かないようにする）
 * 戻り: { get(): { connectors: null|[名前], reading }, refresh({ deny }), whenIdle() }
 *   connectors は、最後に読めた一覧（無ければ null）。読み取りが失敗しても、前の一覧は残す
 */
export function createConnectorReader({ file, probe, now = () => Date.now(), ttl = CONNECTOR_TTL_MS }) {
  let state = { connectors: null, at: 0 }, loading = null, running = null, failed = false;
  // 覚えの読み込みは 1 回だけ。読んでいる最中の呼び出しも、同じ読み込みを待つ（待たないと最初の一覧が空に見える）
  const load = () => loading ??= (async () => {
    const j = await readJson(file);
    if (Array.isArray(j?.connectors)) state = { connectors: j.connectors.filter(n => typeof n === 'string').slice(0, CONNECTOR_CACHE_MAX), at: Number(j.at) || 0 };
  })();
  const save = () => writeAtomic(file, `${JSON.stringify({ connectors: state.connectors, at: state.at })}\n`).catch(() => {});
  return {
    async get() { await load(); return { connectors: state.connectors, reading: running !== null, at: state.at, failed }; },
    // 戻り: 読めたか（直近 ttl の間に読めた一覧があれば、起こさずに true）。読めなかったときは前の一覧のまま（failed が立つ）
    refresh({ deny = [], force = false } = {}) {
      if (running) return running;
      running = (async () => {
        await load();
        if (!force && state.connectors && now() - state.at < ttl) return true;
        try {
          const names = await probe({ deny });
          if (!Array.isArray(names)) { failed = true; return false; }
          state = { connectors: [...new Set(names)].sort().slice(0, CONNECTOR_CACHE_MAX), at: now() };
          failed = false;
          await save();
          return true;
        } catch { failed = true; return false; /* 読めなかった: 前の一覧のまま */ }
      })().finally(() => { running = null; });
      return running;
    },
    whenIdle: async () => { await running; },
  };
}
