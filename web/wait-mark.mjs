// 共通の待ちの印（docs/design-system.md §6）。状態の説明は呼び出し元の文言が持つ。
export function waitMark(title, { paused = false } = {}) {
  const mark = document.createElement('span');
  mark.className = `run wait-mark${paused ? ' paused' : ''}`;
  if (title) mark.title = title;
  const dot = document.createElement('span');
  dot.className = 'wait-dot';
  dot.setAttribute('aria-hidden', 'true');
  mark.append(dot);
  return mark;
}
