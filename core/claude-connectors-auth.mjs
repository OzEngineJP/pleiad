// 登録した Claude アカウントで claude.ai のコネクターを使うときの認証（ADR 0340。段 2: 方式 (b1)）。
//
// 入口（core/claude-connectors.mjs）がオンのアカウントだけがここへ来る。オフ・未設定・別アカウント・ログイン中・互換接続はここを呼ばない。
// (b1) は、会話の CLI の env にだけ次の 3 つを足す（process.env は触らない）。
//   CLAUDE_CONFIG_DIR           共有の設定フォルダ（既定は ~/.claude。履歴・設定・Skills・プラグインを今までと同じ場所で共用する）
//   CLAUDE_CODE_OAUTH_TOKEN     使用量の認可（claude-usage/<id>）のアクセス用トークン（会話用に登録したトークンではない）
//   CLAUDE_CODE_OAUTH_SCOPES    そのログインに記録された権限の並び（空白区切り・順序そのまま。足すとコネクターが通常のログインと一致する）
// 更新用トークンは取り出さない・渡さない・写さない（更新用トークンは期限だけを読む）。
// アクセス用トークンの更新は CLI だけが行う（Pleiad は私的な更新の口を呼ばない）。期限が近ければ使用量の読み取りを 1 回流して CLI に更新させ、
// 読み直す。オンのアカウントの設定フォルダは使用量の読み取りを順に流す（claude-usage.mjs の guardUsageDir・refreshUsageDir）ので、
// 同じ設定フォルダを同時に 2 つの CLI が更新しにいかない（印を付ける前から走っていた読み取りも待つ）。
// 会話・内部呼出し（core/backends/claude.mjs の withConnectorsAuth）と、設定 › 外部 MCP のコネクターの一覧（connectorListProbe）は、
// どちらも connectors.fresh() の組み立て（期限の確かめ直し・設定の反映・3 つの env）を通る。
//
// 止める条件（黙って会話用トークンへ戻さない。投げるのは ConnectorsAuthError。server の scopedOrUnavailable がそのアカウントの会話を
// 「引けなかった理由」で断る）: ログインが無い・読めない・期限切れ / 持ち主の不一致・未確認 / 確かめていない CLI・SDK の版 /
// 対応していない OS / 別の認証が環境・共有の settings.json にある / 履歴の場所を保てない / 設定の反映に失敗。
// トークン・メールアドレス・組織の id はメッセージ・ログに出さない。
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { run as runProcess } from './process.mjs';
import { AccountError, cliConfigFile } from './claude-accounts.mjs';
import { createClaudeConnectorsGate, createClaudeConnectorSettings, hashConnectorIdentity } from './claude-connectors.mjs';
import { claudeManagedFiles } from './hooks-config.mjs';
import { t } from './i18n.mjs';
import { claudeUsageAuthFailure } from './backends/claude-usage.mjs';

/** CLI の下限と完全一致を要求する SDK の組（ADR 0340）。 */
export const VERIFIED_VERSIONS = [{ cli: '2.1.322', sdk: '0.3.288' }];
/** CLI は下限以上、Pleiad が固定する SDK は完全一致。未知・先行版の文字列は許可しない。 */
export function supportedConnectorVersions(found, verified = VERIFIED_VERSIONS) {
  const parse = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    ? value.split('.').map(Number) : null;
  const cli = parse(found?.cli);
  if (!cli || !cli.every(Number.isSafeInteger)) return false;
  return verified.some(v => {
    const minimum = parse(v.cli);
    if (!minimum || found?.sdk !== v.sdk) return false;
    for (let i = 0; i < 3; i++) {
      if (cli[i] !== minimum[i]) return cli[i] > minimum[i];
    }
    return true;
  });
}
/** キャッシュのキーに足す識別子（core/claude-connectors.mjs の identitySuffix）。b1 の認証元を別のキャッシュにする */
export const IDENTITY = 'b1';
// CLI がアクセス用トークンを更新する窓。動作確認では残り 4 分 59 秒で更新された（ADR 0340）。
export const REFRESH_WINDOW_MS = 5 * 60_000;
/** 資格情報の読み取り（CLI が書き換え中に壊れて見えることがある）の回数と間 */
export const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 100;
const CREDENTIALS_FILE = '.credentials.json';
const SETTINGS_FILE = 'settings.json';
const TOKEN = /^[\x21-\x7e]{20,4096}$/;
const SCOPE = /^[A-Za-z0-9:_.-]{1,64}$/;
/** ファイルでログインを持つ OS。macOS のキーチェーンは項目名が設定フォルダに依存し公開されていないので、確かめた OS だけにする */
const FILE_PLATFORMS = ['win32', 'linux'];
/**
 * 401 のとき、CLI が渡したトークンを捨てて、共有の .credentials.json・ホストが持つトークン・別の出どころのトークンへ
 * 乗り換える道を開く指定（CLI 2.1.322 のコードで確かめた。足さなかった候補と理由は ADR 0340）
 */
const SWITCH_ON_401_ENV = ['ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_BG_AUTH_SNAPSHOT_PATH'];
/** 別の認証・接続先が環境にあると、CLI はそちらで動く（トークンの経路が混ざる） */
const MIXED_AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_GATEWAY',
  ...SWITCH_ON_401_ENV];
