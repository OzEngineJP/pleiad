// テスト用: Claude のアカウントを、claude.ai のログインが済んだ形でデータの置き場に直に置く。
// ADR 0353 から、アカウントは専用フォルダのログインが済んだときだけ登録される（claudeLoginStart { name }）。
// 画面とサーバーを通したログインは server-claude-login・claude-login が確かめるので、ほかのテストはこれで置く。
// claude-accounts.json はサーバーが毎回読み直すので、サーバーが動いている間に置いてもよい（claudeAccountsChanged は出ない）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { newAccountId } from '../../core/claude-accounts.mjs';
import { VERIFIED_VERSIONS } from '../../core/claude-connectors-auth.mjs';
import { installFakeClaude } from './fake-claude.mjs';

/**
 * 置いたアカウントで会話・委譲を走らせるサーバーの env。登録したアカウントは版の確かめ（CLI 2.1.322 以上）とログインの有無を通るので、
 * 本物の CLI の無い CI でも通るよう、dir に偽の CLI を置いて確かめた版で答えさせる。macOS でもログインを専用フォルダのファイルで見る
 * （AGENT_HOST_FAKE_OWN_DIR_LOGIN。本物のキーチェーンを見ない）
 */
export async function claudeAccountServerEnv(dir) {
  const fake = await installFakeClaude(dir);
  return { ...fake.env, FAKE_CLAUDE_VERSION: VERIFIED_VERSIONS[0].cli, AGENT_HOST_FAKE_OWN_DIR_LOGIN: 'file' };
}

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
    // Pleiad の印と、CLI の資格情報（中身は偽物。Pleiad は有無だけを見る。macOS は claudeAccountServerEnv の env で同じファイルを見る）
    await fs.writeFile(path.join(dir, 'ply-usage-login.json'), JSON.stringify({ at: new Date().toISOString() }) + '\n');
    await fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: access, scopes: ['user:profile'] } }));
  }
  if (oauthAccount) await fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount }));
  return id;
}
