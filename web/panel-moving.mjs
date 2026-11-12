// 右の欄が開け閉めで動いている間（body.file-preview-moving）、会話の列の幅に反応する処理を止め、止まったときに 1 度だけやり直す。
// 右の欄の動きは毎コマ列の幅が替わるため、幅の変化ごとに量り直す処理（ResizeObserver）をそのまま走らせると、
// コマごとに全体のレイアウトを強制して重くなる（docs/design-system.md §8「動きの語彙」）。
// 左の脇の欄の side-moving（web/client.mjs の setSidebar）は別の仕組み（class と setTimeout 後の直呼び）で、ここは通らない
// - 止められるのは、動く間の見た目に効かない処理だけ。動く間の見た目が替わる処理（入力欄の下の行を 1 行に収める fitRow など）は
//   止めずに、量る回数を減らす
// - 止まった合図は、閉じる動きの片付け（file-preview-leaving を外す）まで済んだ後に 1 度だけ出す（file-preview.mjs の announceSettled）
// - やり直しは、合図が出たコマの次のコマの頭で 1 度（止まったコマのレイアウトの前ではなく、ばねの最後の rAF の外で）。
//   その間に届いた呼び出しは捨てずに、そのやり直しに束ねる（やり直しは届いた後に走るので、最後の姿を読む）
// - 同じ仕事を呼ぶ口は 1 つの whileStill にまとめる（口ごとに止まった瞬間のやり直しが走るため）
// - 見張りの一覧（registry）に載るのは「止めた呼び出しを抱えている間」だけ。作っただけでは載らず、止まってやり直した（捨てた）ら外れる。
//   持ち主が閉じ方を持たなくても、抱えた分は次に止まったときに 1 度で外れるので、残り続けるものが無い

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

// 止まった合図を受けるのは document に 1 本だけ。whileStill ごとに足さない（呼ぶたびに閉じる口の無いリスナーが残るため）
// 一覧に載るのは、動いている間に呼ばれて止めた分を抱えている口だけ
const registry = new Set();
let listeningOn = null;
function listen() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function' || listeningOn === document) return;
  listeningOn = document;
  document.addEventListener(RIGHT_SETTLED_EVENT, () => { for (const entry of [...registry]) entry.settled(); });
}
/** 止めた呼び出しを抱えている口の数（試験用。止まってやり直したあとは 0 に戻ること） */
export const stillWatchers = () => registry.size;

// 合図の次のコマで走らせる。ページが裏に回って rAF が止まっても残らないよう、時間でも拾う
const FALLBACK_MS = 120;

/**
 * run を「右の欄が動いている間は走らせず、止まったときに 1 度だけ走らせる」形で包む。
 * 動いていないときは、呼ばれたとおりにすぐ走らせる。引数なしでやり直せる処理に使う（ResizeObserver の entries は渡せない）。
 * replay は止まったときにやり直す内容（既定は run）。run が次のコマへ回す形（rAF でまとめる）でも、止まった所はすぐやり直したいとき。
 * signal は、持ち主を閉じるとき（作業ダイアログの子の会話など、何度も作られるもの）にリスナーを外す口。閉じた後は何も走らない
 */
export function whileStill(run, { replay = run, signal = null } = {}) {
  let pending = false, settling = false, disposed = false, frame = 0, timer = 0;
  const cancel = () => {
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    clearTimeout(timer); frame = 0; timer = 0;
  };
  const flush = () => {
    cancel();
    if (!settling) return;
    settling = false;
    if (disposed) return;
    if (!pending) { registry.delete(entry); return; }
    if (rightPanelMoving()) return;   // 合図の直後に折り返した。抱えたまま、次に止まったときに出る合図で走らせる
    pending = false;
    registry.delete(entry);
    replay();
  };
  const entry = {
    settled() {
      if (disposed) return;
      if (!pending) { registry.delete(entry); return; }   // 動いている間に抱えたあと、止まる前にすぐ走って空になった分
      settling = true;
      cancel();
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush);
      timer = setTimeout(flush, FALLBACK_MS);
    },
  };
  const stop = () => { disposed = true; pending = false; settling = false; cancel(); registry.delete(entry); };
  if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
  return (...args) => {
    if (disposed) return;
    if (rightPanelMoving() || settling) { pending = true; registry.add(entry); listen(); return; }
    pending = false;
    registry.delete(entry);   // 動いている間に抱えたあと、止まる合図の前に呼ばれてすぐ走った分は、もう抱えていない
    run(...args);
  };
}
