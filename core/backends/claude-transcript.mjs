// 同じ版の transcript を getMessages / getCompactions / outline / older で共有する。
// 追記しかない版は、前回の末尾の窓を照合してから差分だけを読み、増えた行だけを解釈する（ADR 0330）。
// 保持するのは解釈済みの行の「蒸留」形（claude-normalize.mjs。大きい行はバイト位置と選別に要る
// フィールドだけ）で、返す履歴は蒸留した message を行から読み直して戻す。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionParser } from './claude-normalize.mjs';

export const TRANSCRIPT_CACHE_BYTES = 320 * 1024 * 1024;
export const TRANSCRIPT_CACHE_ENTRIES = 4;
// 追記かどうかの照合に使う窓: 先頭と末尾（書きかけの行を含む末尾）のバイト数
const APPEND_WINDOW = 4096;
const stamp = s => `${s.mtimeMs}:${s.size}:${s.ctimeMs}:${s.ino}:${s.dev}`;

/**
 * 前回の記録（size・ino・dev・window・head）と今の stat を突き合わせ、
 * 「同じファイルが末尾にだけ書き足された」と分かるときだけ前回の末尾の窓＋追加分のバイト列を返す。
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
    return { chunk };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 全部読みの結果（ファイル全体の Buffer）から、次の追記読みに使う記録を作る。
 * tail は書きかけの末尾の行（'' = 改行で終わっている）。window は tail を含む末尾の窓。
 * subarray は本体を掴むので Buffer.from で写して持つ。
 */
export function trackTail(buf) {
  const nl = buf.lastIndexOf(0x0a);
  const tailStart = nl < 0 ? 0 : nl + 1;
  const windowStart = Math.max(0, tailStart - APPEND_WINDOW);
  return { tail: buf.toString('utf8', tailStart), tailStart,
    windowStart, window: Buffer.from(buf.subarray(windowStart)) };
}

/** 先頭の照合窓。 */
export function trackHead(buf) {
  return buf.length ? Buffer.from(buf.subarray(0, APPEND_WINDOW)) : null;
}

/** 追記読みのあとの記録を、読んだ chunk（前回の windowStart から末尾）から作る。 */
export function trackTailAfterAppend(prev, size, chunk, tail) {
  const tailStart = size - Buffer.byteLength(tail, 'utf8');
  const windowStart = Math.max(0, tailStart - APPEND_WINDOW);
  return { tail, tailStart, windowStart, window: Buffer.from(chunk.subarray(windowStart - prev.windowStart)) };
}

/**
 * 追記分（ファイルの offset = 前回の tailStart から末尾までのバイト列。旧 tail + 追加分）を parser へ流す。
 * 行にできなかった末尾を取り消して組み立て直す。JSON として読めていた末尾が変わったときは false（全部読み直し）。
 */
export function feedAppended(parser, bytes, offset) {
  let at = 0;
  if (parser.tailParsed) {
    const nl = bytes.indexOf(0x0a);
    const first = nl < 0 ? bytes.toString('utf8') : bytes.toString('utf8', 0, nl);
    if (first !== parser.tail) return false;
    if (nl < 0) return true;   // 実質到達不能（追記バイトが無いと size は増えない）
    at = nl + 1;
  } else {
    parser.unfeedTail();
  }
  for (;;) {
    const nl = bytes.indexOf(0x0a, at);
    if (nl < 0) { parser.feedTail(bytes.toString('utf8', at), offset + at, bytes.length - at); return true; }
    parser.feed(bytes.toString('utf8', at, nl), offset + at, nl - at);
    at = nl + 1;
  }
}

/**
 * selectMessages（SDK）が蒸留した message をそのまま返してきた分を、行のバイト位置から読み直して
 * 本物の message に戻す。戻した行のバイト数を返し、読めない・別の版に差し替わったときは -1
 * （呼び出し側はこの版をキャッシュせず、必要なら全部読み直す）。
 */
export async function hydrateSlim(io, file, messages, slimIndex) {
  if (!slimIndex?.size || !Array.isArray(messages)) return 0;
  const need = [];
  for (const m of messages) {
    const pos = slimIndex.get(m?.message);
    if (pos) need.push([m, pos]);
  }
  if (!need.length) return 0;
  if (typeof io.open !== 'function') return -1;
  let handle;
  try { handle = await io.open(file, 'r'); } catch { return -1; }
  try {
    let bytes = 0;
    for (const [m, pos] of need) {
      const buf = Buffer.alloc(pos.len);
      const got = await handle.read(buf, 0, pos.len, pos.offset);
      if (got.bytesRead !== pos.len) return -1;
      let row;
      try { row = JSON.parse(buf.toString('utf8')); } catch { return -1; }
      if (row?.uuid !== m.uuid || typeof row?.message !== 'object' || row.message === null) return -1;
      m.message = row.message;
      bytes += pos.len;
    }
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** キャッシュする上限は「保持するメモリ」（蒸留した行＋戻した message の見積もりバイト数）。本文は保持しない。 */
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
        if (delta && feedAppended(cached.parser,
            delta.chunk.subarray(cached.tailStart - cached.windowStart), cached.tailStart)) {
          parser = cached.parser;
          tracked = trackTailAfterAppend(cached, stat.size, delta.chunk, parser.tail);
          head = cached.head;
        } else {
          // 追記ではない・途中が書き換わった・解釈済みの末尾が化けた → 全部読み直し
          discard(file);
          const buf = await io.readFile(file);
          timing?.('transcript.read', performance.now() - started);
          const parsing = performance.now();
          parser = createSessionParser();
          for (let at = 0; at <= buf.length;) {
            const end = buf.indexOf(0x0a, at);
            if (end < 0) { parser.feedTail(buf.toString('utf8', at), at, buf.length - at); break; }
            parser.feed(buf.toString('utf8', at, end), at, end - at);
            at = end + 1;
          }
          tracked = trackTail(buf);
          head = trackHead(buf);
          timing?.('transcript.extras', performance.now() - parsing);
        }
        const { entries, ...extras } = parser.finish();
        const selecting = performance.now();
        // SDK が無い場合も、圧縮の印は transcript だけで読める。失敗した履歴は保持しない。
        // 圧縮の区切りが追記されると SDK が返す履歴（圧縮前を読み飛ばす）が変わるので、差分では済ませず毎回選び直す
        const messages = await selectMessages(sessionId, entries.slice()).catch(() => null);
        timing?.('transcript.sdk', performance.now() - selecting);
        const hydrating = performance.now();
        const hydrated = messages === null ? 0 : await hydrateSlim(io, file, messages, parser.slimIndex);
        timing?.('transcript.hydrate', performance.now() - hydrating);
        if (hydrated < 0) { discard(file); return null; }   // 読み直し中に差し替わった → 読めなかった扱い
        const value = { ...extras, entries: messages };
        // 読みながら追記・置換された版を次の要求へ持ち越さない。
        // 保持量の見積もり: 蒸留した行（kept）＋読み直して戻した message のバイト数
        const est = parser.kept + hydrated;
        if (messages !== null && stamp(await io.stat(file)) === version && est <= maxBytes && maxEntries > 0) {
          discard(file);
          while (recent.size && (recent.size >= maxEntries || bytes + est > maxBytes)) discard(recent.keys().next().value);
          recent.set(file, { stamp: version, bytes: est, size: stat.size, ino: stat.ino, dev: stat.dev,
            head, ...tracked, parser, value });
          bytes += est;
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
