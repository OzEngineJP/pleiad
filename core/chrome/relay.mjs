// エージェントのブラウザー（PC の Chrome）の絞り込みの中継（docs/inapp-browser.md「Chrome の中継」、ADR 0148・0153）。
//
// 会話ごとに鍵付きの loopback の ws の端点（ws://127.0.0.1:<port>/devtools/browser/<鍵 48 桁>）を出し、
// Chrome への 1 本の接続（core/chrome/connection.mjs）の上で、その会話の窓の範囲にだけ絞った CDP を中継する。
//   - 範囲: 会話の窓（windowId）のタブ。中継が作った窓のタブと、範囲のタブが開いたタブ（openerId。popup の別窓はその窓も範囲に足す）。
//     ほかの窓（利用者の普段の窓・ほかの会話の窓）のタブは、getTargets にもイベントにも出さない。URL・題は覚えずログにも出さない
//   - 上りへは、ブラウザー全体の Target.setAutoAttach を一度も送らない（利用者の全タブに attach するため）。エージェントのものは中継の中で真似る
//   - sessionId は、どのエージェントの接続が attach したものかを覚え、ほかの接続の sessionId は断る
//   - ブラウザー全体に効く操作（Browser.close・Storage.*・Cookie の一括の読み書きなど）は断る。断る・真似る・許すの一覧は下の表と docs
// サイトの利用の確認（confirmAgentSites が ON のとき）は、中継が範囲のタブに自分のセッションを attach して Fetch で主フレームの要求を止めて聞く。
// 「今の origin」は、そのセッションの Page.frameNavigated（主フレーム）で移り終えた先の securityOrigin で持つ（targetInfo の URL は断った先も指すため）。
// 要求を出さずに移った（履歴の移動・bfcache の復元）ときは、移った後に聞き、断られたら about:blank に戻す。
// window.open で開いたタブの最初の要求は Fetch では止められない（実機。docs）ので、開いた後に聞き、断られたら閉じる。
// 窓の作り方は scope の口（既定は core/chrome/windows.mjs の専用の窓。ADR 0154）。窓は最小化せず、画面の外の見えない窓に置く。
//   - エージェントの Page.bringToFront・Target.activateTarget は Chrome へ送らずに成功で返す（窓が前面を取るため。agent-browser の「今のタブ」は自分の側で持つ）
//   - エージェントのターンの間、会話の窓のタブすべてに中継の自分のセッションで Emulation.setFocusEmulationEnabled(true) を保つ（隠した窓の描画・入力を保つため）。
//     エージェントのセッションの付け外しでは切れない。ターンが終わったら外す
//   - 範囲のタブが window.open の popup で開いた別窓にも、同じ置き方を当てる（scope.adoptPopup）
// 一時停止（entry.paused。状態機械は core/chrome/control.mjs）: 前の版（ADR 0148・0154 の、会話ごとの引き継ぎ）から更新を越えて持ち越した引き継ぎだけが入る（restore の paused）。
// ADR 0296 からは、人の操作はタブごとの持ち手（tab-holder.mjs）で断り、新しく一時停止に入る経路は無い。
// 一時停止の間は、エージェントのコマンドを全部 PAUSED_MESSAGE で断る（人が窓を操作している。エージェントは hand_to_user で戻るのを待つ）。
// 呼び手は「任せる」（control の resume）か窓を閉じる操作で unpause() する。Chrome との接続が切れたとき・窓が無くなったときも解く。
//   - 一時停止の間は、タブを「エージェントが動かしている」と見なさない（人の移動をサイトの利用の確認にかけない）
//   - 会話の範囲の上りへの送信は、送る直前にもう一度一時停止を見る（確認の待ちの後ろに並んだコマンドが、一時停止の後に届かないように）
//   - onChange(fn): 会話の状態（ターンの間か・止めた・一時停止）が変わるたびに sessionId を渡す。onTap(fn): エージェントが押した位置（Input.dispatchMouseEvent の mousePressed）
//   - onTabsLost(fn): 会話のタブが、エージェントが閉じたのでなく全部無くなった（窓を閉じる操作・人が窓を閉じた・Chrome が切れた）ときに sessionId を渡す。
//     agent-browser は --pin-tab で消えたタブに縛られたまま、次の open からも tab_gone で断り続ける。聞き手（core/agent-browser.mjs）が縛りの記録を消して true を返したら、
//     中継はエージェントの接続を切る。デーモンはつなぎ直すときに記録を読み直し、縛りが無ければ新しいタブ（新しい専用窓）を作る。
//     縛りの無いエージェントの接続は切らない（次の createTarget で黙って窓を開き直す。ADR 0154）
// 右パネルの映像（core/chrome/screencast.mjs。ADR 0148 第 5 段）には view の口を出す: 会話の窓のタブ・AI のタブ（view.current。エージェントが CLAIMS のコマンドで操作したタブの履歴の、残っている一番新しいもの。ADR 0321）・
// タブの題（右パネルのタブの列。見ている端末にだけ送る）・操作中の印・中継自身のセッションの付け外し（エージェントのセッションとは別。映像を見ている間だけ付け、focus emulation も映像側のセッションで持つ）・変化の知らせ
// ブラウザーの一本化（ADR 0294〜0297）の口: 移動の検査とコマンドの前後のふるい（page-policy.mjs）・操作の前の門（tab-holder.mjs）・
// タブの情報（tab-info.mjs）・ページからの頼み（page-bridge.mjs）。出来事は onTabEvent(fn) に 1 本で出す（TAB_EVENTS）。setPagePorts でサーバーの port を受ける
// ダウンロード（ADR 0328。記録は downloads.mjs）: 上りの接続に Browser.setDownloadBehavior { behavior: 'default', eventsEnabled: true } を送り、
// ブラウザー全体のダウンロードのイベントのうち、会話のタブで始まったもの（始まったフレームから会話を引けたもの）だけを記録する。保存先は替えない（Chrome のいつもの保存先）。
// 利用者自身のダウンロードは記録せず、エージェントの接続にはどのダウンロードのイベントも配らない。エージェントからの Browser.setDownloadBehavior・Page.setDownloadBehavior は引き続き断る
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createChromeWindows } from './windows.mjs';
import { CARRY_MAX_BYTES } from './link-wire.mjs';
// ブラウザーの一本化（ADR 0294〜0297）の 4 つの口。試験では hooks で差し替える
import { createPagePolicy, safeUrl } from './page-policy.mjs';
import { createTabHolder, PAUSED_MESSAGE, HUMAN_MESSAGE } from './tab-holder.mjs';
import { createTabInfo } from './tab-info.mjs';
import { createPageBridge } from './page-bridge.mjs';
import { createChromeDownloads } from './downloads.mjs';

export { safeUrl, PAUSED_MESSAGE };
/** relay.onTabEvent(fn) で出す出来事の名前（fn(type, payload)）。ほかの名前は出さない */
export const TAB_EVENTS = Object.freeze(['tab:info', 'tab:holder', 'tab:page-request', 'tab:viewport', 'tab:downloads']);
/** ダウンロードを止められるか（CDP の既定の context）を引き直す間隔（ms）。進行中のものがある間だけ引く */
const DOWNLOAD_CONTEXT_MS = 3000;

const KEY_PATH = /^\/devtools\/browser\/([a-f0-9]{48})$/;
const random = () => crypto.randomBytes(24).toString('hex');
const CONNECT_WAIT_MS = 20_000;
/** エージェントのコマンドの上りの上限。移動の確認（人が答える）を待つことがあるので長くとる。CLI は自分で先に打ち切る */
const COMMAND_TIMEOUT_MS = 600_000;

/** 応答のときに確認の答えを待ち、断られた文を返すコマンド（ADR 0042） */
const OPERATES = /^(Input\.|Runtime\.(evaluate|callFunctionOn)$|Page\.(navigate|reload|navigateToHistoryEntry)$)/;
/**
 * エージェントがタブを動かしている印を付けないコマンド（有効化と、iframe・worker の自動 attach の続き）。
 * ほかのコマンドは全部、印を付ける（DOM の書き換え・runScript・Debugger などでも移動はできるため。ターンの終わりで外れる）
 */
const PASSIVE = /(\.enable|\.disable)$|^(Runtime\.runIfWaitingForDebugger|Target\.setAutoAttach)$/;
/**
 * AI のタブ（映像が追い、人が引き継ぐ対象。ADR 0321）を、そのタブへ移すコマンドの許可の一覧。ここに無いコマンドでは AI のタブは移らない。
 * 理由: agent-browser は、範囲に入ったタブ（人が開いたタブ・持ち越して戻したタブも）に自分から Target.attachToTarget し、
 * 続けて準備のコマンド（runIfWaitingForDebugger・各 enable・setAutoAttach・Page.getFrameTree）を送る（実測 2026-11-12、agent-browser 0.38.1）。
 * それを数えると、人がタブを開いた瞬間や、つなぎ直したときに AI のタブが勝手に移る。数えるのは、エージェントがそのタブを相手に選んだと分かるものだけ:
 * - 操作（入力・スクリプト・移動）: Input.*、Runtime.evaluate / callFunctionOn、Page.navigate / reload / navigateToHistoryEntry など
 * - 明示の切り替え: Page.bringToFront（agent-browser の tab の切り替え）。ブラウザーの単位の Target.activateTarget は browserCommand で数える
 * - ページを読む・撮る: 読み上げの木（snapshot）・画面の撮影・PDF・ダイアログへの答え・DOM を探す・書き換える
 */
const CLAIMS = new RegExp('^(' + [
  'Input\\.[A-Za-z]+',
  'Runtime\\.(evaluate|callFunctionOn|compileScript|runScript)',
  'Page\\.(navigate|reload|navigateToHistoryEntry|bringToFront|captureScreenshot|printToPDF|handleJavaScriptDialog|stopLoading|setDocumentContent)',
  'Accessibility\\.(getFullAXTree|getPartialAXTree|queryAXTree|getRootAXNode|getChildAXNodes)',
  'DOM\\.(getDocument|querySelector|querySelectorAll|getOuterHTML|describeNode|resolveNode|getBoxModel|getContentQuads|performSearch|focus|scrollIntoViewIfNeeded|setFileInputFiles|setAttributeValue|setAttributesAsText|setOuterHTML|setNodeValue|removeNode)',
].join('|') + ')$');
/** AI のタブの履歴（新しい順）と、人が開いたタブの印を持ち越す数の上限（閉じたタブは外すので、ふつうは窓のタブの数より少ない） */
const AI_HISTORY_MAX = 20;
/** 中継の口が使う binding の名前（page-bridge.mjs の plyPage・input.mjs の plyInput）。エージェントには足させない・外させない */
const RESERVED_BINDINGS = new Set(['plyPage', 'plyInput']);
/** 確認のセッションとその子の iframe に付ける自動 attach（子は止めたまま付き、Fetch を付けてから走らせる） */
const CHILD_AUTO_ATTACH = Object.freeze({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

// セッションの上（タブ・iframe・worker）で断るもの。ほかは通す。
// 考え方: ドメインごと通すものでも、引数でほかの origin・storageKey・url を指せて、自分のタブの外に届くコマンドは断る（docs）
const SESSION_DENIED_DOMAINS = ['Browser.', 'Storage.', 'Extensions.', 'PWA.', 'Autofill.', 'Cast.', 'SystemInfo.', 'Tethering.',
  // securityOrigin・storageKey・storageId でほかの origin の保存データ（localStorage・IndexedDB・Cache・Web SQL・OPFS・Service Worker）を読み書きできる
  'DOMStorage.', 'IndexedDB.', 'CacheStorage.', 'Database.', 'FileSystem.', 'ServiceWorker.',
  // 記録はブラウザーの全 origin の分（origin・storageKey が載る）
  'BackgroundService.'];
const SESSION_DENIED = new Set(['Network.getAllCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Page.setDownloadBehavior', 'Security.setIgnoreCertificateErrors',
  'Page.deleteCookie',                   // 任意の url の Cookie を消せる
  'Network.loadNetworkResource',         // 資格情報つきでほかの origin を取れ、サイトの確認を通らない
  'Network.getCertificate',              // 任意の origin の証明書（その origin へつないだかが分かる）
  'Network.enableDeviceBoundSessions', 'Network.deleteDeviceBoundSession',   // 全サイトの端末に結んだセッションを見る・消す
  'Network.setRequestInterception', 'Network.continueInterceptedRequest',    // 古い横取り。url を差し替えて、確認を通らずにほかの origin へ送れる（Fetch を使う）
]);
const COOKIE_WRITES = new Set(['Network.setCookie', 'Network.setCookies', 'Network.deleteCookies']);
/** エージェントの Fetch で止まっている要求の URL（Fetch.continueRequest の url の差し替えを同じ origin に限るため）。接続あたりの上限 */
const PAUSED_LIMIT = 1000;
/** Page.navigateToHistoryEntry の応答の後、移り終える（frameNavigated）のを待つ上限 */
const HISTORY_COMMIT_WAIT_MS = 1000;
// ブラウザーの上（sessionId なし）で許すもの。ここに無いものは断る
const BROWSER_ALLOWED = new Set([
  'Browser.getVersion',
  // 真似る（上りへ送らない・送り方を変える）
  'Target.getBrowserContexts', 'Target.setDiscoverTargets', 'Target.setAutoAttach', 'Target.getTargets', 'Target.createTarget',
  // 範囲のタブ・窓だけ
  'Target.getTargetInfo', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.closeTarget', 'Target.activateTarget',
  'Browser.getWindowForTarget', 'Browser.getWindowBounds', 'Browser.setContentsSize',
]);

/** 一時停止中のコマンドを断る文（agent-browser の画面にそのまま出る）。日本語と英語を並べる */
// i18n-ignore: エージェントへの断りの文。会話の言語に依らず、日本語と英語を並べる（中継は言語を持たない）

class RelayError extends Error {
  constructor(message, code = -32000) { super(message); this.code = code; }
}
const denied = what => new RelayError(`${what} denied`);
/** エージェントからは受けないダウンロードの命令（ADR 0328）。断るときは、理由と次の手の文を返す */
const DOWNLOAD_COMMANDS = new Set(['Browser.setDownloadBehavior', 'Page.setDownloadBehavior', 'Browser.cancelDownload']);

const originOf = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : null; } catch { return null; } };
const hostOf = value => { try { return new URL(value).hostname; } catch { return null; } };
/** 主フレームが移り終えた先の origin（Page.frameNavigated の frame）。http(s) のときだけで、エラーのページ・about:blank・data: などは null */
function committedOrigin(frame) {
  if (!frame || frame.unreachableUrl) return null;
  return originOf(frame.securityOrigin || frame.url || '');
}

