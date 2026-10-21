// 設定 › Pleiad Plus の「同期」（web/plus-sync.mjs）: 状態ごとの行とボタン・書式（DOM の代役）
import assert from 'node:assert/strict';
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
  const deps = { onResetCheck: v => calls.push(['resetCheck', v]), onToggle: v => calls.push(['toggle', v]), onNow: () => calls.push(['now']), onAskReset: () => calls.push(['askReset']), onCancelReset: () => calls.push(['cancelReset']), onReset: () => calls.push(['reset']), onOpenConflicts: () => calls.push(['openConflicts']) };
  const render = (sync, extra = {}) => renderSync({ enabled: true, sync, ...deps, ...extra });

  // 見出し・スイッチ・「同期するもの」はいつも出る
  let nodes = render(BASE);
  t.ok('見出し「同期」とスイッチ（既定は入）と「同期するもの」', text(nodes).includes('同期') && switchOf(nodes)?.getAttribute('aria-checked') === 'true' && text(nodes).includes('同期するもの'));
  byFk(nodes, 'syncToggle').onclick();
  t.ok('スイッチは onToggle(false) を呼ぶ', calls.at(-1)[0] === 'toggle' && calls.at(-1)[1] === false);
  t.ok('「同期するもの」の中身（する・しない・暗号）', text(nodes).includes('同期しない') && text(nodes).includes('暗号化してから送ります'));
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

  // waiting_key
  nodes = render({ ...BASE, state: 'waiting_key' });
  t.ok('waiting_key: 文と下の案内と「同期をやり直す」', text(nodes).includes('ほかの PC が鍵を渡すのを待っています') && text(nodes).includes('別の PC で Pleiad を開いてください') && buttonTexts(nodes).includes('同期をやり直す'));
  t.ok('waiting_key: 「今すぐ同期」は出さない', !buttonTexts(nodes).includes('今すぐ同期'));

  // ---- 鍵を待つ場面（docs/plus.md「同期の始め直しと登録の外れ」）
  const WAIT = { keyId: 'key-1', itemCount: 312, totalBytes: 4_404_019, updatedAt: '2026-10-21T04:00:00Z', lastWriter: { hostId: 'h-desk', name: 'desk' }, holders: [] };
  // 場面 1: 鍵を持つ PC が台帳に居る → 名前と最後の同期、ボタンは控えめ
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...WAIT, holder: true, holders: [{ hostId: 'h-desk', name: 'desk', registered: true, lastSyncAt: '2026-10-21T04:30:00Z' }] } });
  let tx = text(nodes);
  t.ok('場面 1: 鍵を持つ PC の名前・最後の同期・その PC を開く案内', tx.includes('ほかの PC が鍵を渡すのを待っています') && tx.includes('鍵を持つ PC: desk（最後の同期:') && tx.includes('その PC で Pleiad を開くと'), tx);
  t.ok('場面 1: ボタンは「鍵を持つ PC が使えないとき」（控えめ）で、件数は出さない', byFk(nodes, 'syncReset')?.textContent === '鍵を持つ PC が使えないとき' && byFk(nodes, 'syncReset').className.includes('btn-quiet') && !tx.includes('312 件'));
  byFk(nodes, 'syncReset').onclick();
  t.ok('場面 1: ボタンは確かめを開く（onAskReset）', calls.at(-1)[0] === 'askReset');
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...WAIT, holder: true, holders: [{ hostId: 'h-x', name: null, registered: true, lastSyncAt: null }] } });
  t.ok('場面 1: 名前も時刻も無い PC は「名前の無い PC」で時刻を書かない', text(nodes).includes('鍵を持つ PC: 名前の無い PC。'), text(nodes));
  // 場面 2: 鍵を持つ PC が外れていて、サーバーにデータがある → 件数・大きさ・最後の更新・外れた PC
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...WAIT, holder: false, holders: [{ hostId: 'h-desk', name: 'desk', registered: false }, { hostId: 'h-lap', name: 'laptop', registered: false }] } });
  tx = text(nodes);
  t.ok('場面 2: 件数と大きさ（約 4.2 MB・312 件）', tx.includes('ほかの PC が同期したデータがあります（約 4.2 MB・312 件）'), tx);
  t.ok('場面 2: 最後の更新は書いた PC の名前つき', tx.includes('最後の更新:') && tx.includes('（desk）'));
  t.ok('場面 2: 外れているかもしれない旨と、外れた PC の名前', tx.includes('登録から外れているかもしれません') && tx.includes('登録から外れた PC: desk、laptop'), tx);
  t.ok('場面 2: ボタンは「鍵を持つ PC が使えない」', byFk(nodes, 'syncReset')?.textContent === '鍵を持つ PC が使えない' && !byFk(nodes, 'syncReset').className.includes('btn-quiet'));
  // 前の版の api（件数が分からない）
  nodes = render({ ...BASE, state: 'waiting_key', wait: { keyId: 'key-1', itemCount: null, totalBytes: 0, updatedAt: null, holder: false, holders: [] } });
  tx = text(nodes);
  t.ok('件数が分からない（前の api）: 「あるかもしれません」で、件数・最後の更新は出さない', tx.includes('データがあるかもしれません') && !tx.includes('件）') && !tx.includes('最後の更新'), tx);
  // 始め直された直後（自分の鍵が古い）
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...WAIT, holder: true, stale: true, resetAt: '2026-10-21T03:00:00Z', resetBy: { hostId: 'h-test', name: 'test-pc' },
    holders: [{ hostId: 'h-test', name: 'test-pc', registered: true, lastSyncAt: null }] } });
  t.ok('始め直された: 「test-pc で … に始め直されました」', text(nodes).includes('同期は test-pc で') && text(nodes).includes('に始め直されました'), text(nodes));

  // ---- 始め直しの窓（場面 3）: チェックを入れるまで押せない
  const w2 = { ...WAIT, holder: false, holders: [] };
  nodes = render({ ...BASE, state: 'waiting_key', wait: w2 }, { confirming: true });
  tx = text(nodes);
  t.ok('始め直しの窓: 題・消えるもの（件数と大きさ）・消えないもの・ほかの PC',
    tx.includes('同期のデータを消して、この PC で始め直しますか？') && tx.includes('消えるもの: サーバーにある同期のデータ（約 4.2 MB・312 件）') && tx.includes('手元のファイルと設定は消えません') && tx.includes('「同期の写し」に 30 日残ります'), tx);
  const check = byFk(nodes, 'syncResetCheck');
  t.ok('始め直しの窓: チェックは 1 つで、文言は「サーバーの同期のデータを消して、この PC から始め直す」', check?.type === 'checkbox' && check.checked === false && tx.includes('サーバーの同期のデータを消して、この PC から始め直す'));
  t.ok('始め直しの窓: チェックの前は「消して始め直す」を押せない', byFk(nodes, 'syncResetYes')?.textContent === '消して始め直す' && byFk(nodes, 'syncResetYes').disabled === true);
  check.checked = true;
  check.onchange();
  t.ok('チェックは onResetCheck(true) を呼ぶ', calls.at(-1)[0] === 'resetCheck' && calls.at(-1)[1] === true);
  nodes = render({ ...BASE, state: 'waiting_key', wait: w2 }, { confirming: true, resetChecked: true });
  t.ok('チェックを入れると押せる', byFk(nodes, 'syncResetYes').disabled === false && byFk(nodes, 'syncResetCheck').checked === true);
  byFk(nodes, 'syncResetYes').onclick();
  t.ok('「消して始め直す」は onReset', calls.at(-1)[0] === 'reset');
  byFk(nodes, 'syncResetNo').onclick();
  t.ok('「やめる」は onCancelReset', calls.at(-1)[0] === 'cancelReset');
  nodes = render({ ...BASE, state: 'waiting_key', wait: w2 }, { confirming: true, resetChecked: true, busy: true });
  t.ok('回している間は押せない', byFk(nodes, 'syncResetYes').disabled === true && byFk(nodes, 'syncResetCheck').disabled === true);
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...w2, itemCount: 315 } }, { confirming: true, resetChanged: true });
  tx = text(nodes);
  t.ok('数字が変わった（409 reset_confirm）: 変わった旨と新しい件数、チェックは外れたまま',
    tx.includes('確かめている間に、サーバーのデータが変わりました') && tx.includes('315 件') && byFk(nodes, 'syncResetYes').disabled === true, tx);
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...w2, itemCount: null } }, { confirming: true });
  t.ok('件数が分からない窓: 件数を書かずに消えるものを書く', text(nodes).includes('消えるもの: サーバーにある同期のデータ。'));

  // ---- 登録の外れ
  nodes = render({ ...BASE, state: 'unregistered' });
  tx = text(nodes);
  t.ok('unregistered: 止めている旨と、登録し直すと再開する案内・ボタンは出さない', tx.includes('この PC の登録が外れているため、同期を止めています') && tx.includes('登録し直すと、自動で再開します') && buttonTexts(nodes).length === 0, tx);

  // ---- 鍵を渡した PC の知らせ
  nodes = render({ ...BASE, sharedTo: [{ hostId: 'h-new', name: 'new-pc', at: '2026-10-21T04:00:00Z' }] });
  t.ok('sharedTo: 「新しい PC new-pc に同期の鍵を渡しました」', text(nodes).includes('新しい PC new-pc に同期の鍵を渡しました'), text(nodes));
  nodes = render({ ...BASE, state: 'disabled', sharedTo: [{ hostId: 'h-new', name: 'new-pc', at: '2026-10-21T04:00:00Z' }] });
  t.ok('sharedTo: 同期を切っているアカウントでは出さない', !text(nodes).includes('同期の鍵を渡しました'));

  // syncing
  nodes = render({ ...BASE, state: 'syncing' });
  t.ok('syncing: 「同期しています…」', text(nodes).includes('同期しています'));

  // idle: 最後の同期と「今すぐ同期」「同期をやり直す」
  nodes = render(BASE);
  t.ok('idle: 「最後の同期: 」と 2 ボタン', text(nodes).includes('最後の同期:') && buttonTexts(nodes).includes('今すぐ同期') && buttonTexts(nodes).includes('同期をやり直す'));
  byFk(nodes, 'syncNow').onclick();
  t.ok('「今すぐ同期」は onNow', calls.at(-1)[0] === 'now');
  byFk(nodes, 'syncReset').onclick();
  t.ok('「同期をやり直す」は確かめを開く（onAskReset）', calls.at(-1)[0] === 'askReset');

  // quota: 赤・使用量・新しいものは送られない・「同期をやり直す」
  nodes = render({ ...BASE, state: 'quota', totalBytes: 6_000_000, limitBytes: 7_340_032 });
  const quotaTx = text(nodes);
  t.ok('quota: 上限・使用量（MB 小数 1 桁）・送られない', quotaTx.includes('同期の容量の上限に達しました') && quotaTx.includes('5.7 MB / 7.0 MB') && quotaTx.includes('新しく変えたものは送られません'), quotaTx);
  t.ok('quota: 「同期をやり直す」は出るが「今すぐ同期」は出さない', buttonTexts(nodes).includes('同期をやり直す') && !buttonTexts(nodes).includes('今すぐ同期'));

  // error: 誤りの code ごとの一言と「今すぐ同期」「同期をやり直す」
  for (const [error, want] of [['unavailable', 'サーバーにつながりません'], ['network', 'サーバーにつながりません'], ['rate_limited', '自動でやり直します'], ['conflict', 'もう一度お試しください']]) {
    nodes = render({ ...BASE, state: 'error', error });
    t.ok(`error(${error}): 「同期できませんでした」と「${want}」`, text(nodes).includes('同期できませんでした') && text(nodes).includes(want), text(nodes));
    t.ok(`error(${error}): 「今すぐ同期」と「同期をやり直す」`, buttonTexts(nodes).includes('今すぐ同期') && buttonTexts(nodes).includes('同期をやり直す'));
  }

  // stopped: アカウントの停止（403 account_disabled・not_plus）。誤りではないので「同期できませんでした」は出さず、自動で戻ることを書く
  for (const [error, want] of [['account_disabled', 'このアカウントでは今は同期を使えません'], ['not_plus', 'Pleiad Plus に戻ると']]) {
    nodes = render({ ...BASE, state: 'stopped', error });
    const tx = text(nodes);
    t.ok(`stopped(${error}): 「同期は止まっています」と「${want}」、「同期できませんでした」は出さない`, tx.includes('同期は止まっています') && tx.includes(want) && tx.includes('自動で再開します') && !tx.includes('同期できませんでした'), tx);
    t.ok(`stopped(${error}): ボタンは出さない（回しても断られる）`, buttonTexts(nodes).length === 0, buttonTexts(nodes).join());
  }

  // 確かめ: 題・本文・「やり直す」「やめる」
  nodes = render(BASE, { confirming: true });
  t.ok('確かめ: 題と本文と 2 ボタン', text(nodes).includes('同期をやり直しますか？') && text(nodes).includes('サーバーから消して、この PC の内容で始め直します') && buttonTexts(nodes).includes('やり直す') && buttonTexts(nodes).includes('やめる'));
  byFk(nodes, 'syncResetNo').onclick();
  t.ok('「やめる」は onCancelReset', calls.at(-1)[0] === 'cancelReset');
  byFk(nodes, 'syncResetYes').onclick();
  t.ok('「やり直す」は onReset', calls.at(-1)[0] === 'reset');

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

  // ---- 受け入れの v2（wait.v2。docs/plus.md「同期の鍵の受け渡し」）: 鍵は鍵を持つ PC の承認でだけ届く
  const NOW = new Date('2026-10-21T06:00:00Z');
  const V2 = { ...WAIT, v2: true, holder: true, holders: [{ hostId: 'h-desk', name: 'desk', registered: true, lastSyncAt: '2026-10-21T04:30:00Z' }, { hostId: 'h-lap', name: 'lap', registered: true, lastSyncAt: null }] };
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...V2, join: { state: 'committed', code: null, approver: null } } }, { now: NOW });
  tx = text(nodes);
  t.ok('v2 申し込み: 「鍵を持つ PC の承認を待っています」と、開く PC の名前（desk または lap）', tx.includes('鍵を持つ PC の承認を待っています') && tx.includes('desk') && tx.includes('lap') && tx.includes('両方の画面に確認コード'), tx);
  t.ok('v2 申し込み: まだ確認コードは出さない・件数も出さない', !tx.includes('確認コード ') && !/\d{3} \d{3}/.test(tx) && !tx.includes('312 件'));
  t.ok('v2 申し込み: ボタンは「鍵を持つ PC が使えないとき」（控えめ）だけ', buttonTexts(nodes).join() === '鍵を持つ PC が使えないとき' && byFk(nodes, 'syncReset').className.includes('btn-quiet'), buttonTexts(nodes).join());
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...V2, join: { state: 'revealed', code: '731058', approver: { hostId: 'h-desk', name: 'desk' } } } }, { now: NOW });
  tx = text(nodes);
  t.ok('v2 確認コード: 「desk の画面で承認してください」と、3 桁ずつの確認コード', tx.includes('desk の画面で承認してください') && tx.includes('731 058'), tx);
  const codeNode = (() => { const walk = n => (n.className?.includes?.('sync-code') ? n : (n.children ?? []).map(walk).find(Boolean) ?? null); return nodes.map(walk).find(Boolean); })();
  t.ok('v2 確認コード: 読み上げは「確認コード 731 058」', codeNode?.getAttribute('aria-label') === '確認コード 731 058', String(codeNode?.getAttribute('aria-label')));
  t.ok('v2 確認コード: 承認する PC の最後の同期も出す', tx.includes('最後の同期'));
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...V2, join: { state: 'denied', code: null, approver: null } } }, { now: NOW });
  tx = text(nodes);
  t.ok('v2 断られた: 「断られました」と 1 時間の案内、コードは出さない', tx.includes('鍵の受け渡しが断られました') && tx.includes('1 時間たつと') && !/\d{3} \d{3}/.test(tx), tx);
  // 「鍵を持つ PC が使えないとき」: 始め直しではなく、外し方と回復の説明
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...V2, join: { state: 'committed' } } }, { confirming: true, onOpenAccount: () => calls.push(['account']) });
  tx = text(nodes);
  t.ok('v2 使えないとき: PC の外し方と回復の説明。始め直しのチェックは出さない', tx.includes('アカウントのページで外して') && tx.includes('回復を頼めます') && !buttonTexts(nodes).includes('消して始め直す'), tx);
  byFk(nodes, 'syncHelpAccount').onclick();
  t.ok('v2 使えないとき: アカウントのページを開ける', calls.at(-1)[0] === 'account');
  byFk(nodes, 'syncHelpClose').onclick();
  t.ok('v2 使えないとき: 「閉じる」は onCancelReset', calls.at(-1)[0] === 'cancelReset');
  t.ok('v2 使えないとき: アカウントのページの URL が無ければ、そのボタンは出さない',
    byFk(render({ ...BASE, state: 'waiting_key', wait: { ...V2 } }, { confirming: true }), 'syncHelpAccount') === null);

  // 鍵を持つ PC が居ない: データと回復
  const rec = [];
  const onRecovery = a => rec.push(a);
  const NOHOLD = { ...WAIT, v2: true, holder: false, holders: [{ hostId: 'h-old', name: 'old-desk', registered: false, lastSyncAt: null }], recovery: null };
  nodes = render({ ...BASE, state: 'waiting_key', wait: NOHOLD }, { now: NOW, onRecovery });
  tx = text(nodes);
  t.ok('v2 回復の前: データの件数・外れた PC の名前・回復の説明', tx.includes('312 件') && tx.includes('どれも登録から外れています') && tx.includes('old-desk') && tx.includes('72 時間後'), tx);
  byFk(nodes, 'syncRecoveryRequest').onclick();
  t.ok('v2 回復の前: 「回復を頼む」は onRecovery(request)', rec.at(-1) === 'request');
  const R = { requestedBy: 'h-me', requestedAt: '2026-10-21T05:00:00Z', readyAt: '2026-10-24T05:00:00Z', requestedByName: 'me' };
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...NOHOLD, recovery: R, recoveryMine: true } }, { now: NOW, onRecovery });
  tx = text(nodes);
  t.ok('v2 回復を待つ: 明ける時刻と「取り下げる」。まだ始め直しは出さない', tx.includes('回復を待っています') && buttonTexts(nodes).includes('取り下げる') && !buttonTexts(nodes).includes('新しい鍵で始め直す'), tx);
  byFk(nodes, 'syncRecoveryCancel').onclick();
  t.ok('「取り下げる」は onRecovery(cancel)', rec.at(-1) === 'cancel');
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...NOHOLD, recovery: R, recoveryMine: true } }, { now: new Date('2026-10-24T06:00:00Z'), onRecovery });
  t.ok('v2 回復の待ちが明けた: 「新しい鍵で始め直す」が出て、確かめの窓を開く', text(nodes).includes('待ちが明けました') && buttonTexts(nodes).includes('新しい鍵で始め直す'));
  byFk(nodes, 'syncReset').onclick();
  t.ok('「新しい鍵で始め直す」は確かめを開く（onAskReset）', calls.at(-1)[0] === 'askReset');
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...NOHOLD, recovery: R, recoveryMine: true } }, { confirming: true, resetChecked: true, onRecovery });
  tx = text(nodes);
  t.ok('v2 回復の確かめ: 消えるデータの件数と、ほかの PC は承認でまた同期すること', tx.includes('312 件') && tx.includes('この PC の画面で承認すると'), tx);
  byFk(nodes, 'syncResetYes').onclick();
  t.ok('v2 回復の確かめ: 始め直すは onRecovery(complete)（onReset ではない）', rec.at(-1) === 'complete' && calls.at(-1)[0] !== 'reset');
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...NOHOLD, recovery: { ...R, requestedByName: 'tablet' }, recoveryMine: false, recoveryStop: false } }, { now: NOW, onRecovery });
  t.ok('v2 ほかの PC の回復: その PC の名前と時刻。鍵が無ければ止めるボタンは出さない', text(nodes).includes('tablet が回復を頼んでいます') && byFk(nodes, 'syncRecoveryStop') === null, text(nodes));
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...NOHOLD, recovery: { ...R, requestedByName: 'tablet' }, recoveryMine: false, recoveryStop: true } }, { now: NOW, onRecovery });
  byFk(nodes, 'syncRecoveryStop').onclick();
  t.ok('v2 ほかの PC の回復: 今の鍵があれば「回復を止める」→ onRecovery(stop)', rec.at(-1) === 'stop');

  // 外されたこの PC が今の鍵を持っていて、回復が頼まれている
  nodes = render({ ...BASE, state: 'unregistered', recoveryAlert: { requestedByName: 'tablet', readyAt: R.readyAt } }, { now: NOW, onRecovery });
  tx = text(nodes);
  t.ok('回復の知らせ（外された PC）: 心当たりが無ければ止める・「回復を止める」', tx.includes('tablet が同期の回復を頼んでいます') && tx.includes('心当たりが無ければ') && buttonTexts(nodes).includes('回復を止める'), tx);
  // 操作の結果の一言
  nodes = render({ ...BASE, state: 'waiting_key', wait: NOHOLD }, { recoveryNote: 'reauth', onLogin: () => calls.push(['login']) });
  t.ok('回復の結果 reauth: ログインし直す案内とボタン', text(nodes).includes('ログインし直してください') && buttonTexts(nodes).includes('ログインし直す'));
  byFk(nodes, 'syncRelogin').onclick();
  t.ok('「ログインし直す」は onLogin', calls.at(-1)[0] === 'login');
  t.ok('回復の結果 other・stopped の一言', text(render({ ...BASE, state: 'waiting_key', wait: NOHOLD }, { recoveryNote: 'other' })).includes('先に回復を頼みました')
    && text(render(BASE, { recoveryNote: 'stopped' })).includes('回復を止めました'));

  // 426: この版では続けられない
  nodes = render({ ...BASE, state: 'update_required' });
  tx = text(nodes);
  t.ok('update_required: 更新を促す文と、回すボタンは出さない', tx.includes('この版の Pleiad では同期を続けられません') && tx.includes('新しい版に更新') && !buttonTexts(nodes).includes('今すぐ同期'), tx);
  nodes = render({ ...BASE, state: 'update_required', error: 'api_downgraded' });
  tx = text(nodes);
  t.ok('update_required（api_downgraded）: 止めたことを知らせる文で、回すボタンは出さない',
    tx.includes(tr('settings.plus.syncApiDowngraded')) && !tx.includes('この版の Pleiad では同期を続けられません') && !buttonTexts(nodes).includes('今すぐ同期'), tx);

  // 前の鍵では確かめられない新しい鍵: 人が選ぶまで移らない
  const restarts = [];
  const RS = { keyId: 'key-9', unverified: false, by: 'h-tab', byName: 'tablet', at: '2026-10-21T05:00:00Z' };
  nodes = render({ ...BASE, state: 'waiting_key', wait: { ...V2, holder: false, restarted: RS } }, { onAcceptRestart: k => restarts.push(k) });
  tx = text(nodes);
  t.ok('新しい鍵で始め直された: 自動では移らないことと「新しい鍵を受け取る」',
    tx.includes(tr('settings.plus.syncRestarted')) && buttonTexts(nodes).includes(tr('settings.plus.syncAcceptRestart')), tx);
  byFk(nodes, 'syncAcceptRestart').onclick();
  t.ok('「新しい鍵を受け取る」は onAcceptRestart(見せた keyId)', restarts.at(-1) === 'key-9');
  // 届いた鍵を確かめられなかった: 受け取らずに止めていることと直し方。受け取るボタンは出さない
  for (const [label, wait] of [['包み', { ...V2, holder: false, unverified: true }], ['始め直し', { ...V2, holder: false, restarted: { ...RS, unverified: true } }]]) {
    nodes = render({ ...BASE, state: 'waiting_key', wait }, { onAcceptRestart: k => restarts.push(k) });
    tx = text(nodes);
    t.ok(`確かめられない鍵（${label}）: 受け取らずに止めていることと直し方。受け取るボタンは出さない`,
      tx.includes(tr('settings.plus.syncKeyUnverified')) && tx.includes(tr('settings.plus.syncKeyUnverifiedHint')) && byFk(nodes, 'syncAcceptRestart') === null, tx);
  }
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
