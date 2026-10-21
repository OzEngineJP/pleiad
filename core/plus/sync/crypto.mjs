// 同期の暗号（docs/plus.md「同期」）。暗号化と復号はこの PC の中だけで行い、鍵は api に渡さない。
//
//   K（アカウントの同期鍵・32 バイト）と keyId（8 バイトの小文字の hex）
//   K_enc = HKDF-SHA256(K, salt 空, "pleiad sync enc v1")      … 項目の中身の AES-256-GCM の鍵
//   K_id  = HKDF-SHA256(K, salt 空, "pleiad sync item id v1")  … 項目の ID（path の HMAC）の鍵
//
//   包む（W が T のために）: kek = HKDF-SHA256(X25519(W.priv, T.pub), salt = W.pub ‖ T.pub, "pleiad sync wrap v1")
//     wrapped = base64url(nonce12 ‖ AES-256-GCM(kek, nonce12, K, aad = "pleiad-sync-wrap-v1|uid|T.hostId|keyId"))（60 バイト）
//   項目: itemId = base64url(HMAC-SHA256(K_id, path)) の先頭 32 字
//     暗号文 = "v1." + keyId + "." + base64url(nonce12) + "." + base64url(AES-256-GCM(K_enc, nonce12, 平文, aad = "pleiad-sync-item-v1|uid|itemId|rev"))
import crypto from 'node:crypto';
import { dh, generateKeyPair, keyPairFromPrivate } from '../../remote/noise.mjs';

const ENC_INFO = 'pleiad sync enc v1';
const ID_INFO = 'pleiad sync item id v1';
const WRAP_INFO = 'pleiad sync wrap v1';
const WRAP_AAD = 'pleiad-sync-wrap-v1';
const ITEM_AAD = 'pleiad-sync-item-v1';
const TAG = 16;
const NONCE = 12;
export const KEY_ID_RX = /^[0-9a-f]{16}$/;
export const ITEM_ID_RX = /^[A-Za-z0-9_-]{32}$/;

export const b64url = buf => Buffer.from(buf).toString('base64url');
export const fromB64url = s => Buffer.from(String(s ?? ''), 'base64url');

const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), 32));

/** K から項目の鍵（enc）と ID の鍵（id）を導く */
export function deriveItemKeys(key) {
  const K = Buffer.from(key);
  if (K.length !== 32) throw new Error('sync key must be 32 bytes');
  return { enc: hkdf(K, Buffer.alloc(0), ENC_INFO), id: hkdf(K, Buffer.alloc(0), ID_INFO) };
}

/** 新しいアカウントの同期鍵 { keyId, key } */
export function newAccountKey() {
  return { keyId: crypto.randomBytes(8).toString('hex'), key: crypto.randomBytes(32) };
}

/** ホストの同期用の X25519 の鍵対（Noise の静的鍵とは別）。{ privateKey, publicKey } は生の 32 バイト */
export const newSyncKeyPair = () => generateKeyPair();
export const syncKeyPairFromPrivate = priv => keyPairFromPrivate(priv);

function wrapKek(shared, wrapperPublic, targetPublic) {
  return hkdf(shared, Buffer.concat([Buffer.from(wrapperPublic), Buffer.from(targetPublic)]), WRAP_INFO);
}
const wrapAad = (uid, targetHostId, keyId) => Buffer.from(`${WRAP_AAD}|${uid}|${targetHostId}|${keyId}`, 'utf8');

/**
 * W（この PC）が T のために K を包む。
 * @param {{ key: Buffer, keyId: string, uid: string, privateKey: Buffer, publicKey: Buffer, targetPublicKey: Buffer, targetHostId: string, nonce?: Buffer }} o
 */
export function wrapKey({ key, keyId, uid, privateKey, publicKey, targetPublicKey, targetHostId, nonce = crypto.randomBytes(NONCE) }) {
  const kek = wrapKek(dh(privateKey, targetPublicKey), publicKey, targetPublicKey);
  const c = crypto.createCipheriv('aes-256-gcm', kek, nonce);
  c.setAAD(wrapAad(uid, targetHostId, keyId));
  const body = Buffer.concat([c.update(Buffer.from(key)), c.final()]);
  return b64url(Buffer.concat([nonce, body, c.getAuthTag()]));
}

/**
 * T（この PC）が W の包んだ K を開く。開けなければ null（タグが合わない・形が違う・鍵が壊れている）。
 * @param {{ wrapped: string, keyId: string, uid: string, privateKey: Buffer, publicKey: Buffer, wrapperPublicKey: Buffer, hostId: string }} o
 */
