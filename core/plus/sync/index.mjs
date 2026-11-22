// Pleiad Plus の同期（docs/plus.md「同期」）。鍵（keys.mjs）・運ぶもの（targets.mjs）・回すもの（engine.mjs）を束ね、状態を出す。
//
//   回す条件: Plus にログインしていて（account.status が plus）、この PC が台帳に載っている（hosts.mjs の state が registered）
//   条件から外れた（Plus でなくなった・登録が外れた）: 回していても止める。そろい直したら start から回し直す（タイマーも張り直す）
//   api が 403 not_plus・account_disabled を返した（engine が stopped で止まる）: セッションがまだ plus と読んでいても、
//     止まったあとに GET /v1/account を読めて plus と分かる（accountReadAt が進む）か、条件がいったん外れるまで回さない
//   サインアウト（人のログアウト・401 の繰り返し・更新の拒否）: 止めるだけ。同期鍵（K）・申し込みの覚え・手元の覚えは残す（ADR 0346 の D7）
//   別のアカウントで同期を始める（保存した K の uid が今の uid と違う）: そのときだけ K と申し込みの覚え・手元の覚えを捨てる。ホストの鍵対は残す
//   api が 403 host を返した（engine が unregistered で止まる）: onHostLost（登録の確かめ直し）を待ってから update で回し直す
//   getSyncStatus(): { state: off|disabled|waiting_key|syncing|idle|quota|stopped|unregistered|update_required|error, lastSyncedAt,
//     totalBytes, limitBytes, conflicts, error, wait, sharedTo, inbox, inboxAt }
//     wait: 鍵を待つ間の見え方 { kind: approval|preparing|restarted, ... }（keys.mjs の冒頭）。sharedTo: 7 日の間に鍵を渡した新しい PC
//     inbox・inboxAt: 受け入れ待ちの件数と、いちばん新しく届いた時刻（ADR 0250）
//     approvals: 鍵を渡す承認を待っている新しい PC [{ hostId, name, platform, code, at }]（v2 の api）
//     recoveryAlert: この PC は外された（または活動していなかった）が今の鍵を持っていて、ほかの PC が始め直しを頼んでいる
//       { requestedByName, readyAt }
//   同期の券（ticket.mjs）: identity（ホストの鍵）を渡したときだけ使う。券の口が 404 の api では前の版の流れ
//   外された PC: 今の鍵を手元に持っていれば、回復が頼まれていないかを 10 分ごとに見る（券は要らない）。止めるのは K の署名
//   受け入れ待ち（inboxList・inboxItem・inboxTake・inboxDrop）: 画面に出す形にする。パスは ~/ からの見た目、送った PC は台帳の名前
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSyncKeys } from './keys.mjs';
import { createSyncTargets } from './targets.mjs';
import { createSyncEngine } from './engine.mjs';
import { createSyncTicket } from './ticket.mjs';

const RECOVERY_WATCH_MS = 10 * 60_000;
const defaultTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

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
 * @param {(() => Promise<object|null>|object|null)|null} [o.identity]  ホストの鍵（remote の store.peekIdentity）。同期の券に使う
 * @param {object|null} [o.issuer]  券の手（core/plus/tickets.mjs の createTicketIssuer。中継の券と同じもの）
 * @param {object} [o.clock] @param {Function} [o.watch]  試験の差し替え用
 */
