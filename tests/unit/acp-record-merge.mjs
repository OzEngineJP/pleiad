import assert from 'node:assert/strict';
import { createDevinMapper } from '../../core/backends/devin-normalize.mjs';
import { createGrokMapper } from '../../core/backends/grok-normalize.mjs';
import { mergeMessages } from '../../core/conversations.mjs';

export const name = 'acp-record-merge';
export const title = 'ACP の再生を記録に重ねても、圧縮で位置がずれた発言を重ねず上書きせず、送った全文でなく原文を残す（#97）';

const HOST = '<host-instructions>\nfixture instruction\n</host-instructions>';
const chunk = (role, text) => ({ sessionUpdate: `${role}_message_chunk`, content: { type: 'text', text } });
const sentOf = shown => `${HOST}\n\n${shown}`;
const tool = (id, result) => [
  { sessionUpdate: 'tool_call', toolCallId: id, title: 'Read file', rawInput: { path: id }, status: 'pending' },
  ...(result ? [{ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: result }] : []),
];
// ターン = 人が書いた分と、返答の ACP の更新の並び
const turnOf = (shown, ...updates) => ({ shown, sent: sentOf(shown), updates: updates.flat().map(u => typeof u === 'string' ? chunk('agent', u) : u) });
// このプロセスが送るターン（エコーは全文を 2 つに割って返す）
function live(mapper, turn) {
  mapper.beginTurn(turn.sent, turn.shown);
  const half = Math.ceil(turn.sent.length / 2);
  mapper.accept(chunk('user', turn.sent.slice(0, half))); mapper.accept(chunk('user', turn.sent.slice(half)));
  for (const update of turn.updates) mapper.accept(update);
  mapper.finish();
  return mapper;
}
// session/load の再生（ネイティブに残っているターンだけ。user は送った全文で返る）
function replay(turns, { sid = 'nid', rows = [] } = {}) {
  const mapper = createDevinMapper(sid);
  for (const update of rows) mapper.accept(update);
  for (const turn of turns) {
    mapper.accept(chunk('user', turn.sent));
    for (const update of turn.updates) mapper.accept(update);
  }
  return mapper;
}
const record = () => ({ base: 0, nativeId: 'nid', messages: [] });
const view = r => r.messages.map(m => [m.role, m.text]);
const uuids = r => r.messages.map(m => m.uuid);

