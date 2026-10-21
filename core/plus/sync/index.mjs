// Pleiad Plus の同期（docs/plus.md「同期」）。鍵（keys.mjs）・運ぶもの（targets.mjs）・回すもの（engine.mjs）を束ね、状態を出す。
//
//   回す条件: Plus にログインしていて（account.status が plus）、この PC が台帳に載っている（hosts.mjs の state が registered）
//   条件から外れた（Plus でなくなった・登録が外れた）: 回していても止める。そろい直したら start から回し直す（タイマーも張り直す）
//   api が 403 not_plus・account_disabled を返した（engine が stopped で止まる）: セッションがまだ plus と読んでいても、
//     止まったあとに GET /v1/account を読めて plus と分かる（accountReadAt が進む）か、条件がいったん外れるまで回さない
//   ログアウト・アカウントの切り替え: 止めて、アカウントの同期鍵（plus:syncAccountKey）と手元の覚えを捨てる。ホストの鍵対は残す
//   api が 403 host を返した（engine が unregistered で止まる）: onHostLost（登録の確かめ直し）を待ってから update で回し直す
//   getSyncStatus(): { state: off|disabled|waiting_key|syncing|idle|quota|stopped|unregistered|error, lastSyncedAt, totalBytes,
//     limitBytes, conflicts, error, wait, sharedTo, inbox, inboxAt }
//     wait: 鍵を待つ間に見せるもの（keys.mjs の waitInfo）。sharedTo: 7 日の間に鍵を渡した新しい PC
//     inbox・inboxAt: 受け入れ待ちの件数と、いちばん新しく届いた時刻（ADR 0245）
//   受け入れ待ち（inboxList・inboxItem・inboxTake・inboxDrop）: 画面に出す形にする。パスは ~/ からの見た目、送った PC は台帳の名前
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSyncKeys } from './keys.mjs';
import { createSyncTargets } from './targets.mjs';
import { createSyncEngine } from './engine.mjs';

/**
 * @param {object} o
 * @param {object} o.session     createPlusSession の結果（client・snapshot）
 * @param {() => { state: string, hostId: string|null }} o.host  この PC の登録の状態（createPlusHost の host()）
 * @param {object} o.secrets     <data>/plus-secrets.json の secret-store
 * @param {string} o.dataDir
 * @param {object|null} [o.settings]        createSyncSettings の結果
 * @param {object|null} [o.settingsEvents]  { subscribe(fn) }（設定の変更の配信）
 * @param {(dir: string) => Promise<unknown>} [o.openFolder]  フォルダーを OS で開く
 * @param {string} [o.home] @param {object} [o.env]
 * @param {(line: string) => void} [o.log]
 * @param {() => unknown} [o.onHostLost]  api が 403 host を返した（createPlusHost の recheck を渡す）
 * @param {object} [o.clock] @param {Function} [o.watch]  試験の差し替え用
 */
