// 内蔵ブラウザー（ADR 0041。ADR 0291 の 6 で無くした）の保存領域 persist:pleiad-browser を、新しい版の起動で 1 回だけ消す。
//   - Cookie・保存領域を session.clearStorageData() で消してから、userData/Partitions/pleiad-browser のフォルダーを消す
//   - 済んだら userData/browser-partition-cleared に印を書き、次の起動からは何もしない（保存領域が無かったときも印を書く）
//   - フォルダーを消せなかった（Windows で使用中など）ときは、次の起動でフォルダーだけを消し直す（session は開かない）。MAX_ATTEMPTS 回で諦めて印を書く
//   - どこで失敗しても投げない（起動を止めない）
const fs = require('node:fs');
const path = require('node:path');

const PARTITION = 'persist:pleiad-browser';
const MARKER = 'browser-partition-cleared';
const MAX_ATTEMPTS = 3;
const CLEAR_TIMEOUT_MS = 5000;

/** 印の中身。無い・読めないなら null（まだ一度も試していない） */
function readMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * userData: Electron の userData。session: Electron の session（fromPartition だけ使う）。
 * 戻り値は { state: 'done' | 'skipped' | 'retry', attempts }。試験は fs を差し替えずに一時のフォルダーで呼ぶ
 */
async function clearOldBrowserPartition({ userData, session, log = () => {}, timeoutMs = CLEAR_TIMEOUT_MS }) {
  const marker = path.join(userData, MARKER);
  const dir = path.join(userData, 'Partitions', PARTITION.slice('persist:'.length));
  const before = readMarker(marker);
  if (before?.done) return { state: 'skipped', attempts: before.attempts ?? 0 };
  const attempts = (Number.isInteger(before?.attempts) ? before.attempts : 0) + 1;
  const write = done => {
    try { fs.writeFileSync(marker, JSON.stringify({ done, attempts }), 'utf8'); } catch (error) { log(`marker could not be saved: ${error.message}`); }
  };
  if (!fs.existsSync(dir)) { write(true); return { state: 'done', attempts }; }
  // 2 回目からは session を開かない（開くと Chromium がフォルダーの中のファイルを掴み、消せなくなる）
  if (attempts === 1) {
    try {
      let timer;
      await Promise.race([
        session.fromPartition(PARTITION).clearStorageData(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
    } catch (error) { log(`clearStorageData failed: ${error?.message ?? error}`); }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) { log(`partition folder could not be removed: ${error.message}`); }
  const gone = !fs.existsSync(dir);
  if (gone || attempts >= MAX_ATTEMPTS) {
    if (!gone) log(`gave up removing the partition folder after ${attempts} attempts`);
    write(true);
    return { state: 'done', attempts };
  }
  write(false);
  return { state: 'retry', attempts };
}

module.exports = { clearOldBrowserPartition, PARTITION, MARKER, MAX_ATTEMPTS };
