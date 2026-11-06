// タブのページの大きさの決め方（ADR 0293 の 3）。中継は Emulation.setDeviceMetricsOverride で、タブのページの大きさを次の順に決める。
//   1. 人がスマホで操作しているタブ: そのスマホの幅（モバイルの表示。mobile: true と端末の倍率）
//   2. それ以外で、PC の右の欄が開いているとき: パネルの幅と高さを等倍で
//   3. それ以外で、スマホが AI の操作を見ているとき: 既定の幅のまま、高さだけ映像の枠の比に伸ばす
//   4. どれでもないとき（AI だけが使っているとき）: 既定の窓（800×800 DIP。WINDOW_DIP と同じ。AI の snapshot が揺れないよう幅は変えない）
// 純粋な関数だけを置く（中継・映像のセッションへの適用は組 B の core/chrome/screencast.mjs）。
// 入力は「そのタブについて分かっている見ている側・操作している側」の箱。無い・数でないものは無いものとして次の順へ進む。
import { WINDOW_DIP } from './windows.mjs';

/** AI だけが使っているときの既定のページの大きさ（専用の窓と同じ 800×800 DIP） */
export const BASE_VIEWPORT = Object.freeze({ width: WINDOW_DIP.width, height: WINDOW_DIP.height });

const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const size = (box, { wMin, wMax, hMin, hMax, sMin = 1, sMax = 3, scale = 1 }) =>
  box && Number.isFinite(box.width) && Number.isFinite(box.height)
    ? { width: Math.round(clamp(box.width, wMin, wMax, wMin)), height: Math.round(clamp(box.height, hMin, hMax, hMin)), deviceScaleFactor: clamp(box.scale, sMin, sMax, scale) }
    : null;

/**
 * タブのページの大きさを決める（ADR 0293 の 3 の順）。
 * @param {object} input
 * @param [input.operating] 人がスマホで操作している映像の箱（{ width, height, scale }。tab-holder の viewport）。無ければ次の順へ
 * @param [input.panel]     PC の右の欄が開いているときの欄の大きさ（{ width, height }）
 * @param [input.watching]  スマホが AI の操作を見ているときの映像の枠（{ width, height, scale }）
 * @param [input.base]      AI だけのときの既定のページの大きさ（既定は 800×800 DIP）
 * @returns Emulation.setDeviceMetricsOverride の引数の形（{ width, height, deviceScaleFactor, mobile }）に、決めた順の印（source: 'device'|'panel'|'watch'|'default'）を添えたもの
 */
export function decideViewport({ operating = null, panel = null, watching = null, base = BASE_VIEWPORT } = {}) {
  const device = size(operating, { wMin: 240, wMax: 1600, hMin: 240, hMax: 2400 });
  if (device) return { ...device, mobile: true, source: 'device' };                 // 1. 人がスマホで操作中
  const pane = size(panel, { wMin: 200, wMax: 4000, hMin: 200, hMax: 2400 });
  if (pane) return { ...pane, mobile: false, source: 'panel' };                     // 2. PC の右の欄が開いている
  const watch = watching && Number.isFinite(watching.width) && watching.width > 0 && Number.isFinite(watching.height)
    ? { width: base.width, height: Math.round(clamp((base.width * watching.height) / watching.width, base.height, 4000, base.height)), deviceScaleFactor: clamp(watching.scale, 1, 3, 1) }
    : null;
  if (watch) return { ...watch, mobile: false, source: 'watch' };                   // 3. スマホが見ている（幅は既定のまま、高さを枠の比に伸ばす）
  return { width: base.width, height: base.height, deviceScaleFactor: 1, mobile: false, source: 'default' };   // 4. AI だけ
}
