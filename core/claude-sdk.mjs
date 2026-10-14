// Claude Agent SDK（@anthropic-ai/claude-agent-sdk）をどこから読むか、の唯一の分かれ目（ADR 0208）。
//
// SDK は Anthropic の独自ライセンス（© Anthropic PBC. All rights reserved）なので、配布物（インストーラー・アプリ）には入れない。
// 配布物では、Claude を初めて使うとき（か設定の画面）に、利用者の同意を得てから npm のレジストリから取り、データ置き場に置いて読む。
// 前の版（SDK を同梱していた版）から Claude を使っていた人は、同意済みとみなして案内なしに取る（core/claude-sdk-legacy.mjs）。
//   local     アプリの node_modules の SDK を読む。開発（npm で直に動かす）と試験。node_modules に SDK があればこちら
//   download  <データ置き場>/claude-sdk/<版>/ に取ったものを読む。配布物（SDK は devDependencies なので入らない）
// AGENT_HOST_CLAUDE_SDK=local|download で強制できる（配布物と同じ道を開発機で試すとき）。
//
// 取る版はビルドのときに固定する（core/claude-sdk-pin.json。package-lock の integrity と同じ。tests/unit/claude-sdk-pin.mjs が突き合わせる）。
// 取得・確かめ・展開は core/claude-sdk-install.mjs。
//
// 取ってきた SDK が import する peer 依存（zod・@modelcontextprotocol/sdk。将来の版が使えば @anthropic-ai/sdk も）は、
// アプリの node_modules のものに解決させる（下の解決のフック）。置き場から上へ node_modules を探すと、
// 利用者のホームに偶然ある別の版を拾う・見つからない、になるため。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { t } from './i18n.mjs';
import { checkPin, installedSdk, installSdk, cleanupSdk, markUsed, ClaudeSdkFetchError } from './claude-sdk-install.mjs';
import { settleLegacyConsent } from './claude-sdk-legacy.mjs';

export const SDK_NAME = '@anthropic-ai/claude-agent-sdk';
const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
/** peer 依存を解決する起点（アプリの package.json。ここから node_modules を探す） */
const APP_ANCHOR = new URL('../package.json', import.meta.url).href;

/** ビルドのときに固定した版（名前・版・integrity・tarball の URL） */
export const CLAUDE_SDK_PIN = checkPin(JSON.parse(fs.readFileSync(new URL('./claude-sdk-pin.json', import.meta.url), 'utf8')));