export default function (t) {
  // ---- 圧縮後の位置の再利用: u0/a1/u2/a3 の後、圧縮の再生で 2 ターン目だけが位置 0・1 で返る
  {
    const r = record(), mapper = createDevinMapper('nid');
    const one = turnOf('User original', 'First answer'), two = turnOf('Second original', 'Second answer');
    mergeMessages(r, live(mapper, one).messages(), 'devin');
    mergeMessages(r, live(mapper, two).messages(), 'devin');
    const before = uuids(r);
    mergeMessages(r, replay([two]).messages(), 'devin');
    assert.deepEqual(view(r), [['user', 'User original'], ['assistant', 'First answer'], ['user', 'Second original'], ['assistant', 'Second answer']]);
    assert.deepEqual(uuids(r), before);
    t.ok('圧縮の再生で位置が前にずれても、1 ターン目を上書きせず 4 行を保ち UUID も変えない', true);
    assert.ok(r.messages.every(m => !m.text.includes('fixture instruction') && m.sent === undefined && m.positional === undefined));
    t.ok('ライブと再生のどちらの経路でも、記録の発言は人が書いた分（指示の全文と印は残さない）', true);
  }

  // ---- 正当な同じ本文の繰り返し（「OK」「続けて」と同じ返答）は数を保つ
  {
    const r = record(), mapper = createDevinMapper('nid');
    const ok = turnOf('OK', 'X'), more = turnOf('続けて', 'Y');
    for (const turn of [ok, ok, more, ok]) mergeMessages(r, live(mapper, turn).messages(), 'devin');
    const before = uuids(r), shape = view(r);
    assert.equal(r.messages.length, 8);
    mergeMessages(r, replay([ok, ok, more, ok]).messages(), 'devin');
    assert.deepEqual(view(r), shape); assert.deepEqual(uuids(r), before);
    mergeMessages(r, replay([more, ok]).messages(), 'devin');
    assert.deepEqual(view(r), shape); assert.deepEqual(uuids(r), before);
    mergeMessages(r, replay([ok]).messages(), 'devin');
    assert.deepEqual(view(r), shape); assert.deepEqual(uuids(r), before);
    t.ok('同じ本文のターンは、全部の再生でも圧縮後の一部の再生でも数と UUID を保つ', true);
    // 圧縮で 1 ターンだけ残った会話に、前と同じ「OK」を送ると新しい 2 行が足される（再起動の後の再生でも重ならない）
    const resumed = replay([ok]);
    mergeMessages(r, live(resumed, ok).messages(), 'devin');
    assert.equal(r.messages.length, 10);
    assert.deepEqual(view(r).slice(-2), [['user', 'OK'], ['assistant', 'X']]);
    const after = uuids(r);
    mergeMessages(r, replay([ok, ok]).messages(), 'devin');
    assert.deepEqual(uuids(r), after);
    // ネイティブが全部落とした後（再生が空）の同じ本文のターンも足される
    const empty = createDevinMapper('nid');
    mergeMessages(r, live(empty, ok).messages(), 'devin');
    assert.equal(r.messages.length, 12);
    t.ok('圧縮の後に前と同じ本文の新しいターンを送ると足され、次の再生で重ならない', new Set(uuids(r)).size === 12);
  }

  // ---- ツール付きの返答: 結果は後から埋まり、同じ本文でもツールの違う行は取り違えない
  {
    const r = record(), mapper = createDevinMapper('nid');
    const first = turnOf('read a', tool('ta', null), 'done'), second = turnOf('read b', tool('tb', 'b-result'), 'done');
    mergeMessages(r, live(mapper, first).messages(), 'devin');
    mergeMessages(r, live(mapper, second).messages(), 'devin');
    const before = uuids(r);
    assert.equal(r.messages[1].toolCalls[0].result, null);
    mergeMessages(r, replay([turnOf('read a', tool('ta', 'a-result'), 'done'), second]).messages(), 'devin');
    assert.deepEqual(uuids(r), before);
    assert.equal(r.messages[1].toolCalls[0].result.text, 'a-result');
    mergeMessages(r, replay([second]).messages(), 'devin');
    assert.deepEqual(uuids(r), before);
    assert.deepEqual(r.messages.filter(m => m.role === 'assistant').map(m => m.toolCalls[0].id), ['ta', 'tb']);
    t.ok('ツールの結果は再生で埋まり、同じ本文でツールの違う返答は別の行のまま保つ', r.messages[1].toolCalls[0].result.text === 'a-result');
  }

  // ---- 修正前の記録（位置の UUID）: 再生の位置の UUID が別の発言の記録の UUID と同じでも上書きしない
  {
    const legacy = (role, i, text) => ({ uuid: `devin:nid:nid:${role}:${i}`, role, text, backend: 'devin', at: null });
    const r = { base: 0, nativeId: 'nid', messages: [legacy('user', 0, 'u0'), legacy('assistant', 1, 'a1'), legacy('user', 2, 'u2'), legacy('assistant', 3, 'a3')] };
    // 圧縮で u0/a1 が落ち、Pleiad の外で u4/a5 が足された再生。位置の UUID は u0・a1・u2・a3 の記録の UUID と同じになる
    const compacted = createDevinMapper('nid');
    for (const update of [chunk('user', 'u2'), chunk('agent', 'a3'), chunk('user', 'u4'), chunk('agent', 'a5')]) compacted.accept(update);
    assert.equal(compacted.messages()[0].uuid, 'nid:user:0');
    mergeMessages(r, compacted.messages(), 'devin');
    assert.deepEqual(view(r), [['user', 'u0'], ['assistant', 'a1'], ['user', 'u2'], ['assistant', 'a3'], ['user', 'u4'], ['assistant', 'a5']]);
    assert.deepEqual(uuids(r).slice(0, 4), ['devin:nid:nid:user:0', 'devin:nid:nid:assistant:1', 'devin:nid:nid:user:2', 'devin:nid:nid:assistant:3']);
    t.ok('修正前の位置の UUID の記録に圧縮の再生が来ても、同じ UUID の別の発言を上書きせず、増えた行は別の UUID で足す', new Set(uuids(r)).size === 6);
    const before = uuids(r);
    mergeMessages(r, compacted.messages(), 'devin');
    t.ok('同じ再生の読み直しで、足した行が重ならない', r.messages.length === 6 && uuids(r).every((u, i) => u === before[i]));
  }

  // ---- 再起動の後の再生（キャッシュの無い mapper）でも原文に戻す。全文が一致したときだけ
  {
    const r = record(), mapper = createDevinMapper('nid');
    const spaced = turnOf('f(a,  b)', 'two spaces'), single = turnOf('f(a, b)', 'one space');
    mergeMessages(r, live(mapper, spaced).messages(), 'devin');
    mergeMessages(r, live(mapper, single).messages(), 'devin');
    const before = uuids(r);
    mergeMessages(r, replay([spaced, single]).messages(), 'devin');
    assert.deepEqual(view(r), [['user', 'f(a,  b)'], ['assistant', 'two spaces'], ['user', 'f(a, b)'], ['assistant', 'one space']]);
    assert.deepEqual(uuids(r), before);
    t.ok('再起動の後の再生でも原文に戻し、空白だけ違う別の本文を取り違えない', true);
    const crlf = { ...single, sent: single.sent.replace(/\n/g, '\r\n') };
    mergeMessages(r, replay([spaced, crlf]).messages(), 'devin');
    t.ok('改行コードだけが違う全文も同じ発言として原文に戻す', r.messages.length === 4 && r.messages[2].text === 'f(a, b)');
    const unknown = turnOf('never recorded', 'reply');
    mergeMessages(r, replay([spaced, single, unknown]).messages(), 'devin');
    t.ok('記録に無いターン（Pleiad の外で打った分）は、送った全文のまま足す（推測で剥がさない）', r.messages.length === 6 && r.messages[4].text === unknown.sent);
  }

  // ---- 引き継ぎの文（バックエンドの切り替え）: 先頭のメモや `!` の結果が付いても原文に戻し、record.injected を消した後の再生でも戻る
  {
    const handoff = 'HANDOFF: read the transcript at C:/x.json\n\nUser: orig';
    const r = { ...record(), injected: handoff, original: 'orig' };
    const mapper = createDevinMapper('nid');
    const note = '<pleiad-note>\nnote\n</pleiad-note>', shell = '$ ls\nfile.txt';
    const plain = turnOf(handoff, 'first'), noted = turnOf(`${shell}\n\n${note}\n\n${handoff}`, 'second');
    mergeMessages(r, live(mapper, plain).messages(), 'devin');
    mergeMessages(r, live(mapper, noted).messages(), 'devin');
    assert.deepEqual(view(r).filter(([role]) => role === 'user'), [['user', 'orig'], ['user', `${shell}\n\n${note}\n\norig`]]);
    t.ok('引き継ぎの文は、メモや `!` の結果が前に付いた行でも原文に戻る', true);
    const before = uuids(r), shape = view(r);
    // 再生の全文（指示 + `!` の結果 + メモ + 引き継ぎの文）は、末尾の引き継ぎの文を書き換える前の全文のハッシュで原文に戻す
    mergeMessages(r, replay([plain, noted]).messages(), 'devin');
    assert.deepEqual(view(r), shape); assert.deepEqual(uuids(r), before);
    t.ok('指示と引き継ぎの文とメモの再生は、引き継ぎの印が残っている間も原文のまま重ならない', true);
    delete r.injected; delete r.original;
    mergeMessages(r, replay([plain, noted]).messages(), 'devin');
    assert.deepEqual(view(r), shape); assert.deepEqual(uuids(r), before);
    t.ok('引き継ぎの印を消した後の再生でも原文のまま', r.messages[0].text === 'orig' && r.messages[2].text === `${shell}\n\n${note}\n\norig`);
    // 修正前の記録（送った全文のまま・ハッシュ無し）に引き継ぎの印が残っていても、再生の行の末尾だけを書き換えて別の行にしない
    const legacy = { ...record(), injected: handoff, original: 'orig', messages: [
      { uuid: 'devin:nid:nid:user:0', role: 'user', text: noted.sent, backend: 'devin' },
      { uuid: 'devin:nid:nid:assistant:1', role: 'assistant', text: 'second', backend: 'devin' }] };
    mergeMessages(legacy, replay([noted]).messages(), 'devin');
    t.ok('修正前の全文の発言は、引き継ぎの印が残っていても再生で重ならない', legacy.messages.length === 2 && legacy.messages[0].text === noted.sent);
    // 修正前の記録が原文（ハッシュ無し）で、指示を足さずに送った引き継ぎの文がそのまま再生で返る
    const bare = { ...record(), injected: handoff, original: 'orig', messages: [
      { uuid: 'devin:nid:nid:user:0', role: 'user', text: 'orig', backend: 'devin' },
      { uuid: 'devin:nid:nid:assistant:1', role: 'assistant', text: 'first', backend: 'devin' }] };
    const unprefixed = createDevinMapper('nid');
    for (const update of [chunk('user', handoff), chunk('agent', 'first')]) unprefixed.accept(update);
    mergeMessages(bare, unprefixed.messages(), 'devin');
    assert.deepEqual(view(bare), [['user', 'orig'], ['assistant', 'first']]);
    t.ok('修正前の原文の発言（ハッシュ無し）は、引き継ぎの文と全文が一致する再生で原文に戻り重ならない', bare.messages[0].uuid === 'devin:nid:nid:user:0');
    const codex = { base: 0, messages: [], injected: 'handoff', original: 'orig' };
    mergeMessages(codex, [{ uuid: 'u', role: 'user', text: 'handoff' }, { uuid: 'v', role: 'user', text: 'note\n\nhandoff' }], 'codex');
    t.ok('ほかのバックエンドの引き継ぎの戻しも同じに効く', codex.messages[0].text === 'orig' && codex.messages[1].text === 'note\n\norig');
  }

  // ---- 途中送信の発言（回の途中の user_message_chunk）も再生で重ならない
  {
    const r = record(), mapper = createDevinMapper('nid');
    const turn = turnOf('start', 'working', chunk('user', 'steer-note'), 'steered');
    mergeMessages(r, live(mapper, turn).messages(), 'devin');
    assert.deepEqual(view(r), [['user', 'start'], ['assistant', 'working'], ['user', 'steer-note'], ['assistant', 'steered']]);
    const before = uuids(r);
    mergeMessages(r, replay([turn]).messages(), 'devin');
    t.ok('途中送信の発言を含むターンも、再生で数と UUID を保つ', r.messages.length === 4 && uuids(r).every((u, i) => u === before[i]));
    // 返答の前に届いた途中送信は、同じ発言の行に続く。再生でも同じ行に続くので、送った全文にも足しておく
    const early = turnOf('begin', chunk('user', 'early-steer'), 'reply');
    mergeMessages(r, live(mapper, early).messages(), 'devin');
    assert.deepEqual(view(r).slice(-2), [['user', 'beginearly-steer'], ['assistant', 'reply']]);
    const grown = uuids(r);
    mergeMessages(r, replay([turn, early]).messages(), 'devin');
    t.ok('返答の前の途中送信を含む発言も、再生で原文のまま重ならない', r.messages.length === 6 && uuids(r).every((u, i) => u === grown[i]));
  }

  // ---- 長い会話: 照合の表を作れない長さでも、時間とメモリを使い切らずに行を失わない
  {
    const turns = Array.from({ length: 3000 }, (_, i) => turnOf(i % 3 ? `step ${i}` : 'OK', i % 2 ? 'X' : `answer ${i}`));
    const r = record();
    mergeMessages(r, replay(turns).messages(), 'devin');
    const before = uuids(r), started = performance.now();
    // 最後に再生にだけある行が来ると、末尾の一致で済まず、残りの照合に回る
    const extra = replay(turns); extra.accept(chunk('user', 'native only'));
    mergeMessages(r, extra.messages(), 'devin');
    const elapsed = performance.now() - started;
    assert.equal(r.messages.length, 6001);
    assert.deepEqual(uuids(r).slice(0, 6000), before);
    t.ok('6000 行の再生の照合を上限の内で終え、全部の行を保って 1 行だけ足す', elapsed < 5000, `${Math.round(elapsed)} ms`);
  }

  // ---- Grok の mapper も同じ形（指示を前に足して送り、再生は位置の UUID）
  {
    const r = record(), mapper = createGrokMapper('nid');
    const one = turnOf('User original', 'First answer'), two = turnOf('Second original', 'Second answer');
    mergeMessages(r, live(mapper, one).messages(), 'grok');
    mergeMessages(r, live(mapper, two).messages(), 'grok');
    const before = uuids(r);
    const replayed = createGrokMapper('nid');
    for (const update of [chunk('user', two.sent), chunk('agent', 'Second answer')]) replayed.accept(update);
    mergeMessages(r, replayed.messages(), 'grok');
    assert.deepEqual(view(r), [['user', 'User original'], ['assistant', 'First answer'], ['user', 'Second original'], ['assistant', 'Second answer']]);
    t.ok('Grok でも、発言は原文で記録し、位置のずれた再生で前の行を上書きしない', uuids(r).every((u, i) => u === before[i]));
  }
}
