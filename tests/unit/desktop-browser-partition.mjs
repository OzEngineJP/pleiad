// 前の版の内蔵ブラウザーの保存領域の掃除（desktop/browser-partition-cleanup.cjs。ADR 0291 の 6）。
// 一時の userData に前の版の Partitions/pleiad-browser を作り、偽の session で起動を何回か繰り返す
//   - 1 回目: session を開かずにフォルダーを消し、印を書く。2 回目からは何もしない
//   - 保存領域が無い（新しく入れた）: 印だけ書く
//   - フォルダーを消せない: 1 回目だけ clearStorageData で中身を消し、次の起動でフォルダーだけを消し直す（session は開かない）。MAX_ATTEMPTS 回で諦めて印を書く
//   - clearStorageData の失敗・固まり: 投げない
//   - 印を書けない: 投げない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const realFs = require('node:fs');
const { clearOldBrowserPartition, PARTITION, MARKER, MAX_ATTEMPTS } = require('../../desktop/browser-partition-cleanup.cjs');

export const name = 'desktop-browser-partition';
export const title = '前の版の内蔵ブラウザーの保存領域を 1 回だけ消す: 印・2 回目は何もしない・失敗しても起動を止めない・消せないときは消し直す';

/** 前の版の userData（内蔵ブラウザーの Cookie と保存領域のファイルがある） */
function oldUserData() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-partition-'));
  const dir = path.join(userData, 'Partitions', 'pleiad-browser');
  fs.mkdirSync(path.join(dir, 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cookies'), 'cookie');
  fs.writeFileSync(path.join(dir, 'Local Storage', 'leveldb', '000003.log'), 'storage');
  // ほかの保存領域（Chrome の操作の窓など）は触らない
  fs.mkdirSync(path.join(userData, 'Partitions', 'other'), { recursive: true });
  return { userData, dir };
}

/** 偽の electron.session。fromPartition の呼び出しと clearStorageData の回数を数える */
function fakeSession(clear = async () => {}) {
  const calls = { partitions: [], clears: 0 };
  return { calls, fromPartition: name => { calls.partitions.push(name); return { clearStorageData: async () => { calls.clears++; return clear(); } }; } };
}

const marker = userData => JSON.parse(fs.readFileSync(path.join(userData, MARKER), 'utf8'));

export default async function (t) {
  {
    const { userData, dir } = oldUserData();
    const session = fakeSession();
    const first = await clearOldBrowserPartition({ userData, session });
    t.ok('1 回目: session を開かずにフォルダーを消す（開くと Windows ではファイルを掴まれて消せない）', first.state === 'done' && session.calls.partitions.length === 0 && !fs.existsSync(dir), JSON.stringify(first));
    t.ok('1 回目: ほかの保存領域は残す', fs.existsSync(path.join(userData, 'Partitions', 'other')));
    t.ok('1 回目: 済んだ印を userData に書く', marker(userData).done === true);
    const second = await clearOldBrowserPartition({ userData, session });
    t.ok('2 回目: 何もしない', second.state === 'skipped' && session.calls.partitions.length === 0, JSON.stringify(second));
    // 印のあとで同じ名前のフォルダーができても（前の版へ戻して起動した）、消さない
    fs.mkdirSync(dir, { recursive: true });
    const third = await clearOldBrowserPartition({ userData, session });
    t.ok('印があれば、後でできたフォルダーにも触らない', third.state === 'skipped' && fs.existsSync(dir));
    fs.rmSync(userData, { recursive: true, force: true });
  }
  {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-partition-'));
    const session = fakeSession();
    const result = await clearOldBrowserPartition({ userData, session });
    t.ok('保存領域が無い（新しく入れた）: session を開かず、印だけ書く', result.state === 'done' && session.calls.partitions.length === 0 && marker(userData).done === true);
    fs.rmSync(userData, { recursive: true, force: true });
  }
  {
    // clearStorageData はフォルダーを消せなかったときだけ呼ぶので、rmSync を差し替えて消せなくする
    const { userData } = oldUserData();
    const logs = [];
    const rmSync = realFs.rmSync;
    realFs.rmSync = () => { throw new Error('EBUSY'); };
    let failed, hung, started;
    try {
      failed = await clearOldBrowserPartition({ userData, session: fakeSession(async () => { throw new Error('boom'); }), log: line => logs.push(line) });
      fs.unlinkSync(path.join(userData, MARKER));
      started = Date.now();
      hung = await clearOldBrowserPartition({ userData, session: fakeSession(() => new Promise(() => {})), log: line => logs.push(line), timeoutMs: 50 });
    } finally { realFs.rmSync = rmSync; }
    t.ok('clearStorageData が失敗しても投げず、消し直しの印を書く', failed.state === 'retry' && logs.some(line => line.includes('boom')), logs.join(' | '));
    t.ok('clearStorageData が返らなくても、時間で切って起動を続ける', hung.state === 'retry' && Date.now() - started < 2000 && logs.some(line => line.includes('timed out')), logs.join(' | '));
    fs.rmSync(userData, { recursive: true, force: true });
  }
  {
    // Windows で使用中のファイルがあって消せない、を rmSync の差し替えで作る
    const { userData, dir } = oldUserData();
    const session = fakeSession();
    const logs = [];
    const rmSync = realFs.rmSync;
    realFs.rmSync = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
    let results = [];
    try {
      for (let i = 0; i < MAX_ATTEMPTS - 1; i++) results.push(await clearOldBrowserPartition({ userData, session, log: line => logs.push(line) }));
    } finally { realFs.rmSync = rmSync; }
    t.ok('消せない: 投げずに消し直しの印（done: false）を書く', results.every(r => r.state === 'retry') && marker(userData).done === false && marker(userData).attempts === MAX_ATTEMPTS - 1 && logs.some(line => line.includes('EBUSY')), JSON.stringify(results));
    t.ok('消せなかった 1 回目だけ clearStorageData で中身を消し、消し直しでは session を開かない', session.calls.partitions.join() === PARTITION && session.calls.clears === 1);
    const retried = await clearOldBrowserPartition({ userData, session });
    t.ok('消し直しの起動で消せれば、済んだ印にする', retried.state === 'done' && !fs.existsSync(dir) && marker(userData).done === true && session.calls.clears === 1, JSON.stringify(retried));
    fs.rmSync(userData, { recursive: true, force: true });
  }
  {
    const { userData, dir } = oldUserData();
    const logs = [];
    const rmSync = realFs.rmSync;
    realFs.rmSync = () => { throw new Error('EPERM'); };
    let results = [];
    try {
      for (let i = 0; i < MAX_ATTEMPTS + 1; i++) results.push(await clearOldBrowserPartition({ userData, session: fakeSession(), log: line => logs.push(line) }));
    } finally { realFs.rmSync = rmSync; }
    t.ok(`${MAX_ATTEMPTS} 回消せなければ諦めて済んだ印を書き、それからは何もしない`, results[MAX_ATTEMPTS - 1].state === 'done' && results[MAX_ATTEMPTS].state === 'skipped' && fs.existsSync(dir) && logs.some(line => line.includes('gave up')), JSON.stringify(results));
    fs.rmSync(userData, { recursive: true, force: true });
  }
  {
    // 印を書けない（userData が読み取り専用など）を writeFileSync の差し替えで作る
    const { userData } = oldUserData();
    const logs = [];
    const writeFileSync = realFs.writeFileSync;
    realFs.writeFileSync = () => { throw new Error('EACCES'); };
    let result;
    try { result = await clearOldBrowserPartition({ userData, session: fakeSession(), log: line => logs.push(line) }); } finally { realFs.writeFileSync = writeFileSync; }
    t.ok('印を書けなくても投げない（ログに残す）', result?.state === 'done' && logs.some(line => line.includes('marker could not be saved')), logs.join(' | '));
    fs.rmSync(userData, { recursive: true, force: true });
  }
  {
    const logs = [];
    const result = await clearOldBrowserPartition({ userData: path.join(os.tmpdir(), 'ply-partition-missing', 'x'), session: { fromPartition: () => { throw new Error('no session'); } }, log: line => logs.push(line) });
    t.ok('userData が無くても投げない', ['done', 'retry'].includes(result.state));
    // 印の中身が壊れていたら、まだ試していない扱い
    const { userData, dir } = oldUserData();
    fs.writeFileSync(path.join(userData, MARKER), '{broken');
    const again = await clearOldBrowserPartition({ userData, session: fakeSession() });
    t.ok('壊れた印は、まだ試していない扱いで消しに行く', again.state === 'done' && !fs.existsSync(dir));
    fs.rmSync(userData, { recursive: true, force: true });
  }
}
