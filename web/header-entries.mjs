// 会話の頭の行の、右パネルを開くアイコンボタン（docs/design-system.md「会話の頭の行のアイコン」）。
//   - プラグイン（#contextEntry）: 件数は画面に出さず、title と読み上げの名前にだけ入れる。「変更あり」は右上の点
//   - ブラウザー（#browserEntry）: 会話の右の欄（会話の Chrome のタブ。ADR 0294）を開閉する。
//     近道は Ctrl+Shift+B（macOS は ⌘⇧B）
import { t } from './i18n.mjs';
// i18n-dynamic: tabs:address.openPanel
import { runMark } from './arc.mjs';
// i18n-dynamic: browser.entryState
import { isComposingKey } from './keyboard.mjs';
import { browserIcon } from './tab-strip.mjs';

const CTX_KINDS = ['instruction', 'skill', 'mcp'];
// 実際に渡ったものだけ数える。除外・重複・未対応・接続できなかった MCP は数に入れない
const CTX_LOADED = { instruction: ['supplied', 'loaded'], skill: ['available', 'manual-only', 'loaded'], mcp: ['pending', 'connected'] };
// Pleiad が担当する種類だけ数える（エージェント任せの種類は Pleiad が中身を把握していない）
export const contextTotal = (report) => CTX_KINDS.filter((kind) => report?.owners?.[kind] === 'ply')
  .reduce((sum, kind) => sum + (report.entries ?? []).filter((e) => e.kind === kind && CTX_LOADED[kind].includes(e.status)).length, 0);
// エージェント任せの会話（と、Pleiad 担当を受け取れなかった antigravity の会話）
export const isManagedContext = (report) => Boolean(report) && report.status !== 'native';

/**
 * プラグインの入口の名前。report は会話のコンテキストの報告、summary は札と同じ要約（指示 2 · Skills 9 · MCP 1）、
 * changed は次の送信で読み直す変更があるか。件数は Pleiad が管理している会話でだけ入れる
 */
export function contextEntryText({ report, summary = '', changed = false, status = '' }) {
  const managed = isManagedContext(report);
  let title = [report ? t('session.context.titleWith', { summary }) : t('session.context.title'), changed ? t('session.context.changed') : ''].filter(Boolean).join(' · ');
  let label = [t('session.context.label'), managed ? String(contextTotal(report)) : '', changed ? t('session.context.changed') : ''].filter(Boolean).join(' ');
  const state = contextStatusText(status);
  if (state) {
    const partial = status === 'nativeUnknown' || status === 'nativeError';
    title = [partial ? title : t('session.context.title'), state, !partial && changed ? t('session.context.changed') : ''].filter(Boolean).join(' · ');
    label = [t('session.context.label'), state, changed ? t('session.context.changed') : ''].filter(Boolean).join(' · ');
  }
  return { title, label, changed: !!changed };
}

const contextStatusText = status => ({
  loading: t('sessionContext.state.loading'), refreshing: t('sessionContext.state.refreshing'),
  error: t('sessionContext.state.error'), nativeError: t('sessionContext.state.nativeError'), nativeUnknown: t('sessionContext.state.nativeUnknown'),
})[status] ?? '';

/** プラグインの入口に名前と「変更あり」の点を当てる。点（.entry-dot）は変更がある間だけ DOM に置く */
export function paintContextEntry(button, { visible, report, summary, changed, status = '' }) {
  button.hidden = !visible;
  if (!visible) return;
  const text = contextEntryText({ report, summary, changed, status });
  button.title = text.title;
  button.setAttribute('aria-label', text.label);
  button.dataset.contextStatus = contextStatusText(status);
  button.querySelector('.entry-context-state')?.remove();
  if (status) {
    const mark = status === 'loading' || status === 'refreshing' ? runMark() : document.createElement('span');
    mark.classList.add('entry-context-state');
    if (status === 'error' || status === 'nativeError' || status === 'nativeUnknown') mark.textContent = '!';
    mark.setAttribute('aria-hidden', 'true');
    button.append(mark);
  }
  const dot = button.querySelector('.entry-dot');
  if (text.changed && !dot) {
    const mark = document.createElement('span');
    mark.className = 'entry-dot';
    mark.setAttribute('aria-hidden', 'true');
    button.append(mark);
  } else if (!text.changed && dot) dot.remove();
}

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
/** 右の欄の近道か（Ctrl+Shift+B、macOS は ⌘⇧B）。IME の変換中は奪わない */
export function isBrowserShortcut(event, mac = isMac()) {
  if (!event || event.defaultPrevented || isComposingKey(event) || event.altKey || !event.shiftKey) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  return String(event.key ?? '').toLowerCase() === 'b';
}
/** ツールチップに添える近道の書き方 */
export const browserShortcutLabel = (mac = isMac()) => (mac ? '⌘⇧B' : 'Ctrl+Shift+B');

