// 圧縮の記録（compactions）は要約の本文が大きいので、起動の全件読みでメモリに載せず、使うときにその会話の分だけ DB から読む。
// 読み書きの振る舞い（返す値・並び・保存・同じ値は書かない・書けなければ例外で前のまま）が、メモリに載せていた頃と同じことを確かめる。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/server.mjs';

export const name = 'store-compactions';
export const title = '圧縮の記録: DB から使うときに読む（メモリに載せない）。読み書き・同じ値は書かない・失敗は前のまま・消去';

const url = file => pathToFileURL(path.join(ROOT, file)).href;
const SCRIPT = `
  const store = await import(process.env.STORE_URL);
  const { openRaw, openReadOnly, dbPath } = await import(process.env.DB_URL);
  const dir = process.env.AGENT_HOST_DATA;
  await store.setMeta('a', { title: 't' });   // DB ができてから、別の接続（読み取り専用）で中を見る
  const reader = openReadOnly(dir);
  const row = id => { const v = reader.prepare('SELECT value FROM session_fields WHERE session_id = ? AND field = ?').get(id, 'compactions')?.value; return v === undefined ? undefined : JSON.parse(v); };
  const version = () => reader.prepare('PRAGMA data_version').get().data_version;
  const j = JSON.stringify;
  const c1 = { id: 'c1', at: 100, summary: '最初の要約' };
  const c2 = { id: 'c2', at: 200, summary: '2 番目の要約' };
  const c3 = { id: 'c3', at: 300, summary: '3 番目の要約' };
  const out = {};

  out.empty = [j(await store.getCompactions('a')), j(await store.getCompactions('nobody'))];

  // 書く: 返す値は書いた値、DB に行ができ、get・getAll・peek の記録には載らない
  const saved = await store.setSessionData('a', 'compactions', [c1]);
  out.write = { returned: j(saved), db: j(row('a')), read: j(await store.getCompactions('a')),
    inGet: 'compactions' in (await store.get('a')), inAll: 'compactions' in (await store.getAll()).a, inPeek: 'compactions' in store.peek('a'),
    kept: (await store.get('a')).title };

  // 足す（読んで、末尾に足して、書く。server.mjs の圧縮の記録と同じ流れ）
  const previous = await store.getCompactions('a');
  await store.setSessionData('a', 'compactions', [...previous, c2]);
  out.append = j(await store.getCompactions('a'));

  // 返した配列を書き換えても、記録は変わらない（そのつど DB から読み直す）
  const handed = await store.getCompactions('a');
  handed.push({ id: 'junk' });
  handed[0].summary = '書き換えた';
  out.isolated = j(await store.getCompactions('a'));

  // 同じ値は書き直さない（別の接続から見た DB の版が動かない）
  const before = version();
  await store.setSessionData('a', 'compactions', [c1, c2]);
  out.same = version() === before;

  // 巻き戻しで古い記録を落とす（id で絞って置き換える）
  await store.setSessionData('a', 'compactions', (await store.getCompactions('a')).filter(c => c.at > 100));
  out.prune = [j(await store.getCompactions('a')), j(row('a'))];

  // ほかの項目・メタの書き込みは、compactions の行に触れない
  await store.setMeta('a', { title: 'u' });
  await store.setSessionData('a', 'outbox', [{ id: 'm1' }]);
  await store.setMode('a', 'plan');
  out.others = [j(await store.getCompactions('a')), j(row('a')), (await store.get('a')).title];

  // 作り直しても同じ（メモリを捨てて DB から読み直す）。起動の読み込みに compactions は載らない
  store.closeStore();
  out.reload = { read: j(await store.getCompactions('a')), inGet: 'compactions' in (await store.get('a')), title: (await store.get('a')).title, mode: (await store.get('a')).mode };

  // 会話が無いうちに書くと、会話が作られる（history は空、compactions は記録に載らない）
  const fresh = await store.setSessionData('fresh', 'compactions', [c3]);
  out.fresh = { returned: j(fresh), read: j(await store.getCompactions('fresh')), db: j(row('fresh')),
    entry: j({ ...(await store.get('fresh')) }), memory: 'compactions' in store.peek('fresh') };

  // 書けないとき（別の接続が書き込みのロックを持つ）: 例外で、DB もそのつど読む値も前のまま。同じ値なら書かないので通る
  const blocker = openRaw(dbPath(dir));
  blocker.exec('BEGIN IMMEDIATE');
  const failedWrite = await store.setSessionData('a', 'compactions', [c3]).then(() => null, e => e.message);
  const failedNew = await store.setSessionData('another', 'compactions', [c1]).then(() => null, e => e.message);
  const sameUnderLock = await store.setSessionData('a', 'compactions', [c2]).then(() => 'ok', e => e.message);
  out.locked = { failedWrite: failedWrite !== null, failedNew: failedNew !== null, sameUnderLock, read: j(await store.getCompactions('a')), anotherRead: j(await store.getCompactions('another')),
    anotherInMemory: store.peek('another') !== null };
  blocker.exec('ROLLBACK');
  blocker.close();
  out.afterLock = [j(row('a')), row('another') === undefined];
  await store.setSessionData('a', 'compactions', [c3]);
  out.retry = [j(await store.getCompactions('a')), j(row('a'))];

  // undefined は消す。消せば [] に戻る
  await store.setSessionData('a', 'compactions', undefined);
  out.cleared = [j(await store.getCompactions('a')), row('a') === undefined, (await store.get('a')).title];

  // 会話を消せば compactions の行も消える（作り直した会話に前の記録が残らない）
  await store.removeSession('fresh');
  out.removed = [j(await store.getCompactions('fresh')), row('fresh') === undefined];
  await store.setMeta('fresh', { title: 'again' });
  out.recreated = j(await store.getCompactions('fresh'));

  // 値が null・形が崩れていても、そのまま返す（?? [] は undefined と null だけを置き換える）
  await store.setSessionData('a', 'compactions', 'broken');
  out.odd = j(await store.getCompactions('a'));
  console.log(j(out));
`;

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-store-compactions-'));
  try {
    const result = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', SCRIPT], {
      env: { ...process.env, AGENT_HOST_DATA: dir, STORE_URL: url('core/store.mjs'), DB_URL: url('core/db.mjs') }, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop()))));
    const c1 = { id: 'c1', at: 100, summary: '最初の要約' }, c2 = { id: 'c2', at: 200, summary: '2 番目の要約' }, c3 = { id: 'c3', at: 300, summary: '3 番目の要約' };
    const j = JSON.stringify;

    t.ok('記録が無い会話・無い会話 ID は [] を返す', j(result.empty) === j(['[]', '[]']), j(result.empty));
    t.ok('書くと、書いた値を返し、DB に行ができて、読むと同じ値が返る', result.write.returned === j([c1]) && result.write.db === j([c1]) && result.write.read === j([c1]), j(result.write));
    t.ok('メモリの記録（get・getAll・peek）には載らない。ほかの項目は残る', !result.write.inGet && !result.write.inAll && !result.write.inPeek && result.write.kept === 't', j(result.write));
    t.ok('読んで足して書く流れで、並びのとおりに残る', result.append === j([c1, c2]), result.append);
    t.ok('返した配列を書き換えても、記録は変わらない', result.isolated === j([c1, c2]), result.isolated);
    t.ok('同じ値の setSessionData は DB を書き直さない', result.same === true);
    t.ok('置き換えると、読む値も DB も新しい並びになる', j(result.prune) === j([j([c2]), j([c2])]), j(result.prune));
    t.ok('ほかの項目・メタの書き込みは compactions に触れない', j(result.others) === j([j([c2]), j([c2]), 'u']), j(result.others));
    t.ok('メモリを捨てて読み直しても同じ。起動の記録に compactions は載らない', result.reload.read === j([c2]) && !result.reload.inGet && result.reload.title === 'u' && result.reload.mode === 'plan', j(result.reload));
    t.ok('会話が無いうちに書くと会話ができる（history は空・compactions は記録に載らない）', result.fresh.returned === j([c3]) && result.fresh.read === j([c3]) && result.fresh.db === j([c3])
      && result.fresh.entry === j({ history: [] }) && result.fresh.memory === false, j(result.fresh));
    t.ok('書けないとき（ロック）は例外で、DB も読む値も前のまま。新しい会話も作らない', result.locked.failedWrite && result.locked.failedNew && result.locked.read === j([c2])
      && result.locked.anotherRead === '[]' && result.locked.anotherInMemory === false && result.afterLock[0] === j([c2]) && result.afterLock[1] === true, j(result.locked));
    t.ok('同じ値は書かないので、ロック中でも通る', result.locked.sameUnderLock === 'ok', j(result.locked));
    t.ok('ロックを手放せば同じ呼び出しが通る', j(result.retry) === j([j([c3]), j([c3])]), j(result.retry));
    t.ok('undefined で消せて、消せば [] に戻る。ほかの項目は残る', j(result.cleared) === j(['[]', true, 'u']), j(result.cleared));
    t.ok('会話を消すと compactions の行も消え、作り直した会話に残らない', j(result.removed) === j(['[]', true]) && result.recreated === '[]', j(result.removed));
    t.ok('配列でない値も、書いたまま返す', result.odd === j('broken'), result.odd);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
