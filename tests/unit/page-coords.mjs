// 映像の座標の変換（web/page-coords.mjs）。前の内蔵ブラウザーの全面の表示から引っ越した前後で同じ値を返す（ADR 0291 の 5 の 2）。
// 下の期待値は、引っ越す前の関数で出したもの。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containRect, toPageCoords, toPageDelta } from '../../web/page-coords.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

export const name = 'page-coords';
export const title = '映像の座標の変換（web/page-coords.mjs）: 引っ越しの前後で同じ値・使う側の import';

const near = (a, b) => Math.abs(a - b) < 1e-9;
const sameRect = (a, b) => ['left', 'top', 'width', 'height'].every(k => near(a[k], b[k]));

// [箱, 画像の大きさ, フレームの metadata, 表示の点, 描かれた範囲, ページの点, 37 px の移動量]
const CASES = [
  [{ left: 0, top: 100, width: 400, height: 1000 }, { width: 780, height: 1400 }, { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 }, { x: 133.33333333333334, y: 420.51282051282055 },
    { left: 2.842170943040401e-14, top: 241.02564102564105, width: 399.99999999999994, height: 717.9487179487179 }, { x: 130, y: 175 }, 36.075],
  [{ left: 0, top: 100, width: 400, height: 1000 }, { width: 780, height: 1400 }, { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 }, { x: -0.9999999999999716, y: 241.02564102564105 },
    { left: 2.842170943040401e-14, top: 241.02564102564105, width: 399.99999999999994, height: 717.9487179487179 }, null, 36.075],
  [{ left: 0, top: 100, width: 400, height: 1000 }, { width: 780, height: 1400 }, { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 }, { x: 400, y: 958.9743589743589 },
    { left: 2.842170943040401e-14, top: 241.02564102564105, width: 399.99999999999994, height: 717.9487179487179 }, null, 36.075],
  [{ left: 0, top: 100, width: 400, height: 1000 }, { width: 780, height: 1400 }, { deviceWidth: 1280, deviceHeight: 720, offsetTop: 56 }, { x: 133.33333333333334, y: 420.51282051282055 },
    { left: 2.842170943040401e-14, top: 241.02564102564105, width: 399.99999999999994, height: 717.9487179487179 }, { x: 427, y: 138 }, 118.40000000000002],
  [{ left: 10, top: 20, width: 1200, height: 600 }, { width: 1600, height: 900 }, { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 }, { x: 432.22222222222223, y: 170 },
    { left: 76.66666666666674, top: 20, width: 1066.6666666666665, height: 600 }, { x: 130, y: 175 }, 13.528125000000001],
  [{ left: 10, top: 20, width: 1200, height: 600 }, { width: 1600, height: 900 }, { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 }, { x: 75.66666666666674, y: 20 },
    { left: 76.66666666666674, top: 20, width: 1066.6666666666665, height: 600 }, null, 13.528125000000001],
  [{ left: 10, top: 20, width: 1200, height: 600 }, { width: 1600, height: 900 }, { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 }, { x: 1143.3333333333333, y: 620 },
    { left: 76.66666666666674, top: 20, width: 1066.6666666666665, height: 600 }, { x: 390, y: 700 }, 13.528125000000001],
  [{ left: 0, top: 0, width: 0, height: 300 }, { width: 100, height: 100 }, { deviceWidth: 1280, deviceHeight: 720, offsetTop: 56 }, { x: 0, y: 0 },
    { left: 0, top: 0, width: 0, height: 0 }, null, 0],
  [{ left: 5, top: 5, width: 300, height: 300 }, { width: 0, height: 100 }, { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 }, { x: 5, y: 5 },
    { left: 5, top: 5, width: 0, height: 0 }, null, 0],
  [{ left: 5, top: 5, width: 300, height: 300 }, { width: 0, height: 100 }, null, { x: 5, y: 5 },
    { left: 5, top: 5, width: 0, height: 0 }, null, 0],
];

export default async function (t) {
  CASES.forEach(([box, natural, meta, point, rect, coords, delta], i) => {
    const got = containRect(box, natural);
    t.ok(`#${i} 描かれた範囲`, sameRect(got, rect), JSON.stringify(got));
    const page = toPageCoords(point, got, meta);
    t.ok(`#${i} ページの点`, coords === null ? page === null : page?.x === coords.x && page?.y === coords.y, JSON.stringify(page));
    t.ok(`#${i} 移動量`, near(toPageDelta(37, got, meta), delta));
  });

  // 使う側は page-coords.mjs から読む
  t.ok('chrome-panel.mjs は page-coords.mjs から読む', /from '\.\/page-coords\.mjs'/.test(read('web/chrome-panel.mjs')));
}
