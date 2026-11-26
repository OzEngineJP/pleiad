// 登録した Claude アカウントの認証（ADR 0340・ADR 0345・ADR 0350・ADR 0353。専用フォルダ方式だけ）。
//
// 登録したアカウントはすべてここへ来る（コネクターのオン・オフで分けない。ADR 0353）。ログイン中・互換接続はここを呼ばない。
// 会話の CLI は、そのアカウントの専用フォルダ（claude-usage/<id>。設定 › アカウントのログインを置く場所）を CLAUDE_CONFIG_DIR にして起動する。
// コネクター（入口 core/claude-connectors.mjs）がオフのアカウントは ENABLE_CLAUDEAI_MCP_SERVERS=false も渡し、claude.ai のコネクターを出さない。
// トークンは env で渡さない。更新は CLI が自分で行う（同じフォルダの CLI どうしは .oauth_refresh.lock で直列になり、失効を検知したら
// ディスクから読み直す）ので、Pleiad は期限を見ず、更新もしない。専用フォルダの projects・skills・plugins・settings.json は
// 共有の ~/.claude へのリンクにする（core/claude-own-dir.mjs の ensureClaudeOwnDirLinks。名前が重なった項目は退避する）。
// 会話・内部呼出し（core/backends/claude.mjs の withConnectorsAuth）と、設定 › 外部 MCP のコネクターの一覧（connectorListProbe）は、
// どちらも connectors.prepare()（リンクの準備・設定の反映）を通り、{ env: { CLAUDE_CONFIG_DIR } } を受け取る。
//
// 止める条件（黙ってログイン中のアカウントへ戻さない。投げるのは ConnectorsAuthError。server の scopedOrUnavailable がそのアカウントの会話を
// 「引けなかった理由」で断る）: ログインが無い・読めない / 確かめていない CLI・SDK の版 / 対応していない OS・ssh 経由の macOS /
// 共有の settings.json に別の認証がある / 履歴の場所を保てない / リンクの準備・設定の反映に失敗。
// トークン・メールアドレス・組織の id はメッセージ・ログに出さない。
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { AccountError, cliConfigFile } from './claude-accounts.mjs';
import { createClaudeConnectorSettings, hashConnectorIdentity } from './claude-connectors.mjs';
import { claudeManagedFiles } from './hooks-config.mjs';
import { t } from './i18n.mjs';
import { gitRootOf, canonicalRoot } from './git-root.mjs';
import { claudeLoginPresent, ensureClaudeOwnDirLinks, macKeychainAuthFailure, OWN_DIR, sshSession, withClaudeUsageDir } from './claude-own-dir.mjs';

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
/** 設定の読み取り（CLI が書き換え中に壊れて見えることがある）の回数と間 */
export const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 100;
const SETTINGS_FILE = 'settings.json';
/** claude.ai のコネクターを出さない指定（Claude Code 2.1.328 は "0"・"false"・"no"・"off" で止める。ADR 0353） */
export const NO_CONNECTORS_ENV = 'ENABLE_CLAUDEAI_MCP_SERVERS';
/**
 * 専用フォルダ方式を使える OS。macOS はキーチェーンの項目の有無で判定する（ADR 0351。2026-11-24 の実機の確かめで通した）。
 * macOS でも ssh からの起動は止める（ssh。画面が無いと CLI が鍵束を開けない）
 */
const OWN_DIR_PLATFORMS = ['win32', 'linux', 'darwin'];
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

export function claudeOwnDirEnv(base, extra) {
  return Object.fromEntries(Object.entries({ ...base, ...extra })
    .filter(([key]) => !SETTINGS_ENV.includes(key.toUpperCase()) || key === 'CLAUDE_CONFIG_DIR'));
}

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
      reauth: ['login', 'ownDirLogin', 'keychainAuth'].includes(kind),
      params: error.connectorsParams ?? {},
    };
  }
  return error;
}

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const present = (env, names) => names.filter(name => typeof env[name] === 'string' && env[name] !== '');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stripBom = text => String(text).replace(/^﻿/, '');

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
 * @param {{ usageDir: (id: string) => string, hasUsageLogin: (id: string) => Promise<boolean> }} o.accounts  core/claude-accounts.mjs
 * @param {() => Promise<{ cli: string|null, sdk: string|null }>} o.versions  使っている CLI と SDK の版
 * @returns {(account: { id: string, name: string }) => Promise<{ account: object }>}  入口の resolveAuth
 */
