// スレッドの見出し（.th-top）。左に「# チャンネル名 › スレッドの題」、右に入口（ToDo・会話内の検索・右の欄）と閉じる ✕。
// 頭の行は Chats と同じ部品（.top。docs/design-system.md「会話の頭（狭い画面）」）で、≡・虫眼鏡・✦・⋮ の絵は web/icons.mjs から。
// 狭い画面の題は 2 行（1 行目がスレッドの題、2 行目が弱い字の「# チャンネル名」で押すと流れに戻る。並べ替えは CSS。承認済み（2026-11-26））。
// 狭い画面（700px 以下）の右は、検索の虫眼鏡と ⋮ と ✕ だけ。ToDo・通話・題の候補（✦）は ⋮ のメニューへ移る（ADR 0358。Chats の狭い画面の ⋮ と同じ並び）。
// 左にチャンネルの流れが見えている間（split）はチャンネル名を出さず「› スレッドの題」だけ（CSS が .deck[data-deck] で出し分ける）。
// 入口は ToDo（Chats と同じ部品。web/session-todo.mjs）・会話内の検索（虫眼鏡。開く面は目次と検索の面 web/conversation-toc.mjs で、検索欄に文字を打てる）・右の欄（Chats の頭と同じ開け閉め。ADR 0294）。
// どれも bot の会話（そのスレッドで最後に動いた bot）を基準にする。
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { shortcutLabel, shortcutAria } from '../keyboard.mjs';
import { closeIcon, moreIcon, menuIcon, searchIcon, wandIcon } from '../icons.mjs';
import { adoptOpenSidebar } from '../open-sidebar-mark.mjs';
import { browserIcon } from '../tab-strip.mjs';
import { TODO_ICON } from '../session-todo.mjs';

const GLOBE_PATHS = ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.6 2.5 3.9 5.5 3.9 9s-1.3 6.5-3.9 9c-2.6-2.5-3.9-5.5-3.9-9s1.3-6.5 3.9-9z'];

