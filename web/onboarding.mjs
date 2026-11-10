import { isComposingKey } from './keyboard.mjs';
import { t } from './i18n.mjs';
import { usableReport, gateKind } from './agent-usable.mjs';
// ページを足したら、下の `$('<名前>Tab').onclick = () => page('<名>')` も足す（無いと札は出るが切り替わらない）
const pages = [['setup', 'setupTab', 'setupPanel'], ['apiKeys', 'apiKeysTab', 'apiKeysPanel'], ['usage', 'usageTab', 'usagePanel'], ['delegation', 'delegationTab', 'delegationPanel'], ['appearance', 'appearanceTab', 'appearancePanel'], ['input', 'inputTab', 'inputPanel'], ['context', 'openContext', 'contextPanel'], ['autoCompaction', 'autoCompactionTab', 'autoCompactionPanel'], ['browser', 'browserTab', 'browserPanel'], ['computer', 'computerTab', 'computerPanel'], ['notify', 'notifyTab', 'notifyPanel'], ['voice', 'voiceTab', 'voicePanel'], ['remote', 'remoteTab', 'remotePanel'], ['plus', 'plusTab', 'plusPanel'], ['memory', 'memoryTab', 'memoryPanel'], ['updates', 'updatesTab', 'updatesPanel']];

/**
 * folderBrowser はブラウザー版の「フォルダーを選ぶ…」の簡易ブラウザー（web/composer-controls.mjs。入力欄の面と同じ部品）
 * kit は行の部品の束（web/agent-row.mjs の createRowKit。設定・会話の中の一覧と共有）、capabilities(id) は能力の印、
 * loadEndpoints() は確かめ済みの互換の接続先を読み直す、onUsable(id) は「使えるエージェントがありません」が自分で閉じたときの行き先、
 * authNote(id) は直前のログインの時間切れ・失敗の一文（ADR 0243）
 *
 * 初回の案内と「使えるエージェントがありません」は同じ窓で、閉じる口が無い（docs/desktop-onboarding.md「使えるエージェントが無いとき」）。
 * 出す・出さないの判断は web/agent-usable.mjs の gateKind だけ
 */
