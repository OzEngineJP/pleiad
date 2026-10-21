// 同じ版の transcript を getMessages / getCompactions / outline / older で共有する。
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSessionTranscript } from './claude-normalize.mjs';

export const TRANSCRIPT_CACHE_BYTES = 320 * 1024 * 1024;
export const TRANSCRIPT_CACHE_ENTRIES = 4;
const stamp = s => `${s.mtimeMs}:${s.size}:${s.ctimeMs}:${s.ino}:${s.dev}`;

/** 上限は元ファイルのバイト数。本文・全行の配列は保持せず、SDK が選んだ履歴と印だけ残す。 */
export function createTranscriptReader({ projects, selectMessages, onUnreadable = async () => {},
  io = fs, maxBytes = TRANSCRIPT_CACHE_BYTES, maxEntries = TRANSCRIPT_CACHE_ENTRIES }) {
  const files = new Map(), recent = new Map(), pending = new Map();
  let bytes = 0;
  const discard = file => {
    const old = recent.get(file);
    if (old) { bytes -= old.bytes; recent.delete(file); }
  };
  async function locate(root, id) {
    const key = path.join(root, id);
    const known = files.get(key);
    if (known) {
      try { return { file: known, stat: await io.stat(known) }; }
      catch { files.delete(key); discard(known); }
    }
    for (const dir of await io.readdir(root)) {
      const file = path.join(root, dir, `${id}.jsonl`);
      try {
        const stat = await io.stat(file);
        files.set(key, file);
        if (files.size > 128) files.delete(files.keys().next().value);
        return { file, stat };
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') await onUnreadable();
      }
    }
    return null;
  }
  return async function read(sessionId, timing) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId ?? ''))) return null;
    let file;
    try {
      const found = await locate(projects(), sessionId);
      if (!found) return null;
      file = found.file;
      const version = stamp(found.stat);
      const cached = recent.get(file);
      if (cached?.stamp === version) {
        recent.delete(file); recent.set(file, cached);
        return cached.value;
      }
      discard(file);
      const key = `${file}:${version}`;
      if (pending.has(key)) return await pending.get(key);
      const work = (async () => {
        const started = performance.now();
        const text = await io.readFile(file, 'utf8');
        timing?.('transcript.read', performance.now() - started);
        const parsing = performance.now();
        const { entries, ...extras } = parseSessionTranscript(text);
        timing?.('transcript.extras', performance.now() - parsing);
        const selecting = performance.now();
        // SDK が無い場合も、圧縮の印は transcript だけで読める。失敗した履歴は保持しない。
        const messages = await selectMessages(sessionId, entries).catch(() => null);
        timing?.('transcript.sdk', performance.now() - selecting);
        const value = { ...extras, entries: messages };
        // 読みながら追記・置換された版を次の要求へ持ち越さない。
        if (messages !== null && stamp(await io.stat(file)) === version && found.stat.size <= maxBytes && maxEntries > 0) {
          discard(file);
          while (recent.size && (recent.size >= maxEntries || bytes + found.stat.size > maxBytes)) discard(recent.keys().next().value);
          recent.set(file, { stamp: version, bytes: found.stat.size, value });
          bytes += found.stat.size;
        }
        return value;
      })();
      pending.set(key, work);
      try { return await work; } finally { pending.delete(key); }
    } catch {
      if (file) { discard(file); await onUnreadable(); }
      return null;
    }
  };
}
