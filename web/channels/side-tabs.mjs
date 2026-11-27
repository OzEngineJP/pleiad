// メインの面の切り替え（会話の面 / Channels の面 #channelsView）。
// 最後の面は覚える（再読み込みで同じ面に戻す。場所は web/view-address.mjs）。あなた待ちが残っている間は、今いる側でもアイコン右上の点と読み上げ名を保つ。
import { t } from '../i18n.mjs';
import { reducedMotion } from '../motion.mjs';
import { unreadMark } from '../side.mjs';

const KEY = 'agent-host-side-tab';
const TABS = ['chats', 'channels'];
// 読み上げの名前（キーは直書きで持つ。i18n-lint が使われているかを見るため）
const waitingLabel = (name) => (name === 'chats' ? t('channels:side.face.waitingChats') : t('channels:side.face.waitingChannels'));

export function createSideTabs({ onChange = () => {} } = {}) {
  const root = document.documentElement;
  const side = document.getElementById('channelsSide');
  const view = document.getElementById('channelsView');
  const faceGroup = document.getElementById('sideFace');
  const faceButtons = [...(faceGroup?.querySelectorAll('[data-face]') ?? [])];
  const wraps = {
    chats: document.getElementById('faceChatsWrap') ?? faceButtons.find((b) => b.dataset.face === 'chats')?.querySelector('.side-face-ico-wrap') ?? null,
    channels: document.getElementById('faceChannelsWrap') ?? faceButtons.find((b) => b.dataset.face === 'channels')?.querySelector('.side-face-ico-wrap') ?? null,
  };
  const dotState = { chats: null, channels: null };
  // 会話の頭・筋・入力欄。Channels を見ている間はキーボードと読み上げを届かせない（設定の画面と同じ手。web/onboarding.mjs）
  const covered = () => [...(document.querySelector('body > main')?.children ?? [])].filter((n) => n.matches('.top, #logFrame, .composer'));
  let tab = 'chats';
  try { if (localStorage.getItem(KEY) === 'channels') tab = 'channels'; } catch { /* 覚えていなければ会話の面 */ }

  function paint() {
    const on = tab === 'channels';
    root.classList.remove('side-channels');
    document.body.classList.toggle('channels', on);
    if (side) side.hidden = true;
    for (const node of covered()) node.inert = on;
    if (view) view.inert = !on;
    if (faceGroup) faceGroup.dataset.on = tab;
    for (const b of faceButtons) b.setAttribute('aria-pressed', String(b.dataset.face === tab));
    for (const name of TABS) {
      const wait = dotState[name] === 'mark';
      const unread = dotState[name] === 'unread';
      wraps[name]?.classList.toggle('has-wait', wait);
      const wrap = wraps[name];
      const mark = wrap?.querySelector('.unread-mark');
      if (unread && wrap && !mark) {
        const dot = unreadMark();
        dot.setAttribute('aria-hidden', 'true');
        wrap.append(dot);
      } else if (!unread) mark?.remove();
      const btn = faceButtons.find((b) => b.dataset.face === name);
      if (!btn) continue;
      if (wait) {
        btn.setAttribute('aria-label', waitingLabel(name));
        btn.title = t('channels:side.face.waitingTip');
      } else if (unread) {
        const label = name === 'chats' ? t('channels:side.face.chats') : t('channels:side.face.channels');
        btn.setAttribute('aria-label', `${label} · ${t('sidebar.unread')}`);
        btn.title = t('sidebar.unread');
      } else {
        btn.removeAttribute('aria-label');
        btn.removeAttribute('title');
      }
    }
  }

  function playSwitchIcon() {
    const reduce = reducedMotion();
    for (const b of faceButtons) {
      const ico = b.querySelector('.side-face-ico');
      if (!ico) continue;
      ico.classList.remove('play');
      if (!reduce && b.dataset.face === tab) {
        void ico.getBoundingClientRect?.();
        ico.classList.add('play');
      }
    }
  }

  function set(next) {
    if (!TABS.includes(next)) return;
    const changed = next !== tab;
    tab = next;
    paint();
    if (changed) {
      playSwitchIcon();
      try { localStorage.setItem(KEY, tab); } catch { /* 覚えられなくても切り替わる */ }
      onChange(tab);
    }
  }

  for (const b of faceButtons) b.addEventListener('click', () => set(b.dataset.face));
  // 新しい会話（web/client.mjs の onNew）・会話を開く・設定は Chats の側の操作で、それぞれが set('chats') で戻す
  paint();

  return {
    get tab() { return tab; },
    set,
    /** あなた待ち・未読の印 */
    setDot(name, kind) { if (name in dotState && dotState[name] !== kind) { dotState[name] = kind; paint(); } },
  };
}
