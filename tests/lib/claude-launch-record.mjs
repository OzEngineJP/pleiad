// Claude の起動の記録（段 0。「Claude アカウントで claude.ai のコネクターを使う」計画。ADR 0339）。
// 各起動の経路を、親の env・アカウントの状態・接続先の組み合わせごとに流し、次の 2 つを記録する:
//   sdk   … SDK の query に渡した options（関数・AbortController などは型名にする。env は値まで残す）
//   proc  … 実際に起こされた CLI の argv・cwd・env（偽の CLI が書く。tests/lib/launch-record-cli.mjs）。起こされなければ null
// 期待値は変更前のコード（main）で採った tests/fixtures/claude-launch-main.json。この記録を作る側は core の置き場（root）を引数に取り、
// 旧い道に新しい組み立ての関数を挟まない。認証の値はすべて固定の偽物。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeClaude } from './fake-claude.mjs';

const CLI = fileURLToPath(new URL('./launch-record-cli.mjs', import.meta.url));
export const ACCOUNT_ID = 'acct-fake000001';
// 偽の認証の値（本物ではない）
export const FAKE = {
  registered: 'fake-registered-token-0001', parentOauth: 'fake-parent-oauth-0002', apiKey: 'fake-api-key-0003', authToken: 'fake-auth-token-0004',
  endpointKey: 'fake-endpoint-key-0005', configDir: 'FAKE_CONFIG_DIR',
};
// 機械ごとに違う env は有無だけ記録する
const MACHINE = new Set(['path', 'systemroot', 'comspec', 'pathext', 'temp', 'tmp', 'windir', 'systemdrive', 'home', 'userprofile']);

/** 親の env の組み合わせ（process.env を丸ごとこれに置き換えて流す） */
export const PARENTS = {
  plain: {},
  parentOauth: { CLAUDE_CODE_OAUTH_TOKEN: FAKE.parentOauth },
  apiKey: { ANTHROPIC_API_KEY: FAKE.apiKey },
  authToken: { ANTHROPIC_AUTH_TOKEN: FAKE.authToken },
  configDir: { CLAUDE_CONFIG_DIR: FAKE.configDir },
  allAuth: { CLAUDE_CODE_OAUTH_TOKEN: FAKE.parentOauth, ANTHROPIC_API_KEY: FAKE.apiKey, ANTHROPIC_AUTH_TOKEN: FAKE.authToken, CLAUDE_CONFIG_DIR: FAKE.configDir },
  emptyOauth: { CLAUDE_CODE_OAUTH_TOKEN: '' },
  undefinedOauth: { CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CONFIG_DIR: undefined },
  lowerCase: { claude_code_oauth_token: FAKE.parentOauth, Claude_Config_Dir: FAKE.configDir },
};
/** アカウントの状態: none = 指定なし（ログイン中のアカウントを選んだ場合も同じ道）/ registered = 登録したトークン */
export const ACCOUNTS = ['none', 'registered'];
export const ENDPOINTS = { none: null, compat: { baseUrl: 'https://compat.example.invalid', auth: 'bearer', key: FAKE.endpointKey, roles: { main: 'fake-model' }, options: {} } };

