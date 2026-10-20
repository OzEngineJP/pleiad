// 入力欄の下の帯（作業場所のチップの git のブランチ・「ほかの会話も書き込み中」）の元になる補足情報の持ち方（DOM を触らない。
// tests/unit/composer-aux.mjs から直接呼ぶ）。補足情報は作業場所（scope）ごとに取り、確認中・取得失敗・確定を区別する。
//  - scope（作業場所・エージェント・モード）が同じなら、会話の id が変わっただけ（新しい会話ができた）で消さない。静かに取り直す
//  - scope が変わったら、前の作業場所の値は捨てる（別の作業場所の「書き込み中」を出し続けない）
//  - 確認中・取得失敗を「書き込みなし」の顔で出さない（auxState が 'checking' / 'failed' を返す間は、呼び手が印を出す）。
//    最後に確定した値は取り直しの失敗・確認中でも保つ（auxData）が、信頼できるかは auxState で別に伝える

/** 補足情報の入れ物。client.mjs の state.git・state.worktree に使う */
export const createAuxSlot = () => ({ scope: null, owner: '', dataOwner: null, data: null, status: 'checking', ticket: 0 });

/**
 * 取り直しを始める。返す番号を settleAux に渡す（後から始めた取り直しがあれば、先の応答は捨てられる）。
 * owner は、結果が会話ごとに変わる補足情報（書き込み中の別の会話は、その会話自身を除いて数える）の持ち主。
 * 草稿の欄（owner ''）で取った結果は、自分を除かない一覧なので、できた会話でもそのまま使える（多めに数えるだけ）
 */
export function beginAux(slot, { scope, owner = '' }) {
  if (slot.scope !== scope) { slot.data = null; slot.dataOwner = null; slot.status = 'checking'; }
  else if (slot.status !== 'confirmed') slot.status = 'checking';
  slot.scope = scope;
  slot.owner = owner;
  return ++slot.ticket;
}

/** 取り直しの結果を載せる。後から始めた取り直しがあれば false（載せない）。失敗は、最後に確定した値を消さずに status だけ 'failed' にする */
export function settleAux(slot, ticket, { ok, data = null }) {
  if (ticket !== slot.ticket) return false;
  if (ok) { slot.data = data ?? null; slot.dataOwner = slot.owner; slot.status = 'confirmed'; }
  else slot.status = 'failed';
  return true;
}

/** 取り直しを待たずに捨てる（作業場所が無いなど、問い合わせる先が無いとき）。確定した「無し」にする */
export function clearAux(slot, owner = '') {
  slot.ticket += 1;
  slot.scope = ''; slot.owner = owner; slot.data = null; slot.dataOwner = owner; slot.status = 'confirmed';
}

/** この持ち主に使える値（最後に確定したもの）があるか。持ち主を除いて数える値は、別の持ち主の分には使えない */
const fits = (slot, owner) => slot.dataOwner !== null && (slot.dataOwner === '' || slot.dataOwner === owner);

/**
 * いまの答えを信頼してよいか。'confirmed'（最後の取り直しが成功し、data が答え。null は「無い」と確かめた）/
 * 'checking'（取り直している最中）/ 'failed'（最後の取り直しが失敗）。
 * 取り直しが失敗・確認中の間は、最後の値を持っていても 'confirmed' にしない（「無しと確かめた」扱いを避ける）
 */
export function auxState(slot, owner = '') {
  if (slot.status === 'confirmed') return fits(slot, owner) ? 'confirmed' : 'checking';
  return slot.status;
}

/**
 * この持ち主に使える最後の値（無ければ null）。取り直しの失敗・確認中でも消さない。null は「無い」とも「まだ無い」ともなるので、
 * 「無し」と読むのは auxState が 'confirmed' のときだけ
 */
export const auxData = (slot, owner = '') => (fits(slot, owner) ? slot.data : null);