export function unwrapKey({ wrapped, keyId, uid, privateKey, publicKey, wrapperPublicKey, hostId }) {
  try {
    const raw = fromB64url(wrapped);
    if (raw.length !== NONCE + 32 + TAG) return null;
    const kek = wrapKek(dh(privateKey, wrapperPublicKey), wrapperPublicKey, publicKey);
    const d = crypto.createDecipheriv('aes-256-gcm', kek, raw.subarray(0, NONCE));
    d.setAAD(wrapAad(uid, hostId, keyId));
    d.setAuthTag(raw.subarray(NONCE + 32));
    return Buffer.concat([d.update(raw.subarray(NONCE, NONCE + 32)), d.final()]);
  } catch { return null; }
}

/** 項目の ID（path の HMAC の base64url の先頭 32 字）。api には path ではなくこれだけを渡す */
export function itemIdFor(idKey, logicalPath) {
  return b64url(crypto.createHmac('sha256', idKey).update(Buffer.from(logicalPath, 'utf8')).digest()).slice(0, 32);
}

const itemAad = (uid, itemId, rev) => Buffer.from(`${ITEM_AAD}|${uid}|${itemId}|${rev}`, 'utf8');

// 平文の from（上げた PC の hostId）の形。画面に「どの PC から」を出すためだけに使い、取り込むかどうかの判断には使わない
const FROM_RX = /^[A-Za-z0-9._:-]{1,128}$/;

/** 平文の形: { v: 1, path, mtime, deleted, content(base64), from? } */
export function itemPlaintext({ path, mtime, deleted = false, content = null, from = null }) {
  return {
    v: 1, path, mtime: new Date(mtime).toISOString(), deleted: Boolean(deleted), content: deleted ? '' : Buffer.from(content ?? '').toString('base64'),
    ...(typeof from === 'string' && FROM_RX.test(from) ? { from } : {}),
  };
}

/**
 * 項目を暗号化する。rev は書き込む版（baseRev + 1）。
 * @param {{ encKey: Buffer, keyId: string, uid: string, itemId: string, rev: number, plaintext: object, nonce?: Buffer }} o
 */
export function encryptItem({ encKey, keyId, uid, itemId, rev, plaintext, nonce = crypto.randomBytes(NONCE) }) {
  const c = crypto.createCipheriv('aes-256-gcm', encKey, nonce);
  c.setAAD(itemAad(uid, itemId, rev));
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(plaintext), 'utf8')), c.final(), c.getAuthTag()]);
  return `v1.${keyId}.${b64url(nonce)}.${b64url(body)}`;
}

/**
 * 受けた項目を開く。開けない・形が違う・path から作った ID が itemId と違う・path が論理名の形でない → null。
 * from（上げた PC）は形が合うときだけ返す（無い・形が違う → null）。
 * @param {{ encKey: Buffer, idKey: Buffer, keyId: string, uid: string, itemId: string, rev: number, ciphertext: string, validPath?: (p: string) => boolean }} o
 */
export function decryptItem({ encKey, idKey, keyId, uid, itemId, rev, ciphertext, validPath = () => true }) {
  try {
    const parts = String(ciphertext ?? '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || parts[1] !== keyId) return null;
    const nonce = fromB64url(parts[2]);
    const body = fromB64url(parts[3]);
    if (nonce.length !== NONCE || body.length < TAG) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', encKey, nonce);
    d.setAAD(itemAad(uid, itemId, rev));
    d.setAuthTag(body.subarray(body.length - TAG));
    const plain = JSON.parse(Buffer.concat([d.update(body.subarray(0, body.length - TAG)), d.final()]).toString('utf8'));
    if (plain?.v !== 1 || typeof plain.path !== 'string' || typeof plain.deleted !== 'boolean' || typeof plain.content !== 'string') return null;
    if (!Number.isFinite(Date.parse(plain.mtime))) return null;
    if (itemIdFor(idKey, plain.path) !== itemId || !validPath(plain.path)) return null;
    return {
      path: plain.path, mtime: new Date(plain.mtime).toISOString(), deleted: plain.deleted, content: plain.deleted ? null : Buffer.from(plain.content, 'base64'),
      from: typeof plain.from === 'string' && FROM_RX.test(plain.from) ? plain.from : null,
    };
  } catch { return null; }
}