const svgButton = (cls, label, paths) => {
  const b = el('button', `btn btn-icon ${cls}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  if (typeof paths === 'string') { b.innerHTML = paths; return b; }   // web/icons.mjs の絵
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const d of paths) svg.append(svgEl('path', { d }));
  b.append(svg);
  return b;
};

/**
 * @param {object} o
 * @param {object} o.host  web/channels/index.mjs の host（openSidebar）
 * @param {() => void} o.onClose  ✕
 * @param {() => void} o.onBack  チャンネル名（流れに戻る）
 * @param {(button: HTMLElement) => void} o.onToc  目次
 * @param {(title: string) => void} [o.onRename]  題を変える（題を押すと欄になる。Enter で決め、Esc でやめる）
 * @param {() => Promise<string|null>} [o.suggestTitle]  ✦ 題の候補（スレッドの bot の会話から。欄に入れて選ばせる）
 */
export function createThreadHead({ host, onClose, onBack, onToc, onRename, suggestTitle = null }) {
  const head = el('header', 'top th-top');

  // 脇を閉じている間の入口（Chats の #openSidebar・流れの見出しの #chOpenSidebar と同じ部品。スレッドだけが見えているときだけ出す。CSS）。
  // 印（◆・未確認の点）・名前・aria-expanded は web/open-sidebar-mark.mjs が全部の ≡（.side-opener）に付ける
  const side = el('button', 'btn btn-icon side-toggle side-opener th-side');
  side.type = 'button';
  side.id = 'chThreadOpenSidebar';
  side.title = t('app.openSidebarTitle', { key: shortcutLabel('B') });
  side.setAttribute('aria-label', t('app.openSidebar'));
  side.setAttribute('aria-controls', 'sidebar');
  side.setAttribute('aria-keyshortcuts', shortcutAria('B'));
  side.innerHTML = menuIcon;
  adoptOpenSidebar(side);
  side.onclick = () => host.openSidebar?.();

  let suggest = null;   // ✦ を押したときと同じ働き（狭い画面は ⋮ のメニューから呼ぶ）
  const crumb = el('div', 'th-crumb');
  const chan = el('button', 'th-chan');
  chan.type = 'button';
  const sep = el('span', 'th-sep', '›');
  sep.setAttribute('aria-hidden', 'true');
  const title = el('h2', 'th-title');
  title.id = 'chThreadTitle';
  crumb.append(chan, sep, title);
  chan.onclick = onBack;
  // 題を押すと、その場で欄になる（Chats の頭の題と同じ働き）
  if (onRename) {
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    title.classList.add('th-title-edit');
    const edit = (value = null) => {
      if (head.querySelector('.th-title-input')) return;
      const input = el('input', 'th-title-input');
      input.value = value ?? (title.title || '');
      input.setAttribute('aria-label', t('channels:thread.rename'));
      input.maxLength = 120;
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        input.replaceWith(title);
        if (commit && next !== (title.title || '')) { title.textContent = next || title.textContent; onRename(next); }
        title.focus({ preventScroll: true });
      };
      input.onkeydown = (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      };
      input.onblur = () => finish(true);
      title.replaceWith(input);
      input.focus();
      input.select();
    };
    title.onclick = () => edit();
    title.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(); } };
    if (suggestTitle) {
      const wand = el('button', 'btn btn-icon th-wand');
      wand.type = 'button';
      wand.innerHTML = wandIcon;
      wand.title = t('session.titleWand');
      wand.setAttribute('aria-label', t('session.titleWand'));
      wand.onclick = suggest = async () => {
        if (wand.disabled) return;
        wand.disabled = true;
        wand.classList.add('busy');
        try { const next = await suggestTitle(); if (next) edit(next); }
        finally { wand.disabled = false; wand.classList.remove('busy'); }
      };
      crumb.append(wand);
    }
  }

  // ToDo の入口（Chats の #todoEntry と同じ形。開け閉め・点・件数の読み上げは createSessionTodo が持つ。会話が無い間は隠す）
  const todo = el('button', 'btn btn-icon th-todo');
  todo.type = 'button';
  todo.hidden = true;
  todo.setAttribute('aria-expanded', 'false');
  todo.innerHTML = TODO_ICON;
  todo.append(el('span', 'entry-dot'));
  todo.querySelector('.entry-dot').hidden = true;

  // 会話内の検索（Chats の #tocEntry と同じ名前・同じ近道の表記）。押すと目次と検索の面が開き、検索欄にカーソルが入る
  const toc = svgButton('th-toc', t('nav.toc.entry', { key: shortcutLabel('F') }), searchIcon);
  toc.setAttribute('aria-expanded', 'false');
  toc.setAttribute('aria-keyshortcuts', shortcutAria('F'));
  toc.onclick = () => onToc(toc);

  // 狭い画面だけの ⋮（広い画面は CSS が隠す）。メニューの中身は thread.mjs が組む
  const more = el('button', 'btn btn-icon th-more');
  more.type = 'button';
  more.title = t('session.more');
  more.setAttribute('aria-label', t('session.more'));
  more.setAttribute('aria-haspopup', 'menu');
  more.innerHTML = moreIcon;

  const browser = svgButton('th-browser', t('channels:thread.entry.browser'), GLOBE_PATHS);
  browser.setAttribute('aria-pressed', 'false');
  // ブラウザーの部品（web/browser-unify.mjs）がホストの caps を受けて使えるようになってから出す（ply-browser-availability で知らせる）
  const ready = () => document.body.classList.contains('browser-unify');
  const paintAvailability = () => {
    browser.hidden = !ready();
    if (ready() && !browser.dataset.unifiedIcon) { const icon = browserIcon('panel'); icon.classList.add('i'); browser.querySelector('svg')?.replaceWith(icon); browser.dataset.unifiedIcon = 'true'; }
  };
  paintAvailability();
  document.addEventListener('ply-browser-availability', paintAvailability);
  browser.onclick = () => browser.dispatchEvent(new CustomEvent('ply-browser-toggle', { bubbles:true, detail:{ sessionId } }));
  const paintBrowser = () => {
    const open = Boolean(document.querySelector('#filePreview[data-panel=chrome-window]:not([hidden])'));
    browser.setAttribute('aria-pressed', String(open));
    browser.title = t(open ? 'tabs:address.closePanel' : 'tabs:address.openPanel'); browser.setAttribute('aria-label', browser.title);
    browser.classList.toggle('on', open);
  };

  const close = el('button', 'btn btn-icon th-close');
  close.type = 'button';
  close.title = t('channels:thread.close');
  close.setAttribute('aria-label', t('channels:thread.close'));
  close.innerHTML = closeIcon;
  close.onclick = onClose;

  const entries = el('div', 'th-entries');
  entries.append(todo, toc, browser, more);
  head.append(side, crumb, entries, close);

  // 右パネルの開閉に合わせて、押されている印を合わせる
  new MutationObserver(paintBrowser).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  let sessionId = null;

  return {
    el: head,
    tocButton: toc,
    todoButton: todo,
    moreButton: more,
    /** ✦ と同じ（題の候補を欄に入れて選ばせる）。題を変えられない頭では null */
    suggest: () => suggest?.(),
    canSuggest: () => Boolean(suggest),
    setTitle({ channel, home = false, title: text }) {
      // 一時チャットの頭は # を付けない（チャンネルの名前ではなく置き場の名前）
      chan.replaceChildren(...(home ? [] : [el('span', 'th-hash', '#')]), document.createTextNode(channel ?? ''));
      chan.title = t('channels:thread.back', { name: channel ?? '' });
      chan.setAttribute('aria-label', t('channels:thread.back', { name: channel ?? '' }));
      title.textContent = text || t('channels:thread.untitled');
      title.title = text || '';
    },
    /** 右の欄の開け閉めが指す bot の会話 */
    setSession(id) { sessionId = id; },
    paintBrowser,
  };
}
