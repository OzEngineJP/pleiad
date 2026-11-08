// ヘッダーとアドレスバーで共用するタブ数の四角。
const SVG = 'http://www.w3.org/2000/svg';

export function tabCountBadge(className, tag = 'span') {
  const badge = document.createElement(tag);
  badge.className = `${className} tabn-badge`;
  if (tag === 'button') badge.type = 'button';
  const outline = document.createElementNS(SVG, 'svg');
  outline.setAttribute('viewBox', '0 0 20 20');
  outline.setAttribute('aria-hidden', 'true');
  const rect = document.createElementNS(SVG, 'rect');
  rect.setAttribute('x', '0.85'); rect.setAttribute('y', '0.85');
  rect.setAttribute('width', '18.3'); rect.setAttribute('height', '18.3');
  rect.setAttribute('rx', '4'); rect.setAttribute('fill', 'none');
  rect.setAttribute('stroke', 'currentColor'); rect.setAttribute('stroke-width', '1.7');
  outline.append(rect);
  const value = document.createElement('span'); value.className = 'tabn-value';
  badge.append(outline, value);
  return badge;
}
