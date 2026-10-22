'use strict';
// Chrome への接続の OS の層（Windows）。core/chrome/os.mjs の口の実装（docs/inapp-browser.md「OS ごとの層」、ADR 0153・0154）。
// koffi は desktop/computer/win32.cjs の表（createWin32 の戻り値）だけが読む。ここは表の関数を呼ぶだけで、テストは偽の表で動かす。
//
// WindowRef = { id: string }（窓のハンドルの 10 進）。自分が出した ref だけを Map で覚え、知らない値には何もしない
// （ほかのアプリの窓を前に出す・閉じる・隠すことが起きない）。閉じてよいのは確認の窓として出した ref だけ、隠す・戻すのは
// エージェントの窓（題の nonce か窓の大きさで見つけた窓）として出した ref だけ。

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createUiaRunner } = require('./win32-uia.cjs');

const BROWSER_CLASS = 'Chrome_WidgetWin_1';   // Electron のアプリも同じクラスなので、実行ファイルでも絞る
const BROWSER_EXES = new Set(['chrome.exe', 'msedge.exe']);
// 確認の窓の題。言語で変わるので「見つけ方の補助」でしかない（ja は実機で確認。en は未確認）
const DIALOG_TITLE = /リモート\s*デバッグ|remote debugging/i;
const MAX_DIALOG_DIP = { width: 1000, height: 700 };
const SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, SW_RESTORE = 9, SW_SHOWNA = 8;
const WM_CLOSE = 0x0010;
const MAX_REFS = 200;
const MAX_AGENT_REFS = 64;

// 画面の外へ置いた窓のスタイル（ADR 0154）。タスクバーと Alt+Tab から外し、透明度 0 で見えなくし、マウスを素通しにする
const WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_LAYERED = 0x80000;
const STYLE_BITS = WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_APPWINDOW | WS_EX_LAYERED;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20;
/** 仮想デスクトップの右の端からの余白（物理画素）。窓がどのモニターにも入らない */
const HIDDEN_MARGIN = 1000;
const HIDDEN_X_MAX = 30000;
const GUARD_MS = 100;
/** 見張りが、隠している窓の位置とスタイルを確かめる間隔（Chrome が後から画面の中へ動かした窓を隠し直す） */
const PLACE_CHECK_MS = 1000;
/** 閉じる依頼（WM_CLOSE）を出した窓が、これだけ経っても残っていたら（beforeunload の確認など）、見える形へ戻す */
const CLOSE_GRACE_MS = 3000;
/**
 * 人かエージェントかの見分け（ADR 0246）。隠した窓を層が隠した・引き継いだ直後の前面取りは、エージェントの操作
 * （開きかけの窓・window.open の popup）とみなす。同じプロフィールの見える窓を開く間隔（同じ窓が前面を取り直すたびに何枚も開かない）
 */
const AGENT_GRACE_MS = 2000;
const OPEN_VISIBLE_COOLDOWN_MS = 30_000;

