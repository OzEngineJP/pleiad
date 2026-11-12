// 右の欄が開け閉めで動いている間（body.file-preview-moving）、会話の列の幅に反応する処理を止め、止まったときに 1 度だけやり直す。
// 左の脇の欄の side-moving の見張り（web/client.mjs の setSidebar）と同じ形で、右の欄の動きは毎コマ列の幅が替わるため、
// 幅の変化ごとに量り直す処理（ResizeObserver）をそのまま走らせると、コマごとに全体のレイアウトを強制して重くなる
// （docs/design-system.md §8「動きの語彙」）。
// - 止められるのは、動く間の見た目に効かない処理だけ。動く間の見た目が替わる処理（入力欄の下の行を 1 行に収める fitRow など）は
//   止めずに、量る回数を減らす
// - 止まった合図は、閉じる動きの片付け（file-preview-leaving を外す）まで済んだ後に 1 度だけ出す（file-preview.mjs の announceSettled）

export const RIGHT_MOVING_CLASS = 'file-preview-moving';
export const RIGHT_SETTLED_EVENT = 'right-panel-settled';

export const rightPanelMoving = () => typeof document !== 'undefined' && !!document.body && document.body.classList.contains(RIGHT_MOVING_CLASS);

/** 動きが止まって、列の幅が最後に落ち着いた。動いている間に止めた処理をここで 1 度だけやり直す（file-preview.mjs が呼ぶ） */
export function announceSettled() {
  if (typeof document === 'undefined') return;
  // 閉じる動きは、ばねが止まった同じ呼び出しの中で片付け（file-preview-leaving を外す）が続く。その後に出す
  queueMicrotask(() => {
    if (rightPanelMoving()) return;   // 止まった直後に逆へ折り返した。次に止まったときに出す
    document.dispatchEvent(new Event(RIGHT_SETTLED_EVENT));
  });
}

/**
 * run を「右の欄が動いている間は走らせず、止まったときに 1 度だけ走らせる」形で包む。
 * 動いていないときは、呼ばれたとおりにすぐ走らせる。引数なしでやり直せる処理に使う（ResizeObserver の entries は渡せない）。
 * replay は止まったときにやり直す内容（既定は run）。run が次のコマへ回す形（rAF でまとめる）でも、止まった所はすぐやり直したいとき
 */
export function whileStill(run, replay = run) {
  let pending = false, replayed = false;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener(RIGHT_SETTLED_EVENT, () => {
      if (!pending) return;
      pending = false; replay();
      // 合図は描画の前に出る。同じコマの後ろで届く ResizeObserver は、いま落ち着いた幅で済んでいるので走らせない
      replayed = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { replayed = false; });
      else replayed = false;
    });
  }
  return (...args) => {
    if (rightPanelMoving()) { pending = true; return; }
    if (replayed) return;
    pending = false;
    run(...args);
  };
}
