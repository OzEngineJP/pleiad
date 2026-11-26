// 「サイドバーを開く」の印（docs/design-system.md §4.1「脇を閉じている間の印」）。
// 脇が見えていない間（700px 以下の引き出し・広い画面で閉じたとき）も、ほかの会話の完了・承認待ちに気付けるようにする。
//   承認待ちがあれば ◆（差し色。2 件以上なら数を添える。グループの要約と同じ規則）、無ければ未確認の青い丸。
//   件数はボタンのアクセシブルな名前に入れる（印は aria-hidden。色だけに頼らない: 名前と形の違う ● / ◆）。
//   今開いている会話は数えない。脇が見えている間は開くボタンごと隠れる（style.css の .side-opener）

/**
 * 今の会話を除いた、承認待ちと完了・未確認の件数。
 * 未確認は一覧の行と同じく、走っている・裏で待っている会話では数えない（行では弧・衛星が勝つ）
 */
export function attentionCounts(sessions, { currentId = null, waitingIds = new Set(), unreadIds = new Set(), busyIds = new Set() } = {}) {
  let waiting = 0, unread = 0;
  for (const s of sessions ?? []) {
    if (!s?.id || s.id === currentId) continue;
    if (waitingIds.has(s.id)) waiting++;
    if (unreadIds.has(s.id) && !busyIds.has(s.id)) unread++;
  }
  return { waiting, unread };
}

function ensureMark(button) {
  let mark = button.querySelector('.side-mark');
  if (!mark) {
    mark = document.createElement('span');
    mark.className = 'side-mark';
    mark.setAttribute('aria-hidden', 'true');
    button.append(mark);
  }
  return mark;
}

/**
 * 作業のダイアログの「一覧を開く」ボタン（畳んだ列の左上）の印と名前。承認待ちの子がいる間だけ ◆ を 1 つ（件数は付けない。
 * 脇の印と同じ形）。名前は「一覧を開く（承認待ちあり）」。未確認の丸は持たない（段 1 の一覧は未確認の印を持たない）
 */
export function paintOpenList(button, waiting, t) {
  if (!waiting) {
    button.querySelector('.side-mark')?.remove();
    button.setAttribute('aria-label', t('dialog.work.openList'));
    return;
  }
  const mark = ensureMark(button);
  mark.dataset.kind = 'wait';
  mark.textContent = '';
  button.setAttribute('aria-label', t('dialog.work.openListWaiting'));
}

// 脇を開く入口（≡）は、Chats・チャンネル・DM・スレッド・bot のページの頭にある（どれも .side-opener）。
// 印・名前・開閉の状態（aria-expanded）は全部に同じものを付ける。後から組まれる ≡（スレッドの頭）は adoptOpenSidebar で今の印を受け取る
let last = { counts: {}, t: null, expanded: null };

/** ページの中の ≡ を全部、同じ件数で塗る */
export function paintOpenSidebars(counts, t, root = document) {
  last = { ...last, counts, t };
  for (const b of root.querySelectorAll('.side-opener')) paintOpenSidebar(b, counts, t);
}

/** 引き出しの開け閉めを、ページの中の ≡ の全部に写す */
export function setOpenSidebarsExpanded(open, root = document) {
  last = { ...last, expanded: Boolean(open) };
  for (const b of root.querySelectorAll('.side-opener')) b.setAttribute('aria-expanded', String(Boolean(open)));
}

/** 後から組んだ ≡ に、今の印・名前・開閉の状態を付ける */
export function adoptOpenSidebar(button) {
  if (last.t) paintOpenSidebar(button, last.counts, last.t);
  if (last.expanded !== null) button.setAttribute('aria-expanded', String(last.expanded));
}

/** 開くボタンに印とアクセシブルな名前を付ける */
export function paintOpenSidebar(button, { waiting = 0, unread = 0 } = {}, t) {
  if (!waiting && !unread) {
    button.querySelector('.side-mark')?.remove();
    button.setAttribute('aria-label', t('app.openSidebar'));
    return;
  }
  const mark = ensureMark(button);
  mark.dataset.kind = waiting ? 'wait' : 'unread';
  mark.textContent = waiting > 1 ? String(waiting) : '';
  const parts = [];
  if (waiting) parts.push(t('sidebar.waitingCount', { count: waiting }));
  if (unread) parts.push(t('sidebar.unreadCount', { count: unread }));
  button.setAttribute('aria-label', t('app.openSidebarWith', { detail: parts.join(' · ') }));
}
