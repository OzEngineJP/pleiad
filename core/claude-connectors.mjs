// 登録した Claude アカウントで claude.ai のコネクターを使うかの設定（ADR 0340・0352）。
// アカウントごとに 1 つのスイッチ。未設定・読めない・知らない版・知らない値はすべてオフ。
//   <データ置き場>/claude-account-connectors.json = { version: 1, accounts: { <アカウント id>: { enabled: true } } }
//   （秘密を含まない。claude-accounts.json の版は上げない。claude-connectors.json は設定 › 外部 MCP のコネクターの一覧の覚えで別のもの）
//   コネクターの名前ごとのオフは、同じアカウントの項目に後から足せる（今は読まない。知らない項目は無視する）
// 登録したアカウントは、オン・オフに関係なく専用フォルダのログインで会話する（core/claude-connectors-auth.mjs の createClaudeConnectorsWiring。ADR 0352）。
// オフのときは claude.ai のコネクターを出さない（ENABLE_CLAUDEAI_MCP_SERVERS=false）。保存済みの mode（b1 の時代の印）は読まない
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './atomic-file.mjs';

export const CONNECTORS_FILE = 'claude-account-connectors.json';
export const CONNECTORS_CACHE_FILE = 'claude-account-connectors-cache.json';
export const CONNECTORS_VERSION = 1;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CONNECTOR_NAME_MAX = 200;

/** 資格情報・メール・組織 id を平文で保存せず、認証世代の変化だけを識別するハッシュ */
export const hashConnectorIdentity = (parts) =>
  crypto.createHash('sha256').update(JSON.stringify(parts ?? null)).digest('hex').slice(0, 32);

const readJson = async (file) => {
  try { return { ok: true, data: JSON.parse(await fs.readFile(file, 'utf8')) }; }
  catch (e) { return e?.code === 'ENOENT' ? { ok: true, data: null } : { ok: false, data: null }; }
};
const writeJson = (file, data) => writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);

/**
 * 入口の設定。read(id) は書き込みをせず壊れていても投げない（段 1 互換）。
 * list() / setEnabled(id, enabled) / remove(id) は段 3 の保存・削除で使う。
 */
export function createClaudeConnectorSettings({ dataDir }) {
  const file = path.join(dataDir, CONNECTORS_FILE);
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };
  const validDoc = (raw) => raw?.version === CONNECTORS_VERSION && raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts);
  return {
    file,
    async read(accountId) {
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!validDoc(raw)) return { enabled: false };
        const entry = Object.hasOwn(raw.accounts, accountId) ? raw.accounts[accountId] : null;
        // 保存済みの mode（b1 の時代の印）は読まない。オンなら専用フォルダ方式（ADR 0350）
        return { enabled: entry?.enabled === true };
      } catch { return { enabled: false }; }
    },
    async list() {
      const { ok, data } = await readJson(file);
      if (!ok || !validDoc(data)) return {};
      const out = {};
      for (const [id, entry] of Object.entries(data.accounts)) {
        if (ID_RE.test(id) && entry && typeof entry === 'object' && !Array.isArray(entry)) {
          out[id] = entry.enabled === true;
        }
      }
      return out;
    },
    setEnabled(accountId, enabled) {
      if (!ID_RE.test(accountId ?? '')) throw new Error('Invalid Claude account id');
      return serial(async () => {
        const { ok, data } = await readJson(file);
        const doc = ok && data === null
          ? { version: CONNECTORS_VERSION, accounts: {} }
          : ok && validDoc(data)
            ? { version: CONNECTORS_VERSION, accounts: { ...data.accounts } }
            : null;
        if (!doc) throw new Error('claude-account-connectors.json is unreadable');
        const prev = doc.accounts[accountId];
        doc.accounts[accountId] = {
          ...(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}),
          enabled: Boolean(enabled),
        };
        // b1 の時代の mode の印は、書き直すときに捨てる
        delete doc.accounts[accountId].mode;
        await writeJson(file, doc);
        return { enabled: Boolean(enabled) };
      });
    },
    remove(accountId) {
      if (!ID_RE.test(accountId ?? '')) return Promise.resolve({ removed: false });
      return serial(async () => {
        const { ok, data } = await readJson(file);
        if (!ok || !validDoc(data) || !Object.hasOwn(data.accounts, accountId)) return { removed: false };
        const accounts = { ...data.accounts };
        delete accounts[accountId];
        await writeJson(file, { version: CONNECTORS_VERSION, accounts });
        return { removed: true };
      });
    },
  };
}