export function createPlusSync({ session, host, secrets, dataDir, settings = null, settingsEvents = null, openFolder = async () => {},
  home = os.homedir(), env = process.env, log = () => {}, onHostLost = async () => {}, identity = null, issuer = null, clock, watch }) {
  const listeners = new Set();
  const uid = () => session.snapshot?.()?.account?.uid ?? null;
  const hostId = () => host()?.hostId ?? null;
  let engine = null;
  const ticket = identity ? createSyncTicket({ client: session.client, issuer, identity: async () => (await identity()) ?? null }) : null;
  /** 同期の口（券を付ける）。前の版の api では券を付けずに呼ぶ */
  const syncClient = ticket ? { request: (m, p, o) => ticket.request(m, p, o) } : session.client;
  const keys = createSyncKeys({ client: session.client, ticket, secrets, uid, hostId, log, onShared: to => engine?.noteShared(to) });
  const targets = createSyncTargets({ dataDir, home, env, settings, log });
  let runningUid = null;   // 回している uid
  let held = null;         // engine が api の 403 で止まった: { readAt }（止まったときの accountReadAt）
  let accountCleanup = null;
  engine = createSyncEngine({
    client: syncClient, keys, targets, dataDir, uid, hostId, log, settingsEvents,
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
    if (runningUid && now !== runningUid) { runningUid = null; held = null; engine.stop(); }
    // 別のアカウントで入った: 前のアカウントの同期鍵と覚えを捨てる（サインアウトだけでは捨てない）
    if (accountCleanup) await accountCleanup;
    const owner = now ? await keys.ownerUid() : null;
    if (now !== (session.snapshot?.()?.signedIn ? uid() : null)) return;
    if (owner && owner !== now) {
      accountCleanup ??= (async () => {
        runningUid = null; held = null;
        unwatchRecovery();
        ticket?.forget();
        await engine.forget();
        await keys.forget();
      })().finally(() => { accountCleanup = null; });
      await accountCleanup;
      if (now !== (session.snapshot?.()?.signedIn ? uid() : null)) return;
    }
    if (!eligible()) {
      runningUid = null; held = null; engine.stop({ reason: stopReason(s) });
      if (s.signedIn === true && host()?.state === 'removed') watchRecovery(); else unwatchRecovery();
      return;
    }
    unwatchRecovery();
    if (runningUid) return;
    // api の 403 で止まったあとは、plus と新しく読めるまで待つ（読むたびに 1 回だけ試す）
    if (held && (s.accountReadAt ?? 0) <= held.readAt) return;
    held = null;
    runningUid = now;
    await engine.start();
  }

  // ---- 外された PC の回復の見張り ----------------------------------------------------------------------------
  const timers = clock ?? defaultTimers;
  let recoveryTimer = null;
  let recoveryWatchId = 0;
  function unwatchRecovery() {
    const watched = recoveryTimer != null;
    if (recoveryTimer) timers.clearTimeout(recoveryTimer);
    recoveryTimer = null;
    recoveryWatchId++;
    if ((watched || !eligible()) && engine.status().recoveryAlert) engine.note({ recoveryAlert: null });
  }
  async function checkRecovery() {
    const watchId = recoveryWatchId;
    let alert = null;
    try { alert = (await keys.recoveryWatch())?.recovery ?? null; } catch {}
    if (watchId === recoveryWatchId) engine.note({ recoveryAlert: alert });
  }
  function watchRecovery() {
    if (recoveryTimer || !ticket) return;
    const watchId = ++recoveryWatchId;
    const tick = () => {
      if (watchId !== recoveryWatchId) return;
      recoveryTimer = timers.setTimeout(() => { void checkRecovery().finally(tick); }, RECOVERY_WATCH_MS);
      recoveryTimer?.unref?.();
    };
    tick();
    void checkRecovery();
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
    /**
     * 1 件: 一覧の欄と before・after（文字。無いものは null）、版（sha256・rev。取り込む・捨てるに渡し返す）。
     * 文字として見せられないものは binary: true で中身を出さず、大きさ（size・baseSize）だけ出す
     */
    async inboxItem(id) {
      const m = await engine.inbox.item(id);
      if (!m) return { item: null };
      const before = asText(m.base), after = asText(m.incoming);
      const binary = before === undefined || after === undefined;
      return { item: {
        ...shown(m, await hostNames()), sha256: m.sha256, rev: m.rev, binary,
        before: binary ? null : before, after: binary ? null : after,
        size: m.incoming ? m.incoming.length : null, baseSize: m.base ? m.base.length : null,
      } };
    },
    /** 取り込む。seen: 画面が受けた { sha256, rev }。{ taken } か { taken: false, reason: changed|local_changed|not_applied|gone } */
    inboxTake: (id, seen) => engine.inbox.take(id, seen),
    /** 捨てる（同じ版はもう出さない）。seen は inboxTake と同じ */
    inboxDrop: (id, seen) => engine.inbox.drop(id, seen),
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
    /** 同期をリセットする（容量の上限のときだけ。今の内容で作り直し、ほかの PC は自動でついてくる）。戻り値 { reset, status } */
    resetSync: () => engine.reset(),
    /** 新しい PC に鍵を渡す（code: 画面に出した確認コード。読み直して同じときだけ渡す）。{ shared } か { shared: false, reason } */
    approveSync: (target, code) => engine.approve(target, code),
    /** 渡さない（その PC は 1 時間申し込み直せない） */
    denySync: target => engine.deny(target),
    /** ほかの PC で始め直された同期に加わる（人が「{name} と同期する」を押した）。{ accepted } か { changed }（その間にまた替わった） */
    acceptRestart: keyId => engine.acceptRestart(keyId),
    /** ほかの PC の頼んだ始め直しを、今の鍵の署名で止める（外された・活動していない PC から） */
    async stopRecovery() {
      const out = await keys.recoveryStop();
      if (runningUid) await engine.run({ full: false });
      else if (recoveryTimer) await checkRecovery();
      return { ...out, status: engine.status() };
    },
    async openConflictsFolder() {
      await fsp.mkdir(engine.conflictsDir, { recursive: true });
      return openFolder(engine.conflictsDir);
    },
    stop: () => { runningUid = null; held = null; unwatchRecovery(); engine.stop(); },
    engine, keys, targets,
  };
}
