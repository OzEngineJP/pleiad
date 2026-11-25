// ADR 0350（段 2a の前に満たすこと）の試験 T1〜T7 を、使い捨てのログインと別のデータの場所で流す。手で流す試験（npm test には入らない）。
//
//   node tests/manual/own-dir-trial.mjs setup [--root <dir>]       試験の場所を作り、使い捨てのログインの手順を出す
//   node tests/manual/own-dir-trial.mjs status                      ログインの有無・CLI/SDK の版・リンクの状態を出す（何も書かない）
//   node tests/manual/own-dir-trial.mjs t1 | t2 | t4 | t7           ログインが要る試験（2 アカウントが要るのは t7 だけ。ほかは A だけ）
//   node tests/manual/own-dir-trial.mjs t5 | t6                     ログイン不要。偽の資格情報で、リンクの権限・アカウント削除を見る
//   node tests/manual/own-dir-trial.mjs t3 start | drive | check | stop   別の Pleiad（別のデータの場所）を立て、使用量の取得を繰り返す
//   node tests/manual/own-dir-trial.mjs selftest                    偽の CLI で、この試験自身の部品（守り・伏せ字・判定）を確かめる
//   node tests/manual/own-dir-trial.mjs all                         ログイン不要の t5・t6 と、ログイン済みなら t1・t2・t4・t7
//
// 共通のオプション: --root <dir>（既定 <一時フォルダー>/ply-own-dir-trial）・--model <名前>（既定 haiku）・--turn-timeout <ms>（既定 120000）・
//   --rounds <回数>（t2 は既定 20、t7 は既定 3）・--minutes / --every <秒>（t3 drive。既定 30 分・20 秒おき）。
//
// 守ること:
//   - 試験の場所（root）は、本物のデータ（~/.claude・~/.agent-host・CLAUDE_CONFIG_DIR・AGENT_HOST_DATA）と重ならない場所だけ許す（assertSafeRoot）。
//     setup が置く印のファイル（.own-dir-trial-root）の無い場所には、setup 以外は何も書かない。
//   - 使うログインは、人が使い捨てのアカウントで `claude auth login` したもの（setup が手順を出す）。本物のアカウントのログインを使わない・写さない。
//   - 子の CLI の env には、親のトークン・設定フォルダー（ANTHROPIC_*・CLAUDE_*・AGENT_HOST_* など）を渡さない。渡すのは試験の CLAUDE_CONFIG_DIR だけ
//     （b1 の比較の子だけ、使い捨てのアクセス用トークンを CLAUDE_CODE_OAUTH_TOKEN に入れる）。
//   - トークンの値は表示・保存しない（出すのは sha256 の頭 10 文字と、あるか・ないか）。出力は sk-ant-… と読み込んだトークンを伏せ字にする。
//   - 資格情報の期限を書き換えるのは、root の中の使い捨てのファイルだけ（backdate）。
//
// 結果: <root>/results/<試験>.json と標準出力。判定は PASS / FAIL / INCONCLUSIVE（条件が揃わず結論が出ない）/ BLOCKED（人の作業が先に要る）。
// 終了コード: 0 = すべて PASS、1 = FAIL あり、3 = FAIL は無いが PASS でないものがある。
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readClaudeUsage, claudeUsageAuthFailure } from '../../core/backends/claude-usage.mjs';
import { createClaudeAccounts } from '../../core/claude-accounts.mjs';
import { createClaudeConnectorsWiring, VERIFIED_VERSIONS } from '../../core/claude-connectors-auth.mjs';
import { ensureClaudeOwnDirLinks, OWN_DIR, unlinkClaudeOwnDirLinks, withClaudeUsageDir } from '../../core/claude-own-dir.mjs';
import { claudeSdkVersion, loadClaudeSdk } from '../../core/claude-sdk.mjs';
import { claudeExecutable, cliCommand } from '../../core/cli-installation.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';
import { open as openWs } from '../lib/ws-client.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINAL = { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR, agentHostData: process.env.AGENT_HOST_DATA };
const KEEP_ENV = new Set(['AGENT_HOST_CLAUDE_BIN', 'AGENT_HOST_CLAUDE_SDK']);
const SCRUB_ENV = /^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|AGENT_HOST_|PLEIAD_|PLY_|AGENT_BROWSER_)/i;
const PROMPT = 'Reply with exactly the single word OK.';
const LAUNCHED = /http:\/\/(localhost|[\d.]+|\[[\da-f:]+\]):(\d+)\/\?token=(\S+)/i;
// 更新用トークンの取り合い（core/backends/claude-usage.mjs の USAGE_REFRESH_CONTENTION と同じ文言。selftest が claudeUsageAuthFailure と食い違わないか見る）
const CONTENTION = /another Claude Code process is (?:refreshing|holding the refresh lock)|OAuthRefreshLock(?:Timeout|Contended)Error/i;
const REVOKED = /token (?:has been )?revoked|access token has been revoked/i;
const RATE_LIMITED = /\b429\b|rate[ _-]?limit|overloaded/i;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);

// ---------------------------------------------------------------- 伏せ字・env・守り

const secrets = new Set();
const watch = value => { if (typeof value === 'string' && value.length >= 8) secrets.add(value); return value; };
export function redact(text) {
  let out = String(text ?? '').replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]').replace(/(token=)[^\s&]+/gi, '$1[redacted]');
  for (const value of secrets) out = out.split(value).join('[token]');
  return out;
}

/** 子の CLI に渡す env。親のトークン・設定フォルダー・Pleiad の変数は渡さない。渡すのは試験の CLAUDE_CONFIG_DIR（と b1 の比較の子のトークン）だけ */
export function childEnv(configDir, token = null, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !SCRUB_ENV.test(key)) env[key] = value;
  env.CLAUDE_CONFIG_DIR = configDir;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

function scrubProcessEnv() {
  for (const key of Object.keys(process.env)) if (SCRUB_ENV.test(key) && !KEEP_ENV.has(key)) delete process.env[key];
}