/** 角の印は一つ。操作の依頼を最優先し、次に人の操作、最後にエージェントの操作 */
export const browserEntryMark = ({ requested = false, paused = false, working = false } = {}) =>
  requested ? 'requested' : paused ? 'paused' : working ? 'working' : '';

/**
 * 右の欄のボタン。chrome() は web/chrome-panel.mjs の返り値（open・close・isOpen）。
 * blocked() が true の間は近道を効かせない（設定・ダイアログ）。会話を開いていない間は隠す
 */
export function setupBrowserEntry({ button, chrome = () => null, windows = null, getSessionId = () => null,
  getAgentName = () => 'Claude', getChromeState = () => 'idle', waiting = () => false, chromeAvailable = () => false, pagesOnly = () => false,
  mac = isMac(), blocked = () => false, announce = () => {} }) {
  if (!button) return null;
  button.setAttribute('aria-keyshortcuts', mac ? 'Meta+Shift+B' : 'Control+Shift+B');
  const activeId = () => getSessionId() ?? null;
  const open = () => chrome()?.isOpen() === true;

  /** いまの会話の角の印（requested / paused / working / ''）。Chrome のタブの印も同じものを読む */
  function currentMark() {
    const id = activeId();
    if (!id || !chromeAvailable()) return '';
    return browserEntryMark({ requested: Boolean(waiting(id)), paused: getChromeState(id) === 'paused',
      working: Boolean(windows?.operating(id) || getChromeState(id) === 'running') });
  }

  // 会話ごとに最後に見た印。依頼待ち・人の操作中に「変わった」ときだけ一度読み上げる（開き直しや再描画では読まない）
  const seenMark = new Map();
  function announceChange(id, state) {
    const before = seenMark.get(id);
    seenMark.set(id, state);
    if (before === undefined || before === state) return;
    if (state === 'requested' || state === 'paused') announce(t(`browser.entryState.${state}`, { name: getAgentName() || 'Claude' }));
  }

  function paint() {
    const id = activeId();
    const hasWindow = Boolean(id && chromeAvailable() && windows?.has(id));
    button.hidden = !id;
    if (hasWindow) button.setAttribute('data-mobile-chrome', ''); else button.removeAttribute('data-mobile-chrome');
    if (button.hidden) return;
    const state = currentMark();
    if (!button.dataset.unifiedIcon) {
      const icon = browserIcon('panel'); icon.classList.add('i'); button.querySelector('svg')?.replaceWith(icon); button.dataset.unifiedIcon = 'true';
    }
    announceChange(id, state);
    // Chrome が無い会話では Pleiad のページだけを出すので「ブラウザー」と呼ばない（ADR 0294 の 4 の 2）
    const label = open() ? t('tabs:address.closePanel') : pagesOnly() ? t('tabs:address.openPagePanel') : t('tabs:address.openPanel');
    button.title = `${label}（${browserShortcutLabel(mac)}）`;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(open()));
    button.classList.toggle('on', open());
    button.querySelector('.entry-browser-mark')?.remove();
    // 開いている間はアドレスバーの札とタブの点が状態を見せるので、角の印は出さない。閉じている間の「動いている」も点にする
    // （右の欄の印の角に弧を重ねると「›」に見える）
    const shown = open() ? '' : state;
    if (shown) {
      const mark = document.createElement('span');
      mark.classList.add('entry-browser-mark', `entry-${shown}`);
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark);
    }
  }

  function toggle(anchor = button) {
    if (open()) {
      chrome()?.close();
      anchor.focus({ preventScroll: true });
    } else chrome()?.open(anchor);
    paint();
  }

  button.addEventListener('click', () => toggle());
  document.addEventListener('keydown', (event) => {
    if (!isBrowserShortcut(event, mac) || button.hidden || blocked()) return;
    event.preventDefault();
    toggle();
  });
  paint();
  return { paint, toggle, currentMark, available: () => !!activeId() };
}