/** [親, アカウント, 接続先] の組み合わせ。接続先の互換は、代表の 2 つの親だけに絞る */
export function scenarios() {
  const rows = [];
  for (const p of Object.keys(PARENTS)) for (const a of ACCOUNTS) rows.push([p, a, 'none']);
  for (const p of ['plain', 'allAuth']) for (const a of ACCOUNTS) rows.push([p, a, 'compat']);
  return rows;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function makeNorm(tmp) {
  const slash = tmp.replace(/\\/g, '/');
  return s => String(s).replace(/\\/g, '/').split(slash).join('<tmp>').replace(UUID, '<uuid>').replace(/claude-[0-9a-f]{8}/g, 'claude-<id>')
    // 実行時の置き場（core が読み込み時に決める。試験のプロセスによって違う）の一時ファイル
    .replace(/[^"'\s=]*\/run\/(claude-[a-z]+-)<uuid>/g, '<run>/$1<uuid>')
    // 記録を受ける一時ファイルの連番（流す組み合わせを絞ると番号がずれる）
    .replace(/<tmp>\/rec-\d+\.json/g, '<tmp>/rec-<n>.json');
}
function plain(v, norm, depth = 0) {
  if (v === null) return null;
  if (v === undefined) return '<undefined>';
  if (typeof v === 'string') return norm(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'function') return '<fn>';
  if (Array.isArray(v)) return depth > 6 ? '<deep>' : v.map(x => plain(x, norm, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return `<${v.constructor?.name ?? 'object'}>`;
  if (depth > 6) return '<deep>';
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, plain(v[k], norm, depth + 1)]));
}
function envRecord(env, norm) {
  const out = {};
  for (const k of Object.keys(env).sort()) {
    if (k.startsWith('=') || k === 'LAUNCH_RECORD_OUT') continue;
    out[k] = MACHINE.has(k.toLowerCase()) ? '<present>' : (env[k] === undefined ? '<undefined>' : norm(env[k]));
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFile(file, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { await sleep(40); } }
  return null;
}

/**
 * root の core で全経路を流して記録を返す。
 *   accountFor(accounts, id, { data })  … 会話が使うアカウントの決め方（既定: accounts.resolve。段 1 以降は入口を通す関数を渡す。data = 試験のデータ置き場）
 *   onSetup({ data })         … 流す前に、データ置き場へ足すものがあれば（段 1 の設定ファイルなど）
 */
export async function recordAll({ root, accountFor = (accounts, id, ctx) => accounts.resolve(id), onSetup = null, only = null } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-launch-rec-')));
  const norm = makeNorm(tmp);
  const savedEnv = { ...process.env };
  // core はデータ置き場を読み込み時に決めるので、読み込む前に一時の置き場へ向ける（利用者の ~/.agent-host に書かない）
  process.env.AGENT_HOST_DATA = path.join(tmp, 'data');
  const imp = rel => import(pathToFileURL(path.join(root, 'core', rel)).href);
  const [{ backend: claude, setClaudeSdkForTest, probeClaudeCatalogForTest, probeClaudeConnectors }, { createClaudeAccounts }, usage, held, sdkMod] = await Promise.all([
    imp('backends/claude.mjs'), imp('claude-accounts.mjs'), imp('backends/claude-usage.mjs'), imp('backends/claude-held.mjs'), imp('claude-sdk.mjs')]);
  const data = path.join(tmp, 'data'), work = path.join(tmp, 'work');
  await fs.mkdir(data, { recursive: true }); await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(data, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: ACCOUNT_ID, name: 'fake-account', createdAt: '2026-01-01T00:00:00.000Z' }] }));
  if (onSetup) await onSetup({ data });
  const secrets = { get: async () => ({ token: FAKE.registered }), keys: async () => [], status: async () => null, set: async () => {}, delete: async () => {} };
  const accounts = createClaudeAccounts({ dataDir: data, secrets, cliConfig: path.join(tmp, 'no-cli.json') });
  const installed = await installFakeClaude(path.join(tmp, 'bin'), { cli: CLI });
  const realQuery = (await sdkMod.loadClaudeSdk()).query;
  let sdkRec = [];
  const wrapped = args => { const o = args.options ?? {}; sdkRec.push(plain({ ...o, env: o.env && typeof o.env === 'object' ? envRecord(o.env, norm) : o.env }, norm)); return realQuery(args); };
  const restoreSdk = setClaudeSdkForTest({ query: wrapped, resolveSettings: async () => ({ sources: [], effective: {} }), probe: null });
  const out = {};
  let n = 0;
  try {
    for (const [p, a, e] of scenarios()) {
      const label = `${p}/${a}/${e}`;
      if (only && !only.includes(label)) continue;
      for (const k of Object.keys(process.env)) delete process.env[k];
      // 子の node が起動できる最小限（Windows は SystemRoot が無いと乱数の初期化で落ちる）。大文字小文字は親のまま引く
      const pick = name => Object.entries(savedEnv).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
      const base = {};
      for (const k of ['PATH', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'SystemDrive']) { const v = pick(k); if (v !== undefined) base[k] = v; }
      Object.assign(process.env, base, { TEMP: tmp, TMP: tmp, AGENT_HOST_DATA: data, AGENT_HOST_CLAUDE_BIN: installed.bin, AGENT_HOST_CLAUDE_HOLDER: 'off' });
      for (const [k, v] of Object.entries(PARENTS[p])) if (v !== undefined) process.env[k] = v;
      const account = a === 'registered' ? await accountFor(accounts, ACCOUNT_ID, { data }) : await accountFor(accounts, '', { data });
      const endpoint = ENDPOINTS[e];
      const scoped = account?.id ? claude.forAccount(account) : claude;
      const paths = {
        runTurn: () => scoped.runTurn({ prompt: 'hi', sessionId: null, cwd: work, mode: 'bypass', emit: () => {}, askPermission: async () => ({ allow: true }),
          signal: new AbortController().signal, control: {}, hostSessionId: 'fake-host-session', endpoint }),
        internalTurn: () => scoped.internalTurn({ prompt: 'hi', model: 'haiku', cwd: work, endpoint }),
        suggestTitle: () => scoped.suggestTitle({ transcript: 'hi', endpoint }),
        modelList: () => probeClaudeCatalogForTest(work, true, account?.id ? account : null),
        connectorList: () => probeClaudeConnectors({ deny: [], token: account?.token ?? null }),
        usage: () => usage.readClaudeUsage({ token: account?.token, configDir: account?.id ? path.join(data, 'claude-usage', account.id) : undefined }),
      };
      if (e === 'compat') for (const k of ['modelList', 'connectorList', 'usage']) delete paths[k];
      const rec = {};
      for (const [pathName, run] of Object.entries(paths)) {
        const file = path.join(tmp, `rec-${n++}.json`);
        process.env.LAUNCH_RECORD_OUT = file;
        sdkRec = [];
        await Promise.race([Promise.resolve().then(run).catch(() => {}), sleep(30000)]);
        const proc = await waitFile(file, 25000);
        delete process.env.LAUNCH_RECORD_OUT;
        rec[pathName] = { sdk: sdkRec, proc: proc && { argv: proc.argv.map(norm), cwd: norm(proc.cwd), env: envRecord(proc.env, norm),
          files: Object.fromEntries(Object.entries(proc.files ?? {}).map(([k, v]) => [norm(k), norm(v)])) } };
      }
      // 保持役の起動の変換（SDK の spawn の引数 → 保持役への spawn）。保持役に載せるかの判断（heldPlan）は保持役が要るので含めない
      const frames = [];
      const client = Object.assign(new EventEmitter(), { spawn: async f => { frames.push(f); return { pid: 1 }; }, send: () => {}, kill: () => {} });
      try {
        const cli = held.createHeldCli({ mode: 'spawn', client });
        await Promise.race([Promise.resolve(cli.spawnClaudeCodeProcess({ command: 'fake-cmd', args: ['--fake'], cwd: work, env: { ...process.env }, signal: new AbortController().signal })).catch(() => {}), sleep(500)]);
      } catch { /* 起こせなければ記録なし */ }
      rec.heldSpawn = frames.map(f => plain({ ...f, env: f.env ? envRecord(f.env, norm) : f.env }, norm));
      out[label] = rec;
    }
  } finally {
    restoreSdk();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  return out;
}

const AUTH_KEY = /TOKEN|API_KEY|CONFIG_DIR|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_/i;
/** 記録を、比べやすい小さい形にする: 経路ごとに全体の sha256 と、認証に関わる env の値（偽物）・env のキーの一覧 */
export function digest(records) {
  const out = {};
  for (const [label, rec] of Object.entries(records)) {
    out[label] = {};
    for (const [name, r] of Object.entries(rec)) {
      const proc = r?.proc;
      out[label][name] = { sha: crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16),
        ...(proc ? { argv: proc.argv.length, envKeys: Object.keys(proc.env).join(','), auth: Object.fromEntries(Object.entries(proc.env).filter(([k]) => AUTH_KEY.test(k))) } : { proc: null }) };
    }
  }
  return out;
}
