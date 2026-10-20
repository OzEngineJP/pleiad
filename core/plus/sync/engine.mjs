// 同期のエンジン（docs/plus.md「同期」）。手元の項目を暗号化して上げ、ほかの PC の項目を受けて書く。
//
//   手元の覚え: <data>/plus/sync-state.json = { keyId, cursor, items: { <論理名>: { itemId, rev, sha256, deleted, mtime } } }
//   1 回の流れ: 鍵の始め方（keys.setup）→ 宛ての無いホストへ鍵を渡す → 受ける → 上げる。同時に 1 本だけ回す
//   いつ: start（Plus のセッションが plus になったとき）・手元の変更（fs.watch と設定の変更を 5 秒まとめる）・10 分ごと。
//     鍵の受け渡しだけは 5 分ごとにも見る
//   競合: 平文の mtime の新しい方を採り（同じなら相手）、負けた方を <data>/plus/sync-conflicts/<YYYYMMDD-HHmmss>/<論理名> に写す。
//     写しは作ってから 30 日を過ぎたら start のときに消す
//
// ログには論理名・中身・鍵を出さない（項目は itemId だけ）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../../atomic-file.mjs';
import { itemIdFor, itemPlaintext, encryptItem, decryptItem, ITEM_ID_RX } from './crypto.mjs';
import { skippedName, ITEM_LIMIT_BYTES } from './targets.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const SYNC_DEBOUNCE_MS = 5_000;
export const SYNC_RECEIVE_MS = 10 * MINUTE;
export const SYNC_SHARE_MS = 5 * MINUTE;
export const CONFLICT_KEEP_MS = 30 * DAY;
const BACKOFF_MAX_MS = 10 * MINUTE;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10_000;
const OWN_WRITE_MS = 10_000;
const STAMP_RX = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const STOP_CODES = new Set(['not_plus', 'account_disabled', 'unauthenticated']);

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const pad = n => String(n).padStart(2, '0');
const stampOf = ms => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const stampTime = name => { const m = STAMP_RX.exec(name); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
const emptyState = keyId => ({ keyId: keyId ?? null, cursor: 0, items: {} });

const defaultClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
const defaultWatch = (dir, opts, listener) => fs.watch(dir, opts, listener);

/**
 * @param {object} o
 * @param {{ request: Function }} o.client
 * @param {object} o.keys      createSyncKeys の結果
 * @param {object} o.targets   createSyncTargets の結果
 * @param {string} o.dataDir
 * @param {() => string|null} o.uid
 * @param {() => string|null} o.hostId
 * @param {(line: string) => void} [o.log]
 * @param {{ subscribe?: (fn: (keys: string[]) => void) => () => void }} [o.settingsEvents] 設定の変更の配信
 * @param {{ now, setTimeout, clearTimeout }} [o.clock]
 * @param {Function} [o.watch]  fs.watch と同じ形（試験の差し替え用）
 * @param {(status: object) => void} [o.onStatus]
 */
export function createSyncEngine({ client, keys, targets, dataDir, uid, hostId, log = () => {}, settingsEvents = null,
  clock = defaultClock, watch = defaultWatch, onStatus = () => {} }) {
  const plusDir = path.join(dataDir, 'plus');
  const stateFile = path.join(plusDir, 'sync-state.json');
  const conflictsDir = path.join(plusDir, 'sync-conflicts');

  let active = false;
  let key = null;               // { keyId, key, enc, id }
  let local = null;             // sync-state.json の中身
  let status = { state: 'off', lastSyncedAt: null, totalBytes: 0, limitBytes: 0, conflicts: 0, error: null };
  let quota = false;
  let running = null, again = null;
  let debounceTimer = null, receiveTimer = null, shareTimer = null, retryTimer = null;
  let backoffMs = 0;
  const watchers = new Map();   // dir → watcher
  const ownWrites = new Map();  // 絶対パス → { sha, at }（自分で書いたものを fs.watch が拾っても上げ直さない）
  const ownSettings = new Map(); // 設定の key → at
  const settingsChangedAt = new Map();
  const tooLarge = new Map();   // 論理名 → sha（413 too_large のものは中身が変わるまで上げない）
  let unsubscribe = null;

  function setStatus(patch) {
    const next = { ...status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    try { onStatus({ ...status }); } catch {}
  }

  // ---- 手元の覚え ------------------------------------------------------------------------------------------

  async function loadLocal() {
    if (local) return local;
    try {
      const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
      local = raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object'
        ? { keyId: raw.keyId ?? null, cursor: raw.cursor ?? 0, items: raw.items } : emptyState(null);
    } catch { local = emptyState(null); }
    return local;
  }
  async function saveLocal() {
    if (!local) return;
    await fsp.mkdir(plusDir, { recursive: true });
    await writeAtomic(stateFile, `${JSON.stringify(local)}\n`);
  }

  // ---- 競合の写し ------------------------------------------------------------------------------------------

  async function copyLoser(logical, content) {
    if (!content) return;
    const rel = logical.startsWith('settings/') ? `${logical}.json` : logical;
    const file = path.join(conflictsDir, stampOf(clock.now()), ...rel.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, content);
    log('sync conflict saved');
  }

  /** 30 日を過ぎた写しのフォルダーを消し、残りの写しの数を数える */
  async function sweepConflicts({ remove = false } = {}) {
    let count = 0;
    const names = await fsp.readdir(conflictsDir).catch(() => []);
    for (const name of names) {
      const at = stampTime(name);
      if (at === null) continue;
      const dir = path.join(conflictsDir, name);
      if (clock.now() - at > CONFLICT_KEEP_MS) {
        if (remove) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const files = await fsp.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
      count += files.filter(f => f.isFile()).length;
    }
    setStatus({ conflicts: count });
    return count;
  }

  // ---- 誤り -----------------------------------------------------------------------------------------------

  /** 回の途中の誤りを状態とやり直しの予定にする */
  function handleRunError(e) {
    const code = e?.code ?? 'error';
    if (e?.status === 403 && e.message === 'sync_disabled') { setStatus({ state: 'disabled', error: null }); return; }
    if (STOP_CODES.has(code) || e?.status === 401) {
      // セッションの扱い（B1）に従う。ここでは止めるだけ
      log(`sync stopped (${code})`);
      setStatus({ state: 'error', error: code });
      clearTimers();
      return;
    }
    if (e?.status === 429) {
      setStatus({ state: 'error', error: code });
      scheduleRetry(Math.max(1, Number(e.retryAfter) || 60) * 1000);
      return;
    }
    // 503・ネットの誤り・そのほか: 1 分・2 分・4 分…最大 10 分で張り直す
    backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs ? backoffMs * 2 : MINUTE);
    log(`sync error (${code}${e?.status ? ` ${e.status}` : ''})`);
    setStatus({ state: 'error', error: code });
    scheduleRetry(backoffMs);
  }

  // ---- 受ける ---------------------------------------------------------------------------------------------

  /** 受けた項目の平文。開けない・形が違う → null。ciphertext の無い消した項目は覚えの itemId から論理名を引く */
  function openItem(it) {
    if (!it.ciphertext) {
      if (!it.deleted) return null;
      const found = Object.entries(local.items).find(([, r]) => r.itemId === it.itemId);
      return found ? { path: found[0], mtime: it.updatedAt ?? new Date(clock.now()).toISOString(), deleted: true, content: null } : undefined;
    }
    return decryptItem({
      encKey: key.enc, idKey: key.id, keyId: key.keyId, uid: uid(), itemId: it.itemId, rev: it.rev, ciphertext: it.ciphertext,
      validPath: p => { const parsed = targets.parse(p); return Boolean(parsed) && (parsed.kind !== 'setting' || targets.hasSetting(parsed.key)); },
    });
  }

  function localMtime(logical, entry) {
    if (!entry) return clock.now();   // 手元で消した: 気づいた今
    if (entry.kind === 'setting') return settingsChangedAt.get(logical) ?? (local.items[logical] ? Date.parse(local.items[logical].mtime) || 0 : 0);
    return entry.mtimeMs ?? clock.now();
  }

  async function applyRemote(logical, plain) {
    const abs = targets.localFile(logical);
    if (plain.deleted) {
      if (abs) ownWrites.set(abs, { sha: null, at: clock.now() });
      else ownSettings.set(logical.slice('settings/'.length), clock.now());
      return targets.remove(logical);
    }
    if (abs) ownWrites.set(abs, { sha: sha256(plain.content), at: clock.now() });
    else ownSettings.set(logical.slice('settings/'.length), clock.now());
    return targets.write(logical, plain.content, plain.mtime);
  }

  async function receive(scan, { since } = {}) {
    let cursor = since ?? local.cursor ?? 0;
    let rekey = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const out = await client.request('GET', `/v1/sync/items?since=${encodeURIComponent(cursor)}&limit=${PAGE_LIMIT}`);
      const items = Array.isArray(out?.items) ? out.items : [];
      for (const it of items) {
        if (!it || !ITEM_ID_RX.test(String(it.itemId)) || !Number.isInteger(it.rev)) continue;
        if (it.keyId !== key.keyId) { rekey = true; continue; }
        const plain = openItem(it);
        if (plain === undefined) continue;   // 覚えに無い項目の、中身の無い消した印
        if (!plain) { log(`sync item rejected ${it.itemId}`); continue; }
        await receiveOne(it, plain, scan);
      }
      if (out?.cursor !== undefined && out.cursor !== null) cursor = out.cursor;
      if (since === undefined) local.cursor = cursor;
      if (!out?.more) break;
    }
    return { rekey };
  }

  async function receiveOne(it, plain, scan) {
    const logical = plain.path;
    const rec = local.items[logical];
    if (rec && rec.rev >= it.rev) return;   // もう持っている版（自分が上げたものを含む）
    const entry = scan.get(logical) ?? null;
    const localSha = entry ? sha256(entry.content) : null;
    const remoteSha = plain.deleted ? null : sha256(plain.content);
    const recSha = rec ? (rec.deleted ? null : rec.sha256) : undefined;
    const localChanged = rec ? localSha !== recSha : entry !== null;
    const record = () => { local.items[logical] = { itemId: it.itemId, rev: it.rev, sha256: remoteSha, deleted: plain.deleted, mtime: plain.mtime }; };

    if (!localChanged || localSha === remoteSha) {
      if (localSha !== remoteSha && !(await applyRemote(logical, plain))) { log(`sync item not applied ${it.itemId}`); return; }
      record();
      if (plain.deleted) scan.delete(logical);
      else scan.set(logical, { kind: entry?.kind ?? (logical.startsWith('settings/') ? 'setting' : 'file'), content: plain.content, mtimeMs: Date.parse(plain.mtime) });
      return;
    }
    // 競合: 平文の mtime の新しい方を採る（同じなら相手）
    const mine = localMtime(logical, entry);
    const theirs = Date.parse(plain.mtime) || 0;
    if (theirs >= mine) {
      await copyLoser(logical, entry?.content ?? null);
      if (!(await applyRemote(logical, plain))) { log(`sync item not applied ${it.itemId}`); return; }
      record();
      if (plain.deleted) scan.delete(logical);
      else scan.set(logical, { kind: entry?.kind ?? 'file', content: plain.content, mtimeMs: theirs });
    } else {
      await copyLoser(logical, plain.content);
      record();   // 相手の rev を土台にして、上げる段で手元の版を上げ直す
      if (entry?.kind === 'setting') settingsChangedAt.set(logical, mine);
    }
    await sweepConflicts();
  }

  // ---- 上げる ---------------------------------------------------------------------------------------------

  /** 1 項目を上げる。戻り値: 'ok' | 'conflict' | 'rekey' | 'skip' | 'quota' */
  async function uploadOne(logical, entry) {
    const rec = local.items[logical];
    const deleted = !entry;
    const sha = deleted ? null : sha256(entry.content);
    const baseRev = rec?.rev ?? 0;
    const itemId = rec?.itemId ?? itemIdFor(key.id, logical);
    const mtime = deleted ? clock.now() : (entry.kind === 'setting' ? (settingsChangedAt.get(logical) ?? (rec ? clock.now() : 0)) : entry.mtimeMs);
    const plaintext = itemPlaintext({ path: logical, mtime, deleted, content: entry?.content ?? null });
    // 平文（JSON にした形）が 1MB を超える項目は運ばない（api にも送らない）
    if (Buffer.byteLength(JSON.stringify(plaintext), 'utf8') > ITEM_LIMIT_BYTES) {
      tooLarge.set(logical, sha);
      log(`sync item too large ${itemId}`);
      return 'skip';
    }
    const ciphertext = encryptItem({ encKey: key.enc, keyId: key.keyId, uid: uid(), itemId, rev: baseRev + 1, plaintext });
    try {
      const out = await client.request('PUT', `/v1/sync/items/${itemId}`, { body: { baseRev, keyId: key.keyId, ciphertext, deleted, hostId: hostId() } });
      local.items[logical] = { itemId, rev: Number.isInteger(out?.rev) ? out.rev : baseRev + 1, sha256: sha, deleted, mtime: plaintext.mtime };
      tooLarge.delete(logical);
      return 'ok';
    } catch (e) {
      if (e?.status === 409 && e.code === 'conflict') return e.message === 'keyId' ? 'rekey' : 'conflict';
      if (e?.status === 413 && e.code === 'too_large') { tooLarge.set(logical, sha); log(`sync item too large ${itemId}`); return 'skip'; }
      if (e?.status === 413 && e.code === 'sync_quota') {
        const limitBytes = Number(e.body?.error?.limitBytes);
        if (Number.isFinite(limitBytes)) setStatus({ limitBytes });
        return 'quota';
      }
      if (e?.status === 400) { log(`sync item skipped ${itemId} (${String(e.message ?? '').slice(0, 120)})`); return 'skip'; }
      throw e;
    }
  }

  function changedPaths(scan) {
    const out = [];
    for (const [logical, entry] of scan) {
      const rec = local.items[logical];
      const sha = sha256(entry.content);
      if (tooLarge.get(logical) === sha) continue;
      if (!rec || rec.deleted || rec.sha256 !== sha) out.push(logical);
    }
    for (const [logical, rec] of Object.entries(local.items)) {
      if (!scan.has(logical) && !rec.deleted && targets.parse(logical)) out.push(logical);
    }
    return out;
  }

  async function upload(scan) {
    for (let pass = 0; pass < 3; pass++) {
      let conflicted = false;
      for (const logical of changedPaths(scan)) {
        const entry = scan.get(logical) ?? null;
        if (quota && entry) continue;   // 容量の上限: 新しい中身は上げない（消すのは上げる）
        const r = await uploadOne(logical, entry);
        if (r === 'rekey') return { rekey: true };
        if (r === 'quota') { quota = true; setStatus({ state: 'quota' }); }
        if (r === 'conflict') conflicted = true;
      }
      if (!conflicted) return { rekey: false };
      // 409 rev: 相手の版を受けて競合を解き、勝った手元の版をもう一度上げる
      const before = JSON.stringify(local.items);
      const r = await receive(scan);
      if (r.rekey) return { rekey: true };
      if (JSON.stringify(local.items) === before) await receive(scan, { since: 0 });
    }
    return { rekey: false };
  }

  // ---- 1 回の流れ -----------------------------------------------------------------------------------------

  async function runOnce({ full = true, forceNew = false } = {}) {
    await loadLocal();
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await keys.setup({ forceNew });
      forceNew = false;
      if (r.state) setStatus({ totalBytes: Number(r.state.totalBytes) || 0, limitBytes: Number(r.state.limitBytes) || 0 });
      if (r.status === 'disabled') { key = null; setStatus({ state: 'disabled', error: null }); return; }
      if (r.status === 'waiting_key') { key = null; setStatus({ state: 'waiting_key', error: null }); return; }
      key = r.key;
      if (r.changed || local.keyId !== key.keyId) {
        local = emptyState(key.keyId);
        settingsChangedAt.clear();
        tooLarge.clear();
        await saveLocal();
      }
      if (quota && r.state && (Number(r.state.totalBytes) || 0) < (Number(r.state.limitBytes) || 0)) quota = false;
      if ((await keys.sharePending(r.state, key)) === 'rekey') continue;
      if (!full) { setStatus({ state: quota ? 'quota' : (status.state === 'syncing' ? 'syncing' : 'idle'), error: null }); return; }

      setStatus({ state: 'syncing', error: null });
      const scan = await targets.scan();
      try {
        const got = await receive(scan);
        if (got.rekey) { await saveLocal(); continue; }
        const up = await upload(scan);
        if (up.rekey) { await saveLocal(); continue; }
      } finally {
        await saveLocal();
      }
      backoffMs = 0;
      setStatus({ state: quota ? 'quota' : 'idle', error: null, lastSyncedAt: new Date(clock.now()).toISOString() });
      return;
    }
  }

  /** 同時に 1 本だけ。回っている間に呼ばれたら、終わったあとにもう 1 回（まとめて）回す */
  function run(opts = {}) {
    if (!active) return Promise.resolve();
    if (running) {
      again = { full: Boolean(again?.full || opts.full !== false), forceNew: Boolean(again?.forceNew || opts.forceNew) };
      return running;
    }
    running = (async () => {
      let next = opts;
      try {
        while (active && next) {
          again = null;
          try { await runOnce(next); }
          catch (e) { handleRunError(e); }
          next = again;
        }
      } finally { running = null; }
    })();
    return running;
  }

  // ---- いつ回すか -----------------------------------------------------------------------------------------

  function clearTimers() {
    for (const id of [debounceTimer, receiveTimer, shareTimer, retryTimer]) if (id) clock.clearTimeout(id);
    debounceTimer = receiveTimer = shareTimer = retryTimer = null;
  }
  function scheduleRetry(ms) {
    if (!active) return;
    if (retryTimer) clock.clearTimeout(retryTimer);
    retryTimer = clock.setTimeout(() => { retryTimer = null; void run(); }, ms);
    retryTimer?.unref?.();
  }
  function scheduleReceive() {
    if (!active) return;
    receiveTimer = clock.setTimeout(() => { receiveTimer = null; scheduleReceive(); void run(); }, SYNC_RECEIVE_MS);
    receiveTimer?.unref?.();
  }
  function scheduleShare() {
    if (!active) return;
    shareTimer = clock.setTimeout(() => { shareTimer = null; scheduleShare(); void run({ full: false }); }, SYNC_SHARE_MS);
    shareTimer?.unref?.();
  }
  /** 手元の変更: 最初の変更から 5 秒まとめて 1 回回す */
  function changed() {
    if (!active || debounceTimer) return;
    debounceTimer = clock.setTimeout(() => { debounceTimer = null; void run(); }, SYNC_DEBOUNCE_MS);
    debounceTimer?.unref?.();
  }

  function onFsEvent(dir, name) {
    if (name && String(name).split(/[\\/]/).some(skippedName)) return;
    const abs = name ? path.join(dir, String(name)) : null;
    const own = abs ? ownWrites.get(abs) : null;
    if (own && clock.now() - own.at < OWN_WRITE_MS) {
      // 自分で書いた中身と同じなら上げ直さない
      void fsp.readFile(abs).then(buf => sha256(buf), () => null).then(sha => {
        if (sha === own.sha) return;
        ownWrites.delete(abs);
        changed();
      });
      return;
    }
    if (abs) ownWrites.delete(abs);
    changed();
  }

  function watchDir(dir, recursive, name) {
    if (watchers.has(dir)) return;
    let w;
    try {
      w = watch(dir, { recursive, persistent: false }, (_type, filename) => {
        if (name && filename && path.basename(String(filename)) !== name) return;
        onFsEvent(dir, filename);
      });
    } catch (e) {
      if (recursive && e?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') { watchTree(dir); return; }
      return;
    }
    w.on?.('error', () => { try { w.close(); } catch {} watchers.delete(dir); });
    watchers.set(dir, w);
  }
  /** 再帰の watch が使えないとき: フォルダーごとに張る（リンクと入れないものの下は張らない） */
  function watchTree(root) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      watchDir(dir, false, null);
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
      for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !skippedName(e.name)) stack.push(path.join(dir, e.name));
    }
  }
  function ensureWatchers() {
    for (const { dir, recursive, name } of targets.watchPlan()) {
      let st = null;
      try { st = fs.lstatSync(dir); } catch {}
      if (!st?.isDirectory() || st.isSymbolicLink()) continue;
      watchDir(dir, recursive, name);
    }
  }
  function closeWatchers() {
    for (const w of watchers.values()) { try { w.close(); } catch {} }
    watchers.clear();
  }

  function onSettingsChanged(changedKeys) {
    let any = false;
    for (const k of changedKeys ?? []) {
      if (!targets.hasSetting(k)) continue;
      const own = ownSettings.get(k);
      if (own !== undefined && clock.now() - own < OWN_WRITE_MS) { ownSettings.delete(k); continue; }
      settingsChangedAt.set(`settings/${k}`, clock.now());
      any = true;
    }
    if (any) changed();
  }

  // ---- 外へ出す口 -----------------------------------------------------------------------------------------

  async function start() {
    if (active) return run();
    active = true;
    await sweepConflicts({ remove: true });
    ensureWatchers();
    unsubscribe = settingsEvents?.subscribe?.(onSettingsChanged) ?? null;
    scheduleReceive();
    scheduleShare();
    const done = run();
    void done.then(() => ensureWatchers());
    return done;
  }

  function stop() {
    active = false;
    clearTimers();
    closeWatchers();
    try { unsubscribe?.(); } catch {}
    unsubscribe = null;
    key = null;
    quota = false;
    setStatus({ state: 'off', error: null });
  }

  /** 同期をやり直す: 新しい鍵で作り直し、手元の全部を上げ直す */
  function reset() { return run({ forceNew: true }); }

  /** ログアウト・アカウントの切り替え: 止めて、手元の覚えを捨てる（次のアカウントで最初から） */
  async function forget() {
    stop();
    local = emptyState(null);
    await saveLocal().catch(() => {});
  }

  return {
    start, stop, run, reset, forget, changed,
    status: () => ({ ...status }),
    conflictsDir,
    stateFile,
    /** 試験用: 今張っている watch の場所 */
    watching: () => [...watchers.keys()],
  };
}
