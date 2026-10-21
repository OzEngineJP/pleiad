// 設定 › Pleiad Plus › 同期の「届いた変更」（ADR 0246。docs/plus.md「同期で届いた skill と指示ファイル」）。
// ほかの PC から届いた skill・指示ファイル（消すものも）を 1 件ずつ開き、差分を見て「取り込む」か「捨てる」。
// 開くのは 1 件だけ。押したら、その行に「取り込みました」などを残して次の 1 件を開く。
// 「すべて取り込む」は置かない（中身を見ずに通す道を作らない）。
// 見ている間に新しい版が届いた（取り込む・捨てるが changed）: 「新しい版が届きました」を出して差分を読み直す。
// 文字として見せられないものは、大きさと sha256 と警告を出し、「取り込む」の後にもう一度確かめる。
// 見えない文字（向きを変える制御文字・幅の無い文字）は差分の中で ⟨U+XXXX⟩ と書き、改行コードだけの違いも一言出す。
// 状態から DOM を作る純粋な関数（tests/unit/plus-inbox-ui.mjs が tests/lib/dom-stub.mjs で動かす）。
import { el, svgEl, relTime } from './dom.mjs';
import { t } from './i18n.mjs';
import { button, rmIcon, waitLine } from './remote-parts.mjs';
import { lineDiff, diffView } from './line-diff.mjs';

/** 下向きの山（開閉の印。開くと CSS で上向きに回す） */
function downIcon() {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'm4 6.5 4 4 4-4' }));
  return svg;
}

/** 「同期」のまとまりの行「届いた変更 N 件」。押すと届いた変更の面を開く */
export function inboxRow(count, onOpen) {
  const row = button('', onOpen, 'rm-row');
  row.dataset.fk = 'syncInbox';
  const text = el('span', 'rm-rt');
  text.append(el('span', 'rm-nm', t('settings.plus.syncInbox', { count })));
  const end = el('span', 'rm-end');
  end.append(rmIcon('chevron'));
  row.append(el('span', 'card-kind', '◆'), text, end);
  return row;
}

