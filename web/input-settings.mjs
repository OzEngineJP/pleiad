// 設定 › 入力（docs/design-system.md「入力欄の呼び出しと候補」）。入力欄の ↑ の呼び出しと、次のメッセージの候補のオン・オフ。
// 値は prefs.json（composerHistoryRecall・composerSuggestions。既定はどちらもオン）。書くのは設定の一覧の setPref（core/ops/settings.mjs の composer.*）。
// 面と部品は設定 › 通知と同じ（web/notify-settings.css の .nf-* とスイッチ .cx-sw）
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

/** 入力欄の設定の今の値（prefs から。無ければ既定のオン） */
export function inputPrefs(prefs) {
  return { historyRecall: prefs?.composerHistoryRecall !== false, suggestions: prefs?.composerSuggestions !== false };
}

// i18n-dynamic: settings.input.
const ROWS = [
  ['historyRecall', 'composer.historyRecall', 'settings.input.historyRecall'],
  ['suggestions', 'composer.suggestions', 'settings.input.suggestions'],
];

/**
 * @param cmd       WS コマンド
 * @param getPrefs  () => prefs（client.mjs の state.prefs。prefs イベントで新しくなる）
 */
export function setupInputSettings({ cmd, getPrefs }) {
  const root = document.getElementById('inputPanel');
  const section = el('section', 'nf-section');
  const state = el('p', 'mp-state');
  state.setAttribute('role', 'status');
  root.append(section, state);
  let busy = null;

  async function set(key, value) {
    if (busy) return;
    busy = key;
    state.textContent = '';
    paint();
    try { await cmd('setPref', { key, value }); }
    catch (e) { state.textContent = t('settings.input.saveFailed', { error: e.message }); }
    busy = null;
    paint();
  }

  function paint() {
    const now = inputPrefs(getPrefs());
    const rows = ROWS.map(([name, key, base]) => {
      const label = t(`${base}.title`);
      const sw = el('button', 'cx-sw');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(now[name]));
      sw.setAttribute('aria-label', label);
      sw.disabled = Boolean(busy);
      sw.onclick = () => set(key, !now[name]);
      const r = el('div', 'nf-row');
      const info = el('div', 'nf-info');
      info.append(el('span', 'nf-label', label), el('small', null, t(`${base}.description`)));
      r.append(info, sw);
      r.onclick = (e) => { if (e.target !== sw && !sw.disabled) sw.click(); };
      return r;
    });
    const card = el('div', 'nf-card');
    card.append(...rows);
    section.replaceChildren(card);
  }

  paint();
  return { paint };
}
