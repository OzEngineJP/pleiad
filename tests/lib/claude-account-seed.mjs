// テスト用: Claude のアカウントを、claude.ai のログインが済んだ形でデータの置き場に直に置く。
// ADR 0353 から、アカウントは専用フォルダのログインが済んだときだけ登録される（claudeLoginStart { name }）。
// 画面とサーバーを通したログインは server-claude-login・claude-login が確かめるので、ほかのテストはこれで置く。
// claude-accounts.json はサーバーが毎回読み直すので、サーバーが動いている間に置いてもよい（claudeAccountsChanged は出ない）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { newAccountId } from '../../core/claude-accounts.mjs';

/**
 * @param {string} dataDir
 * @param {string} name   表示名
 * @param {{ id?: string, login?: boolean, oauthAccount?: object, access?: string }} [o]
 *   login: false ならログインの印を置かない（ログインがまだのアカウント）。oauthAccount は専用フォルダの .claude.json に書く。
 *   access は偽の資格情報の accessToken（偽の CLI が FAKE_CLAUDE_MODELS_FILE の 'cred:<access>' でアカウントを見分ける）
 * @returns {Promise<string>} アカウントの id
 */
export async function seedClaudeAccount(dataDir, name, { id = newAccountId(), login = true, oauthAccount = null, access = 'fake-access' } = {}) {
  const file = path.join(dataDir, 'claude-accounts.json');
  const data = await fs.readFile(file, 'utf8').then(JSON.parse, () => ({ version: 1, accounts: [] }));
  data.accounts.push({ id, name, createdAt: new Date().toISOString() });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
  const dir = path.join(dataDir, 'claude-usage', id);
  await fs.mkdir(dir, { recursive: true });
  if (login) {
    // Pleiad の印と、CLI の資格情報（中身は偽物。Pleiad は有無だけを見る。macOS 以外）
    await fs.writeFile(path.join(dir, 'ply-usage-login.json'), JSON.stringify({ at: new Date().toISOString() }) + '\n');
    await fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: access, scopes: ['user:profile'] } }));
  }
  if (oauthAccount) await fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount }));
  return id;
}
