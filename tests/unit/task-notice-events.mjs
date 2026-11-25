// 完了通知の「これまでの出来事」の行と「結果」「エラー」の段落（ADR 0355 §7。core/task-notice-events.mjs）。文だけを確かめる。
//   - 子が止まっている: 最後の回の返答は「結果」の段落に載せ、出来事の行には載せない（同じ返答を 2 度載せない）
//   - 結果を書かずに止まった回（始まる前・取り直しの途中で止めた）: 行に残る前の回の結果を「結果」として出さない
//   - 子が動いている: 「結果」「エラー」の段落を出さず、どの回の返答も出来事の行に 1 度だけ載る
//   - 例外で失敗した回（エラーだけ）: 「エラー」は出し、「結果」は出さない
//   - 出来事を持たない古い行: 今までどおり「結果」を出す
import { agentT } from '../../core/i18n.mjs';
import { eventsNotice, noticeResultParts } from '../../core/task-notice-events.mjs';

export const name = 'task-notice-events';
export const title = '完了通知の出来事の行と「結果」「エラー」の段落: 止まっている・結果を書かずに止まった・動いている・失敗・古い行';

const run = (status, extra = {}) => ({ id: `e-${Math.random()}`, at: 1, kind: 'run', status, stoppedBy: null, cause: [], result: '', ...extra });
const count = (text, part) => text.split(part).length - 1;

export default async function(t) {
  const heading = agentT('ja', 'delegation.noticeResult', { text: '', more: '' }).split('\n')[0];
  t.ok('「結果」の見出しが取れる', heading.length > 0 && !heading.includes('{{'), heading);

  // ---- 止まっていて、最後の回が返答を書いた
  {
    const task = { status: 'completed', result: 'もう終わりました', error: null, events: [run('completed', { result: 'もう終わりました' })] };
    const parts = noticeResultParts('ja', task, 16000);
    const lines = eventsNotice('ja', task);
    t.ok('止まっている子: 最後の回の返答は「結果」の段落に載る', parts.result.includes(heading) && parts.result.includes('もう終わりました'), JSON.stringify(parts));
    t.ok('止まっている子: 同じ返答は出来事の行に載せない', !lines.includes('もう終わりました') && lines.includes(agentT('ja', 'delegation.eventEndCompleted')), lines);
  }

  // ---- 長い結果は limit 字で切り、続きの読み方を添える
  {
    const task = { status: 'completed', result: 'あ'.repeat(30), error: null, events: [run('completed', { result: 'あ'.repeat(30) })] };
    const parts = noticeResultParts('ja', task, 10);
    t.ok('結果は limit 字で切り、offset の案内を添える', parts.result.includes('あ'.repeat(10)) && !parts.result.includes('あ'.repeat(11)) && parts.result.includes('offset: 10'), parts.result);
  }

  // ---- 結果を書かずに止まった回: 行の result は前の回のまま
  {
    const task = { status: 'cancelled', stoppedBy: 'parent', result: '前の回の結果', error: null, events: [run('cancelled', { stoppedBy: 'parent' })] };
    const parts = noticeResultParts('ja', task, 16000);
    const lines = eventsNotice('ja', task);
    t.ok('結果を書かずに止まった回: 前の回の結果を「結果」として出さない', parts.result === '' && parts.error === '', JSON.stringify(parts));
    t.ok('結果を書かずに止まった回: 行にも前の回の結果は出ず、止めた側は出る', !lines.includes('前の回の結果') && lines.includes(agentT('ja', 'delegation.eventEndParent')), lines);
  }

  // ---- 動いている子: 終わった回の返答は行に 1 度だけ
  {
    const task = { status: 'running', result: '途中までの返答', error: null, events: [
      run('cancelled', { stoppedBy: 'human', result: '途中までの返答' }),
      { id: 'h', at: 2, kind: 'human', text: 'つぎはこれ', attachments: 0 },
    ] };
    const parts = noticeResultParts('ja', task, 16000);
    const lines = eventsNotice('ja', task);
    const all = parts.result + parts.error + lines;
    t.ok('動いている子: 「結果」「エラー」の段落を出さない', parts.result === '' && parts.error === '', JSON.stringify(parts));
    t.ok('動いている子: 終わった回の返答は出来事の行に 1 度だけ載る', count(all, '途中までの返答') === 1 && lines.includes(agentT('ja', 'delegation.eventPartial', { text: '途中までの返答' })), lines);
    t.ok('動いている子: 人が止めた・人の指示・今は動いている が載る', lines.includes(agentT('ja', 'delegation.eventEndHuman')) && lines.includes('つぎはこれ')
      && lines.includes(agentT('ja', 'delegation.eventStateRunning')), lines);
  }

  // ---- 例外で失敗した回（エラーだけ、返答なし）
  {
    const task = { status: 'failed', result: '前の回の結果', error: 'boom', events: [run('failed', { error: 'boom' })] };
    const parts = noticeResultParts('ja', task, 16000);
    const lines = eventsNotice('ja', task);
    t.ok('エラーだけの回: 「エラー」は出し、前の回の結果を「結果」として出さない', parts.error === 'boom' && parts.result === '', JSON.stringify(parts));
    t.ok('エラーだけの回: エラーは行に重ねて載せない', count(parts.error + lines, 'boom') === 1, lines);
  }

  // ---- 止まった子で、前の回（行に載る）と最後の回（結果の段落に載る）の返答
  {
    const task = { status: 'completed', result: '二回目', error: null, events: [
      run('completed', { result: '一回目' }),
      { id: 'h', at: 2, kind: 'human', text: 'もう一度', attachments: 0 },
      run('completed', { result: '二回目', cause: ['human'] }),
    ] };
    const parts = noticeResultParts('ja', task, 16000);
    const lines = eventsNotice('ja', task);
    const all = parts.result + lines;
    t.ok('前の回の返答は行に、最後の回の返答は「結果」に、それぞれ 1 度だけ', count(all, '一回目') === 1 && count(all, '二回目') === 1
      && lines.includes('一回目') && parts.result.includes('二回目') && lines.includes(agentT('ja', 'delegation.wakeHuman')), lines);
  }

  // ---- 出来事を持たない古い行（版を上げる前に積まれた通知）
  {
    const task = { status: 'completed', result: '古い結果', error: null };
    const parts = noticeResultParts('ja', task, 16000);
    const lines = eventsNotice('ja', task);
    t.ok('古い行: 「結果」を今までどおり出す', parts.result.includes('古い結果'), JSON.stringify(parts));
    t.ok('古い行: 状態から回の終わりを 1 行組み立てる', lines.includes(agentT('ja', 'delegation.eventEndCompleted')) && !lines.includes('古い結果'), lines);
  }

  // ---- 英語でも同じ形
  {
    const task = { status: 'cancelled', stoppedBy: 'human', result: 'old', error: null, events: [run('cancelled', { stoppedBy: 'human' })] };
    const parts = noticeResultParts('en', task, 16000);
    const lines = eventsNotice('en', task);
    t.ok('英語: 結果を書かずに止まった回は「結果」を出さない', parts.result === '' && !lines.includes('old') && lines.includes(agentT('en', 'delegation.eventEndHuman')), lines);
  }
}
