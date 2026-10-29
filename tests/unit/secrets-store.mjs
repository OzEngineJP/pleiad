// 秘密情報と変数の置き場（core/secrets.mjs。ADR 0217）と、その周りの純粋な部品:
//   - 登録・変更・削除。秘密の値は台帳にも一覧にも出ない（変数の値だけ出す）。秘密を変数へ戻さない
//   - 使えない名前（Pleiad 自身の名前・PATH など）は断り、ANTHROPIC_* などは断らない。同じ名前・同じ場所は重ねない
//   - 渡す場所: すべて < フォルダー < 深いフォルダー。worktree は元のリポジトリの使い道を引く。API キーの使い道（keyUses）も同じ規則
//   - .env の取り込み（新規・上書き・使えない名前・API キーと重なる名前）。ログイン情報の origin の照合。伏せる値の一覧
//   - core/secret-mask.mjs（JSON の中でも伏せる）・core/claude-env-file.mjs（sh の引用・元の CLAUDE_ENV_FILE を先に読む・片付け）・
//     web/dotenv.mjs（.env の読み方）・core/secrets-prompt.mjs（名前だけの一覧の文）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createSecrets, reservedEnvName, siteMatches, normalizeSite, inFolder } from '../../core/secrets.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { createSecretMasker, createStreamMasker, SECRET_MASK } from '../../core/secret-mask.mjs';
import { envScript, envValues, writeClaudeEnvFile, adoptClaudeEnvFile, sweepClaudeEnvFiles, shQuote } from '../../core/claude-env-file.mjs';
import { secretsPrompt } from '../../core/secrets-prompt.mjs';
import { resolveShell } from '../../core/shell-bridge.mjs';
import { parseDotenv, looksSecret, reservedName } from '../../web/dotenv.mjs';
import { agentT } from '../../core/i18n.mjs';

export const name = 'secrets-store';
export const title = '秘密情報と変数の置き場: 値を出さない・使えない名前・渡す場所の勝ち負け・worktree・.env・origin の照合・伏せる・Claude のシェルへ渡すファイル';

