import { t, has } from './i18n.mjs';
import { createTabStrip, browserButton, browserIcon, tabIcon } from './tab-strip.mjs';
import { createCombo } from './combo.mjs';
import { runMark } from './arc.mjs';
import { createAddressBar, hasFileViews } from './address-bar.mjs';
import { createControlBadge, createTabHolderStore } from './chrome-control.mjs';
import { pageRequestOf, framePoint } from './page-frame.mjs';
import { samePath } from './file-actions.mjs';
import { createPageTabs } from './page-tabs.mjs';
import { createBrowserTree } from './browser-tree.mjs';
import { openExternalLink } from './link-open.mjs';
import { browserShortcutLabel } from './header-entries.mjs';

/** メニューの行のアイコン（タブの列・アドレスバーと同じ線の絵） */
const menuIcon = kind => { const svg = browserIcon(kind); svg.classList.add('i'); return svg; };

// Right-pane browser styles; injected once when the host reports browserUnify (always, since ADR 0294 stage C1).
const css = `
.bu-display{flex:none;font-size:12px!important;padding:6px 8px!important;border-radius:var(--r-pill);min-height:34px}
.bu-display:hover{background:var(--surface-3)}
.bu-page-update-bar{margin-left:var(--bu-tree-width);display:flex;align-items:center;gap:12px;padding:4px 12px;font-size:12px}.bu-page-update-bar[hidden]{display:none}.bu-page-update{display:block;margin:0 0 0 auto;padding:6px 12px!important;color:var(--ink-blue)!important}
.bu-page-host[hidden],.bu-local-page[hidden],.bu-explorer[hidden],.bu-explorer-list[hidden],.bu-explorer-failed[hidden]{display:none!important}
.bu-local-page{width:100%;height:100%;border:0;display:block;background:var(--surface-paper)}
.bu-panel{position:relative;--bu-tree-width:0px}
.browser-unify .bu-panel>.cp-screen{margin-left:var(--bu-tree-width);width:calc(100% - var(--bu-tree-width))}
.bu-explorer{position:absolute;top:0;bottom:0;left:0;z-index:6;display:flex;flex-direction:column;background:var(--surface-paper);color:var(--ink);font-size:13px}
.bu-explorer-head{display:flex;align-items:center;justify-content:space-between;min-height:38px;padding:0 12px}.bu-explorer-head>span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bu-explorer-list{flex:1;min-height:0;overflow:auto;padding:0 6px}.file-preview-content[hidden]{display:none!important}.bu-explorer-list .tree-row{min-height:30px;padding-top:0;padding-bottom:0}.bu-explorer-list .tree-row.sel{background:var(--surface-2);box-shadow:none}.bu-explorer{border-right:1px solid var(--line)}.bu-explorer-head button{border:0;background:none;color:inherit;cursor:pointer;width:28px;height:28px;padding:5px}.bu-explorer-head svg{width:16px;height:16px}.bu-tree-more{border:0;background:none;color:inherit;padding:5px;cursor:pointer}
.bu-explorer-list .tree-row>svg{width:16px;height:16px;flex:none}.bu-tree-more{width:28px;height:28px;margin-left:auto;opacity:0}.tree-row:hover .bu-tree-more,.tree-row.sel .bu-tree-more{opacity:1}
.bu-explorer-failed{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:6px 12px}.bu-explorer-failed>p{margin:0;color:var(--ink-strong);font-weight:600;overflow-wrap:anywhere}.bu-explorer-head button:disabled{opacity:.35;cursor:default}
.bu-tree-resize{position:absolute;right:-3px;top:0;bottom:0;width:6px;cursor:col-resize;touch-action:none}.bu-tree-resize:focus-visible{outline:2px solid var(--line-blue)}
.bu-tree-overlay{box-shadow:6px 0 18px var(--shadow)}
@media(max-width:600px){.bu-display{font-size:11px!important;min-height:44px;padding:4px!important}.bu-tree-more{opacity:1;min-width:44px;min-height:44px}.bu-explorer-list .tree-row{min-height:44px}.bu-explorer-failed .btn{min-height:44px;padding:0 16px}}

.bu-chrome{--bu-frame:var(--surface-3);--bu-bar:var(--surface-1);--bu-omni:var(--surface-2);color:var(--ink);flex:none;min-width:0;position:relative}
[data-theme=dark] .bu-chrome{--bu-frame:var(--surface-0);--bu-bar:var(--surface-3);--bu-omni:var(--surface-paper)}
.bu-chrome button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
.bu-chrome [hidden]{display:none!important}
.bu-chrome button:focus-visible,.bu-crumbs:focus-visible{outline:2px solid var(--line-blue);outline-offset:-2px}
.bu-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:34px;height:34px;border-radius:50%;padding:0}
.bu-icon:hover:not(:disabled),.bu-crumb:hover,.bu-count:hover{background:var(--surface-3)}
.bu-icon svg{width:18px;height:18px;flex:none}.bu-icon:disabled{opacity:.35;cursor:default}
@property --fade-s{syntax:'<number>';inherits:false;initial-value:1}
@property --fade-e{syntax:'<number>';inherits:false;initial-value:1}
/* Tabs shrink to 96px, then scroll sideways with faded edges (24px). */
.bu-tabs{display:flex;align-items:end;height:42px;padding:4px 0 0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;flex:0 1 auto;min-width:0;--fade-s:1;--fade-e:1;-webkit-mask-image:linear-gradient(to right,rgba(0,0,0,var(--fade-s)) 0,#000 24px,#000 calc(100% - 24px),rgba(0,0,0,var(--fade-e)) 100%);mask-image:linear-gradient(to right,rgba(0,0,0,var(--fade-s)) 0,#000 24px,#000 calc(100% - 24px),rgba(0,0,0,var(--fade-e)) 100%);transition:--fade-s var(--dur-fast) linear,--fade-e var(--dur-fast) linear}
.bu-tabs.fade-s{--fade-s:0}.bu-tabs.fade-e{--fade-e:0}.bu-tabs::-webkit-scrollbar{display:none}
.bu-tab{height:38px;padding:0 6px 4px 12px;display:flex;align-items:center;flex:0 1 240px;width:240px;max-width:240px;min-width:96px;border-radius:10px 10px 0 0;position:relative;overflow:hidden;color:var(--ink-weak);transition:background-color var(--dur-fast) var(--ease-out)}
.bu-tab+.bu-tab:before{content:'';position:absolute;left:0;top:9px;height:20px;width:1px;background:var(--line)}
.bu-tab.on{background:var(--bu-bar);color:var(--ink)}.bu-tab.on:before,.bu-tab.on+.bu-tab:before{display:none}
.bu-tab:not(.on):hover{background:color-mix(in srgb,var(--bu-bar) 55%,transparent)}
.bu-tab-pick:focus-visible{outline:none!important}.bu-tab:has(>.bu-tab-pick:focus-visible){box-shadow:inset 0 0 0 2px var(--line-blue)}
.bu-tab-pick{display:flex;align-items:center;gap:8px;min-width:0;flex:1;height:100%;padding:0;text-align:left}
.bu-tab-title{overflow:hidden;white-space:nowrap;flex:1;font-size:12px;mask-image:linear-gradient(to right,#000 calc(100% - 18px),transparent)}
.bu-favicon{width:16px;height:16px;flex:none}.bu-loading{animation:bu-pulse 1s ease-in-out infinite alternate}@keyframes bu-pulse{to{opacity:.3}}
@media(prefers-reduced-motion:reduce){.bu-loading{animation:none}}
/* Tab close: a 16px glyph in a 22px circle, 6px from the right edge. Hover 14% / press 22% of the text colour. */
.bu-tab-close{width:22px;height:22px;margin-left:2px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;padding:0}
.bu-tab-close svg{width:16px;height:16px}
.bu-tab-close:hover{color:var(--ink-strong);background-image:linear-gradient(color-mix(in srgb,currentColor 14%,transparent),color-mix(in srgb,currentColor 14%,transparent))}
.bu-tab-close:active{color:var(--ink-strong);background-image:linear-gradient(color-mix(in srgb,currentColor 22%,transparent),color-mix(in srgb,currentColor 22%,transparent))}
/* Under 120px per tab, inactive tabs show their close only on hover; the active tab keeps 120px. */
.bu-narrow .bu-tab:not(.on) .bu-tab-close{position:absolute;right:6px;top:6px;margin:0;opacity:0;background-color:color-mix(in srgb,var(--bu-bar) 55%,var(--bu-frame));transition:opacity var(--dur-fast) linear}
.bu-narrow .bu-tab:not(.on):hover .bu-tab-close,.bu-narrow .bu-tab:not(.on):focus-within .bu-tab-close{opacity:1}
.bu-narrow .bu-tab.on{min-width:120px}
.bu-spacer{flex:none;height:1px}
.bu-new{width:36px;height:34px;align-self:center}.bu-tabrow-gap{flex:1 0 8px}.bu-panel-close{margin-right:4px}
.bu-list svg{width:16px;height:16px}.bu-list[aria-expanded=true]{background:var(--surface-3)}
/* All tabs (opened from the chevron). */
.bu-alltabs{position:absolute;z-index:31;width:300px;max-width:calc(100% - 16px);display:flex;flex-direction:column;padding:6px;border-radius:12px;background:var(--surface-paper);box-shadow:0 0 0 1px var(--line),0 8px 24px var(--shadow);transform-origin:top right}
.bu-alltabs-q{flex:none;height:32px;border:0;border-radius:8px;background:var(--surface-1);color:var(--ink);font:inherit;font-size:13px;padding:0 10px;margin-bottom:4px;outline:none}
.bu-alltabs-q:focus-visible{outline:2px solid var(--line-blue);outline-offset:-2px}
.bu-alltabs ul{list-style:none;margin:0;padding:0;overflow:auto;min-height:0}
.bu-alltabs li{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:8px;font-size:12.5px;white-space:nowrap;cursor:pointer}
.bu-alltabs li:hover{background:var(--surface-1)}.bu-alltabs li.act{background:var(--surface-2)}
.bu-alltabs li .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.bu-alltabs li[aria-current=true] .t{font-weight:700;color:var(--ink-blue)}.bu-alltabs li .bu-favicon{color:var(--ink-weak)}
.bu-alltabs li.none{color:var(--ink-weak);cursor:default}.bu-alltabs li.none:hover{background:none}
.bu-toolbar{position:relative;display:flex;align-items:center;gap:2px;height:46px;padding:0 6px;background:var(--bu-bar);min-width:0}
.bu-omni{display:flex;align-items:center;flex:1;min-width:0;gap:8px;height:34px;border-radius:17px;margin:0 4px;padding:0 4px 0 12px;background:var(--bu-omni);cursor:text}
.bu-omni.bu-file{padding-left:4px;gap:4px}.bu-tree{width:28px;height:26px;border-radius:13px}.bu-tree svg{width:17px;height:17px}
.bu-crumbs{flex:1;min-width:0;height:100%;display:flex;align-items:center;overflow:hidden;white-space:nowrap;font-size:13.5px;cursor:text}
.bu-crumb{flex:none;min-width:0;padding:3px 5px;border-radius:6px;line-height:18px}.bu-current{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;font-weight:600;cursor:text!important}
.bu-crumb:first-child{color:var(--ink-weak)}.bu-separator{flex:none;width:14px;margin:0 -1px;color:var(--ink-weak);text-align:center;opacity:.7}.bu-ellipsis{flex:none}
.bu-measure .bu-crumb{flex:none}.bu-views{display:inline-flex;flex:none;padding:2px;border-radius:999px;background:var(--surface-3)}
.bu-views .bu-icon{width:auto;height:24px;padding:0 10px;gap:4px;font-size:12px;border-radius:999px}.bu-views svg{display:none;width:15px;height:15px}
.bu-views .on{background:var(--surface-paper);box-shadow:0 1px 2px var(--shadow)}.bu-views.bu-icons svg{display:block}.bu-views.bu-icons span{display:none}.bu-views.bu-icons .bu-icon{padding:0 7px}
.bu-saved{display:inline-flex;align-items:center;gap:5px;flex:none;height:22px;padding:0 9px;border-radius:11px;background:var(--surface-3);color:var(--ink-weak);font-size:12px}
.bu-saved svg{width:13px;height:13px}.bu-saved-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.bu-external{width:28px;height:26px;border-radius:13px;flex:none;margin-left:2px}.bu-external svg{width:16px;height:16px}
.bu-address-input{width:100%;min-width:0;flex:1;border:0;outline:0;background:none;color:var(--ink);font:inherit;font-size:13px;padding:0 8px;height:100%}
.bu-editing .bu-omni,.bu-omni:has(:focus-visible){box-shadow:none;outline:2px solid var(--line-blue);outline-offset:1px}
.bu-editing .bu-omni{background:var(--surface-paper)}
/* One ring only: no outlines inside the pill. Kept after .bu-chrome button:focus-visible (same specificity (0,2,1)). */
.bu-omni button:focus-visible,.bu-omni input:focus-visible,.bu-crumbs:focus-visible{outline:none}
.bu-suggestions,.bu-address-error{position:absolute;z-index:20;top:43px;left:8px;right:8px;background:var(--surface-paper);border-radius:var(--r-m);box-shadow:0 4px 16px var(--shadow);padding:6px}
.bu-suggestion{display:block;width:100%;text-align:left;padding:8px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:var(--r-s)}.bu-suggestion:hover,.bu-suggestion[aria-selected=true]{background:var(--surface-2)}
.bu-address-error{color:var(--ink-danger);font-size:13px;padding:10px 14px}.bu-conversation{display:none}.bu-toolbar .bu-count{display:none}
.tabn-badge{position:relative;display:grid;place-items:center;width:20px;height:20px;flex:none;padding:0;border:0;background:transparent;font-size:12px;line-height:16px;color:var(--ink-weak)}
.tabn-badge>svg{position:absolute;inset:0;width:20px;height:20px;overflow:visible}.tabn-badge>svg rect{stroke:currentColor}.tabn-value{position:relative;z-index:1}
.bu-tight>.bu-forward:disabled{display:none}
.bu-mobile>.bu-icon:not(.bu-conversation):not(.bu-more){display:none}.bu-mobile .bu-conversation{display:inline-flex}.bu-mobile .bu-count{display:grid;margin:0 12px}.bu-mobile .bu-count.tabn-badge{color:var(--ink-weak);position:relative}.bu-mobile .bu-count.tabn-badge::before{content:'';position:absolute;inset:-12px}.bu-phone-filename{font-weight:600}
.bu-mobile .bu-omni{height:34px;margin:0 2px}.bu-mobile .bu-crumbs{font-size:13px;text-overflow:ellipsis;display:block;line-height:34px}
.bu-overview{display:flex;flex-direction:column;background:var(--surface-0);max-height:70dvh;overflow:visible}
.bu-ov-head{display:flex;align-items:center;gap:2px;flex:none;height:52px;padding:0 4px;background:var(--surface-3)}
.bu-ov-head .bu-icon{width:44px;height:44px}
.bu-ov-head .bu-conv{flex:1;min-width:0;max-width:none;margin:0 4px}
.bu-ov-head .bu-conv input{height:44px;font-size:14px;padding:0 28px 0 12px}
.bu-ov-head .bu-conv::after{top:18px;right:12px}
.bu-ov-head .bu-conv>.run{top:15px}
.bu-ov-head .bu-conv .clist{width:268px;max-width:calc(100vw - 70px)}
.bu-ov-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:16px;overflow-y:auto;flex:1;min-height:0;align-content:start}
.bu-card{position:relative;min-width:0;overflow:hidden;border-radius:var(--r-m);background:var(--surface-paper)}.bu-card.on{outline:2px solid var(--line-blue)}
.bu-card-pick{width:100%;text-align:left;padding:0 10px 10px!important}.bu-card-preview{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;margin-bottom:8px}.bu-card-label{display:flex;gap:6px;align-items:center;padding-right:16px}.bu-card-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.bu-card-close{position:absolute;right:4px;bottom:4px;width:24px;height:24px}
.browser-unify #filePreview[data-panel=chrome-window]{padding:0;gap:0;overflow:hidden}
.browser-unify #filePreview[data-panel=chrome-window]>.file-preview-head,.browser-unify #filePreview[data-panel=chrome-window]>.file-preview-toolbar{display:none}
.browser-unify #filePreview[data-panel=chrome-window] .file-preview-body-layout{padding:0;gap:0}
.browser-unify #filePreview[data-panel=chrome-window] .file-preview-content{padding:0;overflow:hidden;display:flex;flex-direction:column}
.browser-unify .cp.bu-panel{display:flex;flex-direction:column;flex:1;min-height:0;gap:0;padding:0}
.browser-unify .bu-panel>.cp-screen{flex:1;min-height:0;border:0;border-radius:0;margin:0 0 0 var(--bu-tree-width)}
.bu-tab.bu-flash{animation:bu-flash .9s ease-out}@keyframes bu-flash{0%,40%{background:color-mix(in srgb,var(--line-blue) 22%,transparent)}}
@media(prefers-reduced-motion:reduce){.bu-tab.bu-flash{animation:none;outline:2px solid var(--line-blue);outline-offset:-2px}}
.bu-agent{display:grid;place-items:center;flex:none;width:14px;height:14px}
.bu-agent .run svg{width:12.32px;height:12.32px;stroke-width:1.7}
/* Keep the conversation picker, new tab, all tabs and panel close outside the scrolling tabs. */
.bu-tabrow{display:flex;align-items:center;height:42px;min-width:0;gap:4px;padding-left:8px;background:var(--bu-frame)}
.bu-tabrow .bu-conv{flex:none;align-self:flex-start;min-width:0;max-width:220px;margin-top:4px}
.bu-conv input{height:34px;font-size:13px;padding:0 24px 0 12px}
.bu-conv::after{content:'';position:absolute;right:10px;top:12px;width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);color:var(--ink-weak);pointer-events:none}
.bu-conv>.run{position:absolute;left:8px;top:10px;display:grid;place-items:center;pointer-events:none}
.bu-conv>.run svg{width:14px;height:14px}
.bu-conv:has(>.run:not([hidden])) input{padding-left:28px}
.bu-conv .clist{z-index:30}
.bu-tabrow .bu-tabs{align-self:stretch}
/* Show loading until the selected mobile tab supplies its first frame or page. */
.bu-load{position:absolute;left:0;right:20%;bottom:0;height:2px;background:var(--line-blue);animation:bu-load .8s ease-in-out infinite alternate}
@keyframes bu-load{to{right:0}}
@media(min-width:601px){.bu-load{display:none}}
@media(prefers-reduced-motion:reduce){.bu-load{animation:none}}
.cp-screen>.bu-page-host{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;z-index:5;background:var(--surface-paper)}
@media(max-width:760px){.browser-unify #filePreview{padding:0;border-radius:0}.browser-unify #filePreview .file-preview-content{border-radius:0}}
/* Phone: the tab list covers the whole panel, so the chrome row must not be its containing block (it is only 48px tall). */
@media(max-width:600px){.bu-tabrow{display:none}.bu-toolbar{height:48px}.bu-chrome{position:static}.bu-overview{position:absolute;inset:0;max-height:none;z-index:40}}
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
  // タブの列は選んだ会話の窓全部のタブ（承認済み 2026-11-08。窓番号は出さない）。子を選んだら子の分だけ
  const tabs = () => allTabs(session());
  const current = () => tabs().find(tab => active?.sessionId === session() && tab.targetId === active.targetId) ?? tabs().find(tab => tab.targetId === chrome()?.tabId) ?? tabs()[0] ?? null;
  const holderOf = (sessionId, targetId) => holderStore.holderOf(sessionId, targetId);
  const phoneQuery = matchMedia('(max-width: 600px)');
  // サーバーが 'view-only' で断った（引き継ぐ前の AI のタブ）は、文を出さずに行を AI の形に描き直して [引き継ぐ] を促す（ADR 0321）
  const failed = error => (error?.code ?? error?.message) === 'view-only' ? refusedViewOnly() : notify(t(`tabs:address.reasons.${error?.code ?? error?.message}`, { defaultValue:t('tabs:address.failed') }));
  /** サーバーが 'view-only' で断った: 画面の持ち手が古かった（AI へ戻った後に押した など）。そのタブの持ち手を AI に戻して描き直し、[引き継ぐ] を促す（ADR 0321） */
  function refusedViewOnly(targetId = chrome()?.screencastState?.agentTabId ?? null) {
    const sessionId = session();
    if (sessionId && targetId) holderStore.event({ type:'tab:holder', sessionId, targetId, holder:'ai' });
    paint(); badge?.nudge();
  }
  // 引き継ぐ前の AI のタブ（映像は見るだけ。ADR 0321）か。そのタブへは戻る・進む・再読み込み・閉じる・表示の切り替えを送らない
  const viewOnlyTab = (sessionId, id) => id != null && id === chrome()?.screencastState?.agentTabId && holderOf(sessionId, id).holder !== 'human';
  /**
   * 今あるタブへの chromeNavigate。サーバーが 'view-only' で断った（画面の持ち手が古かった）ら、文を出さずに AI の形へ描き直して促し、blocked を返す。
   * アドレスバー・タブの列・メニューのどの入口から来ても同じにする（アドレスバーは自分で失敗の文を出すので、ここで受ける。ADR 0321）
   */
  const chromeNavigate = args => cmd('chromeNavigate', args).catch(error => {
    if ((error?.code ?? error?.message) !== 'view-only') throw error;
    refusedViewOnly(args.targetId ?? undefined); return { blocked:true };
  });
  /** 送らずに [引き継ぐ] を促す。AI のタブを映していなければ映してから（[引き継ぐ] の行は AI のタブを映している間だけ出る）。blocked で呼び手に知らせる */
  async function nudgeTakeOver(id) {
    if (!control().viewOnly) { const row = tabs().find(item => (item.chromeId ?? item.targetId) === id); if (row) await pick(row); }
    paintControl(); badge?.nudge();
    return { blocked:true };
  }
  /** 窓・タブの切り替えの失敗。サーバーの code（no-tab などの生の字）を画面へ出さず、理由の文か既定の文にする */
  // i18n-dynamic: browser.chromeWindow.reasons.
  const pinFailed = error => { const key = `browser.chromeWindow.reasons.${error?.code ?? error?.message}`; notify(has(key) ? t(key) : t('browser.chromeWindow.pinFailed')); };
  /**
   * タブの ⋮ と右クリックの今のタブの操作。ファイル・フォルダーのページはファイルの操作（web/file-preview.mjs の tabMenu）、
   * Web のページは「既定のブラウザーで開く」（URL）。リモートの画面では外で開く操作を出さない（ADR 0010。モック v6 の 9）
   */
  const tabMenu = tab => {
    // 保存した版（kind:'viz'）は束の印（vizHash・entry）が要るので、タブをそのまま渡す
    if (tab?.page?.kind === 'viz') return deps.preview?.tabMenu?.(tab) ?? [];
    const page = tab?.page?.path && ['file', 'dir', 'html'].includes(tab.page.kind) ? { path:tab.page.path, kind:tab.page.kind === 'dir' ? 'directory' : 'file' } : null;
    if (page) return deps.preview?.tabMenu?.({ ...tab, page }) ?? [];
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
    const existing = path && pages.list(sessionId).find(tab => tab !== replace && tab.page?.kind !== 'viz' && samePath(tab.page?.path, path));
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
      const pending = beginLoad({ pending:true });
      const opened = await openInput(args.input, sessionId).catch(error => { if (loadTicket === pending) clearLoading(); throw error; });
      if (loadTicket === pending) clearLoading();   // pick が具体的な待ちへ替えていなければ下ろす
      if (opened) { chrome()?.open?.(); return opened; }
    }
    if (tab?.local) {
      if (action === 'close') {
        // 映像で出している AI のタブは閉じない。端末内のページを出している間は、端末内のタブだけ閉じる（Chrome の AI のタブは AI に残す）
        if (tab.mode === 'chrome' && viewOnlyTab(sessionId, tab.chromeId)) return nudgeTakeOver(tab.chromeId);
        if (!discard(tab)) return {};
        if (tab.chromeId && !viewOnlyTab(sessionId, tab.chromeId)) { const closed = await chromeNavigate({ sessionId, targetId:tab.chromeId, action:'close' }); if (closed?.blocked) return closed; }
        if (loadTicket?.targetId === tab.targetId) clearLoading();
        frames.get(tab.targetId)?.frame.remove(); frames.delete(tab.targetId); pages.close(tab);
        if (active?.targetId === tab.targetId) { active = null; if (tabs().length) await pick(tabs()[0]); else await openInput(null, sessionId); }
        return {};
      }
      if (action === 'navigate') {
        const opened = await openInput(args.input, sessionId, tab); if (opened) return opened;
        if (!discard(tab)) return tab;
        // AI のタブ（見るだけ）は動かさず、新しい人のタブで開く
        const result = await chromeNavigate({ sessionId, targetId:tab.chromeId, action:tab.chromeId && !viewOnlyTab(sessionId, tab.chromeId) ? 'navigate' : 'new', input:args.input });
        if (result?.blocked) return result;
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
        if (tab.mode === 'chrome' && viewOnlyTab(sessionId, tab.chromeId)) return nudgeTakeOver(tab.chromeId);
        pages.view(tab, args.view);
        if (tab.mode === 'chrome' && tab.chromeId) await chromeNavigate({ sessionId, targetId:tab.chromeId, action:'navigate', input:tab.url });
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
              here.url = target; here.pendingNav = null; here.loaded = false; here.frame.src = target;
              pages.histGo(tab, dir);
              return {};
            }
          }
          if (discard(tab)) await pages.travel(tab, action === 'back' ? -1 : 1); return {};
        }
      }
    }
    // 端末内タブでない HTML の Chrome タブ（リモート・エージェントの窓）も ?view= で原文を出せる
    // 引き継ぐ前の AI のタブ（映像は見るだけ）: 戻る・進む・再読み込み・閉じる・表示の切り替えは送らず [引き継ぐ] を促す。
    // アドレスバーに打った URL は AI のタブを動かさず、新しい人のタブで開く（ファイルのパスは new の openInput が今までどおり端末内のタブで開く）。ADR 0321
    const remoteId = tab?.chromeId ?? (tab?.local ? undefined : tab?.targetId);
    if (action !== 'new' && action !== 'home' && viewOnlyTab(sessionId, remoteId)) return action === 'navigate' ? navigate('new', { input:args.input }) : nudgeTakeOver(remoteId);
    if (action === 'view' && !tab?.local && tab?.page?.kind === 'html' && tab.url) {
      const at = new URL(tab.url);
      if (args.view === 'source') at.searchParams.set('view', 'source'); else at.searchParams.delete('view');
      const moved = await chromeNavigate({ sessionId, targetId:tab.targetId, action:'navigate', input:at.href });
      if (moved?.targetId) await pick(tabs().find(item => item.targetId === moved.targetId) ?? { targetId:moved.targetId });
      return moved;
    }
    const result = await chromeNavigate({ sessionId, targetId:tab?.chromeId ?? (tab?.local ? undefined : tab?.targetId), action, ...args,
      ...(tab?.local && args.targetId ? { targetId:tab.chromeId } : {}) });
    if (result?.targetId) await pick(tabs().find(item => item.targetId === result.targetId) ?? { targetId:result.targetId });
    return result;
  }
  // ---- 読み込み線（スマホ。タブを押した直後から、新しい映像・ページが届くまで。古い応答では下ろさない） ----
  const loadLine = document.createElement('div'); loadLine.className = 'bu-load'; loadLine.hidden = true;
  let loadTicket = null, loadTimer = 0;
  function beginLoad(ticket) {
    clearTimeout(loadTimer);
    if (!phoneQuery.matches) { loadTicket = null; loadLine.hidden = true; return null; }
    loadTicket = { sessionId:session(), ...ticket };
    loadLine.hidden = false;
    const captured = loadTicket;
    loadTimer = setTimeout(() => { if (loadTicket === captured) clearLoading(); }, 12000);
    return loadTicket;
  }
  function clearLoading(ticket = null) {
    if (ticket && loadTicket !== ticket) return;
    clearTimeout(loadTimer); loadTicket = null; loadLine.hidden = true;
  }
  async function pick(tab) {
    const selection = active = { sessionId:session(), targetId:tab.targetId };
    clearLoading();   // 前の待ち（別のタブへ替えた・古い線）はここで下ろす
    overview.hidden = true;
    if (tab.local && tab.mode !== 'chrome') {
      chrome()?.cancelTabPin?.();
      const entry = frames.get(tab.targetId);
      if (entry?.loaded !== true) beginLoad({ targetId:tab.targetId, local:true });
      paint(); return;
    }
    try {
      const target = tab.chromeId ?? tab.targetId;
      // AI が操作中のタブを選ぶ = エージェントを追う（固定を解く。専用の追うボタンは無い）
      const follow = target != null && target === chrome()?.screencastState?.agentTabId;
      const pin = follow ? { windowId:null, tabId:null } : { windowId:tab.windowId ?? null, tabId:target };
      beginLoad({ targetId:tab.targetId, chrome:target, follow });
      chrome()?.expectFrame?.({ tabId:target, follow });   // 最初の絵が届くまでの骨組み（150ms を超えたら。ADR 0321）
      const pending = chrome()?.pinTab ? chrome().pinTab(selection.sessionId, pin) : cmd('chromePinWindow', { sessionId:selection.sessionId, ...pin });
      paint(); await pending;
    } catch (error) { if (active === selection) { clearLoading(); chrome()?.cancelFrameWait?.(); } pinFailed(error); }
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
    // 引き継ぐ前の AI のタブ（見るだけ）は動かさず、今のページのまま映像へ戻す（ADR 0321）
    if (viewOnlyTab(session(), tab.chromeId)) { tab.mode = 'chrome'; await pick(tab); return; }
    if (tab.chromeUrl && tab.chromeUrl !== tab.url) { const moved = await chromeNavigate({ sessionId:session(), targetId:tab.chromeId, action:'navigate', input }); if (moved?.blocked) return; }
    tab.chromeUrl = tab.url; tab.mode = 'chrome'; await pick(tab);
  }
  /** [引き継ぐ]: 映像の AI のタブを、窓を出さずにこの画面の人の操作にする。スマホは映像の箱の大きさを添える。押したら入力を映像へ移す（ADR 0321） */
  async function takeOver() {
    const sessionId = session(); if (!sessionId) return;
    const size = phoneQuery.matches ? await chrome()?.measure?.().catch(() => null) : null;
    // 画面が映している AI のタブを添える。サーバーの AI のタブと違えば（入れ違い）引き継がず、届く状態で描き直す（ADR 0321）
    const tabId = control().agentTab ?? undefined;
    await cmd('chromeTakeOver', { sessionId, by:'screen', tabId, ...(size ?? {}) }).catch(failed);
    paint();
    chrome()?.focusScreen?.();
  }
  /** 映像の操作状態。agentUsed: この会話のエージェントがブラウザーを使っている（使っていなければ入口を出さない）。anyHuman: 会話に人が触っているタブがある（見ているタブとは無関係） */
  function control() {
    const live = chrome()?.screencastState, sessionId = session(), tab = current(), agentTab = live?.agentTabId ?? null;
    const store = deps.controlStore?.get?.(sessionId)?.state ?? 'idle';
    const anyHuman = holderStore.anyHuman(sessionId);
    const held = tab ? holderOf(sessionId, tab.chromeId ?? tab.targetId) : { holder:'ai' };
    // 映像に映っているのが AI のタブか。AI のタブは、人が引き継ぐ（持ち手が人になる）までは見るだけ（ADR 0321）。端末内のページを出している間は映像ではない
    const page = Boolean(tab?.local && tab.mode !== 'chrome');
    const videoTab = page ? null : (live?.tabId ?? tab?.chromeId ?? tab?.targetId ?? null);
    const aiView = agentTab != null && videoTab === agentTab;
    return { sessionId, tab, held, agentTab, store, anyHuman, aiView, viewOnly:aiView && holderOf(sessionId, agentTab).holder !== 'human', agentUsed:store !== 'idle' || agentTab != null };
  }
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
  // タブの列の右端の ✖ はパネルを閉じる（開いている間は頭のアイコンを隠し、ここへ受け渡す。docs/design-system.md「会話の頭の行のアイコン」）
  const strip = createTabStrip({ label:tabLabel, onPick:pick, onClose:tab => navigate('close', { targetId:tab.targetId }).catch(failed), onNew:() => navigate('new').catch(failed),
    onPanelClose:() => { chrome()?.close(); deps.focusEntry?.(); }, shortcut:{ label:browserShortcutLabel(mac), aria:mac ? 'Meta+Shift+B' : 'Control+Shift+B' },
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
    // 元の HTML のタブの、外で開く印（アドレスの右端。OS の操作はサーバーのある PC の画面だけ）
    externalFor:tab => tab?.page?.kind === 'html' && tab.page.path && osActions() ? () => deps.preview?.openExternal?.({ path:tab.page.path, sessionId:tab.sessionId }) : null,
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
  // ---- 上の行の会話の切替（共有 combo。窓番号と「エージェントを追う」は出さない。承認済み 2026-11-08） ----
  /** 上の行に出す会話: この会話と、窓のある直接の子の会話（映している子は窓が無くても）。2 つ以上のときだけ */
  function convList() {
    const owner = state.current, shown = session();
    if (!owner) return [];
    // 作業のダイアログの中の欄は、左の一覧で選んだ子の会話のタブだけを映す（ほかの会話へは左の一覧で替える）。
    // メインの会話（owner）と映す子（shown）が別になるので、下の規則に任せると「子の会話」の切替が出てしまう
    if (deps.preview?.mounted?.()) return [];
    const list = [{ sessionId: owner, label: t('browser.chromeWindow.thisConversation') }];
    for (const row of deps.conversations?.() ?? []) {
      if (!row?.taskId || !row.sessionId || row.sessionId === owner) continue;
      if (!(row.windows > 0) && row.sessionId !== shown) continue;
      list.push({ sessionId: row.sessionId, label: row.title || t('browser.chromeWindow.childUntitled') });
    }
    if (shown && !list.some(conv => conv.sessionId === shown)) list.push({ sessionId: shown, label: t('browser.chromeWindow.childUntitled') });
    return list.length < 2 ? [] : list;
  }
  /** 会話の切替: 会話は移らず、映像だけその会話の Chrome へ替える */
  function onPickConv(id) { if (id && id !== session()) { active = null; chrome()?.open?.(null, { target: id }); } }
  const convOptions = () => convList().map(row => ({ value: row.sessionId, label: row.label }));
  const conv = createCombo({ ariaLabel: t('browser.chromeWindow.pickConversation'), cls: 'bu-conv', strict: true, options: convOptions,
    onCommit: id => onPickConv(id) });
  const convRun = runMark(); convRun.hidden = true; conv.root.prepend(convRun);
  /** 上の行の切替を今の状態にする（選ぶ会話・動いている印） */
  function paintSwitch() {
    if (!enabled) return;
    const shown = session(), convs = convList();
    conv.root.hidden = convs.length < 2;
    if (convs.length >= 2) conv.set(shown);
    const running = shown ? windowsTbl?.operating?.(shown) === true : false;
    convRun.hidden = ovRun.hidden = !running;
  }
  const tabRow = document.createElement('div'); tabRow.className = 'bu-tabrow';
  tabRow.append(conv.root, ...strip.items);
  const root = document.createElement('div'); root.className = 'bu-chrome'; root.append(tabRow, address.root);
  address.root.append(loadLine);
  // ---- スマホの一覧（[N]）: 上段は閉じる・会話の切替・＋。カードは選んだ会話のタブだけ ----
  const overview = document.createElement('div'); overview.className = 'bu-overview'; overview.hidden = true;
  const ovBack = browserButton('back', t('tabs:strip.closeList'), () => { overview.hidden = true; paintControl(); });
  const ovNew = browserButton('plus', t('tabs:strip.new'), () => { overview.hidden = true; navigate('new').catch(failed); });
  const ovConv = createCombo({ ariaLabel: t('browser.chromeWindow.pickConversation'), cls: 'bu-conv', strict: true, options: convOptions,
    onCommit: id => onPickConv(id) });
  const ovRun = runMark(); ovRun.hidden = true; ovConv.root.prepend(ovRun);
  const ovCards = document.createElement('div'); ovCards.className = 'bu-ov-cards';
  const ovHead = document.createElement('div'); ovHead.className = 'bu-ov-head'; ovHead.append(ovBack, ovConv.root, ovNew);
  overview.append(ovHead, ovCards); root.append(overview);
  let badge = null, ovSig = null;
  function paintOverview() {
    if (overview.hidden) return;
    const convs = convList();
    ovConv.root.hidden = convs.length < 2;
    if (convs.length >= 2) ovConv.set(session());
    // タブの並びだけでなく題・選択・持ち手の変化でもカードを張り直す（同じ枚数で中身が替わると見逃すため）
    const list = tabs(), cur = current()?.targetId;
    const sig = list.map(tab => `${tab.targetId}|${tabLabel(tab)}|${tab.targetId === cur ? 1 : 0}`).join(',');
    if (sig === ovSig) return;
    ovSig = sig;
    ovCards.replaceChildren(...list.map(tab => {
      const card = document.createElement('div'); card.className = 'bu-card' + (tab.targetId === current()?.targetId ? ' on' : '');
      const pickButton = document.createElement('button'); pickButton.type = 'button'; pickButton.className = 'bu-card-pick';
      const img = document.createElement('img'); img.alt = ''; img.className = 'bu-card-preview';
      const title = document.createElement('span'); title.className = 'bu-card-title'; title.textContent = tabLabel(tab);
      const label = document.createElement('div'); label.className = 'bu-card-label'; label.append(tabIcon(tab), title);
      if (!tab.local) pickButton.append(img); pickButton.append(label); pickButton.onclick = () => pick(tab); card.append(pickButton);
      const close = browserButton('close', t('tabs:strip.close', { title:title.textContent }), () => navigate('close', { targetId:tab.targetId }).then(result => { if (result?.blocked) return; overview.hidden = true; showOverview(); }).catch(failed)); close.classList.add('bu-card-close'); card.append(close);
      !tab.local && cmd('chromeAddress', { sessionId:session(), input:'', targetId:tab.targetId, thumbnail:true }).then(result => { if (img.isConnected && result?.data) img.src = `data:image/jpeg;base64,${result.data}`; }).catch(() => {});
      return card;
    }));
  }
  function showOverview() {
    overview.hidden = !overview.hidden; paintControl(); if (overview.hidden) return;
    ovSig = null; paintOverview();
  }
  /** 映像の再開操作（アドレスバーのすぐ下の 1 行）を今の状態にする */
  function paintControl() {
    if (!enabled) return;
    const c = control();
    // 人が触っているタブは会話ごとに数える（anyHuman）。PC は別のタブを見ていても「AI に戻す」は消えない（ADR 0296）。
    // スマホは「II あなたが操作中 [AI に戻す]」を人のタブを開いている間だけ出す（一覧を開いている間も出さない。承認済み 2026-11-08）
    const shown = phoneQuery.matches ? (c.held.holder === 'human' && overview.hidden) : (c.anyHuman && c.store !== 'paused');
    // AI のタブを見ている間は、「<名前> が Chrome を操作中 [引き継ぐ]」を出し続ける（ADR 0321。人が引き継ぐと、上の「あなたが操作中 [AI に戻す]」になる。同じ高さで入れ替わる）
    if (c.viewOnly) badge?.update({ visible:overview.hidden, mode:'ai', name:deps.agentName?.(c.sessionId) || '' });
    else badge?.update({ visible:shown, mode:'human' });
    chrome()?.refreshInput?.();   // 見るだけの間は確認・ファイル選び・選択の窓を出さず、引き継いだら開いたままのものを出す（ADR 0321）
  }
  function paint() {
    const tab = current(), shown = session(), live = chrome()?.screencastState;
    if (loadTicket?.sessionId && loadTicket.sessionId !== shown) clearLoading();   // 別の会話へ映し替えたら、前の待ちは下ろす
    const running = shown ? windowsTbl?.operating?.(shown) === true : false;
    // タブのチップのエージェントの印（弧。エージェントの今のタブは映像の状態が持つ）
    const items = tabs().map(row => row.local || live?.agentTabId == null ? row : { ...row, agent: row.targetId === live.agentTabId, agentRunning: running, agentName: deps.agentName?.(shown) });
    strip.update(items, tab?.targetId); address.show(tab, items.length); paintControl(); paintLocal(); paintSwitch(); paintOverview(); deps.onTabsChange?.();
  }
  const pageHost = document.createElement('div'); pageHost.className = 'bu-page-host';
  const frames = new Map(); let local = null, explorer = null;
  const update = document.createElement('button'); update.type = 'button'; update.className = 'bu-page-update'; update.hidden = true;
  update.textContent = t('tabs:display.update');
  // 「更新を表示」: 画面の中のページを読み直す。映像の中に居る HTML のタブは、そちらの Chrome のタブも読み直す（P10）
  update.onclick = () => { const tab = current(); if (!discard(tab)) return;
    if (tab?.mode === 'chrome' && tab.chromeId && !viewOnlyTab(tab.sessionId, tab.chromeId)) chromeNavigate({ sessionId:tab.sessionId, targetId:tab.chromeId, action:'reload' }).catch(failed);
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
        showMenu(x, y, [{ label:t('tabs:tree.new'), onClick:() => navigate('new', { input:item.id }).catch(failed) }, ...tabMenu(target)]); } });
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
      entry = { frame, sessionId, targetId:tab.targetId, url:tab.url, reload:tab.reload, tab, loaded:false };
      frames.set(tab.targetId, entry); pageHost.append(frame);
      frame.addEventListener('load', () => {
        entry.loaded = true; followLocal(entry);
        if (loadTicket?.local && loadTicket.targetId === entry.targetId) clearLoading();
      });
    } else if ((!tab.pending && entry.url !== tab.url) || entry.reload !== tab.reload) {
      const same = entry.url === tab.url;
      entry.url = tab.url; entry.reload = tab.reload;
      // 同じ文書のままの読み直しは中の文書に頼む（src の張り直しは # だけの違いを読み直さない・場所を保てない。指摘 2）。
      // 橋の無い出し方（?view=source の text/plain）は枠を直接読み直す
      const bridged = (() => { try { return new URL(entry.url).searchParams.get('view') !== 'source'; } catch { return false; } })();
      if (same && bridged && ['html', 'viz'].includes(tab.page?.kind)) pageCommand(entry, { type:'reload' });
      else { entry.loaded = false; entry.frame.src = tab.url; beginLoad({ targetId:tab.targetId, local:true }); }
    }
    if (loadTicket?.local && loadTicket.targetId === tab.targetId && entry.loaded === true) clearLoading();
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
    strip.relayout();
    // 「II あなたが操作中 [AI に戻す]」はアドレスバーのすぐ下の 1 行（承認済み 2026-11-08）。
    // 一覧（.bu-overview）の後に置くので、PC の出る場所は今のまま（一覧を開いている間は一覧の下）
    if (badge && badge.element.parentElement !== root) overview.after(badge.element);
    paint();
  }
  /** ファイルのページの頼み。worktree（requestId がある）は結果をページへ返す。メニューの位置はページの点から映像の上の点へ直す */
  async function pageRequest({ sessionId, targetId, request }) {
    // 端末経由でもページの頼みは未信頼: iframe の message と同じ検査（種別・形・長さ・送信元の会話）を通す
    const checked = pageRequestOf({ type:'pleiad:page-request', request }, sessionId);
    if (!checked || !deps.onPageRequest) return;
    request = checked;
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
    /** 使い回したタブへ今回の可視化の記録を付ける（web/page-tabs.mjs の markViz） */
    markViz:(tab, viz) => pages.markViz?.(tab, viz),
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
          catch (error) { pinFailed(error); }
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
          catch (error) { pinFailed(error); }
        }
        open(); return;
      }
      if (same) await openInput(null, sessionId);
      else await cmd('chromeNavigate', { sessionId, action:'new' }).catch(failed);
      open();
    },
    /** 見ている会話が替わった。欄を開いたままタブの無い会話へ移ったときだけ、空のタブを作る（inapp-browser.md 32 行） */
    sessionChanged(id) {
      if (!enabled || typeof id !== 'string' || !id) return;
      const needTab = () => chrome()?.isOpen?.() === true && !allTabs(id).length && !windowsTbl?.has?.(id);
      // watchSession の返事を待ってからもう一度確かめる（先に tab:info の棚が届くことがある）
      if (needTab()) void cmd('watchSession', { sessionId:id }).catch(() => {}).then(() => { if (needTab()) return openInput(null, id).catch(() => {}); });
      paint();
    },
    /** 会話の一覧（上の列の題・子の窓）が変わった。描き直す */
    conversationsChanged() { if (enabled) paint(); },
    /** タブの列のタブを一瞬光らせる（もう開いていたファイル） */
    flashTab(tab, sessionId) {
      if (sessionId !== session()) return;
      const item = [...strip.root.querySelectorAll('.bu-tab')].find(node => node.dataset.target === tab?.targetId && !node.classList.contains('bu-ghost'));
      if (!item) return;
      strip.reveal(tab.targetId);
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
        badge = createControlBadge({ onResume:() => cmd('chromeResume', { sessionId:session() }).catch(failed), onTakeOver:takeOver });
        // AI のタブの映像は引き継ぐまで見るだけ。触れたら [引き継ぐ] を強調する（ADR 0321）
        chrome()?.useInput?.({ phone:() => phoneQuery.matches, showMenu, viewOnly:() => control().viewOnly, onBlocked:() => badge?.nudge(), onRefused:tabId => refusedViewOnly(tabId ?? undefined) });
        chrome()?.onOpenChange(attach);
        // 開いたら中へフォーカスを移す: 新しいタブならアドレスバー、ほかは今のタブ（docs/design-system.md「会話の頭の行のアイコン」）。
        // 開いたまま映す会話を替えたとき（show の呼び直し）は動かさない。スマホはキーボードを出さないよう、パネルのまま
        let wasOpen = false;
        chrome()?.onOpenChange(open => {
          const opened = open && !wasOpen; wasOpen = !!open;
          if (!opened || phoneQuery.matches) return;
          // 開いた直後の知らせ（onTargetChange → attach）が列を置き直すと、移したフォーカスが外れる。次のコマで移す
          const inside = () => {
            if (chrome()?.isOpen?.() === false) return;
            const tab = current();
            if (!tab || tab.page?.kind === 'new') address.edit(); else strip.focusCurrent();
          };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(inside); else inside();
        });
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
          // 読み込み線: 選んだタブの最初のフレームが届いたら下ろす（映像の状態が先に替わっても、絵が古いまま線を下ろさない）
          if (event?.type === 'state' && loadTicket?.follow && loadTicket.sessionId === session()) {
            // 追っている途中で AI が別のタブへ移ったら、待つ絵をそのタブへ替える
            const moved = chrome()?.screencastState?.agentTabId;
            if (moved != null) loadTicket.chrome = moved;
          }
          if (event?.type === 'frame' && loadTicket && !loadTicket.local) {
            if (loadTicket.sessionId === session() && event.tabId === loadTicket.chrome) clearLoading();
          }
          if (event?.type === 'pin-failed' && loadTicket && (!event.sessionId || event.sessionId === loadTicket.sessionId)
            && (!event.tabId || event.tabId === loadTicket.chrome || loadTicket.follow)) clearLoading();
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
