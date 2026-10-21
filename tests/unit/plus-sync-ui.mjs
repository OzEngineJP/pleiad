// 設定 › Pleiad Plus の「同期」（web/plus-sync.mjs）: 状態ごとの行とボタン・書式（DOM の代役）
import assert from 'node:assert/strict';
import { renderSync, syncTimeText, megaBytes } from '../../web/plus-sync.mjs';

export const name = 'plus-sync-ui';
export const title = '設定 › Pleiad Plus の同期: 状態ごとの中身・確かめ・鍵を待つ場面と始め直しの窓・登録の外れ・時刻と MB の書式（DOM の代役）';

const text = nodes => nodes.map(n => n.textContent).join(' ');
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