/** 履歴の置き場を動かす指定が親にあると、共有の履歴を保てない */
const HISTORY_ENV = ['CLAUDE_CODE_PROJECT_DIR_NAME'];
/** 共有の settings.json の env で、上の 2 つに加えて止める名前（Pleiad が渡す 3 つを settings が上書きすると、渡した認証・置き場が効かない） */
const SETTINGS_ENV = [...MIXED_AUTH_ENV, 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CONFIG_DIR'];

/** 止める条件。code は connectors-<種類>。message はそのまま利用者に出る（秘密を含めない）。message だけ別の文にするときは messageKey */
export class ConnectorsAuthError extends AccountError {
  // i18n-dynamic: claude.connectors.
  constructor(kind, params = {}, messageKey = kind, { scope = null } = {}) {
    super(t(`claude.connectors.${messageKey}`, params), `connectors-${kind}`);
    this.connectorsKind = kind;
    this.connectorsScope = scope;
    // 画面の失敗の行に出す細目（版・OS・指定の名前）。秘密は入らない（名前は環境変数・設定の鍵の名前）
    this.connectorsParams = Object.fromEntries(['cli', 'sdk', 'verified', 'platform', 'names']
      .filter(k => typeof params[k] === 'string' && params[k]).map(k => [k, params[k]]));
  }
}

function attachConnectorsError(error, account, fallbackKind = 'login') {
  if (!(error instanceof ConnectorsAuthError)) return error;
  if (!error.connectorsError) {
    const kind = error.connectorsKind ?? fallbackKind;
    error.connectorsError = {
      kind,
      scope: error.connectorsScope ?? null,
      code: error.code,
      accountId: account?.id ?? null,
      accountName: account?.name ?? account?.id ?? '',
      reauth: ['expired', 'login', 'format'].includes(kind),
      needsOwnerCheck: kind === 'owner',
      params: error.connectorsParams ?? {},
    };
  }
  return error;
}

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const present = (env, names) => names.filter(name => typeof env[name] === 'string' && env[name] !== '');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stripBom = text => String(text).replace(/^﻿/, '');

/** macOS の準備経路。実機合格までは platform の停止を解除しない。 */
export async function readMacAccessCredentials(dir, {
  configDir = dir, run = runProcess, readFile = fs.readFile, sleep = sleepFor,
} = {}) {
  // 使用量の CLI は設定フォルダーを明示する。無指定の通常 CLI とは項目名が異なる。
  const suffix = configDir === null ? '' : `-${crypto.createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`;
  let text;
  try {
    const result = await run('/usr/bin/security', ['find-generic-password', '-a', 'claude-code-user', '-w', '-s', `Claude Code-credentials${suffix}`],
      { timeoutMs: 10_000, maxOutputChars: 1024 * 1024, windowsHide: true });
    if (result.exitCode !== 0 || result.timedOut || result.stopped || result.truncated) {
      throw { code: result.startCode ?? result.exitCode, killed: result.timedOut || result.stopped || result.truncated };
    }
    text = result.stdout;
  } catch (error) {
    // 項目なし・鍵束なし・実行ファイルなしだけファイル保存を確認する。
    // ロック・拒否・確認待ちのタイムアウトでは古いファイルへ乗り換えない。
    if ([44, 37, 50, 'ENOENT'].includes(error?.code) && !error?.killed) {
      return readAccessCredentials(dir, { readFile, sleep });
    }
    return null;
  }
  // 既存の検査を共用し、アクセス用トークン・期限・権限だけを返す。
  return readAccessCredentials(dir, { readFile: async () => text, sleep: async () => {} });
}

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
    try { oauth = JSON.parse(stripBom(text))?.claudeAiOauth; }
    catch { if (attempt === READ_ATTEMPTS - 1) return { malformed: true }; await sleep(READ_RETRY_MS * (attempt + 1)); continue; }
    const token = oauth?.accessToken, expiresAt = oauth?.expiresAt, scopes = oauth?.scopes;
    if (typeof token !== 'string' || !TOKEN.test(token) || !Number.isFinite(expiresAt)
      || !Array.isArray(scopes) || !scopes.length || !scopes.every(s => typeof s === 'string' && SCOPE.test(s))) return { malformed: true };
    const refreshTokenExpiresAt = oauth?.refreshTokenExpiresAt;
    return { token, expiresAt, scopes: [...scopes], ...(Number.isFinite(refreshTokenExpiresAt) ? { refreshTokenExpiresAt } : {}) };
  }
  return null;
}

/**
 * 指定の settings.json 1 ファイルのうち、認証・置き場を変える指定の名前。env と apiKeyHelper を見る。値は返さない。
 * 無い・空 → { auth: [], history: [] }。読めない・壊れている・形が違う → null（入口は止める。CLI がどう読むか分からないため）
 */
