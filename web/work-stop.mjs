// 子の会話のモーダルの「中断」ボタン（ADR 0317）。入力欄の中断ボタン（メインと同じ形）を、いま詳細に出している子に使う。
// ここは「出すか・押せるか・押すと何を送るか」を決めるだけの純粋な関数（描画と送信は web/client.mjs・web/composer/work-composer.mjs）。
//
// 出す条件（メインの入力欄の「走っている、または承認を待っている」に、モーダルでだけ要る 2 つを足した）:
//   - 子のターンが走っている（running）
//   - 子が人間の承認を待っている（approval）
//   - 子のタスクが順番待ち（queued）
//   - ターンの外で、子から出した孫のタスクが終わるのを待っている（item.live で、孫が走っている）
// 押すと送るもの:
//   - 入力欄のある子: 「中断」（abort。その会話のターンを止め、その子のタスクと孫も取り消す）。メインの中断ボタンと同じ
//   - ホストに任せた子（根）: 入力欄は無く、中断だけを入力欄の位置に出す。abort は別の PC に届かないので、タスクの取り消し（cancelAgentTask）を送る
//   - ネイティブのサブエージェント・ホストの孫: 何も出さない（止める口はメインの会話の側）

/**
 * @param {object} o
 * @param {object|null} o.item 詳細に出している項目（backgroundItems の行）
 * @param {boolean} o.running 子のターンが走っている（state.runningIds）
 * @param {boolean} o.approval 子が人間の承認を待っている（ターンを止めるものだけ）
 * @param {boolean} o.grandchild 子から出したタスクが走っている・待っている
 * @param {boolean} o.stopping 中断を受け付けて、止まり終えるのを待っている
 * @returns {{ show: boolean, disabled: boolean, solo: boolean, via: 'abort'|'cancelAgentTask'|null }}
 */
export function workStop({ item, running = false, approval = false, grandchild = false, stopping = false } = {}) {
  const none = { show: false, disabled: false, solo: false, via: null };
  if (!item || item.source !== 'task' || item.hostDescendant || !item.taskId) return none;
  const cancelling = item.taskStatus === 'cancelling';
  if (item.host) {
    return { show: Boolean(item.live || item.waiting), disabled: cancelling, solo: true, via: 'cancelAgentTask' };
  }
  if (!item.childId) return none;
  const queued = item.taskStatus === 'queued';
  const waitingOnGrandchild = Boolean(item.live) && grandchild;
  const show = running || approval || queued || waitingOnGrandchild;
  return { show, disabled: show && (stopping || cancelling), solo: false, via: 'abort' };
}
