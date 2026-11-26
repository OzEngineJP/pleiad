// Antigravity（agy）の 2 つ目以降のアカウント。1 つ目は OS の鍵束のまま触らず、登録したアカウントだけ、Pleiad が所有する別の置き場
// （<data>/accounts/antigravity/<id>）に、トークンをファイルとして保存させて分ける（ADR 0222。agy 1.5.17 の
// AGY_CLI_FORCE_FILE_TOKEN_STORAGE と `agy acp --app-data-dir`）。トークンの中身は Pleiad は読まない（在るかどうかだけ確かめる）。
// 置き場の形は grok-accounts.mjs と同じ（id の書式・親の確認・リンクの拒否・所有者だけが読める権限）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { AgyAcp, agyLaunchProfile, assertFileStorage, prepareAgyLogs } from './antigravity-acp.mjs';
import { cliCommand } from '../cli-installation.mjs';
import { loginCancelledError, loginTimeoutError } from '../auth/login-watch.mjs';
import { run } from '../process.mjs';
import { systemTool } from '../win-system.mjs';
import { t } from '../i18n.mjs';

const AGENT = 'Antigravity';
/** ブラウザーでのログインを待つ上限（既定 10 分） */
export const LOGIN_TIMEOUT_MS = Number(process.env.AGENT_HOST_AGY_LOGIN_MS ?? 10 * 60_000);
/** ログイン後、トークンのファイルが現れるまで待つ上限 */
const TOKEN_WAIT_MS = 3000;
export const DEFAULT_LOGIN_METHOD = 'oauth-personal';

const stat = p => fs.lstat(p).catch(e => { if (e.code === 'ENOENT') return null; throw e; });

/** 検査を通した置き場（<data>/accounts/antigravity/<id>）。create: 無ければ作る */
export async function accountHome(account, dataDir, { create = false } = {}) {
  const root = path.resolve(dataDir, 'accounts', 'antigravity');
  if (!account || !/^acct-[0-9a-f]{12}$/i.test(String(account.id ?? '')) || typeof account.dir !== 'string' || !path.isAbsolute(account.dir)) {
    throw new Error('Invalid Antigravity account directory');
  }
  const dir = path.resolve(account.dir);
  if (path.basename(dir) !== account.id || path.dirname(dir) !== root) throw new Error('Antigravity account directory is outside the account root');
  for (let p = dir; ; p = path.dirname(p)) {
    const s = await stat(p);
    if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new Error('Unsafe Antigravity account directory');
    if (p === root) break;
    const relative = path.relative(root, p);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Antigravity account directory is outside the account root');
    }
  }
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await stat(dir))) throw new Error(t('accounts.backend.directoryRemoved', { agent: AGENT }));
  return dir;
}

