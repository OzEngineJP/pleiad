// Claude の起動の記録（段 0。「Claude アカウントで claude.ai のコネクターを使う」計画。ADR 0339）。
// 各起動の経路を、親の env・アカウントの状態・接続先の組み合わせごとに流し、次の 2 つを記録する:
//   sdk   … SDK の query に渡した options（関数・AbortController などは型名にする。env は値まで残す）
//   proc  … 実際に起こされた CLI の argv・cwd・env（偽の CLI が書く。tests/lib/launch-record-cli.mjs）。起こされなければ null
// 期待値は変更前のコード（main）で採った tests/fixtures/claude-launch-main.<OS>.json（fixtureFile()。OS ごと）。この記録を作る側は core の置き場（root）を引数に取り、
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
/**
 * 期待値の fixture。OS ごとに 1 つ（どちらも main で採る）。起動の記録が OS で違うため: 製品の側は、Windows は npm の .cmd を SDK の起動では cli.mjs へ解決する・
 * Windows だけの env（SystemRoot など）を子へ渡す。試験の側は、偽の CLI の入口が Windows は .cmd・Linux は sh（sh が子の env に PWD を足す）。
 * win32 以外は linux の記録と比べる（CI は ubuntu と windows。macOS は確かめていない）
 */
export const fixtureFile = (platform = process.platform) =>
  fileURLToPath(new URL(`../fixtures/claude-launch-main.${platform === 'win32' ? 'win32' : 'linux'}.json`, import.meta.url));
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
function makeNorm(tmp, repos) {
  const slash = tmp.replace(/\\/g, '/');
  // 作業ツリーの置き場（試験を流した場所と、記録する core の置き場）は機械ごとに違うので <repo> にする（長い方から）
  const repoSlashes = [...new Set(repos.map(r => path.resolve(r).replace(/\\/g, '/').replace(/\/$/, '')))].sort((a, b) => b.length - a.length);
  return s => repoSlashes.reduce((v, r) => v.split(r).join('<repo>'), String(s).replace(/\\/g, '/').split(slash).join('<tmp>')).replace(UUID, '<uuid>').replace(/claude-[0-9a-f]{8}/g, 'claude-<id>')
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
export async function recordAll({ root, accountFor = (accounts, id, ctx) => accounts.resolve(id), onSetup = null, only = null, dumpName = 'records' } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-launch-rec-')));
  const norm = makeNorm(tmp, [process.cwd(), root]);
  const savedEnv = { ...process.env };
  const dumpDir = process.env.LAUNCH_RECORD_DUMP || '';
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
        // どの経路も CLI が終わるまで待ってから戻る（記録は CLI が終わる前に書かれる。実測で戻ってから記録が読めるまで数 ms）。
        // 待ちが長いのは起動されない・戻らない壊れたときだけなので短く切る: 戻ったら 2 秒、戻らなければ 10 秒で見切ってさらに 10 秒
        const settled = await Promise.race([Promise.resolve().then(run).then(() => true, () => true), sleep(10000).then(() => false)]);
        const proc = await waitFile(file, settled ? 2000 : 10000);
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
  // 調べる口: LAUNCH_RECORD_DUMP=<フォルダー> を付けて流すと、比べる前の記録（sha の元）を丸ごと書き出す。
  //   落ちたときに、main の worktree（root）で同じ口を付けて流した物と、JSON の差分で見比べる（どのキー・どの引数が違うか）
  if (dumpDir) {
    await fs.mkdir(dumpDir, { recursive: true });
    await fs.writeFile(path.join(dumpDir, `${dumpName}.json`), JSON.stringify(out, null, 1) + '\n');
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

/**
 * 合わなかった組み合わせ × 経路の手がかり（argv の数・env のキーの増減・認証に関わる env の値の違い）を短く返す。
 * 中身まで見るときは LAUNCH_RECORD_DUMP（recordAll の末尾の説明）で記録を書き出し、main の記録と見比べる
 */
export function explain(want, got, limit = 6) {
  const bad = [];
  for (const label of new Set([...Object.keys(want), ...Object.keys(got)])) {
    for (const route of new Set([...Object.keys(want[label] ?? {}), ...Object.keys(got[label] ?? {})])) {
      const w = want[label]?.[route], g = got[label]?.[route];
      if (JSON.stringify(w) === JSON.stringify(g)) continue;
      const hint = [];
      if (!w || !g) hint.push(!w ? 'fixture に無い' : '記録が無い');
      else {
        if (w.argv !== g.argv) hint.push(`argv の数 ${w.argv}→${g.argv}`);
        const wk = new Set((w.envKeys ?? '').split(',').filter(Boolean)), gk = new Set((g.envKeys ?? '').split(',').filter(Boolean));
        const add = [...gk].filter(k => !wk.has(k)), del = [...wk].filter(k => !gk.has(k));
        if (add.length) hint.push(`env +${add.join(' +')}`);
        if (del.length) hint.push(`env -${del.join(' -')}`);
        for (const k of new Set([...Object.keys(w.auth ?? {}), ...Object.keys(g.auth ?? {})])) if (w.auth?.[k] !== g.auth?.[k]) hint.push(`${k} ${JSON.stringify(w.auth?.[k])}→${JSON.stringify(g.auth?.[k])}`);
        if (('proc' in w) !== ('proc' in g)) hint.push(g.proc === null ? '起動されなかった' : '起動された');
        if (!hint.length) hint.push('ほかの中身（SDK の options・env の値・argv の中身）');
      }
      bad.push(`${label} ${route}: ${hint.join(', ')}`);
    }
  }
  const more = bad.length > limit ? ` …ほか ${bad.length - limit} 件` : '';
  return { count: bad.length, text: bad.length ? `${bad.slice(0, limit).join(' | ')}${more}（中身は LAUNCH_RECORD_DUMP=<フォルダー> を付けて流し、main の記録と見比べる。tests/unit/claude-launch-main-pinned.mjs の先頭）` : '' };
}
