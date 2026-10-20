// 同期の暗号（core/plus/sync/crypto.mjs、docs/plus.md「同期」）。HKDF・鍵を包む・開く・項目の暗号文の往復と、固定の試験ベクトル。
// 試験ベクトルは docs/plus.md の「試験ベクトル」と同じ値。LLM もネットワークも使わない。
import crypto from 'node:crypto';
import {
  deriveItemKeys, syncKeyPairFromPrivate, wrapKey, unwrapKey, itemIdFor, itemPlaintext, encryptItem, decryptItem, newAccountKey, KEY_ID_RX, ITEM_ID_RX,
} from '../../core/plus/sync/crypto.mjs';
import { parseLogicalPath } from '../../core/plus/sync/targets.mjs';

export const name = 'plus-sync-crypto';
export const title = '同期の暗号: HKDF・包む・開く・項目の往復・固定の試験ベクトル・aad を変えると開けない・itemId の不一致を捨てる';

const seq = (start, n) => Buffer.from(Array.from({ length: n }, (_, i) => (start + i) & 255));

// docs/plus.md「試験ベクトル」と同じ入力
const K = seq(0x00, 32);
const KEY_ID = '0011223344556677';
const UID = 'test-user';
const W = syncKeyPairFromPrivate(seq(0x40, 32));
const T = syncKeyPairFromPrivate(seq(0x60, 32));
const TARGET = 'host-target';
const PATH = 'skills/pleiad/demo/SKILL.md';
const MTIME = '2026-01-02T03:04:05.000Z';
const CONTENT = Buffer.from('hello\r\n');

const VECTOR = {
  wPub: 'eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRo',
  tPub: 'Z13VdO13iTELPS52gfN5C0ZsdzsVIf7PNld5WDcepS8',
  kEnc: '5148e946bc3b28b72b9454ed12758b194eb8b7dc535c1ada0a410caa3c305c3f',
  kId: '4280c95d06eb920592e3eab530cd79d123104de4dc4f4ec5418cc1c9f3b8551e',
  wrapped: 'oKGio6SlpqeoqaqrtTglUOa9GkxgTALVD1CWBroh_HpFU5OBb_UCJmUoSiCb9eGAAD9NEAIIA_4UnMW7',
  itemId: 'Yxk-Pddt_fEXUSeObnwpP9_aCuErsMz6',
  plaintext: '{"v":1,"path":"skills/pleiad/demo/SKILL.md","mtime":"2026-01-02T03:04:05.000Z","deleted":false,"content":"aGVsbG8NCg=="}',
  ciphertext: 'v1.0011223344556677.sLGys7S1tre4ubq7.sqVME4Kd2WWoXG3_Bz7DB7q80JMLwTpEKrfhR4RbgEoJGp9HXG-Jmx8X8qDZgApn7eCJ6v-3YSMhIrt78ZRxU1ki0seYF8niA0GsGy7sVL3LbTn7UusQec2QbeBL-fEY5DVuhTnMia5_MyCOLTF81UjwV0jp7_jnjV2eC0kGGuM823nMfWFXNg',
};

