import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createDb, dbPath, openReadOnly, memoryStateTable } from '../../core/db.mjs';
import { ensureDataSchemaSync, DATA_SCHEMA } from '../../core/data-schema.mjs';
import { createMemoryStore } from '../../core/memory/store.mjs';

export const name = 'bot-delete-migration';
export const title = '記憶履歴の形式移行: 写し・照合・中断再開・旧版拒否';
const rows = [
  { rev: 1, op: 'add', layer: 'user', id: 'm_user', text: 'common', by: { kind: 'human' } },
  { rev: 4, op: 'add', layer: 'b_other', id: 'm_other', text: 'other', by: { kind: 'human' } },
  { rev: 7, op: 'forget', layer: 'b_deleted', id: 'm_private', text: 'private', fp: 'private', entry: { id: 'm_private', layer: 'b_deleted', text: 'private' } },
];
export default async function(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-delete-migration-'));
  const seed = async name => {
    const dir = path.join(root, name); await fs.mkdir(path.join(dir, 'memory'), { recursive: true });
    const db = createDb(dbPath(dir)); memoryStateTable(db).save([['meta', 'lastRunAt', 99]]); db.close();
    await fs.writeFile(path.join(dir, 'data-schema.json'), '{"schema":2}\n');
    await fs.writeFile(path.join(dir, 'memory/log.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return dir;
  };
  const schema = async dir => JSON.parse(await fs.readFile(path.join(dir, 'data-schema.json'), 'utf8')).schema;
  const history = dir => { const db = openReadOnly(dir); try { return memoryStateTable(db).ofKind('memory.log'); } finally { db.close(); } };
  try {
    const dir = await seed('success');
    const rollback = path.join(root, 'rollback'); await fs.cp(dir, rollback, { recursive: true });
    // 起動検査の対応形式を旧版と同じ2に固定して、同じ入口が書き込み前に拒否することを確認する。
    const source = (await fs.readFile(new URL('../../core/data-schema.mjs', import.meta.url), 'utf8'))
      .replace('export const DATA_SCHEMA = 3;', 'export const DATA_SCHEMA = 2;')
      .replace(/from '(\.\/[^']+)'/g, (_all, relative) => `from '${new URL(relative, new URL('../../core/data-schema.mjs', import.meta.url)).href}'`);
    // 一時のファイルから読む。data: URL だと、エラーの見出しと stack の行ごとに URL（約 8 KB）が載り、macOS のパイプへの
    // stderr は非同期なので、子は 8192 バイトを書いたところで終わる（後ろの拒否の文が届かない）
    const oldModule = path.join(root, 'data-schema-v2.mjs');
    await fs.writeFile(oldModule, source);
    const oldStart = target => spawnSync(process.execPath, ['--input-type=module', '-e', `const {ensureDataSchemaSync}=await import(${JSON.stringify(pathToFileURL(oldModule).href)});ensureDataSchemaSync(${JSON.stringify(target)});`], { encoding: 'utf8' });
    const before = await fs.readFile(path.join(dir, 'memory/log.jsonl'));
    const result = ensureDataSchemaSync(dir);
    t.ok('写しの履歴は元とバイト一致し、形式2の番号とDBも退避', (await fs.readFile(path.join(result.backup, 'memory/log.jsonl'))).equals(before)
      && await schema(result.backup) === 2 && (await fs.stat(path.join(result.backup, 'pleiad.db'))).size > 0);
    t.ok('共通・他bot・忘れた記憶の履歴と欠番を含むrevを保持', JSON.stringify(Object.values(history(dir))) === JSON.stringify(rows) && await schema(dir) === DATA_SCHEMA);
    const db = openReadOnly(dir); t.ok('既存の整理進捗は保持', memoryStateTable(db).get('meta', 'lastRunAt') === 99); db.close();
    const memory = createMemoryStore({ dir: path.join(dir, 'memory') });
    // 履歴だけのfixtureなので syncせず、revは初回の読み込み後に検査。
    await memory.purgeLayer('b_deleted');
    t.ok('移行後の専用履歴だけを削除しrevを単調増加', memory.rev() === 8 && memory.recordsSince(0).filter(r => r.op !== 'purge').length === 2 && !JSON.stringify(memory.recordsSince(0)).includes('private'));
    memory.close();
    const old = oldStart(dir);
    t.ok('形式2までの起動入口は更新済みデータを拒否', old.status !== 0 && /別の形式|different format/.test(old.stderr) && await schema(dir) === DATA_SCHEMA);
    t.ok('全体の退避を戻せば形式2の起動検査を通り元の履歴が読める', oldStart(rollback).status === 0 && (await fs.readFile(path.join(rollback, 'memory/log.jsonl'))).equals(before));

    for (const mismatch of [false, true]) {
      const failed = await seed(mismatch ? 'mismatch' : 'failure');
      let error;
      try { ensureDataSchemaSync(failed, { afterMemoryImport: db => { if (mismatch) db.exec("DELETE FROM memory_state WHERE kind='memory.log' AND id='4'"); else throw new Error('injected failure'); } }); } catch (e) { error = e; }
      t.ok(`${mismatch ? '照合不一致' : '保存失敗'}では番号と元の履歴を変えない`, !!error && await schema(failed) === 2 && (await fs.readFile(path.join(failed, 'memory/log.jsonl'))).equals(before) && Object.keys(history(failed)).length === 0);
      ensureDataSchemaSync(failed);
      t.ok('原因解消後は再移行できる', await schema(failed) === DATA_SCHEMA && Object.keys(history(failed)).length === 3);
    }
    const interrupted = await seed('interrupted');
    try { ensureDataSchemaSync(interrupted, { afterMemoryCommit: () => { throw new Error('interrupted before version'); } }); } catch {}
    const extra = { rev: 8, op: 'add', layer: 'user', id: 'm_later', text: 'old app append' };
    await fs.appendFile(path.join(interrupted, 'memory/log.jsonl'), JSON.stringify(extra) + '\n');
    t.ok('番号更新前の中断では旧版用の原本が残る', await schema(interrupted) === 2);
    ensureDataSchemaSync(interrupted);
    t.ok('中断後に旧版が追記した履歴も再開時に取り込む', history(interrupted)['8']?.text === extra.text && await schema(interrupted) === DATA_SCHEMA);

    const cleanup = await seed('cleanup');
    try { ensureDataSchemaSync(cleanup, { remove: () => { throw new Error('locked'); } }); } catch {}
    const reopened = createMemoryStore({ dir: path.join(cleanup, 'memory') });
    await reopened.purgeLayer('b_deleted'); reopened.close();
    t.ok('番号更新後の旧ログ削除中断から再開できる', await schema(cleanup) === DATA_SCHEMA && !await fs.access(path.join(cleanup, 'memory/log.jsonl')).then(() => true, () => false));
    const changed = await seed('unexpected-log');
    try { ensureDataSchemaSync(changed, { remove: () => { throw new Error('locked'); } }); } catch {}
    await fs.appendFile(path.join(changed, 'memory/log.jsonl'), JSON.stringify(extra) + '\n');
    const refused = createMemoryStore({ dir: path.join(changed, 'memory') });
    let error; try { await refused.init(); } catch (e) { error = e; } finally { refused.close(); }
    t.ok('番号更新後に別内容が追記された旧ログは黙って消さず停止', !!error && (await fs.readFile(path.join(changed, 'memory/log.jsonl'), 'utf8')).includes(extra.text));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