/**
 * @param {object} deps
 * @param deps.connection  core/chrome/connection.mjs の接続（demand({ signal }) で cdp を返す）
 * @param deps.os          core/chrome/os.mjs の口（窓を隠す・見つける。connection と同じものでよい）
 * @param deps.locate      Chrome の User Data（core/chrome/locate.mjs の chromeHomes の 1 つ。{ userDataDir, custom? }）
 * @param [deps.profileFor]  会話の窓を開くプロフィール（core/chrome/windows.mjs の profileFor。既定の scope に渡す）
 * @param [deps.profileUsed] 選んでいない会話の最初の窓を開いたプロフィール（同じく profileUsed）
 * @param [deps.scope]     窓の作り方（openTab・adoptPopup・windowClosed・rebind・reset・forget）。既定は core/chrome/windows.mjs の専用の窓
 * @param [deps.authorize] サイトの利用の確認（core/browser-confirm.mjs の createBrowserSiteApprovals）。({ sessionId, url, profile }, signal) → { allow, message? }。
 *                        profile はタブのプロフィール（'chrome:<フォルダー名>'。scope.profileOf。分からなければ null）
 * @param [deps.deniedMessage] 確認で断られた移動をエージェントへ返す文
 * @param [deps.handoff]  操作待ち（core/chrome/handoff.mjs）。接続が無いまま待つとき connect(sessionId) で許可待ちのカードを出す（20 秒の待ちが外れても試行は続く）
 * @param [deps.turnLive] (sessionId) => その会話のターンが走っているか。無い・false のとき、つながっていなければ確認を出さずに断る（頼んだ人が居ない）
 * @param [deps.turnSignal] (sessionId) => 走っているターンの中断の合図。人の「止める」で、その会話の接続待ちを外す
 * @param [deps.carryExtra] 更新を越えて持ち越す、中継の外の状態（{ snapshot() → 小さな object, restore(object) }）。carry の extra に載り、変わったら touch() で預け直す（一時 id のプロフィール選択・ログイン待ちの束ねの鍵。ADR 0167）
 * @param [deps.connectWaitText] (sessionId) => 20 秒待ってもつながらないときに（setup・permission で）エージェントへ返す文。会話の言語。無ければ英語の固定
 * @param [deps.downloadDeniedText] (sessionId) => エージェントのダウンロードの命令（Browser.setDownloadBehavior・Page.setDownloadBehavior・Browser.cancelDownload）を断るときに返す文（理由と次の手。会話の言語）。無ければ英語の固定
 * @param [deps.hooks] ブラウザーの一本化の口の差し替え（試験用。{ pagePolicy, tabHolder, tabInfo, pageBridge, downloads } の作り方。各モジュールの create* と同じ引数）。無いものは各モジュールの既定
 */
