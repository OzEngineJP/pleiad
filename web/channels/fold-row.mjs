// bot のページの畳んだ 1 行（ADR 0358）。details の 1 行: 左に ›、題、右に今の値。開くと中身（body）が出る。
// 触る頻度の低い設定（他の会話に送る・ルーティン・活動メモ）を、説明文なしの 1 行ずつに畳む。
//   foldRow({ id, title }) → { el, body, setValue(text) }
import { el, svgEl } from '../dom.mjs';

export function foldRow({ id, title }) {
  const root = el('details', 'bp-frow');
  if (id) root.id = id;
  const head = el('summary');
  const cv = svgEl('svg', { class: 'i bp-frow-cv', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  cv.append(svgEl('path', { d: 'M9 6l6 6-6 6' }));
  const value = el('span', 'bp-frow-v');
  head.append(cv, el('span', 'bp-frow-t', title), value);
  const body = el('div', 'bp-frow-body');
  root.append(head, body);
  return { el: root, body, setValue: (text) => { value.textContent = text ?? ''; } };
}
