// ファイルのページと隔離の 2 つのリスナーを起こし、port をデータの置き場に覚える（ADR 0295 の 1）。旗が on のときだけ core/server.mjs が呼ぶ。
//   - port は page-ports.json に覚え、次の起動でも同じ port を試す（開いているページのタブの URL を変えないため）。取れなければ新しい port にして覚え直す
//   - 環境変数 AGENT_HOST_PAGES_PORT・AGENT_HOST_ISOLATED_PORT が先（試験用。0 で空いた port）。環境変数で決めた port は覚えない
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './atomic-file.mjs';
import { startPagesServer } from './pages-server.mjs';
import { startIsolatedServer } from './isolated-server.mjs';

export const PAGE_PORTS_FILE = 'page-ports.json';
export const PAGES_PORT_ENV = 'AGENT_HOST_PAGES_PORT';
export const ISOLATED_PORT_ENV = 'AGENT_HOST_ISOLATED_PORT';
const KEYS = Object.freeze({ pages: PAGES_PORT_ENV, isolated: ISOLATED_PORT_ENV });

/** 環境変数の port。空・数でない・範囲の外は null（使わない）。0 は空いた port */
export function envPort(value) {
  if (value == null || String(value).trim() === '') return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

const remembered = value => (Number.isInteger(value) && value > 0 && value <= 65535 ? value : null);

/** 覚えた port。無い・壊れていれば null */
export async function readPagePorts(dataDir) {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, PAGE_PORTS_FILE), 'utf8'));
    return { pages: remembered(saved?.pages), isolated: remembered(saved?.isolated) };
  } catch {
    return { pages: null, isolated: null };
  }
}

export async function writePagePorts(dataDir, ports) {
  await writeAtomic(path.join(dataDir, PAGE_PORTS_FILE), `${JSON.stringify({ pages: remembered(ports.pages), isolated: remembered(ports.isolated) })}\n`);
}

/**
 * 2 つのリスナーを起こす。
 * @param {object} options
 * @param {string} options.dataDir    データの置き場（page-ports.json）
 * @param {object} [options.env]      環境変数（AGENT_HOST_PAGES_PORT・AGENT_HOST_ISOLATED_PORT）
 * @param {string} options.token      本体のトークン（ページの Cookie の検査）
 * @param {number} [options.waitMs]   覚えた port が塞がっていたら待つ上限（無停止の更新で前のサーバーが放すのを待つ）
 * @param options.pagesRoutes         core/pages-routes.mjs の createPagesRoutes の返り値
 * @param options.isolatedRoutes      core/isolated-routes.mjs の createIsolatedRoutes の返り値
 * @param [options.tickets]           既定のブラウザーで開くときの入場券（core/page-tickets.mjs）
 * @returns {Promise<{ ports: { pages: number, isolated: number }, close: () => Promise<void> }>}
 */
export async function startBrowserUnifyListeners({ dataDir, env = process.env, token, waitMs = 0, pagesRoutes, isolatedRoutes, tickets = null, hosts, log = () => {} }) {
  const saved = await readPagePorts(dataDir);
  const fromEnv = Object.fromEntries(Object.entries(KEYS).map(([key, name]) => [key, envPort(env?.[name])]));
  const pick = key => fromEnv[key] ?? saved[key] ?? 0;
  const pages = await startPagesServer({ port: pick('pages'), waitMs, token, routes: pagesRoutes, tickets, hosts, log });
  let isolated;
  try {
    isolated = await startIsolatedServer({ port: pick('isolated'), waitMs, routes: isolatedRoutes, hosts, log });
  } catch (error) {
    await pages.close();
    throw error;
  }
  const ports = { pages: pages.port, isolated: isolated.port };
  const next = { pages: fromEnv.pages == null ? ports.pages : saved.pages, isolated: fromEnv.isolated == null ? ports.isolated : saved.isolated };
  if (next.pages !== saved.pages || next.isolated !== saved.isolated) {
    await writePagePorts(dataDir, next).catch(error => log(`page ports: could not remember the ports: ${String(error?.message ?? error)}`));
  }
  return {
    ports,
    close: () => Promise.all([pages.close(), isolated.close()]).then(() => {}),
  };
}
