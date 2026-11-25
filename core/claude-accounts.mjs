// Claude のアカウントの切り替え（会話ごと）。
//
// アカウントごとに専用の設定フォルダ（<data>/claude-usage/<id>/）で claude.ai にログインしておき、その会話の子 CLI に
// CLAUDE_CONFIG_DIR として渡す（専用フォルダ方式。ADR 0345・0350・0352。準備とリンクは core/claude-connectors-auth.mjs・
// core/claude-own-dir.mjs）。process.env は書き換えない（書き換えると Pleiad から起動するすべての会話がそのアカウントになる）。
// 履歴（projects/）・skills・plugins・settings.json は共有の ~/.claude へリンクするので、会話の途中でアカウントを変えても
// resume で続きから話せる。ログインの更新は CLI が自分で行う。Pleiad はトークンを持たない。
//
// 何も選んでいない会話（'' = ログイン中のアカウント）は env に何も足さない＝今までと同じ動き。
//
// 置き場:
//   <data>/claude-accounts.json   一覧（id と表示名。秘密は入れない）
//   <data>/claude-usage/<id>/     そのアカウントの設定フォルダ（CLAUDE_CONFIG_DIR）。Pleiad がここで `claude auth login` を回す
//                                 （core/claude-login.mjs）。済むと ply-usage-login.json を置く。会話・使用量・モデル一覧・コネクターが使う
//
// 0.43.0-beta.24 より前は、会話用の長期トークン（claude setup-token）を <data>/claude-account-secrets.json に置いていた。
// 起動時に dropLegacyTokens() で消す（ADR 0352）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { t } from './i18n.mjs';
import { unlinkClaudeOwnDirLinks, withClaudeUsageDir } from './claude-own-dir.mjs';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 60;
const USAGE_MARKER = 'ply-usage-login.json';
const USAGE_EXPIRED_MARKER = 'ply-usage-expired.json';
const ORG = /^[A-Za-z0-9-]{8,64}$/;
// 0.43.0-beta.24 より前の置き場（ADR 0352 で使わなくなった）
const LEGACY_SECRETS = 'claude-account-secrets.json';
const LEGACY_LOGIN_SCRATCH = 'claude-login-tmp';
const LEGACY_FIELDS = ['tokenOrg', 'tokenCheckedAt'];

export function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error(t('claude.accounts.nameRequired'));
  if (name.length > MAX_NAME) throw new Error(t('claude.accounts.nameTooLong', { max: MAX_NAME }));
  return name;
}

/** 新しいアカウントの id。ログインが済むまで一覧には載せない（core/claude-login.mjs） */
export function newAccountId() {
  return 'acct-' + crypto.randomBytes(6).toString('hex');
}

/** Claude Code の設定（.claude.json）でログインしているアカウント。{ org, email } か null */
export async function readOauthAccount(file) {
  try {
    const account = JSON.parse((await fs.readFile(file, 'utf8')).trimStart())?.oauthAccount;
    const org = typeof account?.organizationUuid === 'string' && ORG.test(account.organizationUuid) ? account.organizationUuid : null;
    if (!org) return null;
    return { org, email: typeof account.emailAddress === 'string' && account.emailAddress ? account.emailAddress : null };
  } catch { return null; }
}

/** CLI（共有の設定フォルダ）の .claude.json。CLAUDE_CONFIG_DIR があればその中、無ければホームの直下 */
export function cliConfigFile(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
}

/** 選んだアカウントを使えないときのエラー。code で見分ける（deleted ほか。core/claude-connectors-auth.mjs の connectors-*） */
export class AccountError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {string} [o.cliConfig]      ログイン中のアカウントの .claude.json（既定は cliConfigFile()）
 * @param {(dir: string) => unknown} [o.logout]  アカウントを消す前に、その設定フォルダのログインを CLI に消させる（macOS。ADR 0351）
 */
