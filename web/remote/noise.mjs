// ブラウザーの Noise IK（docs/remote.md §3）。バイト列は Node 版 core/remote/noise.mjs と同じ。
const PROTOCOL = 'Noise_IK_25519_AESGCM_SHA256';
const DH_BYTES = 32;
const TAG_BYTES = 16;
const MAX_MESSAGE = 65535;
export const MAX_PLAINTEXT = MAX_MESSAGE - TAG_BYTES;
const MAX_NONCE = 2 ** 32;
const EMPTY = new Uint8Array();
const encoder = new TextEncoder();

function concat(...parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function bytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError('expected bytes or a string');
}

function publicBytes(value) {
  const key = bytes(value);
  if (key.length !== DH_BYTES) throw new TypeError('X25519 public key must be 32 bytes');
  return key;
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}

/** The public key is raw X25519 (32 bytes). The private key stays in WebCrypto. */
export async function generateKeyPair() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
  return { publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)), privateKey };
}

async function dh(privateKey, rawPublicKey) {
  const publicKey = await crypto.subtle.importKey('raw', rawPublicKey, 'X25519', false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256));
  if (secret.every(byte => byte === 0)) throw new Error('X25519 result is zero (invalid peer key)');
  return secret;
}

async function noiseHkdf(chainingKey, input) {
  // RFC 5869 with an empty info field gives Noise's two HKDF outputs.
  const material = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
  const output = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: chainingKey, info: EMPTY }, material, 512,
  ));
  return [output.subarray(0, 32), output.subarray(32)];
}

function aesKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

class CipherState {
  #key;
  #nonce = 0;
  #tail = Promise.resolve();

  constructor(key) {
    this.#key = key;
  }

