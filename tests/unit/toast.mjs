// 短い知らせ（web/file-actions.mjs の notify。docs/design-system.md「短い知らせ」）
//   - 4 秒で消える。右端の ✕ ですぐ消せる
//   - ポインターが載っている間・フォーカスが中にある間は消えず、離れたら 4 秒を数え直す
//   - 文は … で切る側の要素に入れ、✕ は別の要素のまま残す。開いているダイアログがあればその中に出す
import { notify } from '../../web/file-actions.mjs';
import { N } from '../lib/dom-stub.mjs';
import { t as tr } from '../../web/i18n.mjs';

export const name = 'toast';
export const title = '短い知らせは ✕ で消せて、載せている間・フォーカスが中にある間は消えない（DOM の代役）';

/** 時計の代役。advance で進めた分だけタイマーが鳴る */
function fakeClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map(); let now = 0, seq = 0;
  globalThis.setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
  globalThis.clearTimeout = id => { timers.delete(id); };
  return {
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    get pending() { return timers.size; },
    restore() { globalThis.setTimeout = real.setTimeout; globalThis.clearTimeout = real.clearTimeout; },
  };
}

export default async function (t) {
  const saved = { body: document.body, querySelector: document.querySelector, activeElement: Object.getOwnPropertyDescriptor(document, 'activeElement') };
  const clock = fakeClock();
  try {
    // 閉じたダイアログも document の中に残る（本物と同じに、閉じたあとも中の知らせを見つけられる）
    const body = new N('body'), dialog = new N('dialog'); let dialogOpen = false;
    document.body = body;
    document.querySelector = selector => selector === 'dialog[open]' ? (dialogOpen ? dialog : null) : (body.querySelector(selector) ?? dialog.querySelector(selector) ?? null);
    // 代役の append は前の親から外さないので、本物と同じに外す
    const settle = node => { for (const parent of [body, dialog]) if (parent !== node.parent) parent.children = parent.children.filter(child => child !== node); };
    document.activeElement = body;
    const send = (node, type, relatedTarget = null) => node.dispatchEvent({ type, relatedTarget });

    // 形
    notify('パスをコピーしました');
    const box = body.querySelector('.file-toast');
    const text = box?.querySelector('.file-toast-text'), close = box?.querySelector('.file-toast-close');
    t.ok('知らせが body に出る', !!box && box.parent === body && box.hidden === false);
    t.ok('文は … で切る側の要素に入り、読み上げ（role="status"）もそこに付く', text?.textContent === 'パスをコピーしました' && text.getAttribute('role') === 'status', text?.outerHTML);
    t.ok('✕ は文とは別のボタンで、名前（aria-label と title）が「閉じる」', close?.tagName === 'BUTTON' && close.type === 'button' && close.getAttribute('aria-label') === tr('files.toastClose') && close.attrs.title === tr('files.toastClose') && tr('files.toastClose') !== 'files.toastClose', close?.outerHTML);
    t.ok('✕ は既存のアイコンのボタン（.btn .btn-icon）で、文の後ろに並ぶ', close.classList.contains('btn') && close.classList.contains('btn-icon') && box.children[0] === text && box.children[1] === close);

    // 4 秒で消える
    clock.advance(3999);
    t.ok('4 秒より前は出たまま', box.hidden === false);
    clock.advance(1);
    t.ok('4 秒で消える', box.hidden === true);

    // 出し直すと同じ箱を使い、数え直す
    notify('一つ目');
    clock.advance(3000);
    notify('とても長い知らせ'.repeat(30));
    t.ok('出し直しても箱は 1 つで、文だけ入れ替わり、✕ は残る', body.querySelectorAll('.file-toast').length === 1 && text.textContent === 'とても長い知らせ'.repeat(30) && box.children.length === 2 && box.children[1] === close);
    clock.advance(3999);
    t.ok('出し直したら 4 秒を数え直す', box.hidden === false);
    clock.advance(1);
    t.ok('数え直した 4 秒で消える', box.hidden === true);

    // ✕ で消す
    notify('開けませんでした');
    clock.advance(500);
    close.click();
    t.ok('✕ を押すとすぐ消える', box.hidden === true);
    t.ok('✕ で消したら、残りのタイマーは無い', clock.pending === 0);
    notify('もう一度');
    t.ok('✕ で消したあとも、次の知らせは出る', box.hidden === false && text.textContent === 'もう一度');
    clock.advance(4000);
    t.ok('次の知らせも 4 秒で消える', box.hidden === true);

    // ポインターが載っている間
    notify('載せている間');
    clock.advance(1000);
    send(box, 'pointerenter');
    clock.advance(60000);
    t.ok('ポインターが載っている間は消えない', box.hidden === false);
    notify('載せている間に次の知らせ');
    clock.advance(60000);
    t.ok('載っている間に出し直しても消えない（文は入れ替わる）', box.hidden === false && text.textContent === '載せている間に次の知らせ');
    send(box, 'pointerleave');
    clock.advance(3999);
    t.ok('離れてから 4 秒より前は出たまま（数え直す）', box.hidden === false);
    clock.advance(1);
    t.ok('離れてから 4 秒で消える', box.hidden === true);

    // 載っている間に ✕ で消したあと、次の知らせは載っていない扱いから始まる
    notify('載せて閉じる');
    send(box, 'pointerenter');
    close.click();
    notify('そのあと');
    clock.advance(4000);
    t.ok('載っている間に ✕ で消したあとの知らせも 4 秒で消える', box.hidden === true);

    // フォーカスが中にある間
    const prev = new N('textarea'); let focused = 0; prev.isConnected = true; prev.focus = () => { focused++; document.activeElement = prev; };
    notify('フォーカス');
    send(box, 'focusin', prev); document.activeElement = close;
    clock.advance(60000);
    t.ok('フォーカスが中にある間は消えない', box.hidden === false);
    send(box, 'pointerenter'); send(box, 'pointerleave');
    clock.advance(60000);
    t.ok('ポインターが離れても、フォーカスが中にあれば消えない', box.hidden === false);
    send(box, 'focusout', close);
    clock.advance(60000);
    t.ok('中から中へ移るフォーカスでは数え始めない', box.hidden === false);
    send(box, 'focusout', prev); document.activeElement = prev;
    clock.advance(3999);
    t.ok('フォーカスが外へ出てから 4 秒より前は出たまま', box.hidden === false);
    clock.advance(1);
    t.ok('フォーカスが外へ出てから 4 秒で消える', box.hidden === true);

    // キーボードで ✕ まで来て閉じたら、来る前に居た所へ返す
    notify('キーボードで閉じる');
    send(box, 'focusin', prev); document.activeElement = close;
    close.click();
    t.ok('フォーカスが中にあるときに ✕ で閉じると、来る前に居た所へフォーカスを返す', box.hidden === true && focused === 1 && document.activeElement === prev);
    notify('マウスで閉じる');
    close.click();
    t.ok('フォーカスが外にあるときは、フォーカスを動かさない', box.hidden === true && focused === 1);

    // 開いているダイアログの中に出す
    dialogOpen = true;
    notify('ダイアログの中'); settle(box);
    t.ok('ダイアログが開いていれば、同じ箱をその中へ移して出す', box.parent === dialog && box.hidden === false && text.textContent === 'ダイアログの中');
    clock.advance(4000);
    t.ok('ダイアログの中でも 4 秒で消える', box.hidden === true);
    dialogOpen = false;
    notify('閉じたあと'); settle(box);
    t.ok('ダイアログを閉じたあとは、同じ箱を body に戻して出す', box.parent === body && box.hidden === false && body.querySelectorAll('.file-toast').length === 1 && dialog.querySelectorAll('.file-toast').length === 0);
    clock.advance(4000);

    // 操作ボタン付き notify(text, { label, onClick }) と、通常 notify への戻し
    let actionClicked = 0;
    notify('送っていません', { label: '開く', onClick: () => { actionClicked++; } });
    const actionBtn = box.querySelector('.file-toast-action');
    t.ok('操作ボタン付きなら .has-action とボタンを ✕ の左に置く', box.classList.contains('has-action') && actionBtn?.textContent === '開く' && box.children.length === 3 && box.children[2] === close);
    actionBtn.click();
    t.ok('操作ボタンを押すと onClick が走り、箱が閉じてボタンも消える', actionClicked === 1 && box.hidden === true && !box.classList.contains('has-action') && !box.querySelector('.file-toast-action'));

    notify('操作なしに戻す');
    t.ok('通常の notify へ戻すと 2 要素だけになる', box.children.length === 2 && !box.classList.contains('has-action'));
    clock.advance(4000);
  } finally {
    clock.restore();
    document.body = saved.body; document.querySelector = saved.querySelector;
    if (saved.activeElement) Object.defineProperty(document, 'activeElement', saved.activeElement); else delete document.activeElement;
  }
}