export function createChromeRelay({ connection, os, locate, log = () => {}, profileFor, profileUsed, scope = createChromeWindows({ os, locate, log, profileFor, profileUsed }), authorize = async () => ({ allow: false }), deniedMessage = () => 'navigation denied',
  connectWaitMs = CONNECT_WAIT_MS, commandTimeoutMs = COMMAND_TIMEOUT_MS, handoff = null, connectWaitText = null, downloadDeniedText = null, turnLive = null, turnSignal = () => undefined, carryExtra = null, now = Date.now, hooks = {} } = {}) {
  const entries = new Map();   // 会話の id -> entry
  const byKey = new Map();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  let address = null, listening = null;
  let confirm = false;         // サイトの利用の確認（confirmAgentSites）
  let up = null;               // 上り（Chrome への接続 1 本）の上の状態
  let binding = null;
  let closed = false;
  let invalidCarry = false;    // 前のサーバーの預かり物が無効だった（会話の端点を、人が送るまで止めたものとして作る）
  let staleSessions = [];      // 前のサーバーが Chrome の接続に付けたまま残したセッション（restore で受け、最初の bind で外す）
  const orphans = new Set();   // 層が引き継げなかった窓の windowId（Chrome の接続が付いたら、その窓のタブを CDP で閉じる）
  let chromeId = null;         // 持ち越した窓・orphans の持ち主の Chrome（ws のパスの GUID）。windowId は Chrome の起動ごとに 1 から振り直されるので、別の Chrome の windowId で利用者の窓を触らないための印
  const carryListeners = new Set();
  const changeListeners = new Set(), tapListeners = new Set(), lostListeners = new Set();
  const fire = (set, ...args) => { for (const fn of [...set]) { try { fn(...args); } catch (error) { log(`chrome-relay: listener failed: ${error?.message ?? error}`); } } };
  // ---- ブラウザーの一本化の口（ADR 0294〜0297） ----
  let pagePorts = null;        // サーバーの 3 つの port（setPagePorts）。{ main, pages, isolated }
  let pageCookie = null;       // ファイルのページの Cookie（setPageCookie。ログに書かない）
  const tabEventListeners = new Set();
  const emitTab = (type, payload) => { if (TAB_EVENTS.includes(type)) fire(tabEventListeners, type, payload); };
  const pagePolicy = (hooks.pagePolicy ?? createPagePolicy)({ ports: () => pagePorts, cookie: () => pageCookie, log });
  const tabHolder = (hooks.tabHolder ?? createTabHolder)({ emit: emitTab, now, log });
  const tabInfo = (hooks.tabInfo ?? createTabInfo)({ emit: emitTab, log });
  const pageBridge = (hooks.pageBridge ?? createPageBridge)({ emit: emitTab, ports: () => pagePorts, log });
  // 会話のタブで始まったダウンロードの記録（ADR 0328）
  const downloads = (hooks.downloads ?? createChromeDownloads)({ emit: emitTab, now, log });
  /** 口の呼び出し（タブの出入りの知らせ）。口が投げても中継は止めない */
  const callHook = (name, fn) => { try { fn(); } catch (error) { log(`chrome-relay: ${name} failed: ${error?.message ?? error}`); } };
  /** 口に渡すタブ。attach は中継自身のセッションを付ける（view.attach と同じ形） */
  const tabHandle = (state, tab) => ({ sessionId: tab.entry.id, targetId: tab.targetId, windowId: tab.windowId, info: { ...tab.info }, attach: onEvent => ownSession(state, tab, onEvent) });
  const tabGone = tab => {
    const gone = { sessionId: tab.entry.id, targetId: tab.targetId };
    callHook('tabInfo', () => tabInfo.removed(gone));
    callHook('pageBridge', () => pageBridge.removed(gone));
    callHook('tabHolder', () => tabHolder.forget(gone));
  };
  /** 移動を通すか（口が投げたら通さない） */
  const allowUrl = (url, context) => { try { return pagePolicy.allowUrl(url, context) === true; } catch { return false; } };
  /** 中継自身の接続（ブラウザーの単位）でコマンドを送る口。移動の検査の口の connected・beforeOpen に渡す */
  const browserSend = state => (method, params) => state.cdp.send(method, params);
  /** タブを開く前に、移動の検査の口に支度させる（ページの Cookie）。口が投げても開くのは止めない */
  const prepareOpen = (state, sessionId, url) => Promise.resolve()
    .then(() => pagePolicy.beforeOpen?.({ sessionId, url, send: browserSend(state) }))
    .catch(error => log(`chrome-relay: pagePolicy failed: ${error?.message ?? error}`));
  /** 中継のセッションをタブに付けて要求を止めるか（確認が ON か、口が止めたい） */
  const intercepting = () => confirm || pagePolicy.intercepts === true;
  /** 中継のセッションの Fetch の patterns（確認のための主フレームの Document と、口が足す Pleiad の port） */
  const internalPatterns = () => pagePolicy.fetchPatterns([{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }]);
  /** iframe の子のセッションの Fetch の patterns（Pleiad の port だけ。空なら子に Fetch も自動 attach も付けない） */
  const childPatterns = () => { try { return pagePolicy.childPatterns?.() ?? []; } catch { return []; } };
  /** ブラウザーの単位の Fetch の patterns（window.open の最初の要求。空なら付けない） */
  const browserPatterns = () => { try { return pagePolicy.browserPatterns?.() ?? []; } catch { return []; } };
  /** エージェントへ送るイベントの params（Cookie の値を除く口を通す）。口が投げたら null（そのイベントは送らない） */
  const filterEvent = (entryId, method, params) => {
    try { return pagePolicy.event?.({ sessionId: entryId, method, params }) ?? params; }
    catch (error) { log(`chrome-relay: pagePolicy failed: ${error?.message ?? error}`); return null; }
  };
  /** その URL へ移す前にページの Cookie をタブのセッションで入れるか（口が投げたら入れない） */
  const wantsCookie = url => { try { return pagePolicy.wantsCookie?.(url) === true; } catch { return false; } };
  /** タブの中継のセッションでページの Cookie を入れる（既定の context でないプロフィールのタブには、ブラウザーの単位の Storage.setCookies が届かない） */
  const tabCookie = (state, sessionId) => Promise.resolve()
    .then(() => pagePolicy.tabCookie?.((method, params) => state.cdp.send(method, params, sessionId)))
    .catch(error => log(`chrome-relay: pagePolicy failed: ${error?.message ?? error}`));
  const changed = entry => { fire(changeListeners, entry.id); carryChanged(); };
  const viewers = new Set();   // 映像側の聞き手 fn(entryId, kind, extra)。kind: tabs（タブの増減・タブの窓が分かった）| title（タブの題が替わった）| current（今のタブが替わった）| operating（操作中の印が替わった）| reset（Chrome の接続が切れた）| forget（会話を消した）| rebind（extra が前の id）
  const notifyView = (entryId, kind, extra) => { for (const fn of [...viewers]) { try { fn(entryId, kind, extra); } catch { /* 聞き手の失敗は中継を壊さない */ } } };
  /** 更新を越えて持ち越す状態（接続の子へ預ける carry）。端点（会話の id・鍵・待ち受けのポート）と、隠した窓の印 */
  function snapshot() {
    const windows = scope.snapshot?.() ?? [];
    const carry = {
      v: 1,
      port: address?.port ?? null,
      chrome: chromeId,
      entries: [...entries.values()].map(entry => ({ id: entry.id, key: entry.key, stopped: entry.stopped, paused: entry.paused ? { ...entry.paused } : null, lastUsedAt: entry.lastUsedAt ?? null,
        ...(entry.ai.length ? { ai: [...entry.ai] } : {}), ...(entry.human.size ? { human: [...entry.human] } : {}) })),
      windows,
    };
    const extra = carryExtra?.snapshot?.();
    if (extra && typeof extra === 'object' && Object.keys(extra).length) carry.extra = extra;
    // 大きすぎて預けられないときは、窓も止めた印も一時停止も無い古い会話（端点だけ）から落とす。それでも大きければ、link が「無効」の印にする
    if (Buffer.byteLength(JSON.stringify(carry), 'utf8') > CARRY_MAX_BYTES) {
      const keep = new Set(windows.filter(item => item?.windows?.length).map(item => item.id));
      carry.entries = carry.entries.filter(item => item.stopped || item.paused || keep.has(item.id));
    }
    if (carry.extra && Buffer.byteLength(JSON.stringify(carry), 'utf8') > CARRY_MAX_BYTES) delete carry.extra;   // 補助の状態は、端点・窓の印より先に諦める
    return carry;
  }
  /** carry の一時停止の印を戻す。at は時刻 ms、by は control が付けた印（文字列）、viewport は端末が引き継いだときの映像の箱（数だけ受ける） */
  const restoredPause = saved => {
    const mark = { at: Number.isFinite(saved.at) ? saved.at : Date.now() };
    if (typeof saved.by === 'string' && saved.by.length <= 40) mark.by = saved.by;
    const v = saved.viewport;
    if (v && [v.width, v.height, v.scale].every(n => Number.isFinite(n) && n > 0 && n <= 10_000)) mark.viewport = { width: v.width, height: v.height, scale: v.scale };
    return mark;
  };
  /** carry のタブの id の列を戻す（字の id だけ・重ねない・上限まで） */
  const carriedIds = list => (Array.isArray(list) ? [...new Set(list.filter(id => typeof id === 'string' && id && id.length <= 100))].slice(0, AI_HISTORY_MAX) : []);
  /** 持ち越す状態が変わった。聞き手（server.mjs → link.setCarry。200 ms でまとめる）へ今の状態を渡す */
  let lastCarry = '', lastMarks = '';
  function carryChanged() {
    if (closed || !carryListeners.size) return;
    const carry = snapshot();
    const text = JSON.stringify(carry);
    if (text === lastCarry) return;
    lastCarry = text;
    // 一時停止・止めた印が替わったときは、まとめずにすぐ預ける（人が操作中の窓を、落ちた後の新しいサーバーが動かさないため）
    const marks = JSON.stringify(carry.entries.map(item => [item.id, item.stopped, item.paused]));
    const now = marks !== lastMarks;
    lastMarks = marks;
    for (const fn of [...carryListeners]) { try { fn(carry, { now }); } catch { /* 聞き手の失敗は中継を壊さない */ } }
  }
  scope.onChange?.(carryChanged);
  /** 窓のタブをすべて閉じる（CDP）。層が窓を引き継げなかった・層が居ない間に閉じるとき */
  async function closeWindowTabs(state, windowIds) {
    if (!windowIds.size || state.cdp.closed) return;
    const { targetInfos = [] } = await state.cdp.send('Target.getTargets').catch(() => ({}));
    for (const info of targetInfos) {
      if (info.type !== 'page') continue;
      const where = await state.cdp.send('Browser.getWindowForTarget', { targetId: info.targetId }).catch(() => null);
      if (where && windowIds.has(where.windowId)) state.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const key = KEY_PATH.exec(request.url || '')?.[1];
    const entry = key ? byKey.get(key) : null;
    if (closed || !entry || entry.stopped || request.headers.host !== `127.0.0.1:${address?.port}` || request.socket.remoteAddress !== '127.0.0.1') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => attachClient(entry, ws));
  });

  // ---- 上り ------------------------------------------------------------------------------------
  /** 上りの状態を作る（cdp 1 本につき 1 回）。範囲を知るため、Target.setDiscoverTargets を上りに 1 回だけ送る */
  function bind(cdp) {
    if (up?.cdp === cdp) return Promise.resolve(up);
    if (binding?.cdp === cdp) return binding.promise;
    const state = { cdp, tabs: new Map(), windows: new Map(), sessions: new Map(), attaching: new Map(), offs: [], frameTabs: new Map(), browserFetch: null,
      downloadOwners: new Map(), downloadContextAt: 0 };   // downloadOwners: 持ち主を引いている途中のダウンロード（guid -> { last: 待たせた進み具合 }）
    // 持ち越した窓が、今つなぐ Chrome のものでなければ（Chrome が起動し直された）、その windowId は今の Chrome の別の窓を指す。捨てる
    const browserId = typeof cdp.browserId === 'string' && cdp.browserId ? cdp.browserId : null;
    if (browserId && chromeId && browserId !== chromeId) forgetCarriedWindows('another chrome');
    if (browserId && browserId !== chromeId) { chromeId = browserId; carryChanged(); }
    state.offs.push(cdp.onEvent((method, params, sessionId) => { if (up === state) onUpEvent(state, method, params, sessionId); }));
    state.offs.push(cdp.onClose(() => teardown(state)));
    // 持ち越した窓（restore）。Target.setDiscoverTargets が返す既存のタブのうち、この窓にあるものを、会話の範囲に戻す（onTargetCreated の窓の経路）
    for (const entry of entries.values()) for (const windowId of entry.windows) state.windows.set(windowId, entry);
    const promise = (async () => {
      up = state;
      const stale = staleSessions; staleSessions = [];
      for (const sessionId of stale) cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});   // 前のサーバーの確認の Fetch は、答える相手が居ない
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      // ダウンロードのイベントを受ける（ADR 0328）。保存先は替えない（behavior: 'default'）。旗は接続の単位で、どのプロフィールのダウンロードも届く。
      // browserContextId は付けない（既定でないプロフィールの id は断られる。実機）。待たない・断られても（古い Chrome など）つなぐのは止めない
      cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true })
        .catch(error => log(`chrome-relay: download events unavailable: ${error?.message ?? error}`));
      // 移動の検査の口に、つながったことを知らせる（ページの Cookie を入れる）。待たない・口が投げてもつなぐのは止めない
      Promise.resolve().then(() => pagePolicy.connected?.({ send: browserSend(state) }))
        .catch(error => log(`chrome-relay: pagePolicy failed: ${error?.message ?? error}`));
      // ブラウザーの単位の Fetch を今の port で付ける（patterns が空なら外す。前のサーバーがこの接続に付けたものは答える相手が居ない）
      syncBrowserFetch(state);
      // Chrome は、すでに発見中の接続（更新を越えて接続の子が持ち続ける接続）への setDiscoverTargets では既存のタブの targetCreated を送り直さない（実機）。
      // 持ち越した窓のタブは、今あるタブを自分で引いて会話の範囲に戻す（イベントが来ても state.tabs で重ならない）
      if (state.windows.size) {
        const listed = await cdp.send('Target.getTargets').catch(() => null);
        const targetInfos = Array.isArray(listed?.targetInfos) ? listed.targetInfos : [];
        await Promise.all(targetInfos.filter(info => info?.type === 'page').map(info => onTargetCreated(state, info).catch(() => {})));
        // 持ち越した AI のタブの履歴・人の印から、この Chrome にもう無いタブ（居ない間に閉じた）を除く。一覧を引けなかったときは除かない（ADR 0321）
        if (listed) {
          const alive = new Set(targetInfos.map(info => info?.targetId));
          for (const entry of entries.values()) for (const id of [...entry.ai, ...entry.human]) if (!alive.has(id)) forgetTab(entry, id);
        }
      }
      if (orphans.size) { const ids = new Set(orphans); orphans.clear(); closeWindowTabs(state, ids).catch(() => {}); }
      return state;
    })();
    binding = { cdp, promise };
    promise.catch(() => {}).finally(() => { if (binding?.cdp === cdp) binding = null; });
    return promise;
  }

  /** Chrome に接続済みなら、確認を起こさずに上りをつなぐ（つながっていなければ何もしない） */
  async function bindConnected() {
    if (up || closed || connection.state?.().state !== 'connected') return;
    const cdp = await connection.demand().catch(() => null);
    if (cdp && !closed) await bind(cdp).catch(() => {});
  }

  /**
   * 層が窓を引き継ぐ（readopt の本体）。同時には 1 つだけ流す（層の ready が重なって onReady が続けて呼ばれても、窓ごとの引き継ぎを重ねない）
   */
  let readoptChain = Promise.resolve();
  async function readoptNow() {
    if (closed) return 0;
    // 層が戻ったので、上りがまだなら Chrome の接続につなぐ（更新の直後は層が listen の後でないと付かず、起動時の rejoin の時点では待てない。窓の有無には依らない）
    await bindConnected();
    // Chrome に接続している間に引き継いだ窓の popup は、ここで探して隠す。接続が無ければ、層に引き継げた窓も誰にも戻せない（main が居ない間に Chrome との接続が切れた）ので閉じる
    const lost = await scope.readopt?.({ cdp: up?.cdp ?? null }) ?? [];
    const state = connection.state?.().state;
    // 層が入れ替わっている途中（interrupted）は、閉じる側へ倒さない。層が戻ったときの readopt がもう一度判断する
    if (!lost.interrupted && !up && state !== 'connected' && state !== 'permission') { await scope.closeHidden?.(); carryChanged(); }
    if (!lost.length) return 0;
    // 引き継げなかった窓のタブは閉じる。ただし人が操作している（見せている）窓は閉じない（人の窓。記録だけ捨てる）
    for (const { entryId, windowId, revealed } of lost) { entries.get(entryId)?.windows.delete(windowId); if (!revealed) orphans.add(windowId); }
    // Chrome の接続が既にあれば、その窓のタブを今閉じる（エージェントがつなぐまで、引き継げなかった窓を残さない）。許可の確認は起こさない
    await bindConnected();
    if (up) { const ids = new Set(orphans); orphans.clear(); await closeWindowTabs(up, ids).catch(() => {}); }
    carryChanged();
    return lost.length;
  }

  /** 持ち越した窓の記録・閉じ待ち（orphans）・古いセッションを捨てる。層の隠した窓は閉じる（Chrome が別なら、窓はもう無い） */
  function forgetCarriedWindows(why) {
    log(`chrome-relay: dropped carried windows (${why})`);
    orphans.clear(); staleSessions = [];
    scope.reset?.();
    for (const entry of entries.values()) {
      entry.windows.clear();
      entry.ai = []; entry.human.clear();   // 別の Chrome: 覚えたタブの id は、もう何も指さない
      if (entry.paused) { entry.paused = null; changed(entry); }   // 引き継ぎ中の窓ももう無い
    }
  }

  /** 上りが切れた（Chrome が閉じた・許可の取り消し・切る）。エージェントの接続も閉じる（次の接続でつなぎ直す） */
  function teardown(state) {
    if (up !== state) return;
    up = null;
    for (const off of state.offs) off();
    for (const tab of state.tabs.values()) { tab.controller.abort(); tab.fe = null; }
    callHook('downloads', () => downloads.disconnected());   // 進行中のダウンロードは、結果が分からなくなる
    scope.reset?.(); orphans.clear(); chromeId = null;   // Chrome が閉じた。窓はもう無い（閉じ待ちの windowId も、次の Chrome では別の窓を指す）
    for (const entry of entries.values()) {
      if (!closed) fire(lostListeners, entry.id);   // 窓はもう無い。agent-browser の縛りを捨てさせる（接続はすぐ下で閉じる）
      entry.windows.clear();
      if (entry.paused) { entry.paused = null; changed(entry); }   // Chrome が閉じた。窓はもう無いので、引き継ぎも解く
      // AI のタブの履歴と人の印は残す（Chrome が生きたまま接続だけ切れたなら、つなぎ直しで同じタブが戻る。戻ったタブを adopt が current に戻す）
      entry.current = null; entry.operating = false;
      for (const client of [...entry.clients]) { try { client.ws.close(1011, 'chrome disconnected'); } catch { /* 閉じていてもよい */ } }
      notifyView(entry.id, 'reset');
    }
  }

  /** エージェントの接続が上りを待つ。つながっていなければ接続を求め、connectWaitMs で諦める（Chrome の許可を待つ。agent-browser は 30 秒で読むのをやめる） */
  async function upFor(client) {
    if (up && !up.cdp.closed) return up;
    client.upWait ??= (async () => {
      // ターンの外で呼ばれた（終わったターンの後ろに残った agent-browser など）。人に頼む相手が居ないので、Chrome の確認も出さない
      if (turnLive && !turnLive(client.entry.id)) throw new RelayError('the agent browser (Chrome) is not connected, and cannot ask the user outside of a turn. Try again within a conversation turn');
      const ac = new AbortController();
      client.upAbort = ac;
      let waitingAtGiveUp = null;   // 待ちを外すと試行が止まって off に戻るので、外す直前の状態を覚える
      const timer = setTimeout(() => { waitingAtGiveUp = connection.state?.().state; ac.abort(); }, connectWaitMs);
      // 人の「止める」でこの会話の待ちを外す。ほかに待つ人（設定の「つなぐ」・別の会話）が居なければ、Chrome の確認もすぐ閉じる
      const turn = turnSignal(client.entry.id);
      const onTurnAbort = () => { waitingAtGiveUp = connection.state?.().state; ac.abort(); };
      if (turn?.aborted) onTurnAbort(); else turn?.addEventListener('abort', onTurnAbort, { once: true });
      // 接続を待つあいだ、人に許可を頼むカードを出す。カードは自分の試行を持つので、この待ちが外れても Chrome の確認は出たまま
      try { handoff?.connect(client.entry.id); } catch (error) { log(`chrome: handoff connect failed: ${error?.message ?? error}`); }
      try {
        const cdp = await connection.demand({ signal: ac.signal });
        return await bind(cdp);
      } catch (error) {
        const code = error?.code;
        if (code === 'unsupported') throw new RelayError('the agent browser (Chrome) is not available on this computer');
        if (code === 'declined') throw new RelayError('the user did not allow the connection to Chrome');
        // 失敗の字は、許可を待っているあいだ（A・B）だけ会話の言語。エージェントは hand_to_user を呼んで待つ
        const waiting = waitingAtGiveUp ?? connection.state?.().state;
        const localized = (waiting === 'setup' || waiting === 'permission') && connectWaitText ? connectWaitText(client.entry.id) : null;
        if (localized) throw new RelayError(localized);
        // A（setup）は、Chrome が起動していないか、リモート デバッグがオフ（DevToolsActivePort は Chrome を閉じても残るので見分けない）
        if (waiting === 'setup') throw new RelayError('Chrome is not running, or remote debugging is off in Chrome (waiting for the user). Try again later');
        throw new RelayError('Chrome is not connected yet (waiting for the user to allow remote debugging in Chrome). Try again later');
      } finally { clearTimeout(timer); turn?.removeEventListener('abort', onTurnAbort); client.upWait = null; client.upAbort = null; }
    })();
    return client.upWait;
  }

  // ---- 範囲（会話の窓のタブ） ------------------------------------------------------------------
  function newTab(entry, info, windowId, opener = null) {
    // origin: 主フレームが移り終えた先（中継のセッションの Page.frameNavigated。確認が ON の間だけ持つ）。approved: 確認で許可され、まだ移り終えていない origin
    // gate: 移った後の確認の答えを待つ間、エージェントのこのタブへのコマンドを待たせる（{ promise }）
    return { targetId: info.targetId, entry, info: { ...info }, windowId, opener, internal: null, internalReady: null,
      active: opener?.active ?? false, origin: null, approved: new Set(), commits: 0, gate: null,
      controller: new AbortController(), pending: new Set(), paused: new Map(), denial: null, ops: 0, popupChecked: false,
      fe: null,     // fe: focus emulation 用の中継自身のセッション（{ sessionId, promise }）。ターンの間と、映像を見ている間だけ持つ
      viewFocus: new Set(),   // 映像（view.focus）がこのタブの focus emulation を要る持ち主（映像の見張りごとの札）。ターン（entry.turn）と別の理由で、どちらも無くなったときだけ外す
      focusChain: null };     // focus emulation の付け外しを 1 つずつ流す順番待ち（focusSync）
  }
  const tabsOf = (state, entry) => [...state.tabs.values()].filter(tab => tab.entry === entry);
  const clientsOf = entry => [...entry.clients];
  function addWindow(state, entry, windowId) {
    if (windowId == null || state.windows.has(windowId)) return;
    state.windows.set(windowId, entry);
    entry.windows.add(windowId);
  }

  /** その会話の Chrome の窓を使った（最後に使った時刻。24 時間使われない会話の窓を閉じるのに使う。ADR 0246） */
  function noteUsed(entry) { if (entry) entry.lastUsedAt = now(); }

  /** タブを会話の範囲に入れる。発見中の接続に targetCreated を送り、真似た自動 attach と確認の Fetch を付ける */
  function adopt(state, entry, info, { windowId = null, opener = null, human = false } = {}) {
    if (state.tabs.has(info.targetId)) return state.tabs.get(info.targetId);
    noteUsed(entry);
    const tab = newTab(entry, info, windowId, opener);
    state.tabs.set(tab.targetId, tab);
    addWindow(state, entry, windowId);
    // 人が開いたタブの印（エージェントに知らせる前に付ける。知らせると agent-browser がすぐ attach と準備を送る）。人のタブが開いた popup も人のタブ
    if (human || (opener && entry.human.has(opener.targetId))) markHuman(entry, tab.targetId);
    // ほかの会話の持ち越しに同じ id があれば外す（持ち越しが壊れていても、ほかの会話のタブを AI のタブ・人のタブとして覚え続けない。ADR 0321）
    for (const other of entries.values()) if (other !== entry && (other.ai.includes(tab.targetId) || other.human.has(tab.targetId))) forgetTab(other, tab.targetId);
    // 持ち越した AI のタブがつなぎ直しで戻った・閉じた後の繰り上げ先が戻った
    if (up === state) refreshCurrent(entry);
    // 一時停止中（人が開いたタブなど）は、エージェントの接続に知らせず、エージェントのセッションも付けない
    if (!entry.paused) for (const client of clientsOf(entry)) {
      if (client.discovering) send(client, { method: 'Target.targetCreated', params: { targetInfo: { ...tab.info } } });
      if (client.autoAttach) attachFor(state, client, tab).catch(() => {});
    }
    if (intercepting()) ensureInternal(state, tab).catch(() => {});
    if (wantsFocus(tab)) focusSync(state, tab);
    if (opener) checkPopup(state, tab);
    notifyView(entry.id, 'tabs');
    callHook('tabInfo', () => tabInfo.added(tabHandle(state, tab)));
    callHook('pageBridge', () => pageBridge.added(tabHandle(state, tab)));
    return tab;
  }

  function dropTab(state, tab) {
    if (state.tabs.get(tab.targetId) !== tab) return;
    state.tabs.delete(tab.targetId);
    tab.controller.abort();
    tab.fe = null;   // セッションはタブと一緒に消える
    for (const client of clientsOf(tab.entry)) if (client.discovering) send(client, { method: 'Target.targetDestroyed', params: { targetId: tab.targetId } });
    if (tab.windowId != null && ![...state.tabs.values()].some(other => other.windowId === tab.windowId)) {
      state.windows.delete(tab.windowId);
      tab.entry.windows.delete(tab.windowId);
      scope.windowClosed?.(tab.entry.id, tab.windowId);   // 窓だけ閉じられた。次に使うときに黙って開き直す
    }
    forgetTab(tab.entry, tab.targetId);   // AI のタブだったら、履歴の 1 つ前の開いている AI のタブへ戻る（popup を閉じたら開いた元へ）
    notifyView(tab.entry.id, 'tabs');
    tabGone(tab);
    refreshOperating(tab.entry);
    if (!tab.agentClosed && !tabsOf(state, tab.entry).length) tabsLost(tab.entry);   // 人が窓を閉じた・窓を閉じる操作
  }

  /** エージェントが動かしているタブか（一時停止中と、人の操作のタブ（tab-holder.mjs）は人が動かしているので false。確認にかけるかを決める） */
  const driven = tab => tab.active && !tab.entry.paused && tabHolder.holder?.(tab.entry.id, tab.targetId)?.holder !== 'human';

  /** タブの窓のプロフィールのフォルダー名（'chrome:<dir>' を外す。分からなければ null）。popup の窓を隠すときに渡す */
  const profileDirOfTab = tab => scope.profileOf?.(tab.entry.id, { windowId: tab.windowId, context: tab.info?.browserContextId ?? null })?.replace(/^chrome:/, '') ?? null;

  /** エージェントが選んだ・操作したタブ（Target.activateTarget と CLAIMS のコマンドの宛先）を AI のタブにする（claim。映像が追う。
   *  agent-browser の「今のタブ」は自分の側で持つので、コマンドの宛先から知る）。使った時刻と操作中の印も見直す。下ごしらえのコマンドでは呼ばない（ADR 0321） */
  function touch(tab) {
    const entry = tab.entry;
    noteUsed(entry);
    claim(tab);
    refreshOperating(entry);
  }
  /** AI のタブにする: 人の印を外し、履歴の先頭へ置く（ADR 0321。呼ぶのは CLAIMS のコマンド・Target.activateTarget・エージェントが作ったタブだけ） */
  function claim(tab) {
    const entry = tab.entry, id = tab.targetId;
    const wasHuman = entry.human.delete(id);
    if (entry.ai[0] !== id || wasHuman) {
      entry.ai = [id, ...entry.ai.filter(other => other !== id)].slice(0, AI_HISTORY_MAX);
      carryChanged();
    }
    refreshCurrent(entry);
  }
  function markHuman(entry, id) {
    if (entry.human.has(id)) return;
    entry.human.add(id);
    while (entry.human.size > AI_HISTORY_MAX) entry.human.delete(entry.human.values().next().value);
    carryChanged();
  }
  function forgetTab(entry, id) {
    const had = entry.ai.includes(id) || entry.human.has(id);
    entry.ai = entry.ai.filter(other => other !== id); entry.human.delete(id);
    refreshCurrent(entry);
    if (had) carryChanged();
  }
  /** AI のタブ: 履歴（新しい順）のうち、いま範囲にある最初のタブ。無ければ null */
  const aiTabOf = entry => (up ? entry.ai.find(id => up.tabs.get(id)?.entry === entry) ?? null : null);
  /** 窓に映っているタブ: AI のタブ。AI のタブが無いときだけ窓の最初のタブ */
  const shownTab = entry => (up ? aiTabOf(entry) ?? tabsOf(up, entry)[0]?.targetId ?? null : null);
  /** entry.current（AI のタブ）を履歴から引き直し、替わったら映像に知らせる */
  function refreshCurrent(entry) {
    const next = aiTabOf(entry);
    if (entry.current === next) return;
    entry.current = next;
    notifyView(entry.id, 'current');
  }
  /** 操作中: ターンの間にエージェントがタブを動かしている */
  function refreshOperating(entry) {
    const operating = Boolean(entry.turn && up && tabsOf(up, entry).some(tab => tab.active));
    if (operating === entry.operating) return;
    entry.operating = operating;
    notifyView(entry.id, 'operating');
  }

  async function onTargetCreated(state, info) {
    if (info?.type !== 'page' || state.tabs.has(info.targetId)) return;
    const opener = info.openerId ? (state.tabs.get(info.openerId) ?? state.frameTabs.get(info.openerId) ?? null) : null;
    if (opener) {
      // 範囲のタブが開いたタブ（window.open）。popup の別窓なら、その窓も範囲に足す
      const tab = adopt(state, opener.entry, info, { opener });
      const where = await state.cdp.send('Browser.getWindowForTarget', { targetId: info.targetId }).catch(() => null);
      if (where?.windowId != null && state.tabs.get(tab.targetId) === tab) {
        const isNewWindow = !tab.entry.windows.has(where.windowId);
        tab.windowId = where.windowId; addWindow(state, tab.entry, where.windowId);
        notifyView(tab.entry.id, 'tabs');   // 映像の側がタブの窓を知る（開いた直後は窓が分からない）
        // popup の別窓は画面の左上などに出て前面を取る。同じ置き方（画面の外・透明）を当てる（ADR 0154）
        if (isNewWindow) Promise.resolve(scope.adoptPopup?.({ cdp: state.cdp, entryId: tab.entry.id, windowId: where.windowId, profile: profileDirOfTab(opener) })).catch(() => {});
      }
      return;
    }
    // ほかの経路で会話の窓に入ったタブ（利用者が窓へ移した、など）。会話の窓が 1 つも無ければ見ない（利用者のタブの数だけ問い合わせない）
    if (!state.windows.size) return;
    const where = await state.cdp.send('Browser.getWindowForTarget', { targetId: info.targetId }).catch(() => null);
    const entry = where ? state.windows.get(where.windowId) : null;
    if (entry && up === state && !state.tabs.has(info.targetId)) {
      const fresh = await state.cdp.send('Target.getTargetInfo', { targetId: info.targetId }).catch(() => null);
      if (fresh?.targetInfo && up === state) adopt(state, entry, fresh.targetInfo, { windowId: where.windowId });
    }
  }

  // ---- 上りのイベントの配り分け --------------------------------------------------------------
  function onUpEvent(state, method, params, sessionId) {
    if (sessionId) {
      const rec = state.sessions.get(sessionId);
      if (!rec) return;
      if (rec.own) { rec.own(method, params); return; }   // 映像の中継自身のセッション（view.attach）
      if (!rec.client) { onInternalEvent(state, rec.tab, method, params, sessionId); return; }
      if (method === 'Target.attachedToTarget' && params.sessionId) {
        // セッションの自動 attach（iframe・worker）。子のセッションも同じエージェントの接続のもの
        state.sessions.set(params.sessionId, { client: rec.client, tab: rec.tab, parent: sessionId });
        rec.client.sessions.add(params.sessionId);
      } else if (method === 'Target.detachedFromTarget' && params.sessionId) forgetSession(state, params.sessionId);
      else if (method === 'Fetch.requestPaused' && params.requestId) {
        const paused = rec.client.paused;
        if (paused.size >= PAUSED_LIMIT) paused.delete(paused.keys().next().value);
        paused.set(params.requestId, params.request?.url ?? '');
      }
      // Cookie の値（pleiad_* の Cookie・Set-Cookie の見出し）を除いてから渡す
      const out = filterEvent(rec.tab.entry.id, method, params);
      if (out) send(rec.client, { method, params: out, sessionId });
      return;
    }
    switch (method) {
      case 'Target.targetCreated': onTargetCreated(state, params.targetInfo).catch(() => {}); return;
      case 'Target.targetInfoChanged': {
        const tab = state.tabs.get(params.targetInfo?.targetId);
        if (!tab) return;   // 範囲の外のタブの URL・題は捨てる（覚えない）
        const titled = tab.info.title !== params.targetInfo.title;
        tab.info = { ...params.targetInfo };
        onTabUrl(state, tab);
        if (titled) notifyView(tab.entry.id, 'title');
        callHook('tabInfo', () => tabInfo.changed(tabHandle(state, tab)));
        callHook('pageBridge', () => pageBridge.changed(tabHandle(state, tab)));
        for (const client of clientsOf(tab.entry)) if (client.discovering) send(client, { method, params });
        return;
      }
      case 'Target.targetDestroyed': { const tab = state.tabs.get(params.targetId); if (tab) dropTab(state, tab); return; }
      case 'Target.attachedToTarget': {
        // attach の応答より先に届く。待っている attach（エージェントの接続か中継自身）に結ぶ
        const queue = state.attaching.get(params.targetInfo?.targetId);
        const token = queue?.shift();
        if (queue && !queue.length) state.attaching.delete(params.targetInfo.targetId);
        if (!token || !params.sessionId) return;
        token.sessionId = params.sessionId;
        register(state, params.sessionId, token);
        if (token.client) send(token.client, { method, params });
        return;
      }
      case 'Target.detachedFromTarget': {
        const rec = state.sessions.get(params.sessionId);
        if (!rec) return;
        forgetSession(state, params.sessionId);
        if (rec.client) send(rec.client, { method, params });
        else if (rec.own) rec.own(method, params);
        else if (rec.tab.internal === params.sessionId) { rec.tab.internal = null; rec.tab.internalReady = null; }
        else if (rec.tab.fe?.sessionId === params.sessionId) {
          // Chrome の側で外れた。ターンの間は付け直す（タブが残っていれば）
          const { tab } = rec;
          tab.fe = null;
          if (wantsFocus(tab) && state.tabs.get(tab.targetId) === tab) focusSync(state, tab);
        }
        return;
      }
      case 'Fetch.requestPaused': onBrowserPaused(state, params); return;
      // ダウンロード。会話のタブで始まったものだけを記録する。エージェントの接続には配らない（ADR 0328）
      case 'Browser.downloadWillBegin': onDownloadBegin(state, params); return;
      case 'Browser.downloadProgress': onDownloadProgress(state, params); return;
      default: return;   // ほかのブラウザー全体のイベントは配らない
    }
  }

  // ---- ダウンロード（ADR 0328） ----------------------------------------------------------------
  /** セッションの Page.getFrameTree から、フレームの id を全部読む */
  async function frameIds(send) {
    const tree = await send('Page.getFrameTree', {}).catch(() => null);
    const ids = [];
    const walk = node => { if (node?.frame?.id) ids.push(node.frame.id); for (const child of node?.childFrames ?? []) walk(child); };
    walk(tree?.frameTree);
    return ids;
  }
  /** タブのフレームの id（同じ process の iframe を含む）。確認のセッションがあれば使い、無ければ中継のセッションを付けて読んで外す */
  async function tabFrameIds(state, tab) {
    if (tab.internal) return frameIds((method, params) => state.cdp.send(method, params, tab.internal));
    const own = await ownSession(state, tab, () => {}).catch(() => null);
    if (!own) return [];
    try { return await frameIds(own.send); } finally { own.detach().catch(() => {}); }
  }
  /** cross-site の iframe（別の target）の中のフレームの id。読むだけなので、中継の台帳には載せずに付けて外す（iframe の target には、ほかの attach の待ちが無い） */
  async function iframeFrameIds(state, targetId) {
    const attached = await state.cdp.send('Target.attachToTarget', { targetId, flatten: true }).catch(() => null);
    if (!attached?.sessionId) return [];
    try { return await frameIds((method, params) => state.cdp.send(method, params, attached.sessionId)); }
    finally { state.cdp.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {}); }
  }
  /**
   * ダウンロードの始まったフレーム（Browser.downloadWillBegin の frameId）から、会話のタブを引く。会話のタブで始まったものでなければ null（実機 Chrome 157。ADR 0328）。
   *   - 主フレームのリンク: frameId はタブの targetId
   *   - target=_blank・window.open: 開いてすぐ消えるタブの targetId。開いた知らせ（openerId 付き）が先に届き、範囲に入っている（onTargetCreated）
   *   - cross-site の iframe: iframe の target の id。Target.getTargets の parentFrameId を親へたどる
   *   - 同じ process の iframe: target でないフレームの id。会話のタブ（とその下の cross-site の iframe）の Page.getFrameTree で探す
   */
  async function downloadOwner(state, frameId) {
    if (typeof frameId !== 'string' || !frameId) return null;
    const known = id => state.tabs.get(id) ?? state.frameTabs.get(id) ?? null;
    const direct = known(frameId);
    if (direct) return direct;
    if (!state.tabs.size) return null;   // 会話のタブが無ければ、利用者のダウンロードのたびに問い合わせない
    const info = (await state.cdp.send('Target.getTargetInfo', { targetId: frameId }).catch(() => null))?.targetInfo ?? null;
    if (up !== state) return null;
    if (info?.type === 'page') return known(frameId) ?? (info.openerId ? known(info.openerId) : null);
    if (info && info.type !== 'iframe') return null;
    const listed = await state.cdp.send('Target.getTargets', { filter: [{}] }).catch(() => null);
    if (up !== state) return null;
    const iframes = (listed?.targetInfos ?? []).filter(target => target?.type === 'iframe' && target.targetId);
    const parentOf = new Map(iframes.map(target => [target.targetId, target.parentFrameId ?? null]));
    const owners = new Map();   // target でないフレームの id -> タブ
    const climb = id => {
      for (let hops = 0; hops < 16 && id; hops += 1) {
        const tab = known(id) ?? owners.get(id);
        if (tab) return tab;
        id = parentOf.get(id);
      }
      return null;
    };
    const found = climb(frameId);
    if (found) return found;
    await Promise.all([...new Set(state.tabs.values())].map(async tab => { for (const id of await tabFrameIds(state, tab)) if (!owners.has(id)) owners.set(id, tab); }));
    // 会話のタブの下の cross-site の iframe の中も読む（入れ子の分だけ繰り返す）
    const read = new Set();
    for (let round = 0; round < 3 && up === state; round += 1) {
      const tab = climb(frameId);
      if (tab) return tab;
      const next = iframes.filter(target => !read.has(target.targetId) && climb(target.targetId));
      if (!next.length) return null;
      await Promise.all(next.map(async target => {
        read.add(target.targetId);
        const owner = climb(target.targetId);
        for (const id of await iframeFrameIds(state, target.targetId)) if (!owners.has(id)) owners.set(id, owner);
      }));
    }
    return up === state ? climb(frameId) : null;
  }
  /** 始まったページの URL（list_downloads が返す）。開いてすぐ消えるタブ（target=_blank）は、開いた元のタブの URL */
  function downloadPageUrl(tab, url) {
    const own = tab.info?.url ?? '';
    if (tab.opener && (!own || own === 'about:blank' || own === url)) return tab.opener.info?.url ?? own;
    return own;
  }
  /** CDP の既定の context を引き直す（ダウンロードを止められるのは、そのプロフィールが既定のときだけ）。続けては引かない */
  function refreshDownloadContext(state, force = false) {
    if (up !== state || state.cdp.closed) return;
    if (!force && now() - state.downloadContextAt < DOWNLOAD_CONTEXT_MS) return;
    state.downloadContextAt = now();
    state.cdp.send('Target.getBrowserContexts', {})
      .then(result => { if (up === state) callHook('downloads', () => downloads.setDefaultContext(result?.defaultBrowserContextId ?? null)); }, () => {});
  }
  function onDownloadBegin(state, params) {
    const guid = params?.guid;
    if (typeof guid !== 'string' || !guid || state.downloadOwners.has(guid)) return;
    const pending = { last: null };
    state.downloadOwners.set(guid, pending);
    // 持ち主のタブは、始まりの時点で引く（開いてすぐ消えるタブは、引いている間に範囲から消える）
    downloadOwner(state, params.frameId).catch(() => null).then(tab => {
      state.downloadOwners.delete(guid);
      if (!tab || up !== state) return;   // 利用者自身のダウンロード・ほかの窓のダウンロードは記録しない
      noteUsed(tab.entry);
      callHook('downloads', () => {
        downloads.begin({ sessionId: tab.entry.id, guid, name: params.suggestedFilename, pageUrl: downloadPageUrl(tab, params.url), context: tab.info?.browserContextId ?? null });
        if (pending.last) downloads.progress(pending.last);
      });
      refreshDownloadContext(state, true);
    });
  }
  function onDownloadProgress(state, params) {
    const pending = state.downloadOwners.get(params?.guid);
    if (pending) { pending.last = params; return; }   // 持ち主を引いている途中。引けたら最後のものを渡す
    let known = false;
    callHook('downloads', () => { known = downloads.progress(params) === true; });
    if (known && params.state === 'inProgress') refreshDownloadContext(state);
  }
  /** 人が「ダウンロードを止める」を押した。止まったら、Chrome の canceled の知らせで記録が canceled になる。断られたら（既定でないプロフィール）止められないものとして出し直す */
  async function stopDownload(sessionId, guid) {
    const state = up;
    const record = state && !state.cdp.closed ? downloads.running(sessionId, guid) : null;
    if (!record) return { stopped: false };
    downloads.stopping(guid, true);
    try {
      await state.cdp.send('Browser.cancelDownload', { guid, ...(record.context ? { browserContextId: record.context } : {}) });
      return { stopped: true };
    } catch (error) {
      log(`chrome-relay: download stop failed: ${error?.message ?? error}`);
      downloads.stopping(guid, false);
      refreshDownloadContext(state, true);
      return { stopped: false };
    }
  }

  function register(state, sessionId, { client, tab, own = null }) {
    state.sessions.set(sessionId, { client, tab, parent: null, ...(own ? { own } : {}) });
    if (client) client.sessions.add(sessionId);
  }
  function forgetSession(state, sessionId) {
    const rec = state.sessions.get(sessionId);
    if (!rec) return;
    state.sessions.delete(sessionId);
    rec.client?.sessions.delete(sessionId);
    if (rec.frame && state.frameTabs.get(rec.frame) === rec.tab) state.frameTabs.delete(rec.frame);
    for (const [sid, child] of [...state.sessions]) if (child.parent === sessionId) forgetSession(state, sid);
  }

  /** 上りへ attach（flatten）。セッションは上りの attachedToTarget（応答より先に届く）で結び、届かなければ応答で結ぶ */
  async function attach(state, tab, client, own = null) {
    const token = { client, tab, sessionId: null, own };
    if (!state.attaching.has(tab.targetId)) state.attaching.set(tab.targetId, []);
    state.attaching.get(tab.targetId).push(token);
    let result;
    try { result = await state.cdp.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true }); }
    finally {
      const queue = state.attaching.get(tab.targetId);
      const i = queue?.indexOf(token) ?? -1;
      if (i >= 0) queue.splice(i, 1);
      if (queue && !queue.length) state.attaching.delete(tab.targetId);
    }
    if (!token.sessionId) {
      token.sessionId = result.sessionId;
      register(state, result.sessionId, token);
      if (client) send(client, { method: 'Target.attachedToTarget', params: { sessionId: result.sessionId, targetInfo: { ...tab.info, attached: true }, waitingForDebugger: false } });
    }
    // 待っている間に、エージェントの接続が閉じた・一時停止に入った。付けたセッションは外す（誰にも使われないセッションを Chrome に残さない）
    if (client && (client.closed || client.entry.paused)) {
      forgetSession(state, result.sessionId);
      state.cdp.send('Target.detachFromTarget', { sessionId: result.sessionId }).catch(() => {});
      throw new RelayError(client.entry.paused ? PAUSED_MESSAGE : 'the agent connection is closed');
    }
    return result.sessionId;
  }
  const attachFor = (state, client, tab) => attach(state, tab, client);

  // ---- focus emulation（ADR 0154） ---------------------------------------------------------------
  /**
   * 隠した窓のページに、見えている・フォーカスがあるものとして描かせ、入力を受けさせる（Emulation.setFocusEmulationEnabled）。
   * セッションごとの状態なので、エージェントのセッション（付け外しされる）とは別に、中継自身のセッションを 1 タブにつき 1 本、ターンの間だけ保つ
   */
  function ensureFocusNow(state, tab) {
    if (tab.fe) return tab.fe.promise;
    const fe = { sessionId: null, promise: null };
    tab.fe = fe;
    fe.promise = (async () => {
      const sessionId = await attach(state, tab, null);
      fe.sessionId = sessionId;
      if (tab.fe !== fe) { await detachFocus(state, sessionId); return; }   // つけている間に外された
      await state.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    })().catch(error => {
      if (tab.fe === fe) tab.fe = null;
      log(`chrome-relay: focus emulation failed: ${error?.message ?? error}`);
    });
    return fe.promise;
  }
  async function detachFocus(state, sessionId) {
    if (up !== state) return;
    forgetSession(state, sessionId);
    await state.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId).catch(() => {});
    await state.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
  async function dropFocusNow(state, tab) {
    const fe = tab.fe;
    if (!fe) return;
    tab.fe = null;
    await fe.promise;
    if (fe.sessionId) await detachFocus(state, fe.sessionId);
  }
  /**
   * focus emulation が要る理由は 2 つ: エージェントのターンの間（entry.turn）と、映像を見ている間（tab.viewFocus。view.focus）。
   * Chrome は focus emulation をページに 1 つの状態として持ち、あるセッションが外すと（enabled: false・detach）ほかのセッションが有効にしていても外れる（実機）。
   * だから外すセッションを 1 タブ 1 本（tab.fe）に決め、理由がどちらも無くなったときだけ外す
   */
  const wantsFocus = tab => tab.entry.turn || tab.viewFocus.size > 0;
  /**
   * タブの focus emulation を、そのときの理由（ターン・映像）に合わせる。付け外しは 1 タブにつき 1 つずつ順に流し、流す時に理由を見直す
   * （閉じてすぐ開き直したときに、前の「外す」が後から届いて新しい「付ける」を打ち消さない）
   */
  function focusSync(state, tab) {
    tab.focusChain = (tab.focusChain ?? Promise.resolve()).then(() => {
      if (up !== state || state.tabs.get(tab.targetId) !== tab) return undefined;
      return wantsFocus(tab) ? ensureFocusNow(state, tab) : dropFocusNow(state, tab);
    }).catch(() => {});
    return tab.focusChain;
  }
  /** 会話のタブの focus emulation を、理由（ターン・映像）に合わせる */
  function syncFocus(state, entry) {
    for (const tab of tabsOf(state, entry)) focusSync(state, tab);
  }
  /** 会話のタブの映像の理由を全部手放す（会話を消した・id を付け替えた。映像の見張りは古い id では手放せない） */
  function clearViewFocus(entry) {
    if (!up) return;
    for (const tab of tabsOf(up, entry)) if (tab.viewFocus.size) { tab.viewFocus.clear(); focusSync(up, tab); }
  }

  /** 中継自身のセッションを範囲のタブに付ける（映像と口が使う）。onEvent(method, params) はそのセッションのイベント */
  async function ownSession(state, tab, onEvent) {
    if (up !== state || state.cdp.closed || state.tabs.get(tab.targetId) !== tab) throw new Error('tab not available');
    const cdpSession = await attach(state, tab, null, onEvent);   // 付けた時から、届くイベントを onEvent へ渡す
    return {
      sessionId: cdpSession,
      send: (method, params = {}) => state.cdp.send(method, params, cdpSession),
      async detach() {
        if (up !== state) return;
        forgetSession(state, cdpSession);
        await state.cdp.send('Target.detachFromTarget', { sessionId: cdpSession }).catch(() => {});
      },
    };
  }

  // ---- サイトの利用の確認（Fetch と Page.frameNavigated） ------------------------------------
  /**
   * 確認のために、中継自身のセッションをタブに付ける。Fetch で主フレームの Document の要求を止め、Page.frameNavigated で移り終えた先の origin を持つ。
   * 付ける前に移り終えていた分は Page.getFrameTree で読む
   */
  function ensureInternal(state, tab) {
    tab.internalReady ??= (async () => {
      const sessionId = await attach(state, tab, null);
      tab.internal = sessionId;
      const commits = tab.commits;
      await state.cdp.send('Page.enable', {}, sessionId);
      await state.cdp.send('Fetch.enable', { patterns: internalPatterns() }, sessionId);
      // cross-site の iframe（別の process）の要求は、このセッションの Fetch で止まらない（実機）。子にも Fetch を付けてから走らせる
      if (childPatterns().length) await state.cdp.send('Target.setAutoAttach', CHILD_AUTO_ATTACH, sessionId);
      const tree = await state.cdp.send('Page.getFrameTree', {}, sessionId).catch(() => null);
      if (tab.commits === commits) tab.origin = committedOrigin(tree?.frameTree?.frame);
      await tabCookie(state, sessionId);
      return sessionId;
    })().catch(error => { tab.internalReady = null; throw error; });
    return tab.internalReady;
  }
  function dropInternal(state, tab) {
    for (const resume of [...tab.paused.values()]) resume();
    const sessionId = tab.internal;
    tab.internal = null; tab.internalReady = null; tab.origin = null; tab.approved.clear();
    if (sessionId) { forgetSession(state, sessionId); state.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  }

  /**
   * 確認のセッション（とその子）に自動で付いた子。cross-site の iframe は Fetch で Pleiad の port への要求を止め、孫の iframe にも同じ自動 attach を付けてから走らせる。
   * dedicated worker の要求は、親のページのセッションの Fetch で止まる（実機。worker のセッションに Fetch は無い）ので、走らせるだけ
   */
  function onInternalChild(state, tab, parent, params) {
    const child = params.sessionId;
    if (!child) return;
    const iframe = params.targetInfo?.type === 'iframe';
    const frame = iframe ? params.targetInfo?.targetId ?? null : null;
    state.sessions.set(child, { client: null, tab, parent, child: true, fetch: iframe, ...(frame ? { frame } : {}) });
    if (frame) state.frameTabs.set(frame, tab);   // この iframe から開いたタブ（window.open）も、このタブが開いたものとみなす
    (async () => {
      if (!iframe) return;
      const patterns = childPatterns();
      if (!patterns.length) return;
      await state.cdp.send('Fetch.enable', { patterns }, child);
      await state.cdp.send('Target.setAutoAttach', CHILD_AUTO_ATTACH, child);
    })().catch(error => log(`chrome-relay: child interception failed: ${error?.message ?? error}`))
      .finally(() => { if (params.waitingForDebugger) state.cdp.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {}); });
  }

  /** ブラウザーの単位の Fetch（window.open の最初の要求を止める）を、今の port に合わせる。同じ patterns なら送り直さない */
  function syncBrowserFetch(state) {
    if (up !== state || state.cdp.closed) return;
    const patterns = browserPatterns();
    const key = JSON.stringify(patterns);
    if (state.browserFetch === key) return;
    // つないで最初は先に外す（前のサーバーがこの接続に付けて止めたままの要求を放す。Fetch.enable の付け直しでは放されない）
    const first = state.browserFetch === null;
    state.browserFetch = key;
    const disable = () => state.cdp.send('Fetch.disable', {});
    const sent = !patterns.length ? disable() : (first ? disable().catch(() => {}) : Promise.resolve()).then(() => state.cdp.send('Fetch.enable', { patterns }));
    sent.catch(error => { if (state.browserFetch === key) state.browserFetch = null; log(`chrome-relay: browser interception failed: ${error?.message ?? error}`); });
  }

  /**
   * ブラウザーの単位の Fetch で止めた、Pleiad の port への主フレームの移動。window.open・target=_blank で開いたタブの最初の要求は、
   * 開いた元のタブの Fetch で止まらず、ここで止まる（frameId が開いたタブの targetId。targetCreated が先に届く。実機 Chrome 156）。
   * 会話のタブ（開いた直後で、まだ中継のセッションが付いていないタブを含む）なら移動の検査の口に聞き、ほかのタブ（利用者のタブ）はそのまま通す
   */
  function onBrowserPaused(state, params) {
    const { requestId } = params;
    const settle = verdict => state.cdp.send(verdict === 'block' ? 'Fetch.failRequest' : 'Fetch.continueRequest', verdict === 'block' ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {});
    const decide = tab => {
      if (!tab) return null;
      try { return pagePolicy.request({ sessionId: tab.entry.id, targetId: tab.targetId, url: params.request?.url ?? '', resourceType: params.resourceType ?? null, frameId: params.frameId ?? null }); } catch { return 'block'; }
    };
    const known = state.tabs.get(params.frameId) ?? state.frameTabs.get(params.frameId) ?? null;
    if (known || !params.frameId) { settle(decide(known)); return; }
    // まだ範囲に入っていないタブ（開いた知らせより先に届いた・会話の窓へ後から入るタブ）。開いた元が会話のタブなら、その会話の移動として聞く
    state.cdp.send('Target.getTargetInfo', { targetId: params.frameId })
      .then(result => { const opener = result?.targetInfo?.openerId; return opener ? (state.tabs.get(opener) ?? state.frameTabs.get(opener) ?? null) : null; }, () => null)
      .then(owner => settle(decide(owner ?? state.tabs.get(params.frameId) ?? null)));
  }

  /**
   * port・ページの Cookie が替わった（port は後から決まる）。範囲のタブの中継のセッションの Fetch の patterns・子の自動 attach・ページの Cookie と、
   * ブラウザーの単位の Fetch を今に合わせ、まだ止めていなかったタブにも中継のセッションを付ける
   */
  function refreshInterception(state) {
    if (!state || up !== state || state.cdp.closed) return;
    syncBrowserFetch(state);
    for (const tab of state.tabs.values()) {
      if (!intercepting()) { dropInternal(state, tab); continue; }
      const ready = tab.internalReady;
      if (!ready) { ensureInternal(state, tab).catch(() => {}); continue; }
      ready.then(sessionId => refreshTab(state, tab, sessionId), () => {});
    }
  }
  async function refreshTab(state, tab, sessionId) {
    if (up !== state || tab.internal !== sessionId) return;
    const kids = childPatterns();
    await state.cdp.send('Fetch.enable', { patterns: internalPatterns() }, sessionId).catch(() => {});
    await state.cdp.send('Target.setAutoAttach', { ...CHILD_AUTO_ATTACH, autoAttach: kids.length > 0 }, sessionId).catch(() => {});
    for (const [child, rec] of [...state.sessions]) {
      if (rec.tab !== tab || !rec.child || !rec.fetch) continue;
      state.cdp.send(kids.length ? 'Fetch.enable' : 'Fetch.disable', kids.length ? { patterns: kids } : {}, child).catch(() => {});
    }
    await tabCookie(state, sessionId);
  }

  function ask(tab, url) {
    const signal = tab.controller.signal;
    const profile = scope.profileOf?.(tab.entry.id, { windowId: tab.windowId, context: tab.info?.browserContextId ?? null }) ?? null;
    const work = Promise.resolve().then(() => authorize({ sessionId: tab.entry.id, url, profile }, signal)).then(answer => answer ?? { allow: false }, () => ({ allow: false }));
    tab.pending.add(work);
    work.finally(() => tab.pending.delete(work));
    return work;
  }
  /** 答えを待つ間、エージェントのこのタブへのコマンドを待たせる（then は答えの後の始末。済むまで待たせる） */
  function hold(tab, work, then) {
    const gate = {};
    tab.gate = gate;
    gate.promise = work.then(then).catch(() => {}).finally(() => { if (tab.gate === gate) tab.gate = null; });
  }

  /** 中継自身のセッション（確認・focus emulation）と、確認のセッションの子（iframe・worker）のイベント。sessionId はイベントが届いたセッション */
  function onInternalEvent(state, tab, method, params, sessionId) {
    if (method === 'Target.attachedToTarget') { onInternalChild(state, tab, sessionId, params); return; }
    if (method === 'Target.detachedFromTarget') { if (params.sessionId && state.sessions.get(params.sessionId)?.parent === sessionId) forgetSession(state, params.sessionId); return; }
    if (method === 'Page.frameNavigated') { if (sessionId === tab.internal && params.frame && !params.frame.parentId) onCommit(state, tab, params.frame); return; }
    if (method !== 'Fetch.requestPaused') return;
    const { requestId } = params;
    const key = `${sessionId}:${requestId}`;   // requestId はセッションごとの番号（子のセッションと重なりうる）
    let settled = false;
    const resume = () => { if (settled) return; settled = true; tab.paused.delete(key); state.cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {}); };
    const block = () => { if (settled) return; settled = true; tab.paused.delete(key); state.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {}); };
    tab.paused.set(key, Object.assign(resume, { block }));
    // 移動の検査の口（既定は何も止めない）。口が投げたら止める
    let verdict;
    try { verdict = pagePolicy.request({ sessionId: tab.entry.id, targetId: tab.targetId, url: params.request?.url ?? '', resourceType: params.resourceType ?? null, frameId: params.frameId ?? null }); } catch { verdict = 'block'; }
    if (verdict === 'block') { block(); return; }
    // 主フレームの Document の要求だけを聞く（iframe・サブリソースは聞かない。確認はトップフレームの移動の単位。口の patterns が足したほかの要求も聞かない）
    if (!confirm || sessionId !== tab.internal || params.frameId !== tab.targetId || params.resourceType !== 'Document') { resume(); return; }
    // 新しい移動（リダイレクトでない）なら、前の移動で許可して移り終えなかった分は捨てる
    if (!params.redirectedRequestId) tab.approved.clear();
    const url = params.request?.url ?? '';
    const origin = originOf(url);
    // エージェントが動かしていないタブ（人の操作）・移り終えた今の origin と同じ・この移動で許可済みは聞かない
    if (!driven(tab) || !origin || origin === tab.origin || tab.approved.has(origin)) { resume(); return; }
    ask(tab, url).then(answer => {
      if (!confirm) { resume(); return; }
      if (answer.allow && !tab.controller.signal.aborted) { tab.approved.add(origin); resume(); return; }
      deny(tab, answer);
      block();
    });
  }

  /**
   * 主フレームが移り終えた。今の origin を替え、確認を通っていない別の origin へ移った（要求を出さない履歴の移動・bfcache の復元など）なら、
   * 移った後に聞き、断られたら about:blank に戻す
   */
  function onCommit(state, tab, frame) {
    tab.commits += 1;
    const previous = tab.origin;
    const origin = committedOrigin(frame);
    const approved = Boolean(origin) && tab.approved.has(origin);
    tab.origin = origin;
    tab.approved.clear();
    if (!origin || origin === previous || approved || !confirm || !driven(tab)) return;
    if (tab.opener && !tab.popupChecked) { checkPopup(state, tab, origin, frame.url ?? ''); return; }
    hold(tab, ask(tab, frame.url ?? origin), async answer => {
      if (state.tabs.get(tab.targetId) !== tab || tab.origin !== origin || !confirm) return;   // 閉じた・もう別の所へ移った・OFF にした
      if (answer.allow && !tab.controller.signal.aborted) return;
      deny(tab, answer);
      if (up === state && tab.internal) await state.cdp.send('Page.navigate', { url: 'about:blank' }, tab.internal, { timeoutMs: commandTimeoutMs }).catch(() => {});
    });
  }

  /** タブの URL が替わった（targetInfoChanged）。window.open のタブは最初の要求の後に聞く */
  function onTabUrl(state, tab) {
    if (tab.opener) checkPopup(state, tab);
  }

  /** window.open で開いたタブ（最初の要求は Fetch で止められない）。開いた後に聞き、断られたら閉じる */
  function checkPopup(state, tab, origin = originOf(tab.info.url), url = tab.info.url) {
    if (tab.popupChecked || !confirm || !driven(tab.opener)) return;
    if (!origin) return;   // まだ about:blank。URL が付いたら聞く
    tab.popupChecked = true;
    // 聞いている間の origin はこれとみなす（後から届く frameNavigated で二度聞かない。断られたらタブを閉じる）
    tab.origin = origin;
    const opener = tab.opener;
    if (origin === opener.origin) return;
    hold(tab, ask(tab, url), answer => {
      if (state.tabs.get(tab.targetId) !== tab) return;   // 先に閉じられた
      if (answer.allow && !tab.controller.signal.aborted) return;
      deny(opener, answer);
      if (up === state) return state.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    });
  }

  /** 断られた。そのときの最後の操作のコマンド（ops の番号）に返す文として覚える */
  function deny(tab, answer) { tab.denial = { message: answer.message || deniedMessage(), op: tab.ops }; }
  /**
   * 操作のコマンド（op 番）の応答のときに、そのタブの確認がまだ済んでいなければ待ち、その操作の後に断られていれば断られた文を返す（内蔵ブラウザーと同じ）。
   * 前の操作の断りは返さない（並んで送られた操作の片方が、ほかの操作の断りを取らないように）
   */
  async function settleApprovals(tab, op) {
    await new Promise(resolve => setImmediate(resolve));
    while (tab.pending.size || tab.gate) await Promise.all([...tab.pending, tab.gate?.promise]);
    const denial = tab.denial;
    if (!denial || denial.op < op) return null;
    tab.denial = null;
    return denial.message;
  }
  // ---- エージェントの接続 ------------------------------------------------------------------------
  function send(client, message) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(message));
  }

  function attachClient(entry, ws) {
    const client = { entry, ws, sessions: new Set(), paused: new Map(), discovering: false, autoAttach: false, upWait: null, upAbort: null, closed: false };
    entry.clients.add(client);
    ws.on('message', raw => { void onMessage(client, raw); });
    ws.on('error', () => {});
    ws.on('close', () => {
      client.closed = true;
      entry.clients.delete(client);
      client.upAbort?.abort();
      const state = up;
      if (!state) return;
      // この接続が attach したセッションを上りで外す（上りの接続は残るので、外さないと Chrome にセッションが残る）
      for (const sessionId of [...client.sessions]) {
        const rec = state.sessions.get(sessionId);
        if (!rec || rec.client !== client) continue;
        const top = rec.parent == null;
        forgetSession(state, sessionId);
        if (top) state.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    });
  }

  async function onMessage(client, raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const { id, method, params = {}, sessionId } = message ?? {};
    if (!Number.isInteger(id) || typeof method !== 'string') return;
    if (client.entry.stopped) { try { client.ws.close(1008, 'stopped'); } catch { /* 閉じていてもよい */ } return; }
    const reply = body => send(client, { id, ...body, ...(sessionId ? { sessionId } : {}) });
    if (client.entry.paused) { reply({ error: { code: -32000, message: PAUSED_MESSAGE } }); return; }   // 引き継ぎ中は全部断る（接続は切らない）
    noteUsed(client.entry);
    try {
      const state = await upFor(client);
      if (client.closed) return;
      if (client.entry.paused) throw new RelayError(PAUSED_MESSAGE);   // 待っている間に引き継がれた
      const result = sessionId ? await sessionCommand(state, client, method, params ?? {}, sessionId) : await browserCommand(state, client, method, params ?? {});
      reply({ result: result ?? {} });
    } catch (error) {
      reply({ error: { code: Number.isInteger(error?.code) ? error.code : -32000, message: String(error?.message ?? error) } });
    }
  }

  function mine(state, client, targetId) {
    const tab = state.tabs.get(targetId);
    if (!tab || tab.entry !== client.entry) throw denied('target');
    return tab;
  }

  async function sessionCommand(state, client, method, params, sessionId) {
    const rec = state.sessions.get(sessionId);
    if (!rec || rec.client !== client) throw denied('session');
    const tab = rec.tab;
    // 待ち（確認・準備）の後に送る前に、もう一度一時停止と接続を見る。待っている間に人が引き継いだのに、後ろに並んだコマンドが届かないように
    const live = () => {
      if (client.entry.paused) throw new RelayError(PAUSED_MESSAGE);
      if (client.closed || state.cdp.closed) throw new RelayError('the agent connection is closed');
    };
    if (method.startsWith('Target.') && method !== 'Target.setAutoAttach') throw denied('browser command');
    if (DOWNLOAD_COMMANDS.has(method)) throw downloadDenied(client);
    if (SESSION_DENIED.has(method) || SESSION_DENIED_DOMAINS.some(prefix => method.startsWith(prefix))) throw denied('browser command');
    let forward = params;
    if (method === 'Page.navigate' && !allowUrl(params.url, { sessionId: client.entry.id, via: 'navigate' })) throw denied('navigation');
    // ページからの頼みと入力欄の位置の binding は中継のものだけ。エージェントが同じ名前を足すと、ページの頼みの中身を横から受け取れる（どのタブでも断る）
    if ((method === 'Runtime.addBinding' || method === 'Runtime.removeBinding') && RESERVED_BINDINGS.has(params.name)) throw denied('binding');
    // 操作の前の門（core/chrome/tab-holder.mjs）。コマンド全部を通す: 人の操作のタブでは読むだけのもの（通してよい一覧）のほかを断る。
    // 一時停止の間は全部断る（上の live と同じ）。待ちの後、送る直前にもう一度見る
    const operates = OPERATES.test(method);
    const held = () => {
      const message = tabHolder.gate({ sessionId: client.entry.id, targetId: tab.targetId, method, paused: client.entry.paused, operates });
      if (message) throw new RelayError(message);
    };
    held();
    // エージェントの Fetch で止めた要求の url の差し替えは、同じ origin の中だけ（ほかの origin へ送り先を替えると、確認を通らずに届く）
    if (method === 'Fetch.continueRequest') {
      const original = client.paused.get(params.requestId);
      if (params.url !== undefined && (!originOf(params.url) || originOf(params.url) !== originOf(original ?? ''))) throw denied('request url');
      client.paused.delete(params.requestId);
    } else if (method === 'Fetch.failRequest' || method === 'Fetch.fulfillRequest') client.paused.delete(params.requestId);
    // エージェントが動かしているタブの印（人の操作と区別する。ターンの終わりで外れる）。人が開いたタブは、許可の一覧（CLAIMS）のコマンドだけ数える
    const claims = CLAIMS.test(method);
    if (!PASSIVE.test(method) && (claims || !client.entry.human.has(tab.targetId))) {
      tab.active = true; noteUsed(client.entry);
      if (claims) claim(tab);   // AI のタブを移すのは、エージェントがこのタブを相手に選んだと分かるコマンドだけ（準備のコマンドでは移さない）
      refreshOperating(client.entry);
    }
    // 移った後の確認の答えを待つ間は、このタブへのコマンドを待たせる（断られたページを読ませない）
    while (tab.gate) await tab.gate.promise;
    live();
    // 窓を前に出して前面を取る命令は、Chrome へ送らずに成功で返す。agent-browser の「今のタブ」は自分の側で持つので操作は変わらず、
    // 隠した窓は前面を取らない。前に出すのは人が引き継いだときの Pleiad だけ（ADR 0154）
    if (method === 'Page.bringToFront') return {};
    // Cookie は今のページのものだけ（ほかのサイトのログインを読む・消す・植えるのを防ぐ）
    if (method === 'Network.getCookies') forward = {};
    if (COOKIE_WRITES.has(method)) {
      // 確認が ON なら、移り終えた今の origin のホスト（断った先のエラーのページは、どのホストでもない）
      if (confirm) { await ensureInternal(state, tab); live(); }
      const host = confirm ? hostOf(tab.origin ?? '') : hostOf(tab.info.url);
      const list = method === 'Network.setCookies' ? (Array.isArray(params.cookies) ? params.cookies : []) : [params];
      const domainOk = value => { const domain = value.replace(/^\./, ''); return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`)); };
      // url と domain は、渡されたものを全部見る（Chrome は domain を url より優先して使うことがある）
      const ok = cookie => {
        if (!host || !cookie || (cookie.url == null && cookie.domain == null)) return false;
        if (cookie.url != null && hostOf(cookie.url) !== host) return false;
        if (cookie.domain != null && (typeof cookie.domain !== 'string' || !domainOk(cookie.domain))) return false;
        return true;
      };
      if (!list.length || !list.every(ok)) throw denied('cookie');
    }
    // ファイルのページへ移す前に、タブのセッションでページの Cookie を入れる（既定の context でないプロフィールのタブ）
    if (method === 'Page.navigate' && wantsCookie(params.url)) { const internal = await ensureInternal(state, tab); live(); await tabCookie(state, internal); live(); }
    // コマンドの前のふるい（既定は素通し）
    forward = await pagePolicy.before({ sessionId: client.entry.id, targetId: tab.targetId, method, params: forward });
    const op = operates ? ++tab.ops : 0;
    if (operates) {
      // 確認を ON にした直後でも、中継のセッションの準備（Page と Fetch）が済むまで移動を待たせる
      if (confirm) await ensureInternal(state, tab);
    }
    live();   // 送る直前（この後は await を挟まない）
    held();
    const commits = tab.commits;
    let result = await state.cdp.send(method, forward, sessionId, { timeoutMs: commandTimeoutMs });
    // コマンドの後のふるい（既定は素通し）
    result = await pagePolicy.after({ sessionId: client.entry.id, targetId: tab.targetId, method, params: forward, result });
    // 押した位置（右パネルの輪）。座標だけで、URL・題は渡さない
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && Number.isFinite(params.x) && Number.isFinite(params.y)) {
      fire(tapListeners, { sessionId: tab.entry.id, x: params.x, y: params.y, windowId: tab.windowId });
    }
    if (operates && confirm) {
      // 履歴の移動は要求を出さないこと（bfcache）があり、応答が移り終える前に返る。移り終えるのを少し待ってから答えを見る
      if (method === 'Page.navigateToHistoryEntry') await commitAfter(tab, commits, HISTORY_COMMIT_WAIT_MS);
      const message = await settleApprovals(tab, op);
      if (message) throw new RelayError(message);
    }
    return result;
  }

  /** タブの主フレームが commits の後にもう一度移り終えるのを、ms まで待つ */
  async function commitAfter(tab, commits, ms) {
    const end = Date.now() + ms;
    while (tab.commits === commits && Date.now() < end && !tab.controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
  }

  /** ダウンロードの命令を断る（保存先はエージェントに決めさせない。ADR 0328）。文は会話の言語で、押して始める・list_downloads で確かめる、を案内する */
  function downloadDenied(client) {
    let text = null;
    try { text = downloadDeniedText?.(client.entry.id) ?? null; } catch { /* 文が引けなければ固定の字 */ }
    return new RelayError(typeof text === 'string' && text ? text : 'browser command denied');
  }

  async function browserCommand(state, client, method, params) {
    if (DOWNLOAD_COMMANDS.has(method)) throw downloadDenied(client);
    if (!BROWSER_ALLOWED.has(method)) throw denied('browser command');
    const entry = client.entry;
    switch (method) {
      case 'Browser.getVersion': return state.cdp.send(method, {});
      case 'Target.getBrowserContexts': return { browserContextIds: [] };
      case 'Target.setDiscoverTargets':
        client.discovering = params.discover === true;
        if (client.discovering) for (const tab of tabsOf(state, entry)) send(client, { method: 'Target.targetCreated', params: { targetInfo: { ...tab.info } } });
        return {};
      case 'Target.setAutoAttach':
        // ブラウザー全体の自動 attach は上りへ送らない（利用者の全タブに attach するため）。範囲のタブにだけ attach して真似る
        client.autoAttach = params.autoAttach === true;
        if (client.autoAttach) queueMicrotask(() => { for (const tab of tabsOf(state, entry)) if (![...client.sessions].some(sid => state.sessions.get(sid)?.tab === tab && state.sessions.get(sid)?.parent == null)) attachFor(state, client, tab).catch(() => {}); });
        return {};
      case 'Target.getTargets': {
        const targetInfos = tabsOf(state, entry).map(tab => ({ ...tab.info }));
        // つないで最初にタブを探して 1 枚も無かった。次に作る空のタブは agent-browser の置き場（createTab の spare）
        if (!client.created) client.placeholder = !targetInfos.length;
        return { targetInfos };
      }
      case 'Target.getTargetInfo': {
        if (!params.targetId) throw denied('target');
        mine(state, client, params.targetId);
        return state.cdp.send(method, { targetId: params.targetId });
      }
      // つなぐだけでは AI のタブにしない（agent-browser は範囲のタブ全部につなぐ。CLAIMS の説明）
      case 'Target.attachToTarget': { const tab = mine(state, client, params.targetId); noteUsed(entry); return { sessionId: await attachFor(state, client, tab) }; }
      case 'Target.detachFromTarget': {
        const rec = state.sessions.get(params.sessionId);
        if (!rec || rec.client !== client) throw denied('session');
        return state.cdp.send(method, { sessionId: params.sessionId });
      }
      case 'Target.closeTarget': {
        const tab = mine(state, client, params.targetId);
        // 人の操作のタブは閉じさせない（ADR 0296 の 1）
        if (tabHolder.holder?.(entry.id, tab.targetId)?.holder === 'human') throw new RelayError(HUMAN_MESSAGE);
        tab.agentClosed = true;
        return state.cdp.send(method, { targetId: params.targetId });
      }
      // bringToFront と同じ（明示の切り替え。AI のタブにする）。範囲の外の targetId は断る（mine）。
      case 'Target.activateTarget': {
        const tab = mine(state, client, params.targetId);
        if (!entry.paused) touch(tab);   // 一時停止の間はエージェントのコマンドで何も移さない
        return {};
      }
      case 'Browser.getWindowForTarget': {
        if (!params.targetId) throw denied('target');
        mine(state, client, params.targetId);
        return state.cdp.send(method, { targetId: params.targetId });
      }
      case 'Browser.getWindowBounds':
      case 'Browser.setContentsSize':
        if (!entry.windows.has(params.windowId)) throw denied('window');
        // 人の操作のタブのある窓の大きさは変えさせない（人の見ているページの大きさが変わる）
        if (method === 'Browser.setContentsSize' && tabsOf(state, entry).some(tab => tab.windowId === params.windowId && tabHolder.holder?.(entry.id, tab.targetId)?.holder === 'human')) throw new RelayError(HUMAN_MESSAGE);
        return state.cdp.send(method, params);
      case 'Target.createTarget': return { targetId: await createTab(state, client, params) };
      default: throw denied('browser command');
    }
  }

  /** Target.createTarget を真似る。context・窓の指定は信じず、会話の窓（scope）に作る。確認が ON なら、移動は確認を通してから */
  async function createTab(state, client, params) {
    const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
    if (!allowUrl(url, { sessionId: client.entry.id, via: 'create' })) throw denied('navigation');
    const entry = client.entry;
    // agent-browser はつないだとき会話にタブが無いと（Target.getTargets が空）空のタブを 1 つ作り、--pin-tab の縛りが無ければ続けて自分のタブを作る。
    // タブごとに窓が分かれるので、最初の空のタブが空の窓として残る。同じ接続が次のタブを作ったら、まだ何も載せていないその空のタブを閉じる。
    // タブを探さずに作ったタブ（エージェントが自分で並べたタブ）は閉じない
    const spare = client.spare;
    client.spare = null;
    const first = client.placeholder === true && !client.created && url === 'about:blank' && !tabsOf(state, entry).length;
    client.created = true;
    // ファイルのページは、空のタブで開いてタブのセッションで Cookie を入れてから移す（既定の context でないプロフィールの窓）
    const cookieFirst = wantsCookie(url);
    const direct = url === 'about:blank' || (!confirm && !cookieFirst);
    if (url !== 'about:blank') await prepareOpen(state, entry.id, url);
    const { targetId, windowId } = await scope.openTab({ cdp: state.cdp, url: direct ? url : 'about:blank', entryId: entry.id });
    const fresh = await state.cdp.send('Target.getTargetInfo', { targetId }).catch(() => null);
    const tab = adopt(state, entry, fresh?.targetInfo ?? { targetId, type: 'page', title: '', url: 'about:blank', attached: false, canAccessOpener: false }, { windowId });
    // 窓を作っている間に引き継がれた。作った窓（隠れた about:blank）は閉じ、エージェントには断りを返す（移動もしない）
    const stillLive = () => !entry.paused && !client.closed && !state.cdp.closed;
    if (!stillLive()) { state.cdp.send('Target.closeTarget', { targetId }).catch(() => {}); throw new RelayError(entry.paused ? PAUSED_MESSAGE : 'the agent connection is closed'); }
    tab.active = true;   // エージェントが作ったタブ
    touch(tab);
    if (first) client.spare = targetId;
    else if (spare) {
      const blank = state.tabs.get(spare);
      if (blank?.entry === entry && blank.info.url === 'about:blank') {
        blank.agentClosed = true;
        state.cdp.send('Target.closeTarget', { targetId: spare }).catch(() => {});
      }
    }
    if (direct) return targetId;
    const op = ++tab.ops;
    try {
      const sessionId = await ensureInternal(state, tab);
      if (cookieFirst) await tabCookie(state, sessionId);
      if (!stillLive()) throw new RelayError(entry.paused ? PAUSED_MESSAGE : 'the agent connection is closed');
      const result = await state.cdp.send('Page.navigate', { url }, sessionId, { timeoutMs: commandTimeoutMs });
      if (result?.errorText) {
        const message = (tab.denial?.op >= op && tab.denial.message) || result.errorText;
        tab.denial = null;
        throw new RelayError(message);
      }
    } catch (error) {
      state.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      throw error;
    }
    return targetId;
  }

  // ---- 公開 ------------------------------------------------------------------------------------
  function listenOn(port) {
    return new Promise((resolve, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(server.address()); });
    });
  }
  function ensureListening() {
    listening ??= listenOn(0).then(value => { address = value; return value; }, error => { listening = null; throw error; });
    return listening;
  }
  function closeClients(entry, code, reason) {
    for (const client of [...entry.clients]) { try { client.ws.close(code, reason); } catch { /* 閉じていてもよい */ } }
  }
  /**
   * 会話のタブが、エージェントが閉じたのでなく全部無くなった。agent-browser（--pin-tab）の縛りの記録を聞き手に先に消させ（同期）、消したら接続を切る。
   * デーモンは消えたタブの縛りを覚えたままなので、接続を切らないと記録を消しても tab_gone が続く（つなぎ直すときに記録を読み直す）。
   * 縛りが無ければ接続は切らない（窓が閉じてもエージェントの接続は生きている。次に使うときに黙って開き直す）
   */
  function tabsLost(entry) {
    let unpinned = false;
    for (const fn of [...lostListeners]) {
      try { if (fn(entry.id) === true) unpinned = true; } catch (error) { log(`chrome-relay: listener failed: ${error?.message ?? error}`); }
    }
    if (unpinned) closeClients(entry, 1000, 'tabs lost');
  }
  /**
   * 引き継ぎ（一時停止）に入る: エージェントのブラウザーとタブの接続を切り、タブを「エージェントが動かしている」と見なさなくし（確認の待ちも取り下げる）、
   * 走っているスクリプトを止める。接続を切るので、Chrome からの通知（Network.requestWillBeSent の postData・Fetch.requestPaused など）はエージェントへ流れず、
   * エージェントが付けていた Fetch の横取りもセッションごと外れる（人のページが固まらない）。戻した後は agent-browser がつなぎ直す
   */
  /** 会話のタブの確認の待ちを取り下げ、エージェントが動かしている印を外す（ターンの終わり・止める） */
  function settleEntry(entry) {
    const wasTurn = entry.turn;
    entry.turn = false;   // ターンが終わった（止める・消す）。focus emulation を外す
    if (wasTurn) changed(entry);
    if (!up) { refreshOperating(entry); return; }
    for (const tab of tabsOf(up, entry)) {
      tab.active = false; tab.approved.clear(); tab.denial = null;
      tab.controller.abort(); tab.controller = new AbortController();
    }
    syncFocus(up, entry);
    refreshOperating(entry);
  }

  return {
    /** 会話の端点。unlock（人の送信で始まったターン）なら、止めた会話を新しい鍵で開け直す */
    async endpoint(sessionId, { unlock = false } = {}) {
      if (closed) throw new Error('relay closed');
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('invalid session');
      await ensureListening();
      let entry = entries.get(sessionId);
      if (!entry) { entry = { id: sessionId, key: random(), stopped: invalidCarry && !unlock, clients: new Set(), windows: new Set(), turn: false, current: null, ai: [], human: new Set(), operating: false, lastUsedAt: now() }; entries.set(sessionId, entry); byKey.set(entry.key, entry); carryChanged(); }
      noteUsed(entry);
      if (unlock) { this.resume(sessionId); invalidCarry = false; }   // 人が送った: 無効だった預かり物の代わりに、ここから始める
      // 端点を渡すのはターンの始まり（core/agent-browser.mjs の browserEnvironment）。ターンの間、窓のタブに focus emulation を保つ
      if (!entry.stopped && !entry.turn) { entry.turn = true; changed(entry); if (up) syncFocus(up, entry); }
      return `ws://127.0.0.1:${address.port}/devtools/browser/${entry.key}`;
    },
    /**
     * 人が右パネルのアドレス欄の新しいタブから、会話の窓に URL を開く（browser.chromeNavigate の action: new）。エージェントには知らせない（タブは範囲に入るので、次の tab list で見える）。
     * 会話の記録が無ければ作る（ターンは始めない）。接続が無ければ Chrome の許可を待つ（接続の案内のカードは出さない。signal で待ちをやめる）。
     * 人が開くので、サイトの利用の確認は通さない。開いたタブを今のタブにする（右パネルの映像が追う）
     */
    async openForConversation(sessionId, url, { signal } = {}) {
      if (closed) throw new Error('relay closed');
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('invalid session');
      if (typeof url !== 'string' || !/^https?:/i.test(url) || !allowUrl(url, { sessionId, via: 'open' })) throw denied('navigation');
      await ensureListening();
      let entry = entries.get(sessionId);
      if (!entry) { entry = { id: sessionId, key: random(), stopped: false, clients: new Set(), windows: new Set(), turn: false, current: null, ai: [], human: new Set(), operating: false, lastUsedAt: now() }; entries.set(sessionId, entry); byKey.set(entry.key, entry); }
      noteUsed(entry);
      const state = up && !up.cdp.closed ? up : await bind(await connection.demand({ signal }));
      await prepareOpen(state, entry.id, url);
      // ファイルのページは、空のタブで開いてタブのセッションで Cookie を入れてから移す（既定の context でないプロフィールの窓）
      const cookieFirst = wantsCookie(url);
      const { targetId, windowId } = await scope.openTab({ cdp: state.cdp, url: cookieFirst ? 'about:blank' : url, entryId: entry.id });
      const fresh = await state.cdp.send('Target.getTargetInfo', { targetId }).catch(() => null);
      const tab = adopt(state, entry, fresh?.targetInfo ?? { targetId, type: 'page', title: '', url: cookieFirst ? 'about:blank' : url, attached: false, canAccessOpener: false }, { windowId, human: true });
      // 人が開いたタブは「AI のタブ」にしない（人の印を付ける。エージェントが CLAIMS のコマンドで明示に操作したときだけ AI のタブになる。ADR 0321）
      noteUsed(entry); refreshOperating(entry);
      if (cookieFirst) {
        const sessionId = await ensureInternal(state, tab);
        await tabCookie(state, sessionId);
        await state.cdp.send('Page.navigate', { url }, sessionId, { timeoutMs: commandTimeoutMs });
      }
      return { targetId };
    },
    /** 止める: 接続を閉じ、次の人の送信（resume）まで再接続を断る */
    stop(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.stopped = true;
      settleEntry(entry);
      closeClients(entry, 1000, 'stopped');
      changed(entry);
    },
    resume(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry || !entry.stopped) return;
      byKey.delete(entry.key);
      entry.key = random();
      byKey.set(entry.key, entry);
      entry.stopped = false;
      changed(entry);
    },
    /**
     * 引き継いでいる間に人が窓を作り替えた（タブを引き離して新しい窓にした・窓ごと閉じた）のを、戻す前に取り込む: タブごとの今の窓を引き直し、
     * 新しい窓は範囲に足して（scope.adoptPopup。引き継ぎ中は記録だけで、戻すときに探して隠す）、タブの無くなった窓の記録は捨てる
     */
    async refreshWindows(sessionId) {
      const entry = entries.get(sessionId);
      const state = up;
      if (!entry || !state) return;
      const tabs = tabsOf(state, entry);
      const seen = new Set();
      let answered = 0;
      for (const tab of tabs) {
        const where = await state.cdp.send('Browser.getWindowForTarget', { targetId: tab.targetId }).catch(() => null);
        if (up !== state) return;
        if (!where || where.windowId == null) continue;
        answered += 1;
        seen.add(where.windowId);
        if (where.windowId === tab.windowId) continue;
        tab.windowId = where.windowId;
        const isNew = !entry.windows.has(where.windowId);
        addWindow(state, entry, where.windowId);
        if (isNew) await scope.adoptPopup?.({ cdp: state.cdp, entryId: entry.id, windowId: where.windowId, profile: profileDirOfTab(tab) });
      }
      if (answered !== tabs.length) return;   // 引けないタブがあれば、窓の記録は捨てない
      for (const windowId of [...entry.windows]) {
        if (seen.has(windowId)) continue;
        entry.windows.delete(windowId); state.windows.delete(windowId);
        scope.windowClosed?.(entry.id, windowId);
      }
    },
    /** 一時停止を解く。解く前の始まりの時刻を返す（一時停止でなければ null） */
    unpause(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry?.paused) return null;
      const { at } = entry.paused;
      entry.paused = null;
      noteUsed(entry);
      changed(entry);
      return at;
    },
    /** 会話の今の状態。会話が中継に無ければ null。lastWindowId は、窓に映っているタブ（AI のタブ。無ければ窓の最初のタブ）の窓（引き継ぎで前に出す窓） */
    state(sessionId) {
      const entry = entries.get(sessionId);
      return entry ? { turn: entry.turn, stopped: entry.stopped, paused: entry.paused ? { ...entry.paused } : null, lastWindowId: up?.tabs.get(shownTab(entry))?.windowId ?? null } : null;
    },
    /** その会話で Chrome の窓を最後に使った時刻（ms）。中継に無ければ null（ADR 0246 の 24 時間の掃除） */
    lastUsed(sessionId) { const entry = entries.get(sessionId); return Number.isFinite(entry?.lastUsedAt) ? entry.lastUsedAt : null; },
    /** 窓の作り方（core/chrome/windows.mjs。control が引き継ぎで窓を見える形に戻す・隠し直すのに使う） */
    get scope() { return scope; },
    get cdp() { return up && !up.cdp.closed ? up.cdp : null; },
    onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
    onTap(fn) { tapListeners.add(fn); return () => tapListeners.delete(fn); },
    onTabsLost(fn) { lostListeners.add(fn); return () => lostListeners.delete(fn); },
    /** 新しい会話の id が決まった（turn.key → 本物の id） */
    rebind(from, to) {
      const entry = entries.get(from);
      if (!entry || entries.has(to)) return;
      entries.delete(from); entry.id = to; entries.set(to, entry);
      clearViewFocus(entry);
      scope.rebind?.(from, to);
      callHook('tabHolder', () => tabHolder.rebind?.(from, to));
      callHook('downloads', () => downloads.rebind(from, to));
      changed(entry);
      fire(changeListeners, from);   // 前の id はもう中継に無い（state が null → 待機中）。前の id で配った引き継ぎ（ピルなど）を片付けさせる
      notifyView(to, 'rebind', from);
      carryChanged();
    },
    endTurn(sessionId) { const entry = entries.get(sessionId); if (entry) settleEntry(entry); },
    /** 会話の全タブを CDP で閉じ、残った専用窓だけを OS の層に閉じさせる。端点は残し、次の利用で窓を開き直せる。 */
    async closeConversationWindows(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return { closed: false };
      const state = up;
      const tabs = state ? tabsOf(state, entry) : [];
      if (!tabs.length && !scope.windows?.(sessionId)?.length && !entry.windows.size) return { closed: false };
      entry.paused = null;
      changed(entry);
      for (const tab of tabs) {
        if (up !== state || state.cdp.closed) break;
        await state.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
      }
      // 第 4 段の実機では closeTarget の約 0.3 秒後に Chrome が落ちた。破棄の通知を待ち、
      // 同じ窓に CDP と WM_CLOSE を重ねない。接続が切れた場合は teardown が状態を off に戻す。
      if (scope.windows?.(sessionId)?.length) await new Promise(resolve => setTimeout(resolve, 500));
      const osResult = scope.windows?.(sessionId)?.length ? await scope.closeRemaining?.(sessionId) : null;
      if (up === state) {
        for (const windowId of [...entry.windows]) {
          if (!scope.windows?.(sessionId)?.some(w => w.windowId === windowId)) {
            entry.windows.delete(windowId); state.windows.delete(windowId);
          }
        }
      }
      carryChanged();
      const remainingTabs = up === state && state ? tabsOf(state, entry).length : 0;
      // タブの破棄の通知が閉じる前に届かなかった場合も、閉じ終えた後の次の open が新しい窓で動くようにする（dropTab と同じ。二度目は何もしない）
      if (!remainingTabs) tabsLost(entry);
      return { closed: !remainingTabs && !scope.windows?.(sessionId)?.length && !osResult?.failed,
        ...((remainingTabs || scope.windows?.(sessionId)?.length || osResult?.failed) ? { failed: true } : {}) };
    },
    /**
     * 会話の窓のうち 1 つだけを閉じる（右パネルの「表示中のウィンドウを閉じる」。窓が複数あるとき）。ほかの窓・引き継ぎ・端点には触れない。
     * 窓のタブを CDP で閉じ、窓が残れば OS の層でその窓だけ閉じさせる
     */
    async closeWindow(sessionId, windowId) {
      const entry = entries.get(sessionId);
      const state = up;
      if (!entry || !state || windowId == null) return { closed: false };
      const tabs = tabsOf(state, entry).filter(tab => tab.windowId === windowId);
      if (!tabs.length && !entry.windows.has(windowId)) return { closed: false };
      for (const tab of tabs) {
        if (up !== state || state.cdp.closed) break;
        await state.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
      }
      const listed = () => scope.windows?.(sessionId)?.some(w => w.windowId === windowId);
      if (listed()) await new Promise(resolve => setTimeout(resolve, 500));
      const osResult = listed() ? await scope.closeRemaining?.(sessionId, windowId) : null;
      if (up === state && !listed()) { entry.windows.delete(windowId); state.windows.delete(windowId); }
      carryChanged();
      const remaining = up === state ? tabsOf(state, entry).filter(tab => tab.windowId === windowId).length : 0;
      const failed = remaining > 0 || listed() || Boolean(osResult?.failed);
      return failed ? { closed: false, failed: true } : { closed: true };
    },
    /** 会話を消した。接続を閉じて鍵を捨てる（窓は先に closeConversationWindows で閉じる） */
    forget(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.stopped = true;
      clearViewFocus(entry);
      settleEntry(entry);
      closeClients(entry, 1000, 'forgotten');
      scope.forget?.(sessionId);
      callHook('downloads', () => downloads.forget(sessionId));
      entries.delete(sessionId); byKey.delete(entry.key);
      fire(changeListeners, sessionId);   // 会話がもう中継に無い（state が null → 待機中）
      notifyView(sessionId, 'forget');
      carryChanged();
    },

    // ---- 更新を越える（ADR 0167）
    /** 持ち越す状態（端点・窓の印）。変わるたびに onCarry の聞き手へも渡す */
    snapshot,
    /** carryExtra の中身が変わった。預け直す */
    touch: carryChanged,
    onCarry(fn) { carryListeners.add(fn); return () => carryListeners.delete(fn); },
    /**
     * 前のサーバーが預けた状態を受ける（接続の子の welcome.carry。待ち受けを始める前に呼ぶ）。会話の id・鍵を戻し、同じポートで待ち受ける
     * （エージェントの接続先 ws://127.0.0.1:<port>/devtools/browser/<鍵> が更新を越えて同じ）。前のサーバーがまだポートを持っていれば短く待つ。
     * ポートが取れなければ別のポートで待ち受ける（鍵は作り直す。動いていたエージェントの接続先は古くなる）。窓の印は scope.restore へ
     * @param [options.staleSessions] 前のサーバーが Chrome の接続に付けたまま残したセッション（welcome.sessions）。最初の bind で外す
     * @returns {Promise<boolean>} 何かを戻したか
     */
    async restore(carry, { staleSessions: stale = [], invalid = false } = {}) {
      if (closed) return false;
      // 預かり物が無効（大きすぎて預けられなかった）: 古い止めた印・一時停止の印を信じられない。人が送るまで、端点は止めたものとして渡す
      if (invalid) { invalidCarry = true; log('chrome-relay: previous carry was invalid, conversations start stopped'); }
      chromeId = typeof carry?.chrome === 'string' && carry.chrome.length <= 300 ? carry.chrome : null;
      staleSessions = stale.map(item => (typeof item === 'string' ? item : item?.sessionId)).filter(id => typeof id === 'string' && id);
      let restored = false, fellBack = false;
      if (carry && carry.v === 1 && Array.isArray(carry.entries)) {
        for (const item of carry.entries) {
          if (typeof item?.id !== 'string' || !item.id || item.id.length > 200 || !/^[a-f0-9]{48}$/.test(item.key ?? '') || entries.has(item.id) || byKey.has(item.key)) continue;
          const entry = { id: item.id, key: item.key, stopped: item.stopped === true, clients: new Set(), windows: new Set(), turn: false, current: null, operating: false,
            lastUsedAt: Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : now(),   // 更新で窓を持ち越しても、最後に使った時刻は戻さない（ADR 0246）
            // AI のタブの履歴と人が開いたタブの印（更新・再起動を越えて AI のタブを保つ。ADR 0321）。タブの id の字だけ受ける
            ai: carriedIds(item.ai), human: new Set(carriedIds(item.human)) };
          // 一時停止は更新を越えて解けない（人が窓を操作している間に、エージェントのコマンドが通らない）。at・by は始まりの時刻と押した人
          if (item.paused && typeof item.paused === 'object') entry.paused = restoredPause(item.paused);
          entries.set(entry.id, entry); byKey.set(entry.key, entry);
          restored = true;
        }
        for (const item of Array.isArray(carry.windows) ? carry.windows : []) {
          const entry = entries.get(item?.id);
          if (!entry || !Array.isArray(item.windows)) continue;
          for (const w of item.windows) if (Number.isSafeInteger(w?.windowId)) entry.windows.add(w.windowId);
        }
        scope.restore?.(carry.windows);
        if (carry.extra && typeof carry.extra === 'object') { try { carryExtra?.restore?.(carry.extra); } catch (error) { log(`chrome-relay: restoring the extra carry failed: ${error?.message ?? error}`); } }
      }
      const wanted = Number.isInteger(carry?.port) && carry.port > 0 && carry.port < 65536 ? carry.port : 0;
      if (wanted) {
        listening ??= (async () => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            try { address = await listenOn(wanted); return address; }
            catch (error) {
              if (error?.code !== 'EADDRINUSE' || closed) break;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
          log(`chrome-relay: could not listen on the previous port ${wanted}, so another port is used`);
          address = await listenOn(0);
          fellBack = true;
          return address;
        })().catch(error => { listening = null; throw error; });
      }
      await ensureListening();
      // 前のポートを別のプロセスが持っていた: 古い鍵のままだと、その鍵が別のプロセスに知られる（古い接続先は元々つながらない）。鍵を作り直す。新しい接続先は次の endpoint() で渡る
      if (fellBack) {
        for (const entry of entries.values()) { byKey.delete(entry.key); entry.key = random(); byKey.set(entry.key, entry); }
        log('chrome-relay: previous port was taken, so the keys were regenerated');
      }
      // 一時停止のまま引き継がれた会話を、control に知らせる（映像の撮影を断ち続ける）
      for (const entry of entries.values()) if (entry.paused) fire(changeListeners, entry.id);
      carryChanged();
      return restored;
    },
    /**
     * 持ち越した窓があり、Chrome の接続を引き継げていれば、エージェントがつながる前に上りをつないで、窓のタブを会話の範囲に戻す
     * （更新の後、映像の一覧・窓の状態がすぐ戻り、ターンの外のエージェントも「つながっていない」と断られない）。層の状態には依らない。server.mjs が adopt の後に呼ぶ
     */
    async rejoin() {
      if ([...entries.values()].some(entry => entry.windows.size)) await bindConnected();
    },
    /** 通常のサーバー終了では保存済み carry と Chrome の窓を保ち、HTTP 側の接続だけを閉じる。 */
    releaseForRestart() {
      if (closed) return;
      closed = true;
      if (up) {
        for (const off of up.offs) off();
        for (const tab of up.tabs.values()) { tab.controller.abort(); tab.fe = null; }
        up = null;
      }
      for (const entry of entries.values()) {
        for (const client of [...entry.clients]) { try { client.ws.close(1001, 'server restarting'); } catch { /* already closed */ } }
        entry.clients.clear();
      }
      wss.close(); server.close();
    },
    /**
     * 層（main）が窓を引き継ぐ。サーバーの入れ替わりの後・main の層が戻った後に呼ぶ（server.mjs が os.onReady で）。
     * 層が引き継げなかった窓のタブは、Chrome の接続があれば CDP で閉じ、無ければ接続が付いたときに閉じる
     */
    readopt() {
      const run = readoptChain.then(readoptNow);
      readoptChain = run.catch(() => {});
      return run;
    },
    /** 中継が知っている会話の id（画面がつなぎ直したときに、今の状態を配るため） */
    sessionIds() { return [...entries.keys()]; },
    /** サイトの利用の確認（confirmAgentSites）。ON なら範囲のタブに確認の Fetch を付け、OFF なら外す（止めている要求は通す） */
    setConfirm(enabled) {
      const next = enabled === true;
      if (next === confirm) return;
      confirm = next;
      if (!up) return;
      for (const tab of up.tabs.values()) {
        if (intercepting()) ensureInternal(up, tab).catch(() => {});
        else dropInternal(up, tab);
      }
    },
    /**
     * 映像（core/chrome/screencast.mjs）の口。会話の窓のタブの一覧・今のタブ・操作中の印・変化の知らせと、中継自身のセッションの付け外し。
     * 映像のセッションは範囲のタブだけに付けられ、エージェントのセッションとは別（付け外しが互いに影響しない）。URL は出さない。題はタブの列（items）だけに出す
     */
    view: {
      onChange(fn) { viewers.add(fn); return () => viewers.delete(fn); },
      /** 窓のある会話の id の一覧 */
      sessions() { return up ? [...entries.values()].filter(entry => tabsOf(up, entry).length).map(entry => entry.id) : []; },
      summary(sessionId) {
        const entry = entries.get(sessionId);
        const tabs = entry && up ? tabsOf(up, entry) : [];
        return { tabs: tabs.length, windows: new Set(tabs.map(tab => tab.windowId).filter(id => id != null)).size, operating: Boolean(entry?.operating) };
      },
      tabs(sessionId) {
        const entry = entries.get(sessionId);
        return entry && up ? tabsOf(up, entry).map(tab => ({ targetId: tab.targetId, windowId: tab.windowId })) : [];
      },
      /** タブの並びと題・開いた元のタブ（右パネルのタブの列。映像を見ている端末にだけ送り、ログには出さない）。URL は出さない */
      items(sessionId) {
        const entry = entries.get(sessionId);
        return entry && up ? tabsOf(up, entry).map(tab => ({ targetId: tab.targetId, windowId: tab.windowId, title: String(tab.info.title ?? '').slice(0, 300), openerId: tab.opener?.targetId ?? null })) : [];
      },
      /** 範囲のタブを閉じる（端末が引き継いでいる間に、人がタブの列の × で閉じる） */
      async closeTab(sessionId, targetId) {
        const state = up;
        const tab = state?.tabs.get(targetId);
        if (!state || state.cdp.closed || !tab || tab.entry.id !== sessionId) throw new Error('tab not available');
        await state.cdp.send('Target.closeTarget', { targetId });
      },
      /**
       * AI のタブ: AI のタブの履歴（新しい順）のうち、いま開いている最初のタブ。履歴に入るのは、エージェントが作ったタブと、
       * エージェントが許可の一覧（CLAIMS）のコマンドで明示に操作したタブだけ（つなぐ・準備では入らない）。閉じたら 1 つ前へ戻る。無ければ null（ADR 0321）
       */
      current(sessionId) {
        const entry = entries.get(sessionId);
        return entry ? aiTabOf(entry) : null;
      },
      /** 窓に映っている・使う側のタブ: AI のタブ。AI のタブが 1 つも無いときだけ窓の最初のタブ。撮影・ログインの入力先・窓の特定など、引き継ぎの対象でなくてよい所が使う（引き継ぎは current だけ） */
      shown(sessionId) {
        const entry = entries.get(sessionId);
        return entry ? shownTab(entry) : null;
      },
      /**
       * 映像を見ている間、そのタブに focus emulation を保つ（on）・その理由を手放す（!on。ターンの間・ほかの持ち主がいれば残す）。有効になるまで待つ。
       * owner は理由の持ち主の札（映像の見張りごと）。持ち主ごとに数えるので、閉じた見張りの「手放す」が、開き直した見張りの理由を消さない。
       * 隠した窓のページは focus emulation が無いと描かれない・フレームが出ない（実機）
       */
      async focus(sessionId, targetId, on, owner = 'view') {
        const state = up;
        const tab = state?.tabs.get(targetId);
        if (!state || !tab || tab.entry.id !== sessionId) return;
        if (on === true) tab.viewFocus.add(owner); else tab.viewFocus.delete(owner);
        await focusSync(state, tab);
      },
      /** 中継自身のセッションを範囲のタブに付ける。onEvent(method, params) はそのセッションのイベント（と外れたときの Target.detachedFromTarget） */
      async attach(sessionId, targetId, onEvent) {
        const state = up;
        const tab = state?.tabs.get(targetId);
        if (!state || state.cdp.closed || !tab || tab.entry.id !== sessionId) throw new Error('tab not available');
        return ownSession(state, tab, onEvent);
      },
    },
    /** サーバーの 3 つの port（{ main, pages, isolated }。立っていない port は null）。移動の検査の口が読む */
    setPagePorts(ports) {
      const next = ports ? Object.freeze({ main: ports.main ?? null, pages: ports.pages ?? null, isolated: ports.isolated ?? null }) : null;
      if (JSON.stringify(next) === JSON.stringify(pagePorts)) return;
      pagePorts = next;
      callHook('tabInfo', () => tabInfo.setPagePorts?.(next ?? {}));   // ファイルのページの印（page）と、favicon を取りに行かない port
      refreshInterception(up);   // 後から決まった port を、もう開いているタブの Fetch にも効かせる
    },
    /**
     * port が替わった・サーバーが入れ替わったあと、残っているタブを新しい URL へ移す（ADR 0295 の 7 の 1）。
     * move(url) は新しい URL か null（core/isolated-origins.mjs の movedPageUrl。サーバーが鍵と秘密を持つので外から渡す）。
     * 移したタブは targetInfoChanged → tabInfo.changed が URL と印を報せる
     */
    async migratePageTabs(move) {
      if (typeof move !== 'function' || !up || up.cdp.closed) return { moved: 0, failed: 0 };
      let moved = 0, failed = 0;
      const reasons = [];
      for (const tab of [...up.tabs.values()]) {
        const next = move(tab.info?.url ?? '');
        if (typeof next !== 'string' || !next || next === tab.info?.url) continue;
        try {
          const own = await ownSession(up, tab, () => {});
          try { await own.send('Page.navigate', { url: next }); } finally { await own.detach(); }
          moved++;
        } catch (error) { failed++; if (reasons.length < 3) reasons.push(String(error?.message ?? error)); }
      }
      return { moved, failed, reasons };
    },
    /** ファイルのページの Cookie（core/page-auth.mjs の pagesCookie の形）。移動の検査の口が接続のたびと開く前に入れる */
    setPageCookie(cookie) {
      const next = cookie ? Object.freeze({ ...cookie }) : null;
      if (JSON.stringify(next) === JSON.stringify(pageCookie)) return;
      pageCookie = next;
      refreshInterception(up);   // もう開いているタブ（既定の context でないプロフィール）にも入れる
    },
    /** 4 つの口の実体（{ pagePolicy, tabHolder, tabInfo, pageBridge }）。口を持つ段が足した呼び口へ、中継を変えずに外から届くため */
    get unify() { return { pagePolicy, tabHolder, tabInfo, pageBridge }; },
    /**
     * 会話のタブで始まったダウンロード（ADR 0328）。list はエージェントへ返す形、screen は画面へ出す形（'tab:downloads' と同じ）。
     * wait は進行中のものが無くなるか seconds が過ぎるまで待つ。stop は人の「ダウンロードを止める」（{ stopped }）。onSettled は決着の聞き手（会話の行）
     */
    downloads: {
      list: sessionId => downloads.list(sessionId),
      screen: sessionId => downloads.screen(sessionId),
      wait: (sessionId, seconds, signal) => downloads.wait(sessionId, seconds, signal),
      stop: (sessionId, id) => stopDownload(sessionId, id),
      onSettled: fn => downloads.onSettled(fn),
    },
    /** タブの出来事（TAB_EVENTS の名前）。fn(type, payload) */
    onTabEvent(fn) { tabEventListeners.add(fn); return () => tabEventListeners.delete(fn); },
    get port() { return address?.port ?? null; },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) { entry.stopped = true; closeClients(entry, 1001, 'closing'); }
      // main の層が居ない間（更新中）に終わると、隠した窓を層で閉じられない。見えない窓を残さないよう、CDP でタブを閉じる
      if (up && os.capabilities?.().reason === 'pending') for (const tab of up.tabs.values()) up.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
      // ブラウザーの単位の Fetch は接続に残る（接続の子が更新を越えて持つ）。答える相手が居なくなるので外す（利用者のタブの要求を止めたままにしない）
      if (up && up.browserFetch && up.browserFetch !== '[]' && !up.cdp.closed) up.cdp.send('Fetch.disable', {}).catch(() => {});
      // ダウンロードのイベントの旗は外さない（次のサーバーの bind と順序が入れ替わると、付け直した旗を消してしまう。受ける相手の居ないイベントは捨てられるだけ）
      if (up) teardown(up);
      wss.close(); server.close();
      log('chrome-relay: closed');
    },
  };
}
