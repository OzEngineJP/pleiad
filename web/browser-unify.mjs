import { t } from './i18n.mjs';
import { createTabStrip, browserButton, browserIcon, tabIcon } from './tab-strip.mjs';
import { createWindowSwitch } from './chrome-window-switch.mjs';
import { createAddressBar, hasFileViews } from './address-bar.mjs';
import { createControlBadge, createTabHolderStore } from './chrome-control.mjs';
import { pageRequestOf, framePoint } from './page-frame.mjs';
import { samePath } from './file-actions.mjs';
import { createPageTabs } from './page-tabs.mjs';
import { createBrowserTree } from './browser-tree.mjs';
import { openExternalLink } from './link-open.mjs';

/** メニューの行のアイコン（タブの列・アドレスバーと同じ線の絵） */
const menuIcon = kind => { const svg = browserIcon(kind); svg.classList.add('i'); return svg; };

// Right-pane browser styles; injected once when the host reports browserUnify (always, since ADR 0294 stage C1).
const css = `
.bu-display{flex:none;font-size:12px!important;padding:6px 8px!important;border-radius:var(--r-pill);min-height:34px}
.bu-display:hover{background:var(--surface-3)}
.bu-page-update-bar{margin-left:var(--bu-tree-width);display:flex;align-items:center;gap:12px;padding:4px 12px;font-size:12px}.bu-page-update-bar[hidden]{display:none}.bu-page-update{display:block;margin:0 0 0 auto;padding:6px 12px!important;color:var(--ink-blue)!important}
.bu-page-host[hidden],.bu-local-page[hidden],.bu-explorer[hidden]{display:none!important}
.bu-local-page{width:100%;height:100%;border:0;display:block;background:var(--surface-paper)}
.bu-panel{position:relative;--bu-tree-width:0px}
.browser-unify .bu-panel>.cp-screen{margin-left:var(--bu-tree-width);width:calc(100% - var(--bu-tree-width))}
.bu-explorer{position:absolute;top:86px;bottom:0;left:0;z-index:6;display:flex;flex-direction:column;background:var(--surface-paper);color:var(--ink);font-size:13px}
.bu-explorer-head{display:flex;align-items:center;justify-content:space-between;min-height:38px;padding:0 12px}.bu-explorer-head>span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bu-explorer-list{flex:1;min-height:0;overflow:auto;padding:0 6px}.file-preview-content[hidden]{display:none!important}.bu-explorer-list .tree-row{min-height:30px;padding-top:0;padding-bottom:0}.bu-explorer-list .tree-row.sel{background:var(--surface-2);box-shadow:none}.bu-explorer{border-right:1px solid var(--line)}.bu-explorer-head button{border:0;background:none;color:inherit;cursor:pointer;width:28px;height:28px;padding:5px}.bu-explorer-head svg{width:16px;height:16px}.bu-tree-more{border:0;background:none;color:inherit;padding:5px;cursor:pointer}
.bu-explorer-list .tree-row>svg{width:16px;height:16px;flex:none}.bu-tree-more{width:28px;height:28px;margin-left:auto;opacity:0}.tree-row:hover .bu-tree-more,.tree-row.sel .bu-tree-more{opacity:1}
.bu-tree-resize{position:absolute;right:-3px;top:0;bottom:0;width:6px;cursor:col-resize;touch-action:none}.bu-tree-resize:focus-visible{outline:2px solid var(--line-blue)}
.bu-tree-overlay{box-shadow:6px 0 18px var(--shadow)}
@media(max-width:600px){.bu-display{font-size:11px!important;min-height:44px;padding:4px!important}.bu-explorer{top:48px}.bu-tree-more{opacity:1;min-width:44px;min-height:44px}.bu-explorer-list .tree-row{min-height:44px}}

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
.bu-address-input{width:100%;min-width:0;flex:1;border:0;outline:0;background:none;color:var(--ink);font:inherit;font-size:13px;padding:0 8px;height:100%}
.bu-editing .bu-omni{box-shadow:inset 0 0 0 2px var(--line-blue)}
.bu-suggestions,.bu-address-error{position:absolute;z-index:20;top:43px;left:8px;right:8px;background:var(--surface-paper);border-radius:var(--r-m);box-shadow:0 4px 16px var(--shadow);padding:6px}
.bu-suggestion{display:block;width:100%;text-align:left;padding:8px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:var(--r-s)}.bu-suggestion:hover,.bu-suggestion[aria-selected=true]{background:var(--surface-2)}
.bu-address-error{color:var(--ink-danger);font-size:13px;padding:10px 14px}.bu-conversation,.bu-count{display:none}
.tabn-badge{position:relative;display:grid;place-items:center;width:20px;height:20px;flex:none;padding:0;border:0;background:transparent;font-size:12px;line-height:16px;color:var(--ink-weak)}
.tabn-badge>svg{position:absolute;inset:0;width:20px;height:20px;overflow:visible}.tabn-badge>svg rect{stroke:currentColor}.tabn-value{position:relative;z-index:1}
.bu-tight>.bu-forward:disabled{display:none}
.bu-mobile>.bu-icon:not(.bu-conversation):not(.bu-more){display:none}.bu-mobile .bu-conversation{display:inline-flex}.bu-mobile .bu-count{display:block;margin:0 7px}.bu-mobile .bu-count.tabn-badge{display:grid;color:var(--ink-weak)}.bu-phone-filename{font-weight:600}
.bu-mobile .bu-omni{height:34px;margin:0 2px}.bu-mobile .bu-crumbs{font-size:13px;text-overflow:ellipsis;display:block;line-height:34px}
.bu-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;background:var(--surface-0);padding:16px;overflow:auto;max-height:70dvh}
.bu-card{position:relative;min-width:0;overflow:hidden;border-radius:var(--r-m);background:var(--surface-paper)}.bu-card.on{outline:2px solid var(--line-blue)}
.bu-card-pick{width:100%;text-align:left;padding:0 10px 10px!important}.bu-card-preview{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;margin-bottom:8px}.bu-card-label{display:flex;gap:6px;align-items:center;padding-right:16px}.bu-card-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.bu-card-close{position:absolute;right:4px;bottom:4px;width:24px;height:24px}.bu-overview-new{grid-column:1/-1;justify-self:center}
.browser-unify #filePreview[data-panel=chrome-window]{padding:0;gap:0;overflow:hidden}
.browser-unify #filePreview[data-panel=chrome-window]>.file-preview-head,.browser-unify #filePreview[data-panel=chrome-window]>.file-preview-toolbar{display:none}
.browser-unify #filePreview[data-panel=chrome-window] .file-preview-body-layout{padding:0;gap:0}
.browser-unify #filePreview[data-panel=chrome-window] .file-preview-content{padding:0;overflow:hidden;display:flex;flex-direction:column}
.browser-unify .cp.bu-panel{display:flex;flex-direction:column;flex:1;min-height:0;gap:0;padding:0}
.browser-unify .bu-panel>.cp-screen{flex:1;min-height:0;border:0;border-radius:0;margin:0 0 0 var(--bu-tree-width)}
.bu-tab.bu-flash{animation:bu-flash .9s ease-out}@keyframes bu-flash{0%,40%{background:color-mix(in srgb,var(--line-blue) 22%,transparent)}}
@media(prefers-reduced-motion:reduce){.bu-tab.bu-flash{animation:none;outline:2px solid var(--line-blue);outline-offset:-2px}}
.bu-agent{display:grid;place-items:center;flex:none;width:14px;height:14px}
.bu-agent .run{transform:scale(.75)}
.cp-sw{display:grid;grid-template-rows:0fr;visibility:hidden;flex:none;transition:grid-template-rows var(--dur) var(--ease-out),visibility 0s linear var(--dur)}
.cp-sw[data-open]{grid-template-rows:1fr;visibility:visible;transition-delay:0s;background:var(--bu-frame)}
.cp-sw-in{overflow:hidden;min-height:0}
.cp-sw-row{display:flex;align-items:center;gap:4px;padding:0 8px 0 12px}
.cp-sw-list{position:relative;display:flex;gap:2px;flex:1;min-width:0;padding:3px;overflow-x:auto;scrollbar-width:none;border-radius:var(--r-m);background:var(--surface-1)}
.cp-sw-list::-webkit-scrollbar{display:none}
.cp-sw-pad{position:absolute;left:0;top:3px;width:44px;height:24px;border-radius:var(--r-m);background:var(--surface-paper);pointer-events:none;transition:transform var(--dur) var(--ease-out),width var(--dur) var(--ease-out)}
.cp-sw-chip{position:relative;flex:none;display:flex;align-items:center;justify-content:center;gap:2px;width:44px;height:24px;padding:0;border:0;border-radius:var(--r-m);background:none;color:var(--ink-weak);font:inherit;font-size:11px;cursor:pointer;transition:width var(--dur) var(--ease-out),opacity var(--dur) var(--ease-out),color var(--dur-fast) var(--ease-out)}
.cp-sw-chip:hover:not(:disabled){color:var(--ink)}
.cp-sw-chip[aria-selected="true"]{color:var(--ink)}
.cp-sw-chip:disabled{cursor:default}
.cp-sw-chip.ghost{opacity:.35;pointer-events:none}
.cp-sw-chip:focus-visible,.cp-sw-follow:focus-visible{outline:2px solid var(--line-blue);outline-offset:2px}
.cp-sw-num{min-width:0;line-height:1}
.cp-sw-ag{display:grid;place-items:center;width:0;height:14px;transform:scale(0);transition:transform var(--dur) var(--ease-out),width var(--dur) var(--ease-out)}
.cp-sw-chip[data-agent] .cp-sw-ag{width:14px;transform:scale(1)}
.cp-sw-ag .run{transform:scale(.75)}
.cp-sw-chip[data-agent][data-idle] .cp-sw-ag::after{content:"";display:block;width:6px;height:6px;border-radius:50%;color:var(--ink-weak);background:currentColor}
.cp-sw-dot{display:block;width:6px;height:6px;border-radius:50%;color:var(--ink-weak);background:currentColor}
.cp-sw-dot.wait{color:var(--ink-mark)}
.cp-sw-chip.cp-sw-conv{width:auto;max-width:160px;padding:0 8px;gap:5px}
.cp-sw-chip + .cp-sw-conv{margin-left:5px}
.cp-sw-conv[data-on]{color:var(--ink)}
.cp-sw-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2}
.cp-sw-cm{display:grid;place-items:center;flex:none;width:10px;height:14px}
.cp-sw-cm:empty{display:none}
.cp-sw-cm .run{transform:scale(.75)}
.cp-sw-chip.flash{animation:cp-sw-flash 700ms var(--ease-out)}
@keyframes cp-sw-flash{0%{box-shadow:0 0 0 3px var(--line-blue)}100%{box-shadow:0 0 0 3px transparent}}
.cp-sw[data-paused] .cp-sw-chip:not(.cp-sw-conv){opacity:.45}
.cp-sw-follow{flex:none;position:relative;width:30px;height:30px;color:var(--ink-weak)}
.cp-sw-follow svg{width:17px;height:17px}
.cp-sw-follow.on{color:var(--ink-blue)}
.cp-sw-follow[data-away]{color:var(--ink)}
.cp-sw-follow.flash::after{content:"";position:absolute;inset:0;border-radius:50%;animation:cp-sw-flash 700ms var(--ease-out);pointer-events:none}
@media (pointer:coarse),(max-width:520px){
  .cp-sw-chip,.cp-sw-pad{height:34px}
  .cp-sw-chip{width:50px}
  .cp-sw-pad{width:50px}
  .cp-sw-chip.cp-sw-conv{width:auto}
  .cp-sw-follow{width:40px;height:40px}
}
@media (prefers-reduced-motion:reduce){
  .cp-sw,.cp-sw-pad,.cp-sw-chip,.cp-sw-ag{transition:none}
  .cp-sw-chip.flash,.cp-sw-follow.flash::after{animation:none}
  .cp-sw-chip.flash{box-shadow:0 0 0 2px var(--line-blue)}
}
.cp-screen>.bu-page-host{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;z-index:5;background:var(--surface-paper)}
@media(max-width:600px){.bu-tabs{display:none}.bu-toolbar{height:48px}.browser-unify #filePreview[data-panel=chrome-window]{border-radius:0}}
`;