export function setupOnboarding({ cmd, refreshAuth, getAuth, kit, capabilities, loadEndpoints, getEndpoints, onUsable, authNote, authUrlBox, begin, folderBrowser, onClose }) {
  const $ = id => document.getElementById(id);
  const welcome = $('onboardingDialog');
  let status = null, selected = '', checked = false, locked = false;
  // 今出している案内の種類（'first' | 'none' | null）。null は窓を出していない（出す必要が無い）
  let gate = null, leaving = null;
  // 初回の案内で選んだ作業ディレクトリ。選ぶまでは前に決めたもの、無ければホーム（docs/desktop-onboarding.md）
  let chosenCwd = '';
  const currentCwd = () => chosenCwd || status?.cwd || status?.homeDir || '';
  const error = message => { $('onboardingError').textContent = message; };
  const isOpen = () => document.body.classList.contains('settings');
  // 読み上げに伝えたエージェントごとの状態（変わったときだけ #onboardingLive に書く）
  const spoken = new Map();
  // 別のページへ移ったら本文を先頭に戻す（前のページの位置のまま途中から始まらないように）。同じページを押し直したときは動かさない
  let shown = null;
  function page(active = 'setup') {
    for (const [name, button, panel] of pages) {
      $(panel).hidden = name !== active;
      $(button).setAttribute('aria-pressed', String(name === active));
      // ページの名前は選んだメニューのボタンが持つ（本文の上に重複する見出しは置かない）
      if (name === active) $('settingsView').setAttribute('aria-labelledby', button);
    }
    if (active !== shown) { shown = active; const content = document.querySelector('.settings-content'); if (content) content.scrollTop = 0; }
  }
  // 設定は画面全体。脇の一覧がメニューに、会話がページに入れ替わる。
  // 会話は伏せずにページで覆う（style.css「設定の画面」）ので、キーボードと読み上げが覆った会話へ届かないよう inert にする
  // main の直下だけを見る（文書全体を探すと長い会話ではそれだけで重い）。要素は作り直さないので一度拾えば足りる
  let coveredNodes;
  const covered = () => coveredNodes ??= [...(document.querySelector('body > main')?.children ?? [])].filter(n => n.matches('.top, #logFrame, .composer'));
  function open(active = 'setup') {
    if (welcome.open) return;
    page(active);
    document.body.classList.add('settings');
    for (const node of covered()) node.inert = true;
    $('settingsNav').querySelector('[aria-pressed=true]')?.focus();
  }
  function close() {
    if (locked || !isOpen()) return;
    document.body.classList.remove('settings');
    onClose?.();
    for (const node of covered()) node.inert = false;
    $('settings').focus();
    // 設定から戻ったとき、まだ使えるエージェントが無ければ案内が戻る
    if (gate) resumeGate();
  }
  // 更新の適用中は途中で再起動するので、会話へ戻る道を塞ぐ
  function lock(value) {
    locked = value;
    $('backToChat').disabled = value;
    $('settingsNav').inert = value;
  }
  const agentsOf = () => (status?.agents || []).map(a => ({ ...a, capabilities: capabilities?.(a.id) ?? {} }));
  // 一覧は radiogroup。使える行だけが選べる（選べない行は役割を持たず、操作のボタンだけを持つ）。
  // 矢印で選び、Tab では群ごと飛ばす（選択中の行だけ tabindex=0）
  function move(ids, step) {
    const index = ids.indexOf(selected);
    selected = ids[(Math.max(index, 0) + step + ids.length) % ids.length];
    paint({ focus: true });
  }
  $('onboardingAgentList').addEventListener('keydown', event => {
    const row = event.target.closest?.('[data-pick]');
    if (!row || event.target !== row || isComposingKey(event)) return;
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); selected = row.dataset.pick; return paint({ focus: true }); }
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const ids = [...$('onboardingAgentList').querySelectorAll('[data-pick]')].map(r => r.dataset.pick);
    if (!step || ids.length < 2) return;
    event.preventDefault();
    move(ids, step);
  });

  function paint({ focus = false } = {}) {
    const agents = agentsOf(), auth = getAuth();
    const { usable } = kit.plan(agents);
    if (!usable.includes(selected)) selected = (usable.includes(status?.backend) ? status.backend : usable[0]) || '';
    const list = $('onboardingAgentList');
    kit.paint(list, agents, { desc: true, pick: { pickable: a => usable.includes(a.id), selected, onPick: a => { selected = a.id; paint(); } } });
    if (focus) list.querySelector('[aria-checked=true]')?.focus();

    // 読み上げ: 状態が変わった行だけ伝える
    const live = $('onboardingLive');
    for (const agent of agents) {
      const st = auth.get(agent.id);
      const said = st?.pending ? t('settings.agents.loginPending') : st?.unconfirmed ? t('settings.agents.unconfirmed') : usable.includes(agent.id) ? t('settings.agents.stateOn') : st?.installed === false ? t('settings.agents.notInstalled') : t('settings.agents.loggedOut');
      if (spoken.has(agent.id) && spoken.get(agent.id) !== said && live) live.textContent = `${agent.label}: ${said}`;
      spoken.set(agent.id, said);
    }

    // ログインの URL と手貼りの欄。ダイアログは modal なので、設定画面に出しても届かない
    const waiting = agents.find(a => auth.get(a.id)?.pending);
    const box = authUrlBox?.(waiting?.id ?? selected);
    $('onboardingAuth')?.replaceChildren(...(box ? [box] : []));

    $('completeSetup').disabled = !selected;
    const noted = agents.map(a => authNote?.(a.id)).find(Boolean);
    error(selected ? '' : noted || '');
    // 「使えるエージェントがありません」は、1 つ使えるようになったら自分で閉じる
    if (gate === 'none' && usable.length && welcome.open && !leaving) leave(usable[0]);
  }

  // ---- 案内を出す・畳む
  function showGate() {
    const none = gate === 'none';
    $('onboardingTitle').textContent = none ? t('dialog.onboarding.noneTitle') : t('dialog.onboarding.title');
    $('onboardingSubtitle').textContent = none ? t('dialog.onboarding.noneSubtitle') : t('dialog.onboarding.subtitle');
    // 作業ディレクトリと「会話を始める」は最初の案内だけ。再び出る案内は、使えるものができたら自分で閉じる
    $('onboardingCwd').hidden = none;
    document.querySelector('.onboarding-actions').hidden = none;
    welcome.classList.remove('leaving');
    if (!welcome.open) { welcome.showModal(); $('onboardingTitle').focus({ preventScroll: true }); }   // 歯車に枠が出ないよう、見出しへ（読み上げは見出しから始まる）
    paint();
  }
  function resumeGate() {
    if (!gate || welcome.open) return;
    if (gate === 'none') {
      const { usable } = kit.plan(agentsOf());
      if (usable.length) { const id = usable[0]; gate = null; onUsable?.(id); return; }
    }
    showGate();
  }
  // 使えるものができた: 900ms 見せてから 240ms で薄れて閉じる。行き先は使えるようになったエージェント
  function leave(id) {
    leaving = setTimeout(() => {
      const { usable } = kit.plan(agentsOf());
      if (!usable.length) { leaving = null; return; }   // 見せている間に戻った
      welcome.classList.add('leaving');
      setTimeout(() => {
        leaving = null;
        gate = null;
        welcome.classList.remove('leaving');
        welcome.close();
        onUsable?.(usable.includes(id) ? id : usable[0]);
      }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240);
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900);
  }
  async function refresh() {
    status = await cmd('onboardingStatus');
    await loadEndpoints?.();
    paintCwd();
    if (!checked) {
      checked = true;
      const report = usableReport({ agents: agentsOf(), auth: getAuth(), endpoints: getEndpoints?.() ?? null });
      gate = gateKind({ status, report, remote: Boolean(globalThis.window?.plyRemote) });
      if (gate === 'first') {
        try { await cmd('onboardingSeen'); status.seen = true; }
        catch (e) { $('setupError').textContent = t('onboarding.seenFailed', { error: e.message }); }
      }
      if (gate) { close(); showGate(); return; }
    }
    paint();
  }
  // 閉じる口は無い: Esc・窓の外のクリックでは閉じない。設定へは歯車（戻ると案内が戻る）。OS の閉じる（アプリの終了）は止めない
  welcome.addEventListener('cancel', event => { if (gate) event.preventDefault(); });
  welcome.addEventListener('keydown', event => { if (event.key === 'Escape' && gate) event.preventDefault(); });
  welcome.addEventListener('close', () => {
    // ほかの口が .close() してそのまま設定を開く（openSettings）のは通す。何も開かず閉じたなら出し直す
    if (gate && !leaving) setTimeout(() => { if (gate && !welcome.open && !isOpen() && !leaving) showGate(); }, 0);
  });
  $('onboardingGear').onclick = () => { welcome.close(); open('setup'); };
  $('setupTab').onclick = () => page();
  $('appearanceTab').onclick = () => page('appearance');
  $('inputTab').onclick = () => page('input');
  $('autoCompactionTab').onclick = () => page('autoCompaction');
  $('memoryTab').onclick = () => page('memory');
  $('browserTab').onclick = () => page('browser');
  $('computerTab').onclick = () => page('computer');
  $('backToChat').onclick = () => close();
  // Esc でも会話へ戻る。重なった dialog と、combo・メニューが既に受け取った Esc は横取りしない
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event) || !isOpen()) return;
    if (document.querySelector('dialog[open]')) return;
    close();
  });
  $('refreshAgents').onclick = async () => {
    $('refreshAgents').disabled = true; $('setupError').textContent = '';
    try { await refreshAuth(); }
    catch (e) { $('setupError').textContent = e.message; }
    finally { $('refreshAgents').disabled = false; }
  };
  $('completeSetup').onclick = async () => {
    $('completeSetup').disabled = true;
    try {
      status = { ...status, ...await cmd('completeSetup', { backend: selected, ...(currentCwd() ? { cwd: currentCwd() } : {}) }) };
      await begin({ backend: status.backend, cwd: status.cwd }, '');
      gate = null;
      welcome.close();
      $('prompt').focus();
    } catch (e) { error(e.message); }
    finally { $('completeSetup').disabled = false; }
  };
  // ---- 作業ディレクトリ。フルパスを出し、ホームなら弱い字の「ホーム」を添える。変えるのは「フォルダーを選ぶ…」
  const trimEnd = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a, b) => trimEnd(a) === trimEnd(b);
  function paintCwd() {
    const cwd = currentCwd();
    const home = Boolean(status?.homeDir) && samePath(cwd, status.homeDir);
    const tag = document.createElement('span');
    tag.className = 'onboarding-cwd-home';
    tag.textContent = t('dialog.onboarding.cwdHome');
    $('onboardingCwdPath').replaceChildren(document.createTextNode(cwd), ...(home ? [' ', tag] : []));
    $('onboardingCwdPath').title = cwd;
  }
  const cwdError = $('onboardingCwdError');
  const browseBox = $('onboardingBrowse');
  const useCwd = (value) => {
    const v = String(value ?? '').trim();
    if (!v) return;
    chosenCwd = v;
    browseBox.hidden = true;
    browseBox.replaceChildren();
    cwdError.textContent = '';
    paintCwd();
    $('onboardingCwdChoose').focus();
  };
  const browse = folderBrowser?.({ cmd, box: browseBox, err: cwdError, onChoose: useCwd, closed: () => !welcome.open });
  $('onboardingCwdChoose').onclick = async () => {
    cwdError.textContent = '';
    // デスクトップ版は OS のダイアログ。ブラウザー版（リモートの窓も）は簡易ブラウザーを案内の中に開く。開いていれば閉じる
    if (globalThis.window?.plyDesktop?.chooseFolder) {
      const picked = await window.plyDesktop.chooseFolder().catch(() => null);
      const path = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
      if (path) useCwd(path);
      return;
    }
    if (!browseBox.hidden) { browseBox.hidden = true; browseBox.replaceChildren(); return; }
    browse?.(currentCwd());
  };
  welcome.addEventListener('close', () => { browseBox.hidden = true; browseBox.replaceChildren(); cwdError.textContent = ''; });

  page();
  return { open, close, isOpen, lock, refresh, paint, page, gated: () => gate, agents: agentsOf };
}
