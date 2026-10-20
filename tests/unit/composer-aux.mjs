// 入力欄の下の帯の補足情報（web/composer-aux.mjs）: 作業場所が同じなら会話の id が変わっただけで消さず、確認中・取得失敗を「書き込みなし」と扱わない。
import { createAuxSlot, beginAux, settleAux, clearAux, auxState, auxData } from '../../web/composer-aux.mjs';

export const name = 'composer-aux';
export const title = '入力欄の帯: 確認中・取得失敗を安全と扱わず、作業場所が同じなら会話の id の変更で消さない';

export default function (t) {
  const repo = { scope: '/repo\nclaude\ndefault' };
  const busy = { git: true, conflicts: [{ sessionId: 'other', title: '別の会話' }], canSplit: true };

  // ---- 取り始め: 値が無い間は確認中。「書き込みなし」とは読ませない ----
  {
    const slot = createAuxSlot();
    t.ok('まだ何も取っていなければ確認中', auxState(slot) === 'checking' && auxData(slot) === null);
    const ticket = beginAux(slot, repo);
    t.ok('取り始めても、返るまでは確認中（値は null のまま）', auxState(slot) === 'checking' && auxData(slot) === null);
    t.ok('応答を載せたら確定', settleAux(slot, ticket, { ok: true, data: busy }) && auxState(slot) === 'confirmed' && auxData(slot) === busy);
  }

  // ---- 草稿からできた会話（作業場所は同じ）: 消さずに静かに取り直す ----
  {
    const slot = createAuxSlot();
    settleAux(slot, beginAux(slot, { ...repo, owner: '' }), { ok: true, data: busy });
    const ticket = beginAux(slot, { ...repo, owner: 'new-session' });
    t.ok('会話の id が変わっただけなら、確定した値を保つ（帯が一度消えて描き直されない）', auxState(slot, 'new-session') === 'confirmed' && auxData(slot, 'new-session') === busy);
    settleAux(slot, ticket, { ok: true, data: { ...busy, conflicts: [] } });
    t.ok('取り直した結果で更新する', auxData(slot, 'new-session').conflicts.length === 0);
  }

  // ---- 別の会話へ移る: その会話を除いて数えた値は、別の会話の分では確かでない ----
  {
    const slot = createAuxSlot();
    settleAux(slot, beginAux(slot, { ...repo, owner: 'a' }), { ok: true, data: { ...busy, conflicts: [] } });
    beginAux(slot, { ...repo, owner: 'b' });
    t.ok('会話 a を除いて数えた「書き込みなし」を、会話 b の分として出さない（確認中に戻す）', auxState(slot, 'b') === 'checking' && auxData(slot, 'b') === null);
    t.ok('会話 a の欄に戻れば、a の確定した値はそのまま確かな値', auxState(slot, 'a') === 'confirmed');
  }

  // ---- 作業場所が変わる: 前の作業場所の値は捨てる ----
  {
    const slot = createAuxSlot();
    settleAux(slot, beginAux(slot, repo), { ok: true, data: busy });
    beginAux(slot, { scope: '/other\nclaude\ndefault' });
    t.ok('作業場所が変わったら、前の作業場所の「書き込み中」を出し続けない', auxState(slot) === 'checking' && auxData(slot) === null);
  }

  // ---- 失敗: 確定した値を消さず、無ければ失敗（安全と扱わない） ----
  {
    const slot = createAuxSlot();
    t.ok('値が無いまま失敗したら、失敗として区別する（「書き込みなし」ではない）', settleAux(slot, beginAux(slot, repo), { ok: false }) && auxState(slot) === 'failed' && auxData(slot) === null);
    settleAux(slot, beginAux(slot, repo), { ok: true, data: busy });
    settleAux(slot, beginAux(slot, repo), { ok: false });
    t.ok('取り直しが失敗したら、最後の値は保つが確定とは扱わない（失敗として伝える）', auxState(slot) === 'failed' && auxData(slot) === busy);
    t.ok('失敗の後の取り直しは、値が無ければ確認中に戻る', (() => { const s = createAuxSlot(); settleAux(s, beginAux(s, repo), { ok: false }); beginAux(s, repo); return auxState(s) === 'checking'; })());
  }

  // ---- 「書き込みなし」と確かめた後の取り直しが失敗: 無しの確認を保たない（値は null のまま、状態は失敗） ----
  {
    const slot = createAuxSlot();
    settleAux(slot, beginAux(slot, repo), { ok: true, data: null });
    t.ok('無しと確かめた直後は確定', auxState(slot) === 'confirmed');
    beginAux(slot, repo);
    t.ok('確定済みの同じ作業場所を静かに取り直している間は、前の確定を保つ（帯を描き直さない）', auxState(slot) === 'confirmed');
    settleAux(slot, slot.ticket, { ok: false });
    t.ok('取り直しが失敗したら「無しが確認できた」とは扱わない', auxState(slot) === 'failed' && auxData(slot) === null);
    beginAux(slot, repo);
    t.ok('失敗の後に取り直し始めたら、確認中（まだ無しとは言えない）', auxState(slot) === 'checking');
    settleAux(slot, slot.ticket, { ok: true, data: null });
    t.ok('取り直しが成功したら、また確定', auxState(slot) === 'confirmed');
  }

  // ---- 遅れて届いた古い応答は、後から取り始めた結果を上書きしない ----
  {
    const slot = createAuxSlot();
    const first = beginAux(slot, repo);
    const second = beginAux(slot, repo);
    t.ok('後の応答が先に届き、前の応答が遅れて届いても、前の応答は載せない', settleAux(slot, second, { ok: true, data: null }) && !settleAux(slot, first, { ok: true, data: busy }) && auxData(slot) === null);
    const stale = beginAux(slot, repo);
    beginAux(slot, { scope: '/other\nclaude\ndefault' });
    t.ok('作業場所を変えた後に届いた前の作業場所の応答は載せない', !settleAux(slot, stale, { ok: true, data: busy }) && auxData(slot) === null);
  }

  // ---- git でないと確かめた場合は、確定した「無し」（確認中と区別する） ----
  {
    const slot = createAuxSlot();
    settleAux(slot, beginAux(slot, repo), { ok: true, data: null });
    t.ok('git でないと確かめたら、確定（値は null）', auxState(slot) === 'confirmed' && auxData(slot) === null);
    clearAux(slot);
    t.ok('問い合わせる先が無いときは、確認中のまま残さず確定した「無し」にする', auxState(slot) === 'confirmed');
    const ticket = beginAux(slot, repo);
    clearAux(slot);
    t.ok('捨てた後に届いた応答は載せない', !settleAux(slot, ticket, { ok: true, data: busy }) && auxData(slot) === null);
  }
}