const within = (inner, outer) => {
  const key = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const a = key(inner), b = key(outer);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

/** 本物のデータ・ホーム・ドライブの根と重なる場所を断る。重ならなければ解決した絶対パスを返す */
export function assertSafeRoot(root, { home = os.homedir(), original = ORIGINAL } = {}) {
  let resolved = path.resolve(root);
  try { resolved = fsSync.realpathSync(resolved); } catch { /* まだ無い */ }
  if (path.parse(resolved).root === resolved) throw new Error(`root がドライブの根: ${resolved}`);
  if (within(home, resolved)) throw new Error(`root がホームか、その上: ${resolved}`);
  const guarded = [path.join(home, '.claude'), path.join(home, '.agent-host'), original.claudeConfigDir, original.agentHostData].filter(Boolean);
  for (const g of guarded) {
    if (within(resolved, g) || within(g, resolved)) throw new Error(`root が本物のデータの場所と重なる: ${resolved}（${g}）`);
  }
  return resolved;
}

function assertInside(root, target) {
  if (!within(target, root) || path.resolve(target) === path.resolve(root)) throw new Error(`root の外は触らない: ${target}`);
}

// ---------------------------------------------------------------- 場所・結果

const ACCOUNTS = { A: 'acct-a1a1a1a1a1a1', B: 'acct-b2b2b2b2b2b2' };
export function layout(root) {
  const usage = path.join(root, 'data', 'claude-usage');
  return {
    root, shared: path.join(root, 'shared'), data: path.join(root, 'data'), usage, b1: path.join(root, 'b1-config'), work: path.join(root, 'work'),
    results: path.join(root, 'results'), marker: path.join(root, '.own-dir-trial-root'),
    A: { id: ACCOUNTS.A, dir: path.join(usage, ACCOUNTS.A) }, B: { id: ACCOUNTS.B, dir: path.join(usage, ACCOUNTS.B) },
    pleiadData: path.join(root, 'pleiad-data'), t3Shared: path.join(root, 'shared-t3'), t3: path.join(root, 'pleiad-instance.json'),
    t3Log: path.join(root, 'pleiad.log'), t3Polls: path.join(root, 'results', 't3-polls.jsonl'),
  };
}

const rank = verdict => verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 2 : 1;

async function record(ctx, name, { verdict, summary, details = {}, steps = [] }) {
  const out = { test: name, verdict, summary, at: new Date().toISOString(), steps, details };
  if (!ctx.quiet) {
    await fsp.mkdir(ctx.l.results, { recursive: true });
    await fsp.writeFile(path.join(ctx.l.results, `${name}.json`), redact(JSON.stringify(out, null, 2)) + '\n');
  }
  console.log(redact(`${verdict.padEnd(12)} ${name}: ${summary}`));
  for (const step of steps) console.log(redact(`    - ${step}`));
  ctx.verdicts.push(verdict);
  return out;
}

const blocked = (ctx, name, summary, steps) => record(ctx, name, { verdict: 'BLOCKED', summary, steps });

function loginSteps(l, which) {
  const dir = l[which].dir;
  return [
    `${which} に使い捨ての Claude アカウント（実アカウントではないもの。Claude Code が使えるプラン）でログインする。ブラウザーが開くので、人が操作する。`,
    `PowerShell: $env:CLAUDE_CONFIG_DIR = '${dir}'; claude auth login --claudeai; Remove-Item Env:CLAUDE_CONFIG_DIR`,
    `bash: CLAUDE_CONFIG_DIR='${dir}' claude auth login --claudeai`,
    `済んだら node tests/manual/own-dir-trial.mjs status で ${which} が「ログイン済み」になることを確かめる。`,
  ];
}

// ---------------------------------------------------------------- 資格情報（値は出さない）

async function readOauth(dir) {
  try {
    const oauth = JSON.parse(await fsp.readFile(path.join(dir, '.credentials.json'), 'utf8'))?.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') return null;
    watch(oauth.accessToken); watch(oauth.refreshToken);
    return oauth;
  } catch { return null; }
}

async function loginState(dir) {
  const oauth = await readOauth(dir);
  return {
    ok: Boolean(oauth?.accessToken && oauth?.refreshToken), expiresAt: oauth?.expiresAt ?? null,
    access: oauth?.accessToken ? sha(oauth.accessToken) : null, refresh: oauth?.refreshToken ? sha(oauth.refreshToken) : null,
  };
}

/** 使い捨ての資格情報の期限を過去にして、次に使う CLI に更新させる。root の中のファイルだけ */
async function backdate(root, dir) {
  assertInside(root, dir);
  const file = path.join(dir, '.credentials.json');
  const json = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (!json?.claudeAiOauth) throw new Error('claudeAiOauth が無い');
  json.claudeAiOauth.expiresAt = Date.now() - 60_000;
  await fsp.writeFile(file, JSON.stringify(json), { mode: 0o600 });
}

// ---------------------------------------------------------------- 保持中の CLI（Pleiad と同じ形: 入力を開けたまま、ターンごとに user を流す）

function inputQueue() {
  const items = [];
  let wake = null, closed = false;
  return {
    push(message) { items.push(message); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise(resolve => { wake = resolve; });
        wake = null;
      }
    },
  };
}

/** ターンの失敗を種類にする。contention・rate-limited は一時的、revoked・auth はログインの問題 */
export function classifyTurn({ texts = [], errors = [], text = null, timeout = false, ended = false }) {
  const error = redact(errors.join(' | '));
  const body = text ?? texts.join('');
  let kind = 'ok';
  if (timeout) kind = 'timeout';
  else if (ended && !body) kind = 'ended';
  else if (CONTENTION.test(error)) kind = 'contention';
  else if (REVOKED.test(error)) kind = 'revoked';
  else if (error && claudeUsageAuthFailure(error)) kind = 'auth';
  else if (error && RATE_LIMITED.test(error)) kind = 'rate-limited';
  else if (error || !body) kind = 'error';
  return { kind, ok: kind === 'ok', text: redact(body).slice(0, 200), error: error.slice(0, 400) };
}

async function openHeld({ configDir, token = null, cwd, model, timeoutMs, persist = false, resume = null, skills = false }) {
  const { query } = await loadClaudeSdk();
  const input = inputQueue();
  const state = { init: null, sessionId: null, pending: null, ended: false, pumpError: null, stderr: [] };
  const settle = extra => {
    const cur = state.pending;
    if (!cur) return;
    state.pending = null;
    clearTimeout(cur.timer);
    cur.resolve({ ...classifyTurn({ ...cur, ...extra }), init: state.init, sessionId: state.sessionId });
  };
  const q = query({ prompt: input, options: {
    pathToClaudeCodeExecutable: claudeExecutable(), env: childEnv(configDir, token), cwd, model,
    settingSources: ['user'], mcpServers: {}, settings: { disableAllHooks: true }, persistSession: persist,
    ...(skills ? { skills: 'all' } : { tools: [] }), ...(resume ? { resume } : {}),
    stderr: line => { state.stderr.push(redact(line)); if (state.stderr.length > 30) state.stderr.shift(); },
  } });
  const onMessage = m => {
    if (m.type === 'system' && m.subtype === 'init') {
      state.sessionId = m.session_id ?? state.sessionId;
      state.init = { model: m.model ?? null, skills: Array.isArray(m.skills) ? m.skills : [] };
    }
    if (m.session_id) state.sessionId = m.session_id;
    const cur = state.pending;
    if (!cur) return;
    if (m.type === 'system' && m.subtype === 'api_retry' && m.error) cur.errors.push(`retry ${m.error_status ?? ''} ${m.error}`);
    if (m.type === 'assistant') {
      const text = (m.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (m.error) cur.errors.push(`assistant:${m.error} ${text}`);
      else cur.texts.push(text);
    }
    if (m.type === 'result') {
      if (m.is_error || m.subtype !== 'success') cur.errors.push(`result:${m.subtype} ${m.result ?? (m.errors ?? []).join(' ')}`);
      settle({ text: m.is_error ? null : (m.result ?? null) });
    }
  };
  const pump = (async () => {
    try { for await (const m of q) onMessage(m); } catch (error) { state.pumpError = redact(error?.message ?? error); }
    state.ended = true;
    if (state.pending && state.pumpError) state.pending.errors.push(state.pumpError);
    if (state.pending && state.stderr.length) state.pending.errors.push(`stderr: ${state.stderr.slice(-3).join(' / ')}`);
    settle({ ended: true });
  })();
  return {
    state, q, input, pump,
    turn(text) {
      return new Promise(resolve => {
        if (state.ended) return resolve({ ...classifyTurn({ ended: true, errors: [state.pumpError ?? 'process ended'] }), init: state.init, sessionId: state.sessionId });
        const cur = { texts: [], errors: [], resolve, timer: setTimeout(() => settle({ timeout: true }), timeoutMs) };
        state.pending = cur;
        input.push({ type: 'user', session_id: state.sessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content: text } });
      });
    },
    async close() {
      input.close();
      try { q.close(); } catch { /* 閉じ済み */ }
      await Promise.race([pump, sleep(5000)]);
    },
  };
}

