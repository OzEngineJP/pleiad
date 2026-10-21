// 同期のエンジン（docs/plus.md「同期」）。手元の項目を暗号化して上げ、ほかの PC の項目を受ける。
//
//   手元の覚え: <data>/plus/sync-state.json = { keyId, cursor, items: { <論理名>: { itemId, rev, sha256, deleted, mtime } }, rejoinedAt, sharedTo, dropped }
//     rejoinedAt: 前の鍵を持っていて、別の鍵に替わった時刻。覚えを空にしたあと、手元の設定の mtime の代わりに使う
//       （始め直したほかの PC の「初めて上げた設定」に負けないように。初めての PC は 0 のままで、アカウントの設定を採る）
//     sharedTo: 鍵を渡した新しい PC（新しい順に 3 つ { hostId, name, at }。画面には 7 日の間だけ出す）
//     dropped: 人が捨てた版 { <論理名>: 中身の sha256 | 'deleted' }。同じ版が届き直しても待ちに出さない（違う版が来たら忘れる）
//   受け入れ待ち（ADR 0245）: ほかの PC から届いた skill・指示ファイルは書かずに <data>/plus/sync-inbox/<id>/ に置く
//     （id = 論理名の sha256 の先頭 32 字。incoming（消すときは無い）・base（手元に無いときは無い）・meta.json）。
//     人が「取り込む」と書き、「捨てる」と dropped に覚える。設定の項目は今のまま自動で書く。
//     待っている間の覚えは rev だけ進め、sha256 は手元の版のまま（手元の版を上げ直さない。手元で変えたものは上げる）
//   1 回の流れ: 鍵の始め方（keys.setup）→ 宛ての無いホストへ鍵を渡す → 受ける → 上げる。同時に 1 本だけ回す
//   いつ: start（Plus のセッションが plus になったとき）・手元の変更（fs.watch と設定の変更を 5 秒まとめる）・10 分ごと。
//     鍵の受け渡しだけは 5 分ごとにも見る
//   設定の競合: 平文の mtime の新しい方を採り（同じなら相手）、負けた方を <data>/plus/sync-conflicts/<YYYYMMDD-HHmmss>/<論理名> に写す。
//     写しは作ってから 30 日を過ぎたら start のときに消す
//   アカウントの停止（403 not_plus・account_disabled）: stop まで行い、状態は stopped（error に理由）。回し直すのは start（index.mjs）
//   登録の外れ（403 forbidden・message host）: 止めて状態は unregistered。onHostLost で上（登録の確かめ直し）へ知らせる。
//     知らせるのは、次にうまく回るまで 1 回だけ（同じ誤りで確かめ直しを繰り返さない）
//   鍵を待つ（waiting_key）: 状態の wait に、鍵を持つ PC・サーバーの件数と大きさを載せる（keys.mjs の waitInfo）
//   v2 の api（同期の券。keys.mjs）: 鍵を持つ PC は、新しい PC の申し込みを approvals に並べ、人が承認したら渡す（approve・deny）。
//     申し込んでいる間（受け取る側）は 15 分まで 10 秒ごと、その後は 1 分ごとに見る。渡す側は、明かされるのを待つ間 3 分まで 5 秒ごとに見る
//   426 update_required（この版では使えない api）: 止めて状態は update_required。回し直すのは start
//   券を取れない（404 not_found・403 host_removed）は 403 host と同じ（登録が外れた）
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
export const SYNC_JOIN_POLL_MS = 10_000;
export const SYNC_JOIN_SLOW_MS = MINUTE;
export const SYNC_JOIN_FAST_FOR_MS = 15 * MINUTE;
export const SYNC_CHALLENGE_POLL_MS = 5_000;
export const SYNC_CHALLENGE_FOR_MS = 3 * MINUTE;
export const CONFLICT_KEEP_MS = 30 * DAY;
const BACKOFF_MAX_MS = 10 * MINUTE;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10_000;
const OWN_WRITE_MS = 10_000;
const STAMP_RX = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const ACCOUNT_STOP_CODES = new Set(['not_plus', 'account_disabled']);
const SHARED_KEEP = 3;
const SHARED_SHOW_MS = 7 * DAY;
const INBOX_ID_RX = /^[0-9a-f]{32}$/;
const INBOX_KINDS = new Set(['change', 'new', 'delete']);

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const pad = n => String(n).padStart(2, '0');
const stampOf = ms => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const stampTime = name => { const m = STAMP_RX.exec(name); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
const emptyState = keyId => ({ keyId: keyId ?? null, cursor: 0, items: {} });
/** 受け入れ待ちの id（鍵に依らない。鍵が替わっても同じ項目は同じ場所） */
export const inboxIdOf = logical => sha256(Buffer.from(logical, 'utf8')).slice(0, 32);
const isSetting = logical => logical.startsWith('settings/');
const versionTag = sha => sha ?? 'deleted';

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
 * @param {() => unknown} [o.onHostLost]  api が 403 host を返した（この PC の登録が外れた）
 */
export function createSyncEngine({ client, keys, targets, dataDir, uid, hostId, log = () => {}, settingsEvents = null,
  clock = defaultClock, watch = defaultWatch, onStatus = () => {}, onHostLost = () => {} }) {
  const plusDir = path.join(dataDir, 'plus');
  const stateFile = path.join(plusDir, 'sync-state.json');
  const conflictsDir = path.join(plusDir, 'sync-conflicts');
  const inboxDir = path.join(plusDir, 'sync-inbox');

  let active = false;
  let key = null;               // { keyId, key, enc, id }
  let local = null;             // sync-state.json の中身
  let status = { state: 'off', lastSyncedAt: null, totalBytes: 0, limitBytes: 0, conflicts: 0, error: null, wait: null, sharedTo: [], inbox: 0, inboxAt: null, approvals: [] };
  let quota = false;
  let running = null, again = null;
  let turn = Promise.resolve();   // 回と、取り込む・捨てるを 1 本ずつにする
  let debounceTimer = null, receiveTimer = null, shareTimer = null, retryTimer = null, pollTimer = null;
  let joinSince = null;         // 鍵を受け取る申し込みを見始めた時刻（v2）
  let challengeSince = null;    // 渡す側として明かされるのを待ち始めた時刻（v2）
  let backoffMs = 0;
  const watchers = new Map();   // dir → watcher
  const ownWrites = new Map();  // 絶対パス → { sha, at }（自分で書いたものを fs.watch が拾っても上げ直さない）
  const ownSettings = new Map(); // 設定の key → at
  const background = new Set();  // 回の外で走る続き（watch の出来事の確かめ・覚えの保存・onHostLost）。idle() が待つ
  const track = p => { background.add(p); void p.finally(() => background.delete(p)).catch(() => {}); return p; };
  const settingsChangedAt = new Map();
  const tooLarge = new Map();   // 論理名 → sha（413 too_large のものは中身が変わるまで上げない）
  let unsubscribe = null;
  let hostLostCalled = false;   // 403 host を上へ知らせた（次にうまく回るまで知らせ直さない）

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
      if (Number.isFinite(raw?.rejoinedAt)) local.rejoinedAt = raw.rejoinedAt;
      if (Array.isArray(raw?.sharedTo)) {
        local.sharedTo = raw.sharedTo.filter(s => typeof s?.hostId === 'string' && Number.isFinite(s.at))
          .map(s => ({ hostId: s.hostId, name: typeof s.name === 'string' ? s.name : null, at: s.at })).slice(0, SHARED_KEEP);
      }
      if (raw?.dropped && typeof raw.dropped === 'object' && !Array.isArray(raw.dropped)) {
        local.dropped = Object.fromEntries(Object.entries(raw.dropped).filter(([k, v]) => typeof v === 'string' && targets.parse(k) && !isSetting(k)));
      }
    } catch { local = emptyState(null); }
    showShared();
    return local;
  }
  async function saveLocal() {
    if (!local) return;
    await fsp.mkdir(plusDir, { recursive: true });
    await writeAtomic(stateFile, `${JSON.stringify(local)}\n`);
  }

  /** 鍵を渡した PC のうち、7 日の間のものを状態に出す */
  function showShared() {
    const since = clock.now() - SHARED_SHOW_MS;
    const shown = (local?.sharedTo ?? []).filter(s => s.at > since)
      .map(s => ({ hostId: s.hostId, name: s.name, at: new Date(s.at).toISOString() }));
    setStatus({ sharedTo: shown });
  }

  /** keys.sharePending が鍵を新しい PC に渡した */
  function noteShared({ hostId: to, name = null } = {}) {
    if (!local || typeof to !== 'string') return;
    local.sharedTo = [{ hostId: to, name, at: clock.now() }, ...(local.sharedTo ?? []).filter(s => s.hostId !== to)].slice(0, SHARED_KEEP);
    showShared();
    void track(saveLocal().catch(() => {}));
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

  // ---- 受け入れ待ち ----------------------------------------------------------------------------------------

  /** 1 件の meta.json。無い・形が違う・id と論理名が合わない → null */
  async function readInboxMeta(id) {
    if (typeof id !== 'string' || !INBOX_ID_RX.test(id)) return null;
    try {
      const m = JSON.parse(await fsp.readFile(path.join(inboxDir, id, 'meta.json'), 'utf8'));
      if (typeof m?.path !== 'string' || inboxIdOf(m.path) !== id || !targets.parse(m.path) || isSetting(m.path)) return null;
      if (!INBOX_KINDS.has(m.kind) || !Number.isInteger(m.rev) || !Number.isFinite(Date.parse(m.at))) return null;
      return {
        path: m.path, kind: m.kind, rev: m.rev, at: m.at, mtime: m.mtime, from: typeof m.from === 'string' ? m.from : null,
        sha256: typeof m.sha256 === 'string' ? m.sha256 : null, baseSha: typeof m.baseSha === 'string' ? m.baseSha : null,
      };
    } catch { return null; }
  }

  /** 待っているもの（新しく届いた順） */
  async function listInbox() {
    const names = await fsp.readdir(inboxDir).catch(() => []);
    const out = [];
    for (const id of names) {
      const m = await readInboxMeta(id);
      if (m) out.push({ id, ...m });
    }
    return out.sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || (x.path < y.path ? -1 : 1));
  }

  async function countInbox() {
    const items = await listInbox();
    setStatus({ inbox: items.length, inboxAt: items[0]?.at ?? null });
  }

  const removeInbox = id => fsp.rm(path.join(inboxDir, id), { recursive: true, force: true }).catch(() => {});

  /** 届いた版を待ちに置く。meta.json は最後に書く（途中で止まったものは読まない） */
  async function hold(logical, it, plain, entry) {
    const id = inboxIdOf(logical);
    const dir = path.join(inboxDir, id);
    const incomingSha = plain.deleted ? null : sha256(plain.content);
    const baseSha = entry ? sha256(entry.content) : null;
    const prev = await readInboxMeta(id);
    // 同じ版が同じ手元に対して届き直した（鍵が替わったときなど）: 届いた時刻を変えない（通知を出し直さない）
    const at = prev && prev.sha256 === incomingSha && prev.baseSha === baseSha ? prev.at : new Date(clock.now()).toISOString();
    await fsp.rm(path.join(dir, 'meta.json'), { force: true }).catch(() => {});
    await fsp.mkdir(dir, { recursive: true });
    for (const [name, buf] of [['incoming', plain.deleted ? null : plain.content], ['base', entry?.content ?? null]]) {
      if (buf) await writeAtomic(path.join(dir, name), buf);
      else await fsp.rm(path.join(dir, name), { force: true });
    }
    const kind = plain.deleted ? 'delete' : (entry ? 'change' : 'new');
    await writeAtomic(path.join(dir, 'meta.json'), `${JSON.stringify({ path: logical, from: plain.from ?? null, at, mtime: plain.mtime, kind, rev: it.rev, sha256: incomingSha, baseSha })}\n`);
    log(`sync item held ${it.itemId}`);
  }

  /** 回と、取り込む・捨てるを 1 本ずつ通す */
  function exclusive(fn) {
    const p = turn.then(fn, fn);
    turn = p.catch(() => {});
    return p;
  }

  /** 待っている 1 件の中身。{ ...meta, incoming: Buffer|null, base: Buffer|null } か null */
  async function inboxItem(id) {
    const meta = await readInboxMeta(id);
    if (!meta) return null;
    const dir = path.join(inboxDir, id);
    const incoming = meta.kind === 'delete' ? null : await fsp.readFile(path.join(dir, 'incoming')).catch(() => null);
    const base = meta.baseSha ? await fsp.readFile(path.join(dir, 'base')).catch(() => null) : null;
    return { id, ...meta, incoming, base };
  }

  /**
   * 取り込む: 待っている版を手元に書く（消すものは消す）。待ちに置いた後に手元が変わっていたら書かない。
   * 戻り値 { taken: true } か { taken: false, reason: 'gone' | 'local_changed' | 'not_applied' }
   */
  function take(id) {
    return exclusive(async () => {
      await loadLocal();
      const item = await inboxItem(id);
      if (!item || (item.kind !== 'delete' && (!item.incoming || sha256(item.incoming) !== item.sha256))) {
        if (item) await removeInbox(id);
        await countInbox();
        return { taken: false, reason: 'gone' };
      }
      const cur = await targets.readOne(item.path);
      const curSha = cur ? sha256(cur.content) : null;
      if (curSha !== item.sha256) {
        if (curSha !== item.baseSha) return { taken: false, reason: 'local_changed' };
        const plain = { deleted: item.kind === 'delete', content: item.incoming, mtime: item.mtime };
        if (!(await applyRemote(item.path, plain))) return { taken: false, reason: 'not_applied' };
        if (active) ensureWatchers();   // 置き場のフォルダーを今作ったときは、ここから見張る
      }
      const rec = local.items[item.path];
      // 覚えの rev が待っている版のままなら、その版を持っていることにする。手元から先の版を上げていたら、取り込んだ中身を上げ直す
      if (rec && rec.rev === item.rev) local.items[item.path] = { ...rec, sha256: item.sha256, deleted: item.kind === 'delete', mtime: item.mtime };
      else changed();
      if (local.dropped) delete local.dropped[item.path];
      await removeInbox(id);
      await saveLocal();
      await countInbox();
      log('sync item taken');
      return { taken: true };
    });
  }

  /** 捨てる: 待ちから消し、同じ版が届き直しても出さないように覚える。手元のファイルも api も変えない */
  function drop(id) {
    return exclusive(async () => {
      await loadLocal();
      const meta = await readInboxMeta(id);
      if (meta) {
        local.dropped = { ...(local.dropped ?? {}), [meta.path]: versionTag(meta.sha256) };
        await saveLocal();
      }
      if (typeof id === 'string' && INBOX_ID_RX.test(id)) await removeInbox(id);
      await countInbox();
      return { dropped: Boolean(meta) };
    });
  }

  // ---- 誤り -----------------------------------------------------------------------------------------------

  /** 回の途中の誤りを状態とやり直しの予定にする */
  function handleRunError(e) {
    const code = e?.code ?? 'error';
    if (e?.status === 403 && e.message === 'sync_disabled') { setStatus({ state: 'disabled', error: null, wait: null }); return; }
    if (e?.status === 426) {
      // この版では使えない api（受け入れの v2 が要る）: 更新を促して止める
      log('sync stopped (update_required)');
      halt();
      setStatus({ state: 'update_required', error: 'update_required', wait: null, approvals: [] });
      return;
    }
    if ((e?.status === 403 && (e.message === 'host' || e.code === 'host_removed')) || (e?.ticket && e.status === 404)) {
      // この PC の登録が外れた: やり直しを重ねず止め、上へ知らせる（登録し直したら index.mjs が start から回す）
      log('sync stopped (host)');
      halt();
      setStatus({ state: 'unregistered', error: null, wait: null, approvals: [] });
      if (!hostLostCalled) {
        hostLostCalled = true;
        try { void track(Promise.resolve(onHostLost()).catch(() => {})); } catch {}
      }
      return;
    }
    if (ACCOUNT_STOP_CODES.has(code)) {
      // アカウントが Plus で使えない: 止める（タイマーも watch も外す）。Plus と分かり直したら index.mjs が start から回す
      log(`sync stopped (${code})`);
      stop({ reason: code });
      return;
    }
    if (code === 'unauthenticated' || e?.status === 401) {
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

  /**
   * 受けた項目の平文。開けない・形が違う → null。
   * 暗号文の無いもの（中身の無い消した印）は受けない: 消すことも、暗号文の中の deleted だけを信じる。
   * サーバーの deleted が暗号文の中と食い違うものも受けない
   */
  function openItem(it) {
    if (typeof it.ciphertext !== 'string' || !it.ciphertext) return null;
    const plain = decryptItem({
      encKey: key.enc, idKey: key.id, keyId: key.keyId, uid: uid(), itemId: it.itemId, rev: it.rev, ciphertext: it.ciphertext,
      validPath: p => { const parsed = targets.parse(p); return Boolean(parsed) && (parsed.kind !== 'setting' || targets.hasSetting(parsed.key)); },
    });
    if (!plain || (it.deleted !== undefined && it.deleted !== plain.deleted)) return null;
    return plain;
  }

  function localMtime(logical, entry) {
    if (!entry) return clock.now();   // 手元で消した: 気づいた今
    if (entry.kind === 'setting') return settingsChangedAt.get(logical) ?? (local.items[logical] ? Date.parse(local.items[logical].mtime) || 0 : (local.rejoinedAt ?? 0));
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
        if (!it || !ITEM_ID_RX.test(String(it.itemId)) || !Number.isSafeInteger(it.rev) || it.rev < 1) continue;
        if (it.keyId !== key.keyId) { rekey = true; continue; }
        const plain = openItem(it);
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

    if (!isSetting(logical)) {
      // skill・指示ファイル: 書かずに待ちに置く（手元がもう同じ中身なら覚えるだけ）
      if (localSha === remoteSha) {
        record();
        await removeInbox(inboxIdOf(logical));
        return;
      }
      local.items[logical] = rec
        ? { ...rec, itemId: it.itemId, rev: it.rev }
        : { itemId: it.itemId, rev: it.rev, sha256: localSha, deleted: localSha === null, mtime: entry ? new Date(entry.mtimeMs ?? clock.now()).toISOString() : plain.mtime };
      if (local.dropped?.[logical] === versionTag(remoteSha)) { await removeInbox(inboxIdOf(logical)); return; }
      if (local.dropped) delete local.dropped[logical];
      await hold(logical, it, plain, entry);
      return;
    }

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
    const mtime = deleted ? clock.now() : (entry.kind === 'setting' ? (settingsChangedAt.get(logical) ?? (rec ? clock.now() : (local.rejoinedAt ?? 0))) : entry.mtimeMs);
    const plaintext = itemPlaintext({ path: logical, mtime, deleted, content: entry?.content ?? null, from: hostId() });
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

  /** 1 回回す。人の確かめが要る（409 reset_confirm）ときは 'confirm_needed' を返す */
  async function runOnce({ full = true, forceNew = false, confirm = null } = {}) {
    await loadLocal();
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await keys.setup({ forceNew, confirm });
      forceNew = false;
      confirm = null;
      if (r.state) setStatus({ totalBytes: Number(r.state.totalBytes) || 0, limitBytes: Number(r.state.limitBytes) || 0 });
      if (r.status === 'disabled') { key = null; setStatus({ state: 'disabled', error: null, wait: null, approvals: [] }); return; }
      // 待つ・確かめが要る: 自分宛ての鍵を api に聞けた（台帳に載っている）ので、403 host の知らせをまた出せるようにする
      if (r.status === 'waiting_key') {
        key = null; hostLostCalled = false; challengeSince = null;
        setStatus({ state: 'waiting_key', error: null, wait: r.wait ?? null, approvals: [] });
        pollJoin(r.wait?.join);
        return;
      }
      if (r.status === 'confirm_needed') { key = null; hostLostCalled = false; setStatus({ state: 'waiting_key', error: null, wait: r.wait ?? null, approvals: [] }); return 'confirm_needed'; }
      key = r.key;
      joinSince = null;
      if (status.wait) setStatus({ wait: null });
      if (r.changed || local.keyId !== key.keyId) {
        const prev = local.keyId;
        local = { ...emptyState(key.keyId), sharedTo: local.sharedTo ?? [], dropped: local.dropped ?? {} };
        if (prev && prev !== key.keyId) local.rejoinedAt = clock.now();
        settingsChangedAt.clear();
        tooLarge.clear();
        await saveLocal();
      }
      if (quota && r.state && (Number(r.state.totalBytes) || 0) < (Number(r.state.limitBytes) || 0)) quota = false;
      if (r.v2) {
        // 新しい PC の申し込み: 確認コードを付けて並べる。渡すのは人が承認したときだけ
        const a = await keys.approvals(r.state, key);
        setStatus({ approvals: a.list });
        pollChallenge(a.waiting);
      } else if ((await keys.sharePending(r.state, key)) === 'rekey') continue;
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
        await countInbox();
      }
      backoffMs = 0;
      hostLostCalled = false;   // 手元の鍵だけでは台帳に載っているか分からないので、うまく回りきってから戻す
      setStatus({ state: quota ? 'quota' : 'idle', error: null, lastSyncedAt: new Date(clock.now()).toISOString() });
      return;
    }
  }

  /** 同時に 1 本だけ。回っている間に呼ばれたら、終わったあとにもう 1 回（まとめて）回す */
  function run(opts = {}) {
    if (!active) return Promise.resolve();
    if (running) {
      again = {
        full: Boolean(again?.full || opts.full !== false), forceNew: Boolean(again?.forceNew || opts.forceNew),
        confirm: opts.confirm ?? again?.confirm ?? null,
      };
      return running;
    }
    running = (async () => {
      let next = opts;
      let last = null;
      try {
        while (active && next) {
          again = null;
          const opts = next;
          try { last = await exclusive(() => runOnce(opts)) ?? null; }
          catch (e) { last = null; handleRunError(e); }
          next = again;
        }
      } finally { running = null; }
      return last;
    })();
    return running;
  }

  // ---- いつ回すか -----------------------------------------------------------------------------------------

  function clearTimers() {
    for (const id of [debounceTimer, receiveTimer, shareTimer, retryTimer, pollTimer]) if (id) clock.clearTimeout(id);
    debounceTimer = receiveTimer = shareTimer = retryTimer = pollTimer = null;
  }
  /** 申し込み・承認の途中を短い間隔で見る（鍵の受け渡しだけ。項目は受けない） */
  function schedulePoll(ms) {
    if (!active) return;
    if (pollTimer) clock.clearTimeout(pollTimer);
    pollTimer = clock.setTimeout(() => { pollTimer = null; void run({ full: false }); }, ms);
    pollTimer?.unref?.();
  }
  /** 受け取る側: 申し込んでいる間は 15 分まで 10 秒ごと、その後は 1 分ごと。断られた（denied）・申し込みが無いなら止める */
  function pollJoin(join) {
    if (!join || join.state === 'denied') { joinSince = null; return; }
    joinSince ??= clock.now();
    schedulePoll(clock.now() - joinSince < SYNC_JOIN_FAST_FOR_MS ? SYNC_JOIN_POLL_MS : SYNC_JOIN_SLOW_MS);
  }
  /** 渡す側: nonceH を置いて、明かされるのを待つ間は 3 分まで 5 秒ごと */
  function pollChallenge(waiting) {
    if (!waiting) { challengeSince = null; return; }
    challengeSince ??= clock.now();
    if (clock.now() - challengeSince < SYNC_CHALLENGE_FOR_MS) schedulePoll(SYNC_CHALLENGE_POLL_MS);
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
      void track(fsp.readFile(abs).then(buf => sha256(buf), () => null).then(sha => {
        if (sha === own.sha) return;
        ownWrites.delete(abs);
        changed();
      }));
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
    await countInbox();
    ensureWatchers();
    unsubscribe = settingsEvents?.subscribe?.(onSettingsChanged) ?? null;
    scheduleReceive();
    scheduleShare();
    const done = run();
    void done.then(() => ensureWatchers());
    return done;
  }

  /** 回すのをやめる（タイマー・watch・設定の配信を外す） */
  function halt() {
    active = false;
    clearTimers();
    closeWatchers();
    try { unsubscribe?.(); } catch {}
    unsubscribe = null;
    key = null;
  }

  /** 止める。reason（not_plus・account_disabled）があれば stopped（アカウントの停止。誤りではない）、無ければ off */
  function stop({ reason = null } = {}) {
    halt();
    quota = false;
    joinSince = challengeSince = null;
    setStatus({ state: reason ? 'stopped' : 'off', error: reason, wait: null, approvals: [] });
  }

  /**
   * 鍵の受け渡しと回復の操作（v2）。回と重ねずに通し、終わったら鍵の受け渡しだけを見直す。
   * fn は keys の関数（approve・deny・recoveryRequest・recoveryCancel・recoveryComplete）
   */
  async function keyAction(fn) {
    const out = await exclusive(fn);
    if (active) await run({ full: Boolean(out?.done) });
    return { ...out, status: { ...status } };
  }

  /**
   * 同期をやり直す: 新しい鍵で作り直し、手元の全部を上げ直す。
   * confirm: 人が件数を見て確かめた印 { keyId, itemCount }（鍵を持たない PC がサーバーのデータを消すときに要る）。
   * 戻り値 { confirmNeeded, status }。confirmNeeded: 確かめが無い・数字が変わった（status.wait に今の値）
   */
  async function reset(confirm = null) {
    if (!active) return { confirmNeeded: false, status: { ...status } };
    while (running) await running;
    const last = await run({ forceNew: true, confirm });
    return { confirmNeeded: last === 'confirm_needed', status: { ...status } };
  }

  /** ログアウト・アカウントの切り替え: 止めて、手元の覚えを捨てる（次のアカウントで最初から） */
  async function forget() {
    stop();
    local = emptyState(null);
    await saveLocal().catch(() => {});
    await fsp.rm(inboxDir, { recursive: true, force: true }).catch(() => {});
    setStatus({ inbox: 0, inboxAt: null });
  }

  return {
    start, stop, run, reset, forget, changed, noteShared,
    /** 新しい PC に鍵を渡す（人が確認コードを見比べて承認した） */
    approve: (target, code) => keyAction(() => keys.approve(target, code)),
    /** 渡さない */
    deny: target => keyAction(() => keys.deny(target)),
    /** 回復（鍵を持つ PC が 1 台も無いとき）: 頼む・取り下げる・待ちが明けたら仕上げる */
    recovery: {
      request: () => keyAction(() => keys.recoveryRequest()),
      cancel: () => keyAction(() => keys.recoveryCancel()),
      complete: () => keyAction(() => keys.recoveryComplete()),
    },
    /** 状態に足す（回の外で分かったこと。外された PC の回復の見張りなど） */
    note: patch => setStatus(patch),
    status: () => ({ ...status }),
    /** 受け入れ待ち: list（新しく届いた順の meta）・item（中身つきの 1 件）・take（取り込む）・drop（捨てる） */
    inbox: { list: listInbox, item: inboxItem, take, drop },
    conflictsDir,
    inboxDir,
    stateFile,
    /** 試験用: 今張っている watch の場所 */
    watching: () => [...watchers.keys()],
    /** 試験用: 回っている回（タイマーから始まった回を含む）と、回の外の続きが終わるまで待つ */
    async idle() {
      while (running || background.size) {
        await running?.catch(() => {});
        await Promise.allSettled([...background]);
      }
    },
  };
}
