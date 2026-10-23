import { createDrawerGesture, outsideGestureEdges, excludedDrawerTarget } from '../../web/drawer-swipe.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const name = 'drawer-swipe';
export const title = '脇のスワイプ: 開始・縦の拒否・位置と速度・停止・端と中身の除外・キャンセル';

export default function (t) {
  const make = (open = false) => createDrawerGesture({ x: 100, y: 200, time: 0, width: 300, open });
  let g = make();
  t.ok('横12px未満では開始しない', g.move(111.9, 200, 20) === null && !g.active);
  t.ok('横12pxで開始し、引いた割合を返す', g.move(112, 200, 40) === .04 && g.active);
  g = make();
  t.ok('横が縦の1.5倍ちょうどでは開始しない', g.move(112, 208, 20) === null && !g.active);
  t.ok('縦10pxに達せず横の条件を後から満たしたら開始する', g.move(250, 208, 50) === .5);
  g = make();
  t.ok('横が縦の1.5倍を超えると開始する', g.move(112, 207.9, 20) === .04);
  for (const dy of [-10, 10]) {
    g = make(); g.move(102, 200 + dy, 20);
    t.ok(`先に縦${dy}px動いた操作は開かない`, g.move(280, 200, 60) === null && !g.finish(200));
  }
  for (const open of [false, true]) {
    g = make(open);
    t.ok(`開始時${open}: 逆方向からは始めない`, g.move(open ? 120 : 80, 200, 30) === null);
    g = make(open); g.move(open ? 20 : 240, 200, 70);
    t.ok(`開始時${open}: cancelは元の開閉へ戻す`, g.finish(80, true) === open);
    t.ok(`開始時${open}: 動かさず離すと元の開閉`, make(open).finish(1000) === open);
  }
  for (const [dx, expected] of [[134.9, false], [135, true], [136, true]]) {
    g = make(); g.move(100 + dx, 200, 300);
    t.ok(`位置${dx}/300: 45%を境に確定`, g.finish(450) === expected);
  }
  g = make(); g.move(120, 200, 40); g.move(145, 200, 90);
  t.ok('速度0.5px/msは45%未満でも開く', g.finish(90));
  g = make(); g.move(120, 200, 40); g.move(144, 200, 90);
  t.ok('速度0.5px/ms未満は位置で決める', !g.finish(90));
  g = make(true); g.move(80, 200, 40); g.move(55, 200, 90);
  t.ok('速度-0.5px/msは45%以上でも閉じる', !g.finish(90));
  g = make(); g.move(120, 200, 20); g.move(160, 200, 60);
  t.ok('離す時点の100ms窓に移動の比較点がなければ位置で決める', g.finish(159) === false);
  // 速度は離した時点から直近100ms。古い点は速さの計算に混ぜない。
  g = make(); g.move(200, 200, 20); g.move(180, 200, 190); g.move(200, 200, 230);
  t.ok('古い移動を捨て直近の右向き速度で開く', g.finish(240));
  g = make(); g.move(120, 200, 20); g.move(160, 200, 60);
  t.ok('100ms止めてから離すと速く引いた履歴を使わない', !g.finish(160));
  g = make(); g.move(260, 200, 60); g.move(260, 200, 160);
  t.ok('同じ座標のmoveは停止時間を更新しない', g.finish(200));
  g = make(); t.ok('追従は幅を超えない', g.move(900, 200, 30) === 1);
  t.ok('追従は0未満にならない', g.move(-100, 200, 40) === 0);

  for (const [x, y, expected] of [[23.9, 100, false], [24, 100, true], [336, 100, true], [336.1, 100, false], [100, 732, true], [100, 732.1, false]]) {
    t.ok(`端の除外 (${x},${y})`, outsideGestureEdges(x, y, 360, 760) === expected);
  }
  t.ok('殻が渡す左右と下の広い領域を除外', !outsideGestureEdges(39, 100, 360, 760, { left: 40 }) && !outsideGestureEdges(320, 100, 360, 760, { right: 41 }) && !outsideGestureEdges(100, 710, 360, 760, { bottom: 60 }));
  t.ok('殻の値が小さくても24pxと28pxを守る', !outsideGestureEdges(20, 100, 360, 760, { left: 1 }) && !outsideGestureEdges(100, 740, 360, 760, { bottom: 1 }));

  const node = (match = '', parentElement = null, css = {}) => ({ parentElement, scrollWidth: 100, clientWidth: 100, css,
    matches: selector => selector.split(',').some(s => s === match) });
  const options = { open: false, boundary: null, style: n => n.css };
  for (const tag of ['pre', 'table', 'iframe', 'input', 'textarea', 'select', 'a', 'button', 'summary', '[role="button"]', '[draggable="true"]', '[data-no-drawer-swipe]', '.tc-term', '[role="tablist"]']) {
    t.ok(`${tag}の子からは始めない`, excludedDrawerTarget(node('span', node(tag)), options));
  }
  const editable = node(); editable.isContentEditable = true;
  t.ok('編集可能な要素は除外', excludedDrawerTarget(editable, options));
  t.ok('本文は開始できる', !excludedDrawerTarget(node('p'), options));
  t.ok('開いた脇のボタンからは閉じられる', !excludedDrawerTarget(node('span', node('button')), { ...options, open: true }));
  t.ok('開いた脇の移動可能な会話の行からも閉じられる', !excludedDrawerTarget(node('span', node('[draggable="true"]')), { ...options, open: true }));
  for (const overflowX of ['auto', 'scroll']) {
    const scroller = node('', null, { overflowX }); scroller.scrollWidth = 500;
    for (const scrollLeft of [0, 400]) {
      scroller.scrollLeft = scrollLeft;
      t.ok(`横スクロール祖先 ${overflowX}・端${scrollLeft}は中身を優先`, excludedDrawerTarget(node('span', scroller), options));
    }
  }
  t.ok('先に独自の操作を持つ領域を除外', excludedDrawerTarget(node('', null, { touchAction: 'none' }), options));

  // 殻へ注入する実際のスクリプトを走らせ、ネイティブpx→CSS pxと再通知を確かめる。
  const host = readFileSync(new URL('../../mobile/android/app/src/main/kotlin/dev/pleiad/app/HostActivity.kt', import.meta.url), 'utf8');
  const remoteScript = host.slice(host.indexOf('private fun remoteScript'));
  const script = remoteScript.slice(remoteScript.indexOf('(() => {'), remoteScript.indexOf('})();') + 5)
    .replaceAll('$BRIDGE', 'testBridge').replace('const info = $info;', 'const info = {};');
  const bridge = { postMessage() {} }, window = { testBridge: bridge };
  window.top = window;
  const context = vm.createContext({ window, innerWidth: 360, setTimeout() {} });
  vm.runInContext(script, context);
  t.ok('殻の通知が届くまでは既定の端の幅を使う', Object.keys(window.plyRemote.gestureInsets()).length === 0);
  bridge.onmessage({ data: JSON.stringify({ type: 'gesture-insets', left: 120, right: 150, bottom: 180, viewportWidth: 1080 }) });
  let insets = window.plyRemote.gestureInsets();
  t.ok('殻の物理pxをCSS pxへ換算する', insets.left === 40 && insets.right === 50 && insets.bottom === 60);
  t.ok('殻から届いた幅を開始の除外に使える', !outsideGestureEdges(30, 200, 360, 760, insets));
  context.innerWidth = 720;
  t.ok('ページの倍率が変わっても現在のCSS pxで換算する', window.plyRemote.gestureInsets().left === 80);
  bridge.onmessage({ data: JSON.stringify({ type: 'gesture-insets', left: 90, right: 90, bottom: 0, viewportWidth: 720 }) });
  insets = window.plyRemote.gestureInsets();
  t.ok('回転などによる殻の領域の再通知を反映する', insets.left === 90 && insets.right === 90 && insets.bottom === 0);
}
