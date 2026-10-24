import { el, svgEl } from './dom.mjs';
import { fmt, t } from './i18n.mjs';

/** Unknown context values never become an empty (0%) bar. */
export function contextMetrics({ usage, auto, session, compact } = {}) {
  const known = Number.isFinite(usage?.usedTokens) && usage.usedTokens >= 0 && Number.isFinite(usage?.windowTokens) && usage.windowTokens > 0;
  const threshold = auto?.minTokens;
  const automatic = Boolean(compact && auto?.enabled && !session?.autoCompactionOff);
  return {
    used: known ? usage.usedTokens : null,
    window: known ? usage.windowTokens : null,
    percent: known ? 100 * usage.usedTokens / usage.windowTokens : null,
    automatic,
    threshold: automatic && Number.isFinite(threshold) && threshold > 0 ? threshold : null,
    remaining: known && automatic && Number.isFinite(threshold) && threshold > 0 ? Math.max(0, threshold - usage.usedTokens) : null,
  };
}

const paths = {
  plugins: ['M9 3v4m6-4v4M6 7h12v3.5a6 6 0 0 1-12 0zM12 16.5V21'],
  git: ['M7 7v10m10-6c0 4-10 2-10 6', 'M7 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4m0 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4m10-10a2 2 0 1 0 0 4 2 2 0 0 0 0-4'],
  browser: ['M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18'],
  usage: ['M4 19h16M6 15v-4m6 4V5m6 10V8'],
  compact: ['m7 4 5 5 5-5M7 20l5-5 5 5'],
  copy: ['M8 8h12v12H8zM16 8V4H4v12h4'],
};
export function conversationIcon(name) {
  const svg = svgEl('svg', { class: 'conversation-menu-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const d of paths[name] ?? []) svg.append(svgEl('path', { d }));
  return svg;
}
export function menuMeter(percent) {
  if (!Number.isFinite(percent)) return null;
  const hint = el('span', 'hint conversation-menu-meter');
  const bar = el('span', 'usage-mini'); bar.setAttribute('aria-hidden', 'true');
  const fill = el('i'); fill.style.width = `${Math.max(0, Math.min(100, percent))}%`; bar.append(fill);
  hint.append(bar, el('span', null, `${Math.min(Math.round(percent), percent < 100 ? 99 : 100)}%`));
  return hint;
}

/** The header menu is deliberately independent of the sidebar's full row menu. */
export function conversationMenuItems({ plugins, git, browser, usage, compact, copy }) {
  return [['plugins', plugins], ['git', git], ['browser', browser], ['usage', usage], ['compact', compact], ['copy', copy]]
    .filter(([, item]) => item).map(([name, item]) => ({ ...item, icon: conversationIcon(name) }));
}

export function createConversationSheet(title, opener) {
  const dialog = el('dialog', 'conversation-sheet');
  dialog.setAttribute('aria-label', title);
  const head = el('div', 'conversation-sheet-head');
  const close = el('button', 'conversation-sheet-close', '×'); close.type = 'button';
  close.setAttribute('aria-label', t('usage.header.close'));
  close.onclick = () => dialog.close();
  head.append(el('strong', null, title), close);
  const body = el('div', 'conversation-sheet-body');
  dialog.append(head, body);
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus({ preventScroll: true }); }, { once: true });
  document.body.append(dialog);
  return { dialog, body, open: () => dialog.showModal() };
}

export function renderContextUsage(info = {}) {
  const metrics = contextMetrics(info), section = el('section', 'conversation-context');
  const number = value => fmt.number(Math.round(value));
  function graph(label, value, maximum, note) {
    const row = el('div', 'conversation-graph');
    const rate = Math.min(100, Math.round(100 * value / maximum));
    row.append(el('span', null, label), el('span', 'value', `${rate}%`));
    const bar = el('div', 'usage-bar');
    bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', t('compaction.meterLabel', { rate, used: number(value), window: number(maximum) }));
    const fill = el('i'); fill.style.width = `${Math.min(100, 100 * value / maximum)}%`; bar.append(fill);
    row.append(bar);
    row.append(el('small', null, t('compaction.graphTokens', { used: fmt.number(value), window: fmt.number(maximum) })));
    if (note) row.append(el('small', null, note));
    section.append(row);
  }
  if (metrics.percent != null) graph(t('compaction.contextUsage'), metrics.used, metrics.window);
  else section.append(el('p', 'usage-note', t('usage.unknown')));
  if (metrics.remaining != null) graph(t('compaction.automatic'), metrics.used, metrics.threshold, metrics.remaining > 0 ? t('compaction.remaining', { tokens: number(metrics.remaining) }) : null);
  else section.append(el('p', 'usage-note', !info.compact ? t('compaction.agentManaged', { agent: info.agent }) : metrics.automatic ? t('usage.unknown') : t('compaction.autoOff')));
  if (info.scheduled) section.append(el('p', 'usage-note', t('compaction.scheduled', { time: info.scheduled })));
  return section;
}