const oneShot = async (ctx, options, text = PROMPT) => {
  const held = await openHeld({ cwd: ctx.l.work, model: ctx.model, timeoutMs: ctx.turnTimeout, ...options });
  try { return await held.turn(text); } finally { await held.close(); }
};

const readUsageKind = async (ctx, dir) => {
  try {
    const quota = await ctx.deps.readUsage({ configDir: dir });
    if (quota?.windows?.length || quota?.plan) return { kind: 'ok', ok: true, windows: quota.windows?.length ?? 0 };
    return { kind: 'error', ok: false, error: redact(`reason=${quota?.reason ?? '?'} ${quota?.message ?? ''}`).slice(0, 200) };
  } catch (error) {
    const text = redact(error?.message ?? error);
    const kind = CONTENTION.test(text) ? 'contention' : claudeUsageAuthFailure(error) ? 'auth' : RATE_LIMITED.test(text) ? 'rate-limited' : 'error';
    return { kind, ok: false, error: text.slice(0, 300) };
  }
};

async function prepareLinks(ctx, acct) {
  await fsp.mkdir(acct.dir, { recursive: true });
  return withClaudeUsageDir(acct.dir, () => ensureClaudeOwnDirLinks(acct.dir, ctx.l.shared));
}

// ---------------------------------------------------------------- 判定（純粋な関数。selftest が表で確かめる）

export function t1Verdict({ baseline, usage, refreshed, second, loginKept }) {
  if (!baseline.own.ok) return ['INCONCLUSIVE', `専用フォルダ方式の保持中 CLI が、最初のターンから失敗した（${baseline.own.kind}）`];
  if (!baseline.ctl.ok) return ['INCONCLUSIVE', `b1 の比較の CLI が、最初のターンから失敗した（${baseline.ctl.kind}）。比べる土台が無い`];
  if (!usage.ok) return ['INCONCLUSIVE', `別の CLI の使用量の読み取りが失敗した（${usage.kind}）。更新を起こせなかった`];
  if (!refreshed) return ['INCONCLUSIVE', '使用量の読み取りの後も資格情報が変わらない。トークンの更新が起きなかった'];
  if (!loginKept) return ['FAIL', '更新の後、ログイン情報（アクセス用・更新用トークン）が残っていない'];
  if (!second.own.ok) return ['FAIL', `別の CLI が更新した後、保持中の専用フォルダ方式の CLI が次のターンで失敗した（${second.own.kind}）`];
  if (second.ctl.ok || second.ctl.kind !== 'revoked') {
    return ['INCONCLUSIVE', `専用フォルダ方式は通ったが、b1 の比較が OAuth token revoked にならなかった（${second.ctl.kind}）。サーバー側の失効が再現していない`];
  }
  return ['PASS', '別の CLI の更新の後も、保持中の専用フォルダ方式の CLI は再起動なしで次のターンが通った。b1 の比較は OAuth token revoked で止まった'];
}

export function t2Verdict({ rounds, final }) {
  const bad = rounds.filter(r => r.failed.length || !r.loginKept || (r.retry && !r.retry.ok));
  const refreshed = rounds.filter(r => r.refreshed).length;
  const rateLimited = rounds.filter(r => r.kinds.includes('rate-limited')).length;
  const contention = rounds.reduce((n, r) => n + r.kinds.filter(k => k === 'contention').length, 0);
  if (bad.length) return ['FAIL', `${rounds.length} 回のうち ${bad.length} 回で、ログイン切れ・失効・失敗が残った（回: ${bad.map(r => r.round).join(',')}）`];
  if (!final.ok) return ['FAIL', `繰り返しの後の単独のターンが失敗した（${final.kind}）`];
  if (rateLimited) return ['INCONCLUSIVE', `${rateLimited} 回で使用量・呼び出しの上限に当たった。やり直す`];
  if (refreshed < Math.ceil(rounds.length / 2)) return ['INCONCLUSIVE', `更新が起きたのは ${refreshed}/${rounds.length} 回だけ。期限を過去にしても更新されない回が多い`];
  return ['PASS', `${rounds.length} 回の同時更新でログインを失わなかった（更新 ${refreshed} 回・ロックの競合 ${contention} 件はいずれも次の試行で通った）`];
}

// ---------------------------------------------------------------- T1 失効からの回復

async function runT1(ctx) {
  const { l } = ctx;
  if (!(await loginState(l.A.dir)).ok) return blocked(ctx, 't1', 'アカウント A が未ログイン', loginSteps(l, 'A'));
  const moves = await prepareLinks(ctx, l.A);
  const before = await readOauth(l.A.dir);
  const own = await openHeld({ configDir: l.A.dir, cwd: l.work, model: ctx.model, timeoutMs: ctx.turnTimeout });
  const ctl = await openHeld({ configDir: l.b1, token: before.accessToken, cwd: l.work, model: ctx.model, timeoutMs: ctx.turnTimeout });
  try {
    const baseline = { own: await own.turn(PROMPT), ctl: await ctl.turn(PROMPT) };
    if (!baseline.own.ok || !baseline.ctl.ok) {
      const [verdict, summary] = t1Verdict({ baseline, usage: { ok: true }, refreshed: true, second: {}, loginKept: true });
      return record(ctx, 't1', { verdict, summary, details: { baseline } });
    }
    await backdate(l.root, l.A.dir);
    const fp = (await loginState(l.A.dir)).access;
    const usage = await readUsageKind(ctx, l.A.dir);
    const after = await loginState(l.A.dir);
    const second = { own: await own.turn(PROMPT), ctl: await ctl.turn(PROMPT) };
    const [verdict, summary] = t1Verdict({ baseline, usage, refreshed: Boolean(after.access && after.access !== fp), second, loginKept: (await loginState(l.A.dir)).ok });
    return record(ctx, 't1', { verdict, summary, details: { moves, tokenFingerprint: { before: fp, afterUsageRead: after.access }, usage, baseline, second } });
  } finally { await ctl.close(); await own.close(); }
}

// ---------------------------------------------------------------- T2 同時更新の繰り返し

async function runT2(ctx) {
  const { l } = ctx;
  if (!(await loginState(l.A.dir)).ok) return blocked(ctx, 't2', 'アカウント A が未ログイン', loginSteps(l, 'A'));
  await prepareLinks(ctx, l.A);
  const total = Number(ctx.rounds ?? 20);
  const rounds = [];
  for (let round = 1; round <= total; round++) {
    await backdate(l.root, l.A.dir);
    const fp = (await loginState(l.A.dir)).access;
    const results = await Promise.all([
      oneShot(ctx, { configDir: l.A.dir }), oneShot(ctx, { configDir: l.A.dir }), oneShot(ctx, { configDir: l.A.dir }), readUsageKind(ctx, l.A.dir),
    ]);
    const kinds = results.map(r => r.kind);
    const after = await loginState(l.A.dir);
    const failed = kinds.filter(k => !['ok', 'contention', 'rate-limited'].includes(k));
    // 一時的な失敗（ロックの競合・上限）があった回は、次の試行で通ることを見る
    const retry = kinds.some(k => k !== 'ok') ? await oneShot(ctx, { configDir: l.A.dir }) : null;
    rounds.push({ round, kinds, failed, refreshed: Boolean(after.access && after.access !== fp), loginKept: after.ok, retry: retry && { kind: retry.kind, ok: retry.ok } });
    console.log(`    t2 回 ${round}/${total}: ${kinds.join(',')}${retry ? ` → やり直し ${retry.kind}` : ''}`);
  }
  const final = await oneShot(ctx, { configDir: l.A.dir });
  const [verdict, summary] = t2Verdict({ rounds, final });
  return record(ctx, 't2', { verdict, summary, details: { rounds, final: { kind: final.kind } } });
}