/** 文字の行（終わりの改行 1 つが作る空の行は落とす） */
const linesOf = s => {
  const lines = String(s ?? '').split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** 向きを変える制御文字（Bidi）と、幅の無い文字 */
const BIDI_RX = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const INVISIBLE_RX = /[\u200B-\u200D\u2060-\u2064\uFEFF]/;
const HIDDEN_RX = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** 見えない文字を ⟨U+XXXX⟩ と書く */
const showHidden = s => s.replace(HIDDEN_RX, c => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);

/** 差分の行。新しいファイルは全部 +、消すものは全部 −、変更は手元（before）と届いたもの（after）の差。見えない文字は書き出す */
export function inboxDiffOps(item) {
  const ops = item.kind === 'new' ? linesOf(item.after).map(s => ({ t: '+', s }))
    : item.kind === 'delete' ? linesOf(item.before).map(s => ({ t: '-', s }))
      : lineDiff(item.before ?? '', item.after ?? '');
  return ops.map(o => ({ ...o, s: showHidden(o.s) }));
}

/**
 * 差分の上に出す印: bidi（届いた版に向きを変える制御文字）・invisible（幅の無い文字）・eol（改行コードだけが違う）。
 * 消すものは届いた版が無いので見ない
 */
export function inboxHiddenNotes(item) {
  if (item.kind === 'delete' || typeof item.after !== 'string') return [];
  const notes = [];
  if (BIDI_RX.test(item.after)) notes.push('bidi');
  if (INVISIBLE_RX.test(item.after.replace(/^﻿/, ''))) notes.push('invisible');   // 頭の BOM は数えない
  if (item.kind === 'change' && typeof item.before === 'string' && item.before !== item.after
    && item.before.replace(/\r\n/g, '\n') === item.after.replace(/\r\n/g, '\n')) notes.push('eol');
  return notes;
}

/** 大きさ（バイト）の見せ方 */
export function sizeText(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return t('settings.plus.inboxBytes', { count: n });
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 文字として見せられないもの: 警告と、届いた版（と手元）の大きさ・sha256 */
function binaryBox(detail) {
  const box = el('div', 'inx-bin');
  box.append(el('p', 'rm-warn', t('settings.plus.inboxBinary')));
  if (detail.kind !== 'delete') {
    box.append(el('p', 'rm-sub', t('settings.plus.inboxBinaryIncoming', { size: sizeText(detail.size) })));
    if (detail.sha256) box.append(el('p', 'rm-sub mono inx-sha', `sha256 ${detail.sha256}`));
  }
  if (Number.isFinite(detail.baseSize)) box.append(el('p', 'rm-sub', t('settings.plus.inboxBinaryLocal', { size: sizeText(detail.baseSize) })));
  return box;
}

// i18n-dynamic: settings.plus.inboxKind.
/** 行の 2 行目: 「変更 · LAPTOP-7 · 12分前」 */
export function inboxSub(item) {
  return [t(`settings.plus.inboxKind.${item.kind === 'new' || item.kind === 'delete' ? item.kind : 'change'}`),
    item.fromName || t('settings.plus.inboxFromUnknown'), item.at ? relTime(item.at) : ''].filter(Boolean).join(' · ');
}

/** 押した後に残す 1 行（done）か、取り込めなかったわけ（error） */
const DONE_TEXT = { taken: () => t('settings.plus.inboxTaken'), dropped: () => t('settings.plus.inboxDropped'), gone: () => t('settings.plus.inboxGone') };
const ERROR_TEXT = { local_changed: () => t('settings.plus.inboxLocalChanged'), not_applied: () => t('settings.plus.inboxNotApplied') };
// i18n-dynamic: settings.plus.inboxHidden.

/**
 * 届いた変更の面。
 * @param items    一覧（新しく届いた順）: [{ id, path, kind: change|new|delete, at, fromName }]
 * @param open     開いている 1 件の id（null は閉じている）
 * @param details  id → 中身（plus.syncInboxItem の item。読み込み中は無い）
 * @param results  id → { done: taken|dropped|gone } か { error: local_changed|not_applied|<文言> }
 * @param renewed  id → true: 見ている間に新しい版が届いた（「新しい版が届きました」を出す）
 * @param confirming  文字として見せられないものの「取り込む」を確かめている 1 件の id
 * @param busy     取り込む・捨てるを送っている最中
 * @param loading  一覧をまだ読めていない
 * @param onTake   (id) 取り込む。文字として見せられないものは先に onAskTake（確かめ）
 */
export function renderInbox({ items = [], open = null, details = {}, results = {}, renewed = {}, confirming = null, busy = false, loading = false, message = '',
  onBack = () => {}, onToggle = () => {}, onTake = () => {}, onDrop = () => {}, onAskTake = () => {}, onCancelTake = () => {} } = {}) {
  const back = button('', onBack, 'rm-back');
  back.dataset.fk = 'back';
  back.append(rmIcon('back'), t('settings.nav.plus'));
  const title = el('h3', 'rm-dt-name');
  title.append(el('span', null, t('settings.plus.inboxTitle')));
  const out = [back, title];
  if (message) out.push(el('p', 'rm-err', message));
  if (loading) { out.push(waitLine(t('settings.plus.inboxLoading'))); return out; }
  if (!items.length) { out.push(el('p', 'rm-weak', t('settings.plus.inboxEmpty'))); return out; }

  const list = el('div', 'inx-list');
  for (const item of items) {
    const result = results[item.id] ?? null;
    const done = Boolean(result?.done);
    const isOpen = !done && open === item.id;
    const box = el('div', `inx${isOpen ? ' open' : ''}${done ? ' done' : ''}`);
    box.dataset.id = item.id;

    const head = button('', () => onToggle(item.id), 'rm-row inx-h');
    head.dataset.fk = `inx:${item.id}`;
    head.setAttribute('aria-expanded', String(isOpen));
    head.disabled = done;
    const text = el('span', 'rm-rt');
    text.append(el('span', 'rm-nm mono', item.path), el('span', 'rm-sub', inboxSub(item)));
    const end = el('span', 'rm-end');
    end.append(downIcon());
    head.append(text, end);
    box.append(head);

    if (isOpen) {
      const body = el('div', 'inx-b');
      const detail = details[item.id];
      if (renewed[item.id]) body.append(el('p', 'rm-warn inx-renewed', t('settings.plus.inboxRenewed')));
      if (!detail) body.append(waitLine(t('settings.plus.inboxLoading')));
      else if (detail.binary) body.append(binaryBox(detail));
      else {
        for (const note of inboxHiddenNotes(detail)) body.append(el('p', 'rm-warn', t(`settings.plus.inboxHidden.${note}`)));
        body.append(diffView(inboxDiffOps(detail)));
      }
      if (result?.error) body.append(el('p', 'rm-err', ERROR_TEXT[result.error] ? ERROR_TEXT[result.error]() : result.error));
      if (detail?.binary && confirming === item.id) {
        // 中身を見ずに取り込む前に、もう一度確かめる
        const ask = el('div', 'rm-confirm');
        ask.append(el('p', null, t('settings.plus.inboxBinaryConfirm')));
        const cacts = el('div', 'rm-acts');
        const no = button(t('settings.plus.cancel'), onCancelTake, 'btn btn-quiet');
        no.dataset.fk = `takeNo:${item.id}`;
        const yes = button(t('settings.plus.inboxBinaryConfirmYes'), () => onTake(item.id), 'btn btn-primary');
        yes.dataset.act = 'takeYes'; yes.dataset.fk = `takeYes:${item.id}`;
        no.disabled = yes.disabled = busy;
        cacts.append(no, yes);
        ask.append(cacts);
        body.append(ask);
      } else {
        const acts = el('div', 'rm-acts');
        const drop = button(t('settings.plus.inboxDrop'), () => onDrop(item.id), 'btn btn-quiet');
        drop.dataset.act = 'drop'; drop.dataset.fk = `drop:${item.id}`;
        const take = button(t('settings.plus.inboxTake'), () => (detail?.binary ? onAskTake(item.id) : onTake(item.id)), 'btn btn-primary');
        take.dataset.act = 'take'; take.dataset.fk = `take:${item.id}`;
        // 取り込めなかった（手元が変わった）ものは「取り込む」を押せなくする。今のファイルを残すなら「捨てる」
        drop.disabled = busy || !detail;
        take.disabled = busy || !detail || result?.error === 'local_changed';
        acts.append(drop, take);
        body.append(acts);
      }
      box.append(body);
    }
    const note = el('p', 'inx-done rm-sub', done ? (DONE_TEXT[result.done] ?? DONE_TEXT.gone)() : '');
    note.hidden = !done;
    box.append(note);
    list.append(box);
  }
  out.push(list);
  return out;
}
