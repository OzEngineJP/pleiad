// 作業のダイアログ（#workDialog）の一覧の開け閉め。メインの脇の決まり（web/client.mjs の「脇の開閉」・web/file-preview.css の
// 761〜1150px で脇を畳む決まり）に合わせ、違いはモーダルが 0 ではなく 52px のレールを残すこと（docs/design-system.md「バックグラウンド」）。
//   ・広さの決まり（RAIL・LIST・CONV_MIN・自動で畳む幅）と、右の欄の幅の式はこのファイルが持つ（web/file-preview.mjs も使う）。
//   ・状態は { folded, auto }。auto は「右の欄を開いたとき、自動で畳んだ」印で、欄を閉じるときに戻すのは auto のときだけ。
//     利用者が決めた状態（folded を押した・保存した状態）は、自動では変えない
//   ・DOM は dialog に付ける list-folded / list-moving の 2 つのクラスと、2 つのボタンだけ（見た目は style.css）

export const RAIL = 52;          // 畳んだ一覧の列の幅（メインの --rail-w と同じ）
export const LIST = 320;         // 開いた一覧の列の幅
export const CONV_MIN = 360;     // 会話の列の最小の幅（これを割らないよう右の欄が縮む）
export const AUTO_MIN = 761;     // 右の欄を開いたとき一覧を自動で畳む幅（メインの脇と同じ範囲）
export const AUTO_MAX = 1150;
export const SIDE_STORE = 'agent-host-work-list';
export const PANE_MAX = 520;

export const autoRange = vw => vw >= AUTO_MIN && vw <= AUTO_MAX;
export const listWidth = folded => (folded ? RAIL : LIST);

/** 保存した値（'folded' / 'open'）から、最初の状態を作る */
export const initialState = saved => ({ folded: saved === 'folded', auto: false });

/** 右の欄が開いた。自動で畳める幅で一覧が開いていれば畳み、auto の印を付ける */
export function paneOpened(state, vw) {
  if (autoRange(vw) && !state.folded) return { folded: true, auto: true };
  return state;
}
/** 右の欄が閉じた。自動で畳んだ分だけ開き直す（利用者が畳んだ状態は触らない） */
export function paneClosed(state) {
  return state.auto ? { folded: false, auto: false } : state;
}
/** 窓の幅が変わった。自動で畳んだ後に 3 列が入る幅（1150px 超）になったら開き直す */
export function resized(state, vw) {
  return state.auto && vw > AUTO_MAX ? { folded: false, auto: false } : state;
}
/** 利用者が決めた。以降は自動で変えない */
export const userSet = folded => ({ folded, auto: false });

/**
 * ダイアログの中の右の欄の幅(px)。窓の 96%（ダイアログの最大幅）から一覧の列を除いた分を分母にし、
 * 会話の列に CONV_MIN を残す。目安は 48%（300px 以上・520px まで）で、足りなければ 0 まで縮む（一覧を開き直したときも会話を割らない）。
 * fixed は幅を決めた中身（目次など）の幅
 */
export function modalPaneWidth(vw, folded, { percentage = 48, fixed = 0 } = {}) {
  const available = Math.round(vw * 0.96) - listWidth(folded);
  const room = Math.max(0, available - CONV_MIN);
  const want = fixed || Math.min(PANE_MAX, Math.max(300, available * percentage / 100));
  return Math.min(room, want);
}

/**
 * 一覧の開け閉めの部品。dialog が開いている間だけ生きる想定で、begin() で保存した状態を戻し、
 * 右の欄の開閉は dialog に飛ぶ 'file-preview:layout' で受ける（web/file-preview.mjs の layout が、幅を決める前に飛ばす）。
 * @param {object} o
 * @param {HTMLElement} o.dialog   list-folded / list-moving を付ける
 * @param {HTMLElement} o.openButton  畳んだ列の左上の「一覧を開く」
 * @param {HTMLElement} o.closeButton  一覧の右上の「一覧を閉じる」
 * @param {() => number} o.width   窓の幅
 * @param {() => number} o.duration  動きの長さ(ms)。動きを減らす設定では 0
 * @param {() => boolean} o.steps  700px 以下（一覧・会話・ページの 3 段）か。畳む操作は無い
 * @param {{get:()=>string|null,set:(v:string)=>void}} o.store
 * @param {() => void} [o.relayout]  畳んだ・開いた後に右の欄の幅を測り直す
 * @param {(waiting:boolean)=>void} [o.paint]  開くボタンの名前と ◆
 */
export function createWorkSide({ dialog, openButton, closeButton, width, duration, steps, store, relayout, paint }) {
  let state = { folded: false, auto: false };
  let paneOpen = false, timer = 0, waiting = false;
  const apply = (next, { animate = true } = {}) => {
    const changed = next.folded !== state.folded;
    state = next;
    if (!changed) return;
    const ms = animate ? duration() : 0;
    clearTimeout(timer);
    if (ms > 0) {
      dialog.classList.add('list-moving');
      timer = setTimeout(() => { dialog.classList.remove('list-moving'); relayout?.(); }, ms + 40);
    } else dialog.classList.remove('list-moving');
    dialog.classList.toggle('list-folded', state.folded);
    paint?.(waiting);
  };
  const api = {
    /** ダイアログを開くとき。保存した状態に戻す（動きなし） */
    begin() {
      paneOpen = false;
      clearTimeout(timer);
      dialog.classList.remove('list-moving');
      state = initialState(store.get());
      dialog.classList.toggle('list-folded', state.folded);
      paint?.(waiting);
    },
    /** ダイアログを閉じたとき。印を外す */
    end() {
      clearTimeout(timer);
      dialog.classList.remove('list-moving', 'list-folded');
      paneOpen = false; state = { folded: false, auto: false };
    },
    /** 右の欄の layout の前（open はその時点の開閉）。畳む・開き直すをここで決める */
    layout(open) {
      if (open !== paneOpen) { paneOpen = open; apply(open ? paneOpened(state, width()) : paneClosed(state)); }
      else if (open) apply(resized(state, width()));
    },
    /** 利用者の操作（ボタン・Ctrl+B）。押したボタンは消えるので、反対側のボタンへ焦点を移す */
    set(folded, { focus = true } = {}) {
      if (steps()) return false;
      apply(userSet(folded));
      try { store.set(folded ? 'folded' : 'open'); } catch { /* 保存できなくても動く */ }
      relayout?.();
      if (focus) (folded ? openButton : closeButton).focus({ preventScroll: true });
      return true;
    },
    toggle() { return api.set(!state.folded); },
    /** 承認待ちの子がいるか（開くボタンの ◆） */
    setWaiting(value) { waiting = Boolean(value); paint?.(waiting); },
    folded: () => state.folded,
    state: () => ({ ...state }),
  };
  openButton.onclick = () => api.set(false);
  closeButton.onclick = () => api.set(true);
  return api;
}
