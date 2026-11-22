// 設定 › Pleiad Plus の「同期」（web/plus-sync.mjs）: 状態ごとの行とボタン・書式（DOM の代役）
import { renderSync, syncTimeText, megaBytes, syncCodeText } from '../../web/plus-sync.mjs';
import { t as tr } from '../../web/i18n.mjs';

export const name = 'plus-sync-ui';
export const title = '設定 › Pleiad Plus の同期: 状態ごとの中身・確かめ・鍵を待つ場面と始め直しの窓・登録の外れ・前の鍵で確かめられない鍵・前の版の api・時刻と MB の書式（DOM の代役）';

const text = nodes => nodes.map(n => n.textContent).join(' ');
// 子を足したボタン（button('') の後に append）は、代役では textContent が空のままなので葉を集める
const deepText = n => (n.children?.length ? n.children.map(deepText).join('') : (n.textContent ?? ''));
function byFk(nodes, fk) {
  const walk = n => {
    if (n.dataset?.fk === fk) return n;
    for (const c of n.children ?? []) { const hit = walk(c); if (hit) return hit; }
    return null;
  };
  for (const n of nodes) { const hit = walk(n); if (hit) return hit; }
  return null;
}
const buttonTexts = nodes => {
  const out = [];
  const walk = n => { if (n.tagName === 'BUTTON' && !n.getAttribute?.('aria-checked')) out.push(n.textContent); for (const c of n.children ?? []) walk(c); };
  for (const n of nodes) walk(n);
  return out;
};
const switchOf = nodes => {
  const walk = n => { if (n.getAttribute?.('role') === 'switch') return n; for (const c of n.children ?? []) { const hit = walk(c); if (hit) return hit; } return null; };
  for (const n of nodes) { const hit = walk(n); if (hit) return hit; }
  return null;
};
const liveOf = nodes => {
  const walk = n => { if (n.getAttribute?.('aria-live') === 'polite') return n; for (const c of n.children ?? []) { const hit = walk(c); if (hit) return hit; } return null; };
  for (const n of nodes) { const hit = walk(n); if (hit) return hit; }
  return null;
};
const BASE = { state: 'idle', lastSyncedAt: '2026-10-21T05:00:00Z', totalBytes: 0, limitBytes: 0, conflicts: 0, error: null };