export function createClaudeConnectorsAuth({ accounts, versions, env = process.env, home = os.homedir(), platform = process.platform,
  readFile = fs.readFile, project = projectProfile, verified = VERIFIED_VERSIONS, managedFiles = null,
  loginPresent = claudeLoginPresent } = {}) {
  const sharedDir = () => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');

  async function checkSettingsFile(name, file) {
    const found = await settingsOverridesFile(file, { readFile });
    if (!found) throw new ConnectorsAuthError('env', { name }, 'envSettings', { scope: 'settings' });
    if (found.auth.length) throw new ConnectorsAuthError('env', { name, names: found.auth.join(', ') }, 'env', { scope: 'settings' });
    if (found.history.length) throw new ConnectorsAuthError('history', { name, names: found.history.join(', ') }, 'history', { scope: 'settings' });
  }

  async function settingsCheck(name, cwd = null) {
    for (const entry of settingsFiles({ sharedDir: sharedDir(), cwd, platform, managedFiles })) {
      await checkSettingsFile(name, entry.file);
    }
  }

  async function versionCheck(name) {
    const found = await Promise.resolve().then(versions).catch(() => ({}));
    if (!supportedConnectorVersions(found, verified)) {
      throw new ConnectorsAuthError('version', { name, cli: found?.cli ?? '?', sdk: found?.sdk ?? '?', verified: verified.map(v => `CLI ${v.cli} / SDK ${v.sdk}`).join(', ') });
    }
    return found;
  }

  /** 本人照合に使う、専用フォルダのログインの持ち主（組織・メールのハッシュ。ADR 0350 で残した） */
  async function usageAccountDigest(dir) {
    try {
      const parsed = JSON.parse(stripBom(await readFile(path.join(dir, '.claude.json'), 'utf8')));
      const oa = parsed?.oauthAccount;
      return oa ? hashConnectorIdentity([oa.organizationUuid ?? null, oa.emailAddress ?? null]) : null;
    } catch { return null; }
  }

  /**
   * 登録したアカウントの解決（config は入口の設定。enabled でコネクターを出すか決める）。止める条件は ConnectorsAuthError で投げる。
   * 想定外の例外（設定フォルダを引けないなど）も login に揃えて投げる（元の文面は出さない）
   */
  async function resolveAuth(account, config = { enabled: false }) {
    try { return await resolveOwnDir(account, config?.enabled === true); }
    catch (error) {
      if (error instanceof ConnectorsAuthError) throw attachConnectorsError(error, account);
      throw attachConnectorsError(new ConnectorsAuthError('login', { name: account?.name ?? account?.id }), account);
    }
  }

  /** 画面・一覧用の検査。prepare のときだけリンクを準備する（結果の moves は共有へ移した・退避した項目）。CLI は起こさない。 */
  resolveAuth.inspect = async function inspectAuth(account, { cwd = null, prepare = false } = {}) {
    try {
      const { dir, ver } = await ownDirChecks(account, cwd);
      const moves = prepare ? await prepareOwnDir(account, dir, cwd, false) : [];
      return { ok: true, kind: 'ok', identityHash: hashConnectorIdentity([OWN_DIR, account.id, dir, ver, await usageAccountDigest(dir)]), moves };
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
        identityHash: null,
      };
    }
  };

  return resolveAuth;

  async function ownDirLogin(account, dir) {
    const name = account.name ?? account.id;
    const root = await fs.lstat(dir).catch(() => null);
    if (!root?.isDirectory() || !await accounts.hasUsageLogin(account.id)) throw new ConnectorsAuthError('ownDirLogin', { name });
    // ログインの有無だけを見る（macOS はキーチェーンの項目の有無。中身は読まない。ADR 0351）
    const found = await loginPresent(dir, { platform });
    if (found === 'keychain') throw new ConnectorsAuthError('keychain', { name });
    if (found === 'platform') throw new ConnectorsAuthError('platform', { name, platform });
    if (found !== 'present') throw new ConnectorsAuthError('ownDirLogin', { name });
    const profile = await fs.lstat(path.join(dir, '.claude.json')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (profile && !profile.isFile()) throw new ConnectorsAuthError('ownDirLinks', { name: account.name ?? account.id });
  }

  async function ownDirChecks(account, cwd) {
    const name = account.name ?? account.id;
    if (!OWN_DIR_PLATFORMS.includes(platform)) throw new ConnectorsAuthError('platform', { name, platform });
    // ssh で起動した Mac は、画面が無いので CLI が鍵束を開けない（M8 の実機で loggedIn:false のまま失敗した）。待たずに止める（ADR 0351）
    if (platform === 'darwin' && sshSession(env)) throw new ConnectorsAuthError('ssh', { name });
    const ver = await versionCheck(name);
    const dir = accounts.usageDir(account.id);
    await ownDirLogin(account, dir);
    const moved = present(env, HISTORY_ENV);
    if (moved.length) throw new ConnectorsAuthError('history', { name, names: moved.join(', ') }, 'history', { scope: 'env' });
    await settingsCheck(name, cwd);
    return { dir, ver };
  }

  function prepareOwnDir(account, dir, cwd, projectSettings) {
    return withClaudeUsageDir(dir, async () => {
      const name = account.name ?? account.id;
      let moves;
      try {
        await ownDirLogin(account, dir);
        const shared = sharedDir();
        const ownSettings = path.join(dir, SETTINGS_FILE);
        const info = await fs.lstat(ownSettings).catch(err => { if (err.code !== 'ENOENT') throw err; });
        if (info?.isFile() && info.size) {
          const sharedSettings = await fs.lstat(path.join(shared, SETTINGS_FILE)).catch(err => { if (err.code !== 'ENOENT') throw err; });
          if (!sharedSettings) await checkSettingsFile(name, ownSettings);
        }
        moves = await ensureClaudeOwnDirLinks(dir, shared);
      } catch (error) {
        if (error instanceof ConnectorsAuthError) throw error;
        const permission = platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code);
        throw new ConnectorsAuthError(permission ? 'ownDirLinksWindows' : 'ownDirLinks', { name });
      }
      await settingsCheck(name, cwd);
      if (projectSettings) {
        try { await project({ source: cliConfigFile(env, home), target: path.join(dir, '.claude.json'), cwd }); }
        catch { throw new ConnectorsAuthError('ownDirProfile', { name }); }
      }
      return moves;
    });
  }

  /**
   * account.ownDir は会話・内部呼出し・モデル一覧が使う認証（全アカウント）。account.connectors は同じもので、コネクターがオンのときだけ置く
   * （server と画面は account.connectors の有無でコネクターを使うかを見る）
   */
  async function resolveOwnDir(account, enabled) {
    const { dir } = await ownDirChecks(account);
    const auth = {
      identity: OWN_DIR,
      enabled,
      async prepare({ cwd } = {}) {
        try {
          await prepareOwnDir(account, dir, cwd, true);
          return { env: { CLAUDE_CONFIG_DIR: dir, ...(enabled ? {} : { [NO_CONNECTORS_ENV]: 'false' }) } };
        } catch (error) { throw attachConnectorsError(error, account); }
      },
      /**
       * 会話の CLI がこのフォルダのログインで断られたときに呼ぶ（core/backends/claude.mjs）。macOS で項目が有るなら鍵束を開けなかった
       * （ロック中など。ADR 0351 の M7）とみて keychainAuth の connectorsError を返す。サーバー側でログインが取り消されたとき（M6）も
       * 項目は残るので見分けられない。期限切れの印は付けず、ロックの解除と送り直しを先に、続くときのログインし直しも出す（reauth）。
       * それ以外は null（呼び手は期限切れとして扱う）
       */
      async authFailure() {
        if (await macKeychainAuthFailure(dir, { platform, present: loginPresent }) !== 'keychain') return null;
        return attachConnectorsError(new ConnectorsAuthError('keychainAuth', { name: account.name ?? account.id }), account);
      },
    };
    return { account: { ...account, ownDir: auth, ...(enabled ? { connectors: auth } : {}) } };
  }
}

