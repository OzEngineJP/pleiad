// 会話の ToDo の面の計算（web/session-todo-model.mjs。ADR 0342）: リストとフローの切り替え・依存の正規化・輪の判定・
// todos.update の差分・リストとフローの配置（完了の束）・成果物のリンクの名前と場所
import assert from 'node:assert/strict';
import {
  afterMap, isFlowGraph, materialize, topoOrder, normalizeAfter, reaches, kindOf, leaves,
  changesFor, layoutList, layoutFlow, linkParts, linkInput,
} from '../../web/session-todo-model.mjs';

export const name = 'session-todo-model';
export const title = '会話の ToDo の面: リスト ⇄ フロー・依存の正規化・輪・更新の差分・配置・完了の束・リンクの名前';

const it = (id, after = [], status = 'todo', extra = {}) => ({ id, text: id, status, after, links: [], ...extra });
const K = { NW: 164, NH: 58, GX: 12, GY: 32 };

export default async function (t) {
  // リストとフロー
  assert.equal(isFlowGraph([]), false);
  assert.equal(isFlowGraph([it('a')]), false);
  assert.equal(isFlowGraph([it('a'), it('b'), it('c')]), false, '依存が無ければリスト');
  assert.equal(isFlowGraph([it('a'), it('b', ['a']), it('c', ['b'])]), false, '並びどおりの 1 本道はリスト');
  assert.equal(isFlowGraph([it('a'), it('b', ['a']), it('c', ['a'])]), true, '枝分かれはフロー');
  assert.equal(isFlowGraph([it('a'), it('b'), it('c', ['a', 'b'])]), true, '合流はフロー');
  assert.equal(isFlowGraph([it('a'), it('b', ['x'])]), false, '無い項目への依存は数えない');
  t.ok('依存が無い・1 本道はリスト、枝分かれ・合流はフロー', true);

  // 依存の表
  const am = afterMap([it('a', ['a', 'zz']), it('b', ['a', 'a'])]);
  assert.deepEqual(am.get('a'), []);
  assert.deepEqual(am.get('b'), ['a']);
  const chainMap = materialize([it('a'), it('b'), it('c')]);
  assert.deepEqual([...chainMap.values()], [[], ['a'], ['b']], 'リストは並びの 1 本道');
  t.ok('依存の表は今ある項目だけ・自分と重なりを外し、リストは並びの 1 本道として扱う', true);

  // 先に終える順
  const items = [it('c', ['b']), it('a'), it('b', ['a'])];
  assert.deepEqual(topoOrder(items, afterMap(items)).map(i => i.id), ['a', 'b', 'c']);
  const loop = [it('x', ['y']), it('y', ['x']), it('z')];
  assert.deepEqual(topoOrder(loop, afterMap(loop)).map(i => i.id), ['z', 'x', 'y'], '輪の残りは元の順で後ろへ');
  t.ok('先に終える項目から並べ直し、輪の残りは後ろへ', true);

  // 正規化
  const list3 = [it('a'), it('b'), it('c')];
  let n = normalizeAfter(list3, new Map([['a', []], ['b', ['a']], ['c', ['b']]]));
  assert.deepEqual(n.order, ['a', 'b', 'c']);
  assert.ok([...n.after.values()].every(d => d.length === 0), '1 本道になったら依存を全部外す');
  n = normalizeAfter(list3, new Map([['a', []], ['b', ['a']], ['c', ['a']]]));
  assert.deepEqual(n.after.get('c'), ['a'], '枝分かれは残す');
  n = normalizeAfter(list3, new Map([['a', ['c']], ['b', []], ['c', ['b']]]));
  assert.deepEqual(n.order, ['b', 'c', 'a'], '依存の順に並べ直す');
  t.ok('正規化: 先に終える順に並べ、1 本道ならリストへ戻す', true);

  // 輪の判定
  const deps = new Map([['a', []], ['b', ['a']], ['c', ['b']]]);
  assert.equal(reaches('c', 'a', deps), true);
  assert.equal(reaches('a', 'c', deps), false);
  t.ok('間を挟んだ依存をたどれる（輪になる依存を選べなくする）', true);

  // 印
  assert.equal(kindOf(it('a', [], 'done'), true), 'done');
  assert.equal(kindOf(it('a', [], 'doing'), false), 'doing');
  assert.equal(kindOf(it('a', [], 'todo', { waiting: true }), true), 'wait');
  assert.equal(kindOf(it('a', [], 'todo', { waiting: true }), false), 'todo', '待ちはフローのときだけ');
  assert.deepEqual(leaves([it('a'), it('b', ['a']), it('c', ['a'])]), ['b', 'c']);
  t.ok('待ちの印はフローのときだけ。末端は誰からも待たれていない項目', true);

  // todos.update の差分
  const base = [it('a'), it('b'), it('c')];
  assert.deepEqual(changesFor(base, ['a', 'b', 'c'], new Map([['a', []], ['b', []], ['c', []]])), [], '変わらなければ空');
  assert.deepEqual(changesFor(base, ['b', 'a', 'c'], new Map([['a', []], ['b', []], ['c', []]])),
    [{ id: 'b', before: null }, { id: 'a', before: null }, { id: 'c', before: null }], '並びが変われば新しい順に末尾へ送る');
  assert.deepEqual(changesFor(base, ['a', 'b', 'c'], new Map([['a', []], ['b', []], ['c', ['a', 'b']]])),
    [{ id: 'c', after: ['a', 'b'] }], 'after の変わった項目だけ');
  t.ok('並びと after の変更を todos.update の items に直す', true);

  // 配置
  const L = layoutList(base, 300, () => 34, 2);
  assert.equal(L.R.get('b').y, 36);
  assert.equal(L.H, 34 * 3 + 2 * 2);
  assert.equal(layoutList(base, 1000, () => 34, 2).R.get('a').w, 640, 'リストは 640px まで');
  const diamond = [it('a'), it('b', ['a']), it('c', ['a']), it('d', ['b', 'c'])];
  const F = layoutFlow(diamond, afterMap(diamond), 344, K);
  assert.equal(F.R.get('a').y, 0);
  assert.equal(F.R.get('b').y, F.R.get('c').y, '同じ段');
  assert.equal(F.R.get('d').y, 2 * (K.NH + K.GY));
  assert.equal(F.E.length, 4);
  assert.equal(new Set(F.E.filter(edge => edge.b === 'd').map(edge => edge.inlet)).size, 2);
  const structured = layoutList(diamond, 340, () => 34, 2, afterMap(diamond));
  assert.deepEqual([...structured.R.values()].map(r => r.x), [0, 16, 16, 0]);
  assert.equal(structured.R.get('b').w, 324);
  t.ok('リストは分岐で字下げし、合流で元に戻す。フローは合流の入口を分ける', true);
  assert.ok(F.R.get('b').x < F.R.get('c').x, '段の中は並びの順');
  const skip = [it('a'), it('b', ['a']), it('c', ['b']), it('d', ['a', 'c'])];
  const S = layoutFlow(skip, afterMap(skip), 344, K);
  assert.equal(S.E.find(e => e.key === 'a>d').via.length, 2, '段を跨ぐ線は見えない点を通る');
  const many = [...Array(10)].map((_, i) => it(`n${i}`, i ? [`n${i - 1}`] : [], i < 4 ? 'done' : 'todo'));
  many[9].after = ['n7']; many[8].after = ['n7'];
  const M = layoutFlow(many, afterMap(many), 344, K);
  assert.deepEqual([...M.stacks.values()], [4], '先頭から続く完了は束にまとめる');
  assert.equal(M.R.get('n0').o, 0);
  assert.equal(layoutFlow(many, afterMap(many), 344, K, true).stacks.size, 0, '開いたら束にしない');
  const later = [it('start'), ...[1, 2, 3].map(i => it(`later${i}`, [i === 1 ? 'start' : `later${i - 1}`], 'done'))];
  const foldedLater = layoutFlow(later, afterMap(later), 344, K);
  assert.deepEqual([...foldedLater.stacks.values()], [3]);
  assert.ok(foldedLater.E.some(e => e.a === 'start' && e.b === '#done:later1'));
  t.ok('リストは 640px まで・フローは最長路で段に分け、跨ぐ線は点を通し、完了が 3 件続くと束ねる', true);

  // 成果物のリンク
  assert.deepEqual(linkParts({ kind: 'file', path: 'D:/work/app/report.md' }), { name: 'report.md', where: 'D:/work/app' });
  assert.deepEqual(linkParts({ kind: 'dir', path: 'C:\\work\\out\\' }), { name: 'out', where: 'C:\\work' });
  assert.deepEqual(linkParts({ kind: 'url', url: 'https://example.com/a/b' }), { name: 'example.com/a/b', where: '' });
  assert.deepEqual(linkParts({ kind: 'url', url: 'https://example.com/a', title: 'PR' }), { name: 'PR', where: 'example.com' });
  assert.deepEqual(linkInput('  https://example.com '), { url: 'https://example.com' });
  assert.deepEqual(linkInput('D:/a.txt'), { path: 'D:/a.txt' });
  t.ok('リンクは名前と場所に分け、入力は URL かパスに振り分ける', true);
}