export async function settingsOverridesFile(file, { readFile = fs.readFile } = {}) {
  let text;
  try { text = stripBom(await readFile(file, 'utf8')); }
  catch (error) { return error?.code === 'ENOENT' ? { auth: [], history: [] } : null; }
  if (!text.trim()) return { auth: [], history: [] };
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!isObject(data)) return null;
  const env = data.env ?? {};
  if (!isObject(env)) return null;
  const set = value => value !== undefined && value !== null && value !== '';
  const names = Object.keys(env).filter(name => set(env[name])).map(name => name.toUpperCase());
  const auth = [...new Set(names.filter(name => SETTINGS_ENV.includes(name)))];
  if (set(data.apiKeyHelper)) auth.push('apiKeyHelper');
  return { auth, history: [...new Set(names.filter(name => HISTORY_ENV.includes(name)))] };
}

/** 互換用: 設定フォルダ直下の settings.json を見る */
export function settingsOverrides(dir, options = {}) {
  return settingsOverridesFile(path.join(dir, SETTINGS_FILE), options);
}

/** 管理者・共有（user）・作業場所（workspace）・ローカル（local）の settings.json を重複なく並べる */
export function settingsFiles({ sharedDir, cwd = null, platform = process.platform, managedFiles = null } = {}) {
  const raw = [];
  const managed = Array.isArray(managedFiles) ? managedFiles : claudeManagedFiles(platform);
  for (const file of managed) if (file) raw.push({ scope: 'managed', file });
  if (sharedDir) raw.push({ scope: 'shared', file: path.join(sharedDir, SETTINGS_FILE) });
  const wd = typeof cwd === 'string' && cwd ? path.resolve(cwd) : '';
  if (wd && (!sharedDir || path.resolve(wd, '.claude') !== path.resolve(sharedDir))) {
    raw.push({ scope: 'workspace', file: path.join(wd, '.claude', SETTINGS_FILE) });
    raw.push({ scope: 'local', file: path.join(wd, '.claude', 'settings.local.json') });
  }
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const resolved = path.resolve(entry.file);
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- 作業場所のキー（CLI 2.1.322 と同じ作り方。ADR 0340）
//
// CLI は作業場所ごとの設定を .claude.json の projects[<キー>] に置く。キーは
//   1. 起動の作業場所を realpath（JS の実装。大文字小文字は直さず、/ は \ にする）したもの
//   2. そこから上へ .git（フォルダ・ファイル）のある最初の場所。無ければ 1 の場所
//   3. そこが worktree（.git がファイル）で、指す先が本体の .git/worktrees/<名前> と確かめられれば、本体の作業ツリーの場所
//      （確かめの途中で一つでも合わなければ worktree の場所のまま）
//   4. Windows は \ を / にする（ドライブ文字の大文字小文字は直さない）
// 確かめの一部（シンボリックリンクをたどる安全性の検査）は写していない。その場合は CLI が worktree の場所を使い、こちらは本体の場所へ書く
// （反映が効かないだけで、別の場所の設定を壊しはしない）

const realpathJs = promisify(fsSync.realpath);   // コールバック版は JS の実装（fs.promises.realpath は OS の実装で大文字小文字を直す）

/** 設定の反映が使うファイル操作（試験が差し替える） */
export const PROFILE_IO = {
  readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename, rm: fs.rm, mkdir: fs.mkdir, rmdir: fs.rmdir,
  stat: fs.stat, lstat: fs.lstat, realpath: realpathJs,
};

const DRIVE = /^[A-Za-z]:/;
/** CLI が安全でないとして worktree の解決をやめる参照（NUL・UNC やデバイス・別のドライブ）。CLI の判定の控えめな近似 */
function unsafeRef(ref, base, platform) {
  if (typeof ref !== 'string' || !ref || ref.includes('\0')) return true;
  if (/^[\\/]{2}/.test(ref)) return true;
  return platform === 'win32' && DRIVE.test(ref) && DRIVE.test(base) && ref[0].toLowerCase() !== base[0].toLowerCase();
}

/** ファイルかフォルダがあるか（シンボリックリンクは指す先で見る）。読めなければ無い */
async function isEntry(file, io) {
  try {
    const st = await io.lstat(file);
    const real = st.isSymbolicLink() ? await io.stat(file) : st;
    return real.isDirectory() || real.isFile();
  } catch { return false; }
}

/** 普通のファイルか（シンボリックリンク・特殊なファイル・フォルダ・無いは false） */
async function plainFile(file, io) {
  try { return (await io.lstat(file)).isFile(); } catch { return false; }
}

async function gitRootOf(start, P, io) {
  let dir = P.resolve(start);
  const top = dir.substring(0, dir.indexOf(P.sep) + 1) || P.sep;
  while (dir !== top) {
    if (await isEntry(P.join(dir, '.git'), io)) return dir;
    const up = P.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return (await isEntry(P.join(top, '.git'), io)) ? top : null;
}

/** worktree なら本体の作業ツリーの場所、そうでなければ root のまま */
async function canonicalRoot(root, P, io, platform) {
  let head;
  try { head = String(await io.readFile(P.join(root, '.git'), 'utf8')).trim(); } catch { return root; }
  try {
    if (!head.startsWith('gitdir:')) return root;
    const ref = head.slice('gitdir:'.length).trim();
    if (unsafeRef(ref, root, platform)) return root;
    const gitDir = P.resolve(root, ref);
    const commonFile = P.join(gitDir, 'commondir');
    if (!(await plainFile(commonFile, io))) return root;
    const common = String(await io.readFile(commonFile, 'utf8')).trim();
    if (unsafeRef(common, gitDir, platform)) return root;
    const commonDir = P.resolve(gitDir, common);
    if (P.resolve(P.dirname(gitDir)) !== P.join(commonDir, 'worktrees')) return root;
    const backFile = P.join(gitDir, 'gitdir');
    if (!(await plainFile(backFile, io))) return root;
    const back = String(await io.readFile(backFile, 'utf8')).trim();
    if (unsafeRef(back, root, platform)) return root;
    if (P.sep === '/' && [root, gitDir, back, commonDir].some(s => s.includes('\\'))) return root;
    if ((await io.realpath(P.resolve(gitDir, back))) !== P.join(await io.realpath(root), '.git')) return root;
    if (P.basename(commonDir) !== '.git') return (await isEntry(P.join(commonDir, '.git'), io)) ? root : commonDir;
    return P.dirname(commonDir);
  } catch { return root; }
}

/** 作業場所 cwd の設定を CLI が置く projects のキー */
export async function projectKeyOf(cwd, { platform = process.platform, io = PROFILE_IO } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  let original;
  try { original = await io.realpath(cwd); } catch { original = cwd; }
  const root = await gitRootOf(original, P, io);
  const key = root ? await canonicalRoot(root, P, io, platform) : P.resolve(original);
  return platform === 'win32' ? key.replaceAll('\\', '/') : key;
}

// ---------------------------------------------------------------- 設定の反映（共有の ~/.claude.json → <共有の設定フォルダ>/.claude.json）

/** 反映する作業場所ごとの項目（最上位は mcpServers だけ。持ち主の情報・認証・組織・モデルのキャッシュは含めない） */
const PROJECT_KEYS = ['mcpServers', 'allowedTools', 'hasTrustDialogAccepted', 'hasCompletedProjectOnboarding', 'hasClaudeMdExternalIncludesApproved', 'ignorePatterns'];
const PROFILE_ATTEMPTS = 3;
const RENAME_ATTEMPTS = 6;
const RENAME_RETRY = ['EPERM', 'EBUSY', 'EACCES'];
/** CLI の設定の保存と同じ印（<ファイル>.lock のフォルダ。CLI は proper-lockfile で 10 秒より古い印を捨てる） */
const LOCK_WAIT_MS = 5_000, LOCK_STALE_MS = 10_000, LOCK_STEP_MS = 50;

/** 反映先に足りない項目の [パス, 値] の並び。既存の値は上書きしない。足す先がオブジェクトでなければ（壊れた形）その枝は足さない */
function missingEntries(to, from, key) {
  const out = [];
  const servers = (target, source, base) => {
    if (!isObject(source)) return;
    if (Object.hasOwn(target, 'mcpServers') && !isObject(target.mcpServers)) return;
    for (const [name, value] of Object.entries(source)) {
      if (!(isObject(target.mcpServers) && Object.hasOwn(target.mcpServers, name))) out.push([[...base, 'mcpServers', name], value]);
    }
  };
  if (Object.hasOwn(from, 'mcpServers')) servers(to, from.mcpServers, []);
  const project = key && isObject(from.projects) && Object.hasOwn(from.projects, key) && isObject(from.projects[key]) ? from.projects[key] : null;
  if (!project || (Object.hasOwn(to, 'projects') && !isObject(to.projects))) return out;
  const current = isObject(to.projects) && Object.hasOwn(to.projects, key) ? to.projects[key] : undefined;
  if (current !== undefined && !isObject(current)) return out;
  const target = current ?? {};
  for (const name of PROJECT_KEYS) {
    if (!Object.hasOwn(project, name)) continue;
    if (name === 'mcpServers') servers(target, project[name], ['projects', key]);
    else if (!Object.hasOwn(target, name)) out.push([['projects', key, name], project[name]]);
  }
  return out;
}

// JSON から読んだ名前（__proto__ など）でも自分の項目として置く
const define = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
function setPath(object, keys, value) {
  let o = object;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(o, key)) define(o, key, {});
    o = o[key];
  }
  define(o, keys.at(-1), structuredClone(value));
}
function hasPath(object, keys) {
  let o = object;
  for (const key of keys) {
    if (!isObject(o) || !Object.hasOwn(o, key)) return false;
    o = o[key];
  }
  return true;
}