/**
 * server の組み立て: 入口の設定・認証を 1 つにつなぐ。戻りは { settings, resolve, inspect }。
 * resolve(id) は登録したアカウントを専用フォルダ方式で引く（コネクターのオン・オフで分けない。ADR 0353）。'' / 未指定は null
 */
export function createClaudeConnectorsWiring({ dataDir, accounts, versions, settings = createClaudeConnectorSettings({ dataDir }), ...options }) {
  const resolveAuth = createClaudeConnectorsAuth({ accounts, versions, ...options });
  return {
    settings,
    async resolve(id) {
      const account = await accounts.resolve(id);
      if (!account) return account;
      return (await resolveAuth(account, await settings.read(id))).account;
    },
    inspect: resolveAuth.inspect,
  };
}

/**
 * 設定 › 外部 MCP のコネクターの一覧の読み取り（core/context-claude-extras.mjs の createConnectorReader の probe）。
 * 新しい会話の既定のアカウントで読む。登録したアカウントは会話と同じ組み立て（ownDir.prepare()。コネクターがオフなら claude.ai の
 * コネクターは出ない）を通し、止める条件（ConnectorsAuthError）はそのまま投げる（ログイン中のアカウントで読み直さない。読めなかった扱いで、
 * 覚えの一覧は書かない）。それ以外の失敗（アカウントを消したなど）は、今までどおりログイン中のアカウントで読む
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
    return probe({ deny, ...(account?.ownDir ? { connectors: account.ownDir } : {}) });
  };
}
