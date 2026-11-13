// 会話の Chrome のウィンドウで始まったダウンロードの画面（docs/inapp-browser.md「ダウンロード」、ADR 9187）:
// 会話ごとの一覧の置き場・アドレスバーのボタン（PC）・一覧（PC は吹き出し、スマホは欄いっぱい）・会話の 1 行。
// 見た目は docs/design-system.md「会話のブラウザー」。一覧の中身はサーバーの 'tab:downloads'（新しい順の全量）の写しで、ここでは足し引きしない。
import { t } from './i18n.mjs';
import { el, svgEl } from './dom.mjs';
import { formatBytes } from './folder-upload.mjs';
import { browserButton, browserIcon } from './tab-strip.mjs';

/** 輪（半径 15）の円周。進み具合は stroke-dashoffset で描く */
const RING = 2 * Math.PI * 15;
/** 訳文の中の名前の位置を探すための、見えない目印 */
const MARK = '⁣';

const running = records => records.filter(record => record.state === 'downloading');
const folderOf = path => { const s = String(path ?? ''), at = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return at < 0 ? '' : s.slice(0, at); };
const sizeOf = record => formatBytes(record.received || record.total);

/** 進行中のもの全体の割合（0〜1）。全体の大きさが分からないものしか無ければ null */
export function downloadProgress(records) {
  const known = running(records).filter(record => record.total > 0);
  const total = known.reduce((sum, record) => sum + record.total, 0);
  return total > 0 ? Math.min(1, known.reduce((sum, record) => sum + (Number(record.received) || 0), 0) / total) : null;
}

/** 一覧の行の 2 行目。進行中は「受け取った量 / 全体」、終わったものは「大きさ · 保存先のフォルダー」か結果 */
export function downloadSubText(record) {
  if (record.state === 'downloading') return record.total > 0 ? `${formatBytes(record.received)} / ${formatBytes(record.total)}` : formatBytes(record.received);
  if (record.state === 'completed') return [sizeOf(record), folderOf(record.path)].filter(Boolean).join(' · ');
  return record.state === 'failed' ? t('tabs:downloads.failed') : t('tabs:downloads.stopped');
}

/**
 * 会話ごとのダウンロードの一覧と、まだ見ていない終わったものの印。
 * 印が付くのは、この画面が見ている間に終わったもの（前の一覧で進行中だった・前の一覧に無かった）だけ。
 * 読み込み直後や見始めたときに届く一覧の、もう終わっているものには付けない
 */
export function createDownloadStore() {
  const lists = new Map(), marks = new Map();
  const list = sessionId => lists.get(sessionId) ?? [];
  return {
    list,
    unseen: sessionId => (marks.get(sessionId)?.size ?? 0) > 0,
    set(sessionId, downloads) {
      const known = lists.has(sessionId), before = new Map(list(sessionId).map(record => [record.id, record.state]));
      const next = Array.isArray(downloads) ? downloads : [];
      const keep = new Set([...(marks.get(sessionId) ?? [])].filter(id => next.some(record => record.id === id)));
      if (known) for (const record of next) if (record.state !== 'downloading' && (before.get(record.id) ?? 'downloading') === 'downloading') keep.add(record.id);
      lists.set(sessionId, next); marks.set(sessionId, keep);
    },
    seen(sessionId) { marks.delete(sessionId); },
    /** 見始めた・つなぎ直した（'tab:info' の reset）。次に届く一覧を最初のものとして受ける */
    forget(sessionId) { lists.delete(sessionId); marks.delete(sessionId); },
  };
}

/**
 * ダウンロードの入口と一覧。
 * @param deps.cmd        サーバーへの命令（止めるのは操作 browser.cancelDownload）
 * @param deps.session    () => 右の欄が映している会話
 * @param [deps.store]    一覧の置き場（createDownloadStore）
 * @param [deps.preview]  () => ファイルの入口（open・menu。web/file-preview.mjs）
 * @param [deps.phone]    () => スマホの幅か
 * @param [deps.notify]   止められなかったときの知らせ
 * @returns button（アドレスバーの ⋮ の左に置く）・pop と sheet（欄の枠に足す）・paint・set・forget・menuItem・close
 */
