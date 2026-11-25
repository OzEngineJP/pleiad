// 登録した Claude アカウントのコネクターの設定（ADR 0340・0352）の置き場と入口の位置。LLM も CLI も呼ばない。
//   オン・オフどちらの起動の記録も claude-connectors-auth の 4. が確かめる（どちらも専用フォルダ。差はオフの ENABLE_CLAUDEAI_MCP_SERVERS=false だけ）。
//   アカウントを指定しない会話の起動の記録は claude-launch-main-pinned が main の記録と比べる。ここでは次を確かめる:
//   1. 設定の口（read・list・setEnabled・remove）・設定ファイルの名前が画面・操作の一覧に出ていない・server の入口が 1 か所
//   2. 起動の付け直しは一覧の行とコネクターの設定だけを読む（認証の解決をしない）
//   3. 残った設定ファイルは、アカウントの一覧・解決に影響しない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeConnectorSettings, CONNECTORS_FILE } from '../../core/claude-connectors.mjs';
import { createClaudeAccounts } from '../../core/claude-accounts.mjs';

export const name = 'claude-connectors-off';
export const title = 'Claude コネクターの設定: 口・置き場が画面に出ない・server の入口が 1 か所・残った設定がアカウントの一覧に効かない';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ACCOUNT_ID = 'acct-0123456789ab';

export default async function (t) {
  // 1. 設定の口・画面・操作の一覧に出ていない / server の入口
  const settings = createClaudeConnectorSettings({ dataDir: os.tmpdir() });
  // 書くのは人だけの操作 accounts.setConnectors とアカウントの削除だけ
  t.ok('設定の口は read・list と、書き込みの setEnabled・remove だけ', JSON.stringify(Object.keys(settings).sort()) === JSON.stringify(['file', 'list', 'read', 'remove', 'setEnabled']));
  const hits = [];
  for (const dir of ['core/ops', 'web', 'mobile', 'bin', 'desktop']) {
    for (const f of await fs.readdir(path.join(REPO, dir), { recursive: true, withFileTypes: true }).catch(() => [])) {
      if (!f.isFile() || !/\.(mjs|js|html|css|json)$/.test(f.name)) continue;
      const p = path.join(f.parentPath ?? f.path, f.name);
      if (/claude-account-connectors|CONNECTORS_FILE|claude-connectors\.mjs/.test(await fs.readFile(p, 'utf8').catch(() => ''))) hits.push(path.relative(REPO, p));
    }
  }
  t.ok('設定の置き場は ops・画面・CLI・モバイル・デスクトップに出ていない', hits.length === 0, hits.join(', '));
  const server = await fs.readFile(path.join(REPO, 'core/server.mjs'), 'utf8');
  const resolveCalls = [...server.matchAll(/claudeAccountConnectors\.resolve\(/g)].length;
  t.ok('server は登録したアカウントの解決を accountResolve の 1 か所だけで呼ぶ',
    resolveCalls === 1 && /return claudeAccountConnectors\.resolve\(id\);/.test(server));

  // 2. 起動の付け直し（restoreTurn）は main とのパイプが立つ前に走る。認証の解決（版・ログインの確かめ）を待たない
  const restoreBody = server.slice(server.indexOf('async function restoreTurn('), server.indexOf('const turn = {', server.indexOf('async function restoreTurn(')));
  t.ok('起動の付け直しは、認証を解決せずに一覧の行（claudeAccounts.get）とコネクターの設定だけで読む',
    restoreBody.length > 0 && !/accountResolve\(|claudeAccounts\.resolve\(|claudeAccountConnectors\.resolve\(|secrets?\.get\(/.test(restoreBody)
      && /claudeAccounts\.get\(fields\.accountId\)/.test(restoreBody) && /claudeAccountConnectors\.settings\.read\(/.test(restoreBody));

  // 3. 残った設定ファイルはアカウントの一覧・解決に影響しない
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-cn-left-')));
  try {
    await fs.writeFile(path.join(dir, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: ACCOUNT_ID, name: 'fake-account', createdAt: '2026-01-01T00:00:00.000Z' }] }));
    await fs.writeFile(path.join(dir, CONNECTORS_FILE), JSON.stringify({ version: 1, accounts: { [ACCOUNT_ID]: { enabled: true } } }));
    const accounts = createClaudeAccounts({ dataDir: dir, cliConfig: path.join(dir, 'no-cli.json') });
    const resolved = await accounts.resolve(ACCOUNT_ID);
    const listed = await accounts.list();
    t.ok('設定ファイルが残っていても、アカウントの解決は一覧の行（id・名前）だけ・一覧にコネクターの項目は出ない',
      JSON.stringify(resolved) === JSON.stringify({ id: ACCOUNT_ID, name: 'fake-account' }) && JSON.stringify(listed).includes(ACCOUNT_ID) && !JSON.stringify(listed).includes('connectors'));
    t.ok('get は一覧の行（id・名前）だけを返す。無い id は null',
      JSON.stringify(await accounts.get(ACCOUNT_ID)) === JSON.stringify({ id: ACCOUNT_ID, name: 'fake-account' }) && await accounts.get('acct-000000000000') === null);
  } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
}