const PRODUCTS = {
  chrome: {
    exe: 'chrome.exe',
    appPaths: 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    defaults: [['ProgramFiles', 'Google\\Chrome\\Application\\chrome.exe'], ['ProgramFiles(x86)', 'Google\\Chrome\\Application\\chrome.exe'], ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe']],
  },
};
const PROFILE_DIR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const NONCE = /^[a-f0-9]{8,64}$/;
const NONCE_URL = /^data:text\/html[,;]/;

const FEATURES = Object.freeze({ dialog: true, raise: true, launch: true, conceal: true, watch: true, bounds: true, allow: true, enable: true });

// リモート デバッグのトグルの画面（ADR 0218）。外からは開けない（コマンドラインで渡すと Chrome は新しいタブにする）ので、Pleiad が開いた窓のアドレス欄に入れる
const INSPECT_URL = 'chrome://inspect/#remote-debugging';
/** トグルの窓を開いてから見つけるまで（Chrome が起動していなければ起動から） */
const ENABLE_FIND_MS = 20_000;
/**
 * 窓がこれだけ経っても見つからなければ、同じ URL でもう一度頼む。起動していない Chrome は、起動のときに渡した URL を開かないことがある
 * （起動の画面・前回の続きを優先する。実機で、閉じた Chrome に頼むと Pleiad の窓が開かなかった）。2 回目は起動した Chrome に渡るので開く
 */
const ENABLE_RELAUNCH_MS = 5_000;
/** 窓を探す間隔。見つけるまでの間は窓が見えるので短くする */
const ENABLE_POLL_MS = 50;
/** トグルを探して押すまで（PowerShell の起動を除く） */
const ENABLE_UIA_MS = 12_000;

const exeName = path_ => (typeof path_ === 'string' && path_ ? path_.split(/[\\/]/).pop().toLowerCase() : null);
const isInt = v => Number.isInteger(v) && Math.abs(v) < 100000;

/**
 * @param {object} deps
 * @param deps.win32 desktop/computer/win32.cjs の表（偽物でもよい）
 * @param [deps.spawn] chrome.exe を起こす（既定は child_process.spawn。テストは偽物）
 * @param [deps.env] 場所の既定の展開に使う環境変数
 * @param [deps.exists] ファイルがあるか（既定は fs.existsSync）
 * @param [deps.timers] 前面の見張りの周期（既定は setInterval / clearInterval）
 * @param [deps.appHwnd] Pleiad 自身の窓（main の BrowserWindow）のハンドルを返す関数。引き継ぎで窓を戻す画面を、押した時の前面でなく Pleiad の窓のある画面にするのに使う
 * @param [deps.uia] Chrome 自身の画面を UI Automation で押す口（win32-uia.cjs の createUiaRunner。テストは偽物）
 * @param [deps.sleep] 待つ（既定は setTimeout。テストは偽物）
 */
function createWin32ChromeOs({ win32, log = () => {}, spawn = childProcess.spawn, env = process.env, exists = fs.existsSync,
  timers = { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: handle => clearInterval(handle) }, guardMs = GUARD_MS, now = Date.now, appHwnd = null, pointToDip = null,
  uia = createUiaRunner({ env, log }), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  agentGraceMs = AGENT_GRACE_MS, openVisibleCooldownMs = OPEN_VISIBLE_COOLDOWN_MS }) {
  const refs = new Map();   // id -> { hwnd, kind: 'dialog' | 'foreign' | 'agent', ex0?, concealed?, ghost?, profileDir?, aumid?, agentAt? }
  const browsers = new Map();   // id -> { path, product }
  let browserSeq = 0;
  // プロフィールの手がかり: chrome.exe で開いたときの nonce → フォルダー名、AUMID → フォルダー名（ADR 0246）。
  // 窓は 1 つの Chrome のプロセスを共有するので、プロフィールは窓ごとの AUMID で見分ける。AUMID は不透明な鍵として比べ、
  // 見える窓を開くときのフォルダー名は core の記録か、開いたときに覚えた対応から取る
  const launchProfiles = new Map();
  const aumidProfiles = new Map();
  const visibleOpenedAt = new Map();   // AUMID -> そのプロフィールの見える窓を開いた時刻
  let lastUserDataDir = null;
  const remember = (hwnd, kind) => {
    const id = String(hwnd);
    const known = refs.get(id);
    // いちど確認の窓・エージェントの窓として出した ref を、前面の窓として出し直しても、印は落とさない
    const keep = known && known.kind !== 'foreign' ? known : null;
    refs.set(id, keep ?? { hwnd, kind });
    if (refs.size > MAX_REFS) {
      // エージェントの窓の ref は、窓がある間は見張りと戻す操作が要るので、古い順の掃除では消さない
      for (const [key, entry] of refs) { if (entry.kind !== 'agent') { refs.delete(key); break; } }
    }
    return { id };
  };
  /** 確認の窓として出した窓は、エージェントの窓にしない（隠す・見張る対象にすると、確認の窓を閉じられなくなる）。そのとき null */
  const rememberAgent = hwnd => {
    if (refs.get(String(hwnd))?.kind === 'dialog') return null;
    const out = remember(hwnd, 'agent');
    const agents = [...refs].filter(([, e]) => e.kind === 'agent');
    if (agents.length > MAX_AGENT_REFS) { const [key, old] = agents[0]; if (!old.concealed) refs.delete(key); }
    const entry = refs.get(out.id);
    if (entry) markAgent(entry);
    return out;
  };
  const known = ref => (ref && typeof ref.id === 'string' ? refs.get(ref.id) : undefined);
  const knownAgent = ref => { const entry = known(ref); return entry?.kind === 'agent' ? entry : undefined; };
  const alive = hwnd => { try { return win32.isWindow ? win32.isWindow(hwnd) : true; } catch { return false; } };

  /** 窓の AUMID（読めなければ null。win32 の表に無い・古い層でも投げない） */
  const aumidOf = hwnd => { try { return win32.windowAumid?.(hwnd) ?? null; } catch { return null; } };
  /** 隠した窓のプロフィールのフォルダー名（core の記録が確か。無ければ、開いたときに覚えた AUMID の対応） */
  const profileDirOf = entry => entry?.profileDir ?? (entry?.aumid ? aumidProfiles.get(entry.aumid) ?? null : null);
  /** 窓のプロフィールの鍵（比べるだけに使う。AUMID はプロフィールごとに違う。読めなければ null） */
  const profileKeyOf = entry => entry?.aumid ?? null;
  /** 隠した窓のプロフィールの手がかりを取り直す。core から渡されたフォルダー名があれば、AUMID との対応も覚える */
  function noteProfile(entry, profileDir, userDataDir = null) {
    if (typeof profileDir === 'string' && PROFILE_DIR.test(profileDir)) entry.profileDir = profileDir;
    // 見える窓を開くときの --user-data-dir（確かめ専用の User Data を、利用者の既定の Chrome に開かない）
    if (typeof userDataDir === 'string' && userDataDir && path.win32.isAbsolute(userDataDir) && !/[\r\n\0]/.test(userDataDir)) entry.userDataDir = userDataDir;
    if (!entry.aumid) entry.aumid = aumidOf(entry.hwnd);
    if (entry.aumid && entry.profileDir) aumidProfiles.set(entry.aumid, entry.profileDir);
  }
  const markAgent = entry => { entry.agentAt = now(); if (entry.aumid === undefined) entry.aumid = aumidOf(entry.hwnd); };

  /** 今あるブラウザー（chrome.exe・msedge.exe）の最上位の窓 */
  function browserWindows() {
    const exes = new Map();   // pid -> 実行ファイル名（1 回の列挙の中だけ覚える）
    const exeOf = pid => { if (!exes.has(pid)) { let path_ = null; try { path_ = win32.processPath(pid); } catch { /* 開けない窓は対象外 */ } exes.set(pid, exeName(path_)); } return exes.get(pid); };
    const out = [];
    let handles = [];
    try { handles = win32.topLevelWindows(); } catch { return out; }
    for (const hwnd of handles) {
      let info;
      try { info = win32.windowInfo(hwnd); } catch { continue; }
      if (info.className !== BROWSER_CLASS) continue;
      const exe = exeOf(info.pid);
      if (!exe || !BROWSER_EXES.has(exe)) continue;
      out.push({ hwnd, info, exe });
    }
    return out;
  }

  /**
   * 隠していない Chrome の窓か（プロフィールの選択画面・利用者の窓）。直前の前面がこれだったときだけ、人がプロフィールを
   * 開こうとしたと見る（ADR 0246）。隠した窓・透明の窓・最小化・cloaked の窓は数えない
   */
  function visibleChromeWindow(hwnd) {
    if (!hwnd) return false;
    try {
      const info = win32.windowInfo(hwnd);
      if (info.className !== BROWSER_CLASS || !BROWSER_EXES.has(exeName(win32.processPath(info.pid)))) return false;
      return Boolean(info.visible && !info.iconic && !info.cloaked && !concealStyled(info));
    } catch { return false; }
  }

  const dipScale = hwnd => 96 / (win32.dpiForWindow?.(hwnd) || 96);
  const dipSize = (hwnd, rect) => {
    if (!rect) return null;
    const scale = dipScale(hwnd);
    return { width: (rect.right - rect.left) * scale, height: (rect.bottom - rect.top) * scale };
  };

  function snapshotWindows() {
    return browserWindows().map(w => String(w.hwnd));
  }

  /** 確認の窓の見た目（題が既知の文言で、見えていて、小さいブラウザーの窓）。隠す対象から外すのに使う */
  function looksLikePermissionDialog(hwnd, info) {
    if (!info.visible || info.iconic || info.cloaked || !DIALOG_TITLE.test(info.title)) return false;
    const size = dipSize(hwnd, info.rect);
    return Boolean(size && size.width <= MAX_DIALOG_DIP.width && size.height <= MAX_DIALOG_DIP.height);
  }

  /**
   * 「リモート デバッグを許可しますか？」の確認の窓。since に無い・見えている・小さい（外形が 1000×700 DIP 以下）ブラウザーの窓。
   * 題が既知の文言なら優先し、無ければ「ブラウザーの窓に所有された」新しい窓が 1 つだけのときに限る
   * （実機の確認の窓は WS_POPUP でブラウザーの窓が持ち主。ふつうの窓は持ち主が無い）
   * port（DevToolsActivePort のポート）が分かれば、そのポートを待ち受けているプロセスの窓だけを見る。
   * 別の User Data の Chrome・Edge・別の chrome.exe が同時に動いていても、取り違えて閉じない。持ち主が分からなければ絞らない。
   */
  function findPermissionDialog({ since = [], port = null } = {}) {
    const before = new Set((Array.isArray(since) ? since : []).map(String));
    let ownerPid = null;
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      try { ownerPid = win32.listenerPid?.(port) || null; } catch { ownerPid = null; }
    }
    const candidates = browserWindows().filter(({ hwnd, info }) => {
      if (ownerPid && info.pid !== ownerPid) return false;
      if (before.has(String(hwnd)) || !info.visible || info.iconic || info.cloaked) return false;
      const size = dipSize(hwnd, info.rect);
      return size && size.width <= MAX_DIALOG_DIP.width && size.height <= MAX_DIALOG_DIP.height;
    });
    const titled = candidates.filter(w => DIALOG_TITLE.test(w.info.title));
    let pick = titled[0] ?? null;
    if (!pick) {
      const owned = candidates.filter(w => { try { return win32.ownerOf(w.hwnd) !== 0; } catch { return false; } });
      if (owned.length === 1) pick = owned[0];
    }
    return pick ? remember(pick.hwnd, 'dialog') : null;
  }

  /** 前面を取る 1 手。取れたかは foreground() で確かめる */
  function bring(hwnd) {
    if (win32.windowInfo(hwnd).iconic) win32.showWindow(hwnd, SW_RESTORE);
    win32.setForeground(hwnd);
    if (win32.foreground() === hwnd) return 'direct';
    // 前面のスレッドに入力をつなぐ（Pleiad が前面でも、ほかのアプリが前面でも通る。実機で確認）
    const front = win32.foreground();
    const frontThread = front ? win32.windowThread(front) : 0;
    const me = win32.currentThread();
    const attached = frontThread && frontThread !== me ? win32.attachThreadInput(me, frontThread, true) : false;
    try {
      win32.bringToTop(hwnd);
      win32.setForeground(hwnd);
    } finally {
      if (attached) win32.attachThreadInput(me, frontThread, false);
    }
    return win32.foreground() === hwnd ? 'attach' : 'failed';
  }

  function raise(ref) {
    const entry = known(ref);
    if (!entry) return { ok: false, method: 'unknown' };
    try {
      const method = bring(entry.hwnd);
      log(`raise method=${method}`);
      return { ok: method !== 'failed', method };
    } catch (error) {
      log(`raise failed: ${error.message}`);
      return { ok: false, method: 'failed' };
    }
  }

  /** ref が前面を取っていたら、to（直前の前面）へ返す。ref が前面でなければ何もしない */
  function yieldForeground(ref, { to } = {}) {
    const entry = known(ref), target = known(to);
    if (!entry || !target) return false;
    try {
      if (win32.foreground() !== entry.hwnd) return false;
      return bring(target.hwnd) !== 'failed';
    } catch { return false; }
  }

  /** Pleiad 自身の窓（引き継ぎで窓を戻す画面の手がかり。リモートの端末から押したときも、PC の Pleiad の窓のある画面を指す）。無い・閉じていれば null */
  function appWindow() {
    let hwnd = 0;
    try { hwnd = appHwnd ? Number(appHwnd()) || 0 : 0; } catch { hwnd = 0; }
    if (!hwnd || !alive(hwnd)) return null;
    return remember(hwnd, 'foreign');
  }

  /** The OS rectangle is physical pixels. Electron positions its windows in screen DIP. */
  function bounds(ref) {
    const entry = knownAgent(ref);
    if (!entry || entry.concealed || !alive(entry.hwnd) || !pointToDip) return null;
    try {
      const info = win32.windowInfo(entry.hwnd);
      if (!info.visible || info.iconic || info.cloaked || !info.rect || info.className !== BROWSER_CLASS ||
          !BROWSER_EXES.has(exeName(win32.processPath(info.pid)))) return null;
      const { left, top, right, bottom } = info.rect;
      const dpi = win32.dpiForWindow(entry.hwnd);
      if (![left, top, right, bottom, dpi].every(Number.isFinite) || dpi <= 0 || right <= left || bottom <= top) return null;
      const origin = pointToDip({ x: left, y: top });
      if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
      return { x: origin.x, y: origin.y, width: (right - left) * 96 / dpi, height: (bottom - top) * 96 / dpi };
    } catch { return null; }
  }

  /** Watch foreground changes only while a caller has visible agent windows. */
  function watch({ refs: watched = [] } = {}, notify = () => {}) {
    const ids = new Set(watched.filter(ref => knownAgent(ref)).map(ref => ref.id));
    if (!ids.size) return () => {};
    let previous;
    const tick = () => {
      const front = foreground();
      const id = front?.id ?? null;
      if (id === previous) return;
      previous = id;
      notify({ kind: 'foreground', ref: ids.has(id) ? { id } : null });
    };
    tick();
    const timer = timers.setInterval(tick, 120);
    timer?.unref?.();
    return () => timers.clearInterval(timer);
  }

  function foreground() {
    let hwnd = 0;
    try { hwnd = win32.foreground(); } catch { return null; }
    if (!hwnd) return null;
    let browser = false;
    try {
      const info = win32.windowInfo(hwnd);
      browser = info.className === BROWSER_CLASS && BROWSER_EXES.has(exeName(win32.processPath(info.pid)));
    } catch { /* ブラウザーかどうかが分からなければ、ブラウザーではない扱い */ }
    return { ...remember(hwnd, 'foreign'), browser };
  }

  /** 確認の窓として出した ref だけを、まだ同じ実行ファイルの窓のときに限って WM_CLOSE で閉じる */
  function close(ref) {
    const entry = known(ref);
    if (!entry || entry.kind !== 'dialog') return false;
    try {
      const info = win32.windowInfo(entry.hwnd);
      if (info.className !== BROWSER_CLASS || !BROWSER_EXES.has(exeName(win32.processPath(info.pid)))) { refs.delete(ref.id); return false; }
      return win32.postMessage(entry.hwnd, WM_CLOSE, 0, 0) === true;
    } catch { return false; }
  }

  /** ref が、今もブラウザーの実行ファイルの、ブラウザーのクラスの窓か */
  const stillBrowser = entry => {
    try {
      const info = win32.windowInfo(entry.hwnd);
      return info.className === BROWSER_CLASS && BROWSER_EXES.has(exeName(win32.processPath(info.pid))) ? info : null;
    } catch { return null; }
  };

  /**
   * 確認の窓として出した ref の「許可する」を押す（ADR 0218）。ボタンは UI Automation の InvokePattern で押し、マウス・キーボードは使わない。
   * ボタンは名前（Allow・許可する）で探し、ちょうど 1 つのときだけ押す。ほかの言語の Chrome・見つからないときは false（人が押す案内に戻る）
   */
  async function allowPermission(ref) {
    const entry = known(ref);
    if (!entry || entry.kind !== 'dialog' || !alive(entry.hwnd) || !stillBrowser(entry)) return false;
    const result = await uia({ op: 'allow', hwnd: entry.hwnd });
    log(`allow ok=${result?.ok === true}${result?.reason ? ` reason=${result.reason}` : ''}`);
    return result?.ok === true;
  }

  /**
   * Chrome のリモート デバッグのトグルをオンにする（ADR 0218。人が「オンにしてつなぐ」を押したときだけ core が呼ぶ）。
   * 1. 題に nonce を持つ新しい窓を画面の外に開き、隠す（conceal。透明・マウスの素通し・タスクバーの外）
   * 2. 透明のまま、画面の中の最前面（topmost）へ置く。Chrome は画面の外・覆われた窓のページの中身をアクセシビリティに出さず、
   *    ほかの窓が前面に戻ると一番上（HWND_TOP）の窓にも重なる（実機で確認）
   * 3. その窓のアドレス欄に chrome://inspect/#remote-debugging を入れて開く（win32-uia.ps1 の navigate）。Chrome はアドレス欄の Enter を、
   *    窓が前面のときしか受けないので、開く間（1 秒未満）だけこの窓に前面を持たせ、開いたらすぐ起こす前の前面へ返す
   * 4. トグルを UI Automation で入れる（toggle。前面は要らない）
   * 5. 窓を閉じる。ほかに同じ Chrome の窓が無い（この窓で Chrome を起動した）ときは、閉じると Chrome ごと終わるので、見える形へ戻して残す
   * 利用者の窓・タブ・アドレス欄には触らない
   */
  async function enableRemoteDebugging({ browser, profileDir, userDataDir = null } = {}) {
    const nonce = crypto.randomBytes(12).toString('hex');
    let before = 0;
    try { before = win32.foreground(); } catch { before = 0; }
    const launched = launchWindow({ browser, profileDir, url: `data:text/html,<title>${nonce}</title>`, nonce, userDataDir, position: hiddenSpot(), size: { width: 800, height: 600 } });
    if (!launched.ok) return { ok: false, reason: launched.reason ?? 'launch' };
    let ref = null;
    const start = now();
    let relaunched = false;
    while (!ref && now() - start < ENABLE_FIND_MS) {
      await sleep(ENABLE_POLL_MS);
      ref = findWindowByNonce(nonce);
      if (!ref && !relaunched && now() - start >= ENABLE_RELAUNCH_MS) {
        relaunched = true;
        log('enable: the window did not open, so it was asked again');
        launchWindow({ browser, profileDir, url: `data:text/html,<title>${nonce}</title>`, nonce, userDataDir, position: hiddenSpot(), size: { width: 800, height: 600 } });
      }
    }
    if (!ref) return { ok: false, reason: 'no-window' };
    const entry = knownAgent(ref);
    if (!entry) return { ok: false, reason: 'no-window' };
    // ghost: 見張りが画面の外へ戻さず、前面も返さない（開く間だけ、この層が前面を持たせる）
    entry.ghost = true;
    const giveBack = () => { try { if (before && before !== entry.hwnd && alive(before) && win32.foreground() === entry.hwnd) bring(before); } catch { /* 返せなくても続ける */ } };
    let result = { ok: false, reason: 'place' };
    try {
      if (!conceal(ref)) { result = { ok: false, reason: 'conceal' }; }
      else {
        let list = [];
        try { list = win32.monitors?.() ?? []; } catch { list = []; }
        const screen = list.find(m => m.primary) ?? list[0];
        if (screen && win32.setWindowPos(entry.hwnd, screen.x + 40, screen.y + 40, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER)) {
          win32.setTopmost?.(entry.hwnd, true);
          if (win32.foreground() !== entry.hwnd) bring(entry.hwnd);
          result = await uia({ op: 'navigate', hwnd: entry.hwnd, url: INSPECT_URL, nonce, timeoutMs: ENABLE_UIA_MS / 2 }, { timeoutMs: ENABLE_UIA_MS / 2 + 8000 });
          giveBack();
          if (result?.ok === true) result = await uia({ op: 'toggle', hwnd: entry.hwnd, timeoutMs: ENABLE_UIA_MS / 2 }, { timeoutMs: ENABLE_UIA_MS / 2 + 8000 });
        }
      }
    } catch (error) {
      log(`enable failed: ${error.message}`);
    } finally {
      giveBack();
      entry.ghost = false;
      try { win32.setTopmost?.(entry.hwnd, false); } catch { /* 閉じた窓 */ }
    }
    // 頼み直しで同じ題の窓がもう 1 つ開いていたら、それも閉じる（見える窓を残さない）
    if (relaunched) {
      for (const w of browserWindows()) {
        if (w.hwnd !== entry.hwnd && w.info.title.includes(nonce)) { try { win32.postMessage(w.hwnd, WM_CLOSE, 0, 0); } catch { /* 閉じていてもよい */ } }
      }
    }
    const info = stillBrowser(entry);
    const others = info ? browserWindows().filter(w => w.hwnd !== entry.hwnd && w.info.pid === info.pid && !w.info.title.includes(nonce) && (w.info.visible || w.info.iconic)) : [];
    if (others.length) closeAgent(ref);
    else { reveal(ref); release(ref); }
    log(`enable ok=${result?.ok === true}${result?.reason ? ` reason=${result.reason}` : ''}${others.length ? '' : ' kept'}`);
    return result?.ok === true ? { ok: true } : { ok: false, reason: String(result?.reason ?? 'failed') };
  }

  // ---- エージェントの窓（ADR 0154） -----------------------------------------------------------------

  /** ブラウザーの場所。レジストリの App Paths（HKCU → HKLM）、無ければ既定の 3 か所。層が出した id だけが launchWindow に使える */
  function locateBrowser({ product = 'chrome' } = {}) {
    const spec = PRODUCTS[product];
    if (!spec) return null;
    const candidates = [];
    for (const hive of ['HKCU', 'HKLM']) {
      let value = null;
      try { value = win32.registryString?.(hive, spec.appPaths, '') ?? null; } catch { value = null; }
      if (typeof value === 'string' && value.trim()) candidates.push(value.trim().replace(/^"(.*)"$/, '$1'));
    }
    for (const [variable, rest] of spec.defaults) if (env[variable]) candidates.push(path.win32.join(env[variable], rest));
    for (const candidate of candidates) {
      if (exeName(candidate) !== spec.exe || !path.win32.isAbsolute(candidate)) continue;
      let present = false;
      try { present = exists(candidate) === true; } catch { present = false; }
      if (!present) continue;
      const id = `b${++browserSeq}`;
      browsers.set(id, { path: candidate, product });
      if (browsers.size > 8) browsers.delete(browsers.keys().next().value);
      return { id, product };
    }
    return null;
  }

  /**
   * 専用の窓を chrome.exe --profile-directory --new-window で開く。url は題に nonce を持つ data: のページ（findWindowByNonce が窓を見つける）。
   * userDataDir があるときは --user-data-dir を必ず付ける（付けないと利用者の既定の Chrome に窓が開く）。position（物理画素）・size（DIP）は、
   * 一瞬見えるのを避けるための --window-position・--window-size
   */
  function launchWindow({ browser, profileDir, url, nonce, userDataDir = null, position = null, size = null } = {}) {
    const found = browser && typeof browser.id === 'string' ? browsers.get(browser.id) : null;
    if (!found) return { ok: false, reason: 'unknown-browser' };
    if (typeof profileDir !== 'string' || !PROFILE_DIR.test(profileDir)) return { ok: false, reason: 'profile' };
    if (typeof nonce !== 'string' || !NONCE.test(nonce) || typeof url !== 'string' || !NONCE_URL.test(url) || !url.includes(nonce) || url.length > 400) return { ok: false, reason: 'url' };
    if (userDataDir !== null && (typeof userDataDir !== 'string' || !path.win32.isAbsolute(userDataDir) || /[\r\n\0]/.test(userDataDir))) return { ok: false, reason: 'user-data-dir' };
    const args = [];
    if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
    args.push(`--profile-directory=${profileDir}`, '--new-window');
    if (position && isInt(position.x) && isInt(position.y)) args.push(`--window-position=${position.x},${position.y}`);
    if (size && isInt(size.width) && isInt(size.height) && size.width > 0 && size.height > 0) args.push(`--window-size=${size.width},${size.height}`);
    args.push(url);
    try {
      const child = spawn(found.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on?.('error', error => log(`launch failed: ${error.message}`));
      child.unref?.();
      launchProfiles.set(nonce, { profileDir, userDataDir: userDataDir || null });
      if (launchProfiles.size > 16) launchProfiles.delete(launchProfiles.keys().next().value);
      lastUserDataDir = userDataDir || null;
      log('launch window');
      return { ok: true };
    } catch (error) {
      log(`launch failed: ${error.message}`);
      return { ok: false, reason: 'spawn' };
    }
  }

  /** 題に nonce を含むブラウザーの窓（launchWindow・createTarget が開いた、題が nonce のページの窓） */
  function findWindowByNonce(nonce) {
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return null;
    const hit = browserWindows().find(({ info }) => info.title.includes(nonce));
    if (!hit) return null;
    const out = rememberAgent(hit.hwnd);
    const entry = out && refs.get(out.id);
    const launched = launchProfiles.get(nonce);
    if (entry) noteProfile(entry, launched?.profileDir ?? null, launched?.userDataDir ?? null);
    launchProfiles.delete(nonce);
    return out;
  }

  /**
   * 外形が bounds（CDP の Browser.getWindowBounds の DIP）に合うブラウザーの窓。window.open の popup など、題で見つけられない窓用。
   * port（DevToolsActivePort のポート）の待ち受けのプロセス（つないだ Chrome）の窓だけを見る。持ち主が分からなければ採用しない（null。
   * 利用者の窓・Edge の窓・別の Chrome の窓を取り違えて隠さない）。since（snapshotWindows の写し）に入っている窓は除く。
   * 位置・大きさとも tolerance（既定 16 DIP）の内で、見えていて、すでにエージェントの窓として出していない窓がちょうど 1 つのときだけ返す（曖昧なら null）
   */
  function findWindowByBounds({ bounds, port = null, since = [], tolerance: wanted = 16 } = {}) {
    if (!bounds || ![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)) return null;
    let ownerPid = null;
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      try { ownerPid = win32.listenerPid?.(port) || null; } catch { ownerPid = null; }
    }
    if (!ownerPid) return null;
    const before = new Set((Array.isArray(since) ? since : []).map(String));
    const tolerance = Number.isFinite(wanted) ? Math.min(16, Math.max(1, wanted)) : 16;
    const hits = browserWindows().filter(({ hwnd, info }) => {
      if (info.pid !== ownerPid || before.has(String(hwnd))) return false;
      if (refs.get(String(hwnd))?.kind === 'agent' || !info.visible || info.iconic || info.cloaked || !info.rect) return false;
      const scale = dipScale(hwnd);
      const left = info.rect.left * scale, top = info.rect.top * scale;
      const width = (info.rect.right - info.rect.left) * scale, height = (info.rect.bottom - info.rect.top) * scale;
      return Math.abs(left - bounds.left) <= tolerance && Math.abs(top - bounds.top) <= tolerance
        && Math.abs(width - bounds.width) <= tolerance && Math.abs(height - bounds.height) <= tolerance;
    });
    return hits.length === 1 ? rememberAgent(hits[0].hwnd) : null;
  }

  /** 仮想デスクトップ（全モニター）の右の外。どのモニターにも入らない位置（物理画素） */
  function hiddenSpot() {
    let list = [];
    try { list = win32.monitors?.() ?? []; } catch { list = []; }
    if (!list.length) return { x: 20000, y: 0 };
    const right = Math.max(...list.map(m => m.x + m.width));
    const top = Math.min(...list.map(m => m.y));
    return { x: Math.min(right + HIDDEN_MARGIN, HIDDEN_X_MAX), y: top };
  }

  function refreshTaskbar(hwnd) {
    // 拡張スタイルのタスクバーの札は、隠して出し直すと反映される。画面の外・透明の窓なので見えない。前面は取らない
    win32.showWindow(hwnd, SW_HIDE);
    win32.showWindow(hwnd, SW_SHOWNA);
  }

  /**
   * 画面の外・タスクバーと Alt+Tab から外す・透明度 0・マウスの素通し。何度でもかけ直せる（画面の構成が変わったときの置き直し）。
   * エージェントの窓として出した ref だけ
   */
  function conceal(ref, { profile = null, userDataDir = null } = {}) {
    const entry = knownAgent(ref);
    if (!entry) return false;
    try {
      if (!alive(entry.hwnd)) { refs.delete(ref.id); return false; }
      noteProfile(entry, profile, userDataDir);
      const info = win32.windowInfo(entry.hwnd);
      if (!entry.concealed) entry.ex0 = info.exStyle;
      entry.concealed = true;   // 途中で投げても、隠しかけた窓を追えるようにする（閉じる・戻す・見張る）
      startGuard();
      const spot = hiddenSpot();
      win32.setWindowPos(entry.hwnd, spot.x, spot.y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
      const next = ((info.exStyle | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT) & ~WS_EX_APPWINDOW) >>> 0;
      if (next !== info.exStyle) {
        win32.setExStyle(entry.hwnd, next);
        win32.setLayeredAlpha(entry.hwnd, 0);
        win32.setWindowPos(entry.hwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        if (info.visible && !info.iconic) refreshTaskbar(entry.hwnd);
      } else {
        win32.setLayeredAlpha(entry.hwnd, 0);
      }
      guardTick();   // 隠した窓がもう前面を取っていたら、すぐ返す
      return true;
    } catch (error) {
      log(`conceal failed: ${error.message}`);
      return false;
    }
  }

  /** 見える形へ戻す（conceal の逆。第 6 段の「引き継ぐ」）。near（層が出した ref）のあるモニターの中へ動かす。前には出さない（raise は別） */
  function reveal(ref, { near = null } = {}) {
    const entry = knownAgent(ref);
    if (!entry || !entry.concealed) return false;   // 隠していない窓は元のスタイルを覚えていない（0 扱いで壊す）ので触らない
    try {
      if (!alive(entry.hwnd)) { refs.delete(ref.id); return false; }
      const info = win32.windowInfo(entry.hwnd);
      entry.concealed = false;
      entry.closeAt = 0;
      const original = entry.ex0 ?? 0;
      const next = (((info.exStyle & ~STYLE_BITS) | (original & STYLE_BITS)) >>> 0);
      win32.setLayeredAlpha(entry.hwnd, 255);
      if (next !== info.exStyle) win32.setExStyle(entry.hwnd, next);
      win32.setWindowPos(entry.hwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      refreshTaskbar(entry.hwnd);
      // 画面の中へ。near の窓のあるモニター（無ければ最初のモニター）の中に収める
      let list = [];
      try { list = win32.monitors?.() ?? []; } catch { list = []; }
      const nearInfo = known(near) && alive(known(near).hwnd) ? win32.windowInfo(known(near).hwnd) : null;
      let monitor = list[0] ?? null;
      if (nearInfo?.rect && list.length) {
        const cx = (nearInfo.rect.left + nearInfo.rect.right) / 2, cy = (nearInfo.rect.top + nearInfo.rect.bottom) / 2;
        monitor = list.find(m => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) ?? monitor;
      }
      if (monitor && info.rect) {
        const width = Math.min(info.rect.right - info.rect.left, monitor.width), height = Math.min(info.rect.bottom - info.rect.top, monitor.height);
        const x = monitor.x + Math.max(0, Math.round((monitor.width - width) / 2)), y = monitor.y + Math.max(0, Math.round((monitor.height - height) / 2));
        win32.setWindowPos(entry.hwnd, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
      }
      // 隠していたときに一緒に隠した持ち主つきの窓（Chrome の吹き出し: 許可の確認・パスワードの保存など）も見える形に戻す
      // （引き継ぎの間に出す吹き出しを人が見て答えられるように。戻すときは見張りがまた隠す）
      for (const [id, other] of [...refs]) {
        if (other === entry || other.kind !== 'agent' || !other.concealed) continue;
        let owner = 0;
        try { owner = win32.ownerOf(other.hwnd); } catch { continue; }
        if (owner === entry.hwnd) reveal({ id }, { near });
      }
      return true;
    } catch (error) {
      log(`reveal failed: ${error.message}`);
      return false;
    }
  }

  /** 窓の記録だけを捨てる（窓には触らない）。窓が閉じた・もう見張らない */
  function release(ref) {
    const entry = knownAgent(ref);
    if (!entry) return false;
    entry.concealed = false;
    refs.delete(ref.id);
    return true;
  }

  /**
   * エージェントの窓を閉じる（WM_CLOSE。エージェント専用の窓なので、画面の外・透明のまま残すより閉じる）。窓がもう無ければ記録を捨てるだけ（true）。
   * 隠していない窓（戻した窓・隠せなかった窓）は閉じず、記録だけ捨てる（false）。閉じる依頼が出せなければ、見える形へ戻して記録を捨てる（false）。
   * 依頼を出した窓の記録は、窓が無くなるまで残す（見張りが掃除する。CLOSE_GRACE_MS を過ぎても残っていれば見える形へ戻す）
   */
  function closeAgent(ref) {
    const entry = knownAgent(ref);
    if (!entry) return false;
    if (!entry.concealed) { release(ref); return false; }
    try {
      if (!alive(entry.hwnd)) { release(ref); return true; }
      if (win32.postMessage(entry.hwnd, WM_CLOSE, 0, 0) === true) { entry.closeAt = now(); return true; }
    } catch (error) { log(`close agent failed: ${error.message}`); }
    reveal(ref);
    release(ref);
    return false;
  }

  /** 隠している窓を全部片付ける（閉じる。閉じられなければ戻す）。Pleiad の終了で、見えない窓を誰にも戻せないまま残さない。main の will-quit から呼ぶ */
  function closeAllAgents() {
    let count = 0;
    for (const [id, entry] of [...refs]) {
      if (entry.kind === 'agent' && entry.concealed && closeAgent({ id })) count += 1;
    }
    stopGuard();
    return count;
  }

  /**
   * 隠している窓の持ち物（窓のハンドルと元の拡張スタイル）を、main の入れ替わりを越える印にする（ADR 0167）。窓はそのまま（閉じない・戻さない）。
   * 隠していない窓・エージェントの窓でない ref には null
   */
  function exportAgent(ref) {
    const entry = knownAgent(ref);
    if (!entry || !entry.concealed) return null;
    try {
      // 窓のハンドルは使い回される。ブラウザーのプロセス（pid）も印に入れ、引き継ぐときに同じ窓か確かめる
      return `${entry.hwnd}:${(entry.ex0 ?? 0) >>> 0}:${win32.windowInfo(entry.hwnd).pid}`;
    } catch { return null; }
  }

  /**
   * exportAgent の印から、隠している窓の記録を作り直す（新しい main）。窓がもう無い・ブラウザーの窓でない印には null（窓には触らない）。
   * 作り直した窓は隠しているものとして前面の見張りに入る（revealed: true の窓は人が操作中なので、隠さず見張りにも入れない）。画面の中へ動いていた窓は隠し直す
   */
  function adoptAgent(token, { revealed = false, profile = null, userDataDir = null } = {}) {
    const match = /^(\d{1,20}):(\d{1,10}):(\d{1,10})$/.exec(String(token ?? ''));
    if (!match) return null;
    const hwnd = Number(match[1]);
    try {
      if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || !alive(hwnd)) return null;
      const info = win32.windowInfo(hwnd);
      if (info.className !== BROWSER_CLASS || !BROWSER_EXES.has(exeName(win32.processPath(info.pid)))) return null;
      // 同じ窓か: 印を作ったときのプロセスのままで、隠した姿（タスクバーから外す・透明・素通し）のままか。
      // ハンドルが別のブラウザーの窓に使い回されていたら、隠していない窓に触らない
      if (info.pid !== Number(match[3])) return null;
      // 隠した姿かは拡張スタイルで見て、位置（画面の外か）は問わない。Chrome は隠した後の窓を画面の中へ動かすことがある（最大化で開いた窓が通常に戻ると、保存していた位置へ動く。
      // 透明・素通しのまま）。位置で断ると、その見えない窓を引き継げない窓として閉じていた（実機）。このスタイルの組み合わせは conceal だけが付けるもので、
      // 利用者の Chrome の窓（タスクバーに出て、クリックを受ける）は持たない。画面の中にあるときは、持ち主のある窓（吹き出し）でないことも確かめてから隠し直す
      const away = revealed || offscreen(info.rect);
      if (!revealed && !concealStyled(info)) return null;
      if (!away && win32.ownerOf(hwnd) !== 0) return null;
      if (refs.get(String(hwnd))?.kind === 'dialog') return null;
      const ref = rememberAgent(hwnd);
      if (!ref) return null;
      const entry = refs.get(ref.id);
      entry.ex0 = Number(match[2]) >>> 0;
      noteProfile(entry, profile, userDataDir);
      // 人が操作している窓（revealed）は隠さない・見張らない（戻すときの conceal が元のスタイルで隠す）
      entry.concealed = !revealed;
      entry.closeAt = 0;
      if (!revealed) {
        startGuard();
        if (!away) { log('adopt agent: the hidden window was on a screen, so it was concealed again'); conceal(ref); }
      }
      return ref;
    } catch (error) {
      log(`adopt agent failed: ${error.message}`);
      return null;
    }
  }

  /** conceal が付けた拡張スタイルのままか: TOOLWINDOW・LAYERED・TRANSPARENT があり、APPWINDOW が無い */
  function concealStyled(info) {
    const mask = WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT;
    return (info.exStyle & mask) === mask && (info.exStyle & WS_EX_APPWINDOW) === 0;
  }

  /** どのモニターにもかからない位置か（モニターの一覧が取れなければ、右の外の位置の近く） */
  function offscreen(rect) {
    if (!rect) return false;
    let list = [];
    try { list = win32.monitors?.() ?? []; } catch { list = []; }
    if (list.length) return !list.some(m => rect.left < m.x + m.width && rect.right > m.x && rect.top < m.y + m.height && rect.bottom > m.y);
    const spot = hiddenSpot();
    return Math.abs(rect.left - spot.x) <= 64 && Math.abs(rect.top - spot.y) <= 64;
  }

  /** 画面の構成が変わった（モニターの増減・解像度・DPI・スリープ復帰）。隠している窓を置き直す。main が Electron の screen のイベントで呼ぶ */
  function reconceal() {
    let count = 0;
    for (const [id, entry] of [...refs]) {
      if (entry.kind !== 'agent' || !entry.concealed) continue;
      if (!alive(entry.hwnd)) { refs.delete(id); continue; }
      if (conceal({ id })) count += 1;
    }
    if (count) log(`reconceal windows=${count}`);
    return count;
  }

  // ---- 人がプロフィールを開こうとしたとき（ADR 0246） ---------------------------------------------
  /**
   * そのプロフィールに見えている Chrome の窓があるか。隠した窓・透明の窓・cloaked・最小化の窓は「見える」に数えない
   * （最小化は、プロフィールを選んでも前に出ないので、開き直したほうがよい）。プロフィールは窓の AUMID で比べる
   */
  function hasVisibleProfileWindow(entry, hidden) {
    if (!profileKeyOf(entry)) return true;   // プロフィールが分からなければ、重ねて開かない（分からないまま窓を増やさない）
    for (const { hwnd, info, exe } of browserWindows()) {
      if (exe !== 'chrome.exe' || !info.visible || info.iconic || info.cloaked || !info.rect) continue;
      if (hidden.has(hwnd) || concealStyled(info)) continue;
      const known_ = refs.get(String(hwnd));
      if (known_?.kind === 'agent' && known_.concealed) continue;
      const aumid = aumidOf(hwnd);
      if (!aumid) continue;
      if (aumid === entry.aumid) return true;
    }
    return false;
  }

  /**
   * そのプロフィールの見える新しい窓を chrome.exe --profile-directory --new-window で開き、前に出す（URL は渡さない）。
   * 隠した窓には触らない（隠したまま・エージェントの作業は続く）。開けなければ false（呼び出し側は今までどおり前面を返す）
   */
  function openVisibleWindow(entry) {
    const dir = profileDirOf(entry);
    if (!dir) { log('guard: the profile of the raised window is unknown, so no visible window was opened'); return false; }
    let browser = [...browsers.values()].find(value => value.product === 'chrome') ?? null;
    if (!browser) {
      const found = locateBrowser({ product: 'chrome' });
      browser = found ? browsers.get(found.id) ?? null : null;
    }
    if (!browser) { log('guard: chrome.exe not found, so no visible window was opened'); return false; }
    const args = [];
    const userDataDir = entry.userDataDir ?? lastUserDataDir;
    if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
    args.push(`--profile-directory=${dir}`, '--new-window');
    try {
      const child = spawn(browser.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on?.('error', error => log(`guard: opening a visible window failed: ${error.message}`));
      child.unref?.();
      if (entry.aumid) visibleOpenedAt.set(entry.aumid, now());
      else if (entry.profileDir) visibleOpenedAt.set(`profile:${entry.profileDir}`, now());
      log('guard: opened a visible Chrome window for the profile of the raised window');
      return true;
    } catch (error) {
      log(`guard: opening a visible window failed: ${error.message}`);
      return false;
    }
  }

  /**
   * 隠した窓が前面を取ったのが、エージェントの操作ではない（人がプロフィールを開こうとした）なら、そのプロフィールの見える窓を開く。
   * エージェントの操作とみなす: トグルを入れている窓（ghost）・閉じる依頼中・引き継ぎで見せている・隠した／引き継いだ直後（開きかけ・popup）・
   * 直前に前面だったのが同じ Chrome の隠した窓（エージェントが窓を切り替えた）。見分けられないときは開かない（今までどおり前面を返すだけ）
   */
  function openVisibleIfHuman(entry, previous, hidden, cameFromVisibleChrome) {
    if (!entry || !entry.concealed || entry.ghost || entry.closeAt) return false;
    // 直前の前面が、隠していない Chrome の窓（プロフィールの選択画面・利用者の窓）だったときだけ、人が開こうとしたと見る。
    // エージェントの窓（隠した窓）から移った・ほかのアプリから移ったときは、エージェントの操作（または分からない）として開かない
    if (cameFromVisibleChrome !== true) return false;
    if (now() - (entry.agentAt ?? 0) < agentGraceMs) return false;
    if (previous && hidden.has(previous)) return false;
    if (!profileKeyOf(entry)) return false;
    const key = profileKeyOf(entry);
    if (now() - (visibleOpenedAt.get(key) ?? 0) < openVisibleCooldownMs) return false;
    if (hasVisibleProfileWindow(entry, hidden)) return false;
    return openVisibleWindow(entry);
  }

  // ---- 前面の見張り -------------------------------------------------------------------------------
  // 隠している窓が前面を取ったら（window.open・Chrome 自身の前面化）、すぐ「その窓が前面を取る直前の前面」へ返す。隠している窓があるあいだだけ動く。
  // 直前の前面は、周期ごとの前面の移り変わり（before: 窓 → その窓が前面になる前の前面）で覚える。まだ隠していない新しい窓（popup）が先に前面を取り、
  // 隠した後に見張りが気づく順でも、その窓の直前の前面（利用者の窓）へ返せる（実機で、直前の前面を「今の前面」と覚えて返せなかった: 2026-10-07）
  /**
   * 隠した窓が持ち主の窓（Chrome の吹き出し: 「このページを翻訳しますか？」・権限の確認・パスワードの保存など）も隠す。
   * 吹き出しは持ち主の窓の外へ出るのでなく、別の最上位の窓として今の画面の位置に出て、前面まで取る（実機で、翻訳の確認が画面に出て前面を取った）。
   * ブラウザーの窓だけ（持ち主が、隠している窓のとき）。隠している窓が見張りの間に増えるので、周期ごとに探す
   */
  function concealOwned(hidden) {
    let handles = [];
    try { handles = win32.topLevelWindows(); } catch { return; }
    for (const hwnd of handles) {
      const known_ = refs.get(String(hwnd));
      // すでに隠した窓・確認の窓は対象外。引き継ぎで見える形に戻した吹き出し（kind は agent のまま）は、持ち主をまた隠したときに隠し直す
      if (hidden.has(hwnd) || known_?.kind === 'dialog' || (known_?.kind === 'agent' && known_.concealed)) continue;
      let owner = 0;
      try { owner = win32.ownerOf(hwnd); } catch { continue; }
      if (!owner || !hidden.has(owner)) continue;
      let info;
      try { info = win32.windowInfo(hwnd); } catch { continue; }
      if (info.className !== BROWSER_CLASS || !BROWSER_EXES.has(exeName(win32.processPath(info.pid))) || !info.visible) continue;
      if (looksLikePermissionDialog(hwnd, info)) continue;   // 確認の窓は隠さない（利用者が見て、Pleiad が閉じる）
      const ref = rememberAgent(hwnd);
      if (ref && conceal(ref)) { hidden.add(hwnd); log('conceal owned window'); }
    }
  }
  /**
   * 隠している窓が画面の中へ動かされていたら（スタイルが外れていたら）隠し直す。Chrome は後から窓を動かす（最大化で開いた窓が通常に戻ると、保存していた画面の中の位置へ。
   * 実機で、隠した後に画面の中へ出た）。見張りの PLACE_CHECK_MS ごとに 1 回。引き継ぎで見せている窓（concealed: false）・閉じる依頼を出した窓は見ない
   */
  function keepConcealed() {
    for (const [id, entry] of [...refs]) {
      if (entry.kind !== 'agent' || !entry.concealed || entry.closeAt || entry.ghost) continue;   // ghost: トグルを入れている間の窓（enableRemoteDebugging）
      let info;
      try { info = win32.windowInfo(entry.hwnd); } catch { continue; }
      if (!info.rect || (concealStyled(info) && offscreen(info.rect))) continue;
      if (conceal({ id })) log('guard: a hidden window had moved onto a screen, so it was concealed again');
    }
  }
  let guard = null;
  let current = 0;
  let currentVisibleChrome = false;
  let placedAt = 0;
  const before = new Map();
  const beforeVisibleChrome = new Map();   // 窓 → その窓が前面になる直前の前面が、隠していない Chrome の窓だったか
  let ticking = false;
  function guardTick() {
    if (ticking) return;   // conceal の最後の guardTick から、見張りの中の conceal を呼び直さない
    ticking = true;
    try { guardBody(); }
    catch (error) { log(`guard failed: ${error.message}`); }   // setInterval から直に呼ばれる。投げても見張りを止めない
    finally { ticking = false; }
  }
  function guardBody() {
    let fg = 0;
    try { fg = win32.foreground(); } catch { return; }
    const hidden = new Set();
    for (const [id, entry] of [...refs]) {
      if (entry.kind !== 'agent' || !entry.concealed) continue;
      if (!alive(entry.hwnd)) { refs.delete(id); continue; }
      if (entry.closeAt && now() - entry.closeAt > CLOSE_GRACE_MS) {
        // 閉じる依頼を出したのに残っている（離れる確認など）。見えない窓のまま残さず、利用者が見える形へ戻す
        log('close did not finish, so the window was revealed');
        reveal({ id }); release({ id });
        continue;
      }
      hidden.add(entry.hwnd);
    }
    if (!hidden.size) { stopGuard(); return; }
    // トグルを入れている窓（ghost）は、開く間だけ層が前面を持たせる。見張りは返さない
    const ghosts = new Set([...refs.values()].filter(e => e.kind === 'agent' && e.ghost).map(e => e.hwnd));
    if (now() - placedAt >= PLACE_CHECK_MS) { placedAt = now(); keepConcealed(); }
    concealOwned(hidden);
    if (!fg) return;
    if (fg !== current) {
      if (current) {
        before.set(fg, current); if (before.size > 64) before.delete(before.keys().next().value);
        beforeVisibleChrome.set(fg, currentVisibleChrome); if (beforeVisibleChrome.size > 64) beforeVisibleChrome.delete(beforeVisibleChrome.keys().next().value);
      }
      current = fg;
      currentVisibleChrome = visibleChromeWindow(fg) && !hidden.has(fg);
    }
    if (!hidden.has(fg) || ghosts.has(fg)) return;
    // 人がプロフィールを開こうとして、Chrome がこのプロフィールの最後の窓（隠した窓）を前に出したなら、
    // 前面を返すだけでなく、そのプロフィールの見える窓を開く（ADR 0246）。エージェントの操作のときは開かない
    const raised = refs.get(String(fg));
    let opened = false;
    try { opened = openVisibleIfHuman(raised, before.get(fg), hidden, beforeVisibleChrome.get(fg) === true); } catch (error) { log(`guard: opening a visible window failed: ${error.message}`); }
    if (opened) return;   // 見える窓を開いた。前面はその新しい窓に任せる（ここで返すと、開く窓と前面を奪い合う）
    // 隠した窓が前面を取った。直前の前面（隠した窓でも、最小化・閉じた窓でもない）へ返す。直前も隠した窓なら、その前をたどる
    let target = before.get(fg);
    for (let hop = 0; target && hop < 4 && (hidden.has(target) || !alive(target)); hop += 1) target = before.get(target);
    if (!target || target === fg || hidden.has(target) || !alive(target)) return;
    try {
      if (win32.windowInfo(target).iconic) return;
      const method = bring(target);
      log(`guard yield method=${method}`);
      if (method !== 'failed') { current = target; currentVisibleChrome = visibleChromeWindow(target); }
    } catch (error) { log(`guard failed: ${error.message}`); }
  }
  function startGuard() {
    if (guard) return;
    try { current = win32.foreground(); } catch { current = 0; }
    currentVisibleChrome = visibleChromeWindow(current) && refs.get(String(current))?.concealed !== true;
    guard = timers.setInterval(guardTick, guardMs);
    guard?.unref?.();
  }
  function stopGuard() {
    if (!guard) return;
    timers.clearInterval(guard);
    guard = null;
  }

  /**
   * 既定のブラウザーが Chrome 系か（HKCU の UserChoice の ProgId が ChromeHTML・ChromeBHTML・ChromeDHTML・ChromeSSHTM。
   * 利用者ごとの導入では「ChromeHTML.<接尾辞>」）。scheme が 'html' なら HTML のファイル（openPath）の関連付け、ほかは URL のスキーム。
   * 新しい Windows 11 が書く UserChoiceLatest を先に見る。読めない・ほかのブラウザー（MSEdgeHTM・FirefoxURL など）のときは false（無闇に Chrome の窓を前に出さない）
   */
  function defaultIsChrome(scheme) {
    const base = scheme === 'html'
      ? 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.html'
      : `Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme === 'http' || scheme === 'http:' ? 'http' : 'https'}`;
    let progId = null;
    for (const key of [`${base}\\UserChoiceLatest\\ProgId`, `${base}\\UserChoiceLatest`, `${base}\\UserChoice`]) {
      try { progId = win32.registryString?.('HKCU', key, 'ProgId') ?? null; } catch { progId = null; }
      if (typeof progId === 'string' && progId) break;
    }
    return typeof progId === 'string' && /^Chrome(?:HTML|BHTML|DHTML|SSHTM)(?:\.|$)/i.test(progId);
  }

  /**
   * shell.openExternal で既定のブラウザーへ URL を渡す直前の下準備（main が呼ぶ。core からの口は無い）。
   * Chrome は受け取った URL を「最後にアクティブだった窓」で開く。エージェントの窓は作られた瞬間に一度アクティブになり、
   * そのまま隠すと last-active が見えない窓に残るので、URL は見えない窓に開いてしまう（実機で再現）。
   * 最後に使われていた、見える（conceal していない）Chrome の窓を前面にして last-active を戻す。
   * 何もしない条件（{ ok: false } で返る）: 隠している窓が無い・トグルを入れる窓（ghost）の操作中・
   * 既定のブラウザーが Chrome 系でない・隠した窓と同じ Chrome に見える窓が無い。前に出せなければ reason: 'raise'（呼び出し側はそのまま開く）。
   * 前に出した窓は隠した窓ではないので、前面の見張り（guardBody）は取り戻さない。
   * scheme: 'http' | 'https'（URL）・'html'（HTML のファイルを openPath で開く）
   */
  function raiseVisibleBrowser({ scheme = 'https' } = {}) {
    const hidden = new Set();
    let ghost = false;
    for (const entry of refs.values()) {
      if (entry.kind !== 'agent') continue;
      if (entry.ghost) ghost = true;
      if (entry.concealed) hidden.add(entry.hwnd);
    }
    if (!hidden.size) return { ok: false, reason: 'no-hidden' };
    if (ghost) return { ok: false, reason: 'busy' };
    if (!defaultIsChrome(scheme)) return { ok: false, reason: 'browser' };
    // 隠した窓を持つ Chrome（プロセス）の窓だけを見る。別の User Data で起こした Chrome に隠しているなら、既定のブラウザーの last-active は動いていないので触らない
    const pids = new Set();
    for (const hwnd of hidden) { try { pids.add(win32.windowInfo(hwnd).pid); } catch { /* 閉じた窓 */ } }
    // 見える Chrome の窓: 隠した窓（記録と、窓に残るスタイルの両方）でも、Edge・見えない・cloaked の窓でもないもの。最小化は含める（出すときに戻す）
    const eligible = new Set();
    const listed = [];
    for (const { hwnd, info, exe } of browserWindows()) {
      if (exe !== 'chrome.exe' || !info.visible || info.cloaked || concealStyled(info)) continue;
      if (pids.size && !pids.has(info.pid)) continue;
      const entry = refs.get(String(hwnd));
      if (entry?.kind === 'agent' && entry.concealed) continue;
      eligible.add(hwnd); listed.push(hwnd);
    }
    if (!eligible.size) return { ok: false, reason: 'no-visible' };
    // 「最後に使われていた」窓は、見張りが持つ前面の履歴（その窓が前面になる直前の前面の鎖）を新しい順にたどる。尽きたら窓の列挙（Z 順）の先頭から
    const order = [];
    const push = hwnd => { if (eligible.has(hwnd) && !order.includes(hwnd)) order.push(hwnd); };
    for (let hwnd = current, hop = 0; hwnd && hop < 8; hwnd = before.get(hwnd) ?? 0, hop += 1) push(hwnd);
    for (const hwnd of listed) push(hwnd);
    for (const hwnd of order) {
      try {
        const method = bring(hwnd);
        if (method !== 'failed') { log(`raise visible browser method=${method}`); return { ok: true, method }; }
      } catch { /* 次の窓を試す */ }
    }
    return { ok: false, reason: 'raise' };
  }

  return {
    capabilities: () => ({ supported: true, reason: null, features: FEATURES }),
    snapshotWindows, findPermissionDialog, raise, yieldForeground, foreground, appWindow, close, allowPermission, enableRemoteDebugging, bounds, watch,
    locateBrowser, launchWindow, findWindowByNonce, findWindowByBounds, hiddenSpot, conceal, reveal, release, closeAgent,
    exportAgent, adoptAgent, reconceal, closeAllAgents, raiseVisibleBrowser,
    /** テスト用: 見張りを 1 回だけ回す・止める */
    guardTick, stopGuard,
  };
}

module.exports = { createWin32ChromeOs, BROWSER_EXES, DIALOG_TITLE, WM_CLOSE, WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW, WS_EX_LAYERED };
