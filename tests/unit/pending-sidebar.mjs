import { readFileSync } from 'node:fs';
import { overlaySessions, revertFailed, currentRows } from '../../web/pending-sidebar.mjs';

export const name = 'pending-sidebar';
export const title = '脇の楽観的な更新・失敗時の巻き戻し・削除確認';

export default function (t) {
  const old = [{ id: 'a', status: '進行中', ungrouped: false }, { id: 'b', status: '進行中', ungrouped: false }];
  const patches = new Map([['a', { status: '確認待ち' }], ['b', { status: '確認待ち', ungrouped: true }]]);
  const visible = overlaySessions(old, patches);
  t.ok('古い一覧が返っても保存中の移動先を保つ', visible.every(s => s.status === '確認待ち') && visible[1].ungrouped);
  t.ok('サーバーからの行と元の行を書き換えない', old.every(s => s.status === '進行中') && visible[0] !== old[0]);
  const before = old.map(s => ({ sessionId: s.id, status: s.status, ungrouped: s.ungrouped }));
  const restored = revertFailed(visible, before, patches);
  t.ok('失敗時は状態とグループ所属を両方戻す', restored.every(s => s.status === '進行中' && !s.ungrouped));
  t.ok('巻き戻しで保存中の表示用配列は変えない', visible.every(s => s.status === '確認待ち'));
  t.ok('再試行は置換済みの行を ID で引き直す', currentRows([visible[0]], restored)[0] === restored[0]);

  // 戻す値は「画面が今この値か」ではなく、列に残る移動 → 最後に受け取ったサーバーの値 → 操作前の値の順で決める
  const server = new Map([['a', { status: '保留', ungrouped: false }]]);
  const fromServer = revertFailed(visible, before, patches, server);
  t.ok('別の端末で変わっていたサーバーの値へ戻す（操作前の値で上書きしない）', fromServer[0].status === '保留' && fromServer[1].status === '進行中');
  // 画面の値・失敗した値・操作前の値・サーバーの値が全部ちがうとき、戻し先がサーバーの値から来る（操作前の値でも画面の値でもない）
  const four = revertFailed([{ id: 'a', status: '確認待ち', ungrouped: false }], before, new Map([['a', { status: '確認待ち' }]]), new Map([['a', { status: '保留', ungrouped: false }]]));
  t.ok('画面の値が失敗した値と同じでも、巻き戻しを止めず、戻す先はサーバーの値（操作前の値ではない）', four[0].status === '保留');
  // 別の端末が同じ移動を先に保存していた: サーバーの値が失敗した値と同じなら、操作前の値へ戻さずサーバーの値に合わせる
  const same = revertFailed([{ id: 'a', status: '確認待ち', ungrouped: false }], before, new Map([['a', { status: '確認待ち' }]]), new Map([['a', { status: '確認待ち', ungrouped: false }]]));
  t.ok('サーバーの値が失敗した値と同じなら、操作前の値（進行中）へ戻さない', same[0].status === '確認待ち' && same[0].status !== before[0].status);
  // 列に残る移動・サーバー・操作前の値のどれも無いキーは操作前の値へ戻す
  const none = revertFailed([{ id: 'a', status: '確認待ち', ungrouped: false }], before, new Map([['a', { status: '確認待ち' }]]), new Map());
  t.ok('サーバーの値も列の移動も無ければ操作前の値へ戻す', none[0].status === '進行中');
  const queued = revertFailed(visible, before, patches, server, id => id === 'a' ? { status: '完了' } : undefined);
  t.ok('列に残る後続の移動先を、失敗した操作の巻き戻しで消さない', queued[0].status === '完了' && queued[1].status === '進行中');

  const deleting = overlaySessions([], new Map(), new Map([['a', old[0]]]));
  t.ok('削除応答より先に来た一覧で行を消さない', deleting.length === 1 && deleting[0].id === 'a');
  const confirmation = ['ja', 'en'].map(locale => JSON.parse(readFileSync(new URL(`../../web/locales/${locale}/ui.json`, import.meta.url), 'utf8')).pending.deleteStatusConfirm);
  t.ok('状態削除の確認に件数と移り先を含める', confirmation.every(s => ['{{count}}', '{{destination}}'].every(key => s.includes(key))));
}
