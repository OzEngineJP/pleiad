import { Handshake, generateKeyPair, hostIdFor, prologueFor } from '/noise.mjs';

const fromHex = hex => Uint8Array.from(hex.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

async function vectorKeyPair(raw) {
  const pkcs8 = fromHex('302e020100300506032b656e04220420' + raw);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'X25519', false, ['deriveBits']);
  const basePoint = new Uint8Array(32);
  basePoint[0] = 9;
  const publicBase = await crypto.subtle.importKey('raw', basePoint, 'X25519', false, []);
  const publicKey = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: publicBase }, privateKey, 256));
  return { publicKey, privateKey };
}

async function persistKey(keyPair) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('remote-noise', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
      tx.objectStore('keys').put(keyPair, 'device');
    });
    return await new Promise((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get('device');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function run() {
  let checks = 0;
  function equal(actual, expected, description) {
    if (actual !== expected) throw new Error(description + ': expected ' + expected + ', got ' + actual);
    checks++;
  }
  async function rejects(operation, description, name) {
    try { await operation(); }
    catch (error) {
      if (name && error.name !== name) throw error;
      checks++;
      return;
    }
    throw new Error(description + ': operation succeeded');
  }

  const { noise, pleiad, frames } = await (await fetch('/vectors.json')).json();
  const generated = await generateKeyPair().catch(error => {
    throw new Error('WebCrypto X25519 key generation: ' + error.name + ': ' + error.message);
  });
  const vector = noise.find(entry => entry.protocol_name === 'Noise_IK_25519_AESGCM_SHA256');
  const initKey = await vectorKeyPair(vector.init_static);
  const respKey = await vectorKeyPair(vector.resp_static);
  const init = new Handshake({
    initiator: true, staticKey: initKey, remoteStatic: fromHex(vector.init_remote_static),
    prologue: fromHex(vector.init_prologue), ephemeral: await vectorKeyPair(vector.init_ephemeral),
  });
  const resp = new Handshake({
    initiator: false, staticKey: respKey,
    prologue: fromHex(vector.resp_prologue), ephemeral: await vectorKeyPair(vector.resp_ephemeral),
  });
  let sender = init, receiver = resp;
  for (const [index, message] of vector.messages.entries()) {
    const isHandshake = index < 2;
    const payload = fromHex(message.payload);
    const ciphertext = await (isHandshake ? sender.writeMessage(payload) : sender.encrypt(payload));
    equal(hex(ciphertext), message.ciphertext, 'ciphertext ' + index);
    const plaintext = await (isHandshake ? receiver.readMessage(ciphertext) : receiver.decrypt(ciphertext));
    equal(hex(plaintext), message.payload, 'plaintext ' + index);
    if (index === 0) equal(hex(resp.remoteStatic), hex(initKey.publicKey), 'initiator public key');
    [sender, receiver] = index === 1 ? await Promise.all([init.split(), resp.split()]) : [receiver, sender];
    if (index === 1) {
      equal(hex(sender.handshakeHash), vector.handshake_hash, 'initiator handshake hash');
      equal(hex(receiver.handshakeHash), vector.handshake_hash, 'responder handshake hash');
    }
  }
  equal(hex(respKey.publicKey), pleiad.host.publicKey, 'raw host public key');
  equal(await hostIdFor(respKey.publicKey), pleiad.host.hostId, 'host ID');
  equal(hex(prologueFor(pleiad.host.hostId)), pleiad.host.prologue, 'Pleiad prologue');

  const device = await persistKey(generated);
  equal(device.privateKey.extractable, false, 'non-extractable X25519 after IndexedDB');
  equal(hex(device.publicKey), hex(generated.publicKey), 'public key after IndexedDB');
  await rejects(() => crypto.subtle.exportKey('pkcs8', device.privateKey), 'private key export', 'InvalidAccessError');
  const prologue = prologueFor(pleiad.host.hostId);
  // Reproduce the same first message to test the real response and its corrupted copy.
  const ephemeral = await generateKeyPair();
  const clientOptions = { initiator: true, staticKey: device, remoteStatic: respKey.publicKey, prologue, ephemeral };
  const client = new Handshake(clientOptions);
  const host = new Handshake({ initiator: false, staticKey: respKey, prologue });
  const first = await client.writeMessage();
  await rejects(() => new Handshake({ initiator: false, staticKey: respKey }).readMessage(first), 'wrong prologue');
  await rejects(() => new Handshake({
    initiator: true, staticKey: device, remoteStatic: new Uint8Array(32), prologue,
  }).writeMessage(), 'low-order public key');
  await host.readMessage(first);
  const second = await host.writeMessage();
  const corrupted = second.slice();
  corrupted[corrupted.length - 1] ^= 1;
  const failed = new Handshake(clientOptions);
  await failed.writeMessage();
  await rejects(() => failed.readMessage(corrupted), 'unauthenticated handshake response');
  await rejects(() => failed.readMessage(second), 'reuse after failed handshake');
  await client.readMessage(second);
  equal(hex(host.remoteStatic), hex(device.publicKey), 'handshake with the persisted key');
  const out = await client.split();
  const into = await host.split();
  await rejects(() => client.split(), 'transport keys cannot restart at nonce zero');

  // Carry the existing Pleiad frames as opaque plaintext, also testing concurrent calls.
  const payloads = frames.map(({ frame }) => fromHex(frame));
  if (!payloads.length) throw new Error('missing Pleiad frame vectors');
  const encrypted = await Promise.all(payloads.map(payload => out.encrypt(payload)));
  const tampered = encrypted[0].slice();
  tampered[0] ^= 1;
  await rejects(() => into.decrypt(tampered), 'tampered transport ciphertext');
  const decrypted = await Promise.all(encrypted.map(ciphertext => into.decrypt(ciphertext)));
  for (const [index, payload] of decrypted.entries()) equal(hex(payload), hex(payloads[index]), 'transport frame ' + index);
  await rejects(() => into.decrypt(encrypted[0]), 'replayed transport ciphertext');
  await rejects(() => out.encrypt(new Uint8Array(65520)), 'oversized plaintext');
  equal((await out.encrypt(new Uint8Array(65519))).length, 65535, 'maximum message size');
  return checks;
}