export default async function (t) {
  // ---- HKDF（node の hkdf と別に、RFC 5869 の式を HMAC で組んで照らす）
  const { enc, id } = deriveItemKeys(K);
  const hkdfByHand = (ikm, info) => {
    const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(ikm).digest();
    return crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])])).digest();
  };
  t.ok('K_enc・K_id が試験ベクトルと同じ', enc.toString('hex') === VECTOR.kEnc && id.toString('hex') === VECTOR.kId, `${enc.toString('hex')} ${id.toString('hex')}`);
  t.ok('K_enc・K_id は RFC 5869 の式（salt 空・info・32 バイト）で手で組んだものと同じ',
    hkdfByHand(K, 'pleiad sync enc v1').equals(enc) && hkdfByHand(K, 'pleiad sync item id v1').equals(id));
  t.ok('ホストの同期の公開鍵（X25519）が試験ベクトルと同じ', W.publicKey.toString('base64url') === VECTOR.wPub && T.publicKey.toString('base64url') === VECTOR.tPub);
  const fresh = newAccountKey();
  t.ok('新しい K は 32 バイト、keyId は 16 字の小文字の hex', fresh.key.length === 32 && KEY_ID_RX.test(fresh.keyId));

  // ---- 包む・開く
  const wrapped = wrapKey({ key: K, keyId: KEY_ID, uid: UID, privateKey: W.privateKey, publicKey: W.publicKey, targetPublicKey: T.publicKey, targetHostId: TARGET, nonce: seq(0xa0, 12) });
  t.ok('包んだ鍵が試験ベクトルと同じ（60 バイトの base64url）', wrapped === VECTOR.wrapped && Buffer.from(wrapped, 'base64url').length === 60, wrapped);
  const open = o => unwrapKey({ wrapped, keyId: KEY_ID, uid: UID, privateKey: T.privateKey, publicKey: T.publicKey, wrapperPublicKey: W.publicKey, hostId: TARGET, ...o });
  t.ok('T が W の公開鍵で開くと K に戻る', open({})?.equals(K) === true);
  t.ok('aad の uid を変えると開けない', open({ uid: 'other-user' }) === null);
  t.ok('aad の hostId を変えると開けない', open({ hostId: 'host-other' }) === null);
  t.ok('aad の keyId を変えると開けない', open({ keyId: '8899aabbccddeeff' }) === null);
  const third = syncKeyPairFromPrivate(seq(0x80, 32));
  t.ok('別のホストの鍵対では開けない', open({ privateKey: third.privateKey, publicKey: third.publicKey }) === null);
  t.ok('W の公開鍵を差し替えると開けない', open({ wrapperPublicKey: third.publicKey }) === null);
  const flipped = Buffer.from(wrapped, 'base64url'); flipped[20] ^= 1;
  t.ok('包みの 1 ビットを変えると開けない', open({ wrapped: flipped.toString('base64url') }) === null);
  t.ok('長さの違う包みは開けない', open({ wrapped: wrapped.slice(0, 60) }) === null);

  // ---- 項目
  const itemId = itemIdFor(id, PATH);
  t.ok('itemId が試験ベクトルと同じ（HMAC の base64url の先頭 32 字）', itemId === VECTOR.itemId && ITEM_ID_RX.test(itemId), itemId);
  const plaintext = itemPlaintext({ path: PATH, mtime: MTIME, content: CONTENT });
  t.ok('平文の形が試験ベクトルと同じ', JSON.stringify(plaintext) === VECTOR.plaintext);
  const ciphertext = encryptItem({ encKey: enc, keyId: KEY_ID, uid: UID, itemId, rev: 1, plaintext, nonce: seq(0xb0, 12) });
  t.ok('暗号文が試験ベクトルと同じ（v1.keyId.nonce.本体）', ciphertext === VECTOR.ciphertext, ciphertext);
  const dec = o => decryptItem({ encKey: enc, idKey: id, keyId: KEY_ID, uid: UID, itemId, rev: 1, ciphertext, ...o });
  const back = dec({});
  t.ok('開くと path・mtime・中身のバイト列（CRLF を含む）が戻る', back?.path === PATH && back.mtime === MTIME && back.deleted === false && back.content.equals(CONTENT));
  t.ok('aad の uid を変えると開けない', dec({ uid: 'other-user' }) === null);
  t.ok('aad の rev を変えると開けない', dec({ rev: 2 }) === null);
  t.ok('aad の itemId を変えると開けない', dec({ itemId: itemIdFor(id, 'skills/pleiad/other.md') }) === null);
  t.ok('keyId が違う暗号文は開かない', dec({ keyId: '8899aabbccddeeff' }) === null);
  const otherKeys = deriveItemKeys(seq(0x20, 32));
  t.ok('別の K の enc では開けない', dec({ encKey: otherKeys.enc }) === null);

  // itemId の不一致: 正しく暗号化してあっても、平文の path から作った ID が itemId と違えば捨てる
  const liar = itemIdFor(id, 'skills/pleiad/other.md');
  const mismatched = encryptItem({ encKey: enc, keyId: KEY_ID, uid: UID, itemId: liar, rev: 1, plaintext });
  t.ok('平文の path から作った ID が itemId と違う項目を捨てる', decryptItem({ encKey: enc, idKey: id, keyId: KEY_ID, uid: UID, itemId: liar, rev: 1, ciphertext: mismatched }) === null);

  // 平文の path が論理名の形でないものを捨てる
  const validPath = p => Boolean(parseLogicalPath(p));
  for (const bad of ['../outside.md', '/etc/passwd', 'skills\\pleiad\\a.md', 'other/thing', 'skills/pleiad/../x', 'skills/pleiad/.env']) {
    const pid = itemIdFor(id, bad);
    const ct = encryptItem({ encKey: enc, keyId: KEY_ID, uid: UID, itemId: pid, rev: 1, plaintext: itemPlaintext({ path: bad, mtime: MTIME, content: CONTENT }) });
    t.ok(`論理名の形でない path（${JSON.stringify(bad)}）を捨てる`, decryptItem({ encKey: enc, idKey: id, keyId: KEY_ID, uid: UID, itemId: pid, rev: 1, ciphertext: ct, validPath }) === null);
  }

  // 消した項目
  const delPlain = itemPlaintext({ path: PATH, mtime: MTIME, deleted: true });
  t.ok('消した項目の平文は deleted: true・content が空', delPlain.deleted === true && delPlain.content === '');
  const delCt = encryptItem({ encKey: enc, keyId: KEY_ID, uid: UID, itemId, rev: 3, plaintext: delPlain });
  const delBack = decryptItem({ encKey: enc, idKey: id, keyId: KEY_ID, uid: UID, itemId, rev: 3, ciphertext: delCt });
  t.ok('消した項目も開ける（中身は null）', delBack?.deleted === true && delBack.content === null);
  t.ok('暗号文に path・中身の文字列が出ない', !ciphertext.includes('skills') && !ciphertext.includes('hello') && !ciphertext.includes(Buffer.from(PATH).toString('base64')));
}
