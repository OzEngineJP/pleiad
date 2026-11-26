// 接続先のカード（web/conn-card.mjs）のログアウトまわり（docs/design-system.md「接続先の一覧」承認済み 2026-11-26）:
//   - 押した操作の失敗（ログアウトの失敗など）は、押したカードの中に赤の一文（.mp-state[role=alert]）で出す
//   - 外す前の確かめ（connConfirm）は、渡した文で確かめられる（Antigravity のログアウト）。渡さなければ今までの削除の文。Esc は［やめる］と同じ
//   - 確かめを挟むのは記述の印 logoutConfirm を持つエージェントだけ（Antigravity）。Claude・Codex・Grok は確かめ無しのまま（id では分けない）
import { AGENTS, agentPresentation } from '../../core/backends/agents.mjs';

export const name = 'conn-card-logout';
export const title = '接続先のカード: 失敗の一文はカードの中・確かめの文・Esc・logoutConfirm の印は Antigravity だけ';

const find = (node, pred) => {
  if (pred(node)) return node;
  for (const c of node.children ?? []) { const hit = find(c, pred); if (hit) return hit; }
  return null;
};
const byConfirm = (box, which) => find(box, n => n.attrs?.['data-confirm'] === which);

export default async function (t) {
  const i18n = await import('../../web/i18n.mjs');
  const saved = i18n.lang;
  await i18n.setLanguage('ja');
  try {
    const { connCard, connConfirm } = await import('../../web/conn-card.mjs');
    const { t: tr } = i18n;

    // ---- 失敗の一文はカードの中（#setupError ではない）
    const card = connCard({ name: 'CLI のログイン', status: 'ログイン済み', actions: [{ label: 'ログアウト', act: 'logout', onClick: () => {} }], note: 'ログアウトできませんでした: agy がログアウトを受け付けませんでした' });
    const note = find(card, n => n.attrs?.role === 'alert');
    t.ok('失敗の一文がカードの中に出る', note && note.tagName === 'P' && note.classList.contains('mp-state'), card.outerHTML);
    t.ok('失敗の一文は状態の行より後（カードの最後）', card.children.at(-1) === note, card.outerHTML);
    t.ok('文はそのまま出る', note?.textContent === 'ログアウトできませんでした: agy がログアウトを受け付けませんでした', note?.textContent);
    const plain = connCard({ name: 'CLI のログイン', status: 'ログイン済み' });
    t.ok('失敗が無ければ一文は出さない', !find(plain, n => n.attrs?.role === 'alert'), plain.outerHTML);

    // ---- 確かめ: Antigravity のログアウトの文と［やめる］［ログアウト］
    let no = 0, yes = 0;
    const text = tr(AGENTS.antigravity.logoutConfirm);
    t.ok('Antigravity の確かめの文（ja）', text === 'Antigravity からログアウトしますか？この PC の Antigravity のアプリと、端末の agy もログアウトします。', text);
    const box = connConfirm({ text, yesLabel: tr('conn.logout'), onNo: () => { no++; }, onYes: () => { yes++; } });
    t.ok('渡した文で確かめる', box.children[0]?.textContent === text, box.outerHTML);
    const noBtn = byConfirm(box, 'no'), yesBtn = byConfirm(box, 'yes');
    t.ok('ボタンは［やめる］と［ログアウト］（危ない操作の色）', noBtn?.textContent === tr('conn.cancel') && yesBtn?.textContent === tr('conn.logout') && yesBtn.classList.contains('danger'),
      `${noBtn?.textContent} ${yesBtn?.textContent}`);
    noBtn.click();
    t.ok('［やめる］は onNo', no === 1 && yes === 0);
    yesBtn.click();
    t.ok('［ログアウト］は onYes', yes === 1);
    let prevented = false;
    box.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
    t.ok('Esc は［やめる］と同じ（設定の画面は閉じない）', no === 2 && prevented);
    box.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} });
    t.ok('ほかのキーでは閉じない', no === 2);

    // ---- 文を渡さなければ今までの削除の確かめ
    const del = connConfirm({ name: '仕事', withKey: true, onNo: () => {}, onYes: () => {} });
    t.ok('削除の確かめは今までの文のまま', del.children[0]?.textContent === `${tr('conn.confirmDelete', { name: '仕事' })}${tr('conn.keyAlsoDeleted')}`, del.children[0]?.textContent);
    t.ok('削除の確かめのボタンは［削除］', byConfirm(del, 'yes')?.textContent === tr('conn.delete'));

    // ---- 確かめを挟むのは印 logoutConfirm を持つエージェントだけ
    for (const id of ['claude', 'codex', 'grok']) {
      t.ok(`${id}: ログアウトは確かめ無しのまま（logoutConfirm は null）`, AGENTS[id].logoutConfirm === null && agentPresentation(id).logoutConfirm === null,
        JSON.stringify(agentPresentation(id).logoutConfirm));
    }
    t.ok('antigravity: 画面へ確かめの文の鍵が届く', agentPresentation('antigravity').logoutConfirm === 'conn.logoutConfirm.antigravity');
    await i18n.setLanguage('en');
    t.ok('英語の確かめの文もある', tr(AGENTS.antigravity.logoutConfirm).startsWith('Sign out of Antigravity?'), tr(AGENTS.antigravity.logoutConfirm));
  } finally {
    await i18n.setLanguage(saved);
  }
}
