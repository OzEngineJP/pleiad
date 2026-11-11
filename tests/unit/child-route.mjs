// 会話を開くときの行き先（web/child-route.mjs。ADR 0318）。委譲の子（孫を含む）は依頼元の根をメインに、子はモーダルで開く。
import { isRootRow, childRoute, restoredSession } from '../../web/child-route.mjs';
import { slimRow } from '../../core/session-list-delta.mjs';

export const name = 'child-route';
export const title = '会話を開く行き先: 子（孫）は根をメインに・子をモーダルに。根の例外（依頼元を消した子・端末の子）と古い記録の扱い、保存した id の読み替え';

export default async function (t) {
  const row = (id, delegation = null) => ({ id, title: id, delegation });
  const sessions = [
    row('root'),
    row('child', { parentSessionId: 'root', taskId: 'ply-task-1' }),
    row('grand', { parentSessionId: 'child', taskId: 'ply-task-2' }),
    row('great', { parentSessionId: 'grand', taskId: 'ply-task-3' }),
    row('old', { parentSessionId: 'root' }),                                                     // taskId が無い古い記録
    row('orphan', { parentSessionId: 'deleted', taskId: 'ply-task-9' }),                         // 依頼元を消した子（ADR 0147）
    row('remote', { parentSessionId: 'root', taskId: 'ply-task-8', remote: { deviceId: 'd1' } }), // 端末の AI から任された子
    row('loopA', { parentSessionId: 'loopB', taskId: 'a' }),
    row('loopB', { parentSessionId: 'loopA', taskId: 'b' }),
  ];
  const j = JSON.stringify;

  t.ok('ふつうの会話は null（メインで開く）', childRoute('root', sessions) === null);
  t.ok('子は根と taskId・深さ 1', j(childRoute('child', sessions)) === j({ root: 'root', taskId: 'ply-task-1', depth: 1 }), j(childRoute('child', sessions)));
  t.ok('孫は根まで辿り、自分の taskId・深さ 2', j(childRoute('grand', sessions)) === j({ root: 'root', taskId: 'ply-task-2', depth: 2 }), j(childRoute('grand', sessions)));
  t.ok('ひ孫も根まで辿る', childRoute('great', sessions)?.root === 'root' && childRoute('great', sessions)?.depth === 3);
  t.ok('taskId が無い古い記録の子は taskId が null（根だけを開く）', j(childRoute('old', sessions)) === j({ root: 'root', taskId: null, depth: 1 }), j(childRoute('old', sessions)));
  t.ok('依頼元を消した子は根として扱う（メインで開く）', childRoute('orphan', sessions) === null && isRootRow(sessions[5], new Set(sessions.map((s) => s.id))));
  t.ok('端末の AI から任された子（delegation.remote）は根として扱う', childRoute('remote', sessions) === null);
  t.ok('一覧に無い id は null（そのまま select する）', childRoute('nowhere', sessions) === null && childRoute('x', undefined) === null);
  t.ok('親子が輪になった壊れた記録は子として扱わない', childRoute('loopA', sessions) === null && childRoute('loopB', sessions) === null);

  // 孫の親が一覧から落ちたら、その孫は根になる（脇の一覧が出す行と同じ決まり）
  const cut = sessions.filter((s) => s.id !== 'child');
  t.ok('途中の親が一覧に無ければ、その子が根', childRoute('grand', cut) === null);

  // ---- 保存した id の読み替え（起動・つなぎ直し）
  t.ok('保存していた子の id は根になる', restoredSession('child', sessions) === 'root' && restoredSession('grand', sessions) === 'root');
  t.ok('ふつうの会話・根の例外・知らない id はそのまま', restoredSession('root', sessions) === 'root' && restoredSession('orphan', sessions) === 'orphan'
    && restoredSession('remote', sessions) === 'remote' && restoredSession('nowhere', sessions) === 'nowhere' && restoredSession('child', []) === 'child');

  // ---- 画面に届く行（slimRow）でも同じに引ける: taskId が届く
  const slimmed = sessions.map((s) => slimRow({ ...s, delegation: s.delegation && { ...s.delegation, manager: 'ply' } }));
  t.ok('slimRow を通した行でも子の taskId と根が引ける', j(childRoute('grand', slimmed)) === j({ root: 'root', taskId: 'ply-task-2', depth: 2 }), j(childRoute('grand', slimmed)));
}