export function createPlusSync({ session, host, secrets, dataDir, settings = null, settingsEvents = null, openFolder = async () => {},
  home = os.homedir(), env = process.env, log = () => {}, onHostLost = async () => {}, clock, watch }) {
  const listeners = new Set();
  const uid = () => session.snapshot?.()?.account?.uid ?? null;
  const hostId = () => host()?.hostId ?? null;
  let engine = null;
  const keys = createSyncKeys({ client: session.client, secrets, uid, hostId, log, onShared: to => engine?.noteShared(to) });
  const targets = createSyncTargets({ dataDir, home, env, settings, log });
  let runningUid = null;   // 回している uid
  let keptUid = null;      // 同期鍵と手元の覚えを持っている uid（ログアウト・切り替えで捨てる）
  let held = null;         // engine が api の 403 で止まった: { readAt }（止まったときの accountReadAt）
  engine = createSyncEngine({
    client: session.client, keys, targets, dataDir, uid, hostId, log, settingsEvents,
    ...(clock ? { clock } : {}), ...(watch ? { watch } : {}),
    onHostLost: async () => {
      try { await onHostLost(); } catch {}
      await update();
    },
    onStatus: status => {
      if (status.state === 'stopped' && runningUid) {
        held = { readAt: session.snapshot?.()?.accountReadAt ?? 0 };
        runningUid = null;
      }
      if (status.state === 'unregistered' && runningUid) runningUid = null;
      for (const fn of listeners) { try { fn(status); } catch {} }
    },
  });

  const eligible = () => {
    const s = session.snapshot?.() ?? {};
    return s.signedIn === true && s.account?.status === 'plus' && host()?.state === 'registered' && Boolean(hostId()) && Boolean(uid());
  };

  /** 条件から外れたときの止め方: ログイン中で Plus でないなら stopped（理由つき）、ほかは off */
  const stopReason = s => {
    if (s.signedIn !== true || !s.account?.status || s.account.status === 'plus') return null;
    return s.account.status === 'disabled' ? 'account_disabled' : 'not_plus';
  };

  /** セッション・登録の状態が変わったときに呼ぶ。条件を満たせば回し始め、外れたら止める */
  async function update() {
    const s = session.snapshot?.() ?? {};
    const now = s.signedIn ? uid() : null;
    if (keptUid && now !== keptUid) {
      // ログアウト・アカウントの切り替え: 前のアカウントの同期鍵と覚えを捨てる
      runningUid = null; keptUid = null; held = null;
      await engine.forget();
      await keys.forget();
    }
    if (!eligible()) { runningUid = null; held = null; engine.stop({ reason: stopReason(s) }); return; }
    if (runningUid) return;
    // api の 403 で止まったあとは、plus と新しく読めるまで待つ（読むたびに 1 回だけ試す）
    if (held && (s.accountReadAt ?? 0) <= held.readAt) return;
    held = null;
    runningUid = keptUid = now;
    await engine.start();
  }

  /** 手元のファイルの見た目のパス（ホームの下なら ~/ から、区切りは /） */
  const shownPath = logical => {
    const file = targets.localFile(logical);
    if (!file) return logical;
    const rel = path.relative(home, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : file.split(path.sep).join('/');
  };

  /** hostId → 台帳の名前（読めなければ空） */
  async function hostNames() {
    try {
      const list = await session.client.request('GET', '/v1/hosts');
      return new Map((Array.isArray(list?.hosts) ? list.hosts : []).map(h => [h?.hostId, typeof h?.name === 'string' ? h.name : null]));
    } catch { return new Map(); }
  }

  const shown = (m, names) => ({ id: m.id, path: shownPath(m.path), kind: m.kind, at: m.at, fromName: (m.from && names.get(m.from)) || null });

  /** 中身を文字として見せられるか（UTF-8 として読めて、NUL を含まない） */
  const asText = buf => {
    if (!buf) return null;
    try {
      const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return s.includes('\u0000') ? undefined : s;
    } catch { return undefined; }
  };

  return {
    update,
    /** 受け入れ待ち（新しく届いた順）: [{ id, path, kind: change|new|delete, at, fromName }] */
    async inboxList() {
      const items = await engine.inbox.list();
      const names = items.length ? await hostNames() : new Map();
      return { items: items.map(m => shown(m, names)) };
    },
    /** 1 件: 一覧の欄と before・after（文字。無いものは null）。文字として見せられないものは binary: true で中身を出さない */
    async inboxItem(id) {
      const m = await engine.inbox.item(id);
      if (!m) return { item: null };
      const before = asText(m.base), after = asText(m.incoming);
      const binary = before === undefined || after === undefined;
      return { item: { ...shown(m, await hostNames()), binary, before: binary ? null : before, after: binary ? null : after } };
    },
    /** 取り込む。{ taken } か { taken: false, reason: local_changed|not_applied|gone } */
    inboxTake: id => engine.inbox.take(id),
    /** 捨てる（同じ版はもう出さない） */
    inboxDrop: id => engine.inbox.drop(id),
    /** createPlusHost の syncPublicKey に渡す（台帳に載せる同期の公開鍵） */
    publicKey: () => keys.publicKey(),
    getSyncStatus: () => engine.status(),
    /** 状態が変わるたびに呼ぶ。戻り値で外す */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** 同期を入れる・切る（アカウントの設定。ほかの PC にも効く） */
    async setSyncEnabled(enabled) {
      const out = await session.client.request('PATCH', '/v1/account', { body: { sync: { enabled: Boolean(enabled) } } });
      if (runningUid) await engine.run();
      return out;
    },
    /**
     * 同期をやり直す: 新しい鍵で作り直し、手元の全部を上げ直す。
     * confirm: { keyId, itemCount }（鍵を持たない PC がサーバーのデータを消すとき、人が件数を見て確かめた印）。
     * 戻り値 { confirmNeeded, status }
     */
    resetSync: (confirm = null) => engine.reset(confirm),
    async openConflictsFolder() {
      await fsp.mkdir(engine.conflictsDir, { recursive: true });
      return openFolder(engine.conflictsDir);
    },
    stop: () => { runningUid = null; held = null; engine.stop(); },
    engine, keys, targets,
  };
}
