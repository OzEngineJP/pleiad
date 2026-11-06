// 映像（JPEG のフレーム）の上の点・移動量を、ページの CSS px へ直す純粋な関数。
// Chrome の窓の映像（web/chrome-panel.mjs）と、そのページ側の入力（web/screencast-frame.mjs）が使う。

/** object-fit: contain で箱に収めた画像の、実際に描かれた範囲 */
export function containRect(box, natural) {
  if (!natural.width || !natural.height || !box.width || !box.height) return { left: box.left, top: box.top, width: 0, height: 0 };
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale, height = natural.height * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** 表示上の点（clientX/Y）をページの CSS px へ。画像の外なら null。metadata はフレームの deviceWidth / deviceHeight / offsetTop */
export function toPageCoords(point, rect, metadata) {
  if (!rect.width || !rect.height || !metadata?.deviceWidth || !metadata?.deviceHeight) return null;
  const rx = (point.x - rect.left) / rect.width, ry = (point.y - rect.top) / rect.height;
  if (rx < 0 || ry < 0 || rx > 1 || ry > 1) return null;
  const top = Number(metadata.offsetTop) || 0;
  return { x: Math.round(rx * metadata.deviceWidth), y: Math.round(ry * (metadata.deviceHeight + top) - top) };
}

/** 表示上の移動量（px）をページの CSS px へ */
export function toPageDelta(delta, rect, metadata) {
  if (!rect.width || !metadata?.deviceWidth) return 0;
  return delta * metadata.deviceWidth / rect.width;
}
