// 秘密情報と変数（ADR 0217。設定 › 秘密情報と変数、docs/design.md「秘密情報と変数」）。
//
// 人が預けた値を、AI が人の代わりに使えるようにする。使い道は 3 つで、登録しただけではどこにも渡さない（使い道を選ぶ操作が同意）。
//   - 環境変数として渡す（名前と渡す場所。会話のシェルにだけ入る。core/server.mjs の secretsRuntimeFor）
//   - サイトで入力する（ログイン情報。Pleiad が会話の Chrome のタブの origin を確かめて入れる。core/secret-fill.mjs）
//   - Pleiad の機能（API キーの uses・接続先の keyRef。core/api-keys.mjs のまま）
//
//   <data>/secrets.json        秘密でない台帳: { version, items: [...], keyUses: { <API キーの id>: { env, note } } }
//   <data>/secret-values.json  値（core/secret-store.mjs。エントリ item:<id>。秘密の値は { value }、ログイン情報は { password }）
// API キーの台帳（api-keys.json）は変えない。古い版の core/api-keys.mjs は知らない項目を書き戻しで落とすため、API キーの使い道は keyUses に id で持つ。
//
// 値は返り値・ログ・エラー文に出さない（変数の値だけは画面に出す）。値を読むのは、ターンの env を組むとき・サイトに入力するとき・伏せる値の一覧を作るときだけ。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic } from './atomic-file.mjs';
import { t } from './i18n.mjs';

export const VALUE_PREFIX = 'item:';
export const KINDS = Object.freeze(['login', 'secret', 'var']);
export const MAX_ITEMS = 500;
export const MAX_LABEL = 60;
export const MAX_NOTE = 300;
export const MAX_SITES = 20;
export const MAX_FOLDERS = 20;
export const MAX_VALUE = 16000;
export const MAX_USERNAME = 200;
const ID = /^sec-[a-f0-9]{12}$/;
const KEY_ID = /^key-[a-f0-9]{12}$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * 使えない名前。Pleiad 自身が渡すもの（会話の CLI・ブラウザー・起動の変数）と、上書きすると CLI が動かなくなるものだけ。
 * ANTHROPIC_*・OPENAI_* などは断らない（シェルにだけ渡すので、エージェントの CLI 本体の認証は替わらない。ADR 0217）。
 * Windows の環境変数は大文字小文字を区別しないので、比べるときは大文字にする
 */
const RESERVED_EXACT = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'ELECTRON_RUN_AS_NODE', 'CLAUDE_ENV_FILE']);
const RESERVED_PREFIXES = ['AGENT_HOST_', 'PLEIAD_', 'PLY_', 'AGENT_BROWSER_'];
export function reservedEnvName(name) {
  const upper = String(name ?? '').toUpperCase();
  return RESERVED_EXACT.has(upper) || RESERVED_PREFIXES.some(p => upper.startsWith(p));
}

/** 名前が秘密らしいか（.env の取り込みで、最初から秘密に付ける） */
export const looksSecret = name => /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE/i.test(String(name ?? ''));

/** code: INVALID / NOT_FOUND / RESERVED_NAME / DUPLICATE_NAME / TOO_MANY / FILE_BROKEN / NOT_ALLOWED / KEY_NOT_FOUND */
export class SecretsError extends Error {
  // i18n-dynamic: secrets.errors.
  constructor(code, params) { super(t(`secrets.errors.${code}`, params)); this.code = code; }
}

const iso = ms => new Date(ms).toISOString();
const emptyState = () => ({ version: 1, items: [], keyUses: {} });
const text = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);

/** 秘密の値の形。空・長すぎる・NUL を含むものは断る（改行や空白は値の一部として残す） */
export function normalizeSecretValue(value) {
  if (typeof value !== 'string') return null;
  if (!value || value.length > MAX_VALUE || value.includes('\0')) return null;
  return value;
}

/** サイトの書き方（https://example.com/login・example.com・*.example.com）をホストにする。読めなければ null */
export function normalizeSite(value) {
  let s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('*.')) s = s.slice(2);
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname; } catch { return null; }
  s = s.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) && s.length <= 253 ? s : null;
}

/** origin（https://www.example.com）が、登録したサイト（example.com）に合うか。https で、ホストが同じかそのサブドメイン */
export function siteMatches(sites, origin) {
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  return (sites ?? []).find(site => host === site || host.endsWith('.' + site)) ?? null;
}