const signature = st => `${st.mtimeMs}:${st.size}:${st.ino}`;
async function statSig(file, io) {
  try { return signature(await io.stat(file)); }
  catch (error) { if (error?.code === 'ENOENT') return 'none'; throw error; }
}

/**
 * JSON のオブジェクトを読む。{ data, sig }（sig は読む前の状態。後で比べて、間に書かれたかを見る）。
 * 無い → missing。途中の書き込みで壊れて見えるときは少し待って読み直す。壊れたまま・オブジェクトでない → 投げる（上書きしない）
 */
async function readObject(file, io, sleep, { missing, other }) {
  for (let attempt = 0; ; attempt++) {
    const sig = await statSig(file, io);
    if (sig === 'none') return { data: missing, sig };
    let text;
    try { text = await io.readFile(file, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT' && attempt < READ_ATTEMPTS) continue; throw error; }
    let data;
    try { data = JSON.parse(stripBom(text)); }
    catch (error) {
      if (attempt >= READ_ATTEMPTS - 1) throw error;
      await sleep(READ_RETRY_MS * (attempt + 1));
      continue;
    }
    if (!isObject(data)) { if (other) return { data: null, sig }; throw new Error('not an object'); }
    return { data, sig };
  }
}

async function acquireLock(file, io, sleep, now) {
  const lock = `${file}.lock`;
  const until = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await io.mkdir(lock);
      return { lock, ino: (await io.stat(lock)).ino };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const st = await io.stat(lock).catch(() => null);
      if (st && now() - st.mtimeMs > LOCK_STALE_MS && await io.rmdir(lock).then(() => true, () => false)) continue;
      if (now() >= until) throw new Error('profile lock busy');
      await sleep(LOCK_STEP_MS);
    }
  }
}
async function releaseLock(held, io) {
  const st = await io.stat(held.lock).catch(() => null);
  if (st && st.ino === held.ino) await io.rmdir(held.lock).catch(() => {});
}

