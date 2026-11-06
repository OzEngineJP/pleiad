// タブのページの大きさの決め方（core/chrome/viewport.mjs、ADR 0296 の 3）: 4 つの順・モバイルの表示・既定の窓
import { decideViewport, BASE_VIEWPORT } from '../../core/chrome/viewport.mjs';

export const name = 'chrome-viewport';
export const title = 'タブのページの大きさの決め方（ADR 0296 の 3）: スマホで操作中 > PC の右の欄 > スマホで見る > AI だけ';

const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);

export default async function (t) {
  t.ok('AI だけのときは既定の窓（800×800・等倍・モバイルでない）', same(decideViewport({}), { width: 800, height: 800, deviceScaleFactor: 1, mobile: false, source: 'default' }));
  t.ok('既定は専用の窓と同じ大きさ', BASE_VIEWPORT.width === 800 && BASE_VIEWPORT.height === 800);

  const device = decideViewport({ operating: { width: 390, height: 700, scale: 3 }, panel: { width: 600, height: 900 }, watching: { width: 390, height: 700 } });
  t.ok('人がスマホで操作中なら、そのスマホの幅・モバイルの表示・端末の倍率（ほかより優先）', same(device, { width: 390, height: 700, deviceScaleFactor: 3, mobile: true, source: 'device' }));

  const panel = decideViewport({ panel: { width: 612, height: 940 }, watching: { width: 390, height: 700 } });
  t.ok('PC の右の欄が開いていれば、欄の幅と高さを等倍で（見るだけのスマホより優先）', same(panel, { width: 612, height: 940, deviceScaleFactor: 1, mobile: false, source: 'panel' }));

  const watch = decideViewport({ watching: { width: 390, height: 700, scale: 2 } });
  t.ok('スマホが見ているときは、既定の幅のまま高さを枠の比に伸ばす', same(watch, { width: 800, height: Math.round(800 * 700 / 390), deviceScaleFactor: 2, mobile: false, source: 'watch' }));
  t.ok('横長の枠では既定の高さを下回らない（高さは伸ばすだけ）', decideViewport({ watching: { width: 1200, height: 300 } }).height === 800);

  t.ok('数でない入力は無いものとして次の順へ進む', decideViewport({ operating: { width: 'x' }, panel: null, watching: {} }).source === 'default');
  t.ok('端末の箱は使ってよい範囲に丸める', same(decideViewport({ operating: { width: 10, height: 99999, scale: 9 } }), { width: 240, height: 2400, deviceScaleFactor: 3, mobile: true, source: 'device' }));
}
