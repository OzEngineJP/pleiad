// メインの面の切り替え（会話の面 / Channels の面 #channelsView）。
// 最後の面は覚える（再読み込みで同じ面に戻す。場所は web/view-address.mjs）。見ていない面の ◆・◌ とその読み上げ名も更新する。
import { t } from '../i18n.mjs';
import { reducedMotion } from '../motion.mjs';

const KEY = 'agent-host-side-tab';
const TABS = ['chats', 'channels'];
const LABEL_KEYS = { chats: 'channels:side.face.chats', channels: 'channels:side.face.channels' };

export function createSideTabs({ onChange = () => {} } = {}) {
  const root = document.documentElement;
  const side = document.getElementById('channelsSide');
  const view = document.getElementById('channelsView');
  const faceGroup = document.getElementById('sideFace');
  const faceButtons = [...(faceGroup?.querySelectorAll('[data-face]') ?? [])];
  const marks = { chats: document.getElementById('faceChatsMark'), channels: document.getElementById('faceChannelsMark') };
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
    for (const [name, mark] of Object.entries(marks)) {
      if (!mark) continue;
      const kind = name === tab ? null : dotState[name];
      mark.hidden = !kind;
      mark.className = `face-mark${kind ? ` ${kind}` : ''}`;
      mark.textContent = kind === 'mark' ? '◆' : kind === 'working' ? '◌' : '';
      mark.setAttribute('aria-hidden', 'true');
      const btn = faceButtons.find((b) => b.dataset.face === name);
      if (!btn) continue;
      if (kind === 'mark') {
        btn.setAttribute('aria-label', t('channels:side.face.waiting', { name: t(LABEL_KEYS[name]) }));
        btn.title = t('channels:side.face.waitingTip');
      } else if (kind === 'working') {
        btn.setAttribute('aria-label', t('channels:side.face.working', { name: t(LABEL_KEYS[name]) }));
        btn.title = t('channels:side.face.workingTip');
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
    /** 見ていない面の印（kind: 'mark' = あなた待ち、'working' = 作業中、'unread' は今は区別しない） */
    setDot(name, kind) { if (name in dotState) { dotState[name] = kind === 'mark' ? 'mark' : kind ? 'working' : null; paint(); } },
  };
}
