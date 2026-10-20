// Pleiad Plus の同期（docs/plus.md「同期」）。鍵（keys.mjs）・運ぶもの（targets.mjs）・回すもの（engine.mjs）を束ね、状態を出す。
//
//   回す条件: Plus にログインしていて（account.status が plus）、この PC が台帳に載っている（hosts.mjs の state が registered）
//   ログアウト・アカウントの切り替え: 止めて、アカウントの同期鍵（plus:syncAccountKey）と手元の覚えを捨てる。ホストの鍵対は残す
//   getSyncStatus(): { state: off|disabled|waiting_key|syncing|idle|quota|error, lastSyncedAt, totalBytes, limitBytes, conflicts, error }
import fsp from 'node:fs/promises';
import os from 'node:os';
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
 * @param {object} [o.clock] @param {Function} [o.watch]  試験の差し替え用
 */
export function createPlusSync({ session, host, secrets, dataDir, settings = null, settingsEvents = null, openFolder = async () => {},
  home = os.homedir(), env = process.env, log = () => {}, clock, watch }) {
  const listeners = new Set();
  const uid = () => session.snapshot?.()?.account?.uid ?? null;
  const hostId = () => host()?.hostId ?? null;
  const keys = createSyncKeys({ client: session.client, secrets, uid, hostId, log });
  const targets = createSyncTargets({ dataDir, home, env, settings, log });
  const engine = createSyncEngine({
    client: session.client, keys, targets, dataDir, uid, hostId, log, settingsEvents,
    ...(clock ? { clock } : {}), ...(watch ? { watch } : {}),
    onStatus: status => { for (const fn of listeners) { try { fn(status); } catch {} } },
  });
  let runningUid = null;

  const eligible = () => {
    const s = session.snapshot?.() ?? {};
    return s.signedIn === true && s.account?.status === 'plus' && host()?.state === 'registered' && Boolean(hostId()) && Boolean(uid());
  };

  /** セッション・登録の状態が変わったときに呼ぶ。条件を満たせば回し始め、外れたら止める */
  async function update() {
    const s = session.snapshot?.() ?? {};
    const now = s.signedIn ? uid() : null;
    if (runningUid && now !== runningUid) {
      // ログアウト・アカウントの切り替え: 前のアカウントの同期鍵と覚えを捨てる
      runningUid = null;
      await engine.forget();
      await keys.forget();
    }
    if (!eligible()) { if (!runningUid) engine.stop(); return; }
    if (runningUid) return;
    runningUid = now;
    await engine.start();
  }

  return {
    update,
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
    /** 同期をやり直す: 新しい鍵で作り直し、手元の全部を上げ直す */
    resetSync: () => engine.reset(),
    async openConflictsFolder() {
      await fsp.mkdir(engine.conflictsDir, { recursive: true });
      return openFolder(engine.conflictsDir);
    },
    stop: () => { runningUid = null; engine.stop(); },
    engine, keys, targets,
  };
}