// ---------------------------------------------------------------- T4 b1 の会話を専用フォルダ方式で再開する

async function runT4(ctx) {
  const { l } = ctx;
  if (!(await loginState(l.A.dir)).ok) return blocked(ctx, 't4', 'アカウント A が未ログイン', loginSteps(l, 'A'));
  await prepareLinks(ctx, l.A);
  const token = (await readOauth(l.A.dir)).accessToken;
  const word = `kiwi${crypto.randomBytes(3).toString('hex')}`;
  // b1 と同じ形: 共有フォルダ（試験用）を設定フォルダーにし、アクセス用トークンを env で渡す。会話は共有の projects/ に残る
  const first = await oneShot(ctx, { configDir: l.shared, token, persist: true }, `Remember the secret word ${word}. Reply with exactly the single word OK.`);
  if (!first.ok || !first.sessionId) return record(ctx, 't4', { verdict: 'INCONCLUSIVE', summary: `b1 の形の最初のターンが失敗した（${first.kind}）`, details: { first } });
  const second = await oneShot(ctx, { configDir: l.A.dir, resume: first.sessionId, persist: true }, 'What was the secret word? Reply with only the word.');
  const remembered = second.ok && second.text.toLowerCase().includes(word);
  return record(ctx, 't4', {
    verdict: remembered ? 'PASS' : second.ok ? 'FAIL' : 'INCONCLUSIVE',
    summary: remembered ? 'b1 の形で作った会話を、専用フォルダ方式で同じ ID で再開でき、履歴が続いた'
      : second.ok ? '再開はできたが、履歴の内容（合言葉）が続いていない' : `専用フォルダ方式での再開のターンが失敗した（${second.kind}）`,
    details: { session: sha(first.sessionId), resumedKind: second.kind, resumedSameSession: second.sessionId === first.sessionId },
  });
}

// ---------------------------------------------------------------- T7 2 アカウントの同期スキルの干渉

async function listTree(dir, depth = 3) {
  const out = [];
  const walk = async (current, rel, left) => {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(name);
      if (entry.isDirectory() && left > 0) await walk(path.join(current, entry.name), name, left - 1);
    }
  };
  await walk(dir, '', depth);
  return out.sort();
}

async function syncedSnapshot(l) {
  return [...(await listTree(path.join(l.shared, 'skills', 'synced'))).map(n => `skills/synced/${n}`), ...(await listTree(path.join(l.shared, 'plugins'), 2)).map(n => `plugins/${n}`)];
}

async function runT7(ctx) {
  const { l } = ctx;
  const missing = ['A', 'B'].filter(which => !fsSync.existsSync(path.join(l[which].dir, '.credentials.json')));
  if (missing.length) return blocked(ctx, 't7', `アカウント ${missing.join('・')} が未ログイン`, [...missing.flatMap(which => loginSteps(l, which)), '両方のアカウントで、claude.ai の設定からスキル（またはプラグイン）を 1 つ以上有効にしておく（同期される項目が無いと干渉を見られない）。']);
  await prepareLinks(ctx, l.A); await prepareLinks(ctx, l.B);
  const total = Number(ctx.rounds ?? 3);
  const seen = new Set(), snapshots = [], disappeared = new Set(), turns = [], skills = { A: [], B: [] };
  const turn = async which => {
    const result = await oneShot(ctx, { configDir: l[which].dir, skills: true });
    const snapshot = await syncedSnapshot(l);
    for (const item of seen) if (!snapshot.includes(item)) disappeared.add(item);
    snapshot.forEach(item => seen.add(item));
    if (result.init?.skills) skills[which] = result.init.skills;
    turns.push({ which, kind: result.kind, items: snapshot.length });
    snapshots.push({ which, snapshot });
  };
  for (let i = 0; i < total; i++) { await turn('A'); await turn('B'); }
  const failedTurns = turns.filter(t => t.kind !== 'ok');
  const gone = [...disappeared];
  const [verdict, summary] = gone.length ? ['FAIL', `交互の会話で、同期された項目が ${gone.length} 件消えた（消した側の特定は details.snapshots を見る）`]
    : failedTurns.length ? ['INCONCLUSIVE', `${failedTurns.length} ターンが失敗した（${failedTurns.map(t => `${t.which}:${t.kind}`).join(',')}）`]
    : !seen.size ? ['INCONCLUSIVE', '共有の skills/synced・plugins に同期された項目が一度も現れなかった。claude.ai 側でスキルを有効にしてあるか確かめる']
    : ['PASS', `${turns.length} ターンの交互の会話で、同期された項目（${seen.size} 件）は消えなかった`];
  return record(ctx, 't7', { verdict, summary, details: { turns, disappeared: gone, skillsSeenByA: skills.A, skillsSeenByB: skills.B, snapshots } });
}

// ---------------------------------------------------------------- T5・T6（偽の資格情報。ログイン不要）

async function removeTree(root, target) {
  assertInside(root, target);
  // 中に専用フォルダのリンクがあるものは、先に外してから消す（リンクの先を巻き込まない）
  for (const parent of [path.join(target, 'data', 'claude-usage')]) {
    for (const name of await fsp.readdir(parent).catch(() => [])) await unlinkClaudeOwnDirLinks(path.join(parent, name));
  }
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function makeWorld(base, id, { platform = process.platform } = {}) {
  const shared = path.join(base, 'shared'), dataDir = path.join(base, 'data');
  const put = async (file, text) => { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, text); };
  await put(path.join(dataDir, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id, name: 'Trial' }] }));
  const accounts = createClaudeAccounts({ dataDir, secrets: { get: async () => null, delete: async () => {} }, cliConfig: path.join(base, '.claude.json') });
  const own = accounts.usageDir(id);
  const unexpected = () => { throw new Error('専用フォルダ方式が b1 の道へ入った'); };
  const wiring = createClaudeConnectorsWiring({
    dataDir, accounts, env: { CLAUDE_CONFIG_DIR: shared, PATH: process.env.PATH ?? '' }, home: base, platform, managedFiles: [],
    versions: async () => VERIFIED_VERSIONS[0], usage: { refresh: unexpected, guard: unexpected }, probe: unexpected,
  });
  await put(path.join(own, 'ply-usage-login.json'), '{}');
  await put(path.join(own, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3_600_000 } }));
  // 共有側の内容。skills/synced は共有にも専用にもある（開発 PC の 3 アカウントと同じ重なり方）
  await put(path.join(shared, 'projects', 'p1', 's.jsonl'), 'shared-session\n');
  await put(path.join(shared, 'skills', 'synced', 'shared-skill', 'SKILL.md'), 'shared skill\n');
  await put(path.join(shared, 'skills', 'keep-me', 'SKILL.md'), 'keep\n');
  await put(path.join(shared, 'plugins', 'installed.json'), '{"plugins":[]}\n');
  await put(path.join(shared, 'settings.json'), '{"theme":"dark"}\n');
  // 専用フォルダ側の内容: 重なる synced（退避される）と、重ならない項目（共有へ移る）
  await put(path.join(own, 'skills', 'synced', 'own-skill', 'SKILL.md'), 'own skill\n');
  await put(path.join(own, 'skills', 'own-only', 'SKILL.md'), 'own only\n');
  return { accounts, wiring, own, shared, id, account: { id, name: 'Trial' } };
}