/** フォルダーの書き方をそろえる（区切りは /、末尾の / は外す。Windows は大文字小文字を区別しないので、比べるときは小文字） */
export function normalizeFolder(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 1024 || !path.isAbsolute(s)) return null;
  return path.resolve(s).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}
const folderKey = (folder, platform) => (platform === 'win32' ? folder.toLowerCase() : folder);
/** dir が folder そのものか、その中か */
export function inFolder(dir, folder, platform = process.platform) {
  if (!dir) return false;
  const d = folderKey(dir, platform), f = folderKey(folder, platform);
  return d === f || d.startsWith(f.endsWith('/') ? f : f + '/');
}

/** 渡す場所（scope）の形: 'all' か { folders: [...] } */
export function normalizeScope(value) {
  if (value === 'all' || value == null) return 'all';
  const folders = [...new Set((Array.isArray(value?.folders) ? value.folders : []).map(normalizeFolder).filter(Boolean))].slice(0, MAX_FOLDERS);
  return folders.length ? { folders } : null;
}

/** 環境変数の使い道（{ name, scope }）を整える。null は使わない。形が違えば例外 */
export function normalizeEnv(value) {
  if (value == null || value === false) return null;
  const name = String(value.name ?? '').trim();
  if (!ENV_NAME.test(name)) throw new SecretsError('INVALID_NAME', { name });
  if (reservedEnvName(name)) throw new SecretsError('RESERVED_NAME', { name });
  const scope = normalizeScope(value.scope ?? 'all');
  if (!scope) throw new SecretsError('INVALID_SCOPE');
  return { name, scope };
}

function cleanItem(raw) {
  if (!ID.test(raw?.id ?? '') || !KINDS.includes(raw.kind) || typeof raw.label !== 'string') return null;
  let env = null;
  try { env = raw.env ? normalizeEnv(raw.env) : null; } catch { env = null; }
  return {
    id: raw.id, kind: raw.kind, label: text(raw.label, MAX_LABEL), note: text(raw.note, MAX_NOTE),
    ...(raw.kind === 'login' ? { username: text(raw.username, MAX_USERNAME) } : {}),
    ...(raw.kind === 'var' ? { value: typeof raw.value === 'string' ? raw.value.slice(0, MAX_VALUE) : '' } : {}),
    sites: raw.kind === 'login' ? [...new Set((Array.isArray(raw.sites) ? raw.sites : []).map(normalizeSite).filter(Boolean))].slice(0, MAX_SITES) : [],
    env,
    lastUse: raw.lastUse && typeof raw.lastUse === 'object' && typeof raw.lastUse.at === 'string'
      ? { at: raw.lastUse.at, sessionId: typeof raw.lastUse.sessionId === 'string' ? raw.lastUse.sessionId : null, site: typeof raw.lastUse.site === 'string' ? raw.lastUse.site : null } : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    by: raw.by === 'ai' ? 'ai' : 'human',
  };
}

function clean(raw) {
  if (raw?.version !== 1 || !Array.isArray(raw.items)) throw new Error('bad');
  const items = raw.items.map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS);
  const keyUses = {};
  for (const [id, use] of Object.entries(raw.keyUses ?? {})) {
    if (!KEY_ID.test(id)) continue;
    let env = null;
    try { env = use?.env ? normalizeEnv(use.env) : null; } catch { env = null; }
    const note = text(use?.note, MAX_NOTE);
    if (env || note) keyUses[id] = { env, note };
  }
  return { version: 1, items, keyUses };
}

