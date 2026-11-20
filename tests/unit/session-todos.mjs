// 会話の ToDo（ADR 0342）: 足す・変える・消す・並べ替え・ref で枝分かれを 1 回で作る・輪を断る・ifRev の競合・待ち・リンクの整え方と有無の確かめ・
// 変更の知らせ（onChange）・再び開いても残る・会話を消すと消える・操作（todos.*）の AI と画面の扱い・形式 3 → 4 の移行（写し・失敗で番号を変えない・旧版の拒否）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createTodos, normalizeLink, cycleIn, waitingOf, TodoError } from '../../core/todos.mjs';
import { createDb, dbPath, sessionTable, todoTable } from '../../core/db.mjs';
import { openData, ensureDataSchemaSync, DATA_SCHEMA } from '../../core/data-schema.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'session-todos';
export const title = '会話の ToDo: 足す・変える・消す・並べ替え・ref・輪の拒否・ifRev・待ち・リンク・知らせ・会話の削除で消える・todos.* の操作・形式 3 → 4 の移行';

const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return e instanceof TodoError && e.code === code; } };

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-todos-'));
  const dir = path.join(root, 'data');
  await fs.mkdir(dir);
  let clock = 1_800_000_000_000;
  const events = [];
  const store = createTodos({ dataDir: dir, now: () => clock++, onChange: e => events.push(e) });
  const s1 = { kind: 'session', id: 's1' };
  const user = { kind: 'user' };
  const claude = { kind: 'agent', backend: 'claude' };
  try {
    // ---- 空・足す
    t.ok('空の会話は rev 0・項目なし', JSON.stringify(store.list(s1)) === JSON.stringify({ rev: 0, items: [] }));
    const a = store.add(s1, { entries: [{ text: '  調べる  ' }, { text: '直す', status: 'doing' }], by: user });
    const [i1, i2] = a.items;
    t.ok('足すと rev 1・並び 1, 2・本文の空白を詰める・既定は未着手', a.rev === 1 && i1.order === 1 && i2.order === 2 && i1.text === '調べる' && i1.status === 'todo' && i2.status === 'doing' && /^todo_[0-9a-z]{15}$/.test(i1.id));
    t.ok('足した人が by・updatedBy に残る', i1.by?.kind === 'user' && i1.updatedBy?.kind === 'user' && typeof i1.createdAt === 'number');
    t.ok('知らせは scope・rev・items（全部）・changed（added）・by', events.length === 1 && events[0].scope.id === 's1' && events[0].rev === 1 && events[0].items.length === 2
      && events[0].changed.map(c => c.action).join() === 'added,added' && events[0].by === user);

    // ---- ref で枝分かれ・合流を 1 回で
    const b = store.add(s1, { entries: [{ text: '画面', ref: 'ui', after: [i1.id] }, { text: '保存', ref: 'db', after: [i1.id] }, { text: '試験', after: ['ui', 'db'] }], by: claude });
    const [ui, db, test] = b.items.slice(2);
    t.ok('ref は同じ呼び出しの after から指せる（保存は本当の id）', JSON.stringify(test.after) === JSON.stringify([ui.id, db.id]) && ui.after[0] === i1.id);
    t.ok('先の項目が終わっていない未着手は waiting', ui.waiting && db.waiting && test.waiting && !i1.waiting);
    t.ok('知らないid・ref は NOT_FOUND', throwsCode(() => store.add(s1, { entries: [{ text: 'x', after: ['nope'] }], by: user }), 'NOT_FOUND'));
    t.ok('ref の重複は INVALID', throwsCode(() => store.add(s1, { entries: [{ text: 'x', ref: 'r' }, { text: 'y', ref: 'r' }], by: user }), 'INVALID'));
    t.ok('空の本文・決まりの外の状態は INVALID', throwsCode(() => store.add(s1, { entries: [{ text: '   ' }], by: user }), 'INVALID')
      && throwsCode(() => store.add(s1, { entries: [{ text: 'x', status: 'later' }], by: user }), 'INVALID'));
    t.ok('断ったときは rev を上げない', store.list(s1).rev === 2);

    // ---- 変える・待ちが解ける
    const c = store.update(s1, { changes: [{ id: i1.id, status: 'done' }], by: claude });
    t.ok('先の項目を完了にすると後の項目の waiting が解ける', c.items.filter(x => x.after.includes(i1.id)).every(x => !x.waiting) && c.items.find(x => x.id === test.id).waiting);
    t.ok('完了の知らせは action done・by は AI', events.at(-1).changed[0].action === 'done' && events.at(-1).by.backend === 'claude' && c.items[0].updatedBy.backend === 'claude');
    store.update(s1, { changes: [{ id: i1.id, status: 'todo' }], by: user });
    t.ok('戻すと reopened、進行中は started、本文だけは updated', events.at(-1).changed[0].action === 'reopened'
      && store.update(s1, { changes: [{ id: i1.id, status: 'doing' }], by: user }) && events.at(-1).changed[0].action === 'started'
      && store.update(s1, { changes: [{ id: i1.id, text: '調べ直す' }], by: user }) && events.at(-1).changed[0].action === 'updated');

    // ---- 並べ替え
    const moved = store.update(s1, { changes: [{ id: test.id, before: i1.id }], by: user });
    t.ok('before で前へ動かす（moved）。並びは 1..n に振り直す', moved.items[0].id === test.id && moved.items.map(x => x.order).join() === '1,2,3,4,5' && events.at(-1).changed[0].action === 'moved');
    const back = store.update(s1, { changes: [{ id: test.id, before: null }], by: user });
    t.ok('before: null で末尾へ', back.items.at(-1).id === test.id);

    // ---- 輪・自分の後
    t.ok('輪になる after は CYCLE で断る', throwsCode(() => store.update(s1, { changes: [{ id: i1.id, after: [test.id] }], by: user }), 'CYCLE'));
    t.ok('自分の後は INVALID', throwsCode(() => store.update(s1, { changes: [{ id: i1.id, after: [i1.id] }], by: user }), 'INVALID'));
    t.ok('cycleIn は輪の上の id を返す・輪が無ければ null', cycleIn([{ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] }]) !== null && cycleIn([{ id: 'a', after: [] }, { id: 'b', after: ['a'] }]) === null);
    t.ok('waitingOf: 進行中は待ちにしない', !waitingOf({ status: 'doing', after: ['x'] }, new Map([['x', { status: 'todo' }]])));

    // ---- ifRev
    const rev = store.list(s1).rev;
    t.ok('ifRev が今の版と違えば CONFLICT（detail に今の rev）', (() => { try { store.update(s1, { changes: [{ id: i1.id, text: 'z' }], ifRev: rev - 1, by: user }); return false; } catch (e) { return e.code === 'CONFLICT' && e.detail.rev === rev; } })());
    t.ok('ifRev が合えば通る', store.update(s1, { changes: [{ id: i1.id, text: '調べる' }], ifRev: rev, by: user }).rev === rev + 1);

    // ---- リンク
    t.ok('normalizeLink: http は url・末尾 / は dir・ほかは file・id を振る', normalizeLink({ url: 'https://example.com/a' }).kind === 'url' && normalizeLink({ path: 'D:/x/' }).kind === 'dir'
      && normalizeLink({ path: 'D:/x/a.md' }).kind === 'file' && /^l_[0-9a-z]{8}$/.test(normalizeLink({ path: 'D:/x/a.md' }).id));
    t.ok('url でない url・path の無い file は INVALID', throwsCode(() => normalizeLink({ url: 'javascript:alert(1)' }), 'INVALID') && throwsCode(() => normalizeLink({ kind: 'file' }), 'INVALID'));
    const file = path.join(root, 'report.md');
    await fs.writeFile(file, 'x');
    const missingPath = path.join(root, 'gone.md');
    const linked = store.update(s1, { changes: [{ id: i2.id, addLinks: [{ path: file }, { path: root + path.sep }, { path: missingPath }, { url: 'https://example.com/pr/1', title: 'PR' }] }], by: claude });
    const links = linked.items.find(x => x.id === i2.id).links;
    t.ok('addLinks で足す（種類と title が残る）', links.length === 4 && links.map(l => l.kind).join() === 'file,dir,file,url' && links[3].title === 'PR');
    const check = store.checkLinks(s1, { id: i2.id }).links;
    t.ok('checkLinks: あるファイル・フォルダーは true、無いものは false、url は true', check.map(l => l.exists).join() === 'true,true,false,true');
    const removedLink = store.update(s1, { changes: [{ id: i2.id, removeLinks: [missingPath, links[3].id] }], by: user });
    t.ok('removeLinks はパス・リンクの id で外せる', removedLink.items.find(x => x.id === i2.id).links.length === 2);

    // ---- 消す
    const r = store.remove(s1, { ids: [db.id], by: user });
    t.ok('消すと、ほかの項目の after からも外す', !r.items.some(x => x.id === db.id) && JSON.stringify(r.items.find(x => x.id === test.id).after) === JSON.stringify([ui.id]) && events.at(-1).changed[0].action === 'removed');
    t.ok('無い id を消すのは NOT_FOUND', throwsCode(() => store.remove(s1, { ids: ['todo_none'], by: user }), 'NOT_FOUND'));

    // ---- 会話ごとに分かれる・開き直しても残る
    store.add({ kind: 'session', id: 's2' }, { entries: [{ text: '別の会話' }], by: user });
    const kept = store.list(s1);
    store.close();
    const again = createTodos({ dataDir: dir });
    t.ok('開き直しても並び・状態・リンク・rev が残る', JSON.stringify(again.list(s1)) === JSON.stringify(kept));
    t.ok('会話ごとに分かれる', again.list({ kind: 'session', id: 's2' }).items.length === 1 && again.list(s1).items.length === 4);
    again.close();

    // ---- 会話を消すと ToDo も消える
    const handle = openData(dir);
    try {
      const sessions = sessionTable(handle.db);
      sessions.writeAll('s1', { title: 'x' });
      sessions.remove('s1');
      const todos = todoTable(handle.db);
      t.ok('会話を消すと、その会話の ToDo と rev も消える（ほかの会話は残る）', todos.list('session', 's1').length === 0 && todos.rev('session', 's1') === 0 && todos.list('session', 's2').length === 1);
    } finally { handle.release(); }

    // ---- 操作（todos.*）
    let task;
    const ops = createTodos({ dataDir: dir, taskOf: () => task });
    const sessionsDep = { get: async id => (id === 'me' || id === 'other' ? { row: { id, backend: 'codex' }, children: [], history: [] } : null) };
    const deps = { locale: 'ja', sessions: sessionsDep, todos: ops, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), audit: () => {} };
    const agent = sessionId => ({ by: 'agent', via: 'mcp', sessionId });
    const human = { by: 'human', via: 'ui', local: true };
    const added = await registry.invoke(agent('me'), 'todos.add', { items: [{ text: 'A', ref: 'a' }, { text: 'B', after: ['a'] }] }, deps);
    t.ok('AI は sessionId を省けば自分の会話に足す・by は自分の会話のエージェント', added.ok && added.result.sessionId === 'me' && added.result.items.length === 2 && added.result.items[0].by.backend === 'codex', JSON.stringify(added).slice(0, 300));
    const humanList = await registry.invoke(human, 'todos.list', {}, deps);
    t.ok('画面は sessionId を省けない（INVALID）', !humanList.ok && humanList.code === 'INVALID');
    const noSession = await registry.invoke(agent('me'), 'todos.add', { sessionId: 'ghost', items: [{ text: 'x' }] }, deps);
    t.ok('無い会話には書けない（SESSION_NOT_FOUND）', !noSession.ok && noSession.code === 'SESSION_NOT_FOUND');
    const stale = await registry.invoke(agent('me'), 'todos.update', { items: [{ id: added.result.items[0].id, status: 'done' }], ifRev: 0 }, deps);
    t.ok('古い ifRev は TODO_CONFLICT（文に今の rev）', !stale.ok && stale.code === 'TODO_CONFLICT' && stale.error.includes(String(added.result.rev)), stale.error);
    const loop = await registry.invoke(agent('me'), 'todos.update', { items: [{ id: added.result.items[0].id, after: [added.result.items[1].id] }] }, deps);
    t.ok('輪は TODO_CYCLE', !loop.ok && loop.code === 'TODO_CYCLE');
    const unknown = await registry.invoke(agent('me'), 'todos.remove', { ids: ['todo_x'] }, deps);
    t.ok('無い項目は TODO_NOT_FOUND', !unknown.ok && unknown.code === 'TODO_NOT_FOUND');
    const done = await registry.invoke(human, 'todos.update', { sessionId: 'me', items: [{ id: added.result.items[0].id, status: 'done' }] }, deps);
    t.ok('人の書き込みは by が user', done.ok && done.result.items[0].updatedBy.kind === 'user' && !done.result.items[1].waiting);
    const read = await registry.invoke(human, 'todos.list', { sessionId: 'me' }, deps);
    t.ok('画面は sessionId を渡して読む（waiting 付き）', read.ok && read.result.items.length === 2 && typeof read.result.items[0].waiting === 'boolean');
    const ro = await registry.invoke(agent('me'), 'todos.add', { items: [{ text: 'x' }] }, { ...deps, modeOf: async () => ({ scope: 'readonly', autonomy: 'ask' }) });
    t.ok('読むだけの AI は書けない', !ro.ok);
    t.ok('checkLinks は画面だけ（AI の目録に載らない）', registry.get('todos.checkLinks').surfaces.mcp === false && registry.get('todos.add').surfaces.mcp === 'catalog');
    const taskId = 'ply-task-00000000-0000-4000-8000-000000000000';
    const long = '検証項目'.repeat(160);
    task = { parentSessionId: 'me', status: 'queued', humanWaiting: false };
    const linkedTask = await registry.invoke(agent('me'), 'todos.add', {
      items: [{ text: long, taskId, assignee: 'Codex', humanWaiting: true }],
    }, deps);
    const linkedItem = linkedTask.result.items.at(-1);
    const readLinked = () => ops.list({ id: 'me' }).items.find(item => item.id === linkedItem.id);
    t.ok('長文・担当・人の返事待ち・委譲を足して保存できる', linkedItem.text === long && linkedItem.assignee === 'Codex' && linkedItem.humanWaiting && linkedItem.taskId === taskId);
    await registry.invoke(human, 'todos.update', {
      sessionId: 'me', items: [{ id: linkedItem.id, assignee: '山田', humanWaiting: false }],
    }, deps);
    t.ok('担当と手動の返事待ちは個別に更新できる', readLinked().assignee === '山田' && !readLinked().humanWaiting);
    task.status = 'running';
    task.humanWaiting = true;
    ops.syncTasks();
    t.ok('子の開始と承認待ちを反映する', readLinked().status === 'doing' && readLinked().humanWaiting);
    task.status = 'interrupted';
    task.humanWaiting = false;
    ops.syncTasks();
    t.ok('中断した委譲は進行中のまま印を出す', readLinked().status === 'doing' && readLinked().taskIssue === 'interrupted');
    await registry.invoke(human, 'todos.update', {
      sessionId: 'me', items: [{ id: linkedItem.id, status: 'done' }],
    }, deps);
    task.status = 'failed';
    task.humanWaiting = false;
    ops.syncTasks();
    t.ok('委譲が失敗しても手動の完了を戻さない', readLinked().status === 'done' && readLinked().taskIssue === 'failed' && !readLinked().humanWaiting);
    await registry.invoke(human, 'todos.update', {
      sessionId: 'me', items: [{ id: linkedItem.id, status: 'doing' }],
    }, deps);
    task.status = 'completed';
    ops.syncTasks();
    t.ok('委譲が完了すると項目も完了にする', readLinked().status === 'done' && readLinked().taskIssue === null);
    ops.close();
    t.ok('再び開いても 500 字を超える文と担当が残る', readLinked().text === long && readLinked().assignee === '山田');
    ops.close();

    // ---- 形式 3 → 4 の移行
    const seed = async label => {
      const d = path.join(root, label);
      await fs.mkdir(d);
      const raw = createDb(dbPath(d));
      raw.exec('DROP TABLE IF EXISTS todos; DROP TABLE IF EXISTS todo_scopes;');
      sessionTable(raw).writeAll('keep', { title: '残る会話' });
      raw.close();
      await fs.writeFile(path.join(d, 'data-schema.json'), '{"schema":3}\n');
      return d;
    };
    const schema = async d => JSON.parse(await fs.readFile(path.join(d, 'data-schema.json'), 'utf8')).schema;
    const tables = async d => { const { DatabaseSync } = await import('node:sqlite'); const x = new DatabaseSync(dbPath(d), { readOnly: true }); try { return x.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name); } finally { x.close(); } };

    const ok = await seed('migrate-ok');
    const result = ensureDataSchemaSync(ok);
    t.ok('形式 3 は 4 へ移す（表を作り、番号を 4 に）', DATA_SCHEMA === 4 && await schema(ok) === 4 && (await tables(ok)).includes('todos') && (await tables(ok)).includes('todo_scopes'));
    t.ok('移す前の DB と番号の写しを backup-schema3-* に残す', /backup-schema3-/.test(result?.backup ?? '') && await schema(result.backup) === 3 && !(await tables(result.backup)).includes('todos'));
    const h = openData(ok);
    try { t.ok('移しても会話は残る', sessionTable(h.db).ids().includes('keep')); } finally { h.release(); }

    const failed = await seed('migrate-fail');
    let error;
    try { ensureDataSchemaSync(failed, { afterTodosCreate: () => { throw new Error('injected'); } }); } catch (e) { error = e; }
    t.ok('移行の途中で失敗したら番号は 3 のまま・表も作らない', !!error && await schema(failed) === 3 && !(await tables(failed)).includes('todos'));
    ensureDataSchemaSync(failed);
    t.ok('原因が無くなれば移し直せる', await schema(failed) === 4);

    // 旧版（形式 3 まで）の起動入口は、形式 4 の置き場を書き込みの前に断る
    const source = (await fs.readFile(new URL('../../core/data-schema.mjs', import.meta.url), 'utf8'))
      .replace('export const DATA_SCHEMA = 4;', 'export const DATA_SCHEMA = 3;')
      .replace(/from '(\.\/[^']+)'/g, (_all, relative) => `from '${new URL(relative, new URL('../../core/data-schema.mjs', import.meta.url)).href}'`);
    const oldModule = path.join(root, 'data-schema-v3.mjs');
    await fs.writeFile(oldModule, source);
    const old = spawnSync(process.execPath, ['--input-type=module', '-e', `const {ensureDataSchemaSync}=await import(${JSON.stringify(pathToFileURL(oldModule).href)});ensureDataSchemaSync(${JSON.stringify(ok)});`], { encoding: 'utf8' });
    t.ok('形式 3 までの版は形式 4 の置き場を断る', old.status !== 0 && /別の形式|different format/.test(old.stderr) && await schema(ok) === 4, old.stderr.slice(-300));
  } finally {
    try { store.close(); } catch { /* 既に閉じた */ }
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
