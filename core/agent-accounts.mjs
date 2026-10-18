// Claude 以外のエージェントのアカウント（会話ごとに切り替える。ADR 0222）。Claude は今までの台帳（core/claude-accounts.mjs）のまま。
//
// アカウントの中身（資格情報の持ち方）はエージェントごとに違うので、ここは台帳と置き場だけを持つ:
//   <data>/agent-accounts.json         一覧（id・エージェント・表示名。秘密は入れない）
//   <data>/agent-account-secrets.json  アカウントの資格情報（core/secret-store.mjs。safeStorage で暗号化）。中身はエージェントが決める
//                                      （Codex・OpenCode は専用ホームの auth.json の中身）
//   <data>/accounts/<エージェント>/<id>/  アカウントの置き場（Codex は CODEX_HOME）。会話の記録は junction で本物の置き場と分け合う
// id はエージェントをまたいで一意（acct-<12 桁>）。会話の欄（claudeAccount。名前は歴史的）には、どのエージェントのアカウントの id も入る。
// 秘密はクライアントへ返さない（hasCredential だけ）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { t } from './i18n.mjs';

const SECRET_PREFIX = 'agent-account:';
const ID = /^acct-[0-9a-f]{12}$/;
const BACKEND = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_NAME = 60;
export const MAX_ACCOUNTS = 100;

export class AgentAccountError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const normalizeName = (name) => {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error(t('accounts.nameRequired'));
  return s.slice(0, MAX_NAME);
};

export function createAgentAccounts({ dataDir, secrets }) {
  const file = path.join(dataDir, 'agent-accounts.json');
  const root = path.join(dataDir, 'accounts');
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };
  const key = (id) => SECRET_PREFIX + id;

  async function read() {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (raw?.version !== 1 || !Array.isArray(raw.accounts)) throw new Error('bad');
      return { version: 1, accounts: raw.accounts.filter((a) => ID.test(a?.id ?? '') && BACKEND.test(a?.backend ?? '') && typeof a.name === 'string') };
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, accounts: [] };
      throw new Error(t('accounts.listBroken'));
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
          await new Promise((done) => setTimeout(done, 20 * (attempt + 1)));
        }
      }
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }
  const dirOf = (entry) => path.join(root, entry.backend, entry.id);

  /** 置き場を消す。junction はリンクだけを外す（リンク先の本物の会話の記録は消さない） */
  async function removeDir(dir) {
    async function walk(p) {
      const st = await fs.lstat(p).catch(() => null);
      if (!st) return;
      if (st.isSymbolicLink()) { await fs.unlink(p).catch(() => fs.rmdir(p).catch(() => {})); return; }
      if (st.isDirectory()) {
        for (const name of await fs.readdir(p).catch(() => [])) await walk(path.join(p, name));
        await fs.rmdir(p).catch(() => {});
        return;
      }
      await fs.rm(p, { force: true }).catch(() => {});
    }
    await walk(dir);
  }

  return {
    file,
    root,
    /** 一覧（backend を渡せばそのエージェントの分だけ）。秘密は返さず、持っているかだけ */
    async list(backend = null) {
      const [{ accounts }, keys] = await Promise.all([read(), secrets.keys(SECRET_PREFIX).catch(() => [])]);
      const stored = new Set(keys);
      return accounts.filter((a) => !backend || a.backend === backend)
        .map((a) => ({ id: a.id, backend: a.backend, name: a.name, createdAt: a.createdAt ?? null, hasCredential: stored.has(key(a.id)) }));
    },
    async get(id) {
      const entry = (await read()).accounts.find((a) => a.id === id);
      return entry ? { id: entry.id, backend: entry.backend, name: entry.name, dir: dirOf(entry) } : null;
    },
    async has(backend, id) { return (await read()).accounts.some((a) => a.id === id && a.backend === backend); },
    /** 足す（置き場も作る）。ログインはエージェントの口（backend.accounts.login）が、この置き場で行う */
    create({ backend, name }) {
      if (!BACKEND.test(backend ?? '')) throw new Error(t('accounts.badBackend'));
      const label = normalizeName(name);
      return serial(async () => {
        const data = await read();
        if (data.accounts.length >= MAX_ACCOUNTS) throw new Error(t('accounts.tooMany'));
        const id = 'acct-' + crypto.randomBytes(6).toString('hex');
        const entry = { id, backend, name: label, createdAt: new Date().toISOString() };
        await fs.mkdir(dirOf(entry), { recursive: true });
        data.accounts.push(entry);
        await write(data);
        return { id, backend, name: label, dir: dirOf(entry) };
      });
    },
    rename(id, name) {
      const label = normalizeName(name);
      return serial(async () => {
        const data = await read();
        const entry = data.accounts.find((a) => a.id === id);
        if (!entry) throw new AgentAccountError(t('accounts.notRegistered'), 'deleted');
        entry.name = label;
        await write(data);
        return { id, name: label };
      });
    },
    remove(id) {
      return serial(async () => {
        const data = await read();
        const entry = data.accounts.find((a) => a.id === id);
        if (!entry) throw new AgentAccountError(t('accounts.notRegistered'), 'deleted');
        await write({ ...data, accounts: data.accounts.filter((a) => a.id !== id) });
        await secrets.delete(key(id)).catch(() => {});
        await removeDir(dirOf(entry));
      });
    },
    /** 資格情報（エージェントが決めた形のオブジェクト）。無ければ null */
    async credential(id) {
      try { return (await secrets.get(key(id))) ?? null; }
      catch (e) { throw new AgentAccountError(t('accounts.credentialUnreadable', { message: e.message }), 'unreadable'); }
    },
    async setCredential(id, value) {
      if (!(await read()).accounts.some((a) => a.id === id)) throw new AgentAccountError(t('accounts.notRegistered'), 'deleted');
      await secrets.set(key(id), value);
    },
    async clearCredential(id) { await secrets.delete(key(id)).catch(() => {}); },
    /**
     * 会話で使うアカウントを引く。'' / 未指定、またはほかのエージェントのアカウントの id は、ログイン中のアカウント（null）。
     * 消したアカウントの id（台帳に無い）は AgentAccountError（黙ってログイン中のアカウントへ落とさない）
     */
    async resolve(backend, id, { known = () => false } = {}) {
      if (!id) return null;
      const entry = (await read()).accounts.find((a) => a.id === id);
      if (!entry) {
        // ほかの台帳（Claude）のアカウントなら、このエージェントでは使わない
        if (await known(id)) return null;
        throw new AgentAccountError(t('accounts.deleted'), 'deleted');
      }
      if (entry.backend !== backend) return null;
      const credential = await this.credential(id);
      if (!credential) throw new AgentAccountError(t('accounts.credentialMissing'), 'missing-credential');
      return { id, name: entry.name, dir: dirOf(entry), credential };
    },
  };
}
