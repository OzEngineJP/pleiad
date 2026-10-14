// 前の版（Claude Agent SDK を同梱していた版）から Claude を使っていた人は、取得への同意を済ませたものとみなして案内なしに取る（ADR 0208）。
// 本物のレジストリにはつながない（ループバックの偽物。固定の版の中身ではないので、取りに行った結果は integrity の失敗になる＝取りに行った印）。
//   - 形跡が無い（新しく入れた）: 取らない・同意を書かない・案内が要るまま。見た結果を一度だけ残す
//   - 形跡がある（使用量の記録・送った Claude の会話・Claude のアカウント）: 同意（reason と根拠付き）を書いて、利用者の操作なしに取る
//   - 形跡にしない: Claude の下書き（unsent）だけ・別のバックエンドの記録だけ
//   - 見直さない: 新しく入れた人が後から Claude の会話を作っても、みなし同意にならない（案内を見ずに取らない）
//   - 決められない（DB が読めない・JSON の記録が移行の前）: 何も書かず、取らない
//   - 先取り（切り替えの前に新しい版の SDK を取る）と、起動の裏の取得でも効く
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDb, dbPath } from '../../core/db.mjs';
import { LEGACY_CHECK_FILE, LEGACY_CONSENT_REASON, findClaudeUsage } from '../../core/claude-sdk-legacy.mjs';
import {
  claudeSdkRoot, claudeSdkStatus, claudeSdkConsent, ensureClaudeSdk, loadClaudeSdk, isClaudeSdkMissing,
  startClaudeSdkMaintenance, resetClaudeSdkForTest,
} from '../../core/claude-sdk.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const name = 'claude-sdk-legacy';
export const title = 'Claude Agent SDK: 前の版から Claude を使っていた人は同意済みとみなして取る（新しい人は案内を出す・一度だけ判断する・先取りでも効く）';

