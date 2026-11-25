// Claude のアカウント切り替え（core/claude-accounts.mjs）。LLM も Claude Code も呼ばない。
// アカウントは専用フォルダ（<data>/claude-usage/<id>）のログイン 1 つだけ（ADR 0353）。一覧の中身・名前の検査・
// ログインの印・削除・0.43.0-beta.24 より前の会話用トークンの片付け（dropLegacyTokens）を確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeAccounts, AccountError, readOauthAccount, cliConfigFile, newAccountId, normalizeName } from '../../core/claude-accounts.mjs';

export const name = 'claude-accounts';
export const title = 'Claude のアカウント: 一覧・名前・ログインの印・削除・会話用トークンの片付け（ADR 0353）';

const ORG_WORK = '11111111-0000-4000-8000-000000000001';
const LEGACY_TOKEN = 'sk-ant-oat01-' + 'A'.repeat(40);

export default async function (t) {
  // ---- 名前と id
  t.ok('名前は前後の空白を落とす', normalizeName('  仕事用 ') === '仕事用');
  let empty = null; try { normalizeName('  '); } catch (e) { empty = e; }
  t.ok('空の名前は断る', Boolean(empty));
  let long = null; try { normalizeName('x'.repeat(61)); } catch (e) { long = e; }
  t.ok('長すぎる名前は断る', Boolean(long));
  const a = newAccountId(), b = newAccountId();
  t.ok('新しい id は acct- で始まり、毎回違う', /^acct-[0-9a-f]{12}$/.test(a) && a !== b);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-accounts-'));
  try {
    const accounts = createClaudeAccounts({ dataDir: dir, cliConfig: path.join(dir, 'no-cli.json') });
    t.ok('何も登録していなければ空', (await accounts.list()).accounts.length === 0);
    t.ok('未選択（空）は null＝ログイン中のアカウント', await accounts.resolve('') === null && await accounts.resolve(undefined) === null);

    // ---- 追加（ログインが済んでから載せる。core/claude-login.mjs）
    const work = newAccountId(), home = newAccountId();
    await accounts.assertNameFree('仕事用');
    await accounts.add({ id: work, name: ' 仕事用 ' });
    await accounts.add({ id: home, name: '個人用' });
    const listed = await accounts.list();
    t.ok('一覧は id・表示名・ログインの有無と切れの印だけ', listed.accounts.length === 2 && listed.accounts[0].name === '仕事用'
      && listed.accounts.every(x => Object.keys(x).sort().join() === 'id,name,usageExpired,usageLogin' && x.usageLogin === true && x.usageExpired === false), JSON.stringify(listed));
    t.ok('追加するとログインの印を置く', await accounts.hasUsageLogin(work));
    t.ok('get は id と名前', JSON.stringify(await accounts.get(work)) === JSON.stringify({ id: work, name: '仕事用' }) && await accounts.get('acct-none') === null);
    t.ok('has は登録の有無', await accounts.has(home) && !(await accounts.has('acct-none')));
    t.ok('resolve は id と名前（トークンは持たない）', JSON.stringify(await accounts.resolve(work)) === JSON.stringify({ id: work, name: '仕事用' }));

    // ---- 名前の重複（前後の空白だけ除いて比べる。大文字小文字は区別する）
    const codeOf = async fn => { try { await fn(); } catch (e) { return e.code ?? e.message; } return null; };
    t.ok('ログインの前の検査: 同じ名前は bad-name で止める', (await codeOf(() => accounts.assertNameFree(' 仕事用 '))) === 'bad-name');
    t.ok('ログインの前の検査: 空の名前も bad-name', (await codeOf(() => accounts.assertNameFree(''))) === 'bad-name');
    t.ok('同じ名前の追加は bad-name で止める', (await codeOf(() => accounts.add({ id: newAccountId(), name: '仕事用' }))) === 'bad-name' && (await accounts.list()).accounts.length === 2);
    t.ok('同じ id の追加は止める', Boolean(await codeOf(() => accounts.add({ id: work, name: '別名' }))));
    const msg = async fn => { try { await fn(); } catch (e) { return e.message; } return null; };
    t.ok('ほかのアカウントと同じ名前への変更は止める', (await msg(() => accounts.rename({ id: home, name: '仕事用' }))) === '同じ名前のアカウントがあります'
      && (await accounts.get(home)).name === '個人用');
    t.ok('自分の名前のままの保存と、大文字小文字だけ違う名前は通す', (await msg(() => accounts.rename({ id: work, name: '仕事用' }))) === null
      && (await msg(() => accounts.rename({ id: home, name: 'Work' }))) === null && (await msg(() => accounts.assertNameFree('work'))) === null);
    t.ok('登録していない id は名前を変えられない', Boolean(await msg(() => accounts.rename({ id: 'acct-none', name: 'x' }))));
    // 重複を許す前の既存データ: 読めて、名前を変えない保存は通り、片方を変えれば解消する
    const regFile = path.join(dir, 'claude-accounts.json');
    const reg = JSON.parse(await fs.readFile(regFile, 'utf8'));
    reg.accounts.find(x => x.id === work).name = 'Work';
    await fs.writeFile(regFile, JSON.stringify(reg));
    t.ok('すでに同名が 2 つあるデータも一覧で読める', (await accounts.list()).accounts.filter(x => x.name === 'Work').length === 2);
    t.ok('既存の同名は、名前を変えない保存ができる', (await msg(() => accounts.rename({ id: work, name: 'Work' }))) === null);
    t.ok('既存の同名は、片方の名前を変えれば解消する', (await msg(() => accounts.rename({ id: work, name: '仕事用' }))) === null
      && (await msg(() => accounts.rename({ id: work, name: 'Work' }))) === '同じ名前のアカウントがあります');

    // ---- 載せる前のアカウントの片付け（ログインの取り消し・失敗）
    const pending = newAccountId();
    await fs.mkdir(accounts.usageDir(pending), { recursive: true });
    await fs.writeFile(path.join(accounts.usageDir(pending), '.credentials.json'), '{}');
    await accounts.discard(pending);
    t.ok('discard は載せる前のアカウントの設定フォルダを消す', await fs.access(accounts.usageDir(pending)).then(() => false, () => true));
    await accounts.discard(work);
    t.ok('discard は一覧に載っているアカウントを消さない', await accounts.has(work) && await accounts.hasUsageLogin(work));

    // ---- ログインの印と切れの印
    const usageDir = accounts.usageDir(work);
    t.ok('設定フォルダはデータ置き場の claude-usage/<id>', path.resolve(usageDir) === path.resolve(dir, 'claude-usage', work));
    let badId = null; try { accounts.usageDir('../x'); } catch (e) { badId = e; }
    t.ok('id でないものからフォルダを作らない', Boolean(badId));
    t.ok('切れの印を置ける（2 度目は変わらない）', (await accounts.markUsageExpired(work, 'expired')).changed === true && (await accounts.markUsageExpired(work)).changed === false);
    t.ok('切れの印は一覧に出る', (await accounts.list()).accounts.find(x => x.id === work).usageExpired === true);
    await accounts.markUsageLogin(work);
    t.ok('ログインし直すと切れの印は消える', (await accounts.list()).accounts.find(x => x.id === work).usageExpired === false);
    await accounts.markUsageExpired(work);
    t.ok('clearUsageExpired でも消える', (await accounts.clearUsageExpired(work)).changed === true && !(await accounts.isUsageExpired(work)));
    let unknown = null; try { await accounts.markUsageLogin('acct-none'); } catch (e) { unknown = e; }
    t.ok('登録していないアカウントにはログインの印を付けない', Boolean(unknown));
    await fs.rm(path.join(accounts.usageDir(home), 'ply-usage-login.json'));
    t.ok('ログインの印が無いアカウントには切れの印も付けない', (await accounts.markUsageExpired(home)).changed === false);
    const targets = await accounts.usageTargets();
    t.ok('使用量の対象は設定フォルダとログインの有無', targets.length === 2 && targets.find(x => x.id === work).usageLogin === true
      && targets.find(x => x.id === home).usageLogin === false && targets.every(x => x.configDir === accounts.usageDir(x.id)));

    // ---- 本人の見分け（委譲の振り分け）
    await fs.writeFile(path.join(usageDir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG_WORK, emailAddress: 'work@example.com' } }));
    const ids = await accounts.identities();
    t.ok('identities: ログインの済んだアカウントは設定フォルダの .claude.json から本人を読む', ids.login === null
      && JSON.stringify(ids.accounts.find(x => x.id === work).identity) === JSON.stringify({ org: ORG_WORK, email: 'work@example.com' })
      && ids.accounts.find(x => x.id === home).identity === null && ids.accounts.find(x => x.id === home).usageLogin === false);

    // ---- 削除
    await accounts.remove(work);
    t.ok('削除すると設定フォルダ（CLI の資格情報）も消える', await fs.access(usageDir).then(() => false, () => true));
    let gone = null;
    try { await accounts.resolve(work); } catch (e) { gone = e; }
    t.ok('削除したアカウントは止める（黙ってログイン中へ落とさない）', gone instanceof AccountError && gone.code === 'deleted');
    let twice = null;
    try { await accounts.remove(work); } catch (e) { twice = e; }
    t.ok('無いものは消せない', Boolean(twice));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }

  // ---- 0.43.0-beta.24 より前の会話用トークンの片付け（ADR 0353）
  {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-legacy-'));
    try {
      const id = newAccountId();
      await fs.writeFile(path.join(data, 'claude-account-secrets.json'), JSON.stringify({ version: 1, entries: { [`claude-account:${id}`]: { enc: 'plain', data: LEGACY_TOKEN } } }));
      await fs.writeFile(path.join(data, 'claude-account-secrets.json.lock'), '');
      await fs.mkdir(path.join(data, 'claude-login-tmp', 'x'), { recursive: true });
      await fs.writeFile(path.join(data, 'claude-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id, name: '前から', tokenOrg: ORG_WORK, tokenCheckedAt: '2026-01-01T00:00:00Z' }] }));
      const accounts = createClaudeAccounts({ dataDir: data, cliConfig: path.join(data, 'no-cli.json') });
      const first = await accounts.dropLegacyTokens();
      const exists = p => fs.access(path.join(data, p)).then(() => true, () => false);
      t.ok('会話用トークンの置き場（と錠）を消す', first.removed === true && !(await exists('claude-account-secrets.json')) && !(await exists('claude-account-secrets.json.lock')));
      t.ok('前のログインの作業フォルダも消す', !(await exists('claude-login-tmp')));
      const registry = await fs.readFile(path.join(data, 'claude-accounts.json'), 'utf8');
      t.ok('一覧から持ち主の照合の記録（tokenOrg・tokenCheckedAt）を消し、アカウントは残す', !registry.includes('tokenOrg') && !registry.includes('tokenCheckedAt')
        && JSON.parse(registry).accounts[0].id === id && JSON.parse(registry).accounts[0].name === '前から');
      t.ok('ログインの無い前からのアカウントは、ログインし直すまで usageLogin: false', (await accounts.list()).accounts[0].usageLogin === false);
      t.ok('2 度目は何も消さない', (await accounts.dropLegacyTokens()).removed === false);
      const none = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-legacy-none-'));
      t.ok('何も無いデータ置き場でも失敗しない', (await createClaudeAccounts({ dataDir: none }).dropLegacyTokens()).removed === false);
      await fs.rm(none, { recursive: true, force: true });
    } finally { await fs.rm(data, { recursive: true, force: true }); }
  }

  // ---- 設定の .claude.json
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-oauth-'));
  try {
    const cliFile = path.join(dir2, 'home', '.claude.json');
    await fs.mkdir(path.dirname(cliFile), { recursive: true });
    await fs.writeFile(cliFile, String.fromCharCode(0xfeff) + JSON.stringify({ numStartups: 3, oauthAccount: { organizationUuid: ORG_WORK, emailAddress: 'work@example.com', accountUuid: 'x' } }));
    t.ok('.claude.json のログイン中のアカウント（BOM 付きでも読む）', JSON.stringify(await readOauthAccount(cliFile)) === JSON.stringify({ org: ORG_WORK, email: 'work@example.com' }));
    t.ok('無い・壊れた .claude.json は null', await readOauthAccount(path.join(dir2, 'none.json')) === null);
    t.ok('CLI の .claude.json は CLAUDE_CONFIG_DIR の中、無ければホームの直下',
      cliConfigFile({ CLAUDE_CONFIG_DIR: path.join(dir2, 'cfg') }, '/h') === path.join(dir2, 'cfg', '.claude.json') && cliConfigFile({}, path.join(dir2, 'h')) === path.join(dir2, 'h', '.claude.json'));
  } finally { await fs.rm(dir2, { recursive: true, force: true }); }
}