const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
/** プロセスのコマンドライン（Windows は Win32_Process.CommandLine、それ以外は /proc/<pid>/cmdline） */
const commandLineOf = async (pid) => {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 30_000 });
    return r.status === 0 ? String(r.stdout).trim() : null;
  }
  return fs.readFile(`/proc/${pid}/cmdline`, 'utf8').then((s) => s.replace(/\0/g, ' ').trim(), () => null);
};
const SECRET = 'sk_test_' + 'x'.repeat(24);
const PASSWORD = 'p@ss"w\\ord-' + 'y'.repeat(12);
const KEY = 'sk-or-v1-' + 'k'.repeat(30);

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-secrets-')));
  const dataDir = path.join(scratch, 'data');
  const repo = path.join(scratch, 'repo');
  const wt = path.join(scratch, 'repo.pleiad', 'feature');
  await fs.mkdir(path.join(repo, 'sub'), { recursive: true });
  await fs.mkdir(wt, { recursive: true });
  const values = createSecretStore({ file: path.join(dataDir, 'secret-values.json'), cipher: plainCipher });
  // API キーの代わり（一覧と値だけ）
  const apiKeys = { list: async () => ({ keys: [{ id: 'key-aaaaaaaaaaaa', provider: 'openrouter', label: 'OpenRouter', uses: [] }] }), keyValue: async (id) => (id === 'key-aaaaaaaaaaaa' ? KEY : null), migrated: async () => true };
  const changes = [];
  const store = createSecrets({ dataDir, values, apiKeys: () => apiKeys, repoRoot: async (cwd) => (inFolder(cwd.replace(/\\/g, '/'), wt.replace(/\\/g, '/')) ? repo : null), onChange: (c) => changes.push(c) });
  await store.init();
  try {
    // ---- 名前の決まり
    t.ok('使えない名前: Pleiad 自身の名前（AGENT_HOST_・PLEIAD_・PLY_・AGENT_BROWSER_）・PATH・HOME・CLAUDE_ENV_FILE。大文字小文字は区別しない',
      ['AGENT_HOST_PORT', 'pleiad_control_token', 'PLY_X', 'AGENT_BROWSER_SESSION', 'Path', 'HOME', 'USERPROFILE', 'CLAUDE_ENV_FILE', 'ELECTRON_RUN_AS_NODE'].every(reservedEnvName)
      && ['AGENT_HOST_PORT', 'Path'].every(reservedName));
    t.ok('ANTHROPIC_*・OPENAI_*・GITHUB_TOKEN は断らない（シェルにだけ渡すので、CLI 本体の認証は替わらない）', !['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'DATABASE_URL'].some(reservedEnvName));
    const reserved = await rejects(store.create({ kind: 'var', label: 'PATH', value: 'x', env: { name: 'PATH' } }));
    t.ok('使えない名前は理由つきで断る（黙って落とさない）', reserved?.code === 'RESERVED_NAME');
    t.ok('名前の形が違えば断る', (await rejects(store.create({ kind: 'var', label: 'x', value: 'x', env: { name: '1BAD' } })))?.code === 'INVALID_NAME');

    // ---- 登録と一覧
    const v = await store.create({ kind: 'var', label: 'NODE_ENV', value: 'development', env: { name: 'NODE_ENV', scope: 'all' } });
    const s = await store.create({ kind: 'secret', label: 'STRIPE_SECRET_KEY', value: SECRET, env: { name: 'STRIPE_SECRET_KEY', scope: { folders: [repo] } }, note: 'テスト環境だけ' });
    const login = await store.create({ kind: 'login', label: 'GitHub', username: 'bot', password: PASSWORD, sites: ['https://github.com/login', '*.example.com'] });
    const ledger = await fs.readFile(path.join(dataDir, 'secrets.json'), 'utf8');
    const list = await store.list();
    const agentList = await store.agentList();
    t.ok('台帳（secrets.json）にも一覧にも、秘密の値・パスワードは無い。変数の値はある', !ledger.includes(SECRET) && !ledger.includes('y'.repeat(12))
      && !JSON.stringify(list).includes(SECRET) && !JSON.stringify(agentList).includes(SECRET) && JSON.stringify(list).includes('development'));
    t.ok('ログイン情報のサイトはホスト名にそろえる（https://…/login・*.example.com）', JSON.stringify(list.items.find((i) => i.id === login.id).sites) === '["github.com","example.com"]');
    t.ok('値は値の置き場（secret-values.json）に 1 件ずつ', (await values.keys('item:')).length === 2);
    t.ok('変わるたびに onChange（値は載せない）', changes.length === 3 && !JSON.stringify(changes).includes(SECRET));
    t.ok('同じ名前・重なる場所は重ねない', (await rejects(store.create({ kind: 'var', label: 'NODE_ENV', value: 'x', env: { name: 'node_env', scope: 'all' } })))?.code === 'DUPLICATE_NAME');
    const deeper = await store.create({ kind: 'var', label: 'NODE_ENV', value: 'test', env: { name: 'NODE_ENV', scope: { folders: [path.join(repo, 'sub')] } } });
    t.ok('同じ名前でも、別のフォルダーなら登録できる', Boolean(deeper.id));

    // ---- 渡す場所
    const atRepo = await store.envFor(repo);
    const atSub = await store.envFor(path.join(repo, 'sub', 'deep'));
    const atElse = await store.envFor(scratch);
    const atWt = await store.envFor(wt);
    t.ok('すべてのフォルダーの値は、どこでも渡る', atElse.vars.NODE_ENV === 'development' && !('STRIPE_SECRET_KEY' in atElse.vars));
    t.ok('フォルダーの値はそのフォルダー（と中）にだけ渡る', atRepo.vars.STRIPE_SECRET_KEY === SECRET && atSub.vars.STRIPE_SECRET_KEY === SECRET);
    t.ok('深いフォルダーの値が、浅いフォルダーと「すべて」に勝つ', atSub.vars.NODE_ENV === 'test' && atRepo.vars.NODE_ENV === 'development');
    t.ok('worktree の会話は、元のリポジトリのフォルダーの使い道を引く', atWt.vars.STRIPE_SECRET_KEY === SECRET);
    t.ok('AI に見せる一覧（entries）は名前・種類・メモだけで、値は無い', atRepo.entries.some((e) => e.name === 'STRIPE_SECRET_KEY' && e.secret && e.note === 'テスト環境だけ') && !JSON.stringify(atRepo.entries).includes(SECRET));
    t.ok('ログイン情報は環境変数を選ばなければ渡らない', !Object.values(atRepo.vars).includes(PASSWORD));

    // ---- API キーの使い道
    await store.setKeyUse('key-aaaaaaaaaaaa', { env: { name: 'OPENROUTER_API_KEY', scope: 'all' }, note: 'アプリの試験' });
    const withKey = await store.envFor(scratch);
    t.ok('API キーに環境変数を選ぶと、その名前で渡る（台帳は id で指すだけ）', withKey.vars.OPENROUTER_API_KEY === KEY && !(await fs.readFile(path.join(dataDir, 'secrets.json'), 'utf8')).includes(KEY)
      && withKey.entries.some((e) => e.name === 'OPENROUTER_API_KEY' && e.kind === 'apiKey' && e.label === 'OpenRouter'));
    t.ok('知らない API キーには選べない', (await rejects(store.setKeyUse('key-bbbbbbbbbbbb', { env: { name: 'X_KEY' } })))?.code === 'KEY_NOT_FOUND');
    t.ok('API キーと同じ名前・同じ場所の項目は重ねない', (await rejects(store.create({ kind: 'var', label: 'x', value: 'x', env: { name: 'OPENROUTER_API_KEY' } })))?.code === 'DUPLICATE_NAME');

    // ---- 変える
    await store.update(v.id, { toSecret: true });
    const promoted = (await store.list()).items.find((i) => i.id === v.id);
    t.ok('変数は秘密の値にできる（値は台帳から消え、値の置き場へ移る）', promoted.kind === 'secret' && promoted.value === undefined && (await store.envFor(scratch)).vars.NODE_ENV === 'development');
    t.ok('秘密の値を変数へ戻すことはしない（value の変更は効かない）', (await store.update(v.id, { value: 'plain' })).item.kind === 'secret');
    await store.update(s.id, { secretValue: SECRET + '2' });
    t.ok('秘密の値の差し替え', (await store.envFor(repo)).vars.STRIPE_SECRET_KEY === SECRET + '2');

    // ---- ログイン情報の origin の照合
    const ok = await store.loginFor(login.id, 'https://github.com');
    const sub = await store.loginFor(login.id, 'https://www.example.com');
    t.ok('サイトが同じかサブドメインの https なら値を読める', ok.password === PASSWORD && ok.site === 'github.com' && sub.site === 'example.com');
    t.ok('別のホスト・http・似た名前のホストでは読めない', (await rejects(store.loginFor(login.id, 'https://evil.com')))?.code === 'SITE_MISMATCH'
      && (await rejects(store.loginFor(login.id, 'http://github.com')))?.code === 'SITE_MISMATCH'
      && (await rejects(store.loginFor(login.id, 'https://notgithub.com')))?.code === 'SITE_MISMATCH'
      && siteMatches(['github.com'], 'https://github.com.evil.com') === null && normalizeSite('javascript:alert(1)') === null);
    await store.recordUse(login.id, { sessionId: 's1', site: 'github.com' });
    t.ok('入力したことは最後の 1 回だけ残す（時刻・会話・サイト）', (await store.list()).items.find((i) => i.id === login.id).lastUse?.site === 'github.com');

    // ---- .env の取り込み
    const imported = await store.importEnv([{ name: 'FOO', value: 'bar', secret: false }, { name: 'API_TOKEN', value: 'tok-' + 'z'.repeat(10), secret: true },
      { name: 'PATH', value: '/x', secret: false }, { name: 'OPENROUTER_API_KEY', value: 'x', secret: true }, { name: 'NODE_ENV', value: 'prod', secret: false }], { scope: 'all' });
    t.ok('取り込み: 新規は足し、使えない名前・API キーと重なる名前・登録済み（上書きしないとき）は飛ばす', imported.created.join() === 'FOO,API_TOKEN'
      && imported.skipped.map((x) => `${x.name}:${x.reason}`).join() === 'PATH:reserved,OPENROUTER_API_KEY:apiKey,NODE_ENV:exists');
    const again = await store.importEnv([{ name: 'NODE_ENV', value: 'prod', secret: false }], { scope: 'all', overwrite: true });
    t.ok('上書きを選ぶと値を差し替える。秘密の値は変数に戻さない', again.updated.join() === 'NODE_ENV' && (await store.list()).items.find((i) => i.id === v.id).kind === 'secret'
      && (await store.envFor(scratch)).vars.NODE_ENV === 'prod');

    // ---- 伏せる値
    const mask = await store.maskValues();
    t.ok('伏せる値: 秘密の値・パスワード・API キー（8 文字以上）。変数の値は伏せない', mask.includes(SECRET + '2') && mask.includes(PASSWORD) && mask.includes(KEY) && !mask.includes('bar'));
    const m = createSecretMasker();
    m.set(mask);
    const frame = JSON.stringify({ text: `pw=${PASSWORD} key=${KEY} env=bar` });
    const masked = m.json(frame);
    t.ok('JSON の中の形（" や \\ を含む値）でも伏せる', !masked.includes(KEY) && !masked.includes('y'.repeat(12)) && masked.includes(SECRET_MASK) && masked.includes('env=bar') && JSON.parse(masked).text.startsWith('pw=***'));
    t.ok('値をたどって伏せる（deep）', m.deep({ a: [`x${KEY}`] }).a[0] === `x${SECRET_MASK}`);
    const stream = createStreamMasker(m);
    const pieces = ['key=', KEY.slice(0, 5), KEY.slice(5, 20), KEY.slice(20) + ' ok', ' tail sk-'];
    const sent = pieces.flatMap((p) => stream.process({ type: 'text.delta', sessionId: 's1', text: p })).map((e) => e.text);
    const flushed = stream.process({ type: 'text.end', sessionId: 's1' });
    t.ok('流れの切れ端にまたがる値も伏せる（値の書き出しに当たる末尾だけ持ち越し、ほかの出来事の前に出す）',
      sent.join('') + flushed.filter((e) => e.type === 'text.delta').map((e) => e.text).join('') === `key=${SECRET_MASK} ok tail sk-` && !sent.join('').includes(KEY.slice(0, 12))
      && flushed.at(-1).type === 'text.end' && stream.holding === 0);
    t.ok('別の会話の切れ端は混ぜない', stream.process({ type: 'text.delta', sessionId: 's2', text: 'plain' })[0].text === 'plain');

    // ---- 消す
    await store.remove(s.id);
    t.ok('消すと値も消え、渡らない', !(await values.keys('item:')).includes(`item:${s.id}`) && !('STRIPE_SECRET_KEY' in (await store.envFor(repo)).vars));
    apiKeys.list = async () => ({ keys: [] });
    await store.pruneKeyUses();
    t.ok('API キーが消えたら、その使い道も外す', !(await store.list()).keyUses['key-aaaaaaaaaaaa']);

    // ---- 壊れた台帳は上書きしない
    await fs.writeFile(path.join(scratch, 'broken.json'), '{');
    const broken = createSecrets({ dataDir: scratch, values });
    await fs.writeFile(path.join(scratch, 'secrets.json'), '{ broken');
    await broken.init();
    t.ok('壊れた台帳は空で上書きせず、書く操作を断る', (await broken.status()).broken && (await rejects(broken.create({ kind: 'var', label: 'A', value: 'b', env: { name: 'A' } })))?.code === 'FILE_BROKEN'
      && (await fs.readFile(path.join(scratch, 'secrets.json'), 'utf8')) === '{ broken');
  } finally {}

  // ---- Claude のシェルへ渡すファイル（ADR 0284: 値は .vals にだけ書き、CLAUDE_ENV_FILE の .sh は読む行だけ）
  t.ok("sh の単一引用符: ' は '\\'' にする", shQuote("a'b") === `'a'\\''b'`);
  const vals = envValues({ A: "x'y", B: 'line1\nline2', 'bad-name': 'z' });
  t.ok('値ファイル: export で値を入れる。名前の形が違うものは書かない',
    vals.includes(`export A='x'\\''y'`) && vals.includes("export B='line1\nline2'") && !vals.includes('bad-name'));
  const script = envScript({ valuesFile: 'D:\\data\\run\\claude-env-abc.vals', inherit: 'C:\\Users\\me\\own.sh' });
  t.ok('スクリプト: 元の CLAUDE_ENV_FILE を先に読み（区切りは /）、値ファイルを読む行だけ。値（export 行）は書かない',
    script.includes(`[ -f 'C:/Users/me/own.sh' ] && . 'C:/Users/me/own.sh'`) && script.includes(`[ -f 'D:/data/run/claude-env-abc.vals' ] && . 'D:/data/run/claude-env-abc.vals'`)
    && !script.includes('export ') && script.indexOf('own.sh') < script.indexOf('.vals'));
  const file = await writeClaudeEnvFile(dataDir, { TOKEN: SECRET }, { inherit: null });
  const st = await fs.stat(file.file), stv = await fs.stat(file.values);
  const scriptText = await fs.readFile(file.file, 'utf8'), valuesText = await fs.readFile(file.values, 'utf8');
  t.ok('値は .vals（0600）にだけ書き、.sh の中身は読む行だけ（値を含まない。中身が bash.exe -c の引数に載るため）',
    path.dirname(file.file) === path.join(dataDir, 'run') && st.isFile() && stv.isFile() && file.values === file.file.replace(/\.sh$/, '.vals')
    && !scriptText.includes(SECRET) && valuesText.includes(`export TOKEN='${SECRET}'`)
    && (process.platform === 'win32' || (st.mode & 0o077) === 0 && (stv.mode & 0o077) === 0));
  t.ok('ターンの終わりに両方消す', (await file.dispose(), await fs.stat(file.file).then(() => false, () => true) && await fs.stat(file.values).then(() => false, () => true)));
  t.ok('値が無ければ書かない（CLAUDE_ENV_FILE を付けない）', (await writeClaudeEnvFile(dataDir, {})) === null);
  const adoptedSrc = await writeClaudeEnvFile(dataDir, { X: 'y' }, { inherit: null });
  const adopted = adoptClaudeEnvFile(dataDir, path.basename(adoptedSrc.file));
  t.ok('付け直し: 札のスクリプトの名前から両方を引く。名前の形が違う・run の外は引かない',
    adopted && adopted.file === adoptedSrc.file && adopted.values === adoptedSrc.values
    && adoptClaudeEnvFile(dataDir, '../secrets.json') === null && adoptClaudeEnvFile(dataDir, 'claude-env-x.txt') === null);
  t.ok('付け直した分も終わりに両方消す', (await adopted.dispose(), await fs.stat(adoptedSrc.file).then(() => false, () => true) && await fs.stat(adoptedSrc.values).then(() => false, () => true)));
  const left = await writeClaudeEnvFile(dataDir, { X: 'y' }, { inherit: null });
  const keep = await writeClaudeEnvFile(dataDir, { X: 'y' }, { inherit: null });
  const orphan = path.join(dataDir, 'run', 'claude-env-0d0a5b1c-0000-4000-8000-0000000000aa.vals');
  await fs.writeFile(orphan, 'export ORPHAN=1');
  t.ok('起動時の片付け: 消し損ねたスクリプトと値ファイル（対のスクリプトの無い残りも）を消し、札が指す組は残す',
    (await sweepClaudeEnvFiles(dataDir, { except: [path.basename(keep.file)] })) === 3
    && await fs.stat(left.file).then(() => false, () => true) && await fs.stat(left.values).then(() => false, () => true)
    && await fs.stat(orphan).then(() => false, () => true) && await fs.stat(keep.file).then(() => true, () => false) && await fs.stat(keep.values).then(() => true, () => false));
  await keep.dispose();

  // ---- Claude Code の Bash ツールと同じ形（bash -c '<env file の中身>\n: && <command>'）で動かし、値がプロセスのコマンドラインに出ないか（ADR 0284）
  const bash = resolveShell('bash');
  if (!bash) t.ok('bash が見つかる（この環境ではプロセスの検査はできない）', false, 'bash not found');
  else {
    const env = await writeClaudeEnvFile(dataDir, { PROBE_TOKEN: SECRET }, { inherit: null });
    const scriptBody = await fs.readFile(env.file, 'utf8');
    const echo = spawnSync(bash, ['-c', `${scriptBody}\n: && printf %s "$PROBE_TOKEN"`], { encoding: 'utf8' });
    t.ok('値ファイルを読むと、シェルの中では値が使える', echo.status === 0 && echo.stdout === SECRET, `status=${echo.status} stdout=${JSON.stringify(echo.stdout)} stderr=${JSON.stringify(String(echo.stderr ?? '').slice(0, 200))}`);
    const proc = spawn(bash, ['-c', `${scriptBody}\n: && sleep 30`], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 800));
      const cmdline = await commandLineOf(proc.pid);
      t.ok('走っている bash のコマンドラインに値が無い（.sh の中身は読む行だけなので。中身は argv に載る）',
        typeof cmdline === 'string' && cmdline.length > 0 && !cmdline.includes(SECRET) && cmdline.includes('.vals'), cmdline?.slice(0, 300));
    } finally { try { proc.kill('SIGKILL'); } catch { /* もう居ない */ } }
    await env.dispose();
  }

  // ---- .env の読み方
  const parsed = parseDotenv('# c\nexport A=1\nB="x \\"y\\"\\nz"\nC=\'raw $X\'\nD=plain # note\nE="multi\nline"\nbad line\n1X=2\nA=2\n');
  const byName = Object.fromEntries(parsed.entries.map((e) => [e.name, e.value]));
  t.ok('.env: export・"…"（\\n \\" を解く・複数行）・\'…\'（そのまま）・裸の値の注記・同じ名前は後の行', byName.A === '2' && byName.B === 'x "y"\nz' && byName.C === 'raw $X' && byName.D === 'plain' && byName.E === 'multi\nline'
    && parsed.malformed.join('|') === 'bad line|1X=2');
  t.ok('名前で秘密らしいものを見分ける', looksSecret('STRIPE_SECRET_KEY') && looksSecret('db_password') && !looksSecret('NODE_ENV'));

  // ---- 名前だけの一覧の文
  const none = secretsPrompt({ entries: [], logins: [], agentT, locale: 'ja' });
  const text = secretsPrompt({ entries: [{ name: 'API_TOKEN', kind: 'secret', label: 'API_TOKEN', note: '本番では使わない', secret: true }], logins: [{ id: 'sec-aaaaaaaaaaaa', label: 'GitHub', username: 'bot', sites: ['github.com'] }], browser: true, agentT, locale: 'ja' });
  const noBrowser = secretsPrompt({ entries: [], logins: [{ id: 'sec-aaaaaaaaaaaa', label: 'GitHub', sites: ['github.com'] }], browser: false, agentT, locale: 'en' });
  t.ok('一覧が空なら文を足さない', none === null && noBrowser === null);
  t.ok('文は名前・種類・メモ・サイト・id だけ（値は無い）', text.includes('API_TOKEN（秘密 · 本番では使わない）') && text.includes('GitHub [sec-aaaaaaaaaaaa] · github.com · ユーザー名 bot') && text.includes('fill_secret'));
  // env file 経由のエージェント（Claude）は Bash・ply_shell にだけ届き、PowerShell ツールには渡らないことを書く（ADR 0284）
  const envFileText = secretsPrompt({ entries: [{ name: 'API_TOKEN', kind: 'secret', label: 'API_TOKEN', secret: true }], envFile: true, agentT, locale: 'ja' });
  t.ok('env file のエージェント向け: Bash ツールか ply_shell にだけ届き、PowerShell ツールには渡らないと書く',
    envFileText.includes('Bash ツールか ply_shell') && envFileText.includes('PowerShell ツールには渡されていません'));
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
