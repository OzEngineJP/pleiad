// agy（Antigravity CLI 1.5.15 以降）の ACP の口（`agy acp`）。共通の実装は core/backends/acp-client.mjs で、ここは agy 固有の差だけ:
//   起動の引数（作業場所・HOME・追加の場所・制限した会話の agent・承認の省略・起動の型 profile）・
//   断られた依頼に載せる安全な印（使用量の上限 antigravityLimit・thought signature の失敗・設定の断り）。
// 起動の型（agyLaunchProfile）は、将来アカウントごとに環境・引数を変えるための 1 つの出入口。今は 1 種類（key: 'default'）
import { AcpClient } from './acp-client.mjs';
import { cliCommand, spawnCli } from '../cli-installation.mjs';
import { antigravityLimit } from './antigravity-limit.mjs';

export const MAX_AGY_FRAME_BYTES = 64 * 1024 * 1024;

/** agy の起動の型。会話の起動の違い（環境・追加の引数）はここに集める。key は会話の起こし直しの判断（keysOf）と、モデル一覧の控えの区別に使う */
export function agyLaunchProfile({ account = null } = {}) {
  void account;
  return { key: 'default', args: [], env: {} };
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
      },
    });
  }
}
