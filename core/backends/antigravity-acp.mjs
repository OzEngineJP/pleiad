// agy（Antigravity CLI 1.5.15 以降）の ACP の口（`agy acp`）。共通の実装は core/backends/acp-client.mjs で、ここは agy 固有の差だけ:
//   起動の引数（作業場所・HOME・追加の場所・制限した会話の agent・承認の省略・起動の型 profile）・
//   断られた依頼に載せる安全な印（使用量の上限 antigravityLimit・thought signature の失敗・設定の断り）。
// 起動の型（agyLaunchProfile）は、アカウントごとに環境・引数を変える 1 つの出入口。account 無し（1 つ目。OS の鍵束のまま）は何も足さず、
// 登録した 2 つ目以降のアカウントだけ、トークンをファイルに保存させて別の置き場に分ける（ADR 0222）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from './acp-client.mjs';
import { cliCommand, spawnCli } from '../cli-installation.mjs';
import { antigravityLimit } from './antigravity-limit.mjs';
import { t } from '../i18n.mjs';

export const MAX_AGY_FRAME_BYTES = 64 * 1024 * 1024;

/** ファイル保存に倒す env（agy 1.5.17 の composite_token_storage）。これが効いた印がログに出る */
export const FILE_STORAGE_ENV = 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE';
export const FILE_STORAGE_MARKER = 'Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set';
export const TOKEN_FILE_NAME = 'antigravity-oauth-token';
/** 古いログを残す本数（起動のたびに新しい名前を作る） */
const KEEP_LOGS = 5;

const coded = (code, message) => Object.assign(new Error(message), { code });
/** agy が `~` として見る場所。`--app-data-dir` の相対はここ（~/.gemini）から数える */
const agyHome = () => process.env.USERPROFILE || process.env.HOME || os.homedir();
let launchSeq = 0;

/**
 * agy の起動の型。会話の起動の違い（環境・追加の引数）はここに集める。key は会話の起こし直しの判断（keysOf）と、モデル一覧の控えの区別に使う。
 * account 無しは今までどおり何も足さない。account（dir を持つ）は、トークンをファイルに保存させ（env）、置き場を `--app-data-dir`（~/.gemini からの
 * 相対。agy は絶対パスを断る）で account.dir の下へ向ける。`topEnv` は `agy models`・`--print /usage`（一番上のコマンド。`--app-data-dir` を持たない）
 * を同じ置き場に向ける env。別のドライブで相対パスが作れないときは断る（AGY_APP_DATA_UNREACHABLE）
 */
export function agyLaunchProfile({ account = null } = {}) {
  if (!account) return { key: 'default', args: [], env: {} };
  const dir = path.resolve(String(account.dir ?? ''));
  const appData = path.join(dir, '.gemini', 'antigravity-cli');
  const rel = path.relative(path.join(agyHome(), '.gemini'), appData);
  if (!rel || path.isAbsolute(rel)) throw coded('AGY_APP_DATA_UNREACHABLE', t('antigravity.accounts.appDataUnreachable'));
  const logsDir = path.join(dir, 'logs');
  const logFile = path.join(logsDir, `agy-${Date.now()}-${process.pid}-${++launchSeq}.log`);
  return {
    key: String(account.id),
    args: ['--app-data-dir', rel, '--log-file', logFile],
    env: { [FILE_STORAGE_ENV]: '1' },
    topEnv: { USERPROFILE: dir, HOME: dir, [FILE_STORAGE_ENV]: '1' },
    dir, appData, tokenFile: path.join(appData, TOKEN_FILE_NAME), logsDir, logFile, guard: true,
  };
}

/** ログの置き場を作り、古いログを KEEP_LOGS 本だけ残して消す（起動する側が、起こす前に 1 度呼ぶ） */
export function prepareAgyLogs(profile) {
  if (!profile?.logsDir) return;
  fs.mkdirSync(profile.logsDir, { recursive: true, mode: 0o700 });
  const names = fs.readdirSync(profile.logsDir).filter(n => /^agy-.*\.log$/.test(n) && n !== path.basename(profile.logFile)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - (KEEP_LOGS - 1)))) fs.rmSync(path.join(profile.logsDir, name), { force: true });
}

/**
 * 2 つ目以降のアカウントの起動で、ファイル保存の印がログに出たことを確かめる（出るまで最長 timeoutMs 待つ）。
 * 出なければ AGY_FILE_STORAGE_UNSUPPORTED で止める。**鍵束へ黙って戻さない**（1 つ目のログインを上書きさせない）。
 * 印は session/new を受けてから出るので、会話・ログインはその応答の直後、prompt・authenticate の前に呼ぶ。起こしたプロセス 1 つにつき 1 度で足りる
 */