async function renameWithRetry(from, to, io, sleep) {
  for (let attempt = 0; ; attempt++) {
    try { return await io.rename(from, to); }
    catch (error) {
      if (!RENAME_RETRY.includes(error?.code) || attempt >= RENAME_ATTEMPTS - 1) throw error;
      await sleep(20 * 2 ** attempt);
    }
  }
}

// 反映先ごとに順に流す（同じプロセスの中の 2 つの起動が重ならない）。最後に確かめた状態（両方のファイルの mtime・大きさ・ino とキー）が
// 同じなら、次の起動はファイルを読まない
const profileQueues = new Map();
const profileMemo = new Map();
const sourceCache = new Map();

/**
 * 共有のプロフィール（source）から許可した項目だけを、共有の設定フォルダのプロフィール（target）へ足す。source は読むだけ。
 *   - target に既にある値は上書きしない（競合は既存側が勝つ）。足す物が無ければ書かない
 *   - target が壊れている・オブジェクトでない → 投げる（{} で上書きしない。入口は profile で止める）
 *   - 書くときは CLI と同じ印（<target>.lock）を取り、印の中で読み直して足りない分だけ足す。一時ファイル → 名前の付け替え
 *     （Windows で一時的に断られたら少し待って繰り返す）。付け替えの直前に target が変わっていたらやり直す。書いた後に読み直して確かめる
 * 戻り: { changed }
 */
export async function projectProfile(options) {
  // rename はリンク自体を置き換えるため、既存リンクの実体に対して排他・反映する。
  // 壊れたリンクは realpath の失敗で止め、リンクを新しいファイルに替えない。
  const io = options.io ?? PROFILE_IO;
  const st = await io.lstat(options.target).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (st?.isSymbolicLink()) options = { ...options, target: await io.realpath(options.target) };
  const key = path.resolve(options.target);
  const run = (profileQueues.get(key) ?? Promise.resolve()).then(() => projectProfileNow(options));
  const tail = run.then(() => {}, () => {});
  profileQueues.set(key, tail);
  tail.then(() => { if (profileQueues.get(key) === tail) profileQueues.delete(key); });
  return run;
}

