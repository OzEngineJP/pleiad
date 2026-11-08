// 会話の頭の行の、右の欄を開け閉めするアイコンボタン（#browserEntry。docs/design-system.md「会話の頭の行のアイコン」）。
// 右の欄の入口はこの 1 つだけ（ADR 0294 の 5 の 5。目次の虫眼鏡は別の機能で、その左に並ぶ）。会話の右の欄（会話の Chrome のタブ）を開閉する。
// スマホ（600px 以下）は窓のアイコンでなく、タブの数の四角（.entry-tabn。アドレスバーの [N] と同じ形）を出す（承認済み 2026-11-08。
// temporary/mockups/phone-browser-header.html）。押すと人の操作中のタブ・最後に見ていたタブを全画面で開き、開いた中の [N] が一覧を開く。
// 近道は Ctrl+Shift+B（macOS は ⌘⇧B）
import { t } from './i18n.mjs';
// i18n-dynamic: tabs:address.openPanel
// i18n-dynamic: browser.entryState
// i18n-dynamic: tabs:strip.count
import { isComposingKey } from './keyboard.mjs';
import { browserIcon } from './tab-strip.mjs';
import { runMark } from './arc.mjs';

// エージェント任せの会話（と、Pleiad 担当を受け取れなかった antigravity の会話）
export const isManagedContext = (report) => Boolean(report) && report.status !== 'native';

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
  humanHeld = () => false, mac = isMac(), blocked = () => false, announce = () => {},
  mobile = () => false, tabs = () => [], openEntry = null }) {
  if (!button) return null;
  button.setAttribute('aria-keyshortcuts', mac ? 'Meta+Shift+B' : 'Control+Shift+B');
  const activeId = () => getSessionId() ?? null;
  const open = () => chrome()?.isOpen() === true;
  // スマホのタブの数の四角。中身は数・100 以上は ∞・0 は「0」（0 でも隠さない。ファイル・フォルダー・git の入口でもある）
  const tabn = document.createElement('span'); tabn.className = 'entry-tabn'; tabn.setAttribute('aria-hidden', 'true');
  button.append(tabn);

  /** いまの会話の角の印（requested / paused / working / ''）。Chrome のタブの印も同じものを読む */
  function currentMark() {
    const id = activeId();
    if (!id || !chromeAvailable()) return '';
    return browserEntryMark({ requested: Boolean(waiting(id)),
      // 人が触っているタブは一時停止と同じ印。会話に 1 枚でもあれば出す（どのタブを見ているかは聞かない。ADR 0296）
      paused: getChromeState(id) === 'paused' || Boolean(humanHeld(id)),
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
    button.hidden = !id;
    if (button.hidden) return;
    const state = currentMark();
    if (!button.dataset.unifiedIcon) {
      const icon = browserIcon('panel'); icon.classList.add('i'); button.querySelector('svg')?.replaceWith(icon); button.dataset.unifiedIcon = 'true';
    }
    announceChange(id, state);
    const onPhone = mobile();
    const count = onPhone ? tabs(id)?.length ?? 0 : 0;
    // 2 桁は字を詰める。100 以上は ∞（読み上げの名には実数を入れる。モック 02・04）
    tabn.textContent = count > 99 ? '∞' : String(count);
    tabn.classList.toggle('two', count >= 10 && count <= 99);
    tabn.classList.toggle('sym', count > 99);
    // Chrome が無い会話では Pleiad のページだけを出すので「ブラウザー」と呼ばない（ADR 0294 の 4 の 2）
    const label = onPhone ? t('tabs:strip.count', { count })
      : open() ? t('tabs:address.closePanel') : pagesOnly() ? t('tabs:address.openPagePanel') : t('tabs:address.openPanel');
    button.title = onPhone ? label : `${label}（${browserShortcutLabel(mac)}）`;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(open()));
    button.classList.toggle('on', open());
    button.querySelector('.entry-browser-mark')?.remove();
    // 開いている間はアドレスバーの札とタブの点が状態を見せるので、角の印は出さない。閉じている間の「動いている」も点にする
    // （右の欄の印の角に弧を重ねると「›」に見える）
    const shown = open() ? '' : state;
    if (shown) {
      // 「依頼待ち」も人に返す状態なので、人の操作と同じ II の丸に寄せる（色の点は使わない。承認済み 2026-11-08）
      const visual = shown === 'requested' ? 'paused' : shown;
      // 動いている印は弧（web/arc.mjs の runMark）。CSS は .entry-run.run に当たる
      const mark = visual === 'working' ? runMark() : document.createElement('span');
      mark.classList.add('entry-browser-mark', visual === 'working' ? 'entry-run' : `entry-${visual}`);
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark);
    }
  }

  function toggle(anchor = button) {
    if (open()) {
      chrome()?.close();
      anchor.focus({ preventScroll: true });
    } else if (mobile() && openEntry) {
      // スマホの [N]: 人の操作中のタブ・最後に見ていたタブを全画面で開く（タブが無ければ新しいタブ）
      const id = activeId(); if (id) openEntry(id);
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
