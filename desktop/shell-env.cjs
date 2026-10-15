// ログインシェルの環境変数を読み込む（docs/design.md「4. アーキテクチャ」の「サーバーへ渡す環境変数」。ADR 0212）。
// macOS の Dock・Finder・ログイン項目から起こしたアプリは launchd の最小限の PATH（/usr/bin:/bin:/usr/sbin:/sbin）しか持たず、
// ~/.zprofile・~/.zshrc で足した PATH（Homebrew・gcloud など）が、サーバー経由でエージェントの CLI と `!` の行のシェルに届かない。
// サーバーを起こす前に利用者のログインシェルを対話で 1 回だけ走らせ、その環境を main の process.env へ写す。
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const RESOLVE_TIMEOUT_MS = 10_000;
/** 読み込み中のシェルに付ける印。rc から Pleiad を起こす設定があっても、読み込みが入れ子にならないようにする */
const RESOLVING_ENV = 'PLEIAD_RESOLVING_SHELL_ENV';
/** `off` なら読み込まない（戻し道） */
const SWITCH_ENV = 'AGENT_HOST_SHELL_ENV';

/** シェルの値で上書きしないもの。シェル自身の作業の印と、Electron の動き方を変えるもの */
function skippedKey(key) {
  return key === '_' || key === 'PWD' || key === 'OLDPWD' || key === 'SHLVL' || key === RESOLVING_ENV || key.startsWith('ELECTRON_');
}

/** 読み込むか。Windows は GUI でも利用者の環境変数を受け取るので読まない */
function shouldResolve({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return false;
  if (env[SWITCH_ENV] === 'off') return false;
  return !env[RESOLVING_ENV];
}

/** 利用者のログインシェル。絶対パスでなければ null（何を起こすか分からないものは走らせない） */
function loginShell({ env = process.env, userInfo = os.userInfo } = {}) {
  let shell = env.SHELL;
  if (!shell) { try { shell = userInfo().shell; } catch { shell = null; } }
  return shell && path.isAbsolute(shell) ? shell : null;
}

/** `env -0` の出力（NUL 区切りの KEY=VALUE）を表にする */
function parseEnvBlock(text) {
  const env = {};
  for (const entry of text.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * ログインシェルを対話で走らせ（`-i -l -c`。~/.zprofile と ~/.zshrc の両方を読む）、その環境を返す。
 * rc が出す文字に紛れないよう、前後に一度きりの印を置いた `env -0` の出力だけを読む。
 * 失敗・時間切れは null（呼ぶ側は今の環境のまま続ける）
 */
function resolveShellEnv({ shell, env = process.env, timeoutMs = RESOLVE_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  if (!shell) return Promise.resolve(null);
  const mark = `__PLEIAD_SHELL_ENV_${crypto.randomBytes(8).toString('hex')}__`;
  const command = `printf '%s' '${mark}'; /usr/bin/env -0; printf '%s' '${mark}'`;
  return new Promise((resolve) => {
    let child;
    try {
      // 別のプロセスグループで起こし、時間切れでは rc が起こした子ごと止める
      child = spawnProcess(shell, ['-i', '-l', '-c', command], { env: { ...env, [RESOLVING_ENV]: '1' }, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      finish(null);
    }, timeoutMs);
    // 後ろの印まで届いたら、シェルの終わりを待たない（rc が起こした裏のプロセスが標準出力を持ち続けることがある）
    const parsed = () => {
      const out = Buffer.concat(chunks).toString('utf8');
      const start = out.indexOf(mark);
      const end = out.indexOf(mark, start + mark.length);
      return start >= 0 && end > start ? parseEnvBlock(out.slice(start + mark.length, end)) : null;
    };
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      const shellEnv = parsed();
      if (shellEnv) finish(shellEnv);
    });
    child.once('error', () => finish(null));
    child.once('close', () => finish(parsed()));
  });
}

/** PATH の各要素の重複を、前にあるものを残して外す */
function joinPath(entries, delimiter) {
  const seen = new Set();
  return entries.filter(entry => entry && !seen.has(entry) && seen.add(entry)).join(delimiter);
}

/**
 * base にシェルの環境を重ねた新しい表。シェルの値を優先し、PATH はシェルの PATH の後ろに、base にしか無い要素を残す
 * （Pleiad 自身が足したもの・launchd が渡したものを失わない）
 */
function mergeShellEnv(base, shellEnv, { delimiter = path.delimiter } = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(shellEnv)) {
    if (!skippedKey(key) && key !== 'PATH') merged[key] = value;
  }
  if (shellEnv.PATH) merged.PATH = joinPath([...shellEnv.PATH.split(delimiter), ...String(base.PATH ?? '').split(delimiter)], delimiter);
  return merged;
}

/**
 * env（既定は process.env）をその場で書き換える。読み込めたら true。
 * サーバーを起こす前（utilityProcess.fork・desktop/server-boot.cjs の serverEnv が env を写す前）に待つ
 */
async function applyLoginShellEnv({ env = process.env, platform = process.platform, resolve = resolveShellEnv, log = () => {} } = {}) {
  if (!shouldResolve({ platform, env })) return false;
  const shell = loginShell({ env });
  const shellEnv = await resolve({ shell, env });
  if (!shellEnv) {
    log(`login shell environment unavailable (${shell ?? 'no shell'})`);
    return false;
  }
  const merged = mergeShellEnv(env, shellEnv);
  for (const key of Object.keys(merged)) env[key] = merged[key];
  return true;
}

module.exports = { RESOLVE_TIMEOUT_MS, RESOLVING_ENV, SWITCH_ENV, shouldResolve, loginShell, parseEnvBlock, resolveShellEnv, mergeShellEnv, applyLoginShellEnv };