async function fakeRegistry() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const body = Buffer.from('this is not the pinned tarball');
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}/`, requests, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

const wait = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return cond(); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** データ置き場を作る。pleiad.db に、使用量の記録 usage（backend の配列）と会話 sessions（{ backend, unsent }）を入れる。db: false なら DB を作らない */
function dataDir(tmp, label, { db = true, usage = [], sessions = [], accounts = null } = {}) {
  const dir = path.join(tmp, label);
  fs.mkdirSync(dir, { recursive: true });
  if (db) {
    const handle = createDb(dbPath(dir));
    try {
      usage.forEach((backend, i) => handle.prepare('INSERT INTO usage_records (id, backend, at, data) VALUES (?, ?, ?, ?)').run(`u${i}`, backend, Date.now(), JSON.stringify({ id: `u${i}`, backend })));
      sessions.forEach((s, i) => {
        handle.prepare('INSERT INTO sessions (session_id) VALUES (?)').run(`s${i}`);
        const put = (field, value) => handle.prepare('INSERT INTO session_fields (session_id, field, value) VALUES (?, ?, ?)').run(`s${i}`, field, JSON.stringify(value));
        put('backend', s.backend);
        if (s.unsent !== undefined) put('unsent', s.unsent);
      });
    } finally { handle.close(); }
  }
  if (accounts) fs.writeFileSync(path.join(dir, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts }));
  return dir;
}
const addSession = (dir, id, backend) => {
  const handle = createDb(dbPath(dir));
  try {
    handle.prepare('INSERT INTO sessions (session_id) VALUES (?)').run(id);
    handle.prepare('INSERT INTO session_fields (session_id, field, value) VALUES (?, ?, ?)').run(id, 'backend', JSON.stringify(backend));
  } finally { handle.close(); }
};

export default async function (t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-claude-sdk-legacy-'));
  const reg = await fakeRegistry();
  const envOf = (dir) => ({ AGENT_HOST_CLAUDE_SDK: 'download', AGENT_HOST_DATA: dir, AGENT_HOST_CLAUDE_SDK_REGISTRY: reg.base });
  const fetched = (before = 0) => reg.requests.length - before;
  try {
    // ---------------------------------------------------------------- 形跡の見分け
    t.ok('形跡: 何も無い置き場は「無い」と言い切る', findClaudeUsage(dataDir(tmp, 'e-empty', { db: false })).found === false);
    t.ok('形跡: DB はあるが空なら「無い」', findClaudeUsage(dataDir(tmp, 'e-blank')).found === false);
    t.ok('形跡: 使用量の記録に Claude があれば usage', findClaudeUsage(dataDir(tmp, 'e-usage', { usage: ['codex', 'claude'] })).evidence === 'usage');
    t.ok('形跡: 送った Claude の会話があれば conversation（unsent: false でも）',
      findClaudeUsage(dataDir(tmp, 'e-conv', { sessions: [{ backend: 'claude', unsent: false }] })).evidence === 'conversation'
      && findClaudeUsage(dataDir(tmp, 'e-conv2', { sessions: [{ backend: 'claude' }] })).evidence === 'conversation');
    t.ok('形跡: Claude のアカウントの登録があれば account', findClaudeUsage(dataDir(tmp, 'e-acc', { accounts: [{ id: 'acc-1', name: '仕事' }] })).evidence === 'account');
    t.ok('形跡にしない: Claude の下書き（unsent）だけ・別のバックエンドの記録だけ・空のアカウント一覧',
      findClaudeUsage(dataDir(tmp, 'e-draft', { sessions: [{ backend: 'claude', unsent: true }], usage: ['codex'], accounts: [] })).found === false
      && findClaudeUsage(dataDir(tmp, 'e-other', { sessions: [{ backend: 'codex' }, { backend: 'antigravity', unsent: false }] })).found === false);
    const old = dataDir(tmp, 'e-json', { db: false });
    fs.writeFileSync(path.join(old, 'sessions.json'), '{}');
    t.ok('形跡: 形式 1（JSON）の記録が移行の前に残っていれば「決められない」', findClaudeUsage(old).found === null);
    const broken = dataDir(tmp, 'e-broken', { db: false });
    fs.writeFileSync(dbPath(broken), 'not a database');
    const accountsJson = JSON.stringify({ version: 1, accounts: [{ id: 'a', name: 'a' }] });
    t.ok('形跡: DB が読めなければ「決められない」', findClaudeUsage(broken).found === null);
    fs.writeFileSync(path.join(broken, 'claude-accounts.json'), accountsJson);
    t.ok('形跡: DB が読めなくても、アカウントの登録があればそれで足りる', findClaudeUsage(broken).evidence === 'account');

    // ---------------------------------------------------------------- 新しく入れた人: 案内を出す
    const fresh = dataDir(tmp, 'fresh', { db: false });
    const freshEnv = envOf(fresh);
    const freshRoot = claudeSdkRoot(freshEnv);
    resetClaudeSdkForTest();
    let n = reg.requests.length;
    const freshStatus = claudeSdkStatus({ env: freshEnv });
    t.ok('新しい人: 同意が無いまま（案内が要る）。同意を書かず、見た結果を残す',
      freshStatus.consent === false && !claudeSdkConsent(freshRoot) && fs.existsSync(path.join(freshRoot, LEGACY_CHECK_FILE)) && !fs.existsSync(path.join(freshRoot, 'consent.json')), JSON.stringify(freshStatus));
    let missing = null;
    try { await loadClaudeSdk({ fetch: true, env: freshEnv }); } catch (err) { missing = err; }
    t.ok('新しい人: 会話を始めても取らずに CLAUDE_SDK_MISSING（案内を出させる）', isClaudeSdkMissing(missing) && !missing.kind && fetched(n) === 0, missing?.message);
    const stop = startClaudeSdkMaintenance({ env: freshEnv, delayMs: 60_000 });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    t.ok('新しい人: 起動の裏でも取らない', fetched(n) === 0 && !claudeSdkConsent(freshRoot));

    // 判断は一度だけ。そのあとに Claude の会話と使用量が増えても、案内を見ずにみなし同意にならない
    const fh = createDb(dbPath(fresh));
    fh.close();
    addSession(fresh, 'later-1', 'claude');
    fs.writeFileSync(path.join(fresh, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: 'later', name: 'あとで登録' }] }));
    resetClaudeSdkForTest();
    t.ok('新しい人: あとから Claude の会話・アカウントができても、みなし同意にしない（判断は一度だけ）',
      claudeSdkStatus({ env: freshEnv }).consent === false && (await ensureClaudeSdk({ env: freshEnv }).then(() => 'ok', (e) => e.kind)) === 'consent' && fetched(n) === 0);
    // 案内を見て「取得」を押せば、今までどおり同意を残して取る
    n = reg.requests.length;
    const pressed = await ensureClaudeSdk({ consent: true, env: freshEnv }).then(() => 'ok', (e) => e.kind);
    const pressedConsent = readJson(path.join(freshRoot, 'consent.json'));
    t.ok('新しい人: 「取得」を押せば同意を残して取りに行く（reason は付かない）', pressed === 'integrity' && fetched(n) === 1 && Boolean(pressedConsent?.acceptedAt) && pressedConsent.reason === undefined, JSON.stringify(pressedConsent));

    // ---------------------------------------------------------------- 前から使っていた人: みなして取る
    for (const [label, spec, evidence] of [
      ['usage', { usage: ['claude'] }, 'usage'],
      ['conversation', { sessions: [{ backend: 'claude', unsent: false }] }, 'conversation'],
      ['account', { accounts: [{ id: 'acc-1', name: '仕事' }] }, 'account'],
    ]) {
      const dir = dataDir(tmp, `old-${label}`, spec);
      const env = envOf(dir);
      const root = claudeSdkRoot(env);
      resetClaudeSdkForTest();
      n = reg.requests.length;
      const status = claudeSdkStatus({ env });
      const consent = readJson(path.join(root, 'consent.json'));
      t.ok(`前から使っていた人（${label}）: 同意済みとみなす。reason と根拠を consent.json に残し、案内は出さない`,
        status.consent === true && Boolean(consent?.acceptedAt) && consent.reason === LEGACY_CONSENT_REASON && consent.evidence === evidence && !fs.existsSync(path.join(root, LEGACY_CHECK_FILE)), JSON.stringify(consent));
      t.ok(`前から使っていた人（${label}）: 利用者の操作なしに取りに行く（会話を始めるとき）`,
        await loadClaudeSdk({ fetch: true, env }).then(() => 'ok', (e) => (isClaudeSdkMissing(e) ? `missing:${e.kind}` : 'other')) === 'missing:integrity' && fetched(n) === 1);
    }

    // 「取得」を押しても、みなし同意の reason は消えない
    const keep = dataDir(tmp, 'old-keep', { usage: ['claude'] });
    const keepEnv = envOf(keep);
    resetClaudeSdkForTest();
    await ensureClaudeSdk({ consent: true, env: keepEnv }).catch(() => {});
    t.ok('前から使っていた人: 後から「取得」を押しても、みなし同意の reason を書き換えない', readJson(path.join(claudeSdkRoot(keepEnv), 'consent.json'))?.reason === LEGACY_CONSENT_REASON);

    // 起動の裏の取得（更新を経ずに入れ直した場合など）
    const boot = dataDir(tmp, 'old-boot', { usage: ['claude'] });
    const bootEnv = envOf(boot);
    resetClaudeSdkForTest();
    n = reg.requests.length;
    const stopBoot = startClaudeSdkMaintenance({ env: bootEnv, delayMs: 60_000 });
    t.ok('前から使っていた人: 起動の裏で取りに行く', await wait(() => fetched(n) === 1), `${fetched(n)}`);
    stopBoot();
    t.ok('前から使っていた人: 取れなかったときは今の失敗の表示のまま（画面から再試行できる）', await wait(() => claudeSdkStatus({ env: bootEnv }).error?.kind === 'integrity'), JSON.stringify(claudeSdkStatus({ env: bootEnv }).error));

    // ---------------------------------------------------------------- 決められないとき
    const undecided = dataDir(tmp, 'undecided', { db: false });
    fs.writeFileSync(path.join(undecided, 'sessions.json'), '{}');
    const undecidedEnv = envOf(undecided);
    resetClaudeSdkForTest();
    n = reg.requests.length;
    t.ok('決められない: 取らず、同意も判断の印も書かない（次に呼ばれたときにもう一度見る）',
      claudeSdkStatus({ env: undecidedEnv }).consent === false && fetched(n) === 0 && !fs.existsSync(claudeSdkRoot(undecidedEnv)));

    // ---------------------------------------------------------------- 開発（local）は何も変えない
    const localDir = dataDir(tmp, 'local', { usage: ['claude'] });
    const localStatus = claudeSdkStatus({ env: { AGENT_HOST_CLAUDE_SDK: 'local', AGENT_HOST_DATA: localDir } });
    t.ok('local（開発）: みなし同意を書かない（同意は要らない）', localStatus.consent === true && !fs.existsSync(path.join(localDir, 'claude-sdk')));

    // ---------------------------------------------------------------- 切り替えの前の先取り
    const { runClaudeSdkFetch } = require('../../desktop/switch.cjs');
    const baseEnv = { ...process.env };
    delete baseEnv.AGENT_HOST_CLAUDE_SDK_REGISTRY;
    const prefetch = (dir) => runClaudeSdkFetch({ nodeExe: process.execPath, appDir: ROOT, dataDir: dir, env: { ...baseEnv, ...envOf(dir) }, timeoutMs: 60_000 });
    const preOld = dataDir(tmp, 'pre-old', { usage: ['claude'] });
    n = reg.requests.length;
    const preOldResult = await prefetch(preOld);
    t.ok('先取り: 前から使っていた人は、同意の操作なしに取りに行く（取れなければ kind 付きで ready: false）',
      preOldResult.consent === true && preOldResult.ready === false && preOldResult.kind === 'integrity' && fetched(n) === 1
      && readJson(path.join(preOld, 'claude-sdk', 'consent.json'))?.reason === LEGACY_CONSENT_REASON, JSON.stringify(preOldResult));
    const preFresh = dataDir(tmp, 'pre-fresh', { sessions: [{ backend: 'claude', unsent: true }] });
    n = reg.requests.length;
    const preFreshResult = await prefetch(preFresh);
    t.ok('先取り: 新しい人は取らない（consent: false）', preFreshResult.consent === false && preFreshResult.ready === false && fetched(n) === 0, JSON.stringify(preFreshResult));
  } finally {
    await reg.close();
    resetClaudeSdkForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
