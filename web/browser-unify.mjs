import { t } from './i18n.mjs';
import { createTabStrip, browserButton, tabIcon } from './tab-strip.mjs';
import { createAddressBar, hasFileViews } from './address-bar.mjs';
import { createControlBadge, createTabActivityDot, createPhoneBrowserStrip } from './chrome-control.mjs';

// Local to the flagged browser: the legacy panel keeps its existing styles.
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
.browser-unify .cp.bu-panel{display:flex;flex-direction:column;flex:1;min-height:0;gap:0;padding:0}
.browser-unify .bu-panel>.cp-sw,.browser-unify .bu-panel>.cp-foot{display:none!important}
.browser-unify .bu-panel>.cp-screen{flex:1;min-height:0;border:0;border-radius:0;margin:0}
.browser-unify #contextEntry,.browser-unify #gitEntry,.browser-unify .th-git{display:none!important}
.bu-tab-pick .b2-tab-dot{flex:none}
.bu-tab.bu-flash{animation:bu-flash .9s ease-out}@keyframes bu-flash{0%,40%{background:color-mix(in srgb,var(--line-blue) 22%,transparent)}}
@media(prefers-reduced-motion:reduce){.bu-tab.bu-flash{animation:none;outline:2px solid var(--line-blue);outline-offset:-2px}}
.bu-phone-strip{padding:0 0 6px}.bu-phone-strip[hidden]{display:none}
@media(max-width:600px){.bu-tabs{display:none}.bu-toolbar{height:48px}.browser-unify #filePreview[data-panel=chrome-window]{border-radius:0}}
`;

/**
 * 旗が on の右の欄（タブの列・アドレスバー・札・タブの活動の点・スマホの帯）。web/client.mjs が旗が on のときだけ読む。
 * deps:
 *   - cmd・state・chrome（web/chrome-panel.mjs）・showMenu・notify
 *   - preview: web/file-preview.mjs（タブの ⋮ と右クリックのファイルの操作 tabMenu）
 *   - controlStore: web/chrome-control.mjs の chromeControlStore（エージェントが動いているか・止めたか）。agentName(sessionId): 札の名前
 *   - onPageRequest(request, { sessionId, targetId }): ファイルのページからの頼み（tab:page-request）。worktree の頼みは戻り値・例外をページへ返す
 *   - composer(): スマホの帯を置く入力欄（その上に置く）
 */
export function createBrowserUnify(deps = {}) {
  const { cmd, state = {}, chrome = () => null, showMenu = () => {}, notify = () => {} } = deps;
  const rows = new Map(), holders = new Map(); let active = null, enabled = false;
  const session = () => chrome()?.sessionId ?? state.current;
  const tabs = () => rows.get(session()) ?? [];
  const current = () => tabs().find(tab => tab.targetId === (chrome()?.tabId ?? active)) ?? tabs()[0] ?? null;
  const holderOf = (sessionId, targetId) => holders.get(sessionId)?.get(targetId) ?? { holder:'ai' };
  const phoneQuery = matchMedia('(max-width: 600px)');
  const failed = error => notify(t(`tabs:address.reasons.${error?.code ?? error?.message}`, { defaultValue:t('tabs:address.failed') }));
  /** ファイル・フォルダーのページのタブは、ファイルの操作（web/file-preview.mjs の tabMenu）を出す */
  const tabMenu = tab => {
    const page = tab?.page?.path && ['file', 'dir'].includes(tab.page.kind) ? { path:tab.page.path, kind:tab.page.kind === 'dir' ? 'directory' : 'file' } : null;
    return page ? deps.preview?.tabMenu?.({ ...tab, page }) ?? [] : [];
  };
  async function navigate(action, args = {}) {
    const sessionId = session(); if (!sessionId) return;
    const result = await cmd('chromeNavigate', { sessionId, targetId:current()?.targetId, action, ...args });
    if (result?.targetId) await pick(tabs().find(tab => tab.targetId === result.targetId) ?? { targetId:result.targetId });
    return result;
  }
  async function pick(tab) {
    active = tab.targetId; overview.hidden = true; paint();
    try { await cmd('chromePinWindow', { sessionId:session(), windowId:tab.windowId ?? null, tabId:tab.targetId }); } catch (error) { failed(error); }
  }
  /** 札・点・帯の元。agentUsed: この会話のエージェントがブラウザーを使っている（使っていなければ札も点も出さない） */
  function control() {
    const sessionId = session(), tab = current(), agentTab = chrome()?.screencastState?.agentTabId ?? null;
    const store = deps.controlStore?.get?.(sessionId)?.state ?? 'idle';
    const held = tab ? holderOf(sessionId, tab.targetId) : { holder:'ai' };
    return { sessionId, tab, held, agentTab, store, agentUsed:store !== 'idle' || agentTab != null, name:deps.agentName?.(sessionId) || 'Claude' };
  }
  const strip = createTabStrip({ onPick:pick, onClose:tab => navigate('close', { targetId:tab.targetId }).catch(failed), onNew:() => navigate('new').catch(failed),
    onMenu(tab, event) {
      const items = tabMenu(tab);
      if (items.length) { event.preventDefault(); showMenu(event.clientX, event.clientY, items, tab.page?.path ?? tab.title); }
    },
    decorate(tab, pickButton) {
      if (!enabled) return;
      const c = control();
      createTabActivityDot({ mount:pickButton }).update({ active:c.agentUsed && c.store === 'running' && tab.targetId === c.agentTab,
        holder:holderOf(c.sessionId, tab.targetId).holder === 'human' ? 'human' : 'ai', waiting:false });
    } });
  const address = createAddressBar({ navigate, cwd:() => state.cwd ?? '', suggest:input => cmd('chromeAddress', { sessionId:session(), input }), onClose:() => chrome()?.close(), onTabs:() => showOverview(),
    onMenu(anchor, { viewHidden, view, tab }) {
      const items = [{ label:t('tabs:strip.new'), onClick:() => navigate('new').catch(failed) }];
      if (matchMedia('(max-width: 600px)').matches) items.push({ sep:true }, ...['back', 'forward', 'reload'].map(action => ({ label:t(`tabs:address.${action}`), disabled:action === 'back' ? !tab?.canGoBack : action === 'forward' ? !tab?.canGoForward : !tab, onClick:() => navigate(action).catch(failed) })));
      if (viewHidden && hasFileViews(tab)) {
        items.push({ sep:true }, { label:t('tabs:address.showSource'), checked:view === 'source', onClick:() => address.setView(view === 'source' ? 'preview' : 'source') });
      }
      const extra = [...tabMenu(tab), ...(chrome()?.browserMenuItems?.(anchor) ?? [])];
      if (extra.length) items.push({ sep:true }, ...extra);
      items.push({ sep:true }, { label:t('tabs:address.closePanel'), onClick:() => chrome()?.close() });
      const box = anchor.getBoundingClientRect(); showMenu(box.left, box.bottom + 4, items, t('tabs:address.more'));
    } });
  const root = document.createElement('div'); root.className = 'bu-chrome'; root.append(strip.root, address.root);
  const overview = document.createElement('div'); overview.className = 'bu-overview'; overview.hidden = true; root.append(overview);
  let badge = null, phoneStrip = null, stripHolder = null;
  async function showOverview() {
    overview.hidden = !overview.hidden; if (overview.hidden) return;
    overview.replaceChildren(...tabs().map(tab => {
      const card = document.createElement('div'); card.className = 'bu-card' + (tab.targetId === current()?.targetId ? ' on' : '');
      const pickButton = document.createElement('button'); pickButton.type = 'button'; pickButton.className = 'bu-card-pick';
      const img = document.createElement('img'); img.alt = ''; img.className = 'bu-card-preview';
      const title = document.createElement('span'); title.className = 'bu-card-title'; title.textContent = tab.title || tab.page?.path || tab.url || t('tabs:strip.new');
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
      phoneStrip = createPhoneBrowserStrip({ mount:stripHolder, onActivate:() => chrome()?.open?.() });
    }
    if (stripHolder) stripHolder.hidden = !want;
    if (want) phoneStrip.update({ url:c.tab?.url ?? '', tabs:tabs().length, holder, name:c.name, image:chrome()?.frameImage ?? null, last:c.held.last ?? null, pinned:!!c.held.pinned });
  }
  function paint() { const tab = current(); strip.update(tabs(), tab?.targetId); address.show(tab, tabs().length); paintControl(); }
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
    root, tabs:strip, address, navigate,
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
        // 札は止める・任せるだけ（映像に触れるだけでは引き継がない。ADR 0293）
        badge = createControlBadge({ onStop:() => cmd('chromeStop', { sessionId:session() }), onResume:() => cmd('chromeResume', { sessionId:session() }) });
        chrome()?.useInput?.({ phone:() => phoneQuery.matches });
        chrome()?.onOpenChange(attach); chrome()?.onTargetChange(attach); chrome()?.onTabChange?.(paint);
        deps.controlStore?.onChange?.(id => { if (id === session()) paint(); });
        phoneQuery.addEventListener?.('change', paintControl);
        document.dispatchEvent(new CustomEvent('ply-browser-availability'));
      }
      attach(); if (state.current) cmd('watchSession', { sessionId:state.current }).catch(failed);
    },
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
    },
  };
}