export function createClaudeAccounts({ dataDir, cliConfig = cliConfigFile(), logout = null } = {}) {
  const file = path.join(dataDir, 'claude-accounts.json');
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };

  async function read() {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (raw?.version !== 1 || !Array.isArray(raw.accounts)) throw new Error('bad');
      return { version: 1, accounts: raw.accounts.filter(a => ID.test(a?.id ?? '') && typeof a.name === 'string') };
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, accounts: [] };
      throw new Error(t('claude.accounts.listBroken'));
    }
  }
  async function write(data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, file); break; }
        catch (e) {
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
          await new Promise(done => setTimeout(done, 20 * (attempt + 1)));
        }
      }
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }
  const usageRoot = path.join(dataDir, 'claude-usage');
  const usageDir = id => {
    if (!ID.test(id ?? '')) throw new Error(t('claude.accounts.badId'));
    return path.join(usageRoot, id);
  };
  const usageMarker = id => path.join(usageDir(id), USAGE_MARKER);
  const expiredMarker = id => path.join(usageDir(id), USAGE_EXPIRED_MARKER);
  const hasUsageLogin = id => fs.access(usageMarker(id)).then(() => true, () => false);
  const isUsageExpired = id => fs.access(expiredMarker(id)).then(() => true, () => false);
  const writeMarker = (target, data) => fs.writeFile(target, JSON.stringify(data) + '\n', { mode: 0o600 });
  const usageAccount = id => readOauthAccount(path.join(usageDir(id), '.claude.json'));
  /** 名前の重複（比べ方は normalizeName と同じ: 前後の空白だけ除く・大文字小文字は区別する） */
  const taken = (data, label, skip = null) => data.accounts.some(a => a.id !== skip && a.name.trim() === label);
  const badName = e => Object.assign(e, { code: 'bad-name' });

  /** 設定フォルダを片付ける（ログアウト・リンクを外す・フォルダを消す）。一覧には触らない */
  async function discardDir(dir) {
    // macOS はフォルダを消す前に CLI に自分のキーチェーンの項目を消させる（ADR 0351。失敗しても削除は止めない）
    if (logout) await Promise.resolve().then(() => logout(dir)).catch(() => {});
    await unlinkClaudeOwnDirLinks(dir);
    const info = await fs.lstat(dir).catch(err => { if (err.code !== 'ENOENT') throw err; });
    return async () => {
      if (info?.isSymbolicLink()) await fs.unlink(dir);
      else await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    };
  }

  return {
    file,
    /** 一覧。usageLogin はその設定フォルダでログインが済んでいるか（会話に使えるか）、usageExpired はログインが切れた印 */
    async list() {
      const { accounts } = await read();
      return {
        accounts: await Promise.all(accounts.map(async a => {
          const usageLogin = await hasUsageLogin(a.id);
          return { id: a.id, name: a.name, usageLogin, usageExpired: usageLogin ? await isUsageExpired(a.id) : false };
        })),
      };
    },
    async has(id) {
      return (await read()).accounts.some(a => a.id === id);
    },
    /** 一覧の 1 行（{ id, name }）。無ければ null */
    async get(id) {
      const entry = (await read()).accounts.find(a => a.id === id);
      return entry ? { id: entry.id, name: entry.name } : null;
    },
    /**
     * 追加の前の検査（ブラウザーでの認可を回す前に止めるため）。名前が不正・重複なら例外（code: bad-name。
     * 画面はこれだけを名前の欄に出し、ほかの失敗は流れの所に［やり直す］と出す。web/claude-accounts.mjs）
     */
    async assertNameFree(name) {
      let label;
      try { label = normalizeName(name); } catch (e) { throw badName(e); }
      if (taken(await read(), label)) throw badName(new Error(t('claude.accounts.nameDuplicate')));
    },
    /** 名前の変更。すでに同名が 2 つある既存のデータは読めて使える。名前を変えない保存は通し、片方を変えれば解消する */
    rename({ id, name } = {}) {
      return serial(async () => {
        const data = await read();
        const label = normalizeName(name);
        const entry = data.accounts.find(a => a.id === id);
        if (!entry) throw new Error(t('claude.accounts.notRegistered'));
        if (entry.name.trim() !== label && taken(data, label, id)) throw new Error(t('claude.accounts.nameDuplicate'));
        entry.name = label;
        await write(data);
        return { id };
      });
    },
    /**
     * ログインが済んだ新しいアカウントを載せ、印を置く（id は newAccountId() で先に決めて、その設定フォルダでログインした。core/claude-login.mjs）。
     * 名前が重なったら例外（code: bad-name）。そのときの設定フォルダの片付けは呼ぶ側（discard）
     */
    add({ id, name } = {}) {
      return serial(async () => {
        const data = await read();
        let label;
        try { label = normalizeName(name); } catch (e) { throw badName(e); }
        if (taken(data, label)) throw badName(new Error(t('claude.accounts.nameDuplicate')));
        if (data.accounts.some(a => a.id === id)) throw new Error(t('claude.accounts.badId'));
        await fs.mkdir(usageDir(id), { recursive: true });
        await writeMarker(usageMarker(id), { at: new Date().toISOString() });
        data.accounts.push({ id, name: label, createdAt: new Date().toISOString() });
        await write(data);
        return { id };
      });
    },
    /** 載せる前のアカウント（ログインの取り消し・失敗）の設定フォルダを片付ける。一覧に載っている id は消さない */
    discard(id) {
      return serial(async () => {
        if ((await read()).accounts.some(a => a.id === id)) return;
        const dir = usageDir(id);
        await withClaudeUsageDir(dir, async () => { await (await discardDir(dir))(); });
      });
    },
    remove(id) {
      return serial(async () => {
        const data = await read();
        const next = data.accounts.filter(a => a.id !== id);
        if (next.length === data.accounts.length) throw new Error(t('claude.accounts.notRegistered'));
        const dir = usageDir(id);
        await withClaudeUsageDir(dir, async () => {
          const rm = await discardDir(dir);
          await write({ ...data, accounts: next });
          await rm();
        });
      });
    },
    /**
     * 0.43.0-beta.24 より前の会話用トークン（setup-token）と持ち主の照合の記録を消す（ADR 0352）。起動時に 1 度。
     * トークンは以後読まない。復号は要らない（ファイルごと消す）。{ removed } は消したものがあったか
     */
    dropLegacyTokens() {
      return serial(async () => {
        let removed = false;
        for (const name of [LEGACY_SECRETS, `${LEGACY_SECRETS}.lock`]) {
          const target = path.join(dataDir, name);
          if (await fs.rm(target, { force: false }).then(() => true, () => false)) removed = true;
        }
        await fs.rm(path.join(dataDir, LEGACY_LOGIN_SCRATCH), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
        let data;
        try { data = await read(); } catch { return { removed }; }
        if (data.accounts.some(a => LEGACY_FIELDS.some(f => Object.hasOwn(a, f)))) {
          for (const a of data.accounts) for (const f of LEGACY_FIELDS) delete a[f];
          await write(data);
          removed = true;
        }
        return { removed };
      });
    },
    /** そのアカウントの設定フォルダ（CLAUDE_CONFIG_DIR）。作りはしない */
    usageDir,
    hasUsageLogin,
    isUsageExpired,
    /** 使用量・会話・コネクターで認証切れが分かった印を置く */
    async markUsageExpired(id, reason = 'expired') {
      if (!(await hasUsageLogin(id))) return { changed: false };
      if (await isUsageExpired(id)) return { changed: false };
      await fs.mkdir(usageDir(id), { recursive: true });
      await writeMarker(expiredMarker(id), { at: new Date().toISOString(), reason });
      return { changed: true };
    },
    async clearUsageExpired(id) {
      if (!(await isUsageExpired(id))) return { changed: false };
      await fs.rm(expiredMarker(id), { force: true }).catch(() => {});
      return { changed: true };
    },
    /** 登録済みのアカウントのログイン（`claude auth login`）が済んだ印を置く（期限切れの印があれば消す） */
    async markUsageLogin(id) {
      if (!(await read()).accounts.some(a => a.id === id)) throw new Error(t('claude.accounts.notRegistered'));
      await fs.mkdir(usageDir(id), { recursive: true });
      await writeMarker(usageMarker(id), { at: new Date().toISOString() });
      await fs.rm(expiredMarker(id), { force: true }).catch(() => {});
    },
    /**
     * 委譲の振り分けで同じ人のアカウントを見分ける手がかり（core/delegation-routing.mjs の sameIdentity）。
     * login はログイン中のアカウント、accounts[].identity はそのアカウントの設定フォルダでログインしたアカウント（{ org, email } か null）。
     * usageLogin はログインが済んでいるか（会話に使えるか）
     */
    async identities() {
      const [{ accounts }, login] = await Promise.all([read(), readOauthAccount(cliConfig)]);
      return { login, accounts: await Promise.all(accounts.map(async a => {
        const usageLogin = await hasUsageLogin(a.id);
        return { id: a.id, usageLogin, identity: usageLogin ? await usageAccount(a.id) : null };
      })) };
    },
    /** 使用量の表示に使うアカウント（設定フォルダで読む） */
    async usageTargets() {
      const { accounts } = await read();
      return Promise.all(accounts.map(async a => ({ id: a.id, name: a.name, configDir: usageDir(a.id), usageLogin: await hasUsageLogin(a.id) })));
    },
    /**
     * 会話で使うアカウントを引く。'' / 未指定はログイン中のアカウント（null を返す＝env に何も足さない）。
     * 削除済みは AccountError（黙ってログイン中のアカウントへ落とさない）。ログインの有無は起動の前の検査が見る（core/claude-connectors-auth.mjs）
     */
    async resolve(id) {
      if (!id) return null;
      const entry = (await read()).accounts.find(a => a.id === id);
      if (!entry) throw new AccountError(t('claude.accounts.deleted'), 'deleted');
      return { id, name: entry.name };
    },
  };
}
