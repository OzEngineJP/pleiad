import { createSuggestion } from '../composer/suggestion.mjs';
import { el, icon } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { inputPrefs } from '../input-settings.mjs';
import { announce } from '../message-actions.mjs';
import { botIcon } from './bot-icon.mjs';

const ARROW = 'M5 12h14m-6-6 6 6-6 6';
const CHEVRON = 'm6 9 6 6 6-6';
const keyOf = (where) => where ? JSON.stringify([where.channelId, where.threadId ?? null]) : null;

export function createNextActions({ host, input, box, scope, botOf, blocked }) {
  const strip = el('div', 'ch-next-actions');
  const line = el('div', 'ch-next-line');
  const primary = el('button', 'ch-next-primary');
  const more = el('button', 'ch-next-more');
  const choices = el('div', 'ch-next-choices');
  choices.id = `${input.id}-next-actions`;
  primary.type = more.type = 'button';
  more.setAttribute('aria-controls', choices.id);
  line.append(primary, more);
  strip.append(line, choices);
  strip.hidden = true;
  box.before(strip);

  let items = [], selectedId = null, current = null, key = null, revision = 0;
  let expanded = false, composing = false, taking = false, rendered = '';
  const enabled = () => inputPrefs(host.state?.prefs).suggestions;
  const focused = (node) => node === input || strip.contains(node) || node?.closest('.cg-take')?.parentNode === box;
  const unavailable = () => !key || blocked() || composing || taking || input.disabled || input.readOnly || Boolean(input.closest('[inert]'));
  const suggestion = createSuggestion({
    prompt: input, box, t, enabled, blocked: unavailable, announce,
    touch: () => matchMedia('(pointer:coarse)').matches,
    describe: (text) => t('channels:nextActions.described', { name: current?.bot.name, text }),
    accept: () => void consume(true),
    dismiss: () => void consume(false),
  });

  function fill(button, { bot, action }, arrow = false) {
    const text = t('channels:nextActions.action', { name: bot.name, action });
    button.replaceChildren();
    button.append(botIcon(bot, 'ch-next-bot'), el('span', 'ch-next-text', text));
    if (arrow) button.append(icon(ARROW));
    button.title = text;
  }

  function refresh({ preserveFade = false } = {}) {
    if (!focused(document.activeElement) || selectedId === null) selectedId = items[0]?.id ?? null;
    current = items.find((item) => item.id === selectedId) ?? null;
    const alternatives = items.filter((item) => item !== current);
    if (!alternatives.length) expanded = false;
    strip.hidden = !enabled() || unavailable() || Boolean(input.value) || (!current && !alternatives.length);
    primary.hidden = !current;
    more.hidden = !alternatives.length;
    more.setAttribute('aria-expanded', String(expanded));
    choices.hidden = !expanded;
    const rowKey = (item) => item && [item.id, item.bot.name, item.bot.color, item.action];
    const signature = JSON.stringify([rowKey(current), alternatives.map(rowKey)]);
    if (signature !== rendered) {
      rendered = signature;
      if (current) fill(primary, current, true);
      more.replaceChildren(t('channels:nextActions.more', { count: alternatives.length }), icon(CHEVRON));
      choices.replaceChildren(...alternatives.map((item) => {
        const button = el('button', 'ch-next-choice');
        button.type = 'button';
        fill(button, item);
        button.onclick = () => {
          input.focus();
          selectedId = item.id;
          expanded = false;
          refresh();
        };
        return button;
      }));
    }
    if (preserveFade) return;
    if (suggestion.text !== (current?.text ?? null)) suggestion.set(current?.text ?? null);
    else if (current) suggestion.refresh();
  }

  function syncScope() {
    const where = scope();
    const nextKey = keyOf(where);
    if (nextKey !== key) {
      key = nextKey;
      revision++;
      items = [];
      selectedId = null;
      expanded = taking = false;
      refresh();
    }
    return where;
  }

  function put(result) {
    items = (result?.suggestions ?? []).flatMap((item) => {
      const bot = botOf(item.botId);
      return bot && item.expiresAt > Date.now() ? [{ ...item, bot }] : [];
    });
    refresh();
  }

  async function load(event) {
    const where = syncScope();
    if (!where || (event && keyOf(event) !== key) || taking) return;
    if (!enabled()) { put(null); return; }
    const version = ++revision;
    const { channelId, threadId } = where;
    try {
      const result = await host.invoke('channels.nextActions', { channelId, threadId });
      if (version === revision && keyOf(scope()) === key) put(result);
    } catch { /* The last valid view is refreshed on reconnect. */ }
  }

  async function consume(adopt) {
    const item = current;
    const where = scope();
    if (!item || !where || keyOf(where) !== key || unavailable() || input.value) return;
    input.focus();
    taking = true;
    const version = ++revision;
    items = items.filter((candidate) => candidate !== item);
    expanded = false;
    refresh({ preserveFade: !adopt });
    const { channelId, threadId } = where;
    try {
      const result = await host.invoke('channels.nextActions', { channelId, threadId, consumeId: item.id });
      if (version !== revision || keyOf(scope()) !== key) return;
      taking = false;
      if (adopt && result.consumed && enabled() && !unavailable() && !input.value) {
        const bot = botOf(item.botId);
        if (bot) {
          input.setRangeText(`${where.threadId && !where.dm ? `@${bot.name} ` : ''}${item.text}`, 0, 0, 'end');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } catch { /* A failed request leaves the candidate available to reload. */ }
    finally {
      if (version === revision) { taking = false; void load(); }
    }
  }

  primary.onmousedown = (event) => event.preventDefault();
  primary.onclick = () => suggestion.take();
  more.onclick = () => { expanded = !expanded; refresh(); };
  input.addEventListener('compositionstart', () => { composing = true; refresh(); });
  input.addEventListener('compositionend', () => { composing = false; refresh(); });
  for (const node of [input, strip, box]) node.addEventListener('focusout', (event) => {
    if (focused(event.relatedTarget)) return;
    queueMicrotask(() => {
      if (!focused(document.activeElement)) { expanded = false; refresh(); }
    });
  });
  return { load, refresh() { syncScope(); refresh(); }, keydown: suggestion.keydown };
}