async function projectProfileNow({ source, target, cwd, platform = process.platform, io = PROFILE_IO, sleep = sleepFor, now = Date.now, memo = profileMemo, sources = sourceCache }) {
  if (path.resolve(source) === path.resolve(target)) return { changed: false };
  const key = cwd ? await projectKeyOf(cwd, { platform, io }) : null;
  const sourceSig = await statSig(source, io);
  if (sourceSig === 'none') return { changed: false };
  const last = memo.get(target);
  if (last && last.sourceSig === sourceSig && last.key === key && last.targetSig === await statSig(target, io)) return { changed: false };
  let from = sources.get(source);
  if (from?.sig !== sourceSig) {
    const read = await readObject(source, io, sleep, { missing: null, other: true });
    from = { sig: read.sig, data: read.data };
    sources.set(source, from);
  }
  if (!isObject(from.data)) return { changed: false };
  const remember = targetSig => memo.set(target, { sourceSig: from.sig, targetSig, key });
  for (let attempt = 0; attempt < PROFILE_ATTEMPTS; attempt++) {
    const peek = await readObject(target, io, sleep, { missing: {} });
    if (!missingEntries(peek.data, from.data, key).length) { remember(peek.sig); return { changed: false }; }
    await io.mkdir(path.dirname(target), { recursive: true });
    const held = await acquireLock(target, io, sleep, now);
    let wanted, renamed = false;
    try {
      const current = await readObject(target, io, sleep, { missing: {} });
      wanted = missingEntries(current.data, from.data, key);
      if (!wanted.length) { remember(current.sig); return { changed: false }; }
      for (const [keys, value] of wanted) setPath(current.data, keys, value);
      const tmp = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await io.writeFile(tmp, JSON.stringify(current.data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        if ((await statSig(target, io)) !== current.sig) continue;   // 印を取らない書き手が間に書いた。読み直してやり直す
        await renameWithRetry(tmp, target, io, sleep);
        renamed = true;
      } finally { if (!renamed) await io.rm(tmp, { force: true }).catch(() => {}); }
    } finally { await releaseLock(held, io); }
    const after = await readObject(target, io, sleep, { missing: {} }).catch(() => null);
    if (after && wanted.every(([keys]) => hasPath(after.data, keys))) { remember(after.sig); return { changed: true }; }
  }
  throw new Error('profile not applied');
}

// ---------------------------------------------------------------- 認証の解決

/**
 * @param {object} o
 * @param {{ usageDir: (id: string) => string, ownerStatus: (id: string) => Promise<'ok'|'mismatch'|'unknown'> }} o.accounts  core/claude-accounts.mjs
 * @param {() => Promise<{ cli: string|null, sdk: string|null }>} o.versions  使っている CLI と SDK の版
 * @param {(dir: string) => Promise<unknown>} o.refresh  CLI にその設定フォルダのログインを更新させる（使用量の読み取り。claude-usage.mjs の refreshUsageDir）
 * @param {(dir: string, account: object) => void} o.guard  その設定フォルダの使用量の読み取りを順に流す印を付ける（claude-usage.mjs の guardUsageDir）。refresh と使用量の読み取りが重ならないために、refresh の前に付ける
 * @returns {(account: { id: string, name: string }) => Promise<{ account: object }>}  入口の resolveAuth
 */
export function createClaudeConnectorsAuth({ accounts, versions, refresh, guard = () => {}, env = process.env, home = os.homedir(), platform = process.platform,
  now = Date.now, readFile = fs.readFile, sleep = sleepFor, project = projectProfile, verified = VERIFIED_VERSIONS, managedFiles = null,
  onLoginExpired = async () => {}, verify = null } = {}) {
  const sharedDir = () => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');

  async function settingsCheck(name, cwd = null) {
    for (const entry of settingsFiles({ sharedDir: sharedDir(), cwd, platform, managedFiles })) {
      const found = await settingsOverridesFile(entry.file, { readFile });
      if (!found) throw new ConnectorsAuthError('env', { name }, 'envSettings', { scope: 'settings' });
      if (found.auth.length) throw new ConnectorsAuthError('env', { name, names: found.auth.join(', ') }, 'env', { scope: 'settings' });
      if (found.history.length) throw new ConnectorsAuthError('history', { name, names: found.history.join(', ') }, 'history', { scope: 'settings' });
    }
  }

  async function checks(account, { cwd = null } = {}) {
    const name = account.name ?? account.id;
    if (!FILE_PLATFORMS.includes(platform)) throw new ConnectorsAuthError('platform', { name, platform });
    const mixed = present(env, MIXED_AUTH_ENV);
    if (mixed.length) throw new ConnectorsAuthError('env', { name, names: mixed.join(', ') }, 'env', { scope: 'env' });
    const moved = present(env, HISTORY_ENV);
    if (moved.length) throw new ConnectorsAuthError('history', { name, names: moved.join(', ') }, 'history', { scope: 'env' });
    await settingsCheck(name, cwd);
    const found = await Promise.resolve().then(versions).catch(() => ({}));
    if (!supportedConnectorVersions(found, verified)) {
      throw new ConnectorsAuthError('version', { name, cli: found?.cli ?? '?', sdk: found?.sdk ?? '?', verified: verified.map(v => `CLI ${v.cli} / SDK ${v.sdk}`).join(', ') });
    }
    // 読めない（例外）も確かめられない扱いで止める（一覧の読み取りがログイン中のアカウントへ落ちないように）
    const owner = await Promise.resolve().then(() => accounts.ownerStatus(account.id)).catch(() => 'unknown');
    if (owner !== 'ok') throw new ConnectorsAuthError('owner', { name });
    return found;
  }

  async function credentials(account, dir, { skipSleep = false } = {}) {
    const read = platform === 'darwin' ? readMacAccessCredentials : readAccessCredentials;
    const cred = await read(dir, { readFile, sleep: skipSleep ? async () => {} : sleep });
    if (!cred) throw new ConnectorsAuthError('login', { name: account.name ?? account.id });
    if (cred.malformed) throw new ConnectorsAuthError('format', { name: account.name ?? account.id });
    return cred;
  }

  const refreshExpired = cred => cred.refreshTokenExpiresAt <= now();

  async function usageAccountDigest(dir) {
    try {
      const parsed = JSON.parse(stripBom(await readFile(path.join(dir, '.claude.json'), 'utf8')));
      const oa = parsed?.oauthAccount;
      return oa ? hashConnectorIdentity([oa.organizationUuid ?? null, oa.emailAddress ?? null]) : null;
    } catch { return null; }
  }

  /**
   * 入口がオンのときの解決。止める条件は ConnectorsAuthError で投げる。想定外の例外（使用量の設定フォルダを引けないなど）も
   * login に揃えて投げる（呼び手の一覧の読み取りは ConnectorsAuthError 以外をオフと同じ「ログイン中のアカウントで読む」に回すため。
   * 元の文面は出さない）
   */
  async function resolveAuth(account) {
    try { return await resolveOn(account); }
    catch (error) {
      if (error instanceof ConnectorsAuthError) throw attachConnectorsError(error, account);
      throw attachConnectorsError(new ConnectorsAuthError('login', { name: account?.name ?? account?.id }), account);
    }
  }

  /** 画面・一覧用の受動検査（CLI を起こさず、書き込みもしない。止める理由・安全な識別ハッシュだけを返す） */
  resolveAuth.inspect = async function inspectAuth(account, { cwd = null } = {}) {
    try {
      const ver = await checks(account, { cwd });
      const dir = accounts.usageDir(account.id);
      const cred = await credentials(account, dir, { skipSleep: true });
      if (refreshExpired(cred)) throw new ConnectorsAuthError('expired', { name: account.name ?? account.id });
      const identityHash = hashConnectorIdentity({
        id: account.id,
        identity: IDENTITY,
        cli: ver?.cli ?? null,
        sdk: ver?.sdk ?? null,
        dir,
        tokenOrg: account.tokenOrg ?? null,
        scopes: cred.scopes,
        usageDigest: await usageAccountDigest(dir),
      });
      return { ok: true, kind: 'ok', identityHash };
    } catch (error) {
      const err = error instanceof ConnectorsAuthError
        ? attachConnectorsError(error, account)
        : attachConnectorsError(new ConnectorsAuthError('login', { name: account?.name ?? account?.id }), account);
      return {
        ok: false,
        kind: err.connectorsError.kind,
        scope: err.connectorsError.scope,
        code: err.code,
        message: err.message,
        reauth: err.connectorsError.reauth,
        needsOwnerCheck: err.connectorsError.needsOwnerCheck,
        identityHash: null,
      };
    }
  };

  return resolveAuth;

  async function resolveOn(account) {
    const ver = await checks(account);
    const dir = accounts.usageDir(account.id);
    guard(dir, account);
    const first = await credentials(account, dir);
    const expectedIdentity = await usageAccountDigest(dir);
    const shared = sharedDir();
    const name = account.name ?? account.id;
    return {
      account: {
        ...account,
        // gate の時点の値。会話の起動・一覧の取得は connectors.fresh() で期限を確かめ直した値を使う（会話用に登録したトークンへは戻さない）
        token: first.token,
        connectors: {
          identity: IDENTITY,
          expiredError() { return attachConnectorsError(new ConnectorsAuthError('expired', { name }), account); },
          /** 会話の起動の直前に呼ぶ。期限が近ければ CLI に更新させ、設定を反映して、{ token, env, expiresAt } を返す。失敗は投げる（旧いトークンへ戻さない） */
          async fresh({ cwd } = {}) {
            try {
              await settingsCheck(name, cwd);
              let cred = await credentials(account, dir);
              let loginFailure = refreshExpired(cred) ? 'refresh-token-expired' : null;
              if (!loginFailure && cred.expiresAt - now() <= REFRESH_WINDOW_MS) {
                const authFailed = await Promise.resolve().then(() => refresh(dir)).then(() => false, claudeUsageAuthFailure);
                if (authFailed) await Promise.resolve().then(() => onLoginExpired(account.id, 'no-login')).catch(() => {});
                cred = await credentials(account, dir);
                if (refreshExpired(cred)) loginFailure = 'refresh-token-expired';
              }
              if (loginFailure) await Promise.resolve().then(() => onLoginExpired(account.id, loginFailure)).catch(() => {});
              if (loginFailure || cred.expiresAt <= now()) throw new ConnectorsAuthError('expired', { name });
              try { await project({ source: cliConfigFile(env, home), target: path.join(shared, '.claude.json'), cwd }); }
              catch { throw new ConnectorsAuthError('profile', { name }); }
              const auth = { token: cred.token, env: { CLAUDE_CONFIG_DIR: shared, CLAUDE_CODE_OAUTH_SCOPES: cred.scopes.join(' ') }, expiresAt: cred.expiresAt };
              if (verify) await verify({ account, ver, auth, dir, shared, home, expectedIdentity }).catch(async error => {
                if (error?.cliAuthFailed === true) {
                  await Promise.resolve().then(() => onLoginExpired(account.id, 'no-login')).catch(() => {});
                  throw new ConnectorsAuthError('expired', { name });
                }
                throw error;
              });
              if (auth.expiresAt <= now()) throw new ConnectorsAuthError('expired', { name });
              return auth;
            } catch (error) {
              throw attachConnectorsError(error, account);
            }
          },
        },
      },
    };
  }
}

/**
 * server の組み立て: 入口の設定・認証・使用量の読み取りの印を 1 つにつなぐ。戻りは入口（{ settings, gate, inspect }）。
 * 印はオンの間だけ効く（使用量の読み取りのたびに入口の設定を見て、オフなら外す。core/backends/claude-usage.mjs）
 * @param {{ guard: (dir: string, active: () => Promise<boolean>) => void, refresh: (dir: string) => Promise<unknown> }} o.usage
 */
export function createClaudeConnectorsWiring({ dataDir, accounts, versions, usage, probe = null, settings = createClaudeConnectorSettings({ dataDir }), ...options }) {
  const resolveAuth = createClaudeConnectorsAuth({
    accounts, versions, refresh: usage.refresh,
    verify: probe ? createConnectorVerification({ dataDir, probe }) : null,
    guard: (dir, account) => usage.guard(dir, async () => (await settings.read(account.id)).enabled === true),
    ...options,
  });
  return {
    ...createClaudeConnectorsGate({ dataDir, resolveAuth, settings }),
    inspect: resolveAuth.inspect,
  };
}

const verificationFlights = new Map();
/** 初回だけ、同じ資格情報を使った専用設定先と共有設定先の本人・一覧を比較する。秘密は保存しない。 */
export function createConnectorVerification({ dataDir, probe, timeoutMs = 30_000 }) {
  const read = async file => fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return async ({ account, ver, auth, dir, shared, home, expectedIdentity }) => {
    let expected;
    try {
      const oa = JSON.parse(await fs.readFile(path.join(dir, '.claude.json'), 'utf8')).oauthAccount;
      if (!oa?.organizationUuid || !oa?.emailAddress) throw new Error();
      expected = hashConnectorIdentity([oa.organizationUuid, oa.emailAddress]);
    } catch { throw new ConnectorsAuthError('owner', { name: account.name }); }
    if (!expectedIdentity || expected !== expectedIdentity) throw new ConnectorsAuthError('owner', { name: account.name });
    const key = hashConnectorIdentity([account.id, ver.cli, ver.sdk, expected]);
    const file = path.join(dataDir, 'claude-connectors-verification', `${key}.json`);
    const flightKey = path.resolve(file);
    if (verificationFlights.has(flightKey)) return verificationFlights.get(flightKey);
    const run = (async () => {
      const cached = await read(file);
      if (cached?.toString() === JSON.stringify({ version: 1, cli: ver.cli, sdk: ver.sdk, key })) return;
      const snapshot = async () => {
        try {
          const oa = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')).oauthAccount;
          return hashConnectorIdentity([oa?.organizationUuid ?? null, oa?.emailAddress ?? null]);
        } catch (error) { return error?.code === 'ENOENT' ? 'missing' : 'unreadable'; }
      };
      const before = await snapshot();
      const ac = new AbortController();
      let timer;
      const check = async () => {
        const results = [];
        for (const config of [dir, shared]) {
          if (ac.signal.aborted) throw new ConnectorsAuthError('verificationTimeout', { name: account.name });
          const result = await probe({ token: auth.token, verification: true, connectors: { fresh: async () => ({ ...auth, env: { ...auth.env, CLAUDE_CONFIG_DIR: config } }) }, signal: ac.signal });
          const info = result?.account;
          if (config === shared ? (info?.tokenSource !== 'CLAUDE_CODE_OAUTH_TOKEN' || info?.apiProvider !== 'firstParty') : ((info?.email != null || info?.organization != null) && (!info.email || !info.organization || hashConnectorIdentity([info.organization, info.email]) !== expected))) throw new ConnectorsAuthError('owner', { name: account.name });
          if (!Array.isArray(result.connectors)) throw new ConnectorsAuthError('verificationList', { name: account.name });
          results.push(JSON.stringify(result.connectors.map(c => typeof c === 'string' ? c : c.name).sort()));
        }
        if (results[0] !== results[1]) throw new ConnectorsAuthError('verificationList', { name: account.name });
        if (before !== await snapshot()) throw new ConnectorsAuthError('verificationWrites', { name: account.name });
      };
      try {
        await Promise.race([check(), new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new ConnectorsAuthError('verificationTimeout', { name: account.name })); }, timeoutMs); })]);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.writeFile(tmp, JSON.stringify({ version: 1, cli: ver.cli, sdk: ver.sdk, key }), { mode: 0o600 });
          await renameWithRetry(tmp, file, fs, sleepFor);
        } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
      } catch (error) {
        if (error instanceof ConnectorsAuthError || error?.cliAuthFailed === true) throw error;
        throw new ConnectorsAuthError('verificationList', { name: account.name });
      } finally { clearTimeout(timer); }
    })();
    verificationFlights.set(flightKey, run);
    try { await run; } finally { if (verificationFlights.get(flightKey) === run) verificationFlights.delete(flightKey); }
  };
}

/**
 * 設定 › 外部 MCP のコネクターの一覧の読み取り（core/context-claude-extras.mjs の createConnectorReader の probe）。
 * 新しい会話の既定のアカウントで読む。入口がオンのアカウントは会話と同じ組み立て（connectors.fresh()）を通し、
 * 止める条件（ConnectorsAuthError）はそのまま投げる（ログイン中のアカウントで読み直さない。読めなかった扱いで、覚えの一覧は書かない）。
 * オンの解決は想定外の例外も ConnectorsAuthError にして投げる（createClaudeConnectorsAuth）ので、ここへ来るそれ以外の失敗は
 * 入口の手前（アカウントを消した・トークンが無いなど。オフと同じ）だけで、今までどおりログイン中のアカウントで読む
 */
export function connectorListProbe({ defaultId, resolve, probe }) {
  return async ({ deny }) => {
    const id = await defaultId();
    let account;
    try { account = await resolve(id); }
    catch (error) {
      if (error instanceof ConnectorsAuthError) throw error;
      account = null;
    }
    return probe({ deny, token: account?.token ?? null, ...(account?.connectors ? { connectors: account.connectors } : {}) });
  };
}