const sameScope = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 同じ名前の環境変数の渡す場所が重なるか（すべて同士・同じフォルダーを含む） */
function scopesOverlap(a, b, platform) {
  if (a === 'all' || b === 'all') return a === 'all' && b === 'all';
  return a.folders.some(f => b.folders.some(g => folderKey(f, platform) === folderKey(g, platform)));
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {ReturnType<import('./secret-store.mjs').createSecretStore>} o.values  secret-values.json
 * @param {() => object|null} [o.apiKeys]  core/api-keys.mjs（API キーの名前・値。遅れて結ぶ）
 * @param {(cwd: string) => Promise<string|null>} [o.repoRoot]  cwd の git の本体のフォルダー（worktree なら元のリポジトリ）。無ければ null
 * @param {(change: object) => void} [o.onChange]
 */
export function createSecrets({ dataDir, values, apiKeys = () => null, repoRoot = async () => null, now = Date.now, log = () => {}, onChange = () => {}, platform = process.platform }) {
  const file = path.join(dataDir, 'secrets.json');
  let state = emptyState();
  let broken = false;
  let initPromise = null;
  let queue = Promise.resolve();
  let maskCache = null;   // 伏せる値の一覧（変わったら捨てる）
  const serial = fn => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };
  const emit = change => {
    maskCache = null;
    try { onChange(change); } catch (e) { log('secrets.on_change_failed', { code: String(e?.code ?? '') }); }
  };
  const keys = () => apiKeys?.() ?? null;

  async function load() {
    try { return clean(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (e) {
      if (e.code === 'ENOENT') return emptyState();
      // 壊れた台帳を黙って空で上書きしない
      throw new SecretsError('FILE_BROKEN');
    }
  }
  const save = async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await writeAtomic(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  };
  const mutate = fn => serial(async () => {
    const before = structuredClone(state);
    try { const out = await fn(state); await save(); return out; }
    catch (e) { state = before; throw e; }
  });
  async function init() {
    try { state = await load(); }
    catch (e) { state = emptyState(); broken = true; log('secrets.state_unreadable', { code: String(e?.code ?? '') }); }
  }
  const ensure = () => (initPromise ??= init());
  async function writable() {
    await ensure();
    if (broken) throw new SecretsError('FILE_BROKEN');
  }
  const known = id => state.items.find(i => i.id === id) ?? null;
  const need = id => { const item = known(String(id ?? '')); if (!item) throw new SecretsError('NOT_FOUND'); return item; };

  /** API キーの一覧（id → { label, provider }）。読めなければ空 */
  async function apiKeyMap() {
    const list = await keys()?.list?.().catch(() => null);
    return new Map((list?.keys ?? []).map(k => [k.id, k]));
  }

  /** 同じ名前で、渡す場所の重なる使い道があれば断る（self は自分自身を除く印） */
  function assertUniqueEnv(env, self) {
    if (!env) return;
    const upper = env.name.toUpperCase();
    const clash = (other, otherSelf) => other && otherSelf !== self && other.name.toUpperCase() === upper && scopesOverlap(other.scope, env.scope, platform);
    for (const item of state.items) if (clash(item.env, item.id)) throw new SecretsError('DUPLICATE_NAME', { name: env.name });
    for (const [id, use] of Object.entries(state.keyUses)) if (clash(use.env, id)) throw new SecretsError('DUPLICATE_NAME', { name: env.name });
  }

  function publicItem(item) {
    return { ...structuredClone(item) };
  }

  async function secretValue(item) {
    if (item.kind === 'var') return item.value ?? '';
    const stored = await values.get(VALUE_PREFIX + item.id);
    return item.kind === 'login' ? stored?.password ?? null : stored?.value ?? null;
  }

  /** cwd の場所の候補（cwd そのものと、git の本体のフォルダー） */
  async function placesOf(cwd) {
    const dir = normalizeFolder(cwd);
    if (!dir) return [];
    const root = await repoRoot(cwd).catch(() => null);
    const main = root ? normalizeFolder(root) : null;
    return [...new Set([dir, main].filter(Boolean))];
  }
  /** 渡す場所が cwd に合うか。合えば強さ（すべて = 0、フォルダー = 合ったフォルダーの長さ）、合わなければ -1 */
  const strength = (scope, places) => {
    if (scope === 'all') return 0;
    let best = -1;
    for (const f of scope.folders) if (places.some(p => inFolder(p, f, platform))) best = Math.max(best, f.length);
    return best;
  };

  const api = {
    file,
    init: ensure,
    async status() { await ensure(); return { broken }; },

    /** 設定のページと AI の一覧（secrets.list）。秘密の値は持たない（変数の値だけ） */
    async list() {
      await ensure();
      const storage = await values.status().catch(() => null);
      return {
        broken,
        storage: storage ? { encrypted: storage.encrypted, backend: storage.backend, ...(storage.reason ? { reason: storage.reason } : {}) } : null,
        items: state.items.map(publicItem),
        keyUses: structuredClone(state.keyUses),
      };
    },
    /** AI に見せる一覧（値を持たない。変数の値は持つ）。API キーは環境変数かメモのあるものだけ */
    async agentList() {
      await ensure();
      // API キーの一覧は、使い道を選んだキーがあるときだけ引く（引くと暗号化の状態を確かめ、main が居ない間は待つため。ターンを始めるたびに呼ばれる）
      const keyMap = Object.keys(state.keyUses).length ? await apiKeyMap() : new Map();
      const items = state.items.map(i => ({ id: i.id, kind: i.kind, label: i.label, ...(i.note ? { note: i.note } : {}),
        ...(i.kind === 'login' ? { username: i.username, sites: i.sites } : {}), ...(i.kind === 'var' ? { value: i.value } : {}),
        env: i.env, by: i.by, ...(i.lastUse ? { lastUse: { at: i.lastUse.at, site: i.lastUse.site } } : {}) }));
      for (const [id, use] of Object.entries(state.keyUses)) {
        const k = keyMap.get(id);
        if (k) items.push({ id, kind: 'apiKey', label: k.label || k.provider, ...(use.note ? { note: use.note } : {}), env: use.env, by: 'human' });
      }
      return { items };
    },

    async create({ kind, label, note, username, value, password, sites, env }, { by = 'human' } = {}) {
      await writable();
      if (!KINDS.includes(kind)) throw new SecretsError('INVALID');
      if (state.items.length >= MAX_ITEMS) throw new SecretsError('TOO_MANY', { max: MAX_ITEMS });
      const nextEnv = normalizeEnv(env);
      const name = text(label, MAX_LABEL) || nextEnv?.name || '';
      if (!name) throw new SecretsError('INVALID_LABEL');
      const nextSites = kind === 'login' ? [...new Set((sites ?? []).map(normalizeSite).filter(Boolean))].slice(0, MAX_SITES) : [];
      if (kind === 'login' && (sites ?? []).some(s => !normalizeSite(s))) throw new SecretsError('INVALID_SITE');
      let secret = null;
      if (kind === 'secret') { secret = normalizeSecretValue(value); if (!secret) throw new SecretsError('INVALID_VALUE'); }
      if (kind === 'login') { secret = normalizeSecretValue(password); if (!secret) throw new SecretsError('INVALID_VALUE'); }
      if (kind === 'var' && (typeof value !== 'string' || value.length > MAX_VALUE || value.includes('\0'))) throw new SecretsError('INVALID_VALUE');
      assertUniqueEnv(nextEnv, null);
      const id = 'sec-' + crypto.randomBytes(6).toString('hex');
      const at = iso(now());
      const item = cleanItem({ id, kind, label: name, note, username, value: kind === 'var' ? value : undefined, sites: nextSites, env: nextEnv, createdAt: at, updatedAt: at, by });
      if (secret !== null) await values.set(VALUE_PREFIX + id, kind === 'login' ? { password: secret } : { value: secret });
      try { await mutate(s => { s.items.push(item); }); }
      catch (e) { if (secret !== null) await values.delete(VALUE_PREFIX + id).catch(() => {}); throw e; }
      emit({ items: [id] });
      return { id, item: publicItem(item) };
    },

    /**
     * 変える。patch の欄だけ。secretValue は秘密の値・パスワードの差し替え（人の操作か、AI が作った項目だけ。呼ぶ側が確かめる）。
     * 変数を秘密の値にする（toSecret）のはよいが、秘密の値を変数に戻すことはしない
     */
    async update(id, patch = {}) {
      await writable();
      const item = need(id);
      const next = structuredClone(item);
      if (patch.label !== undefined) { next.label = text(patch.label, MAX_LABEL); if (!next.label) throw new SecretsError('INVALID_LABEL'); }
      if (patch.note !== undefined) next.note = text(patch.note, MAX_NOTE);
      if (patch.username !== undefined && item.kind === 'login') next.username = text(patch.username, MAX_USERNAME);
      if (patch.sites !== undefined && item.kind === 'login') {
        if ((patch.sites ?? []).some(s => !normalizeSite(s))) throw new SecretsError('INVALID_SITE');
        next.sites = [...new Set((patch.sites ?? []).map(normalizeSite).filter(Boolean))].slice(0, MAX_SITES);
      }
      if (patch.env !== undefined) next.env = normalizeEnv(patch.env);
      let secret = null;
      if (patch.value !== undefined && item.kind === 'var') {
        if (typeof patch.value !== 'string' || patch.value.length > MAX_VALUE || patch.value.includes('\0')) throw new SecretsError('INVALID_VALUE');
        next.value = patch.value;
      }
      if (patch.toSecret === true && item.kind === 'var') {
        secret = normalizeSecretValue(next.value ?? '');
        if (!secret) throw new SecretsError('INVALID_VALUE');
        next.kind = 'secret'; delete next.value;
      }
      if (patch.secretValue !== undefined) {
        if (item.kind === 'var') throw new SecretsError('INVALID');
        secret = normalizeSecretValue(patch.secretValue);
        if (!secret) throw new SecretsError('INVALID_VALUE');
      }
      assertUniqueEnv(next.env, item.id);
      next.updatedAt = iso(now());
      if (secret !== null) await values.set(VALUE_PREFIX + id, next.kind === 'login' ? { password: secret } : { value: secret });
      await mutate(s => { s.items[s.items.findIndex(i => i.id === id)] = next; });
      emit({ items: [id] });
      return { id, item: publicItem(next) };
    },

    /** 消す。値も消す（台帳を先に保存する。値の消し損ねは、台帳に無い項目の値として使われない） */
    async remove(id) {
      await writable();
      const item = need(id);
      await mutate(s => { s.items = s.items.filter(i => i.id !== id); });
      if (item.kind !== 'var') await values.delete(VALUE_PREFIX + id).catch(() => {});
      emit({ items: [id] });
      return { id, item: publicItem(item) };
    },

    /** API キーの使い道（環境変数・メモ）。env が null で、メモも空なら消す */
    async setKeyUse(keyId, { env, note } = {}) {
      await writable();
      const id = String(keyId ?? '');
      if (!KEY_ID.test(id) || !(await apiKeyMap()).has(id)) throw new SecretsError('KEY_NOT_FOUND');
      const before = state.keyUses[id] ?? { env: null, note: '' };
      const next = { env: env === undefined ? before.env : normalizeEnv(env), note: note === undefined ? before.note : text(note, MAX_NOTE) };
      assertUniqueEnv(next.env, id);
      await mutate(s => { if (next.env || next.note) s.keyUses[id] = next; else delete s.keyUses[id]; });
      emit({ keyUses: [id] });
      return { id, use: next.env || next.note ? structuredClone(next) : null };
    },
    /** API キーを消したとき（core/api-keys.mjs の onChange）。台帳に無いキーの使い道を外す */
    async pruneKeyUses() {
      await ensure();
      if (broken || !Object.keys(state.keyUses).length) return;
      const keyMap = await apiKeyMap();
      if (!keyMap.size && !(await keys()?.migrated?.().catch(() => false))) return;
      const gone = Object.keys(state.keyUses).filter(id => !keyMap.has(id));
      if (!gone.length) return;
      await mutate(s => { for (const id of gone) delete s.keyUses[id]; }).catch(e => log('secrets.prune_failed', { code: String(e?.code ?? '') }));
      emit({ keyUses: gone });
    },

    /**
     * .env の取り込み。entries: [{ name, value, secret }]。scope は全部に同じ。
     * 同じ名前・同じ場所の項目があれば値を差し替え（overwrite のときだけ）、無ければ足す。秘密の値は変数へ戻さない。API キーの使い道とは重ねない
     */
    async importEnv(entries, { scope = 'all', overwrite = false } = {}) {
      await writable();
      const target = normalizeScope(scope);
      if (!target) throw new SecretsError('INVALID_SCOPE');
      const result = { created: [], updated: [], skipped: [] };
      for (const e of entries ?? []) {
        const name = String(e?.name ?? '').trim();
        if (!ENV_NAME.test(name)) { result.skipped.push({ name, reason: 'invalid' }); continue; }
        if (reservedEnvName(name)) { result.skipped.push({ name, reason: 'reserved' }); continue; }
        if (typeof e.value !== 'string' || e.value.length > MAX_VALUE || e.value.includes('\0') || (e.secret && !e.value)) { result.skipped.push({ name, reason: 'invalid' }); continue; }
        const same = state.items.find(i => i.env && i.env.name.toUpperCase() === name.toUpperCase() && sameScope(i.env.scope, target));
        const keyClash = Object.values(state.keyUses).some(u => u.env && u.env.name.toUpperCase() === name.toUpperCase() && scopesOverlap(u.env.scope, target, platform));
        if (keyClash) { result.skipped.push({ name, reason: 'apiKey' }); continue; }
        try {
          if (same) {
            if (!overwrite) { result.skipped.push({ name, reason: 'exists' }); continue; }
            if (same.kind === 'login') { result.skipped.push({ name, reason: 'login' }); continue; }
            if (same.kind === 'var' && !e.secret) await api.update(same.id, { value: e.value });
            else if (same.kind === 'var') { await api.update(same.id, { value: e.value }); await api.update(same.id, { toSecret: true }); }
            else await api.update(same.id, { secretValue: e.value });
            result.updated.push(name);
          } else {
            await api.create({ kind: e.secret ? 'secret' : 'var', label: name, value: e.value, env: { name, scope: target } });
            result.created.push(name);
          }
        } catch (err) { result.skipped.push({ name, reason: err?.code === 'DUPLICATE_NAME' ? 'exists' : 'invalid' }); }
      }
      return result;
    },

    /**
     * cwd の会話のシェルへ渡す環境変数。フォルダーの使い道が「すべて」に勝ち、深いフォルダーが浅いフォルダーに勝つ。
     * 読めない値（暗号化を読めない起動）は渡さず、unreadable に名前を残す。entries は AI に見せる一覧（値は持たない。変数の値だけ）
     */
    async envFor(cwd) {
      await ensure();
      const places = await placesOf(cwd);
      const chosen = new Map();   // 大文字の名前 -> { strength, source }
      const consider = (env, source) => {
        if (!env) return;
        const s = strength(env.scope, places);
        if (s < 0) return;
        const key = env.name.toUpperCase();
        const prev = chosen.get(key);
        if (!prev || s > prev.strength) chosen.set(key, { strength: s, source, name: env.name });
      };
      for (const item of state.items) consider(item.env, { item });
      for (const [id, use] of Object.entries(state.keyUses)) consider(use.env, { keyId: id, note: use.note });
      const vars = {}, entries = [], unreadable = [];
      const keyMap = chosen.size ? await apiKeyMap() : new Map();
      for (const { source, name } of chosen.values()) {
        try {
          if (source.item) {
            const v = await secretValue(source.item);
            if (v == null || v === '' && source.item.kind !== 'var') { unreadable.push(name); continue; }
            vars[name] = v;
            entries.push({ name, kind: source.item.kind, label: source.item.label, ...(source.item.note ? { note: source.item.note } : {}), secret: source.item.kind !== 'var' });
          } else {
            const k = keyMap.get(source.keyId);
            const v = k ? await keys()?.keyValue?.(source.keyId) : null;
            if (!v) { unreadable.push(name); continue; }
            vars[name] = v;
            entries.push({ name, kind: 'apiKey', label: k.label || k.provider, ...(source.note ? { note: source.note } : {}), secret: true });
          }
        } catch (e) { unreadable.push(name); log('secrets.value_unreadable', { code: String(e?.code ?? '') }); }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return { vars, entries, unreadable };
    },

    /** サイトで入力するログイン情報。origin が登録したサイトに合わなければ NOT_ALLOWED（値は返さない） */
    async loginFor(id, origin) {
      await ensure();
      const item = need(id);
      if (item.kind !== 'login') throw new SecretsError('NOT_LOGIN');
      const site = siteMatches(item.sites, origin);
      if (!site) throw new SecretsError('SITE_MISMATCH', { label: item.label });
      const stored = await values.get(VALUE_PREFIX + item.id);
      return { item: publicItem(item), site, username: item.username, password: stored?.password ?? null };
    },
    /** サイトで入力したことを残す（最後の 1 回だけ。件数では増えない） */
    async recordUse(id, { sessionId = null, site = null } = {}) {
      await ensure();
      if (broken || !known(id)) return;
      await mutate(s => { const item = s.items.find(i => i.id === id); if (item) item.lastUse = { at: iso(now()), sessionId, site }; })
        .catch(e => log('secrets.record_failed', { code: String(e?.code ?? '') }));
      emit({ items: [id], use: true });
    },

    /** 画面・リモートへ出す前に伏せる値（秘密の値・パスワード・API キー。8 文字以上）。変数は伏せない */
    async maskValues() {
      await ensure();
      if (maskCache) return maskCache;
      const out = new Set();
      for (const item of state.items) {
        if (item.kind === 'var') continue;
        const v = await secretValue(item).catch(() => null);
        if (typeof v === 'string' && v.length >= 8) out.add(v);
      }
      const list = await keys()?.list?.().catch(() => null);
      for (const k of list?.keys ?? []) {
        const v = await keys()?.keyValue?.(k.id).catch(() => null);
        if (typeof v === 'string' && v.length >= 8) out.add(v);
      }
      maskCache = [...out].sort((a, b) => b.length - a.length);
      return maskCache;
    },
    /** API キーが変わったとき（伏せる値の一覧を作り直す） */
    invalidate() { maskCache = null; },
    known: id => (known(id) ? publicItem(known(id)) : null),
  };
  return api;
}
