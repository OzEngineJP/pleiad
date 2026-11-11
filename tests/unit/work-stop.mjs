// 子の会話のモーダルの中断ボタン（web/work-stop.mjs。ADR 0317）: 出す条件・押せるか・押すと何を送るか。
//   見た目と、押して本当に止まるかは実ブラウザーの tests/browser/work-dialog-stop.mjs が見る
import { workStop } from '../../web/work-stop.mjs';

export const name = 'work-stop';
export const title = '子の会話のモーダルの中断ボタン（出す条件・ホストの子は中断だけ・ネイティブ／ホストの孫は出さない）';

export default async function(t) {
  const child = (o = {}) => ({ source: 'task', taskId: 't1', childId: 's1', taskStatus: 'running', live: true, ...o });
  const plan = (item, o = {}) => workStop({ item, ...o });

  // ---- 出す条件（入力欄のある子）
  t.ok('走っているターンがあれば出す（abort）', JSON.stringify(plan(child(), { running: true })) === '{"show":true,"disabled":false,"solo":false,"via":"abort"}');
  t.ok('承認を待っていれば、ターンが走っていなくても出す', plan(child({ waiting: true }), { approval: true }).show === true);
  t.ok('順番待ち（queued）なら出す', plan(child({ taskStatus: 'queued' })).show === true);
  t.ok('ターンの外で、孫が走っているのを待っているなら出す', plan(child(), { grandchild: true }).show === true);
  t.ok('孫がいても、子のタスクが終わっていれば出さない', plan(child({ live: false, taskStatus: 'done' }), { grandchild: true }).show === false);
  t.ok('終わった子には出さない（再開は送信で行う）', plan(child({ live: false, taskStatus: 'done' })).show === false);
  t.ok('走っておらず・待ってもいない running のタスクには出さない', plan(child()).show === false);

  // ---- 押せるか
  t.ok('中断を受け付けた後は押せない', plan(child(), { running: true, stopping: true }).disabled === true);
  t.ok('タスクが取り消し中なら押せない', plan(child({ taskStatus: 'cancelling' }), { running: true }).disabled === true);
  t.ok('出さないときは disabled にもしない', plan(child({ live: false, taskStatus: 'done' }), { stopping: true }).disabled === false);

  // ---- ホストに任せた子（根）: 中断だけ・cancelAgentTask
  const host = (o = {}) => ({ source: 'task', taskId: 't2', host: true, taskStatus: 'running', live: true, ...o });
  t.ok('ホストの子（根）は中断だけを単独で出し、cancelAgentTask を送る', JSON.stringify(plan(host())) === '{"show":true,"disabled":false,"solo":true,"via":"cancelAgentTask"}');
  t.ok('ホストの子が承認待ちでも出す', plan(host({ live: false, waiting: true })).show === true);
  t.ok('ホストの子が終わっていれば出さない', plan(host({ live: false, taskStatus: 'done' })).show === false);
  t.ok('ホストの子が取り消し中なら押せない', plan(host({ taskStatus: 'cancelling' })).disabled === true);

  // ---- 出さないもの
  t.ok('ホストの孫には何も出さない', plan(host({ hostDescendant: true }), { running: true }).show === false);
  t.ok('ネイティブのサブエージェント（task ではない）には出さない', plan({ source: 'subagent', childId: 's9' }, { running: true }).show === false);
  t.ok('taskId の無い項目には出さない', plan(child({ taskId: null }), { running: true }).show === false);
  t.ok('子の会話の id が無ければ出さない', plan(child({ childId: null }), { running: true }).show === false);
  t.ok('項目が無ければ出さない', plan(null, { running: true }).show === false && workStop().show === false);
}
