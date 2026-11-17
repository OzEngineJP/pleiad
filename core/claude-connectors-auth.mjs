// 登録した Claude アカウントで claude.ai のコネクターを使うときの認証（ADR 0340。段 2: 方式 (b1)）。
//
// 入口（core/claude-connectors.mjs）がオンのアカウントだけがここへ来る。オフ・未設定・別アカウント・ログイン中・互換接続はここを呼ばない。
// (b1) は、会話の CLI の env にだけ次の 3 つを足す（process.env は触らない）。
//   CLAUDE_CONFIG_DIR           共有の設定フォルダ（既定は ~/.claude。履歴・設定・Skills・プラグインを今までと同じ場所で共用する）
//   CLAUDE_CODE_OAUTH_TOKEN     使用量の認可（claude-usage/<id>）のアクセス用トークン（会話用に登録したトークンではない）
//   CLAUDE_CODE_OAUTH_SCOPES    そのログインに記録された権限の並び（空白区切り・順序そのまま。足すとコネクターが通常のログインと一致する）
// 更新用トークンは取り出さない・渡さない・写さない（ファイルを解析するが、使うのは accessToken・expiresAt・scopes の 3 項目だけ）。
// アクセス用トークンの更新は CLI だけが行う（Pleiad は私的な更新の口を呼ばない）。期限が近ければ使用量の読み取りを 1 回流して CLI に更新させ、
// 読み直す。オンのアカウントの設定フォルダは使用量の読み取りを順に流す（claude-usage.mjs の guardUsageDir）ので、同じ設定フォルダを同時に 2 つの CLI が更新しにいかない。
//
// 止める条件（黙って会話用トークンへ戻さない。投げるのは ConnectorsAuthError。server の scopedOrUnavailable がそのアカウントの会話を
// 「引けなかった理由」で断る）: ログインが無い・読めない・期限切れ / 持ち主の不一致・未確認 / 確かめていない CLI・SDK の版 /
// 対応していない OS / 別の認証が環境にある / 履歴の場所を保てない / 設定の反映に失敗。
// トークン・メールアドレス・組織の id はメッセージ・ログに出さない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AccountError, cliConfigFile } from './claude-accounts.mjs';
import { t } from './i18n.mjs';

/** 確かめた CLI と SDK の組（ADR 0340）。これ以外の版ではオンを止める（オフの会話は影響しない） */
export const VERIFIED_VERSIONS = [{ cli: '2.1.322', sdk: '0.3.288' }];
/** キャッシュのキーに足す識別子（core/claude-connectors.mjs の identitySuffix）。b1 の認証元を別のキャッシュにする */
export const IDENTITY = 'b1';
/** 期限までの残りがこれより短ければ、会話の前に CLI に更新させる */
export const EXPIRY_MARGIN_MS = 5 * 60_000;
/** 資格情報の読み取り（CLI が書き換え中に壊れて見えることがある）の回数と間 */
export const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 100;
const CREDENTIALS_FILE = '.credentials.json';
const TOKEN = /^[\x21-\x7e]{20,4096}$/;
const SCOPE = /^[A-Za-z0-9:_.-]{1,64}$/;
/** ファイルでログインを持つ OS。macOS のキーチェーンは項目名が設定フォルダに依存し公開されていないので、確かめた OS だけにする */
const FILE_PLATFORMS = ['win32', 'linux'];
/** 別の認証・接続先が環境にあると、CLI はそちらで動く（トークンの経路が混ざる） */
const MIXED_AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_GATEWAY'];
/** 履歴の置き場を動かす指定が親にあると、共有の履歴を保てない */
const HISTORY_ENV = ['CLAUDE_CODE_PROJECT_DIR_NAME'];

/** 止める条件。code は connectors-<種類>。message はそのまま利用者に出る（秘密を含めない） */
export class ConnectorsAuthError extends AccountError {
  // i18n-dynamic: claude.connectors.
  constructor(kind, params = {}) {
    super(t(`claude.connectors.${kind}`, params), `connectors-${kind}`);
  }
}

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const present = (env, names) => names.filter(name => typeof env[name] === 'string' && env[name] !== '');