  encrypt(ad, input) { return this.#crypt('encrypt', ad, input); }
  decrypt(ad, input) { return this.#crypt('decrypt', ad, input); }

  #crypt(operation, ad, input) {
    const data = bytes(input);
    const run = this.#tail.then(async () => {
      if (this.#nonce >= MAX_NONCE) throw new Error('nonce exhausted (reconnect)');
      if (data.length > (operation === 'encrypt' ? MAX_PLAINTEXT : MAX_MESSAGE)) {
        throw new RangeError('Noise message too large');
      }
      if (operation === 'decrypt' && data.length < TAG_BYTES) throw new Error('ciphertext too short');

      // AES-GCM uses four zero bytes followed by a big-endian uint64 (Noise §12.4).
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setBigUint64(4, BigInt(this.#nonce));
      const result = await crypto.subtle[operation](
        { name: 'AES-GCM', iv, additionalData: ad, tagLength: TAG_BYTES * 8 }, this.#key, data,
      );
      this.#nonce++;
      return new Uint8Array(result);
    });
    // Calls in each direction take nonces in call order, even across await.
    // A failed operation leaves the nonce unchanged (Noise §5.1).
    this.#tail = run.catch(() => {});
    return run;
  }
}

class SymmetricState {
  constructor() {
    this.hash = new Uint8Array(32);
    this.hash.set(encoder.encode(PROTOCOL));
    this.chainingKey = this.hash;
  }

  async mixHash(value) {
    this.hash = await sha256(concat(this.hash, value));
  }

  async mixKey(secret) {
    const [chainingKey, key] = await noiseHkdf(this.chainingKey, secret);
    this.chainingKey = chainingKey;
    this.cipher = new CipherState(await aesKey(key));
  }

  async encryptAndHash(plaintext) {
    const encrypted = await this.cipher.encrypt(this.hash, plaintext);
    await this.mixHash(encrypted);
    return encrypted;
  }

  async decryptAndHash(ciphertext) {
    const decrypted = await this.cipher.decrypt(this.hash, ciphertext);
    await this.mixHash(ciphertext);
    return decrypted;
  }

  async split() {
    const keys = await noiseHkdf(this.chainingKey, EMPTY);
    return Promise.all(keys.map(async key => new CipherState(await aesKey(key))));
  }
}

const MESSAGES = [
  ['e', 'es', 's', 'ss'],
  ['e', 'ee', 'se'],
];
const OVERHEAD = [DH_BYTES * 2 + TAG_BYTES * 2, DH_BYTES + TAG_BYTES];

function keyPair(pair) {
  if (pair?.privateKey?.type !== 'private' || pair.privateKey.algorithm?.name !== 'X25519') {
    throw new TypeError('an X25519 private CryptoKey is required');
  }
  return { publicKey: publicBytes(pair.publicKey), privateKey: pair.privateKey };
}

/**
 * Noise IK. The initiator supplies the pinned host public key. A responder must
 * check remoteStatic against the approved device before sending its response.
 * Await each handshake operation. Discard the session after a failed read.
 * Use one WebSocket binary message per handshake message or transport ciphertext.
 */
export class Handshake {
  #initiator;
  #static;
  #remoteStatic;
  #ephemeral;
  #remoteEphemeral;
  #symmetric = new SymmetricState();
  #prologue;
  #step = 0;
  #busy = false;
  #failed = false;
  #split = false;

  constructor({ initiator, staticKey, remoteStatic, prologue = EMPTY, ephemeral }) {
    if (typeof initiator !== 'boolean') throw new TypeError('initiator must be true or false');
    this.#initiator = initiator;
    this.#static = keyPair(staticKey);
    this.#remoteStatic = initiator ? publicBytes(remoteStatic) : null;
    // Fixed ephemeral keys are only for deterministic vector tests.
    this.#ephemeral = ephemeral ? keyPair(ephemeral) : null;
    this.#prologue = bytes(prologue);
  }

  get remoteStatic() { return this.#remoteStatic?.slice() ?? null; }
  get isComplete() { return this.#step === MESSAGES.length; }
  get isMyTurn() { return !this.isComplete && (this.#step === 0) === this.#initiator; }

  #begin(writing) {
    if (this.#failed || this.#busy || this.isComplete || writing !== this.isMyTurn) {
      throw new Error('invalid Noise handshake state');
    }
    this.#busy = true;
  }

  async #mixPrologue() {
    if (this.#step !== 0) return;
    await this.#symmetric.mixHash(this.#prologue);
    await this.#symmetric.mixHash(this.#initiator ? this.#remoteStatic : this.#static.publicKey);
  }

  async #mixDh(token) {
    let local, remote;
    switch (token) {
      case 'es':
        [local, remote] = this.#initiator ?
          [this.#ephemeral, this.#remoteStatic] : [this.#static, this.#remoteEphemeral];
        break;
      case 'se':
        [local, remote] = this.#initiator ?
          [this.#static, this.#remoteEphemeral] : [this.#ephemeral, this.#remoteStatic];
        break;
      case 'ee':
        [local, remote] = [this.#ephemeral, this.#remoteEphemeral];
        break;
      case 'ss':
        [local, remote] = [this.#static, this.#remoteStatic];
        break;
    }
    await this.#symmetric.mixKey(await dh(local.privateKey, remote));
  }

  async writeMessage(payload = EMPTY) {
    const data = bytes(payload);
    this.#begin(true);
    try {
      if (data.length + OVERHEAD[this.#step] > MAX_MESSAGE) throw new RangeError('handshake message too large');
      await this.#mixPrologue();
      const parts = [];
      for (const token of MESSAGES[this.#step]) {
        if (token === 'e') {
          this.#ephemeral ??= await generateKeyPair();
          parts.push(this.#ephemeral.publicKey);
          await this.#symmetric.mixHash(this.#ephemeral.publicKey);
        } else if (token === 's') {
          parts.push(await this.#symmetric.encryptAndHash(this.#static.publicKey));
        } else {
          await this.#mixDh(token);
        }
      }
      parts.push(await this.#symmetric.encryptAndHash(data));
      this.#step++;
      return concat(...parts);
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async readMessage(message) {
    const data = bytes(message);
    this.#begin(false);
    try {
      if (data.length < OVERHEAD[this.#step] || data.length > MAX_MESSAGE) {
        throw new RangeError('invalid handshake message size');
      }
      await this.#mixPrologue();
      let offset = 0;
      for (const token of MESSAGES[this.#step]) {
        if (token === 'e') {
          this.#remoteEphemeral = data.subarray(offset, offset + DH_BYTES);
          offset += DH_BYTES;
          await this.#symmetric.mixHash(this.#remoteEphemeral);
        } else if (token === 's') {
          const size = DH_BYTES + TAG_BYTES;
          this.#remoteStatic = await this.#symmetric.decryptAndHash(data.subarray(offset, offset + size));
          offset += size;
        } else {
          await this.#mixDh(token);
        }
      }
      const payload = await this.#symmetric.decryptAndHash(data.subarray(offset));
      this.#step++;
      return payload;
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async split() {
    if (!this.isComplete || this.#split) throw new Error('Noise handshake can be split only once after completion');
    this.#split = true;
    const [first, second] = await this.#symmetric.split();
    const [send, receive] = this.#initiator ? [first, second] : [second, first];
    return {
      handshakeHash: this.#symmetric.hash.slice(),
      encrypt: plaintext => send.encrypt(EMPTY, plaintext),
      decrypt: ciphertext => receive.decrypt(EMPTY, ciphertext),
    };
  }
}

export function prologueFor(hostId) {
  return encoder.encode('pleiad-remote/1' + String(hostId));
}

/** Lower-case Base32 SHA-256 of the host's raw public key, truncated to 26 characters. */
export async function hostIdFor(publicKey) {
  const hash = await sha256(publicBytes(publicKey));
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, id = '';
  for (const byte of hash) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += alphabet[(value >>> bits) & 31];
      if (id.length === 26) return id;
    }
  }
}