async function entryKinds(own) {
  const kinds = {};
  for (const name of ['projects', 'skills', 'plugins', 'settings.json']) {
    const info = await fsp.lstat(path.join(own, name)).catch(() => null);
    kinds[name] = !info ? 'absent' : info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : 'file';
  }
  return kinds;
}

async function withInjectedEperm(run) {
  const real = fsp.symlink;
  fsp.symlink = async (target, file, type) => {
    if (type === 'file') throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM', syscall: 'symlink' });
    return real.call(fsp, target, file, type);
  };
  try { return await run(); } finally { fsp.symlink = real; }
}

async function canMakeFileSymlink(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'probe-target');
  await fsp.writeFile(target, '');
  try { await fsp.symlink(target, path.join(dir, 'probe-link'), 'file'); return { ok: true }; }
  catch (error) { return { ok: false, code: error.code }; }
}

async function runT5(ctx) {
  const { l } = ctx;
  const base = path.join(l.root, 't5');
  await removeTree(l.root, base);
  const parts = [];
  // 1. EPERM を注入した（Windows のログインの権限が無い状態を、開発者モードがオンの PC でも再現する）
  const injected = await makeWorld(path.join(base, 'injected'), ACCOUNTS.A, { platform: 'win32' });
  const result = await withInjectedEperm(() => injected.wiring.inspect(injected.account, { mode: OWN_DIR, prepare: true }));
  const left = await entryKinds(injected.own);
  parts.push({ name: 'EPERM を注入', ok: result.kind === 'ownDirLinksWindows' && result.ok === false, kind: result.kind, message: redact(result.message ?? '').slice(0, 200), left });
  // 2. 失敗の後に権限が戻ったら、同じ準備が通ること（やり直しできる）
  const retry = await injected.wiring.inspect(injected.account, { mode: OWN_DIR, prepare: true });
  parts.push({ name: '権限が戻った後の再準備', ok: retry.ok === true, kind: retry.kind, left: await entryKinds(injected.own) });
  // 3. この PC が本当にファイル用リンクを作れないなら、注入なしで同じ準備をして実際の種類を見る
  const natural = await canMakeFileSymlink(path.join(base, 'probe'));
  let real = 'not-run';
  if (!natural.ok && process.platform === 'win32') {
    const world = await makeWorld(path.join(base, 'natural'), ACCOUNTS.A);
    const r = await world.wiring.inspect(world.account, { mode: OWN_DIR, prepare: true });
    real = { kind: r.kind, message: redact(r.message ?? '').slice(0, 200), left: await entryKinds(world.own) };
    parts.push({ name: '本物の権限なし（開発者モードがオフの Windows）', ok: r.kind === 'ownDirLinksWindows', kind: r.kind });
  }
  const failed = parts.filter(p => !p.ok);
  const [verdict, summary] = failed.length ? ['FAIL', `期待と違う: ${failed.map(p => `${p.name}（${p.kind}）`).join('、')}`]
    : real === 'not-run' ? ['INCONCLUSIVE', 'EPERM を注入した経路は合格。この PC はファイル用リンクを作れるので、開発者モードがオフの本物の Windows は未確認（別の PC か VM でこの t5 を流す）']
    : ['PASS', '本物の権限なしでも、準備は ownDirLinksWindows で止まり、権限が戻れば再準備が通った'];
  return record(ctx, 't5', { verdict, summary, details: { parts, realDevModeOff: real, thisPcCanMakeFileSymlink: natural.ok } });
}

const text = file => fsp.readFile(file, 'utf8').catch(() => null);

async function runT6(ctx) {
  const { l } = ctx;
  const base = path.join(l.root, 't6');
  await removeTree(l.root, base);
  const checks = [];
  const probe = await canMakeFileSymlink(path.join(base, 'probe'));
  if (!probe.ok) return record(ctx, 't6', { verdict: 'INCONCLUSIVE', summary: `この PC はファイル用リンクを作れない（${probe.code}）。開発者モードをオンにした PC で流す` });
  const verify = async (name, world, archivedFrom) => {
    const archived = (await fsp.readdir(path.dirname(world.own)).catch(() => [])).filter(n => n.startsWith('synced.pleiad-moved-'));
    const archivedText = archived.length ? await text(path.join(path.dirname(world.own), archived[0], 'own-skill', 'SKILL.md')) : null;
    checks.push({
      name, ownGone: !fsSync.existsSync(world.own),
      sharedProjects: await text(path.join(world.shared, 'projects', 'p1', 's.jsonl')) === 'shared-session\n',
      sharedSkills: await text(path.join(world.shared, 'skills', 'keep-me', 'SKILL.md')) === 'keep\n',
      sharedSynced: await text(path.join(world.shared, 'skills', 'synced', 'shared-skill', 'SKILL.md')) === 'shared skill\n',
      sharedPlugins: await text(path.join(world.shared, 'plugins', 'installed.json')) === '{"plugins":[]}\n',
      sharedSettings: (await text(path.join(world.shared, 'settings.json')))?.includes('"theme":"dark"') ?? false,
      movedToShared: archivedFrom === 'full' ? await text(path.join(world.shared, 'skills', 'own-only', 'SKILL.md')) === 'own only\n' : null,
      archivedKept: archivedFrom === 'full' ? archivedText === 'own skill\n' : null,
    });
  };
  // 1. 準備が済んだアカウントを削除する
  const full = await makeWorld(path.join(base, 'full'), ACCOUNTS.A);
  const prepared = await full.wiring.inspect(full.account, { mode: OWN_DIR, prepare: true });
  if (!prepared.ok) return record(ctx, 't6', { verdict: 'FAIL', summary: `準備が通らない（${prepared.kind}）`, details: { prepared } });
  const kinds = await entryKinds(full.own);
  await full.accounts.remove(full.id);
  await verify('準備済みのアカウントを削除', full, 'full');
  // 2. 準備が途中で止まった（リンクが一部だけある）アカウントを削除する
  const partial = await makeWorld(path.join(base, 'partial'), ACCOUNTS.B, { platform: 'win32' });
  const stopped = await withInjectedEperm(() => partial.wiring.inspect(partial.account, { mode: OWN_DIR, prepare: true }));
  const partialKinds = await entryKinds(partial.own);
  await partial.accounts.remove(partial.id);
  await verify('準備が途中で止まったアカウントを削除', partial, 'partial');
  const bad = checks.filter(c => Object.entries(c).some(([k, v]) => k !== 'name' && v === false));
  return record(ctx, 't6', {
    verdict: bad.length ? 'FAIL' : 'PASS',
    summary: bad.length ? `アカウント削除で共有のデータか退避が失われた（${bad.map(c => c.name).join('、')}）` : 'アカウントを削除しても、共有の projects・skills・plugins・settings.json と退避した項目は残った（準備済み・途中で止まった両方）',
    details: { preparedKinds: kinds, stoppedKind: stopped.kind, partialKinds, checks },
  });
}

// ---------------------------------------------------------------- T3 別の Pleiad で使用量の取得を繰り返す

const readJson = async file => { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; } };

async function instanceAlive(instance) {
  if (!instance?.port) return false;
  try { const ws = await openWs({ port: instance.port, token: instance.token }); ws.close(); return true; } catch { return false; }
}