export async function assertFileStorage(profile, { timeoutMs = 3000, pollMs = 25 } = {}) {
  if (!profile?.guard || profile.verified) return true;
  const until = Date.now() + timeoutMs;
  for (;;) {
    let text = '';
    try { text = fs.readFileSync(profile.logFile, 'utf8'); } catch {}
    if (text.includes(FILE_STORAGE_MARKER)) { profile.verified = true; return true; }
    if (Date.now() >= until) throw coded('AGY_FILE_STORAGE_UNSUPPORTED', t('antigravity.accounts.fileStorageUnsupported'));
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

/** `agy acp` が使える最小のバージョン（1.5.15）。読めない版は false（呼び出し側が、版が分からない場合の扱いを決める） */
export const MIN_ACP_VERSION = '1.5.15';
export function supportsAcp(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 15)));
}

let versionProbe = null;
/** agy の `--version`（結果は 1 回だけ控える）。取れなければ null（取れない版は止めず通す） */
export function agyVersion({ argv = cliCommand('antigravity'), timeoutMs = 15_000 } = {}) {
  versionProbe ??= new Promise(resolve => {
    let proc, out = '';
    const done = value => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { try { proc?.kill(); } catch {} done(null); }, timeoutMs);
    try {
      proc = spawnCli(argv, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => { out += chunk; });
      proc.on('error', () => done(null));
      proc.on('close', () => done(out.trim().split(/\s+/).find(word => /^v?\d+\.\d+\.\d+$/.test(word)) ?? null));
    } catch { done(null); }
  }).then(value => { if (value === null) versionProbe = null; return value; });
  return versionProbe;
}

/** 起こす前の版の確認。古いと分かったときだけ版を返す（取れない・読めないときは null で通す） */
export async function tooOldAcp(options) {
  const version = await agyVersion(options);
  return version && !supportsAcp(version) ? version : null;
}

/** agy の thought signature の失敗（会話の歴史にネイティブ側の署名が合わない）。再送しても直らないので、ネイティブの会話を使えない印にする */
export const SIGNATURE_RE = /invalid thought signature/i;

/** authenticate を断った agy の文を、画面に出せる 1 行にする（制御文字を外し、空白を詰め、URL の問い合わせ部分と長い符号を伏せ、300 字まで） */
export function authRefusalReason(text) {
  let s = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, '$1').replace(/[A-Za-z0-9_\-.+/=]{40,}/g, '…');
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

/** `agy acp` の引数。restricted は Skills・MCP を止める会話（agent 定義 ply-context を使う） */
export function agyAcpArgs({ cwd, home, extraDirs = [], restricted = false, skipPermissions = false, profile = agyLaunchProfile() } = {}) {
  return ['acp',
    ...(cwd ? ['--add-dir', cwd] : []),
    ...(home ? ['--add-dir', home] : []),
    ...extraDirs.flatMap(dir => ['--add-dir', dir]),
    ...(restricted ? ['--agent', 'ply-context'] : []),
    ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...(profile?.args ?? [])];
}

export class AgyAcp extends AcpClient {
  constructor({ command = cliCommand('antigravity'), cwd, home, env, extraDirs = [], restricted = false, skipPermissions = false, profile = agyLaunchProfile(),
    onUpdate = () => {}, onResponse = () => {}, onRequest, onGone = () => {}, onDrop = ({ bytes }) => console.error(`  agy: dropped an oversize ACP line (${bytes} bytes)`),
    timeoutMs = 30_000, held = null, adopt = null } = {}) {
    super({
      label: 'Antigravity',
      args: agyAcpArgs({ cwd, home, extraDirs, restricted, skipPermissions, profile }),
      command, cwd, env: { ...(env ?? process.env), ...(profile?.env ?? {}) }, timeoutMs, held, adopt,
      onUpdate, onResponse, onRequest, onGone,
      onOverflow: onDrop,
      maxFrameBytes: MAX_AGY_FRAME_BYTES,
      decorateError: (reject, { error, method, params }) => {
        // 構造化した安全な印だけを載せる（wire の message はここから外へ出さない）
        const text = String(error?.message ?? '');
        const limit = antigravityLimit(text);
        if (limit) reject.acpLimit = limit;
        if (SIGNATURE_RE.test(text)) reject.thoughtSignature = true;
        // 設定の値を agy が断った印（-32602 Invalid params）。どの設定か（configId）だけを載せる
        if (error?.code === -32602 && method === 'session/set_config_option' && typeof params?.configId === 'string') {
          reject.configRejected = { option: params.configId };
        }
        // 会話が見つからない（resume・load の失敗の見分け）
        if (error?.code === -32002) reject.notFound = true;
        // ログイン（authenticate）を agy が断った理由（例: -32603 no Gemini Enterprise license…）。ログインの段で本人に見せる
        // ためだけに、1 行・300 字までに整えて載せる（ほかの依頼の wire の message は今までどおり外へ出さない。ADR 0366）
        if (method === 'authenticate' && error?.code !== -32001) {
          const reason = authRefusalReason(text);
          if (reason) reject.authRefused = reason;
        }
      },
    });
  }
}
