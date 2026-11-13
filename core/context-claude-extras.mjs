// Claude 側にだけある外部 MCP（プラグインの MCP と claude.ai のコネクター）を読む。ADR 0324。
// どちらも Claude の設定ファイル（.claude.json など）には出ず、ここで読まないと一覧に出せない。
//   プラグイン: ~/.claude/plugins/installed_plugins.json と各プラグインの .mcp.json（ディスクだけで読める）
//   コネクター: Claude を起動しないと分からない。画面を開いたときに裏で 1 回だけ起こして読み、直近の一覧を覚えておく
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from './atomic-file.mjs';

const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Claude のプラグインの MCP。有効なプラグインだけ。戻り: [{ plugin, server, key, transport }]（key は deniedMcpServers の名前） */
export async function readClaudePlugins({ claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude') } = {}) {
  const installed = await readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  if (!isObj(installed?.plugins)) return [];
  const enabled = (await readJson(path.join(claudeHome, 'settings.json')))?.enabledPlugins;
  const out = [];
  for (const [id, installs] of Object.entries(installed.plugins)) {
    if (isObj(enabled) && enabled[id] === false) continue;
    const dir = Array.isArray(installs) ? installs.find(i => typeof i?.installPath === 'string')?.installPath : null;
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
export function createConnectorReader({ file, probe, now = () => Date.now() }) {
  let state = { connectors: null, at: 0 }, loading = null, running = null;
  // 覚えの読み込みは 1 回だけ。読んでいる最中の呼び出しも、同じ読み込みを待つ（待たないと最初の一覧が空に見える）
  const load = () => loading ??= (async () => {
    const j = await readJson(file);
    if (Array.isArray(j?.connectors)) state = { connectors: j.connectors.filter(n => typeof n === 'string').slice(0, CONNECTOR_CACHE_MAX), at: Number(j.at) || 0 };
  })();
  const save = () => writeAtomic(file, `${JSON.stringify({ connectors: state.connectors, at: state.at })}\n`).catch(() => {});
  return {
    async get() { await load(); return { connectors: state.connectors, reading: running !== null, at: state.at }; },
    refresh({ deny = [] } = {}) {
      if (running) return running;
      running = (async () => {
        await load();
        try {
          const names = await probe({ deny });
          if (Array.isArray(names)) {
            state = { connectors: [...new Set(names)].sort().slice(0, CONNECTOR_CACHE_MAX), at: now() };
            await save();
          }
        } catch { /* 読めなかった: 前の一覧のまま */ }
      })().finally(() => { running = null; });
      return running;
    },
    whenIdle: async () => { await running; },
  };
}
