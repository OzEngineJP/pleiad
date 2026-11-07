import { t } from './i18n.mjs';
import { createTabStrip, browserButton, browserIcon, tabIcon } from './tab-strip.mjs';
import { createAddressBar, hasFileViews } from './address-bar.mjs';
import { createControlBadge, createTabActivityDot, createPhoneBrowserStrip } from './chrome-control.mjs';
import { pageRequestOf, framePoint } from './page-frame.mjs';
import { openExternalLink } from './link-open.mjs';

/** メニューの行のアイコン（タブの列・アドレスバーと同じ線の絵） */
const menuIcon = kind => { const svg = browserIcon(kind); svg.classList.add('i'); return svg; };

// Right-pane browser styles; injected once when the host reports browserUnify (always, since ADR 0294 stage C1).
const css = `
.bu-chrome{--bu-frame:var(--surface-3);--bu-bar:var(--surface-1);--bu-omni:var(--surface-2);color:var(--ink);flex:none;min-width:0}
[data-theme=dark] .bu-chrome{--bu-frame:var(--surface-0);--bu-bar:var(--surface-3);--bu-omni:var(--surface-paper)}
.bu-chrome button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
.bu-chrome [hidden]{display:none!important}
.bu-chrome button:focus-visible,.bu-crumbs:focus-visible{outline:2px solid var(--line-blue);outline-offset:-2px}
.bu-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:34px;height:34px;border-radius:50%;padding:0}
.bu-icon:hover:not(:disabled),.bu-crumb:hover,.bu-count:hover{background:var(--surface-3)}
.bu-icon svg{width:18px;height:18px;flex:none}.bu-icon:disabled{opacity:.35;cursor:default}
.bu-tabs{display:flex;align-items:end;height:40px;padding:0 6px 0 8px;background:var(--bu-frame);min-width:0}
.bu-tab{height:34px;display:flex;align-items:center;flex:1 1 240px;max-width:240px;min-width:0;border-radius:10px 10px 0 0;position:relative;padding:0 8px 0 12px;color:var(--ink-weak)}
.bu-tab+.bu-tab:before{content:'';position:absolute;left:0;top:7px;height:20px;width:1px;background:var(--line)}
.bu-tab.on{background:var(--bu-bar);color:var(--ink)}.bu-tab.on:before,.bu-tab.on+.bu-tab:before{display:none}
.bu-tab-pick{display:flex;align-items:center;gap:8px;min-width:0;flex:1;height:100%;padding:0;text-align:left}
.bu-tab-title{overflow:hidden;white-space:nowrap;flex:1;font-size:12px;mask-image:linear-gradient(to right,#000 calc(100% - 18px),transparent)}
.bu-favicon{width:16px;height:16px;flex:none}.bu-loading{animation:bu-pulse 1s ease-in-out infinite alternate}@keyframes bu-pulse{to{opacity:.3}}
@media(prefers-reduced-motion:reduce){.bu-loading{animation:none}}
.bu-tab-close{width:18px;height:18px;margin-left:4px}.bu-tab-close svg{width:12px;height:12px}.bu-new{width:32px;height:32px;margin:0 0 1px 2px}
.bu-favicons .bu-tab-title,.bu-favicons .bu-tab:not(.on) .bu-tab-close{display:none}.bu-favicons .bu-tab{padding:0 5px;justify-content:center}.bu-favicons .bu-tab-pick{justify-content:center;flex:0}
.bu-toolbar{position:relative;display:flex;align-items:center;gap:2px;height:46px;padding:0 6px;background:var(--bu-bar);min-width:0}
.bu-omni{display:flex;align-items:center;flex:1;min-width:0;gap:8px;height:34px;border-radius:17px;margin:0 4px;padding:0 4px 0 12px;background:var(--bu-omni);cursor:text}
.bu-omni.bu-file{padding-left:4px;gap:4px}.bu-tree{width:28px;height:26px;border-radius:13px}.bu-tree svg{width:17px;height:17px}
.bu-crumbs{flex:1;min-width:0;height:100%;display:flex;align-items:center;overflow:hidden;white-space:nowrap;font-size:13.5px;cursor:text}
.bu-crumb{flex:none;min-width:0;padding:3px 5px;border-radius:6px;line-height:18px}.bu-current{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;font-weight:600;cursor:text!important}
.bu-crumb:first-child{color:var(--ink-weak)}.bu-separator{flex:none;width:14px;margin:0 -1px;color:var(--ink-weak);text-align:center;opacity:.7}.bu-ellipsis{flex:none}
.bu-measure .bu-crumb{flex:none}.bu-views{display:inline-flex;flex:none;padding:2px;border-radius:999px;background:var(--surface-3)}
.bu-views .bu-icon{width:auto;height:24px;padding:0 10px;gap:4px;font-size:12px;border-radius:999px}.bu-views svg{display:none;width:15px;height:15px}
.bu-views .on{background:var(--surface-paper);box-shadow:0 1px 2px var(--shadow)}.bu-views.bu-icons svg{display:block}.bu-views.bu-icons span{display:none}.bu-views.bu-icons .bu-icon{padding:0 7px}
.bu-holder-slot{display:flex;align-items:center;flex:none;max-width:130px;overflow:hidden;border-radius:999px}.bu-holder-slot:empty{display:none}
.bu-holder-slot.bu-dot{max-width:24px}.bu-holder-slot.bu-dot [data-holder-label]{display:none}
.bu-address-input{width:100%;min-width:0;flex:1;border:0;outline:0;background:none;color:var(--ink);font:inherit;font-size:13px;padding:0 8px;height:100%}
.bu-editing .bu-omni{box-shadow:inset 0 0 0 2px var(--line-blue)}
.bu-suggestions,.bu-address-error{position:absolute;z-index:20;top:43px;left:8px;right:8px;background:var(--surface-paper);border-radius:var(--r-m);box-shadow:0 4px 16px var(--shadow);padding:6px}
.bu-suggestion{display:block;width:100%;text-align:left;padding:8px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:var(--r-s)}.bu-suggestion:hover,.bu-suggestion[aria-selected=true]{background:var(--surface-2)}
.bu-address-error{color:var(--ink-danger);font-size:13px;padding:10px 14px}.bu-conversation,.bu-count{display:none}
.bu-tight>.bu-forward:disabled{display:none}
.bu-mobile>.bu-icon:not(.bu-conversation):not(.bu-more){display:none}.bu-mobile .bu-conversation{display:inline-flex}.bu-mobile .bu-count{display:block;width:20px;height:20px;padding:0;border:1.7px solid var(--ink-weak);margin:0 7px;border-radius:4px;font-size:12px;line-height:16px}.bu-phone-filename{font-weight:600}
.bu-mobile .bu-omni{height:34px;margin:0 2px}.bu-mobile .bu-crumbs{font-size:13px;text-overflow:ellipsis;display:block;line-height:34px}.bu-mobile .bu-holder-slot{max-width:24px}
.bu-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;background:var(--surface-0);padding:16px;overflow:auto;max-height:70dvh}
.bu-card{position:relative;min-width:0;overflow:hidden;border-radius:var(--r-m);background:var(--surface-paper)}.bu-card.on{outline:2px solid var(--line-blue)}
.bu-card-pick{width:100%;text-align:left;padding:0 10px 10px!important}.bu-card-preview{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;margin-bottom:8px}.bu-card-label{display:flex;gap:6px;align-items:center;padding-right:16px}.bu-card-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.bu-card-close{position:absolute;right:4px;bottom:4px;width:24px;height:24px}.bu-overview-new{grid-column:1/-1;justify-self:center}
.browser-unify #filePreview[data-panel=chrome-window]{padding:0;gap:0;overflow:hidden}
.browser-unify #filePreview[data-panel=chrome-window]>.file-preview-head,.browser-unify #filePreview[data-panel=chrome-window]>.file-preview-toolbar{display:none}
.browser-unify #filePreview[data-panel=chrome-window] .file-preview-body-layout{padding:0;gap:0}
.browser-unify #filePreview[data-panel=chrome-window] .file-preview-content{padding:0;overflow:hidden;display:flex;flex-direction:column}
.browser-unify #filePreview[data-panel=page-frame]{padding:0;gap:0;overflow:hidden;background:var(--surface-paper)}
.browser-unify #filePreview[data-panel=page-frame]>.file-preview-head,.browser-unify #filePreview[data-panel=page-frame]>.file-preview-toolbar{display:none}
.bu-frame-body{display:flex;flex-direction:column;flex:1;min-height:0}.bu-frame .bu-count{display:none!important}
.browser-unify #filePreview[data-panel=page-frame] .file-preview-body-layout{padding:0;gap:0}
.browser-unify #filePreview[data-panel=page-frame] .file-preview-content{border-radius:0;overflow:hidden;display:flex;flex-direction:column}
.page-frame-dir{color:var(--ink-weak)}.page-frame-file{font-weight:600}
.browser-unify .cp.bu-panel{display:flex;flex-direction:column;flex:1;min-height:0;gap:0;padding:0}
.browser-unify .bu-panel>.cp-screen{flex:1;min-height:0;border:0;border-radius:0;margin:0}
.bu-tab-pick .b2-tab-dot{flex:none}
.bu-tab.bu-flash{animation:bu-flash .9s ease-out}@keyframes bu-flash{0%,40%{background:color-mix(in srgb,var(--line-blue) 22%,transparent)}}
@media(prefers-reduced-motion:reduce){.bu-tab.bu-flash{animation:none;outline:2px solid var(--line-blue);outline-offset:-2px}}
.bu-phone-strip{padding:0 0 6px}.bu-phone-strip[hidden]{display:none}
.cp-screen>.bu-local-page{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;z-index:5;background:var(--surface-paper)}
@media(max-width:600px){.bu-tabs{display:none}.bu-toolbar{height:48px}.browser-unify #filePreview[data-panel=chrome-window]{border-radius:0}}
`;

