const encoder = new TextEncoder();
const decoder = new TextDecoder();

class BrowserBytes extends Uint8Array {
  static from(value, offset, length) {
    if (typeof value === 'string') return new BrowserBytes(encoder.encode(value));
    if (value instanceof ArrayBuffer) return new BrowserBytes(value, offset, length);
    return new BrowserBytes(value);
  }
  static alloc(size) { return new BrowserBytes(size); }
  static allocUnsafe(size) { return new BrowserBytes(size); }
  static isBuffer(value) { return value instanceof BrowserBytes; }
  static concat(parts) {
    const result = new BrowserBytes(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
  copy(target, offset) { target.set(this, offset); }
  view() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }
  readUInt8(offset = 0) { return this.view().getUint8(offset); }
  readUInt16BE(offset = 0) { return this.view().getUint16(offset); }
  readUInt32BE(offset = 0) { return this.view().getUint32(offset); }
  writeUInt8(value, offset = 0) { this.view().setUint8(offset, value); }
  writeUInt16BE(value, offset = 0) { this.view().setUint16(offset, value); }
  writeUInt32BE(value, offset = 0) { this.view().setUint32(offset, value); }
  toString(encoding) {
    if (encoding === 'hex') return Array.from(this, byte => byte.toString(16).padStart(2, '0')).join('');
    return decoder.decode(this);
  }
}
class BrowserEvents {
  #listeners = new Map();
  on(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, []);
    this.#listeners.get(type).push(fn);
    return this;
  }
  once(type, fn) {
    const listener = (...args) => {
      this.#listeners.get(type).splice(this.#listeners.get(type).indexOf(listener), 1);
      fn(...args);
    };
    return this.on(type, listener);
  }
  listenerCount(type) { return this.#listeners.get(type)?.length ?? 0; }
  emit(type, ...args) {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) fn(...args);
  }
}

const node = typeof process !== 'undefined' && Boolean(process.versions?.node);
export const WireBytes = node ? globalThis.Buffer : BrowserBytes;
export const WireEvents = node ? (await import('node:events')).EventEmitter : BrowserEvents;
