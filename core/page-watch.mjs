// 画面に開かれているファイル・フォルダーの変化を追う（page:changed。ADR 0295 の 6）。
//   - 開くとき（pageOpen・ファイルのページの api/preview・api/html-key）に登録する。開いた数だけ簿に残る（上限あり）
//   - fs.watch はフォルダー単位に張る（Windows の watch は直下の子だけ分かる）。ファイルは中身の名前で照合し、
//     フォルダー（dir の印）は直下の子のどれかが変われば知らせる。書き換え・名前の替え・消去のどれも拾う
//   - 同じファイルへの連続の書き込みは 250ms でまとめてから知らせる（AI の一括の書き換えで何度も読み直さない）
//   - 変化の事実とパスだけを知らせる（中身・差分は送らない。読み直すか・「更新を表示」を出すかは画面が決める）
import fs from 'node:fs';
import path from 'node:path';

const MAX_WATCHED_DIRS = 150;
const MAX_TRACKED = 600;
const DEBOUNCE_MS = 250;

/** パスの照合の形。Windows は大小文字を見ない。区切りは / に揃える */
const norm = value => {
  const p = String(value ?? '').replaceAll('\\', '/');
  return process.platform === 'win32' ? p.toLowerCase() : p;
};

/**
 * @param {object} [deps]
 * @param [deps.watch] (dir, listener) => { close }。fs.watch と同じ形（試験で差し替える）
 * @param [deps.emit]  (sessionId, filePath) => 変化を知らせる口（browser-unify-ws.mjs が page:changed にして流す）
 * @param [deps.debounceMs] まとめる幅（試験用）
 */
export function createPageWatch({ watch = (dir, listener) => fs.watch(dir, listener), emit = () => {}, debounceMs = DEBOUNCE_MS } = {}) {
  // dirKey（張ったフォルダー）-> { watcher, targets: Map<targetKey, { path, sessions:Set, dir }> }
  const watched = new Map();
  const pending = new Map();   // targetKey -> timer
  let tracked = 0;

  function fire(dirKey, targetKey) {
    const entry = watched.get(dirKey)?.targets.get(targetKey);
    if (entry) for (const sessionId of entry.sessions) emit(sessionId, entry.path);
  }

  function onEvent(dirKey, _type, name) {
    const dir = watched.get(dirKey);
    if (!dir) return;
    const base = norm(String(name ?? ''));
    for (const [targetKey, entry] of dir.targets) {
      // フォルダーの見張りは直下の子のどれでも。ファイルは名前が一致したものだけ
      if (!entry.dir && path.basename(targetKey) !== base) continue;
      if (pending.has(targetKey)) continue;
      const timer = setTimeout(() => { pending.delete(targetKey); fire(dirKey, targetKey); }, debounceMs);
      timer.unref?.();
      pending.set(targetKey, timer);
    }
  }

  function ensure(dirPath) {
    const dirKey = norm(dirPath);
    const held = watched.get(dirKey);
    if (held) return held;
    let watcher = null;
    try { watcher = watch(dirPath, (type, name) => onEvent(dirKey, type, name)); }
    catch { return null; }
    if (watched.size >= MAX_WATCHED_DIRS) drop(watched.keys().next().value);
    const entry = { watcher, targets: new Map() };
    watched.set(dirKey, entry);
    return entry;
  }

  function drop(dirKey) {
    const held = watched.get(dirKey);
    if (!held) return;
    try { held.watcher?.close?.(); } catch {}
    for (const targetKey of held.targets.keys()) {
      const timer = pending.get(targetKey);
      if (timer) { clearTimeout(timer); pending.delete(targetKey); }
    }
    tracked -= held.targets.size;
    watched.delete(dirKey);
  }

  function prune(dirKey, targetKey) {
    const dir = watched.get(dirKey);
    const entry = dir?.targets.get(targetKey);
    if (entry && !entry.sessions.size) { dir.targets.delete(targetKey); tracked--; }
    if (dir && !dir.targets.size) drop(dirKey);
  }

  return {
    /** @param {'file'|'dir'} kind 'dir' なら対象のフォルダーの直下の子の変化を知らせる */
    add(sessionId, filePath, kind = 'file') {
      if (typeof sessionId !== 'string' || !sessionId || typeof filePath !== 'string' || !filePath) return;
      const isDir = kind === 'dir';
      const dirPath = isDir ? filePath : path.dirname(filePath);
      const dir = ensure(dirPath);
      if (!dir) return;
      const targetKey = isDir ? `${norm(dirPath)}\u0000dir` : norm(filePath);
      let entry = dir.targets.get(targetKey);
      if (!entry) {
        if (tracked >= MAX_TRACKED) return;
        entry = { path: filePath, sessions: new Set(), dir: isDir };
        dir.targets.set(targetKey, entry);
        tracked++;
      }
      entry.sessions.add(sessionId);
    },
    remove(sessionId, filePath, kind = 'file') {
      const dirKey = norm(kind === 'dir' ? filePath : path.dirname(filePath));
      const targetKey = kind === 'dir' ? `${norm(filePath)}\u0000dir` : norm(filePath);
      watched.get(dirKey)?.targets.get(targetKey)?.sessions.delete(sessionId);
      prune(dirKey, targetKey);
    },
    /** その会話ぶんを全部消す（タブを閉じたとき・会話の終わり） */
    removeSession(sessionId) {
      for (const [dirKey, dir] of watched) for (const [targetKey, entry] of dir.targets) {
        entry.sessions.delete(sessionId);
        prune(dirKey, targetKey);
      }
    },
    close() { for (const key of [...watched.keys()]) drop(key); },
    stats() { return { dirs: watched.size, targets: tracked }; },
  };
}