// i18n-dynamic: tabs:address.locations.
/** アドレスバーと一覧の題。Pleiad のページはホスト名でなく、ファイル・フォルダーの名前かページの名前。Web は空（ホスト名を出す） */
export function pageName(tab) {
  const page = tab?.page; if (!page?.kind) return '';
  if ((['file', 'dir', 'html'].includes(page.kind) || page.kind === 'viz') && page.path) return String(page.path ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || page.path || '';
  if (page.kind === 'viz') return tab.title ?? '';
  if (page.kind === 'html') return page.title || tab.title || '';
  return t(`tabs:address.locations.${page.kind}`, { defaultValue:tab.title || '' });
}

/** タブの帯と一覧の題。Pleiad のページはページの <title>（「· Pleiad」付き）でなく、ファイル・フォルダーの名前かページの名前。新しいタブのページは「新しいタブ」 */
export function tabLabel(tab) {
  if (tab?.page?.kind === 'new') return t('tabs:strip.new');
  return pageName(tab) || tab?.title || tab?.page?.path || tab?.url || t('tabs:strip.new');
}

/**
 * 右の欄（タブの列・アドレスバー・ファイルツリー・スマホの入口）。web/client.mjs は本体が browserUnify を返したときに読む（ADR 0294 の段 C1 から常に返す）。
 * deps:
 *   - cmd・state・chrome（web/chrome-panel.mjs）・showMenu・notify
 *   - preview: web/file-preview.mjs（タブの ⋮ と右クリックのファイルの操作 tabMenu）。osActions(): サーバーのある PC の画面か（外で開く操作を出す）
 *   - controlStore: web/chrome-control.mjs の chromeControlStore（エージェントが動いているか・止めたか）
 *   - holderStore: web/chrome-control.mjs の createTabHolderStore（タブの持ち手。頭の行の印と同じ置き場を頭の行と分け合う。無ければ自分で持つ）
 *   - onPageRequest(request, { sessionId, targetId }): ファイルのページからの頼み（tab:page-request）。worktree の頼みは戻り値・例外をページへ返す
 *   - onTabsChange(): タブの列を描き直したとき（頭の行の [N] が数を追う）
 *   - windows: web/chrome-panel.mjs の createWindowTable（上の列の番号・エージェントのいる窓・固定）。無ければ上の列は出ない
 *   - conversations(): browser.chromeWindows の行（この会話と窓のある直接の子。上の列の題のチップ）
 *   - waiting(id): その会話にブラウザーの依頼が来ている（題のチップの印の色の点・入口の「依頼待ちなら Chrome のタブ」）
 *   - deviceOperating(id): この端末が「端末で操作」で引き継いでいる（自分が操作している間は切り替えられる）
 */
export function createBrowserUnify(deps = {}) {
  const { cmd, state = {}, chrome = () => null, showMenu = () => {}, notify = () => {}, osActions = () => false } = deps;
  // 上の列（会話の題・ウィンドウの番号）の元: chromeWindow イベントの表と、窓のある子の会話の一覧（browser.chromeWindows の行）
  const windowsTbl = deps.windows ?? null;
  const convIds = () => new Set([state.current, ...(deps.conversations?.() ?? []).map(row => row?.sessionId).filter(Boolean)]);
  // active は端末内のページ、または切り替えの応答待ちの選択だけ。確定した映像の対象は chrome().tabId が持つ。
  // タブの持ち手は会話ごとの置き場（holderStore。頭の行の印と同じものを見る。ADR 0296）
  const rows = new Map(), holderStore = deps.holderStore ?? createTabHolderStore(); let active = null, enabled = false, pagePort = null, order = 0;
  const orders = new Map();
  const session = () => chrome()?.sessionId ?? state.current;
  const pages = createPageTabs({ pageOpen:input => (deps.pageOpen ?? (args => cmd('pageOpen', args)))(input), origin:location.origin, changed:() => { if (enabled) paint(); },
    // 「触った」はページが送る活動だけでなく、映像側の持ち手も数える（Chrome の映像のタブを人が操作中なら、戻ったときの上書きも「触った」）
    touched:tab => holderOf(tab.sessionId, tab.chromeId ?? tab.targetId).holder === 'human',
    release:tab => { if (['file', 'dir', 'html'].includes(tab.page?.kind) && tab.page.path) cmd('pageWatch', { sessionId:tab.sessionId, path:tab.page.path, kind:tab.page.kind === 'dir' ? 'dir' : 'file', tab:tab.targetId }).catch(() => {}); },
    onError:error => failed(error) });
  const allTabs = id => { const local = pages.list(id), linked = new Set(local.map(tab => tab.chromeId).filter(Boolean)); const merged = [...local, ...(rows.get(id) ?? []).filter(tab => !linked.has(tab.targetId))];
    for (const tab of merged) { const key = `${id}:${tab.targetId}`; if (!orders.has(key)) orders.set(key, ++order); }
    return merged.sort((a,b) => orders.get(`${id}:${a.targetId}`) - orders.get(`${id}:${b.targetId}`)); };
  const tabs = () => allTabs(session());
  const current = () => tabs().find(tab => active?.sessionId === session() && tab.targetId === active.targetId) ?? tabs().find(tab => tab.targetId === chrome()?.tabId) ?? tabs()[0] ?? null;
  const holderOf = (sessionId, targetId) => holderStore.holderOf(sessionId, targetId);
  const phoneQuery = matchMedia('(max-width: 600px)');
  const failed = error => notify(t(`tabs:address.reasons.${error?.code ?? error?.message}`, { defaultValue:t('tabs:address.failed') }));
  /**
   * タブの ⋮ と右クリックの今のタブの操作。ファイル・フォルダーのページはファイルの操作（web/file-preview.mjs の tabMenu）、
   * Web のページは「既定のブラウザーで開く」（URL）。リモートの画面では外で開く操作を出さない（ADR 0010。モック v6 の 9）
   */
  const tabMenu = tab => {
    const page = tab?.page?.path && ['file', 'dir', 'viz', 'html'].includes(tab.page.kind) ? { path:tab.page.path, kind:tab.page.kind === 'dir' ? 'directory' : 'file' } : null;
    if (page) return deps.preview?.tabMenu?.({ ...tab, page }) ?? [];
    if (tab?.page?.kind === 'viz') return [{ label:t('tabs:display.copyTitle'), onClick:async () => { try { await navigator.clipboard.writeText(tab.title ?? ''); notify(t('timeline.code.copied')); } catch { notify(t('timeline.code.copyFailed')); } } }];
    if (tab?.page || !/^https?:\/\//i.test(tab?.url ?? '') || !osActions()) return [];
    return [{ label:t('browser.openExternal'), icon:menuIcon('web'), onClick:() => openExternalLink(tab.url) }];
  };
  const discard = tab => !tab?.dirty || (deps.confirm ?? globalThis.confirm)(t('tabs:display.discard'));
  async function openInput(input, sessionId, replace = null) {
    let kind, path, vizHash, entry, title, line, url;
    if (input) {
      let parsed; try { parsed = new URL(input, location.origin); } catch {}
      // 隔離の origin の名前（localhost と <印>.localhost。core/isolated-origins.mjs）
      const isolatedHost = parsed && (parsed.hostname === 'localhost' || /^[a-z0-9][a-z0-9-]{0,61}\.localhost$/i.test(parsed.hostname));
      const page = parsed && (parsed.origin === location.origin || (parsed.hostname === 'localhost' && parsed.port === String(pagePort))) && /^\/_pleiad\/s\/([^/]+)\/(file|dir|git|plugins|new|attachment)$/.exec(parsed.pathname);
      const viz = isolatedHost && /^\/viz\/([0-9a-f]{64})\/(.+)$/.exec(parsed.pathname);
      if (page && decodeURIComponent(page[1]) === sessionId) {
        kind = page[2]; path = parsed.searchParams.get('path'); line = parsed.searchParams.get('line');
        if (path && ['file', 'dir'].includes(kind)) {
          const resolved = await cmd('resolvePath', { sessionId, path, base:parsed.searchParams.get('base') || undefined });
          path = resolved.path; kind = resolved.kind === 'directory' ? 'dir' : 'file';
        }
      }
      else if (viz) { kind = 'viz'; vizHash = viz[1]; entry = decodeURIComponent(viz[2]); title = parsed.searchParams.get('title'); }
      else if (isolatedHost && /^\/f\//.test(parsed.pathname)) {
        kind = 'html'; url = parsed.href; title = parsed.searchParams.get('title');
        // 鍵を開いて中身のファイルを引く（アドレスバーのパンくず・ツリー・変化の見張り。pageResolve はサーバーが登り直す）
        const resolved = await cmd('pageResolve', { sessionId, url:parsed.href }).catch(() => null);
        if (resolved?.kind === 'html') path = resolved.path;
      }
      else if (/^(?:[a-z]:[\\/]|[./~])/i.test(input)) { const resolved = await cmd('resolvePath', { sessionId, path:input }); kind = resolved.kind === 'directory' ? 'dir' : 'file'; path = resolved.path; }
      else return null;
    }
    const existing = path && pages.list(sessionId).find(tab => tab !== replace && samePath(tab.page?.path, path));
    if (existing) { if (sessionId === session()) await pick(existing); return existing; }
    if (replace && !discard(replace)) return replace;
    const tab = await pages.open({ sessionId, kind:kind ?? 'new', path, vizHash, entry, title, line, url }, replace);
    tab.mode = 'page'; if (sessionId === session()) await pick(tab); return tab;
  }
  async function navigate(action, args = {}) {
    const sessionId = session(); if (!sessionId) return;
    const tab = tabs().find(item => item.targetId === args.targetId) ?? current();
    if (action === 'tree') { explorer?.toggle(); return {}; }
    if (action === 'new' || action === 'home') {
      const opened = await openInput(args.input, sessionId); if (opened) { chrome()?.open?.(); return opened; }
    }
    if (tab?.local) {
      if (action === 'close') {
        if (!discard(tab)) return {};
        if (tab.chromeId) await cmd('chromeNavigate', { sessionId, targetId:tab.chromeId, action:'close' });
        frames.get(tab.targetId)?.frame.remove(); frames.delete(tab.targetId); pages.close(tab);
        if (active?.targetId === tab.targetId) { active = null; if (tabs().length) await pick(tabs()[0]); else await openInput(null, sessionId); }
        return {};
      }
      if (action === 'navigate') {
        const opened = await openInput(args.input, sessionId, tab); if (opened) return opened;
        if (!discard(tab)) return tab;
        const result = await cmd('chromeNavigate', { sessionId, targetId:tab.chromeId, action:tab.chromeId ? 'navigate' : 'new', input:args.input });
        // 移動は既存タブに届いていれば targetId の返らない古い応答でも同じタブ（P1）。新規は返る ID が要る
        const targetId = result?.targetId ?? tab.chromeId;
        if (!targetId) throw new Error('NO_WINDOW');
        const remote = (rows.get(sessionId) ?? []).find(item => item.targetId === targetId) ?? { sessionId, targetId, url:args.input, title:args.input };
        rows.set(sessionId, [...(rows.get(sessionId) ?? []).filter(item => item.targetId !== remote.targetId), remote]);
        frames.get(tab.targetId)?.frame.remove(); frames.delete(tab.targetId); pages.close(tab);
        await pick(remote); return remote;
      }
      if (action === 'view' && tab.page?.kind === 'html') {
        // 隔離の HTML のプレビュー/原文は ?view= の張り直し（映像の中のタブは同じ URL へ移す）
        pages.view(tab, args.view);
        if (tab.mode === 'chrome' && tab.chromeId) await cmd('chromeNavigate', { sessionId, targetId:tab.chromeId, action:'navigate', input:tab.url });
        return {};
      }
      if (tab.mode !== 'chrome') {
        if (action === 'reload') { if (discard(tab)) pages.reload(tab); return {}; }
        if (action === 'view') { const here = frames.get(tab.targetId); if (here) pageCommand(here, { type:'view', view:args.view }); return {}; }
        if (action === 'back' || action === 'forward') {
          // 隔離の origin のページは、親が持つ文書の中の履歴（histTrail）を動かす。枠の中の history は
          // 鍵の替わり・読み直し・つなぎ直しで失われるので頼らない（指摘 1）。
          // 枠の中の履歴は使わず、橋のない文書も含めて親が持つ履歴 URL を読み直す。
          const here = frames.get(tab.targetId);
          if (here && ['html', 'viz'].includes(tab.page?.kind)) {
            const dir = action === 'back' ? -1 : 1;
            const target = pages.histPeek(tab, dir);
            if (target) {

              // Navigation uses the parent-owned URL so missing bridges and source documents work too.
              here.url = target; here.pendingNav = null; here.frame.src = target;
              pages.histGo(tab, dir);
              return {};
            }
          }
          if (discard(tab)) await pages.travel(tab, action === 'back' ? -1 : 1); return {};
        }
      }
    }
    // 端末内タブでない HTML の Chrome タブ（リモート・エージェントの窓）も ?view= で原文を出せる
    if (action === 'view' && !tab?.local && tab?.page?.kind === 'html' && tab.url) {
      const at = new URL(tab.url);
      if (args.view === 'source') at.searchParams.set('view', 'source'); else at.searchParams.delete('view');
      const moved = await cmd('chromeNavigate', { sessionId, targetId:tab.targetId, action:'navigate', input:at.href });
      if (moved?.targetId) await pick(tabs().find(item => item.targetId === moved.targetId) ?? { targetId:moved.targetId });
      return moved;
    }
    const result = await cmd('chromeNavigate', { sessionId, targetId:tab?.chromeId ?? (tab?.local ? undefined : tab?.targetId), action, ...args,
      ...(tab?.local && args.targetId ? { targetId:tab.chromeId } : {}) });
    if (result?.targetId) await pick(tabs().find(item => item.targetId === result.targetId) ?? { targetId:result.targetId });
    return result;
  }
  async function pick(tab) {
    const selection = active = { sessionId:session(), targetId:tab.targetId };
    overview.hidden = true;
    if (tab.local && tab.mode !== 'chrome') { chrome()?.cancelTabPin?.(); paint(); return; }
    try {
      const pin = { windowId:tab.windowId ?? null, tabId:tab.chromeId ?? tab.targetId };
      const pending = chrome()?.pinTab ? chrome().pinTab(selection.sessionId, pin) : cmd('chromePinWindow', { sessionId:selection.sessionId, ...pin });
      paint(); await pending;
    } catch (error) { notify(error?.message || t('browser.chromeWindow.pinFailed')); }
  }
  async function display(mode) {
    let tab = current(); if (!tab) return;
    if (mode === 'page') {
      if (!tab.local) {
        if (!tab.page || tab.page.kind === 'web') return;   // 外の URL のタブは「ページ」へ戻せる対象を持たない
        const original = tab, request = { sessionId:session(), ...tab.page, title:tab.page.title ?? tab.title };
        // 隔離の origin のタブは URL の形から開き直す。可視化は束の入口（sub.html など）を、HTML のファイルは鍵の URL を引き継ぐ
        if (tab.page.kind === 'viz') {
          const seg = /^\/viz\/[0-9a-f]{64}\/(.+)$/.exec(new URL(tab.url).pathname);
          if (seg) request.entry = decodeURIComponent(seg[1]);
        }
        if (tab.page.kind === 'html') request.url = tab.url;
        tab = await pages.open(request); tab.chromeId = original.targetId; tab.chromeUrl = tab.url;
      }
      tab.mode = 'page'; await pick(tab); return;
    }
    if (!tab.local) return;
    // 隔離の origin のページ（可視化・HTML のファイル）は鍵・束の印の URL のまま映像へ開く（P9）
    const isolated = ['viz', 'html'].includes(tab.page?.kind) || /\.html?$/i.test(tab.page?.path ?? '');
    let input = isolated ? tab.url : tab.page?.path;
    if (!input && tab.page?.kind !== 'new') {
      if (!pagePort) throw new Error('NO_WINDOW');
      const url = new URL(tab.url); url.hostname = 'localhost'; url.port = String(pagePort); input = url.href;
    }
    if (!tab.chromeId) {
      const result = await cmd('chromeNavigate', { sessionId:session(), action:'new', input });
      if (!result?.targetId) throw new Error('NO_WINDOW');
      tab.chromeId = result.targetId;
    }
    if (tab.chromeUrl && tab.chromeUrl !== tab.url) await cmd('chromeNavigate', { sessionId:session(), targetId:tab.chromeId, action:'navigate', input });
    tab.chromeUrl = tab.url; tab.mode = 'chrome'; await pick(tab);
  }
  /** 映像の操作状態。agentUsed: この会話のエージェントがブラウザーを使っている（使っていなければ入口を出さない）。anyHuman: 会話に人が触っているタブがある（見ているタブとは無関係） */
  function control() {
    const sessionId = session(), tab = current(), agentTab = chrome()?.screencastState?.agentTabId ?? null;
    const store = deps.controlStore?.get?.(sessionId)?.state ?? 'idle';
    const anyHuman = holderStore.anyHuman(sessionId);
    const held = tab ? holderOf(sessionId, tab.chromeId ?? tab.targetId) : { holder:'ai' };
    return { sessionId, tab, held, agentTab, store, anyHuman, agentUsed:store !== 'idle' || agentTab != null };
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
    });
  const address = createAddressBar({ navigate, cwd:() => state.cwd ?? '', suggest:input => cmd('chromeAddress', { sessionId:session(), input }), onClose:() => chrome()?.close(), onTabs:() => showOverview(),
    onDisplay:(anchor, tab) => { const rect = anchor.getBoundingClientRect(); showMenu(rect.left, rect.bottom, [
      { label:t('tabs:display.page'), checked:tab?.local && tab.mode !== 'chrome', disabled:!tab?.page || tab.page.kind === 'web', onClick:() => display('page').catch(failed) },
      { label:t('tabs:display.chrome'), checked:!tab?.local || tab.mode === 'chrome', onClick:() => display('chrome').catch(failed) },
    ]); },
    onMenu:(anchor, shown) => addressMenu(anchor, { ...shown, go:action => navigate(action).catch(failed), setView:view => address.setView(view),
      extra:[...tabMenu(shown.tab), ...(chrome()?.browserMenuItems?.(anchor) ?? [])], close:() => chrome()?.close() }) });
  /**
   * アドレスバーの ⋮。ページと Chrome の映像で同じ並びにする:
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
  // ---- 上の列（会話の題・ウィンドウの番号・「エージェントを追う」。inapp-browser.md「見るウィンドウを選ぶ」） ----
  /** 切り替えられない間: PC で引き継いでいる・ほかの端末が操作している。会話の題のチップはいつも押せる */
  const switchDisabled = id => {
    const row = deps.controlStore?.get?.(id) ?? {};
    return row.state === 'paused' && !(row.by === 'device' && deps.deviceOperating?.(id) === true);
  };
  const pinnedWindowOf = id => { const pin = windowsTbl?.pinned?.(id); return pin != null && (windowsTbl?.ids?.(id) ?? []).includes(pin) ? pin : null; };
  const pinnedAny = id => pinnedWindowOf(id) != null || (id === session() && (chrome()?.screencastState?.pinnedWindowId != null || chrome()?.screencastState?.pinnedTabId != null));
  /** 映像に映っているウィンドウ。閉じたウィンドウを薄くして残している間は、それ */
  const shownWindow = id => {
    if (id === session()) {
      const hold = chrome()?.hold;
      if (hold?.windowId != null) return hold.windowId;
      const live = chrome()?.screencastState;
      const row = (live?.list ?? []).find(item => item.tabId === live?.tabId);
      if (Number.isSafeInteger(row?.windowId)) return row.windowId;
    }
    return pinnedWindowOf(id) ?? windowsTbl?.current?.(id) ?? (windowsTbl?.ids?.(id) ?? [])[0] ?? null;
  };
  /** 上の列に出す会話: この会話と、窓のある直接の子の会話（映している子は窓が無くても）。2 つ以上のときだけ */
  function convList() {
    const owner = state.current, shown = session();
    if (!owner) return [];
    const list = [{ sessionId: owner, label: t('browser.chromeWindow.thisConversation'), waits: false }];
    for (const row of deps.conversations?.() ?? []) {
      if (!row?.taskId || !row.sessionId || row.sessionId === owner) continue;
      if (!(row.windows > 0) && row.sessionId !== shown) continue;
      list.push({ sessionId: row.sessionId, label: row.title || t('browser.chromeWindow.childUntitled'), waits: row.waiting === true });
    }
    if (shown && !list.some(conv => conv.sessionId === shown)) list.push({ sessionId: shown, label: t('browser.chromeWindow.childUntitled'), waits: false });
    if (list.length < 2) return [];
    return list.map(conv => ({ sessionId: conv.sessionId, label: conv.label, agent: deps.agentName?.(conv.sessionId), current: conv.sessionId === shown,
      mark: conv.waits || deps.waiting?.(conv.sessionId) === true ? 'wait' : windowsTbl?.operating?.(conv.sessionId) || deps.controlStore?.get?.(conv.sessionId)?.state === 'running' ? 'run' : null }));
  }
  /** 番号のチップ: その会話を映してからそのウィンドウを固定する（固定は会話に 1 つ。映し始めの固定はパネルの pinTab が受け持つ） */
  function onPick(windowId, ownerId) {
    const id = ownerId ?? session();
    if (!id || !Number.isSafeInteger(windowId) || switchDisabled(id) || !(windowsTbl?.ids?.(id) ?? []).includes(windowId)) return;
    active = null;
    if (id !== session()) chrome()?.open?.(null, { target: id });
    const pin = { windowId, tabId: null };
    (chrome()?.pinTab ? chrome().pinTab(id, pin) : cmd('chromePinWindow', { sessionId: id, ...pin })).catch(error => notify(error?.message || t('browser.chromeWindow.pinFailed')));
  }
  /** 会話の題のチップ: 会話は移らず、映像だけその会話の Chrome へ替える */
  function onPickConv(id) { if (id && id !== session()) { active = null; chrome()?.open?.(null, { target: id }); } }
  /** 「エージェントを追う」。追っている間に押すと、今映っているウィンドウを固定する */
  function onFollow() {
    const id = session();
    if (!id || switchDisabled(id)) return;
    if (pinnedAny(id)) {
      const pin = { windowId: null, tabId: null };
      (chrome()?.pinTab ? chrome().pinTab(id, pin) : cmd('chromePinWindow', { sessionId: id, ...pin })).catch(error => notify(error?.message || t('browser.chromeWindow.pinFailed')));
      switcher.flashFollow();
    } else {
      const shown = shownWindow(id);
      if (shown == null) return;
      const pin = { windowId: shown, tabId: null };
      (chrome()?.pinTab ? chrome().pinTab(id, pin) : cmd('chromePinWindow', { sessionId: id, ...pin })).catch(error => notify(error?.message || t('browser.chromeWindow.pinFailed')));
    }
  }
  const switcher = createWindowSwitch({ t, getName: () => deps.agentName?.(session()) ?? 'Claude', onPick, onPickConv, onFollow });
  let lastAgentWin;
  /** 上の列を描く（チップの並び・印・追う・固定の印） */
  function paintSwitch() {
    if (!enabled) return;
    const shown = session();
    const convs = convList();
    const rows = shown ? windowsTbl?.list?.(shown) ?? [] : [];
    const known = rows.length > 0 && rows.every(row => row.windowId !== null);
    const shownWin = shown ? shownWindow(shown) : null, agentWin = shown ? windowsTbl?.current?.(shown) ?? null : null;
    const items = known && (rows.length >= 2 || !convs.length) ? rows.map(row => ({ windowId: row.windowId, number: row.number, selected: row.windowId === shownWin, agent: row.windowId === agentWin, ghost: false, sessionId: shown })) : [];
    const hold = shown === chrome()?.sessionId ? chrome()?.hold : null;
    if (items.length && hold) items.splice(Math.min(hold.index, items.length), 0, { windowId: hold.windowId, number: hold.number, selected: true, agent: false, ghost: true, sessionId: shown });
    // ほかの会話のウィンドウ（2 つ以上ある分）も、その会話の題の後ろに番号で出す
    for (const conv of convs) {
      if (conv.sessionId === shown) continue;
      const others = windowsTbl?.list?.(conv.sessionId) ?? [];
      if (others.length < 2 || !others.every(row => row.windowId !== null)) continue;
      const otherAgent = windowsTbl?.current?.(conv.sessionId), otherRunning = windowsTbl?.operating?.(conv.sessionId) === true;
      for (const row of others) items.push({ windowId: row.windowId, number: row.number, selected: false, agent: row.windowId === otherAgent, running: otherRunning, ghost: false, sessionId: conv.sessionId });
    }
    // 会話の題が選ばれているのは、映している会話に番号のチップが無いとき（あれば番号のチップに敷きがある）
    const targetHasNumbers = items.some(item => item.sessionId === shown);
    for (const conv of convs) conv.selected = conv.current && !targetHasNumbers;
    // エージェントが別のウィンドウへ移ったら、そのチップの印が移って 1 回光る
    const flashId = lastAgentWin !== undefined && agentWin !== lastAgentWin && agentWin != null ? agentWin : null;
    lastAgentWin = agentWin;
    const pinned = shown ? pinnedAny(shown) === true : false;
    const live = chrome()?.screencastState;
    const away = pinned && (pinnedWindowOf(shown) !== agentWin || (live?.pinnedTabId != null && live?.tabId !== live?.agentTabId));
    const running = shown ? windowsTbl?.operating?.(shown) === true : false;
    const disabled = shown ? switchDisabled(shown) : false;
    const firstOpen = convs.length >= 2 || items.length >= 2;
    switcher.paint({ items, convs, agentRunning: running, pinned, away, disabled, flashId, followHere: firstOpen || tabs().length < 2 });
    // 「追う」は見えている最初の列の右端（上の列が閉じていてタブの列だけならタブの列）
    if (!firstOpen && tabs().length >= 2 && switcher.follow.parentNode !== strip.root) strip.root.append(switcher.follow);
  }
  const root = document.createElement('div'); root.className = 'bu-chrome'; root.append(switcher.root, strip.root, address.root);
  const overview = document.createElement('div'); overview.className = 'bu-overview'; overview.hidden = true; root.append(overview);
  let badge = null;
  async function showOverview() {
    overview.hidden = !overview.hidden; paintControl(); if (overview.hidden) return;
    overview.replaceChildren(...tabs().map(tab => {
      const card = document.createElement('div'); card.className = 'bu-card' + (tab.targetId === current()?.targetId ? ' on' : '');
      const pickButton = document.createElement('button'); pickButton.type = 'button'; pickButton.className = 'bu-card-pick';
      const img = document.createElement('img'); img.alt = ''; img.className = 'bu-card-preview';
      const title = document.createElement('span'); title.className = 'bu-card-title'; title.textContent = tabLabel(tab);
      const label = document.createElement('div'); label.className = 'bu-card-label'; label.append(tabIcon(tab), title);
      if (!tab.local) pickButton.append(img); pickButton.append(label); pickButton.onclick = () => pick(tab); card.append(pickButton);
      const close = browserButton('close', t('tabs:strip.close', { title:title.textContent }), () => navigate('close', { targetId:tab.targetId }).then(() => { overview.hidden = true; showOverview(); }).catch(failed)); close.classList.add('bu-card-close'); card.append(close);
      !tab.local && cmd('chromeAddress', { sessionId:session(), input:'', targetId:tab.targetId, thumbnail:true }).then(result => { if (img.isConnected && result?.data) img.src = `data:image/jpeg;base64,${result.data}`; }).catch(() => {});
      return card;
    }));
    const add = browserButton('plus', t('tabs:strip.new'), () => { overview.hidden = true; navigate('new').catch(failed); }); add.classList.add('bu-overview-new'); overview.append(add);
  }
  /** 映像の再開操作（アドレスバーのすぐ下の 1 行）を今の状態にする */
  function paintControl() {
    if (!enabled) return;
    const c = control();
    // 人が触っているタブは会話ごとに数える（anyHuman）。PC は別のタブを見ていても「AI に戻す」は消えない（ADR 0296）。
    // スマホは「II あなたが操作中 [AI に戻す]」を人のタブを開いている間だけ出す（一覧を開いている間も出さない。承認済み 2026-11-08）
    const shown = phoneQuery.matches ? (c.held.holder === 'human' && overview.hidden) : (c.anyHuman && c.store !== 'paused');
    badge?.update({ visible:shown });
  }
  function paint() {
    const tab = current(), shown = session(), live = chrome()?.screencastState;
    const running = shown ? windowsTbl?.operating?.(shown) === true : false;
    // タブのチップのエージェントの印（弧/点。エージェントの今のタブは映像の状態が持つ）
    const items = tabs().map(row => row.local || live?.agentTabId == null ? row : { ...row, agent: row.targetId === live.agentTabId, agentRunning: running, agentName: deps.agentName?.(shown) });
    strip.update(items, tab?.targetId); address.show(tab, items.length); paintControl(); paintLocal(); paintSwitch(); deps.onTabsChange?.();
  }
  const pageHost = document.createElement('div'); pageHost.className = 'bu-page-host';
  const frames = new Map(); let local = null, explorer = null;
  const update = document.createElement('button'); update.type = 'button'; update.className = 'bu-page-update'; update.hidden = true;
  update.textContent = t('tabs:display.update');
  // 「更新を表示」: 画面の中のページを読み直す。映像の中に居る HTML のタブは、そちらの Chrome のタブも読み直す（P10）
  update.onclick = () => { const tab = current(); if (!discard(tab)) return;
    if (tab?.mode === 'chrome' && tab.chromeId) cmd('chromeNavigate', { sessionId:tab.sessionId, targetId:tab.chromeId, action:'reload' }).catch(failed);
    pages.reload(tab); };
  const updateBar = document.createElement('div'); updateBar.className = 'bu-page-update-bar'; updateBar.hidden = true;
  const updateNotice = document.createElement('span'); updateNotice.setAttribute('role', 'status');
  updateBar.append(updateNotice, update); root.append(updateBar);
  function paintLocal() {
    const tab = current(), sessionId = session();
    if (!enabled) return;
    if (!explorer && chrome()?.workspace) explorer = createBrowserTree({ host:chrome().workspace,
      open:(path, fresh) => navigate(fresh ? 'new' : 'navigate', { input:path }).catch(failed),
      menu:(item, x, y) => { const target = { page:{ path:item.id, kind:item.kind === 'directory' ? 'dir' : 'file' } };
        showMenu(x, y, [{ label:t('tabs:tree.new'), onClick:() => navigate('new', { input:item.id }).catch(failed) }, ...tabMenu(target)]); }, notify });
    explorer?.show(tab, sessionId);
    // 映像の中のファイル・フォルダーのページは、映像の中のバーが受け持つ（HTML は中にバーを出せないので、ここに出す。P10）
    update.hidden = updateBar.hidden = !tab?.local || !tab.pending || (tab.mode === 'chrome' && tab.page?.kind !== 'html');
    updateNotice.textContent = update.hidden ? '' : t('tabs:display.updated');
    for (const [id, entry] of frames) entry.frame.hidden = id !== tab?.targetId || tab?.mode === 'chrome';
    if (!tab?.local) { local = null; chrome()?.mountPage?.(null); return; }
    let entry = frames.get(tab.targetId);
    if (!entry) {
      const frame = document.createElement('iframe'); frame.className = 'bu-local-page'; frame.title = tabLabel(tab);
      frame.setAttribute('referrerpolicy', 'no-referrer'); frame.src = tab.url;
      entry = { frame, sessionId, targetId:tab.targetId, url:tab.url, reload:tab.reload, tab };
      frames.set(tab.targetId, entry); pageHost.append(frame);
      frame.addEventListener('load', () => { followLocal(entry); });
    } else if ((!tab.pending && entry.url !== tab.url) || entry.reload !== tab.reload) {
      const same = entry.url === tab.url;
      entry.url = tab.url; entry.reload = tab.reload;
      // 同じ文書のままの読み直しは中の文書に頼む（src の張り直しは # だけの違いを読み直さない・場所を保てない。指摘 2）。
      // 橋の無い出し方（?view=source の text/plain）は枠を直接読み直す
      const bridged = (() => { try { return new URL(entry.url).searchParams.get('view') !== 'source'; } catch { return false; } })();
      if (same && bridged && ['html', 'viz'].includes(tab.page?.kind)) pageCommand(entry, { type:'reload' });
      else entry.frame.src = tab.url;
    }
    entry.frame.title = tabLabel(tab);
    entry.frame.hidden = tab.mode === 'chrome';
    if (tab.mode === 'chrome') { local = null; chrome()?.mountPage?.(null); }
    else { local = entry; chrome()?.mountPage?.(pageHost); }
  }
  let pageEnv = null;
  function followLocal(entry) {
    const tab = entry.tab;
    if (pageEnv) entry.frame.contentWindow?.postMessage({ type:'pleiad:env', env:pageEnv }, new URL(entry.url).origin);
    entry.frame.contentWindow?.postMessage({ type:'pleiad:page-activity-init' }, new URL(entry.url).origin);
    try {
      const win = entry.frame.contentWindow, at = new URL(win.location.href);
      if (at.origin !== location.origin) return;
      const match = /^\/_pleiad\/s\/([^/]+)\/(file|dir|git|plugins|new|attachment)$/.exec(at.pathname);
      if (!match || decodeURIComponent(match[1]) !== entry.sessionId) return;
      if (entry.url !== at.href) {
        entry.url = tab.url = at.href; tab.page = { kind:match[2], path:at.searchParams.get('path') }; tab.touched = tab.dirty = false;
        paint();
      }
      const touch = event => { pages.activity(tab, ['input', 'change'].includes(event.type)); explorer?.dismiss(); };
      for (const type of ['pointerdown', 'scroll', 'selectionchange', 'input', 'change']) win.document.addEventListener(type, touch, { capture:true, passive:true });
    } catch { /* Isolated pages report activity through their own bridge. */ }
  }
  /** ページの URL（/_pleiad/…）を画面と同じ出どころへ写す。映像の中の移動を、リンクした端末内タブへ戻すときに使う */
  function mirrorUrl(raw) {
    try {
      const at = new URL(raw);
      if (!/^\/_pleiad\/s\//.test(at.pathname)) return null;
      return new URL(at.pathname + at.search, location.origin).href;
    } catch { return null; }
  }
  /** 映像の中の移動（tab:info）で、リンクした端末内タブの題・戻る/進む・対象を追い直す（P4）。HTML は鍵からサーバーが元のファイルを引く */
  function syncLinkedPage(tab, event) {
    if (event.url) tab.chromeUrl = event.url;
    if (typeof event.title === 'string' && event.title) tab.title = event.title;
    if (typeof event.loading === 'boolean') tab.loading = event.loading;
    if (typeof event.canGoBack === 'boolean') tab.canGoBack = event.canGoBack;
    if (typeof event.canGoForward === 'boolean') tab.canGoForward = event.canGoForward;
    if (!('page' in event)) return;
    const page = event.page;
    if (page?.kind === 'html' && event.url) {
      void cmd('pageResolve', { sessionId:tab.sessionId, url:event.url, tab:tab.targetId }).then(resolved => {
        if (resolved?.kind !== 'html' || tab.chromeId !== event.targetId) return;
        tab.page = { ...tab.page, kind:'html', path:resolved.path, ...(page.title ? { title:page.title } : {}) };
        tab.url = event.url;
        if (tab.history?.length) tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url, path:resolved.path };
        paint();
      }).catch(() => {});
      return;
    }
    if (page?.kind === 'viz') tab.page = { ...tab.page, kind:'viz', vizHash:page.hash };
    else if (page) tab.page = { ...tab.page, ...page };
    else tab.page = { kind:'web' };   // 外の URL のタブ（page は空でなく 'web'。あちこちで tab.page.path などを読むので null にしない。指摘 5）
    const local = event.url && mirrorUrl(event.url);
    if (local && tab.mode === 'chrome' && local !== tab.url) {
      tab.url = local;
      if (tab.history?.length) tab.history[tab.position] = { ...tab.history[tab.position], url:tab.url };
    }
  }
  function pageCommand(entry, command) { entry.frame.contentWindow?.postMessage({ type:'pleiad:page-command', command }, new URL(entry.url).origin); }
  async function localRequest(event) {
    const entry = [...frames.values()].find(item => event.source === item.frame.contentWindow);
    if (!entry || event.origin !== new URL(entry.url).origin) return;
    if (event.data?.type === 'pleiad:page-activity') { pages.activity(entry.tab, event.data.input === true); explorer?.dismiss(); return; }
    if (event.data?.type === 'ply-preview-location' && typeof event.data.href === 'string') {
      // ページの中の移動の報告（LINK_BRIDGE）。アドレス・履歴・見張りを出している文書に追い直す（P3）
      let at;
      try { at = new URL(event.data.href); } catch { return; }
      if (at.origin !== event.origin) return;
      if (entry.resolvingUrl === at.href || entry.lastResolvedUrl === at.href) return;
      entry.resolvingUrl = at.href;
      entry.url = at.href; entry.pendingNav = null;
      const before = entry.tab.page?.path;
      const resolved = await cmd('pageResolve', { sessionId:entry.sessionId, url:at.href, tab:entry.targetId }).catch(() => null);
      if (entry.resolvingUrl === at.href) entry.resolvingUrl = null;
      if (entry.url !== at.href) return;
      entry.lastResolvedUrl = at.href;
      // 別のファイルへ移った: 前のファイルのこのタブぶんの見張りを外す（ほかの画面・タブが見ている分は残る。指摘 3）
      const nextPath = resolved?.kind === 'html' ? resolved.path : null;
      if (before && (!nextPath || !samePath(before, nextPath))) {
        cmd('pageWatch', { sessionId:entry.sessionId, path:before, kind:'file', tab:entry.targetId }).catch(() => {});
      }
      pages.locate(entry.tab, { url:at.href, title:typeof event.data.title === 'string' ? event.data.title : null, resolved, sameDocument:event.data.replace === true });
      return;
    }
    if (event.data?.type === 'ply-preview-open-link' && typeof event.data.url === 'string') {
      // 隔離のページの中のリンク（LINK_BRIDGE から）。Pleiad のページはタブで開き、外の URL は新しい Chrome のタブ（画面の中）へ
      let link;
      try { link = new URL(event.data.url); } catch { return; }
      if (!/^https?:$/.test(link.protocol) || link.username || link.password) return;
      // 新しい窓・Ctrl/中クリックは新しいタブで開く。同じタブの移動は今のタブを差し替える（P5）
      if (await openInput(link.href, entry.sessionId, (event.data.newWindow === true || event.data.external === true) ? null : entry.tab).catch(() => null)) return;
      const result = await cmd('chromeNavigate', { sessionId:entry.sessionId, action:'new', input:link.href }).catch(() => null);
      if (result?.targetId && entry.sessionId === session()) await pick(tabs().find(item => item.targetId === result.targetId) ?? { targetId:result.targetId });
      return;
    }
    if (event.origin !== location.origin || entry.sessionId !== session()) return;
    if (event.data?.type === 'pleiad:page-open' && event.data.sessionId === entry.sessionId) {
      if (entry !== local) return;
      const url = new URL(event.data.url, location.origin);
      if (url.origin !== location.origin) return;
      await openInput(url.href, entry.sessionId, event.data.newTab ? null : entry.tab); return;
    }
    if (!deps.onPageRequest) return;
    const request = pageRequestOf(event.data, entry.sessionId); if (!request) return;
    const reply = (ok, value) => { if (frames.has(entry.targetId) && request.requestId) entry.frame.contentWindow?.postMessage({ type:'pleiad:page-result', requestId:request.requestId, ok,
      ...(ok ? { result:value ?? null } : { error:String(value?.message ?? value ?? 'unavailable').slice(0, 200) }) }, location.origin); };
    try { reply(true, await deps.onPageRequest(framePoint(request, entry.frame.getBoundingClientRect()), { sessionId:entry.sessionId, targetId:entry.targetId })); }
    catch (error) { reply(false, error); }
  }
  function attach() {
    chrome()?.mountBrowserChrome?.(root);
    // 「II あなたが操作中 [AI に戻す]」はアドレスバーのすぐ下の 1 行（承認済み 2026-11-08）。
    // 一覧（.bu-overview）の後に置くので、PC の出る場所は今のまま（一覧を開いている間は一覧の下）
    if (badge && badge.element.parentElement !== root) overview.after(badge.element);
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
    tabsOf:allTabs,
    /** 利用者のページタブを開く（ファイルのリンク・可視化） */
    async openTab(input) {
      const { sessionId, url, ...request } = input;
      let tab;
      if (request.kind || request.path || request.vizHash) {
        tab = await pages.open({ sessionId, ...request, kind:request.kind === 'directory' ? 'dir' : request.kind ?? 'file' });
        if (sessionId === session()) await pick(tab);
      } else tab = await openInput(url, sessionId);
      if (!tab) {
        const result = await cmd('chromeNavigate', { sessionId, action:'new', input:url });
        if (sessionId === session() && result?.targetId) await pick(tabs().find(item => item.targetId === result.targetId) ?? { targetId:result.targetId });
        tab = result;
      }
      if (sessionId === session()) chrome()?.open?.(); return tab;
    },
    display,
    /** 開いているタブを選んで右の欄に映す */
    async focusTab(tab, sessionId) {
      if (sessionId !== session()) return;
      await pick(tab); chrome()?.open?.();
    },
    /**
     * 欄の入口（地球ボタン・スマホの [N]。inapp-browser.md「入口を押したとき」）。
     * 操作中・依頼待ち・あなたが操作中なら Chrome のタブ（映像・既定はエージェントを追う。人の持つタブがあればそちら）。
     * それ以外は会話で最後に見た方を開く。タブが無ければ空の新しいタブ。開いている間の状態変化では切り替えない（ここは閉じているときだけ呼ばれる）
     */
    async openEntry(sessionId, anchor = null) {
      const list = allTabs(sessionId), same = sessionId === session();
      const held = list.find(item => holderOf(sessionId, item.chromeId ?? item.targetId).holder === 'human');
      const row = deps.controlStore?.get?.(sessionId) ?? {};
      const open = () => chrome()?.open?.(anchor, same ? {} : { target:sessionId });
      // 人の持つタブ（あなたが操作中）→ そのタブを映す
      if (held) {
        if (same) await pick(held);
        else {
          const pin = { windowId:held.windowId ?? null, tabId:held.chromeId ?? held.targetId };
          try { await (chrome()?.pinTab ? chrome().pinTab(sessionId, pin) : cmd('chromePinWindow', { sessionId, ...pin })); }
          catch (error) { notify(error?.message || t('browser.chromeWindow.pinFailed')); }
        }
        open(); return;
      }
      // エージェントが操作中・依頼待ち・（PC/端末の）引き継ぎ中 → Chrome のタブを開いて追う（固定は解かない。会話の watch が持つ既定）
      if (row.state === 'running' || row.state === 'paused' || deps.waiting?.(sessionId) === true || windowsTbl?.operating?.(sessionId)) {
        if (same) { active = null; chrome()?.cancelTabPin?.(); }
        open(); return;
      }
      // それ以外は最後に見た方
      const tab = same ? current() : list.find(item => item.targetId === chrome()?.tabId) ?? list[0] ?? null;
      if (tab) {
        if (same) await pick(tab);
        else {
          const pin = { windowId:tab.windowId ?? null, tabId:tab.chromeId ?? tab.targetId };
          try { await (chrome()?.pinTab ? chrome().pinTab(sessionId, pin) : cmd('chromePinWindow', { sessionId, ...pin })); }
          catch (error) { notify(error?.message || t('browser.chromeWindow.pinFailed')); }
        }
        open(); return;
      }
      if (same) await openInput(null, sessionId);
      else await cmd('chromeNavigate', { sessionId, action:'new' }).catch(failed);
      open();
    },
    /** 見ている会話が替わった。ビューアを開いたままタブの無い会話へ移ったときも空のタブを作る */
    sessionChanged(id) {
      if (!enabled || typeof id !== 'string' || !id) return;
      if (!allTabs(id).length && !windowsTbl?.has?.(id)) void cmd('watchSession', { sessionId:id }).catch(() => {}).then(() => openInput(null, id).catch(() => {}));
      paint();
    },
    /** 会話の一覧（上の列の題・子の窓）が変わった。描き直す */
    conversationsChanged() { if (enabled) paint(); },
    /** タブの列のタブを一瞬光らせる（もう開いていたファイル） */
    flashTab(tab, sessionId) {
      if (sessionId !== session()) return;
      const item = [...strip.root.querySelectorAll('.bu-tab')].find(node => node.dataset.target === tab?.targetId);
      if (!item) return;
      item.classList.remove('bu-flash'); void item.offsetWidth; item.classList.add('bu-flash');
      item.addEventListener('animationend', () => item.classList.remove('bu-flash'), { once:true });
      setTimeout(() => item.classList.remove('bu-flash'), 1200);
    },
    capsChanged(caps) {
      if (!caps?.browserUnify) return;
      pagePort = caps.browserUnify.pages ?? pagePort;
      if (!enabled) {
        enabled = true; const style = document.createElement('style'); style.dataset.browserUnify = ''; style.textContent = css; document.head.append(style); document.body.classList.add('browser-unify');
        // 札は止める・任せるだけ（映像に触れるだけでは引き継がない。ADR 0296）
        badge = createControlBadge({ onResume:() => cmd('chromeResume', { sessionId:session() }).catch(failed) });
        chrome()?.useInput?.({ phone:() => phoneQuery.matches, showMenu });
        chrome()?.onOpenChange(attach);
        chrome()?.onTargetChange(attach);
        chrome()?.onTabChange?.(event => {
          // つなぎ直し（サーバーの入れ替え）で、ファイル・フォルダー・HTML・可視化のページの見張りと鍵を取り直す（P6）。
          // 先に watchSession を送り直す（こちらの接続が見ている会話と分かってから pageOpen を投げる。貼り直したばかりの線では登録がまだ無い）
          if (event?.type === 'reconnected') void (async () => {
            for (const id of pages.sessionIds()) {
              const list = pages.list(id).filter(tab => tab.local && ['file', 'dir', 'html', 'attachment', 'viz'].includes(tab.page?.kind));
              if (!list.length) continue;
              await cmd('watchSession', { sessionId:id }).catch(() => {});
              for (const tab of list) pages.reissue(tab).catch(failed);
            }
          })();
          if (!current()?.local && (event?.type === 'state' || event?.type === 'reconnected'
            || (event?.type === 'pin-failed' && active?.targetId === event.tabId
              && (!event.sessionId || event.sessionId === active.sessionId)))) active = null;
          paint();
        });
        deps.controlStore?.onChange?.(id => { if (id === session() || convIds().has(id)) paint(); });
        phoneQuery.addEventListener?.('change', () => { paintControl(); paintLocal(); });
        window.addEventListener('message', event => { localRequest(event).catch(failed); });
        document.dispatchEvent(new CustomEvent('ply-browser-availability'));
      }
      attach(); if (state.current) cmd('watchSession', { sessionId:state.current }).catch(failed);
    },
    /** 配色が変わった（端末内のページにも渡す） */
    envChanged(env) { pageEnv = env; for (const entry of frames.values()) entry.frame.contentWindow?.postMessage({ type:'pleiad:env', env }, new URL(entry.url).origin); },
    onEvent(event) {
      document.dispatchEvent(new CustomEvent('ply-tab-event', { detail:event }));
      if (['page:moved', 'page:changed'].includes(event.type)) {
        // 端末内のページ: ページの port が替わったことを openInput が知るように持ち、隔離の origin の URL はページの一覧が張り直す。
        // Chrome のタブは本体（relay.migratePageTabs）が付け替え、tab:info が届いて列が直る
        if (event.type === 'page:moved') pagePort = event.ports?.pages ?? pagePort;
        pages.event(event); return;
      }
      if (event.type === 'tab:info') {
        holderStore.event(event);   // 棚と持ち手を揃える（消えたタブ・張り替えでは持ち手も捨てる）
        let list = rows.get(event.sessionId) ?? [];
        if (event.reset) list = event.tabs ?? [];
        else if (event.removed) { for (const tab of pages.list(event.sessionId)) if (tab.chromeId === event.targetId) { delete tab.chromeId; tab.mode = 'page'; } list = list.filter(tab => tab.targetId !== event.targetId); }
        else { const at = list.findIndex(tab => tab.targetId === event.targetId); list = [...list]; if (at < 0) list.push(event); else list[at] = event; }
        rows.set(event.sessionId, list);
        // 映像の中の移動を、リンクした端末内タブへ追い直す（P4）
        for (const info of event.reset ? (event.tabs ?? []) : [event]) {
          if (info.removed) continue;
          for (const tab of pages.list(event.sessionId)) if (tab.chromeId === info.targetId) syncLinkedPage(tab, info);
        }
        if (event.sessionId === session() || convIds().has(event.sessionId)) paint();
      } else if (event.type === 'tab:holder') {
        holderStore.event(event);
        if (event.sessionId === session() || convIds().has(event.sessionId)) paint();
      } else if (event.type === 'tab:page-request') pageRequest(event);
    },
  };
}
