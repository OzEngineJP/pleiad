// 行単位の差分と、その見せ方（会話の文脈・フックの写し・同期で届いた変更で使う）。色ではなく − / + の記号と面の階調で見せる（.scx-lines）
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

/** 行単位の差分。前後の一致を落とし、残りを最長共通部分列で並べる（大きいときは削除→追加の塊） */
export function lineDiff(before, after) {
  const a = String(before ?? '').split(/\r?\n/), b = String(after ?? '').split(/\r?\n/);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const x = a.slice(pre, a.length - post), y = b.slice(pre, b.length - post);
  let mid = [];
  if (x.length * y.length <= 1_000_000) {
    const w = y.length + 1, len = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
      len[i * w + j] = x[i] === y[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { mid.push({ t: ' ', s: x[i] }); i++; j++; }
      else if (j < y.length && (i >= x.length || len[i * w + j + 1] > len[(i + 1) * w + j])) { mid.push({ t: '+', s: y[j] }); j++; }
      else { mid.push({ t: '-', s: x[i] }); i++; }
    }
  } else mid = [...x.map(s => ({ t: '-', s })), ...y.map(s => ({ t: '+', s }))];
  return [...a.slice(0, pre).map(s => ({ t: ' ', s })), ...mid, ...a.slice(a.length - post).map(s => ({ t: ' ', s }))];
}

/** 差分の表示。変わった行の前後 2 行だけ残し、あとは「n 行同じ」に畳む */
export function diffView(ops) {
  const box = el('div', 'scx-lines');
  const keep = ops.map((o, i) => o.t !== ' ' || ops.slice(Math.max(0, i - 2), i + 3).some(n => n.t !== ' '));
  for (let i = 0; i < ops.length;) {
    if (!keep[i]) {
      let j = i;
      while (j < ops.length && !keep[j]) j++;
      box.append(el('div', 'skip', t('sessionContext.diff.same', { count: j - i })));
      i = j;
      continue;
    }
    const o = ops[i++];
    const row = el('div', o.t === '-' ? 'del' : o.t === '+' ? 'add' : '');
    row.append(el('span', 'g', o.t === '-' ? '−' : o.t === '+' ? '+' : ''), el('span', null, o.s || ' '));
    box.append(row);
  }
  return box;
}