/**
 * アカウントごとの claude.ai コネクター一覧の覚え（秘密・メール・組織 id は保存しない。identityHash で認証・ホスト・CLI 版の組を分ける）。
 */
export function createClaudeConnectorsCache({ dataDir, maxAccounts = 50, maxConnectors = 200, now = () => Date.now() }) {
  const file = path.join(dataDir, CONNECTORS_CACHE_FILE);
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };
  const validDoc = (raw) => raw?.version === CONNECTORS_VERSION && raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts);
  const cleanEntry = (raw) => {
    if (!raw || typeof raw !== 'object' || typeof raw.identityHash !== 'string' || !Array.isArray(raw.connectors)) return null;
    const connectors = [...new Set(raw.connectors.filter((x) => typeof x === 'string'))].slice(0, CONNECTOR_NAME_MAX);
    const set = new Set(connectors);
    const needsAuth = Array.isArray(raw.needsAuth) ? [...new Set(raw.needsAuth.filter((x) => typeof x === 'string' && set.has(x)))] : [];
    const at = Number.isFinite(raw.at) ? raw.at : 0;
    return { identityHash: raw.identityHash, connectors, needsAuth, at };
  };
  return {
    file,
    async get(accountId, { identityHash, ttlMs } = {}) {
      if (!ID_RE.test(accountId ?? '') || !identityHash) return null;
      const { ok, data } = await readJson(file);
      if (!ok || !validDoc(data) || !Object.hasOwn(data.accounts, accountId)) return null;
      const entry = cleanEntry(data.accounts[accountId]);
      if (!entry || entry.identityHash !== identityHash) return null;
      const stale = Number.isFinite(ttlMs) ? now() - entry.at >= ttlMs : false;
      return { connectors: entry.connectors, needsAuth: entry.needsAuth, at: entry.at, stale };
    },
    set(accountId, { identityHash, connectors, needsAuth = [], at = now() }) {
      if (!ID_RE.test(accountId ?? '') || typeof identityHash !== 'string' || !identityHash || !Array.isArray(connectors)) {
        throw new Error('Invalid connectors cache entry');
      }
      return serial(async () => {
        const { ok, data } = await readJson(file);
        const accounts = ok && validDoc(data) ? { ...data.accounts } : {};
        const names = [...new Set(connectors.filter((x) => typeof x === 'string'))].sort().slice(0, maxConnectors);
        const set = new Set(names);
        accounts[accountId] = {
          identityHash,
          connectors: names,
          needsAuth: [...new Set((Array.isArray(needsAuth) ? needsAuth : []).filter((x) => typeof x === 'string' && set.has(x)))].sort(),
          at: Number.isFinite(at) ? at : now(),
        };
        const ids = Object.keys(accounts);
        if (ids.length > maxAccounts) {
          ids.sort((a, b) => (accounts[a]?.at ?? 0) - (accounts[b]?.at ?? 0));
          for (const drop of ids.slice(0, ids.length - maxAccounts)) delete accounts[drop];
        }
        await writeJson(file, { version: CONNECTORS_VERSION, accounts });
        return accounts[accountId];
      });
    },
    remove(accountId) {
      if (!ID_RE.test(accountId ?? '')) return Promise.resolve({ removed: false });
      return serial(async () => {
        const { ok, data } = await readJson(file);
        if (!ok || !validDoc(data) || !Object.hasOwn(data.accounts, accountId)) return { removed: false };
        const accounts = { ...data.accounts };
        delete accounts[accountId];
        await writeJson(file, { version: CONNECTORS_VERSION, accounts });
        return { removed: true };
      });
    },
  };
}

