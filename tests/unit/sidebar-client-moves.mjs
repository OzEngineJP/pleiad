// 脇の移動の受け口（web/client.mjs の sidebarChange・restore・deleteSessionRow）。列そのものは tests/unit/sidebar-moves.mjs が見る。
// ここでは client が列へ渡す対象と、削除・元に戻す・失敗の札の扱いを、client.mjs の該当部分を vm で走らせて確かめる。
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createMoveLanes, settleAll } from '../../web/sidebar-moves.mjs';
import { overlaySessions, revertFailed, currentRows } from '../../web/pending-sidebar.mjs';

export const name = 'sidebar-client-moves';
export const title = '脇の移動の受け口: 削除は移動の保存の後・元に戻すは生きている行だけ・失敗の札は覆われない行を知らせる';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  const g = {};
  g.promise = new Promise((resolve, reject) => { g.resolve = resolve; g.reject = reject; });
  return g;
}

export default async function (t) {
  const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const cut = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
  const moveCode = cut('const pendingRows = new Map();', '/** その行と同じグループに居る行');
  const deleteCode = cut('async function deleteSessionRow(', '/**\n * 会話の操作のメニュー');

  const calls = [];
  const holds = new Map();   // `${command}:${sessionId}` → 手で終わらせる保存
  const notes = [], undos = [];
  const state = { sessions: [], drafts: new Map() };
  const context = vm.createContext({
    state, createMoveLanes, settleAll, overlaySessions, revertFailed, currentRows,
    t: (key, params) => (params?.reason ? `${key}: ${params.reason}` : key),
    statusWord: (s) => s || 'none', rowLabel: (s) => s.id, refreshVersion: 0,
    renderSessions: () => {}, refresh: async () => {}, refreshVersionBump: () => {},
    setTimeout, clearTimeout, DRAFT_STORE: 'drafts', localStorage: { setItem() {} },
    document: { querySelector: () => null }, CSS: { escape: (x) => x },
    familiesOf: () => [],
    side: { showUndo: (text, fn, opts) => { if (text) undos.push({ text, fn, opts }); } },   // null は札を消す呼び出し
    sideNote: (text) => notes.push(text),
    cmd: (command, args = {}) => {
      calls.push(`${command}:${args.sessionId}${args.status !== undefined ? `=${args.status}` : ''}`);
      const hold = holds.get(`${command}:${args.sessionId}`);
      return hold ? hold.promise : Promise.resolve({});
    },
  });
  vm.runInContext(moveCode + '\n' + deleteCode, context);
  const run = (js) => vm.runInContext(js, context);
  const reset = () => {
    calls.length = 0; notes.length = 0; undos.length = 0; holds.clear();
    run('moveLanes.confirm(Infinity)');   // 前の場面で保存済みの表示の上書きを、一覧の取り直しが確かめた後の状態にする
    state.sessions = [{ id: 'a', status: '進行中', ungrouped: false }, { id: 'b', status: '進行中', ungrouped: false }];
  };
  const snap = (id, status = '進行中') => ({ sessionId: id, status, ungrouped: false });

  // ---- 元に戻す: 一覧から消えた行へは書かない（表示の対象と保存の対象が同じ） ----
  reset();
  state.sessions = [{ id: 'a', status: '完了', ungrouped: false }];   // b は消えた
  context.restoreInput = [snap('a'), snap('b')];
  await run('restore(restoreInput)');
  await tick();
  t.ok('消えた行へは元に戻す書き込みをしない', calls.includes('setStatus:a=進行中') && !calls.some((c) => c.endsWith(':b') || c.includes(':b=')), JSON.stringify(calls));
  t.ok('生きている行だけを元の値へ戻す', state.sessions[0].status === '進行中');
  reset();
  state.sessions = [];
  context.restoreInput = [snap('a'), snap('b')];
  await run('restore(restoreInput)');
  t.ok('戻す行が全部消えていれば何も書かない', calls.length === 0);

  // ---- 削除: 受理済みの移動の保存が決着してから消す。削除の印を移動の印で上書きしない ----
  reset();
  const saving = gate();
  holds.set('setStatus:a', saving);
  context.rowA = state.sessions[0];
  const moving = run("sidebarChange({ rows: [rowA], patches: new Map([['a', { status: '完了' }]]), run: () => cmd('setStatus', { sessionId: 'a', status: '完了' }), coalesceKey: 'status:a' })");
  await tick();
  const deleting = run("deleteSessionRow(rowA, 'deleteSession')");
  await tick();
  t.ok('移動の保存中は、削除の書き込みを始めない', calls.join() === 'setStatus:a=完了', calls.join());
  t.ok('移動の保存中も、削除の印（削除中）を保つ', run("pendingRows.get('a')?.kind") === 'delete');
  const later = run("sidebarChange({ rows: [rowA], patches: new Map([['a', { status: '保留' }]]), run: () => cmd('setStatus', { sessionId: 'a', status: '保留' }), coalesceKey: 'status:a' })");
  await later;
  t.ok('削除を受理した行には、新しい移動を受けない', !calls.includes('setStatus:a=保留'));
  saving.resolve();
  await moving;
  await deleting;
  t.ok('移動の保存が終わった後に削除する', calls.join() === 'setStatus:a=完了,deleteSession:a', calls.join());
  t.ok('削除が済んだ行は一覧から消える', !state.sessions.some((row) => row.id === 'a') && run("pendingDeletedRows.size") === 0);

  // ---- 失敗の札: 全対象が後続の移動に覆われるときだけ静かにする ----
  // 全部覆われる: 先行（単体 a）が失敗、後続が同じ行に居る
  reset();
  const fail = gate(), tail = gate();
  holds.set('setStatus:a', fail);
  context.rows2 = state.sessions;
  const first = run("sidebarChange({ rows: [rows2[0]], patches: new Map([['a', { status: 'X' }]]), run: () => cmd('setStatus', { sessionId: 'a', status: 'X' }), retry: () => {}, coalesceKey: '' })");
  holds.set('setStatus:a', fail);
  const second = run("sidebarChange({ rows: [rows2[0]], patches: new Map([['a', { status: 'Y' }]]), run: () => cmd('setStatus', { sessionId: 'a', status: 'Y' }), retry: () => {}, coalesceKey: '' })");
  fail.reject(new Error('保存できない'));
  holds.set('setStatus:a', tail);
  await first;
  t.ok('全対象が後続に覆われる失敗は札にしない', notes.length === 0 && undos.length === 0, JSON.stringify({ notes, undos }));
  tail.resolve();
  await second;

  // 一部だけ覆われる: a と b の移動が失敗し、a にだけ後続がある。b の失敗は知らせる
  reset();
  const failBoth = gate(), holdA = gate();
  holds.set('setStatus:a', failBoth); holds.set('setStatus:b', failBoth);
  context.rows3 = state.sessions;
  const group = run(`sidebarChange({ rows: rows3, patches: new Map(rows3.map(r => [r.id, { status: 'G' }])),
    run: () => settleAll(rows3.map(r => cmd('setStatus', { sessionId: r.id, status: 'G' }))), retry: () => {}, coalesceKey: 'g' })`);
  context.onlyA = [state.sessions[0]];
  const follow = run("sidebarChange({ rows: onlyA, patches: new Map([['a', { status: 'H' }]]), run: () => cmd('setStatus', { sessionId: 'a', status: 'H' }), retry: () => {}, coalesceKey: '' })");
  failBoth.reject(new Error('一部の保存に失敗'));
  holds.set('setStatus:a', holdA);
  await group;
  t.ok('一部の行だけ後続に覆われる失敗は、覆われない行のために知らせる', notes.length === 1 && notes[0].includes('一部の保存に失敗'), JSON.stringify({ notes, undos }));
  holdA.resolve();
  await follow;

  // 覆われる行が無い: 再試行つきの札
  reset();
  const failOnly = gate();
  holds.set('setStatus:a', failOnly);
  context.rows4 = [state.sessions[0]];
  const alone = run("sidebarChange({ rows: rows4, patches: new Map([['a', { status: 'X' }]]), run: () => cmd('setStatus', { sessionId: 'a', status: 'X' }), retry: () => {}, coalesceKey: '' })");
  failOnly.reject(new Error('保存できない'));
  await alone;
  t.ok('後続が無い失敗は、再試行つきの札で知らせる', undos.length === 1 && undos[0].opts?.retry === true && typeof undos[0].fn === 'function', JSON.stringify(undos.map((u) => u.text)));
  t.ok('失敗した行は戻る', state.sessions[0].status === '進行中', state.sessions[0].status);

  // ---- 失敗→成功→元に戻す: 保存されなかった途中の値へ戻らない ----
  reset();
  const g1 = gate();
  holds.set('setStatus:a', g1);
  context.rows5 = state.sessions;
  const ab = run("sidebarChange({ rows: [rows5[0]], patches: new Map([['a', { status: 'B' }]]), run: () => cmd('setStatus', { sessionId: 'a', status: 'B' }), retry: () => {}, coalesceKey: '' })");
  const bc = run("sidebarChange({ rows: [rows5[0]], patches: new Map([['a', { status: 'C' }]]), run: () => cmd('setStatus', { sessionId: 'a', status: 'C' }), success: 'moved', retry: () => {}, coalesceKey: '' })");
  g1.reject(new Error('保存できない'));
  holds.delete('setStatus:a');
  await Promise.all([ab, bc]);
  const undo = undos.at(-1);
  t.ok('成功の後に「元に戻す」が出る', undo?.text === 'moved' && typeof undo.fn === 'function');
  calls.length = 0;
  undo.fn();
  await tick(); await tick();
  t.ok('元に戻す先は、保存されなかった B ではなく最初の値（進行中）', calls.includes('setStatus:a=進行中') && !calls.includes('setStatus:a=B'), calls.join());

  // ---- グループの一部だけ保存できた後の成功: 戻し先が確かでないので「元に戻す」を出さない ----
  reset();
  const gg = gate();
  holds.set('setStatus:a', gg); holds.set('setStatus:b', gg);
  context.rows6 = state.sessions;
  const grp = run(`sidebarChange({ rows: rows6, patches: new Map(rows6.map(r => [r.id, { status: 'G' }])),
    run: () => settleAll(rows6.map(r => cmd('setStatus', { sessionId: r.id, status: 'G' }))), retry: () => {}, coalesceKey: 'g' })`);
  context.rowsA = [state.sessions[0]];
  holds.delete('setStatus:b');
  const after = run("sidebarChange({ rows: rowsA, patches: new Map([['a', { status: 'C' }]]), run: () => cmd('setStatus', { sessionId: 'a', status: 'C' }), success: 'moved', retry: () => {}, coalesceKey: '' })");
  gg.reject(new Error('一部だけ保存できた'));
  holds.delete('setStatus:a');
  await Promise.all([grp, after]);
  t.ok('グループの一部が保存できた後の成功には、戻し先が確かでないので「元に戻す」を出さない', !undos.some((u) => u.text === 'moved'), JSON.stringify(undos.map((u) => u.text)));
}