export default async function (t) {
  const calls = [];
  const deps = { onToggle: v => calls.push(['toggle', v]), onNow: () => calls.push(['now']), onAskReset: () => calls.push(['askReset']), onCancelReset: () => calls.push(['cancelReset']), onReset: () => calls.push(['reset']), onOpenConflicts: () => calls.push(['openConflicts']) };
  const render = (sync, extra = {}) => renderSync({ enabled: true, sync, ...deps, ...extra });

  // 見出し・スイッチ・「同期するもの」はいつも出る
  let nodes = render(BASE);
  t.ok('見出し「同期」とスイッチ（既定は入）と「同期するもの」', text(nodes).includes('同期') && switchOf(nodes)?.getAttribute('aria-checked') === 'true' && text(nodes).includes('同期するもの'));
  byFk(nodes, 'syncToggle').onclick();
  t.ok('スイッチは onToggle(false) を呼ぶ', calls.at(-1)[0] === 'toggle' && calls.at(-1)[1] === false);
  t.ok('「同期するもの」の中身は箇条書きの 5 項目（「同期しない」・暗号の一言は出さない）',
    text(nodes).includes('設定（PC ごとの値・パス・リモート・秘密を除く）') && text(nodes).includes('~/.claude/skills') && text(nodes).includes('~/.agents/skills') && text(nodes).includes('Pleiad の skill') && text(nodes).includes('Claude・Codex・Gemini の全体の指示ファイル')
      && !text(nodes).includes('同期しない') && !text(nodes).includes('暗号化してから送ります'), text(nodes));
  t.ok('状態の行は aria-live=polite の中', liveOf(nodes) !== null);

  // enabled: false → 状態の行は出さない（スイッチだけ残る）
  nodes = renderSync({ enabled: false, sync: { ...BASE, state: 'idle' }, ...deps });
  t.ok('enabled=false → スイッチは切で、状態の行は出さない', switchOf(nodes).getAttribute('aria-checked') === 'false' && !text(nodes).includes('最後の同期') && liveOf(nodes) === null);
  byFk(nodes, 'syncToggle').onclick();
  t.ok('切のスイッチは onToggle(true)', calls.at(-1)[0] === 'toggle' && calls.at(-1)[1] === true);

  // disabled: 状態の行は出さない
  nodes = render({ ...BASE, state: 'disabled' });
  t.ok('disabled: 状態の行は出さない', !text(nodes).includes('最後の同期') && !text(nodes).includes('同期を切っています'));

  // off
  nodes = render({ ...BASE, state: 'off' });
  t.ok('off: 「同期を切っています」', text(nodes).includes('同期を切っています'));

  const waiting = (wait, extra) => render({ ...BASE, state: 'waiting_key', wait }, extra);
  const nowScene = new Date(2026, 9, 21, 15);
  const startsAt = new Date(2026, 9, 22, 9, 5).toISOString();
  const line = ns => ns.find(n => n.className.includes('sync-row'))?.children[0].children[1];
  nodes = waiting({ kind: 'preparing' }, { now: nowScene });
  t.ok('準備中: スイッチの行に状態を表示し、操作を求めない', line(nodes)?.getAttribute('role') === 'status'
    && line(nodes)?.textContent.includes('準備しています') && buttonTexts(nodes).length === 0);
  nodes = waiting({ kind: 'preparing', startsAt }, { now: nowScene });
  t.ok('自動で始め直すときは開始時刻を表示する', line(nodes)?.textContent.includes('09:05 に始まります'));
  nodes = waiting({ kind: 'preparing', startsAt }, { now: new Date(2026, 9, 23) });
  t.ok('開始時刻を過ぎたら準備中の表示に戻る', !line(nodes)?.textContent.includes('に始まります'));
  nodes = waiting({ kind: 'approval', approvers: ['desk', 'lap'] });
  t.ok('利用する PC と許可待ちの状態を表示する', line(nodes)?.textContent.includes('ほかの PC の許可を待っています')
    && text(nodes).includes('desk か lap で Pleiad を開いてください') && buttonTexts(nodes).length === 0);
  nodes = waiting({ kind: 'approval', approvers: ['desk'], code: '731058' });
  t.ok('許可の途中は確認コードと確かめる相手が見える', text(nodes).includes('731 058') && text(nodes).includes('desk の画面で'));
  nodes = waiting({ kind: 'approval', approvers: ['desk'], deniedAt: startsAt, code: '731058' });
  t.ok('許可されなければ次に進める時間だけを案内する', text(nodes).includes('1 時間たつと') && !text(nodes).includes('731 058'));
  nodes = waiting({ kind: 'preparing', relogin: true }, { onLogin: () => calls.push(['login']) });
  byFk(nodes, 'syncRelogin').onclick();
  t.ok('ログインし直す案内と操作', text(nodes).includes('ログインし直してください') && calls.at(-1)[0] === 'login');
  nodes = waiting({ kind: 'restarted', keyId: 'key-9', byName: 'tablet' }, { onAcceptRestart: id => calls.push(['restart', id]) });
  const accept = byFk(nodes, 'syncAcceptRestart');
  t.ok('始め直された同期には利用者が相手を確認してから加わる', text(nodes).includes('tablet で同期が始め直されました')
    && text(nodes).includes('知らない PC なら') && accept?.textContent === 'tablet と同期する');
  accept.onclick();
  t.ok('始め直しの選択には表示した鍵の ID を送る', calls.at(-1).join() === 'restart,key-9');

  // syncing
  nodes = render({ ...BASE, state: 'syncing' });
  t.ok('syncing: 「同期しています…」', text(nodes).includes('同期しています'));

  nodes = render(BASE);
  t.ok('同期済みと時刻はスイッチの行にあり、操作は「今すぐ同期」', line(nodes)?.textContent.includes('同期済み')
    && buttonTexts(nodes).join() === '今すぐ同期');
  byFk(nodes, 'syncNow').onclick();
  t.ok('「今すぐ同期」は onNow', calls.at(-1)[0] === 'now');

  // quota: 赤・使用量・新しいものは送られない・「同期をリセット」
  nodes = render({ ...BASE, state: 'quota', totalBytes: 6_000_000, limitBytes: 7_340_032 });
  const quotaTx = text(nodes);
  t.ok('quota: 上限・使用量（MB 小数 1 桁）・送られない', quotaTx.includes('同期の容量の上限に達しました') && quotaTx.includes('5.7 MB / 7.0 MB') && quotaTx.includes('新しく変えたものは送られません'), quotaTx);
  t.ok('quota: 「同期をリセット」は出るが「今すぐ同期」は出さない', buttonTexts(nodes).includes('同期をリセット') && !buttonTexts(nodes).includes('今すぐ同期'));

  // error: 誤りの code ごとの一言と「今すぐ同期」「同期をリセット」
  for (const [error, want] of [['network', 'サーバーにつながりません'], ['rate_limited', '自動でやり直します'], ['conflict', 'もう一度お試しください']]) {
    nodes = render({ ...BASE, state: 'error', error });
    t.ok(`error(${error}): 「同期できませんでした」と「${want}」`, text(nodes).includes('同期できませんでした') && text(nodes).includes(want), text(nodes));
    t.ok(`error(${error}): 「今すぐ同期」と「同期をリセット」`, buttonTexts(nodes).join() === '今すぐ同期');
  }

  // Plus が止まっている（api の 503 unavailable）: 誤りではなく待ち。「同期できませんでした」「サーバーにつながりません」は出さない
  nodes = render({ ...BASE, state: 'error', error: 'unavailable' });
  const pausedTx = text(nodes);
  t.ok('error(unavailable): 「Pleiad Plus が一時的に止まっています（再開を待っています）」と自動で再開する旨', pausedTx.includes('Pleiad Plus が一時的に止まっています（再開を待っています）') && pausedTx.includes('再開したら自動で同期します') && !pausedTx.includes('同期できませんでした') && !pausedTx.includes('サーバーにつながりません'), pausedTx);
  t.ok('error(unavailable): 「今すぐ同期」だけ（リセットも断られる）', buttonTexts(nodes).includes('今すぐ同期') && !buttonTexts(nodes).includes('同期をリセット'), buttonTexts(nodes).join());

  // stopped: アカウントの停止（403 account_disabled・not_plus）。誤りではないので「同期できませんでした」は出さず、自動で戻ることを書く
  for (const [error, want] of [['account_disabled', 'このアカウントでは今は同期を使えません'], ['not_plus', 'Pleiad Plus に戻ると']]) {
    nodes = render({ ...BASE, state: 'stopped', error });
    const tx = text(nodes);
    t.ok(`stopped(${error}): 「同期は止まっています」と「${want}」、「同期できませんでした」は出さない`, tx.includes('同期は止まっています') && tx.includes(want) && tx.includes('自動で再開します') && !tx.includes('同期できませんでした'), tx);
    t.ok(`stopped(${error}): ボタンは出さない（回しても断られる）`, buttonTexts(nodes).length === 0, buttonTexts(nodes).join());
  }

  // 確かめ: 題・本文・「リセットする」「やめる」
  nodes = render({ ...BASE, state: 'quota' }, { confirming: true });
  t.ok('確かめ: 題と本文と 2 ボタン', text(nodes).includes('同期をリセットしますか？') && text(nodes).includes('サーバーの同期のデータを消して、この PC の内容で始め直します') && buttonTexts(nodes).includes('リセットする') && buttonTexts(nodes).includes('やめる'));
  byFk(nodes, 'syncResetNo').onclick();
  t.ok('「やめる」は onCancelReset', calls.at(-1)[0] === 'cancelReset');
  byFk(nodes, 'syncResetYes').onclick();
  t.ok('「リセットする」は onReset', calls.at(-1)[0] === 'reset');

  // 競合: 1 件以上で行と「フォルダーを開く」と 30 日
  nodes = render({ ...BASE, conflicts: 3 });
  t.ok('競合 3: 文と「フォルダーを開く」と 30 日', text(nodes).includes('3 件の古い方を残しました') && buttonTexts(nodes).includes('フォルダーを開く') && text(nodes).includes('30 日で消えます'));
  byFk(nodes, 'syncOpenConflicts').onclick();
  t.ok('「フォルダーを開く」は onOpenConflicts', calls.at(-1)[0] === 'openConflicts');
  nodes = render({ ...BASE, conflicts: 0 });
  t.ok('競合 0: 行は出さない', !text(nodes).includes('古い方を残しました'));

  // 届いた変更: 1 件以上で「届いた変更 N 件」の行（◆・山）。0 件・同期を切っているときは出さない
  nodes = render({ ...BASE, inbox: 2 }, { onOpenInbox: () => calls.push(['openInbox']) });
  const inx = byFk(nodes, 'syncInbox');
  t.ok('届いた変更 2: 「届いた変更 2 件」の行（button.rm-row・◆）', inx?.tagName === 'BUTTON' && inx.className.includes('rm-row') && deepText(inx).includes('届いた変更 2 件') && deepText(inx).includes('◆'));
  inx.onclick();
  t.ok('「届いた変更」の行は onOpenInbox', calls.at(-1)[0] === 'openInbox');
  t.ok('届いた変更 0: 行は出さない', byFk(render({ ...BASE, inbox: 0 }), 'syncInbox') === null && byFk(render(BASE), 'syncInbox') === null);
  t.ok('同期を切っているとき（disabled）は、届いた変更の行も出さない', byFk(render({ ...BASE, state: 'disabled', inbox: 2 }), 'syncInbox') === null);

  nodes = render({ ...BASE, state: 'unregistered', recoveryAlert: { requestedByName: 'tablet', readyAt: startsAt } },
    { now: nowScene, onRecoveryStop: () => calls.push(['stop']) });
  t.ok('登録が外れた PC に始め直しの知らせと期限を表示する', text(nodes).includes('tablet が同期を始め直そうとしています')
    && text(nodes).includes('09:05 に始め直されます') && !line(nodes));
  byFk(nodes, 'syncRecoveryStop').onclick();
  t.ok('「止める」は始め直しを止める操作を呼ぶ', calls.at(-1)[0] === 'stop');
  t.ok('止めたあとに結果を表示する', text(render(BASE, { recoveryNote: 'stopped' })).includes('止めました'));
  const sharedTo = [{ name: 'desk', at: startsAt }];
  t.ok('許可した PC の名前と時刻が見える', text(render({ ...BASE, sharedTo })).includes('desk の同期を許可しました'));
  t.ok('許可を待つ PC には以前の許可の行を表示しない',
    !text(render({ ...BASE, sharedTo, state: 'waiting_key' })).includes('desk の同期を許可しました'));
  nodes = render({ ...BASE, state: 'update_required' });
  t.ok('426 の場合は更新を促す', text(nodes).includes(tr('settings.plus.syncUpdateRequired')) && byFk(nodes, 'syncNow') === null);
  nodes = render({ ...BASE, state: 'error', error: 'api_downgraded' });
  t.ok('前の版の応答を返すサーバーでは起動し直すよう案内する', text(nodes).includes(tr('settings.plus.syncErrServer'))
    && byFk(nodes, 'syncNow') === null);
  t.ok('確認コードの書式: 6 桁は 3 桁ずつ、ほかはそのまま', syncCodeText('731058') === '731 058' && syncCodeText('12') === '12' && syncCodeText(null) === '');

  // スイッチの失敗の文言
  nodes = render(BASE, { message: '変えられませんでした' });
  t.ok('スイッチの失敗: 「変えられませんでした」', text(nodes).includes('変えられませんでした'));

  // ---- 書式 ----
  const now = new Date(2026, 9, 21, 15, 0, 0);
  t.ok('時刻: 今日は HH:mm', /^\d{2}:\d{2}$/.test(syncTimeText(new Date(2026, 9, 21, 9, 5).toISOString(), { now })), syncTimeText(new Date(2026, 9, 21, 9, 5).toISOString(), { now }));
  t.ok('時刻: 前の日は日付つき', syncTimeText(new Date(2026, 9, 20, 9, 5).toISOString(), { now }).includes('20'));
  t.ok('時刻: en も日付つき', /Sep|20/.test(syncTimeText(new Date(2026, 8, 20, 9, 5).toISOString(), { lang: 'en', now })), syncTimeText(new Date(2026, 8, 20, 9, 5).toISOString(), { lang: 'en', now }));
  t.ok('時刻: 読めない値は空', syncTimeText('x') === '' && syncTimeText(null) === '');
  t.ok('MB: 小数 1 桁', megaBytes(7_340_032) === '7.0 MB' && megaBytes(0) === '0.0 MB' && megaBytes(524_288) === '0.5 MB');
}
