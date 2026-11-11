// 作業のダイアログの一覧の開け閉め（web/work-side.mjs）: 広さの決まり・自動で畳む範囲・開き直す条件・右の欄の幅の式・部品の動き。
//   見た目と動き（押し出し・重ならない・ボタンの位置）は実ブラウザーの tests/browser/work-dialog-list.mjs が見る
import fs from 'node:fs/promises';
import { N } from '../lib/dom-stub.mjs';
import { RAIL, LIST, CONV_MIN, AUTO_MIN, AUTO_MAX, autoRange, listWidth, initialState, paneOpened, paneClosed, resized, userSet, modalPaneWidth, createWorkSide } from '../../web/work-side.mjs';
import { paintOpenList } from '../../web/open-sidebar-mark.mjs';

export const name = 'work-side';
export const title = '作業のダイアログの一覧の開け閉め（自動で畳む範囲・会話の最小幅・開き直す条件・◆・フォーカス）';

export default async function(t) {
  // ---- 決まりの値（メインの脇と同じ範囲）
  t.ok('レール 52・一覧 320・会話の最小 360・自動で畳むのは 761〜1150', RAIL === 52 && LIST === 320 && CONV_MIN === 360 && AUTO_MIN === 761 && AUTO_MAX === 1150);
  t.ok('自動で畳む範囲の境（760 は畳まない・761 は畳む・1150 は畳む・1151 は畳まない）', !autoRange(760) && autoRange(761) && autoRange(1150) && !autoRange(1151));
  t.ok('列の幅', listWidth(false) === 320 && listWidth(true) === 52);

  // ---- 状態の遷移
  t.ok('保存した畳みは次の最初の状態になる（auto ではない）', JSON.stringify(initialState('folded')) === '{"folded":true,"auto":false}' && JSON.stringify(initialState('open')) === '{"folded":false,"auto":false}' && initialState(null).folded === false);
  t.ok('欄が開くと、範囲内で開いていた一覧は auto で畳む', JSON.stringify(paneOpened({ folded: false, auto: false }, 1100)) === '{"folded":true,"auto":true}');
  t.ok('範囲の外（1280・760）では畳まない', paneOpened({ folded: false, auto: false }, 1280).folded === false && paneOpened({ folded: false, auto: false }, 760).folded === false);
  t.ok('利用者が畳んでいれば、auto の印は付けない', JSON.stringify(paneOpened({ folded: true, auto: false }, 1100)) === '{"folded":true,"auto":false}');
  t.ok('欄が閉じると、auto で畳んだ分だけ開き直す', JSON.stringify(paneClosed({ folded: true, auto: true })) === '{"folded":false,"auto":false}' && JSON.stringify(paneClosed({ folded: true, auto: false })) === '{"folded":true,"auto":false}' && paneClosed({ folded: false, auto: false }).folded === false);
  t.ok('auto で畳んだ後に窓が 3 列の入る幅へ広がったら開き直す（範囲の中では動かさない）', resized({ folded: true, auto: true }, 1200).folded === false && resized({ folded: true, auto: true }, 1150).folded === true && resized({ folded: true, auto: false }, 1400).folded === true);
  t.ok('利用者の操作は auto を外す', JSON.stringify(userSet(false)) === '{"folded":false,"auto":false}' && JSON.stringify(userSet(true)) === '{"folded":true,"auto":false}');

  // ---- 右の欄の幅の式: 会話に 360px を残す（窓の 96% が分母）
  const conv = (vw, folded, o) => Math.round(vw * 0.96) - listWidth(folded) - modalPaneWidth(vw, folded, o);
  for (const vw of [701, 720, 761, 900, 1000, 1040, 1100, 1150, 1151, 1280, 1600]) {
    for (const folded of [true, false]) {
      const pane = modalPaneWidth(vw, folded);
      if (vw >= 761) t.ok(`${vw}px 一覧${folded ? '畳み' : '開き'}: 会話 360 以上（${conv(vw, folded)}）・欄は 0〜520`, conv(vw, folded) >= CONV_MIN && pane >= 0 && pane <= 520);
    }
  }
  t.ok('1000px で一覧を開き直すと、会話がちょうど 360 になるまで欄が縮む', conv(1000, false) === 360 && modalPaneWidth(1000, false) < modalPaneWidth(1000, true));
  t.ok('入りきらない幅では欄が 0 まで縮む（負にしない）', modalPaneWidth(400, false) === 0);
  t.ok('幅を決めた中身（目次など）は、その幅で、会話を割らない範囲まで', modalPaneWidth(1600, false, { fixed: 400 }) === 400 && conv(1000, false, { fixed: 400 }) >= CONV_MIN);

  // ---- 部品（偽のノードと時計）
  const make = ({ steps = false, ms = 240, saved = null } = {}) => {
    const dialog = new N('dialog'), open = new N('button'), close = new N('button');
    const focused = [];
    open.focus = () => focused.push('open'); close.focus = () => focused.push('close');
    const stored = { v: saved };
    const timers = [];
    const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, wait) => { const h = { fn, wait }; timers.push(h); return h; };
    globalThis.clearTimeout = h => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
    const relayouts = [], paints = [];
    let vw = 1100;
    const api = createWorkSide({ dialog, openButton: open, closeButton: close, width: () => vw, duration: () => ms, steps: () => steps,
      store: { get: () => stored.v, set: v => { stored.v = v; } }, relayout: () => relayouts.push(1), paint: w => paints.push(w) });
    const restore = () => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; };
    return { api, dialog, open, close, focused, stored, timers, relayouts, paints, setWidth: v => { vw = v; }, restore };
  };
  {
    const s = make();
    try {
      s.api.begin();
      t.ok('保存が無ければ開いて始まる', !s.dialog.classList.contains('list-folded') && s.api.folded() === false);
      t.ok('閉じるボタンを押すと畳み（list-folded・list-moving）、保存し、開くボタンへ焦点を移す',
        s.close.onclick() === true && s.dialog.classList.contains('list-folded') && s.dialog.classList.contains('list-moving') && s.stored.v === 'folded' && s.focused.at(-1) === 'open');
      t.ok('動きの印は --dur + 40ms で外れ、そのあと右の欄の幅を測り直す', s.timers.length === 1 && s.timers[0].wait === 280);
      const before = s.relayouts.length;
      s.timers[0].fn();
      t.ok('動きが終わると list-moving が外れ、relayout が走る', !s.dialog.classList.contains('list-moving') && s.relayouts.length === before + 1);
      t.ok('開くボタンを押すと開き、保存し、閉じるボタンへ焦点を移す', s.open.onclick() === true && !s.dialog.classList.contains('list-folded') && s.stored.v === 'open' && s.focused.at(-1) === 'close');
      s.api.end();
      t.ok('閉じたら印を外す', !s.dialog.classList.contains('list-folded') && !s.dialog.classList.contains('list-moving'));
      s.stored.v = 'folded';
      s.api.begin();
      t.ok('保存した畳みで開き直すと、動きなしで畳んで始まる', s.dialog.classList.contains('list-folded') && !s.dialog.classList.contains('list-moving') && s.api.state().auto === false);
      s.api.end();
    } finally { s.restore(); }
  }
  {
    const s = make();
    try {
      s.api.begin();
      s.api.layout(true);
      t.ok('欄が開くと（1100px）自動で畳む。保存はしない', s.api.folded() && s.api.state().auto && s.stored.v === null);
      s.open.onclick();
      t.ok('自動で畳んだ後に利用者が開くと、auto が外れ保存される', !s.api.folded() && !s.api.state().auto && s.stored.v === 'open');
      s.api.layout(true);
      t.ok('欄が開いたままの再測定では動かさない', !s.api.folded());
      s.api.layout(false);
      t.ok('欄が閉じても、利用者が開いた一覧はそのまま', !s.api.folded());
      s.close.onclick();
      s.api.layout(true); s.api.layout(false);
      t.ok('利用者が畳んだ一覧は、欄の開閉で開き直さない', s.api.folded() && s.stored.v === 'folded');
      s.api.end();
    } finally { s.restore(); }
  }
  {
    const s = make({ saved: null });
    try {
      s.api.begin(); s.setWidth(1100);
      s.api.layout(true);
      t.ok('自動で畳んだ後に欄が閉じると開き直す', s.api.folded());
      s.api.layout(false);
      t.ok('…欄が閉じた分だけ開き直す', !s.api.folded() && s.stored.v === null);
      s.setWidth(1280);
      s.api.layout(true);
      t.ok('1280px では欄が開いても畳まない（3 列）', !s.api.folded());
      s.api.layout(false);
      s.setWidth(1100); s.api.layout(true);
      s.setWidth(1300); s.api.layout(true);
      t.ok('自動で畳んだ後に窓が広がり、3 列が入る幅になったら開き直す', !s.api.folded() && !s.api.state().auto);
      s.api.end();
    } finally { s.restore(); }
  }
  {
    const s = make({ steps: true });
    try {
      s.api.begin();
      t.ok('700px 以下（3 段）では開け閉めの操作を受けない', s.close.onclick() === false && !s.dialog.classList.contains('list-folded') && s.stored.v === null && s.focused.length === 0);
      s.api.end();
    } finally { s.restore(); }
  }
  {
    const s = make({ ms: 0 });
    try {
      s.api.begin();
      s.close.onclick();
      t.ok('動きを減らす設定（長さ 0）では list-moving を付けず、タイマーも置かない', s.dialog.classList.contains('list-folded') && !s.dialog.classList.contains('list-moving') && s.timers.length === 0);
      s.api.end();
    } finally { s.restore(); }
  }
  {
    const s = make();
    try {
      s.api.begin(); s.paints.length = 0;
      s.api.setWaiting(true);
      t.ok('承認待ちの印は paint に渡る（畳む・開くたびにも）', s.paints.at(-1) === true);
      s.close.onclick();
      t.ok('畳んだ後も承認待ちを覚えている', s.paints.at(-1) === true);
      s.api.setWaiting(false);
      t.ok('消える', s.paints.at(-1) === false);
      s.api.end();
    } finally { s.restore(); }
  }

  // ---- 開くボタンの印と名前（◆ は 1 つ・数なし・名前は「承認待ちあり」）
  {
    const button = new N('button');
    const tr = k => k;
    paintOpenList(button, true, tr);
    paintOpenList(button, true, tr);
    const marks = button.querySelectorAll('.side-mark');
    t.ok('承認待ちがあれば ◆ の印を 1 つ（重ねて呼んでも 1 つ）。数は添えない', marks.length === 1 && marks[0].getAttribute('data-kind') === 'wait' && marks[0].textContent === '' && marks[0].getAttribute('aria-hidden') === 'true');
    t.ok('名前は「承認待ちあり」入り', button.getAttribute('aria-label') === 'dialog.work.openListWaiting');
    paintOpenList(button, false, tr);
    t.ok('無くなれば印を外し、名前を戻す', !button.querySelector('.side-mark') && button.getAttribute('aria-label') === 'dialog.work.openList');
  }

  // ---- 文言と配線（HTML・訳・CSS・Ctrl+B）
  {
    const html = await fs.readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
    const client = await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8');
    const css = await fs.readFile(new URL('../../web/style.css', import.meta.url), 'utf8');
    const openTag = /<button[^>]*id="workOpenList"[^>]*>/.exec(html)?.[0] ?? '';
    const closeTag = /<button[^>]*id="workCloseList"[^>]*>/.exec(html)?.[0] ?? '';
    t.ok('開くボタンは .side-pm（メインと同じ部品）で、名前は件数・印と一緒に書くので data-i18n-aria-label を置かない', /class="side-pm /.test(openTag) && !/data-i18n-aria-label/.test(openTag) && /data-shortcut="B"/.test(openTag));
    t.ok('閉じるボタンは #closeSidebar と同じ btn btn-icon side-toggle で、Ctrl+B の印', /class="btn btn-icon side-toggle /.test(closeTag) && /data-shortcut="B"/.test(closeTag));
    for (const lang of ['ja', 'en']) {
      const ui = JSON.parse(await fs.readFile(new URL(`../../web/locales/${lang}/ui.json`, import.meta.url), 'utf8'));
      const w = ui.dialog.work;
      t.ok(`${lang}: 一覧を開く・閉じるの文言が揃っている`, ['openList', 'openListWaiting', 'openListTitle', 'closeList', 'closeListTitle'].every(k => typeof w[k] === 'string' && w[k]) && /\{\{key\}\}/.test(w.openListTitle) && /\{\{key\}\}/.test(w.closeListTitle));
    }
    const ja = JSON.parse(await fs.readFile(new URL('../../web/locales/ja/ui.json', import.meta.url), 'utf8')).dialog.work;
    t.ok('日本語の名前は「一覧を開く」「一覧を閉じる」「一覧を開く（承認待ちあり）」', ja.openList === '一覧を開く' && ja.closeList === '一覧を閉じる' && ja.openListWaiting === '一覧を開く（承認待ちあり）');
    t.ok('CSS は --rail-w・--dur・--ease-out を使い、動きを減らす設定で動きを切る', /#workDialog\{--rail-w:52px\}/.test(css) && /list-folded \.work-side\{width:var\(--rail-w\)\}/.test(css) && /list-moving \.work-side\{transition:width var\(--dur\) var\(--ease-out\)\}/.test(css) && /prefers-reduced-motion:reduce\)\{\s*\.work-side[^}]*transition:none!important/.test(css));
    t.ok('Ctrl+B は、いちばん上が作業のダイアログのときはその一覧を動かし、メインの脇へ抜けない', /dialogs\.at\(-1\) === \$\("workDialog"\) && workSide\.set\(!workSide\.folded\(\)\)/.test(client));
  }
}