async function t3Start(ctx) {
  const { l } = ctx;
  const existing = await readJson(l.t3);
  if (await instanceAlive(existing)) { console.log(`すでに起動中: port ${existing.port}（URL は ${path.join(l.root, 'pleiad-url.txt')}）`); return; }
  await fsp.mkdir(l.pleiadData, { recursive: true });
  await fsp.mkdir(l.t3Shared, { recursive: true });
  const token = crypto.randomBytes(12).toString('hex');
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUB_ENV.test(key) || KEEP_ENV.has(key)));
  const env = {
    ...base, AGENT_HOST_DATA: l.pleiadData, AGENT_HOST_PORT: '0', AGENT_HOST_TOKEN: token, CLAUDE_CONFIG_DIR: l.t3Shared,
    AGENT_HOST_BACKENDS: 'claude', AGENT_HOST_GIT_SNAPSHOTS: 'off', AGENT_HOST_WORKTREES: 'off',
    AGENT_HOST_AGENT_BROWSER_PRESTART: 'off', AGENT_HOST_HOLDER_IDLE_MS: '5000', AGENT_HOST_LOCALE: 'ja', PLEIAD_SCAN_HOME: path.join(l.pleiadData, 'scan-home'),
  };
  const offset = fsSync.existsSync(l.t3Log) ? fsSync.statSync(l.t3Log).size : 0;
  const fd = fsSync.openSync(l.t3Log, 'a');
  const child = spawn(process.execPath, [path.join(REPO, 'core', 'server.mjs')], { cwd: REPO, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  let exited = false;
  child.once('exit', () => { exited = true; });
  for (let waited = 0; waited < 90_000; waited += 500) {
    await sleep(500);
    const log = (await fsp.readFile(l.t3Log, 'utf8')).slice(offset);
    const m = LAUNCHED.exec(log);
    if (m) {
      await fsp.writeFile(l.t3, JSON.stringify({ pid: child.pid, port: Number(m[2]), token: m[3], startedAt: new Date().toISOString() }));
      await fsp.writeFile(path.join(l.root, 'pleiad-url.txt'), `http://127.0.0.1:${m[2]}/?token=${m[3]}\n`);
      console.log(`別の Pleiad を起動した（pid ${child.pid}、port ${m[2]}、データ ${l.pleiadData}）。URL は ${path.join(l.root, 'pleiad-url.txt')} にある（ブラウザーで開く）。`);
      return;
    }
    if (exited) break;
  }
  throw new Error(`別の Pleiad が起動しなかった。ログ: ${l.t3Log}`);
}

const summarizeUsage = result => {
  const rows = result?.quota?.accounts ?? result?.accounts ?? [];
  return { reason: result?.reason ?? result?.quota?.reason ?? null, accounts: rows.map(a => ({ name: a.name ?? null, reason: a.reason ?? null, windows: Array.isArray(a.windows) ? a.windows.length : null })) };
};

async function instanceCreds(l) {
  const out = [];
  const root = path.join(l.pleiadData, 'claude-usage');
  for (const name of await fsp.readdir(root).catch(() => [])) {
    if (name.includes('.pleiad-moved-')) continue;
    out.push({ account: name, ...await loginState(path.join(root, name)) });
  }
  return out;
}

async function t3Drive(ctx) {
  const { l } = ctx;
  const instance = await readJson(l.t3);
  if (!(await instanceAlive(instance))) return blocked(ctx, 't3', '別の Pleiad が起動していない', ['node tests/manual/own-dir-trial.mjs t3 start']);
  if (!(await instanceCreds(l)).length) {
    return blocked(ctx, 't3', '別の Pleiad に使い捨てのアカウントが無い', [
      `ブラウザーで ${path.join(l.root, 'pleiad-url.txt')} の URL を開く（この Pleiad は試験用の別のデータ置き場）。`,
      '設定で Claude のアカウントとして、使い捨てのアカウントを追加し、使用量の認可（ログイン）まで済ませる。実アカウントは使わない。',
      '設定 › 外部 MCP で、そのアカウントのコネクターをオンにし、「専用フォルダ方式（ベータ）」をオンにする。',
      '続けて t3 drive を流す。同時に、そのアカウントで長めの会話（期限をまたぐ 1 時間以上）を、別の会話を並べて 2 本以上走らせておく。',
    ]);
  }
  const ws = await openWs({ port: instance.port, token: instance.token });
  const end = Date.now() + Number(ctx.minutes ?? 30) * 60_000;
  let last = null;
  console.log(`使用量の取得を ${ctx.every} 秒おきに ${ctx.minutes} 分続ける（記録: ${l.t3Polls}）`);
  while (Date.now() < end) {
    const started = Date.now();
    let row;
    try { row = { ok: true, ...summarizeUsage(await ws.cmd('providerUsage', { backend: 'claude' }, { ms: 90_000 })) }; }
    catch (error) { row = { ok: false, error: redact(error?.message ?? error).slice(0, 300) }; }
    row.at = new Date().toISOString();
    row.ms = Date.now() - started;
    row.creds = await instanceCreds(l);
    const changed = last && row.creds.some(c => last.find(p => p.account === c.account)?.access !== c.access);
    row.refreshed = Boolean(changed);
    last = row.creds;
    await fsp.mkdir(l.results, { recursive: true });
    await fsp.appendFile(l.t3Polls, redact(JSON.stringify(row)) + '\n');
    console.log(`    ${row.at} ${row.ok ? 'ok' : 'NG'} ${row.ms}ms${row.refreshed ? ' 更新あり' : ''}${row.error ? ` ${row.error}` : ''}`);
    await sleep(Number(ctx.every ?? 20) * 1000);
  }
  ws.close();
}

const AUTH_LINE = /revoked|authentication_failed|invalid_grant|please run \/login|OAuth (?:session|access token) (?:expired|has expired)|failed to authenticate/i;

async function t3Check(ctx) {
  const { l } = ctx;
  const polls = (await text(l.t3Polls))?.split('\n').filter(Boolean).map(line => JSON.parse(line)) ?? [];
  const logLines = ((await text(l.t3Log)) ?? '').split('\n');
  const authLines = logLines.filter(line => AUTH_LINE.test(line)).map(line => redact(line).slice(0, 200));
  const problems = polls.filter(p => !p.ok || p.accounts?.some(a => a.reason));
  const refreshes = polls.filter(p => p.refreshed).length;
  const [verdict, summary] = authLines.length ? ['FAIL', `別の Pleiad のログに認証の失敗が ${authLines.length} 行ある`]
    : problems.some(p => /revoked|auth|login/i.test(JSON.stringify(p))) ? ['FAIL', `使用量の取得の ${problems.length} 回に、認証の問題の印があった`]
    : polls.length < 3 ? ['INCONCLUSIVE', `使用量の取得の記録が ${polls.length} 回しかない。t3 drive を流す`]
    : !refreshes ? ['INCONCLUSIVE', 'トークンの更新が一度も起きなかった。期限をまたぐまで（約 8 時間おき）続けるか、t1・t2 で更新を起こす']
    : ['PASS', `使用量の取得 ${polls.length} 回、更新 ${refreshes} 回の間、認証の失敗は無かった（会話側の確認は人が画面で見る: 手順 4 の最後）`];
  return record(ctx, 't3', { verdict, summary, details: { polls: polls.length, problems: problems.length, refreshes, authLines: authLines.slice(0, 10) } });
}

async function t3Stop(ctx) {
  const instance = await readJson(ctx.l.t3);
  if (!(await instanceAlive(instance))) { console.log('止める対象が無い（起動していない）'); await fsp.rm(ctx.l.t3, { force: true }); return; }
  // 自分が起こした 1 つだけ（トークンが合う接続が通った pid）を止める
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(instance.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(instance.pid, 'SIGTERM');
  await fsp.rm(ctx.l.t3, { force: true });
  console.log(`止めた（pid ${instance.pid}）`);
}

// ---------------------------------------------------------------- status・setup

function cliVersion() {
  const argv = cliCommand('claude');
  if (!argv) return null;
  const run = spawnSync(argv[0], [...argv.slice(1), '--version'], { encoding: 'utf8', env: childEnv(os.tmpdir()), timeout: 15_000 });
  return run.status === 0 ? String(run.stdout).trim() : null;
}

async function status(ctx) {
  const { l } = ctx;
  console.log(`root: ${l.root}`);
  console.log(`OS: ${process.platform}${process.platform === 'darwin' ? '（専用フォルダ方式は止める方針。キーチェーンのため試験しない）' : ''}`);
  console.log(`Claude Code CLI: ${cliVersion() ?? '見つからない'} / SDK: ${claudeSdkVersion() ?? '不明'}（検証済み: ${VERIFIED_VERSIONS.map(v => `${v.cli}/${v.sdk}`).join(', ')}）`);
  for (const which of ['A', 'B']) {
    const state = await loginState(l[which].dir);
    console.log(`アカウント ${which}: ${state.ok ? `ログイン済み（アクセス用 ${state.access}・更新用 ${state.refresh}・期限 ${state.expiresAt ? new Date(state.expiresAt).toISOString() : '?'}）` : '未ログイン'}  リンク: ${JSON.stringify(await entryKinds(l[which].dir))}`);
  }
  const instance = await readJson(l.t3);
  console.log(`別の Pleiad（t3）: ${(await instanceAlive(instance)) ? `起動中（port ${instance.port}）` : '起動していない'}`);
  const results = await fsp.readdir(l.results).catch(() => []);
  for (const file of results.filter(f => /^t\d\.json$/.test(f))) {
    const r = await readJson(path.join(l.results, file));
    console.log(`結果 ${r?.test}: ${r?.verdict} — ${r?.summary}`);
  }
}

async function setup(ctx) {
  const { l } = ctx;
  for (const dir of [l.root, l.shared, l.usage, l.b1, l.work, l.results, l.A.dir, l.B.dir]) await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(l.marker, `${new Date().toISOString()}\n`);
  console.log(`試験の場所を作った: ${l.root}`);
  console.log('ログインが要る試験（t1・t2・t4・t7）の前に、使い捨てのアカウントで次を人が行う（t7 だけ A と B の 2 つ。ほかは A だけ）:');
  for (const which of ['A', 'B']) for (const step of loginSteps(l, which)) console.log(`  ${step}`);
}

// ---------------------------------------------------------------- selftest（偽の CLI。ログインも LLM も要らない）

async function selftest() {
  let failed = 0;
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'OK' : 'NG'}  ${name}${ok ? '' : ` ${detail}`}`); if (!ok) failed++; };
  const home = os.homedir();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ply-own-dir-trial-selftest-'));
  const original = { claudeConfigDir: path.join(tmp, 'real-config'), agentHostData: path.join(tmp, 'real-data') };
  const refuses = root => { try { assertSafeRoot(root, { home, original }); return false; } catch { return true; } };
  check('守り: ホーム・~/.claude・~/.agent-host・CLAUDE_CONFIG_DIR・AGENT_HOST_DATA・ドライブの根・その下を断る',
    [home, path.dirname(home), path.join(home, '.claude'), path.join(home, '.claude', 'x'), path.join(home, '.agent-host'), original.claudeConfigDir,
      path.join(original.agentHostData, 'y'), path.parse(tmp).root].every(refuses));
  check('守り: 一時フォルダーの下の別の場所は通す', !refuses(path.join(tmp, 'trial')));

  secrets.add('fake-access-token-1');
  check('伏せ字: sk-ant-…・読み込んだトークン・URL のトークンを出さない',
    !/sk-ant-|fake-access-token-1|abc123/.test(redact('a sk-ant-oat01-AbC_d-1 b fake-access-token-1 http://x/?token=abc123 c')));

  const polluted = { PATH: 'p', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/real', CLAUDECODE: '1', AGENT_HOST_DATA: '/real', PLEIAD_X: '1', PLY_Y: '1', KEEP_ME: 'v' };
  check('env: 親のトークン・設定フォルダー・Pleiad の変数を渡さず、試験の CLAUDE_CONFIG_DIR だけ渡す',
    JSON.stringify(childEnv('/own', null, polluted)) === JSON.stringify({ PATH: 'p', KEEP_ME: 'v', CLAUDE_CONFIG_DIR: '/own' })
    && childEnv('/own', 'tok', polluted).CLAUDE_CODE_OAUTH_TOKEN === 'tok');

  const kinds = [
    [{ errors: ['result:error_during_execution OAuth token revoked · Please run /login'] }, 'revoked'],
    [{ errors: ['Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh'] }, 'contention'],
    [{ errors: ['assistant:authentication_failed Failed to authenticate. API Error: 401 OAuth access token has expired.'] }, 'auth'],
    [{ errors: ['API Error: 429 rate limit'] }, 'rate-limited'], [{ timeout: true }, 'timeout'], [{ texts: ['OK'] }, 'ok'], [{ texts: [] }, 'error'],
  ];
  const wrong = kinds.filter(([input, kind]) => classifyTurn(input).kind !== kind).map(([, kind]) => kind);
  check('分類: revoked・contention・auth・rate-limited・timeout・ok・error', !wrong.length, wrong.join(','));
  check('分類: 競合の文言が core の claudeUsageAuthFailure と食い違わない（競合はログイン切れ扱いにしない）',
    CONTENTION.test('OAuthRefreshLockContendedError') && claudeUsageAuthFailure(new Error('OAuthRefreshLockContendedError')) === false);

  const ok = { ok: true, kind: 'ok' }, revoked = { ok: false, kind: 'revoked' };
  const base = { baseline: { own: ok, ctl: ok }, usage: ok, refreshed: true, second: { own: ok, ctl: revoked }, loginKept: true };
  const t1 = overrides => t1Verdict({ ...base, ...overrides })[0];
  check('T1 の判定: 比較が失効して専用が通れば PASS。専用が落ちれば FAIL。比較が再現しない・更新が起きない・土台が落ちるのは INCONCLUSIVE',
    t1({}) === 'PASS' && t1({ second: { own: revoked, ctl: revoked } }) === 'FAIL' && t1({ loginKept: false }) === 'FAIL'
    && t1({ second: { own: ok, ctl: ok } }) === 'INCONCLUSIVE' && t1({ refreshed: false }) === 'INCONCLUSIVE'
    && t1({ usage: { ok: false, kind: 'auth' } }) === 'INCONCLUSIVE' && t1({ baseline: { own: revoked, ctl: ok } }) === 'INCONCLUSIVE'
    && t1({ baseline: { own: ok, ctl: revoked } }) === 'INCONCLUSIVE');
  const round = overrides => ({ round: 1, kinds: ['ok', 'ok', 'ok', 'ok'], failed: [], refreshed: true, loginKept: true, retry: null, ...overrides });
  const t2 = (rounds, final = ok) => t2Verdict({ rounds, final })[0];
  check('T2 の判定: 競合は次の試行で通れば PASS。失敗・ログイン喪失は FAIL。更新が起きない・上限は INCONCLUSIVE',
    t2([round(), round({ kinds: ['ok', 'contention', 'ok', 'ok'], retry: ok })]) === 'PASS'
    && t2([round({ failed: ['auth'] })]) === 'FAIL' && t2([round({ loginKept: false })]) === 'FAIL'
    && t2([round({ kinds: ['contention', 'ok', 'ok', 'ok'], retry: { ok: false } })]) === 'FAIL' && t2([round()], revoked) === 'FAIL'
    && t2([round({ refreshed: false }), round({ refreshed: false })]) === 'INCONCLUSIVE' && t2([round({ kinds: ['rate-limited', 'ok', 'ok', 'ok'] })]) === 'INCONCLUSIVE');

  const l = layout(path.join(tmp, 'trial'));
  const ctx = { l, quiet: false, verdicts: [], model: 'fake', turnTimeout: 30_000, rounds: 2, deps: {} };
  await setupDirs(l);
  const fake = await installFakeClaude(path.join(tmp, 'fake'));
  process.env.AGENT_HOST_CLAUDE_BIN = fake.bin;
  const link = await canMakeFileSymlink(path.join(tmp, 'probe'));
  if (!link.ok) {
    check('偽の CLI の通し（保持中の CLI・T1・T2）はファイル用リンクが要る（この PC は作れない: 省略）', true);
  } else {
    const turn = await oneShot(ctx, { configDir: path.join(tmp, 'cfg') }, 'hello');
    check('保持中の CLI（偽）: 1 ターン目が通る', turn.ok && /hello/.test(turn.text), JSON.stringify(turn));
    const held = await openHeld({ configDir: path.join(tmp, 'cfg'), cwd: l.work, model: 'fake', timeoutMs: 30_000 });
    const two = [await held.turn('one'), await held.turn('two')];
    await held.close();
    check('保持中の CLI（偽）: 入力を開けたまま 2 ターン続けて通る', two.every(r => r.ok) && /two/.test(two[1].text), JSON.stringify(two));
    // 偽の資格情報。使用量の読み取りは、更新を真似て資格情報を書き換える
    const writeCreds = async n => fsp.writeFile(path.join(l.A.dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `fake-access-${n}-xxxxxxxx`, refreshToken: `fake-refresh-${n}-xxxxxxxx`, expiresAt: Date.now() + 3_600_000 } }));
    let n = 0;
    await writeCreds(n);
    ctx.deps.readUsage = async () => { await writeCreds(++n); return { windows: [{}], plan: 'fake' }; };
    ctx.quiet = true;
    const log = console.log;
    console.log = () => {};
    let t1, t2;
    try { await runT1(ctx); await runT2(ctx); } finally { console.log = log; }
    t1 = ctx.verdicts[0]; t2 = ctx.verdicts[1];
    check('T1 の流れ（偽）: 比較が失効しない偽の CLI では PASS にせず INCONCLUSIVE', t1 === 'INCONCLUSIVE', t1);
    check('T2 の流れ（偽）: 2 回の同時更新が PASS', t2 === 'PASS', t2);
    const b = await readOauth(path.join(tmp, 'trial', 'data', 'claude-usage', ACCOUNTS.B));
    check('試験の外・B のログインには触れない', b === null);
  }

  const outside = path.join(tmp, 'outside', '.credentials.json');
  await fsp.mkdir(path.dirname(outside), { recursive: true });
  await fsp.writeFile(outside, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'b', expiresAt: 1 } }));
  check('期限の書き換え: root の外は断る', await backdate(l.root, path.dirname(outside)).then(() => false, () => true));
  const other = JSON.parse(await fsp.readFile(path.join(l.A.dir, '.credentials.json'), 'utf8'));
  await backdate(l.root, l.A.dir).catch(() => {});
  const after = JSON.parse(await fsp.readFile(path.join(l.A.dir, '.credentials.json'), 'utf8'));
  check('期限の書き換え: root の中は期限だけ変える', after.claudeAiOauth.expiresAt < Date.now() && after.claudeAiOauth.accessToken === other.claudeAiOauth.accessToken);

  await removeTree(tmp, path.join(tmp, 'trial')).catch(() => {});
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  console.log(failed ? `${failed} 件 NG` : 'selftest: すべて OK');
  process.exitCode = failed ? 1 : 0;
}

async function setupDirs(l) {
  for (const dir of [l.root, l.shared, l.usage, l.b1, l.work, l.results, l.A.dir, l.B.dir]) await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(l.marker, 'selftest\n');
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { pos.push(arg); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[arg.slice(2)] = true;
    else { flags[arg.slice(2)] = next; i++; }
  }
  return { pos, flags };
}

async function main() {
  const { pos: [cmd, sub], flags } = parseArgs(process.argv.slice(2));
  scrubProcessEnv();
  if (!cmd || cmd === 'help') { console.log('使い方: ファイルの先頭のコメントを見る'); return; }
  if (cmd === 'selftest') return selftest();
  const root = assertSafeRoot(flags.root ?? path.join(os.tmpdir(), 'ply-own-dir-trial'));
  const l = layout(root);
  const ctx = {
    l, verdicts: [], deps: { readUsage: options => readClaudeUsage(options) }, model: flags.model ?? 'haiku', turnTimeout: Number(flags['turn-timeout'] ?? 120_000),
    rounds: flags.rounds, minutes: flags.minutes ?? 30, every: flags.every ?? 20,
  };
  if (cmd === 'setup') return setup(ctx);
  if (!fsSync.existsSync(l.marker)) { console.log(`試験の場所が無い。先に: node tests/manual/own-dir-trial.mjs setup --root ${root}`); process.exitCode = 3; return; }
  if (cmd === 'status') return status(ctx);
  const live = ['t1', 't2', 't4', 't7'];
  if (live.includes(cmd) || cmd === 'all') {
    if (process.platform === 'darwin') { await blocked(ctx, cmd, 'macOS は専用フォルダ方式を止める方針（ADR 0350）。試験しない', []); return finish(ctx); }
    if (!claudeSdkVersion()) { await blocked(ctx, cmd, 'Claude Agent SDK が読めない（npm ci）', []); return finish(ctx); }
    if (!cliVersion()) { await blocked(ctx, cmd, 'claude CLI が見つからない', []); return finish(ctx); }
  }
  const runs = { t1: runT1, t2: runT2, t4: runT4, t5: runT5, t6: runT6, t7: runT7 };
  if (cmd === 'all') for (const name of ['t5', 't6', 't1', 't2', 't4', 't7']) await runs[name](ctx);
  else if (runs[cmd]) await runs[cmd](ctx);
  else if (cmd === 't3') {
    const actions = { start: t3Start, drive: t3Drive, check: t3Check, stop: t3Stop };
    if (!actions[sub]) throw new Error('t3 start | drive | check | stop');
    await actions[sub](ctx);
  } else throw new Error(`知らないコマンド: ${cmd}`);
  finish(ctx);
}

function finish(ctx) {
  const worst = Math.max(0, ...ctx.verdicts.map(rank));
  if (ctx.verdicts.length) process.exitCode = worst === 0 ? 0 : worst === 2 ? 1 : 3;
}

main().catch(error => { console.error(redact(error?.stack ?? error)); process.exitCode = 1; });
