// ホストの鍵・リモートの設定・端末一覧の置き場（docs/remote.md §3.1・§3.3・§6.1）。
//
//   <data>/remote/secrets.json   ホストの静的鍵（秘密鍵）と中継の登録用の秘密。core/secret-store.mjs
//                                （デスクトップは safeStorage、npm start は 0600 の平文）
//   <data>/remote/settings.json  { enabled, relayUrl, hostName }（秘密は入れない）
//   <data>/remote/devices.json   { version: 1, devices: [{ id, name, platform, app, publicKey, tokenHash, createdAt, lastSeenAt, via?, plusUid?, approvedBy?, approvedAt?, notify? }] }
//                                via = 'own' | 'plus'（どのつながりで受け入れた端末か。無いものは 'own' とみなす。docs/remote.md §6.4）
//                                plusUid = via:'plus' の端末を受け入れたときのアカウントの uid（'own' では書かない。状態には出さない）
//                                notify = { settings, muted, registeredAt, lastSentAt }（離れた端末への通知。鍵は秘密の置き場の notify:<id>）
//                                agentDelegation は前の版の「この端末の AI からの依頼を受ける」。今は読まない（デスクトップ版の端末なら受ける。ADR 0239）
//                                invite = <招待の id>（審査の招待で入った端末の印。招待を取り消す・作り直す・期限が来ると、この印の端末をすべて外す。ADR 0172）
//                                approvedBy = この端末の鍵を許可した機器（PC の画面なら 'host'。端末の id なら、その端末を取り消すと一緒に外れる）。
//                                  via:'plus' で approvedBy の無い端末は、前の版で確認コードなしに入ったもの。もう一度の許可が済むまで通さない（ADR 0248）
//                                公開鍵は base64url、tokenHash は中継用トークン（生の 32 バイト）の SHA-256 の 16 進。トークンそのものは持たない
//   <data>/remote/revoked.json   { version: 1, keys: [{ id, publicKey, revokedAt, by, name, platform?, via?, approvedBy?, createdAt?, hidden? }] }
//                                取り消した端末の鍵。台帳や中継の資格に関係なく、この鍵はもう通さない。行は消さない
//                                （「一覧から消す」は hidden を立てて表示から外すだけ）。by = 取り消した機器（'host' か端末の id）
//   <data>/remote/plus-requests.json  { version: 1, accounts: { <uid>: { denials: [ISO 時刻], pausedUntil: ISO 時刻 | null } } }
//                                公式の中継から来た申し込みを PC の画面で断った時刻（直近 1 時間ぶん）と、続けて断ったので
//                                申し込みを止めている期限。アカウントの uid ごと。起動し直しても数え直さない
//
// ファイルは一時ファイル + rename で 0600、フォルダーは 0700 で作る（Windows では効かないが、利用者のフォルダーの中に置く）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSecretStore, plainCipher, withFileLock } from '../secret-store.mjs';
import { generateKeyPair, keyPairFromPrivate, hostIdFor } from './noise.mjs';
import { t } from '../i18n.mjs';

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(t('remote.store.unreadable', { file: path.basename(file) }));
  }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(tmp, 0o600).catch(() => {});
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(tmp, file); break; }
      catch (e) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        await new Promise(done => setTimeout(done, 20 * (attempt + 1)));
      }
    }
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

export const DEFAULT_SETTINGS = Object.freeze({ enabled: false, relayUrl: '', hostName: '', plus: { connect: true, userSet: false } });

/**
 * リモートの置き場。dataDir は store.dataDir（AGENT_HOST_DATA を尊重する）。
 * cipher は server の暗号器（デスクトップは safeStorage に頼む）を渡す。
 */
