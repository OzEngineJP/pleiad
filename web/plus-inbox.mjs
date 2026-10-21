// 設定 › Pleiad Plus › 同期の「届いた変更」（ADR 0245。docs/plus.md「同期で届いた skill と指示ファイル」）。
// ほかの PC から届いた skill・指示ファイル（消すものも）を 1 件ずつ開き、差分を見て「取り込む」か「捨てる」。
// 開くのは 1 件だけ。押したら、その行に「取り込みました」などを残して次の 1 件を開く。
// 「すべて取り込む」は置かない（中身を見ずに通す道を作らない）。
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

/** 差分の行。新しいファイルは全部 +、消すものは全部 −、変更は手元（before）と届いたもの（after）の差 */
export function inboxDiffOps(item) {
  if (item.kind === 'new') return linesOf(item.after).map(s => ({ t: '+', s }));
  if (item.kind === 'delete') return linesOf(item.before).map(s => ({ t: '-', s }));
  return lineDiff(item.before ?? '', item.after ?? '');
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

/**
 * 届いた変更の面。
 * @param items    一覧（新しく届いた順）: [{ id, path, kind: change|new|delete, at, fromName }]
 * @param open     開いている 1 件の id（null は閉じている）
 * @param details  id → 中身（plus.syncInboxItem の item。読み込み中は無い）
 * @param results  id → { done: taken|dropped|gone } か { error: local_changed|not_applied|<文言> }
 * @param busy     取り込む・捨てるを送っている最中
 * @param loading  一覧をまだ読めていない
 */
export function renderInbox({ items = [], open = null, details = {}, results = {}, busy = false, loading = false, message = '',
  onBack = () => {}, onToggle = () => {}, onTake = () => {}, onDrop = () => {} } = {}) {
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
      if (!detail) body.append(waitLine(t('settings.plus.inboxLoading')));
      else if (detail.binary) body.append(el('p', 'rm-sub', t('settings.plus.inboxBinary')));
      else body.append(diffView(inboxDiffOps(detail)));
      if (result?.error) body.append(el('p', 'rm-err', ERROR_TEXT[result.error] ? ERROR_TEXT[result.error]() : result.error));
      const acts = el('div', 'rm-acts');
      const drop = button(t('settings.plus.inboxDrop'), () => onDrop(item.id), 'btn btn-quiet');
      drop.dataset.act = 'drop'; drop.dataset.fk = `drop:${item.id}`;
      const take = button(t('settings.plus.inboxTake'), () => onTake(item.id), 'btn btn-primary');
      take.dataset.act = 'take'; take.dataset.fk = `take:${item.id}`;
      // 取り込めなかった（手元が変わった）ものは「取り込む」を押せなくする。今のファイルを残すなら「捨てる」
      drop.disabled = busy || !detail;
      take.disabled = busy || !detail || result?.error === 'local_changed';
      acts.append(drop, take);
      body.append(acts);
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