export function createDownloadsUi({ cmd, session, store = createDownloadStore(), preview = () => null, phone = () => false, notify = () => {} } = {}) {
  let open = null, openFor = null;   // open: 'pop'（PC の吹き出し）| 'sheet'（スマホの一覧）
  const records = new WeakMap();
  const button = browserButton('download', t('tabs:downloads.title'), () => (open ? close(true) : show()));
  button.classList.add('dl-btn'); button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false'); button.hidden = true;
  const ring = svgEl('svg', { class: 'dl-ring', viewBox: '0 0 34 34', 'aria-hidden': 'true' });
  const arc = svgEl('circle', { class: 'pg', cx: 17, cy: 17, r: 15, 'stroke-dasharray': RING.toFixed(2) });
  ring.append(svgEl('circle', { class: 'tr', cx: 17, cy: 17, r: 15 }), arc);
  const dot = el('span', 'dl-dot'), moreDot = el('span', 'dl-dot');
  ring.style.display = 'none'; dot.hidden = true; moreDot.hidden = true; button.append(ring, dot);
  const pop = el('div', 'dl-pop'); pop.setAttribute('role', 'list'); pop.setAttribute('aria-label', t('tabs:downloads.title')); pop.hidden = true;
  const sheet = el('div', 'dl-sheet'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', t('tabs:downloads.title')); sheet.hidden = true;
  const sheetClose = browserButton('close', t('tabs:downloads.close'), () => close(true));
  const sheetHead = el('div', 'dl-sheet-head'); sheetHead.append(el('span', '', t('tabs:downloads.title')), sheetClose);
  const sheetList = el('div', 'dl-sheet-list'); sheetList.setAttribute('role', 'list');
  sheet.append(sheetHead, sheetList);
  /** スマホの入口（アドレスバーの ⋮）。ボタンと同じ行に居る */
  const more = () => button.parentElement?.querySelector?.('.bu-more') ?? null;
  const inMenu = node => Boolean(node?.closest?.('.pop.menu'));

  function rowOf(record) {
    const row = el('div', 'dl-row'); row.setAttribute('role', 'listitem'); row.dataset.id = record.id; row.dataset.sig = sigOf(record);
    const main = el('button', 'dl-main'); main.type = 'button'; main.disabled = !(record.state === 'completed' && record.path);
    const text = el('span', 'dl-tx'); text.append(el('span', 'dl-name', record.name), el('span', 'dl-sub', downloadSubText(record)));
    main.append(browserIcon('file'), text); row.append(main);
    main.onclick = () => { const now = records.get(row); if (!now?.path) return; preview()?.open?.({ path: now.path, line: null }, main); close(false); };
    if (record.state === 'downloading') {
      row.classList.add('is-run');
      if (record.stoppable) row.append(browserButton('close', t('tabs:downloads.stop'), () => stop(records.get(row))));
      const bar = el('div', 'dl-bar'); bar.append(el('i')); row.append(bar);
    } else if (record.state === 'completed' && record.path) {
      const actions = browserButton('dots', t('tabs:downloads.actions', { name: record.name }), () => {
        const now = records.get(row), box = actions.getBoundingClientRect();
        // 会話は渡さない: 絶対パスなので場所は同じに解け、「会話で使う」が見ている会話の入力欄へ入る
        if (now?.path) preview()?.menu?.(box.left, box.bottom + 4, { path: now.path, kind: 'file', element: actions });
      });
      actions.setAttribute('aria-haspopup', 'menu'); row.append(actions);
    } else if (record.state === 'failed') row.classList.add('bad');
    tune(row, record);
    return row;
  }
  /** 行を作り直す境目（状態・止められるか・保存先・名前）。進み具合だけの変化は字と棒の幅だけ替える（フォーカスを保つ） */
  const sigOf = record => [record.state, record.stoppable ? 1 : 0, record.path ?? '', record.name].join('\n');
  function tune(row, record) {
    records.set(row, record);
    const sub = row.querySelector('.dl-sub'), text = downloadSubText(record);
    if (sub && sub.textContent !== text) sub.textContent = text;
    const fill = row.querySelector('.dl-bar>i');
    if (fill) fill.style.width = `${record.total > 0 ? Math.min(100, Math.round((Number(record.received) || 0) / record.total * 100)) : 0}%`;
  }
  function fill(box, list) {
    const focused = box.contains(document.activeElement);
    const old = new Map([...box.children].map(row => [row.dataset.id, row]));
    const rows = list.map(record => { const row = old.get(record.id); if (row?.dataset.sig !== sigOf(record)) return rowOf(record); tune(row, record); return row; });
    for (const row of old.values()) if (!rows.includes(row)) row.remove();
    let at = box.firstElementChild;
    for (const row of rows) { if (row === at) at = at.nextElementSibling; else box.insertBefore(row, at); }
    // フォーカスのあった行が作り直された（進行中 → 終わった など）ら、一覧の中へ戻す
    if (focused && !box.contains(document.activeElement)) (box.querySelector('button:not(:disabled)') ?? (open === 'sheet' ? sheetClose : button)).focus?.({ preventScroll: true });
  }
  function stop(record) {
    if (!record || !openFor) return;
    cmd('invoke', { op: 'browser.cancelDownload', args: { sessionId: openFor, id: record.id } })
      .then(result => { if (result?.stopped !== true) notify(t('files.actionFailed')); }, () => notify(t('files.actionFailed')));
  }
  function show() {
    const id = session();
    if (open || !id || !store.list(id).length) return;
    const host = pop.parentElement?.getBoundingClientRect?.(), bar = button.parentElement?.getBoundingClientRect?.();
    openFor = id; open = phone() ? 'sheet' : 'pop';
    if (open === 'pop') {
      const at = button.getBoundingClientRect();
      if (host && bar) { pop.style.top = `${bar.bottom - host.top + 4}px`; pop.style.right = `${Math.max(8, host.right - at.right)}px`; }
      pop.hidden = false; button.setAttribute('aria-expanded', 'true'); button.classList.add('on');
      document.addEventListener('pointerdown', onOutside, true);
    } else {
      // アドレスバーは残し、その下を覆う（スマホでは欄そのものが位置の基準。基準は出してからでないと測れない）
      sheet.hidden = false;
      const base = sheet.offsetParent?.getBoundingClientRect?.();
      sheet.style.top = `${base && bar ? Math.max(0, bar.bottom - base.top) : 0}px`;
    }
    paint();
    (open === 'sheet' ? sheetClose : pop.querySelector('button:not(:disabled)'))?.focus?.({ preventScroll: true });
  }
  function hide(focusBack) {
    if (!open) return;
    const was = open; open = null; openFor = null;
    pop.hidden = true; sheet.hidden = true; pop.replaceChildren(); sheetList.replaceChildren();
    button.setAttribute('aria-expanded', 'false'); button.classList.remove('on');
    document.removeEventListener('pointerdown', onOutside, true);
    if (focusBack) (was === 'pop' ? button : more())?.focus?.({ preventScroll: true });
  }
  function close(focusBack = false) { if (!open) return; hide(focusBack); paint(); }
  // 外を押したら閉じる。行の ⋯ のメニュー（body に出る）の中は外に数えない
  function onOutside(event) { if (open === 'pop' && !pop.contains(event.target) && !button.contains(event.target) && !inMenu(event.target)) close(false); }
  // フォーカスが一覧の外のものへ移ったら閉じる（行き先の無い blur ＝窓の切り替えなどでは閉じない）
  pop.addEventListener('focusout', event => { const next = event.relatedTarget; if (open === 'pop' && next && !pop.contains(next) && next !== button && !inMenu(next)) close(false); });
  for (const box of [pop, sheet]) box.addEventListener('keydown', event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); } });

  /** 映している会話の今の一覧で、ボタン・点・開いている一覧を描く。会話か幅が替わったら、開いていた一覧は閉じる */
  function paint() {
    const id = session(), list = id ? store.list(id) : [], active = running(list), small = phone();
    if (open && (openFor !== id || !list.length || (open === 'sheet') !== small)) hide(false);
    if (open) store.seen(id);
    const label = active.length ? t('tabs:downloads.running', { count: active.length }) : t('tabs:downloads.title');
    button.hidden = !list.length; button.title = label; button.setAttribute('aria-label', label);
    ring.style.display = active.length ? '' : 'none';
    if (active.length) arc.setAttribute('stroke-dashoffset', (RING * (1 - (downloadProgress(list) ?? 0))).toFixed(2));
    const unseen = Boolean(id) && store.unseen(id);
    dot.hidden = active.length > 0 || !unseen;
    const anchor = more();
    if (anchor && moreDot.parentElement !== anchor) anchor.append(moreDot);
    moreDot.hidden = !(small && !open && (active.length > 0 || unseen));
    if (open) fill(open === 'pop' ? pop : sheetList, list);
  }
  return {
    button, pop, sheet, store, paint, close,
    set(sessionId, downloads) { store.set(sessionId, downloads); },
    forget(sessionId) { store.forget(sessionId); },
    /** スマホの ⋮ のメニューの項目（ダウンロードのある会話でだけ）。右の値は進行中の全体の割合 */
    menuItem() {
      const id = session(), list = id ? store.list(id) : [];
      if (!list.length) return null;
      const progress = downloadProgress(list);
      return { label: t('tabs:downloads.title'), ...(progress == null ? {} : { hint: `${Math.round(progress * 100)}%` }), onClick: () => show() };
    },
  };
}

/** 会話の 1 行（present kind: chromeDownload）。終わったものだけが届く。完了の行のファイル名は押すと開ける（web/file-preview.mjs が受ける） */
export function renderChromeDownloadLine(ev) {
  const download = ev?.chromeDownload ?? {}, name = String(download.name ?? '');
  const row = el('div', 'cc-line');
  const mark = el('span', 'cc-line-ic'); mark.setAttribute('aria-hidden', 'true');
  const svg = browserIcon('download'); svg.classList.add('i'); mark.append(svg);
  const text = el('span', 'cc-line-t');
  if (download.state === 'completed') {
    const [head, tail = ''] = t('tabs:downloads.line.completed', { name: MARK, size: formatBytes(download.size) }).split(MARK);
    let file = name;
    if (download.path) { file = el('button', 'cc-file', name); file.type = 'button'; file.dataset.filePath = download.path; }
    text.append(...[head, file, tail].filter(piece => piece !== ''));
  } else text.textContent = download.state === 'canceled' ? t('tabs:downloads.line.canceled', { name }) : t('tabs:downloads.line.failed', { name });
  row.append(mark, text);
  return row;
}