/**
 * 使用量の認可のログインから、アクセス用トークン・期限・権限を読む。更新用トークンは返さない。
 * 無い → null。形が違う → { malformed: true }
 */
export async function readAccessCredentials(dir, { readFile = fs.readFile, sleep = sleepFor } = {}) {
  const file = path.join(dir, CREDENTIALS_FILE);
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (attempt === READ_ATTEMPTS - 1) return null;
      await sleep(READ_RETRY_MS * (attempt + 1));
      continue;
    }
    let oauth;
    try { oauth = JSON.parse(text.replace(/^﻿/, ''))?.claudeAiOauth; }
    catch { if (attempt === READ_ATTEMPTS - 1) return { malformed: true }; await sleep(READ_RETRY_MS * (attempt + 1)); continue; }
    const token = oauth?.accessToken, expiresAt = oauth?.expiresAt, scopes = oauth?.scopes;
    if (typeof token !== 'string' || !TOKEN.test(token) || !Number.isFinite(expiresAt)
      || !Array.isArray(scopes) || !scopes.length || !scopes.every(s => typeof s === 'string' && SCOPE.test(s))) return { malformed: true };
    return { token, expiresAt, scopes: [...scopes] };
  }
  return null;
}

// ---------------------------------------------------------------- 設定の反映（共有の ~/.claude.json → <共有の設定フォルダ>/.claude.json）

/** 反映する最上位の項目（秘密の持ち主情報・認証・組織・モデルのキャッシュは含めない） */
const TOP_KEYS = ['mcpServers'];
/** 反映する作業場所ごとの項目 */
const PROJECT_KEYS = ['mcpServers', 'allowedTools', 'hasTrustDialogAccepted', 'hasCompletedProjectOnboarding', 'hasClaudeMdExternalIncludesApproved', 'ignorePatterns'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 反映先に無い項目だけ足す（既存の値は上書きしない。mcpServers は名前ごと）。足したら true */
function fillMissing(target, source, keys) {
  let changed = false;
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) continue;
    if (key === 'mcpServers' && isObject(source[key])) {
      if (Object.hasOwn(target, key) && !isObject(target[key])) continue;
      const servers = isObject(target[key]) ? target[key] : {};
      for (const [name, value] of Object.entries(source[key])) {
        if (!Object.hasOwn(servers, name)) { servers[name] = structuredClone(value); changed = true; }
      }
      if (changed || !Object.hasOwn(target, key)) { target[key] = servers; }
    } else if (!Object.hasOwn(target, key)) { target[key] = structuredClone(source[key]); changed = true; }
  }
  return changed;
}

/** CLI が作業場所の設定を引く Git のルート（無ければ cwd）。.git はフォルダでもファイル（worktree）でもよい */
export async function projectRootOf(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (await fs.stat(path.join(dir, '.git')).then(() => true, () => false)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(cwd);
    dir = up;
  }
}

async function readJson(file) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, '')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/**
 * 共有のプロフィール（source）から許可した項目だけを、共有の設定フォルダのプロフィール（target）へ足す。source は読むだけ。
 * target に既にある値は上書きしない（競合は既存側が勝つ）。変わらなければ書かない。書くときは一時ファイル → 名前の付け替え。
 * 戻り: { changed }
 */
export async function projectProfile({ source, target, cwd }) {
  if (path.resolve(source) === path.resolve(target)) return { changed: false };
  const from = await readJson(source);
  if (!isObject(from)) return { changed: false };
  const existing = await readJson(target);
  const to = isObject(existing) ? existing : {};
  let changed = fillMissing(to, from, TOP_KEYS);
  if (isObject(from.projects) && cwd) {
    const root = await projectRootOf(cwd);
    for (const key of new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')])) {
      if (!Object.hasOwn(from.projects, key) || !isObject(from.projects[key])) continue;
      if (!isObject(to.projects)) to.projects = {};
      if (!isObject(to.projects[key])) to.projects[key] = {};
      const before = JSON.stringify(to.projects[key]);
      fillMissing(to.projects[key], from.projects[key], PROJECT_KEYS);
      if (JSON.stringify(to.projects[key]) !== before) changed = true;
    }
  }
  if (!changed) return { changed: false };
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(to, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, target);
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  return { changed: true };
}

