// 操作のメニューを開く「…」の形（docs/design-system.md「「…」の形」・ADR 0313）。どこでも縦の 3 点（⋮）。
// 共通の絵（web/icons.mjs の moreIcon・web/dom.mjs の dotsIcon）が縦であることと、
// web/ のどこにも横の 3 点のメニュー（円を横に並べた絵・横の点の線・字の ⋯ のボタン）が残っていないことを見る。
// 差分の畳んだ行の印（gapIcon）はメニューではないので横のまま。
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../lib/dom-stub.mjs';
import { moreIcon, gapIcon, MORE_PATH } from '../../web/icons.mjs';
import { dotsIcon } from '../../web/dom.mjs';

export const name = 'more-icon';
export const title = '「…」のボタンはどこでも縦の 3 点';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** path の d の点（"M12 5v.01M12 12v.01…"）の座標 */
const points = (d) => [...d.matchAll(/M\s*([\d.]+)[ ,]([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const vertical = (pts) => pts.length === 3 && pts.every(([x]) => x === pts[0][0]) && new Set(pts.map(([, y]) => y)).size === 3;

function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'locales' && e.name !== 'vendor') sources(p, out); }
    else if (/\.(mjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

export default function (t) {
  const d = /d="([^"]+)"/.exec(moreIcon)?.[1] ?? '';
  t.ok('moreIcon は縦の 3 点', d === MORE_PATH && vertical(points(d)), d);
  t.ok('差分の畳んだ行の印は横のまま（メニューではない）', points(/d="([^"]+)"/.exec(gapIcon)[1]).every(([, y]) => y === 12));

  const svg = dotsIcon();
  const circles = svg.children.map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]);
  t.ok('dotsIcon（脇の行・見出し・器・送信予定の「…」）は縦の 3 点', vertical(circles), JSON.stringify(circles));

  // 横の 3 点の書き方が web/ に残っていない
  const bad = [];
  for (const f of sources(path.join(ROOT, 'web'))) {
    const rel = path.relative(ROOT, f).replaceAll('\\', '/');
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      // 円を横に並べる（for (const cx of [5, 12, 19]) … cy: 12）
      if (/for \(const cx of \[[^\]]*\]\)[^;]*cy: ?12\b/.test(line)) bad.push(`${at} 円を横に並べている`);
      // 円の属性で横に並べる（<circle cx="5" cy="12"/>…）
      if (/<circle cx="5(\.5)?" cy="12"/.test(line)) bad.push(`${at} 円を横に並べている`);
      // 点の線を横に並べる（M5 12h.01M12 12h.01…）。差分の畳んだ行の印だけは別
      if (/M5 12h\.01M12 12h\.01/.test(line) && !/export const gapIcon/.test(line)) bad.push(`${at} 点を横に並べている`);
      // 字の ⋯ をボタンに入れる
      if (/el\([^)]*['"]⋯['"]\)/.test(line)) bad.push(`${at} 字の ⋯ のボタン`);
    });
  }
  t.ok('横の 3 点のメニューが web/ に残っていない', bad.length === 0, bad.join(' / '));
}
