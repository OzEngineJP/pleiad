import { generateKeyPair, hostIdFor } from './noise.mjs';
import { b64url, unbase64, encode } from './browser-wire.mjs';

const subtle = crypto.subtle;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function browserIdentity({ account, hostId, hostKey }) {
  if (typeof account !== 'string' || !account) throw new TypeError('account storage key is required');
  const remoteStatic = unbase64(hostKey);
  if (await hostIdFor(remoteStatic) !== hostId) throw new Error('host key does not match host ID');
  const opening = indexedDB.open('pleiad-browser-remote', 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore('identities');
  const db = await request(opening);
  try {
    const id = JSON.stringify([account, hostId]);
    const existing = await request(db.transaction('identities').objectStore('identities').get(id));
    // Generate outside a transaction. Recheck in a write transaction to handle two new tabs.
    const candidate = existing ?? { device: await generateKeyPair(), hostKey };
    const tx = db.transaction('identities', 'readwrite');
    const saved = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    const store = tx.objectStore('identities');
    const current = await request(store.get(id)) ?? candidate;
    if (current.hostKey === hostKey) store.put(current, id);
    await saved;
    if (current.hostKey !== hostKey) throw new Error('host key changed');
    if (current.device.privateKey.extractable !== false) throw new Error('browser key cannot be stored securely');
    return { ...current.device, remoteStatic };
  } finally { db.close(); }
}

async function hmac(key, data) {
  const material = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', material, data));
}

export async function confirmationCode(hash) {
  const bytes = await hmac(hash, encode.encode('pleiad pair code'));
  return String(new DataView(bytes.buffer).getUint32(0) % 1_000_000).padStart(6, '0');
}

export async function ticketProof({ privateKey, hostId, nonce, serverPublicKey }) {
  const peer = await subtle.importKey('raw', unbase64(serverPublicKey), 'X25519', false, []);
  const shared = await subtle.deriveBits({ name: 'X25519', public: peer }, privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const key = await subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encode.encode('pleiad host proof v1'),
  }, material, 256);
  const challenge = unbase64(nonce);
  const label = encode.encode(hostId + 'device');
  const input = new Uint8Array(challenge.length + label.length);
  input.set(challenge);
  input.set(label, challenge.length);
  return b64url(await hmac(key, input));
}
