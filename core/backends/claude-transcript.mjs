// 同じ版の transcript を getMessages / getCompactions / outline / older で共有する。
// 追記しかない版は、前回の末尾の窓を照合してから差分だけを読み、増えた行だけを解釈する（ADR 0330）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionParser } from './claude-normalize.mjs';

export const TRANSCRIPT_CACHE_BYTES = 320 * 1024 * 1024;
export const TRANSCRIPT_CACHE_ENTRIES = 4;
// 追記かどうかの照合に使う窓: 先頭と末尾（書きかけの行の手前まで）のバイト数
const APPEND_WINDOW = 4096;
const stamp = s => `${s.mtimeMs}:${s.size}:${s.ctimeMs}:${s.ino}:${s.dev}`;

/**
 * 前回の記録（size・ino・dev・window・head）と今の stat を突き合わせ、
 * 「同じファイルが末尾にだけ書き足された」と分かるときだけ追加分を返す。
 * 先頭と末尾の窓が一致しない・ファイルが縮んだ・差し替えられたときは null（全部読み直す）。
 * 窓の外側（中腹）だけ書き換えた細工は見抜けないが、transcript は追記だけなので割り切る。
 */
export async function readAppendedText(io, file, stat, prev) {
  if (!prev || typeof io.open !== 'function') return null;
  if (prev.ino !== stat.ino || prev.dev !== stat.dev || stat.size <= prev.size) return null;
  let handle;
  try { handle = await io.open(file, 'r'); } catch { return null; }
  try {
    if (prev.head?.length) {
      const head = Buffer.alloc(prev.head.length);
      const got = await handle.read(head, 0, head.length, 0);
      if (got.bytesRead !== head.length || !head.equals(prev.head)) return null;
    }
    const chunk = Buffer.alloc(stat.size - prev.windowStart);
    const got = await handle.read(chunk, 0, chunk.length, prev.windowStart);
    if (got.bytesRead !== chunk.length) return null;
    if (!chunk.subarray(0, prev.window.length).equals(prev.window)) return null;
    // 追加分は書きかけの末尾の行と一体で UTF-8 として読む（行の途中がマルチバイトの途中でも崩れない）
    const region = chunk.subarray(prev.tailStart - prev.windowStart).toString('utf8');
    return { region, chunk };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 全部読みの結果から、次の追記読みに使う記録を作る。
 * tail は書きかけの末尾の行（'' = 改行で終わっている）。window は tail の手前まで遡る末尾の窓。
 */
export function trackTail(text, size) {
  const tailStartChar = text.lastIndexOf('\n') + 1;
  const tail = text.slice(tailStartChar);
  const tailStart = size - Buffer.byteLength(tail, 'utf8');
  const windowStartChar = Math.max(0, tailStartChar - APPEND_WINDOW);
  const window = Buffer.from(text.slice(windowStartChar), 'utf8');
  return { tail, tailStart, windowStart: size - window.length, window };
}

/** 先頭の照合窓（UTF-8 で読めないファイルは合わず毎回全部読み直しになるだけ）。 */
export function trackHead(text) {
  const head = Buffer.from(text.slice(0, APPEND_WINDOW), 'utf8');
  return head.length ? head : null;
}

/** 追記読みのあとの記録を、読んだ chunk（前回の windowStart から末尾）から作る。 */
export function trackTailAfterAppend(prev, size, chunk, tail) {
  const tailStart = size - Buffer.byteLength(tail, 'utf8');
  const windowStart = Math.max(0, tailStart - APPEND_WINDOW);
  return { tail, tailStart, windowStart, window: Buffer.from(chunk.subarray(windowStart - prev.windowStart)) };
}

/**
 * 追記分（前回の書きかけの行を含む領域。tail + 新しいバイト列を UTF-8 で読んだもの）を parser へ流す。
 * 行にできなかった末尾を取り消して組み立て直す。JSON として読めていた末尾が変わったときは false（全部読み直し）。
 */
export function feedAppended(parser, region) {
  const lines = region.split('\n');
  let at = 0;
  if (parser.tailParsed) {
    if (lines[0] !== parser.tail) return false;
    at = 1;
    if (lines.length === 1) return true;
  } else {
    parser.unfeedTail();
  }
  for (; at < lines.length - 1; at++) parser.feed(lines[at]);
  parser.feedTail(lines[lines.length - 1]);
  return true;
}

/** 上限は元ファイルのバイト数。本文は保持せず、解釈済みの行・SDK が選んだ履歴と印を残す。 */
export function createTranscriptReader({ projects, selectMessages, onUnreadable = async () => {},
  io = fs, maxBytes = TRANSCRIPT_CACHE_BYTES, maxEntries = TRANSCRIPT_CACHE_ENTRIES }) {
  const files = new Map(), recent = new Map(), pending = new Map(), busy = new Map();
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
  // 同じファイルの読みは直列にする。差分の追記状態を並行に触ると行の順が壊れる
  const enqueue = (file, work) => {
    const prev = busy.get(file) ?? Promise.resolve();
    const run = prev.then(work, work);
    const marker = run.catch(() => {});
    busy.set(file, marker);
    marker.finally(() => { if (busy.get(file) === marker) busy.delete(file); });
    return run;
  };
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
      const key = `${file}:${version}`;
      if (pending.has(key)) return await pending.get(key);
      const work = enqueue(file, async () => {
        const started = performance.now();
        const stat = await io.stat(file);
        const version = stamp(stat);
        const cached = recent.get(file);
        if (cached?.stamp === version) return cached.value;

        let parser, tracked, head;
        const delta = await readAppendedText(io, file, stat, cached);
        if (delta && feedAppended(cached.parser, delta.region)) {
          parser = cached.parser;
          tracked = trackTailAfterAppend(cached, stat.size, delta.chunk, parser.tail);
          head = cached.head;
        } else {
          // 追記ではない・途中が書き換わった・解釈済みの末尾が化けた → 全部読み直し
          discard(file);
          const text = await io.readFile(file, 'utf8');
          timing?.('transcript.read', performance.now() - started);
          const parsing = performance.now();
          parser = createSessionParser();
          for (let at = 0; at <= text.length;) {
            const end = text.indexOf('\n', at);
            if (end < 0) { parser.feedTail(text.slice(at)); break; }
            parser.feed(text.slice(at, end));
            at = end + 1;
          }
          tracked = trackTail(text, stat.size);
          head = trackHead(text);
          timing?.('transcript.extras', performance.now() - parsing);
        }
        const { entries, ...extras } = parser.finish();
        const selecting = performance.now();
        // SDK が無い場合も、圧縮の印は transcript だけで読める。失敗した履歴は保持しない。
        // 圧縮の区切りが追記されると SDK が返す履歴（圧縮前を読み飛ばす）が変わるので、差分では済ませず毎回選び直す
        const messages = await selectMessages(sessionId, entries.slice()).catch(() => null);
        timing?.('transcript.sdk', performance.now() - selecting);
        const value = { ...extras, entries: messages };
        // 読みながら追記・置換された版を次の要求へ持ち越さない。
        if (messages !== null && stamp(await io.stat(file)) === version && stat.size <= maxBytes && maxEntries > 0) {
          discard(file);
          while (recent.size && (recent.size >= maxEntries || bytes + stat.size > maxBytes)) discard(recent.keys().next().value);
          recent.set(file, { stamp: version, bytes: stat.size, size: stat.size, ino: stat.ino, dev: stat.dev,
            head, ...tracked, parser, value });
          bytes += stat.size;
        } else if (cached && cached.parser === parser) {
          // 進めた parser を記録に載せないまま残すと、次の差分の基準（tail・窓）が実態とずれる → 捨てる
          discard(file);
        }
        return value;
      });
      pending.set(key, work);
      try { return await work; } finally { pending.delete(key); }
    } catch {
      if (file) { discard(file); await onUnreadable(); }
      return null;
    }
  };
}