// ---------------------------------------------------------------- 認証の解決

/**
 * @param {object} o
 * @param {{ usageDir: (id: string) => string, ownerStatus: (id: string) => Promise<'ok'|'mismatch'|'unknown'> }} o.accounts  core/claude-accounts.mjs
 * @param {() => Promise<{ cli: string|null, sdk: string|null }>} o.versions  使っている CLI と SDK の版
 * @param {(dir: string) => Promise<unknown>} o.refresh  CLI にその設定フォルダのログインを更新させる（使用量の読み取り）
 * @param {(dir: string) => void} o.guard  その設定フォルダの使用量の読み取りを順に流す印を付ける（claude-usage.mjs の guardUsageDir）。refresh と使用量の読み取りが重ならないために、refresh の前に付ける
 * @returns {(account: { id: string, name: string }) => Promise<{ account: object }>}  入口の resolveAuth
 */
export function createClaudeConnectorsAuth({ accounts, versions, refresh, guard = () => {}, env = process.env, home = os.homedir(), platform = process.platform,
  now = Date.now, readFile = fs.readFile, sleep = sleepFor, project = projectProfile, verified = VERIFIED_VERSIONS } = {}) {
  const sharedDir = () => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');

  async function checks(account) {
    const name = account.name ?? account.id;
    if (!FILE_PLATFORMS.includes(platform)) throw new ConnectorsAuthError('platform', { name, platform });
    const mixed = present(env, MIXED_AUTH_ENV);
    if (mixed.length) throw new ConnectorsAuthError('env', { name, names: mixed.join(', ') });
    const moved = present(env, HISTORY_ENV);
    if (moved.length) throw new ConnectorsAuthError('history', { name, names: moved.join(', ') });
    const found = await Promise.resolve().then(versions).catch(() => ({}));
    if (!verified.some(v => v.cli === found?.cli && v.sdk === found?.sdk)) {
      throw new ConnectorsAuthError('version', { name, cli: found?.cli ?? '?', sdk: found?.sdk ?? '?', verified: verified.map(v => `CLI ${v.cli} / SDK ${v.sdk}`).join(', ') });
    }
    if ((await accounts.ownerStatus(account.id)) !== 'ok') throw new ConnectorsAuthError('owner', { name });
  }

  async function credentials(account, dir) {
    const cred = await readAccessCredentials(dir, { readFile, sleep });
    if (!cred) throw new ConnectorsAuthError('login', { name: account.name ?? account.id });
    if (cred.malformed) throw new ConnectorsAuthError('format', { name: account.name ?? account.id });
    return cred;
  }

  return async function resolveAuth(account) {
    await checks(account);
    const dir = accounts.usageDir(account.id);
    guard(dir);
    const first = await credentials(account, dir);
    const shared = sharedDir();
    return {
      account: {
        ...account,
        // gate の時点の値。会話の起動・一覧の取得は connectors.fresh() で期限を確かめ直した値を使う（会話用に登録したトークンへは戻さない）
        token: first.token,
        connectors: {
          identity: IDENTITY,
          /** 会話の起動の直前に呼ぶ。期限が近ければ CLI に更新させ、設定を反映して、{ token, env } を返す。失敗は投げる（旧いトークンへ戻さない） */
          async fresh({ cwd } = {}) {
            let cred = await credentials(account, dir);
            if (cred.expiresAt - now() < EXPIRY_MARGIN_MS) {
              await Promise.resolve().then(() => refresh(dir)).catch(() => {});   // 失敗は読み直した期限で判断する
              cred = await credentials(account, dir);
              if (cred.expiresAt - now() < EXPIRY_MARGIN_MS) throw new ConnectorsAuthError('expired', { name: account.name ?? account.id });
            }
            try { await project({ source: cliConfigFile(env, home), target: path.join(shared, '.claude.json'), cwd }); }
            catch { throw new ConnectorsAuthError('profile', { name: account.name ?? account.id }); }
            return { token: cred.token, env: { CLAUDE_CONFIG_DIR: shared, CLAUDE_CODE_OAUTH_SCOPES: cred.scopes.join(' ') } };
          },
        },
      },
    };
  };
}