/** SDK を置くフォルダー（<データ置き場>/claude-sdk）。データ置き場は store.mjs と同じ決め方 */
export const claudeSdkRoot = (env = process.env) => path.join(claudeDataDir(env), 'claude-sdk');
const claudeDataDir = (env) => path.resolve(env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host'));

/** 'local' か 'download'。**どちらを使うかはここだけで決める** */
export function claudeSdkSource(env = process.env, appRoot = APP_ROOT) {
  const forced = String(env.AGENT_HOST_CLAUDE_SDK ?? '').trim();
  if (forced === 'local' || forced === 'download') return forced;
  // 上へ node_modules を探さない（worktree の外の node_modules にある SDK を、配布物で拾わないため）
  return fs.existsSync(path.join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')) ? 'local' : 'download';
}

// ---------------------------------------------------------------- 同意

const consentFile = (root) => path.join(root, 'consent.json');
/** 取得への同意（npm から取る・Anthropic の規約が適用される、の案内を見て「取得」を押した）。版をまたいで持つ */
export function claudeSdkConsent(root = claudeSdkRoot()) {
  try { return Boolean(JSON.parse(fs.readFileSync(consentFile(root), 'utf8'))?.acceptedAt); } catch { return false; }
}
/** 同意を書く。あれば書き直さない（みなし同意の reason を、後から「取得」を押しても消さない）。reason は押したのでなく、みなしたとき */
function writeConsent(root, reason = null, evidence = null) {
  if (claudeSdkConsent(root)) return;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(consentFile(root), JSON.stringify({ acceptedAt: new Date().toISOString(), ...(reason ? { reason, evidence } : {}) }));
}
/**
 * 同意があるか。無ければ、前の版から Claude を使っていた人かを見て（一度だけ。core/claude-sdk-legacy.mjs）、そうなら同意済みとみなして書く。
 * 同意を見るところ（状態・取得・読み込み・先取り・起動の裏の取得）はこれを通す
 */
export function claudeSdkConsented(env = process.env) {
  const root = claudeSdkRoot(env);
  if (claudeSdkConsent(root)) return true;
  if (claudeSdkSource(env) !== 'download') return false;
  return settleLegacyConsent({ dataDir: claudeDataDir(env), root, writeConsent: (reason, evidence) => writeConsent(root, reason, evidence) });
}

// ---------------------------------------------------------------- 状態と取得

const state = { job: null, progress: null, error: null, listeners: new Set(), lastEmit: 0, timer: null };
const PROGRESS_EMIT_MS = 250;

/** 画面（設定の Claude の行）と ops に出す状態 */
export function claudeSdkStatus({ env = process.env, root = claudeSdkRoot(env), pin = CLAUDE_SDK_PIN } = {}) {
  const source = claudeSdkSource(env);
  return {
    source,
    version: pin.version,
    ready: source === 'local' || Boolean(installedSdk(root, pin)),
    consent: source === 'local' || claudeSdkConsented(env),
    fetching: state.job ? { ...(state.progress ?? { received: 0, total: null }) } : null,
    error: state.error ? { ...state.error, message: claudeSdkErrorMessage(state.error) } : null,
  };
}

/** 状態が変わったら呼ぶ（取得の始まり・進み・終わり・失敗）。戻り値で外す */
export function onClaudeSdkChange(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}
function emit({ throttle = false } = {}) {
  const run = () => {
    state.timer = null;
    state.lastEmit = Date.now();
    let status;
    try { status = claudeSdkStatus(); } catch { return; }
    for (const fn of state.listeners) { try { fn(status); } catch { /* 聞き手の失敗は取得を止めない */ } }
  };
  if (!throttle) { if (state.timer) clearTimeout(state.timer); return run(); }
  if (state.timer) return;
  const wait = PROGRESS_EMIT_MS - (Date.now() - state.lastEmit);
  if (wait <= 0) return run();
  state.timer = setTimeout(run, wait);
  state.timer.unref?.();
}

/**
 * 同意が無いまま Claude の会話を始めようとした。画面に取得の案内（設定の Claude の行）を開かせる。
 * 聞き手には prompt: true を付けた状態を渡す（状態そのものには残さない）
 */
export function requestClaudeSdkConsent() {
  let status;
  try { status = { ...claudeSdkStatus(), prompt: true }; } catch { return; }
  for (const fn of state.listeners) { try { fn(status); } catch { /* 聞き手の失敗は無視 */ } }
}

/** 取得の失敗を、画面と会話に出す文にする */
export function claudeSdkErrorMessage(error) {
  const kind = error?.kind ?? 'offline';
  // i18n-dynamic: claudeSdk.errors.
  return t(`claudeSdk.errors.${kind}`, { detail: error?.detail ?? String(error?.message ?? error ?? '') });
}

/**
 * 固定の版を取る（もうあれば何もしない）。同時に何度呼ばれても取得は 1 本。
 * consent: true は利用者が案内を見て「取得」を押したとき（同意を残す）。同意が無ければ consent の失敗を投げる
 */
export function ensureClaudeSdk({ consent = false, env = process.env } = {}) {
  if (claudeSdkSource(env) === 'local') return Promise.resolve({ source: 'local', fetched: false });
  const root = claudeSdkRoot(env);
  if (consent) { claudeSdkConsented(env); writeConsent(root); }   // 先にみなし同意を見る（押す前から使っていた人の reason を、押した同意で隠さない）
  if (!claudeSdkConsented(env)) return Promise.reject(new ClaudeSdkFetchError('consent', 'the user has not agreed to fetch the SDK yet'));
  if (state.job) return state.job;
  const have = installedSdk(root, CLAUDE_SDK_PIN);
  if (have) return Promise.resolve({ source: 'download', ...have, fetched: false });
  state.error = null;
  state.progress = { received: 0, total: null };
  const job = installSdk({
    root, pin: CLAUDE_SDK_PIN, env,
    registry: env.AGENT_HOST_CLAUDE_SDK_REGISTRY || null,
    onProgress: (p) => { state.progress = p; emit({ throttle: true }); },
  }).then((got) => ({ source: 'download', ...got }), (err) => {
    const e = err instanceof ClaudeSdkFetchError ? err : new ClaudeSdkFetchError('disk', err?.message ?? String(err), err);
    state.error = { kind: e.kind, detail: e.detail.slice(0, 500) };
    console.warn(`[claude-sdk] fetching ${CLAUDE_SDK_PIN.name}@${CLAUDE_SDK_PIN.version} failed (${e.kind}): ${e.detail}`);
    throw e;
  }).finally(() => {
    state.job = null;
    state.progress = null;
    emit();
  });
  state.job = job;
  emit();
  return job;
}

// ---------------------------------------------------------------- 読み込み

const hookedRoots = new Set();
let hooksInstalled = false;
const sameUrlPrefix = (url, prefix) => process.platform === 'win32' || process.platform === 'darwin'
  ? url.toLowerCase().startsWith(prefix.toLowerCase())
  : url.startsWith(prefix);
const isBare = (spec) => !/^(\.|\/|[A-Za-z][A-Za-z0-9+.-]*:)/.test(spec) && !spec.startsWith('#') && !module.isBuiltin(spec);

/**
 * 置き場の中のファイルが書いた裸の指定子（zod/v4 など）を、アプリの package.json から解決させる。
 * Node 22.15 以降は registerHooks（同じスレッド・同期）、それより前は register（別スレッドのローダー）
 */
function installPeerHook(root) {
  const prefix = pathToFileURL(root).href.replace(/\/?$/, '/');
  if (hookedRoots.has(prefix)) return;
  hookedRoots.add(prefix);
  if (hooksInstalled) return;
  hooksInstalled = true;
  if (typeof module.registerHooks === 'function') {
    module.registerHooks({
      resolve(specifier, context, nextResolve) {
        const parent = context?.parentURL;
        if (parent && isBare(specifier) && [...hookedRoots].some((p) => sameUrlPrefix(parent, p))) {
          return nextResolve(specifier, { ...context, parentURL: APP_ANCHOR });
        }
        return nextResolve(specifier, context);
      },
    });
    return;
  }
  // 古い Node（22.13〜22.14）: 別スレッドのローダー。置き場は data で渡す（後から増えた置き場は port で足す）
  const loader = `
    import { isBuiltin } from 'node:module';
    let roots = [], anchor = '', fold = false;
    const bare = (s) => !/^(\\.|\\/|[A-Za-z][A-Za-z0-9+.-]*:)/.test(s) && !s.startsWith('#') && !isBuiltin(s);
    const has = (u) => roots.some((p) => fold ? u.toLowerCase().startsWith(p.toLowerCase()) : u.startsWith(p));
    export function initialize(data) {
      roots = data.roots; anchor = data.anchor; fold = data.fold;
      data.port?.on('message', (m) => { if (m?.root) roots.push(m.root); });
      data.port?.unref?.();
    }
    export async function resolve(specifier, context, next) {
      if (context.parentURL && bare(specifier) && has(context.parentURL)) return next(specifier, { ...context, parentURL: anchor });
      return next(specifier, context);
    }`;
  const { port1, port2 } = new MessageChannel();
  module.register(`data:text/javascript,${encodeURIComponent(loader)}`, {
    data: { roots: [...hookedRoots], anchor: APP_ANCHOR, fold: process.platform !== 'linux', port: port2 },
    transferList: [port2],
  });
  port1.unref?.();
  addRoot = (p) => port1.postMessage({ root: p });
}
let addRoot = null;
function hookRoot(root) {
  const before = hookedRoots.size;
  installPeerHook(root);
  if (addRoot && hookedRoots.size > before) addRoot([...hookedRoots].at(-1));
}

/** 置き場に取ったものを読む（試験もここを通す）。peer 依存はアプリのものに解決させる */
export async function importInstalledSdk(entry, root) {
  hookRoot(root);
  return import(pathToFileURL(entry).href);
}

/** SDK が無いとき（取っていない・同意が無い・取れなかった）の失敗。code で見分ける */
export class ClaudeSdkMissingError extends Error {
  constructor(message, { kind = null, cause = null } = {}) {
    super(message);
    this.name = 'ClaudeSdkMissingError';
    this.code = 'CLAUDE_SDK_MISSING';
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}
export const isClaudeSdkMissing = (err) => err?.code === 'CLAUDE_SDK_MISSING';

let loaded = null;   // { key, promise }
/**
 * SDK を読む。読んだものは覚えておく（失敗は覚えない）。
 *   fetch: true  置き場に無く、同意があれば取ってから読む（会話を始めるとき）。同意が無ければ ClaudeSdkMissingError
 *   fetch: false 置き場に無ければ ClaudeSdkMissingError（一覧・使用量など、取得を始めない読み）
 */
export function loadClaudeSdk({ fetch = false, env = process.env } = {}) {
  const source = claudeSdkSource(env);
  const root = claudeSdkRoot(env);
  const key = source === 'local' ? 'local' : `${root}|${CLAUDE_SDK_PIN.version}`;
  if (loaded?.key === key) return loaded.promise;
  if (source === 'local') {
    const promise = import(SDK_NAME);
    loaded = { key, promise };
    promise.catch(() => { if (loaded?.promise === promise) loaded = null; });
    return promise;
  }
  const have = installedSdk(root, CLAUDE_SDK_PIN);
  if (!have) {
    if (!fetch || !claudeSdkConsented(env)) return Promise.reject(new ClaudeSdkMissingError(t('claudeSdk.missing', { version: CLAUDE_SDK_PIN.version })));
    return ensureClaudeSdk({ env }).then(
      () => loadClaudeSdk({ fetch: false, env }),
      (err) => { throw new ClaudeSdkMissingError(claudeSdkErrorMessage(err), { kind: err?.kind ?? null, cause: err }); },
    );
  }
  const promise = importInstalledSdk(have.entry, root).then((api) => { markUsed(have.dir); return api; });
  loaded = { key, promise };
  promise.catch(() => { if (loaded?.promise === promise) loaded = null; });
  return promise;
}

/** 試験だけが使う: 読んだものを忘れる・状態を戻す */
export function resetClaudeSdkForTest() {
  loaded = null;
  state.job = null; state.progress = null; state.error = null;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

// ---------------------------------------------------------------- 起動のあと

/** 片付けを始めるまでの待ち（起動の直後は、前の版の Pleiad がまだ古い版を読んでいることがある） */
export const CLEANUP_DELAY_MS = 5 * 60_000;

/**
 * サーバーの起動のあとに呼ぶ。配布物で同意済み（前の版から Claude を使っていた人は、みなし同意）なのに固定の版が無ければ
 * （更新で版が変わり、切り替えの前に取れなかった・入れ直した）裏で取る。取れなければ状態に残り、画面から再試行できる。
 * 少し待ってから古い版と展開の途中を片付ける。開発（local）では何もしない
 */
export function startClaudeSdkMaintenance({ env = process.env, delayMs = CLEANUP_DELAY_MS } = {}) {
  if (claudeSdkSource(env) !== 'download') return () => {};
  const root = claudeSdkRoot(env);
  if (claudeSdkConsented(env) && !installedSdk(root, CLAUDE_SDK_PIN)) ensureClaudeSdk({ env }).catch(() => { /* 状態に残す。画面から再試行できる */ });
  const timer = setTimeout(() => {
    cleanupSdk({ root, pin: CLAUDE_SDK_PIN })
      .then((removed) => { if (removed.length) console.log(`[claude-sdk] removed ${removed.join(', ')}`); })
      .catch((err) => console.warn(`[claude-sdk] cleanup failed: ${err?.message ?? err}`));
  }, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