export function createRemoteStore({ dataDir, cipher = plainCipher }) {
  const dir = path.join(dataDir, 'remote');
  const settingsFile = path.join(dir, 'settings.json');
  const devicesFile = path.join(dir, 'devices.json');
  const revokedFile = path.join(dir, 'revoked.json');
  const plusRequestsFile = path.join(dir, 'plus-requests.json');
  const secrets = createSecretStore({ file: path.join(dir, 'secrets.json'), cipher });
  let identity = null;
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };
  const lockedDevices = fn => serial(() => withFileLock(`${devicesFile}.lock`, fn));

  function keyFrom(priv) {
    const kp = keyPairFromPrivate(Buffer.from(priv, 'base64url'));
    return { ...kp, hostId: hostIdFor(kp.publicKey) };
  }

  async function readDevices() {
    const raw = await readJson(devicesFile, { version: 1, devices: [] });
    if (raw?.version !== 1 || !Array.isArray(raw.devices)) throw new Error(t('remote.store.badFormat', { file: 'devices.json' }));
    return raw;
  }
  async function readRevoked() {
    const raw = await readJson(revokedFile, { version: 1, keys: [] });
    if (raw?.version !== 1 || !Array.isArray(raw.keys)) throw new Error(t('remote.store.badFormat', { file: 'revoked.json' }));
    return raw;
  }

  return {
    dir,
    secrets,

    /** ホストの鍵。無ければ作る（プロセスをまたいで 1 つだけになるよう、秘密の置き場の排他の中で）。 */
    async identity() {
      if (identity) return identity;
      const priv = await secrets.update('hostKey', cur => cur ?? generateKeyPair().privateKey.toString('base64url'));
      identity = keyFrom(priv);
      return identity;
    },
    /** 作らずに読む。無ければ null。 */
    async peekIdentity() {
      if (identity) return identity;
      const priv = await secrets.get('hostKey');
      if (!priv) return null;
      identity = keyFrom(priv);
      return identity;
    },
    /** ホストの鍵を作り直す（hostId が変わる。Plus の「つなぎ直す」。呼んだ側は端末の取り消しと中継への張り直しを行う）。 */
    async regenerateIdentity() {
      const kp = generateKeyPair();
      await secrets.set('hostKey', kp.privateKey.toString('base64url'));
      identity = { ...kp, hostId: hostIdFor(kp.publicKey) };
      return identity;
    },

    async settings() {
      const raw = await readJson(settingsFile, {});
      return {
        enabled: raw.enabled === true,
        relayUrl: typeof raw.relayUrl === 'string' ? raw.relayUrl : '',
        hostName: typeof raw.hostName === 'string' ? raw.hostName : '',
        // Pleiad Plus の公式の中継につなぐか（docs/plus.md §既定）。既定は入（リモートが入で Plus にログインしているときだけ張る）。
        // userSet は人が切り替えた印。印の無い connect は、既定が切だった頃に何もしなくても書かれた値と区別できないので入とみなす
        plus: raw.plus?.userSet === true
          ? { connect: raw.plus.connect === true, userSet: true }
          : { connect: true, userSet: false },
      };
    },
    async saveSettings(patch) {
      return serial(async () => {
        const next = { ...(await this.settings()), ...patch };
        await writeJson(settingsFile, next);
        return next;
      });
    },
    enrollSecret: () => secrets.get('enrollSecret'),
    setEnrollSecret: value => value ? secrets.set('enrollSecret', value) : secrets.delete('enrollSecret'),
    storageStatus: () => secrets.status(),

    async devices() { return (await readDevices()).devices; },
    async addDevice(device) {
      return lockedDevices(async () => {
        const data = await readDevices();
        data.devices = data.devices.filter(d => d.id !== device.id).concat(device);
        await writeJson(devicesFile, data);
        return device;
      });
    },
    /** 端末の記録の一部を置き換える（もう一度の許可・トークンの出し直し）。置き換えた後のものを返す（無ければ null）。 */
    async updateDevice(id, patch) {
      return lockedDevices(async () => {
        const data = await readDevices();
        const hit = data.devices.find(d => d.id === id);
        if (!hit) return null;
        Object.assign(hit, patch);
        await writeJson(devicesFile, data);
        return hit;
      });
    },
    /** 公式の中継からの申し込みを断った記録（plus-requests.json）。読めない・形が違えば空から数える。 */
    async plusRequests() {
      const raw = await readJson(plusRequestsFile, null).catch(() => null);
      return raw?.version === 1 && raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts) ? raw : { version: 1, accounts: {} };
    },
    async savePlusRequests(data) { return serial(() => writeJson(plusRequestsFile, data)); },
    /** 取り消した鍵の一覧（hidden のものも含む）。 */
    async revokedKeys() { return (await readRevoked()).keys; },
    /** 取り消した鍵を足す。同じ鍵がもうあれば日付と取り消した機器だけ新しくし、一覧にも戻す。 */
    async addRevoked(entry) {
      return lockedDevices(async () => {
        const data = await readRevoked();
        const hit = data.keys.find(k => k.publicKey === entry.publicKey);
        if (hit) Object.assign(hit, { id: entry.id ?? hit.id, revokedAt: entry.revokedAt, by: entry.by, hidden: false });
        else data.keys.push({ ...entry });
        await writeJson(revokedFile, data);
        return hit ?? entry;
      });
    },
    /** 取り消した端末を一覧から消す（鍵は残し、表示だけ外す）。 */
    async hideRevoked(publicKey) {
      return lockedDevices(async () => {
        const data = await readRevoked();
        const hit = data.keys.find(k => k.publicKey === publicKey);
        if (!hit) return null;
        hit.hidden = true;
        await writeJson(revokedFile, data);
        return hit;
      });
    },
    /** 一覧から消す。消したものを返す（無ければ null）。 */
    async removeDevice(id) {
      return lockedDevices(async () => {
        const data = await readDevices();
        const hit = data.devices.find(d => d.id === id) ?? null;
        if (!hit) return null;
        data.devices = data.devices.filter(d => d.id !== id);
        await writeJson(devicesFile, data);
        return hit;
      });
    },
    /**
     * 通知の記録（docs/remote.md §11-5）。patch は { settings?, muted?, registeredAt?, lastSentAt? } で、書いたものだけ置き換える。
     * 通知鍵そのものは devices.json には置かず、秘密の置き場（notify:<id>）に置く。
     */
    async setNotify(id, patch) {
      return lockedDevices(async () => {
        const data = await readDevices();
        const hit = data.devices.find(d => d.id === id);
        if (!hit) return null;
        hit.notify = { ...(hit.notify ?? {}), ...patch };
        await writeJson(devicesFile, data);
        return hit;
      });
    },
    notifyKey: id => secrets.get(`notify:${id}`),
    setNotifyKey: (id, value) => secrets.set(`notify:${id}`, value),
    removeNotifyKey: id => secrets.delete(`notify:${id}`),

    async touchDevice(id, at = new Date().toISOString()) {
      return lockedDevices(async () => {
        const data = await readDevices();
        const hit = data.devices.find(d => d.id === id);
        if (!hit) return null;
        hit.lastSeenAt = at;
        await writeJson(devicesFile, data);
        return hit;
      });
    },
  };
}