/** 置き場を本人の Windows ユーザーだけが読めるようにする（ADR 0222。継承を切り、SID に絞る） */
export async function protect(dir) {
  await fs.chmod(dir, 0o700).catch(() => {});
  if (process.platform !== 'win32') return;
  const who = await run(systemTool('whoami'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = who.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error(t('accounts.backend.permissionsUnknown', { agent: AGENT }));
  const acl = await run(systemTool('icacls'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
  if (acl.startError || acl.exitCode !== 0) throw new Error(t('accounts.backend.permissionsFailed', { agent: AGENT }));
}

/**
 * トークンのファイルが安全に在るか（中身は読まない）。普通のファイルで、リンクでなく、ハードリンクが 1 つだけのときだけ true。
 * 置き場そのものが安全でなければ投げる（accountHome）
 */
export async function hasAgyToken(account, dataDir) {
  const dir = await accountHome(account, dataDir);
  const profile = agyLaunchProfile({ account: { ...account, dir } });
  const s = await stat(profile.tokenFile).catch(() => null);
  return Boolean(s && s.isFile() && !s.isSymbolicLink() && s.nlink === 1);
}

/** agy が stderr に出す "visit https://…" の URL（無ければ null） */
export function visitUrl(text) {
  const m = /visit\s+(https:\/\/[^\s"'<>]+)/i.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * 起こした `agy acp` に authenticate を送り、agy にブラウザーを開かせて待つ（1 つ目も 2 つ目以降も同じ口。ADR 0365）。
 * 待つ間は「ブラウザーでログインしてください」の文だけを出し、agy が stderr に "visit https://…" を出したら、その URL も渡す
 * （ブラウザーが開かなかったときに、利用者が自分で開けるように）。check はやめられていたら CANCELLED で投げる。
 * 時間切れ（-32001）は TIMEOUT、agy が断ったときは理由を 1 行にして AGY_LOGIN_REFUSED で投げる
 */
export async function authenticateInBrowser({ client, method = DEFAULT_LOGIN_METHOD, timeoutMs = LOGIN_TIMEOUT_MS, emit, check = () => {} }) {
  const message = t('antigravity.accounts.loginInBrowser');
  emit?.({ type: 'auth', phase: 'url', message });
  let sentUrl = null;
  const watcher = setInterval(() => {
    const url = visitUrl(client.stderrTail);
    if (url && url !== sentUrl) { sentUrl = url; emit?.({ type: 'auth', phase: 'url', url, message }); }
  }, 500);
  watcher.unref?.();
  try { await client.call('authenticate', { methodId: method }, { timeoutMs }); }
  catch (error) {
    check();
    if (error?.code === -32001) throw loginTimeoutError(t('antigravity.auth.loginTimeout'));
    // agy が断った理由（会社のアカウントを oauth-business で入れたときの Enterprise の契約が無い、など）をログインの段に出す
    if (typeof error?.authRefused === 'string') throw Object.assign(new Error(t('antigravity.accounts.loginRefused', { reason: error.authRefused })), { code: 'AGY_LOGIN_REFUSED' });
    throw error;
  } finally { clearInterval(watcher); }
}

/**
 * 2 つ目以降のアカウントのログイン。`agy acp` を、このアカウントの置き場とファイル保存の env で起こし、
 *   initialize → 試しの session/new（未ログインなら -32000）→ ファイル保存の印を確かめる → authenticate（ブラウザー）
 * の順に進める。**印が出なければ authenticate を送らない**（古い版は鍵束に書き、1 つ目のログインを上書きするため）。
 * 成功したら資格情報の控え（トークンは入れない。印だけ）を返す。method は oauth-personal（既定）か oauth-business
 */
export async function loginAgyAccount({ account, dataDir, signal, emit, method = DEFAULT_LOGIN_METHOD, command = cliCommand('antigravity'),
  timeoutMs = LOGIN_TIMEOUT_MS, markerMs } = {}) {
  const dir = await accountHome(account, dataDir, { create: true });
  await protect(dir);
  const profile = agyLaunchProfile({ account: { ...account, dir } });
  prepareAgyLogs(profile);
  const client = new AgyAcp({ command, cwd: dir, profile, timeoutMs: 30_000 });
  let cancelled = false;
  const onAbort = () => { cancelled = true; client.close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const check = () => { if (cancelled || signal?.aborted) throw loginCancelledError(AGENT); };
  try {
    check();
    const init = await client.start();
    const offered = Array.isArray(init?.authMethods) ? init.authMethods.map(m => m?.id) : [];
    if (offered.length && !offered.includes(method)) throw new Error(t('accounts.backend.loginFailed', { agent: AGENT }));
    check();
    // 試しの session/new。未ログインは -32000（Authentication required）。ここで agy がファイル保存の印をログへ書く
    let authorized = false;
    try { await client.call('session/new', { cwd: dir, mcpServers: [] }); authorized = true; } catch { /* 未ログイン（想定）。印の確認で判定する */ }
    check();
    await assertFileStorage(profile, markerMs ? { timeoutMs: markerMs } : undefined);
    if (!authorized) await authenticateInBrowser({ client, method, timeoutMs, emit, check });
    check();
    const until = Date.now() + TOKEN_WAIT_MS;
    while (!(await hasAgyToken(account, dataDir))) {
      check();
      if (Date.now() >= until) throw new Error(t('antigravity.accounts.loginTokenMissing'));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await protect(dir);
    emit?.({ type: 'auth', phase: 'done', message: t('antigravity.auth.loggedIn') });
    return { credential: { kind: 'agy-file-token', method, at: new Date().toISOString() }, label: account.name || t('antigravity.auth.account') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await client.close().catch(() => {});
  }
}