// i18n-dynamic: tabs:address.locations.
/** スマホの帯の名前。Pleiad のページはホスト名（localhost）でなく、ファイル・フォルダーの名前かページの名前。Web は空（ホスト名を出す） */
export function pageName(tab) {
  const page = tab?.page; if (!page?.kind) return '';
  if (['file', 'dir'].includes(page.kind)) return String(page.path ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || page.path || '';
  return t(`tabs:address.locations.${page.kind}`, { defaultValue:tab.title || '' });
}

/** 可視化の別のタブ（隔離の origin の /viz/。web/visualize-frame.mjs）は、ホスト名（localhost）でなく説明の文（ページの <title>） */
const vizTitle = tab => (/^http:\/\/localhost:\d+\/viz\/[0-9a-f]{64}\//.test(tab?.url ?? '') ? tab.title ?? '' : '');

/** タブの帯と一覧の題。Pleiad のページはページの <title>（「· Pleiad」付き）でなく、ファイル・フォルダーの名前かページの名前。新しいタブのページは「新しいタブ」 */
export function tabLabel(tab) {
  if (tab?.page?.kind === 'new') return t('tabs:strip.new');
  return pageName(tab) || tab?.title || tab?.page?.path || tab?.url || t('tabs:strip.new');
}

// スマホでは映像でなく端末内で描く Pleiad のページ（Web・HTML のファイル・新しいタブは映像のまま）
const LOCAL_PAGES = new Set(['file', 'dir', 'git', 'plugins']);
/** スマホで端末内に描くページの URL。本体と同じ出どころの /_pleiad/（端末の Cookie で入る。ホストの pages の port は使わない）。描かないタブは null */
export function localPageUrl(tab, sessionId, origin = globalThis.location?.origin) {
  if (!LOCAL_PAGES.has(tab?.page?.kind) || !sessionId || !origin) return null;
  let url; try { url = new URL(tab.url); } catch { return null; }
  const match = /^\/_pleiad\/s\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match || match[1] !== encodeURIComponent(sessionId) || match[2] !== tab.page.kind || url.username || url.password) return null;
  return new URL(url.pathname + url.search, origin).href;
}
/** 同じページか（種類とパス）。行や表示の違いでは描き直さない */
const pageKey = href => { try { const url = new URL(href); return `${url.pathname}\n${url.searchParams.get('path') ?? ''}`; } catch { return ''; } };

/**
 * 右の欄（タブの列・アドレスバー・札・タブの活動の点・スマホの帯）。web/client.mjs は本体が browserUnify を返したときに読む（ADR 0294 の段 C1 から常に返す）。
 * deps:
 *   - cmd・state・chrome（web/chrome-panel.mjs）・showMenu・notify
 *   - preview: web/file-preview.mjs（タブの ⋮ と右クリックのファイルの操作 tabMenu）。osActions(): サーバーのある PC の画面か（外で開く操作を出す）
 *   - controlStore: web/chrome-control.mjs の chromeControlStore（エージェントが動いているか・止めたか）。agentName(sessionId): 札の名前
 *   - onPageRequest(request, { sessionId, targetId }): ファイルのページからの頼み（tab:page-request）。worktree の頼みは戻り値・例外をページへ返す
 *   - composer(): スマホの帯を置く入力欄（その上に置く）
 */
export function createBrowserUnify(deps = {}) {
  const { cmd, state = {}, chrome = () => null, showMenu = () => {}, notify = () => {}, osActions = () => false } = deps;
  // active は端末内のページ、または切り替えの応答待ちの選択だけ。確定した映像の対象は chrome().tabId が持つ。
  const rows = new Map(), holders = new Map(); let active = null, enabled = false, awaitingState = false;
  const session = () => chrome()?.sessionId ?? state.current;
  const tabs = () => rows.get(session()) ?? [];
  const current = () => tabs().find(tab => active?.sessionId === session() && tab.targetId === active.targetId) ?? tabs().find(tab => tab.targetId === chrome()?.tabId) ?? tabs()[0] ?? null;
  const holderOf = (sessionId, targetId) => holders.get(sessionId)?.get(targetId) ?? { holder:'ai' };
  const phoneQuery = matchMedia('(max-width: 600px)');
  const failed = error => notify(t(`tabs:address.reasons.${error?.code ?? error?.message}`, { defaultValue:t('tabs:address.failed') }));
  /**
   * タブの ⋮ と右クリックの今のタブの操作。ファイル・フォルダーのページはファイルの操作（web/file-preview.mjs の tabMenu）、
   * Web のページは「既定のブラウザーで開く」（URL）。リモートの画面では外で開く操作を出さない（ADR 0010。モック v6 の 9）
   */
  const tabMenu = tab => {
    const page = tab?.page?.path && ['file', 'dir'].includes(tab.page.kind) ? { path:tab.page.path, kind:tab.page.kind === 'dir' ? 'directory' : 'file' } : null;
    if (page) return deps.preview?.tabMenu?.({ ...tab, page }) ?? [];
    if (tab?.page || !/^https?:\/\//i.test(tab?.url ?? '') || !osActions()) return [];
    return [{ label:t('browser.openExternal'), icon:menuIcon('web'), onClick:() => openExternalLink(tab.url) }];
  };
  async function navigate(action, args = {}) {
    const sessionId = session(); if (!sessionId) return;
    const here = local && local.sessionId === sessionId && local.targetId === current()?.targetId ? local : null;
    // 端末内のページ: ツリー・原文は手元のページへ（Chrome のタブにも表示を合わせる）、再読み込みは手元を読み直す
    if (here && action === 'tree') { pageCommand(here, { type:'tree' }); return {}; }
    if (here && action === 'reload') { try { here.frame.contentWindow?.location.reload(); } catch { /* 読み込み中 */ } return {}; }
    const result = await cmd('chromeNavigate', { sessionId, targetId:current()?.targetId, action, ...args });
    if (here && action === 'view') pageCommand(here, { type:'view', view:args.view === 'source' ? 'source' : 'preview' });
    if (result?.targetId) await pick(tabs().find(tab => tab.targetId === result.targetId) ?? { targetId:result.targetId });
    return result;
  }
  async function pick(tab) {
    const selection = active = { sessionId:session(), targetId:tab.targetId };
    overview.hidden = true;
    // スマホが手元に描くページの間は映像を止めているので固定しない
    if (enabled && phoneQuery.matches && chrome()?.isOpen?.() && localPageUrl(tab, selection.sessionId)) {
      chrome()?.cancelTabPin?.(); paint(); return;
    }
    // 映していない間（パネルが閉じている・映し直している）は、パネルが映し始めてから固定する
    const pin = { windowId:tab.windowId ?? null, tabId:tab.targetId };
    try {
      // 端末内のページを外すと映像の開始が走る。先に切り替えを予約し、開始時の古いタブ情報で選択を戻さない。
      const pending = chrome()?.pinTab ? chrome().pinTab(selection.sessionId, pin)
        : cmd('chromePinWindow', { sessionId:selection.sessionId, ...pin });
      paint();
      await pending;
      if (!chrome()?.pinTab && active === selection && chrome()?.tabId === tab.targetId) { active = null; paint(); }
    } catch (error) {
      if (active === selection) { active = null; paint(); }
      notify(error?.message || t('browser.chromeWindow.pinFailed'));
    }
  }
  /** 札・点・帯の元。agentUsed: この会話のエージェントがブラウザーを使っている（使っていなければ札も点も出さない） */
  function control() {
    const sessionId = session(), tab = current(), agentTab = chrome()?.screencastState?.agentTabId ?? null;
    const store = deps.controlStore?.get?.(sessionId)?.state ?? 'idle';
    const held = tab ? holderOf(sessionId, tab.targetId) : { holder:'ai' };
    return { sessionId, tab, held, agentTab, store, agentUsed:store !== 'idle' || agentTab != null, name:deps.agentName?.(sessionId) || 'Claude' };
  }
  const strip = createTabStrip({ label:tabLabel, onPick:pick, onClose:tab => navigate('close', { targetId:tab.targetId }).catch(failed), onNew:() => navigate('new').catch(failed),
    // タブの右クリック: 今のタブの操作、その下に再読み込み・タブを閉じる（モック v6 の「タブを右クリック」。題は付けない）
    onMenu(tab, event) {
      event.preventDefault();
      const items = tabMenu(tab);
      showMenu(event.clientX, event.clientY, [...items, ...(items.length ? [{ sep:true }] : []),
        { label:t('tabs:address.reload'), icon:menuIcon('reload'), onClick:() => navigate('reload', { targetId:tab.targetId }).catch(failed) },
        { label:t('tabs:strip.closeTab'), icon:menuIcon('close'), onClick:() => navigate('close', { targetId:tab.targetId }).catch(failed) }]);
    },
    decorate(tab, pickButton) {
      if (!enabled) return;
      const c = control();
      createTabActivityDot({ mount:pickButton }).update({ active:c.agentUsed && c.store === 'running' && tab.targetId === c.agentTab,
        holder:holderOf(c.sessionId, tab.targetId).holder === 'human' ? 'human' : 'ai', waiting:false });
    } });
  const address = createAddressBar({ navigate, cwd:() => state.cwd ?? '', suggest:input => cmd('chromeAddress', { sessionId:session(), input }), onClose:() => chrome()?.close(), onTabs:() => showOverview(),
    onMenu:(anchor, shown) => addressMenu(anchor, { ...shown, go:action => navigate(action).catch(failed), setView:view => address.setView(view),
      extra:[...tabMenu(shown.tab), ...(chrome()?.browserMenuItems?.(anchor) ?? [])], close:() => chrome()?.close() }) });
  /**
   * アドレスバーの ⋮。会話の Chrome の欄と Chrome 無しの欄（frameBar）で同じ並びにする（モック v6 の「メニュー」）:
   * 新しいタブ・（スマホ）戻る・進む・再読み込み・（表示の切り替えを隠したとき）原文を表示・ファイルの操作・（PC）パネルを閉じる。
   * スマホは左上の ‹ で会話へ戻るので「パネルを閉じる」は出さない。見出しは付けない（モックに無い）
   */
  function addressMenu(anchor, { tab, view, viewHidden, go, setView, extra, close }) {
    const icon = menuIcon;
    const items = [];
    // スマホは戻る・進む・再読み込みをアドレスバーから外したので、メニューの頭にアイコンの 1 段で置く（モック v6 の phone-menu）
    if (phoneQuery.matches) items.push({ tools:['back', 'forward', 'reload'].map(action => ({ label:t(`tabs:address.${action}`), icon:icon(action),
      disabled:action === 'back' ? !tab?.canGoBack : action === 'forward' ? !tab?.canGoForward : !tab, onClick:() => go(action) })) });
    items.push({ label:t('tabs:strip.new'), icon:icon('plus'), onClick:() => go('new') });
    if (viewHidden && hasFileViews(tab)) items.push({ sep:true }, { label:t('tabs:address.showSource'), icon:icon('source'), checked:view === 'source', onClick:() => setView(view === 'source' ? 'preview' : 'source') });
    if (extra.length) items.push({ sep:true }, ...extra);
    if (!phoneQuery.matches) items.push({ sep:true }, { label:t('tabs:address.closePanel'), icon:icon('panel'), onClick:close });
    const box = anchor.getBoundingClientRect(); showMenu(box.left, box.bottom + 4, items);
  }
  const root = document.createElement('div'); root.className = 'bu-chrome'; root.append(strip.root, address.root);
  const overview = document.createElement('div'); overview.className = 'bu-overview'; overview.hidden = true; root.append(overview);
  let badge = null, phoneStrip = null, stripHolder = null;
  async function showOverview() {
    overview.hidden = !overview.hidden; if (overview.hidden) return;
    overview.replaceChildren(...tabs().map(tab => {
      const card = document.createElement('div'); card.className = 'bu-card' + (tab.targetId === current()?.targetId ? ' on' : '');
      const pickButton = document.createElement('button'); pickButton.type = 'button'; pickButton.className = 'bu-card-pick';
      const img = document.createElement('img'); img.alt = ''; img.className = 'bu-card-preview';
      const title = document.createElement('span'); title.className = 'bu-card-title'; title.textContent = tabLabel(tab);
      const label = document.createElement('div'); label.className = 'bu-card-label'; label.append(tabIcon(tab), title);
      pickButton.append(img, label); pickButton.onclick = () => pick(tab); card.append(pickButton);
      const close = browserButton('close', t('tabs:strip.close', { title:title.textContent }), () => navigate('close', { targetId:tab.targetId }).then(() => { overview.hidden = true; showOverview(); }).catch(failed)); close.classList.add('bu-card-close'); card.append(close);
      cmd('chromeAddress', { sessionId:session(), input:'', targetId:tab.targetId, thumbnail:true }).then(result => { if (img.isConnected && result?.data) img.src = `data:image/jpeg;base64,${result.data}`; }).catch(() => {});
      return card;
    }));
    const add = browserButton('plus', t('tabs:strip.new'), () => { overview.hidden = true; navigate('new').catch(failed); }); add.classList.add('bu-overview-new'); overview.append(add);
  }
  /** 札（アドレスバーの中）とスマホの帯を今の状態にする */
  function paintControl() {
    if (!enabled) return;
    const c = control(), holder = c.held.holder === 'human' ? 'human' : 'ai';
    badge?.update({ agentUsed:c.agentUsed, holder, paused:c.store === 'paused', waiting:c.store !== 'running', name:c.name });
    // スマホ: 右の欄を閉じている間、入力欄の上に帯（押すと右の欄を開く）。入力欄は履歴に重ねてあるので、帯は入力欄の中の先頭に置く
    const composer = deps.composer?.();
    const want = phoneQuery.matches && c.agentUsed && tabs().length > 0 && !chrome()?.isOpen?.() && !!composer;
    if (want && !phoneStrip) {
      stripHolder = document.createElement('div'); stripHolder.className = 'bu-phone-strip'; composer.prepend(stripHolder);
      phoneStrip = createPhoneBrowserStrip({ mount:stripHolder, onActivate:() => chrome()?.open?.(), onResume:() => cmd('chromeResume', { sessionId:session() }) });
    }
    if (stripHolder) stripHolder.hidden = !want;
    // 帯は今の「一時停止中」の帯を置き換える（任せるは帯にもある）。帯を出している間は、会話の側の古い帯を出さない
    const banner = document.getElementById('chromeBanner');
    if (banner) banner.hidden = want;
    if (!want) return;
    const image = chrome()?.frameImage ?? stripThumb(c.sessionId, c.tab);
    phoneStrip.update({ url:c.tab?.url ?? '', title:pageName(c.tab) || vizTitle(c.tab), tabs:tabs().length, holder, name:c.name, image, last:c.held.last ?? null, pinned:!!c.held.pinned });
  }
  /** 帯の小さな絵: 右の欄を閉じている間は映像が無いので、タブを撮った絵を使う。同じタブは 15 秒に 1 回まで */
  const thumbs = new Map();
  function stripThumb(sessionId, tab) {
    if (!sessionId || !tab?.targetId) return null;
    const key = `${sessionId}\n${tab.targetId}`, held = thumbs.get(key);
    if (!held || (!held.pending && Date.now() - held.at > 15_000)) {
      const next = { at:Date.now(), pending:true, src:held?.src ?? null }; thumbs.set(key, next);
      cmd('chromeAddress', { sessionId, input:'', targetId:tab.targetId, thumbnail:true }).then(result => {
        if (result?.data) next.src = `data:image/jpeg;base64,${result.data}`;
      }).catch(() => {}).finally(() => { next.pending = false; next.at = Date.now(); if (next.src && thumbs.get(key) === next) paintControl(); });
    }
    return thumbs.get(key).src;
  }
  function paint() { const tab = current(); strip.update(tabs(), tab?.targetId); address.show(tab, tabs().length); paintControl(); paintLocal(); }
  /** スマホのファイル・フォルダー・git・プラグインのタブは、映像の上に端末内のページを重ねる。タブ・題・履歴は Chrome のタブのまま */
  let local = null;
  function paintLocal() {
    const tab = current(), sessionId = session();
    const url = enabled && (!awaitingState || active) && phoneQuery.matches && chrome()?.isOpen?.() ? localPageUrl(tab, sessionId) : null;
    if (!url) { if (local) { local = null; chrome()?.mountPage?.(null); } return; }
    if (local?.sessionId === sessionId && local.targetId === tab.targetId) {
      // 戻る・進む・アドレスバーで Chrome のタブが別のページへ移った
      if (pageKey(url) !== pageKey(local.url)) { local.url = url; try { local.frame.contentWindow.location.replace(url); } catch { local.frame.src = url; } }
      return;
    }
    const frame = document.createElement('iframe'); frame.className = 'bu-local-page'; frame.title = pageName(tab) || tab.title || '';
    frame.setAttribute('referrerpolicy', 'no-referrer'); frame.src = url;
    const entry = local = { frame, sessionId, targetId:tab.targetId, url };
    frame.addEventListener('load', () => followLocal(entry));
    chrome()?.mountPage?.(frame);
  }
  /** ページの中のリンク（フォルダー → ファイルなど）で移ったら、Chrome のタブも同じページへ移す（タブの題・帯・戻るを合わせる） */
  function followLocal(entry) {
    if (local !== entry) return;
    let at; try { at = new URL(entry.frame.contentWindow.location.href); } catch { return; }
    if (at.origin !== location.origin || pageKey(at.href) === pageKey(entry.url)) return;
    entry.url = at.href;
    const kind = /\/(file|dir)$/.exec(at.pathname)?.[1], path = at.searchParams.get('path');
    if (kind && path) cmd('chromeNavigate', { sessionId:entry.sessionId, targetId:entry.targetId, action:'navigate', input:path }).catch(failed);
  }
  function pageCommand(entry, command) { entry.frame.contentWindow?.postMessage({ type:'pleiad:page-command', command }, location.origin); }
  /** 端末内のページの頼み（ファイルの ⋯ など）。Chrome のタブからの頼み（tab:page-request）と同じ口へ渡し、結果はページへ返す */
  async function localRequest(event) {
    const entry = local;
    if (!entry || event.source !== entry.frame.contentWindow || event.origin !== location.origin || !deps.onPageRequest) return;
    const request = pageRequestOf(event.data, entry.sessionId); if (!request) return;
    const reply = (ok, value) => { if (local === entry && request.requestId) entry.frame.contentWindow?.postMessage({ type:'pleiad:page-result', requestId:request.requestId, ok,
      ...(ok ? { result:value ?? null } : { error:String(value?.message ?? value ?? 'unavailable').slice(0, 200) }) }, location.origin); };
    try { reply(true, await deps.onPageRequest(framePoint(request, entry.frame.getBoundingClientRect()), { sessionId:entry.sessionId, targetId:entry.targetId })); }
    catch (error) { reply(false, error); }
  }
  /**
   * Chrome の無い会話の右の欄（web/page-frame.mjs の 1 枚の iframe）の頭。アドレスバーと同じ形（ツリー・区切り・プレビュー／原文）で、
   * タブの列・件数・新しいタブは出さない（ADR 0294 の 4 の 2）。戻る・進むはその iframe の中の履歴だけ（Navigation API）。Web の URL は既定のブラウザーへ
   */
  function frameBar(frame, { sessionId }) {
    const closePanel = () => deps.preview?.close?.();
    const pageUrl = (kind, path) => `/_pleiad/s/${encodeURIComponent(sessionId)}/${kind}${path ? `?${new URLSearchParams({ path })}` : ''}`;
    const win = () => { try { return frame.contentWindow; } catch { return null; } };
    async function go(action, args = {}) {
      if (action === 'tree') return pageCommand({ frame }, { type:'tree' });
      if (action === 'view') return pageCommand({ frame }, { type:'view', view:args.view === 'source' ? 'source' : 'preview' });
      if (action === 'reload') return win()?.location.reload();
      if (action === 'back' || action === 'forward') { try { await win()?.navigation?.[action]().committed; } catch { /* 先が無い */ } return; }
      if (action === 'home') { frame.src = pageUrl('new'); return; }
      const input = String(args.input ?? '').trim();
      if (/^https?:\/\//i.test(input)) { if (!openExternalLink(input)) throw new Error('blocked'); return; }
      const where = await cmd('resolvePath', { sessionId, path:input });
      frame.src = pageUrl(where.kind === 'directory' ? 'dir' : 'file', where.path);
    }
    const bar = createAddressBar({ navigate:go, cwd:() => state.cwd ?? '', onClose:closePanel,
      suggest:input => cmd('chromeAddress', { sessionId, input }).catch(() => ({})),
      onMenu:(anchor, shown) => addressMenu(anchor, { ...shown, go:action => go(action === 'new' ? 'home' : action).catch(failed), setView:view => bar.setView(view),
        extra:tabMenu(shown.tab), close:closePanel }) });
    /** iframe が今出しているページを、アドレスバーの 1 つのタブとして見せる */
    function sync() {
      let at; try { at = new URL(win()?.location.href); } catch { return; }
      if (at.origin !== location.origin) return;
      const kind = /^\/_pleiad\/s\/[^/]+\/([^/]+)$/.exec(at.pathname)?.[1], path = at.searchParams.get('path');
      const navigation = win()?.navigation;
      bar.show({ targetId:'page-frame', url:at.href, page:kind ? { kind, ...(path ? { path } : {}) } : null,
        canGoBack:!!navigation?.canGoBack, canGoForward:!!navigation?.canGoForward }, 1);
    }
    frame.addEventListener('load', () => { sync(); win()?.navigation?.addEventListener?.('currententrychange', sync); });
    const head = document.createElement('div'); head.className = 'bu-chrome bu-frame'; head.append(bar.root);
    const body = document.createElement('div'); body.className = 'bu-frame-body'; body.append(head, frame);
    let first; try { first = new URL(frame.src, location.origin); } catch { first = null; }
    if (first) {
      const kind = /\/([^/]+)$/.exec(first.pathname)?.[1], path = first.searchParams.get('path');
      bar.show({ targetId:'page-frame', url:first.href, page:{ kind, ...(path ? { path } : {}) }, canGoBack:false, canGoForward:false }, 1);
    }
    return { body, dispose:() => bar.destroy() };
  }
  function attach() {
    chrome()?.mountBrowserChrome?.(root, address.holderSlot);
    if (badge) chrome()?.mountStatus?.(badge.element);
    paint();
  }
  /** ファイルのページの頼み。worktree（requestId がある）は結果をページへ返す。メニューの位置はページの点から映像の上の点へ直す */
  async function pageRequest({ sessionId, targetId, request }) {
    if (!request || typeof request !== 'object' || request.sessionId !== sessionId || !deps.onPageRequest) return;
    const reply = (ok, value) => cmd('pageResult', { sessionId, targetId, requestId:request.requestId, ok,
      ...(ok ? { result:value ?? null } : { error:String(value?.message ?? value ?? 'unavailable').slice(0, 200) }) }).catch(() => {});
    try {
      const point = request.type === 'file-menu' && chrome()?.tabId === targetId ? chrome()?.toScreen?.({ x:request.x, y:request.y }) : null;
      const result = await deps.onPageRequest(point ? { ...request, x:point.x, y:point.y } : request, { sessionId, targetId });
      if (request.requestId) reply(true, result);
    } catch (error) { if (request.requestId) reply(false, error); }
  }
  return {
    root, tabs:strip, address, navigate, frameBar,
    /** その会話のタブ（web/file-preview.mjs の configureBrowserUnify。同じファイルのタブを使い回す） */
    tabsOf:sessionId => rows.get(sessionId) ?? [],
    /** 会話の Chrome に新しいタブで開き、右の欄に映す（ファイルのリンク・可視化） */
    async openTab({ sessionId, url }) {
      const result = await cmd('chromeNavigate', { sessionId, action:'new', input:url });
      if (sessionId !== session()) return result;
      if (result?.targetId) await pick(tabs().find(tab => tab.targetId === result.targetId) ?? { targetId:result.targetId });
      chrome()?.open?.(); return result;
    },
    /** 開いているタブを選んで右の欄に映す */
    async focusTab(tab, sessionId) {
      if (sessionId !== session()) return;
      await pick(tab); chrome()?.open?.();
    },
    /** タブの列のタブを一瞬光らせる（もう開いていたファイル） */
    flashTab(tab, sessionId) {
      if (sessionId !== session()) return;
      const item = [...strip.root.querySelectorAll('.bu-tab')].find(node => node.dataset.target === tab?.targetId);
      if (!item) return;
      item.classList.remove('bu-flash'); void item.offsetWidth; item.classList.add('bu-flash');
      item.addEventListener('animationend', () => item.classList.remove('bu-flash'), { once:true });
      setTimeout(() => item.classList.remove('bu-flash'), 1200);
    },
    /** Tab-control status insertion point; also reached through chromePanel.mountStatus(). */
    holderSlot:address.holderSlot,
    capsChanged(caps) {
      if (!caps?.browserUnify) return;
      if (!enabled) {
        enabled = true; const style = document.createElement('style'); style.dataset.browserUnify = ''; style.textContent = css; document.head.append(style); document.body.classList.add('browser-unify');
        // 札は止める・任せるだけ（映像に触れるだけでは引き継がない。ADR 0296）
        badge = createControlBadge({ onStop:() => cmd('chromeStop', { sessionId:session() }), onResume:() => cmd('chromeResume', { sessionId:session() }) });
        chrome()?.useInput?.({ phone:() => phoneQuery.matches });
        chrome()?.onOpenChange(open => { if (!open) { active = null; awaitingState = true; } attach(); });
        chrome()?.onTargetChange(attach);
        chrome()?.onTabChange?.(event => {
          if (event?.type === 'reconnected') awaitingState = true;
          if (event?.type === 'state') awaitingState = false;
          if (event?.type === 'state' || event?.type === 'reconnected'
            || (event?.type === 'pin-failed' && active?.targetId === event.tabId
              && (!event.sessionId || event.sessionId === active.sessionId))) active = null;
          paint();
        });
        deps.controlStore?.onChange?.(id => { if (id === session()) paint(); });
        phoneQuery.addEventListener?.('change', () => { paintControl(); paintLocal(); });
        window.addEventListener('message', localRequest);
        document.dispatchEvent(new CustomEvent('ply-browser-availability'));
      }
      attach(); if (state.current) cmd('watchSession', { sessionId:state.current }).catch(failed);
    },
    /** 配色が変わった（端末内のページにも渡す） */
    envChanged(env) { local?.frame.contentWindow?.postMessage({ type:'pleiad:env', env }, location.origin); },
    onEvent(event) {
      document.dispatchEvent(new CustomEvent('ply-tab-event', { detail:event }));
      if (event.type === 'tab:info') {
        let list = rows.get(event.sessionId) ?? [];
        if (event.reset) { list = event.tabs ?? []; holders.delete(event.sessionId); }
        else if (event.removed) { list = list.filter(tab => tab.targetId !== event.targetId); holders.get(event.sessionId)?.delete(event.targetId); }
        else { const at = list.findIndex(tab => tab.targetId === event.targetId); list = [...list]; if (at < 0) list.push(event); else list[at] = event; }
        rows.set(event.sessionId, list); if (event.sessionId === session()) paint();
      } else if (event.type === 'tab:holder') {
        if (!holders.has(event.sessionId)) holders.set(event.sessionId, new Map());
        if (event.holder === 'human') holders.get(event.sessionId).set(event.targetId, event); else holders.get(event.sessionId).delete(event.targetId);
        if (event.sessionId === session()) paint();
      } else if (event.type === 'tab:page-request') pageRequest(event);
      else if (event.type === 'page:changed') {
        // 端末内のページがそのファイルを出していれば知らせる（読み直すかはページが決める。Chrome のタブは本体が届ける）
        const entry = local;
        if (entry && event.sessionId === entry.sessionId && typeof event.path === 'string') {
          let at; try { at = new URL(entry.frame.contentWindow?.location?.href ?? entry.url, location.origin); } catch { at = null; }
          const shown = at?.origin === location.origin ? at.searchParams.get('path') : null;
          const norm = value => String(value ?? '').replaceAll('\\', '/');
          const target = norm(event.path).toLowerCase();
          if (shown && (norm(shown).toLowerCase() === target || norm(shown) === norm(event.path))) pageCommand(entry, { type:'changed' });
        }
      }
      // page:moved: 端末内のページは本体と同じ出どころ（/_pleiad/…。port は入っていない）なので張り直しは要らない。
      // Chrome のタブは本体（relay.migratePageTabs）が付け替え、tab:info が届いて列が直る
    },
  };
}
