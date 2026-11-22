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
const K = { NW: 164, MAXW: 280, SW: 112, SH: 28, GX: 12, GY: 32 };

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
  const height = ({ id }) => id === 'b' ? 61 : 37;
  const flow = (items, width = 344, expand = false) => layoutFlow(items, afterMap(items), width, K, height, expand);
  const linearFlow = flow(base);
  assert.deepEqual([...linearFlow.R.values()].map(r => r.y), [0, 37 + K.GY, 37 + 61 + 2 * K.GY]);
  assert.equal(new Set([...linearFlow.R.values()].map(r => r.x)).size, 1);
  assert.deepEqual(linearFlow.E, []);
  t.ok('依存が無い項目のフローは並びの順に縦一列で、線を引かない', true);
  const F = flow(diamond);
  assert.equal(F.R.get('a').y, 0);
  assert.equal(F.R.get('b').y, F.R.get('c').y, '同じ段');
  assert.equal(F.R.get('d').y, 37 + 61 + 2 * K.GY);
  assert.equal(F.R.get('c').h, 37);
  assert.equal(F.R.get('b').w, 166);
  assert.equal(flow(diamond, 300).R.get('b').w, K.NW);
  assert.equal(flow(diamond, 624).R.get('b').w, K.MAXW);
  assert.equal(F.E.length, 4);
  assert.equal(new Set(F.E.filter(edge => edge.b === 'd').map(edge => edge.inlet)).size, 2);
  const structured = layoutList(diamond, 340, () => 34, 2, afterMap(diamond));
  assert.deepEqual([...structured.R.values()].map(r => r.x), [0, 16, 16, 0]);
  assert.equal(structured.R.get('b').w, 324);
  t.ok('リストは分岐で字下げし、合流で元に戻す。フローは合流の入口を分ける', true);
  assert.ok(F.R.get('b').x < F.R.get('c').x, '段の中は並びの順');
  const skip = [it('a'), it('b', ['a']), it('c', ['b']), it('d', ['a', 'c'])];
  const S = flow(skip);
  assert.equal(S.E.find(e => e.key === 'a>d').via.length, 2, '段を跨ぐ線は見えない点を通る');
  const many = [...Array(10)].map((_, i) => it(`n${i}`, i ? [`n${i - 1}`] : [], i < 4 ? 'done' : 'todo'));
  many[2].after = ['n0'];
  many[3].after = ['n1', 'n2'];
  many[4].after = ['n1', 'n3'];
  many[9].after = ['n7']; many[8].after = ['n7'];
  const M = flow(many);
  assert.deepEqual([...M.stacks], [['#done', 4]]);
  assert.deepEqual(many.filter(({ id }) => M.R.get(id).o === 0).map(({ id }) => id), ['n0', 'n1', 'n2', 'n3']);
  assert.deepEqual(M.E.filter(e => e.a === '#done' || e.b === '#done').map(e => e.key), ['#done>n4']);
  assert.equal(M.R.get('#done').w, K.SW);
  assert.equal(M.R.get('#done').h, K.SH);
  assert.equal(M.R.get('n4').y, K.SH + K.GY);
  const expanded = flow(many, 344, true);
  assert.equal(expanded.stacks.size, 0);
  assert.equal(expanded.canFold, true);
  assert.ok(many.every(({ id }) => expanded.R.get(id).o === 1));
  t.ok('10 件の先頭にある分岐と合流をまとめ、外への線を 1 本にし、開くと全件を表示する', true);

  const independent = Array.from({ length: 10 }, (_, i) => it(`n${i}`, i === 9 ? ['n0', 'n5', 'n8'] : [], i < 6 ? 'done' : 'todo'));
  const I = flow(independent);
  assert.deepEqual([...I.stacks], [['#done', 6]]);
  assert.deepEqual(I.E.map(e => e.key), ['#done>n9', 'n8>n9']);
  assert.equal(flow(independent.slice(0, 8), 344, true).canFold, false);
  t.ok('10 件のうち依存の無い完了 6 件をまとめる。8 件では畳むボタンも出さない', true);

  const short = Array.from({ length: 8 }, (_, i) => it(`short${i}`, i ? [`short${i - 1}`] : [], i < 4 ? 'done' : 'todo'));
  assert.deepEqual([...flow(short).stacks], [['#done:short0', 4]]);
  const later = [...many.slice(0, 5), it('branch', ['n4']), it('other', ['n4']),
    it('later1', ['branch'], 'done'), it('later2', ['later1'], 'done'), it('later3', ['later2'], 'done'),
    it('join', ['other', 'later3'])];
  const foldedLater = flow(later);
  assert.deepEqual([...foldedLater.stacks], [['#done', 4], ['#done:later1', 3]]);
  assert.ok(foldedLater.E.some(e => e.key === 'branch>#done:later1'));
  assert.ok(foldedLater.E.some(e => e.key === '#done:later1>join'));
  assert.equal(new Set(foldedLater.E.filter(e => e.b === 'join').map(e => e.inlet)).size, 2);
  t.ok('8 件の一本道の完了 4 件と、先頭のまとまりとは別に分岐の後ろの完了 3 件を畳む', true);
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
