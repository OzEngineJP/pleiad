// 委譲の子への追加指示（ply_task_send）を会話の中の受け付けた位置へ置く置き場の単体検証。
// 位置は受付の出来事（taskInstructionId）・配送の id（deliveryId=native 履歴 messageId）・届いた発言の id（nativeId）・
// 受付時の錨（anchor）・受付時刻（at）で引き、件数や本文の一致には頼らない（Issue #109 / #106）
import { injectTaskInstructions } from '../../web/task-instructions.mjs';

export const name = 'task-instructions';
export const title = '追加指示は受け付けた位置・IDで会話に置き、件数・本文の照合に頼らない';

const at = ms => ms;   // 指示の at は epoch ms（画面の仕掛けと同じ）
// 並びを読みやすく: 発言は msg:<index>、指示の行はその instruction id
const seq = out => out.map((x, i) => x.role === 'instruction' ? x.instruction.id : `m${i - out.slice(0, i).filter(y => y.role === 'instruction').length}`);

export default function (t) {
  for (const state of ['queued', 'sending', 'delivered']) {
    const instructions = [{ id: 'x', text: 'extra', state, at: at(20), deliveryId: 'task-send-x', anchor: { kind: 'uuid', v: 'before' } }];
    const messages = [{ role: 'assistant', uuid: 'before', text: 'before' }, { role: 'assistant', text: 'after' },
      { role: 'user', text: 'extra', messageId: 'task-send-x' }];
    const out = injectTaskInstructions(instructions, messages);
    t.ok(`次ターンの入力行より受付位置を優先する（${state}）`, out.map(m => m.text).join('|') === 'before|extra|after');
  }
  {
    const instructions = [{ id: 'x', text: 'extra', state: 'delivered', at: at(20), deliveryId: 'task-send-x' }];
    const messages = [{ role: 'assistant', text: 'before', at: at(10) }, { role: 'assistant', text: 'after', at: at(30) },
      { role: 'user', text: 'extra', messageId: 'task-send-x', at: at(40) }];
    t.ok('錨がない次ターン配送も受付時刻を使う', injectTaskInstructions(instructions, messages).map(m => m.text).join('|') === 'before|extra|after');
  }
  {
    const instructions = [{ id: 'x', text: 'X', state: 'delivered', deliveryId: 'task-send-x', anchor: { kind: 'uuid', v: 'a' } },
      { id: 'y', text: 'Y', state: 'delivered', deliveryId: 'task-send-x', anchor: { kind: 'uuid', v: 'b' } }];
    const messages = [{ role: 'assistant', uuid: 'a', text: 'A' }, { role: 'assistant', uuid: 'b', text: 'B' },
      { role: 'user', text: 'X\n\nY', messageId: 'task-send-x' }];
    t.ok('次ターンでまとめて届いても各指示の受付位置を保つ', injectTaskInstructions(instructions, messages).map(m => m.text).join('|') === 'A|X|B|Y');
  }
  {
    const instructions = [{ id: 'x', text: 'partial', state: 'delivered', deliveryId: 'task-send-x' }];
    const messages = [{ role: 'user', text: 'partial\n\nnot-fetched', messageId: 'task-send-x' }];
    const out = injectTaskInstructions(instructions, messages);
    t.ok('次ターンの入力に未取得の指示が含まれるときは消さない', out.length === 1 && out[0] === messages[0]);
  }
  {
    const instructions = Array.from({ length: 4 }, (_, n) => ({ id: String(n), text: 'same', state: 'queued', anchor: { kind: 'tool', v: 'tool' } }));
    const messages = [{ role: 'assistant', text: 'before', toolCalls: [{ id: 'tool' }, { id: 'later' }] }];
    const out = injectTaskInstructions(instructions, messages);
    t.ok('同じ位置への連続指示の受付順を保つ', out.filter(m => m.role === 'instruction').map(m => m.instruction.id).join() === '0,1,2,3');
    t.ok('ツールを分割しても本文は重複しない', out.filter(m => m.role === 'assistant').map(m => m.text).join('') === 'before');
  }
  // 走っているターンの受付の出来事（marker）は、その位置に指示を置く（出来事が畳まれた順＝受け付けた順）
  {
    const instructions = [
      { id: 'x', text: 'X', at: at(10), state: 'sending' },
      { id: 'y', text: 'Y', at: at(20), state: 'queued' },
    ];
    const messages = [
      { role: 'user', text: 'request' },
      { role: 'assistant', text: 'outputA' },
      { role: 'user', taskInstructionId: 'x', text: 'X' },
      { role: 'assistant', text: 'outputB' },
      { role: 'user', taskInstructionId: 'y', text: 'Y' },
    ];
    t.ok('受付の出来事の位置に置く（outputA → X → outputB → Y）',
      JSON.stringify(seq(injectTaskInstructions(instructions, messages))) === JSON.stringify(['m0', 'm1', 'x', 'm2', 'y']),
      JSON.stringify(seq(injectTaskInstructions(instructions, messages))));
  }
  // 同じ本文が続いても ID で区別する。届いた履歴行（nativeId）は消し、指示の行は受付位置に残す
  {
    const instructions = [
      { id: 'one', text: 'same', at: at(1), state: 'delivered', nativeId: 'n1' },
      { id: 'two', text: 'same', at: at(2), state: 'sending' },
      { id: 'three', text: 'same', at: at(3), state: 'queued' },
    ];
    const messages = [
      { role: 'user', text: 'request', at: at(0) },
      { role: 'user', uuid: 'n1', text: 'same', at: at(4) },          // 届いた位置（受付後の出力より後ろにありうる）
      { role: 'user', taskInstructionId: 'two', text: 'same' },
    ];
    const out = injectTaskInstructions(instructions, messages);
    t.ok('届いた履歴行は消し、指示の行は受け付けた時刻の位置に残す（届いた位置へは動かさない）',
      JSON.stringify(seq(out)) === JSON.stringify(['m0', 'one', 'two', 'three']), JSON.stringify(seq(out)));
  }
  // marker と nativeId の行が同時にある（ライブのまま履歴を読んだ等）ときも、同じ指示を二重に出さない
  {
    const instructions = [{ id: 'x', text: 'dup', at: at(1), state: 'delivered', nativeId: 'n1', deliveryId: 'task-send-x' }];
    const messages = [
      { role: 'user', taskInstructionId: 'x', text: 'dup' },
      { role: 'user', uuid: 'n1', text: 'dup' },
      { role: 'user', messageId: 'task-send-x', text: 'dup' },
    ];
    const out = injectTaskInstructions(instructions, messages);
    t.ok('同じ指示が複数の印に引っかかっても 1 か所にだけ出る', out.filter(x => x.instruction?.id === 'x').length === 1, JSON.stringify(seq(out)));
  }
  // ターンを始めた発言（deliveryId=messageId の行）は batch 全員で肩代わりする
  {
    const instructions = [
      { id: 'a', text: 'one', at: at(1), state: 'delivered', deliveryId: 'task-send-a' },
      { id: 'b', text: 'two', at: at(2), state: 'sending', deliveryId: 'task-send-a' },
    ];
    const messages = [
      { role: 'user', text: 'request' },
      { role: 'user', messageId: 'task-send-a', text: 'one\n\ntwo' },
      { role: 'assistant', text: 'answer' },
    ];
    t.ok('ターン開始の入力の行は、積まれた指示全員の行に置き換わる',
      JSON.stringify(seq(injectTaskInstructions(instructions, messages))) === JSON.stringify(['m0', 'a', 'b', 'm1']),
      JSON.stringify(seq(injectTaskInstructions(instructions, messages))));
  }
  // 届いた行の本文に取得できていない分が混ざる可能性があるときは、その行は消さない（指示も出さない）
  {
    const instructions = [{ id: 'a', text: 'part', at: at(1), state: 'delivered', nativeId: 'n9' }];
    const messages = [{ role: 'user', uuid: 'n9', text: 'part\n\nnot-fetched' }];
    const out = injectTaskInstructions(instructions, messages);
    t.ok('届いた行に未取得の分が混ざる可能性があるときは、履歴の行を消さない',
      out.length === 1 && out[0].role === 'user', JSON.stringify(seq(out)));
  }
  // 受付時の錨（anchor）: 直前のツール呼び出しを指す。時刻も marker も無い読み直し後でも同じ位置へ戻る
  {
    const instructions = [{ id: 'x', text: 'X', at: at(99), state: 'delivered', nativeId: 'n1', anchor: { kind: 'tool', v: 'tc-1' } }];
    const messages = [
      { role: 'user', text: 'request' },                                        // 時刻なし
      { role: 'assistant', toolCalls: [{ id: 'tc-1', name: 'Bash' }] },         // 受付直前の出力（錨）
      { role: 'assistant', toolCalls: [{ id: 'tc-2', name: 'Bash' }] },         // 受付後の出力
      { role: 'user', uuid: 'n1', text: 'X' },                                  // 届いた発言（消す）
      { role: 'assistant', text: 'later' },
    ];
    const out = injectTaskInstructions(instructions, messages);
    t.ok('錨の指す発言（ツール呼び出し）の直後に置く（時刻の無い履歴でも元の位置）',
      JSON.stringify(seq(out)) === JSON.stringify(['m0', 'm1', 'x', 'm2', 'm3']), JSON.stringify(seq(out)));
  }
  // 錨のツール呼び出しが発言の途中にあるとき（同じ発言に受付後の呼び出しが続く）、発言を錨の位置で分ける
  {
    const instructions = [{ id: 'x', text: 'X', at: at(99), state: 'delivered', nativeId: 'n1', anchor: { kind: 'tool', v: 'tc-1' } }];
    const messages = [
      { role: 'user', text: 'request' },
      { role: 'assistant', toolCalls: [{ id: 'tc-1', name: 'Bash' }, { id: 'tc-2', name: 'Read' }] },  // tc-1 が受付直前、tc-2 が受付後
      { role: 'user', uuid: 'n1', text: 'X' },
    ];
    const out = injectTaskInstructions(instructions, messages);
    t.ok('発言を錨の位置で分け、受付後のツール呼び出しは指示の後ろに残る',
      out.length === 4 && out[1].toolCalls.length === 1 && out[2].role === 'instruction' && out[3].toolCalls.length === 1,
      JSON.stringify(out.map(x => x.role === 'instruction' ? x.instruction.id : (x.toolCalls ?? []).map(c => c.id).join('+'))));
  }
  // 錨が直前の指示を指すとき（連続して受け付けた）、その指示の直後に続く
  {
    const instructions = [
      { id: 'a', text: 'A', at: at(1), state: 'sending' },
      { id: 'b', text: 'B', at: at(2), state: 'queued', anchor: { kind: 'instruction', v: 'a' } },
    ];
    const messages = [{ role: 'user', taskInstructionId: 'a', text: 'A' }, { role: 'assistant', text: 'x' }];
    t.ok('錨が直前の指示ならその直後に並ぶ', JSON.stringify(seq(injectTaskInstructions(instructions, messages))) === JSON.stringify(['a', 'b', 'm0']));
  }
  // 時刻だけの手がかり（ID が無い古い記録）: 受付時刻の位置に置く
  {
    const messages = [
      { role: 'user', text: 'req', at: at(10) },
      { role: 'assistant', text: 'a' },
      { role: 'assistant', text: 'b', at: at(20) },
    ];
    const instructions = [
      { id: 'y', text: 'Y', at: at(5), state: 'queued' },
      { id: 'x', text: 'X', at: at(15), state: 'sending' },
    ];
    t.ok('ID の無い分は受付時刻で置く（時刻の無い行は前の行の時刻を引き継ぐ）',
      JSON.stringify(seq(injectTaskInstructions(instructions, messages))) === JSON.stringify(['y', 'm0', 'm1', 'x', 'm2']),
      JSON.stringify(seq(injectTaskInstructions(instructions, messages))));
  }
  // 配送済みで ID・錨・確かめられた履歴行のどれも無いものは、履歴の発言が引き継ぐ（推測で出さない）
  {
    const instructions = [{ id: 'x', text: 'done', at: at(1), state: 'delivered' }];
    const out = injectTaskInstructions(instructions, [{ role: 'assistant', text: 'a' }]);
    t.ok('ID の無い配送済みは別の行を出さない（履歴の発言が引き継ぐ）', out.length === 1 && out[0].role === 'assistant');
  }
  // 届いたのに履歴行が無い分（圧縮で消えた等）は、nativeId があるので指示の行を残す
  {
    const instructions = [{ id: 'gone', text: 'G', at: at(2), state: 'delivered', nativeId: 'n1' }];
    const messages = [{ role: 'assistant', text: 'a', at: at(1) }];
    t.ok('届いたのに履歴行が無い分は、指示の行を残す',
      JSON.stringify(seq(injectTaskInstructions(instructions, messages))) === JSON.stringify(['m0', 'gone']));
  }
}
